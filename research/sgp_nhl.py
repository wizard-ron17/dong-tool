"""NHL same-game correlations, measured (research).

    python3 research/sgp_nhl.py        # prints the table, writes sgp_nhl.json

Every pair of legs the NHL slip can hold, fit as a copula ρ (sgp_core.py) with
each leg's own model probability as its margin, walk-forward by season:

  skaters  goal 1+, assist 1+, point 1+ (Poisson, the points/goals models'
           shipped features), shots / hits / blocks at the near-even line
           (NB — the shots and physical models' shipped features)
  goalies  saves at the near-even line and goals allowed over 2.5 (count
           fits on the saves data's log features — calibrated, simpler than
           the site's pulled-goalie mixture; fine for a margin)

Pairs are within one game. Big pools (teammate skaters) are sampled — the CI
still comes from resampling whole games.
"""
import json, os, sys
import numpy as np, pandas as pd
from scipy.stats import poisson
sys.path.insert(0, os.path.dirname(__file__))
from sgp_core import fit_rho
import nhl_sog as SG
import nhl_goals as GL
import nhl_points as PT
import nhl_phys as PH

HERE = os.path.dirname(os.path.abspath(__file__))
RNG = np.random.default_rng(7)
MAX_PAIRS = 250_000


def walk_mu(D, feats, target, design):
    out = pd.Series(np.nan, index=D.index)
    for s in sorted(D.season.unique())[1:]:
        tr, te = D[D.season < s], D[D.season == s]
        ref = {f: (tr[f].mean(), tr[f].std() or 1.0) for f in feats}
        b = SG.poisson_irls(design(tr, feats, ref), tr[target].to_numpy(float))
        out.loc[te.index] = np.exp(np.clip(design(te, feats, ref) @ b, -8, 4))
    return out


def walk_nb(D, feats, target, design):
    mu = pd.Series(np.nan, index=D.index); al = pd.Series(np.nan, index=D.index)
    for s in sorted(D.season.unique())[1:]:
        tr, te = D[D.season < s], D[D.season == s]
        ref = {f: (tr[f].mean(), tr[f].std() or 1.0) for f in feats}
        b = SG.poisson_irls(design(tr, feats, ref), tr[target].to_numpy(float))
        m_tr = np.exp(np.clip(design(tr, feats, ref) @ b, -6, 5))
        mu.loc[te.index] = np.exp(np.clip(design(te, feats, ref) @ b, -6, 5))
        al.loc[te.index] = SG.nb_dispersion(tr[target].to_numpy(float), m_tr)
    return mu, al


def even_nb(mu, alpha, y):
    """Each row at its own near-even half line: (p over, hit)."""
    Ls = np.arange(0.5, 45, 1.0)
    best_p = np.full(len(mu), np.nan); best_L = np.full(len(mu), np.nan)
    for L in Ls:
        p = SG.nb_sf(L, mu, alpha)
        better = np.isnan(best_p) | (np.abs(p - 0.5) < np.abs(best_p - 0.5))
        best_p = np.where(better, p, best_p); best_L = np.where(better, L, best_L)
    return best_p, y > best_L


def skaters():
    S = SG.D.copy()
    S["gkey"] = S.date.astype(str) + "|" + [ "|".join(sorted((a, b))) for a, b in zip(S.team, S.opp)]
    pts = PT.D[["season", "date", "pid", "a", "pts"]] if hasattr(PT, "D") else pd.read_parquet(os.path.join(HERE, "nhl_points.parquet"))[["season", "date", "pid", "a", "pts"]]
    S = S.merge(pts, on=["season", "date", "pid"], how="left")
    P = PT.D if hasattr(PT, "D") else None
    # goals, assists, points: Poisson on the shipped features
    S["mu_g"] = walk_mu(S, GL.SHIPPED, "goals", GL.design)
    PS = P.merge(S[["season", "date", "pid", "gkey"]], on=["season", "date", "pid"], how="inner") if P is not None else None
    for key, col in (("a", "mu_a"), ("pts", "mu_p")):
        PS[col] = walk_mu(PS, PT.SHIPPED[key], key, PT.design)
    S = S.merge(PS[["season", "date", "pid", "mu_a", "mu_p"]], on=["season", "date", "pid"], how="left")
    # shots: NB on the shipped features
    S["mu_s"], S["al_s"] = walk_nb(S, SG.SHIPPED, "sog", SG.design)
    # hits and blocks: the physical model's own walk-forward
    Dp, _ = PH.build()
    for tgt, c in (("hits", "h"), ("bks", "b")):
        _, P2 = PH.walk(Dp, tgt, PH.SHIPPED[tgt])
        Dp.loc[P2.index, "mu_" + c] = P2.mu; Dp.loc[P2.index, "al_" + c] = P2.alpha
    S = S.merge(Dp[["season", "date", "pid", "mu_h", "al_h", "mu_b", "al_b"]], on=["season", "date", "pid"], how="left")
    S = S.dropna(subset=["mu_g", "mu_a", "mu_p", "mu_s", "mu_h", "mu_b"]).reset_index(drop=True)
    S["p_g"], S["y_g"] = 1 - np.exp(-S.mu_g), S.goals > 0
    S["p_a"], S["y_a"] = 1 - np.exp(-S.mu_a), S.a > 0
    S["p_p"], S["y_p"] = 1 - np.exp(-S.mu_p), S.pts > 0
    S["p_s"], S["y_s"] = even_nb(S.mu_s.to_numpy(), S.al_s.to_numpy(), S.sog.to_numpy())
    S["p_h"], S["y_h"] = even_nb(S.mu_h.to_numpy(), S.al_h.to_numpy(), S.hits.to_numpy())
    S["p_b"], S["y_b"] = even_nb(S.mu_b.to_numpy(), S.al_b.to_numpy(), S.bks.to_numpy())
    return S


def goalies():
    G = pd.read_parquet(os.path.join(HERE, "nhl_saves.parquet"))
    G = G[G.start == 1].reset_index(drop=True)
    for f in ["sv_prior", "sv_l5", "sv_l10", "sa_prior", "sa_l10", "team_sa_prior", "team_sa_l10", "opp_sf_prior", "opp_sf_l10",
              "ga_prior", "ga_l10", "team_ga_prior", "opp_gf_prior"]:
        G["log_" + f] = np.log(G[f].clip(lower=0) + 0.1)
    des = lambda df, feats, ref: np.column_stack([np.ones(len(df))] + [(df[f].to_numpy(float) - ref[f][0]) / ref[f][1] for f in feats])
    fs = ["log_sv_prior", "log_sv_l5", "log_sv_l10", "log_sa_prior", "log_team_sa_prior", "log_opp_sf_prior", "is_home"]
    fg = ["log_ga_prior", "log_ga_l10", "log_team_ga_prior", "log_opp_gf_prior", "is_home"]
    G["mu_sv"], G["al_sv"] = walk_nb(G, fs, "sv", des)
    G["mu_ga"] = walk_mu(G, fg, "ga", des)
    G = G.dropna(subset=["mu_sv", "mu_ga"]).reset_index(drop=True)
    G["p_sv"], G["y_sv"] = even_nb(G.mu_sv.to_numpy(), G.al_sv.to_numpy(), G.sv.to_numpy())
    G["p_ga"] = np.clip(poisson.sf(2, G.mu_ga), 1e-4, 1 - 1e-4); G["y_ga"] = G.ga > 2.5
    G["gkey"] = G.date.astype(str) + "|" + ["|".join(sorted((a, b))) for a, b in zip(G.team, G.opp)]
    return G


def main():
    S = skaters(); G = goalies()
    print(f"skater-games {len(S)}, goalie starts {len(G)}")
    cal = {k: (S["p_" + k].mean(), S["y_" + k].mean()) for k in "gapshb"}
    print("margins (priced vs actual):", {k: (round(a, 3), round(b, 3)) for k, (a, b) in cal.items()},
          "saves", (round(G.p_sv.mean(), 3), round(G.y_sv.mean(), 3)), "GA o2.5", (round(G.p_ga.mean(), 3), round(G.y_ga.mean(), 3)))
    out = {}

    def rec(key, lab, a, b, ka, kb, grp):
        if len(a) > MAX_PAIRS:
            ix = RNG.choice(len(a), MAX_PAIRS, replace=False); a, b, grp = a.iloc[ix], b.iloc[ix], grp.iloc[ix]
        res = fit_rho(a["p_" + ka], b["p_" + kb], a["y_" + ka], b["y_" + kb], groups=grp)
        out[key] = {**res, "label": lab}
        ci = f"[{res['lo']:+.3f}, {res['hi']:+.3f}]" if res["lo"] is not None else ""
        print(f"{lab:48s} ρ {res['rho']:+.3f} {ci:18s} n {res['n']:7d}  lift {res['lift_at_avg']:.3f}", flush=True)

    # pairs within a game
    cols = ["gkey", "pid", "team", "role", "toi_prior"] + [f"{p}_{k}" for p in ("p", "y") for k in "gapshb"]
    X = S[cols]
    P = X.merge(X, on="gkey", suffixes=("_a", "_b")); P = P[P.pid_a != P.pid_b]
    tm = P[(P.team_a == P.team_b) & (P.pid_a < P.pid_b)]
    op = P[(P.team_a != P.team_b) & (P.pid_a < P.pid_b)]
    A = lambda d, s: d[[c for c in d.columns if c.endswith(s)]].rename(columns=lambda c: c[:-2])
    for key, lab, d, ka, kb in (
        ("g_g_team", "goal + goal · teammates", tm, "g", "g"),
        ("g_a_team", "goal + assist · teammates", tm, "g", "a"),
        ("a_a_team", "assist + assist · teammates", tm, "a", "a"),
        ("p_p_team", "point + point · teammates", tm, "p", "p"),
        ("s_s_team", "shots over + shots over · teammates", tm, "s", "s"),
        ("s_g_team", "shots over + a teammate's goal", tm, "s", "g"),
        ("h_h_team", "hits over + hits over · teammates", tm, "h", "h"),
        ("b_b_team", "blocks over + blocks over · teammates", tm, "b", "b"),
        ("g_g_opp", "goal + goal · opponents", op, "g", "g"),
        ("p_p_opp", "point + point · opponents", op, "p", "p"),
        ("s_s_opp", "shots over + shots over · opponents", op, "s", "s"),
        ("h_h_opp", "hits over + hits over · opponents", op, "h", "h"),
        ("b_s_opp", "blocks over + an opponent's shots over", op, "b", "s"),
        ("s_g_opp", "shots over + an opponent's goal", op, "s", "g"),
    ):
        rec(key, lab, A(d, "_a"), A(d, "_b"), ka, kb, d.gkey)
    # same player, two markets
    one = S
    for key, lab, ka, kb in (("s_g_same", "shots over + goal · same player", "s", "g"), ("s_a_same", "shots over + assist · same player", "s", "a"),
                             ("g_a_same", "goal + assist · same player", "g", "a"), ("h_b_same", "hits over + blocks over · same player", "h", "b"),
                             ("h_p_same", "hits over + point · same player", "h", "p")):
        rec(key, lab, one, one, ka, kb, one.gkey)
    # goalies vs skaters
    Gs = G[["gkey", "team", "p_sv", "y_sv", "p_ga", "y_ga"]]
    GS = Gs.merge(S[["gkey", "team"] + [f"{p}_{k}" for p in ("p", "y") for k in "gps"]], on="gkey", suffixes=("_gk", ""))
    vs = GS[GS.team_gk != GS.team]; own = GS[GS.team_gk == GS.team]
    for key, lab, d, ka, kb in (
        ("sv_s_opp", "goalie saves over + an opposing skater's shots over", vs, "sv", "s"),
        ("sv_g_opp", "goalie saves over + an opposing skater's goal", vs, "sv", "g"),
        ("ga_g_opp", "goalie GA over 2.5 + an opposing skater's goal", vs, "ga", "g"),
        ("ga_p_opp", "goalie GA over 2.5 + an opposing skater's point", vs, "ga", "p"),
        ("sv_g_own", "goalie saves over + his own skater's goal", own, "sv", "g"),
        ("ga_g_own", "goalie GA over 2.5 + his own skater's goal", own, "ga", "g"),
    ):
        rec(key, lab, d, d, ka, kb, d.gkey)
    GG = G.merge(G, on="gkey", suffixes=("_a", "_b")); GG = GG[GG.team_a < GG.team_b]
    rec("sv_sv", "saves over + saves over · the two goalies", A(GG, "_a"), A(GG, "_b"), "sv", "sv", GG.gkey)
    rec("ga_ga", "GA over + GA over · the two goalies", A(GG, "_a"), A(GG, "_b"), "ga", "ga", GG.gkey)
    json.dump(out, open(os.path.join(HERE, "sgp_nhl.json"), "w"), indent=1)
    print("wrote research/sgp_nhl.json")


if __name__ == "__main__":
    main()
