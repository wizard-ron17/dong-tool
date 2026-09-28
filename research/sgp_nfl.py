"""NFL same-game correlations, measured (research).

    PICKS_CACHE=<nflverse pbp cache> python3 research/sgp_nfl.py   # writes sgp_nfl.json

Every pair of legs the NFL slip can hold, fit as a copula ρ (sgp_core.py)
with each leg's own probability as its margin, walk-forward 2019-2025:

  anytime TD      the shipped model (backtest.py FINAL, M12), exactly
  everything else walk-forward count models on the market's own history —
                  a windowed prior, last three games, the implied team total
                  and the spread — at the near-even line: receptions,
                  receiving / rushing yards, a QB's completions, pass yards,
                  pass TDs (over 1.5), an interception (1+), a kicker's points.
                  Close stand-ins for the shipped models, calibrated; what
                  matters for ρ is that the shared game context (the implied
                  total) is in every margin, so ρ is what's left beyond it.

The questions it answers: does one receiver eating mean another eats less
(teammates' receptions), do interceptions cost completions, do receptions
carry yards, does a rushing TD take a passing TD away, do kickers feed off
stalled drives or TDs…
"""
import json, os, sys
import numpy as np, pandas as pd
from scipy.stats import poisson, nbinom
sys.path.insert(0, os.path.dirname(__file__))
from sgp_core import fit_rho
import backtest as BT

HERE = os.path.dirname(os.path.abspath(__file__))
CACHE = os.environ.get("PICKS_CACHE")
SEASONS = range(2016, 2026)
RNG = np.random.default_rng(11)


def load():
    cols = ["game_id", "season", "week", "season_type", "posteam", "defteam", "home_team", "away_team", "passer_player_id",
            "receiver_player_id", "rusher_player_id", "kicker_player_id", "complete_pass", "pass_attempt", "rush_attempt",
            "interception", "pass_touchdown", "rush_touchdown", "receiving_yards", "rushing_yards", "passing_yards",
            "field_goal_result", "extra_point_result", "total_line", "spread_line", "sack"]
    d = pd.concat([pd.read_parquet(f"{CACHE}/pbp_{y}.parquet", columns=cols) for y in SEASONS], ignore_index=True)
    return d[(d.season_type == "REG") & d.posteam.notna()]


def game_ctx(d):
    g = d.groupby(["game_id", "posteam"], as_index=False).agg(season=("season", "first"), week=("week", "first"),
        defteam=("defteam", "first"), home=("home_team", "first"), total=("total_line", "first"), spread=("spread_line", "first"))
    home = g.posteam == g.home
    g["implied"] = np.where(home, g.total / 2 + g.spread / 2, g.total / 2 - g.spread / 2)
    g["spread_own"] = np.where(home, g.spread, -g.spread)
    return g.rename(columns={"posteam": "team"})[["game_id", "team", "season", "week", "defteam", "implied", "spread_own"]]


def tables(d):
    pa = d[(d.pass_attempt == 1) & (d.sack != 1)]
    rec = pa[pa.receiver_player_id.notna()].groupby(["game_id", "posteam", "receiver_player_id"], as_index=False).agg(
        tgt=("pass_attempt", "sum"), rec=("complete_pass", "sum"), ryds=("receiving_yards", "sum")).rename(columns={"receiver_player_id": "pid"})
    ru = d[(d.rush_attempt == 1) & d.rusher_player_id.notna()].groupby(["game_id", "posteam", "rusher_player_id"], as_index=False).agg(
        car=("rush_attempt", "sum"), rush=("rushing_yards", "sum")).rename(columns={"rusher_player_id": "pid"})
    sk = rec.merge(ru, on=["game_id", "posteam", "pid"], how="outer").fillna(0).rename(columns={"posteam": "team"})
    qb = pa[pa.passer_player_id.notna()].groupby(["game_id", "posteam", "passer_player_id"], as_index=False).agg(
        att=("pass_attempt", "sum"), cmp=("complete_pass", "sum"), ints=("interception", "sum"), ptd=("pass_touchdown", "sum"),
        pyds=("passing_yards", "sum")).rename(columns={"passer_player_id": "pid", "posteam": "team"})
    qb = qb[qb.att >= 15]                               # starters
    k = d[d.kicker_player_id.notna()].copy()
    k["pts"] = np.where(k.field_goal_result == "made", 3, 0) + np.where(k.extra_point_result == "good", 1, 0)
    kk = k.groupby(["game_id", "posteam", "kicker_player_id"], as_index=False).pts.sum().rename(columns={"kicker_player_id": "pid", "posteam": "team"})
    return sk, qb, kk


def priors(df, cols, k=3.0):
    """As-of mean of each col over the player's earlier games (shrunk toward
    the column mean, k games) and his last three."""
    df = df.sort_values(["pid", "season", "week"]).reset_index(drop=True)
    g = df.groupby("pid", sort=False)
    for c in cols:
        s = g[c].cumsum() - df[c]; n = g.cumcount()
        df[c + "_prior"] = (s + k * df[c].mean()) / (n + k)
        df[c + "_l3"] = g[c].transform(lambda x: x.shift(1).rolling(3, min_periods=1).mean()).fillna(df[c + "_prior"])
    df["games_prior"] = g.cumcount()
    return df


def irls(X, y, ridge=1.0, it=50):
    b = np.zeros(X.shape[1]); b[0] = np.log(max(y.mean(), 1e-3))
    for _ in range(it):
        mu = np.exp(np.clip(X @ b, -8, 8)); z = X @ b + (y - mu) / mu
        A = X.T @ (X * mu[:, None]) + ridge * np.eye(X.shape[1]); A[0, 0] -= ridge
        nb = np.linalg.solve(A, X.T @ (mu * z))
        if np.max(np.abs(nb - b)) < 1e-9: return nb
        b = nb
    return b


def walk(df, y, feats):
    """Walk-forward mu and NB dispersion (alpha) per row, 2019+."""
    mu = pd.Series(np.nan, index=df.index); al = pd.Series(np.nan, index=df.index)
    for s in range(2019, 2026):
        tr, te = df[df.season < s], df[df.season == s]
        ref = {f: (tr[f].mean(), tr[f].std() + 1e-9) for f in feats}
        X = lambda q: np.column_stack([np.ones(len(q))] + [(q[f].to_numpy(float) - ref[f][0]) / ref[f][1] for f in feats])
        b = irls(X(tr), tr[y].to_numpy(float))
        m_tr = np.exp(np.clip(X(tr) @ b, -8, 8)); yy = tr[y].to_numpy(float)
        a = max(0.0, float((((yy - m_tr) ** 2 - yy).sum()) / (m_tr ** 2).sum()))
        mu.loc[te.index] = np.exp(np.clip(X(te) @ b, -8, 8)); al.loc[te.index] = a
    return mu, al


def sf(L, mu, a):
    """P(X > L), NB with dispersion a (Poisson when a ~ 0)."""
    L = np.floor(L)
    if np.all(a < 1e-6): return poisson.sf(L, mu)
    r = 1 / np.maximum(a, 1e-6); p = r / (r + mu)
    return nbinom.sf(L, r, p)


def at_even(df, y, mu, al, maxL=450, step=1.0):
    """Each row at its near-even half line; yards step coarser for speed."""
    best_p = np.full(len(df), np.nan); best_L = np.full(len(df), np.nan)
    m, a = mu.to_numpy(float), al.to_numpy(float)
    for L in np.arange(0.5, maxL, step):
        p = sf(L, m, a)
        better = np.isnan(best_p) | (np.abs(p - 0.5) < np.abs(best_p - 0.5))
        best_p = np.where(better, p, best_p); best_L = np.where(better, L, best_L)
    return np.clip(best_p, 1e-4, 1 - 1e-4), df[y].to_numpy(float) > best_L


def td_margins():
    """The shipped anytime-TD model, walk-forward, per (game_id, pid)."""
    ds = pd.read_parquet(BT.DATA)
    F = BT.MODELS[BT.FINAL]; out = []
    for s in range(2019, 2026):
        tr, te = ds[ds.season < s], ds[ds.season == s]
        X, mu, sd = BT.design(tr, F); w = BT.fit_logistic(X, tr.scored.to_numpy(float))
        out.append(te[["game_id", "pid", "team", "position"]].assign(p_td=BT.predict(BT.design(te, F, mu, sd)[0], w), y_td=te.scored.to_numpy() > 0))
    return pd.concat(out)


def margins():
    """Every leg's walk-forward margin: R receivers (rec, ryds), U runners (rush),
    Q starting QBs (cmp, pyds, int, ptd), Kx kickers (kp), T anytime TD."""
    d = load(); ctx = game_ctx(d); sk, qb, kk = tables(d)
    sk = priors(sk.merge(ctx, on=["game_id", "team"]), ["rec", "tgt", "ryds", "rush", "car"])
    qb = priors(qb.merge(ctx, on=["game_id", "team"]), ["att", "cmp", "ints", "ptd", "pyds"])
    kk = priors(kk.merge(ctx, on=["game_id", "team"]), ["pts"])
    sk = sk[sk.games_prior >= 3]; qb = qb[qb.games_prior >= 3]; kk = kk[kk.games_prior >= 3]
    ctxf = ["implied", "spread_own"]
    # receivers with a real target share; runners with a real carry share
    R = sk[sk.tgt_prior >= 3].copy()
    R["mu_rec"], R["al_rec"] = walk(R, "rec", ["rec_prior", "rec_l3", "tgt_prior", "tgt_l3"] + ctxf)
    R["mu_ryds"], R["al_ryds"] = walk(R, "ryds", ["ryds_prior", "ryds_l3", "tgt_prior", "tgt_l3"] + ctxf)
    R = R.dropna(subset=["mu_rec", "mu_ryds"])
    R["p_rec"], R["y_rec"] = at_even(R, "rec", R.mu_rec, R.al_rec, maxL=16)
    R["p_ryds"], R["y_ryds"] = at_even(R, "ryds", R.mu_ryds, R.al_ryds, maxL=180, step=1.0)
    U = sk[sk.car_prior >= 6].copy()
    U["mu_rush"], U["al_rush"] = walk(U, "rush", ["rush_prior", "rush_l3", "car_prior", "car_l3"] + ctxf)
    U = U.dropna(subset=["mu_rush"]); U["p_rush"], U["y_rush"] = at_even(U, "rush", U.mu_rush, U.al_rush, maxL=200)
    Q = qb.copy()
    for c, f in (("cmp", ["cmp_prior", "cmp_l3", "att_prior"]), ("pyds", ["pyds_prior", "pyds_l3", "att_prior"]),
                 ("ints", ["ints_prior", "att_prior"]), ("ptd", ["ptd_prior", "ptd_l3", "att_prior"])):
        Q["mu_" + c], Q["al_" + c] = walk(Q, c, f + ctxf)
    Q = Q.dropna(subset=["mu_cmp", "mu_pyds", "mu_ints", "mu_ptd"])
    Q["p_cmp"], Q["y_cmp"] = at_even(Q, "cmp", Q.mu_cmp, Q.al_cmp, maxL=40)
    Q["p_pyds"], Q["y_pyds"] = at_even(Q, "pyds", Q.mu_pyds, Q.al_pyds, maxL=450)
    Q["p_int"] = np.clip(1 - np.exp(-Q.mu_ints), 1e-4, 1 - 1e-4); Q["y_int"] = Q.ints >= 1
    Q["p_ptd"] = np.clip(sf(1.5, Q.mu_ptd.to_numpy(), Q.al_ptd.to_numpy()), 1e-4, 1 - 1e-4); Q["y_ptd"] = Q.ptd >= 2
    Kx = kk.copy(); Kx["mu_pts"], Kx["al_pts"] = walk(Kx, "pts", ["pts_prior", "pts_l3"] + ctxf)
    Kx = Kx.dropna(subset=["mu_pts"]); Kx["p_kp"], Kx["y_kp"] = at_even(Kx, "pts", Kx.mu_pts, Kx.al_pts, maxL=20)
    T = td_margins()
    print("margins (priced vs actual):",
          {k: (round(float(df["p_" + k].mean()), 3), round(float(df["y_" + k].mean()), 3)) for df, k in
           ((R, "rec"), (R, "ryds"), (U, "rush"), (Q, "cmp"), (Q, "pyds"), (Q, "int"), (Q, "ptd"), (Kx, "kp"), (T, "td"))}, flush=True)
    return R, U, Q, Kx, T


def main():
    R, U, Q, Kx, T = margins()
    out = {}

    def rec_(key, lab, a, b, ka, kb, grp, cap=250_000):
        if len(a) > cap:
            ix = RNG.choice(len(a), cap, replace=False); a, b, grp = a.iloc[ix], b.iloc[ix], grp.iloc[ix]
        res = fit_rho(a["p_" + ka], b["p_" + kb], a["y_" + ka], b["y_" + kb], groups=grp)
        out[key] = {**res, "label": lab}
        ci = f"[{res['lo']:+.3f}, {res['hi']:+.3f}]"
        print(f"{lab:56s} ρ {res['rho']:+.3f} {ci:18s} n {res['n']:7d}  lift {res['lift_at_avg']:.3f}", flush=True)

    A = lambda d, s: d[[c for c in d.columns if c.endswith(s)]].rename(columns=lambda c: c[:-2])
    # same player
    RT = R.merge(T, on=["game_id", "pid"], suffixes=("", "_t"))
    rec_("rec_ryds_same", "receptions over + receiving yards over · same player", R, R, "rec", "ryds", R.game_id)
    rec_("rec_td_same", "receptions over + anytime TD · same player", RT, RT, "rec", "td", RT.game_id)
    rec_("ryds_td_same", "receiving yards over + anytime TD · same player", RT, RT, "ryds", "td", RT.game_id)
    UT = U.merge(T, on=["game_id", "pid"], suffixes=("", "_t"))
    rec_("rush_td_same", "rushing yards over + anytime TD · same player", UT, UT, "rush", "td", UT.game_id)
    # teammates: one eating vs the others
    RR = R[["game_id", "team", "pid", "p_rec", "y_rec", "p_ryds", "y_ryds"]]
    tm = RR.merge(RR, on=["game_id", "team"], suffixes=("_a", "_b")); tm = tm[tm.pid_a < tm.pid_b]
    rec_("rec_rec_team", "receptions over + receptions over · teammates", A(tm, "_a"), A(tm, "_b"), "rec", "rec", tm.game_id)
    rec_("ryds_ryds_team", "receiving yards over + receiving yards over · teammates", A(tm, "_a"), A(tm, "_b"), "ryds", "ryds", tm.game_id)
    TT = T.merge(T, on=["game_id", "team"], suffixes=("_a", "_b")); TT = TT[TT.pid_a < TT.pid_b]
    rec_("td_td_team", "anytime TD + anytime TD · teammates", A(TT, "_a"), A(TT, "_b"), "td", "td", TT.game_id)
    TO = T.merge(T, on="game_id", suffixes=("_a", "_b")); TO = TO[(TO.team_a != TO.team_b) & (TO.pid_a < TO.pid_b)]
    rec_("td_td_opp", "anytime TD + anytime TD · opponents", A(TO, "_a"), A(TO, "_b"), "td", "td", TO.game_id)
    # QB and his receivers
    QR = Q[["game_id", "team", "p_cmp", "y_cmp", "p_pyds", "y_pyds", "p_int", "y_int", "p_ptd", "y_ptd"]].merge(RR, on=["game_id", "team"])
    rec_("cmp_rec_team", "QB completions over + a receiver's receptions over", QR, QR, "cmp", "rec", QR.game_id)
    rec_("pyds_ryds_team", "QB passing yards over + a receiver's yards over", QR, QR, "pyds", "ryds", QR.game_id)
    rec_("int_rec_team", "QB interception + a receiver's receptions over", QR, QR, "int", "rec", QR.game_id)
    QT = Q[["game_id", "team", "p_ptd", "y_ptd", "p_int", "y_int"]].merge(T, on=["game_id", "team"])
    rec_("ptd_td_wr", "QB 2+ pass TDs + a WR/TE's anytime TD", QT[QT.position.isin(["WR", "TE"])], QT[QT.position.isin(["WR", "TE"])], "ptd", "td", QT[QT.position.isin(["WR", "TE"])].game_id)
    rec_("ptd_td_rb", "QB 2+ pass TDs + an RB's anytime TD", QT[QT.position == "RB"], QT[QT.position == "RB"], "ptd", "td", QT[QT.position == "RB"].game_id)
    rec_("int_td_team", "QB interception + a teammate's anytime TD", QT, QT, "int", "td", QT.game_id)
    # the QB himself
    for key, lab, ka, kb in (("int_cmp_same", "interception + completions over · same QB", "int", "cmp"), ("int_ptd_same", "interception + 2+ pass TDs · same QB", "int", "ptd"),
                             ("cmp_pyds_same", "completions over + passing yards over · same QB", "cmp", "pyds"), ("ptd_pyds_same", "2+ pass TDs + passing yards over · same QB", "ptd", "pyds")):
        rec_(key, lab, Q, Q, ka, kb, Q.game_id)
    QQ = Q.merge(Q, on="game_id", suffixes=("_a", "_b")); QQ = QQ[QQ.team_a < QQ.team_b]
    rec_("pyds_pyds_opp", "passing yards over + passing yards over · the two QBs", A(QQ, "_a"), A(QQ, "_b"), "pyds", "pyds", QQ.game_id)
    rec_("int_int_opp", "interception + interception · the two QBs", A(QQ, "_a"), A(QQ, "_b"), "int", "int", QQ.game_id)
    # kickers
    KT = Kx[["game_id", "team", "p_kp", "y_kp"]].merge(T, on=["game_id", "team"])
    rec_("kp_td_team", "kicker points over + a teammate's anytime TD", KT, KT, "kp", "td", KT.game_id)
    KQ = Kx[["game_id", "team", "p_kp", "y_kp"]].merge(Q[["game_id", "team", "p_ptd", "y_ptd"]], on=["game_id", "team"])
    rec_("kp_ptd_team", "kicker points over + his QB's 2+ pass TDs", KQ, KQ, "kp", "ptd", KQ.game_id)
    json.dump(out, open(os.path.join(HERE, "sgp_nfl.json"), "w"), indent=1)
    print("wrote research/sgp_nfl.json")


if __name__ == "__main__":
    main()
