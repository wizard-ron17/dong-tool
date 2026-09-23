"""Every goal of every game, in order — for first / last / period / PP goal markets.

api-web /score/{date} lists each game's goals with scorer, period, time,
strength and goalModifier (empty-net, penalty-shot, own-goal). Shootout
"goals" are not goals and are dropped by the analysis, not here.

Cached per date as $NHL_CACHE/{season}/{date}/goals.json.

    python3 research/nhl_goal_seq_fetch.py
"""
import json, os, glob, subprocess, time

CACHE = os.environ.get("NHL_CACHE") or "/tmp/nhl-cache"


def get(url, tries=4):
    for i in range(1, tries + 1):
        r = subprocess.run(["curl", "-sL", "--max-time", "30", "-H", "User-Agent: dong-tool/1.0", url],
                           capture_output=True, text=True)
        if r.returncode == 0 and r.stdout.strip().startswith("{"):
            try:
                return json.loads(r.stdout)
            except json.JSONDecodeError:
                pass
        time.sleep(0.6 * i)
    return None


if __name__ == "__main__":
    n = 0
    for f in sorted(glob.glob(os.path.join(CACHE, "20*", "games.json"))):
        season = int(os.path.basename(os.path.dirname(f)))
        dates = sorted({g["date"] for g in json.load(open(f))})
        for i, d in enumerate(dates, 1):
            p = os.path.join(CACHE, str(season), d, "goals.json")
            if not os.path.exists(p):
                sc = get(f"https://api-web.nhle.com/v1/score/{d}")
                if sc is None:
                    continue
                out = []
                for g in sc.get("games", []):
                    if g.get("gameType") != 2:
                        continue
                    out.append({"gid": g["id"], "away": g["awayTeam"]["abbrev"], "home": g["homeTeam"]["abbrev"],
                                "as": g["awayTeam"].get("score"), "hs": g["homeTeam"].get("score"),
                                "goals": [{"pid": x.get("playerId"), "team": x.get("teamAbbrev", {}).get("default") if isinstance(x.get("teamAbbrev"), dict) else x.get("teamAbbrev"),
                                           "per": (x.get("periodDescriptor") or {}).get("number"),
                                           "ptype": (x.get("periodDescriptor") or {}).get("periodType"),
                                           "t": x.get("timeInPeriod"), "str": x.get("strength"),
                                           "mod": x.get("goalModifier")} for x in g.get("goals", [])]})
                os.makedirs(os.path.dirname(p), exist_ok=True)
                json.dump(out, open(p, "w"))
                time.sleep(0.05)
            n += 1
            if i % 50 == 0:
                print(f"{season}: {i}/{len(dates)} dates", flush=True)
    print(f"done: {n} dates")
