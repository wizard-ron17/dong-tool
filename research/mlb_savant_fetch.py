"""Pitch-level plate discipline for the walks research, from Baseball Savant.

One statcast_search CSV per date (~4,000 pitches, under Savant's row cap),
reduced to per-game lines and cached as JSON — the raw CSVs are ~3 MB a day
and nothing downstream needs single pitches:

  pitchers  pitches, balls, strikes, in-zone pitches, first pitches, first-pitch
            strikes, out-of-zone pitches, out-of-zone swings induced (chases),
            batters faced, strikeouts, walks, and his club
  batters   pitches seen, out-of-zone pitches seen, chases, in-zone pitches,
            in-zone swings, plate appearances, strikeouts, walks, and the batting-order slot
            (order of first appearance for his team that game)

Zones 1-9 are the strike zone, 11-14 outside it. Bunt attempts don't count as
swings. Cached under research/.cache/savant/{date}.json.

    python3 research/mlb_savant_fetch.py            # season start -> yesterday
    python3 research/mlb_savant_fetch.py --past     # + July-September 2023-2025
"""
import io, json, os, subprocess, sys, time
from concurrent.futures import ThreadPoolExecutor
from datetime import date, timedelta
import pandas as pd

HERE = os.path.dirname(os.path.abspath(__file__))
CACHE = os.path.join(HERE, ".cache", "savant")
SWING = {"swinging_strike", "swinging_strike_blocked", "foul", "foul_tip", "hit_into_play"}


def csv(d):
    url = (f"https://baseballsavant.mlb.com/statcast_search/csv?all=true&type=details"
           f"&game_date_gt={d}&game_date_lt={d}&hfGT=R%7C")
    for i in range(4):
        r = subprocess.run(["curl", "-s", "-A", "Mozilla/5.0", "--max-time", "120", url], capture_output=True)
        if r.returncode == 0 and r.stdout[:40].lstrip(b"\xef\xbb\xbf").startswith(b'"pitch_type"'):
            return pd.read_csv(io.BytesIO(r.stdout))
        if r.returncode == 0 and len(r.stdout) < 200: return pd.DataFrame()   # no games that day
        time.sleep(3 * (i + 1))
    return None


def one(d):
    p = os.path.join(CACHE, f"{d}.json")
    if os.path.exists(p): return d, "cached"
    df = csv(d)
    if df is None: return d, "FAILED"
    out = {"pitchers": [], "batters": []}
    if len(df):
        df = df[df.game_type == "R"].copy()
        z = df.zone
        df["inz"] = z.between(1, 9); df["outz"] = z.between(11, 14)
        df["swing"] = df.description.isin(SWING)
        df["ball"] = df.type == "B"; df["strike"] = df.type.isin(["S", "X"])
        df["first"] = df.pitch_number == 1
        df["fps"] = df["first"] & df["strike"]
        df["pa"] = df.events.notna()
        df["k"] = df.events.isin(["strikeout", "strikeout_double_play"])
        df["bb"] = df.events.isin(["walk", "intent_walk"])
        df["bat_team"] = df.home_team.where(df.inning_topbot == "Bot", df.away_team)
        # the starter: whoever threw his club's first pitch of the game
        first_p = df.sort_values(["game_pk", "at_bat_number", "pitch_number"]).drop_duplicates(["game_pk", "inning_topbot"])
        starters = {(r.game_pk, r.pitcher) for r in first_p.itertuples()}
        for (gpk, pid), g in df.groupby(["game_pk", "pitcher"]):
            out["pitchers"].append(dict(gpk=int(gpk), pid=int(pid), n=len(g), ball=int(g.ball.sum()), strike=int(g.strike.sum()),
                                        inz=int(g.inz.sum()), first=int(g["first"].sum()), fps=int(g.fps.sum()),
                                        outz=int(g.outz.sum()), chase=int((g.outz & g.swing).sum()), pa=int(g.pa.sum()),
                                        k=int(g.k.sum()), bb=int(g.bb.sum()), team=(g.away_team.iloc[0] if g.inning_topbot.iloc[0] == "Bot" else g.home_team.iloc[0]),
                                        sp=(gpk, pid) in starters))
        # batting order: order of first plate appearance for his team in the game
        firsts = df.sort_values(["game_pk", "at_bat_number"]).drop_duplicates(["game_pk", "batter"])
        firsts["slot"] = firsts.groupby(["game_pk", "bat_team"]).cumcount() + 1
        slot = {(r.game_pk, r.batter): r.slot for r in firsts.itertuples()}
        for (gpk, pid, team), g in df.groupby(["game_pk", "batter", "bat_team"]):
            out["batters"].append(dict(gpk=int(gpk), pid=int(pid), team=team, n=len(g), outz=int(g.outz.sum()),
                                       chase=int((g.outz & g.swing).sum()), inz=int(g.inz.sum()),
                                       zswing=int((g.inz & g.swing).sum()), pa=int(g.pa.sum()), slot=int(slot[(gpk, pid)]),
                                       k=int(g.k.sum()), bb=int(g.bb.sum())))
    os.makedirs(CACHE, exist_ok=True)
    if d < date.today().isoformat(): json.dump(out, open(p, "w"))
    return d, f"{len(out['pitchers'])} pitcher-games"


if __name__ == "__main__":
    # this season from opening day; with --past, August-September of 2023-2025
    # too (the motivation tests compare clubs with themselves, so any season works)
    start = json.load(open(os.path.join(HERE, "..", "mlb", "data.json"))).get("seasonStart") or "2026-03-25"
    d0, d1 = date.fromisoformat(start), date.today() - timedelta(days=1)
    dates = [(d0 + timedelta(days=i)).isoformat() for i in range((d1 - d0).days + 1)]
    if "--past" in sys.argv:
        for y in (2023, 2024, 2025):
            a, b = date(y, 7, 1), date(y, 9, 30)
            dates += [(a + timedelta(days=i)).isoformat() for i in range((b - a).days + 1)]
    print(f"{len(dates)} dates", flush=True)
    bad = []
    with ThreadPoolExecutor(4) as ex:
        for i, (d, st) in enumerate(ex.map(one, dates), 1):
            if st == "FAILED": bad.append(d)
            if i % 20 == 0: print(f"  {i}/{len(dates)}", flush=True)
    print(f"done — failed: {bad}")
