"""Per-game NHL skater + team data for the shots-on-goal model.

The stats warehouse only aggregates, so per-GAME rows come from partitioning
every report to a single date (`gameDate >= D and gameDate <= D`), which makes
each row one player's one game — `gamesPlayed == 1` on every row is the check.

Three skater reports are needed because no single one carries the lot:
    summary    shots on goal, goals, assists, TOI, position
    realtime   totalShotAttempts (Corsi/ICF), shotAttemptsBlocked, missedShots
    timeonice  ppTimeOnIcePerGame, evTimeOnIcePerGame, shifts
plus team/summary for shots for/against, which becomes the opponent's
shots-allowed matchup term.

`limit` is capped at 100 rows however large a number you send (verified again
here), so a 12-game night needs five pages per report. A season is ~1,400
requests; everything is cached to the scratchpad so a re-run costs nothing.

    python3 research/nhl_fetch.py            # default seasons
    python3 research/nhl_fetch.py 20242025   # one season
"""
import json, os, sys, time, urllib.parse, subprocess

SEASONS = [20222023, 20232024, 20242025, 20252026]
CACHE = os.environ.get("NHL_CACHE") or "/tmp/nhl-cache"
REST = "https://api.nhle.com/stats/rest/en"
WEB = "https://api-web.nhle.com/v1"
SKATER_REPORTS = ["summary", "realtime", "timeonice"]


def get(url, tries=4):
    """curl, not urllib: the warehouse 403s on urllib's user-agent."""
    for i in range(1, tries + 1):
        r = subprocess.run(["curl", "-sL", "--max-time", "40", "-H",
                            "User-Agent: dong-tool/1.0", url],
                           capture_output=True, text=True)
        if r.returncode == 0 and r.stdout.strip().startswith("{"):
            try:
                return json.loads(r.stdout)
            except json.JSONDecodeError:
                pass
        time.sleep(0.6 * i)
    raise RuntimeError(f"failed: {url}")


def cached(key, fn):
    p = os.path.join(CACHE, key + ".json")
    os.makedirs(os.path.dirname(p), exist_ok=True)
    if os.path.exists(p):
        with open(p) as f:
            return json.load(f)
    v = fn()
    with open(p, "w") as f:
        json.dump(v, f)
    return v


def paged(path, exp):
    """Every row for one cayenne expression, 100 at a time."""
    out, start = [], 0
    while True:
        q = urllib.parse.quote(exp, safe="")
        j = get(f"{REST}/{path}?limit=100&start={start}&cayenneExp={q}")
        rows = j.get("data") or []
        out.extend(rows)
        if len(rows) < 100 or len(out) >= (j.get("total") or 0):
            return out
        start += 100
        time.sleep(0.05)


def season_dates(season):
    """Dates with a regular-season game, walked off the schedule feed."""
    def pull():
        meta = [s for s in get(f"{REST}/season")["data"] if s["id"] == season][0]
        cur, end, dates = meta["startDate"][:10], meta["regularSeasonEndDate"][:10], []
        guard = 0
        while cur and cur <= end and guard < 60:
            wk = get(f"{WEB}/schedule/{cur}")
            for day in wk.get("gameWeek", []):
                if any(g.get("gameType") == 2 for g in day.get("games", [])):
                    dates.append(day["date"])
            nxt = wk.get("nextStartDate")
            cur = nxt if nxt and nxt > cur else None
            guard += 1
        return sorted(d for d in set(dates) if d <= end)
    return cached(f"{season}/dates", pull)


def fetch_season(season):
    dates = season_dates(season)
    print(f"{season}: {len(dates)} dates")
    n = 0
    for i, d in enumerate(dates, 1):
        exp = f'gameDate>="{d}" and gameDate<="{d}" and gameTypeId=2'
        for rep in SKATER_REPORTS:
            rows = cached(f"{season}/{d}/{rep}", lambda p=rep, e=exp: paged(f"skater/{p}", e))
            n += len(rows)
        cached(f"{season}/{d}/team", lambda e=exp: paged("team/summary", e))
        # goalie/summary: saves, shots against, goals against, gamesStarted — the
        # saves / goals-allowed model (nhl_saves_data.py)
        cached(f"{season}/{d}/goalie", lambda e=exp: paged("goalie/summary", e))
        if i % 25 == 0:
            print(f"   {i}/{len(dates)} dates, {n:,} skater-rows")
    print(f"   done: {n:,} skater-rows across {len(dates)} dates")


if __name__ == "__main__":
    seasons = [int(a) for a in sys.argv[1:]] or SEASONS
    for s in seasons:
        fetch_season(s)
