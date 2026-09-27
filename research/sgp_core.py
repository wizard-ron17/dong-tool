"""Same-game parlay correlations — the shared machinery (research).

A parlay's true price is P(every leg hits). Multiplying the legs assumes they
don't move together; same-game legs do (one pitcher, one park, one game
script, one pie of plate appearances / targets / shots to split). Books price
this with a Gaussian copula, and so do we:

  * each leg keeps its own probability p (from our model, as the site shows it)
  * it's the event Z < Φ⁻¹(p) for a standard-normal latent Z
  * legs are tied together by a correlation ρ between their Zs

What makes it honest is how ρ is measured: per PAIR TYPE (teammates' HRs, a
pitcher's Ks and his walks, a batter's HR and the opposing starter's Ks…), by
maximum likelihood over real games, with each leg's own model probability as
its margin. So ρ is only what's LEFT after everything each leg's price already
knows — a Coors game where both legs are likely is not "correlation", it's two
high probabilities. ρ > 0: they rise together (shared game). ρ < 0: one eats
the other's share (the pie), or they're opposite sides of one duel.

Shared by research/sgp_mlb.py, sgp_nfl.py, sgp_nhl.py; the page runs the same
copula over the exported table (sgp.js).
"""
import numpy as np
from scipy.special import owens_t, ndtr, ndtri


def bvn(h, k, r):
    """P(X < h, Y < k) for standard bivariate normal with correlation r.
    Vectorised via Owen's T: Φ2 = ½[Φ(h)+Φ(k)] − T(h, a_h) − T(k, a_k) − c."""
    h, k, r = np.broadcast_arrays(np.asarray(h, float), np.asarray(k, float), np.asarray(r, float))
    s = np.sqrt(np.maximum(1 - r * r, 1e-12))
    with np.errstate(divide="ignore", invalid="ignore"):
        ah = np.where(h != 0, (k - r * h) / (h * s), np.sign(k - r * h) * 1e12)
        ak = np.where(k != 0, (h - r * k) / (k * s), np.sign(h - r * k) * 1e12)
    c = np.where((h * k < 0) | ((h * k == 0) & (h + k < 0)), 0.5, 0.0)
    return 0.5 * (ndtr(h) + ndtr(k)) - owens_t(h, ah) - owens_t(k, ak) - c


def pair_loglik(p1, p2, y1, y2, rho):
    """Log likelihood of paired binary outcomes under the copula."""
    a, b = ndtri(np.clip(p1, 1e-6, 1 - 1e-6)), ndtri(np.clip(p2, 1e-6, 1 - 1e-6))
    p11 = np.clip(bvn(a, b, rho), 1e-12, 1)
    p10 = np.clip(p1 - p11, 1e-12, 1); p01 = np.clip(p2 - p11, 1e-12, 1)
    p00 = np.clip(1 - p1 - p2 + p11, 1e-12, 1)
    return np.where(y1 & y2, np.log(p11), np.where(y1, np.log(p10), np.where(y2, np.log(p01), np.log(p00)))).sum()


def fit_rho(p1, p2, y1, y2, groups=None, boot=60, seed=0):
    """MLE of ρ (bounded scalar search); 95% CI by bootstrapping GAMES
    (pairs from one game aren't independent). Returns dict with the lift at
    the average margins so it reads in betting terms."""
    p1, p2 = np.asarray(p1, float), np.asarray(p2, float)
    y1, y2 = np.asarray(y1, bool), np.asarray(y2, bool)

    from scipy.optimize import minimize_scalar

    def mle(ix):
        f = lambda g: -pair_loglik(p1[ix], p2[ix], y1[ix], y2[ix], g)
        return minimize_scalar(f, bounds=(-0.95, 0.95), method="bounded", options={"xatol": 1e-4}).x

    all_ix = np.arange(len(p1))
    rho = mle(all_ix)
    lo = hi = None
    if boot and groups is not None:
        rng = np.random.default_rng(seed)
        groups = np.asarray(groups)
        uniq, inv = np.unique(groups, return_inverse=True)
        order = np.argsort(inv, kind="stable"); cuts = np.searchsorted(inv[order], np.arange(len(uniq) + 1))
        by = [order[cuts[i]:cuts[i + 1]] for i in range(len(uniq))]
        bs = []
        for _ in range(boot):
            pick = rng.integers(0, len(uniq), len(uniq))
            bs.append(mle(np.concatenate([by[i] for i in pick])))
        lo, hi = np.percentile(bs, [2.5, 97.5])
    m1, m2 = p1.mean(), p2.mean()
    joint = float(bvn(ndtri(m1), ndtri(m2), rho))
    return {"rho": round(float(rho), 3), "lo": None if lo is None else round(float(lo), 3), "hi": None if hi is None else round(float(hi), 3),
            "n": int(len(p1)), "both": int((y1 & y2).sum()), "p1": round(float(m1), 4), "p2": round(float(m2), 4),
            "obs_both": round(float((y1 & y2).mean()), 5), "indep_both": round(float((p1 * p2).mean()), 5),
            "lift_at_avg": round(joint / (m1 * m2), 3)}


if __name__ == "__main__":
    # the Owen's T bivariate normal against scipy's
    from scipy.stats import multivariate_normal
    rng = np.random.default_rng(1)
    worst = 0
    for _ in range(300):
        h, k, r = rng.normal(0, 1.5), rng.normal(0, 1.5), rng.uniform(-0.9, 0.9)
        ref = multivariate_normal([0, 0], [[1, r], [r, 1]]).cdf([h, k])
        worst = max(worst, abs(float(bvn(h, k, r)) - ref))
    print(f"bvn vs scipy, max abs error over 300 draws: {worst:.2e}")
