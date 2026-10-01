"""Receptions: one dispersion for everyone, or a spread that scales with volume? (research)

    python3 research/receptions_disp.py            # walk-forward test
    python3 research/receptions_disp.py export     # + write var_pow into receptions_model.json

The board prices receptions off a negative binomial with ONE alpha (Var = mu +
alpha mu^2) for every player. The model audit found the top of the board priced
~7% cold at o3.5 (67% priced, 72% hit) while its mean was right: the spread is
too wide for high-volume receivers. Measured, the dispersion falls steeply with
volume (a 1-catch projection is far noisier, relative to its mean, than an
8-catch one: role uncertainty on the fringe, a steady target share at the top).

Tested here, walk-forward by season, with the mean calibration curve fitted
only on the earlier seasons in each fold, then its top knot extended by its
last slope instead of flattened:
  fixed      one alpha, method of moments on the training seasons (as shipped)
  var_pow    Var = c * mu^p (the NBA stats engine's shape), fit on the training
             seasons; NB alpha(mu) = (c mu^p - mu) / mu^2, floored
Scored on log loss at o2.5..o6.5 and the top tenth of each line.
"""
import json, os, sys
import numpy as np
import pandas as pd

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
_ARGV = list(sys.argv); sys.argv = sys.argv[:1]
import receptions as R
from receptions import nb_sf

LINES = [2.5, 3.5, 4.5, 5.5, 6.5]
A_FLOOR = 0.005


def pairs():
    """Walk-forward (season, raw mu, actual) — receptions.oos_mu_pairs with the season kept."""
    d = R.D.copy()
    d["wind"] = d.wind.fillna(0.0)
    d["wind_excess"] = np.where(d.indoor == 1, 0.0, np.maximum(d.wind - R.WIND_THRESHOLD, 0.0))
    d = d[d.games_prior >= 3].dropna(subset=R.BASE).copy()
    out = []
    for s in sorted(d.season.unique()):
        if s < 2019: continue
        tr = d[d.season < s]; te = d[d.season == s]
        if len(tr) < 5000 or len(te) < 500: continue
        ref = {f: (tr[f].to_numpy(float).mean(), tr[f].to_numpy(float).std() + 1e-9) for f in R.BASE}
        b = R.poisson_irls(R.design(tr, R.BASE, ref), tr.rec.to_numpy(float))
        out.append(pd.DataFrame({"season": s, "mu": np.exp(np.clip(R.design(te, R.BASE, ref) @ b, -8, 4)), "y": te.rec.to_numpy(float)}))
    return pd.concat(out, ignore_index=True)


def cal(mu, M):
    """Apply the exported mean map as the current board does."""
    x, y = np.array(M["mu_cal"]["x"]), np.array(M["mu_cal"]["y"])
    return apply_mu_map(mu, x, y, extend=bool(M.get("mu_cal_extend")))


def fit_mu_map(raw, actual):
    """Fit the shipped equal-count, monotone 40-knot map on training folds only."""
    order = np.argsort(raw)
    raw, actual = raw[order], actual[order]
    edges = np.linspace(0, len(raw), 41).astype(int)
    x = np.array([raw[a:b].mean() for a, b in zip(edges[:-1], edges[1:]) if b > a])
    y = np.array([actual[a:b].mean() for a, b in zip(edges[:-1], edges[1:]) if b > a])
    return x, np.maximum.accumulate(y)


def apply_mu_map(raw, x, y, extend=False):
    base = np.where(raw <= x[0], y[0] * raw / x[0], np.interp(raw, x, y))
    if not extend:
        return base
    slope = (y[-1] - y[-3]) / (x[-1] - x[-3])
    return np.where(raw > x[-1], y[-1] + slope * (raw - x[-1]), base)


def fit_pow(m, y):
    """Var = c m^p from binned squared residuals (log-log fit)."""
    q = pd.qcut(pd.Series(m).rank(method="first"), 20, labels=False)
    t = pd.DataFrame({"m": m, "v": (y - m) ** 2, "q": q}).groupby("q").mean()
    p, lc = np.polyfit(np.log(t.m), np.log(t.v), 1)
    return float(np.exp(lc)), float(p)


def alpha_of(m, c, p): return np.maximum(A_FLOOR, (c * np.power(m, p) - m) / m ** 2)


def ll(p, y): p = np.clip(p, 1e-9, 1 - 1e-9); return float(-(y * np.log(p) + (1 - y) * np.log(1 - p)).mean())


def walkforward():
    M = json.load(open(os.path.join(HERE, "receptions_model.json")))
    P = pairs(); P["m"] = cal(P.mu.to_numpy(), M)
    seasons = sorted(P.season.unique())
    rows = {L: {"fixed": [], "pow": [], "y": []} for L in LINES}
    for s in seasons[1:]:
        tr, te = P[P.season < s], P[P.season == s]
        x, y = fit_mu_map(tr.mu.to_numpy(), tr.y.to_numpy())
        train_m = apply_mu_map(tr.mu.to_numpy(), x, y, extend=True)
        test_m = apply_mu_map(te.mu.to_numpy(), x, y, extend=True)
        a_fix = max(A_FLOOR, float(((tr.y.to_numpy() - train_m) ** 2 - train_m).sum() / (train_m ** 2).sum()))
        c, pw = fit_pow(train_m, tr.y.to_numpy())
        for L in LINES:
            rows[L]["fixed"].append(nb_sf(L, test_m, a_fix))
            rows[L]["pow"].append(nb_sf(L, test_m, alpha_of(test_m, c, pw)))
            rows[L]["y"].append((te.y > L).to_numpy(float))
    return M, P, seasons, rows


def main(export=False):
    M, P, seasons, rows = walkforward()
    print(f"{len(P):,} player-games, walk-forward {seasons[1]}..{seasons[-1]}\n")
    print(f"{'line':5s} {'ll fixed':>9s} {'ll var_pow':>10s} | top 10%: {'fixed':>6s} {'var_pow':>7s} {'hit':>6s}")
    better = 0
    for L in LINES:
        f, pv, y = (np.concatenate(rows[L][k]) for k in ("fixed", "pow", "y"))
        k = np.argsort(-f)[: len(f) // 10]; k2 = np.argsort(-pv)[: len(pv) // 10]
        print(f"o{L:<4} {ll(f, y):9.5f} {ll(pv, y):10.5f} | {f[k].mean() * 100:14.1f}% {pv[k2].mean() * 100:6.1f}% {y[k].mean() * 100:5.1f}%")
        better += ll(pv, y) < ll(f, y)
    c, pw = fit_pow(P.m.to_numpy(), P.y.to_numpy())
    print(f"\nvar_pow on every season: Var = {c:.3f} x mu^{pw:.3f}  (beat the fixed alpha at {better}/{len(LINES)} lines)")
    if export and better == len(LINES):
        M["var_pow"] = {"c": round(c, 5), "p": round(pw, 5), "floor": A_FLOOR,
                        "note": "research/receptions_disp.py: NB alpha(mu) = max(floor, (c mu^p - mu)/mu^2); beats the single alpha at every line walk-forward"}
        M["mu_cal_extend"] = True
        json.dump(M, open(os.path.join(HERE, "receptions_model.json"), "w"), indent=1)
        print("exported var_pow + mu_cal_extend -> receptions_model.json")


if __name__ == "__main__":
    main(export="export" in _ARGV[1:])
