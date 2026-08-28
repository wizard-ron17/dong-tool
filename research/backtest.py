"""Walk-forward backtest of the stage-1 Picks models.

For each season S, fit on every season before it and predict S cold. Nothing
in-season is ever fit on. Reports a model ladder so each added feature has to
earn its place against the simpler thing:

    M0 base        intercept only (the base rate)
    M1 pos         position only
    M2 +snaps      position + prior snap share
    M3 +total      position + snap share + implied team total
    M4 +rz         M3 + prior red-zone touches      <- the stage-1 model

The bar M4 has to clear is M3, and the bar the whole exercise has to clear is
M2. If a 40-feature model can't beat these, the extra features are decoration.

Logistic regression is IRLS with a small ridge; no sklearn in this env.
"""
import os
import numpy as np
import pandas as pd

DATA = os.path.join(os.path.dirname(__file__), "dataset.parquet")
RIDGE = 1e-4
POS = ["RB", "WR", "TE", "FB"]


def fit_logistic(X, y, ridge=RIDGE, iters=50, tol=1e-9):
    """IRLS / Newton-Raphson. X must already carry an intercept column."""
    n, k = X.shape
    w = np.zeros(k)
    pen = ridge * np.eye(k)
    pen[0, 0] = 0.0                       # never penalise the intercept
    for _ in range(iters):
        z = X @ w
        p = 1.0 / (1.0 + np.exp(-np.clip(z, -30, 30)))
        g = X.T @ (p - y) + pen @ w
        s = np.clip(p * (1 - p), 1e-9, None)
        H = X.T @ (X * s[:, None]) + pen
        try:
            step = np.linalg.solve(H, g)
        except np.linalg.LinAlgError:
            step = np.linalg.lstsq(H, g, rcond=None)[0]
        w -= step
        if np.max(np.abs(step)) < tol:
            break
    return w


def predict(X, w):
    return 1.0 / (1.0 + np.exp(-np.clip(X @ w, -30, 30)))


def log_loss(y, p):
    p = np.clip(p, 1e-12, 1 - 1e-12)
    return -np.mean(y * np.log(p) + (1 - y) * np.log(1 - p))


def auc(y, p):
    """Mann-Whitney U, tie-aware."""
    order = np.argsort(p, kind="mergesort")
    r = np.empty(len(p), dtype=float)
    sp = p[order]
    i = 0
    while i < len(sp):                     # average ranks within ties
        j = i
        while j + 1 < len(sp) and sp[j + 1] == sp[i]:
            j += 1
        r[order[i:j + 1]] = (i + j) / 2.0 + 1.0
        i = j + 1
    n1 = y.sum()
    n0 = len(y) - n1
    if n1 == 0 or n0 == 0:
        return float("nan")
    return (r[y == 1].sum() - n1 * (n1 + 1) / 2.0) / (n1 * n0)


def design(df, feats, mu=None, sd=None):
    """Intercept + position dummies (FB is the reference) + scaled features."""
    parts = [np.ones((len(df), 1))]
    for p in POS[:-1]:
        parts.append((df["position"] == p).values.astype(float)[:, None])
    if feats:
        Z = df[feats].to_numpy(dtype=float)
        if mu is None:
            mu, sd = Z.mean(0), Z.std(0)
            sd = np.where(sd < 1e-9, 1.0, sd)
        parts.append((Z - mu) / sd)
    return np.hstack(parts), mu, sd


MODELS = {
    "M0 base":   None,                    # intercept only, no position
    "M1 pos":    [],
    "M2 +snaps": ["snap_share_prior"],
    "M3 +total": ["snap_share_prior", "implied_total"],
    "M4 +rz":    ["snap_share_prior", "implied_total", "rz_touches_prior"],
}


def run():
    df = pd.read_parquet(DATA).sort_values(["season", "week"])
    seasons = sorted(df["season"].unique())
    rows, preds = [], {k: [] for k in MODELS}

    for S in seasons[1:]:                 # need >=1 prior season to train
        tr = df[df["season"] < S]
        te = df[df["season"] == S]
        y_tr = tr["scored"].to_numpy(float)
        y_te = te["scored"].to_numpy(float)

        for name, feats in MODELS.items():
            if feats is None:
                p = np.full(len(te), y_tr.mean())
            else:
                Xtr, mu, sd = design(tr, feats)
                Xte, _, _ = design(te, feats, mu, sd)
                p = predict(Xte, fit_logistic(Xtr, y_tr))
            rows.append({"season": S, "model": name, "n": len(te),
                         "logloss": log_loss(y_te, p), "auc": auc(y_te, p)})
            preds[name].append(pd.DataFrame(
                {"season": S, "y": y_te, "p": p,
                 "position": te["position"].values,
                 "player": te["player"].values, "week": te["week"].values}))

    res = pd.DataFrame(rows)
    print("=" * 66)
    print("WALK-FORWARD: fit on all prior seasons, predict season cold")
    print("=" * 66)
    piv = res.pivot(index="season", columns="model", values="logloss")
    print("\nLOG LOSS by season (lower is better)")
    print(piv.round(4).to_string())

    print("\nPOOLED out-of-sample (2017-2025)")
    print(f"{'model':<11} {'logloss':>9} {'vs M0':>8} {'AUC':>7}")
    base_ll = None
    for name in MODELS:
        all_p = pd.concat(preds[name])
        ll = log_loss(all_p["y"].to_numpy(float), all_p["p"].to_numpy(float))
        a = auc(all_p["y"].to_numpy(float), all_p["p"].to_numpy(float))
        if base_ll is None:
            base_ll = ll
        print(f"{name:<11} {ll:>9.4f} {(ll-base_ll)/base_ll*100:>7.2f}% {a:>7.4f}")

    # calibration of the stage-1 model
    best = pd.concat(preds["M4 +rz"])
    print("\nCALIBRATION, M4 (pooled OOS, decile bins)")
    best = best.copy()
    best["bin"] = pd.qcut(best["p"], 10, labels=False, duplicates="drop")
    cal = best.groupby("bin").agg(n=("y", "size"), pred=("p", "mean"),
                                  actual=("y", "mean"))
    cal["gap"] = cal["actual"] - cal["pred"]
    print(cal.round(4).to_string())
    ece = (cal["n"] / cal["n"].sum() * cal["gap"].abs()).sum()
    print(f"\nexpected calibration error: {ece:.4f}")

    print("\nTOP-DECILE LIFT, M4")
    top = best[best["bin"] == best["bin"].max()]
    print(f"  top 10% by model: {top['y'].mean():.1%} score rate "
          f"({top['y'].mean()/best['y'].mean():.2f}x base of {best['y'].mean():.1%})")
    bot = best[best["bin"] == 0]
    print(f"  bottom 10%:       {bot['y'].mean():.1%} "
          f"({bot['y'].mean()/best['y'].mean():.2f}x)")

    best.to_parquet(os.path.join(os.path.dirname(__file__), "oos_preds.parquet"),
                    index=False)
    return res


if __name__ == "__main__":
    run()
