"""Calibrating the SOG projection. The walk-forward backtest shows the board
runs hot at the top (projected 4+: 4.84 vs 3.88 actual) and the bottom
(0-1: 0.91 vs 0.76) while the middle is right.

Diagnosis: log link + raw-scale features means mu grows EXPONENTIALLY in each
rate feature. A skater with twice the average shot rate gets far more than
twice the projection. Two fixes are tested against the shipped model:

  LOG   rate features on a log scale, so mu is a power law in the rates
        (mu ~ sog_prior^b) — fixing the shape at the source.
  ISO   an isotonic map from projected to actual shots, fitted on earlier
        seasons' out-of-sample predictions — patching the output, as Picks does.

Both are judged only on seasons where every variant is out of sample
(2024-25 and 2025-26): the isotonic map needs a prior OOS season to fit on.

    python3 research/nhl_sog_cal.py
"""
import os, sys
import numpy as np
import pandas as pd
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
import nhl_sog as m

D = m.D.copy()
LOGF = ["sog_prior", "sog_l5", "sog_l10", "toi_prior", "toi_l5", "pptoi_l5"]
for f in LOGF:
    D["log_" + f] = np.log(D[f].clip(lower=0) + (1.0 if f.startswith("pptoi") else 0.1))
SHIPPED = m.SHIPPED
LOGSET = ["log_" + f if f in LOGF else f for f in SHIPPED]


def iso_fit(x, y, nb=40):
    o = np.argsort(x); x, y = x[o], y[o]
    ed = np.array_split(np.arange(len(x)), nb)
    xs = [x[e].mean() for e in ed]; ys = [y[e].mean() for e in ed]; ws = [len(e) for e in ed]
    i = 0
    while i < len(ys) - 1:
        if ys[i] > ys[i + 1]:
            w = ws[i] + ws[i + 1]
            ys[i] = (ys[i]*ws[i] + ys[i+1]*ws[i+1]) / w; xs[i] = (xs[i]*ws[i] + xs[i+1]*ws[i+1]) / w
            ws[i] = w; del ys[i+1], xs[i+1], ws[i+1]; i = max(i - 1, 0)
        else: i += 1
    return np.array(xs), np.array(ys)


def iso_apply(kx, ky, x):
    """Monotone map; proportional past both end knots so the ranking never ties."""
    out = np.interp(x, kx, ky)
    hi = x > kx[-1]; lo = x < kx[0]
    out[hi] = x[hi] * (ky[-1] / kx[-1]); out[lo] = x[lo] * (ky[0] / kx[0])
    return out


def run(feats, iso=False):
    seasons = sorted(D.season.unique())
    oos = {}                                  # season -> (mu, y, alpha)
    for s in seasons[1:]:
        tr, te = D[D.season < s], D[D.season == s]
        ref = {f: (tr[f].mean(), tr[f].std() or 1.0) for f in feats}
        b = m.poisson_irls(m.design(tr, feats, ref), tr.sog.to_numpy(float))
        mu_tr = np.exp(np.clip(m.design(tr, feats, ref) @ b, -6, 6))
        mu = np.exp(np.clip(m.design(te, feats, ref) @ b, -6, 6))
        y = te.sog.to_numpy(float)
        if iso:
            prev = [k for k in oos if k < s]
            if prev:
                kx, ky = iso_fit(np.concatenate([oos[k][3] for k in prev]), np.concatenate([oos[k][1] for k in prev]))
                raw = mu.copy(); mu = iso_apply(kx, ky, mu)
                mu_tr = iso_apply(kx, ky, mu_tr)
            else:
                raw = mu.copy()
        else:
            raw = mu.copy()
        alpha = m.nb_dispersion(tr.sog.to_numpy(float), mu_tr)
        oos[s] = (mu, y, alpha, raw)
    return oos


def score(oos, seasons):
    mu = np.concatenate([oos[s][0] for s in seasons]); y = np.concatenate([oos[s][1] for s in seasons])
    ll = []
    for s in seasons:
        mu_s, y_s, a, _ = oos[s]
        for L in m.LINES:
            p = m.nb_sf(L, mu_s, a); h = (y_s > L).astype(float)
            ll.append((float(-(h*np.log(p) + (1-h)*np.log(1-p)).sum()), len(y_s)))
    ll = sum(a for a, _ in ll) / sum(n for _, n in ll)
    rows = []
    for lo, hi in [(0, 1), (1, 2), (2, 3), (3, 4), (4, 99)]:
        k = (mu >= lo) & (mu < hi)
        if k.sum(): rows.append((f"{lo}-{hi if hi<99 else '+'}", int(k.sum()), mu[k].mean(), y[k].mean()))
    # the quoted line (closest to even) calibration at the extremes
    return ll, float(np.abs(y - mu).mean()), rows


if __name__ == "__main__":
    evalS = sorted(D.season.unique())[2:]        # 2024-25, 2025-26: OOS for all variants
    print(f"judged on {[int(s) for s in evalS]} — {int(D.season.isin(evalS).sum()):,} skater-games\n")
    variants = [("SHIPPED  (raw scale)", SHIPPED, False), ("LOG      (rates on log scale)", LOGSET, False),
                ("ISO      (shipped + isotonic)", SHIPPED, True), ("LOG+ISO", LOGSET, True)]
    res = {}
    for name, f, iso in variants:
        o = run(f, iso); ll, mae, rows = score(o, evalS); res[name] = (ll, mae, rows)
        print(f"{name:32s} ladder log loss {ll:.5f}   MAE {mae:.4f}")
        for lab, n, pm, am in rows:
            print(f"      proj {lab:>4s}  n {n:>6,}   projected {pm:5.2f}   actual {am:5.2f}   ({(pm/am-1)*100:+5.1f}%)")
