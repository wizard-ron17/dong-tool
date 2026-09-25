"""Per-game contact quality from Baseball Savant, for the HR replay.

    python3 research/mlb_barrels_fetch.py 2025 2026

One statcast_search CSV per date (as mlb_savant_fetch.py), reduced to per-game
lines and cached as JSON under research/.cache/savant_bbe/{date}.json:

  batters   PA, batted balls, barrels, hard-hit (95+ mph), blasts
  pitchers  batters faced, and the same four ALLOWED, plus whether he started

Barrel = Savant's launch_speed_angle 6. Blast = a squared-up swing that's also
fast: squared-up % (exit velo over the max the bat and pitch speed allow,
1.23*bat + 0.23*pitch) plus bat speed >= 164 — the definition behind Savant's
Blast%, which our live base power blends toward. Bat speed exists from 2024.

Why: the replay (mlb_hr_replay.py) prices a batter off HR/AB and the opposing
starter off HR/BF. August's backtests found barrel%-allowed is the real pitcher
signal (z~4.3, orthogonal to power), and the market's premium on raw-power
names looks like contact quality HR/AB can't see. This supplies both.
"""
import io
import json
import os
import subprocess
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import date, timedelta

import numpy as np
import pandas as pd

HERE = os.path.dirname(os.path.abspath(__file__))
CACHE = os.path.join(HERE, ".cache", "savant_bbe")
SEASONS = {2025: ("2025-03-18", "2025-09-28"), 2026: ("2026-03-25", None)}


def csv(d):
    url = (f"https://baseballsavant.mlb.com/statcast_search/csv?all=true&type=details"
           f"&game_date_gt={d}&game_date_lt={d}&hfGT=R%7C")
    for i in range(4):
        r = subprocess.run(["curl", "-s", "-A", "Mozilla/5.0", "--max-time", "120", url], capture_output=True)
        if r.returncode == 0 and r.stdout[:40].lstrip(b"\xef\xbb\xbf").startswith(b'"pitch_type"'):
            return pd.read_csv(io.BytesIO(r.stdout), low_memory=False)
        if r.returncode == 0 and len(r.stdout) < 200:
            return pd.DataFrame()                     # no games that day
        time.sleep(3 * (i + 1))
    return None


def reduce(df):
    df = df[df.game_type == "R"].copy()
    df["pa"] = df.events.notna()
    df["bbe"] = df.type == "X"
    df["barrel"] = df.bbe & (df.launch_speed_angle == 6)
    df["hard"] = df.bbe & (df.launch_speed >= 95)
    if "bat_speed" in df:
        mx = 1.23 * df.bat_speed + 0.23 * df.release_speed
        sq = (df.launch_speed / mx).clip(upper=1)
        df["blast"] = df.bbe & (sq * 100 + df.bat_speed >= 164).fillna(False)
    else:
        df["blast"] = False
    first = df.sort_values(["game_pk", "at_bat_number", "pitch_number"]).drop_duplicates(["game_pk", "inning_topbot"])
    starters = {(r.game_pk, r.pitcher) for r in first.itertuples()}
    agg = dict(pa=("pa", "sum"), bbe=("bbe", "sum"), barrel=("barrel", "sum"), hard=("hard", "sum"), blast=("blast", "sum"))
    bat = df.groupby(["game_pk", "batter"]).agg(**agg).reset_index()
    pit = df.groupby(["game_pk", "pitcher"]).agg(**agg).reset_index()
    pit["sp"] = [(g, p) in starters for g, p in zip(pit.game_pk, pit.pitcher)]
    to = lambda t, key: [{"gpk": int(r.game_pk), "pid": int(getattr(r, key)), **{k: int(getattr(r, k)) for k in agg}, **({"sp": bool(r.sp)} if key == "pitcher" else {})}
                         for r in t.itertuples()]
    return {"batters": to(bat, "batter"), "pitchers": to(pit, "pitcher")}


def one(d):
    p = os.path.join(CACHE, f"{d}.json")
    if os.path.exists(p):
        return d, "cached"
    df = csv(d)
    if df is None:
        return d, "FAILED"
    out = reduce(df) if len(df) else {"batters": [], "pitchers": []}
    if d < date.today().isoformat():
        os.makedirs(CACHE, exist_ok=True)
        json.dump(out, open(p, "w"))
    return d, f"{len(out['batters'])} batter-games"


def dates_for(seasons):
    out = []
    for y in seasons:
        a, b = SEASONS[y]
        a, b = date.fromisoformat(a), date.fromisoformat(b) if b else date.today() - timedelta(days=1)
        out += [(a + timedelta(days=i)).isoformat() for i in range((b - a).days + 1)]
    return out


if __name__ == "__main__":
    os.makedirs(CACHE, exist_ok=True)
    dates = dates_for([int(x) for x in sys.argv[1:]] or [2025, 2026])
    print(f"{len(dates)} dates", flush=True)
    bad = []
    with ThreadPoolExecutor(4) as ex:
        for i, (d, st) in enumerate(ex.map(one, dates), 1):
            if st == "FAILED":
                bad.append(d)
            if i % 25 == 0:
                print(f"  {i}/{len(dates)} ({d}: {st})", flush=True)
    print(f"done — failed: {bad}")
