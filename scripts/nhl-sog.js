// Shots on goal — over/under pricing for skater SOG.
//
// Model and methodology in research/nhl_sog.py. Training stays in Python; this
// file computes features and applies the exported coefficients, the same split
// as scripts/receptions.js.
//
// Two things carried over from the receptions board, both for measured reasons:
//
//  * The mean comes from a Poisson GLM but the PRICE does not. Per player, SOG
//    runs variance/mean 1.13 against the 1.00 a Poisson assumes, so pricing it
//    Poisson misprices the tails. pOver() below is the same negative-binomial
//    tail receptions uses, with SOG's own fitted alpha.
//
//  * Rate features are on a log scale — see featureValue() below.
//
//  * Individual Corsi and Fenwick are NOT features, though the feed has them
//    (skater/realtime totalShotAttempts and shotAttemptsBlocked). They were
//    tested: r=0.927 and 0.978 with career SOG/game, both worse than it alone,
//    and adding Corsi back to the shipped set makes it worse. They measure the
//    same thing less well.
import fs from 'node:fs';

const MODEL = JSON.parse(
  fs.readFileSync(new URL('../research/nhl_sog_model.json', import.meta.url), 'utf8'));
const K = MODEL.shrink_k ?? 8;

/** Shrunk mean toward a league prior — mirrors asof_mean() in the Python. */
const shrunk = (sum, n, prior) => (sum + K * prior) / (n + K);

/** Mean of the last n entries, or null when there is no history at all. */
function lastN(vals, n) {
  if (!vals.length) return null;
  const w = vals.slice(-n);
  return w.reduce((a, b) => a + b, 0) / w.length;
}

/**
 * Feature row for one skater's upcoming game.
 *
 * `log` is his per-game history, oldest first, each { sog, toi, pptoi }, and
 * must contain only games STRICTLY BEFORE the one being priced.
 */
export function sogFeatures({ log, role, oppSa, teamSf, isHome }) {
  if (!log || log.length < 3) return null;      // research floor is 5; 3 is the hard minimum
  const L = MODEL.league;
  const sum = (k) => log.reduce((a, g) => a + (g[k] || 0), 0);
  const n = log.length;

  const sogs = log.map(g => g.sog || 0);
  const tois = log.map(g => g.toi || 0);
  const pps = log.map(g => g.pptoi || 0);

  return {
    sog_prior: shrunk(sum('sog'), n, L.sog),
    sog_l5: lastN(sogs, 5),
    sog_l10: lastN(sogs, 10),
    toi_prior: shrunk(sum('toi'), n, L.toi),
    toi_l5: lastN(tois, 5),
    pptoi_l5: lastN(pps, 5),
    opp_sa_prior: oppSa ?? L.opp_sa,
    team_sf_prior: teamSf ?? L.team_sf,
    is_home: isHome ? 1 : 0,
    is_D: role === 'D' ? 1 : 0,
  };
}

/** Projected shots on goal: exp of the standardised linear predictor. */
// Rate features enter the model on a log scale (log_<x> = ln(max(x,0) + offset)),
// so the projection is a power law in a skater's rates rather than exponential
// in them — raw-scale inputs ran the ends of the board ~25% hot out of sample.
const LOG_OFFSET = MODEL.log_offset || {};
const featureValue = (f, k) => {
  if (!k.startsWith('log_')) return f[k];
  const raw = k.slice(4);
  return Math.log(Math.max(0, f[raw] ?? 0) + (LOG_OFFSET[raw] ?? 0.1));
};

export function projectSog(f) {
  if (!f) return null;
  let eta = MODEL.coef.intercept;
  for (const k of MODEL.features) {
    const s = MODEL.scale[k];
    eta += MODEL.coef[k] * ((featureValue(f, k) - s.mean) / s.sd);
  }
  eta += (MODEL.coef.is_D || 0) * f.is_D;
  return Math.exp(Math.max(-6, Math.min(6, eta)));
}

/**
 * P(shots > line) under NB2, Var = mu + alpha*mu^2.
 *
 * Summing the pmf up to floor(line) rather than using a Poisson tail is the
 * point: the extra variance moves probability out of the middle, and the gap
 * grows with the line.
 */
export function pOver(line, mu, alpha = MODEL.alpha) {
  const k = Math.floor(line);
  const r = 1 / alpha;
  const p = r / (r + mu);
  let term = Math.pow(p, r);
  let cdf = term;
  for (let i = 1; i <= k; i++) {
    term = term * ((r + i - 1) / i) * (1 - p);
    cdf += term;
  }
  return Math.min(1 - 1e-6, Math.max(1e-6, 1 - cdf));
}

/** Fair American odds from a probability. No vig. */
export function fairOdds(p) {
  if (!(p > 0 && p < 1)) return null;
  return p >= 0.5 ? Math.round(-100 * p / (1 - p)) : Math.round(100 * (1 - p) / p);
}

/** The whole ladder for one projection, priced both ways. */
export function ladder(mu) {
  return MODEL.lines.map(line => {
    const over = pOver(line, mu);
    return { line, over, under: 1 - over, oddsOver: fairOdds(over), oddsUnder: fairOdds(1 - over) };
  });
}

export const LINES = MODEL.lines;
export const SOG_MODEL = MODEL;
