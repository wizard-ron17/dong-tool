"""Who played whom, per date — needed for the opponent shots-allowed term.

Cheap on its own: /v1/schedule/{date} answers a whole WEEK and names the next
one, so a season costs ~27 requests rather than one per date.

    python3 research/nhl_sched.py
"""
import json, os, sys, time, subprocess

CACHE = os.environ.get("NHL_CACHE") or "/tmp/nhl-cache"
WEB = "https://api-web.nhle.com/v1"
REST = "https://api.nhle.com/stats/rest/en"
SEASONS = [20222023, 20232024, 20242025, 20252026]


def get(url, tries=4):
    for i in range(1, tries + 1):
        r = subprocess.run(["curl", "-sL", "--max-time", "40", "-H",
                            "User-Agent: dong-tool/1.0", url], capture_output=True, text=True)
        if r.returncode == 0 and r.stdout.strip().startswith("{"):
            try:
                return json.loads(r.stdout)
            except json.JSONDecodeError:
                pass
        time.sleep(0.6 * i)
    raise RuntimeError(url)


def build(season):
    p = os.path.join(CACHE, str(season), "games.json")
    if os.path.exists(p):
        return json.load(open(p))
    meta = [s for s in get(f"{REST}/season")["data"] if s["id"] == season][0]
    cur, end, games = meta["startDate"][:10], meta["regularSeasonEndDate"][:10], []
    guard = 0
    while cur and cur <= end and guard < 60:
        wk = get(f"{WEB}/schedule/{cur}")
        for day in wk.get("gameWeek", []):
            for g in day.get("games", []):
                if g.get("gameType") == 2:
                    games.append({"date": day["date"], "gid": g["id"],
                                  "away": g["awayTeam"]["abbrev"], "home": g["homeTeam"]["abbrev"]})
        nxt = wk.get("nextStartDate")
        cur = nxt if nxt and nxt > cur else None
        guard += 1
    os.makedirs(os.path.dirname(p), exist_ok=True)
    json.dump(games, open(p, "w"))
    print(f"{season}: {len(games)} games")
    return games


if __name__ == "__main__":
    for s in ([int(a) for a in sys.argv[1:]] or SEASONS):
        build(s)
