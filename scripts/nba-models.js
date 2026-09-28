// NBA board models — applies research/nba_model.json (research/nba_model_export.py).
// Nothing is fitted here. Every input is computed the way research defines it,
// from nba/players.json; research/nba_parity.mjs replays a cached season through
// these same functions and checks them against research's own numbers.
import fs from 'node:fs';

export const MODEL = JSON.parse(fs.readFileSync(new URL('../research/nba_model.json', import.meta.url), 'utf8'));
const POS = MODEL.positions;
export const fam = (pos) => POS[pos] || 'F';
const mean = (a) => a.length ? a.reduce((x, y) => x + y, 0) / a.length : null;
const clip = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
const days = (a, b) => Math.round((Date.parse(b + 'T12:00:00Z') - Date.parse(a + 'T12:00:00Z')) / 864e5);

/**
 * His minutes inputs before tonight, from his state row. `last10` holds played
 * games only (applyGame skips DNPs), oldest first — research's rolling windows
 * over played games, carried across the season break.
 */
export function minutesInputs(s, prev) {
  const L = s.last10 || [];
  const m = (n) => mean(L.slice(-n).map(g => g.min));
  const m10 = m(10);
  return {
    m3: m(3), m5: m(5), m10,
    mseason: s.gp > 0 ? s.min / s.gp : m10,                         // season to date, else last 10
    mprev: prev?.gp > 0 ? prev.min / prev.gp : m10,                  // last season, else last 10
    start10: mean(L.slice(-10).map(g => g.st)),
    lastDate: L.length ? L[L.length - 1].d : null,
  };
}

/**
 * Tonight's projected minutes. ctx: { date, teamLast, absSpread, b2b, vacated, vacPos, starting? }.
 * Rest is days since his TEAM's last game (teamLast), as research defines it.
 * `starting` known (lineups posted) switches to the lineup model.
 */
export function projectMinutes(inp, ctx) {
  const M = MODEL.minutes, useLineup = ctx.starting != null, m = useLineup ? M.lineup : M.pre;
  const st = useLineup ? (ctx.starting ? 1 : 0) : 0;
  const abs = ctx.absSpread ?? M.abs_sp_median;
  const x = {
    m3: inp.m3, m5: inp.m5, m10: inp.m10, mseason: inp.mseason, mprev: inp.mprev, start10: inp.start10,
    vacated: ctx.vacated || 0, vac_pos: ctx.vacPos || 0, abs_sp: abs, b2b: ctx.b2b ? 1 : 0,
    rest: ctx.teamLast ? clip(days(ctx.teamLast, ctx.date), 0, 7) : 7,
    st, st_x_sp: st * abs, vac_x_st: (ctx.vacated || 0) * st,
  };
  let v = m.coef.const;
  for (const c of m.cols) v += m.coef[c] * (x[c] ?? 0);
  return { min: clip(v, 0, 44), sd: m.sd, lineup: useLineup };
}

/** His made threes per minute: season to date + half of last season, shrunk to his position family. */
export function threesRate(s, prev, pos, famRates = MODEL.league.fam_rate_3pm) {
  const T = MODEL.threes, fr = famRates[fam(pos)] ?? 0.05;
  const pt = prev?.tpm || 0, pm = prev?.min || 0;
  return (s.tpm + T.prev_weight * pt + T.shrink_min * fr) / (s.min + T.prev_weight * pm + T.shrink_min);
}

/** Opponent's threes allowed per game so far, shrunk 10 games to the league, as a ratio. */
export function oppThreesRatio(team, lgAllowed) {
  const T = MODEL.threes, lg = lgAllowed || MODEL.league.tpm_allowed;
  const n = team?.gp || 0, allowed = n ? team.tpm_allowed / n : lg;
  return ((allowed * n + T.opp_shrink_games * lg) / (n + T.opp_shrink_games)) / lg;
}

/** Expected made threes tonight at his projected minutes. */
export function threesMu({ rate, mproj, implied, oppRatio, home, lgImplied }) {
  const T = MODEL.threes, c = T.coef;
  const impR = implied != null ? implied / (lgImplied || MODEL.league.implied) : 1;
  const z = c.const + c.lrate * Math.log(Math.max(rate, 1e-4)) + c.limp * Math.log(clip(impR, ...T.clip.imp))
          + c.lopp * Math.log(clip(oppRatio, ...T.clip.opp)) + c.home * (home ? 1 : 0);
  return Math.exp(z + Math.log(Math.max(mproj, 1)));
}

// ── The ladder: NB (alpha) mixed over his minutes, 9-node Gauss–Hermite ─────
const GH = (() => {                     // probabilists' Hermite nodes/weights, n = 9, normalised
  const x = [-4.512745863399783, -3.205429002856470, -2.076847978677830, -1.023255663789133, 0,
    1.023255663789133, 2.076847978677830, 3.205429002856470, 4.512745863399783];
  const w = [2.234584400774658e-5, 2.789141321231769e-3, 4.991640676521788e-2, 2.440975028949394e-1,
    4.063492063492063e-1, 2.440975028949394e-1, 4.991640676521788e-2, 2.789141321231769e-3, 2.234584400774658e-5];
  return { x, w };
})();
function lgamma(z) {                    // Lanczos
  const g = 7, c = [0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313,
    -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7];
  if (z < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * z)) - lgamma(1 - z);
  z -= 1; let a = c[0]; const t = z + g + 0.5;
  for (let i = 1; i < g + 2; i++) a += c[i] / (z + i);
  return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(a);
}
/** P(X >= k) for NB with mean lam, dispersion alpha (variance lam + alpha lam^2). */
function nbSf(k, lam, alpha) {
  const r = 1 / alpha, p = r / (r + lam);
  let cdf = 0;
  for (let j = 0; j < k; j++) cdf += Math.exp(lgamma(j + r) - lgamma(r) - lgamma(j + 1) + r * Math.log(p) + j * Math.log(1 - p));
  return Math.max(0, 1 - cdf);
}
/** The ladder P(3PM >= k) for each rung, averaged over minutes N(mproj, sd). */
export function threesLadder(mu, mproj, sd) {
  const T = MODEL.threes, out = T.rungs.map(() => 0);
  for (let i = 0; i < GH.x.length; i++) {
    const m = clip(mproj + sd * GH.x[i], 1, 48), lam = mu * m / Math.max(mproj, 1);
    T.rungs.forEach((k, j) => { out[j] += GH.w[i] * nbSf(k, lam, T.alpha); });
  }
  return out;
}
