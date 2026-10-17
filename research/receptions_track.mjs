// The receptions track record (scripts/receptions.js trackRecord) for every player-week 2018-2025, computed by
// the BUILD's own code under the build's own data: scoring season S it loads play-by-play for S-1 and S only.
// research/receptions_persist.py tests and exports on these, so research and the build agree by construction.
//   node research/receptions_track.mjs     -> research/.cache/rec_track.csv  (pid, season, week, m)
// Implied totals come from research/receptions.parquet (rec_implied.csv), the same nflverse lines the build reads.
import fs from 'node:fs';
import { loadPlayers, loadSnapLog, loadPbpLogs } from '../scripts/picks.js';
import { trackRecord } from '../scripts/receptions.js';
const imp = new Map(fs.readFileSync('research/.cache/rec_implied.csv', 'utf8').trim().split('\n').slice(1)
  .map(l => { const [t, s, w, v] = l.split(','); return [`${t}|${s}|${w}`, +v]; }));
const { xwalk } = await loadPlayers();
const snapLog = await loadSnapLog(Array.from({ length: 10 }, (_, i) => 2016 + i), xwalk);
const out = ['pid,season,week,m'];
for (let S = 2018; S <= 2025; S++) {
  const { recLog, teamPassLog } = await loadPbpLogs([S - 1, S]);
  const cache = new Map();
  for (const [pid, arr] of snapLog) for (const e of arr) if (e.season === S)
    out.push([pid, S, e.week, trackRecord({ pid, position: e.position, season: S, week: e.week, snapLog, recLog, teamPassLog,
      impliedOf: (t, s, w) => imp.get(`${t}|${s}|${w}`), windowFloor: S - 1, cache }).toFixed(5)].join(','));
  console.log(S, out.length - 1);
}
fs.writeFileSync('research/.cache/rec_track.csv', out.join('\n'));
