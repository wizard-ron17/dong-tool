"""Kickers: field goals made, PATs made, kicker points. Investigation — nothing shipped.

Kicker points = 3 x FG made + 1 x PAT made (two-point tries score the kicker nothing).

Unit: one team's kicking in one game (the kicker market follows the team's
kicker; mid-game kicker changes are rare and handled by summing the team).

Questions:
  1. What do the three markets look like? (mean, dispersion, the usual lines,
     how FGs and PATs move together — decides how to price points)
  2. Which pre-game facts predict each one, walk-forward, beyond the Vegas
     implied team total? Ron's list: weather, the kicker's history, the spread
     (dogs kick FGs, favourites kick PATs), the total. Plus red-zone finishing,
     4th-down aggressiveness, the opposing defence, altitude.
  3. Are the "kicker" traits real traits? (split-half reliability)

Metric: a quasi-Poisson fit per market, walk-forward by season 2019-2025
(train on every earlier season). Scored by log loss of P(over) at the lines the
books actually hang (FG made 1.5, PAT made 2.5, points 7.5) plus MAE. A feature
is REAL when the paired per-game log-loss difference clears |t| > 2.5.

    python3 research/kickers.py
"""
import os, sys, warnings
warnings.filterwarnings("ignore")
import numpy as np
import pandas as pd
from math import lgamma

sys.path.insert(0, os.path.dirname(__file__))
from completions import CACHE, windowed_prior      # noqa: E402

SEASONS = list(range(2016, 2026))
COLS = ["game_id", "season", "week", "season_type", "posteam", "defteam", "home_team", "play_type",
        "field_goal_attempt", "field_goal_result", "kick_distance", "extra_point_attempt", "extra_point_result",
        "two_point_attempt", "kicker_player_id", "kicker_player_name", "spread_line", "total_line",
        "wind", "temp", "roof", "surface", "weather", "fixed_drive", "fixed_drive_result", "drive_inside20",
        "down", "yardline_100", "touchdown", "td_team", "posteam_score_post", "defteam_score_post"]
LINES = {"fgm": 1.5, "patm": 2.5, "pts": 7.5}


def load():
    d = pd.concat([pd.read_parquet(f"{CACHE}/pbp_{y}.parquet", columns=COLS) for y in SEASONS], ignore_index=True)
    return d[(d.season_type == "REG") & d.posteam.notna()]


def team_games(d):
    fg = d[d.field_goal_attempt == 1]
    xp = d[d.extra_point_attempt == 1]
    k = pd.concat([
        fg.groupby(["game_id", "posteam"]).agg(fga=("field_goal_attempt", "size"), fgm=("field_goal_result", lambda s: (s == "made").sum()),
                                               fga40=("kick_distance", lambda s: (s >= 40).sum()), fga50=("kick_distance", lambda s: (s >= 50).sum()),
                                               fgm40=("kick_distance", lambda s: 0)),
        xp.groupby(["game_id", "posteam"]).agg(pata=("extra_point_attempt", "size"), patm=("extra_point_result", lambda s: (s == "good").sum())),
    ], axis=1).fillna(0)
    made40 = fg[(fg.kick_distance >= 40) & (fg.field_goal_result == "made")].groupby(["game_id", "posteam"]).size()
    k["fgm40"] = made40.reindex(k.index).fillna(0)
    # the main kicker that game, for his personal history
    kick = pd.concat([fg, xp]).groupby(["game_id", "posteam"]).kicker_player_id.agg(lambda s: s.value_counts().index[0])
    k["kid"] = kick.reindex(k.index)

    # every team-game, including ones with no kicks at all
    g = d.groupby(["game_id", "posteam"], as_index=False).agg(
        season=("season", "first"), week=("week", "first"), defteam=("defteam", "first"), home=("home_team", "first"),
        sp=("spread_line", "first"), tot=("total_line", "first"), wind=("wind", "first"), temp=("temp", "first"),
        roof=("roof", "first"), surface=("surface", "first"), weather=("weather", "first"))
    g = g.merge(k.reset_index(), on=["game_id", "posteam"], how="left")
    for c in ["fga", "fgm", "fga40", "fga50", "fgm40", "pata", "patm"]:
        g[c] = g[c].fillna(0)
    g["pts"] = 3 * g.fgm + g.patm
    h = g.posteam == g.home
    g["implied"] = np.where(h, g.tot / 2 + g.sp / 2, g.tot / 2 - g.sp / 2)
    g["fav"] = np.where(h, g.sp, -g.sp)           # + = favoured by that many
    g["is_home"] = h.astype(int)
    g["indoor"] = g.roof.isin(["dome", "closed"]).astype(int)
    g["wind"] = np.where(g.indoor == 1, 0.0, g.wind.fillna(g.wind.median()))
    g["cold"] = np.where(g.indoor == 1, 0.0, np.clip(50 - g.temp.fillna(60), 0, None))   # degrees below 50F
    wx = g.weather.fillna("").str.lower()
    g["precip"] = ((g.indoor == 0) & wx.str.contains(r"rain|snow|shower|sleet|drizzle|flurr")).astype(int)
    g["altitude"] = ((g.home == "DEN") & (g.indoor == 0)).astype(int)

    # red-zone finishing and 4th-down aggressiveness, per team-game (priors taken as-of later)
    dr = d[d.fixed_drive.notna()].groupby(["game_id", "posteam", "fixed_drive"]).agg(
        rz=("drive_inside20", "max"), res=("fixed_drive_result", "first")).reset_index()
    rz = dr[dr.rz == 1].groupby(["game_id", "posteam"]).agg(rz_trips=("rz", "size"), rz_td=("res", lambda s: (s == "Touchdown").sum()))
    drives = dr.groupby(["game_id", "posteam"]).size().rename("drives")
    g = g.merge(rz.reset_index(), on=["game_id", "posteam"], how="left").merge(drives.reset_index(), on=["game_id", "posteam"], how="left")
    g[["rz_trips", "rz_td"]] = g[["rz_trips", "rz_td"]].fillna(0)
    # 4th downs in field-goal range (opp 40 to opp 15): went for it vs kicked
    f4 = d[(d.down == 4) & d.yardline_100.between(15, 40) & d.play_type.isin(["run", "pass", "field_goal"])]
    go = f4.groupby(["game_id", "posteam"]).agg(f4n=("play_type", "size"), f4go=("play_type", lambda s: s.isin(["run", "pass"]).sum()))
    g = g.merge(go.reset_index(), on=["game_id", "posteam"], how="left")
    g[["f4n", "f4go"]] = g[["f4n", "f4go"]].fillna(0)
    # what each defence allowed, joined back onto the offence it faces
    dd = g[["game_id", "posteam", "fga", "rz_trips", "rz_td", "pts"]].rename(columns={
        "posteam": "defteam", "fga": "d_fga", "rz_trips": "d_rz_trips", "rz_td": "d_rz_td", "pts": "d_kpts"})
    g = g.merge(dd, on=["game_id", "defteam"], how="left")
    return g[g.implied.notna()].copy()


def rate(df, key, num, den, k, window, name):
    df = windowed_prior(df, key, num, k=0.0, window=window)
    df = windowed_prior(df, key, den, k=0.0, window=window)
    n = df[num + "_n"].to_numpy(float)
    s_num = df[num + "_prior"].fillna(0).to_numpy(float) * n
    s_den = df[den + "_prior"].fillna(0).to_numpy(float) * n
    lg = df[num].sum() / max(df[den].sum(), 1)
    df[name] = (s_num + k * lg) / (s_den + k)
    return df.drop(columns=[num + "_prior", den + "_prior", num + "_n", den + "_n"])


def features(g):
    g = g.rename(columns={"posteam": "team"})
    g["one"] = 1.0
    # team volume and finishing, 2-season windows, shrunk
    # (rate() works through windowed_prior columns and drops them, so the
    # plain per-game priors come after it)
    g = rate(g, "team", "rz_td", "rz_trips", 40, 2, "rz_td_rate")
    g = rate(g, "team", "f4go", "f4n", 25, 2, "go4_rate")
    g = rate(g, "team", "fga50", "fga", 30, 2, "long_share")       # how far the coach sends him
    g = windowed_prior(g, "team", "fga", k=8.0, window=2)
    g = windowed_prior(g, "team", "patm", k=8.0, window=2)
    # defence
    g = windowed_prior(g, "defteam", "d_fga", k=8.0, window=2)
    g = rate(g, "defteam", "d_rz_td", "d_rz_trips", 60, 2, "def_rz_td_rate")
    # kicker, by his own id across teams
    kk = g[g.kid.notna()].copy()
    kk = rate(kk, "kid", "fgm", "fga", 40, 3, "k_fg_pct")
    kk = rate(kk, "kid", "fgm40", "fga40", 30, 3, "k_fg40_pct")
    kk = rate(kk, "kid", "patm", "pata", 60, 3, "k_pat_pct")
    g = g.merge(kk[["game_id", "team", "k_fg_pct", "k_fg40_pct", "k_pat_pct"]], on=["game_id", "team"], how="left")
    for c in ["k_fg_pct", "k_fg40_pct", "k_pat_pct"]:
        g[c] = g[c].fillna(g[c].median())
    return g


# ── model ───────────────────────────────────────────────────────────────────
def irls(X, y, ridge=1.0, it=60):
    b = np.zeros(X.shape[1]); b[0] = np.log(max(y.mean(), 1e-3))
    for _ in range(it):
        mu = np.exp(np.clip(X @ b, -10, 5)); W = np.clip(mu, 1e-6, None)
        R = np.eye(X.shape[1]) * ridge; R[0, 0] = 0
        try: step = np.linalg.solve(X.T @ (X * W[:, None]) + R, X.T @ (y - mu) - R @ b)
        except np.linalg.LinAlgError: break
        b += step
        if np.abs(step).max() < 1e-7: break
    return b


def design(df, fs, ref):
    Z = [(df[f].to_numpy(float) - ref[f].mean()) / (ref[f].std() or 1) for f in fs]
    return np.column_stack([np.ones(len(df))] + Z)


def pois_cdf(k, mu):
    mu = np.asarray(mu, float); out = np.zeros_like(mu)
    for i in range(int(k) + 1):
        out += np.exp(i * np.log(np.maximum(mu, 1e-12)) - mu - lgamma(i + 1))
    return out


def binom_cdf(k, n, p):
    n = np.asarray(n, int); p = np.asarray(p, float); out = np.zeros(len(n))
    for i in range(int(k) + 1):
        ok = n >= i
        lc = np.array([lgamma(a + 1) - lgamma(i + 1) - lgamma(a - i + 1) if a >= i else 0 for a in n])
        out += np.where(ok, np.exp(lc + i * np.log(p) + (n - i) * np.log1p(-p)), 0)
    return out


def p_over_count(line, mu, disp):
    """P(Y > line) for a count with mean mu. disp < 1 (under-dispersed, as FGs
    are) is handled by a binomial with n chosen so the variance matches."""
    k = np.floor(line)
    if disp >= 1:
        return 1 - pois_cdf(k, mu)
    pr = np.clip(1 - disp, 0.02, 0.98)
    n = np.maximum(np.round(mu / pr), 1).astype(int)
    return 1 - binom_cdf(k, n, np.clip(mu / n, 1e-6, 1 - 1e-6))


def walk(q, fs, y, first=2019):
    parts = []
    for s in range(first, 2026):
        tr, te = q[q.season < s], q[q.season == s]
        b = irls(design(tr, fs, tr), tr[y].to_numpy(float))
        mu_tr = np.exp(design(tr, fs, tr) @ b)
        mu_te = np.exp(design(te, fs, tr) @ b)
        disp = float(np.mean((tr[y] - mu_tr) ** 2) / np.mean(mu_tr))
        parts.append(te.assign(mu=mu_te, p=p_over_count(LINES[y], mu_te, disp)))
    t = pd.concat(parts)
    return t


def walk_points(q, fs_f, fs_p, first=2019):
    """Points priced from the two count models, allowing for how FGs and PATs
    trade off: the joint is simulated from the training residual pairs."""
    parts = []
    for s in range(first, 2026):
        tr, te = q[q.season < s], q[q.season == s]
        out = {}
        for y, fs in (("fgm", fs_f), ("patm", fs_p)):
            b = irls(design(tr, fs, tr), tr[y].to_numpy(float))
            out[y] = (np.exp(design(tr, fs, tr) @ b), np.exp(design(te, fs, tr) @ b))
        mu_tr = 3 * out["fgm"][0] + out["patm"][0]
        mu_te = 3 * out["fgm"][1] + out["patm"][1]
        # scale the empirical ratio of actual/expected points within projection bins
        ratio = tr.pts.to_numpy(float) / np.maximum(mu_tr, 1e-6)
        bins = np.quantile(mu_tr, [0, .2, .4, .6, .8, 1])
        p = np.empty(len(te))
        bi_te = np.clip(np.searchsorted(bins, mu_te, side="right") - 1, 0, 4)
        bi_tr = np.clip(np.searchsorted(bins, mu_tr, side="right") - 1, 0, 4)
        for b_ in range(5):
            r = ratio[bi_tr == b_]
            m = bi_te == b_
            p[m] = np.array([(r * v > LINES["pts"]).mean() for v in mu_te[m]])
        parts.append(te.assign(mu=mu_te, p=np.clip(p, 0.01, 0.99)))
    return pd.concat(parts)


def ll_rows(t, y):
    o = (t[y] > LINES[y]).to_numpy(float); p = np.clip(t.p.to_numpy(float), 1e-4, 1 - 1e-4)
    return -(o * np.log(p) + (1 - o) * np.log(1 - p))


def compare(q, y, base, groups, runner):
    t0 = runner(base); l0 = ll_rows(t0, y)
    print(f"  {'base: ' + ', '.join(base):58s} MAE {np.abs(t0[y] - t0.mu).mean():.3f}   log loss {l0.mean():.5f}")
    keep = []
    for lab, extra in groups:
        t = runner(base + extra); l = ll_rows(t, y)
        dd = l - l0; tt = dd.mean() / (dd.std(ddof=1) / np.sqrt(len(dd)))
        flag = "  <-- REAL" if tt < -2.5 else ("  (worse)" if tt > 2.5 else "")
        print(f"  {'+ ' + lab:58s} MAE {np.abs(t[y] - t.mu).mean():.3f}   {l.mean():.5f} ({l.mean() - l0.mean():+.5f}, t={tt:+.1f}){flag}")
        if tt < -2.5: keep.append(lab)
    return keep


def split_half(g, key, num, den, min_den):
    """Odd vs even games within a season: does the trait repeat?"""
    g = g.sort_values([key, "season", "week"]).copy()
    g["half"] = g.groupby([key, "season"]).cumcount() % 2
    a = g.groupby([key, "season", "half"])[[num, den]].sum().unstack("half")
    a = a[(a[(den, 0)] >= min_den) & (a[(den, 1)] >= min_den)]
    r0 = a[(num, 0)] / a[(den, 0)]; r1 = a[(num, 1)] / a[(den, 1)]
    return float(np.corrcoef(r0, r1)[0, 1]), len(a)


def main():
    d = load()
    g = features(team_games(d))
    q = g[g.season >= 2017].copy()      # priors need a season behind them
    print(f"team-games {len(q):,} (2017-2025) · walk-forward 2019-2025: {(q.season >= 2019).sum():,}")

    print("\n1. What the markets look like")
    for y, lab in (("fga", "FG attempts"), ("fgm", "FG made"), ("patm", "PAT made"), ("pts", "kicker points")):
        v = q[y]
        print(f"  {lab:14s} mean {v.mean():.2f}  sd {v.std():.2f}  var/mean {v.var() / v.mean():.2f}  "
              f"dist {dict(v.clip(upper=4 if y != 'pts' else 15).value_counts(normalize=True).sort_index().round(3))}" if y != "pts" else
              f"  {lab:14s} mean {v.mean():.2f}  sd {v.std():.2f}  median {v.median():.0f}  P(>6.5) {(v > 6.5).mean():.3f}  P(>7.5) {(v > 7.5).mean():.3f}  P(>8.5) {(v > 8.5).mean():.3f}")
    print(f"  P(FG made > 1.5) {(q.fgm > 1.5).mean():.3f}   P(PAT made > 2.5) {(q.patm > 2.5).mean():.3f}")
    print(f"  FG made vs PAT made correlation: {np.corrcoef(q.fgm, q.patm)[0, 1]:+.3f}   "
          f"(controlling for implied total: {np.corrcoef(q.fgm - q.groupby(pd.cut(q.implied, 10)).fgm.transform('mean'), q.patm - q.groupby(pd.cut(q.implied, 10)).patm.transform('mean'))[0, 1]:+.3f})")
    print(f"  FG% {q.fgm.sum() / q.fga.sum():.3f}  PAT% {q.patm.sum() / q.pata.sum():.3f}  (league, 2017-2025)")

    print("\n  by implied team total (Ron: more scoring, more kicking)")
    tb = q.groupby(pd.cut(q.implied, [0, 17, 20, 23, 26, 29, 50])).agg(n=("pts", "size"), fga=("fga", "mean"), fgm=("fgm", "mean"), patm=("patm", "mean"), pts=("pts", "mean"))
    print(tb.round(2).to_string())
    print("\n  by spread, same implied total band 21-25 (Ron: dogs kick FGs, favourites kick PATs)")
    mid = q[q.implied.between(21, 25)]
    tb = mid.groupby(pd.cut(mid.fav, [-30, -7, -3, 0, 3, 7, 30])).agg(n=("pts", "size"), implied=("implied", "mean"), fga=("fga", "mean"), fgm=("fgm", "mean"), patm=("patm", "mean"), pts=("pts", "mean"))
    print(tb.round(2).to_string())
    print("\n  weather (outdoor games)")
    od = q[q.indoor == 0]
    print("  wind mph:", od.groupby(pd.cut(od.wind, [-1, 5, 10, 15, 20, 60])).agg(n=("pts", "size"), fga=("fga", "mean"), fg_pct=("fgm", "sum"), att=("fga", "sum"), patm=("patm", "mean"), pts=("pts", "mean"))
          .assign(fg_pct=lambda x: x.fg_pct / x.att).drop(columns="att").round(3).to_string().replace("\n", "\n    "))
    print("  indoor vs outdoor:", q.groupby("indoor").agg(n=("pts", "size"), fga=("fga", "mean"), fgm=("fgm", "mean"), pts=("pts", "mean")).round(3).to_dict("index"))
    print("  precipitation:", od.groupby("precip").agg(n=("pts", "size"), fga=("fga", "mean"), fgm=("fgm", "mean"), pts=("pts", "mean")).round(3).to_dict("index"))

    print("\n3. Are the traits real? (split-half, odd vs even games in a season)")
    kk = g[g.kid.notna()]
    for lab, key, num, den, mn in (("kicker FG%", "kid", "fgm", "fga", 12), ("kicker 40+ FG%", "kid", "fgm40", "fga40", 8),
                                    ("kicker PAT%", "kid", "patm", "pata", 15), ("team FGA per game", "team", "fga", "one", 6),
                                    ("team red-zone TD rate", "team", "rz_td", "rz_trips", 12), ("team 4th-down go rate (FG range)", "team", "f4go", "f4n", 6)):
        r, n = split_half(kk if key == "kid" else g, key, num, den, mn)
        print(f"  {lab:34s} r = {r:+.3f}  ({n} team/kicker-seasons)")

    print("\n2. Walk-forward, 2019-2025")
    q = q.dropna(subset=["fga_prior", "rz_td_rate", "def_rz_td_rate", "go4_rate"])
    base = ["implied"]
    groups = [("spread (favourite by)", ["fav"]), ("game total", ["tot"]), ("home", ["is_home"]),
              ("indoor", ["indoor"]), ("wind", ["wind"]), ("cold", ["cold"]), ("precipitation", ["precip"]), ("altitude (Denver)", ["altitude"]),
              ("team FGA per game, prior", ["fga_prior"]), ("team red-zone TD rate, prior", ["rz_td_rate"]),
              ("defence red-zone TD rate allowed", ["def_rz_td_rate"]), ("defence FGA allowed per game", ["d_fga_prior"]),
              ("team 4th-down go rate", ["go4_rate"]), ("long-attempt share (50+)", ["long_share"]),
              ("kicker FG%", ["k_fg_pct"]), ("kicker 40+ FG%", ["k_fg40_pct"]), ("kicker PAT%", ["k_pat_pct"])]
    for y, lab in (("fgm", "FG made (line 1.5)"), ("patm", "PAT made (line 2.5)")):
        print(f"\n {lab}")
        compare(q, y, base, groups, lambda fs, y=y: walk(q, fs, y))

    print("\n4. Combined, and what the base itself is worth")
    q["zero"] = 0.0
    for y, lab in (("fgm", "FG made"), ("patm", "PAT made")):
        t_none = walk(q, ["zero"], y); l_none = ll_rows(t_none, y)
        print(f"\n {lab}: league average only, log loss {l_none.mean():.5f}")
        combos = [("implied", ["implied"]), ("implied + fav", ["implied", "fav"]),
                  ("implied + fav + cold + wind", ["implied", "fav", "cold", "wind"]),
                  ("... + long share + kicker 40+ FG%", ["implied", "fav", "cold", "wind", "long_share", "k_fg40_pct"])]
        for name, fs in combos:
            t = walk(q, fs, y); l = ll_rows(t, y); dd = l - l_none
            tt = dd.mean() / (dd.std(ddof=1) / np.sqrt(len(dd)))
            print(f"  {name:44s} {l.mean():.5f} ({l.mean() - l_none.mean():+.5f} vs average, t={tt:+.1f})  MAE {np.abs(t[y] - t.mu).mean():.3f}")

    print("\n Kicker points (line 7.5), priced from both counts")
    l_none = None
    for name, ff, fp in (("league average", ["zero"], ["zero"]), ("implied", ["implied"], ["implied"]),
                         ("implied + fav + cold + wind (FGs)", ["implied", "fav", "cold", "wind"], ["implied"]),
                         ("... + long share + kicker 40+ FG%", ["implied", "fav", "cold", "wind", "long_share", "k_fg40_pct"], ["implied"])):
        t = walk_points(q, ff, fp); l = ll_rows(t, "pts")
        if l_none is None: l_none = l; print(f"  {name:44s} {l.mean():.5f}"); continue
        dd = l - l_none; tt = dd.mean() / (dd.std(ddof=1) / np.sqrt(len(dd)))
        print(f"  {name:44s} {l.mean():.5f} ({l.mean() - l_none.mean():+.5f} vs average, t={tt:+.1f})  MAE {np.abs(t.pts - t.mu).mean():.3f}")
        last = t
    print("\n  calibration of the last points model, by projection quintile:")
    last["b"] = pd.qcut(last.mu, 5, labels=False)
    print(last.groupby("b").agg(n=("pts", "size"), proj=("mu", "mean"), actual=("pts", "mean"), said_over=("p", "mean"),
                                hit_over=("pts", lambda v: (v > 7.5).mean())).round(3).to_string())

    print("\n5. On top of implied + fav + cold + wind (FG made)")
    base = ["implied", "fav", "cold", "wind"]
    compare(q, "fgm", base, [("long-attempt share (50+)", ["long_share"]), ("kicker 40+ FG%", ["k_fg40_pct"]), ("kicker FG%", ["k_fg_pct"]),
                             ("team FGA per game, prior", ["fga_prior"]), ("precipitation", ["precip"]), ("indoor", ["indoor"]),
                             ("team 4th-down go rate", ["go4_rate"]), ("team red-zone TD rate", ["rz_td_rate"])], lambda fs: walk(q, fs, "fgm"))
    r, n = split_half(g, "team", "fga50", "fga", 6)
    print(f"  split-half: team 50+ attempt share r = {r:+.3f} ({n})")

    print("\n  which way each pushes (full-sample fit, per 1 sd):")
    for y, fs in (("fgm", ["implied", "fav", "cold", "wind", "long_share"]), ("patm", ["implied", "fav"])):
        b = irls(design(q, fs, q), q[y].to_numpy(float))
        print(f"   {y}: " + ", ".join(f"{f} {np.exp(c) - 1:+.1%}" for f, c in zip(fs, b[1:])) + f"  (sd: " + ", ".join(f"{f} {q[f].std():.2f}" for f in fs) + ")")

    print("\n  how wide the prices spread (2019-2025 walk-forward):")
    for y, fs in (("fgm", ["implied", "fav", "cold", "wind", "long_share"]), ("patm", ["implied"])):
        t = walk(q, fs, y)
        pc = np.percentile(t.p, [5, 25, 50, 75, 95])
        odds = lambda p: f"{'-' if p >= .5 else '+'}{round(100 * p / (1 - p)) if p >= .5 else round(100 * (1 - p) / p)}"
        print(f"   {y} over {LINES[y]}: P 5/25/50/75/95% = " + " / ".join(f"{v:.2f}" for v in pc) + "  → " + " / ".join(odds(v) for v in pc))
        t["b"] = pd.qcut(t.p, 5, labels=False)
        print("   calibration:", t.groupby("b").agg(said=("p", "mean"), hit=(y, lambda v: (v > LINES[y]).mean())).round(3).to_dict("list"))
    return q


if __name__ == "__main__":
    main()
