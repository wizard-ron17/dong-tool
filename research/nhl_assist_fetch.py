"""Every goal of four seasons WITH its assisters — for the Pairs scorer -> assister stacks.

nhl_goal_seq_fetch.py kept scorer, period and strength but dropped the assists.
Cached per date as $NHL_CACHE/{season}/{date}/goals_a.json:
  [{gid, away, home, goals: [{pid, team, a: [pid, ...], str, mod, ptype}]}]

    python3 research/nhl_assist_fetch.py
"""
import json, os, glob, sys
from concurrent.futures import ThreadPoolExecutor
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from nhl_goal_seq_fetch import get, CACHE


def one(args):
    season, d = args
    p = os.path.join(CACHE, str(season), d, "goals_a.json")
    if os.path.exists(p): return 0
    sc = get(f"https://api-web.nhle.com/v1/score/{d}")
    if sc is None: return 0
    out = []
    for g in sc.get("games", []):
        if g.get("gameType") != 2: continue
        out.append({"gid": g["id"], "away": g["awayTeam"]["abbrev"], "home": g["homeTeam"]["abbrev"],
                    "goals": [{"pid": x.get("playerId"),
                               "team": x["teamAbbrev"]["default"] if isinstance(x.get("teamAbbrev"), dict) else x.get("teamAbbrev"),
                               "a": [y.get("playerId") for y in x.get("assists", [])],
                               "str": x.get("strength"), "mod": x.get("goalModifier"),
                               "ptype": (x.get("periodDescriptor") or {}).get("periodType")} for x in g.get("goals", [])]})
    os.makedirs(os.path.dirname(p), exist_ok=True)
    json.dump(out, open(p, "w"))
    return 1


if __name__ == "__main__":
    jobs = []
    for f in sorted(glob.glob(os.path.join(CACHE, "20*", "games.json"))):
        season = int(os.path.basename(os.path.dirname(f)))
        jobs += [(season, d) for d in sorted({g["date"] for g in json.load(open(f))})]
    with ThreadPoolExecutor(6) as ex:
        n = sum(ex.map(one, jobs))
    print(f"fetched {n} of {len(jobs)} dates")
