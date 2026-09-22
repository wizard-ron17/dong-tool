"""Build the shots-on-goal dataset: one row per skater-game, features from
games STRICTLY BEFORE it.

Mirrors build_dataset.py's rules, with the two bugs its memory flags designed
out rather than guarded:
  * every rolling feature is a cumulative sum SHIFTED by one game, so a row can
    never see its own outcome — no per-row loop that can rebind a frame and
    misalign an index;
  * the shrinkage target is a prior-seasons-only position mean, computed
    walk-forward, so early-season rows cannot borrow the future.

    python3 research/nhl_sog_data.py   # -> research/nhl_sog.parquet
"""
import json, os, glob
import numpy as np
import pandas as pd

HERE = os.path.dirname(os.path.abspath(__file__))
CACHE = os.environ.get("NHL_CACHE") or "/tmp/nhl-cache"
OUT = os.path.join(HERE, "nhl_sog.parquet")
SHRINK_K = 8.0        # games of prior weight; receptions uses a comparable k


def load():
    sk, tm = [], []
    for season_dir in sorted(glob.glob(os.path.join(CACHE, "20*"))):
        season = int(os.path.basename(season_dir))
        for date_dir in sorted(glob.glob(os.path.join(season_dir, "20*-*-*"))):
            date = os.path.basename(date_dir)
            need = [os.path.join(date_dir, f + ".json") for f in ("summary", "realtime", "timeonice", "team")]
            if not all(os.path.exists(p) for p in need):
                continue
            s, r, t, m = [json.load(open(p)) for p in need]
            if not s:
                continue
            by_r = {x["playerId"]: x for x in r}
            by_t = {x["playerId"]: x for x in t}
            for row in s:
                pid = row["playerId"]
                rr, tt = by_r.get(pid, {}), by_t.get(pid, {})
                sk.append(dict(
                    season=season, date=date, pid=pid,
                    name=row.get("skaterFullName"), pos=row.get("positionCode"),
                    teams=(row.get("teamAbbrevs") or "").strip(),
                    sog=row.get("shots") or 0, goals=row.get("goals") or 0,
                    evg=row.get("evGoals") or 0, ppg=row.get("ppGoals") or 0,
                    toi=row.get("timeOnIcePerGame") or 0.0,
                    icf=rr.get("totalShotAttempts") or 0,      # Individual Corsi For
                    blk=rr.get("shotAttemptsBlocked") or 0,    # his own attempts blocked
                    miss=rr.get("missedShots") or 0,
                    pptoi=tt.get("ppTimeOnIcePerGame") or 0.0,
                    shifts=tt.get("shifts") or 0))
            for x in m:
                tm.append(dict(season=season, date=date, team_name=x["teamFullName"],
                               sf=x.get("shotsForPerGame") or 0.0,
                               sa=x.get("shotsAgainstPerGame") or 0.0,
                               gf=x.get("goalsFor") or 0.0, ga=x.get("goalsAgainst") or 0.0,
                               pk=x.get("penaltyKillPct") if x.get("penaltyKillPct") is not None else np.nan,
                               pp=x.get("powerPlayPct") if x.get("powerPlayPct") is not None else np.nan))
    return pd.DataFrame(sk), pd.DataFrame(tm)


def asof_mean(df, group, num, den, k, prior):
    """Shrunk mean of num/den over all PRIOR rows in `group`, walk-forward.

    cumsum().shift() inside the group is the whole trick: row i sees rows
    0..i-1 and nothing else.
    """
    g = df.groupby(group, sort=False)
    n = g[num].cumsum() - df[num]
    d = g[den].cumsum() - df[den]
    return (n + k * prior) / (d + k)


def build():
    sk, tm = load()
    if sk.empty:
        raise SystemExit("no cache — run research/nhl_fetch.py first")
    # A traded player's row lists every club he played for that season, and the
    # LAST one is where he ended up — not who he suited up for on this date. Pick
    # whichever of his abbrevs is actually on the schedule that night.
    playing = playing_map()
    def resolve(season, date, teams):
        opts = [t.strip() for t in teams.split(",") if t.strip()]
        if len(opts) == 1:
            return opts[0]
        for t in opts:
            if (season, date, t) in playing:
                return t
        return opts[-1] if opts else ""
    sk["team"] = [resolve(s_, d, t) for s_, d, t in zip(sk.season, sk.date, sk.teams)]
    sk = sk.sort_values(["pid", "season", "date"]).reset_index(drop=True)
    sk["one"] = 1.0
    sk["iff"] = sk.icf - sk.blk                       # Individual Fenwick For
    # Forwards vs defence is the single biggest split in shot volume.
    sk["role"] = np.where(sk.pos == "D", "D", "F")

    # League means from PRIOR seasons only, as the shrinkage target.
    seasons = sorted(sk.season.unique())
    tgt = {}
    for i, s in enumerate(seasons):
        past = sk[sk.season < s]
        base = past if len(past) else sk[sk.season == s]     # first season bootstraps on itself
        for role in ("F", "D"):
            b = base[base.role == role]
            tgt[(s, role)] = dict(
                sog=b.sog.mean() or 1.0, icf=b.icf.mean() or 1.0, iff=b.iff.mean() or 1.0,
                toi=b.toi.mean() or 900.0, pptoi=b.pptoi.mean() or 30.0,
                conv=(b.sog.sum() / max(b.icf.sum(), 1)) or 0.55)
    for f in ("sog", "icf", "iff", "toi", "pptoi", "conv"):
        sk["_t_" + f] = [tgt[(s, r)][f] for s, r in zip(sk.season, sk.role)]
    tgt_g = {}
    for s_ in seasons:
        past = sk[sk.season < s_]
        base = past if len(past) else sk[sk.season == s_]
        for role in ("F", "D"):
            b = base[base.role == role]
            tgt_g[(s_, role)] = dict(goals=b.goals.mean(), evg=b.evg.mean(), ppg=b.ppg.mean())

    # Career-to-date (crosses seasons: a shooter is a shooter), shrunk.
    for f in ("sog", "icf", "iff", "toi", "pptoi"):
        sk[f + "_prior"] = asof_mean(sk, "pid", f, "one", SHRINK_K, sk["_t_" + f])
    # ── Goal features (the Picks / anytime-goal model) ──
    for f in ("goals", "evg", "ppg"):
        pri = sk.groupby(["season", "role"])[f].transform("mean")  # replaced below by prior-season means
        sk[f + "_t"] = [tgt_g[(s_, r_)][f] for s_, r_ in zip(sk.season, sk.role)]
        sk[f + "_prior"] = asof_mean(sk, "pid", f, "one", SHRINK_K * 2, sk[f + "_t"])
    # Career shooting %: goals per shot, shrunk hard — finishing talent is real
    # but a small-sample shooting % is mostly luck.
    sk["shpct_prior"] = asof_mean(sk, "pid", "goals", "sog", 120.0, sk["goals_t"] / sk["_t_sog"])
    sk["goals_l10"] = (sk.groupby("pid", sort=False)["goals"]
                         .transform(lambda s_: s_.shift(1).rolling(10, min_periods=2).mean())).fillna(sk.goals_prior)

    # Share of his own attempts that reach the net — the "catch rate" analogue.
    sk["conv_prior"] = asof_mean(sk, "pid", "sog", "icf", SHRINK_K * 3, sk["_t_conv"])
    # Shots per 60 of ice time: volume with the minutes divided out.
    sk["toi_h"] = sk.toi / 3600.0
    sk["sog60_prior"] = asof_mean(sk, "pid", "sog", "toi_h", SHRINK_K / 4, sk["_t_sog"] / (sk["_t_toi"] / 3600.0))

    # Rolling windows. Ron asked for last-5 and last-10; both are built and the
    # ladder decides. shift(1) keeps the current game out of its own feature.
    for w in (5, 10):
        for f in ("sog", "icf", "toi", "pptoi"):
            r = (sk.groupby("pid", sort=False)[f]
                   .transform(lambda s, w=w: s.shift(1).rolling(w, min_periods=2).mean()))
            sk[f"{f}_l{w}"] = r.fillna(sk[f + "_prior"])

    # Team context, also as-of: own team's shots-for, opponent's shots-allowed.
    if not tm.empty:
        NAME2AB = team_map(sk, tm)
        tm["team"] = tm.team_name.map(NAME2AB)
        tm = tm.dropna(subset=["team"]).sort_values(["team", "season", "date"]).reset_index(drop=True)
        tm["one"] = 1.0
        for f in ("sf", "sa", "gf", "ga"):
            tm[f + "_prior"] = asof_mean(tm, "team", f, "one", 10.0, tm[f].mean())
        tm["pk_f"] = tm.pk.fillna(tm.pk.mean())
        tm["pk_prior"] = asof_mean(tm, "team", "pk_f", "one", 10.0, tm.pk_f.mean())
        # who played whom, that date
        pair = tm.groupby(["season", "date"])["team"].apply(list).to_dict()
        opp = opponents(tm)
        tm["opp"] = [opp.get((s, d, t)) for s, d, t in zip(tm.season, tm.date, tm.team)]
        home = home_map()
        sa = tm.set_index(["season", "date", "team"])["sa_prior"].to_dict()
        sf = tm.set_index(["season", "date", "team"])["sf_prior"].to_dict()
        om = tm.set_index(["season", "date", "team"])["opp"].to_dict()
        key = list(zip(sk.season, sk.date, sk.team))
        sk["team_sf_prior"] = [sf.get(k, np.nan) for k in key]
        sk["opp"] = [opp.get(k) for k in key]
        sk["opp_sa_prior"] = [sa.get((s, d, o), np.nan) if o else np.nan
                              for s, d, o in zip(sk.season, sk.date, sk.opp)]
        for col, src in (("opp_ga_prior", "ga_prior"), ("opp_pk_prior", "pk_prior")):
            mp = tm.set_index(["season", "date", "team"])[src].to_dict()
            sk[col] = [mp.get((s, d, o), np.nan) if o else np.nan for s, d, o in zip(sk.season, sk.date, sk.opp)]
        gfm = tm.set_index(["season", "date", "team"])["gf_prior"].to_dict()
        sk["team_gf_prior"] = [gfm.get(k, np.nan) for k in key]
        sk["is_home"] = [1.0 if home.get((s, d, t)) else 0.0 for s, d, t in key]
    for c in ("team_sf_prior", "opp_sa_prior", "opp_ga_prior", "opp_pk_prior", "team_gf_prior"):
        sk[c] = sk[c].fillna(sk[c].mean())

    # A skater needs some history before he is predictable at all; the app will
    # price the rest off a positional baseline the way thin.py does in /nfl.
    sk["gp_prior"] = sk.groupby("pid", sort=False)["one"].cumsum() - 1
    out = sk[(sk.gp_prior >= 5) & (sk.toi > 0)].copy()
    out.to_parquet(OUT)
    print(f"{len(out):,} skater-games, {out.pid.nunique():,} skaters, seasons {sorted(out.season.unique())}")
    print(f"mean SOG {out.sog.mean():.3f}   var/mean {out.sog.var()/out.sog.mean():.3f}")
    return out


def playing_map():
    """(season, date, team) for every club that actually played that night."""
    out = set()
    for f in glob.glob(os.path.join(CACHE, "20*", "games.json")):
        season = int(os.path.basename(os.path.dirname(f)))
        for g in json.load(open(f)):
            out.add((season, g["date"], g["home"]))
            out.add((season, g["date"], g["away"]))
    return out


def home_map():
    out = {}
    for f in glob.glob(os.path.join(CACHE, "20*", "games.json")):
        season = int(os.path.basename(os.path.dirname(f)))
        for g in json.load(open(f)):
            out[(season, g["date"], g["home"])] = True
            out[(season, g["date"], g["away"])] = False
    return out


def team_map(sk, tm):
    """teamFullName -> abbrev, learned from which abbrevs play on which dates."""
    by_date = sk.groupby(["season", "date"])["team"].apply(set).to_dict()
    counts = {}
    for s, d, n in zip(tm.season, tm.date, tm.team_name):
        for ab in by_date.get((s, d), ()):
            counts.setdefault(n, {}).setdefault(ab, 0)
            counts[n][ab] += 1
    # the abbrev that co-occurs with a club name on the most dates is its abbrev
    return {n: max(c, key=c.get) for n, c in counts.items()}


def opponents(_tm=None):
    """(season, date, team) -> the club it faced, off the cached schedule.

    A date has several games, so the pair cannot be inferred from the team
    report alone — matching one club's shots-for to another's shots-against is
    ambiguous the moment two games share a score line.
    """
    out = {}
    for f in glob.glob(os.path.join(CACHE, "20*", "games.json")):
        season = int(os.path.basename(os.path.dirname(f)))
        for g in json.load(open(f)):
            out[(season, g["date"], g["home"])] = g["away"]
            out[(season, g["date"], g["away"])] = g["home"]
    return out


if __name__ == "__main__":
    build()
