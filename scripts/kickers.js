// Kickers — field goals made, PATs made, kicker points (3 x FG made + PAT made).
//
// Model in research/kickers.py. What moves each market, walk-forward 2019-2025:
//   * PAT made is the implied team total and nothing else (log loss 0.667 ->
//     0.614 against the league average; spread, weather, the kicker all null)
//   * FG made is thin: the implied total alone is worth nothing, but being
//     favoured (+10% FGs per 6.4 points), cold (-4.6% per 6 degrees below 50F)
//     and wind (-3.2% per 5 mph) together beat the average at t -4.0. Prices
//     only run about +137 to -133 — most games are near a coin flip.
//   * Underdogs do NOT kick more field goals; favourites do (trailing teams go
//     for it on fourth down instead).
//   * The kicker himself is noise: FG% split-half r 0.02, 40+ 0.06, PAT% 0.08.
//     His name is on the row; his accuracy is not in the price.
// FG made and PAT made are under-dispersed (variance 0.88 / 0.85 of the mean),
// priced binomial with the variance matched. Points are priced from both means
// through the measured actual/projected ratio by projection quintile, which
// carries the trade-off between the two (FG vs PAT correlation -0.19).
import fs from 'node:fs';

const M = JSON.parse(fs.readFileSync(new URL('../research/kickers_model.json', import.meta.url), 'utf8'));

/** Game-level features for one team. Indoors: no wind, no cold by construction. */
export function kickerFeatures({ implied, fav, indoor, windMph, tempF }) {
  const outdoor = !indoor;
  const wind = outdoor ? (windMph ?? M.league.wind_outdoor_median) : 0;
  const cold = outdoor && tempF != null ? Math.max(0, 50 - tempF) : 0;
  return { implied, fav: fav ?? 0, wind, cold, _windKnown: !outdoor || windMph != null, _tempKnown: !outdoor || tempF != null };
}

function mean(m, row) {
  let z = m.coef.intercept;
  for (const f of m.features) z += m.coef[f] * ((row[f] - m.scale[f].mean) / m.scale[f].sd);
  return Math.exp(Math.max(-8, Math.min(3, z)));
}
export const muFgm = (row) => mean(M.fgm, row);
export const muPat = (row) => mean(M.patm, row);
export const muPts = (row) => 3 * muFgm(row) + muPat(row);

function lchoose(n, k) { let s = 0; for (let i = 1; i <= k; i++) s += Math.log((n - k + i) / i); return s; }
/** pmf of a count with mean mu and variance disp x mu (disp < 1: binomial). */
export function countPmf(mu, disp, max = 10) {
  const pr = Math.min(0.98, Math.max(0.02, 1 - disp));
  const n = Math.max(1, Math.round(mu / pr)), p = Math.min(1 - 1e-6, mu / n);
  const out = [];
  for (let k = 0; k <= max; k++) out.push(k > n ? 0 : Math.exp(lchoose(n, k) + k * Math.log(p) + (n - k) * Math.log1p(-p)));
  return out;
}
const tail = (pmf, line) => Math.min(1 - 1e-4, Math.max(1e-4, pmf.slice(Math.floor(line) + 1).reduce((a, b) => a + b, 0)));
export const pOverFgm = (line, mu) => tail(countPmf(mu, M.fgm.disp), line);
export const pOverPat = (line, mu) => tail(countPmf(mu, M.patm.disp), line);

/** P(kicker points > line) from the ratio table of the projection's quintile. */
export function pOverPts(line, mu) {
  const e = M.pts.edges;
  let b = 0; while (b < 4 && mu >= e[b + 1]) b++;
  const q = M.pts.q[b];
  return Math.min(0.995, Math.max(0.005, q.filter(r => r * mu > line).length / q.length));
}

/** Each feature's pull on expected FGs / PATs, as a multiplier (log-additive, exact). */
export function contributions(row) {
  const part = (m) => Object.fromEntries(m.features.map(f => [f, Math.exp(m.coef[f] * ((row[f] - m.scale[f].mean) / m.scale[f].sd))]));
  return { fgm: part(M.fgm), patm: part(M.patm) };
}

export const KICK_LINES = M.lines;
export const KICKERS_MODEL = M;
