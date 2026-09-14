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


def load_pbp():
    d = pd.concat([pd.read_parquet(f"{CACHE}/pbp_{y}.parquet", columns=PBP) for y in SEASONS], ignore_index=True)
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


if __name__ == "__main__":
    d = load_pbp()
    ctx = game_ctx(d)
    dfp = def_priors(defense_table(d))
    if "--live" in sys.argv:
        live(d, ctx, dfp)
    else:
        passing(d, ctx, dfp)
        skill(d, ctx, dfp)
