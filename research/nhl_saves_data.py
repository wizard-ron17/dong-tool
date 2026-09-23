"""Build the saves / goals-allowed dataset: one row per goalie START, features
from games strictly before it.

Same rules as nhl_sog_data.py (cumsum-shift as-of means, prior-season shrink
targets, opponents and traded players resolved against the cached schedule),
and it borrows that file's helpers rather than re-deriving them.

    python3 research/nhl_fetch.py         # adds goalie.json per date to the cache
    python3 research/nhl_saves_data.py    # -> research/nhl_saves.parquet
"""
import json, os, glob
import numpy as np
import pandas as pd
from nhl_sog_data import CACHE, asof_mean, playing_map, opponents, home_map, load as load_skaters, team_map

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "nhl_saves.parquet")
SV_SHRINK = 1500.0     # shots of league-average save % a goalie starts with — sv% is mostly noise
RATE_SHRINK = 8.0      # starts of prior weight on per-start rates
PREV_TEAM_W = 0.35     # last season's weight in a team rate — scripts/nhl-shots.js absorb()
RELIEF_UNITS = 0.35    # a relief appearance counts as this much of a start


def two_season(df, key, cols, prev_w):
    """Per row: this season's totals BEFORE the row, plus prev_w x the previous
    season's full totals, for `key`. The build can compute exactly this from two
    season aggregates and the season to date; a career-long as-of mean cannot
    be, and it lags a league whose shot rate falls every year."""
    df = df.sort_values([key, "season", "date"])
    out = {}
    g = df.groupby([key, "season"], sort=False)
    for c in cols:
        cur = g[c].cumsum() - df[c]
        tot = df.groupby([key, "season"])[c].sum()
        prev = [tot.get((k, s - 10001), 0.0) for k, s in zip(df[key], df.season)]
        out[c] = (cur + prev_w * np.array(prev)).reindex(df.index)
    return out


def load_goalies():
    rows = []
    for season_dir in sorted(glob.glob(os.path.join(CACHE, "20*"))):
        season = int(os.path.basename(season_dir))
        for p in sorted(glob.glob(os.path.join(season_dir, "20*-*-*", "goalie.json"))):
            date = os.path.basename(os.path.dirname(p))
            for r in json.load(open(p)):
                rows.append(dict(season=season, date=date, pid=r["playerId"], name=r.get("goalieFullName"),
                                 teams=(r.get("teamAbbrevs") or "").strip(),
                                 start=int(r.get("gamesStarted") or 0),
                                 sa=r.get("shotsAgainst") or 0, sv=r.get("saves") or 0,
                                 ga=r.get("goalsAgainst") or 0, toi=r.get("timeOnIce") or 0))
    return pd.DataFrame(rows)


def build():
    g = load_goalies()
    if g.empty:
        raise SystemExit("no goalie cache — run research/nhl_fetch.py first")
    playing = playing_map()
    def resolve(season, date, teams):
        opts = [t.strip() for t in teams.split(",") if t.strip()]
        for t in opts:
            if (season, date, t) in playing:
                return t
        return opts[-1] if opts else ""
    g["team"] = [resolve(s, d, t) for s, d, t in zip(g.season, g.date, g.teams)]
    g = g.sort_values(["pid", "season", "date"]).reset_index(drop=True)
    g["one"] = 1.0

    # League targets from PRIOR seasons (first season bootstraps on itself).
    seasons = sorted(g.season.unique())
    tgt = {}
    for s in seasons:
        b = g[(g.season < s) & (g.start == 1)]
        if b.empty: b = g[(g.season == s) & (g.start == 1)]
        tgt[s] = dict(svp=b.sv.sum() / b.sa.sum(), sv=b.sv.mean(), sa=b.sa.mean(), ga=b.ga.mean(),
                      pulled=(b.toi < 3000).mean())
    for k in ("svp", "sv", "sa", "ga", "pulled"):
        g["_t_" + k] = g.season.map(lambda s, k=k: tgt[s][k])

    # This season to date + last season, every appearance — what the build has
    # from two goalie/summary aggregates. Relief appearances count as a third of
    # a start for the per-start rate.
    g["units"] = np.where(g.start == 1, 1.0, RELIEF_UNITS)
    T = two_season(g, "pid", ["sv", "sa", "units"], 1.0)
    g["svp_prior"] = (T["sv"] + SV_SHRINK * g._t_svp) / (T["sa"] + SV_SHRINK)
    g["sv_prior2"] = (T["sv"] + RATE_SHRINK * g._t_sv) / (T["units"] + RATE_SHRINK)
    g["gs2"] = two_season(g, "pid", ["start"], 1.0)["start"]
    # Per-START rows.
    st = g[g.start == 1].copy()
    st["pulled"] = (st.toi < 3000).astype(float)          # under 50 minutes: pulled or hurt
    st["sv_prior"] = st.sv_prior2
    st["sa_prior"] = asof_mean(st, "pid", "sa", "one", RATE_SHRINK, st._t_sa)
    st["ga_prior"] = asof_mean(st, "pid", "ga", "one", RATE_SHRINK, st._t_ga)
    st["pull_prior"] = asof_mean(st, "pid", "pulled", "one", RATE_SHRINK * 2, st._t_pulled)
    for w in (5, 10):
        for f in ("sv", "sa", "ga"):
            st[f"{f}_l{w}"] = (st.groupby("pid", sort=False)[f]
                                 .transform(lambda x, w=w: x.shift(1).rolling(w, min_periods=2).mean())
                              ).fillna(st[f + "_prior"])
    st["gp_prior"] = st.gs2          # starts this season + last, as the build counts them

    # Team context, as-of — the same team report the shots model reads.
    _, tm = load_skaters()
    sk_like = pd.DataFrame({"season": g.season, "date": g.date, "team": g.team})
    NAME2AB = team_map(sk_like, tm)
    tm["team"] = tm.team_name.map(NAME2AB)
    tm = tm.dropna(subset=["team"]).sort_values(["team", "season", "date"]).reset_index(drop=True)
    tm["one"] = 1.0
    # Team rates: this season to date + 0.35 x last season, the build's recipe.
    # A club with no games at all falls back to the league mean of prior seasons.
    T = two_season(tm, "team", ["sf", "sa", "gf", "ga", "one"], PREV_TEAM_W)
    for f in ("sf", "sa", "gf", "ga"):
        lg = tm.groupby("season")[f].mean().shift(1).reindex(tm.season).to_numpy()
        lg = np.where(np.isnan(lg), tm[f].mean(), lg)
        tm[f + "_prior"] = np.where(T["one"] > 0, T[f] / T["one"].replace(0, np.nan), lg)
    # last-10 team form, as-of
    for f in ("sf", "sa"):
        tm[f + "_l10"] = (tm.groupby("team", sort=False)[f]
                            .transform(lambda x: x.shift(1).rolling(10, min_periods=3).mean())).fillna(tm[f + "_prior"])
    opp = opponents()
    home = home_map()
    idx = tm.set_index(["season", "date", "team"])
    key = list(zip(st.season, st.date, st.team))
    st["opp"] = [opp.get(k) for k in key]
    okey = [(s, d, o) for s, d, o in zip(st.season, st.date, st.opp)]
    for col, src, keys in (("team_sa_prior", "sa_prior", key), ("team_ga_prior", "ga_prior", key),
                           ("team_sa_l10", "sa_l10", key),
                           ("opp_sf_prior", "sf_prior", okey), ("opp_gf_prior", "gf_prior", okey),
                           ("opp_sf_l10", "sf_l10", okey)):
        mp = idx[src].to_dict()
        st[col] = [mp.get(k, np.nan) for k in keys]
        st[col] = st[col].fillna(st[col].mean())
    st["is_home"] = [1.0 if home.get(k) else 0.0 for k in key]
    # Back-to-back: his club played the night before.
    from datetime import date as D, timedelta
    prev = lambda d: (D.fromisoformat(d) - timedelta(days=1)).isoformat()
    playing = playing_map()
    st["team_b2b"] = [1.0 if (s, prev(d), t) in playing else 0.0 for s, d, t in key]
    st["opp_b2b"] = [1.0 if (s, prev(d), o) in playing else 0.0 for s, d, o in okey]

    out = st[(st.gp_prior >= 3) & st.opp.notna()].copy()
    out.to_parquet(OUT)
    print(f"{len(out):,} starts, {out.pid.nunique()} goalies, seasons {sorted(out.season.unique())}")
    for c in ("sv", "sa", "ga"):
        print(f"  {c}: mean {out[c].mean():.2f}  var/mean {out[c].var() / out[c].mean():.3f}")
    print(f"  pulled {out.pulled.mean():.1%}")
    return out


if __name__ == "__main__":
    build()
