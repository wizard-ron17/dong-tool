"""Receptions model: negative binomial, and an honest look at defense/weather.

Poisson is the wrong distribution here. Reception counts are over-dispersed —
variance/mean runs 1.11 to 1.29 for real receivers against the 1.0 Poisson
assumes — so a Poisson understates the spread and over-prices the over, and the
error grows with the line (+3.2pp at o2.5, +9.1pp at o6.5). The mean is fitted
with a Poisson GLM, which stays consistent under over-dispersion, and the
prices come off a negative binomial fitted to the residual dispersion.

The TD model found defense, weather and matchup to be nulls. That result does
NOT transfer: touchdowns are a scoring-share market and receptions are a VOLUME
market, and volume has mechanisms scoring does not — wind suppresses passing,
and a trailing team throws more. Each is tested here rather than assumed.

    python3 research/receptions.py
"""
import json, os
import numpy as np
import pandas as pd

HERE = os.path.dirname(__file__)
D = pd.read_parquet(os.path.join(HERE, "receptions.parquet"))
POS = ["WR", "RB", "TE", "FB"]
# tgt_prior is deliberately absent: receptions are ~65% of targets, so the pair
# is collinear and the fit gives tgt_prior a negative coefficient while chasing
# a meaningless difference. Catch rate carries that information cleanly.
BASE = ["rec_l3", "rec_prior", "share_l3", "tgt_share_prior", "snap_l3",
        "catch_prior", "team_pass_prior", "implied_total", "wind_excess"]

# WIND is in, and it is the one environment feature that survived — but not for
# the reason a coefficient test would give. Linearly, and averaged over every
# game, wind is worth -0.0001 of log loss, which is nothing. It looks like a
# null because it is nonlinear and rare: 89% of games never reach 15 mph.
#
# Where it bites it bites hard. Out of sample, in games at 20+ mph the model
# WITHOUT wind over-prices receptions by 18.0%, and at 15-20 mph by 7.9%,
# against 2.3% in calm outdoor games. The measured gradient is monotone through
# two separate channels — teams throw less (37.0 attempts at 0-5 mph, 34.2 at
# 20+) and completion rate falls (0.663 to 0.630).
#
# So it ships because it removes a large localised bias, not because it moves an
# average. Statistically significant and worth modelling are different tests and
# this feature only passes the second one on the games that matter.
WIND_THRESHOLD = 15.0

# Defense, temperature, indoor/outdoor and game script were all tested here
# against this market specifically rather than inherited from the TD model's
# nulls, since receptions are a volume market and touchdowns are a share market.
# All four are nulls anyway: opponent receptions-allowed to the position
# -0.00027, temperature -0.00026, indoor -0.00046, signed spread +0.00050.


def design(df, feats, ref):
    X = [np.ones(len(df))]
    for f in feats:
        v = df[f].to_numpy(float)
        X.append((v - ref[f][0]) / ref[f][1])
    for p in POS[1:]:
        X.append((df.position.to_numpy() == p).astype(float))
    return np.column_stack(X)


def poisson_irls(X, y, ridge=1.0, it=40):
    """log-link Poisson. Consistent for the MEAN even when the data are
    over-dispersed, which is the whole reason it is used here."""
    b = np.zeros(X.shape[1]); b[0] = np.log(max(y.mean(), 1e-3))
    for _ in range(it):
        mu = np.exp(np.clip(X @ b, -8, 4))
        W = np.clip(mu, 1e-6, None)
        R = np.eye(X.shape[1]) * ridge; R[0, 0] = 0
        try:
            b += np.linalg.solve(X.T @ (X * W[:, None]) + R, X.T @ (y - mu) - R @ b)
        except np.linalg.LinAlgError:
            break
    return b


def nb_dispersion(y, mu):
    """Method-of-moments alpha for NB2: Var = mu + alpha*mu^2."""
    num = ((y - mu) ** 2 - mu).sum()
    den = (mu ** 2).sum()
    return max(float(num / den), 1e-4)


def nb_sf(line, mu, alpha):
    """P(count > line) under NB2, summing the pmf up to floor(line)."""
    k = int(np.floor(line))
    r = 1.0 / alpha
    p = r / (r + mu)
    term = p ** r                      # pmf at 0
    cdf = term.copy()
    for i in range(1, k + 1):
        term = term * (r + i - 1) / i * (1 - p)
        cdf = cdf + term
    return np.clip(1 - cdf, 1e-6, 1 - 1e-6)


def evaluate(df, feats, first=2019, lines=(2.5, 3.5, 4.5, 5.5, 6.5)):
    out = []
    for s in sorted(df.season.unique()):
        if s < first: continue
        tr = df[df.season < s]; te = df[df.season == s]
        if len(tr) < 5000 or len(te) < 500: continue
        ref = {f: (tr[f].to_numpy(float).mean(), tr[f].to_numpy(float).std() + 1e-9) for f in feats}
        b = poisson_irls(design(tr, feats, ref), tr.rec.to_numpy(float))
        mu_tr = np.exp(np.clip(design(tr, feats, ref) @ b, -8, 4))
        alpha = nb_dispersion(tr.rec.to_numpy(float), mu_tr)
        mu = np.exp(np.clip(design(te, feats, ref) @ b, -8, 4))
        y = te.rec.to_numpy(float)
        mae = np.abs(y - mu).mean()
        # log loss over the standard lines, restricted to players near each line
        lls, ns = [], 0
        for L in lines:
            m = (mu > L - 1.5) & (mu < L + 1.5)
            if m.sum() < 100: continue
            p = nb_sf(L, mu[m], alpha)
            o = (y[m] > L).astype(float)
            lls.append(-np.mean(o * np.log(p) + (1 - o) * np.log(1 - p)) * m.sum())
            ns += m.sum()
        out.append((len(te), mae, sum(lls) / max(ns, 1), alpha))
    w = np.array([o[0] for o in out], float); w /= w.sum()
    return (sum(wi * o[1] for wi, o in zip(w, out)),
            sum(wi * o[2] for wi, o in zip(w, out)),
            float(np.mean([o[3] for o in out])))


def main():
    d = D.copy()
    # opponent defense: receptions allowed to this position per game, prior only
    g = d.groupby(["game_id", "defteam", "position"], as_index=False).rec.sum()
    g = g.sort_values("game_id")
    g["def_prior"] = (g.groupby(["defteam", "position"]).rec.cumsum() - g.rec) / \
                      g.groupby(["defteam", "position"]).cumcount().replace(0, np.nan)
    d = d.merge(g[["game_id", "defteam", "position", "def_prior"]],
                on=["game_id", "defteam", "position"], how="left")
    d["def_prior"] = d.def_prior.fillna(d.def_prior.mean())
    d["wind"] = d.wind.fillna(0.0)
    d["wind_excess"] = np.where(d.indoor == 1, 0.0,
                                np.maximum(d.wind - WIND_THRESHOLD, 0.0))
    # air yards are NaN for a player with no targets in a game — that is a real
    # zero-information row, not a zero-depth route, so the prior falls back to
    # the position mean rather than poisoning the column with NaN
    d["air_prior"] = d.air_prior.fillna(d.groupby("position").air_prior.transform("mean"))
    d["air_prior"] = d.air_prior.fillna(d.air_prior.mean())
    d["temp"] = d.temp.fillna(60.0)
    d["abs_spread"] = d.spread_own.abs()
    d = d[d.games_prior >= 3].copy()

    print(f"evaluating on {len(d):,} player-games with 3+ prior games\n")
    print("  %-40s %-8s %-10s %s" % ("feature set", "MAE", "log loss", "alpha"))
    # naive baseline: his own prior receptions, nothing else
    nv = []
    for s_ in sorted(d.season.unique()):
        if s_ < 2019: continue
        te = d[d.season == s_]
        if len(te) < 500: continue
        nv.append((len(te), np.abs(te.rec.to_numpy(float) - te.rec_prior.to_numpy(float)).mean()))
    wn = np.array([x[0] for x in nv], float); wn /= wn.sum()
    print("  %-40s %-8.4f %-10s %s" % ("naive: his own prior receptions",
          sum(w_ * x[1] for w_, x in zip(wn, nv)), "-", "-"))
    base = evaluate(d, BASE)
    print("  %-40s %-8.4f %-10.5f %.3f" % ("BASE (usage + team volume + total)", *base))
    print()
    print("  the three the TD model wrote off, tested again for THIS market:")
    for lab, extra in (("+ opponent defense (rec allowed to pos)", ["def_prior"]),
                       ("+ wind", ["wind"]),
                       ("+ temp", ["temp"]),
                       ("+ indoor", ["indoor"]),
                       ("+ game script (signed spread)", ["spread_own"]),
                       ("+ game script (|spread|)", ["abs_spread"]),
                       ("+ air yards (route depth)", ["air_prior"]),
                       ("+ ALL of the above", ["def_prior","wind","spread_own","air_prior"])):
        r = evaluate(d, BASE + extra)
        d_ll = r[1] - base[1]
        mark = "  <-- REAL" if d_ll < -0.0008 else ""
        print("  %-40s %-8.4f %-10.5f %+.5f%s" % (lab, r[0], r[1], d_ll, mark))


if __name__ == "__main__":
    main()


def oos_mu_pairs():
    """Walk-forward (raw mu, actual receptions) pairs for the calibration fit."""
    d = D.copy()
    d["wind"] = d.wind.fillna(0.0)
    d["wind_excess"] = np.where(d.indoor == 1, 0.0,
                                np.maximum(d.wind - WIND_THRESHOLD, 0.0))
    d = d[d.games_prior >= 3].dropna(subset=BASE).copy()
    mus, acts = [], []
    for s in sorted(d.season.unique()):
        if s < 2019: continue
        tr = d[d.season < s]; te = d[d.season == s]
        if len(tr) < 5000 or len(te) < 500: continue
        ref = {f: (tr[f].to_numpy(float).mean(), tr[f].to_numpy(float).std() + 1e-9) for f in BASE}
        b = poisson_irls(design(tr, BASE, ref), tr.rec.to_numpy(float))
        mus.append(np.exp(np.clip(design(te, BASE, ref) @ b, -8, 4)))
        acts.append(te.rec.to_numpy(float))
    return np.concatenate(mus), np.concatenate(acts)


def export():
    """Fit on everything and write research/receptions_model.json for the build."""
    d = D.copy()
    d["wind"] = d.wind.fillna(0.0)
    d["wind_excess"] = np.where(d.indoor == 1, 0.0,
                                np.maximum(d.wind - WIND_THRESHOLD, 0.0))
    d = d[d.games_prior >= 3].dropna(subset=BASE).copy()
    ref = {f: (float(d[f].to_numpy(float).mean()), float(d[f].to_numpy(float).std() + 1e-9))
           for f in BASE}
    X = design(d, BASE, ref)
    y = d.rec.to_numpy(float)
    b = poisson_irls(X, y)
    mu = np.exp(np.clip(X @ b, -8, 4))
    # Monotone recalibration of the projection, the same cure the TD model
    # applies to its logistic: a log link extrapolates exponentially where the
    # empirical relationship flattens, so the top of the board over-projects
    # (walk-forward: rows projected 5.95 actually caught 5.25, and week-1
    # boards quoted a 9.4-catch projection that no receiver has ever averaged).
    # Fitted on out-of-sample walk-forward pairs with the same equal-count-bin
    # isotonic used by calibrate.py.
    from calibrate import fit_map
    om, oa = oos_mu_pairs()
    order = np.argsort(om)
    om, oa = om[order], oa[order]
    edges = np.linspace(0, len(om), 41).astype(int)
    bx = [om[a2:b2].mean() for a2, b2 in zip(edges[:-1], edges[1:]) if b2 > a2]
    by = [oa[a2:b2].mean() for a2, b2 in zip(edges[:-1], edges[1:]) if b2 > a2]
    by = np.maximum.accumulate(by).tolist()          # enforce monotone
    mu_cal = np.interp(mu, bx, by)
    alpha = nb_dispersion(y, mu_cal)
    names = ["intercept"] + BASE + ["pos_" + p for p in POS[1:]]
    out = {
        "note": ("Receptions. Poisson GLM for the mean (consistent under "
                 "over-dispersion) priced through a negative binomial, because "
                 "reception counts run variance/mean 1.1-1.3 and a Poisson "
                 "over-prices the over by up to 9pp at o6.5. wind_excess is "
                 "max(wind - 15, 0) and 0 indoors."),
        "features": BASE,
        "reference_position": POS[0],
        "coef": {n: float(v) for n, v in zip(names, b)},
        "scale": {f: {"mean": ref[f][0], "sd": ref[f][1]} for f in BASE},
        "alpha": float(alpha),
        "mu_cal": {"x": [round(float(v), 4) for v in bx],
                   "y": [round(float(v), 4) for v in by]},
        "wind_threshold": WIND_THRESHOLD,
        "shrink_k": 3.0,
        "lines": [1.5, 2.5, 3.5, 4.5, 5.5, 6.5, 7.5],
        "trained_on": "2016-2025",
        "n_rows": int(len(d)),
        "mean_rec": float(y.mean()),
        "position_priors": {
            c: {p: float(d[d.position == p][c].mean()) for p in POS}
            for c in ["rec_prior", "tgt_share_prior", "snap_prior", "catch_prior",
                      "rec_l3", "share_l3", "snap_l3", "team_pass_prior"]
        },
    }
    path = os.path.join(HERE, "receptions_model.json")
    with open(path, "w") as fh:
        json.dump(out, fh, indent=1)
    print(f"\nwrote {path}: alpha {alpha:.4f}, {len(d):,} rows")
    for n, v in zip(names, b):
        print(f"    {n:<20} {v:+.5f}")
