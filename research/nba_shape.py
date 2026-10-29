"""Points and PRA ladder shape: a calibration on top of the counting-stat ladders (research, 2026-10-29).

    python3 research/nba_shape.py        # walk-forward test, then writes stats.shape_cal into research/nba_model.json

nba_stats.py's mean is right in every band (actual vs projected within 0.3 points), but its points
curve is the wrong SHAPE, priced at the lines books hang (floor(mu) + 0.5 + d, d = -4..4):
  bench (mu < 5)      overs 5-17pp too high: more zeros and near-zeros than the NB allows
  mid (mu 9-17)       overs at the line ~3pp too low: games bunch nearer the mean than its skew says
  stars (mu 22+)      low lines' overs ~3pp too low: they bust less often than priced
PRA the same; rebounds ~1pp, assists / steals / blocks within 1pp (left alone).

Wider variance (a x c) doesn't fix it (the misses are lopsided), and minutes are near-normal (mild left
skew for starters only). What fixes it: P(X >= k) mapped on the logit scale, by log mu,
  logit p' = c0 + c1 z + c2 m + c3 z m + c4 m^2 + c5 z m^2      (z = logit p, m = log mu clipped to the fit range)
fit on earlier seasons' out-of-sample ladders, scored on the next. 2021-22 is left out: its ladders were
fit on 2020-21 alone (the bubble season) and miss +3.3pp across the board, which skews every fit after it.
Walk-forward log loss: points -0.51% (-0.57 / -0.50 / -0.46 by season), PRA -0.42%; rebounds -0.04%,
the rest ~0 (not shipped). An empirical x/mu curve per mu band did as well on points (-0.49%) but worse
on rebounds and assists, and can't ride the minutes mixture the page and odds-viewer share.

Against this season's SmartStake closes (10/21-10/27, 17.5k lines, odds-viewer's own pricing): points
log loss .6267 -> .6216, PRA .6765 -> .6705 (main lines .5933 -> .5893, .6450 -> .6404); our gap from the
close keeps its signal beside it (z 4.6 either way). The double-double stays on the raw curve (it beats
the close as is).
"""
import json, os, sys
import numpy as np
import pandas as pd
import nba_stats as S

HERE = os.path.dirname(os.path.abspath(__file__))
MODEL = os.path.join(HERE, "nba_model.json")
SHIP, SKIP = ("pts", "pra"), "2021-22"
lg = lambda p: np.log(np.clip(p, 1e-5, 1 - 1e-5) / (1 - np.clip(p, 1e-5, 1 - 1e-5)))


def X(z, m): return np.column_stack([np.ones(len(z)), z, m, z * m, m * m, z * m * m])


def fit(Xm, y):
    b = np.zeros(Xm.shape[1]); b[1] = 1
    for _ in range(50):
        q = 1 / (1 + np.exp(-Xm @ b)); W = q * (1 - q)
        b += np.linalg.solve(Xm.T @ (Xm * W[:, None]) + 1e-6 * np.eye(len(b)), Xm.T @ (y - q))
    return b


def main():
    D, _, _ = S.build()
    ss = sorted(D.season.unique()); ss = [ss[0]] + ss
    SD = json.load(open(MODEL))["minutes"]["lineup"]["sd"]
    x, w = S.NODES; w = w / w.sum(); rows = []
    for s in ss[2:]:
        tr, te = D[D.season < s], D[D.season == s]
        for st in S.STATS:
            b, a, pw = S.fit_stat(tr, st); mu = np.exp(S.X_of(te, st) @ b + te.off.values)
            for d in range(-4, 5):
                k = np.maximum(np.floor(mu) + 1 + d, 1); p = np.zeros(len(te))
                for xi, wi in zip(x, w):
                    p += wi * S.sf_pow(k, mu * np.clip(te.mproj.values + SD * xi, 1, 48) / np.clip(te.mproj.values, 1, None), a, pw)
                rows.append(pd.DataFrame({"season": s, "stat": st, "d": d, "mu": mu, "k": k, "p": p, "y": (te[st].values >= k).astype(float)}))
    R = pd.concat(rows, ignore_index=True)
    R = R[R.season != SKIP].drop_duplicates(["season", "stat", "mu", "k"])
    out = {}
    print(f"{'stat':4s}  walk-forward log loss, raw -> calibrated (by season)")
    for st in S.STATS:
        G = R[R.stat == st]; n = l0 = l1 = 0; per = []
        for s in sorted(G.season.unique())[1:]:
            tr, te = G[G.season < s], G[G.season == s]
            b = fit(X(lg(tr.p.values), np.log(tr.mu.values)), tr.y.values)
            q = 1 / (1 + np.exp(-X(lg(te.p.values), np.log(te.mu.values)) @ b))
            a0, a1 = S.ll(te.p.values, te.y.values), S.ll(q, te.y.values)
            n += len(te); l0 += len(te) * a0; l1 += len(te) * a1; per.append(f"{s}: {(a1 / a0 - 1) * 100:+.2f}%")
        print(f"{st:4s}  {l0 / n:.5f} -> {l1 / n:.5f} ({(l1 / l0 - 1) * 100:+.2f}%)   " + "  ".join(per))
        if st in SHIP:
            m = np.log(G.mu.values); lo, hi = float(np.quantile(m, .001)), float(np.quantile(m, .999))
            b = fit(X(lg(G.p.values), np.clip(m, lo, hi)), G.y.values)
            mm = np.linspace(lo, hi, 50); assert (b[1] + b[3] * mm + b[5] * mm * mm).min() > 0, "not monotone"
            out[st] = {"c": [round(float(v), 5) for v in b], "m": [round(lo, 4), round(hi, 4)]}
    M = json.load(open(MODEL))
    M["stats"]["shape_cal"] = {**out, "note": "research/nba_shape.py: P(X >= k) on the logit scale, z = logit p, m = log mu clipped to m: "
                               "logit p' = c0 + c1 z + c2 m + c3 z m + c4 m^2 + c5 z m^2. Points and PRA only; the double-double uses the raw curve."}
    json.dump(M, open(MODEL, "w"), indent=1)
    print("\nwrote stats.shape_cal:", out)


if __name__ == "__main__":
    main()
