// Receptions — over/under pricing for catches.
//
// Model and methodology in research/receptions.py. Training stays in Python;
// this file computes features and applies the exported coefficients.
//
// Two things make this different from the touchdown board:
//
//  * The mean comes from a Poisson GLM but the PRICE does not. Reception counts
//    are over-dispersed (variance/mean 1.1-1.3 against the 1.0 a Poisson
//    assumes), so pricing them Poisson over-prices the over by up to 9pp at
//    o6.5. Prices come off a negative binomial with the fitted alpha.
//
//  * Wind is in, which no touchdown feature is. Averaged over a season it looks
//    like a null, because 89% of games never reach 15 mph. In the games that do
//    it is worth up to 18% of a player's projection.
import fs from 'node:fs';

const MODEL = JSON.parse(
  fs.readFileSync(new URL('../research/receptions_model.json', import.meta.url), 'utf8'));
const SHRINK_K = MODEL.shrink_k ?? 3;
const REC_POS = ['WR', 'RB', 'TE', 'FB'];

/** Shrunk prior toward the position mean — mirrors add_form() in the Python. */
function shrunk(sum, n, posMean) {
  return (sum + SHRINK_K * posMean) / (n + SHRINK_K);
}

/** Mean over the last n games strictly before this one. */
function lastN(vals, n) {
  if (!vals.length) return null;
  const w = vals.slice(-n);
  return w.reduce((a, b) => a + b, 0) / w.length;
}

/**
 * Feature row for one player. Every input is drawn from games strictly before
 * the target week, exactly as research/build_receptions.py does it.
 */
export function receptionFeatures({ pid, position, season, week, snapLog, recLog,
                                    teamPassLog, team, impliedTotal,
                                    windowFloor, windMph }) {
  const before = (s) => s.season < season || (s.season === season && s.week < week);
  const snaps = (snapLog.get(pid) ?? []).filter(before);
  const recs = (recLog.get(pid) ?? []).filter(before);
  if (!snaps.length) return null;

  const pri = (k) => MODEL.position_priors[k]?.[position]
                  ?? MODEL.position_priors[k]?.WR ?? 0;
  // A game with no targets is a real zero, so the denominator is games PLAYED
  // from the snap log, never the length of the reception log — using the
  // latter computes "his rate in games he caught something", always high.
  //
  // But played games must span the SAME WINDOW as the reception log, which
  // only covers the loaded play-by-play seasons. The first cut counted a
  // player's whole career of snap games (2016+) against two seasons of
  // receptions — a veteran's rec_prior collapsed toward zero and the whole
  // board under-projected: the results replay showed overs quoted 44.7% and
  // hitting 67.4% in the top ten. Same bug class as the TD-share denominator,
  // one level down.
  const recFloor = Math.max(season - 1, windowFloor ?? season - 1);
  const inWin = (e) => e.season >= recFloor;
  const winSnaps = snaps.filter(inWin);
  const played = winSnaps.length;
  const recSum = recs.filter(inWin).reduce((a, b) => a + b.rec, 0);
  const tgtSum = recs.filter(inWin).reduce((a, b) => a + b.tgt, 0);
  const shareSum = recs.filter(inWin).reduce((a, b) => a + b.share, 0);
  const snapVals = snaps.map(s => s.pct);

  // per-game series padded with the zeros the reception log omits, so a quiet
  // game pulls the last-3 window down the way it actually should
  const byKey = new Map(recs.map(r => [`${r.season}|${r.week}`, r]));
  const recSeries = snaps.map(s => byKey.get(`${s.season}|${s.week}`)?.rec ?? 0);
  const shareSeries = snaps.map(s => byKey.get(`${s.season}|${s.week}`)?.share ?? 0);

  const tp = [];
  for (const s of snaps) {
    const v = teamPassLog.get(`${s.team}|${s.season}|${s.week}`);
    if (v != null) tp.push(v);
  }
  const recPrior = shrunk(recSum, played, pri('rec_prior'));
  const tgtPrior = shrunk(tgtSum, played, pri('rec_prior') / 0.65);

  return {
    position,
    rec_l3: lastN(recSeries, 3) ?? shrunk(0, 0, pri('rec_l3')),
    rec_prior: recPrior,
    share_l3: lastN(shareSeries, 3) ?? shrunk(0, 0, pri('share_l3')),
    tgt_share_prior: shrunk(shareSum, played, pri('tgt_share_prior')),
    snap_l3: lastN(snapVals, 3) ?? shrunk(0, 0, pri('snap_l3')),
    catch_prior: Math.min(1, Math.max(0, recPrior / Math.max(tgtPrior, 0.1))),
    team_pass_prior: tp.length ? tp.reduce((a, b) => a + b, 0) / tp.length
                               : pri('team_pass_prior'),
    implied_total: impliedTotal,
    wind_mph: windMph ?? 0,
    _games: played,
  };
}

/**
 * Expected receptions. Log link, then a monotone recalibration — the same cure
 * the TD model applies to its logistic. A log link extrapolates exponentially
 * where the empirical relationship flattens, so raw projections over-shot the
 * top of the board (a 9.4-catch quote no receiver has ever averaged; rows
 * projected 5.95 caught 5.25). Knots fitted on out-of-sample walk-forward
 * pairs in research/receptions.py; interp clamps flat past the last knot.
 */
export function scoreMu(row) {
  const c = MODEL.coef;
  let z = c.intercept;
  if (row.position !== MODEL.reference_position) z += c[`pos_${row.position}`] ?? 0;
  for (const f of MODEL.features) {
    const s = MODEL.scale[f];
    z += c[f] * ((row[f] - s.mean) / s.sd);
  }
  const raw = Math.exp(Math.max(-8, Math.min(4, z)));

  // Monotone recalibration of the usage-driven projection.
  const cal = MODEL.mu_cal;
  let base = raw;
  if (cal) {
    const { x, y } = cal;
    if (raw <= x[0]) base = y[0] * (raw / x[0]);
    else if (raw >= x[x.length - 1]) base = y[y.length - 1];
    else {
      let i = 1;
      while (i < x.length && x[i] < raw) i++;
      const t = (raw - x[i - 1]) / (x[i] - x[i - 1]);
      base = y[i - 1] + t * (y[i] - y[i - 1]);
    }
  }
  // Wind multiplies the calibrated mean rather than entering the fit. Applied
  // AFTER the recalibration on purpose: the map is flat past its last knot,
  // which is honest about usage but would swallow wind whole — a 25 mph game
  // moved the top of the board 6.34 -> 6.34, zero effect on exactly the players
  // most likely to be bet.
  return base * windFactor(row.wind_mph);
}

/** Measured multiplier on expected catches, interpolated from research bins. */
export function windFactor(mph) {
  const w = MODEL.wind_factor;
  if (!w || mph == null || !(mph > 0)) return 1;
  const { x, y } = w;
  if (mph <= x[0]) return y[0];
  if (mph >= x[x.length - 1]) return y[y.length - 1];
  let i = 1;
  while (i < x.length && x[i] < mph) i++;
  const t = (mph - x[i - 1]) / (x[i] - x[i - 1]);
  return y[i - 1] + t * (y[i] - y[i - 1]);
}

/**
 * P(receptions > line) under NB2, Var = mu + alpha*mu^2.
 *
 * Summing the pmf up to floor(line) rather than using a Poisson tail is the
 * whole point: the extra variance moves probability out of the middle and the
 * over gets cheaper, by up to 9 points at the longer lines.
 */
export function pOver(line, mu, alpha = MODEL.alpha) {
  const k = Math.floor(line);
  const r = 1 / alpha;
  const p = r / (r + mu);
  let term = Math.pow(p, r);          // pmf at 0
  let cdf = term;
  for (let i = 1; i <= k; i++) {
    term = term * ((r + i - 1) / i) * (1 - p);
    cdf += term;
  }
  return Math.min(1 - 1e-6, Math.max(1e-6, 1 - cdf));
}

export const LINES = MODEL.lines;
export const RECEPTION_POS = REC_POS;
export const RECEPTION_MODEL = MODEL;
