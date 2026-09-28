"""Birthdays for /nba: every cached player's birthday record, and whether it matters (research).

    python3 research/nba_fun_data.py          # -> research/nba_fun.json

/nhl/birthdays asks "do birthday boys score?" against the goals model's own
price. This asks it of points: every regular-season game played on his
birthday, the points model's walk-forward projection (nba_ddtd_oos.parquet,
mu_pts) against what he scored, with the days either side as a control.

Birthdates come from ESPN's core athlete record, one call per player, cached
in .cache/nba_dob.json (the roster feed only covers current players).
Per player: [birthday games, points in them] across every cached season.
"""
import json, os
from concurrent.futures import ThreadPoolExecutor
import numpy as np
import pandas as pd
from nba_fetch import get                                   # its SSL context and retries

HERE = os.path.dirname(os.path.abspath(__file__))
DOB = os.path.join(HERE, ".cache", "nba_dob.json")
CORE = "https://sports.core.api.espn.com/v2/sports/basketball/leagues/nba/athletes/"


def dob_of(pid):
    j = get(CORE + str(pid), tries=3)
    return (j or {}).get("dateOfBirth", "")[:10] or None


def main():
    M = pd.read_parquet(os.path.join(HERE, "nba_minutes.parquet"))
    M = M[(M.type == 2) & (~M.dnp)][["gid", "pid", "name", "date", "season", "pts", "tpm"]].copy()
    dob = json.load(open(DOB)) if os.path.exists(DOB) else {}
    todo = [p for p in M.pid.unique() if p not in dob]
    if todo:
        print(f"fetching {len(todo)} birthdates…")
        with ThreadPoolExecutor(8) as ex:
            for p, d in zip(todo, ex.map(dob_of, todo)): dob[p] = d
        json.dump(dob, open(DOB, "w"))
    M["dob"] = M.pid.map(dob)
    M = M[M.dob.notna()].copy()
    print(f"{M.pid.nunique():,} players with a birthdate, {len(M):,} played games")
    # days from his birthday that season (the birthday in the game's own year; wraps handled by picking the nearest)
    d = pd.to_datetime(M.date)
    md = M.dob.str[5:]
    off = np.full(len(M), 999)
    for dy in (-1, 0, 1):
        bd = pd.to_datetime((d.dt.year + dy).astype(str) + "-" + md.where(md != "02-29", "02-28"), errors="coerce")
        o = (d - bd).dt.days.values
        off = np.where(np.abs(o) < np.abs(off), o, off)
    M["off"] = off
    on = M[M.off == 0]
    rec = {p: [int(len(r)), int(r.pts.sum())] for p, r in on.groupby("pid")}
    # does it matter: the points model's walk-forward projection, on the day and the three days either side
    O = pd.read_parquet(os.path.join(HERE, "nba_ddtd_oos.parquet"))[["gid", "pid", "mu_pts"]]
    G = M.merge(O, on=["gid", "pid"])
    def grade(x):
        r = x.pts - x.mu_pts
        return {"games": int(len(x)), "pts": round(float(x.pts.mean()), 2), "proj": round(float(x.mu_pts.mean()), 2),
                "ratio": round(float(x.pts.sum() / x.mu_pts.sum()), 3), "z": round(float(r.mean() / (r.std() / np.sqrt(len(x)))), 2)}
    st = {"on": grade(G[G.off == 0]), "near": grade(G[(G.off.abs() <= 3) & (G.off != 0)]), "all": grade(G),
          "seasons": f"{G.season.min()} to {G.season.max()}"}
    print(f"on his birthday:   {st['on']}")
    print(f"the days around:   {st['near']}")
    print(f"every game:        {st['all']}")
    json.dump({"through": M.season.max(), "bday": {"rec": rec, "stats": st}}, open(os.path.join(HERE, "nba_fun.json"), "w"), separators=(",", ":"))
    print(f"wrote nba_fun.json: {len(rec)} players with a birthday game")


if __name__ == "__main__":
    main()
