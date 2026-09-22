"""Anytime goal scorer: Poisson on goals, P(ATG) = 1 - exp(-mu), walk-forward.

Goals per skater-game run variance/mean 1.004 — Poisson, not negative binomial
(the SOG model needs NB at 1.13; goals do not). So the mean is a Poisson GLM
and the anytime price is simply 1 - exp(-mu), which is also what makes a
goals-by-situation split additive: mu_EV + mu_PP = mu.

Scored as a BINARY market — log loss, Brier, AUC — because that is what an
anytime price is judged on. The NFL TD board is the template: it is a logistic
on "scored", and this is the Poisson equivalent (1 - exp(-mu) with log link is
the complementary log-log, which suits rare counts better than a logit).

Also tested, from the Reddit write-up Ron found: separate even-strength and
power-play models summed, and isotonic post-calibration.

    python3 research/nhl_goals.py
"""
import json, os, sys
import numpy as np
import pandas as pd

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from nhl_sog import poisson_irls  # same IRLS, same ridge

D = pd.read_parquet(os.path.join(HERE, "nhl_sog.parquet"))
D["scored"] = (D.goals > 0).astype(float)


def design(df, feats, ref):
    X = [np.ones(len(df))]
    for f in feats:
        X.append((df[f].to_numpy(float) - ref[f][0]) / ref[f][1])
    X.append((df.role.to_numpy() == "D").astype(float))
    return np.column_stack(X)


def fit_mu(tr, te, feats, target="goals"):
    ref = {f: (tr[f].mean(), tr[f].std() or 1.0) for f in feats}
    b = poisson_irls(design(tr, feats, ref), tr[target].to_numpy(float))
    return np.exp(np.clip(design(te, feats, ref) @ b, -8, 3)), b, ref


def metrics(p, y):
    p = np.clip(p, 1e-6, 1 - 1e-6)
    ll = float(-(y * np.log(p) + (1 - y) * np.log(1 - p)).mean())
    brier = float(((p - y) ** 2).mean())
    order = np.argsort(p)
    r = np.empty(len(p)); r[order] = np.arange(1, len(p) + 1)
    n1 = y.sum(); n0 = len(y) - n1
    auc = float((r[y == 1].sum() - n1 * (n1 + 1) / 2) / (n1 * n0))
    bins = np.quantile(p, np.linspace(0, 1, 11)); idx = np.clip(np.searchsorted(bins, p, side="right") - 1, 0, 9)
    ece = float(sum(abs(p[idx == k].mean() - y[idx == k].mean()) * (idx == k).mean() for k in range(10) if (idx == k).any()))
    top = float(y[idx == 9].mean())
    return dict(ll=ll, brier=brier, auc=auc, ece=ece, top=top)


def walk(feats, split=False, iso=False):
    seasons = sorted(D.season.unique())
    P, Y = [], []
    prev_oos = []                          # (p, y) of earlier OOS seasons, for isotonic
    for s in seasons[1:]:
        tr, te = D[D.season < s], D[D.season == s]
        if split:
            mu_ev, *_ = fit_mu(tr, te, feats, "evg")
            mu_pp, *_ = fit_mu(tr, te, feats, "ppg")
            mu_ot = te.goals_prior.to_numpy() * 0 + (tr.goals - tr.evg - tr.ppg).mean()  # SH/EN residual
            mu = mu_ev + mu_pp + mu_ot
        else:
            mu, *_ = fit_mu(tr, te, feats)
        p = 1 - np.exp(-mu)
        y = te.scored.to_numpy()
        if iso and prev_oos:
            pp_, yy_ = np.concatenate([a for a, _ in prev_oos]), np.concatenate([b for _, b in prev_oos])
            p_cal = isotonic_apply(pp_, yy_, p)
            prev_oos.append((p, y)); p = p_cal
        else:
            prev_oos.append((p, y))
        P.append(p); Y.append(y)
    return metrics(np.concatenate(P), np.concatenate(Y))


def isotonic_fit(p, y, nb=40):
    """Pool-adjacent-violators on quantile bins; returns (x, fitted) knots."""
    o = np.argsort(p); p, y = p[o], y[o]
    edges = np.array_split(np.arange(len(p)), nb)
    xs = [p[e].mean() for e in edges]; ys = [y[e].mean() for e in edges]; ws = [len(e) for e in edges]
    i = 0
    while i < len(ys) - 1:
        if ys[i] > ys[i + 1]:
            w = ws[i] + ws[i + 1]
            ys[i] = (ys[i] * ws[i] + ys[i + 1] * ws[i + 1]) / w
            xs[i] = (xs[i] * ws[i] + xs[i + 1] * ws[i + 1]) / w
            ws[i] = w; del ys[i + 1], xs[i + 1], ws[i + 1]
            i = max(i - 1, 0)
        else:
            i += 1
    return np.array(xs), np.array(ys)


def isotonic_apply(p_tr, y_tr, p):
    x, f = isotonic_fit(p_tr, y_tr)
    return np.clip(np.interp(p, x, f), 1e-4, 1 - 1e-4)


BASE = []
LADDER = [
    ("M0  position only",                  []),
    ("M1  + career goals/game",            ["goals_prior"]),
    ("M2  + career shots/game",            ["goals_prior", "sog_prior"]),
    ("M3  + shooting %",                   ["goals_prior", "sog_prior", "shpct_prior"]),
    ("M4  + ice time",                     ["goals_prior", "sog_prior", "shpct_prior", "toi_prior", "toi_l5"]),
    ("M5  + power-play minutes",           ["goals_prior", "sog_prior", "shpct_prior", "toi_prior", "toi_l5", "pptoi_l5"]),
    ("M6  + recent shots (last 10)",       ["goals_prior", "sog_prior", "shpct_prior", "toi_prior", "toi_l5", "pptoi_l5", "sog_l10"]),
    ("M7  + recent goals (last 10)",       ["goals_prior", "sog_prior", "shpct_prior", "toi_prior", "toi_l5", "pptoi_l5", "sog_l10", "goals_l10"]),
    ("M8  + opp goals allowed",            ["goals_prior", "sog_prior", "shpct_prior", "toi_prior", "toi_l5", "pptoi_l5", "sog_l10", "opp_ga_prior"]),
    ("M9  + opp shots allowed",            ["goals_prior", "sog_prior", "shpct_prior", "toi_prior", "toi_l5", "pptoi_l5", "sog_l10", "opp_ga_prior", "opp_sa_prior"]),
    ("M10 + opp penalty kill",             ["goals_prior", "sog_prior", "shpct_prior", "toi_prior", "toi_l5", "pptoi_l5", "sog_l10", "opp_ga_prior", "opp_sa_prior", "opp_pk_prior"]),
    ("M11 + team goals-for, home",         ["goals_prior", "sog_prior", "shpct_prior", "toi_prior", "toi_l5", "pptoi_l5", "sog_l10", "opp_ga_prior", "opp_sa_prior", "opp_pk_prior", "team_gf_prior", "is_home"]),
]

# The ladder ends with a negative control that SHUFFLES D in place, so the
# export must never share a run with it.
if __name__ == "__main__" and "--export" not in sys.argv:
    print(f"{len(D):,} skater-games · ATG base {D.scored.mean():.4f}\n")
    print(f"{'model':36s} {'logloss':>8s} {'Brier':>7s} {'AUC':>6s} {'ECE':>6s} {'top10%':>7s}")
    res = {}
    for name, f in LADDER:
        m = walk(f); res[name] = (f, m)
        print(f"{name:36s} {m['ll']:8.5f} {m['brier']:7.5f} {m['auc']:6.4f} {m['ece']:6.4f} {m['top']:7.3f}")
    best_name = min(res, key=lambda k: res[k][1]["ll"]); best = res[best_name][0]
    print(f"\nbest: {best_name}")
    for lab, kw in (("  EV + PP models summed (Reddit)", dict(split=True)),
                    ("  + isotonic calibration", dict(iso=True))):
        m = walk(best, **kw)
        print(f"{lab:36s} {m['ll']:8.5f} {m['brier']:7.5f} {m['auc']:6.4f} {m['ece']:6.4f} {m['top']:7.3f}")
    D2 = D.copy(); D2["goals"] = D2.groupby("season")["goals"].transform(lambda s: s.sample(frac=1, random_state=0).to_numpy())
    D2["scored"] = (D2.goals > 0).astype(float); globals()["D"] = D2
    m = walk(best)
    print(f"{'  negative control (shuffled)':36s} {m['ll']:8.5f} {m['brier']:7.5f} {m['auc']:6.4f}")


# What survived. goals_l10, opp_sa_prior and opp_pk_prior are out: each moved
# log loss by <0.00002. The EV/PP split is out too — summing two Poisson fits
# was worse than one (0.39152 vs 0.39096) and doubled calibration error; the
# power-play channel is already carried by pptoi_l5 inside the single model.
SHIPPED = ["goals_prior", "sog_prior", "shpct_prior", "toi_prior", "toi_l5",
           "pptoi_l5", "sog_l10", "opp_ga_prior", "team_gf_prior", "is_home"]


def export(path=None):
    """Fit on everything; isotonic knots fitted on walk-forward OOS predictions."""
    seasons = sorted(D.season.unique())
    P, Y = [], []
    for s in seasons[1:]:
        tr, te = D[D.season < s], D[D.season == s]
        mu, *_ = fit_mu(tr, te, SHIPPED)
        P.append(1 - np.exp(-mu)); Y.append(te.scored.to_numpy())
    kx, ky = isotonic_fit(np.concatenate(P), np.concatenate(Y))
    # Max-price cuts, measured: the hit rate each cut ACTUALLY produced out of
    # sample, and how many skaters a night clear it. Same idea as the NFL
    # board's cut chips — tightening the board is a measured trade.
    pc = np.interp(np.concatenate(P), kx, ky); yy = np.concatenate(Y)
    oos = D[D.season > sorted(D.season.unique())[0]]
    nights = oos.groupby(["season", "date"]).ngroups
    cuts = []
    for odds in (200, 250, 300, 400, 500):
        thr = 100 / (odds + 100)
        m = pc >= thr
        cuts.append({"v": odds, "p": round(thr, 4), "hit": round(float(yy[m].mean() * 100), 1) if m.any() else None,
                     "per": round(float(m.sum() / nights), 1)})
    ref = {f: (float(D[f].mean()), float(D[f].std() or 1.0)) for f in SHIPPED}
    b = poisson_irls(design(D, SHIPPED, ref), D.goals.to_numpy(float))
    names = ["intercept"] + SHIPPED + ["is_D"]
    model = {
        "note": ("Anytime goal scorer. Poisson GLM on goals per skater-game "
                 "(variance/mean 1.004 - Poisson, not NB) with P(1+ goal) = "
                 "1 - exp(-mu), then isotonic calibration fitted on walk-forward "
                 "out-of-sample predictions. A separate even-strength / power-play "
                 "split was tested and is worse than one model."),
        "features": SHIPPED,
        "coef": {n: float(v) for n, v in zip(names, b)},
        "scale": {f: {"mean": ref[f][0], "sd": ref[f][1]} for f in SHIPPED},
        "iso": {"x": [float(v) for v in kx], "y": [float(v) for v in ky]},
        "shrink": {"goals": 16.0, "shpct_shots": 120.0},
        "seasons": [int(s) for s in seasons], "rows": int(len(D)),
        "base": float(D.scored.mean()),
        "cuts": cuts,
        # Shrinkage targets by role, as the dataset builder uses them: career
        # rates are pulled toward the forward or defence mean, not the league's.
        "role": {r: {"goals": float(D[D.role == r].goals.mean()), "sog": float(D[D.role == r].sog.mean()),
                     "toi": float(D[D.role == r].toi.mean())} for r in ("F", "D")},
        "league": {"goals": float(D.goals.mean()), "shpct": float(D.goals.sum() / D.sog.sum()),
                   "opp_ga": float(D.opp_ga_prior.mean()), "team_gf": float(D.team_gf_prior.mean())},
    }
    path = path or os.path.join(HERE, "nhl_goals_model.json")
    json.dump(model, open(path, "w"), indent=1)
    print(f"wrote {path}  knots={len(kx)}")


def deciles():
    seasons = sorted(D.season.unique()); P, Y = [], []; prev = []
    for s in seasons[1:]:
        tr, te = D[D.season < s], D[D.season == s]
        mu, *_ = fit_mu(tr, te, SHIPPED); p = 1 - np.exp(-mu); y = te.scored.to_numpy()
        pc = isotonic_apply(np.concatenate([a for a, _ in prev]), np.concatenate([b for _, b in prev]), p) if prev else p
        prev.append((p, y)); P.append(pc); Y.append(y)
    p, y = np.concatenate(P), np.concatenate(Y)
    q = np.quantile(p, np.linspace(0, 1, 11))
    print(f"\n{'decile':>6s} {'pred':>7s} {'actual':>7s}")
    for k in range(10):
        m = (p >= q[k]) & (p <= q[k + 1] if k == 9 else p < q[k + 1])
        print(f"{k+1:6d} {p[m].mean():7.3f} {y[m].mean():7.3f}")
    print(f"Brier {((p-y)**2).mean():.5f}  vs base-rate Brier {D.scored.mean()*(1-D.scored.mean()):.5f}")


if __name__ == "__main__" and "--export" in sys.argv:
    m = walk(SHIPPED); print("shipped set:", {k: round(v, 5) for k, v in m.items()})
    m = walk(SHIPPED, iso=True); print("  + isotonic:", {k: round(v, 5) for k, v in m.items()})
    deciles(); export()
