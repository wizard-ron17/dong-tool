// Points, assists and power-play points — the board behind /nhl/points.
//
// Model and methodology in research/nhl_points.py (182,053 skater-games,
// walk-forward). Poisson means on log-scale rates; Poisson tails beat NB on
// every line, points o2.5 included. Career rate carries each market (points
// per game alone: -8.2% log loss), then ice time and power-play minutes.
// Involvement, a goals+assists split, a centre flag, Corsi and Fenwick were all
// tested and added nothing. PP points is the strongest model on the site (AUC
// .825 — power-play minutes make it a role market) and the only one of the
// three with an isotonic map; it hurt the other two.
import fs from 'node:fs';

export const PT_MODEL = JSON.parse(
  fs.readFileSync(new URL('../research/nhl_points_model.json', import.meta.url), 'utf8'));
const K = PT_MODEL.shrink_games;           // 16 games of prior weight
const K8 = 8;                              // shots / TOI priors, as the shots dataset shrinks them

const lg = (k, v) => Math.log(Math.max(0, v) + PT_MODEL.log_offset[k]);

/**
 * @param h      career-to-date totals, this season + last: { gp, goals, a, pts, ppp, sog, toi, pptoi }
 * @param recent his recent games, oldest first: [{ a, pts, ppp, toi, pptoi }]
 */
export function pointsFeatures({ role, h, recent, teamGf, oppGa, oppPk, isHome }) {
  const R = PT_MODEL.role[role] || PT_MODEL.role.F, L = PT_MODEL.league;
  const shr = (sum, prior, k = K) => (sum + k * prior) / (h.gp + k);
  const last = (k, n, dflt) => { const w = recent.slice(-n); return w.length >= 2 ? w.reduce((s, x) => s + x[k], 0) / w.length : dflt; };
  const x = {
    goals_prior: shr(h.goals, R.goals), a_prior: shr(h.a, R.a), pts_prior: shr(h.pts, R.pts), ppp_prior: shr(h.ppp, R.ppp),
    sog_prior: shr(h.sog, R.sog, K8), toi_prior: shr(h.toi, R.toi, K8),
    team_gf_prior: teamGf ?? L.team_gf, opp_ga_prior: oppGa ?? L.opp_ga, opp_pk_prior: oppPk ?? L.opp_pk,
    is_home: isHome ? 1 : 0, is_D: role === 'D' ? 1 : 0,
  };
  x.pts_l10 = last('pts', 10, x.pts_prior); x.a_l10 = last('a', 10, x.a_prior); x.ppp_l10 = last('ppp', 10, x.ppp_prior);
  x.toi_l5 = last('toi', 5, h.toi / h.gp); x.pptoi_l5 = last('pptoi', 5, h.pptoi / h.gp); x.pptoi_l10 = last('pptoi', 10, h.pptoi / h.gp);
  for (const k of Object.keys(PT_MODEL.log_offset)) if (x[k] != null) x['log_' + k] = lg(k, x[k]);
  return x;
}

function linear(m, f) {
  let eta = m.coef.intercept + (m.coef.is_D || 0) * f.is_D;
  for (const k of m.features) eta += m.coef[k] * ((f[k] - m.scale[k].mean) / m.scale[k].sd);
  return Math.exp(Math.max(-8, Math.min(3, eta)));
}
function iso(p, { x, y }) {
  const n = x.length;
  if (p <= x[0]) return p * (y[0] / x[0]);
  if (p >= x[n - 1]) return p * (y[n - 1] / x[n - 1]);
  let i = 1; while (x[i] < p) i++;
  const t = (p - x[i - 1]) / (x[i] - x[i - 1]);
  return y[i - 1] + t * (y[i] - y[i - 1]);
}
/** Expected points, assists and PP points. PP points' mean comes back through its isotonic map. */
export function projectPoints(f) {
  const pts = linear(PT_MODEL.pts, f), a = linear(PT_MODEL.a, f), raw = linear(PT_MODEL.ppp, f);
  const p1 = Math.min(0.97, Math.max(1e-5, iso(1 - Math.exp(-raw), PT_MODEL.ppp.iso)));
  return { pts, a, ppp: -Math.log(1 - p1) };
}
