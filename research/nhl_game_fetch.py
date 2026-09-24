"""Per-game skater rows, re-pulled clean — the fix for nhl_fetch.py's paging.

nhl_fetch.py paged each date's reports 100 rows at a time WITHOUT a sort, and
the warehouse doesn't hold its order between pages: rows came back twice and
others never came (555 duplicate player-games; 925 goals whose scorer had no
row at all). And its date-partitioned rows name a traded player's clubs for the
whole season, so the club he played for that night was guessed — wrongly for
587 goals.

This pulls the same three reports in the warehouse's per-GAME mode
(isGame=true), which carries gameId, teamAbbrev, opponentTeamAbbrev and
homeRoad on every row — no guessing — sorted by playerId + gameId so pages are
stable, and checks every date: unique (player, game) rows, count == the
report's own total, and all three reports covering the same player-games.
A date that fails is retried, then reported, never cached.

Cached as $NHL_CACHE/{season}/{date}/g_{summary,realtime,timeonice}.json.

    python3 research/nhl_game_fetch.py            # all four seasons
"""
import json, os, sys, time, urllib.parse
from concurrent.futures import ThreadPoolExecutor
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from nhl_fetch import get, season_dates, CACHE, REST, SEASONS

SORT = urllib.parse.quote(json.dumps([{"property": "playerId", "direction": "ASC"}, {"property": "gameId", "direction": "ASC"}]))


def pull(rep, d):
    exp = urllib.parse.quote(f'gameDate>="{d}" and gameDate<="{d}" and gameTypeId=2', safe="")
    out, start, total = [], 0, None
    while True:
        j = get(f"{REST}/skater/{rep}?isAggregate=false&isGame=true&limit=100&start={start}&sort={SORT}&cayenneExp={exp}")
        rows = j.get("data") or []
        total = j.get("total", total)
        out.extend(rows)
        if len(rows) < 100 or len(out) >= (total or 0): break
        start += 100
    return out, total


def one(args):
    season, d = args
    paths = {rep: os.path.join(CACHE, str(season), d, f"g_{rep}.json") for rep in ("summary", "realtime", "timeonice")}
    if all(os.path.exists(p) for p in paths.values()): return (d, "cached")
    for attempt in range(3):
        got, ok = {}, True
        for rep in paths:
            rows, total = pull(rep, d)
            keys = [(r["playerId"], r["gameId"]) for r in rows]
            if len(set(keys)) != len(keys) or len(rows) != total: ok = False; break
            got[rep] = rows
        if ok:
            ks = [{(r["playerId"], r["gameId"]) for r in got[rep]} for rep in got]
            ok = ks[0] == ks[1] == ks[2]
        if ok:
            os.makedirs(os.path.dirname(paths["summary"]), exist_ok=True)
            for rep, rows in got.items(): json.dump(rows, open(paths[rep], "w"))
            return (d, f"{len(got['summary'])} rows")
        time.sleep(2 * (attempt + 1))
    return (d, "FAILED")


if __name__ == "__main__":
    jobs = [(s, d) for s in SEASONS for d in season_dates(s)]
    print(f"{len(jobs)} dates", flush=True)
    bad = []
    with ThreadPoolExecutor(6) as ex:
        for i, (d, st) in enumerate(ex.map(one, jobs), 1):
            if st == "FAILED": bad.append(d)
            if i % 100 == 0: print(f"  {i}/{len(jobs)}", flush=True)
    print(f"done — {len(bad)} failed: {bad}")
