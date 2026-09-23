"""nhl/pairs-20252026.json — last season's goals for /nhl/pairs before this one has any.

Pairs counts who scores together from the season's goal archive (players.json).
On opening night that archive is empty, so the page falls back to this: every
2025-26 regular-season goal, in order, with its assisters — built once from the
research cache (research/nhl_assist_fetch.py), committed, never rebuilt.

  cols  [date, gameId, team, scorer, [assisters], strength, modifier]
  p     pid -> [name, position, last club]

    python3 research/nhl_pairs_season.py
"""
import glob, json, os
import pandas as pd

HERE = os.path.dirname(os.path.abspath(__file__))
CACHE = os.environ.get("NHL_CACHE") or "/tmp/nhl-cache"
SEASON = 20252026

if __name__ == "__main__":
    rows = []
    for f in sorted(glob.glob(os.path.join(CACHE, str(SEASON), "*", "goals_a.json"))):
        d = f.split(os.sep)[-2]
        for g in sorted(json.load(open(f)), key=lambda x: x["gid"]):
            for x in g["goals"]:
                if x.get("ptype") == "SO" or not x.get("pid"): continue
                rows.append([d, g["gid"], x["team"], x["pid"], [a for a in x.get("a") or [] if a], x.get("str"), x.get("mod") or None])
    S = pd.read_parquet(os.path.join(HERE, "nhl_sog.parquet"))
    S = S[S.season == SEASON].sort_values("date").drop_duplicates("pid", keep="last")
    need = {r[3] for r in rows} | {a for r in rows for a in r[4]}
    p = {str(r.pid): [r["name"], r.pos, r.team] for _, r in S.iterrows() if r.pid in need}
    # goalies assist too, and the skater dataset doesn't carry them
    fun = json.load(open(os.path.join(HERE, "nhl_fun.json")))
    for pid in need - {int(k) for k in p}:
        if str(pid) in fun["goalies"]: p[str(pid)] = [fun["goalies"][str(pid)][0], "G", ""]
        elif str(pid) in fun["career"]: p[str(pid)] = [fun["career"][str(pid)][0], fun["career"][str(pid)][1], ""]
    out = {"season": SEASON, "cols": ["date", "gameId", "team", "pid", "ast", "str", "mod"], "goals": rows, "p": p}
    path = os.path.join(HERE, "..", "nhl", f"pairs-{SEASON}.json")
    json.dump(out, open(path, "w"), separators=(",", ":"))
    print(f"{len(rows):,} goals, {len(p)} names ({len(need - {int(k) for k in p})} missing) — {os.path.getsize(path) // 1024} KB")
