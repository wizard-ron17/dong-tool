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
                                    teamPassLog, team, impliedTotal, windExcess }) {
  const before = (s) => s.season < season || (s.season === season && s.week < week);
  const snaps = (snapLog.get(pid) ?? []).filter(before);
  const recs = (recLog.get(pid) ?? []).filter(before);
  if (!snaps.length) return null;

  const pri = (k) => MODEL.position_priors[k]?.[position]
                  ?? MODEL.position_priors[k]?.WR ?? 0;
  // A game with no targets is a real zero, so the denominator is games PLAYED
  // (the snap log), never the length of the reception log — using the latter
  // would compute "his rate in games he caught something", which is near
  // useless and always high.
  const played = snaps.length;
  const recSum = recs.reduce((a, b) => a + b.rec, 0);
  const tgtSum = recs.reduce((a, b) => a + b.tgt, 0);
  const shareSum = recs.reduce((a, b) => a + b.share, 0);
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
    wind_excess: windExcess ?? 0,
    _games: played,
  };
}

/** Expected receptions. Log link, so the linear predictor exponentiates. */
export function scoreMu(row) {
  const c = MODEL.coef;
  let z = c.intercept;
  if (row.position !== MODEL.reference_position) z += c[`pos_${row.position}`] ?? 0;
  for (const f of MODEL.features) {
    const s = MODEL.scale[f];
    z += c[f] * ((row[f] - s.mean) / s.sd);
  }
  return Math.exp(Math.max(-8, Math.min(4, z)));
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
