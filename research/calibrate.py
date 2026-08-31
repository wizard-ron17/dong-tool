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


def fit_map(p, y, bins=200, knots=KNOTS):
    """Monotone p -> calibrated p, robust in a thin tail.

    Two details matter, both learned the hard way on the 2+ market, whose
    predictions are wildly skewed (median 0.013, max 0.43):

    * Bin to equal-count bins BEFORE the isotonic fit. Fitting on raw points
      lets a single lucky observation at the extreme set the top of the curve.
    * Place the exported knots uniformly in p, not at quantiles. Quantile knots
      crowd into the dense low end and leave the tail spanned by one segment,
      so everything from 0.14 up got interpolated toward a 0.75 endpoint —
      turning a -4pp bias into a +21pp one.
    """
    p = np.asarray(p, float); y = np.asarray(y, float)
    o = np.argsort(p, kind="mergesort")
    p, y = p[o], y[o]
    edges = np.linspace(0, len(p), min(bins, max(2, len(p) // 50)) + 1).astype(int)
    bp, by, bw = [], [], []
    for a, b in zip(edges[:-1], edges[1:]):
        if b <= a:
            continue
        bp.append(p[a:b].mean()); by.append(y[a:b].mean()); bw.append(b - a)
    bx, bf = isotonic(np.array(bp), np.array(by), np.array(bw, float))
    xs = np.linspace(bx[0], bx[-1], knots)
    ys = np.maximum.accumulate(np.interp(xs, bx, bf))
    keep = np.concatenate([[True], np.diff(xs) > 1e-9])
    return xs[keep].tolist(), ys[keep].tolist()


def to_steps(x, fitted, knots=KNOTS):
    """Kept for callers that already have an isotonic fit."""
    xs = np.linspace(x[0], x[-1], knots)
    ys = np.maximum.accumulate(np.interp(xs, x, fitted))
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
        xs, ys = fit_map(prior["p"].to_numpy(), prior["scored"].to_numpy(float))
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
    xs, ys = fit_map(allp["p"].to_numpy(), allp["scored"].to_numpy(float))

    # ── the 2+ market ────────────────────────────────────────────────────
    # P(2+) = calibrated P(1+) * P(2+|1+), then its own isotonic. Its drift is
    # far milder than the 1+ model's (-4.3pp at the top vs -21.6pp) but it is
    # the same kind of top-end over-confidence, so correct it the same way.
    oos2 = {}
    for S in seasons[1:]:
        tr, te = df[df.season < S], df[df.season == S]
        X1, mu, sd = design(tr, F)
        Xt1, _, _ = design(te, F, mu, sd)
        w1 = fit_logistic(X1, tr["scored"].to_numpy(float))
        p1 = apply_steps(predict(Xt1, w1), xs, ys)
        sc = tr[tr.scored == 1]
        Xc, mc, sc_ = design(sc, F)
        Xtc, _, _ = design(te, F, mc, sc_)
        wc = fit_logistic(Xc, (sc["tds"] >= 2).to_numpy(float))
        t = te.copy()
        t["p2"] = p1 * predict(Xtc, wc)
        t["m2"] = (te["tds"] >= 2).astype(int)
        oos2[S] = t
    all2 = pd.concat(oos2.values())
    x2, y2 = fit_map(all2["p2"].to_numpy(), all2["m2"].to_numpy(float))

    # ── the first-TD market ──────────────────────────────────────────────
    # P(first) is the anytime price divided by the total scoring threat in that
    # game, times the share of games whose first scorer we actually carry.
    # Dividing by the in-game sum is the whole point: a back in a quiet game has
    # a far better claim on the opening score than one boxed in with three other
    # likely scorers, even at identical anytime prices. Ignoring competition
    # costs real accuracy (AUC .7357 -> .7412 on 2025 held out).
    oos3 = {}
    for S in seasons[1:]:
        tr, te = df[df.season < S], df[df.season == S]
        X1, mu, sd = design(tr, F)
        Xt1, _, _ = design(te, F, mu, sd)
        w1 = fit_logistic(X1, tr["scored"].to_numpy(float))
        p1 = apply_steps(predict(Xt1, w1), xs, ys)
        share = tr.groupby("game_id")["first_td"].max().mean()
        t = te.copy()
        t["p1c"] = p1
        t["pf"] = p1 / t.groupby("game_id")["p1c"].transform("sum") * share
        oos3[S] = t
    all3 = pd.concat(oos3.values())
    x3, y3 = fit_map(all3["pf"].to_numpy(), all3["first_td"].to_numpy(float))
    share_all = float(df.groupby("game_id")["first_td"].max().mean())

    yy3 = all3["first_td"].to_numpy(float)
    pc3 = apply_steps(all3["pf"].to_numpy(), x3, y3)
    print(f"\n1st-TD market, out of sample:")
    print(f"  log loss {log_loss(yy3, all3.pf.to_numpy()):.5f} -> {log_loss(yy3, pc3):.5f}"
          f"   AUC {auc(yy3, all3.pf.to_numpy()):.4f}")
    print(f"  in-pool share of first scorers: {share_all:.3f}")
    for lo, hi in [(0.05, 0.10), (0.10, 0.15), (0.15, 1.01)]:
        g = all3[(all3.pf >= lo) & (all3.pf < hi)]
        if not len(g):
            continue
        c = apply_steps(g.pf.to_numpy(), x3, y3)
        print(f"  {lo:.0%}-{hi:.0%}: n={len(g):>5} raw {g.pf.mean():.1%} -> cal {c.mean():.1%}"
              f"  actual {g.first_td.mean():.1%}")

    json.dump({"x": xs, "y": ys, "x2": x2, "y2": y2, "x3": x3, "y3": y3,
               "first_share": share_all,
               "note": "isotonic recalibration fit on walk-forward out-of-sample "
                       "predictions. x/y: P(>=1 TD). x2/y2: P(>=2 TD). x3/y3: "
                       "P(first TD), applied after dividing the calibrated "
                       "anytime price by the game's total scoring threat and "
                       "scaling by first_share (the fraction of games whose "
                       "first scorer is in the pool)."},
              open(OUT, "w"), indent=1)
    print(f"\nwrote {OUT} ({len(xs)} + {len(x2)} knots)")
    for q in (0.3, 0.5, 0.6, 0.7, 0.78):
        print(f"  1+ : {q:.0%} raw -> {apply_steps(np.array([q]), xs, ys)[0]:.1%} calibrated")
    print(f"\n2+ market, out of sample:")
    yy = all2["m2"].to_numpy(float)
    pc2 = apply_steps(all2["p2"].to_numpy(), x2, y2)
    print(f"  log loss {log_loss(yy, all2.p2.to_numpy()):.5f} -> {log_loss(yy, pc2):.5f}")
    for lo, hi in [(0.10, 0.15), (0.15, 0.25), (0.25, 1.01)]:
        g = all2[(all2.p2 >= lo) & (all2.p2 < hi)]
        if not len(g):
            continue
        c = apply_steps(g.p2.to_numpy(), x2, y2)
        print(f"  {lo:.0%}-{hi:.0%}: n={len(g):>5} raw {g.p2.mean():.1%} -> cal {c.mean():.1%}  actual {g.m2.mean():.1%}")


if __name__ == "__main__":
    main()
