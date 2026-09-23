"""The standing data behind Birthdays, Milestones and Due — pulled once, committed.

  career   every skater's career goals / assists / points / games and every
           goalie's games / wins / shutouts, regular season, through the last
           finished season — for anyone who played in either of the last two.
           The build adds the current season on top (scripts/nhl-fun.js).
  drought  where each skater's goal drought stood when last season ended:
           games, shots and ice time since his last regular-season goal. The
           build carries it into this season off players.json.
  bday     per-player record on his birthday, and the league-wide question —
           do birthday boys score more than their price? — graded against the
           shipped goals model's walk-forward price (research/nhl_due.py).

    python3 research/nhl_fun_data.py      # writes research/nhl_fun.json
"""
import json, os, subprocess, sys, time, urllib.parse
import numpy as np
import pandas as pd

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
REST = "https://api.nhle.com/stats/rest/en"
THROUGH = 20252026


def get(path, **q):
    url = f"{REST}/{path}?" + urllib.parse.urlencode(q, quote_via=urllib.parse.quote)
    for i in range(4):
        r = subprocess.run(["curl", "-sL", "--max-time", "60", url], capture_output=True, text=True)
        try: return json.loads(r.stdout)
        except json.JSONDecodeError: time.sleep(1 + i)
    raise RuntimeError(url)


def paged(path, exp, sort):
    out, start = [], 0
    while True:
        d = get(path, isAggregate="true", start=start, limit=100, cayenneExp=exp,
                sort=json.dumps([{"property": sort, "direction": "DESC"}, {"property": "playerId", "direction": "ASC"}]))
        out += d["data"]; start += 100
        if start >= d["total"]: return out


if __name__ == "__main__":
    recent = f"seasonId>={THROUGH - 10001} and seasonId<={THROUGH} and gameTypeId=2"
    ever = f"seasonId>=19171918 and seasonId<={THROUGH} and gameTypeId=2"
    sk_bio = paged("skater/bios", f"seasonId>=20222023 and seasonId<={THROUGH} and gameTypeId=2", "gamesPlayed")
    gl_bio = paged("goalie/bios", recent, "gamesPlayed")
    active_sk = {r["playerId"] for r in paged("skater/summary", recent, "gamesPlayed")}
    active_gl = {r["playerId"] for r in gl_bio}
    career = {str(r["playerId"]): [r["skaterFullName"], r["positionCode"], r["gamesPlayed"], r["goals"], r["assists"], r["points"]]
              for r in paged("skater/summary", ever, "points") if r["playerId"] in active_sk}
    goalies = {str(r["playerId"]): [r["goalieFullName"], r["gamesPlayed"], r["wins"], r["shutouts"]]
               for r in paged("goalie/summary", ever, "wins") if r["playerId"] in active_gl}
    print(f"career: {len(career)} active skaters, {len(goalies)} goalies")

    # ── drought at the end of last season ──
    from nhl_due import droughts, walk, FEATS
    from nhl_goals import D
    D = D.drop_duplicates(["pid", "date"])
    last = D[D.season == THROUGH].sort_values("date")
    drought = {}
    for pid, g in last.groupby("pid"):
        allg = D[D.pid == pid].sort_values("date")
        hit = allg[allg.goals > 0]
        after = allg[allg.date > hit.date.iloc[-1]] if len(hit) else allg
        drought[str(pid)] = [int(len(after)), int(after.sog.sum()), int(round(after.toi.sum() / 60)),
                             hit.date.iloc[-1] if len(hit) else None]
    print(f"drought: {len(drought)} skaters carried")

    # ── birthdays ──
    bd = {r["playerId"]: r["birthDate"] for r in sk_bio}
    P = walk(D, FEATS)                               # walk-forward price, 2023-24 on
    T = D.loc[P.index].assign(p=P)
    T["bd"] = T.pid.map(bd)
    T = T[T.bd.notna()]
    md = lambda s: s.str[5:10]
    T["on"] = md(T.bd) == md(T.date)
    delta = (pd.to_datetime(T.date) - pd.to_datetime(T.date.str[:4] + "-" + T.bd.str[5:10], errors="coerce")).dt.days
    T["near"] = delta.abs().between(1, 3)
    on, near = T[T.on], T[T.near]
    base = T[~T.on]
    se = np.sqrt((on.p * (1 - on.p)).sum())
    z = (on.scored.sum() - on.p.sum()) / se
    stats = {
        "seasons": "2023-24 to 2025-26",
        "on": {"games": int(len(on)), "goals": int(on.scored.sum()), "rate": round(float(on.scored.mean()), 4), "priced": round(float(on.p.mean()), 4)},
        "near": {"games": int(len(near)), "goals": int(near.scored.sum()), "rate": round(float(near.scored.mean()), 4), "priced": round(float(near.p.mean()), 4)},
        "base": round(float(base.scored.mean()), 4), "z": round(float(z), 2),
    }
    print("birthdays:", stats)
    # every season in the dataset for the per-player record, not just the priced ones
    A = D.assign(bd=D.pid.map(bd)); A = A[A.bd.notna() & (A.bd.str[5:10] == A.date.str[5:10])]
    rec = {str(pid): [int(len(g)), int((g.goals > 0).sum())] for pid, g in A.groupby("pid")}

    json.dump({"through": THROUGH, "career": career, "goalies": goalies, "drought": drought,
               "bday": {"stats": stats, "rec": rec}},
              open(os.path.join(HERE, "nhl_fun.json"), "w"), separators=(",", ":"))
    print(f"wrote nhl_fun.json — {os.path.getsize(os.path.join(HERE, 'nhl_fun.json')) // 1024} KB")
