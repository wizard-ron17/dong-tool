"""Is anyone "due" for a goal? Drought features against the shipped goals model.

The NFL answer was no: red-zone volume predicts touchdowns, the gap between
volume and output does not. This asks the hockey version. For every skater-game
(nhl_sog.parquet, 2022-23 on), as of the morning of the game:

  g_since    games since his last goal (across seasons)
  sog_since  shots on goal since his last goal
  toi_since  minutes of ice time since his last goal
  owed       expected goals in the drought — shots since x his shrunk
             shooting %, minus the zero he scored — the "xG he's owed"
  l10_gap    last 10 games: goals minus shots x his shooting % (cold streak)

Two tests, walk-forward by season (train on earlier seasons, grade the next):

  1. calibration — does the shipped model under-price long droughts? Actual
     scoring rate / model price, by drought bucket. "Due" would show up as
     ratios above 1 for the longest droughts.
  2. added terms — each feature (logged) added to the shipped Poisson GLM; the
     per-row log-loss gain, paired t over games. |t| > 2.5 to count.

    python3 research/nhl_due.py
"""
import json, os, sys
import numpy as np
import pandas as pd

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from nhl_goals import D, fit_mu

FEATS = json.load(open(os.path.join(HERE, "nhl_goals_model.json")))["features"]


def droughts(D):
    D = D.sort_values(["pid", "date"]).copy()
    out = {k: np.full(len(D), np.nan) for k in ("g_since", "sog_since", "toi_since", "l10_gap")}
    pid, goals, sog, toi, shp = (D[c].to_numpy() for c in ("pid", "goals", "sog", "toi", "shpct_prior"))
    start = 0
    for i in range(1, len(D) + 1):
        if i < len(D) and pid[i] == pid[start]: continue
        g = s = t = 0.0; seen = False
        for j in range(start, i):
            if seen:
                out["g_since"][j], out["sog_since"][j], out["toi_since"][j] = g, s, t
            if j - start >= 10:
                w = slice(j - 10, j)
                out["l10_gap"][j] = goals[w].sum() - (sog[w] * shp[j]).sum()
            if goals[j] > 0: g = s = t = 0.0; seen = True
            else: g += 1; s += sog[j]; t += toi[j]
        start = i
    for k, v in out.items(): D[k] = v
    D["owed"] = D.sog_since * D.shpct_prior
    return D


def ll(p, y):
    p = np.clip(p, 1e-6, 1 - 1e-6)
    return -(y * np.log(p) + (1 - y) * np.log(1 - p))


def walk(D, feats):
    P = []
    for s in sorted(D.season.unique())[1:]:
        tr, te = D[D.season < s], D[D.season == s]
        mu, *_ = fit_mu(tr, te, feats)
        P.append(pd.Series(1 - np.exp(-mu), index=te.index))
    return pd.concat(P)


if __name__ == "__main__":
    D = droughts(D)
    D = D[D.g_since.notna() & D.l10_gap.notna()].copy()
    for k in ("g_since", "sog_since", "toi_since", "owed"):
        D["log_" + k] = np.log1p(D[k])
    base = walk(D, FEATS)
    T = D.loc[base.index].assign(p=base)
    print(f"{len(T):,} graded skater-games with a known last goal · base rate {T.scored.mean():.3f}\n")

    print("1. Does the shipped model under-price droughts?  actual / priced\n")
    for col, cuts, lab in (("g_since", [0, 1, 3, 6, 10, 15, 20, 30, 999], "games since goal"),
                           ("sog_since", [0, 5, 10, 20, 30, 45, 60, 999], "shots since goal")):
        T["b"] = pd.cut(T[col], cuts, right=False)
        g = T.groupby("b", observed=True).agg(n=("p", "size"), priced=("p", "mean"), actual=("scored", "mean"))
        g["ratio"] = g.actual / g.priced
        g["z"] = (g.actual - g.priced) / np.sqrt(g.priced * (1 - g.priced) / g.n)
        print(f"  {lab}\n" + g.to_string(float_format=lambda x: f"{x:.3f}") + "\n")

    # the "owed" view, restricted to the shooters people actually call due
    hi = T[T.sog_prior >= 2.5]
    hi = hi.assign(b=pd.qcut(hi.owed, 5, duplicates="drop"))
    g = hi.groupby("b", observed=True).agg(n=("p", "size"), priced=("p", "mean"), actual=("scored", "mean"))
    g["ratio"] = g.actual / g.priced
    print("  xG owed, shooters with 2.5+ shots/game\n" + g.to_string(float_format=lambda x: f"{x:.3f}") + "\n")

    print("2. Added to the shipped model (log loss gain per 1,000 games, paired t)\n")
    y = T.scored.to_numpy(); l0 = ll(T.p.to_numpy(), y)
    for lab, extra in (("games since goal", ["log_g_since"]), ("shots since goal", ["log_sog_since"]),
                       ("ice time since goal", ["log_toi_since"]), ("xG owed", ["log_owed"]),
                       ("last-10 cold streak", ["l10_gap"]), ("all of it", ["log_g_since", "log_sog_since", "log_owed", "l10_gap"])):
        p1 = walk(D, FEATS + extra).loc[T.index].to_numpy()
        d = l0 - ll(p1, y)
        t = d.mean() / (d.std() / np.sqrt(len(d)))
        print(f"  {lab:22s} {d.mean() * 1000:+.3f}   t {t:+.2f}")
