// Ron's Tud Tool — NFL data build. Mirrors build-data.js (MLB): fetch open
// nflverse CSVs (no API key), shape them, write nfl/data.json. Sources:
//   - nfldata games.csv        -> schedule + betting lines (2022-2026)
//   - nflverse play_by_play    -> every TD, for weekly recaps (like MLB HR recaps)
//   - nflverse stats_player    -> weekly player stats -> TD + opportunity leaders
import fs from 'node:fs';

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';
const HISTORY_SEASON = 2025;   // last completed season — our historical base until 2026 games play
const UPCOMING_SEASON = 2026;  // full schedule already published

async function fetchText(url) {
  for (let a = 0; a < 4; a++) {
    try {
      const r = await fetch(url, { headers: { 'User-Agent': UA } });
      if (r.ok) return await r.text();
    } catch (e) {}
    await new Promise(r => setTimeout(r, 1500));
  }
  throw new Error('fetch failed: ' + url);
}
// Quote-aware CSV -> {header:[], rows:[[...]]} with a name->index map.
function parseCsv(text) {
  const lines = text.replace(/^﻿/, '').split('\n');
  const parseLine = (s) => {
    const out = []; let cur = '', q = false;
    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      if (c === '"') { if (q && s[i + 1] === '"') { cur += '"'; i++; } else q = !q; }
      else if (c === ',' && !q) { out.push(cur); cur = ''; }
      else cur += c;
    }
    out.push(cur); return out;
  };
  const header = parseLine(lines[0]);
  const idx = {}; header.forEach((h, i) => idx[h] = i);
  const rows = [];
  for (let i = 1; i < lines.length; i++) { if (lines[i].trim()) rows.push(parseLine(lines[i])); }
  return { idx, rows };
}
const num = (v) => { const n = parseFloat(v); return isNaN(n) ? null : n; };
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
  // results map for the historical season (to caption recap games)
  const results = {};
  for (const r of grows) if (+game(r, 'season') === HISTORY_SEASON)
    results[game(r, 'game_id')] = { away: game(r, 'away_team'), home: game(r, 'home_team'), aScore: num(game(r, 'away_score')), hScore: num(game(r, 'home_score')), week: +game(r, 'week') };

  // ── 2) Every TD -> weekly recap (from play-by-play) ────────────────────
  console.log(`Fetching ${HISTORY_SEASON} play-by-play for TD recaps (large file)…`);
  const { idx: pi, rows: prows } = parseCsv(await fetchText(`https://github.com/nflverse/nflverse-data/releases/download/pbp/play_by_play_${HISTORY_SEASON}.csv`));
  const P = (r, k) => r[pi[k]];
  const tdRecap = {}; // week -> [ {player, team, opp, type, yards, qtr, passer, gameId} ]
  let tdTotal = 0;
  for (const r of prows) {
    if (P(r, 'touchdown') !== '1') continue;
    const scorer = cleanName(P(r, 'td_player_name'));
    if (!scorer) continue; // skip odd rows with no credited scorer
    const type = P(r, 'pass_touchdown') === '1' ? 'rec' : P(r, 'rush_touchdown') === '1' ? 'rush' : P(r, 'return_touchdown') === '1' ? 'ret' : 'other';
    const wk = P(r, 'week');
    (tdRecap[wk] ??= []).push({
      player: scorer, pid: P(r, 'td_player_id') || null,
      team: P(r, 'td_team') || P(r, 'posteam'), opp: P(r, 'defteam'),
      type, yards: num(P(r, 'yards_gained')), qtr: num(P(r, 'qtr')),
      passer: type === 'rec' ? cleanName(P(r, 'passer_player_name')) : null,
      gameId: P(r, 'game_id'),
    });
    tdTotal++;
  }
  const weeks = Object.keys(tdRecap).map(Number).sort((a, b) => a - b);

  // ── 3) Season TD + opportunity leaders (weekly player stats) ───────────
  console.log(`Fetching ${HISTORY_SEASON} weekly player stats…`);
  const { idx: si, rows: srows } = parseCsv(await fetchText(`https://github.com/nflverse/nflverse-data/releases/download/stats_player/stats_player_week_${HISTORY_SEASON}.csv`));
  const S = (r, k) => r[si[k]];
  const agg = {}; // pid -> {name, pos, team, rushTd, recTd, tds, targets, carries, games}
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
  }
  const tdLeaders = Object.entries(agg).filter(([, a]) => a.tds > 0).sort((x, y) => y[1].tds - x[1].tds).slice(0, 50)
    .map(([pid, a]) => ({ pid, name: a.name, pos: a.pos, team: a.team, tds: a.tds, rushTd: a.rushTd, recTd: a.recTd, opp: Math.round(a.targets + a.carries), games: a.games }));

  // Only ship headshots we actually reference (recap scorers + leaders) to stay lean.
  const referenced = new Set(tdLeaders.map(l => l.pid));
  for (const wk of weeks) for (const t of tdRecap[wk]) if (t.pid) referenced.add(t.pid);
  const shots = {}; for (const pid of referenced) if (headshots[pid]) shots[pid] = headshots[pid];

  const output = {
    generatedAt: new Date().toISOString(),
    historySeason: HISTORY_SEASON, upcomingSeason: UPCOMING_SEASON,
    schedule, results, tdRecap, tdRecapWeeks: weeks, tdLeaders, headshots: shots,
  };
  fs.writeFileSync(new URL('../nfl/data.json', import.meta.url), JSON.stringify(output));
  console.log(`Wrote nfl/data.json — ${schedule.length} ${UPCOMING_SEASON} games, ${tdTotal} TDs across ${weeks.length} weeks, ${tdLeaders.length} TD leaders.`);
}
main().catch(e => { console.error(e); process.exit(1); });
