"""Is the skater-game dataset clean? Checked against the NHL's own scoresheets.

  1. one row per (player, date) — no repeats
  2. every team-game dresses 18 skaters
  3. each team-game's goals in the data == the goals on the scoresheet
     (research/nhl_goal_seq_fetch.py: every goal, shootouts excluded)
  4. every goal's scorer has a row, on the club he scored for

Run on the loaded rows (before the model's 5-game history filter), and on the
parquet the models read.

    python3 research/nhl_data_check.py
"""
import glob, json, os, sys
import pandas as pd
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from nhl_sog_data import load, CACHE

if __name__ == "__main__":
    sk, _ = load()
    sk["team"] = [tg if tg else t.split(",")[-1].strip() for tg, t in zip(sk.team_g, sk.teams)]
    print(f"loaded rows: {len(sk):,}  ({sk.team_g.notna().mean():.1%} from per-game files)")
    dup = sk.duplicated(["pid", "date"]).sum()
    print(f"1. repeated player-dates: {dup}")
    act, scorers = {}, []
    for f in glob.glob(os.path.join(CACHE, "20*", "*", "goals.json")):
        date = f.split(os.sep)[-2]
        for g in json.load(open(f)):
            for side in ("away", "home"):
                act[(date, g[side])] = 0
            for x in g["goals"]:
                if x.get("ptype") == "SO" or not x.get("pid"): continue
                act[(date, x["team"])] = act.get((date, x["team"]), 0) + 1
                scorers.append((date, x["pid"], x["team"]))
    tg = sk.groupby(["date", "team"]).agg(goals=("goals", "sum"), n=("pid", "size")).reset_index()
    tg = tg[[(d, t) in act for d, t in zip(tg.date, tg.team)]]
    print(f"2. skaters per team-game: {tg.n.value_counts().sort_index().to_dict()}")
    tg["act"] = [act[(d, t)] for d, t in zip(tg.date, tg.team)]
    bad = tg[tg.goals != tg.act]
    print(f"3. team-games {len(tg):,}; goal totals off the scoresheet: {len(bad)}")
    if len(bad): print(bad.head(10).to_string())
    rows = {(d, p): t for d, p, t in zip(sk.date, sk.pid, sk.team)}
    miss = [s for s in scorers if (s[0], s[1]) not in rows]
    wrong = [s for s in scorers if (s[0], s[1]) in rows and rows[(s[0], s[1])] != s[2]]
    print(f"4. goals {len(scorers):,}: scorer missing {len(miss)}, on the wrong club {len(wrong)}")
    if miss[:5]: print("   e.g. missing", miss[:5])
    if wrong[:5]: print("   e.g. wrong club", wrong[:5])
    P = pd.read_parquet(os.path.join(HERE, "nhl_sog.parquet"))
    print(f"parquet: {len(P):,} rows, repeated player-dates {P.duplicated(['pid', 'date']).sum()}")
