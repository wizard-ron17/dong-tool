// NBA board models — applies research/nba_model.json (research/nba_model_export.py).
// Nothing is fitted here. Every input is computed the way research defines it,
// from nba/players.json; research/nba_parity.mjs replays a cached season through
// these same functions and checks them against research's own numbers.
import fs from 'node:fs';

export const MODEL = JSON.parse(fs.readFileSync(new URL('../research/nba_model.json', import.meta.url), 'utf8'));
const POS = MODEL.positions;
export const fam = (pos) => POS[pos] || 'F';
const mean = (a) => a.length ? a.reduce((x, y) => x + y, 0) / a.length : null;
const clip = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
const days = (a, b) => Math.round((Date.parse(b + 'T12:00:00Z') - Date.parse(a + 'T12:00:00Z')) / 864e5);

/** Early season: 1 in his first game, fading by his tenth — his recent windows then reach back past the summer. */
export const earlyOf = (s) => Math.exp(-(s?.gp || 0) / 3);

/**
 * His minutes inputs before tonight, from his state row. `last10` holds played
 * games only (applyGame skips DNPs), oldest first — research's rolling windows
 * over played games, carried across the season break.
 */
export function minutesInputs(s, prev) {
  const L = s.last10 || [];
  const m = (n) => mean(L.slice(-n).map(g => g.min));
  const m10 = m(10);
  return {
    m3: m(3), m5: m(5), m10,
    mseason: s.gp > 0 ? s.min / s.gp : m10,                         // season to date, else last 10
    mprev: prev?.gp > 0 ? prev.min / prev.gp : m10,                  // last season, else last 10
    start10: mean(L.slice(-10).map(g => g.st)),
    lastDate: L.length ? L[L.length - 1].d : null,
    early: earlyOf(s),
  };
}

/**
 * Tonight's projected minutes. ctx: { date, teamLast, absSpread, b2b, vacated, vacPos, starting? }.
 * Rest is days since his TEAM's last game (teamLast), as research defines it.
 * `starting` known (lineups posted) switches to the lineup model.
 */
export function projectMinutes(inp, ctx) {
  const M = MODEL.minutes, useLineup = ctx.starting != null, m = useLineup ? M.lineup : M.pre;
  const st = useLineup ? (ctx.starting ? 1 : 0) : 0;
  const abs = ctx.absSpread ?? M.abs_sp_median;
  const x = {
    m3: inp.m3, m5: inp.m5, m10: inp.m10, mseason: inp.mseason, mprev: inp.mprev, start10: inp.start10,
    vacated: ctx.vacated || 0, vac_pos: ctx.vacPos || 0, abs_sp: abs, b2b: ctx.b2b ? 1 : 0,
    rest: ctx.teamLast ? clip(days(ctx.teamLast, ctx.date), 0, 7) : 7,
    st, st_x_sp: st * abs, vac_x_st: (ctx.vacated || 0) * st, early: inp.early ?? 0,
  };
  let v = m.coef.const;
  for (const c of m.cols) v += m.coef[c] * (x[c] ?? 0);
  return { min: clip(v, 0, 44), sd: m.sd, lineup: useLineup };
}

/** His made threes per minute: season to date + half of last season, shrunk to his position family. */
export function threesRate(s, prev, pos, famRates = MODEL.threes.league.fam_rate) {
  const T = MODEL.threes, fr = famRates[fam(pos)] ?? 0.05;
  const pt = prev?.tpm || 0, pm = prev?.min || 0;
  return (s.tpm + T.prev_weight * pt + T.shrink_min * fr) / (s.min + T.prev_weight * pm + T.shrink_min);
}

/** Opponent's threes allowed per game so far, shrunk 10 games to the league, as a ratio. */
export function oppThreesRatio(team, lgAllowed) {
  const T = MODEL.threes, lg = lgAllowed || T.league.allowed;
  const n = team?.gp || 0, allowed = n ? team.tpm_allowed / n : lg;
  return ((allowed * n + T.opp_shrink_games * lg) / (n + T.opp_shrink_games)) / lg;
}

/**
 * Expected made threes tonight at his projected minutes (research/nba_threes_form2.py):
 * the stats engine's columns for threes — his rate, his last-10 form, the
 * team's implied points, the opponent, home, early season — plus how long since
 * his last made three (log(1 + games), capped, and its square: the player who
 * has stopped shooting them). drought: the state's dr.t1, null = none on record.
 */
export function threesMu({ rate, form = 0, implied, oppRatio, home, mproj, early = 0, drought = null }) {
  const T = MODEL.threes, c = T.coef;
  const impR = implied != null ? implied / T.league.implied : 1;
  const l = Math.log1p(Math.min(drought ?? T.drought_cap, T.drought_cap));
  const z = c.const + c.lrate * Math.log(Math.max(rate, 1e-4)) + c.form * form + c.limp * Math.log(clip(impR, ...T.clip.imp))
          + c.lopp * Math.log(clip(oppRatio, ...T.clip.opp)) + c.home * (home ? 1 : 0) + c.early * early + c.form_x_early * form * early
          + c.ldr * l + c.ldr2 * l * l;
  return Math.exp(z + Math.log(Math.max(mproj, 1)));
}

// ── The ladder: NB (alpha) mixed over his minutes, 9-node Gauss–Hermite ─────
const GH = (() => {                     // probabilists' Hermite nodes/weights, n = 9, normalised
  const x = [-4.512745863399783, -3.205429002856470, -2.076847978677830, -1.023255663789133, 0,
    1.023255663789133, 2.076847978677830, 3.205429002856470, 4.512745863399783];
  const w = [2.234584400774658e-5, 2.789141321231769e-3, 4.991640676521788e-2, 2.440975028949394e-1,
    4.063492063492063e-1, 2.440975028949394e-1, 4.991640676521788e-2, 2.789141321231769e-3, 2.234584400774658e-5];
  return { x, w };
})();
function lgamma(z) {                    // Lanczos
  const g = 7, c = [0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313,
    -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7];
  if (z < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * z)) - lgamma(1 - z);
  z -= 1; let a = c[0]; const t = z + g + 0.5;
  for (let i = 1; i < g + 2; i++) a += c[i] / (z + i);
  return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(a);
}
/** P(X >= k) for NB with mean lam, dispersion alpha (variance lam + alpha lam^2). */
function nbSf(k, lam, alpha) {
  const r = 1 / alpha, p = r / (r + lam);
  let cdf = 0;
  for (let j = 0; j < k; j++) cdf += Math.exp(lgamma(j + r) - lgamma(r) - lgamma(j + 1) + r * Math.log(p) + j * Math.log(1 - p));
  return Math.max(0, 1 - cdf);
}
/** The ladder P(3PM >= k) for each rung, averaged over minutes N(mproj, sd). */
export function threesLadder(mu, mproj, sd) {
  const T = MODEL.threes, out = T.rungs.map(() => 0);
  for (let i = 0; i < GH.x.length; i++) {
    const m = clip(mproj + sd * GH.x[i], 1, 48), lam = mu * m / Math.max(mproj, 1);
    T.rungs.forEach((k, j) => { out[j] += GH.w[i] * nbSf(k, lam, T.alpha); });
  }
  return out;
}

// ── First basket (research/nba_firstbasket2.py) ─────────────────────────────
const lgt = (p) => Math.log(p / (1 - p)), sig = (z) => 1 / (1 + Math.exp(-z));
/** His tip record, shrunk k_tip jumps toward .500. */
export const tipRate = (s) => { const F = MODEL.first; return ((s?.tipw || 0) + F.k_tip * 0.5) / ((s?.tipn || 0) + F.k_tip); };
/** P(home wins the tip): log5 of the two jumpers' shrunk records. */
export function pWinTip(home, away) {
  const a = tipRate(home), b = tipRate(away);
  return a * (1 - b) / (a * (1 - b) + b * (1 - a));
}
/** P(his team scores the first basket): the tip, then the line (his team's implied margin). */
export function pTeamFirst(pWin, margin) {
  const F = MODEL.first, e = F.e;
  const ptTip = pWin * e + (1 - pWin) * (1 - e);
  return sig(F.team.const + F.team.tip * lgt(Math.min(Math.max(ptTip, 1e-4), 1 - 1e-4)) + F.team.line * (margin || 0));
}
/** A starter's weight on his team's first basket: his record, shrunk k_fb starts to his position's. */
export function fbWeight(s, pos) {
  const F = MODEL.first, r = F.pos_rate[fam(pos)] ?? 0.1;
  return ((s?.fb || 0) + F.k_fb * r) / ((s?.starts || 0) + F.k_fb);
}

// ── Counting stats: points, rebounds, assists, PRA, steals, blocks, stocks ──
// research/nba_stats.py. One shape for all: projected minutes x his per-minute
// rate x the game; variance given minutes a x lam^p; mixed over his minutes.
const STAT_PARTS = { tpm: ['tpm'], pts: ['pts'], reb: ['reb'], ast: ['ast'], pra: ['pts', 'reb', 'ast'], stl: ['stl'], blk: ['blk'], stk: ['stl', 'blk'] };
const sumParts = (o, st) => STAT_PARTS[st].reduce((a, k) => a + (o?.[k] || 0), 0);
/** His per-minute rate for a stat: season to date + half of last season, shrunk to his position (last season's). */
export function statRate(st, s, prev, pos) {
  const S = MODEL.stats, fr = S.league.fam_rate[st][fam(pos)] ?? Object.values(S.league.fam_rate[st])[0];
  return (sumParts(s, st) + S.prev_weight * sumParts(prev, st) + S.shrink_min * fr) / ((s?.min || 0) + S.prev_weight * (prev?.min || 0) + S.shrink_min);
}
/** Recent form: his last-10 rate against the longer one, on the log scale (shrunk form_k minutes). */
export function statForm(st, s, rate) {
  const L = (s?.reg10 || []).slice(-10), k = MODEL.stats.form_k;          // regular season only, as research
  const x = L.reduce((a, g) => a + sumParts(g, st), 0), m = L.reduce((a, g) => a + (g.min || 0), 0);
  return Math.log(Math.max((x + k * rate) / (m + k), 1e-3)) - Math.log(Math.max(rate, 1e-3));
}
/** The opponent's allowance of this stat per game so far, shrunk to last season's league mean, as a ratio. */
export function statOpp(st, team) {
  const S = MODEL.stats, lg = sumParts(Object.fromEntries(STAT_PARTS[st].map(k => [k, S.league.allowed[k]])), st) || S.league.allowed[st];
  const n = team?.gp || 0, allowed = n ? STAT_PARTS[st].reduce((a, k) => a + (team[k + '_allowed'] || 0), 0) / n : lg;
  return ((allowed * n + S.opp_shrink_games * lg) / (n + S.opp_shrink_games)) / lg;
}
/** Expected count tonight at his projected minutes. */
export function statMu(st, { rate, form, implied, oppRatio, home, mproj, early = 0 }) {
  const S = MODEL.stats, b = S.models[st].coef;
  const impR = implied != null ? implied / S.league.implied : 1;
  const z = b[0] + b[1] * Math.log(Math.max(rate, 1e-4)) + b[2] * form + b[3] * Math.log(clip(impR, ...S.clip.imp))
          + b[4] * Math.log(clip(oppRatio, ...S.clip.opp)) + b[5] * (home ? 1 : 0) + b[6] * early + b[7] * form * early;
  return Math.exp(z + Math.log(Math.max(mproj, 1)));
}
/** P(X >= k), NB with variance a x lam^p (floored at Poisson). */
function sfPow(k, lam, a, p) {
  const l = Math.max(lam, 0.02), alpha = Math.max((a * Math.pow(l, p) - l) / (l * l), 1e-4);
  return nbSf(k, l, alpha);
}
/** A stat's ladder over its rungs, mixed over minutes N(mproj, sd); g scales the rate (the shared night). */
export function statLadder(st, mu, mproj, sd, g = 1, rungs = MODEL.stats.models[st].rungs) {
  const m = MODEL.stats.models[st], out = rungs.map(() => 0);
  for (let i = 0; i < GH.x.length; i++) {
    const lam = mu * g * clip(mproj + sd * GH.x[i], 1, 48) / Math.max(mproj, 1);
    rungs.forEach((k, j) => { out[j] += GH.w[i] * sfPow(k, lam, m.a, m.p); });
  }
  return out;
}
/**
 * Double / triple-double: pts, reb, ast independent GIVEN minutes and a shared
 * night factor, each at the 10 line; then blended with his own last-40 rate.
 * mus: { pts, reb, ast } at projected minutes; cats40: his digit history.
 */
export function doublesPrice(mus, mproj, sd, cats40) {
  const DD = MODEL.stats.dd, gs = DD.g_nodes, gw = 1 / gs.length;
  let pdd = 0, ptd = 0;
  for (const g of gs) for (let i = 0; i < GH.x.length; i++) {
    const sc = clip(mproj + sd * GH.x[i], 1, 48) / Math.max(mproj, 1);
    const [p1, p2, p3] = ['pts', 'reb', 'ast'].map(st => { const m = MODEL.stats.models[st]; return sfPow(10, mus[st] * sc * g, m.a, m.p); });
    const w = GH.w[i] * gw;
    pdd += w * (p1 * p2 + p1 * p3 + p2 * p3 - 2 * p1 * p2 * p3); ptd += w * p1 * p2 * p3;
  }
  const h = (cats40 || '').slice(-40), n = h.length;
  const rate = (min) => { const hit = [...h].filter(c => +c >= min).length; const base = min === 2 ? DD.base_dd : DD.base_td;
    return ((n ? hit / n : 0) * n + DD.l40_prior * base) / (n + DD.l40_prior); };
  const lg = (p) => { const q = Math.min(Math.max(p, 1e-6), 1 - 1e-6); return Math.log(q / (1 - q)); };
  const blend = (p, own, b) => 1 / (1 + Math.exp(-(b[0] + b[1] * lg(p) + b[2] * lg(own))));
  return { dd: blend(pdd, rate(2), DD.blend_dd), td: blend(ptd, rate(3), DD.blend_td), ddModel: pdd, tdModel: ptd, ddOwn: rate(2), tdOwn: rate(3) };
}
