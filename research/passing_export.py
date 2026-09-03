"""Fit, calibrate and export the passing-TD model for the Picks board.

Stage 2 of the passing-TD work (stage 1 is passing_td.py, which vetted the
features). The ladder there was unambiguous: Vegas's implied team total carries
almost all of the signal, pass volume and the QB's own TD rate add a little, and
red-zone efficiency, weapon quality, defense and game script add nothing once
those three are in. So the shipped model is three features, not nine.

Passing TDs are UNDERdispersed (variance 1.33 against a mean 1.45), so a raw
Poisson puts too much weight in both tails — it under-prices Over 1.5 and
over-prices Over 2.5. Each line therefore gets its own isotonic map fitted on
walk-forward out-of-sample predictions, the same treatment the other four
markets already get.

Writes research/passing_model.json for the Node port in scripts/picks.js.

  python3 research/passing_export.py
"""
import json
import os
import numpy as np
import pandas as pd

from calibrate import fit_map
from passing_td import (fit_poisson, pois_at_least, ece, auc, SEASONS,
                        SHRINK_K, PRIOR_SEASONS, MIN_ATT)

HERE = os.path.dirname(__file__)
OUT = os.path.join(HERE, "passing_model.json")
# Three features. See the module docstring — the other six were measured and
# dropped, not omitted for convenience.
FEATS = ["implied_total", "att_pg", "ptd_pg"]
LINES = [1, 2, 3]           # the whole number needed for Over 0.5 / 1.5 / 2.5
TEST_FROM = 2018            # first two seasons are training-only


def design(d, mu, sd):
    return np.column_stack([np.ones(len(d))] +
                           [((d[f] - mu[f]) / sd[f]).values for f in FEATS])


def main():
    df = pd.read_parquet(os.path.join(HERE, "passing_td.parquet"))
    mu, sd = df[FEATS].mean(), df[FEATS].std().replace(0, 1)

    # ── walk-forward OOS predictions, used ONLY to fit the calibration ──
    oos_mu, oos_y, oos_season = [], [], []
    for ts in [s for s in SEASONS if s >= TEST_FROM]:
        tr, te = df[df.season < ts], df[df.season == ts]
        if len(tr) < 500 or not len(te):
            continue
        w = fit_poisson(design(tr, mu, sd), tr.ptd.values)
        oos_mu.append(np.exp(np.clip(design(te, mu, sd) @ w, -20, 20)))
        oos_y.append(te.ptd.values)
        oos_season.append(np.full(len(te), ts))
    m = np.concatenate(oos_mu); y = np.concatenate(oos_y)
    print(f"out-of-sample QB starts: {len(y):,}")
    print(f"  mean projected {m.mean():.3f}   actual {y.mean():.3f}")

    # ── one isotonic map per line ──────────────────────────────────────
    cal = {}
    print("\n── calibration by line ──")
    for need in LINES:
        p = pois_at_least(m, need)
        hit = (y >= need).astype(float)
        xs, ys = fit_map(p, hit)
        adj = np.interp(p, xs, ys)
        print(f"  Over {need - 0.5}:  raw {p.mean():6.2%} -> cal {adj.mean():6.2%}   "
              f"actual {hit.mean():6.2%}   ECE {ece(p, hit):.4f} -> {ece(adj, hit):.4f}   "
              f"AUC {auc(p, hit):.3f}")
        cal[str(need)] = {"x": [round(v, 6) for v in xs], "y": [round(v, 6) for v in ys]}

    # ── final fit on everything, for the shipped coefficients ──────────
    w = fit_poisson(design(df, mu, sd), df.ptd.values)
    model = {
        "note": ("Poisson on 3 features; the other six tested in passing_td.py "
                 "added nothing once implied_total was in. Counts are "
                 "underdispersed, so each line carries its own isotonic map."),
        "features": FEATS,
        "coef": [round(float(v), 8) for v in w],
        "scale": {f: {"mean": round(float(mu[f]), 8), "sd": round(float(sd[f]), 8)}
                  for f in FEATS},
        "lines": LINES,
        "cal": cal,
        # Everything the Node port needs to rebuild att_pg / ptd_pg identically:
        # shrink k games of league prior into the QB's own last `window` seasons.
        #   feat = (his prior total + k * lg) / (his prior starts + k)
        "prior": {
            "k": SHRINK_K,
            "window": PRIOR_SEASONS,
            "min_att": MIN_ATT,
            "lg_att": round(float(df.att.mean()), 6),
            "lg_ptd": round(float(df.ptd.mean()), 6),
        },
        "seasons": f"{min(SEASONS)}-{max(SEASONS)}",
        "n": int(len(df)),
        "base": {str(n): round(float((df.ptd >= n).mean()), 4) for n in LINES},
    }
    with open(OUT, "w") as f:
        json.dump(model, f, separators=(",", ":"))
    print(f"\ncoefficients (standardised): intercept {w[0]:+.4f}  "
          + "  ".join(f"{f} {v:+.4f}" for f, v in zip(FEATS, w[1:])))
    print(f"wrote {OUT} ({os.path.getsize(OUT)/1024:.1f} KB)")

    # ── verify a hand-rolled scorer matches, the way export_model.py does ──
    # This is the exact arithmetic the Node port has to reproduce; if it can't
    # be reproduced from the exported numbers alone, the port will silently
    # disagree with the backtest.
    r = df.iloc[0]
    z = w[0] + sum(w[i + 1] * ((r[f] - mu[f]) / sd[f]) for i, f in enumerate(FEATS))
    manual = float(np.exp(z))
    ref = float(np.exp(design(df.iloc[[0]], mu, sd) @ w)[0])
    print(f"hand-rolled scorer matches: {abs(manual - ref):.2e}")
    assert abs(manual - ref) < 1e-9

    # Round-trip the JSON the way Node will read it, so rounding can't shift a price.
    j = json.loads(json.dumps(model))
    z2 = j["coef"][0] + sum(j["coef"][i + 1] * ((r[f] - j["scale"][f]["mean"]) / j["scale"][f]["sd"])
                            for i, f in enumerate(j["features"]))
    print(f"post-JSON drift on a sample row: {abs(float(np.exp(z2)) - ref):.2e}")


if __name__ == "__main__":
    main()
