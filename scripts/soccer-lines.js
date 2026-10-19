// Ron's Goal Tool: a soccer line's three-way moneyline and total, devigged,
// and the goals each side is expected to score. Shared by the build (off the
// scoreboard's DraftKings line) and the research replay (off each final's
// summary, research/soccer_fetch.mjs), so both read the market the same way.
const num = (v) => { const x = parseFloat(v); return Number.isFinite(x) ? x : null; };

export const am2p = (o) => { const x = num(o); return x == null ? null : x > 0 ? 100 / (x + 100) : -x / (-x + 100); };
/** Power devig: the k that makes the prices' p^k sum to one (research/devig_study.py: power is best or tied). */
export function devig(ps) {
  if (ps.some(p => p == null)) return null;
  let lo = 0.5, hi = 2;
  for (let i = 0; i < 60; i++) { const k = (lo + hi) / 2, s = ps.reduce((a, p) => a + p ** k, 0); if (s > 1) lo = k; else hi = k; }
  const k = (lo + hi) / 2; return ps.map(p => p ** k);
}
const pois = (l, K = 12) => { const o = [Math.exp(-l)]; for (let i = 1; i <= K; i++) o.push(o[i - 1] * l / i); return o; };
/** The goal model's outcome probabilities for (home, away) means: win/draw/win and the over at line L (pushes dropped, quarter lines split). */
export function outcome(lh, la, L) {
  const H = pois(lh), A = pois(la); let ph = 0, pd = 0, pa = 0; const tot = new Array(26).fill(0);
  for (let i = 0; i < H.length; i++) for (let j = 0; j < A.length; j++) { const p = H[i] * A[j]; if (i > j) ph += p; else if (i === j) pd += p; else pa += p; tot[i + j] += p; }
  const over = (x) => { let o = 0, u = 0; for (let t = 0; t < tot.length; t++) { if (t > x) o += tot[t]; else if (t < x) u += tot[t]; } return o / (o + u); };
  const q = L * 4 % 2 === 1 ? (over(L - 0.25) + over(L + 0.25)) / 2 : over(L);
  return { ph, pd, pa, over: q };
}
/** The (home, away) goal means that best reproduce the devigged 1X2 and total: a coarse grid, then a fine one. */
export function impliedGoals(P, L, pOver) {
  const err = (lh, la) => { const o = outcome(lh, la, L); return (o.ph - P[0]) ** 2 + (o.pd - P[1]) ** 2 + (o.pa - P[2]) ** 2 + (pOver == null ? 0 : (o.over - pOver) ** 2); };
  let best = [1.4, 1.1], be = Infinity;
  for (let lh = 0.2; lh <= 4; lh += 0.05) for (let la = 0.2; la <= 4; la += 0.05) { const e = err(lh, la); if (e < be) { be = e; best = [lh, la]; } }
  const [h0, a0] = best;
  for (let lh = h0 - 0.05; lh <= h0 + 0.05; lh += 0.005) for (let la = a0 - 0.05; la <= a0 + 0.05; la += 0.005) { const e = err(lh, la); if (e < be) { be = e; best = [lh, la]; } }
  return best.map(x => +x.toFixed(2));
}

/** A summary's pre-game line (pickcenter first, then odds; live and fractional rows skipped) -> { book, mlHome, mlDraw, mlAway, total, over, under }. */
export function summaryLine(s) {
  for (const o of [...(s.pickcenter || []), ...(s.odds || [])]) {
    const book = o.provider?.name || '';
    if (/live/i.test(book)) continue;
    const L = { book, mlHome: num(o.homeTeamOdds?.moneyLine), mlAway: num(o.awayTeamOdds?.moneyLine), mlDraw: num(o.drawOdds?.moneyLine),
      total: num(o.overUnder), over: num(o.overOdds), under: num(o.underOdds) };
    if (L.mlHome != null && L.mlAway != null && L.mlDraw != null && L.total != null) return L;
  }
  return null;
}
/** The devigged 1X2 and the (home, away) goal means a line implies; null without a full 1X2 and total. */
export function lineGoals(L) {
  if (!L) return null;
  const P = devig([am2p(L.mlHome), am2p(L.mlDraw), am2p(L.mlAway)]); if (!P || L.total == null) return null;
  const T = L.over != null && L.under != null ? devig([am2p(L.over), am2p(L.under)]) : null;
  const [impHome, impAway] = impliedGoals(P, L.total, T ? T[0] : null);
  return { pHome: P[0], pDraw: P[1], pAway: P[2], impHome, impAway };
}
