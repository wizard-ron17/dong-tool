"""Poisson or negative binomial? How each NBA box stat varies game to game (research).

    python3 research/nba_dispersion.py

Reads the ESPN cache from nba_fetch.py. For every stat, the dispersion index is
mean((y - mu)^2 / mu) over player-games — 1.0 is Poisson, above 1 is over-
dispersed (NB), below 1 under-dispersed (binomial-like). Two versions of mu:

  pregame    his season rate per game, leave-one-out — minutes unknown, which
             is what a price has to handle: minutes swings are in the variance
  given MIN  his season rate per minute (leave-one-out) x the minutes he played
             — what's left once minutes are known

The gap between the two is how much of the NBA's variance is minutes (the
role) rather than the stat itself — the NHL ice-time / NFL snap-share question.
Player-seasons with 20+ games of 10+ minutes; regular season only.
"""
import glob, json, os
import numpy as np
import pandas as pd

HERE = os.path.dirname(os.path.abspath(__file__))
STATS = ["pts", "fgm", "tpm", "ftm", "reb", "oreb", "dreb", "ast", "stl", "blk", "to", "pf"]


def load():
    rows, games = [], []
    for f in glob.glob(os.path.join(HERE, ".cache", "nba", "*", "*.json")):
        d = json.load(open(f)); g = d["game"]; games.append(g)
        for p in d["players"]:
            if p.get("min") is None or p["dnp"]: continue
            rows.append({**{k: p.get(k) for k in ["pid", "name", "team", "pos", "starter", "min", "tpa", "fga", "fta"] + STATS},
                         "gid": g["id"], "date": g["date"], "season": g["season"], "type": g["type"]})
    return pd.DataFrame(rows), pd.DataFrame(games)


def main():
    P, G = load()
    P = P[(P.type == 2) & (P["min"] >= 10)].copy()
    n = P.groupby(["pid", "season"]).gid.transform("count")
    P = P[n >= 20].copy()
    print(f"{len(G):,} games cached · {len(P):,} player-games (10+ min, 20+ game seasons) · {P.pid.nunique():,} players\n")
    grp = P.groupby(["pid", "season"])
    tot_min, gp = grp["min"].transform("sum"), grp.gid.transform("count")
    print(f"{'stat':6s} {'mean':>6s}  {'pregame':>8s} {'given MIN':>10s}   read")
    out = {}
    for s in STATS:
        y = P[s].astype(float)
        tot = grp[s].transform("sum")
        mu_pre = (tot - y) / (gp - 1)                                  # leave-one-out per game
        mu_min = (tot - y) / (tot_min - P["min"]) * P["min"]           # leave-one-out per minute x minutes
        ok = (mu_pre > 0.05) & (mu_min > 0.05)
        d_pre = float((((y - mu_pre) ** 2) / mu_pre)[ok].mean())
        d_min = float((((y - mu_min) ** 2) / mu_min)[ok].mean())
        read = "Poisson" if 0.9 <= d_pre <= 1.15 else ("NB (over-dispersed)" if d_pre > 1.15 else "under-dispersed")
        out[s] = {"mean": float(y.mean()), "pregame": round(d_pre, 3), "given_min": round(d_min, 3)}
        print(f"{s:6s} {y.mean():6.2f}  {d_pre:8.3f} {d_min:10.3f}   {read}")
    # made threes given attempts: binomial check (3PM | 3PA vs his season 3P%)
    t = P[P.tpa > 0]; gt = t.groupby(["pid", "season"])
    pct = (gt.tpm.transform("sum") - t.tpm) / (gt.tpa.transform("sum") - t.tpa)
    ok = (pct > 0) & (pct < 1)
    var_bin = (t.tpa * pct * (1 - pct))[ok]
    print(f"\n3PM given 3PA vs binomial: variance ratio {float(((t.tpm - t.tpa * pct) ** 2)[ok].sum() / var_bin.sum()):.3f} (1.0 = pure binomial shooting luck)")
    json.dump(out, open(os.path.join(HERE, "nba_dispersion.json"), "w"), indent=1)


if __name__ == "__main__":
    main()
