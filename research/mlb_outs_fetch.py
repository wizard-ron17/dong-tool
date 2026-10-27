"""Every pitching line (starters and relievers) for 2024-2026, for the leash study.

    python3 research/mlb_outs_fetch.py       # cached per date under research/.cache/mlb_box/

One row per pitcher per game: batters faced, pitches, outs, K, BB, H, ER, HR, and
whether he started. The Ks / Walks tools project a start as rate x batters faced;
research/mlb_outs.py models the batters faced (and outs) from these lines.
"""
import json, os, ssl, time, urllib.request
from concurrent.futures import ThreadPoolExecutor
from datetime import date, timedelta
import pandas as pd

HERE = os.path.dirname(os.path.abspath(__file__))
CACHE = os.path.join(HERE, ".cache", "mlb_box")
MLB = "https://statsapi.mlb.com/api/v1"
SEASONS = {2024: ("2024-03-20", "2024-09-30"), 2025: ("2025-03-18", "2025-09-28"), 2026: ("2026-03-25", "2026-09-28")}
try:
    import certifi; _SSL = ssl.create_default_context(cafile=certifi.where())
except ImportError:
    _SSL = ssl.create_default_context()


def get(url, tries=4):
    for i in range(tries):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": "dong-tool/1.0"}), timeout=60, context=_SSL) as r:
                return json.load(r)
        except Exception:
            time.sleep(0.8 * (i + 1))
    return None


def day(d):
    p = os.path.join(CACHE, f"{d}.json")
    if os.path.exists(p):
        return json.load(open(p))
    sched = get(f"{MLB}/schedule?sportId=1&date={d}&gameType=R")
    if sched is None: return []
    rows = []
    for g in [g for x in sched.get("dates", []) for g in x.get("games", [])]:
        st = g.get("status", {})
        if st.get("abstractGameState") != "Final" or any(w in (st.get("detailedState") or "").lower() for w in ("postpon", "cancel")): continue
        box = get(f"{MLB}/game/{g['gamePk']}/boxscore")
        if not box: continue
        for side, oside in (("home", "away"), ("away", "home")):
            t = box["teams"][side]; ab = t["team"]["abbreviation"]; opp = box["teams"][oside]["team"]["abbreviation"]
            for i, pid in enumerate(t.get("pitchers", [])):
                s = t["players"].get(f"ID{pid}", {}).get("stats", {}).get("pitching")
                if not s: continue
                rows.append({"date": d, "gpk": g["gamePk"], "gameNo": g.get("gameNumber", 1), "start_time": g.get("gameDate"),
                             "pid": str(pid), "name": t["players"][f"ID{pid}"]["person"]["fullName"], "team": ab, "opp": opp,
                             "home": side == "home", "order": i, "gs": int((s.get("gamesStarted") or 0) > 0),
                             "bf": s.get("battersFaced", 0), "pitches": s.get("numberOfPitches", 0), "outs": s.get("outs", 0),
                             "k": s.get("strikeOuts", 0), "bb": s.get("baseOnBalls", 0), "h": s.get("hits", 0),
                             "er": s.get("earnedRuns", 0), "r": s.get("runs", 0), "hr": s.get("homeRuns", 0), "hbp": s.get("hitBatsmen", 0)})
    os.makedirs(CACHE, exist_ok=True)
    if d < date.today().isoformat():
        json.dump(rows, open(p, "w"))
    return rows


if __name__ == "__main__":
    dates = []
    for a, b in SEASONS.values():
        cur = date.fromisoformat(a)
        while cur <= date.fromisoformat(b):
            dates.append(cur.isoformat()); cur += timedelta(days=1)
    out = []
    with ThreadPoolExecutor(8) as ex:
        for i, rows in enumerate(ex.map(day, dates), 1):
            out += rows
            if i % 50 == 0: print(f"  {i}/{len(dates)}", flush=True)
    df = pd.DataFrame(out)
    df.to_parquet(os.path.join(CACHE, "lines.parquet"))
    print(f"{len(df):,} pitching lines, {df.gs.sum():,} starts")
