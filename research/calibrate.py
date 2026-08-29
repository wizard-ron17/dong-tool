"""Fit a monotone recalibration for the top end of the board.

The model is well calibrated across the bulk but systematically over-confident
where it matters most — the favourites. Walk-forward, out of sample:

    predicted 60-70%  ->  actually 55.0%   (-9.5)
    predicted 70-80%  ->  actually 58.6%  (-15.5)
    predicted   80%+  ->  actually 60.9%  (-21.6)

A logistic extrapolates linearly in log-odds, but scoring saturates: no amount
of usage makes a touchdown a near-certainty. Platt scaling cannot fix this — a
two-parameter map is dominated by the ~99% of rows that are already right and
comes back as the identity (slope 1.026). Isotonic regression can, because it
is free to flatten one region without touching the rest.

Fitted here on WALK-FORWARD out-of-sample predictions, since the miscalibration
is an out-of-sample phenomenon: a logistic is calibrated by construction on the
data it was fitted to, so fitting the calibrator in-sample learns nothing.

Exports research/calibration.json — a compact step function the Node build
applies after scoring.
"""
import json
import os
import sys

import numpy as np
import pandas as pd

sys.path.insert(0, os.path.dirname(__file__))
from backtest import MODELS, FINAL, design, fit_logistic, predict, log_loss, auc  # noqa: E402

OUT = os.path.join(os.path.dirname(__file__), "calibration.json")
KNOTS = 40          # breakpoints exported; plenty for a smooth monotone map


def isotonic(x, y, w=None):
    """Pool-adjacent-violators. Returns (x_sorted, fitted_y) — monotone in x."""
    o = np.argsort(x, kind="mergesort")
    x, y = np.asarray(x, float)[o], np.asarray(y, float)[o]
    w = np.ones_like(y) if w is None else np.asarray(w, float)[o]
    # each block: (sum_wy, sum_w, end_index)
    vals, wts = [], []
    for i in range(len(y)):
        vals.append(y[i] * w[i]); wts.append(w[i])
        while len(vals) > 1 and vals[-2] / wts[-2] > vals[-1] / wts[-1]:
            v, ww = vals.pop(), wts.pop()
            vals[-1] += v; wts[-1] += ww
    out, k = np.empty(len(y)), 0
    # rebuild block means back onto the points
    blocks = []
    i = 0
    vals2, wts2 = [], []
    for j in range(len(y)):
        vals2.append(y[j] * w[j]); wts2.append(w[j]); blocks.append(1)
        while len(vals2) > 1 and vals2[-2] / wts2[-2] > vals2[-1] / wts2[-1]:
            v, ww, b = vals2.pop(), wts2.pop(), blocks.pop()
            vals2[-1] += v; wts2[-1] += ww; blocks[-1] += b
    for v, ww, b in zip(vals2, wts2, blocks):
        out[k:k + b] = v / ww
        k += b
    return x, out


def to_steps(x, fitted, knots=KNOTS):
    """Compress the step function to `knots` breakpoints for shipping."""
    qs = np.linspace(0, 1, knots)
    xs = np.quantile(x, qs)
    ys = np.interp(xs, x, fitted)
    ys = np.maximum.accumulate(ys)                 # keep it monotone after interp
    # dedupe on x
    keep = np.concatenate([[True], np.diff(xs) > 1e-9])
    return xs[keep].tolist(), ys[keep].tolist()


def apply_steps(p, xs, ys):
    return np.interp(p, xs, ys)


def main():
    df = pd.read_parquet(os.path.join(os.path.dirname(__file__), "dataset.parquet"))
    df = df.sort_values(["season", "week"])
    seasons = sorted(df["season"].unique())
    F = MODELS[FINAL]

    oos = {}
    for S in seasons[1:]:
        tr, te = df[df.season < S], df[df.season == S]
        Xtr, mu, sd = design(tr, F)
        Xte, _, _ = design(te, F, mu, sd)
        w = fit_logistic(Xtr, tr["scored"].to_numpy(float))
        t = te.copy(); t["p"] = predict(Xte, w)
        oos[S] = t

    # honest evaluation: calibrator for season S sees only earlier OOS seasons
    ev = []
    for S in seasons[2:]:
        prior = pd.concat([oos[s] for s in seasons[1:] if s < S])
        xs, ys = to_steps(*isotonic(prior["p"].to_numpy(), prior["scored"].to_numpy(float)))
        t = oos[S].copy()
        t["pc"] = apply_steps(t["p"].to_numpy(), xs, ys)
        ev.append(t)
    p = pd.concat(ev)
    y = p["scored"].to_numpy(float)

    print(f"{'band':<12} {'n':>6} | {'raw':>7} {'actual':>8} {'gap':>7} | {'calib':>7} {'gap':>7}")
    for lo, hi in [(0.30, 0.40), (0.40, 0.50), (0.50, 0.60), (0.60, 0.70), (0.70, 1.01)]:
        g = p[(p.p >= lo) & (p.p < hi)]
        if not len(g):
            continue
        print(f"{f'{lo:.0%}-{hi:.0%}':<12} {len(g):>6} | {g.p.mean():>6.1%} {g.scored.mean():>7.1%} "
              f"{g.scored.mean()-g.p.mean():>+6.1%} | {g.pc.mean():>6.1%} {g.scored.mean()-g.pc.mean():>+6.1%}")

    def ece(pr):
        b = pd.qcut(pr, 10, labels=False, duplicates="drop")
        d = pd.DataFrame({"p": pr, "y": y, "b": b})
        g = d.groupby("b").agg(n=("y", "size"), pp=("p", "mean"), aa=("y", "mean"))
        return (g.n / g.n.sum() * (g.aa - g.pp).abs()).sum()

    print(f"\nlog loss  raw {log_loss(y, p.p.to_numpy()):.4f} -> calibrated {log_loss(y, p.pc.to_numpy()):.4f}")
    print(f"ECE       raw {ece(p.p.to_numpy()):.4f} -> calibrated {ece(p.pc.to_numpy()):.4f}")
    print(f"AUC       unchanged by a monotone map: {auc(y, p.p.to_numpy()):.4f} / {auc(y, p.pc.to_numpy()):.4f}")

    # deployment map: fit on every out-of-sample prediction we have
    allp = pd.concat([oos[s] for s in seasons[1:]])
    xs, ys = to_steps(*isotonic(allp["p"].to_numpy(), allp["scored"].to_numpy(float)))
    json.dump({"x": xs, "y": ys,
               "note": "isotonic recalibration fit on walk-forward out-of-sample "
                       "predictions; corrects top-end over-confidence"},
              open(OUT, "w"), indent=1)
    print(f"\nwrote {OUT} ({len(xs)} knots)")
    for q in (0.3, 0.5, 0.6, 0.7, 0.78):
        print(f"  {q:.0%} raw -> {apply_steps(np.array([q]), xs, ys)[0]:.1%} calibrated")


if __name__ == "__main__":
    main()
