"""First basket: who scores the game's first field goal (research).

    python3 research/nba_firstbasket.py

Ron: "that's a home run in my mind, or more like a 1st TD." It is the NFL's
first-TD market in shape: a race among the ten starters, decided by
  1. which team scores first — how much of that is winning the opening tip?
  2. who on that team takes (and makes) the first shot — starters only, and
     not evenly: usage, and whether the offense runs its first set for him.
Checked here, walk-forward by season (each season scored on the ones before):
  - team scores first | won the tip (and how the jumper's tip record predicts it)
  - share of first baskets by starter vs bench, and by position
  - P(player first) = P(team first) x his share of the starters' shots, vs 1/10
Also the double-double / triple-double base rates, for the ladders.
"""
import glob, json, os
from collections import defaultdict
import numpy as np
import pandas as pd

HERE = os.path.dirname(os.path.abspath(__file__))


def load():
    games, rows = [], []
    for f in glob.glob(os.path.join(HERE, ".cache", "nba", "*", "*.json")):
        d = json.load(open(f)); g = d["game"]
        if g["type"] != 2: continue
        games.append(g)
        for p in d["players"]:
            rows.append({**p, "gid": g["id"], "season": g["season"], "date": g["date"]})
    return pd.DataFrame(games), pd.DataFrame(rows)


def ll(p, y):
    p = np.clip(np.asarray(p, float), 1e-6, 1 - 1e-6); y = np.asarray(y, float)
    return float(-(y * np.log(p) + (1 - y) * np.log(1 - p)).mean())


def main():
    G, P = load()
    G = G[G.first_fg.notna()].copy()
    G["ffg_team"] = G.first_fg.map(lambda x: x.get("team")); G["ffg_pid"] = G.first_fg.map(lambda x: x.get("pid"))
    G["ffg_val"] = G.first_fg.map(lambda x: x.get("value"))
    tip = G[G.tip_team.notna()]
    print(f"{len(G):,} regular-season games with a first field goal; {len(tip):,} with the tip recorded\n")
    print(f"team that won the tip scores first: {(tip.tip_team == tip.ffg_team).mean():.3f}")
    print(f"first basket is a three: {(G.ffg_val == 3).mean():.3f}")
    fp = G.first_pts.map(lambda x: x.get("type") if isinstance(x, dict) else None)
    print(f"first POINTS are free throws (so 'first basket' and 'first points' differ): {fp.str.contains('Free Throw', case=False, na=False).mean():.3f}\n")

    # who: starter / bench, position
    st = P[P.starter].copy()
    key = st.set_index(["gid", "pid"])
    fb = G[["id", "ffg_pid", "ffg_team"]].rename(columns={"id": "gid"})
    fb["starter"] = [bool(key.starter.get((g, p), False)) if (g, p) in key.index else False for g, p in zip(fb.gid, fb.ffg_pid)]
    print(f"first basket by a starter: {fb.starter.mean():.3f}")
    pos = st.merge(fb, left_on=["gid", "pid"], right_on=["gid", "ffg_pid"], how="left", indicator=True)
    pos["hit"] = pos._merge == "both"
    by = pos.groupby("pos").hit.agg(["mean", "count"])
    print("rate per starter by position (1/10 = 0.100):")
    for k, r in by[by["count"] > 2000].sort_values("mean", ascending=False).iterrows(): print(f"  {k:3s} {r['mean']:.3f}  (n {int(r['count']):,})")

    # walk-forward: P(team first) from the tip, P(player | team) from his share of the starters' shots
    st["fga_pm"] = st.fga / st["min"].clip(lower=1)
    seasons = sorted(G.season.unique())
    by_game = {g: d for g, d in st.groupby("gid")}
    T = {}
    for s in seasons[1:]:
        prior = P[(P.season < s) & (P["min"] > 0)]
        # his prior shooting volume: FGA per game as a starter, recency-weighted by season, shrunk
        pr = prior[prior.starter].groupby("pid").agg(fga=("fga", "sum"), gp=("gid", "count"))
        lg = pr.fga.sum() / pr.gp.sum()
        vol = ((pr.fga + 10 * lg) / (pr.gp + 10)).to_dict()
        cur = G[G.season == s]
        rows = []
        for _, g in cur.iterrows():
            sts = by_game.get(g.id)
            if sts is None: continue
            if len(sts) != 10: continue
            won = g.tip_team
            for team in (g.home, g.away):
                mine = sts[sts.team == team]
                w = np.array([vol.get(p, lg) for p in mine.pid]); share = w / w.sum()
                for pid, sh in zip(mine.pid, share):
                    rows.append({"season": s, "gid": g.id, "team": team, "pid": pid, "share": sh, "won_tip": won == team,
                                 "y": float(pid == g.ffg_pid)})
        T[s] = pd.DataFrame(rows)
    D = pd.concat(T.values())
    # the tip edge, measured on the prior seasons only (walk-forward)
    res = []
    for s in seasons[1:]:
        prev = tip[tip.season < s]; edge = float((prev.tip_team == prev.ffg_team).mean())
        d = D[D.season == s].copy()
        d["p_team"] = np.where(d.won_tip, edge, 1 - edge)
        d["p"] = d.p_team * d.share * float(fb[fb.gid.isin(d.gid)].starter.mean())   # the bench's share comes off the top
        res.append(d)
    R = pd.concat(res)
    base = np.full(len(R), R.y.mean())
    print(f"\nwalk-forward, {R.gid.nunique():,} games, {len(R):,} starter-games (seasons {seasons[1]}..{seasons[-1]}):")
    print(f"  log loss  one-in-ten {ll(base, R.y):.5f}   tip only {ll(R.p_team * 0.1 * 2, R.y):.5f}   tip x shot share {ll(R.p, R.y):.5f}")
    R["q"] = pd.qcut(R.p, 5, labels=False, duplicates="drop")
    print("  by predicted band:")
    for q, r in R.groupby("q"): print(f"    priced {r.p.mean():.3f}  actual {r.y.mean():.3f}  (n {len(r):,})")

    # double-double / triple-double base rates
    pl = P[(P["min"] > 0) & ~P.dnp]
    cats = pl[["pts", "reb", "ast", "stl", "blk"]].fillna(0) >= 10
    n10 = cats.sum(axis=1)
    print(f"\ndouble-double {(n10 >= 2).mean():.4f} of player-games ({(n10[pl.starter] >= 2).mean():.4f} of starters) · triple-double {(n10 >= 3).mean():.5f}")


if __name__ == "__main__":
    main()
