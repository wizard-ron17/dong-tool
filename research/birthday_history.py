"""Per-player birthday scoring record, 2016-2025.

Exports research/birthday_history.json: for every player who has played a game
on or near his birthday, how many such games and how many he scored in. The
build attaches it to the Birthday tool so a row can say "2 for 5 on his
birthday" instead of only "he is turning 26".

Computed here rather than in the Node build because it needs ten seasons of
play-by-play to know who scored, which the daily build has no reason to carry.
Only changes when a season completes.
"""
import json
import os
import ssl
import sys
import urllib.request

import numpy as np
import pandas as pd

try:
    import certifi
    _SSL = ssl.create_default_context(cafile=certifi.where())
except ImportError:
    _SSL = ssl.create_default_context()

HERE = os.path.dirname(__file__)
CACHE = os.environ.get(
    "PICKS_CACHE",
    "/private/tmp/claude-501/-Users-ron-Desktop-dong-tool/"
    "5857f821-b559-469c-a8ee-a9ffc542c6c6/scratchpad/nflcache",
)
OUT = os.path.join(HERE, "birthday_history.json")
NEAR_DAYS = 3           # "birthday week" — the NFL analogue of MLB's game day


def game_days():
    req = urllib.request.Request(
        "https://raw.githubusercontent.com/nflverse/nfldata/master/data/games.csv",
        headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req, context=_SSL, timeout=180) as r:
        gm = pd.read_csv(r)
    return gm[["game_id", "gameday"]]


def main():
    ds = pd.read_parquet(os.path.join(HERE, "dataset.parquet"))
    pl = pd.read_csv(f"{CACHE}/players.csv",
                     usecols=["gsis_id", "birth_date", "display_name"],
                     low_memory=False)
    ds = ds.merge(pl, left_on="pid", right_on="gsis_id", how="left")
    ds = ds.merge(game_days(), on="game_id", how="left")
    ds = ds[ds.birth_date.notna() & ds.gameday.notna()].copy()

    gd = pd.to_datetime(ds.gameday)
    bd = pd.to_datetime(ds.birth_date)
    diff = (gd.dt.dayofyear - bd.dt.dayofyear).abs()
    ds["dist"] = np.minimum(diff, 365 - diff)      # wrap the year boundary

    on = ds[ds.dist == 0]
    near = ds[ds.dist <= NEAR_DAYS]
    base = ds.scored.mean()

    rec = {}
    for label, frame in (("on", on), ("near", near)):
        g = frame.groupby("pid").agg(games=("scored", "size"), tds=("scored", "sum"))
        for pid, row in g.iterrows():
            rec.setdefault(pid, {})[label] = [int(row.games), int(row.tds)]

    out = {
        "seasons": f"{int(ds.season.min())}-{int(ds.season.max())}",
        "near_days": NEAR_DAYS,
        "base_rate": float(base),
        "league": {
            "on":   {"games": int(len(on)),   "tds": int(on.scored.sum()),
                     "rate": float(on.scored.mean())},
            "near": {"games": int(len(near)), "tds": int(near.scored.sum()),
                     "rate": float(near.scored.mean())},
        },
        "players": rec,
    }
    with open(OUT, "w") as f:
        json.dump(out, f, separators=(",", ":"))

    n, hits = len(on), int(on.scored.sum())
    import math
    z = (hits - n * base) / math.sqrt(n * base * (1 - base))
    p = math.erfc(abs(z) / math.sqrt(2))
    print(f"wrote {OUT}  ({len(rec)} players, {os.path.getsize(OUT)/1024:.0f} KB)")
    print(f"  league base rate           {base:.2%}")
    print(f"  ON his birthday            {hits}/{n} = {on.scored.mean():.2%} "
          f"({on.scored.mean()/base:.2f}x)  z={z:.2f}  p={p:.3f}")
    print(f"  within {NEAR_DAYS} days             "
          f"{int(near.scored.sum())}/{len(near)} = {near.scored.mean():.2%} "
          f"({near.scored.mean()/base:.2f}x)")
    print("  -> not significant; the tool should say so")
    top = sorted(((k, v.get("on", [0, 0])) for k, v in rec.items()),
                 key=lambda kv: (-kv[1][1], -kv[1][0]))[:5]
    names = dict(zip(pl.gsis_id, pl.display_name))
    print("\n  most TDs on their own birthday:")
    for pid, (g_, t) in top:
        print(f"    {names.get(pid, pid):<24} {t} in {g_} game(s)")


if __name__ == "__main__":
    main()
