"""Frank's angles on NHL shots (2026-10-07): do they add anything to the shipped SOG model?

    python3 research/nhl_sog_angles.py

Frank the Bank (Discord) asked about: which position shoots most for a team, how often a
position shoots against a given opponent, PP / PK frequency, and a TOI adjustment per shot
attempt. The shipped model (nhl_sog_model.json) already carries career / last-5 / last-10
SOG, ice time, PP minutes, opponent shots allowed (all skaters), own team shots-for and
home. nhl_sog.py's ladder already found Corsi / Fenwick / attempts-on-net null over SOG.

New features, every one from games STRICTLY before the row (a team's last N games,
shifted, shrunk toward the league):
  opp_sa_role   shots the opponent allows per game to THIS role (F or D), vs league
  opp_sh        how much power-play time the opponent gives away (its penalty habit)
  pp_x_oppsh    the player's PP minutes x that habit: more PP time vs a penalty-prone club
  team_pp       how much PP time his own club draws
  rate_x_toi    shots per 60 x recent ice time, as one term
  team_role_sh  share of his club's shots its F (or D) take, vs league

Each is added to the shipped feature set and scored walk-forward (fit on prior seasons,
predict the next cold) on the same NB ladder log loss nhl_sog.py uses; per-season deltas
show whether a gain is consistent or one season's noise.
"""
import os, sys
import numpy as np
import pandas as pd

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import nhl_sog as M          # D (with log_ features), walk(), design(), poisson_irls()

D = M.D
WIN, K = 40, 10              # team window (games) and shrinkage (games) for team-level priors


def team_prior(df, key_cols, val_col, out_col):
    """Per key (e.g. defending club x role), the mean of val over its previous WIN games,
    shrunk K games toward the league mean of that key's population; NaN-free."""
    df = df.sort_values("date").copy()
    g = df.groupby(key_cols, sort=False)[val_col]
    roll_sum = g.transform(lambda s: s.shift(1).rolling(WIN, min_periods=1).sum())
    roll_n = g.transform(lambda s: s.shift(1).rolling(WIN, min_periods=1).count())
    lg = df.groupby(key_cols[1:] or (lambda _: 0))[val_col].transform("mean") if len(key_cols) > 1 else df[val_col].mean()
    df[out_col] = (roll_sum.fillna(0) + K * lg) / (roll_n.fillna(0) + K)
    df[out_col + "_lg"] = lg
    return df


def build():
    # one row per (game date, club, role): the club's shots and PP time in that game
    g = D.groupby(["season", "date", "team", "opp", "role"], as_index=False).agg(sog=("sog", "sum"), pp=("pptoi", "sum"))
    club = g.groupby(["season", "date", "team", "opp"], as_index=False).agg(sog=("sog", "sum"), pp=("pp", "sum"))
    club = club.merge(g.pivot_table(index=["date", "team"], columns="role", values="sog", aggfunc="sum").reset_index()
                      .rename(columns={"F": "sog_F", "D": "sog_D"}), on=["date", "team"], how="left")

    # 1) shots the DEFENDING club allows to each role: the attacking club's role shots, keyed by its opponent
    allow = g.rename(columns={"opp": "def"})[["date", "def", "role", "sog"]]
    allow = team_prior(allow, ["def", "role"], "sog", "opp_sa_role")
    feat = allow[["date", "def", "role", "opp_sa_role", "opp_sa_role_lg"]].rename(columns={"def": "opp"})

    # 2) the opponent's penalty habit: PP time its opponents got against it
    pen = club.rename(columns={"opp": "def"})[["date", "def", "pp"]]
    pen = team_prior(pen, ["def"], "pp", "opp_sh")
    pen = pen[["date", "def", "opp_sh", "opp_sh_lg"]].rename(columns={"def": "opp"})

    # 3) his own club's PP draw, and the share of its shots each role takes
    own = team_prior(club[["date", "team", "pp"]].copy(), ["team"], "pp", "team_pp")[["date", "team", "team_pp", "team_pp_lg"]]
    sh = club[["date", "team", "sog", "sog_D"]].copy()
    sh["d_share"] = sh.sog_D.fillna(0) / sh.sog.clip(lower=1)
    sh = team_prior(sh, ["team"], "d_share", "team_d_share")[["date", "team", "team_d_share", "team_d_share_lg"]]

    X = D.merge(feat, on=["date", "opp", "role"], how="left").merge(pen, on=["date", "opp"], how="left") \
         .merge(own, on=["date", "team"], how="left").merge(sh, on=["date", "team"], how="left")
    assert len(X) == len(D), (len(X), len(D))
    lg = lambda c: X[c + "_lg"].fillna(X[c].mean())
    X["opp_sa_role"] = np.log(X.opp_sa_role.fillna(lg("opp_sa_role")) / lg("opp_sa_role"))
    X["opp_sh"] = np.log(X.opp_sh.fillna(lg("opp_sh")) / lg("opp_sh"))
    X["team_pp"] = np.log(X.team_pp.fillna(lg("team_pp")) / lg("team_pp"))
    X["pp_x_oppsh"] = X.log_pptoi_l5 * X.opp_sh                  # PP men see more of a penalty-prone opponent
    share = X.team_d_share.fillna(lg("team_d_share")) / lg("team_d_share")
    X["team_role_sh"] = np.where(X.role == "D", np.log(share), np.log((1 - X.team_d_share.fillna(lg("team_d_share"))) / (1 - lg("team_d_share"))))
    X["rate_x_toi"] = np.log(X.sog60_prior.clip(lower=0) * X.toi_l5.clip(lower=0) / 3600 + 0.1)
    return X


BASE = ["log_sog_prior", "log_sog_l5", "log_sog_l10", "log_toi_prior", "log_toi_l5", "log_pptoi_l5",
        "opp_sa_prior", "team_sf_prior", "is_home"]
TESTS = [
    ("shipped model",                                   BASE),
    ("+ opp shots allowed TO HIS POSITION",             BASE + ["opp_sa_role"]),
    ("  ... instead of all-skater opp shots allowed",   [f for f in BASE if f != "opp_sa_prior"] + ["opp_sa_role"]),
    ("+ opponent's penalty habit (PP time given)",      BASE + ["opp_sh"]),
    ("+ his PP minutes x opponent's penalty habit",     BASE + ["opp_sh", "pp_x_oppsh"]),
    ("+ own club's PP draw",                            BASE + ["team_pp"]),
    ("+ shots/60 x ice time (one term)",                BASE + ["rate_x_toi"]),
    ("+ his position's share of his club's shots",      BASE + ["team_role_sh"]),
]


def season_ll(X, feats, s):
    """M.walk's fit for one test season: train on every earlier season, score season s."""
    tr, te = X[X.season < s], X[X.season == s]
    ref = {f: (tr[f].mean(), tr[f].std() or 1.0) for f in feats}
    b = M.poisson_irls(M.design(tr, feats, ref), tr.sog.to_numpy(float))
    alpha = M.nb_dispersion(tr.sog.to_numpy(float), np.exp(np.clip(M.design(tr, feats, ref) @ b, -6, 6)))
    mu, y = np.exp(np.clip(M.design(te, feats, ref) @ b, -6, 6)), te.sog.to_numpy(float)
    lls = []
    for L in M.LINES:
        p = np.clip(M.nb_sf(L, mu, alpha), 1e-9, 1 - 1e-9); hit = (y > L).astype(float)
        lls.append(float(-(hit * np.log(p) + (1 - hit) * np.log(1 - p)).mean()))
    return float(np.mean(lls))


def main():
    X = build()
    M.D = X                                                         # walk() reads the module's D
    seasons = sorted(X.season.unique())
    base = M.walk(BASE, seasons)
    print(f"skater-games {len(X):,}  test seasons {seasons[1:]}\n")
    print(f"{'model':48s} {'ladder log loss':>15s} {'vs shipped':>11s}   per test season (vs shipped)")
    base_ps = {s: season_ll(X, BASE, s) for s in seasons[1:]}
    for name, feats in TESTS:
        r = M.walk(feats, seasons)
        ps = [f"{(season_ll(X, feats, s) / base_ps[s] - 1) * 100:+.2f}%" for s in seasons[1:]]
        print(f"{name:48s} {r['ll']:15.5f} {(r['ll'] / base['ll'] - 1) * 100:+10.2f}%   {'  '.join(ps)}")
    # how different are clubs, really? (is there a signal to find)
    for c in ["opp_sa_role", "opp_sh", "team_pp", "team_role_sh"]:
        v = X[c]
        print(f"  spread of {c:13s}: 10th pct {np.exp(v.quantile(0.1)):.2f}x  90th {np.exp(v.quantile(0.9)):.2f}x of league")


if __name__ == "__main__":
    main()
