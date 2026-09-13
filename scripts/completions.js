// Completions — QB completion over/unders.
//
// Model in research/completions.py. The usage model barely beats a career
// average, and that is fine: it is the honest baseline a completions line is
// built from. The two things that move a QB off his average both only bite at
// the extreme, so both ship as measured multipliers on the mean rather than
// coefficients:
//   * wind  — x0.889 at ~23 mph (fewer attempts AND a lower completion rate)
//   * pass defense — x0.968 against the stingiest fifth of defenses by
//     completion % allowed; the other four fifths are flat
// Priced negative binomial: completions run variance/mean 1.5-1.9.
import fs from 'node:fs';

const M = JSON.parse(fs.readFileSync(new URL('../research/completions_model.json', import.meta.url), 'utf8'));
const K = M.shrink_k ?? 3;

const interp = (tab, v) => {
  if (!tab || v == null || Number.isNaN(v)) return 1;
  const { x, y } = tab;
  if (v <= x[0]) return y[0];
  if (v >= x[x.length - 1]) return y[y.length - 1];
  let i = 1; while (i < x.length && x[i] < v) i++;
  return y[i - 1] + (v - x[i - 1]) / (x[i] - x[i - 1]) * (y[i] - y[i - 1]);
};
export const windFactor = (mph) => (mph > 0 ? interp(M.wind_factor, mph) : 1);
export const defFactor = (rate) => interp(M.def_factor, rate);

/**
 * Features for one QB start. Every input comes from games strictly before the
 * target week, inside the same 2-season window research/completions.py fits on.
 * Only starts (10+ attempts) count, matching the training population.
 */
export function completionFeatures({ pid, season, week, passLog, defLog, opp, impliedTotal, floor }) {
  const before = (g) => g.season < season || (g.season === season && g.week < week);
  const lo = Math.max(season - 1, floor ?? season - 1);
  const starts = (passLog.get(pid) ?? []).filter(g => before(g) && g.season >= lo && g.att >= 10);
  const n = starts.length;
  const L = M.league;
  const sum = (k) => starts.reduce((a, g) => a + g[k], 0);
  const rates = starts.map(g => g.cmp / g.att);
  const cmpPrior = (sum('cmp') + K * L.cmp) / (n + K);
  const attPrior = (sum('att') + K * L.att) / (n + K);
  const ratePrior = (rates.reduce((a, b) => a + b, 0) + K * L.rate) / (n + K);

  const dg = (defLog.get(opp) ?? []).filter(g => before(g) && g.season >= lo);
  const dRates = dg.map(g => g.cmp / Math.max(g.att, 1));
  const defRate = (dRates.reduce((a, b) => a + b, 0) + K * L.def_rate) / (dg.length + K);

  return { cmp_prior: cmpPrior, att_prior: attPrior, rate_prior: ratePrior,
           implied: impliedTotal, def_rate: defRate, _starts: n,
           _l3: starts.slice(-3).reduce((a, g) => a + g.cmp, 0) / Math.max(1, Math.min(3, n)) };
}

/** Expected completions: log-link usage mean x wind x pass defense. */
export function scoreMu(row, windMph) {
  let z = M.coef.intercept;
  for (const f of M.features) z += M.coef[f] * ((row[f] - M.scale[f].mean) / M.scale[f].sd);
  const base = Math.exp(Math.max(-8, Math.min(5, z)));
  return base * windFactor(windMph) * defFactor(row.def_rate) * thinFactor(row._starts);
}

/**
 * A starter with under 3 recent starts shrinks toward a league-average QB, and
 * that overstates him: walk-forward, 0-start starters completed 2.39 fewer than
 * projected. x0.894 at 0 starts, x0.974 at 1-2, 1 from 3 on.
 */
export const thinFactor = (starts) =>
  starts >= 3 ? 1 : (M.thin_factor?.[String(Math.max(0, starts))] ?? 1);

/** P(completions > line) under NB2. */
export function pOver(line, mu, alpha = M.alpha) {
  const k = Math.floor(line), r = 1 / alpha, p = r / (r + mu);
  let term = Math.pow(p, r), cdf = term;
  for (let i = 1; i <= k; i++) { term = term * ((r + i - 1) / i) * (1 - p); cdf += term; }
  return Math.min(1 - 1e-6, Math.max(1e-6, 1 - cdf));
}

export const CMP_LINES = M.lines;
export const COMPLETIONS_MODEL = M;
