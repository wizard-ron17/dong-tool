// Anytime-TD board for 2025 weeks 2-18 and 2026 weeks 2-7, rebuilt through the real buildPicks, keeping
// each row's usage inputs so research/td_prior.py can find the players priced off the POSITION PRIOR
// (no games in the window: touches, TD share and red zone fall back to the position's mean) and see how
// they actually scored. Jaydn Ott, a 4th-string RB, priced 18.8% on that prior (2026-10-30).
//   node research/td_prior_replay.mjs   -> research/.cache/td_prior_replay.csv
import fs from 'node:fs';
import { parseCsv, num } from '../scripts/nflverse.js';
import { buildPicks } from '../scripts/picks.js';
const { idx: gi, rows } = parseCsv(fs.readFileSync('research/.cache/nfl/games.csv', 'utf8'));
const G = (r, k) => r[gi[k]];
const out = ['season,week,pid,pos,p,depth,snap3,snapPrior,touches,tdShare,rz'];
const jobs = [...Array.from({ length: 17 }, (_, i) => [2025, i + 2]), ...[2, 3, 4, 5, 6, 7].map(w => [2026, w])];
for (const [S, wk] of jobs) {
  const schedule = rows.filter(r => +G(r, 'season') === S).map(r => ({ gameId: G(r, 'game_id'), week: +G(r, 'week'), type: G(r, 'game_type'),
    gameday: G(r, 'gameday'), gametime: G(r, 'gametime') || null, away: G(r, 'away_team'), home: G(r, 'home_team'),
    spread: num(G(r, 'spread_line')), total: num(G(r, 'total_line')), awayScore: num(G(r, 'away_score')), homeScore: num(G(r, 'home_score')), roof: G(r, 'roof'), stadium: G(r, 'stadium') }));
  const scheduleAll = rows.filter(r => +G(r, 'season') >= S - 1 && +G(r, 'season') <= S).map(r => ({ season: +G(r, 'season'), week: +G(r, 'week'), home: G(r, 'home_team'), away: G(r, 'away_team'),
    spread: num(G(r, 'spread_line')), total: num(G(r, 'total_line')) }));
  let P;
  try { P = await buildPicks({ schedule, historySeason: S, upcomingSeason: S, target: { season: S, week: wk }, scheduleAll }); } catch (e) { console.log('fail', S, wk, e.message); continue; }
  if (!P) continue;
  for (const r of P.picks || []) { const f = r.f || {};
    out.push([S, wk, r.pid, r.pos, r.p, f.depthRank ?? '', f.snap3 ?? '', f.snapPrior ?? '', f.touches ?? '', f.tdShare ?? '', f.rz ?? ''].join(',')); }
  console.log('done', S, wk, out.length - 1);
  fs.writeFileSync('research/.cache/td_prior_replay.csv', out.join('\n'));
}
