// Ron's Tud Tool — NFL data build. Mirrors build-data.js (MLB): fetch open
// nflverse CSVs (no API key), shape them, write nfl/data.json. Sources:
//   - nfldata games.csv        -> schedule + betting lines (2022-2026)
//   - nflverse play_by_play    -> every TD, for weekly recaps (like MLB HR recaps)
//   - nflverse stats_player    -> weekly player stats -> TD + opportunity leaders
import fs from 'node:fs';
import { fetchText, parseCsv, num } from './nflverse.js';
import { buildPicks, loadTdSet, updateHistory } from './picks.js';

const HISTORY_SEASON = 2025;   // last completed season — our historical base until 2026 games play
const UPCOMING_SEASON = 2026;
const REG_WEEKS = 18;           // weeks 19+ in results are the playoffs
const MILESTONE_MAX_AWAY = 25;  // a chase you could finish inside a season  // full schedule already published

const cleanName = (n) => (n || '').trim();

async function main() {
  // ── 1) Schedule + lines ────────────────────────────────────────────────
  console.log('Fetching schedule + lines (nfldata games.csv)…');
  const { idx: gi, rows: grows } = parseCsv(await fetchText('https://raw.githubusercontent.com/nflverse/nfldata/master/data/games.csv'));
  const game = (r, k) => r[gi[k]];
  const schedule = grows.filter(r => +game(r, 'season') === UPCOMING_SEASON).map(r => ({
    gameId: game(r, 'game_id'), week: +game(r, 'week'), type: game(r, 'game_type'),
    gameday: game(r, 'gameday'), gametime: game(r, 'gametime') || null, weekday: game(r, 'weekday'),
    away: game(r, 'away_team'), home: game(r, 'home_team'),
    spread: num(game(r, 'spread_line')), total: num(game(r, 'total_line')),
    awayScore: num(game(r, 'away_score')), homeScore: num(game(r, 'home_score')),
  }));
  // results map for the historical season (to caption recap games + day-of-week filtering)
  const results = {};
  for (const r of grows) if (+game(r, 'season') === HISTORY_SEASON)
    results[game(r, 'game_id')] = { away: game(r, 'away_team'), home: game(r, 'home_team'), aScore: num(game(r, 'away_score')), hScore: num(game(r, 'home_score')), week: +game(r, 'week'), gameday: game(r, 'gameday'), weekday: game(r, 'weekday') };

  // ── 2) Every TD -> weekly recap (from play-by-play) ────────────────────
  console.log(`Fetching ${HISTORY_SEASON} play-by-play for TD recaps (large file)…`);
  const { idx: pi, rows: prows } = parseCsv(await fetchText(`https://github.com/nflverse/nflverse-data/releases/download/pbp/play_by_play_${HISTORY_SEASON}.csv`));
  const P = (r, k) => r[pi[k]];
  const tdRecap = {}; // week -> [ {player, team, opp, type, yards, qtr, passer, gameId, firstTd, lastTd, multi, weekday} ]
  let tdTotal = 0;
  const gameHasTd = new Set(); // gameIds that have already scored a TD -> flags the first one
  // Per-player TD tallies from pbp — the authoritative source since it also
  // captures return TDs (kick/punt/INT/fumble), which the offensive weekly
  // stats don't. pid -> {rush, rec, ret, first, tds, team, games:Set, name}.
  const tdAgg = {};
  for (const r of prows) {
    if (P(r, 'touchdown') !== '1') continue;
    const scorer = cleanName(P(r, 'td_player_name'));
    if (!scorer) continue; // skip odd rows with no credited scorer
    // Classify each TD to a top-level type (rush/rec/st/def) plus a specific
    // subtype so the recap can say exactly what it was:
    //   ST  -> kick (kickoff ret), punt (punt ret)
    //   DEF -> pick6 (INT ret), fumble (fumble ret by D), blk (blocked-kick ret)
    const pt = P(r, 'play_type');
    const defScored = P(r, 'td_team') && P(r, 'td_team') === P(r, 'defteam');
    let type, subtype;
    if (P(r, 'pass_touchdown') === '1') { type = 'rec'; subtype = 'rec'; }
    else if (P(r, 'rush_touchdown') === '1') { type = 'rush'; subtype = 'rush'; }
    else if (pt === 'kickoff') { type = 'st'; subtype = 'kick'; }
    else if (pt === 'punt') { type = 'st'; subtype = 'punt'; }
    else if (P(r, 'interception') === '1') { type = 'def'; subtype = 'pick6'; }
    else if (P(r, 'fumble') === '1' && defScored) { type = 'def'; subtype = 'fumble'; }
    else if (pt === 'field_goal') { type = 'def'; subtype = 'blk'; }
    else { type = 'def'; subtype = 'def'; } // rare leftovers (e.g. own-fumble recovery)
    const offensive = type === 'rush' || type === 'rec';
    // Distance: scrimmage yards for offensive TDs; the RETURN distance for
    // ST/DEF (yards_gained is wrong there — often 0 or negative). return_yards
    // is blank/0 for fumble recoveries, so leave those without a yardage.
    const yards = offensive ? num(P(r, 'yards_gained')) : (num(P(r, 'return_yards')) || null);
    const wk = P(r, 'week');
    const gameId = P(r, 'game_id');
    const pid = P(r, 'td_player_id') || null;
    const team = P(r, 'td_team') || P(r, 'posteam');
    // pbp rows are in play order within a game, so the first TD row we see for a
    // gameId is the game's opening touchdown.
    const firstTd = !gameHasTd.has(gameId); gameHasTd.add(gameId);
    (tdRecap[wk] ??= []).push({
      player: scorer, pid,
      team, opp: P(r, 'defteam'),
      type, subtype, yards, qtr: num(P(r, 'qtr')),
      passer: type === 'rec' ? cleanName(P(r, 'passer_player_name')) : null,
      gameId, firstTd, weekday: results[gameId]?.weekday || null,
    });
    if (pid) {
      const a = tdAgg[pid] ??= { rush: 0, rec: 0, st: 0, def: 0, first: 0, last: 0, multi: 0, tds: 0, team, games: new Set(), name: scorer };
      if (type === 'rush') a.rush++; else if (type === 'rec') a.rec++; else if (type === 'st') a.st++; else a.def++;
      a.tds++; a.team = team; a.games.add(gameId);
      if (firstTd) a.first++;
    }
    tdTotal++;
  }
  // Second pass for the markets that need the whole game in view.
  //   lastTd — the game's closing touchdown. pbp rows arrive in play order, so
  //            the last row we pushed for a gameId is it.
  //   multi  — the scorer had 2+ in that game, which is the 2+ market's outcome.
  // firstTd is set inline above because it only needs "have we seen one yet".
  const lastByGame = {}, perGame = {};
  for (const wk of Object.keys(tdRecap)) for (const t of tdRecap[wk]) {
    lastByGame[t.gameId] = t;
    if (t.pid) perGame[`${t.gameId}|${t.pid}`] = (perGame[`${t.gameId}|${t.pid}`] ?? 0) + 1;
  }
  for (const t of Object.values(lastByGame)) t.lastTd = true;
  const countedMulti = new Set();
  for (const wk of Object.keys(tdRecap)) for (const t of tdRecap[wk]) {
    t.lastTd = !!t.lastTd;
    t.multi = t.pid ? (perGame[`${t.gameId}|${t.pid}`] ?? 0) >= 2 : false;
    if (t.pid && tdAgg[t.pid]) {
      if (t.lastTd) tdAgg[t.pid].last++;
      // count a multi-TD GAME once, not once per touchdown in it
      const k = `${t.gameId}|${t.pid}`;
      if (t.multi && !countedMulti.has(k)) { countedMulti.add(k); tdAgg[t.pid].multi++; }
    }
  }

  const weeks = Object.keys(tdRecap).map(Number).sort((a, b) => a - b);

  // ── 3) Season TD + opportunity leaders (weekly player stats) ───────────
  console.log(`Fetching ${HISTORY_SEASON} weekly player stats…`);
  const { idx: si, rows: srows } = parseCsv(await fetchText(`https://github.com/nflverse/nflverse-data/releases/download/stats_player/stats_player_week_${HISTORY_SEASON}.csv`));
  const S = (r, k) => r[si[k]];
  const agg = {}; // pid -> {name, pos, team, rushTd, recTd, tds, targets, carries, games}
  const qbAgg = {}; // pid -> passing line, for the Schedule matchup card
  const headshots = {}; // gsis pid -> headshot url (shared by recap + leaders)
  for (const r of srows) {
    if (S(r, 'season_type') !== 'REG') continue;
    const pid = S(r, 'player_id'); if (!pid) continue;
    const hs = S(r, 'headshot_url'); if (hs && !headshots[pid]) headshots[pid] = hs;
    const a = agg[pid] ??= { name: S(r, 'player_display_name') || S(r, 'player_name'), pos: S(r, 'position'), team: S(r, 'team'), rushTd: 0, recTd: 0, tds: 0, targets: 0, carries: 0, games: 0 };
    a.team = S(r, 'team'); // last team seen
    const rt = num(S(r, 'rushing_tds')) || 0, ct = num(S(r, 'receiving_tds')) || 0;
    a.rushTd += rt; a.recTd += ct; a.tds += rt + ct;
    a.targets += num(S(r, 'targets')) || 0; a.carries += num(S(r, 'carries')) || 0;
    a.games++;
    // QB passing line, for the Schedule matchup card
    const att = num(S(r, 'attempts')) || 0;
    if (att > 0) {
      const q = qbAgg[pid] ??= { name: a.name, team: S(r, 'team'), g: 0, att: 0, cmp: 0,
                                 yds: 0, td: 0, int: 0, sacks: 0, rushYds: 0, rushTd: 0 };
      q.team = S(r, 'team'); q.g++; q.att += att;
      q.cmp += num(S(r, 'completions')) || 0;
      q.yds += num(S(r, 'passing_yards')) || 0;
      q.td  += num(S(r, 'passing_tds')) || 0;
      q.int += num(S(r, 'passing_interceptions')) || 0;
      q.sacks += num(S(r, 'sacks_suffered')) || 0;
      q.rushYds += num(S(r, 'rushing_yards')) || 0;
      q.rushTd += num(S(r, 'rushing_tds')) || 0;
    }
  }
  // Leaders come from the pbp TD tallies (includes return TDs + first-TD counts),
  // enriched with position / opportunities / games / full name from the weekly
  // offensive stats when the scorer appears there (nearly all do).
  const allScorers = Object.entries(tdAgg).map(([pid, t]) => {
    const a = agg[pid];
    return {
      pid, name: a?.name || t.name, pos: a?.pos || '—', team: a?.team || t.team,
      tds: t.tds, rushTd: t.rush, recTd: t.rec, stTd: t.st, defTd: t.def,
      firstTd: t.first, lastTd: t.last, multiTd: t.multi,
      opp: a ? Math.round(a.targets + a.carries) : 0, // rushing attempts + targets
      games: a?.games || t.games.size,
    };
  });
  // Ship the union of the top 50 in every sortable metric, so sorting the board
  // by (say) defensive TDs surfaces the real leaders — not just high-total
  // scorers who happen to have one. Return/defense specialists get in via st/def.
  const pool = new Set();
  for (const key of ['tds', 'rushTd', 'recTd', 'stTd', 'defTd', 'firstTd', 'lastTd', 'multiTd', 'opp'])
    allScorers.filter(l => l[key] > 0).sort((x, y) => y[key] - x[key]).slice(0, 50).forEach(l => pool.add(l.pid));
  const tdLeaders = allScorers.filter(l => pool.has(l.pid)).sort((a, b) => b.tds - a.tds);

  // Only ship headshots we actually reference (recap scorers + leaders) to stay
  // lean. The Pairs tool computes co-occurrence groups client-side from tdRecap,
  // so every player it can surface is already a recap scorer here.
  const referenced = new Set(tdLeaders.map(l => l.pid));
  for (const wk of weeks) for (const t of tdRecap[wk]) if (t.pid) referenced.add(t.pid);
  const shots = {}; for (const pid of referenced) if (headshots[pid]) shots[pid] = headshots[pid];

  // ── 4) Picks — score the upcoming slate ───────────────────────────────
  // Model + methodology live in research/; this only computes features and
  // applies exported coefficients. research/validate_port.py checks the two
  // agree to machine precision on real historical weeks.
  let picks = null, picksHistory = [];
  try {
    picks = await buildPicks({ schedule, historySeason: HISTORY_SEASON,
                               upcomingSeason: UPCOMING_SEASON });
    // Carry the pick log forward across rebuilds and grade what has played.
    // data.json is regenerated from scratch every run, so the log has to be
    // read back off the previous build or it resets daily.
    let prev = [];
    try {
      const old = JSON.parse(fs.readFileSync(new URL('../nfl/data.json', import.meta.url), 'utf8'));
      prev = old.picksHistory ?? [];
    } catch (e) {}
    const tdSet = await loadTdSet(UPCOMING_SEASON);
    picksHistory = updateHistory(prev, picks, tdSet);
    const graded = picksHistory.filter(w => w.graded).length;
    console.log(`  pick log: ${picksHistory.length} weeks (${graded} graded)`);
  } catch (e) {
    // A picks failure must not take the whole build down — recap/stats/schedule
    // are independent of it and are what the site mostly shows.
    console.error('  picks failed (continuing without them):', e.message);
  }

  // ── 5) Team matchup profiles ──────────────────────────────────────────
  // What each team scored and allowed last season, by position — the
  // team-vs-team view. Built from the recap we already have rather than a new
  // fetch. Reliability varies enormously across these numbers and the UI says
  // so: what a team SCORES carries real season-to-season signal, what a defence
  // ALLOWS by position is close to noise (split-half r of -0.06 for WRs and
  // -0.03 for TEs, against +0.83 for a player's own snap share). That is why
  // the Picks model has no opponent input at all.
  // Position for EVERY scorer, not just the leaderboard. tdLeaders is a
  // top-50-per-metric union, so keying off it left ~40% of a team's touchdowns
  // filed under "no position".
  const posOf = {};
  for (const [pid, a] of Object.entries(agg)) if (a.pos) posOf[pid] = a.pos;
  for (const l of tdLeaders) if (l.pos && l.pos !== '—') posOf[l.pid] = l.pos;
  const blank = () => ({ games: 0, scored: 0, pf: 0, pa: 0, w: 0, l: 0, t: 0, off: 0, def: 0, offPos: {}, defPos: {},
                         offType: { rush: 0, rec: 0 }, defType: { rush: 0, rec: 0 },
                         firstFor: 0, firstAgainst: 0, lastFor: 0, lastAgainst: 0 });
  const teamStats = {};
  const T = (t) => (teamStats[t] ??= blank());
  // Points for and against — the thing a schedule card should lead with, and
  // the one team number here with real season-to-season signal.
  for (const r of Object.values(results)) {
    const h = T(r.home), a = T(r.away);
    h.games++; a.games++;
    if (r.hScore != null && r.aScore != null) {
      h.pf += r.hScore; h.pa += r.aScore;
      a.pf += r.aScore; a.pa += r.hScore;
      h.scored++; a.scored++;
      // Last completed season's record, REGULAR SEASON ONLY. results carries
      // weeks 1-22, so counting them all made New England 17-4 across 21 games
      // — a real number, but not what anyone means by a record.
      if (r.week <= REG_WEEKS) {
        if (r.hScore > r.aScore) { h.w++; a.l++; }
        else if (r.aScore > r.hScore) { a.w++; h.l++; }
        else { h.t++; a.t++; }
      }
    }
  }
  for (const wk of weeks) for (const t of tdRecap[wk]) {
    if (t.type !== 'rush' && t.type !== 'rec') continue;   // offensive TDs only
    const p = posOf[t.pid] || '—';
    const o = T(t.team), d = T(t.opp);
    o.off++; d.def++;
    o.offPos[p] = (o.offPos[p] || 0) + 1;
    d.defPos[p] = (d.defPos[p] || 0) + 1;
    o.offType[t.type]++; d.defType[t.type]++;
    if (t.firstTd) { o.firstFor++; d.firstAgainst++; }
    if (t.lastTd) { o.lastFor++; d.lastAgainst++; }
  }
  // each team's own scorers, for the matchup card's roster columns
  const teamScorers = {};
  for (const l of tdLeaders) {
    if (!l.team || (l.rushTd + l.recTd) === 0) continue;
    (teamScorers[l.team] ??= []).push({ pid: l.pid, name: l.name, pos: l.pos,
      tds: l.rushTd + l.recTd, firstTd: l.firstTd || 0, lastTd: l.lastTd || 0 });
  }
  for (const t of Object.keys(teamScorers))
    teamScorers[t] = teamScorers[t].sort((a, b) => b.tds - a.tds).slice(0, 8);
  // Each team's QB1 = most pass attempts last season, with his full line.
  const teamQB = {};
  for (const [pid, q] of Object.entries(qbAgg)) {
    if (!q.team) continue;
    if (!teamQB[q.team] || q.att > teamQB[q.team].att) {
      teamQB[q.team] = { pid, name: q.name, g: q.g, att: q.att, cmp: q.cmp, yds: q.yds,
                         td: q.td, int: q.int, sacks: q.sacks, rushYds: q.rushYds, rushTd: q.rushTd };
    }
  }
  console.log(`  team profiles: ${Object.keys(teamStats).length} teams, ${Object.keys(teamQB).length} QBs`);

  // Correlation multipliers for pricing multi-leg parlays in the Pairs tool.
  // Measured in research/pair_correlation.py and shipped verbatim — the tool
  // must not carry its own copy of these numbers.
  const parlay = JSON.parse(
    fs.readFileSync(new URL('../research/pair_correlation.json', import.meta.url), 'utf8'));

  // Career touchdowns for the Milestones board. research/career_tds.py walks
  // nflverse back to 1999 and is re-run when a season completes; anything since
  // that file's `through` season is added here from the recap we already have,
  // so a chase stays current mid-season without refetching 27 years.
  const career = JSON.parse(
    fs.readFileSync(new URL('../research/career_tds.json', import.meta.url), 'utf8'));
  if (HISTORY_SEASON > career.through) {
    const since = {};
    for (const wk of weeks) for (const t of (tdRecap[wk] || [])) if (t.pid) since[t.pid] = (since[t.pid] || 0) + 1;
    let bumped = 0;
    for (const [pid, n] of Object.entries(since)) {
      if (career.players[pid]) { career.players[pid].t += n; bumped++; }
    }
    career.through = HISTORY_SEASON;
    console.log(`  career TDs: added ${HISTORY_SEASON} for ${bumped} players`);
  }
  const milestones = (() => {
    const rungs = career.rungs, out = [];
    for (const [pid, v] of Object.entries(career.players)) {
      if (v.ls < career.through) continue;                 // retired / inactive
      const next = rungs.find(r => r > v.t);
      // Cap at a distance someone could cover inside a season, so the board is
      // people actually approaching something rather than the whole league.
      if (next && next - v.t <= MILESTONE_MAX_AWAY)
        out.push({ pid, name: v.n, team: v.tm, pos: v.p, career: v.t, next, away: next - v.t });
    }
    return out.sort((a, b) => a.away - b.away || b.career - a.career);
  })();
  console.log(`  milestones: ${milestones.length} active chases (closest: ${milestones[0]?.name} ${milestones[0]?.away} from ${milestones[0]?.next})`);

  const output = {
    generatedAt: new Date().toISOString(),
    historySeason: HISTORY_SEASON, upcomingSeason: UPCOMING_SEASON,
    schedule, results, tdRecap, tdRecapWeeks: weeks, tdLeaders, headshots: shots,
    teamStats, teamScorers, teamQB,
    picks, picksHistory, parlay, milestones,
  };
  fs.writeFileSync(new URL('../nfl/data.json', import.meta.url), JSON.stringify(output));
  console.log(`Wrote nfl/data.json — ${schedule.length} ${UPCOMING_SEASON} games, ${tdTotal} TDs across ${weeks.length} weeks, ${tdLeaders.length} TD leaders, ${picks?.picks.length ?? 0} picks.`);
}
main().catch(e => { console.error(e); process.exit(1); });
