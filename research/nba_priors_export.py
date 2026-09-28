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
  dr/drd   games since his last made three / 3+ threes / double-double /
           triple-double (regular-season games played) and starts since his
           last first basket, with each one's date — Due's droughts run
           across the summer. scripts/nba-state.js drStep counts the same way.
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
    reg10 = defaultdict(list)       # his last 10 regular-season games (the stats engine's recent form)
    cats40 = defaultdict(str)       # his last 40 regular-season games: how many of pts/reb/ast/stl/blk hit 10, one digit a game
    fb, starts, tipn, tipw = defaultdict(int), defaultdict(int), defaultdict(int), defaultdict(int)
    dr, drd = defaultdict(dict), defaultdict(dict)

    def step(pid, k, hit, date):                                     # scripts/nba-state.js drStep
        if hit: dr[pid][k] = 0; drd[pid][k] = date
        elif dr[pid].get(k) is not None: dr[pid][k] += 1
    for d in games:
        g = d["game"]
        reg = g["type"] == 2
        if reg:
            # starters who played, as scripts/nba-state.js counts them (ESPN lists the odd 0-minute "starter")
            st = [p for p in d["players"] if p["starter"] and not p["dnp"] and (p.get("min") or 0) > 0]
            if g.get("first_fg") and len(st) == 10:
                for p in st:
                    starts[p["pid"]] += 1; step(p["pid"], "fb", p["pid"] == g["first_fg"]["pid"], g["date"])
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
            if reg:
                reg10[p["pid"]] = (reg10[p["pid"]] + [{k: p.get(k) or 0 for k in ("min", "pts", "reb", "ast", "stl", "blk", "tpm")}])[-10:]
                n10 = sum(1 for k in ("pts", "reb", "ast", "stl", "blk") if (p.get(k) or 0) >= 10)
                cats40[p["pid"]] = (cats40[p["pid"]] + str(min(n10, 5)))[-40:]
                t3 = p.get("tpm") or 0
                for k, hit in (("t1", t3 >= 1), ("t3", t3 >= 3), ("dd", n10 >= 2), ("td", n10 >= 3)): step(p["pid"], k, hit, g["date"])
            if reg and g["season"] == last:
                t = tot[p["pid"]]
                for k in BOX: t[k] += p.get(k) or 0
                t["gp"] += 1; t["gs"] += int(p["starter"])
    players = {}
    for pid, m in meta.items():
        if pid not in tot and pid not in recent: continue
        if not recent[pid] or recent[pid][-1]["d"] < f"{int(last[:4]) - 1}-10-01": continue   # gone two seasons
        players[pid] = {**m, "prev": {k: round(v, 1) for k, v in tot[pid].items()} if pid in tot else None,
                        "last10": recent[pid], "reg10": reg10.get(pid, []), "cats40": cats40.get(pid, ""), "fb": fb.get(pid, 0), "starts": starts.get(pid, 0),
                        "tipn": tipn.get(pid, 0), "tipw": tipw.get(pid, 0), "dr": dr.get(pid, {}), "drd": drd.get(pid, {})}
    json.dump({"season": last, "players": players}, open(OUT, "w"), separators=(",", ":"))
    print(f"wrote {OUT}: {len(players)} players, priors season {last}, {os.path.getsize(OUT) // 1024} KB")


if __name__ == "__main__":
    main()
