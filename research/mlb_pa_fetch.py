"""Plate-appearance lines from Baseball Savant, for the HR factor scan.

    python3 research/mlb_pa_fetch.py 2024 2025 2026

The per-game caches (mlb_barrels_fetch.py, mlb_savant_fetch.py) can't test
most of the Pick Score's factors: platoon needs each PA's two hands, the
starter-vs-pen split needs who threw it, and "qualifying flies" needs launch
angle and exit velocity. One statcast_search CSV per date, reduced to the PA's
last pitch, cached as parquet under research/.cache/savant_pa/{date}.parquet:

  game_pk, date, batter, pitcher, stand, p_throws, sp (pitcher started),
  events, bb_type, launch_speed, launch_angle, launch_speed_angle (Statcast's 1-6
  contact grade, what the live recent-contact factor averages), hc_x, hc_y (spray),
  inning, top (away batting), home_team, away_team, barrel, blast, bat_speed
  plus one row per pitcher-game in {date}_pit.parquet: mean fastball velo.

Blast as in mlb_barrels_fetch.py (bat speed exists from 2024).
"""
import io, os, subprocess, sys, time
from concurrent.futures import ThreadPoolExecutor
from datetime import date, timedelta
import pandas as pd

HERE = os.path.dirname(os.path.abspath(__file__))
CACHE = os.path.join(HERE, ".cache", "savant_pa")
SEASONS = {2024: ("2024-03-20", "2024-09-30"), 2025: ("2025-03-18", "2025-09-28"), 2026: ("2026-03-25", None)}
FB = {"FF", "SI", "FT"}


def csv(d):
    url = (f"https://baseballsavant.mlb.com/statcast_search/csv?all=true&type=details"
           f"&game_date_gt={d}&game_date_lt={d}&hfGT=R%7C")
    for i in range(4):
        r = subprocess.run(["curl", "-s", "-A", "Mozilla/5.0", "--max-time", "150", url], capture_output=True)
        if r.returncode == 0 and r.stdout[:40].lstrip(b"\xef\xbb\xbf").startswith(b'"pitch_type"'):
            return pd.read_csv(io.BytesIO(r.stdout), low_memory=False)
        if r.returncode == 0 and len(r.stdout) < 200:
            return pd.DataFrame()
        time.sleep(3 * (i + 1))
    return None


def reduce(df):
    df = df[df.game_type == "R"].copy()
    first = df.sort_values(["game_pk", "at_bat_number", "pitch_number"]).drop_duplicates(["game_pk", "inning_topbot"])
    starters = set(zip(first.game_pk, first.pitcher))
    velo = (df[df.pitch_type.isin(FB)].groupby(["game_pk", "pitcher"]).release_speed.mean().rename("fb_velo").reset_index())
    pa = df[df.events.notna()].copy()
    pa["sp"] = [(g, p) in starters for g, p in zip(pa.game_pk, pa.pitcher)]
    pa["barrel"] = (pa.type == "X") & (pa.launch_speed_angle == 6)
    if "bat_speed" in pa:
        mx = 1.23 * pa.bat_speed + 0.23 * pa.release_speed
        sq = (pa.launch_speed / mx).clip(upper=1)
        pa["blast"] = (pa.type == "X") & (sq * 100 + pa.bat_speed >= 164).fillna(False)
    else:
        pa["blast"], pa["bat_speed"] = False, float("nan")
    pa["top"] = pa.inning_topbot == "Top"
    keep = ["game_pk", "game_date", "batter", "pitcher", "stand", "p_throws", "sp", "events", "bb_type", "launch_speed",
            "launch_angle", "launch_speed_angle", "hc_x", "hc_y", "inning", "top", "home_team", "away_team", "barrel", "blast", "bat_speed", "at_bat_number"]
    return pa[keep].rename(columns={"game_date": "date"}), velo


def one(d):
    p = os.path.join(CACHE, f"{d}.parquet")
    if os.path.exists(p):
        return d, "cached"
    df = csv(d)
    if df is None:
        return d, "FAILED"
    if not len(df) or not (df.game_type == "R").any():
        pa, velo = pd.DataFrame(), pd.DataFrame()
    else:
        pa, velo = reduce(df)
    if d < date.today().isoformat():
        os.makedirs(CACHE, exist_ok=True)
        pa.to_parquet(p); velo.to_parquet(os.path.join(CACHE, f"{d}_pit.parquet"))
    return d, f"{len(pa)} PA"


def dates_for(seasons):
    out = []
    for y in seasons:
        a, b = SEASONS[y]
        a, b = date.fromisoformat(a), date.fromisoformat(b) if b else date.today() - timedelta(days=1)
        out += [(a + timedelta(days=i)).isoformat() for i in range((b - a).days + 1)]
    return out


if __name__ == "__main__":
    os.makedirs(CACHE, exist_ok=True)
    dates = dates_for([int(x) for x in sys.argv[1:]] or [2024, 2025, 2026])
    print(f"{len(dates)} dates", flush=True)
    bad = []
    with ThreadPoolExecutor(4) as ex:
        for i, (d, st) in enumerate(ex.map(one, dates), 1):
            if st == "FAILED": bad.append(d)
            if i % 25 == 0: print(f"  {i}/{len(dates)} ({d}: {st})", flush=True)
    print(f"done — failed: {bad}", flush=True)
