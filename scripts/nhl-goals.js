// Anytime goal scorer — the NHL Picks board.
//
// Model and methodology in research/nhl_goals.py. Training stays in Python;
// this file computes the features and applies the exported coefficients.
//
// Goals are Poisson (variance/mean 1.004 per skater), so the anytime price is
// 1 - exp(-mu), then an isotonic map fitted on walk-forward out-of-sample
// predictions — that halves the calibration error without moving the ranking.
//
// The link is log, so every feature's push is EXACTLY a multiplier on expected
// goals: exp(coef * z). contribs() hands those to the modal's factor bars.
import fs from 'node:fs';

const MODEL = JSON.parse(
  fs.readFileSync(new URL('../research/nhl_goals_model.json', import.meta.url), 'utf8'));
const KG = MODEL.shrink?.goals ?? 16, KS = MODEL.shrink?.shpct_shots ?? 120, K8 = 8;

/** Features for one skater's upcoming game. All inputs are strictly pre-game. */
export function goalFeatures({ role, gp, goals, sog, toi, toiL5, pptoiL5, sogL10, oppGa, teamGf, isHome }) {
  if (!(gp >= 10)) return null;
  const R = MODEL.role[role] || MODEL.role.F, L = MODEL.league;
  const sogPrior = (sog + K8 * R.sog) / (gp + K8);
  return {
    goals_prior: (goals + KG * R.goals) / (gp + KG),
    sog_prior: sogPrior,
    shpct_prior: (goals + KS * (R.goals / R.sog)) / (sog + KS),
    toi_prior: (toi + K8 * R.toi) / (gp + K8),
    toi_l5: toiL5 ?? toi / gp,
    pptoi_l5: pptoiL5 ?? 0,
    sog_l10: sogL10 ?? sogPrior,
    opp_ga_prior: oppGa ?? L.opp_ga,
    team_gf_prior: teamGf ?? L.team_gf,
    is_home: isHome ? 1 : 0,
    is_D: role === 'D' ? 1 : 0,
  };
}

/** Per-term log-multipliers on expected goals, plus the league-average base. */
export function contribs(f) {
  let base = MODEL.coef.intercept + (MODEL.coef.is_D || 0) * f.is_D;
  const parts = {};
  for (const k of MODEL.features) {
    const s = MODEL.scale[k];
    parts[k] = MODEL.coef[k] * ((f[k] - s.mean) / s.sd);
  }
  return { base, parts };
}

// Past either end knot the map is extended PROPORTIONALLY, not held flat. The
// top knot sits at raw 0.442 -> 0.398, and a flat clamp gave every star above
// it the identical price, so the head of the board tied. Scaling by that
// knot's own ratio keeps the correction and the ranking.
function iso(p) {
  const { x, y } = MODEL.iso, n = x.length;
  if (p <= x[0]) return p * (y[0] / x[0]);
  if (p >= x[n - 1]) return p * (y[n - 1] / x[n - 1]);
  let i = 1; while (x[i] < p) i++;
  const t = (p - x[i - 1]) / (x[i] - x[i - 1]);
  return y[i - 1] + t * (y[i] - y[i - 1]);
}

/** mu, raw P(1+), calibrated P(1+). */
export function priceGoal(f) {
  const { base, parts } = contribs(f);
  const eta = base + Object.values(parts).reduce((a, b) => a + b, 0);
  const mu = Math.exp(Math.max(-8, Math.min(3, eta)));
  const pRaw = 1 - Math.exp(-mu);
  return { mu, pRaw, p: Math.min(0.97, Math.max(0.003, iso(pRaw))), base, parts };
}

export const GOAL_MODEL = MODEL;
