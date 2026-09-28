"""Points ladder: 10+ .. 35+ (research).

    python3 research/nba_points.py

Points come in 1s, 2s and 3s, so even given minutes they swing ~2.3x a
Poisson (nba_dispersion.py). Mean first, then two shapes, tested walk-forward:

  mu = projected minutes (nba_minutes.py) x his points per minute, times:
     his rate    points per minute, season to date + half of last season,
                 shrunk to his position family (k = 300 minutes)
     usage       minutes newly vacated by teammates (they don't just free
                 minutes — the rest of the lineup shoots more per minute)
     the game    his team's implied points vs league, the opponent's points
                 allowed so far vs league, home
  quasi-Poisson GLM on log mu, log(projected minutes) as the offset.

  shape A  negative binomial on points, dispersion fit on the training seasons
  shape B  normal with variance phi x mu (phi fit on training), continuity-
           corrected — both averaged over minutes, N(projected, 5.2)

Baseline: his own last-20 hit rate at each threshold (shrunk).
"""
import os
import numpy as np
import pandas as pd
from scipy.stats import nbinom, norm

HERE = os.path.dirname(os.path.abspath(__file__))
RUNGS = [10, 15, 20, 25, 30, 35]
SD_MIN = 5.2
NODES = np.polynomial.hermite_e.hermegauss(9)


def glm_poisson(X, y, off, iters=30):
    b = np.zeros(X.shape[1]); b[0] = np.log(max(y.mean(), 1e-3)) - off.mean()
    for _ in range(iters):
        mu = np.exp(np.clip(X @ b + off, -20, 6)); W = mu
        b += np.linalg.solve(X.T @ (X * W[:, None]) + 1e-6 * np.eye(len(b)), X.T @ (y - mu))
    return b


def ll(p, y): p = np.clip(p, 1e-6, 1 - 1e-6); return float(-(y * np.log(p) + (1 - y) * np.log(1 - p)).mean())


def ladder_pow(mu, a, pw):
    """Shape C: NB whose TOTAL variance is a x mu^pw (minutes uncertainty included) — fit on
    the training seasons. Real points variance grows slower than an NB's mu^2: stars are
    steadier than a fixed-alpha NB says, bench bats wilder."""
    var = a * np.power(np.clip(mu, 0.3, None), pw)
    alpha = np.clip((var - mu) / np.clip(mu, 0.3, None) ** 2, 1e-3, None); r = 1 / alpha
    return np.column_stack([nbinom.sf(k - 1, r, r / (r + mu)) for k in RUNGS])


def ladder(mu, mproj, shape, par):
    x, w = NODES; w = w / w.sum()
    out = np.zeros((len(mu), len(RUNGS)))
    for xi, wi in zip(x, w):
        lam = mu * np.clip(mproj + SD_MIN * xi, 1, 48) / np.clip(mproj, 1, None)
        if shape == "nb":
            r = 1 / par; pr = r / (r + lam)
            out += wi * np.column_stack([nbinom.sf(k - 1, r, pr) for k in RUNGS])
        else:
            sd = np.sqrt(par * lam)
            out += wi * np.column_stack([norm.sf((k - 0.5 - lam) / sd) for k in RUNGS])
    return out


def main():
    D = pd.read_parquet(os.path.join(HERE, "nba_minutes.parquet"))
    D = D.sort_values(["pid", "date", "gid"]).reset_index(drop=True)
    for c in ("pts", "min"): D[c] = D[c].astype(float).fillna(0)
    D["fam"] = D.fam.fillna("?")
    g = D.groupby(["pid", "season"])
    D["s_pts"] = g.pts.cumsum() - D.pts; D["s_min"] = g["min"].cumsum() - D["min"]
    tot = D.groupby(["pid", "season"])[["pts", "min"]].sum().reset_index()
    seasons = sorted(D.season.unique()); nxt = {s: seasons[i + 1] for i, s in enumerate(seasons[:-1])}
    tot["season"] = tot.season.map(nxt); tot = tot.dropna().rename(columns={"pts": "p_pts", "min": "p_min"})
    D = D.merge(tot, on=["pid", "season"], how="left").fillna({"p_pts": 0, "p_min": 0})
    fr = D.groupby(["season", "fam"]).apply(lambda d: d.pts.sum() / d["min"].sum(), include_groups=False).rename("fam_rate")
    D = D.merge(fr.reset_index(), on=["season", "fam"], how="left")
    K = 300
    D["rate"] = (D.s_pts + 0.5 * D.p_pts + K * D.fam_rate) / (D.s_min + 0.5 * D.p_min + K)
    # recent form: his points per minute over his last 10 games, shrunk to his longer rate (k = 120 min)
    rp = D.groupby("pid").pts.transform(lambda s: s.shift(1).rolling(10, min_periods=1).sum()).fillna(0)
    rm = D.groupby("pid")["min"].transform(lambda s: s.shift(1).rolling(10, min_periods=1).sum()).fillna(0)
    D["rate10"] = (rp + 120 * D.rate) / (rm + 120)
    D["implied"] = D.total / 2 - D.spread / 2
    D["imp_r"] = (D.implied / D.groupby("season").implied.transform("mean")).fillna(1.0)
    tg = D.groupby(["gid", "team", "opp", "date", "season"]).pts.sum().reset_index().sort_values("date")
    n = tg.groupby(["season", "opp"]).cumcount()
    tg["allowed"] = tg.groupby(["season", "opp"]).pts.transform(lambda s: s.shift(1).expanding().mean())
    lg = tg.groupby("season").pts.transform("mean")
    tg["opp_r"] = ((tg.allowed.fillna(lg) * n + 10 * lg) / (n + 10)) / lg
    D = D.merge(tg[["gid", "team", "opp_r"]], on=["gid", "team"], how="left"); D["opp_r"] = D.opp_r.fillna(1.0)
    D = D[D.mproj.notna() & (D.mproj > 3)].copy()
    D = D.sort_values(["pid", "date", "gid"])
    for k in RUNGS:
        hit = (D.pts >= k).astype(float); base = hit.groupby(D.season).transform("mean")
        l20 = hit.groupby(D.pid).transform(lambda s: s.shift(1).rolling(20, min_periods=1).mean()).fillna(0)
        nn = D.groupby("pid").cumcount().clip(upper=20)
        D[f"l20_{k}"] = (l20 * nn + 5 * base) / (nn + 5)
    D["lrate"] = np.log(D.rate.clip(1e-3)); D["limp"] = np.log(D.imp_r.clip(0.6, 1.4)); D["lopp"] = np.log(D.opp_r.clip(0.7, 1.3))
    D["lvac"] = np.log1p(D.vacated / 48); D["home"] = D.home.astype(float); D["off"] = np.log(D.mproj.clip(1))
    D["lr10"] = np.log(D.rate10.clip(1e-3)) - D.lrate                         # recent vs longer rate
    variants = {"no usage": ["lrate", "limp", "lopp", "home"], "with usage": ["lrate", "lr10", "lvac", "limp", "lopp", "home"]}
    out = []; ss = sorted(D.season.unique())
    for s in ss[1:]:
        tr, te = D[D.season < s], D[D.season == s].copy()
        for name, cols in variants.items():
            X = np.column_stack([np.ones(len(tr))] + [tr[c] for c in cols]); b = glm_poisson(X, tr.pts.values, tr.off.values)
            Xe = np.column_stack([np.ones(len(te))] + [te[c] for c in cols]); te[f"mu_{name}"] = np.exp(Xe @ b + te.off.values)
            if name == "with usage": coef = dict(zip(["const"] + cols, b)); trmu = np.exp(X @ b + tr.off.values)
        # shapes, dispersion chosen on the training seasons (a 20k sample keeps the grid quick)
        smp = np.random.default_rng(0).choice(len(tr), min(20000, len(tr)), replace=False)
        ytr = np.column_stack([(tr.pts.values[smp] >= k) for k in RUNGS]).astype(float)
        score = lambda L: sum(ll(L[:, i], ytr[:, i]) for i in range(len(RUNGS)))
        a_nb = min((score(ladder(trmu[smp], tr.mproj.values[smp], "nb", a)), a) for a in (0.02, 0.04, 0.06, 0.08, 0.1, 0.15))[1]
        phi = min((score(ladder(trmu[smp], tr.mproj.values[smp], "norm", f)), f) for f in (2.8, 3.2, 3.6, 4.0, 4.5, 5.0, 5.5))[1]
        LN = ladder(te["mu_with usage"].values, te.mproj.values, "nb", a_nb)
        LZ = ladder(te["mu_with usage"].values, te.mproj.values, "norm", phi)
        L0 = ladder(te["mu_no usage"].values, te.mproj.values, "norm", phi)
        # shape C: log(squared residual) ~ log(mu) on the training rows gives the power and scale
        res2 = (tr.pts.values - trmu) ** 2
        bins = pd.qcut(trmu, 20, labels=False, duplicates="drop")
        bv = pd.DataFrame({"m": trmu, "v": res2, "b": bins}).groupby("b").mean()
        pw, la = np.polyfit(np.log(bv.m), np.log(bv.v), 1); a_pw = float(np.exp(la))
        LP = ladder_pow(te["mu_with usage"].values, a_pw, pw)
        # mean recalibration: actual ~ c x mu^d on the training rows (the GLM pulls the middle
        # of the board low and both ends high), then shape D — normal, power variance, less skew
        d_, lc = np.polyfit(np.log(bv.m), np.log(pd.DataFrame({"m": trmu, "y": tr.pts.values, "b": bins}).groupby("b").y.mean()), 1)
        mu_c = np.exp(lc) * np.power(te["mu_with usage"].values.clip(0.3), d_)
        sd = np.sqrt(a_pw * np.power(mu_c.clip(0.3), pw))
        LD = np.column_stack([norm.sf((k - 0.5 - mu_c) / sd) for k in RUNGS])
        LPc = ladder_pow(mu_c, a_pw, pw)
        for i, k in enumerate(RUNGS): te[f"pd_{k}"] = LD[:, i]; te[f"pc_{k}"] = LPc[:, i]
        te["mu_c"], te["d_"] = mu_c, d_
        for i, k in enumerate(RUNGS): te[f"nb_{k}"] = LN[:, i]; te[f"z_{k}"] = LZ[:, i]; te[f"z0_{k}"] = L0[:, i]; te[f"pw_{k}"] = LP[:, i]
        te["pw"], te["a_pw"] = pw, a_pw
        te["a_nb"], te["phi"] = a_nb, phi
        out.append(te)
    R = pd.concat(out)
    print(f"{len(R):,} player-games walk-forward ({ss[1]}..{ss[-1]}) · mean pts {R.pts.mean():.2f}, projected {R['mu_with usage'].mean():.2f}")
    print("last fit: " + ", ".join(f"{k} {v:+.3f}" for k, v in coef.items()))
    print(f"shape fits per season: NB alpha {R.groupby('season').a_nb.first().to_dict()} · normal phi {R.groupby('season').phi.first().to_dict()}\n")
    print(f"shape C per season: variance = a x mu^p  " + ", ".join(f"{s}: {a:.2f} x mu^{p:.2f}" for s, a, p in R.groupby('season')[['a_pw', 'pw']].first().itertuples()))
    print(f"mean recalibration exponent per season: {R.groupby('season').d_.first().round(3).to_dict()}")
    print(f"{'rung':5s} {'base':>6s} {'last-20':>9s} {'NB':>9s} {'normal':>9s} {'C: NB pow':>10s} {'C + mean':>9s} {'D: norm pow':>12s}   calibration, D (priced → actual by quintile)")
    for k in RUNGS:
        y = (R.pts >= k).astype(float).values
        q = pd.qcut(R[f"pd_{k}"], 5, labels=False, duplicates="drop")
        cal = "  ".join(f"{R[f'pd_{k}'][q == j].mean():.3f}→{y[q == j].mean():.3f}" for j in sorted(q.unique()))
        print(f"{k}+   {y.mean():6.3f} {ll(R[f'l20_{k}'].values, y):9.5f} {ll(R[f'nb_{k}'].values, y):9.5f} {ll(R[f'z_{k}'].values, y):9.5f} {ll(R[f'pw_{k}'].values, y):10.5f} {ll(R[f'pc_{k}'].values, y):9.5f} {ll(R[f'pd_{k}'].values, y):12.5f}   {cal}")
    R[["gid", "pid", "name", "date", "season", "pts", "mu_with usage", "mproj"] + [f"z_{k}" for k in RUNGS] + [f"nb_{k}" for k in RUNGS] + [f"pw_{k}" for k in RUNGS] + [f"pc_{k}" for k in RUNGS] + [f"pd_{k}" for k in RUNGS]].to_parquet(os.path.join(HERE, "nba_points_oos.parquet"))


if __name__ == "__main__":
    main()
