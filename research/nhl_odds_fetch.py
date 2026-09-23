"""Closing game odds from ESPN, for the goals-allowed (and later, goals) models.

The NHL feed has no betting lines, and goals allowed was close to a null
without one (nhl_saves.py). ESPN keeps each game's lines on its core API well
after the game: total with its over/under prices and both moneylines, open and
close, back to at least 2022.

    scoreboard?dates=YYYYMMDD            one request per date: event ids + teams
    core .../events/{id}/competitions/{id}/odds   one per game: the lines

Cached per date under $NHL_CACHE/{season}/{date}/odds.json, so a re-run is free.

    python3 research/nhl_odds_fetch.py
"""
import json, os, sys, time, subprocess, glob

CACHE = os.environ.get("NHL_CACHE") or "/tmp/nhl-cache"
SB = "https://site.api.espn.com/apis/site/v2/sports/hockey/nhl/scoreboard?dates={}"
ODDS = "https://sports.core.api.espn.com/v2/sports/hockey/leagues/nhl/events/{0}/competitions/{0}/odds"
# ESPN abbreviations that differ from the NHL's
ESPN2NHL = {"LA": "LAK", "NJ": "NJD", "SJ": "SJS", "TB": "TBL", "UTAH": "UTA", "WSH": "WSH", "MON": "MTL"}


def get(url, tries=4):
    for i in range(1, tries + 1):
        r = subprocess.run(["curl", "-s", "--max-time", "30", url], capture_output=True, text=True)
        if r.returncode == 0 and r.stdout.strip().startswith("{"):
            try:
                return json.loads(r.stdout)
            except json.JSONDecodeError:
                pass
        time.sleep(0.8 * i)
    return None


def american(x):
    try:
        return float(str(x).replace("+", ""))
    except (TypeError, ValueError):
        return None


def line(item):
    """Closing lines off one provider's item, falling back to its headline numbers."""
    c = item.get("close") or {}
    h, a = item.get("homeTeamOdds") or {}, item.get("awayTeamOdds") or {}
    ml = lambda side: american(((side.get("close") or {}).get("moneyLine") or {}).get("american")) or side.get("moneyLine")
    return {
        "provider": (item.get("provider") or {}).get("name"),
        "total": american((c.get("total") or {}).get("american")) or item.get("overUnder"),
        "over": american((c.get("over") or {}).get("american")) or item.get("overOdds"),
        "under": american((c.get("under") or {}).get("american")) or item.get("underOdds"),
        "ml_home": ml(h), "ml_away": ml(a),
    }


def fetch_date(season, date):
    p = os.path.join(CACHE, str(season), date, "odds.json")
    if os.path.exists(p):
        return json.load(open(p))
    sb = get(SB.format(date.replace("-", "")))
    if sb is None:
        return None
    out = []
    for ev in sb.get("events", []):
        comp = ev["competitions"][0]
        teams = {c["homeAway"]: ESPN2NHL.get(c["team"]["abbreviation"], c["team"]["abbreviation"]) for c in comp["competitors"]}
        od = get(ODDS.format(ev["id"]))
        items = (od or {}).get("items") or []
        if not items:
            continue
        out.append({"espn": ev["id"], "home": teams.get("home"), "away": teams.get("away"), **line(items[0])})
        time.sleep(0.05)
    os.makedirs(os.path.dirname(p), exist_ok=True)
    json.dump(out, open(p, "w"))
    return out


if __name__ == "__main__":
    n = 0
    for f in sorted(glob.glob(os.path.join(CACHE, "20*", "games.json"))):
        season = int(os.path.basename(os.path.dirname(f)))
        dates = sorted({g["date"] for g in json.load(open(f))})
        for i, d in enumerate(dates, 1):
            rows = fetch_date(season, d) or []
            n += len(rows)
            if i % 25 == 0:
                print(f"{season}: {i}/{len(dates)} dates, {n:,} games with lines", flush=True)
    print(f"done: {n:,} games with lines")
