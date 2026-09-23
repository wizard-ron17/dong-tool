"""Calibration fixes for the saves / goals-allowed means (the by-projection
tables in nhl_saves.py showed both ends of both boards running long).

Candidates, all walk-forward (fit < season, test = season):
  raw        the ladder's shipped GLM
  ridge      a much heavier ridge on the same features
  lean       fewer, steadier features
  shrink     raw, then pulled toward the training mean by a factor k fitted
             on NESTED out-of-sample predictions from the training seasons only
"""
import numpy as np, pandas as pd
import nhl_saves as S
from nhl_sog import poisson_irls, nb_dispersion, nb_sf

D = S.D

def fitpred(tr, te, feats, target, ridge=1.0):
    ref = {f: (tr[f].mean(), tr[f].std() or 1.0) for f in feats}
    b = poisson_irls(S.design(tr, feats, ref), tr[target].to_numpy(float), ridge=ridge)
    return S.predict(tr, b, ref, feats), S.predict(te, b, ref, feats)

def nested_k(tr, feats, target, ridge):
    """Slope of actual on predicted, from OOS predictions INSIDE the training seasons."""
    ss = sorted(tr.season.unique()); P, Y = [], []
    for s in ss[1:]:
        a, b = tr[tr.season < s], tr[tr.season == s]
        _, mu = fitpred(a, b, feats, target, ridge)
        P.append(mu); Y.append(b[target].to_numpy(float))
    if not P: return 1.0
    P, Y = np.concatenate(P), np.concatenate(Y)
    m = P.mean()
    return float(np.clip(((P - m) * (Y - m)).sum() / ((P - m) ** 2).sum(), 0.2, 1.2))

def run(name, feats, target, ridge=1.0, shrink=False):
    res, tabs = [], []
    for s in S.SEASONS[1:]:
        tr, te = D[D.season < s], D[D.season == s]
        mu_tr, mu = fitpred(tr, te, feats, target, ridge)
        k = nested_k(tr, feats, target, ridge) if shrink else 1.0
        m = tr[target].mean()
        mu = m + k * (mu - m); mu_tr = m + k * (mu_tr - m)
        y, y_tr = te[target].to_numpy(float), tr[target].to_numpy(float)
        if target == "sv":
            a = nb_dispersion(y_tr, mu_tr)
            l = np.mean([S.ll(nb_sf(L, mu, a), (y > L).astype(float)) for L in S.SV_LINES])
        else:
            d = S.ga_disp(y_tr, mu_tr)
            l = np.mean([S.ll(S.ga_sf(L, mu, d, "binom"), (y > L).astype(float)) for L in S.GA_LINES])
        res.append((len(te), l, k)); tabs.append(pd.DataFrame({"mu": mu, "y": y}))
    n = sum(r[0] for r in res); L = sum(r[0] * r[1] for r in res) / n
    t = pd.concat(tabs)
    q = pd.qcut(t.mu.rank(method='first'), 5, labels=False)
    g = t.groupby(q).agg(proj=("mu", "mean"), act=("y", "mean"))
    worst = float(((g.act / g.proj - 1).abs() * 100).max())
    print(f"  {name:28s} ll {L:.5f}  k {np.mean([r[2] for r in res]):.2f}  worst quintile off {worst:.1f}%  "
          f"top {g.proj.iloc[-1]:.2f}->{g.act.iloc[-1]:.2f}  bottom {g.proj.iloc[0]:.2f}->{g.act.iloc[0]:.2f}")

if __name__ == '__main__':
    SV = S.SV_SHIPPED
    SV_LEAN = ["log_sv_prior", "log_team_sa_prior", "log_opp_sf_prior", "log_opp_sf_l10", "is_home", "team_b2b", "opp_b2b"]
    print("SAVES")
    run("raw (S6)", SV, "sv")
    run("ridge 200", SV, "sv", ridge=200)
    run("lean", SV_LEAN, "sv")
    run("raw + nested shrink", SV, "sv", shrink=True)
    run("lean + nested shrink", SV_LEAN, "sv", shrink=True)
    GA = S.GA_SHIPPED
    GA_LEAN = ["log_team_ga_prior", "log_opp_gf_prior", "is_home", "team_b2b", "opp_b2b"]
    print("GOALS ALLOWED")
    run("raw (G6)", GA, "ga")
    run("lean (team GA, opp GF, spot)", GA_LEAN, "ga")
    run("raw + nested shrink", GA, "ga", shrink=True)
    run("lean + nested shrink", GA_LEAN, "ga", shrink=True)
    run("league mean only", [], "ga")
