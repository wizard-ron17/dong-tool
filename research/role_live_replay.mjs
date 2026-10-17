// Live-season replay of the role adjustment (2026-10-17): every board for weeks 2-6 of 2026 rebuilt through the
// real buildPicks (that week's injuries; the depth chart as published before it), with the boost exponent for
// promoted players (x > 1) at 0.5 (shipped), 0.75 and 1.0. Graded live, players boosted by the role step caught
// 19-32% more receiving yards than projected while players cut were on the number.
//   node research/role_live_replay.mjs   -> research/.cache/role_replay.csv
import fs from 'node:fs';
import { fetchText, parseCsv, num } from '../scripts/nflverse.js';
import { buildPicks } from '../scripts/picks.js';
const { idx: gi, rows } = parseCsv(await fetchText('https://raw.githubusercontent.com/nflverse/nfldata/master/data/games.csv'));
const G = (r, k) => r[gi[k]];
const S = 2026;
const schedule = rows.filter(r => +G(r, 'season') === S).map(r => ({ gameId: G(r, 'game_id'), week: +G(r, 'week'), type: G(r, 'game_type'),
  gameday: G(r, 'gameday'), gametime: G(r, 'gametime') || null, away: G(r, 'away_team'), home: G(r, 'home_team'),
  spread: num(G(r, 'spread_line')), total: num(G(r, 'total_line')), awayScore: num(G(r, 'away_score')), homeScore: num(G(r, 'home_score')), roof: G(r, 'roof'), stadium: G(r, 'stadium') }));
const scheduleAll = rows.filter(r => +G(r, 'season') >= S - 1).map(r => ({ season: +G(r, 'season'), week: +G(r, 'week'), home: G(r, 'home_team'), away: G(r, 'away_team'),
  spread: num(G(r, 'spread_line')), total: num(G(r, 'total_line')) }));
const out = ['roleUp,week,board,pid,mu,roleX'];
for (const wk of [2, 3, 4, 5, 6]) for (const roleUp of [0.5, 0.75, 1.0]) {
  const P = await buildPicks({ schedule, historySeason: S, upcomingSeason: S, target: { season: S, week: wk }, scheduleAll, roleUp });
  if (!P) continue;
  for (const [m, list] of Object.entries(P.yards || {})) for (const r of list) if (!r.f?.thinRole) out.push([roleUp, wk, m, r.pid, r.mu, r.f?.roleX ?? 1].join(','));
  for (const r of P.receptions || []) if (!r.f?.thinRole) out.push([roleUp, wk, 'recn', r.pid, r.mu, r.f?.roleX ?? 1].join(','));
  console.log('week', wk, 'roleUp', roleUp, 'rows', out.length - 1);
}
fs.writeFileSync('research/.cache/role_replay.csv', out.join('\n'));
