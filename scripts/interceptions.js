// Interceptions — QB over 0.5 / 1.5 interceptions.
//
// Model in research/interceptions.py. The hardest market on the site: the best
// walk-forward model separates starts at AUC 0.556, and prices run about +144
// to -156. What moves a price, in order:
//   * game script — big underdogs throw 0.81 INTs a start, big favourites 0.58,
//     on the same number of attempts
//   * the QB's bad-ball rate (INT + passes defensed per attempt). His own INT
//     rate is left out: split-half reliability 0.10, which is noise
//   * the opponent defense's INT rate, at about half the QB's weight
// Completion %, CPOE, depth of target and wind all tested null.
// Priced negative binomial (alpha ~0.06, close to Poisson).
import fs from 'node:fs';

const M = JSON.parse(fs.readFileSync(new URL('../research/interceptions_model.json', import.meta.url), 'utf8'));
const L = M.league;
const K = M.shrink;

/**
 * Features for one QB start, from games strictly before the target week inside
 * the 2-season window the model was fitted on. Starts are games with 10+
 * attempts, matching research/interceptions.py.
 *   fav: points his team is favoured by (negative = underdog)
 */
export function interceptionFeatures({ pid, season, week, passLog, defLog, opp, impliedTotal, fav, floor }) {
  const before = (g) => g.season < season || (g.season === season && g.week < week);
  const lo = Math.max(season - 1, floor ?? season - 1);
  const starts = (passLog.get(pid) ?? []).filter(g => before(g) && g.season >= lo && g.att >= 10);
  const n = starts.length;
  const sum = (arr, k) => arr.reduce((a, g) => a + (g[k] ?? 0), 0);

  const attPrior = (sum(starts, 'att') + K.att_starts * L.att) / (n + K.att_starts);
  const badRate = (sum(starts, 'bad') + K.bad_att * L.bad_rate) / (sum(starts, 'att') + K.bad_att);
  const dg = (defLog.get(opp) ?? []).filter(g => before(g) && g.season >= lo);
  const defInt = (sum(dg, 'int') + K.def_att * L.def_int) / (sum(dg, 'att') + K.def_att);

  return {
    log_att: Math.log(attPrior), implied: impliedTotal, fav: fav ?? 0,
    log_bad_rate: Math.log(badRate), log_def_int: Math.log(defInt),
    _att: attPrior, _bad: badRate, _defInt: defInt, _starts: n,
    _int: sum(starts, 'int'), _attSum: sum(starts, 'att'),
  };
}

/**
 * A starter with 0 recent starts threw 17.5% more interceptions than projected
 * walk-forward (usually a rookie or a backup pressed into service); 1-2 starts,
 * 2.7% more. 1 from 3 starts on.
 */
export const thinFactor = (starts) =>
  starts >= 3 ? 1 : (M.thin_factor?.[String(Math.max(0, Math.min(2, starts)))] ?? 1);

/** Expected interceptions: log-link mean x thin-history factor. */
export function scoreMu(row) {
  let z = M.coef.intercept;
  for (const f of M.features) z += M.coef[f] * ((row[f] - M.scale[f].mean) / M.scale[f].sd);
  return Math.exp(Math.max(-8, Math.min(3, z))) * thinFactor(row._starts);
}

/** P(interceptions > line) under NB2. */
export function pOver(line, mu, alpha = M.alpha) {
  const k = Math.floor(line), r = 1 / alpha, p = r / (r + mu);
  let term = Math.pow(p, r), cdf = term;
  for (let i = 1; i <= k; i++) { term = term * ((r + i - 1) / i) * (1 - p); cdf += term; }
  return Math.min(1 - 1e-6, Math.max(1e-6, 1 - cdf));
}

/** Each feature's pull on the price, as a multiplier on the mean. Exact, since
 *  the model is additive in log space. */
export function contributions(row) {
  const out = {};
  for (const f of M.features) out[f] = Math.exp(M.coef[f] * ((row[f] - M.scale[f].mean) / M.scale[f].sd));
  return out;
}

export const INT_LINES = M.lines;
export const INTERCEPTIONS_MODEL = M;
