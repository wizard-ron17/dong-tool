"""Do shot quality or goalie quality improve the shipped shots / goals / points models?

Features (research/nhl_xg.py, all as-of):
  ixg_prior    the skater's expected goals per game, career-to-date
  ixg_l10      his last ten games
  finish       his goals per expected goal (finishing talent, shrunk hard)
  opp_gsax100  the opposing starter's goals saved above expected per 100 shots
  opp_backup   the opposing starter made < half his club's last 20 starts
  opp_xga      the opponent's expected goals against per game

Each is added on its own to each shipped model, then the best together; fitted
walk-forward (train on earlier seasons, predict the next — 2023-24, 2024-25,
2025-26 held out) and compared game by game against the shipped model on the
SAME folds: mean log-loss gain per 1,000 games and a paired t (|t| > 2.5 to
count, as every other NHL test here).

    python3 research/nhl_quality_test.py
"""
import json, os, sys
import numpy as np
import pandas as pd
from scipy.stats import poisson

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import nhl_sog as S
import nhl_points as PT

D = pd.read_parquet(os.path.join(HERE, "nhl_sog.parquet"))
X = pd.read_parquet(os.path.join(HERE, "nhl_xg_features.parquet"))
D = D.merge(X.drop(columns=["season"]), on=["pid", "date"], how="left")
P = PT.D.merge(X.drop(columns=["season"]), on=["pid", "date"], how="left")
for df in (D, P):
    for c in ("ixg_prior", "ixg_l10", "finish", "opp_xga_prior"):
        df["log_" + c] = np.log(df[c].clip(lower=1e-3))
    df["opp_gsax100"] = df.opp_gsax100.fillna(0.0)
    df["opp_backup"] = (df.opp_starter_share.fillna(1.0) < 0.5).astype(float)
for f, o in S.LOG_OFFSET.items():
    D["log_" + f] = np.log(D[f].clip(lower=0) + o)
D["scored"] = (D.goals > 0).astype(float)
GOAL_FEATS = json.load(open(os.path.join(HERE, "nhl_goals_model.json")))["features"]
CANDS = [("shot quality: xG/game", ["log_ixg_prior"]), ("shot quality: last-10 xG", ["log_ixg_l10"]),
         ("finishing (goals per xG)", ["log_finish"]), ("opposing goalie GSAx", ["opp_gsax100"]),
         ("opposing goalie is a backup", ["opp_backup"]), ("opponent xG against", ["log_opp_xga_prior"])]


def design(df, feats, ref):
    Xm = [np.ones(len(df))] + [(df[f].to_numpy(float) - ref[f][0]) / ref[f][1] for f in feats]
    Xm.append((df.role.to_numpy() == "D").astype(float))
    return np.column_stack(Xm)


def walk_mu(df, target, feats):
    """Out-of-sample means for every row of seasons 2..n, fitted on the seasons before."""
    mu = pd.Series(np.nan, index=df.index)
    for s in sorted(df.season.unique())[1:]:
        tr, te = df[df.season < s], df[df.season == s]
        ref = {f: (tr[f].mean(), tr[f].std() or 1.0) for f in feats}
        b = S.poisson_irls(design(tr, feats, ref), tr[target].to_numpy(float))
        mu[te.index] = np.exp(np.clip(design(te, feats, ref) @ b, -8, 3))
    return mu


def row_ll(p, y):
    p = np.clip(p, 1e-6, 1 - 1e-6)
    return -(y * np.log(p) + (1 - y) * np.log(1 - p))


def compare(name, df, target, base, lossfn):
    m0 = walk_mu(df, target, base)
    idx = m0.dropna().index
    l0 = lossfn(m0[idx], df.loc[idx])
    print(f"\n{name}  (shipped model, {len(idx):,} held-out games)")
    best = []
    for lab, extra in CANDS + [("all six together", sum((e for _, e in CANDS), []))]:
        m1 = walk_mu(df, target, base + extra)
        d = l0 - lossfn(m1[idx], df.loc[idx])
        t = d.mean() / (d.std() / np.sqrt(len(d)))
        mark = "  <-- counts" if t > 2.5 else ""
        print(f"  {lab:32s} {d.mean() * 1000:+.3f} per 1,000   t {t:+.2f}{mark}")


if __name__ == "__main__":
    goal_loss = lambda mu, rows: row_ll(1 - np.exp(-mu.to_numpy()), rows.scored.to_numpy())
    compare("GOALS — anytime goal (P(1+))", D, "goals", GOAL_FEATS, goal_loss)

    # shots: the negative-binomial ladder the site prices, mean log loss over its lines
    def sog_loss(mu, rows):
        y = rows.sog.to_numpy(float); m = mu.to_numpy()
        alpha = 0.12
        return np.mean([row_ll(S.nb_sf(L, m, alpha), (y > L).astype(float)) for L in S.LINES], axis=0)
    compare("SHOTS — ladder o1.5..o5.5", D, "sog", S.SHIPPED, sog_loss)

    for t, lab in (("pts", "POINTS o0.5"), ("a", "ASSISTS o0.5")):
        loss = lambda mu, rows, t=t: row_ll(1 - np.exp(-mu.to_numpy()), (rows[t] > 0).to_numpy(float))
        compare(lab, P, t, PT.SHIPPED[t], loss)
