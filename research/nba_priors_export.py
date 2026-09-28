"""Seed the NBA build with last season: nba/priors.json (research -> app).

    python3 research/nba_priors_export.py            # the latest cached season

The models (research/nba_*.py) read each player's season to date PLUS last
season, and his last 10 games (which run across the season break). On opening
night the build has no games of its own yet, so this carries, per player, from
the research cache (nba_fetch.py):
  totals   last season's regular-season minutes and box counts, games, starts
  last10   his last 10 played games (date, min, starter and the box) — the
           recent windows (minutes, form) pick up from here
  first    first-basket counts and starts, and tip jumps / wins (all seasons
           cached — the first-basket model's records are career-long)
Regenerate each summer once the season's games are cached.
"""
import glob, json, os
from collections import defaultdict

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "..", "nba", "priors.json")
BOX = ["min", "pts", "fgm", "fga", "tpm", "tpa", "ftm", "fta", "oreb", "dreb", "reb", "ast", "stl", "blk", "to"]


def main():
    games = []
    for f in glob.glob(os.path.join(HERE, ".cache", "nba", "*", "*.json")):
        d = json.load(open(f)); games.append(d)
    games.sort(key=lambda d: (d["game"]["date"], d["game"]["id"]))
    last = max(d["game"]["season"] for d in games)
    tot = defaultdict(lambda: {k: 0.0 for k in BOX} | {"gp": 0, "gs": 0})
    meta, recent = {}, defaultdict(list)
    fb, starts, tipn, tipw = defaultdict(int), defaultdict(int), defaultdict(int), defaultdict(int)
    for d in games:
        g = d["game"]
        reg = g["type"] == 2
        if reg:
            st = [p for p in d["players"] if p["starter"]]
            if g.get("first_fg") and len(st) == 10:
                for p in st: starts[p["pid"]] += 1
                fb[g["first_fg"]["pid"]] += 1
            jt = {p["pid"]: p["team"] for p in st}
            for j in g.get("jump") or []:
                if j in jt and g.get("tip_team"):
                    tipn[j] += 1; tipw[j] += int(jt[j] == g["tip_team"])
        for p in d["players"]:
            if p["dnp"] or not (p.get("min") or 0) > 0: continue
            meta[p["pid"]] = {"name": p["name"], "team": p["team"], "pos": p.get("pos")}
            row = {"d": g["date"], "st": int(p["starter"]), **{k: p.get(k) or 0 for k in BOX}}
            recent[p["pid"]] = (recent[p["pid"]] + [row])[-10:]
            if reg and g["season"] == last:
                t = tot[p["pid"]]
                for k in BOX: t[k] += p.get(k) or 0
                t["gp"] += 1; t["gs"] += int(p["starter"])
    players = {}
    for pid, m in meta.items():
        if pid not in tot and pid not in recent: continue
        if not recent[pid] or recent[pid][-1]["d"] < f"{int(last[:4]) - 1}-10-01": continue   # gone two seasons
        players[pid] = {**m, "prev": {k: round(v, 1) for k, v in tot[pid].items()} if pid in tot else None,
                        "last10": recent[pid], "fb": fb.get(pid, 0), "starts": starts.get(pid, 0),
                        "tipn": tipn.get(pid, 0), "tipw": tipw.get(pid, 0)}
    json.dump({"season": last, "players": players}, open(OUT, "w"), separators=(",", ":"))
    print(f"wrote {OUT}: {len(players)} players, priors season {last}, {os.path.getsize(OUT) // 1024} KB")


if __name__ == "__main__":
    main()
