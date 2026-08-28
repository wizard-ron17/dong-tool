"""Fit the deployment model and export it as plain JSON coefficients.

The point: scripts/build-nfl.js does NOT need to fit anything. Training stays
here in Python; Node only has to compute the four features, standardize with
the exported mean/sd, and apply a logistic. That is ~20 lines of JS.

Refit this whenever the feature set changes, or once a season to fold in the
completed year.
"""
import json
import os

import numpy as np
import pandas as pd

import backtest as bt

OUT = os.path.join(os.path.dirname(__file__), "model.json")
FEATS = bt.MODELS[bt.FINAL]


def main():
    df = pd.read_parquet(bt.DATA)
    X, mu, sd = bt.design(df, FEATS)
    y = df["scored"].to_numpy(float)
    w = bt.fit_logistic(X, y)

    names = ["intercept"] + [f"pos_{p}" for p in bt.POS[:-1]] + FEATS
    model = {
        "trained_on": f"{int(df.season.min())}-{int(df.season.max())}",
        "n_rows": int(len(df)),
        "base_rate": float(y.mean()),
        "reference_position": bt.POS[-1],
        "features": FEATS,
        "scale": {f: {"mean": float(m), "sd": float(s)}
                  for f, m, s in zip(FEATS, mu, sd)},
        "coef": {n: float(v) for n, v in zip(names, w)},
    }
    with open(OUT, "w") as f:
        json.dump(model, f, indent=2)

    # verify a hand-rolled scorer (what Node will do) reproduces predict()
    ref = bt.predict(X, w)
    got = np.empty(len(df))
    c = model["coef"]
    for i, (_, r) in enumerate(df.iterrows()):
        z = c["intercept"]
        for p in bt.POS[:-1]:
            if r["position"] == p:
                z += c[f"pos_{p}"]
        for f_ in FEATS:
            s = model["scale"][f_]
            z += c[f_] * (r[f_] - s["mean"]) / s["sd"]
        got[i] = 1.0 / (1.0 + np.exp(-z))
        if i > 400:
            break
    n = min(401, len(df))
    print(f"wrote {OUT}")
    print(f"  trained on {model['trained_on']}, {model['n_rows']} rows")
    print(f"  max |scorer - predict()| over {n} rows: "
          f"{np.abs(got[:n] - ref[:n]).max():.2e}")
    print(json.dumps(model["coef"], indent=2))


if __name__ == "__main__":
    main()
