"""Do goal scorers score together? The correlation behind /nhl/pairs and the parlay slip.

The NFL answer was that teammates COMPETE (a team scores ~2.5 TDs, so one
player's touchdown is one fewer for the next: a same-team double lands 11%
below the naive product). Hockey might run the other way — a team that scores
five spreads them around, and a line that scores often scores together.

Every skater-game gets the shipped goals model's walk-forward price
(research/nhl_due.py). For every game, every group of skaters is compared
with what happened:

  multiplier = sum over groups of [all scored]  /  sum over groups of prod(p)

computed exactly for every k-subset with elementary symmetric polynomials
(sum of prod p over k-subsets = e_k(p); groups that all scored = C(n_scored, k)).

  same team       every k-subset of one club's dressed skaters, k = 2, 3, 4
  opposing        one skater from each club
  control         two skaters from different games on the same night — must be 1.00
                  if the prices are calibrated, which is what makes the rest believable

Fitted on 2023-24 + 2024-25, checked on 2025-26, as the NFL numbers were.
Also split by price, because a parlay is built from the top of the board and a
correlation measured mostly on fourth-liners might not apply there.

    python3 research/nhl_pairs.py            # prints; writes nhl_pairs_model.json
"""
import json, os, sys
from math import comb
import numpy as np
import pandas as pd

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from nhl_goals import D
from nhl_due import walk, FEATS


def esym(p, kmax):
    """e_0..e_kmax of the vector p."""
    e = np.zeros(kmax + 1); e[0] = 1.0
    for x in p:
        for k in range(kmax, 0, -1):
            e[k] += e[k - 1] * x
    return e


def measure(T, kmax=4, pmin=0.0):
    num = np.zeros(kmax + 1); den = np.zeros(kmax + 1)
    xn = xd = 0.0
    for _, g in T.groupby("gkey"):
        sides = [s for _, s in g.groupby("team")]
        if len(sides) != 2: continue
        sums = []
        for s in sides:
            s = s[s.p >= pmin]
            e = esym(s.p.to_numpy(), kmax); n = int(s.scored.sum())
            for k in range(2, kmax + 1):
                den[k] += e[k]; num[k] += comb(n, k)
            sums.append((s.p.sum(), n))
        xd += sums[0][0] * sums[1][0]; xn += sums[0][1] * sums[1][1]
    out = {f"same_{k}": num[k] / den[k] for k in range(2, kmax + 1)}
    out["cross"] = xn / xd
    out.update({f"hits_{k}": int(num[k]) for k in range(2, kmax + 1)})
    out["hits_cross"] = int(xn)
    return out


def control(T):
    """Pairs from DIFFERENT games on the same night: independent by construction."""
    num = den = 0.0
    for _, n in T.groupby("date"):
        per = n.groupby("gkey").agg(p=("p", "sum"), y=("scored", "sum"), pp=("p", lambda v: (v ** 2).sum()))
        P, Y = per.p.sum(), per.y.sum()
        den += (P ** 2 - (per.p ** 2).sum()) / 2
        num += (Y ** 2 - (per.y ** 2).sum()) / 2
    return num / den


if __name__ == "__main__":
    D = D.drop_duplicates(["pid", "date"])
    P = walk(D, FEATS)
    T = D.loc[P.index].assign(p=P.values)
    # Level first: a season the model priced 2% light makes every pair look 4%
    # "correlated". Rescale each season so its prices sum to its goals; the
    # different-games control then reads 1.00 and the rest is correlation.
    T["p"] = T.p * T.groupby("season").scored.transform("sum") / T.groupby("season").p.transform("sum")
    T["gkey"] = T.date + "|" + np.where(T.team < T.opp, T.team + T.opp, T.opp + T.team)
    print(f"{len(T):,} priced skater-games, {T.gkey.nunique():,} games\n")
    res = {}
    for lab, S in (("fit 2023-24 + 2024-25", T[T.season < 20252026]), ("check 2025-26", T[T.season == 20252026])):
        m = measure(S); c = control(S)
        top = measure(S, pmin=0.20)
        res[lab] = {**m, "control": c, "top": top}
        print(f"{lab}")
        print(f"  control (different games)  {c:.3f}")
        print(f"  opposing teams             {m['cross']:.3f}")
        for k in (2, 3, 4):
            print(f"  same team, {k} legs          {m[f'same_{k}']:.3f}   priced 20%+ only: {top[f'same_{k}']:.3f}")
        print(f"  opposing, priced 20%+      {top['cross']:.3f}")
        print(f"  (groups that all scored, 20%+: {top['hits_2']:,} pairs, {top['hits_3']:,} trios, {top['hits_4']:,} quads, {top['hits_cross']:,} opposing)\n")
    # Fit and check agree to within a point for same-team groups, so what ships
    # is all three seasons pooled, measured where parlays are built: skaters the
    # board prices at 20%+. Opposing legs use every skater — the 20%+ number
    # swung .93 to .99 between the two halves, the all-skater one held at .97.
    top = measure(T, pmin=0.20); allp = measure(T)
    out = {"note": "Goal-scorer group multipliers vs the naive product (research/nhl_pairs.py): same-team groups of skaters priced 20%+, "
                   "opposing pairs over every skater; 2023-24 to 2025-26 pooled after fit/check agreed.",
           "rho_same": round(top["same_2"], 3), "rho_cross": round(allp["cross"], 3),
           "same_by_size": {str(k): round(top[f"same_{k}"], 3) for k in (2, 3, 4)},
           "hits": {str(k): top[f"hits_{k}"] for k in (2, 3, 4)}}
    print("shipped:", out)
    json.dump(out, open(os.path.join(HERE, "nhl_pairs_model.json"), "w"), indent=1)
