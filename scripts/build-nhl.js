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
import { buildShotsBoard, TEAM_ABBREV } from './nhl-shots.js';
import { gameGoalDetail } from './nhl-goal-detail.js';
import { buildPlayersLog } from './nhl-players.js';
import { buildSavesBoard } from './nhl-saves.js';
import { fetchLines, impliedRates } from './nhl-lines.js';
import { fetchEspnLines, trackLine } from './espn-lines.js';
import { buildFun } from './nhl-fun.js';

const LEADERS = 300;      // skaters on the Stats board
const GOALIES = 90;       // ~3 per club
const RECAP_DATES = 21;   // dates of goal-by-goal recap kept (a rolling 3 weeks)
const SCAN_BACK = 150;    // how far back to look for those dates before giving up
const SCAN_GAP = 21;      // ...but stop after this many empty days once we have some

const ymd = (s) => (s || '').slice(0, 10);
// nhl.com video pages end in the Brightcove id the app plays them by:
// "/video/lak-at-bos-recap-6390714705112" -> "6390714705112". Kept a string —
// they are 13 digits today and there's no reason to find out where doubles stop.
const vidId = (path) => (String(path || '').match(/(\d{9,})\/?$/) || [])[1] || null;

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
  // Per-game team rates for the schedule's Matchup tab: shots, special teams,
  // faceoffs. The season being played once it has games, last season's before.
  try {
    let rows = await restPaged(`/team/summary?cayenneExp=seasonId=${UP.id} and gameTypeId=2`, Infinity, [{ property: 'teamId', direction: 'ASC' }]);
    let season = UP.id;
    if (!rows.some(r => r.gamesPlayed)) { rows = await restPaged(`/team/summary?cayenneExp=seasonId=${HIST.id} and gameTypeId=2`, Infinity, [{ property: 'teamId', direction: 'ASC' }]); season = HIST.id; }
    for (const r of rows) {
      const t = teams[TEAM_ABBREV[r.teamFullName]]; if (!t || !r.gamesPlayed) continue;
      t.rates = { season, gp: r.gamesPlayed, gf: r.goalsForPerGame, ga: r.goalsAgainstPerGame, sf: r.shotsForPerGame, sa: r.shotsAgainstPerGame,
                  pp: r.powerPlayPct, pk: r.penaltyKillPct, fo: r.faceoffWinPct };
    }
  } catch (e) { console.warn(`  team rates skipped: ${e.message}`); }
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
          rv: vidId(g.threeMinRecap), cv: vidId(g.condensedGame),
        });
      }
    }
    const next = wk.nextStartDate;
    cursor = next && next > cursor ? next : null;
  }
  schedule.sort((a, b) => a.date.localeCompare(b.date) || (a.start || '').localeCompare(b.start || '') || a.gameId - b.gameId);
  const dates = [...new Set(schedule.map(g => g.date))];

  // Pre-game lines (ESPN / DraftKings) for the next eight regular-season nights.
  // Display only — never an input to a model. A failed fetch just leaves
  // those games without lines.
  try {
    const ahead = [...new Set(schedule.filter(g => g.type === 2 && g.date >= today && !['OFF', 'FINAL'].includes(g.state))
      .map(g => g.date))].slice(0, 8);
    const L = await fetchLines(ahead);
    let n = 0;
    for (const g of schedule) {
      // only before puck drop: ESPN swaps in live odds once a game starts, and
      // the line we keep is the closing one
      if (!['FUT', 'PRE'].includes(g.state)) continue;
      const x = L.get(`${g.date}|${g.away}|${g.home}`);
      if (x) { g.lines = x; n++; }
    }
    console.log(`  lines: ${n} games across ${ahead.length} upcoming nights`);
  } catch (e) { console.warn(`  lines skipped: ${e.message}`); }
  // Closing lines carry forward: a game keeps the last line it had before puck
  // drop, which is what its game-flow chart prices from once it's under way.
  try {
    const prev = JSON.parse(fs.readFileSync(new URL('../nhl/data.json', import.meta.url), 'utf8'));
    const had = new Map((prev.schedule || []).filter(g => g.lines).map(g => [g.gameId, g.lines]));
    let kept = 0;
    for (const g of schedule) if (!g.lines && had.has(g.gameId)) { g.lines = had.get(g.gameId); kept++; }
    if (kept) console.log(`  lines: ${kept} closing lines carried forward`);
  } catch (e) { /* first build */ }
  for (const g of schedule) { const r = g.lines && impliedRates(g.lines); if (r) g.lam = r; }
  // Line movement (scripts/espn-lines.js): open and current moneyline, puck line
  // and total, plus every change a build saw — g.move, beside g.lines. In hockey
  // the puck line sits at 1.5 and the total at 5.5/6.5, so what moves is the
  // moneyline and the price on the total. Only read before puck drop; a started
  // game keeps what it had.
  try {
    const prevMove = new Map();
    try { for (const g of JSON.parse(fs.readFileSync(new URL('../nhl/data.json', import.meta.url), 'utf8')).schedule || []) if (g.move) prevMove.set(g.gameId, g.move); } catch (e) { /* first build */ }
    const ahead = [...new Set(schedule.filter(g => g.type === 2 && g.date >= today && ['FUT', 'PRE'].includes(g.state)).map(g => g.date))].slice(0, 8);
    const fresh = await fetchEspnLines('nhl', ahead, { LA: 'LAK', NJ: 'NJD', SJ: 'SJS', TB: 'TBL', UTAH: 'UTA', MON: 'MTL' });
    let n = 0;
    for (const g of schedule) {
      const prev = prevMove.get(g.gameId);
      const x = ['FUT', 'PRE'].includes(g.state) ? fresh.find(f => f.date === g.date && f.away === g.away && f.home === g.home) : null;
      if (x) { g.move = trackLine(prev, x.line); n++; } else if (prev) g.move = prev;
    }
    console.log(`  line movement: ${n} games tracked, ${prevMove.size} carried`);
  } catch (e) { console.warn(`  line movement skipped: ${e.message}`); }
  console.log(`  ${schedule.length} games over ${dates.length} dates`);

  // ── 4) Recap: every goal, by date ──────────────────────────────────────
  // Walk backwards from today until we have RECAP_DATES dates that actually had
  // finished games. In September that walks back into last season's playoffs,
  // which is the right answer — the alternative is an empty recap page.
  console.log('Fetching goal recaps…');
  const recap = {}, recapGames = {};
  // Goal detail (distance, shot type, goalie, puck speed) costs a play-by-play
  // per game and a tracking replay per goal, and a final game never changes —
  // so carry it forward from the last build and only fetch what's new. A goal
  // whose speed didn't come back is retried for two days, then left alone.
  const prevDetail = {};
  try {
    const prev = JSON.parse(fs.readFileSync(new URL('../nhl/data.json', import.meta.url), 'utf8'));
    for (const [pd, list] of Object.entries(prev.recap || {}))
      for (const x of list) if (x.dx) (prevDetail[x.gameId] ??= { date: pd, rows: {} }).rows[`${x.period}|${x.time}|${x.pid}`] =
        { dist: x.dist ?? null, shot: x.shot ?? null, gid: x.gid ?? null, goalie: x.goalie ?? null, spd: x.spd ?? null };
  } catch (e) { /* first build, or no recap yet */ }
  let detFetched = 0, detReused = 0;
  const detailFor = async (g, d) => {
    const had = prevDetail[g.id];
    const stale = had && Object.values(had.rows).some(r => r.spd == null) && d >= shiftDate(today, -2);
    if (had && !stale && Object.keys(had.rows).length >= (g.goals || []).filter(x => x.periodDescriptor?.periodType !== 'SO').length) {
      detReused++; return had.rows;
    }
    try { detFetched++; return await gameGoalDetail(g.id); }
    catch (e) { console.warn(`  goal detail ${g.id}: ${e.message}`); return had?.rows || {}; }
  };
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
        rv: vidId(g.threeMinRecap), cv: vidId(g.condensedGame),
      };
      const det = (g.goals || []).length ? await detailFor(g, d) : {};
      for (const [k, go] of (g.goals || []).entries()) {
        const period = go.periodDescriptor?.number ?? go.period;
        const dt = det[`${period}|${go.timeInPeriod}|${go.playerId}`];
        goals.push({
          gameId: g.id, k, pid: go.playerId,
          name: [go.firstName?.default, go.lastName?.default].filter(Boolean).join(' ') || go.name?.default || '',
          team: go.teamAbbrev?.default || go.teamAbbrev, mug: go.mugshot || null,
          period, ptype: go.periodDescriptor?.periodType || 'REG',
          time: go.timeInPeriod, strength: go.strength || 'ev',
          mod: go.goalModifier && go.goalModifier !== 'none' ? go.goalModifier : null,
          season: go.goalsToDate ?? null,
          assists: (go.assists || []).map(a => ({ pid: a.playerId, name: a.name?.default || '' })),
          a: g.awayTeam.abbrev, h: g.homeTeam.abbrev, as: go.awayScore, hs: go.homeScore,
          clip: go.highlightClipSharingUrl || null,
          vid: go.highlightClip ? String(go.highlightClip) : null,
          ...(dt ? { dx: 1, dist: dt.dist, shot: dt.shot, gid: dt.gid, goalie: dt.goalie, spd: dt.spd } : {}),
        });
      }
    }
    recap[d] = goals;
    // A date with finals but no goals parsed means the feed hasn't filled in
    // yet; keep the date (the games are real) but don't count it as a full one.
    console.log(`  ${d}: ${finals.length} games, ${goals.length} goals`);
  }
  const recapDates = Object.keys(recap).sort();
  console.log(`  goal detail: ${detFetched} games fetched, ${detReused} carried forward`);

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
  let points = { board: [], model: null, date: upcoming || null };
  let hits = { board: [], model: null, date: upcoming || null };
  let blocks = { board: [], model: null, date: upcoming || null };
  try {
    const r = await buildShotsBoard({
      season: UP.id, prevSeason: HIST.id, games: slate, playedDates,
    });
    shots = { board: r.board, model: r.model, date: upcoming || null };
    picks = { picks: r.picks, model: r.picksModel, date: upcoming || null };
    points = { board: r.points, model: r.pointsModel, date: upcoming || null };
    hits = { board: r.phys.hits, model: r.physModel.hits, date: upcoming || null };
    blocks = { board: r.phys.bks, model: r.physModel.bks, date: upcoming || null };
    console.log(`  ${r.board.length} skaters priced for ${upcoming} (${slate.length} games), ${r.picks.length} goal prices`);
  } catch (e) {
    console.error('  shots board failed:', e.message);
  }

  // ── 6b) Saves and goals allowed ────────────────────────────────────────
  console.log('Pricing saves…');
  let saves = { board: [], model: null, date: upcoming || null };
  try {
    const r = await buildSavesBoard({ season: UP.id, prevSeason: HIST.id, games: slate, playedDates, schedule, recapGames });
    saves = { board: r.board, model: r.model, date: upcoming || null };
    console.log(`  ${r.board.length} projected starters priced for ${upcoming}`);
  } catch (e) {
    console.error('  saves board failed:', e.message);
  }

  // ── 7) Freeze and grade the Picks board ────────────────────────────────
  // Each night's board is frozen before its first puck drop — rewritten on
  // every build until then, so it holds the last pre-game prices — and graded
  // once every game in it is final. Rows are
  //   [pid, p, scored|null, gameId, p2, p3, pFirst, pLast, pP1, pPP,
  //    goals, first, last, p1Goals, ppGoals]
  // — the anytime price plus the six other goal markets, and what happened in
  // each, read off the recap's goal order (shootout goals are not goals).
  //
  // A skater who did not dress is VOID, not a miss: that is how a book settles
  // an anytime bet, and counting scratches as zeros would drag the live hit
  // rate below what the prices actually earned. Who dressed comes from each
  // game's boxscore, since the recap only lists who scored.
  const HIST_PATH = new URL('../nhl/picks-history.json', import.meta.url);
  let hist = {};
  try { hist = JSON.parse(fs.readFileSync(HIST_PATH, 'utf8')); } catch (e) { hist = {}; }
  // Every board freezes GAME BY GAME: a game's rows lock at the last build
  // before its own puck drop, while the night's later games keep refreshing
  // (goalie confirmations, scratches, line moves). Freezing the whole night at
  // its first puck priced a 10pm game off the morning build. `gi` is where a
  // row keeps its gameId.
  const puckDropped = new Set(schedule.filter(g => g.date === upcoming && g.type === 2 && !['FUT', 'PRE'].includes(g.state)).map(g => g.gameId));
  const refreeze = (H, fresh, gi) => {
    const kept = (H[upcoming] || []).filter(x => puckDropped.has(x[gi]));
    H[upcoming] = [...kept, ...fresh.filter(x => !puckDropped.has(x[gi]))];
  };
  if (upcoming && picks.picks.length) refreeze(hist, picks.picks.map(r => [r.pid, r.p, null, r.gameId,
      r.p2, r.p3, r.pFirst, r.pLast, r.pP1, r.pPP, null, null, null, null, null]), 3);
  // One boxscore read per game, shared by both graders: who dressed, and how
  // many shots each put on net. null when the fetch fails — the next build retries.
  // Goalies ride along in goalieBox: pid -> { starter, saves, ga }.
  const boxCache = new Map(), goalieBox = new Map();
  const physBox = new Map();      // 'pid|gameId' -> { hits, bks }, off the same boxscores (Hits / Blocks grading)
  async function boxscore(id) {
    if (boxCache.has(id)) return boxCache.get(id);
    let out = null;
    try {
      const bx = await web(`/gamecenter/${id}/boxscore`);
      out = new Map();
      for (const side of ['awayTeam', 'homeTeam']) {
        for (const grp of ['forwards', 'defense'])
          for (const pl of bx.playerByGameStats?.[side]?.[grp] || []) {
            out.set(pl.playerId, pl.sog ?? 0);
            physBox.set(pl.playerId + '|' + id, { hits: pl.hits ?? 0, bks: pl.blockedShots ?? 0 });
          }
        for (const pl of bx.playerByGameStats?.[side]?.goalies || [])
          goalieBox.set(pl.playerId, { starter: !!pl.starter, saves: pl.saves ?? 0, ga: pl.goalsAgainst ?? 0 });
      }
      if (!out.size) out = null;
    } catch (e) { out = null; }
    boxCache.set(id, out);
    return out;
  }
  async function dressedIn(gids) {
    const all = new Map();
    for (const id of gids) {
      const b = await boxscore(id);
      if (!b) return null;                                    // any game missing -> grade later
      for (const [k, v] of b) all.set(k, v);
    }
    return all;
  }

  let graded = 0;
  for (const [d, rows] of Object.entries(hist)) {
    if (!rows.some(x => x[2] == null)) continue;
    const gids = [...new Set(rows.map(x => x[3]))];
    if (!gids.every(id => recapGames[id])) continue;          // not all final yet
    const scorers = new Set((recap[d] || []).map(x => x.pid));
    const dressed = await dressedIn(gids);
    if (!dressed) continue;
    // per game: the goal order, shootout excluded
    const byGame = {};
    for (const x of recap[d] || []) if (x.ptype !== 'SO') (byGame[x.gameId] ??= []).push(x);
    for (const g of Object.values(byGame)) g.sort((a, b) => a.k - b.k);
    hist[d] = rows.map(([pid, pp, , gid, ...mk]) => {
      if (!dressed.has(pid)) return [pid, pp, -1, gid, ...mk.slice(0, 6), -1, -1, -1, -1, -1];
      const gl = byGame[gid] || [], mine = gl.filter(x => x.pid === pid);
      return [pid, pp, scorers.has(pid) ? 1 : 0, gid, ...mk.slice(0, 6),
              mine.length, gl[0]?.pid === pid ? 1 : 0, gl[gl.length - 1]?.pid === pid ? 1 : 0,
              mine.filter(x => x.period === 1).length, mine.filter(x => x.strength === 'pp').length];
    });
    graded++;
  }
  // -1 = did not dress (void). The app counts only 0 and 1.
  fs.writeFileSync(HIST_PATH, JSON.stringify(hist));
  // The schedule's top pick per game — the frozen board's shortest price in it —
  // with its result, so every played game shows the pick it had at puck drop,
  // graded. Names ride along from the board they were frozen from (the history
  // file keeps only ids), carried build to build. Last 30 nights.
  let schedTops = {};
  {
    let prevTops = {};
    try { prevTops = JSON.parse(fs.readFileSync(new URL('../nhl/data.json', import.meta.url), 'utf8')).schedTops || {}; } catch (e) { /* first build */ }
    const board = new Map((picks.picks || []).map(r => [r.pid, r]));
    for (const d of Object.keys(hist).sort().slice(-30)) {
      const best = {};
      for (const x of hist[d]) if (!best[x[3]] || x[1] > best[x[3]][1]) best[x[3]] = x;
      for (const [gid, x] of Object.entries(best)) {
        const prev = prevTops[gid], r = board.get(x[0]);
        const name = prev?.pid === x[0] ? prev.name : r?.name, pos = prev?.pid === x[0] ? prev.pos : r?.pos;
        if (!name) continue;
        schedTops[gid] = { pid: x[0], name, pos, p: x[1], res: x[2], goals: x[10] ?? null };
      }
    }
  }
  const nGraded = Object.values(hist).filter(r => r.every(x => x[2] != null)).length;
  console.log(`  picks history: ${Object.keys(hist).length} nights frozen, ${nGraded} graded${graded ? ` (${graded} new)` : ''}`);

  // ── 7b) Freeze and grade the Shots board ──────────────────────────────
  // Same cycle as Picks, graded at the line the board quoted — the one whose
  // price sits closest to even, which is what the app shows by default. Rows:
  //   [pid, mu, line, pOver, got, gameId, name, team, opp]
  // got = shots on goal from the boxscore, -1 if he did not dress (void), null
  // until every game that night is final. Names ride along because a graded
  // night is shown long after its skaters have left the live board. Shipped
  // as its own file and loaded by the Results tab only, like /nfl's results.json.
  const SH_PATH = new URL('../nhl/shots-history.json', import.meta.url);
  let shHist = {};
  try { shHist = JSON.parse(fs.readFileSync(SH_PATH, 'utf8')); } catch (e) { shHist = {}; }
  if (upcoming && shots.board.length) refreeze(shHist, shots.board.map(r => {
      const L = Object.keys(r.p).map(Number).reduce((b, x) => Math.abs(r.p[x] - 0.5) < Math.abs(r.p[b] - 0.5) ? x : b);
      return [r.pid, r.mu, L, r.p[L], null, r.gameId, r.name, r.team, r.opp];
    }), 5);
  let shGraded = 0;
  for (const [d, rows] of Object.entries(shHist)) {
    if (!rows.some(x => x[4] == null)) continue;
    const gids = [...new Set(rows.map(x => x[5]))];
    if (!gids.every(id => recapGames[id])) continue;
    const dressed = await dressedIn(gids);
    if (!dressed) continue;
    shHist[d] = rows.map(x => { const y = x.slice(); y[4] = dressed.has(x[0]) ? dressed.get(x[0]) : -1; return y; });
    shGraded++;
  }
  fs.writeFileSync(SH_PATH, JSON.stringify(shHist));
  const shDone = Object.values(shHist).filter(r => r.every(x => x[4] != null)).length;
  console.log(`  shots history: ${Object.keys(shHist).length} nights frozen, ${shDone} graded${shGraded ? ` (${shGraded} new)` : ''}`);

  // ── 7b2) Freeze and grade the Hits and Blocks boards ─────────────────
  // One row per skater, both markets at their quoted (closest-to-even) lines:
  //   [pid, muHits, hitsLine, pOver, gotHits, gameId, name, team, opp, muBks, bksLine, pOver, gotBks]
  // A skater who did not dress is a void (-1) on both, as on Shots.
  const PH_PATH = new URL('../nhl/phys-history.json', import.meta.url);
  let phHist = {};
  try { phHist = JSON.parse(fs.readFileSync(PH_PATH, 'utf8')); } catch (e) { phHist = {}; }
  if (upcoming && hits.board.length) {
    const quote = (r) => { const L = Object.keys(r.p).map(Number).reduce((b, x) => Math.abs(r.p[x] - 0.5) < Math.abs(r.p[b] - 0.5) ? x : b); return [r.mu, L, r.p[L]]; };
    const bk = new Map(blocks.board.map(r => [r.pid, r]));
    refreeze(phHist, hits.board.filter(r => bk.has(r.pid)).map(r =>
      [r.pid, ...quote(r), null, r.gameId, r.name, r.team, r.opp, ...quote(bk.get(r.pid)), null]), 5);
  }
  let phGraded = 0;
  for (const [d, rows] of Object.entries(phHist)) {
    if (!rows.some(x => x[4] == null)) continue;
    const gids = [...new Set(rows.map(x => x[5]))];
    if (!gids.every(id => recapGames[id])) continue;
    const dressed = await dressedIn(gids);
    if (!dressed) continue;
    phHist[d] = rows.map(x => {
      const y = x.slice(), b = physBox.get(x[0] + '|' + x[5]);
      y[4] = dressed.has(x[0]) && b ? b.hits : -1; y[12] = dressed.has(x[0]) && b ? b.bks : -1;
      return y;
    });
    phGraded++;
  }
  fs.writeFileSync(PH_PATH, JSON.stringify(phHist));
  const phDone = Object.values(phHist).filter(r => r.every(x => x[4] != null)).length;
  console.log(`  hits/blocks history: ${Object.keys(phHist).length} nights frozen, ${phDone} graded${phGraded ? ` (${phGraded} new)` : ''}`);

  // ── 7c) Freeze and grade the Saves board ──────────────────────────────
  // Same cycle again, both markets at their quoted (closest-to-even) lines:
  //   [pid, mu, line, pOver, got, gameId, name, team, opp, muGa, gaLine, gaPOver, gotGa]
  // A projected starter who did not START is a void (-1) on both — a backup
  // who came on in relief is not the bet the board offered.
  const SV_PATH = new URL('../nhl/saves-history.json', import.meta.url);
  let svHist = {};
  try { svHist = JSON.parse(fs.readFileSync(SV_PATH, 'utf8')); } catch (e) { svHist = {}; }
  if (upcoming && saves.board.length) refreeze(svHist, saves.board.map(r =>
      [r.pid, r.mu, r.q.line, r.q.p, null, r.gameId, r.name, r.team, r.opp, r.muGa, r.qGa.line, r.qGa.p, null]), 5);
  let svGraded = 0;
  for (const [d, rows] of Object.entries(svHist)) {
    if (!rows.some(x => x[4] == null)) continue;
    const gids = [...new Set(rows.map(x => x[5]))];
    if (!gids.every(id => recapGames[id])) continue;
    if (!(await dressedIn(gids))) continue;                  // fills goalieBox for every game
    svHist[d] = rows.map(x => {
      const y = x.slice(), b = goalieBox.get(x[0]);
      y[4] = b?.starter ? b.saves : -1; y[12] = b?.starter ? b.ga : -1;
      return y;
    });
    svGraded++;
  }
  fs.writeFileSync(SV_PATH, JSON.stringify(svHist));
  const svDone = Object.values(svHist).filter(r => r.every(x => x[4] != null)).length;
  console.log(`  saves history: ${Object.keys(svHist).length} nights frozen, ${svDone} graded${svGraded ? ` (${svGraded} new)` : ''}`);

  // ── 7e) Freeze and grade the Points board ─────────────────────────────
  // Three markets at their quoted (closest-to-even) lines, Poisson on each mean:
  //   [pid, gameId, name, team, opp,  muPts, Lpts, pPts, gotPts,  muA, La, pA, gotA,  muPpp, Lppp, pPpp, gotPpp]
  // Graded off the recap: every non-shootout goal credits its scorer and its
  // assisters, and a power-play goal counts as a PP point for all of them. A
  // skater who did not dress is -1 (void) on all three.
  const PT_PATH = new URL('../nhl/points-history.json', import.meta.url);
  let ptHist = {};
  try { ptHist = JSON.parse(fs.readFileSync(PT_PATH, 'utf8')); } catch (e) { ptHist = {}; }
  const pois = (mu, L) => { let t = Math.exp(-mu), c = t; for (let k = 1; k <= Math.floor(L); k++) { t *= mu / k; c += t; } return 1 - c; };
  const quote = (mu) => { let best = 0.5; for (let L = 0.5; L <= 4.5; L++) if (Math.abs(pois(mu, L) - 0.5) < Math.abs(pois(mu, best) - 0.5)) best = L; return [best, +pois(mu, best).toFixed(4)]; };
  if (upcoming && points.board.length) refreeze(ptHist, points.board.map(r => {
      const [Lp, pp] = quote(r.mu.pts), [La, pa] = quote(r.mu.a), [Lq, pq] = quote(r.mu.ppp);
      return [r.pid, r.gameId, r.name, r.team, r.opp, r.mu.pts, Lp, pp, null, r.mu.a, La, pa, null, r.mu.ppp, Lq, pq, null];
    }), 1);
  let ptGraded = 0;
  for (const [d, rows] of Object.entries(ptHist)) {
    if (!rows.some(x => x[8] == null)) continue;
    const gids = [...new Set(rows.map(x => x[1]))];
    if (!gids.every(id => recapGames[id])) continue;
    const dressed = await dressedIn(gids);
    if (!dressed) continue;
    const tally = new Map();                        // pid -> [points, assists, ppPoints]
    const add = (pid, pts, a, ppp) => { const t = tally.get(pid) || [0, 0, 0]; t[0] += pts; t[1] += a; t[2] += ppp; tally.set(pid, t); };
    for (const x of recap[d] || []) {
      if (x.ptype === 'SO') continue;
      const pp = x.strength === 'pp' ? 1 : 0;
      add(x.pid, 1, 0, pp);
      for (const a of x.assists || []) add(a.pid, 1, 1, pp);
    }
    ptHist[d] = rows.map(x => {
      const y = x.slice();
      if (!dressed.has(x[0])) { y[8] = y[12] = y[16] = -1; return y; }
      const t = tally.get(x[0]) || [0, 0, 0];
      y[8] = t[0]; y[12] = t[1]; y[16] = t[2];
      return y;
    });
    ptGraded++;
  }
  fs.writeFileSync(PT_PATH, JSON.stringify(ptHist));
  const ptDone = Object.values(ptHist).filter(r => r.every(x => x[8] != null)).length;
  console.log(`  points history: ${Object.keys(ptHist).length} nights frozen, ${ptDone} graded${ptGraded ? ` (${ptGraded} new)` : ''}`);

  // ── 7d) Player card archive: game logs + every goal this season ───────
  console.log('Updating player logs…');
  let playersLog = null;
  try { playersLog = await buildPlayersLog({ season: UP.id, schedule, recap, recapGames }); }
  catch (e) { console.warn(`  players.json not updated: ${e.message}`); }   // the card degrades; the build doesn't

  // ── 7e) Birthdays, Milestones, Due ─────────────────────────────────────
  console.log('Birthdays, milestones, droughts…');
  let fun = null;
  try {
    fun = await buildFun({ season: UP.id, hist: HIST.id, today, schedule, picks: picks.picks, log: playersLog });
    console.log(`  ${fun.birthdays.length} birthdays this week, ${fun.milestones.length} milestone chases, ${fun.due.length} droughts`);
  } catch (e) { console.warn(`  fun pages not built: ${e.message}`); }

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
    shots, picks, saves, points, hits, blocks, fun,
    // measured parlay multipliers (research/nhl_pairs.py, research/nhl_stacks.py):
    // goal-scorer groups vs the naive product, and scorer + assister stacks by
    // how many games this season the assister has set the scorer up
    parlay: (() => {
      const rd = (f) => JSON.parse(fs.readFileSync(new URL(`../research/${f}`, import.meta.url), 'utf8'));
      const g = rd('nhl_pairs_model.json'), st = rd('nhl_stacks_model.json');
      return { rho_same: g.rho_same, rho_cross: g.rho_cross, same_by_size: g.same_by_size, stack: st.bins };
    })(),
    // in-game win probability (research/nhl_winprob.py) — the schedule's game flow
    winprob: (({ late, m_lead, m_trail, ot_shrink }) => ({ late, m_lead, m_trail, ot_shrink }))(
      JSON.parse(fs.readFileSync(new URL('../research/nhl_winprob_model.json', import.meta.url), 'utf8'))),
    // graded nights only, voids dropped, as
    //   [pid, p, scored, p2, p3, pFirst, pLast, pP1, pPP, goals, first, last, p1Goals, ppGoals]
    // (nights frozen before the extra markets carry only the first three)
    schedTops,
    picksHistory: Object.fromEntries(Object.entries(hist)
      .filter(([, r]) => r.every(x => x[2] != null))
      .map(([d, r]) => [d, r.filter(x => x[2] >= 0).map(x => x.length > 4 ? [x[0], x[1], x[2], ...x.slice(4)] : [x[0], x[1], x[2]])])),
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
