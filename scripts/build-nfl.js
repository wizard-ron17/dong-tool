// Ron's Tud Tool — NFL data build. Mirrors build-data.js (MLB): fetch open
// nflverse CSVs (no API key), shape them, write nfl/data.json. Sources:
//   - nfldata games.csv        -> schedule + betting lines (2022-2026)
//   - nflverse play_by_play    -> every TD, for weekly recaps (like MLB HR recaps)
//   - nflverse stats_player    -> weekly player stats -> TD + opportunity leaders
import fs from 'node:fs';
import { fetchText, parseCsv, num } from './nflverse.js';
import { buildPicks, loadPlayers } from './picks.js';
import * as liveLog from './live-log.js';

// Neither season is a constant any more. Both are read off the schedule feed so
// the app rolls forward on its own — opening Sunday and the turn of a season
// both used to need someone to edit a year in here and remember why.
const LEADER_SEASONS = 2;      // how many seasons of TD leaders the Stats picker gets
const REG_WEEKS = 18;           // weeks 19+ in results are the playoffs
const MILESTONE_MAX_AWAY = 25;  // a chase you could finish inside a season  // full schedule already published

const cleanName = (n) => (n || '').trim();

async function main() {
  // ── 1) Schedule + lines ────────────────────────────────────────────────
  console.log('Fetching schedule + lines (nfldata games.csv)…');
  const { idx: gi, rows: grows } = parseCsv(await fetchText('https://raw.githubusercontent.com/nflverse/nfldata/master/data/games.csv'));
  const game = (r, k) => r[gi[k]];
  // The newest season that has actually been played. Everything historical —
  // recaps, leaders, team profiles, career top-ups — reads from this rather
  // than a hardcoded year, so the app rolls over to 2026 the moment its first
  // game goes final instead of waiting for someone to edit a constant.
  const HISTORY_SEASON = Math.max(...grows
    .filter(r => num(game(r, 'home_score')) != null)
    .map(r => +game(r, 'season')));
  // The season we price is the newest one with a game still to play. Falls back
  // to the newest on file in the gap after a Super Bowl, before next year's
  // schedule is published.
  const unplayed = grows.filter(r => num(game(r, 'home_score')) == null).map(r => +game(r, 'season'));
  const UPCOMING_SEASON = unplayed.length ? Math.max(...unplayed)
                                          : Math.max(...grows.map(r => +game(r, 'season')));
  console.log(`Active season: ${HISTORY_SEASON} (schedule/picks: ${UPCOMING_SEASON})`);

  const schedule = grows.filter(r => +game(r, 'season') === UPCOMING_SEASON).map(r => ({
    gameId: game(r, 'game_id'), week: +game(r, 'week'), type: game(r, 'game_type'),
    gameday: game(r, 'gameday'), gametime: game(r, 'gametime') || null, weekday: game(r, 'weekday'),
    away: game(r, 'away_team'), home: game(r, 'home_team'),
    spread: num(game(r, 'spread_line')), total: num(game(r, 'total_line')),
    awayScore: num(game(r, 'away_score')), homeScore: num(game(r, 'home_score')),
    // for the wind lookup — roof is known before kickoff, temp/wind are not
    roof: game(r, 'roof'), stadium: game(r, 'stadium'),
  }));

  // results map for the historical season (to caption recap games + day-of-week filtering)
  const results = {};
  for (const r of grows) if (+game(r, 'season') === HISTORY_SEASON)
    results[game(r, 'game_id')] = { away: game(r, 'away_team'), home: game(r, 'home_team'), aScore: num(game(r, 'away_score')), hScore: num(game(r, 'home_score')), week: +game(r, 'week'), gameday: game(r, 'gameday'), weekday: game(r, 'weekday') };

  // ── 2) Every TD -> weekly recap (from play-by-play) ────────────────────
  console.log(`Fetching ${HISTORY_SEASON} play-by-play for TD recaps (large file)…`);
  const { idx: pi, rows: prows } = parseCsv(await fetchText(`https://github.com/nflverse/nflverse-data/releases/download/pbp/play_by_play_${HISTORY_SEASON}.csv`));
  const P = (r, k) => r[pi[k]];
  const tdRecap = {}; // week -> [ {player, team, opp, type, yards, qtr, passer, passerPid, gameId, firstTd, lastTd, multi, weekday} ]
  let tdTotal = 0;
  const gameHasTd = new Set(); // gameIds that have already scored a TD -> flags the first one
  // Per-player TD tallies from pbp — the authoritative source since it also
  // captures return TDs (kick/punt/INT/fumble), which the offensive weekly
  // stats don't. pid -> {rush, rec, ret, first, tds, team, games:Set, name}.
  const tdAgg = {};
  // Every scrimmage play by drive, for the Recap modal's drive chart:
  // `${game}|${drive}` -> [[kind, yardline_100, yards_gained, down, togo, play_id, posteam]]
  const drivePlays = new Map();
  for (const r of prows) {
    const pt = P(r, 'play_type');
    if (!['run', 'pass', 'field_goal', 'punt', 'qb_kneel', 'qb_spike'].includes(pt) || !P(r, 'drive')) continue;
    const k = `${P(r, 'game_id')}|${P(r, 'drive')}`;
    const kind = pt === 'run' ? (P(r, 'qb_scramble') === '1' ? 's' : 'r') : pt === 'pass' ? (P(r, 'sack') === '1' ? 'k' : 'p') : 'o';
    (drivePlays.get(k) ?? drivePlays.set(k, []).get(k)).push([kind, num(P(r, 'yardline_100')), num(P(r, 'yards_gained')) ?? 0,
      num(P(r, 'down')), num(P(r, 'ydstogo')), +P(r, 'play_id'), P(r, 'posteam')]);
  }
  // Win probability through each game, home side, for the Recap modal's chart:
  // flattened [seconds elapsed, home win %, ...], thinned to a point every 40 s
  // of game clock or 3-point move (touchdowns always kept).
  const clockOf = (r) => {
    const q = num(P(r, 'qtr')), qs = num(P(r, 'quarter_seconds_remaining'));
    return q == null || qs == null ? null : q <= 4 ? (q - 1) * 900 + 900 - qs : 3600 + 600 - qs;
  };
  const wpSeries = {};
  for (const r of prows) {
    const el = clockOf(r), hw = num(P(r, 'home_wp_post')) ?? num(P(r, 'home_wp'));
    if (el == null || hw == null) continue;
    const arr = wpSeries[P(r, 'game_id')] ??= [0, Math.round((num(P(r, 'home_wp')) ?? hw) * 100)];
    const pct = Math.round(hw * 100), n = arr.length;
    if (P(r, 'touchdown') !== '1' && el - arr[n - 2] < 40 && Math.abs(pct - arr[n - 1]) < 3) continue;
    if (el < arr[n - 2]) continue;
    arr.push(el, pct);
  }
  // Play detail for every touchdown, loaded by the Recap modal on demand
  // (nfl/plays.json) — where it started, which way it went, the drive, the
  // score and the win-probability swing. No tracking data exists for free, so
  // the modal draws the route from these, and says so.
  const playDetail = {};
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
    // A defense or return unit scoring is the DEFTEAM on that play, so the
    // opponent is whichever side the scorer isn't.
    const opp = team === P(r, 'posteam') ? P(r, 'defteam') : P(r, 'posteam');
    const playId = +P(r, 'play_id');
    {
      const onOffense = team === P(r, 'posteam');
      const dk = `${gameId}|${P(r, 'drive')}`;
      const drive = onOffense ? (drivePlays.get(dk) ?? []).filter(d => d[6] === team && d[5] <= playId).map(d => d.slice(0, 5)) : [];
      const wp = num(P(r, 'wp')), wpa = num(P(r, 'wpa'));
      const r1 = (v) => (v == null ? null : Math.round(v * 1000) / 1000);
      playDetail[`${gameId}|${playId}`] = {
        // who / what, so a shared replay link can preview without the whole data.json
        nm: scorer, tm: team, op: opp, ty: subtype, yd: yards,
        pt: P(r, 'play_type'), yl: num(P(r, 'yardline_100')), gain: num(P(r, 'yards_gained')),
        air: num(P(r, 'air_yards')), yac: num(P(r, 'yards_after_catch')), pl: P(r, 'pass_location') || null,
        rl: P(r, 'run_location') || null, gap: P(r, 'run_gap') || null, kd: num(P(r, 'kick_distance')), ry: num(P(r, 'return_yards')),
        dn: num(P(r, 'down')), tg: num(P(r, 'ydstogo')), clk: P(r, 'time') || null, sh: P(r, 'shotgun') === '1' ? 1 : 0,
        scr: P(r, 'qb_scramble') === '1' ? 1 : 0, desc: (P(r, 'desc') || '').slice(0, 320),
        // jersey numbers for everyone the description names ("8-L.Jackson pass …
        // to 4-Z.Flowers"), and the passer on a pick-six or strip-sack
        jn: Object.fromEntries([...(P(r, 'desc') || '').matchAll(/(?:^|[\s(\[,])(?:[A-Z]{2,3}-)?(\d{1,2})-([A-Z][A-Za-z]*\.(?:St\. [A-Z][A-Za-z'\-]+|[A-Za-z'\-]+)(?: (?:Jr|Sr|II|III|IV)\.?)?)/g)].map(m => [m[2], m[1]])),
        thr: (() => { const m = (P(r, 'desc') || '').match(/(\d{1,2})-([A-Z][A-Za-z]*\.(?:St\. [A-Z][A-Za-z'\-]+|[A-Za-z'\-]+)) (?:pass|sacked|scrambles)/); return m ? [m[1], m[2]] : null; })(),
        // scores after the play from the scorer's side
        sc: onOffense ? [num(P(r, 'posteam_score_post')), num(P(r, 'defteam_score_post'))] : [num(P(r, 'defteam_score_post')), num(P(r, 'posteam_score_post'))],
        // win probability before and after, scorer's side
        wp: wp == null ? null : onOffense ? [r1(wp), r1(wp + (wpa ?? 0))] : [r1(1 - wp), r1(1 - wp - (wpa ?? 0))],
        epa: onOffense ? r1(num(P(r, 'epa'))) : null,
        el: clockOf(r),
        dr: onOffense ? { n: num(P(r, 'drive_play_count')), top: P(r, 'drive_time_of_possession') || null, start: P(r, 'drive_start_yard_line') || null,
                          yds: drive.reduce((a, d2) => a + (d2[2] || 0), 0) } : null,
      };
    }
    (tdRecap[wk] ??= []).push({
      player: scorer, pid, k: playId,
      team, opp,
      type, subtype, yards, qtr: num(P(r, 'qtr')),
      passer: type === 'rec' ? cleanName(P(r, 'passer_player_name')) : null,
      // The thrower's id, not just his name. A receiving TD IS the passing TD,
      // so this is the one place the QB->receiver connection actually exists —
      // and Pairs needs an id, not a name, to make him a member of a group.
      passerPid: type === 'rec' ? (P(r, 'passer_player_id') || null) : null,
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

  // ── Returners: who takes punts and kickoffs, from the same pbp pass ────
  // return_team is authoritative for both types and posteam is NOT — on a punt
  // posteam is the punting side, on a kickoff nflverse assigns it to the
  // RECEIVING side. Reading volume off posteam flips the punt/opponent-punts
  // correlation from +0.80 to -0.63.
  const retAgg = {};   // pid -> { name, team, pr, kr, prTd, krTd, games:Set }
  const teamRet = {};  // team -> { pr, kr }
  for (const r of prows) {
    const isPunt = P(r, 'punt_attempt') === '1', isKick = P(r, 'kickoff_attempt') === '1';
    if (!isPunt && !isKick) continue;
    const pid = isPunt ? P(r, 'punt_returner_player_id') : P(r, 'kickoff_returner_player_id');
    if (!pid) continue;                       // fair catch, touchback, out of bounds
    const team = P(r, 'return_team');
    const name = cleanName(isPunt ? P(r, 'punt_returner_player_name') : P(r, 'kickoff_returner_player_name'));
    const a = retAgg[pid] ??= { name, team, pr: 0, kr: 0, prTd: 0, krTd: 0, games: new Set() };
    a.team = team || a.team;
    a.games.add(P(r, 'game_id'));
    const td = P(r, 'return_touchdown') === '1';
    if (isPunt) { a.pr++; if (td) a.prTd++; } else { a.kr++; if (td) a.krTd++; }
    if (team) { const t = teamRet[team] ??= { pr: 0, kr: 0 }; if (isPunt) t.pr++; else t.kr++; }
  }
  const returners = Object.entries(retAgg)
    .map(([pid, a]) => ({
      pid, name: a.name, team: a.team,
      pr: a.pr, kr: a.kr, prTd: a.prTd, krTd: a.krTd, games: a.games.size,
      // Share of his team's returns — the part of expected volume that is HIS
      // rather than the matchup's, and the thing that actually separates
      // returners once the opponent effects cancel out.
      prShare: teamRet[a.team]?.pr ? +(a.pr / teamRet[a.team].pr).toFixed(3) : 0,
      krShare: teamRet[a.team]?.kr ? +(a.kr / teamRet[a.team].kr).toFixed(3) : 0,
    }))
    .filter(r => r.pr + r.kr >= 3)
    .sort((a, b) => (b.pr + b.kr) - (a.pr + a.kr));
  console.log(`  returners: ${returners.length} with 3+ returns `
    + `(${returners.reduce((n, r) => n + r.prTd + r.krTd, 0)} return TDs)`);

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


  // ── 4) Picks — score the upcoming slate ───────────────────────────────
  // Model + methodology live in research/; this only computes features and
  // applies exported coefficients. research/validate_port.py checks the two
  // agree to machine precision on real historical weeks.
  let picks = null;
  try {
    // Lines for the last two seasons feed the receptions results replay —
    // implied totals are a model input, so grading past boards needs past lines.
    const scheduleAll = grows
      .filter(r => +game(r, 'season') >= UPCOMING_SEASON - 1)
      .map(r => ({ season: +game(r, 'season'), week: +game(r, 'week'),
                   home: game(r, 'home_team'), away: game(r, 'away_team'),
                   spread: num(game(r, 'spread_line')), total: num(game(r, 'total_line')) }));
    picks = await buildPicks({ schedule, historySeason: HISTORY_SEASON,
                               upcomingSeason: UPCOMING_SEASON, scheduleAll });
  } catch (e) {
    // A picks failure must not take the whole build down — recap/stats/schedule
    // are independent of it and are what the site mostly shows.
    console.error('  picks failed (continuing without them):', e.message);
  }

  // ── 4b) Live results: log each game's board at kickoff, grade it when final ─
  // Separate file (nfl/results.json) — see scripts/live-log.js.
  const LOG_PATH = new URL('../nfl/results.json', import.meta.url);
  const log = liveLog.readLog(LOG_PATH);
  let liveWeek = null;
  try {
    if (picks) {
      const n = liveLog.snapshot(log, schedule, {
        season: picks.season, week: picks.week, generatedAt: picks.generatedAt,
        picks: picks.picks, receptions: picks.receptions, recLines: picks.receptionModel?.lines,
        completions: picks.completions, cmpLines: picks.completionModel?.lines,
        interceptions: picks.interceptions, yards: picks.yards,
      });
      console.log(`  results log: snapshot ${n} not-yet-started games`);
    }
    let ids = null;
    const loadIds = async () => {
      if (!ids) { const { espn, nameTeam, xwalk } = await loadPlayers(); ids = { espnToGsis: espn, nameTeamToGsis: nameTeam, xwalk }; }
      return ids;
    };
    const { graded } = await liveLog.grade(log, loadIds);
    const checked = await liveLog.resolveDnp(log, loadIds);
    if (checked) console.log(`  results log: snap counts confirmed ${checked} games`);
    liveLog.trim(log);
    fs.writeFileSync(LOG_PATH, JSON.stringify(log));
    const all = Object.values(log.games);
    console.log(`  results log: graded ${graded} new, ${all.filter(g => g.final).length}/${all.length} games final`);
    // The board's own week, small enough to ride in data.json so board cards
    // can show what already happened without loading the whole log.
    if (picks) {
      const wk = all.filter(g => g.season === picks.season && g.week === picks.week);
      liveWeek = { season: picks.season, week: picks.week, games: {}, td: {}, rec: {}, cmp: {}, ptd: {}, ints: {}, pyds: {}, rush: {}, ryds: {}, dnp: [] };
      for (const g of wk) {
        liveWeek.games[g.id] = { final: !!g.final, live: !!g.live, score: g.score ?? null,
                                 first: g.res?.first ?? null, last: g.res?.last ?? null };
        if (!g.res) continue;
        Object.assign(liveWeek.td, g.res.td); Object.assign(liveWeek.rec, g.res.rec);
        Object.assign(liveWeek.cmp, g.res.cmp); Object.assign(liveWeek.ptd, g.res.ptd);
        Object.assign(liveWeek.ints, g.res.ints ?? {});
        for (const k of ['pyds', 'rush', 'ryds']) Object.assign(liveWeek[k], g.res[k] ?? {});
        liveWeek.dnp.push(...(g.res.dnp ?? []));
      }
    }
  } catch (e) {
    console.error('  results log failed (continuing):', e.message);
  }

  // ── 5) Team matchup profiles ──────────────────────────────────────────
  // What each team scored and allowed last season, by position — the
  // team-vs-team view. Built from the recap we already have rather than a new
  // fetch. Reliability varies enormously across these numbers and the UI says
  // so: what a team SCORES carries real season-to-season signal, what a defense
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
  // Return-game constants: TD rates by type and how volume moves with the
  // opponent's implied total. Measured in research/returners.py.
  const returnModel = JSON.parse(
    fs.readFileSync(new URL('../research/returners_model.json', import.meta.url), 'utf8'));

  // ── Fold the return game into the Picks prices ────────────────────────
  // A return touchdown pays as an ANYTIME touchdown, so a returner's real
  // anytime chance is his offense and his return chance combined. Without this
  // the board understates every return man — and Picks is where people look
  // first, so it has to be the number that's right there rather than only on
  // the Returners board.
  if (picks?.picks && returners.length) {
    const retIdx = {}; for (const r of returners) retIdx[r.pid] = r;
    const teamCtx = {};
    for (const g of schedule) {
      if (g.week !== picks.week || g.total == null) continue;
      const half = g.total / 2, edge = (g.spread ?? 0) / 2;
      teamCtx[g.home] = half - edge;      // what the OPPONENT is expected to score
      teamCtx[g.away] = half + edge;
    }
    const RM = returnModel;
    let touched = 0, biggest = null;
    for (const p of picks.picks) {
      const r = retIdx[p.pid];
      const oppImp = teamCtx[p.team];
      if (!r || oppImp == null) continue;
      const kr = Math.max(0, RM.kick_fit.a + RM.kick_fit.b * oppImp) * r.krShare;
      const pr = Math.max(0, RM.punt_fit.a + RM.punt_fit.b * oppImp) * r.prShare;
      const ret = kr * RM.kick_td_rate + pr * RM.punt_td_rate;
      if (ret <= 0) continue;
      const off = p.p;
      p.pOff = +off.toFixed(6);          // offense-only, kept so the modal can show the split
      p.pRet = +ret.toFixed(6);
      p.p = +(1 - (1 - off) * (1 - ret)).toFixed(6);
      // 2+ is offense-only on purpose: a second touchdown via a second return
      // is rare enough that modelling it would be inventing a number.
      touched++;
      if (!biggest || ret > biggest.pRet) biggest = p;
    }
    console.log(`  return game folded into ${touched} picks`
      + (biggest ? ` (largest: ${biggest.name} +${(biggest.pRet * 100).toFixed(1)}%)` : ''));
  }


  // Career touchdowns for the Milestones board. research/career_tds.py walks
  // nflverse back to 1999 and is re-run when a season completes; anything since
  // that file's `through` season is added here from the recap we already have,
  // so a chase stays current mid-season without refetching 27 years.
  const career = JSON.parse(
    fs.readFileSync(new URL('../research/career_tds.json', import.meta.url), 'utf8'));
  const fileThrough = career.through;
  if (HISTORY_SEASON > career.through) {
    // Same definition as the file: regular-season rushing + receiving scores.
    // The recap also carries return and defensive touchdowns, and playoff weeks.
    const since = {};
    for (const wk of weeks) {
      if (+wk > REG_WEEKS) continue;
      for (const t of (tdRecap[wk] || []))
        if (t.pid && (t.type === 'rush' || t.type === 'rec')) since[t.pid] = (since[t.pid] || 0) + 1;
    }
    let bumped = 0;
    for (const [pid, n] of Object.entries(since)) {
      if (career.players[pid]) { career.players[pid].t += n; career.players[pid].ls = HISTORY_SEASON; bumped++; }
    }
    career.through = HISTORY_SEASON;
    console.log(`  career TDs: added ${HISTORY_SEASON} for ${bumped} players`);
  }
  // Who is still playing. The file only knows each player's last season WITH
  // A TOUCHDOWN, so the moment a new season starts every veteran looks retired
  // until he scores — which emptied the board on opening week. Active means on
  // this week's Picks board (active rosters) or holding a stat line this season
  // (agg, from the weekly stats), so a bye week doesn't drop anyone. Last
  // season is the fallback if Picks failed.
  const activeNow = new Map((picks?.picks ?? []).map(p => [p.pid, p]));
  const milestones = (() => {
    const rungs = career.rungs, out = [];
    for (const [pid, v] of Object.entries(career.players)) {
      const live = activeNow.get(pid);
      // on this week's board, or has recorded a stat this season (covers byes)
      if (activeNow.size ? !live && !agg[pid] && v.ls < HISTORY_SEASON : v.ls < fileThrough) continue;
      if (live) { v.tm = live.team; v.p = live.pos || v.p; }
      const next = rungs.find(r => r > v.t);
      // Cap at a distance someone could cover inside a season, so the board is
      // people actually approaching something rather than the whole league.
      if (next && next - v.t <= MILESTONE_MAX_AWAY)
        out.push({ pid, name: v.n, team: v.tm, pos: v.p, career: v.t, next, away: next - v.t });
    }
    return out.sort((a, b) => a.away - b.away || b.career - a.career);
  })();
  console.log(`  milestones: ${milestones.length} active chases (closest: ${milestones[0]?.name} ${milestones[0]?.away} from ${milestones[0]?.next})`);

  // Only ship headshots we actually reference, but "referenced" now means every
  // surface that shows a face — not just recap scorers. Picks, Due, Milestones
  // and the home page all render players who never scored a touchdown last
  // season, which is why every pocket quarterback was faceless: Goff and
  // Stafford don't rush for TDs, so they never entered the recap. Built here
  // rather than earlier because picks and milestones don't exist until now.
  const referenced = new Set(tdLeaders.map(l => l.pid));
  for (const wk of weeks) for (const t of tdRecap[wk]) {
    if (t.pid) referenced.add(t.pid);
    if (t.passerPid) referenced.add(t.passerPid);   // QB stacks show his face too
  }
  for (const p of (picks?.picks ?? [])) referenced.add(p.pid);
  for (const b of (picks?.birthdays ?? [])) referenced.add(b.pid);
  for (const m of milestones) referenced.add(m.pid);
  for (const r of (picks?.returners?.length ? picks.returners : returners)) referenced.add(r.pid);
  for (const r of (picks?.receptions ?? [])) referenced.add(r.pid);
  for (const r of (picks?.completions ?? [])) referenced.add(r.pid);
  // Passers who never scored themselves aren't in tdLeaders or the recap's
  // scorer rows, so the Stacks view has no name for them without this.
  const passerNames = {};
  for (const wk of weeks) for (const t of tdRecap[wk])
    if (t.passerPid && t.passer && !passerNames[t.passerPid]) passerNames[t.passerPid] = t.passer;
  // Positions for everyone in a QB->receiver connection. tdLeaders only carries
  // the top 50 per metric, so reading positions off it left 37% of receivers
  // unlabelled — posOf comes from the full weekly stats and covers them.
  const connPos = {};
  for (const wk of weeks) for (const t of tdRecap[wk]) {
    if (t.type !== 'rec' || !t.passerPid) continue;
    if (posOf[t.pid]) connPos[t.pid] = posOf[t.pid];
  }

  const shots = {}; for (const pid of referenced) if (headshots[pid]) shots[pid] = headshots[pid];
  // picks.js carries players.csv headshots for the board — better coverage than
  // the season stats feed, which only has a player who took a snap last year.
  for (const [pid, url] of Object.entries(picks?.shots ?? {})) shots[pid] ??= url;
  // milestone chasers can be retired-adjacent; take whatever either source has
  for (const m of milestones) if (!shots[m.pid] && headshots[m.pid]) shots[m.pid] = headshots[m.pid];
  const wanted = referenced.size, got = Object.keys(shots).length;
  console.log(`  headshots: ${got}/${wanted} referenced players have one`);


  // Team colours for the Recap play diagrams (nfldata teamcolors.csv).
  let teamColors = {};
  try {
    const { idx: ci, rows: crows } = parseCsv(await fetchText('https://raw.githubusercontent.com/nflverse/nfldata/master/data/teamcolors.csv'));
    for (const r of crows) teamColors[r[ci.team]] = [r[ci.color], r[ci.color2] || '#ffffff'];
  } catch (e) { console.log('  team colours unavailable:', e.message); }

  const output = {
    generatedAt: new Date().toISOString(),
    historySeason: HISTORY_SEASON, upcomingSeason: UPCOMING_SEASON,
    schedule, results, tdRecap, tdRecapWeeks: weeks, tdLeaders, headshots: shots,
    teamStats, teamScorers, teamQB,
    // Receptions rides along in the picks payload because it reuses that pass's
    // play-by-play, but it is its own market and reads better as its own key.
    picks: picks ? { ...picks, shots: undefined, receptions: undefined, receptionModel: undefined, returners: undefined, receptionsHistory: undefined, wind: undefined, completions: undefined, completionsHistory: undefined, completionModel: undefined, interceptions: undefined, interceptionsHistory: undefined, interceptionModel: undefined, yards: undefined, yardsModel: undefined } : picks,
    receptions: picks?.receptions ?? [], receptionModel: picks?.receptionModel ?? null,
    receptionsHistory: picks?.receptionsHistory ?? [], wind: picks?.wind ?? {},
    completions: picks?.completions ?? [], completionsHistory: picks?.completionsHistory ?? [],
    completionModel: picks?.completionModel ?? null,
    interceptions: picks?.interceptions ?? [], interceptionsHistory: picks?.interceptionsHistory ?? [],
    interceptionModel: picks?.interceptionModel ?? null,
    yards: picks?.yards ?? null, yardsModel: picks?.yardsModel ?? null,
    liveWeek, parlay, milestones, passerNames, connPos, teamColors,
    returners: (picks?.returners?.length ? picks.returners : returners), returnModel,
  };
  fs.writeFileSync(new URL('../nfl/data.json', import.meta.url), JSON.stringify(output));
  for (const [g, arr] of Object.entries(wpSeries)) if (Object.keys(playDetail).some(k => k.startsWith(g + '|'))) playDetail[`wp|${g}`] = arr;
  fs.writeFileSync(new URL('../nfl/plays.json', import.meta.url), JSON.stringify(playDetail));
  console.log(`  play detail: ${Object.keys(playDetail).filter(k => !k.startsWith('wp|')).length} touchdowns + win-probability lines -> nfl/plays.json`);
  console.log(`Wrote nfl/data.json — ${schedule.length} ${UPCOMING_SEASON} games, ${tdTotal} TDs across ${weeks.length} weeks, ${tdLeaders.length} TD leaders, ${picks?.picks.length ?? 0} picks.`);
}
main().catch(e => { console.error(e); process.exit(1); });
