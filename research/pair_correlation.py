"""Correlation constants for pricing multi-leg touchdown parlays.

Multiplying two of our prices together assumes the legs are independent. They
are not, and the direction is the opposite of what "correlation tax" usually
implies: TEAMMATES COMPETE. A team scores ~2.5 touchdowns; if the back takes
one, that is one fewer for the tight end. Same-team pairs come in BELOW the
naive product. Only opposing-team pairs behave independently.

The exception is a quarterback and his own receiver, where a receiving TD IS
the passing TD — the same event, not a competing one — so that pair runs far
above independence. That pair needs the passing model, so it is measured
separately at the bottom.

The structure turns out to be pairwise and multiplicative, which is what makes
this cheap to ship: for a group, multiply the naive product by rho once per
pair of legs, using the rho for that pair's relationship. No copula, no joint
simulation.

  python3 research/pair_correlation.py   ->  research/pair_correlation.json
"""
import itertools
import json
import os

import numpy as np
import pandas as pd

HERE = os.path.dirname(__file__)
OUT = os.path.join(HERE, "pair_correlation.json")
MIN_P = 0.08        # legs anyone would actually put in a parlay
TEST_FROM = 2022    # fit on everything before, check on these


def price(d, model, calib):
    """The shipped Picks price for every player-game."""
    z = np.full(len(d), model["coef"]["intercept"], float)
    for f in model["features"]:
        s = model["scale"][f]
        z += model["coef"][f] * ((d[f].values - s["mean"]) / s["sd"])
    for pos in d.position.unique():
        if pos != model["reference_position"]:
            z += np.where(d.position.values == pos, model["coef"].get(f"pos_{pos}", 0.0), 0.0)
    return np.interp(1 / (1 + np.exp(-np.clip(z, -30, 30))), calib["x"], calib["y"])


def pair_stats(d, size, same):
    """Naive-product sum and actual-hit sum over every group of `size`.

    same=True  -> all legs on one team
    same=False -> legs split across the two teams
    """
    ind = act = n = 0
    if same:
        for _, g in d.groupby(["game_id", "team"]):
            if not (size <= len(g) <= 9):
                continue
            r = g[["p", "scored"]].values
            for c in itertools.combinations(range(len(r)), size):
                pr, hit = 1.0, 1
                for i in c:
                    pr *= r[i][0]; hit &= int(r[i][1])
                ind += pr; act += hit; n += 1
    else:
        for _, g in d.groupby("game_id"):
            teams = g.team.unique()
            if len(teams) != 2:
                continue
            a = g[g.team == teams[0]][["p", "scored"]].values
            b = g[g.team == teams[1]][["p", "scored"]].values
            for i in range(len(a)):
                for j in range(len(b)):
                    ind += a[i][0] * b[j][0]
                    act += int(a[i][1] and b[j][1]); n += 1
    return ind, act, n


def main():
    model = json.load(open(os.path.join(HERE, "model.json")))
    calib = json.load(open(os.path.join(HERE, "calibration.json")))
    d = pd.read_parquet(os.path.join(HERE, "dataset.parquet"))
    d["p"] = price(d, model, calib)
    d = d[d.p >= MIN_P].copy()
    tr, te = d[d.season < TEST_FROM], d[d.season >= TEST_FROM]
    print(f"legs at p>={MIN_P}: {len(d):,}   train {tr.season.min()}-{tr.season.max()}  "
          f"test {te.season.min()}-{te.season.max()}")

    # ── fit the two constants on the training seasons only ────────────
    i2, a2, n2 = pair_stats(tr, 2, True)
    rho_same = a2 / i2
    i2o, a2o, n2o = pair_stats(tr, 2, False)
    rho_cross = a2o / i2o
    print(f"\nfitted on {tr.season.min()}-{tr.season.max()}:")
    print(f"  rho_same  {rho_same:.4f}   (n={n2:,})   teammates compete")
    print(f"  rho_cross {rho_cross:.4f}   (n={n2o:,})  effectively independent")

    # A single pairwise rho under-corrects as groups grow: the effective
    # multiplier keeps sliding (0.889 at two legs, 0.869 at four), because
    # cannibalisation compounds faster than independent pairs imply. So the
    # common case — a pure same-team SGP — gets its own measured multiplier per
    # size, and the pairwise rule is kept only for mixed groups it can't cover.
    same_by_size = {}
    for size in (2, 3, 4, 5):
        i_, a_, n_ = pair_stats(tr, size, True)
        if a_ >= 30:
            same_by_size[size] = a_ / i_
    print("  same-team multiplier fitted per size (train):")
    for k, v in same_by_size.items():
        print(f"    {k}-man  {v:.4f}   (pairwise rule would say {rho_same ** (k*(k-1)//2):.4f})")

    # ── does rho^(pairs) hold OUT OF SAMPLE at bigger sizes? ───────────
    print(f"\nout-of-sample check on {te.season.min()}-{te.season.max()} "
          f"— predicted = naive x rho_same^C(size,2):")
    print("  size      naive    actual   predicted   naive err   model err")
    rows = []
    for size in (2, 3, 4):
        ind, act, n = pair_stats(te, size, True)
        pred = ind * same_by_size.get(size, rho_same ** (size * (size - 1) // 2))
        pw = ind * rho_same ** (size * (size - 1) // 2)
        naive_err = ind / act - 1
        model_err = pred / act - 1
        print(f"  {size}-man  {ind/n:.6f}  {act/n:.6f}  {pred/n:.6f}   "
              f"{naive_err:+7.1%}    {model_err:+7.1%}   (pairwise-only {pw/act-1:+.1%})")
        rows.append({"size": size, "naive_err": round(float(naive_err), 4),
                     "model_err": round(float(model_err), 4), "n": int(n)})

    # mixed group: 1 leg one side, 2 the other -> one same pair, two cross pairs
    ind = act = n = 0
    for _, g in te.groupby("game_id"):
        teams = g.team.unique()
        if len(teams) != 2:
            continue
        a = g[g.team == teams[0]][["p", "scored"]].values
        b = g[g.team == teams[1]][["p", "scored"]].values
        for i in range(len(a)):
            for j in range(len(b)):
                for k in range(j + 1, len(b)):
                    ind += a[i][0] * b[j][0] * b[k][0]
                    act += int(a[i][1] and b[j][1] and b[k][1]); n += 1
    pred = ind * rho_same * rho_cross ** 2
    print(f"  1+2    {ind/n:.6f}  {act/n:.6f}  {pred/n:.6f}   "
          f"{ind/act-1:+7.1%}    {pred/act-1:+7.1%}")

    # ── QB + his own receiver, the one positively correlated pair ──────
    # A receiving TD IS the passing TD, so this is measured against the
    # passing model rather than the anytime one.
    print("\nQB passing market x his own receivers:")
    try:
        pt = pd.read_parquet(os.path.join(HERE, "passing_td.parquet"))
        pm = json.load(open(os.path.join(HERE, "passing_model.json")))
        z = np.full(len(pt), pm["coef"][0], float)
        for i, f in enumerate(pm["features"]):
            s = pm["scale"][f]
            z += pm["coef"][i + 1] * ((pt[f].values - s["mean"]) / s["sd"])
        mu = np.exp(np.clip(z, -20, 20))
        c = pm["cal"]["2"]
        pt["p_qb2"] = np.interp(1 - np.exp(-mu) * (1 + mu), c["x"], c["y"])   # P(2+ pass TD)
        pt["qb_hit"] = (pt.ptd >= 2).astype(int)
        rec = d[d.position.isin(["WR", "TE", "RB"])][["game_id", "team", "p", "scored"]]
        j = rec.merge(pt[["game_id", "team", "p_qb2", "qb_hit"]], on=["game_id", "team"])
        ind = (j.p * j.p_qb2).sum(); act = ((j.scored == 1) & (j.qb_hit == 1)).sum()
        rho_qb = act / ind
        print(f"  rho_qb {rho_qb:.4f}   (n={len(j):,})   naive product understates by "
              f"{1 - ind/act:.0%}")
    except Exception as e:
        rho_qb = None
        print(f"  skipped ({e})")

    # ── QB + N of his receivers ────────────────────────────────────────
    # A trio mixes a positive link (each receiver to the passer) with a negative
    # one (the two receivers competing for his throws), so the pairwise rule
    # can't be assumed to compose here. Measured per size, fitted on train and
    # checked on test, the same way same-team groups are.
    qb_by_size = {}
    if rho_qb is not None:
        j = d[d.position.isin(["WR", "TE", "RB"])].merge(
            pt[["game_id", "team", "p_qb2", "qb_hit"]], on=["game_id", "team"])
        for size in (2, 3, 4):           # size = legs INCLUDING the quarterback
            need = size - 1
            for label, frame in (("train", j[j.season < TEST_FROM]), ("test", j[j.season >= TEST_FROM])):
                ind = act = n = 0
                for _, grp in frame.groupby(["game_id", "team"]):
                    r = grp[["p", "scored"]].values
                    if len(r) < need:
                        continue
                    pq = grp.p_qb2.iloc[0]; qh = grp.qb_hit.iloc[0]
                    for combo in itertools.combinations(range(len(r)), need):
                        pr, hit = pq, int(qh)
                        for i in combo:
                            pr *= r[i][0]; hit &= int(r[i][1])
                        ind += pr; act += hit; n += 1
                if label == "train" and act >= 30:
                    qb_by_size[size] = act / ind
                elif label == "test" and size in qb_by_size and act >= 30:
                    pred = ind * qb_by_size[size]
                    pw = ind * (rho_qb ** need) * (rho_same ** (need * (need - 1) // 2))
                    print(f"  QB + {need} receiver(s): fitted {qb_by_size[size]:.3f}x  "
                          f"-> OOS naive {ind/act - 1:+.1%}, measured {pred/act - 1:+.1%}, "
                          f"pairwise-rule {pw/act - 1:+.1%}")

    out = {
        "note": ("Pairwise correlation multipliers for touchdown parlays. Apply rho once "
                 "per PAIR of legs: true = naive * prod(rho[pair]). Teammates compete for "
                 "a fixed pool of touchdowns, so rho_same is BELOW 1 — the opposite of the "
                 "usual correlation-tax intuition. rho_qb is above 1 because a receiving "
                 "TD is the passing TD, the same event."),
        "rho_same": round(float(rho_same), 4),
        "same_by_size": {str(k): round(float(v), 4) for k, v in same_by_size.items()},
        "rho_cross": round(float(rho_cross), 4),
        "rho_qb": None if rho_qb is None else round(float(rho_qb), 4),
        # Only sizes whose multiplier held out of sample ship. QB + 3 receivers
        # fitted 1.290 and the test wanted ~1.09 — an unstable estimate on a
        # thin sample, so that group is listed without a price rather than
        # priced badly.
        "qb_by_size": {str(k): round(float(v), 4) for k, v in qb_by_size.items() if k <= 3},
        "fit_seasons": f"{int(tr.season.min())}-{int(tr.season.max())}",
        "test_seasons": f"{int(te.season.min())}-{int(te.season.max())}",
        "min_leg_p": MIN_P,
        "oos": rows,
    }
    with open(OUT, "w") as f:
        json.dump(out, f, indent=1)
    print(f"\nwrote {OUT}")


if __name__ == "__main__":
    main()
