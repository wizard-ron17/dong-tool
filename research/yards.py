"""Yards: passing, rushing, receiving. Planning and testing — nothing shipped.

Questions, in order:
  1. What does each market's distribution look like? (decides how to price)
  2. Pre-game: which of the candidate features from Ron's list actually predict
     yards, walk-forward, beyond a player's own average + the Vegas game total?
  3. In-game: how much does knowing the score of the game at Q1 / halftime
     improve a QB's final passing yards? (is a live tool worth building)

Pre-game metric: a naive book hangs a line near the player's recent average.
For each start we put the line at his 2-season yards prior rounded to x.5 and
score P(over) — log loss below 0.693 means the model knows which side of that
line the game lands on better than a coin. MAE is reported alongside.

    python3 research/yards.py            # pre-game, all three markets
    python3 research/yards.py --live     # in-game passing
"""
import os, sys, warnings
warnings.filterwarnings("ignore")
import numpy as np
import pandas as pd

sys.path.insert(0, os.path.dirname(__file__))
from completions import CACHE, windowed_prior      # noqa: E402
from interceptions import rate_prior               # noqa: E402


def irls(X, y, ridge=1.0, it=60):
    """Quasi-Poisson log-link fit. Interceptions' version clips the linear
    predictor at 3 (fine for ~0.7 INTs, fatal for 24 = 240 yards / 10)."""
    b = np.zeros(X.shape[1]); b[0] = np.log(max(y.mean(), 1e-3))
    for _ in range(it):
        mu = np.exp(np.clip(X @ b, -10, 8)); W = np.clip(mu, 1e-6, None)
        R = np.eye(X.shape[1]) * ridge; R[0, 0] = 0
        try: step = np.linalg.solve(X.T @ (X * W[:, None]) + R, X.T @ (y - mu) - R @ b)
        except np.linalg.LinAlgError: break
        b += step
        if np.abs(step).max() < 1e-7: break
    return b

HERE = os.path.dirname(__file__)
SEASONS = list(range(2016, 2026))
PBP = ["game_id", "season", "week", "season_type", "posteam", "defteam", "home_team",
       "play_type", "pass_attempt", "rush_attempt", "sack", "qb_dropback", "qb_scramble",
       "passing_yards", "rushing_yards", "receiving_yards", "yards_gained", "air_yards", "complete_pass",
       "passer_player_id", "rusher_player_id", "receiver_player_id", "epa", "cpoe", "two_point_attempt",
       "spread_line", "total_line", "wind", "roof", "qtr", "game_half", "score_differential",
       "game_seconds_remaining"]


def load_pbp(port=False):
    """port=True keeps exactly the rows the Node build reads (scripts/picks.js
    loadPbpLogs): playoffs and two-point tries included. The snap-count pool
    includes playoff games, so dropping their play-by-play would book every
    playoff appearance as zero yards."""
    d = pd.concat([pd.read_parquet(f"{CACHE}/pbp_{y}.parquet", columns=PBP) for y in SEASONS], ignore_index=True)
    if port:
        return d[d.posteam.notna()]
    d = d[(d.season_type == "REG") & d.posteam.notna() & (d.two_point_attempt != 1)]
    return d


def game_ctx(d):
    g = d.groupby(["game_id", "posteam"], as_index=False).agg(
        defteam=("defteam", "first"), home=("home_team", "first"), sp=("spread_line", "first"),
        tot=("total_line", "first"), wind=("wind", "first"), roof=("roof", "first"))
    h = g.posteam == g.home
    g["implied"] = np.where(h, g.tot / 2 + g.sp / 2, g.tot / 2 - g.sp / 2)
    g["fav"] = np.where(h, g.sp, -g.sp)
    g["is_home"] = h.astype(int)
    g["indoor"] = g.roof.isin(["dome", "closed"]).astype(int)
    g["wind"] = np.where(g.indoor == 1, 0.0, g.wind.fillna(0.0))
    return g.rename(columns={"posteam": "team"})


def defense_table(d):
    """Per defense-game: what it allowed. Priors are taken later, as-of."""
    db = d[d.qb_dropback == 1]
    pa = d[d.pass_attempt == 1]
    ru = d[(d.rush_attempt == 1) & (d.qb_scramble != 1)]
    t = db.groupby(["game_id", "season", "week", "defteam"], as_index=False).agg(
        d_db=("qb_dropback", "sum"), d_epa=("epa", "sum"), d_sack=("sack", "sum"))
    a = pa.groupby(["game_id", "defteam"], as_index=False).agg(
        d_att=("pass_attempt", "sum"), d_pyds=("passing_yards", "sum"),
        d_expl=("passing_yards", lambda s: (s >= 20).sum()))
    r = ru.groupby(["game_id", "defteam"], as_index=False).agg(d_car=("rush_attempt", "sum"), d_ryds=("rushing_yards", "sum"))
    return t.merge(a, on=["game_id", "defteam"], how="left").merge(r, on=["game_id", "defteam"], how="left").fillna(0)


def def_priors(dt, window=2):
    for num, den, k, name in (("d_pyds", "d_att", 300, "def_ypa"), ("d_epa", "d_db", 300, "def_epa_db"),
                              ("d_sack", "d_db", 300, "def_sack"), ("d_expl", "d_att", 400, "def_expl"),
                              ("d_ryds", "d_car", 250, "def_ypc")):
        dt = rate_prior(dt, "defteam", num, den, k, window, name)
    dt = windowed_prior(dt, "defteam", "d_pyds", k=3.0, window=window)
    dt = windowed_prior(dt, "defteam", "d_ryds", k=3.0, window=window)
    return dt.rename(columns={"d_pyds_prior": "def_pyds_g", "d_ryds_prior": "def_ryds_g"})[
        ["game_id", "defteam", "def_ypa", "def_epa_db", "def_sack", "def_expl", "def_ypc", "def_pyds_g", "def_ryds_g"]]


# ── evaluation ─────────────────────────────────────────────────────────────
def fit_predict(tr, te, fs, y):
    ref = {f: (tr[f].mean(), tr[f].std() + 1e-9) for f in fs}
    X = lambda df: np.column_stack([np.ones(len(df))] + [(df[f] - ref[f][0]) / ref[f][1] for f in fs])
    yt = tr[y].clip(lower=0).to_numpy(float)
    b = irls(X(tr) / 1.0, yt / 10.0)          # quasi-Poisson on yards/10: same mean model, stable weights
    mu_tr = np.exp(np.clip(X(tr) @ b, -10, 8)) * 10
    mu_te = np.exp(np.clip(X(te) @ b, -10, 8)) * 10
    return mu_tr, mu_te


def p_over(line, mu, ratio_tr, mu_tr):
    """P(Y > line) from the training ratio distribution y/mu, pooled within
    projection quintiles so the spread can widen or narrow with the mean."""
    edges = np.quantile(mu_tr, [0.2, 0.4, 0.6, 0.8])
    bt, be = np.searchsorted(edges, mu_tr), np.searchsorted(edges, mu)
    out = np.empty(len(mu))
    for b in range(5):
        r = np.sort(ratio_tr[bt == b]); m = be == b
        if not m.any(): continue
        thr = line[m] / np.maximum(mu[m], 1e-6)
        out[m] = 1 - np.searchsorted(r, thr, side="right") / len(r)
    return np.clip(out, 0.01, 0.99)


def walk(q, fs, y, line_col, first=2019):
    parts = []
    for s in range(first, 2026):
        tr, te = q[q.season < s], q[q.season == s]
        mu_tr, mu_te = fit_predict(tr, te, fs, y)
        ratio = (tr[y].to_numpy(float) / np.maximum(mu_tr, 1e-6))
        L = te[line_col].to_numpy(float)
        p = p_over(L, mu_te, ratio, mu_tr)
        parts.append(te.assign(mu=mu_te, p=p))
    t = pd.concat(parts)
    o = (t[y] > t[line_col]).to_numpy(float)
    ll = float(-np.mean(o * np.log(t.p) + (1 - o) * np.log(1 - t.p)))
    return float(np.abs(t[y] - t.mu).mean()), ll, t


def paired_ll(ta, tb, y, line_col):
    m = ta[["game_id", "pid", y, line_col, "p"]].merge(tb[["game_id", "pid", "p"]], on=["game_id", "pid"], suffixes=("_a", "_b"))
    o = (m[y] > m[line_col]).to_numpy(float)
    f = lambda p: -(o * np.log(p) + (1 - o) * np.log(1 - p))
    dd = f(m.p_b.to_numpy()) - f(m.p_a.to_numpy())
    return dd.mean() / (dd.std(ddof=1) / np.sqrt(len(dd)))


def report(name, q, y, base, groups):
    q = q.dropna(subset=list(dict.fromkeys(base + sum([g for _, g in groups], []))))
    q = q.copy(); q["line"] = np.floor(q[y + "_prior"]) + 0.5
    print(f"\n{name}: {(q.season >= 2019).sum():,} player-games 2019-2025 walk-forward · mean {q[y].mean():.1f} · sd {q[y].std():.1f} "
          f"· median {q[y].median():.0f} · P(y > own-average line) {(q[y] > q.line).mean():.3f}")
    mae0, ll0, t0 = walk(q, base, y, "line")
    print(f"  {'base':44s} MAE {mae0:6.2f}   line log loss {ll0:.5f}")
    for lab, extra in groups:
        mae, ll, t = walk(q, base + extra, y, "line")
        tt = paired_ll(t0, t, y, "line")
        flag = "  <-- REAL" if tt < -2.5 else ""
        print(f"  {'+ ' + lab:44s} MAE {mae:6.2f} ({mae - mae0:+.2f})   {ll:.5f} ({ll - ll0:+.5f}, t={tt:+.1f}){flag}")
    return q


# ── passing ────────────────────────────────────────────────────────────────
def passing(d, ctx, dfp):
    p = d[d.pass_attempt == 1]
    db = d[d.qb_dropback == 1]
    qb = p.groupby(["game_id", "season", "week", "posteam", "passer_player_id"], as_index=False).agg(
        att=("pass_attempt", "sum"), pyds=("passing_yards", "sum"), sacks=("sack", "sum"),
        air=("air_yards", "sum"), air_n=("air_yards", "count"), cpoe=("cpoe", "sum"), cpoe_n=("cpoe", "count"))
    e = db.groupby(["game_id", "posteam", "passer_player_id"], as_index=False).agg(dbk=("qb_dropback", "sum"), epa=("epa", "sum"))
    qb = qb.merge(e, on=["game_id", "posteam", "passer_player_id"], how="left")
    qb = qb.sort_values("att", ascending=False).groupby(["game_id", "posteam"], as_index=False).first()
    qb = qb[qb.att >= 10].rename(columns={"posteam": "team", "passer_player_id": "pid"}).copy()
    qb["pyds"] = qb.pyds.fillna(0)
    qb = qb.rename(columns={"cpoe_n": "cpoe_cnt", "air_n": "air_cnt"})
    # rate priors first: rate_prior drops its scratch <col>_prior columns
    for num, den, k, name in (("pyds", "att", 150, "ypa"), ("epa", "dbk", 150, "epa_db"), ("cpoe", "cpoe_cnt", 150, "cpoe_p"),
                              ("air", "air_cnt", 150, "adot"), ("sacks", "dbk", 200, "sack_rate")):
        qb = rate_prior(qb, "pid", num, den, k, 2, name)
    qb = windowed_prior(qb, "pid", "pyds", k=3.0)
    qb = windowed_prior(qb, "pid", "att", k=3.0)
    qb = qb.sort_values(["pid", "season", "week"])
    qb["pyds_l3"] = qb.groupby("pid").pyds.transform(lambda s: s.shift(1).rolling(3, min_periods=1).mean()).fillna(qb.pyds_prior)
    qb = qb.merge(ctx, on=["game_id", "team"], how="left").merge(dfp, on=["game_id", "defteam"], how="left")
    qb = qb[qb.pyds_n >= 3]
    base = ["pyds_prior", "att_prior", "implied", "fav"]
    groups = [("yards per attempt", ["ypa"]), ("EPA per dropback", ["epa_db"]), ("CPOE", ["cpoe_p"]),
              ("air yards (depth)", ["adot"]), ("sack rate", ["sack_rate"]), ("last-3 yards", ["pyds_l3"]),
              ("home field", ["is_home"]), ("wind / indoor", ["wind", "indoor"]),
              ("opp yards per attempt allowed", ["def_ypa"]), ("opp EPA per dropback allowed", ["def_epa_db"]),
              ("opp sack rate (pressure)", ["def_sack"]), ("opp explosive passes allowed", ["def_expl"]),
              ("opp pass yards allowed / game", ["def_pyds_g"]),
              ("ALL of the above", ["ypa", "epa_db", "cpoe_p", "adot", "sack_rate", "pyds_l3", "is_home", "wind", "indoor",
                                    "def_ypa", "def_epa_db", "def_sack", "def_expl", "def_pyds_g"])]
    return report("PASSING YARDS (starting QB)", qb, "pyds", base, groups)


# ── receiving / rushing: the receptions pool (1+ offensive snap, RB/WR/TE/FB) ─
def skill(d, ctx, dfp):
    pool = pd.read_parquet(os.path.join(HERE, "receptions.parquet"))
    rec = d[d.receiver_player_id.notna() & (d.pass_attempt == 1)].groupby(["game_id", "receiver_player_id"], as_index=False).agg(
        ryds=("receiving_yards", "sum")).rename(columns={"receiver_player_id": "pid"})
    ru = d[d.rusher_player_id.notna() & (d.rush_attempt == 1)].groupby(["game_id", "rusher_player_id"], as_index=False).agg(
        rush=("rushing_yards", "sum"), car=("rush_attempt", "sum")).rename(columns={"rusher_player_id": "pid"})
    tc = d[(d.rush_attempt == 1)].groupby(["game_id", "posteam"], as_index=False).agg(team_car=("rush_attempt", "sum")).rename(columns={"posteam": "team"})
    q = pool.merge(rec, on=["game_id", "pid"], how="left").merge(ru, on=["game_id", "pid"], how="left").merge(tc, on=["game_id", "team"], how="left")
    q[["ryds", "rush", "car"]] = q[["ryds", "rush", "car"]].fillna(0)
    q["team_car"] = q.team_car.fillna(q.team_car.median())
    # rate_prior rebuilds and then drops a scratch tgt_prior; keep the dataset's
    # own under another name (the helpers re-sort rows, so never by position)
    q = q.rename(columns={"tgt_prior": "tgt_prior_src"})
    q = rate_prior(q, "pid", "ryds", "tgt", 40, 2, "ypt")
    q = rate_prior(q, "pid", "rush", "car", 60, 2, "ypc")
    q = q.rename(columns={"tgt_prior_src": "tgt_prior"})
    for c in ("ryds", "rush", "car", "team_car"):
        q = windowed_prior(q, "pid", c, k=3.0)
    q["car_share_prior"] = q.car_prior / q.team_car_prior.clip(lower=1)
    q = q.sort_values(["pid", "season", "week"])
    q["ryds_l3"] = q.groupby("pid").ryds.transform(lambda s: s.shift(1).rolling(3, min_periods=1).mean()).fillna(q.ryds_prior)
    q["rush_l3"] = q.groupby("pid").rush.transform(lambda s: s.shift(1).rolling(3, min_periods=1).mean()).fillna(q.rush_prior)
    q["car_l3"] = q.groupby("pid").car.transform(lambda s: s.shift(1).rolling(3, min_periods=1).mean()).fillna(q.car_prior)
    q = q.merge(ctx[["game_id", "team", "implied", "fav", "is_home", "indoor"]].rename(columns={"implied": "imp2"}),
                on=["game_id", "team"], how="left").merge(dfp, on=["game_id", "defteam"], how="left")
    q = q[q.games_prior >= 3]

    rq = q[q.tgt_prior >= 3]            # a pass-catcher books hang a yards line on
    base = ["ryds_prior", "tgt_prior", "implied_total", "spread_own"]
    report("RECEIVING YARDS (3+ targets/game)", rq, "ryds", base, [
        ("yards per target", ["ypt"]), ("target share", ["tgt_share_prior"]), ("depth of target", ["air_prior"]),
        ("snap share last 3", ["snap_l3"]), ("target share last 3", ["share_l3"]), ("last-3 yards", ["ryds_l3"]),
        ("team pass volume", ["team_pass_prior"]), ("wind", ["wind"]),
        ("opp yards per attempt allowed", ["def_ypa"]), ("opp explosive passes allowed", ["def_expl"]),
        ("opp pass yards allowed / game", ["def_pyds_g"]),
        ("ALL of the above", ["ypt", "tgt_share_prior", "air_prior", "snap_l3", "share_l3", "ryds_l3", "team_pass_prior",
                              "wind", "def_ypa", "def_expl", "def_pyds_g"])])

    uq = q[(q.car_prior >= 6) & (q.position == "RB")]   # a runner books hang a yards line on
    base = ["rush_prior", "car_prior", "implied_total", "spread_own"]
    report("RUSHING YARDS (RB, 6+ carries/game)", uq, "rush", base, [
        ("yards per carry", ["ypc"]), ("carry share", ["car_share_prior"]), ("snap share last 3", ["snap_l3"]),
        ("carries last 3", ["car_l3"]), ("last-3 yards", ["rush_l3"]), ("home field", ["is_home"]),
        ("opp yards per carry allowed", ["def_ypc"]), ("opp rush yards allowed / game", ["def_ryds_g"]),
        ("ALL of the above", ["ypc", "car_share_prior", "snap_l3", "car_l3", "rush_l3", "is_home", "def_ypc", "def_ryds_g"])])


# ── in-game passing ────────────────────────────────────────────────────────
def live(d, ctx, dfp):
    """Final passing yards from the pre-game projection plus what is known at
    the end of Q1 and at halftime. Same starters, same walk-forward."""
    q = passing(d, ctx, dfp)
    p = d[d.pass_attempt == 1]
    st = q[["game_id", "team", "pid"]]
    pp = p.merge(st, left_on=["game_id", "posteam", "passer_player_id"], right_on=["game_id", "team", "pid"])
    q1 = pp[pp.qtr == 1].groupby(["game_id", "pid"], as_index=False).agg(y_q1=("passing_yards", "sum"), a_q1=("pass_attempt", "sum"))
    h1 = pp[pp.game_half == "Half1"].groupby(["game_id", "pid"], as_index=False).agg(y_h1=("passing_yards", "sum"), a_h1=("pass_attempt", "sum"))
    sd = d[d.game_half == "Half1"].sort_values("game_seconds_remaining").groupby(["game_id", "posteam"], as_index=False).first()[
        ["game_id", "posteam", "score_differential"]].rename(columns={"posteam": "team", "score_differential": "diff_h1"})
    q = q.merge(q1, on=["game_id", "pid"], how="left").merge(h1, on=["game_id", "pid"], how="left").merge(sd, on=["game_id", "team"], how="left")
    q[["y_q1", "a_q1", "y_h1", "a_h1"]] = q[["y_q1", "a_q1", "y_h1", "a_h1"]].fillna(0)
    q["diff_h1"] = q.diff_h1.fillna(0)
    base = ["pyds_prior", "att_prior", "implied", "fav"]
    _, _, t = walk(q, base, "pyds", "line")
    q = q.merge(t[["game_id", "pid", "mu"]], on=["game_id", "pid"])
    print(f"\nIN-GAME PASSING YARDS ({len(q):,} starts)")
    print(f"  pre-game projection           MAE {np.abs(q.pyds - q.mu).mean():.1f}")
    for lab, cols in (("+ end of Q1 (yards, attempts)", ["mu", "y_q1", "a_q1"]),
                      ("+ halftime (yards, attempts)", ["mu", "y_h1", "a_h1"]),
                      ("+ halftime + score margin", ["mu", "y_h1", "a_h1", "diff_h1"])):
        errs = []
        # the pre-game mu is already out-of-sample, so leave-one-season-out is
        # fair here; season < s left the 2019 fold with nothing to train on
        for s in range(2019, 2026):
            tr, te = q[q.season != s], q[q.season == s]
            X = lambda df: np.column_stack([np.ones(len(df))] + [df[c] for c in cols])
            b, *_ = np.linalg.lstsq(X(tr), tr.pyds, rcond=None)
            errs.append(np.abs(te.pyds - X(te) @ b))
        e = np.concatenate(errs)
        print(f"  {lab:30s} MAE {e.mean():.1f}")
    # what halftime says about the REST of the game — the part a live line prices
    q["rest"] = q.pyds - q.y_h1
    print(f"  second-half yards: mean {q.rest.mean():.0f}, sd {q.rest.std():.0f}; corr with first-half yards "
          f"{np.corrcoef(q.rest, q.y_h1)[0, 1]:+.2f}, with halftime margin {np.corrcoef(q.rest, q.diff_h1)[0, 1]:+.2f}")


if __name__ == "__main__" and "--export" not in sys.argv:
    d = load_pbp()
    ctx = game_ctx(d)
    dfp = def_priors(defense_table(d))
    if "--live" in sys.argv:
        live(d, ctx, dfp)
    else:
        passing(d, ctx, dfp)
        skill(d, ctx, dfp)


# ════════════════════════════════════════════════════════════════════════════
# EXPORT — the shipped models, with every feature built the way the Node port
# (scripts/yards.js) can reproduce it:
#   * priors: sum over the player's pool games inside a 2-season as-of window,
#     shrunk k=3 toward the POSITION mean (the build_receptions.form rule)
#   * last-3: mean of his last three pool games, zeros included
#   * rates (yards per target / carry): windowed sums, shrunk toward league
# Pricing is not parametric: P(yards > line) comes from the out-of-sample
# distribution of actual/projection, stored as quantiles within projection
# quintiles, so the skew (receiving mean 42, median 34) prices itself.
# ════════════════════════════════════════════════════════════════════════════
import json

K = 3.0
QN = 41                     # stored quantiles of the ratio distribution


def form(df, col, out, group="position", k=K, window=2):
    df = df.sort_values(["pid", "season", "week"]).reset_index(drop=True)
    g = df.groupby("pid", sort=False)[col]
    s = (g.cumsum() - df[col]).to_numpy(float)
    n = g.cumcount().to_numpy(float)
    per = df.groupby(["pid", "season"])[col].agg(s="sum", n="size").reset_index().sort_values(["pid", "season"])
    pg = per.groupby("pid"); per["cs"] = pg["s"].cumsum(); per["cn"] = pg["n"].cumsum()
    left = pd.DataFrame({"pid": df.pid.values, "key": df.season.values - window, "_i": np.arange(len(df))}).sort_values("key")
    a = pd.merge_asof(left, per[["pid", "season", "cs", "cn"]].sort_values("season"), left_on="key", right_on="season",
                      by="pid", direction="backward").sort_values("_i")
    s = np.maximum(s - a.cs.fillna(0).to_numpy(), 0)
    n = np.maximum(n - a.cn.fillna(0).to_numpy(), 0)
    m = df.groupby(group)[col].transform("mean").to_numpy(float) if group else np.full(len(df), df[col].mean())
    df[out] = (s + k * m) / (n + k)
    df[out + "_sum"] = s; df["n_win"] = n
    return df


def last3(df, col, out):
    df = df.sort_values(["pid", "season", "week"]).reset_index(drop=True)
    df[out] = df.groupby("pid")[col].transform(lambda x: x.shift(1).rolling(3, min_periods=1).mean())
    df[out] = df[out].fillna(0.0)
    return df


def skill_frame(d):
    pool = pd.read_parquet(os.path.join(HERE, "receptions.parquet"))[
        ["season", "week", "game_id", "pid", "player", "position", "team", "tgt", "snap_pct", "tgt_share",
         "implied_total", "spread_own", "games_prior"]]
    rec = d[d.receiver_player_id.notna() & (d.pass_attempt == 1)].groupby(["game_id", "receiver_player_id"], as_index=False).agg(
        ryds=("receiving_yards", "sum")).rename(columns={"receiver_player_id": "pid"})
    ru = d[d.rusher_player_id.notna() & (d.rush_attempt == 1)].groupby(["game_id", "rusher_player_id"], as_index=False).agg(
        rush=("rushing_yards", "sum"), car=("rush_attempt", "sum")).rename(columns={"rusher_player_id": "pid"})
    q = pool.merge(rec, on=["game_id", "pid"], how="left").merge(ru, on=["game_id", "pid"], how="left")
    q[["ryds", "rush", "car"]] = q[["ryds", "rush", "car"]].fillna(0)
    # target share over ALL of the team's targets, as the port computes it —
    # receptions.parquet divides by the snap pool's targets only
    tt = d[d.receiver_player_id.notna() & (d.pass_attempt == 1)].groupby(["game_id", "posteam"], as_index=False).agg(
        team_tgt_all=("pass_attempt", "sum")).rename(columns={"posteam": "team"})
    q = q.merge(tt, on=["game_id", "team"], how="left")
    q["tgt_share"] = q.tgt / q.team_tgt_all.clip(lower=1)
    q["rr"] = q.ryds + q.rush
    for c in ("ryds", "tgt", "rush", "car", "rr"):
        q = form(q, c, c + "_prior")
    for c in ("ryds", "car", "rush", "snap_pct", "tgt_share", "rr"):
        q = last3(q, c, c + "_l3")
    q = q.rename(columns={"snap_pct_l3": "snap_l3", "tgt_share_l3": "share_l3"})
    lg_ypt = q.ryds.sum() / q.tgt.sum(); lg_ypc = q.rush.sum() / max(q.car.sum(), 1)
    q["ypt"] = (q.ryds_prior_sum + 40 * lg_ypt) / (q.tgt_prior_sum + 40)
    q["ypc"] = (q.rush_prior_sum + 60 * lg_ypc) / (q.car_prior_sum + 60)
    return q, {"ypt": float(lg_ypt), "ypc": float(lg_ypc)}


def qb_frame(d, ctx):
    p = d[d.pass_attempt == 1]
    qb = p.groupby(["game_id", "season", "week", "posteam", "passer_player_id"], as_index=False).agg(
        att=("pass_attempt", "sum"), pyds=("passing_yards", "sum"))
    qb = qb.sort_values("att", ascending=False).groupby(["game_id", "posteam"], as_index=False).first()
    qb = qb[qb.att >= 10].rename(columns={"posteam": "team", "passer_player_id": "pid"}).copy()
    ru = d[d.rusher_player_id.notna() & (d.rush_attempt == 1)].groupby(["game_id", "rusher_player_id"], as_index=False).agg(
        rush=("rushing_yards", "sum"), car=("rush_attempt", "sum")).rename(columns={"rusher_player_id": "pid"})
    qb = qb.merge(ru, on=["game_id", "pid"], how="left")
    qb[["pyds", "rush", "car"]] = qb[["pyds", "rush", "car"]].fillna(0)
    qb["position"] = "QB"
    for c in ("pyds", "att", "rush", "car"):
        qb = form(qb, c, c + "_prior")
    for c in ("pyds", "rush", "car"):
        qb = last3(qb, c, c + "_l3")
    qb = qb.merge(ctx[["game_id", "team", "implied", "fav"]], on=["game_id", "team"], how="left")
    qb = qb.rename(columns={"implied": "implied_total", "fav": "spread_own"})
    qb["games_prior"] = qb.groupby("pid").cumcount()
    return qb


MARKETS = {
    # key: (label, target, population filter on prior features, features)
    "pass":   ("Passing yards (starting QB)", "pyds", lambda q: q.position == "QB",
               ["pyds_prior", "att_prior", "implied_total", "spread_own"]),
    "qbrush": ("Rushing yards (starting QB)", "rush", lambda q: q.position == "QB",
               ["rush_prior", "car_prior", "rush_l3", "car_l3", "implied_total", "spread_own"]),
    "rush":   ("Rushing yards (RB, 4+ carries)", "rush", lambda q: (q.position == "RB") & (q.car_prior >= 4),
               ["rush_prior", "car_prior", "implied_total", "spread_own", "snap_l3", "car_l3", "rush_l3", "ypc"]),
    "rec":    ("Receiving yards (2+ targets)", "ryds", lambda q: q.position.isin(["WR", "TE", "RB"]) & (q.tgt_prior >= 2),
               ["ryds_prior", "tgt_prior", "implied_total", "spread_own", "snap_l3", "share_l3", "ryds_l3", "ypt"]),
    "rr":     ("Rush + receiving yards", "rr", lambda q: q.position.isin(["WR", "TE", "RB"]) & (q.tgt_prior + q.car_prior >= 5),
               ["rr_prior", "ryds_prior", "rush_prior", "tgt_prior", "car_prior", "implied_total", "spread_own",
                "snap_l3", "share_l3", "car_l3", "rr_l3"]),
}


def ratio_table(t, y):
    """Quantiles of actual/projection within projection quintiles (out-of-sample)."""
    edges = np.quantile(t.mu, [0.2, 0.4, 0.6, 0.8])
    b = np.searchsorted(edges, t.mu)
    qs = np.linspace(0, 1, QN)
    buckets = []
    for i in range(5):
        r = (t[y] / t.mu.clip(lower=1e-6))[b == i]
        buckets.append([round(float(v), 4) for v in np.quantile(r, qs)])
    return [round(float(e), 2) for e in edges], buckets


def p_over_tab(line, mu, edges, buckets):
    b = np.searchsorted(edges, mu)
    out = np.empty(len(mu))
    qs = np.linspace(0, 1, QN)
    for i in range(5):
        m = b == i
        if m.any():
            out[m] = 1 - np.interp(line[m] / np.maximum(mu[m], 1e-6), buckets[i], qs, left=0, right=1)
    return np.clip(out, 0.005, 0.995)


def export():
    d = load_pbp(port=True); ctx = game_ctx(d)
    skill, lg = skill_frame(d)
    qb = qb_frame(d, ctx)
    out = {"note": ("NFL yards. One quasi-Poisson log-link mean per market on 2-season windowed priors "
                    "shrunk toward the position mean; priced from the out-of-sample distribution of "
                    "actual/projection within projection quintiles."),
           "shrink_k": K, "window": 2, "league": lg, "markets": {}}
    for key, (lab, y, pop, fs) in MARKETS.items():
        base = qb if key in ("pass", "qbrush") else skill
        q = base[pop(base) & (base.games_prior >= 3)].dropna(subset=fs + [y]).copy()
        q["line"] = np.floor(q[y + "_prior"]) + 0.5
        mae, ll, t = walk(q, fs, y, "line")
        # naive: his own prior as the projection
        mae_naive = float(np.abs(t[y] - t[y + "_prior"]).mean())
        edges, buckets = ratio_table(t, y)
        # calibration of the exported pricing, out-of-sample, at book-like lines
        # around each projection
        chk = []
        for off in (-0.25, 0.0, 0.25):
            L = np.floor(t.mu * np.exp(np.quantile(np.log(np.clip(t[y] / t.mu, 0.05, None)), 0.5)) * (1 + off)) + 0.5
            p = p_over_tab(L.to_numpy(), t.mu.to_numpy(), edges, buckets)
            chk.append((off, float(p.mean()), float((t[y] > L).mean())))
        dec = pd.qcut(t.mu, 5, labels=False)
        bias = t.groupby(dec).agg(mu=("mu", "mean"), act=(y, "mean"))
        ref = {f: (float(q[f].mean()), float(q[f].std() + 1e-9)) for f in fs}
        X = np.column_stack([np.ones(len(q))] + [(q[f] - ref[f][0]) / ref[f][1] for f in fs])
        b = irls(X, q[y].clip(lower=0).to_numpy(float) / 10.0)
        pos_means = {f: {p: float(v) for p, v in base.groupby("position")[f.replace("_prior", "")].mean().items()}
                     for f in fs if f.endswith("_prior")}
        out["markets"][key] = {
            "label": lab, "target": y, "features": fs,
            "coef": {n: float(v) for n, v in zip(["intercept"] + fs, b)},
            "scale": {f: {"mean": ref[f][0], "sd": ref[f][1]} for f in fs},
            "position_means": pos_means,
            "ratio_edges": edges, "ratio_q": buckets, "n": int(len(q)),
        }
        print(f"\n{lab}: n={len(q):,} walk-forward MAE {mae:.1f} (his own average: {mae_naive:.1f}) · own-average line log loss {ll:.4f}")
        print("  pricing check (said vs hit) at lines 25% below / at / 25% above the median:",
              "  ".join(f"{int(o * 100):+d}%: {s:.3f}/{h:.3f}" for o, s, h in chk))
        print("  projection quintiles (proj -> actual mean):", "  ".join(f"{r.mu:.0f}->{r.act:.0f}" for _, r in bias.iterrows()))
    json.dump(out, open(os.path.join(HERE, "yards_model.json"), "w"), indent=1)
    print("\nwrote yards_model.json")


if __name__ == "__main__" and "--export" in sys.argv:
    export()
