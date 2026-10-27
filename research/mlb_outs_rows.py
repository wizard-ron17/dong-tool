"""One row per start, 2024-2026, with what was known before first pitch (the leash study).

    python3 research/mlb_outs_fetch.py && python3 research/mlb_outs_rows.py

Reads research/.cache/mlb_box/lines.parquet, writes research/.cache/mlb_box/start_rows.parquet.
Everything is from his lines BEFORE the game (this season, then last season), his
team's starters before it, and the opponent's batting before it.
"""
import os
from collections import defaultdict, deque
import numpy as np, pandas as pd

HERE = os.path.dirname(os.path.abspath(__file__))
C = os.path.join(HERE, ".cache", "mlb_box")
L = pd.read_parquet(os.path.join(C, "lines.parquet"))
L["season"] = L.date.str[:4].astype(int)
L = L.sort_values(["start_time", "gpk", "order"]).reset_index(drop=True)

pit = defaultdict(lambda: {"gs": 0, "bf": 0, "p": 0, "outs": 0, "k": 0, "bb": 0, "on": 0, "er": 0, "rel": 0, "rel_bf": 0, "rel_p": 0})
recent = defaultdict(lambda: deque(maxlen=5))            # (season, date, pitches, bf, outs) of his last starts
last_app = {}                                            # pid -> last appearance date (any role)
last_start = {}
prev = {}                                                # (season, pid) -> his final season line
team = defaultdict(lambda: {"gs": 0, "bf": 0, "p": 0, "outs": 0})   # (season, team) starters
opp = defaultdict(lambda: {"bf": 0, "k": 0, "on": 0, "p": 0})       # (season, batting team)
rows = []
for gpk, G in L.groupby("gpk", sort=False):
    d = G.date.iloc[0]; s = G.season.iloc[0]; dt = pd.Timestamp(d)
    for r in G[G.gs == 1].itertuples():
        P, T, O = pit[(s, r.pid)], team[(s, r.team)], opp[(s, r.opp)]
        Q = prev.get((s - 1, r.pid))
        rec = [x for x in recent[r.pid]]
        cur = [x for x in rec if x[0] == s]
        la, ls = last_app.get(r.pid), last_start.get(r.pid)
        rows.append({
            "date": d, "season": s, "gpk": gpk, "pid": r.pid, "name": r.name, "team": r.team, "opp": r.opp, "home": int(r.home),
            "bf": r.bf, "outs": r.outs, "pitches": r.pitches, "k": r.k, "bb": r.bb,
            # this season, as a starter
            "gs_n": P["gs"], "gs_bf": P["bf"], "gs_p": P["p"], "gs_outs": P["outs"],
            "all_bf": P["bf"] + P["rel_bf"], "all_k": P["k"], "all_bb": P["bb"], "all_on": P["on"], "all_er": P["er"],
            "rel_n": P["rel"], "rel_bf": P["rel_bf"],
            # last season, as a starter
            "py_gs": Q["gs"] if Q else 0, "py_bf": Q["bf"] if Q else 0, "py_p": Q["p"] if Q else 0, "py_outs": Q["outs"] if Q else 0,
            "py_all_bf": (Q["bf"] + Q["rel_bf"]) if Q else 0, "py_k": Q["k"] if Q else 0,
            # his last starts (any season), newest last
            "l1_p": rec[-1][2] if rec else np.nan, "l1_bf": rec[-1][3] if rec else np.nan, "l1_outs": rec[-1][4] if rec else np.nan,
            "l3_p": np.mean([x[2] for x in rec[-3:]]) if rec else np.nan, "l3_bf": np.mean([x[3] for x in rec[-3:]]) if rec else np.nan,
            "l3_n": len(rec[-3:]), "l3_cur": len(cur[-3:]),
            "l1_cur": int(bool(rec) and rec[-1][0] == s),
            "rest_app": (dt - pd.Timestamp(la)).days if la else np.nan,
            "rest_st": (dt - pd.Timestamp(ls)).days if ls else np.nan,
            # his team's starters this season; the batting team he faces this season
            "tm_gs": T["gs"], "tm_bf": T["bf"], "tm_p": T["p"], "tm_outs": T["outs"],
            "op_bf": O["bf"], "op_k": O["k"], "op_on": O["on"], "op_p": O["p"],
            "month": int(d[5:7]),
        })
    # fold the game in
    for r in G.itertuples():
        P = pit[(s, r.pid)]
        on = r.h + r.bb + r.hbp
        P["k"] += r.k; P["bb"] += r.bb; P["on"] += on; P["er"] += r.er
        if r.gs:
            P["gs"] += 1; P["bf"] += r.bf; P["p"] += r.pitches; P["outs"] += r.outs
            T = team[(s, r.team)]; T["gs"] += 1; T["bf"] += r.bf; T["p"] += r.pitches; T["outs"] += r.outs
            recent[r.pid].append((s, d, r.pitches, r.bf, r.outs)); last_start[r.pid] = d
        else:
            P["rel"] += 1; P["rel_bf"] += r.bf; P["rel_p"] += r.pitches
        last_app[r.pid] = d
        O = opp[(s, r.opp)]; O["bf"] += r.bf; O["k"] += r.k; O["on"] += on; O["p"] += r.pitches
    for r in G.itertuples(): prev[(s, r.pid)] = pit[(s, r.pid)]

R = pd.DataFrame(rows)
R.to_parquet(os.path.join(C, "start_rows.parquet"))
print(f"{len(R):,} starts; mean BF {R.bf.mean():.2f}, outs {R.outs.mean():.2f}, pitches {R.pitches.mean():.1f}")
print(R.groupby("season")[["bf", "outs", "pitches", "k"]].mean().round(2))
