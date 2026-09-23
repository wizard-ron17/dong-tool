"""Do closing lines help? Goals allowed and saves, with and without the
implied goals from research/nhl_odds.py. Walk-forward, starts with a line only
(so the comparison is like for like).

    python3 research/nhl_saves_odds.py
"""
import sys
import numpy as np
import pandas as pd
sys.argv = sys.argv[:1]
import nhl_saves as S
from nhl_odds import attach
from nhl_sog import poisson_irls

D, _ = attach(S.D)
D = D[D.opp_imp.notna()].copy()
for c in ("opp_imp", "team_imp", "total_imp"):
    D["log_" + c] = np.log(D[c])
D["rel_opp_imp"] = np.log(D.opp_imp / D.groupby(["season", "date"]).opp_imp.transform("mean"))
SEASONS = sorted(D.season.unique())
print(f"{len(D):,} starts with a closing line · seasons {SEASONS}")


def ga_run(name, feats, shrink=True):
    import nhl_saves_cal as C
    res, tabs = [], []
    for s in SEASONS[1:]:
        tr, te = D[D.season < s], D[D.season == s]
        ref = {f: (tr[f].mean(), tr[f].std() or 1.0) for f in feats}
        b = poisson_irls(S.design(tr, feats, ref), tr.ga.to_numpy(float))
        mu_tr, mu = S.predict(tr, b, ref, feats), S.predict(te, b, ref, feats)
        if shrink and feats:
            # nested shrink needs >=2 training seasons; otherwise leave it raw
            k = C.nested_k(tr.assign(**{f: tr[f] for f in feats}), feats, "ga", 1.0) if tr.season.nunique() > 1 else 1.0
            m = tr.ga.mean(); mu, mu_tr = m + k * (mu - m), m + k * (mu_tr - m)
        else:
            k = 1.0
        d = S.ga_disp(tr.ga.to_numpy(float), mu_tr); y = te.ga.to_numpy(float)
        res.append((len(y), np.mean([S.ll(S.ga_sf(L, mu, d, "binom"), (y > L).astype(float)) for L in S.GA_LINES]), k))
        tabs.append(pd.DataFrame({"mu": mu, "y": y}))
    n = sum(r[0] for r in res); t = pd.concat(tabs)
    g = t.groupby(pd.qcut(t.mu.rank(method="first"), 5, labels=False)).agg(p=("mu", "mean"), a=("y", "mean"))
    print(f"  {name:40s} ll {sum(r[0]*r[1] for r in res)/n:.5f}  k {np.mean([r[2] for r in res]):.2f}  quintiles "
          + "  ".join(f"{a:.2f}->{b:.2f}" for a, b in zip(g.p, g.a)))


def sv_run(name, extra):
    feats = S.SV_REL + extra
    res, tabs = [], []
    for s in SEASONS[1:]:
        tr, te = D[D.season < s], D[D.season == s]
        keep = S.SV_REL
        S.SV_REL = feats
        try:
            m = S.sv_fit(tr)
        finally:
            S.SV_REL = keep
        mu = m["mu_of"](te); y = te.sv.to_numpy(float)
        res.append((len(y), np.mean([S.ll(S.sv_sf(L, mu, m), (y > L).astype(float)) for L in S.SV_LINES])))
        tabs.append(pd.DataFrame({"mu": mu, "y": y}))
    n = sum(r[0] for r in res)
    print(f"  {name:40s} ll {sum(r[0]*r[1] for r in res)/n:.5f}")


print("\nGOALS ALLOWED (binomial price)")
ga_run("league mean", [], shrink=False)
ga_run("shipped: team GA, opp GF, spot (shrunk)", S.GA_SHIPPED)
ga_run("opponent implied goals only", ["log_opp_imp"], shrink=False)
ga_run("opp implied + save %", ["log_opp_imp", "lgt_miss"], shrink=False)
ga_run("opp implied + save % + shipped", ["log_opp_imp", "lgt_miss"] + S.GA_SHIPPED, shrink=False)
ga_run("opp implied + save % + shipped (shrunk)", ["log_opp_imp", "lgt_miss"] + S.GA_SHIPPED)

print("\nSAVES (level x relative, pull mix)")
sv_run("shipped", [])
sv_run("+ opponent implied goals (relative)", ["rel_opp_imp"])
sv_run("+ game total", ["log_total_imp"])
