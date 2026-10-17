// Every receptions / yards board for 2025 weeks 2-18 and 2026 weeks 2-6, rebuilt through the real buildPicks
// (that week's injuries, the depth chart as published before it, the role step), with each row's depth rank.
// research/depth_live.py fits the depth multipliers on 2025 and checks them on 2026: research's own depth test
// (research/depth_rank.py) has no role step, and the live board already spends part of the depth chart there.
//   node research/depth_live_replay.mjs   -> research/.cache/depth_replay.csv
import fs from 'node:fs';
import { parseCsv, num } from '../scripts/nflverse.js';
import { buildPicks } from '../scripts/picks.js';
const { idx: gi, rows } = parseCsv(fs.readFileSync('research/.cache/nfl/games.csv', 'utf8'));
const G = (r, k) => r[gi[k]];
const out = ['season,week,board,pid,pos,mu,depth,roleX'];   // board 'td': mu = the anytime-TD probability
const jobs = [...Array.from({ length: 17 }, (_, i) => [2025, i + 2]), ...[2, 3, 4, 5, 6].map(w => [2026, w])];
for (const [S, wk] of jobs) {
  const schedule = rows.filter(r => +G(r, 'season') === S).map(r => ({ gameId: G(r, 'game_id'), week: +G(r, 'week'), type: G(r, 'game_type'),
    gameday: G(r, 'gameday'), gametime: G(r, 'gametime') || null, away: G(r, 'away_team'), home: G(r, 'home_team'),
    spread: num(G(r, 'spread_line')), total: num(G(r, 'total_line')), awayScore: num(G(r, 'away_score')), homeScore: num(G(r, 'home_score')), roof: G(r, 'roof'), stadium: G(r, 'stadium') }));
  const scheduleAll = rows.filter(r => +G(r, 'season') >= S - 1 && +G(r, 'season') <= S).map(r => ({ season: +G(r, 'season'), week: +G(r, 'week'), home: G(r, 'home_team'), away: G(r, 'away_team'),
    spread: num(G(r, 'spread_line')), total: num(G(r, 'total_line')) }));
  let P;
  try { P = await buildPicks({ schedule, historySeason: S, upcomingSeason: S, target: { season: S, week: wk }, scheduleAll }); } catch (e) { console.log('fail', S, wk, e.message); continue; }
  if (!P) continue;
  for (const [m, list] of Object.entries(P.yards || {})) for (const r of list) if (!r.f?.thinRole) out.push([S, wk, m, r.pid, r.pos, r.mu, r.f?.depth ?? '', r.f?.roleX ?? 1].join(','));
  for (const r of P.receptions || []) if (!r.f?.thinRole) out.push([S, wk, 'recn', r.pid, r.pos, r.mu, r.f?.depth ?? '', r.f?.roleX ?? 1].join(','));
  for (const r of P.picks || []) out.push([S, wk, 'td', r.pid, r.pos, r.p, r.f?.depthRank ?? '', 1].join(','));
  console.log('done', S, wk, out.length - 1);
  fs.writeFileSync('research/.cache/depth_replay.csv', out.join('\n'));
}
