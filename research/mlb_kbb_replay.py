"""Grade every rung of the Ks / Walks ladder, for every starter, all season.

scripts/build-data.js computeKbbHistory() already replays the season honestly
(each slate projected from the stats BEFORE it, then folded in) — but it keeps
only the top 8 walk/K-rate arms a night, and only grades the two lines hugging
each projection. This re-runs the same replay from the same boxscores for EVERY
rankable starter and grades every half line, so any rung — Over 1.5 walks
included — has a full-season record without waiting to log it.

Mirrors the build exactly: K0 = {k: 70, bb: 120} pseudo-batters of league rate,
log5 against the opponent's rate, projected batters faced = his BF per start so
far, P(over) = Poisson on the projection. Keep them in step if the build changes.

    python3 research/mlb_kbb_replay.py      # boxscores cached under $MLB_CACHE
"""
import json, os, sys, ssl, time, urllib.request
from concurrent.futures import ThreadPoolExecutor
from datetime import date, timedelta
import numpy as np
import pandas as pd
from scipy.stats import poisson

HERE = os.path.dirname(os.path.abspath(__file__))
CACHE = os.environ.get("MLB_CACHE", "/tmp/mlb-cache")
MLB = "https://statsapi.mlb.com/api/v1"
K0 = {"k": 70, "bb": 120}
MIN_BF, MIN_TM_PA, WARMUP_PA = 40, 200, 3000          # KBB_MIN_BF, KBB_MIN_TM_PA, KBB_WARMUP_PA
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


def day_lines(d):
    """Every starter's line and each team's batting line on date d (cached)."""
    p = os.path.join(CACHE, f"{d}.json")
    if os.path.exists(p):
        return json.load(open(p))
    sched = get(f"{MLB}/schedule?sportId=1&date={d}&gameType=R") or {}
    games = [g for x in sched.get("dates", []) for g in x.get("games", [])
             if g.get("status", {}).get("abstractGameState") == "Final"
             and "postpon" not in (g.get("status", {}).get("detailedState") or "").lower()
             and "cancel" not in (g.get("status", {}).get("detailedState") or "").lower()]
    out = {"starts": [], "bat": {}, "pks": []}
    for g in games:
        box = get(f"{MLB}/game/{g['gamePk']}/boxscore")
        if not box: continue
        out["pks"].append(g["gamePk"])
        for side, oside in (("home", "away"), ("away", "home")):
            t = box["teams"][side]; ab = t["team"]["abbreviation"]; opp = box["teams"][oside]["team"]["abbreviation"]
            tb = t.get("teamStats", {}).get("batting", {})
            if tb.get("plateAppearances"):
                e = out["bat"].setdefault(ab, {"k": 0, "bb": 0, "pa": 0})
                e["k"] += tb.get("strikeOuts", 0); e["bb"] += tb.get("baseOnBalls", 0); e["pa"] += tb["plateAppearances"]
            for pid in t.get("pitchers", []):
                st = t["players"].get(f"ID{pid}", {}).get("stats", {}).get("pitching")
                if not st or (st.get("gamesStarted") or 0) < 1: continue
                out["starts"].append({"pid": str(pid), "name": t["players"][f"ID{pid}"]["person"]["fullName"],
                                      "team": ab, "opp": opp, "k": st.get("strikeOuts", 0), "bb": st.get("baseOnBalls", 0),
                                      "bf": st.get("battersFaced", 0)})
    os.makedirs(CACHE, exist_ok=True)
    if d < date.today().isoformat():            # today's slate may still be going
        json.dump(out, open(p, "w"))
    return out


def log5(p, t, l):
    num = p * t / l
    return num / (num + (1 - p) * (1 - t) / (1 - l))


def replay(days):
    pit, tm = {}, {}
    lg = {"k": 0, "bb": 0, "pa": 0}
    rows = []
    for d in sorted(days):
        day = days[d]
        seen = set()                            # a doubleheader can list a pid twice; the build keeps both
        if lg["pa"] >= WARMUP_PA:
            for s in day["starts"]:
                ps, to = pit.get(s["pid"]), tm.get(s["opp"])
                if not ps or ps["bf"] < MIN_BF or not to or to["pa"] < MIN_TM_PA: continue
                r = {"date": d, "pid": s["pid"], "name": s["name"], "team": s["team"], "opp": s["opp"], "bf": s["bf"]}
                for kind in ("k", "bb"):
                    L = lg[kind] / lg["pa"]
                    p_rate = (ps[kind] + K0[kind] * L) / (ps["bf"] + K0[kind])
                    exp = log5(p_rate, to[kind] / to["pa"], L)
                    r[kind + "_exp"] = exp; r[kind + "_raw"] = ps[kind] / ps["bf"]
                    r[kind + "_proj"] = exp * ps["bf"] / ps["gs"]; r[kind] = s[kind]
                r["proj_bf"] = ps["bf"] / ps["gs"]
                # his totals going in, so any shrink can be re-derived without replaying
                r.update(prior_bf=ps["bf"], prior_gs=ps["gs"], prior_k=ps["k"], prior_bb=ps["bb"],
                         tm_k=to["k"] / to["pa"], tm_bb=to["bb"] / to["pa"], lg_k=lg["k"] / lg["pa"], lg_bb=lg["bb"] / lg["pa"])
                rows.append(r)
        for s in day["starts"]:
            e = pit.setdefault(s["pid"], {"k": 0, "bb": 0, "bf": 0, "gs": 0})
            e["k"] += s["k"]; e["bb"] += s["bb"]; e["bf"] += s["bf"]; e["gs"] += 1
        for ab, v in day["bat"].items():
            e = tm.setdefault(ab, {"k": 0, "bb": 0, "pa": 0})
            for k in ("k", "bb", "pa"): e[k] += v[k]; lg[k] += v[k]
    return pd.DataFrame(rows)


if __name__ == "__main__":
    d0 = json.load(open(os.path.join(HERE, "..", "mlb", "data.json")))
    start = d0.get("seasonStart") or "2026-03-26"
    end = date.today() - timedelta(days=1)
    dates = []
    cur = date.fromisoformat(start)
    while cur <= end:
        dates.append(cur.isoformat()); cur += timedelta(days=1)
    print(f"fetching {len(dates)} dates ({start} -> {end}), cached under {CACHE}", flush=True)
    days = {}
    with ThreadPoolExecutor(8) as ex:
        for i, (d, v) in enumerate(zip(dates, ex.map(day_lines, dates)), 1):
            days[d] = v
            if i % 25 == 0: print(f"  {i}/{len(dates)}", flush=True)
    R = replay(days)
    R.to_parquet(os.path.join(HERE, "mlb_kbb_replay.parquet"))
    print(f"{len(R):,} graded starts, every rankable starter, {R.date.nunique()} slates")
