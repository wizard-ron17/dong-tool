"""Diff the Node feature computation against build_dataset.py.

    node scripts/dump-features.js 2025 10 > /tmp/nf.json
    python3 research/validate_port.py /tmp/nf.json

The Node build applies coefficients fitted here, so its features have to BE the
features fitted on. This is the check that says so — anything that drifts (a
different shrink target, an off-by-one in the recency window, a season boundary
handled differently) shows up as a nonzero max deviation.
"""
import json
import sys

import numpy as np
import pandas as pd

FEATS = ["snap_share_prior", "rz_touches_prior", "snap_last3",
         "implied_total", "mates_out", "new_absence"]
# Features must agree to FEAT_TOL and the output probability to PROB_TOL.
#
# FEAT_TOL is not 0 because of one deliberate approximation: the shrinkage
# target for a player with no previous season is the position mean, which
# add_form() computes on the pre-filter frame while export_model.py computes it
# on the saved dataset (904 rows fewer). It moves only rookies, is damped by
# k=2, and lands under 1e-4 on the probability — which is what PROB_TOL guards.
FEAT_TOL = 2e-3
PROB_TOL = 1e-4


def main(path):
    node = pd.DataFrame(json.load(open(path)))
    if node.empty:
        sys.exit("no rows in the Node dump")
    season = int(node.attrs.get("season", 0)) or None

    py = pd.read_parquet("research/dataset.parquet")
    # infer the target week from the overlap, so the caller only passes the file
    key = node[["pid"]].drop_duplicates()
    cand = py.merge(key, on="pid")
    # pick the (season, week) with the most matching pids
    counts = cand.groupby(["season", "week"]).size().sort_values()
    season, week = counts.index[-1]
    py = py[(py.season == season) & (py.week == week)]
    print(f"comparing {season} week {week}: "
          f"{len(node)} Node rows vs {len(py)} Python rows")

    m = py.merge(node, on="pid", suffixes=("_py", "_js"))
    print(f"matched on pid: {len(m)} "
          f"({len(m)/len(py):.1%} of Python rows)\n")

    print(f"{'feature':<20} {'max |diff|':>12} {'mean |diff|':>12}  {'status':>8}")
    worst = 0.0
    for f in FEATS:
        d = (m[f"{f}_py"].to_numpy(float) - m[f"{f}_js"].to_numpy(float))
        mx, mn = np.abs(d).max(), np.abs(d).mean()
        worst = max(worst, mx)
        print(f"{f:<20} {mx:>12.2e} {mn:>12.2e}  "
              f"{'OK' if mx < FEAT_TOL else 'MISMATCH':>8}")

    # and the thing that actually matters: the same probability out the far end
    from backtest import design, fit_logistic, predict
    full = pd.read_parquet("research/dataset.parquet")
    X, mu, sd = design(full, FEATS)
    w = fit_logistic(X, full["scored"].to_numpy(float))
    mm = m.rename(columns={f"{f}_py": f for f in FEATS})
    mm["position"] = m["position_py"] if "position_py" in m else m["position"]
    Xm, _, _ = design(mm, FEATS, mu, sd)
    p_py = predict(Xm, w)
    dp = np.abs(p_py - m["p"].to_numpy(float))
    print(f"\n{'predicted probability':<20} {dp.max():>12.2e} {dp.mean():>12.2e}  "
          f"{'OK' if dp.max() < PROB_TOL else 'MISMATCH':>8}")

    if worst >= FEAT_TOL or dp.max() >= PROB_TOL:
        print("\nWorst offenders:")
        for f in FEATS:
            d = np.abs(m[f"{f}_py"].to_numpy(float) - m[f"{f}_js"].to_numpy(float))
            if d.max() < FEAT_TOL:
                continue
            bad = m.assign(d=d).nlargest(5, "d")
            print(f"\n  {f}:")
            cols = ["pid", "player", "position_py", f"{f}_py", f"{f}_js", "d"]
            print(bad[[c for c in cols if c in bad]].to_string(index=False))
        sys.exit(1)
    print("\nport verified: Node features match build_dataset.py")


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else "/tmp/nf.json")
