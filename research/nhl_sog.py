"""Shots on goal: Poisson mean, negative-binomial prices, walk-forward ladder.

Same shape as receptions.py, and for the same measured reason. Per player, SOG
runs variance/mean 1.13 against the 1.00 Poisson assumes, so the mean is fitted
with a Poisson GLM (consistent under over-dispersion) and the prices come off a
negative binomial fitted to the residual dispersion. Pooled var/mean looks much
higher (1.43) but that is between-player spread, not the dispersion a price
needs — alpha is measured against the FITTED mean.

Every feature Ron asked about is on the ladder rather than assumed in:
Individual Corsi (ICF), Individual Fenwick (IFF), power-play minutes, rolling
last-5/last-10, and opposing shots allowed.

    python3 research/nhl_sog.py
"""
import json, os, sys
import numpy as np
import pandas as pd

HERE = os.path.dirname(os.path.abspath(__file__))
D = pd.read_parquet(os.path.join(HERE, "nhl_sog.parquet"))
LINES = [1.5, 2.5, 3.5, 4.5, 5.5]


def design(df, feats, ref):
    X = [np.ones(len(df))]
    for f in feats:
        v = df[f].to_numpy(float)
        X.append((v - ref[f][0]) / ref[f][1])
    X.append((df.role.to_numpy() == "D").astype(float))
    return np.column_stack(X)


def poisson_irls(X, y, ridge=1.0, it=40):
    """log-link Poisson. Consistent for the MEAN even when the data are
    over-dispersed, which is why the mean and the spread are fitted apart."""
    b = np.zeros(X.shape[1])
    b[0] = np.log(max(y.mean(), 1e-6))
    for _ in range(it):
        eta = np.clip(X @ b, -6, 6)
        mu = np.exp(eta)
        W = mu
        z = eta + (y - mu) / np.maximum(mu, 1e-6)
        A = X.T @ (X * W[:, None]) + ridge * np.eye(X.shape[1])
        A[0, 0] -= ridge
        nb = np.linalg.solve(A, X.T @ (W * z))
        if np.max(np.abs(nb - b)) < 1e-9:
            b = nb
            break
        b = nb
    return b


def nb_dispersion(y, mu):
    """Method-of-moments alpha for NB2: Var = mu + alpha*mu^2."""
    r = (y - mu) ** 2 - mu
    d = np.maximum(mu ** 2, 1e-9)
    return max(float((r / d).mean()), 1e-4)


def nb_sf(line, mu, alpha):
    """P(SOG > line). Identical maths to scripts/receptions.js pOver()."""
    k = int(np.floor(line))
    r = 1.0 / alpha
    p = r / (r + mu)
    term = np.power(p, r)
    cdf = term.copy()
    for i in range(1, k + 1):
        term = term * ((r + i - 1) / i) * (1 - p)
        cdf = cdf + term
    return np.clip(1 - cdf, 1e-6, 1 - 1e-6)


def walk(feats, seasons):
    """Fit on all prior seasons, predict each season cold."""
    rows = []
    for s in seasons[1:]:
        tr, te = D[D.season < s], D[D.season == s]
        if len(tr) < 2000 or len(te) < 500:
            continue
        ref = {f: (tr[f].mean(), tr[f].std() or 1.0) for f in feats}
        b = poisson_irls(design(tr, feats, ref), tr.sog.to_numpy(float))
        mu_tr = np.exp(np.clip(design(tr, feats, ref) @ b, -6, 6))
        alpha = nb_dispersion(tr.sog.to_numpy(float), mu_tr)
        mu = np.exp(np.clip(design(te, feats, ref) @ b, -6, 6))
        y = te.sog.to_numpy(float)
        mae = float(np.abs(y - mu).mean())
        lls = []
        for L in LINES:
            p = nb_sf(L, mu, alpha)
            hit = (y > L).astype(float)
            lls.append(float(-(hit * np.log(p) + (1 - hit) * np.log(1 - p)).mean()))
        rows.append((s, len(te), mae, float(np.mean(lls)), alpha))
    if not rows:
        return None
    n = sum(r[1] for r in rows)
    return dict(n=n,
                mae=sum(r[2] * r[1] for r in rows) / n,
                ll=sum(r[3] * r[1] for r in rows) / n,
                alpha=float(np.mean([r[4] for r in rows])))


LADDER = [
    ("M0  league mean + position",        []),
    ("M1  + career SOG/game",             ["sog_prior"]),
    ("M2  + last-5 SOG",                  ["sog_prior", "sog_l5"]),
    ("M3  + last-10 SOG",                 ["sog_prior", "sog_l5", "sog_l10"]),
    ("M4  + ice time",                    ["sog_prior", "sog_l5", "sog_l10", "toi_l5", "toi_prior"]),
    ("M5  + power-play minutes",          ["sog_prior", "sog_l5", "sog_l10", "toi_l5", "toi_prior", "pptoi_l5"]),
    ("M6  + Individual Corsi (ICF)",      ["sog_prior", "sog_l5", "sog_l10", "toi_l5", "toi_prior", "pptoi_l5", "icf_prior"]),
    ("M7  + Individual Fenwick (IFF)",    ["sog_prior", "sog_l5", "sog_l10", "toi_l5", "toi_prior", "pptoi_l5", "icf_prior", "iff_prior"]),
    ("M8  + attempts-on-net rate",        ["sog_prior", "sog_l5", "sog_l10", "toi_l5", "toi_prior", "pptoi_l5", "icf_prior", "iff_prior", "conv_prior"]),
    ("M9  + opponent shots allowed",      ["sog_prior", "sog_l5", "sog_l10", "toi_l5", "toi_prior", "pptoi_l5", "icf_prior", "iff_prior", "conv_prior", "opp_sa_prior"]),
    ("M10 + own team shots-for, home",    ["sog_prior", "sog_l5", "sog_l10", "toi_l5", "toi_prior", "pptoi_l5", "icf_prior", "iff_prior", "conv_prior", "opp_sa_prior", "team_sf_prior", "is_home"]),
]

# What survived the ladder. Individual Corsi and Fenwick are deliberately NOT
# here: ICF correlates 0.927 with career SOG/game and IFF 0.978, both are worse
# than it as a lone predictor, and adding ICF back to this exact set makes it
# worse (-1.38% -> -1.30%). They are the same feature measured less well — the
# "a composite's signal concentrates in one base-rate feature" result again.
SHIPPED = ["sog_prior", "sog_l5", "sog_l10", "toi_prior", "toi_l5",
           "pptoi_l5", "opp_sa_prior", "team_sf_prior", "is_home"]


def export(path=None):
    """Fit on everything and write plain coefficients for the Node build."""
    feats = SHIPPED
    ref = {f: (float(D[f].mean()), float(D[f].std() or 1.0)) for f in feats}
    X = design(D, feats, ref)
    y = D.sog.to_numpy(float)
    b = poisson_irls(X, y)
    mu = np.exp(np.clip(X @ b, -6, 6))
    alpha = nb_dispersion(y, mu)
    names = ["intercept"] + feats + ["is_D"]
    model = {
        "note": ("Shots on goal. Poisson GLM for the mean (consistent under "
                 "over-dispersion) priced through a negative binomial: per "
                 "player SOG runs variance/mean 1.13 against the 1.00 a Poisson "
                 "assumes. Individual Corsi and Fenwick were tested and "
                 "dropped - r=0.93 and 0.98 with career SOG/game, and worse "
                 "alone. Same shape as the NFL receptions model. NOT "
                 "recalibrated: league SOG/game is falling season over season "
                 "(1.754 -> 1.552 across the training window) so the fit runs "
                 "about 2.4% high on the mean, but a live level correction "
                 "estimated from the first quarter of a season OVERSHOOTS and "
                 "flips the ladder bias from +0.2pp to -1.4pp at o2.5. "
                 "Uncorrected it is honest to within 1pp at every line."),
        "features": feats,
        "coef": {n: float(v) for n, v in zip(names, b)},
        "scale": {f: {"mean": ref[f][0], "sd": ref[f][1]} for f in feats},
        "alpha": float(alpha),
        "lines": LINES,
        "shrink_k": 8.0,
        "seasons": [int(s) for s in sorted(D.season.unique())],
        "rows": int(len(D)),
        "league": {"sog": float(D.sog.mean()),
                   "toi": float(D.toi_prior.mean()),
                   "pptoi": float(D.pptoi_l5.mean()),
                   "opp_sa": float(D.opp_sa_prior.mean()),
                   "team_sf": float(D.team_sf_prior.mean())},
    }
    path = path or os.path.join(HERE, "nhl_sog_model.json")
    with open(path, "w") as f:
        json.dump(model, f, indent=1)
    print(f"wrote {path}  alpha={alpha:.4f}  n={len(D):,}")
    return model


def calibration(feats=None):
    """Are the ladder prices honest? Predicted vs actual by decile, per line."""
    feats = feats or SHIPPED
    seasons = sorted(D.season.unique())
    print("")
    print(f"{'line':>6s} {'n':>7s} {'pred':>7s} {'actual':>7s} {'gap':>7s}")
    for s in seasons[1:]:
        tr, te = D[D.season < s], D[D.season == s]
        if len(tr) < 2000 or len(te) < 500:
            continue
        ref = {f: (tr[f].mean(), tr[f].std() or 1.0) for f in feats}
        b = poisson_irls(design(tr, feats, ref), tr.sog.to_numpy(float))
        mu_tr = np.exp(np.clip(design(tr, feats, ref) @ b, -6, 6))
        alpha = nb_dispersion(tr.sog.to_numpy(float), mu_tr)
        mu = np.exp(np.clip(design(te, feats, ref) @ b, -6, 6))
        y = te.sog.to_numpy(float)
        for L in LINES:
            p = nb_sf(L, mu, alpha)
            a = float((y > L).mean())
            print(f"o{L:<5} {len(te):7,} {p.mean():7.3f} {a:7.3f} {p.mean()-a:+7.3f}")
        break


if __name__ == "__main__" and "--backtest" not in sys.argv:
    seasons = sorted(D.season.unique())
    print(f"{len(D):,} skater-games, {D.pid.nunique()} skaters, seasons {seasons}")
    print(f"mean SOG {D.sog.mean():.3f}\n")
    print(f"{'model':34s} {'MAE':>7s} {'ladder log loss':>16s} {'vs M1':>8s} {'alpha':>7s}")
    base = None
    for name, feats in LADDER:
        r = walk(feats, seasons)
        if r is None:
            print(f"{name:34s}  (not enough seasons cached yet)")
            continue
        if name.startswith("M1 "):
            base = r["ll"]
        d = f"{(r['ll']/base-1)*100:+7.2f}%" if base else "      —"
        print(f"{name:34s} {r['mae']:7.3f} {r['ll']:16.5f} {d:>8s} {r['alpha']:7.3f}")
    # negative control: shuffling the target within season must kill it
    D2 = D.copy()
    D2["sog"] = D2.groupby("season")["sog"].transform(lambda s: s.sample(frac=1, random_state=0).to_numpy())
    globals()["D"] = D2
    r = walk(["sog_prior", "sog_l5", "toi_l5"], seasons)
    print(f"\nnegative control (target shuffled): log loss {r['ll']:.5f}  (must be ~M0)")
    globals()["D"] = D2 if False else pd.read_parquet(os.path.join(HERE, "nhl_sog.parquet"))
    calibration()
    export()


def backtest(path=None):
    """Walk-forward out-of-sample ledgers for the Results tab, patched into the
    exported model without refitting it. Every season is predicted by a model
    fit only on the seasons before it — the same walk() the ladder uses."""
    seasons = sorted(D.season.unique())
    MU, Y = [], []
    alphas = []
    for s in seasons[1:]:
        tr, te = D[D.season < s], D[D.season == s]
        ref = {f: (tr[f].mean(), tr[f].std() or 1.0) for f in SHIPPED}
        b = poisson_irls(design(tr, SHIPPED, ref), tr.sog.to_numpy(float))
        mu_tr = np.exp(np.clip(design(tr, SHIPPED, ref) @ b, -6, 6))
        alphas.append(nb_dispersion(tr.sog.to_numpy(float), mu_tr))
        MU.append(np.exp(np.clip(design(te, SHIPPED, ref) @ b, -6, 6))); Y.append(te.sog.to_numpy(float))
    mu, y = np.concatenate(MU), np.concatenate(Y)
    alpha = float(np.mean(alphas))
    P = {L: nb_sf(L, mu, alpha) for L in LINES}
    # every line, every skater-game
    by_line = [{"line": L, "n": int(len(y)), "pred": round(float(P[L].mean()), 4), "act": round(float((y > L).mean()), 4)} for L in LINES]
    # the line the board actually quotes: closest to even money
    Pm = np.column_stack([P[L] for L in LINES])
    k = np.argmin(np.abs(Pm - 0.5), axis=1)
    pq = Pm[np.arange(len(k)), k]; lq = np.array(LINES)[k]; hit = (y > lq)
    bins = [(0.0, 0.40), (0.40, 0.45), (0.45, 0.50), (0.50, 0.55), (0.55, 0.60), (0.60, 1.01)]
    by_price = []
    for lo, hi in bins:
        m = (pq >= lo) & (pq < hi)
        if m.sum() < 200: continue
        by_price.append({"lab": f"{int(lo*100)}–{int(min(hi,1)*100)}%" if hi <= 1 else f"{int(lo*100)}%+",
                         "n": int(m.sum()), "pred": round(float(pq[m].mean()), 4), "act": round(float(hit[m].mean()), 4)})
    by_proj = []
    for lo, hi in [(0, 1), (1, 2), (2, 3), (3, 4), (4, 99)]:
        m = (mu >= lo) & (mu < hi)
        if m.sum() < 200: continue
        by_proj.append({"lab": f"{lo}–{hi}" if hi < 99 else f"{lo}+", "n": int(m.sum()),
                        "proj": round(float(mu[m].mean()), 3), "act": round(float(y[m].mean()), 3)})
    path = path or os.path.join(HERE, "nhl_sog_model.json")
    M = json.load(open(path))
    M["backtest"] = {"seasons": [int(s) for s in seasons[1:]], "rows": int(len(y)),
                     "mae": round(float(np.abs(y - mu).mean()), 3),
                     "by_line": by_line, "by_price": by_price, "by_proj": by_proj}
    json.dump(M, open(path, "w"), indent=1)
    print(f"backtest patched into {path}: {len(y):,} OOS skater-games")
    for r in by_line: print(f"  o{r['line']}  pred {r['pred']:.3f}  act {r['act']:.3f}")
    for r in by_price: print(f"  quoted {r['lab']:>8s}  n {r['n']:>6,}  pred {r['pred']:.3f}  act {r['act']:.3f}")
    for r in by_proj: print(f"  proj {r['lab']:>4s}  n {r['n']:>6,}  proj {r['proj']:.2f}  got {r['act']:.2f}")


if __name__ == "__main__" and "--backtest" in sys.argv:
    backtest()
