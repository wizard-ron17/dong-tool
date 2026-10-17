// Parity replay (2026-10-17): the build's receptionFeatures() for every 2025 player-week, to diff against
// research/receptions.parquet row by row (research/receptions_parity.py). The live replay ran x1.04 low on
// 2025 while research's own walk-forward ran x0.96 high: the two disagree on some input.
//   node research/receptions_parity.mjs   -> research/.cache/rec_parity_2025.csv
import fs from 'node:fs';
import { loadPlayers, loadSnapLog, loadPbpLogs } from '../scripts/picks.js';
import { receptionFeatures } from '../scripts/receptions.js';
const SEASON = 2025;
const { xwalk } = await loadPlayers();
const snapLog = await loadSnapLog([2016, 2017, 2018, 2019, 2020, 2021, 2022, 2023, 2024, 2025], xwalk);
const { recLog, teamPassLog } = await loadPbpLogs([2024, 2025]);
const cols = ['rec_l3', 'rec_prior', 'share_l3', 'tgt_share_prior', 'snap_l3', 'catch_prior', 'team_pass_prior', '_games'];
const out = ['pid,season,week,position,' + cols.join(',')];
for (const [pid, arr] of snapLog) for (const e of arr) {
  if (e.season !== SEASON) continue;
  const f = receptionFeatures({ pid, position: e.position, season: SEASON, week: e.week, snapLog, recLog, teamPassLog,
    team: e.team, impliedTotal: 0, windowFloor: 2024, windMph: 0 });
  if (!f) continue;
  out.push([pid, SEASON, e.week, e.position, ...cols.map(c => f[c])].join(','));
}
fs.mkdirSync('research/.cache', { recursive: true });
fs.writeFileSync('research/.cache/rec_parity_2025.csv', out.join('\n'));
console.log(out.length - 1, 'rows');
