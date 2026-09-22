// Ron's Goal Tool — NHL data build. Mirrors build-nfl.js: fetch the open NHL
// endpoints (no key), shape them, write nhl/data.json. Sources:
//   /stats/rest/en/season            -> which season we're in, and its dates
//   api-web /standings/now           -> every team's record, for schedule rows
//   api-web /schedule/{date}         -> the season's games (and scores, once played)
//   api-web /score/{date}            -> every goal on a date, for the recap
//   /stats/rest/en/{skater,goalie}/summary -> the Stats leader boards
//
// Nothing here is a constant that needs editing next September: the season, the
// history season and the recap window are all read off the feeds, the same way
// NFL rolls itself over.
import fs from 'node:fs';
import { web, rest, restPaged, etDate, shiftDate } from './nhl-api.js';
import { buildShotsBoard } from './nhl-shots.js';

const LEADERS = 300;      // skaters on the Stats board
const GOALIES = 90;       // ~3 per club
const RECAP_DATES = 21;   // dates of goal-by-goal recap kept (a rolling 3 weeks)
const SCAN_BACK = 150;    // how far back to look for those dates before giving up
const SCAN_GAP = 21;      // ...but stop after this many empty days once we have some

const ymd = (s) => (s || '').slice(0, 10);

async function main() {
  const today = etDate();

  // ── 1) Which season are we in? ─────────────────────────────────────────
  const seasons = (await rest('/season')).data.sort((a, b) => a.id - b.id);
  // The season we schedule: the newest one whose regular season hasn't ended.
  // In the September gap that's the one about to start, which is the point.
  const UP = seasons.filter(s => ymd(s.regularSeasonEndDate) >= today).sort((a, b) => a.id - b.id)[0]
          || seasons[seasons.length - 1];
  // The season the leader boards read from: the newest one that has been
  // played. Before opening night that's last year — the alternative is a Stats
  // page of 32 zeroes.
  const started = seasons.filter(s => ymd(s.startDate) <= today);
  const HIST = started[started.length - 1];
  const label = (s) => s.formattedSeasonId;
  console.log(`Season: ${label(UP)} (${ymd(UP.startDate)} → ${ymd(UP.regularSeasonEndDate)}), leaders from ${label(HIST)}`);

  // ── 2) Standings -> team records ───────────────────────────────────────
  console.log('Fetching standings…');
  const st = await web('/standings/now');
  const teams = {};
  for (const t of st.standings || []) {
    teams[t.teamAbbrev.default] = {
      id: t.teamAbbrev.default, name: t.teamName.default, place: t.placeName.default,
      conf: t.conferenceAbbrev, div: t.divisionAbbrev,
      gp: t.gamesPlayed, w: t.wins, l: t.losses, otl: t.otLosses, pts: t.points,
      gf: t.goalFor, ga: t.goalAgainst, ptPct: t.pointPctg,
      l10: `${t.l10Wins}-${t.l10Losses}-${t.l10OtLosses}`,
      streak: t.streakCode ? `${t.streakCode}${t.streakCount}` : null,
      rank: t.leagueSequence, divRank: t.divisionSequence,
    };
  }
  // Standings are the PREVIOUS season's final table until a game is played, so
  // the app can say so rather than presenting April's table as today's.
  const standingsDate = st.standings?.[0]?.date || null;
  const standingsStale = standingsDate && standingsDate < ymd(UP.startDate);
  console.log(`  ${Object.keys(teams).length} teams, table dated ${standingsDate}${standingsStale ? ' (last season — pre-opener)' : ''}`);

  // ── 3) Schedule ────────────────────────────────────────────────────────
  // /schedule/{date} answers a whole week and names the next one, so the season
  // costs ~28 requests rather than ~190. Start from whichever comes first,
  // today or opening night, so preseason days still have a schedule to show.
  const from = today < ymd(UP.startDate) ? today : ymd(UP.startDate);
  const until = ymd(UP.regularSeasonEndDate);
  console.log(`Fetching schedule ${from} → ${until}…`);
  const schedule = [];
  const seen = new Set();
  let cursor = from, guard = 0;
  while (cursor && cursor <= until && guard++ < 60) {
    const wk = await web(`/schedule/${cursor}`);
    for (const day of wk.gameWeek || []) {
      for (const g of day.games || []) {
        if (seen.has(g.id)) continue;
        seen.add(g.id);
        schedule.push({
          gameId: g.id, date: day.date, start: g.startTimeUTC, type: g.gameType,
          away: g.awayTeam.abbrev, home: g.homeTeam.abbrev,
          awayScore: g.awayTeam.score ?? null, homeScore: g.homeTeam.score ?? null,
          state: g.gameState, venue: g.venue?.default || null,
          tv: (g.tvBroadcasts || []).filter(b => b.countryCode === 'US').map(b => b.network).slice(0, 2),
          end: g.gameOutcome?.lastPeriodType || null,
        });
      }
    }
    const next = wk.nextStartDate;
    cursor = next && next > cursor ? next : null;
  }
  schedule.sort((a, b) => a.date.localeCompare(b.date) || (a.start || '').localeCompare(b.start || '') || a.gameId - b.gameId);
  const dates = [...new Set(schedule.map(g => g.date))];
  console.log(`  ${schedule.length} games over ${dates.length} dates`);

  // ── 4) Recap: every goal, by date ──────────────────────────────────────
  // Walk backwards from today until we have RECAP_DATES dates that actually had
  // finished games. In September that walks back into last season's playoffs,
  // which is the right answer — the alternative is an empty recap page.
  console.log('Fetching goal recaps…');
  const recap = {}, recapGames = {};
  let d = today, found = 0, gap = 0;
  for (let i = 0; i < SCAN_BACK && found < RECAP_DATES; i++, d = shiftDate(d, -1)) {
    const sc = await web(`/score/${d}`);
    const finals = (sc.games || []).filter(g => g.gameState === 'OFF' || g.gameState === 'FINAL');
    // The offseason is a four-month hole. Walk into it far enough to reach last
    // June's playoffs from an early-September build, but stop once it's clear
    // there is nothing behind us rather than burning 150 requests every hour.
    if (!finals.length) { if (found && ++gap >= SCAN_GAP) break; continue; }
    found++; gap = 0;
    const goals = [];
    for (const g of finals) {
      recapGames[g.id] = {
        gameId: g.id, date: d, away: g.awayTeam.abbrev, home: g.homeTeam.abbrev,
        awayScore: g.awayTeam.score ?? 0, homeScore: g.homeTeam.score ?? 0,
        awaySog: g.awayTeam.sog ?? null, homeSog: g.homeTeam.sog ?? null,
        end: g.gameOutcome?.lastPeriodType || 'REG', type: g.gameType,
        recap: g.threeMinRecap ? 'https://www.nhl.com' + g.threeMinRecap : null,
      };
      for (const [k, go] of (g.goals || []).entries()) {
        goals.push({
          gameId: g.id, k, pid: go.playerId,
          name: [go.firstName?.default, go.lastName?.default].filter(Boolean).join(' ') || go.name?.default || '',
          team: go.teamAbbrev?.default || go.teamAbbrev, mug: go.mugshot || null,
          period: go.periodDescriptor?.number ?? go.period, ptype: go.periodDescriptor?.periodType || 'REG',
          time: go.timeInPeriod, strength: go.strength || 'ev',
          mod: go.goalModifier && go.goalModifier !== 'none' ? go.goalModifier : null,
          season: go.goalsToDate ?? null,
          assists: (go.assists || []).map(a => ({ pid: a.playerId, name: a.name?.default || '' })),
          a: g.awayTeam.abbrev, h: g.homeTeam.abbrev, as: go.awayScore, hs: go.homeScore,
          clip: go.highlightClipSharingUrl || null,
        });
      }
    }
    recap[d] = goals;
    // A date with finals but no goals parsed means the feed hasn't filled in
    // yet; keep the date (the games are real) but don't count it as a full one.
    console.log(`  ${d}: ${finals.length} games, ${goals.length} goals`);
  }
  const recapDates = Object.keys(recap).sort();

  // ── 5) Leader boards ───────────────────────────────────────────────────
  // Read the upcoming season first; before opening night it is empty and we
  // fall back to the completed one, flagged so the page can say whose year it is.
  console.log('Fetching leader boards…');
  async function leaders(season) {
    const skRaw = await restPaged(`/skater/summary?cayenneExp=seasonId=${season} and gameTypeId=2`, LEADERS, [{ property: 'points', direction: 'DESC' }, { property: 'playerId', direction: 'ASC' }]);
    // The whole time-on-ice table, not the top LEADERS of it: its own ordering
    // is by ice time, which is not the same 300 men as the points board.
    const toi = await restPaged(`/skater/timeonice?cayenneExp=seasonId=${season} and gameTypeId=2`, Infinity, [{ property: 'timeOnIcePerGame', direction: 'DESC' }, { property: 'playerId', direction: 'ASC' }]);
    const toiBy = Object.fromEntries(toi.map(r => [r.playerId, r]));
    const glRaw = await restPaged(`/goalie/summary?cayenneExp=seasonId=${season} and gameTypeId=2`, GOALIES, [{ property: 'wins', direction: 'DESC' }, { property: 'playerId', direction: 'ASC' }]);
    // teamAbbrevs is comma-joined for a traded player; his mug lives with the
    // club he finished on.
    const lastTeam = (s) => (s || '').split(',').pop().trim();
    const skaters = skRaw.map(r => ({
      pid: r.playerId, name: r.skaterFullName, team: lastTeam(r.teamAbbrevs), pos: r.positionCode,
      gp: r.gamesPlayed, g: r.goals, a: r.assists, p: r.points, ppg: r.ppGoals, shg: r.shGoals,
      gwg: r.gameWinningGoals, s: r.shots, shPct: r.shootingPct, pim: r.penaltyMinutes, pm: r.plusMinus,
      toi: r.timeOnIcePerGame, ppToi: toiBy[r.playerId]?.ppTimeOnIcePerGame ?? null,
      ppp: r.ppPoints, ptsPg: r.pointsPerGame, shoots: r.shootsCatches,
    }));
    const goalies = glRaw.map(r => ({
      pid: r.playerId, name: r.goalieFullName, team: lastTeam(r.teamAbbrevs), pos: 'G',
      gp: r.gamesPlayed, gs: r.gamesStarted, w: r.wins, l: r.losses, otl: r.otLosses,
      sv: r.saves, sa: r.shotsAgainst, svPct: r.savePct, gaa: r.goalsAgainstAverage,
      so: r.shutouts, toi: r.timeOnIce != null && r.gamesPlayed ? r.timeOnIce / r.gamesPlayed : null,
      catches: r.shootsCatches,
    }));
    return { skaters, goalies };
  }
  let L = await leaders(UP.id), leaderSeason = UP.id;
  if (!L.skaters.length) { L = await leaders(HIST.id); leaderSeason = HIST.id; }
  console.log(`  ${L.skaters.length} skaters, ${L.goalies.length} goalies (${leaderSeason})`);

  // ── 6) Shots on goal ───────────────────────────────────────────────────
  // Priced for the next date that has regular-season games, which is what the
  // app opens on. Preseason is deliberately not priced: the rosters are not
  // the rosters.
  console.log('Pricing shots on goal…');
  const upcoming = schedule.filter(g => g.type === 2 && g.date >= today)
    .reduce((d, g) => d || g.date, null);
  const slate = schedule.filter(g => g.type === 2 && g.date === upcoming);
  const playedDates = [...new Set(schedule
    .filter(g => g.type === 2 && g.state !== 'FUT' && g.date < (upcoming || '9999'))
    .map(g => g.date))].sort();
  let shots = { board: [], model: null, date: upcoming || null };
  let picks = { picks: [], model: null, date: upcoming || null };
  try {
    const r = await buildShotsBoard({
      season: UP.id, prevSeason: HIST.id, games: slate, playedDates,
    });
    shots = { board: r.board, model: r.model, date: upcoming || null };
    picks = { picks: r.picks, model: r.picksModel, date: upcoming || null };
    console.log(`  ${r.board.length} skaters priced for ${upcoming} (${slate.length} games), ${r.picks.length} goal prices`);
  } catch (e) {
    console.error('  shots board failed:', e.message);
  }

  // ── 7) Freeze and grade the Picks board ────────────────────────────────
  // Each night's board is frozen before its first puck drop — rewritten on
  // every build until then, so it holds the last pre-game prices — and graded
  // once every game in it is final. Rows are [pid, p, scored|null, gameId].
  //
  // A skater who did not dress is VOID, not a miss: that is how a book settles
  // an anytime bet, and counting scratches as zeros would drag the live hit
  // rate below what the prices actually earned. Who dressed comes from each
  // game's boxscore, since the recap only lists who scored.
  const HIST_PATH = new URL('../nhl/picks-history.json', import.meta.url);
  let hist = {};
  try { hist = JSON.parse(fs.readFileSync(HIST_PATH, 'utf8')); } catch (e) { hist = {}; }
  if (upcoming && picks.picks.length) {
    const started = schedule.some(g => g.date === upcoming && g.type === 2 && !['FUT', 'PRE'].includes(g.state));
    if (!started) hist[upcoming] = picks.picks.map(r => [r.pid, r.p, null, r.gameId]);
  }
  let graded = 0;
  for (const [d, rows] of Object.entries(hist)) {
    if (!rows.some(x => x[2] == null)) continue;
    const gids = [...new Set(rows.map(x => x[3]))];
    if (!gids.every(id => recapGames[id])) continue;          // not all final yet
    const scorers = new Set((recap[d] || []).map(x => x.pid));
    const dressed = new Set();
    for (const id of gids) {
      try {
        const bx = await web(`/gamecenter/${id}/boxscore`);
        for (const side of ['awayTeam', 'homeTeam'])
          for (const grp of ['forwards', 'defense'])
            for (const pl of bx.playerByGameStats?.[side]?.[grp] || []) dressed.add(pl.playerId);
      } catch (e) { /* leave this game ungraded; the next build retries */ }
    }
    if (!dressed.size) continue;
    hist[d] = rows.map(([pid, pp, , gid]) => [pid, pp, dressed.has(pid) ? (scorers.has(pid) ? 1 : 0) : -1, gid]);
    graded++;
  }
  // -1 = did not dress (void). The app counts only 0 and 1.
  fs.writeFileSync(HIST_PATH, JSON.stringify(hist));
  const nGraded = Object.values(hist).filter(r => r.every(x => x[2] != null)).length;
  console.log(`  picks history: ${Object.keys(hist).length} nights frozen, ${nGraded} graded${graded ? ` (${graded} new)` : ''}`);

  // ── 8) Write ───────────────────────────────────────────────────────────
  const output = {
    generated: new Date().toISOString(),
    season: UP.id, seasonLabel: label(UP),
    seasonStart: ymd(UP.startDate), seasonEnd: ymd(UP.regularSeasonEndDate), seasonGames: UP.numberOfGames,
    leaderSeason, leaderSeasonLabel: label(seasons.find(s => s.id === leaderSeason)),
    standingsDate, standingsStale: !!standingsStale,
    teams, schedule, dates,
    recap, recapDates, recapGames,
    leaders: L.skaters, goalies: L.goalies,
    shots, picks,
    // graded nights only, voids dropped, as [pid, p, scored]
    picksHistory: Object.fromEntries(Object.entries(hist)
      .filter(([, r]) => r.every(x => x[2] != null))
      .map(([d, r]) => [d, r.filter(x => x[2] >= 0).map(x => [x[0], x[1], x[2]])])),
  };
  const out = new URL('../nhl/data.json', import.meta.url);
  fs.mkdirSync(new URL('../nhl/', import.meta.url), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(output));
  const kb = (fs.statSync(out).size / 1024).toFixed(0);
  console.log(`Wrote nhl/data.json — ${kb} KB`);

  // Degraded-build guard, same idea as the MLB one: a feed that answers 200
  // with nothing should fail the build, not quietly ship an empty app.
  const bad = [];
  if (Object.keys(teams).length < 32) bad.push(`only ${Object.keys(teams).length} teams`);
  if (!schedule.length) bad.push('no schedule');
  if (!L.skaters.length) bad.push('no skater leaders');
  if (bad.length) { console.error('Degraded build: ' + bad.join(', ')); process.exit(1); }
}

main().catch(e => { console.error(e); process.exit(1); });
