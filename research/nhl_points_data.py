"""Points / assists / power-play points dataset: the shots dataset's skater-games
plus each game's assists, points and PP points, the team's goals that night,
and as-of features for all of it — strictly from games before the row.

The idea to test: an assist is half somebody else's event, so points should be
modelled as (goals his team scores) x (his share of them) — "involvement",
hockey's target share — rather than as a player rate alone.

    python3 research/nhl_points_data.py   # -> research/nhl_points.parquet
"""
import json, os, glob
import numpy as np
import pandas as pd
from nhl_sog_data import CACHE, asof_mean

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "nhl_points.parquet")
K = 16.0       # games of prior weight, as the goals model uses


def load():
    rows = []
    for d in glob.glob(os.path.join(CACHE, "20*", "20*-*-*")):
        season, date = int(d.split(os.sep)[-2]), d.split(os.sep)[-1]
        # per-game file when the date has one (research/nhl_game_fetch.py): the
        # old date-partitioned pages duplicated and dropped rows
        p = os.path.join(d, "g_summary.json")
        if not os.path.exists(p): p = os.path.join(d, "summary.json")
        if not os.path.exists(p): continue
        for r in json.load(open(p)):
            rows.append(dict(season=season, date=date, pid=r["playerId"], a=r.get("assists") or 0,
                             pts=r.get("points") or 0, ppp=r.get("ppPoints") or 0))
    team = []
    for p in glob.glob(os.path.join(CACHE, "20*", "20*-*-*", "goals.json")):
        season, date = int(p.split(os.sep)[-3]), p.split(os.sep)[-2]
        for g in json.load(open(p)):
            real = [x for x in g["goals"] if x.get("ptype") != "SO"]
            for side, opp in (("home", "away"), ("away", "home")):
                ab = g[side]
                team.append(dict(season=season, date=date, team=ab,
                                 tg=sum(1 for x in real if x.get("team") == ab),
                                 tppg=sum(1 for x in real if x.get("team") == ab and x.get("str") == "pp")))
    return pd.DataFrame(rows), pd.DataFrame(team)


def build():
    D = pd.read_parquet(os.path.join(HERE, "nhl_sog.parquet"))
    assert not D.duplicated(["season", "date", "pid"]).any(), "nhl_sog.parquet has repeated player-games — rebuild it"
    P, T = load()
    # the per-date warehouse pages occasionally repeat a row; one per player per night
    P = P.drop_duplicates(["season", "date", "pid"]); T = T.drop_duplicates(["season", "date", "team"])
    D = D.merge(P, on=["season", "date", "pid"], how="left").merge(T, on=["season", "date", "team"], how="left")
    miss = D.tg.isna().mean()
    D = D[D.tg.notna() & D.a.notna()].copy()
    D = D.sort_values(["pid", "season", "date"]).reset_index(drop=True)
    seasons = sorted(D.season.unique())
    # role targets from PRIOR seasons (first season bootstraps on itself)
    tgt = {}
    for s in seasons:
        b = D[D.season < s]; b = b if len(b) else D[D.season == s]
        for role in ("F", "D"):
            x = b[b.role == role]
            tgt[(s, role)] = dict(a=x.a.mean(), pts=x.pts.mean(), ppp=x.ppp.mean(),
                                  inv=x.pts.sum() / max(x.tg.sum(), 1), ppinv=x.ppp.sum() / max(x.tppg.sum(), 1))
    for k in ("a", "pts", "ppp", "inv", "ppinv"):
        D["_t_" + k] = [tgt[(s, r)][k] for s, r in zip(D.season, D.role)]
    for f in ("a", "pts", "ppp"):
        D[f + "_prior"] = asof_mean(D, "pid", f, "one", K, D["_t_" + f])
        D[f + "_l10"] = (D.groupby("pid", sort=False)[f]
                           .transform(lambda s: s.shift(1).rolling(10, min_periods=2).mean())).fillna(D[f + "_prior"])
    # involvement: his points over his team's goals in the games he played
    D["inv_prior"] = asof_mean(D, "pid", "pts", "tg", 20.0, D._t_inv)
    D["ppinv_prior"] = asof_mean(D, "pid", "ppp", "tppg", 6.0, D._t_ppinv)
    D["a_inv_prior"] = asof_mean(D, "pid", "a", "tg", 20.0, D._t_inv * (D._t_a / D._t_pts))
    out = D[D.gp_prior >= 5].copy()
    out.to_parquet(OUT)
    print(f"{len(out):,} skater-games ({miss:.1%} dropped without a goal record)")
    for c in ("a", "pts", "ppp"):
        print(f"  {c}: mean {out[c].mean():.3f}  P(1+) {(out[c] > 0).mean():.3f}  var/mean {out[c].var() / out[c].mean():.3f}")
    return out


if __name__ == "__main__":
    build()
