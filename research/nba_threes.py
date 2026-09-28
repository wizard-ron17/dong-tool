"""Made threes: the NBA's dong. Ladder 1+ .. 5+ (research).

    python3 research/nba_threes.py

Built on nba_minutes.py's walk-forward minutes projection (nba_minutes.parquet).
nba_dispersion.py: given minutes, 3PM is ~Poisson (1.06), and given attempts
it is pure binomial luck — so:

  mu = projected minutes x his 3PM per minute, times the game
     his rate    3PM per minute, this season to date plus last season, shrunk
                 toward his position family's rate (k = 300 minutes)
     the game    his team's implied points (total and spread) vs league, the
                 opponent's threes allowed per game so far vs league, home
  Poisson GLM on log mu with log(projected minutes) as the offset, fit on
  earlier seasons and scored on the next.
  ladder: P(3PM >= k) averaged over his minutes, N(projected, 5.2) — the
  minutes model's residual spread — which is where the NB shape comes from.

Baselines: his own hit rate for each rung over his last 20 games (shrunk),
and the same mu with no minutes spread (plain Poisson).
"""
import os
import numpy as np
import pandas as pd
from scipy.stats import poisson, nbinom

HERE = os.path.dirname(os.path.abspath(__file__))
RUNGS = [1, 2, 3, 4, 5]
SD_MIN = 5.2


def glm_poisson(X, y, off, iters=30):
    b = np.zeros(X.shape[1]); b[0] = np.log(max(y.mean(), 1e-3)) - off.mean()
    for _ in range(iters):
        mu = np.exp(np.clip(X @ b + off, -20, 5)); W = mu
        b += np.linalg.solve(X.T @ (X * W[:, None]) + 1e-6 * np.eye(len(b)), X.T @ (y - mu))
    return b


def ll(p, y): p = np.clip(p, 1e-6, 1 - 1e-6); return float(-(y * np.log(p) + (1 - y) * np.log(1 - p)).mean())


def ladder(mu, mproj, sd=SD_MIN, nodes=9, alpha=0.0):
    """P(X >= k) for each rung, mixing over m ~ N(mproj, sd), m >= 1. alpha > 0 puts a
    gamma layer on the rate (NB, variance lam + alpha lam^2): the nights he just shoots more."""
    x, w = np.polynomial.hermite_e.hermegauss(nodes); w = w / w.sum()
    out = np.zeros((len(mu), len(RUNGS)))
    for xi, wi in zip(x, w):
        m = np.clip(mproj + sd * xi, 1, 48)
        lam = mu * m / np.clip(mproj, 1, None)
        if alpha > 0:
            r = 1 / alpha; pr = r / (r + lam)
            out += wi * np.column_stack([nbinom.sf(k - 1, r, pr) for k in RUNGS])
        else:
            out += wi * np.column_stack([poisson.sf(k - 1, lam) for k in RUNGS])
    return out


def main():
    D = pd.read_parquet(os.path.join(HERE, "nba_minutes.parquet"))
    D = D.sort_values(["pid", "date", "gid"]).reset_index(drop=True)
    for c in ("tpm", "tpa", "min"): D[c] = D[c].astype(float).fillna(0)
    D["fam"] = D.fam.fillna("?")
    # his 3PM per minute: season to date (strictly before) + last season, shrunk to his position family
    g = D.groupby(["pid", "season"])
    D["s_tpm"] = g.tpm.cumsum() - D.tpm; D["s_min"] = g["min"].cumsum() - D["min"]
    tot = D.groupby(["pid", "season"])[["tpm", "min"]].sum().reset_index()
    seasons = sorted(D.season.unique()); nxt = {s: seasons[i + 1] for i, s in enumerate(seasons[:-1])}
    tot["season"] = tot.season.map(nxt); tot = tot.dropna().rename(columns={"tpm": "p_tpm", "min": "p_min"})
    D = D.merge(tot, on=["pid", "season"], how="left").fillna({"p_tpm": 0, "p_min": 0})
    # league constants from LAST season (the first season uses its own): no look-ahead, and all
    # the live build can know — research/nba_parity.mjs checks it
    fr = D.groupby(["season", "fam"]).apply(lambda d: d.tpm.sum() / d["min"].sum(), include_groups=False).rename("fam_rate").reset_index()
    fr_prev = fr.assign(season=fr.season.map(nxt)).dropna()
    fr = pd.concat([fr_prev, fr[fr.season == min(fr.season)]]).drop_duplicates(["season", "fam"])
    D = D.merge(fr, on=["season", "fam"], how="left")
    K = 300
    D["rate"] = (D.s_tpm + 0.5 * D.p_tpm + K * D.fam_rate) / (D.s_min + 0.5 * D.p_min + K)
    # the game: his team's implied points, the opponent's threes allowed so far
    D["implied"] = D.total / 2 - D.spread / 2
    imp_s = D.groupby("season").implied.mean(); imp_prev = imp_s.shift(1).fillna(imp_s)
    lg_imp = D.season.map(imp_prev)
    D["imp_r"] = (D.implied / lg_imp).fillna(1.0)
    tg = D.groupby(["gid", "team", "opp", "date", "season"]).tpm.sum().reset_index().sort_values("date")
    tg["allowed_sofar"] = tg.groupby(["season", "opp"]).tpm.transform(lambda s: s.shift(1).expanding().mean())
    al_s = tg.groupby("season").tpm.mean(); al_prev = al_s.shift(1).fillna(al_s)
    lg_allow = tg.season.map(al_prev)
    tg["opp_r"] = ((tg.allowed_sofar * tg.groupby(["season", "opp"]).cumcount() + 10 * lg_allow) / (tg.groupby(["season", "opp"]).cumcount() + 10)) / lg_allow
    D = D.merge(tg[["gid", "team", "opp_r"]], on=["gid", "team"], how="left"); D["opp_r"] = D.opp_r.fillna(1.0)
    D = D[D.mproj.notna() & (D.mproj > 3)].copy()
    # his own recent hit rates, the baseline a bettor eyeballs
    D = D.sort_values(["pid", "date", "gid"])
    for k in RUNGS:
        hit = (D.tpm >= k).astype(float)
        D[f"l20_{k}"] = hit.groupby(D.pid).transform(lambda s: s.shift(1).rolling(20, min_periods=1).mean())
        base = hit.groupby(D.season).transform("mean")
        n = D.groupby("pid").cumcount().clip(upper=20)
        D[f"l20_{k}"] = (D[f"l20_{k}"].fillna(0) * n + 5 * base) / (n + 5)
    cols = ["lrate", "limp", "lopp", "home"]
    D["lrate"] = np.log(D.rate.clip(1e-4)); D["limp"] = np.log(D.imp_r.clip(0.5, 1.5)); D["lopp"] = np.log(D.opp_r.clip(0.5, 1.5))
    D["home"] = D.home.astype(float); D["off"] = np.log(D.mproj.clip(1))
    out = []
    ss = sorted(D.season.unique())
    for s in ss[1:]:
        tr, te = D[D.season < s], D[D.season == s].copy()
        X = np.column_stack([np.ones(len(tr))] + [tr[c] for c in cols]); b = glm_poisson(X, tr.tpm.values, tr.off.values)
        Xe = np.column_stack([np.ones(len(te))] + [te[c] for c in cols]); te["mu"] = np.exp(Xe @ b + te.off.values)
        L = ladder(te.mu.values, te.mproj.values); P0 = np.column_stack([poisson.sf(k - 1, te.mu.values) for k in RUNGS])
        # the gamma layer's size, chosen on the training seasons' own in-sample fit
        tr_mu = np.exp(X @ b + tr.off.values); ytr = np.column_stack([(tr.tpm >= k) for k in RUNGS]).astype(float)
        best = min((sum(ll(Lt[:, i], ytr[:, i]) for i in range(len(RUNGS))), a)
                   for a in (0.0, 0.05, 0.1, 0.15, 0.2, 0.3) for Lt in [ladder(tr_mu, tr.mproj.values, alpha=a)])[1]
        LN = ladder(te.mu.values, te.mproj.values, alpha=best)
        for i, k in enumerate(RUNGS): te[f"p_{k}"] = L[:, i]; te[f"q_{k}"] = P0[:, i]; te[f"n_{k}"] = LN[:, i]
        te["alpha"] = best
        out.append(te); coef = b
    R = pd.concat(out)
    print(f"{len(R):,} player-games priced walk-forward ({ss[1]}..{ss[-1]}) · mean 3PM {R.tpm.mean():.2f}, projected {R.mu.mean():.2f}")
    print(f"last fit: const {coef[0]:+.3f}, his rate {coef[1]:+.3f}, team implied {coef[2]:+.3f}, opp 3s allowed {coef[3]:+.3f}, home {coef[4]:+.3f}\n")
    print(f"gamma layer chosen per season: {R.groupby('season').alpha.first().to_dict()}\n")
    print(f"{'rung':6s} {'base':>6s}  {'last-20 rate':>12s} {'Poisson':>9s} {'min-mixed':>10s} {'+ NB':>8s}   calibration, + NB (priced → actual, by quintile)")
    for k in RUNGS:
        y = (R.tpm >= k).astype(float).values
        q = pd.qcut(R[f"n_{k}"], 5, labels=False, duplicates="drop")
        cal = "  ".join(f"{R[f'n_{k}'][q == j].mean():.3f}→{y[q == j].mean():.3f}" for j in sorted(q.unique()))
        print(f"{k}+     {y.mean():6.3f}  {ll(R[f'l20_{k}'].values, y):12.5f} {ll(R[f'q_{k}'].values, y):9.5f} {ll(R[f'p_{k}'].values, y):10.5f} {ll(R[f'n_{k}'].values, y):8.5f}   {cal}")
    R[["gid", "pid", "name", "date", "season", "tpm", "mu", "mproj"] + [f"n_{k}" for k in RUNGS]].to_parquet(os.path.join(HERE, "nba_threes_oos.parquet"))


if __name__ == "__main__":
    main()
