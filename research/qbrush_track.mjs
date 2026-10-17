// The QB-rushing track record (scripts/yards.js qbRushSums) for every start 2018-2025, by the BUILD's own code
// under the build's data limit (play-by-play for S-1 and S only). research/qbrush_track.py tests and exports on it.
//   node research/qbrush_track.mjs   -> research/.cache/qbrush_track.csv (pid, season, week, rush, base)
import fs from 'node:fs';
import { loadPbpLogs } from '../scripts/picks.js';
import { qbRushSums, startKeys } from '../scripts/yards.js';
const ctx = new Map(fs.readFileSync('research/.cache/yds_ctx.csv', 'utf8').trim().split('\n').slice(1)
  .map(l => { const [t, s, w, i, f] = l.split(','); return [`${t}|${s}|${w}`, { implied: +i, fav: +f }]; }));
const out = ['pid,season,week,rush,base'];
for (let S = 2018; S <= 2025; S++) {
  const { passLog, rushLog } = await loadPbpLogs([S - 1, S]);
  const topPasser = startKeys(passLog), cache = new Map();
  for (const [pid, arr] of passLog) for (const g of arr) {
    if (g.season !== S || g.att < 10 || !topPasser.has(`${pid}|${g.season}|${g.week}`)) continue;
    const r = qbRushSums({ pid, season: S, week: g.week, passLog, rushLog, ctxOf: (t, s, w) => ctx.get(`${t}|${s}|${w}`), floor: S - 1, topPasser, cache });
    out.push([pid, S, g.week, r.rush.toFixed(1), r.base.toFixed(2)].join(','));
  }
  console.log(S, out.length - 1);
}
fs.writeFileSync('research/.cache/qbrush_track.csv', out.join('\n'));
