"""Fetch every regular-season boxscore for the HR replay (research only).

    python3 research/mlb_hr_replay_fetch.py 2025 2026

One row per starting batter per game: batting slot, AB, PA, HR, the opposing
starting pitcher, venue, date. Boxscores rather than player game logs because
they say who STARTED (battingOrder "N00") — a pinch hitter's one AB is not the
bet the board prices — and who started on the mound against him.

Cached per game under MLB_REPLAY_CACHE, so reruns only fetch what's missing.
Writes research/mlb_hr_replay_raw.parquet.
"""
import json
import os
import sys
import time
import ssl
import urllib.request
from concurrent.futures import ThreadPoolExecutor

import pandas as pd

CACHE = os.environ.get("MLB_REPLAY_CACHE", "/tmp/mlb_replay_cache")
OUT = os.path.join(os.path.dirname(__file__), "mlb_hr_replay_raw.parquet")
API = "https://statsapi.mlb.com/api/v1"
# The python.org build ships no CA bundle (see fetch_data.py); certifi does.
try:
    import certifi
    _SSL = ssl.create_default_context(cafile=certifi.where())
except ImportError:
    _SSL = ssl.create_default_context()


def get(url, tries=4):
    for i in range(tries):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": "dong-tool-research"}), timeout=30, context=_SSL) as r:
                return json.load(r)
        except Exception:
            time.sleep(1.5 * (i + 1))
    return None


def schedule(season):
    j = get(f"{API}/schedule?sportId=1&season={season}&gameType=R&fields=dates,date,games,gamePk,status,abstractGameState,venue,name")
    out = []
    for d in (j or {}).get("dates", []):
        for g in d["games"]:
            if g.get("status", {}).get("abstractGameState") == "Final":
                out.append((g["gamePk"], d["date"], g.get("venue", {}).get("name")))
    return out


def box(pk):
    f = f"{CACHE}/{pk}.json"
    if os.path.exists(f):
        return json.load(open(f))
    j = get(f"{API}/game/{pk}/boxscore")
    if j:
        json.dump(j, open(f, "w"))
    return j


def rows_for(season, pk, date, venue):
    j = box(pk)
    if not j:
        return []
    out = []
    t = j["teams"]
    for side, opp in (("home", "away"), ("away", "home")):
        opp_sp = (t[opp].get("pitchers") or [None])[0]
        sp = t[opp]["players"].get(f"ID{opp_sp}", {}).get("stats", {}).get("pitching", {}) if opp_sp else {}
        for key, p in t[side]["players"].items():
            bo = p.get("battingOrder")
            if not bo or not bo.endswith("00"):
                continue                      # starters only
            b = p.get("stats", {}).get("batting", {})
            if not b:
                continue
            out.append({
                "season": season, "date": date, "game_pk": pk, "venue": venue,
                "home": side == "home", "team": t[side]["team"].get("abbreviation") or t[side]["team"]["id"],
                "pid": p["person"]["id"], "name": p["person"]["fullName"],
                "bats": (p.get("person", {}).get("batSide") or {}).get("code"),
                "slot": int(bo[0]), "ab": b.get("atBats", 0), "pa": b.get("plateAppearances", 0),
                "hr": b.get("homeRuns", 0), "opp_sp": opp_sp,
                # the opposing starter's own line in this game, so his HR rate to
                # date can be built (the replay's crude pitcher-vulnerability test)
                "sp_hr": sp.get("homeRuns", 0), "sp_bf": sp.get("battersFaced", 0),
            })
    return out


def main(seasons):
    os.makedirs(CACHE, exist_ok=True)
    rows = []
    for s in seasons:
        games = schedule(s)
        print(f"{s}: {len(games)} final games", flush=True)
        with ThreadPoolExecutor(8) as ex:
            for i, r in enumerate(ex.map(lambda g: rows_for(s, *g), games)):
                rows.extend(r)
                if i % 500 == 0:
                    print(f"  {i}/{len(games)}", flush=True)
    df = pd.DataFrame(rows)
    df.to_parquet(OUT, index=False)
    print(f"wrote {OUT}: {len(df)} starter-games, HR games {(df.hr > 0).mean():.3f}")


if __name__ == "__main__":
    main([int(x) for x in sys.argv[1:]] or [2025, 2026])
