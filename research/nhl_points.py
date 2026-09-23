"""Points, assists and power-play points — walk-forward ladders.

Poisson GLM means on log-scale rates (the shots calibration lesson), scored as
the binary lines books hang: points o0.5 / o1.5 / o2.5, assists o0.5 / o1.5,
PP points o0.5. Each ladder asks the same question as the goals one — which
terms carry real out-of-sample signal — plus two specific to these markets:

  * INVOLVEMENT: his points as a share of the goals his team scored in his
    games. An assist is half another player's event, so a share-of-team-goals
    rate may be steadier than raw points per game.
  * DISPERSION: pooled points run var/mean 1.15, but much of that is player
    mix. The tail distribution (Poisson vs NB) is decided on held-out lines.

    python3 research/nhl_points.py
"""
import os, sys
import numpy as np
import pandas as pd
from nhl_sog import poisson_irls, nb_dispersion, nb_sf
from scipy.stats import poisson

HERE = os.path.dirname(os.path.abspath(__file__))
D = pd.read_parquet(os.path.join(HERE, "nhl_points.parquet"))
LOG = {"pts_prior": 0.02, "a_prior": 0.02, "ppp_prior": 0.005, "goals_prior": 0.01, "pts_l10": 0.05, "a_l10": 0.05,
       "ppp_l10": 0.02, "toi_prior": 30, "toi_l5": 30, "pptoi_l5": 5, "pptoi_l10": 5, "sog_prior": 0.1,
       "team_gf_prior": 0.1, "opp_ga_prior": 0.1, "inv_prior": 0.01, "a_inv_prior": 0.01, "ppinv_prior": 0.01}
for c, o in LOG.items():
    D["log_" + c] = np.log(D[c].clip(lower=0) + o)
SEASONS = sorted(D.season.unique())
LINES = {"pts": [0.5, 1.5, 2.5], "a": [0.5, 1.5], "ppp": [0.5]}


def design(df, feats, ref):
    X = [np.ones(len(df))] + [(df[f].to_numpy(float) - ref[f][0]) / ref[f][1] for f in feats]
    X.append((df.role.to_numpy() == "D").astype(float))
    return np.column_stack(X)


def auc(p, y):
    o = np.argsort(p); r = np.empty(len(p)); r[o] = np.arange(1, len(p) + 1)
    n1 = y.sum(); n0 = len(y) - n1
    return float((r[y == 1].sum() - n1 * (n1 + 1) / 2) / (n1 * n0))


def walk(target, feats, dist="poisson"):
    lls, aucs, P, Y = [], [], [], []
    for s in SEASONS[1:]:
        tr, te = D[D.season < s], D[D.season == s]
        ref = {f: (tr[f].mean(), tr[f].std() or 1.0) for f in feats}
        b = poisson_irls(design(tr, feats, ref), tr[target].to_numpy(float))
        mu = np.exp(np.clip(design(te, feats, ref) @ b, -8, 3))
        mu_tr = np.exp(np.clip(design(tr, feats, ref) @ b, -8, 3))
        y = te[target].to_numpy(float)
        a = nb_dispersion(tr[target].to_numpy(float), mu_tr) if dist == "nb" else None
        sf = (lambda L: nb_sf(L, mu, a)) if dist == "nb" else (lambda L: poisson.sf(np.floor(L), mu))
        row = []
        for L in LINES[target]:
            p = np.clip(sf(L), 1e-6, 1 - 1e-6); h = (y > L).astype(float)
            row.append(float(-(h * np.log(p) + (1 - h) * np.log(1 - p)).mean()))
        lls.append((len(y), row)); aucs.append((len(y), auc(poisson.sf(0, mu), (y > 0).astype(float))))
        P.append(mu); Y.append(y)
    n = sum(x[0] for x in lls)
    per = np.sum([np.array(r) * k for k, r in lls], axis=0) / n
    return dict(ll=float(per.mean()), per=per, auc=sum(a * k for k, a in aucs) / n, mu=np.concatenate(P), y=np.concatenate(Y))


LADDERS = {
    "pts": [
        ("P0  position only",                 []),
        ("P1  + career points/game",          ["log_pts_prior"]),
        ("P2  + goals & assists split",       ["log_goals_prior", "log_a_prior"]),
        ("P3  + last-10 points",              ["log_goals_prior", "log_a_prior", "log_pts_l10"]),
        ("P4  + ice time, PP minutes",        ["log_goals_prior", "log_a_prior", "log_pts_l10", "log_toi_prior", "log_toi_l5", "log_pptoi_l5"]),
        ("P5  + career shots",                ["log_goals_prior", "log_a_prior", "log_pts_l10", "log_toi_prior", "log_toi_l5", "log_pptoi_l5", "log_sog_prior"]),
        ("P6  + team GF, opp GA, home",       ["log_goals_prior", "log_a_prior", "log_pts_l10", "log_toi_prior", "log_toi_l5", "log_pptoi_l5", "log_sog_prior", "log_team_gf_prior", "log_opp_ga_prior", "is_home"]),
        ("P7  + involvement",                 ["log_goals_prior", "log_a_prior", "log_pts_l10", "log_toi_prior", "log_toi_l5", "log_pptoi_l5", "log_sog_prior", "log_team_gf_prior", "log_opp_ga_prior", "is_home", "log_inv_prior"]),
        ("P8  structural: team GF x involvement + usage", ["log_team_gf_prior", "log_opp_ga_prior", "log_inv_prior", "log_toi_l5", "log_pptoi_l5", "is_home"]),
    ],
    "a": [
        ("A0  position only",                 []),
        ("A1  + career assists/game",         ["log_a_prior"]),
        ("A2  + last-10 assists",             ["log_a_prior", "log_a_l10"]),
        ("A3  + ice time, PP minutes",        ["log_a_prior", "log_a_l10", "log_toi_prior", "log_toi_l5", "log_pptoi_l5"]),
        ("A4  + career goals (finishers pass less?)", ["log_a_prior", "log_a_l10", "log_toi_prior", "log_toi_l5", "log_pptoi_l5", "log_goals_prior"]),
        ("A5  + team GF, opp GA, home",       ["log_a_prior", "log_a_l10", "log_toi_prior", "log_toi_l5", "log_pptoi_l5", "log_goals_prior", "log_team_gf_prior", "log_opp_ga_prior", "is_home"]),
        ("A6  + assist involvement",          ["log_a_prior", "log_a_l10", "log_toi_prior", "log_toi_l5", "log_pptoi_l5", "log_goals_prior", "log_team_gf_prior", "log_opp_ga_prior", "is_home", "log_a_inv_prior"]),
    ],
    "ppp": [
        ("Q0  position only",                 []),
        ("Q1  + career PP points/game",       ["log_ppp_prior"]),
        ("Q2  + PP minutes (l5, l10)",        ["log_ppp_prior", "log_pptoi_l5", "log_pptoi_l10"]),
        ("Q3  + last-10 PP points",           ["log_ppp_prior", "log_pptoi_l5", "log_pptoi_l10", "log_ppp_l10"]),
        ("Q4  + opp penalty kill, home",      ["log_ppp_prior", "log_pptoi_l5", "log_pptoi_l10", "log_ppp_l10", "opp_pk_prior", "is_home"]),
        ("Q5  + PP involvement",              ["log_ppp_prior", "log_pptoi_l5", "log_pptoi_l10", "log_ppp_l10", "opp_pk_prior", "is_home", "log_ppinv_prior"]),
        ("Q6  + team GF",                     ["log_ppp_prior", "log_pptoi_l5", "log_pptoi_l10", "log_ppp_l10", "opp_pk_prior", "is_home", "log_ppinv_prior", "log_team_gf_prior"]),
    ],
}

if __name__ == "__main__":
    print(f"{len(D):,} skater-games · test seasons {SEASONS[1:]}")
    best = {}
    for target, ladder in LADDERS.items():
        print(f"\n{target.upper()} — mean binary log loss over lines {LINES[target]}   (AUC is for 1+)")
        base = None
        for name, f in ladder:
            r = walk(target, f)
            base = base or r["ll"]
            print(f"  {name:48s} ll {r['ll']:.5f} ({(r['ll'] / base - 1) * 100:+.2f}%)  AUC {r['auc']:.4f}  per-line {np.round(r['per'], 5)}")
            if name[1] != "0" and (target not in best or r["ll"] < best[target][1]["ll"]):
                best[target] = (f, r)
    print("\nDISPERSION — best model, Poisson vs negative binomial tails")
    for target, (f, r) in best.items():
        rn = walk(target, f, "nb")
        print(f"  {target:4s} poisson {r['ll']:.5f} {np.round(r['per'], 5)}  |  nb {rn['ll']:.5f} {np.round(rn['per'], 5)}")
    print("\nCALIBRATION of P(1+) by decile, best model (Poisson)")
    for target, (f, r) in best.items():
        p = poisson.sf(0, r["mu"]); y = (r["y"] > 0).astype(float)
        q = pd.qcut(pd.Series(p).rank(method="first"), 10, labels=False)
        t = pd.DataFrame({"p": p, "y": y, "q": q}).groupby("q").agg(p=("p", "mean"), y=("y", "mean"))
        print(f"  {target:4s} ECE {np.mean(np.abs(t.p - t.y)) * 100:.2f}pp  " + " ".join(f"{a:.3f}/{b:.3f}" for a, b in zip(t.p, t.y)))
