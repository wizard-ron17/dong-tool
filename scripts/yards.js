// Yards — passing, rushing (QB and RB), receiving, and rush + receiving.
//
// Models in research/yards.py. What the testing found, and why the features
// are what they are:
//   * passing: a QB's yards and attempts plus the Vegas total and spread. YPA,
//     EPA, CPOE, air yards, sack rate and every defense stat added nothing.
//   * receiving / rushing: recent ROLE — last-3 snap share, target share,
//     carries, yards — on top of the averages. Defense added nothing.
// Priors are 2-season windowed and shrunk k=3 toward the position mean, the
// same rule as the Receptions board. Pricing is not a normal or a Poisson:
// yards are skewed (receiving mean 42, median 34), so P(over) is read off the
// out-of-sample distribution of actual/projection, per projection quintile.
import fs from 'node:fs';

const M = JSON.parse(fs.readFileSync(new URL('../research/yards_model.json', import.meta.url), 'utf8'));
const K = M.shrink_k ?? 3;
const QS = (() => { const n = M.markets.pass.ratio_q[0].length; return Array.from({ length: n }, (_, i) => i / (n - 1)); })();

// position means for every prior, from whichever market carries it
// (merged per position: the QB markets carry rush_prior for QB only, the skill
// markets for RB/WR/TE — taking whichever came first gave RBs no mean at all)
const POS_MEAN = {};
for (const mk of Object.values(M.markets))
  for (const [f, byPos] of Object.entries(mk.position_means ?? {}))
    for (const [pos, v] of Object.entries(byPos)) (POS_MEAN[f] ??= {})[pos] ??= v;
const pm = (f, pos) => POS_MEAN[f]?.[pos] ?? POS_MEAN[f]?.WR ?? 0;

const mean3 = (arr) => (arr.length ? arr.slice(-3).reduce((a, b) => a + b, 0) / Math.min(3, arr.length) : 0);

/**
 * RB/WR/TE features. The game population is his snap-count games (1+ offensive
 * snap) — a game without a target or carry is a real zero, never a skip.
 */
export function skillYardsFeatures({ pid, position, season, week, snapLog, recLog, rushLog, implied, spread, floor }) {
  const before = (g) => g.season < season || (g.season === season && g.week < week);
  const snaps = (snapLog.get(pid) ?? []).filter(before);
  if (!snaps.length) return null;
  const key = (g) => `${g.season}|${g.week}`;
  const recBy = new Map((recLog.get(pid) ?? []).map(r => [key(r), r]));
  const rushBy = new Map((rushLog.get(pid) ?? []).map(r => [key(r), r]));
  const lo = Math.max(season - 1, floor ?? season - 1);

  const series = snaps.map(s => {
    const rc = recBy.get(key(s)), rs = rushBy.get(key(s));
    const ryds = rc?.yds ?? 0, rush = rs?.yds ?? 0;
    return { season: s.season, ryds, tgt: rc?.tgt ?? 0, share: rc?.share ?? 0, rush, car: rs?.car ?? 0, rr: ryds + rush, snap: s.pct };
  });
  const win = series.filter(g => g.season >= lo);
  const n = win.length;
  const sum = (k) => win.reduce((a, g) => a + g[k], 0);
  const prior = (k) => (sum(k) + K * pm(`${k}_prior`, position)) / (n + K);
  const l3 = (k) => mean3(series.map(g => g[k]));

  return {
    position,
    ryds_prior: prior('ryds'), tgt_prior: prior('tgt'), rush_prior: prior('rush'), car_prior: prior('car'), rr_prior: prior('rr'),
    ryds_l3: l3('ryds'), car_l3: l3('car'), rush_l3: l3('rush'), rr_l3: l3('rr'), snap_l3: l3('snap'), share_l3: l3('share'),
    ypt: (sum('ryds') + 40 * M.league.ypt) / (sum('tgt') + 40),
    ypc: (sum('rush') + 60 * M.league.ypc) / (sum('car') + 60),
    implied_total: implied, spread_own: spread,
    _games: snaps.length,
  };
}

/**
 * Starting-QB features over his starts: games where he threw the most passes
 * for his team, with 10+ attempts (research/yards.py qb_frame). A relief
 * appearance with 10 attempts is not a start.
 *   topPasser: Set of `${pid}|${season}|${week}` — see startKeys()
 */
export function qbYardsFeatures({ pid, season, week, passLog, rushLog, implied, spread, floor, topPasser }) {
  const before = (g) => g.season < season || (g.season === season && g.week < week);
  const starts = (passLog.get(pid) ?? []).filter(g => before(g) && g.att >= 10
    && (!topPasser || topPasser.has(`${pid}|${g.season}|${g.week}`)));
  const rushBy = new Map((rushLog.get(pid) ?? []).map(r => [`${r.season}|${r.week}`, r]));
  const lo = Math.max(season - 1, floor ?? season - 1);
  const series = starts.map(g => {
    const rs = rushBy.get(`${g.season}|${g.week}`);
    return { season: g.season, pyds: g.pyds ?? 0, att: g.att, rush: rs?.yds ?? 0, car: rs?.car ?? 0 };
  });
  const win = series.filter(g => g.season >= lo);
  const n = win.length;
  const sum = (k) => win.reduce((a, g) => a + g[k], 0);
  const prior = (k) => (sum(k) + K * pm(`${k}_prior`, 'QB')) / (n + K);
  const l3 = (k) => mean3(series.map(g => g[k]));
  return {
    position: 'QB',
    pyds_prior: prior('pyds'), att_prior: prior('att'), rush_prior: prior('rush'), car_prior: prior('car'),
    pyds_l3: l3('pyds'), rush_l3: l3('rush'), car_l3: l3('car'),
    implied_total: implied, spread_own: spread,
    _games: starts.length,
  };
}

/** Each team-week's leading passer, the definition of a start. */
export function startKeys(passLog) {
  const top = new Map();
  for (const [pid, arr] of passLog) for (const g of arr) {
    const k = `${g.team}|${g.season}|${g.week}`;
    if (!top.has(k) || g.att > top.get(k).att) top.set(k, { pid, att: g.att, season: g.season, week: g.week });
  }
  return new Set([...top.values()].map(t => `${t.pid}|${t.season}|${t.week}`));
}

/** Projected mean yards for a market ('pass' | 'qbrush' | 'rush' | 'rec' | 'rr'). */
export function scoreMu(market, row) {
  const m = M.markets[market];
  let z = m.coef.intercept;
  for (const f of m.features) z += m.coef[f] * ((row[f] - m.scale[f].mean) / m.scale[f].sd);
  return Math.exp(Math.max(-10, Math.min(8, z))) * 10;
}

function bucket(market, mu) {
  const e = M.markets[market].ratio_edges;
  let b = 0; while (b < e.length && mu > e[b]) b++;
  return M.markets[market].ratio_q[b];
}
const interp = (x, xs, ys) => {
  if (x <= xs[0]) return ys[0];
  if (x >= xs[xs.length - 1]) return ys[ys.length - 1];
  let i = 1; while (xs[i] < x) i++;
  return ys[i - 1] + (x - xs[i - 1]) / (xs[i] - xs[i - 1]) * (ys[i] - ys[i - 1]);
};

/** P(yards > line). */
export function pOver(market, line, mu) {
  const q = bucket(market, mu);
  const r = line / Math.max(mu, 1e-6);
  if (r <= q[0]) return 0.995;
  if (r >= q[q.length - 1]) return 0.005;
  return Math.min(0.995, Math.max(0.005, 1 - interp(r, q, QS)));
}

/** A quantile of his yards — 0.5 is the median, the number a book lines. */
export function quantile(market, mu, p = 0.5) {
  return mu * interp(p, QS, bucket(market, mu));
}

// ── Rookies and newcomers (fewer than 3 prior games) ─────────────────────
// No history to project from, so a baseline: the actual spread of catches and
// yards for rookies/newcomers at his position and snap tier (research/thin.py,
// 2017-2025, checked on 2023-25: receptions said 45.7% / hit 45.6%, receiving
// yards 47.5 / 47.0). His tier comes from the depth-chart snap estimate.
const THIN = JSON.parse(fs.readFileSync(new URL('../research/thin_model.json', import.meta.url), 'utf8'));
export const THIN_MIN_SNAP = THIN.tiers[0];
/** Stored quantiles for market 'rec' | 'ryds' | 'rush' | 'rr', or null. */
export function thinQuantiles(market, position, snap) {
  if (!(snap >= THIN.tiers[0])) return null;
  let t = 0; while (t < THIN.tiers.length - 2 && snap >= THIN.tiers[t + 1]) t++;
  return THIN.markets[market]?.[`${position}|${t}`] ?? null;
}
export const thinTier = (snap) => { let t = 0; while (t < THIN.tiers.length - 2 && snap >= THIN.tiers[t + 1]) t++; return t; };
/** P(value > line) from the quantiles: share of them strictly above. */
export const thinOver = (qs, line) => Math.min(0.995, Math.max(0.005, qs.filter(v => v > line).length / qs.length));
export const qMean = (qs) => qs.reduce((a, b) => a + b, 0) / qs.length;
export const qMedian = (qs) => qs[Math.floor(qs.length / 2)];

export const YARDS_MODEL = M;
