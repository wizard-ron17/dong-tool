"""Every career milestone reached in 2025-26 — the Milestones Results tab's history.

The build logs milestones as they're reached (scripts/nhl-fun.js); this fills
in the season before it existed. Career totals through 2025-26 come from
nhl_fun.json; subtracting the season's own game rows gives where each player
started, and walking his games in order finds the night he crossed each rung.
Rungs match MS_RUNGS in scripts/nhl-fun.js.

    python3 research/nhl_milestones_backfill.py    # writes nhl/milestones-20252026.json (loaded by the Results tab)
"""
import glob, json, os
import pandas as pd

HERE = os.path.dirname(os.path.abspath(__file__))
CACHE = os.environ.get("NHL_CACHE") or "/tmp/nhl-cache"
SEASON = 20252026
RUNGS = {"g": (50, 50), "a": (100, 100), "pts": (100, 100), "gp": (100, 100), "w": (50, 50)}   # every, min

if __name__ == "__main__":
    fun = json.load(open(os.path.join(HERE, "nhl_fun.json")))
    games = {g["date"] + "|" + t: g for f in glob.glob(os.path.join(CACHE, str(SEASON), "games.json"))
             for g in json.load(open(f)) for t in (g.get("away"), g.get("home"))}
    # skaters: one row per game played
    P = pd.read_parquet(os.path.join(HERE, "nhl_points.parquet"))
    P = P[P.season == SEASON].drop_duplicates(["pid", "date"]).sort_values("date")
    rows = [(r.date, r.pid, r["name"], r.team, r.opp, {"gp": 1, "g": r.goals, "a": r.a, "pts": r.pts}) for _, r in P.iterrows()]
    # goalies: the warehouse's per-date rows
    for f in sorted(glob.glob(os.path.join(CACHE, str(SEASON), "*", "goalie.json"))):
        d = f.split(os.sep)[-2]
        for r in json.load(open(f)):
            team = (r.get("teamAbbrevs") or "").split(",")[-1].strip()
            g = games.get(d + "|" + team, {})
            opp = g.get("home") if g.get("away") == team else g.get("away")
            rows.append((d, r["playerId"], r["goalieFullName"], team, opp or "", {"ggp": r.get("gamesPlayed", 0), "w": r.get("wins", 0)}))
    rows.sort(key=lambda x: x[0])
    season = {}
    for d, pid, *_ , inc in rows:
        e = season.setdefault(pid, {})
        for k, v in inc.items(): e[k] = e.get(k, 0) + v
    start = {}
    for pid, e in season.items():
        s = str(pid)
        if "ggp" in e and s in fun["goalies"]:
            n, gp, w, so = fun["goalies"][s]
            start[pid] = {"gp": gp - e["ggp"], "w": w - e["w"]}
        elif s in fun["career"]:
            n, pos, gp, g, a, pts = fun["career"][s]
            start[pid] = {"gp": gp - e.get("gp", 0), "g": g - e.get("g", 0), "a": a - e.get("a", 0), "pts": pts - e.get("pts", 0)}
    cur = {pid: dict(v) for pid, v in start.items()}
    events = []
    for d, pid, name, team, opp, inc in rows:
        if pid not in cur: continue
        c = cur[pid]
        for k, v in inc.items():
            k = "gp" if k == "ggp" else k
            if k not in c or not v: continue
            every, lo = RUNGS[k]
            before, after = c[k], c[k] + v
            for n in range(max(lo, (before // every + 1) * every), after + 1, every):
                events.append({"pid": int(pid), "name": name, "team": team, "opp": opp, "stat": k, "n": n, "date": d})
            c[k] = after
    # compact rows — the Results tab fetches this only when it's opened
    cols = ["pid", "name", "team", "opp", "stat", "n", "date"]
    out = {"season": SEASON, "cols": cols, "events": [[e[c] for c in cols] for e in sorted(events, key=lambda e: e["date"])]}
    json.dump(out, open(os.path.join(HERE, "..", "nhl", f"milestones-{SEASON}.json"), "w"), separators=(",", ":"))
    print(f"{len(events)} milestones reached in {SEASON}: " + ", ".join(f"{k} {sum(e['stat'] == k for e in events)}" for k in RUNGS))
    for e in sorted(events, key=lambda e: -e["n"])[:12]: print("  ", e["date"], e["name"], e["stat"], e["n"])
