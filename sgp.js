// Same-game parlay pricing — one engine for every app (mlb, nfl, nhl).
//
// A parlay's true price is P(every leg hits). Multiplying legs assumes they're
// independent; same-game legs aren't (one pitcher, one park, one game script,
// one pie of plate appearances / targets / shots). Books price that with a
// Gaussian copula and so does this: each leg keeps its own probability p, is
// the event Z < Φ⁻¹(p) for a standard-normal latent Z, and the legs' Zs are
// tied by a correlation matrix R measured per pair type in research
// (research/sgp_core.py and sgp_<sport>.py — every ρ there is fit on real
// games with each leg's own model probability as its margin).
//
// The joint probability is the multivariate normal orthant probability,
// computed with Genz's sequential conditioning on a fixed lattice — exact per
// dimension, so it stays accurate for longshot parlays (four +900 legs is a
// 1-in-10,000 event, far below what naive simulation can resolve) and the same
// slip always prices the same.
(function (root) {
  // Φ via erfc (Numerical Recipes rational approximation, |err| < 1.2e-7)
  function erfc(x) {
    const z = Math.abs(x), t = 1 / (1 + 0.5 * z);
    const r = t * Math.exp(-z * z - 1.26551223 + t * (1.00002368 + t * (0.37409196 + t * (0.09678418 + t * (-0.18628806 +
      t * (0.27886807 + t * (-1.13520398 + t * (1.48851587 + t * (-0.82215223 + t * 0.17087277)))))))));
    return x >= 0 ? r : 2 - r;
  }
  const Phi = (x) => 0.5 * erfc(-x / Math.SQRT2);
  // Φ⁻¹ (Acklam), refined with one Halley step
  function PhiInv(p) {
    if (p <= 0) return -Infinity; if (p >= 1) return Infinity;
    const a = [-39.69683028665376, 220.9460984245205, -275.9285104469687, 138.357751867269, -30.66479806614716, 2.506628277459239];
    const b = [-54.47609879822406, 161.5858368580409, -155.6989798598866, 66.80131188771972, -13.28068155288572];
    const c = [-0.007784894002430293, -0.3223964580411365, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
    const d = [0.007784695709041462, 0.3224671290700398, 2.445134137142996, 3.754408661907416];
    const pl = 0.02425; let q, r, x;
    if (p < pl) { q = Math.sqrt(-2 * Math.log(p)); x = (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1); }
    else if (p <= 1 - pl) { q = p - 0.5; r = q * q; x = (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1); }
    else { q = Math.sqrt(-2 * Math.log(1 - p)); x = -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1); }
    const e = Phi(x) - p, u = e * Math.sqrt(2 * Math.PI) * Math.exp(x * x / 2);
    return x - u / (1 + x * u / 2);
  }
  /** Cholesky of a correlation matrix; if it isn't positive definite (pairwise
   *  ρs measured separately needn't be jointly consistent), shrink it toward
   *  the identity until it is — the smallest honest correction. */
  function chol(R) {
    const n = R.length;
    for (let shrink = 0; shrink <= 1.0001; shrink += 0.05) {
      const L = Array.from({ length: n }, () => new Array(n).fill(0)); let ok = true;
      for (let i = 0; i < n && ok; i++) for (let j = 0; j <= i; j++) {
        let s = (i === j ? 1 : R[i][j] * (1 - shrink));
        for (let k = 0; k < j; k++) s -= L[i][k] * L[j][k];
        if (i === j) { if (s <= 1e-9) { ok = false; break; } L[i][i] = Math.sqrt(s); }
        else L[i][j] = s / L[j][j];
      }
      if (ok) return { L, shrink };
    }
    return { L: R.map((r, i) => r.map((_, j) => (i === j ? 1 : 0))), shrink: 1 };
  }
  const PRIMES = [2, 3, 5, 7, 11, 13, 17, 19, 23, 29, 31, 37, 41, 43, 47, 53, 59, 61, 67, 71];
  /** P(Z_i < Φ⁻¹(p_i) for all i), Z ~ N(0, R). Genz SOV over a randomised
   *  Richtmyer lattice, averaged over fixed shifts for a stable estimate. */
  function joint(ps, R, N = 4096) {
    const n = ps.length;
    if (!n) return 1;
    if (n === 1) return ps[0];
    const b = ps.map((p) => PhiInv(Math.min(1 - 1e-12, Math.max(1e-12, p))));
    const { L } = chol(R);
    const alpha = PRIMES.slice(0, n).map((q) => Math.sqrt(q) % 1);
    const shifts = [0.1234567, 0.6180339, 0.3819660, 0.8660254];
    let total = 0;
    const y = new Array(n);
    for (const sh of shifts) {
      let acc = 0;
      for (let k = 1; k <= N; k++) {
        let f = 1;
        for (let i = 0; i < n; i++) {
          let s = 0; for (let j = 0; j < i; j++) s += L[i][j] * y[j];
          const e = Phi((b[i] - s) / L[i][i]);
          f *= e; if (f === 0) break;
          if (i < n - 1) {
            let w = (k * alpha[i] + sh * (i + 1)) % 1; w = Math.abs(2 * w - 1);   // baker's transform
            y[i] = PhiInv(Math.min(1 - 1e-12, Math.max(1e-12, w * e)));
          }
        }
        acc += f;
      }
      total += acc / N;
    }
    return total / shifts.length;
  }
  /** Price a slip. legs: [{p, ...}]; rho(a, b) -> the measured ρ for that pair
   *  of legs (0 when independent / unmeasured). Returns the correlated fair
   *  probability, the straight product, and which pairs moved it. */
  function price(legs, rho) {
    const n = legs.length, R = Array.from({ length: n }, (_, i) => new Array(n).fill(0).map((_, j) => (i === j ? 1 : 0)));
    const pairs = [];
    for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
      const r = rho(legs[i], legs[j]) || 0;
      R[i][j] = R[j][i] = r;
      if (r) pairs.push({ a: i, b: j, rho: r });
    }
    const naive = legs.reduce((a, l) => a * l.p, 1);
    const p = pairs.length ? joint(legs.map((l) => l.p), R) : naive;
    return { p, naive, pairs, lift: p / naive };
  }
  root.SGP = { joint, price, Phi, PhiInv, chol };
})(typeof window !== 'undefined' ? window : globalThis);
