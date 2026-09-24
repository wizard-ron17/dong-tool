// Hits and blocked shots — the boards behind /nhl/hits and /nhl/blocks.
//
// Model and methodology in research/nhl_phys.py (182,609 skater-games,
// walk-forward by season). Poisson means on log-scale rates with negative-
// binomial tails, like shots. Hits: his own rate carries it (career, last 5,
// last 10), then ice time, the opponent's shot attempts, home ice — and the
// rink's scorer, the strongest context term (t +12.4): hits and blocks are
// counted by the home arena's scorekeepers, and some count far more than others.
// It's season-to-date only, because scorekeepers change between seasons (a
// rink's rate carried across seasons HURT the model). Blocks: his rate, ice
// time, penalty-kill minutes (t +4.3), the opponent's attempts (t +8.0), the rink.
// Both also take the closing line's win chance: underdogs expect to trail, and
// trailing clubs chase the puck — hits t +3.5, blocks t +4.0.
import fs from 'node:fs';

export const PHYS_MODEL = JSON.parse(
  fs.readFileSync(new URL('../research/nhl_phys_model.json', import.meta.url), 'utf8'));
const K = PHYS_MODEL.shrink_games;              // 16 games of prior weight on his own rate
const K_TOI = 8;                                // as the shots dataset shrinks ice time
const lg = (k, v) => Math.log(Math.max(0, v) + PHYS_MODEL.log_offset[k]);
const lastN = (xs, n, dflt) => { const w = xs.slice(-n); return w.length >= 2 ? w.reduce((a, b) => a + b, 0) / w.length : dflt; };

/**
 * @param h       career-to-date, this season + last: { gp, hits, bks, toi, shtoi }
 * @param recent  his recent games, oldest first: [{ hits, bks, toi, shtoi }]
 * @param oppCf   the opponent's shot attempts per game
 * @param arena   this season's { hits, bks } per game at tonight's rink, and games there: { n, hits, bks }
 */
export function physFeatures({ role, h, recent, oppCf, isHome, arena, winP }) {
  if (!h?.gp || h.gp < 3) return null;
  const R = PHYS_MODEL.role[role] || PHYS_MODEL.role.F, L = PHYS_MODEL.league, KA = PHYS_MODEL.arena_shrink_games;
  const shr = (sum, prior, k = K) => (sum + k * prior) / (h.gp + k);
  const x = {
    hits_prior: shr(h.hits, R.hits), bks_prior: shr(h.bks, R.bks),
    toi_prior: shr(h.toi, R.toi, K_TOI), shtoi_prior: shr(h.shtoi, R.shtoi, K_TOI),
    opp_cf_prior: oppCf ?? L.cf, is_home: isHome ? 1 : 0, is_D: role === 'D' ? 1 : 0,
    // game state before puck drop: underdogs expect to trail and chase the puck (0 without a line)
    underdog: winP == null ? 0 : 0.5 - winP,
  };
  const col = (k) => recent.map(r => r[k] || 0);
  x.hits_l5 = lastN(col('hits'), 5, x.hits_prior); x.hits_l10 = lastN(col('hits'), 10, x.hits_prior);
  x.bks_l5 = lastN(col('bks'), 5, x.bks_prior); x.bks_l10 = lastN(col('bks'), 10, x.bks_prior);
  x.toi_l5 = lastN(col('toi'), 5, h.toi / h.gp); x.shtoi_l5 = lastN(col('shtoi'), 5, x.shtoi_prior);
  // the rink, this season only: shrunk toward the league with 10 games of weight
  const n = arena?.n || 0;
  x.arena_hits = ((arena?.hits || 0) + KA * L.arena_hits) / (n + KA) / L.arena_hits;
  x.arena_bks = ((arena?.bks || 0) + KA * L.arena_bks) / (n + KA) / L.arena_bks;
  for (const k of Object.keys(PHYS_MODEL.log_offset)) if (x[k] != null) x['log_' + k] = lg(k, x[k]);
  return x;
}

/** Projected hits or blocks ('hits' | 'bks'). */
export function projectPhys(kind, f) {
  const m = PHYS_MODEL[kind];
  let eta = m.coef.intercept + (m.coef.is_D || 0) * f.is_D;
  for (const k of m.features) eta += m.coef[k] * ((f[k] - m.scale[k].mean) / m.scale[k].sd);
  return Math.exp(Math.max(-6, Math.min(4, eta)));
}

/** P(count > line) under NB2 with the market's dispersion. */
export function physOver(kind, line, mu) {
  const r = 1 / PHYS_MODEL[kind].alpha, p = r / (r + mu);
  let term = Math.pow(p, r), cdf = term;
  for (let i = 1; i <= Math.floor(line); i++) { term = term * ((r + i - 1) / i) * (1 - p); cdf += term; }
  return Math.min(1 - 1e-6, Math.max(1e-6, 1 - cdf));
}

export const physMeta = (kind) => {
  const m = PHYS_MODEL[kind];
  return { alpha: m.alpha, lines: m.lines, backtest: m.backtest, rows: PHYS_MODEL.rows, seasons: PHYS_MODEL.seasons };
};
