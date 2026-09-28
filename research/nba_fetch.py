"""Pull every NBA game from ESPN into a compact per-game cache (research).

    python3 research/nba_fetch.py                 # 2018-19 .. 2025-26
    python3 research/nba_fetch.py 2024 2025       # season START years

nba.com's own feeds (cdn.nba.com, stats.nba.com) refuse scripted clients, so
ESPN is the source, as it is for the NFL. One `summary` call per game carries
the box score, every play and (usually) the line. The raw ~400KB payload is
reduced on the spot to what the models read, and only that is cached:

  research/.cache/nba/{season}/{gameId}.json
    game: id, date, season, type (2 regular / 3 playoffs), home/away team,
          final score, spread + total (pickcenter, else the core odds route),
          the opening jump ball (both jumpers, which team won it), the first
          made field goal and the first points of any kind (for first basket)
    players: per athlete — team, starter, DNP, position, minutes and the box
             (PTS FGM FGA 3PM 3PA FTM FTA OREB DREB REB AST TO STL BLK PF +/-)

A game already cached is skipped, so re-running resumes. Dates are walked
through the scoreboard (one call a day) to find each game's id and type.
"""
import json, os, re, ssl, sys, time, urllib.request
from concurrent.futures import ThreadPoolExecutor
from datetime import date, timedelta

HERE = os.path.dirname(os.path.abspath(__file__))
CACHE = os.path.join(HERE, ".cache", "nba")
SITE = "https://site.api.espn.com/apis/site/v2/sports/basketball/nba"
CORE = "https://sports.core.api.espn.com/v2/sports/basketball/leagues/nba"
_SSL = ssl._create_unverified_context()


def get(url, tries=5):
    for i in range(tries):
        try:
            with urllib.request.urlopen(url, timeout=30, context=_SSL) as r:
                return json.load(r)
        except Exception:
            time.sleep(1.5 * (i + 1))
    return None


def season_games(start_year):
    """(eventId, date, seasonType) for every regular-season and playoff game of a season."""
    # to late October: the 2019-20 bubble ran to 2020-10-11 and 2020-21's Finals into July;
    # ESPN's own season year keeps overlapping windows from double-counting
    out, d, end = [], date(start_year, 10, 1), date(start_year + 1, 10, 31)
    days = []
    while d <= end:
        days.append(d); d += timedelta(days=1)
    def day(dd):
        j = get(f"{SITE}/scoreboard?dates={dd:%Y%m%d}&limit=50") or {}
        return [(e["id"], dd.isoformat(), e.get("season", {}).get("type")) for e in j.get("events", [])
                if e.get("season", {}).get("year") == start_year + 1]
    with ThreadPoolExecutor(8) as ex:
        for rows in ex.map(day, days):
            out += [r for r in rows if r[2] in (2, 3)]
    return out


def num(v):
    try: return float(v)
    except (TypeError, ValueError): return None


def made(v):
    m = re.match(r"(\d+)-(\d+)", v or "")
    return (int(m.group(1)), int(m.group(2))) if m else (None, None)


def reduce_game(eid, gdate, gtype, season):
    s = get(f"{SITE}/summary?event={eid}")
    if not s or not s.get("boxscore", {}).get("players"):
        return None
    comp = s["header"]["competitions"][0]
    teams = {c["homeAway"]: c for c in comp["competitors"]}
    ab = {k: v["team"]["abbreviation"] for k, v in teams.items()}
    tid = {v["team"]["id"]: v["team"]["abbreviation"] for v in teams.values()}
    game = {"id": eid, "date": gdate, "season": season, "type": gtype,
            "home": ab["home"], "away": ab["away"],
            "home_pts": num(teams["home"].get("score")), "away_pts": num(teams["away"].get("score"))}
    # the line: pickcenter when ESPN sends it, else the core odds route
    pc = (s.get("pickcenter") or [])
    if not pc:
        o = get(f"{CORE}/events/{eid}/competitions/{eid}/odds") or {}
        pc = [i for i in o.get("items", []) if "Live" not in (i.get("provider", {}).get("name") or "")]
    if pc:
        game["spread"] = num(pc[0].get("spread"))            # home team's line (negative = home favoured)
        game["total"] = num(pc[0].get("overUnder"))
        game["book"] = pc[0].get("provider", {}).get("name")
    plays = s.get("plays") or []
    jb = next((p for p in plays[:5] if "jump" in (p.get("type", {}).get("text", "").lower())), None)
    if jb:
        game["jump"] = [a["athlete"]["id"] for a in jb.get("participants", []) if a.get("athlete")][:2]
        game["jump_text"] = jb.get("text")
        game["tip_team"] = tid.get((jb.get("team") or {}).get("id"))
    fg = next((p for p in plays if p.get("scoringPlay") and p.get("shootingPlay") and (p.get("scoreValue") or 0) >= 2
               and "free throw" not in p.get("type", {}).get("text", "").lower()), None)
    fp = next((p for p in plays if p.get("scoringPlay")), None)
    for k, p in (("first_fg", fg), ("first_pts", fp)):
        if p:
            game[k] = {"pid": (p.get("participants") or [{}])[0].get("athlete", {}).get("id"),
                       "team": tid.get((p.get("team") or {}).get("id")), "value": p.get("scoreValue"),
                       "type": p.get("type", {}).get("text"), "clock": p.get("clock", {}).get("displayValue")}
    players = []
    for side in s["boxscore"]["players"]:
        team = side["team"]["abbreviation"]
        st = side["statistics"][0]; lab = st["labels"]
        for a in st["athletes"]:
            if not a.get("athlete", {}).get("id"): continue        # a malformed entry — no one to credit
            row = {"pid": a["athlete"]["id"], "name": a["athlete"]["displayName"], "team": team,
                   "pos": a["athlete"].get("position", {}).get("abbreviation"), "starter": bool(a.get("starter")),
                   "dnp": bool(a.get("didNotPlay")), "reason": a.get("reason")}
            v = dict(zip(lab, a.get("stats") or []))
            if v:
                fgm, fga = made(v.get("FG")); tpm, tpa = made(v.get("3PT")); ftm, fta = made(v.get("FT"))
                row.update(min=num(v.get("MIN")), pts=num(v.get("PTS")), fgm=fgm, fga=fga, tpm=tpm, tpa=tpa, ftm=ftm, fta=fta,
                           oreb=num(v.get("OREB")), dreb=num(v.get("DREB")), reb=num(v.get("REB")), ast=num(v.get("AST")),
                           to=num(v.get("TO")), stl=num(v.get("STL")), blk=num(v.get("BLK")), pf=num(v.get("PF")), pm=num(v.get("+/-")))
            players.append(row)
    return {"game": game, "players": players}


def main():
    years = [int(y) for y in sys.argv[1:]] or list(range(2018, 2026))
    for y in years:
        season = f"{y}-{str(y + 1)[2:]}"
        d = os.path.join(CACHE, str(y)); os.makedirs(d, exist_ok=True)
        games = season_games(y)
        todo = [g for g in games if not os.path.exists(os.path.join(d, f"{g[0]}.json"))]
        print(f"{season}: {len(games)} games, {len(todo)} to fetch", flush=True)
        def one(g):
            try:
                r = reduce_game(g[0], g[1], g[2], season)
            except Exception as e:                                 # one odd game never stops a season
                print(f"  skip {g[0]}: {e!r}", flush=True); return False
            if r:
                with open(os.path.join(d, f"{g[0]}.json"), "w") as f: json.dump(r, f)
            return bool(r)
        ok = 0
        with ThreadPoolExecutor(8) as ex:
            for i, r in enumerate(ex.map(one, todo), 1):
                ok += r
                if i % 250 == 0: print(f"  {i}/{len(todo)}", flush=True)
        print(f"  {season}: cached {ok}/{len(todo)}", flush=True)


if __name__ == "__main__":
    main()
