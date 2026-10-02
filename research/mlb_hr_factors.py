"""Does any Pick Score factor (or anything else we can think of) belong in the HR odds?

    python3 research/mlb_pa_fetch.py 2024 2025 2026     # Savant PA lines (cached)
    python3 research/mlb_game_meta_fetch.py             # day/night + weather
    python3 research/mlb_hr_factors.py                  # the scan

The odds (research/mlb_hr_replay.py v1) price a starting batter off his power
(HR/AB, barrels and blasts per PA), the opposing starter's barrels per batter
faced, lineup slot and park. The Pick Score multiplied those and a list of
matchup factors at weight 1, each theorised before we had odds to test against.
This puts every one of them, in the form the live build computes it and in
other forms, on top of v1 and asks three things, walk-forward by month (each
month predicted by a model fitted only on the months before it), 2025-26:

  free weight   does it lower out-of-sample log loss (paired t over games), and
                what coefficient does it earn? (1 = the Pick Score's weight)
  score weight  v1 plus the factor applied at the Pick Score's weight (an
                offset of 1 x ln(factor)): does that help the odds or hurt them?
  buckets       in the factor's top fifth, do batters homer more than v1 says?

Plus the screen Ron and Bueno run on the Matchup table (green platoon, green
pitcher vuln, green recent contact), priced against v1.

All features use games on EARLIER dates only.
"""
import glob, os, sys
import numpy as np
import pandas as pd

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
_ARGV = list(sys.argv); sys.argv = sys.argv[:1]
import mlb_hr_replay as R

PA_CACHE = os.path.join(HERE, ".cache", "savant_pa")
META = os.path.join(HERE, ".cache", "mlb_game_meta.parquet")
OUT = os.path.join(HERE, "mlb_hr_factors_frame.parquet")
CAP = (0.7, 1.4)                      # PICKS_RATIO_MIN / MAX in build-data.js


# ── data ──────────────────────────────────────────────────────────────────
def load_pa():
    fs = sorted(f for f in glob.glob(os.path.join(PA_CACHE, "*.parquet")) if not f.endswith("_pit.parquet"))
    pa = pd.concat([pd.read_parquet(f) for f in fs if os.path.getsize(f) > 2000], ignore_index=True)
    pa["date"] = pa.date.astype(str).str[:10]
    pa["season"] = pa.date.str[:4].astype(int)
    pa["hr"] = (pa.events == "home_run").astype(float)
    pa["one"] = 1.0
    pa["bbe"] = pa.launch_speed.notna() & pa.bb_type.notna()
    pa["air"] = pa.bb_type.isin(["fly_ball", "line_drive"])
    # "qualifying fly": hit hard enough, at a homer's angle
    pa["qfly"] = (pa.air & (pa.launch_speed >= 95) & pa.launch_angle.between(20, 35)).astype(float)
    pa["hard"] = (pa.bbe & (pa.launch_speed >= 95)).astype(float)
    # spray angle: 0 = center, negative = third-base side
    ang = np.degrees(np.arctan2(pa.hc_x - 125.42, 198.27 - pa.hc_y))
    pa["pull_air"] = (pa.air & (((pa.stand == "R") & (ang < -15)) | ((pa.stand == "L") & (ang > 15)))).astype(float)
    pa["same"] = (pa.stand == pa.p_throws)
    for c in ("barrel", "blast"): pa[c] = pa[c].astype(float)
    pa["lsa"] = pa.launch_speed_angle.where(pa.launch_speed_angle.between(1, 6))
    pa["bat_team"] = np.where(pa.top, pa.away_team, pa.home_team)
    pa["pit_team"] = np.where(pa.top, pa.home_team, pa.away_team)
    return pa


def load_velo():
    fs = sorted(glob.glob(os.path.join(PA_CACHE, "*_pit.parquet")))
    v = pd.concat([pd.read_parquet(f).assign(date=os.path.basename(f)[:10]) for f in fs if os.path.getsize(f) > 1500], ignore_index=True)
    v["season"] = v.date.str[:4].astype(int)
    return v


def todate(df, key, num, den, k, lg, k_prior=None):
    """num/den per key over strictly earlier dates this season, shrunk toward
    last season's rate (itself shrunk toward lg); NaN-safe."""
    return R.shrunk_to_date(df, key, num, den, "_r", k, k_prior or k, lg)


def masof(left, right, left_on, right_on, by, direction="backward"):
    """merge_asof on string dates (it wants real ones): each left row takes the right
    row with the latest date on or before its own, within `by`."""
    L, Rt = left.copy(), right.copy()
    L["_t"], Rt["_t"] = pd.to_datetime(L[left_on]), pd.to_datetime(Rt[right_on])
    for b in by:   # string keys arrive as str on one side and object on the other
        if L[b].dtype.kind not in "iuf" or Rt[b].dtype.kind not in "iuf":
            L[b], Rt[b] = L[b].astype(object).astype(str), Rt[b].astype(object).astype(str)
    out = pd.merge_asof(L.sort_values("_t"), Rt.drop(columns=[right_on]).sort_values("_t"), on="_t", by=by, direction=direction)
    return out.drop(columns="_t")


def lastn(daily, key, cols, n):
    """Sums over the key's previous n game-dates (any season), excluding today."""
    d = daily.sort_values([key, "date"]).copy()
    g = d.groupby(key, sort=False)
    for c in cols:
        d[f"{c}_l{n}"] = g[c].transform(lambda s: s.shift(1).rolling(n, min_periods=1).sum()).fillna(0)
    return d


# ── features ──────────────────────────────────────────────────────────────
def frame():
    if os.path.exists(OUT) and "rebuild" not in _ARGV:
        return pd.read_parquet(OUT)
    df, bats, p, lgp = R.v1_frame()
    df = df[df.season >= 2025].copy()
    pa = load_pa()
    meta = pd.read_parquet(META)
    # today's starter hand, and the batter's side against him (switch hitters bat opposite)
    sp_hand = pa.groupby("pitcher").p_throws.agg(lambda s: s.mode().iat[0])
    stands = pa.groupby("batter").stand.agg(lambda s: "S" if s.nunique() > 1 and s.value_counts(normalize=True).min() > 0.1 else s.mode().iat[0])
    df["p_hand"] = df.opp_sp.map(sp_hand)
    df["b_hand"] = df.pid.map(stands)
    df["side"] = np.where(df.b_hand == "S", np.where(df.p_hand == "L", "R", "L"), df.b_hand)
    df["same"] = df.side == df.p_hand
    df = df[df.p_hand.notna() & df.side.notna()].copy()

    lg_hr = pa.hr.mean()
    lg_same, lg_opp = pa[pa.same].hr.mean(), pa[~pa.same].hr.mean()

    # 1. batter platoon (as shipped: HR/PA by same/opp class, shrunk 400 PA, today / other, capped)
    pa["bkey"] = pa.batter.astype(str) + "|" + np.where(pa.same, "s", "o")
    rs = todate(pa[pa.same], "bkey", "hr", "one", 400, lg_same).rename(columns={"bkey": "k_s", "_r": "b_same"})
    ro = todate(pa[~pa.same], "bkey", "hr", "one", 400, lg_opp).rename(columns={"bkey": "k_o", "_r": "b_opp"})
    # carry each batter's latest to-date split onto every later date (a split he hasn't faced today still exists)
    def asof(tab, kcol, val, prefix):
        t = tab.copy(); t["pid"] = t[kcol].str.split("|").str[0].astype(int)
        return t[["pid", "season", "date", val]].sort_values("date")
    bs = asof(rs, "k_s", "b_same", "s"); bo = asof(ro, "k_o", "b_opp", "o")
    df = df.sort_values("date")
    df = masof(df, bs.rename(columns={"date": "d_s"}).sort_values("d_s"), left_on="date", right_on="d_s", by=["pid", "season"], direction="backward")
    df = masof(df.sort_values("date"), bo.rename(columns={"date": "d_o"}).sort_values("d_o"), left_on="date", right_on="d_o", by=["pid", "season"], direction="backward")
    df["b_same"] = df.b_same.fillna(lg_same); df["b_opp"] = df.b_opp.fillna(lg_opp)
    raw = np.where(df.same, df.b_same / df.b_opp, df.b_opp / df.b_same)
    df["bplat_raw"] = raw
    df["bplat_ship"] = np.clip(raw, *CAP)
    # 1b. platoon on barrels instead of homers
    lgb_s, lgb_o = pa[pa.same].barrel.mean(), pa[~pa.same].barrel.mean()
    rbs = todate(pa[pa.same], "bkey", "barrel", "one", 200, lgb_s); rbo = todate(pa[~pa.same], "bkey", "barrel", "one", 200, lgb_o)
    for t, nm in ((rbs, "bb_same"), (rbo, "bb_opp")):
        t = t.rename(columns={"_r": nm}); t["pid"] = t.bkey.str.split("|").str[0].astype(int)
        df = masof(df.sort_values("date"), t[["pid", "season", "date", nm]].rename(columns={"date": "d_" + nm}).sort_values("d_" + nm),
                           left_on="date", right_on="d_" + nm, by=["pid", "season"], direction="backward")
    df["bb_same"] = df.bb_same.fillna(lgb_s); df["bb_opp"] = df.bb_opp.fillna(lgb_o)
    df["bplat_brl"] = np.where(df.same, df.bb_same / df.bb_opp, df.bb_opp / df.bb_same)

    # 2. starter platoon vuln (as shipped: his HR allowed vs the batter's side / vs the other side, shrunk ~100 IP)
    pa["pkey"] = pa.pitcher.astype(str) + "|" + pa.stand.where(pa.stand.isin(["L", "R"]), "R")
    lgL, lgR = pa[pa.stand == "L"].hr.mean(), pa[pa.stand == "R"].hr.mean()
    for side, lg in (("L", lgL), ("R", lgR)):
        t = todate(pa[pa.stand == side], "pkey", "hr", "one", 430, lg).rename(columns={"_r": f"sp_v{side}"})
        t["opp_sp"] = t.pkey.str.split("|").str[0].astype(int)
        df = masof(df.sort_values("date"), t[["opp_sp", "season", "date", f"sp_v{side}"]].rename(columns={"date": f"d_v{side}"}).sort_values(f"d_v{side}"),
                           left_on="date", right_on=f"d_v{side}", by=["opp_sp", "season"], direction="backward")
        df[f"sp_v{side}"] = df[f"sp_v{side}"].fillna(lg)
    df["sp_vside"] = np.where(df.side == "L", df.sp_vL, df.sp_vR)
    df["sp_vother"] = np.where(df.side == "L", df.sp_vR, df.sp_vL)
    df["svuln_ship"] = np.clip(df.sp_vside / df.sp_vother, *CAP)
    df["svuln_level"] = df.sp_vside / np.where(df.side == "L", lgL, lgR)        # his HR rate vs this side, vs league

    # 3. stuff: starter's fastball velo to date (season, game-weighted) — the live factor's other half
    v = load_velo().rename(columns={"pitcher": "opp_sp"})
    vd = v.groupby(["opp_sp", "season", "date"], as_index=False).fb_velo.mean().sort_values(["opp_sp", "date"])
    vd["velo_td"] = vd.groupby(["opp_sp", "season"]).fb_velo.transform(lambda s: s.shift(1).expanding().mean())
    df = masof(df.sort_values("date"), vd[["opp_sp", "season", "date", "velo_td"]].rename(columns={"date": "d_velo"}).sort_values("d_velo"),
                       left_on="date", right_on="d_velo", by=["opp_sp", "season"], direction="backward")
    med_velo = vd.velo_td.median()
    df["velo_td"] = df.velo_td.fillna(med_velo)
    df["stuff_velo"] = np.clip(1 + 0.05 * (med_velo - df.velo_td), *CAP)       # STUFF_W_VELO as shipped

    # 4. recent contact (as shipped: mean Statcast contact grade, last 15 game-dates vs the rest of his season, shrunk 20, capped .85-1.15)
    bb = pa[pa.lsa.notna()]
    dd = bb.groupby(["batter", "season", "date"], as_index=False).agg(q=("lsa", "sum"), n=("lsa", "size"),
          brl=("barrel", "sum"), hard=("hard", "sum"), qf=("qfly", "sum"), pull=("pull_air", "sum"))
    pd_ = pa.groupby(["batter", "season", "date"], as_index=False).agg(pa_n=("one", "sum"), hr=("hr", "sum"))
    dd = pd_.merge(dd, on=["batter", "season", "date"], how="left").fillna(0).sort_values(["batter", "date"])
    g = dd.groupby(["batter", "season"], sort=False)
    for c in ("q", "n", "brl", "hard", "qf", "pull", "pa_n", "hr"):
        dd[c + "_cum"] = g[c].cumsum() - dd[c]
        dd[c + "_r15"] = g[c].transform(lambda s: s.shift(1).rolling(15, min_periods=1).sum()).fillna(0)
        dd[c + "_r7"] = g[c].transform(lambda s: s.shift(1).rolling(7, min_periods=1).sum()).fillna(0)
    dd["dates_cum"] = g.cumcount()
    rq = dd.q_r15 / dd.n_r15.replace(0, np.nan)
    base_n = (dd.n_cum - dd.n_r15).clip(lower=0); base_q = (dd.q_cum - dd.q_r15) / base_n.replace(0, np.nan)
    shrunk = (rq * dd.n_r15 + base_q * 20) / (dd.n_r15 + 20)
    ok = (dd.dates_cum >= 5) & (dd.n_r15 >= 8) & base_q.notna()
    dd["recent_ship"] = np.where(ok, np.clip(shrunk / base_q, 0.85, 1.15), 1.0)
    # alternatives: last-15 and last-7 barrel / hard-hit / qualifying-fly rates per PA vs his season to date
    def rel(rcol, ncol, ccol, ncum, k):
        season_rate = (dd[ccol] + 1e-9) / (dd[ncum] + 1e-9)
        lg = dd[ccol].sum() / dd[ncum].sum()
        sr = (dd[ccol] + k * lg) / (dd[ncum] + k)
        rr = (dd[rcol] + k * sr) / (dd[ncol] + k)
        return rr / sr
    dd["recent_brl15"] = rel("brl_r15", "pa_n_r15", "brl_cum", "pa_n_cum", 40)
    dd["recent_hard15"] = rel("hard_r15", "pa_n_r15", "hard_cum", "pa_n_cum", 40)
    dd["recent_qfly15"] = rel("qf_r15", "pa_n_r15", "qf_cum", "pa_n_cum", 40)
    dd["recent_qfly7"] = rel("qf_r7", "pa_n_r7", "qf_cum", "pa_n_cum", 25)
    lgqf, lgpull = dd.qf.sum() / dd.pa_n.sum(), dd.pull.sum() / dd.pa_n.sum()
    dd["qfly_rate"] = (dd.qf_cum + 60 * lgqf) / (dd.pa_n_cum + 60) / lgqf        # season qualifying flies per PA vs league
    dd["pull_air_rate"] = (dd.pull_cum + 60 * lgpull) / (dd.pa_n_cum + 60) / lgpull
    # streaks: homers in his last 7 / 15 game-dates, vs what his season rate expected; days since his last homer
    exp_rate = (dd.hr_cum + 100 * lg_hr) / (dd.pa_n_cum + 100)
    dd["hr_l7"], dd["hr_l15"] = dd.hr_r7, dd.hr_r15
    dd["hot7"] = (dd.hr_r7 + 2) / (exp_rate * dd.pa_n_r7 + 2)                      # actual / expected, lightly shrunk
    dd["hot15"] = (dd.hr_r15 + 3) / (exp_rate * dd.pa_n_r15 + 3)
    # cooling: homered 2+ times in the 15 before his last 7, and none in the last 7
    dd["cooling"] = ((dd.hr_r15 - dd.hr_r7 >= 2) & (dd.hr_r7 == 0)).astype(float)
    dd["last_hr_date"] = dd.date.where(dd.hr > 0)
    dd["last_hr_date"] = dd.groupby("batter").last_hr_date.transform(lambda s: s.shift(1).ffill())
    dd["days_since_hr"] = (pd.to_datetime(dd.date) - pd.to_datetime(dd.last_hr_date)).dt.days.fillna(60).clip(upper=60)
    keep = ["batter", "season", "date", "recent_ship", "recent_brl15", "recent_hard15", "recent_qfly15", "recent_qfly7",
            "qfly_rate", "pull_air_rate", "hot7", "hot15", "hr_l7", "hr_l15", "cooling", "days_since_hr"]
    df = df.merge(dd[keep].rename(columns={"batter": "pid"}), on=["pid", "season", "date"], how="left")
    for c in keep[3:]:
        df[c] = df[c].fillna({"cooling": 0, "days_since_hr": 60, "hr_l7": 0, "hr_l15": 0}.get(c, 1.0))

    # 5. bullpen: the opposing pen's hand mix vs this batter (as shipped: league same/opp rate by the
    #    pen's share of same-hand arms), and the pen's own HR/PA vs his side to date; both over the pen's share
    rp = pa[~pa.sp]
    lg_avg = (lg_same + lg_opp) / 2
    pen = rp.groupby(["pit_team", "season", "date"], as_index=False).agg(nL=("p_throws", lambda s: (s == "L").sum()), n=("one", "sum"))
    pen = pen.sort_values(["pit_team", "date"]); gp = pen.groupby(["pit_team", "season"], sort=False)
    pen["shareL"] = ((gp.nL.cumsum() - pen.nL) + 30 * 0.3) / ((gp.n.cumsum() - pen.n) + 30)
    # the opposing club (Savant's abbreviation), off the starter's own rows
    opp = pa[pa.sp].drop_duplicates(["game_pk", "pitcher"])[["game_pk", "pitcher", "pit_team"]].rename(columns={"pitcher": "opp_sp"})
    df = df.merge(opp, on=["game_pk", "opp_sp"], how="left")
    df = masof(df.sort_values("date"), pen[["pit_team", "season", "date", "shareL"]].rename(columns={"date": "d_pen"}).sort_values("d_pen"),
                       left_on="date", right_on="d_pen", by=["pit_team", "season"], direction="backward")
    df["shareL"] = df.shareL.fillna(0.3)
    same_share = np.where(df.side == "L", df.shareL, 1 - df.shareL)
    df["penv_ship"] = np.clip((same_share * lg_same + (1 - same_share) * lg_opp) / lg_avg, *CAP)
    rp_side = rp.assign(pkey=rp.pit_team + "|" + rp.stand.where(rp.stand.isin(["L", "R"]), "R"))
    for side, lg in (("L", lgL), ("R", lgR)):
        t = todate(rp_side[rp_side.stand == side], "pkey", "hr", "one", 600, lg).rename(columns={"_r": f"pen_v{side}"})
        t["pit_team"] = t.pkey.str.split("|").str[0]
        df = masof(df.sort_values("date"), t[["pit_team", "season", "date", f"pen_v{side}"]].rename(columns={"date": f"d_pv{side}"}).sort_values(f"d_pv{side}"),
                           left_on="date", right_on=f"d_pv{side}", by=["pit_team", "season"], direction="backward")
        df[f"pen_v{side}"] = df[f"pen_v{side}"].fillna(lg)
    df["pen_level"] = np.where(df.side == "L", df.pen_vL / lgL, df.pen_vR / lgR)
    # the starter's share of the game: his average batters faced per start to date / ~38
    st = pa[pa.sp].groupby(["pitcher", "season", "date"], as_index=False).one.sum().sort_values(["pitcher", "date"])
    st["bf_avg"] = st.groupby(["pitcher", "season"]).one.transform(lambda s: s.shift(1).expanding().mean())
    df = masof(df.sort_values("date"), st[["pitcher", "season", "date", "bf_avg"]].rename(columns={"pitcher": "opp_sp", "date": "d_st"}).sort_values("d_st"),
                       left_on="date", right_on="d_st", by=["opp_sp", "season"], direction="backward")
    df["sW"] = (df.bf_avg.fillna(22) / 38).clip(0.3, 0.85)
    # the score's blended pitcher-platoon term: starter split over his share, pen over the rest
    df["vuln_ship"] = df.sW * df.svuln_ship + (1 - df.sW) * df.penv_ship
    df["vuln_level"] = df.sW * df.svuln_level + (1 - df.sW) * df.pen_level

    # 6. conditions
    df = df.merge(meta[["game_pk", "day", "temp", "wind_mph", "wind_dir", "cond"]], on="game_pk", how="left")
    dome = df.cond.isin(["Dome", "Roof Closed"]) | df.wind_dir.isin(["None"])
    w = df.wind_mph.fillna(0).where(~dome, 0)
    d_ = df.wind_dir.fillna("")
    df["wind_out"] = np.where(d_.str.startswith("Out"), w, np.where(d_.str.startswith("In"), -w, 0.0))
    pull_field = np.where(df.side == "R", "LF", "RF")
    df["wind_pull"] = np.where(d_ == "Out To " + pull_field, w, np.where(d_ == "In From " + pull_field, -w, 0.0))
    df["temp_x"] = np.where(dome, 0.0, (df.temp.fillna(72) - 72) / 10)
    df["day"] = df.day.fillna(False).astype(float)
    df["home_f"] = df.home.astype(float)

    # 7. Value's thesis: blasting harder than he's homering ("overdue")
    df["blast_surplus"] = (df.bat_bls / df.bat_bls.mean()) / (df.bat_rate / df.bat_rate.mean())

    # 8. the score's own matchup factor (park and slot are already in v1; synergy is gone)
    df["mf_ship"] = df.bplat_ship * df.vuln_ship * (df.sW * df.stuff_velo + 1 - df.sW) * df.recent_ship
    df.to_parquet(OUT)
    return df


# ── evaluation ────────────────────────────────────────────────────────────
LOGF = {"bplat_ship", "bplat_raw", "bplat_brl", "svuln_ship", "svuln_level", "stuff_velo", "recent_ship", "recent_brl15",
        "recent_hard15", "recent_qfly15", "recent_qfly7", "qfly_rate", "pull_air_rate", "hot7", "hot15", "penv_ship",
        "pen_level", "vuln_ship", "vuln_level", "blast_surplus", "mf_ship"}
LIN = {"wind_out": "mph out", "wind_pull": "mph to his pull side", "temp_x": "per 10F", "day": "day game", "home_f": "home",
       "hr_l7": "HR, last 7", "hr_l15": "HR, last 15", "cooling": "cooling", "days_since_hr": "days since HR", "velo_td": "SP velo"}


def col(d, f):
    x = d[f].to_numpy(float)
    return np.log(np.clip(x, 1e-6, None)) if f in LOGF else x


def fit(X, y, iters=25):
    w = np.zeros(X.shape[1])
    for _ in range(iters):
        p = 1 / (1 + np.exp(-X @ w))
        H = X.T @ (X * (p * (1 - p))[:, None]) + 1e-4 * np.eye(X.shape[1])
        w += np.linalg.solve(H, X.T @ (y - p) - 1e-4 * w)
    return w, np.sqrt(np.diag(np.linalg.inv(H)))


def walk(df, extra=(), offset=None):
    """Monthly walk-forward from 2025-06; returns out-of-sample p and the test rows' index."""
    months = sorted(df.date.str[:7].unique()); months = [m for m in months if m >= "2025-06"]
    ps, idx = [], []
    for m in months:
        tr, te = df[df.date < m + "-01"], df[df.date.str[:7] == m]
        if not len(te): continue
        Xtr = np.column_stack([R.design(tr, R.V1)] + [col(tr, f) for f in extra]) if extra else R.design(tr, R.V1)
        Xte = np.column_stack([R.design(te, R.V1)] + [col(te, f) for f in extra]) if extra else R.design(te, R.V1)
        if offset is None:
            w, _ = fit(Xtr, tr.y.to_numpy())
            z = Xte @ w
        else:   # v1 refit with the factor as a fixed offset (its score weight)
            otr, ote = col(tr, offset), col(te, offset)
            w = np.zeros(Xtr.shape[1]); y = tr.y.to_numpy()
            for _ in range(25):
                p = 1 / (1 + np.exp(-(Xtr @ w + otr)))
                H = Xtr.T @ (Xtr * (p * (1 - p))[:, None]) + 1e-4 * np.eye(Xtr.shape[1])
                w += np.linalg.solve(H, Xtr.T @ (y - p) - 1e-4 * w)
            z = Xte @ w + ote
        ps.append(1 / (1 + np.exp(-z))); idx.append(te.index.to_numpy())
    return np.concatenate(ps), np.concatenate(idx)


def ll(y, p):
    p = np.clip(p, 1e-9, 1 - 1e-9); return -(y * np.log(p) + (1 - y) * np.log(1 - p))


def main():
    df = frame().reset_index(drop=True)
    df = df.dropna(subset=["bat_rate", "bat_brl", "bat_bls", "sp_bpf", "park"]).reset_index(drop=True)
    p0, ix = walk(df)
    y = df.y.to_numpy()[ix]; l0 = ll(y, p0)
    print(f"{len(df):,} starter-games 2025-26; walk-forward test {len(ix):,} games, {int(y.sum()):,} with a homer; v1 log loss {l0.mean():.5f}\n")
    rows = []
    factors = ["bplat_ship", "bplat_raw", "bplat_brl", "svuln_ship", "svuln_level", "stuff_velo", "velo_td", "penv_ship", "pen_level",
               "vuln_ship", "vuln_level", "recent_ship", "recent_brl15", "recent_hard15", "recent_qfly15", "recent_qfly7",
               "qfly_rate", "pull_air_rate", "hot7", "hot15", "hr_l7", "hr_l15", "cooling", "days_since_hr",
               "wind_out", "wind_pull", "temp_x", "day", "home_f", "blast_surplus", "mf_ship"]
    full = R.design(df, R.V1)
    for f in factors:
        p1, _ = walk(df, extra=(f,))
        l1 = ll(y, p1); dl = l1 - l0
        t = dl.mean() / (dl.std(ddof=1) / np.sqrt(len(dl)))
        w, se = fit(np.column_stack([full, col(df, f)]), df.y.to_numpy())
        b, z = w[-1], w[-1] / se[-1]
        score = ""
        if f in LOGF and f.endswith("_ship"):
            p2, _ = walk(df, offset=f)
            d2 = ll(y, p2) - l0; t2 = d2.mean() / (d2.std(ddof=1) / np.sqrt(len(d2)))
            score = f"{100 * d2.mean() / l0.mean():+.3f}% (t {t2:+.1f})"
        x = df[f].to_numpy(float)[ix]
        q = x >= np.quantile(x, 0.8) if np.unique(x).size > 5 else x > np.median(x)
        top = f"{100 * p0[q].mean():.2f}% -> {100 * y[q].mean():.2f}%"
        rows.append((f, b, z, 100 * dl.mean() / l0.mean(), t, score, top))
        print(f"{f:16s} coef {b:+.3f} (z {z:+5.1f})   free: {100 * dl.mean() / l0.mean():+.3f}% logloss (t {t:+5.1f})   "
              f"score weight: {score or '—':22s}   top fifth v1 said -> hit: {top}", flush=True)

    # Bueno's screen: green platoon, green pitcher vuln, green recent contact (top 40% of the day's slate each)
    t = df.iloc[ix].assign(p=p0)
    for c in ("bplat_ship", "vuln_ship", "recent_ship"):
        t[c + "_pct"] = t.groupby("date")[c].rank(pct=True)
    green = (t.bplat_ship_pct >= 0.6) & (t.vuln_ship_pct >= 0.6) & (t.recent_ship_pct >= 0.6)
    for lab, m in (("all bats", green), ("longshots (v1 under 10%, ~+900 or longer)", green & (t.p < 0.10))):
        g = t[m]
        se = np.sqrt((g.p * (1 - g.p)).sum()) / len(g)
        print(f"\nBueno screen, {lab}: n {len(g):,}  v1 said {100 * g.p.mean():.2f}%  hit {100 * g.y.mean():.2f}%  "
              f"(gap {100 * (g.y.mean() - g.p.mean()):+.2f}pp, z {(g.y.mean() - g.p.mean()) / se:+.1f})")
    return rows


if __name__ == "__main__":
    main()
