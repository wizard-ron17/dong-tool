"""Career touchdown totals, for the Milestones watch list.

The Picks pipeline only loads 2016 onward, which is nowhere near enough to know
a veteran's career total. This walks nflverse's weekly player stats back to
1999 — 7 MB a season against 90 MB for play-by-play, so the whole span costs
less than three seasons of pbp — and writes a small JSON the build reads.

Scoring touchdowns only (rushing + receiving). Passing touchdowns are a
different achievement and would put quarterbacks on a list that is otherwise
about who reaches the end zone, the same way MLB's milestone board is about
hitters rather than pitchers.

Re-run after each season completes:

  python3 research/career_tds.py   ->  research/career_tds.json
"""
import io
import json
import os
import ssl
import urllib.request

import pandas as pd

try:
    import certifi
    _SSL = ssl.create_default_context(cafile=certifi.where())
except ImportError:
    _SSL = ssl.create_default_context()

HERE = os.path.dirname(__file__)
OUT = os.path.join(HERE, "career_tds.json")
REL = "https://github.com/nflverse/nflverse-data/releases/download"
FIRST, LAST = 1999, 2025
MIN_CAREER = 15          # below this nobody is chasing anything
UA = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36")
# Hundreds only, matching the MLB board's 100/200/300. Quarter-rungs (25/50/75)
# were tried and dropped: they filled the board with "1 from 25", which is a
# number nobody is chasing. 100 career touchdowns is the achievement.
RUNGS = [100, 200]
COLS = ["player_id", "player_display_name", "player_name", "season", "season_type",
        "team", "position", "rushing_tds", "receiving_tds"]


def season(year):
    url = f"{REL}/stats_player/stats_player_week_{year}.csv"
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=180, context=_SSL) as r:
        raw = r.read()
    d = pd.read_csv(io.BytesIO(raw), low_memory=False)
    have = [c for c in COLS if c in d.columns]
    d = d[have].copy()
    if "season_type" in d:
        d = d[d.season_type == "REG"]          # regular season only, as records are kept
    for c in ("rushing_tds", "receiving_tds"):
        if c not in d:
            d[c] = 0
    d["tds"] = d.rushing_tds.fillna(0) + d.receiving_tds.fillna(0)
    # display name where the feed has it, short name otherwise
    d["name"] = d.get("player_display_name", pd.Series(dtype=object)).fillna(d.get("player_name"))
    if "team" not in d: d["team"] = ""
    if "position" not in d: d["position"] = ""
    return d


def main():
    frames = []
    for y in range(FIRST, LAST + 1):
        try:
            frames.append(season(y))
            print(f"  {y}", flush=True)
        except Exception as e:
            print(f"  {y} FAILED: {e}", flush=True)
    d = pd.concat(frames, ignore_index=True)
    d = d[d.player_id.notna()]

    g = d.groupby("player_id").agg(
        tds=("tds", "sum"),
        name=("name", "last"),
        team=("team", "last"),
        pos=("position", "last"),
        last_season=("season", "max"),
        first_season=("season", "min"),
    ).reset_index()
    g["tds"] = g.tds.astype(int)
    g = g[g.tds >= MIN_CAREER].sort_values("tds", ascending=False)
    print(f"\nplayers with {MIN_CAREER}+ career scoring TDs: {len(g):,}")
    print(g.head(8)[["name", "pos", "tds", "last_season"]].to_string(index=False))

    active = g[g.last_season >= LAST]
    print(f"\nactive into {LAST}: {len(active):,}")
    out = {
        "note": ("Career rushing + receiving touchdowns, regular season, "
                 f"{FIRST}-{LAST}. Passing TDs excluded on purpose — this board "
                 "is about reaching the end zone."),
        "through": LAST,
        "rungs": RUNGS,
        "min": MIN_CAREER,
        "players": {r.player_id: {"n": r.name, "t": int(r.tds), "tm": r.team,
                                  "p": r.pos, "ls": int(r.last_season)}
                    for r in g.itertuples(index=False)},
    }
    with open(OUT, "w") as f:
        json.dump(out, f, separators=(",", ":"))
    print(f"wrote {OUT} ({os.path.getsize(OUT)/1024:.0f} KB)")

    # Who would actually be on the board right now?
    print("\nclosest active chases:")
    rows = []
    for r in active.itertuples(index=False):
        nxt = next((x for x in RUNGS if x > r.tds), None)
        if nxt:
            rows.append((nxt - r.tds, r.name, r.tds, nxt))
    for away, name, tds, nxt in sorted(rows)[:10]:
        print(f"  {name:<24} {tds:>3} career — {away} from {nxt}")


if __name__ == "__main__":
    main()
