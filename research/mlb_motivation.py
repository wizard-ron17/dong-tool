"""Does playoff status change how teams play in August-September?

Ron's questions: do teams in the hunt leave starters in longer, do eliminated
teams strike out more (checked out, hacking), do clinched teams rest their
stars — and does any of it move walks?

Every comparison is a club or pitcher against ITSELF — the same starter's
pitch count against his own average so far, the same lineup's strikeout rate
against its own season rate — so good teams and bad teams aren't confused with
motivated and unmotivated ones. Status is read off MLB's standings the night
before (research/mlb_standings_fetch.py): clinched, eliminated (out of the
division and the wild card), or in the race. Pitch data: Baseball Savant
(research/mlb_savant_fetch.py), August-September of 2023-2026, with each
entity's baseline built from July on.

    python3 research/mlb_motivation.py
"""
import glob, json, os
import numpy as np
import pandas as pd

HERE = os.path.dirname(os.path.abspath(__file__))
C = os.path.join(HERE, ".cache")


def load():
    P, B = [], []
    for f in sorted(glob.glob(os.path.join(C, "savant", "*.json"))):
        d = os.path.basename(f)[:-5]
        j = json.load(open(f))
        for r in j["pitchers"]: P.append({**r, "date": d})
        for r in j["batters"]: B.append({**r, "date": d})
    P, B = pd.DataFrame(P), pd.DataFrame(B)
    for X in (P, B): X["season"] = X.date.str[:4].astype(int)
    return P, B


def trailing(df, key, num, den, min_den):
    """His own rate over everything before this row, this season (NaN until min_den)."""
    df = df.sort_values([key, "date"])
    g = df.groupby([key, "season"], sort=False)
    cn, cd = g[num].cumsum() - df[num], g[den].cumsum() - df[den]
    return (cn / cd).where(cd >= min_den)


def table(df, val, lab, fmt="{:+.3f}"):
    """Mean residual by status, with its standard error and the gap to 'race'."""
    g = df.groupby("status")[val].agg(["mean", "std", "size"])
    g["se"] = g["std"] / np.sqrt(g["size"])
    race = g.loc["race"] if "race" in g.index else None
    print(f"\n{lab}")
    for s in ("race", "clinched", "eliminated"):
        if s not in g.index: continue
        r = g.loc[s]
        t = "" if s == "race" or race is None else f"   vs race: t {((r['mean'] - race['mean']) / np.hypot(r['se'], race['se'])):+.2f}"
        print(f"  {s:11s} n {int(r['size']):5,}   {fmt.format(r['mean'])} (± {r['se']:.3f}){t}")


if __name__ == "__main__":
    st = json.load(open(os.path.join(C, "standings.json")))
    P, B = load()
    stat = lambda d, t: st.get(d, {}).get(t)
    print(f"{len(P):,} pitcher-games, {len(B):,} batter-games, {P.date.min()} .. {P.date.max()}")

    # ── A. Starter length: pitches and batters faced vs his own average so far ──
    S = P[P.sp].copy()
    S["one"] = 1
    S = S.sort_values(["pid", "date"])
    S["avg_n"] = trailing(S, "pid", "n", "one", 5)
    S["avg_pa"] = trailing(S, "pid", "pa", "one", 5)
    S["status"] = [stat(d, t) for d, t in zip(S.date, S.team)]
    S = S[S.status.notna() & S.avg_n.notna() & (S.date.str[5:7] >= "08")]
    S["d_n"] = S.n - S.avg_n; S["d_pa"] = S.pa - S.avg_pa
    table(S, "d_n", "A. Starter pitch count vs his own average (pitches)", "{:+.2f}")
    table(S, "d_pa", "   ... batters faced vs his own average", "{:+.2f}")

    # ── B. Lineups: strikeout / walk / chase rate vs the club's own rate so far ──
    T = B.groupby(["date", "season", "gpk", "team"]).agg(pa=("pa", "sum"), k=("k", "sum"), bb=("bb", "sum"),
                                                           outz=("outz", "sum"), chase=("chase", "sum")).reset_index()
    for num, den in (("k", "pa"), ("bb", "pa"), ("chase", "outz")):
        T[f"base_{num}"] = trailing(T, "team", num, den, 400)
    T["status"] = [stat(d, t) for d, t in zip(T.date, T.team)]
    T = T[T.status.notna() & T.base_k.notna() & (T.date.str[5:7] >= "08") & (T.pa > 0)]
    for num, den, lab in (("k", "pa", "strikeout rate"), ("bb", "pa", "walk rate"), ("chase", "outz", "chase rate")):
        T[f"d_{num}"] = 100 * (T[num] / T[den].where(T[den] > 0) - T[f"base_{num}"])
        table(T.dropna(subset=[f"d_{num}"]), f"d_{num}", f"B. Lineup {lab} vs the club's own season rate (percentage points)", "{:+.2f}")

    # ── C. Regulars: how many of his usual starting nine start, vs his last 30 days ──
    L = B[B.slot <= 9].copy()
    reg_share = []
    L = L.sort_values("date")
    by_team = {t: g for t, g in L.groupby(["team", "season"])}
    rows = []
    for (team, season), g in by_team.items():
        dates = sorted(g.date.unique())
        for d in dates:
            if d[5:7] < "08": continue
            prior = g[(g.date < d) & (g.date >= (pd.Timestamp(d) - pd.Timedelta(days=30)).strftime("%Y-%m-%d"))]
            if prior.gpk.nunique() < 15: continue
            regulars = set(prior.pid.value_counts().head(9).index)
            base = prior.groupby("gpk").pid.apply(lambda s: len(set(s) & regulars)).mean()
            for gpk, gg in g[g.date == d].groupby("gpk"):
                rows.append(dict(date=d, team=team, n=len(set(gg.pid) & regulars) - base, status=stat(d, team)))
    R = pd.DataFrame(rows).dropna(subset=["status"])
    table(R, "n", "C. Usual starters in the lineup vs the club's last 30 days (players out of 9)", "{:+.2f}")

    # ── D. Walks: the starter's walk rate vs his own, by his club's and the opponent's status ──
    S2 = P[P.sp].copy().sort_values(["pid", "date"])
    S2["base_bb"] = trailing(S2, "pid", "bb", "pa", 150)
    S2 = S2[S2.base_bb.notna() & (S2.date.str[5:7] >= "08") & (S2.pa > 0)]
    gteams = B.groupby("gpk").team.agg(lambda s: sorted(set(s))).to_dict()
    S2["opp"] = [next((x for x in gteams.get(g, []) if x != t), None) for g, t in zip(S2.gpk, S2.team)]
    S2["d_bb"] = 100 * (S2.bb / S2.pa - S2.base_bb)
    S2["status"] = [stat(d, t) for d, t in zip(S2.date, S2.team)]
    table(S2.dropna(subset=["status"]), "d_bb", "D. Starter walk rate vs his own (pp), by HIS club's status", "{:+.2f}")
    S2["status"] = [stat(d, o) for d, o in zip(S2.date, S2.opp)]
    table(S2.dropna(subset=["status"]), "d_bb", "   ... by the OPPONENT's status (the lineup he faces)", "{:+.2f}")
