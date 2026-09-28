"""Double-doubles and triple-doubles (research).

    python3 research/nba_ddtd.py

A double-double is two of {points, rebounds, assists, steals, blocks} at 10+;
a triple-double three. Nearly every one is built from points, rebounds and
assists, so those three are modelled (steals and blocks at 10+ are left out:
a rounding error).

  1. each stat's mean: projected minutes x his per-minute rate, times the game
     (implied points, the opponent's allowance of that stat, home) — the
     nba_points.py machinery, a Poisson GLM with log(projected minutes) as the
     offset, fit on earlier seasons and scored on the next, plus an NB layer
  2. do they move together beyond minutes? the residual correlation of each
     pair given the minutes he actually played. If ~0, then GIVEN MINUTES the
     three are independent and P(two or more at 10+) is exact:
        p1 p2 + p1 p3 + p2 p3 - 2 p1 p2 p3
     averaged over his minutes, N(projected, 5.2) — minutes carry the
     correlation between them, as they should
  3. walk-forward calibration and log loss vs his own shrunk hit rate
"""
import os
import numpy as np
import pandas as pd
from scipy.stats import nbinom

HERE = os.path.dirname(os.path.abspath(__file__))
SD_MIN = 5.2
NODES = np.polynomial.hermite_e.hermegauss(9)
STATS = ["pts", "reb", "ast"]


def glm_poisson(X, y, off, iters=30):
    b = np.zeros(X.shape[1]); b[0] = np.log(max(y.mean(), 1e-3)) - off.mean()
    for _ in range(iters):
        mu = np.exp(np.clip(X @ b + off, -20, 6))
        b += np.linalg.solve(X.T @ (X * mu[:, None]) + 1e-6 * np.eye(len(b)), X.T @ (y - mu))
    return b


def ll(p, y): p = np.clip(p, 1e-6, 1 - 1e-6); return float(-(y * np.log(p) + (1 - y) * np.log(1 - p)).mean())


def price(mus, mproj, alphas, v):
    """P(double-double), P(triple-double): independent NB per stat given minutes AND a shared
    night factor g ~ Gamma(mean 1, variance v) on all three — pace, overtime, the hot night —
    which is the small correlation left after minutes (+0.07). Averaged over both."""
    from scipy.stats import gamma
    x, w = NODES; w = w / w.sum()
    if v > 0:
        qs = (np.arange(7) + 0.5) / 7; gs = gamma.ppf(qs, 1 / v, scale=v); gw = np.full(7, 1 / 7)
    else:
        gs, gw = np.array([1.0]), np.array([1.0])
    pdd = np.zeros(len(mproj)); ptd = np.zeros(len(mproj))
    for xi, wi in zip(x, w):
        scale = np.clip(mproj + SD_MIN * xi, 1, 48) / np.clip(mproj, 1, None)
        for gi, gwi in zip(gs, gw):
            p = []
            for st in STATS:
                lam = mus[st] * scale * gi; r = 1 / max(alphas[st], 1e-4)
                p.append(nbinom.sf(9, r, r / (r + lam)))
            p1, p2, p3 = p
            pdd += wi * gwi * (p1 * p2 + p1 * p3 + p2 * p3 - 2 * p1 * p2 * p3); ptd += wi * gwi * (p1 * p2 * p3)
    return pdd, ptd


def prep(D, stat):
    g = D.groupby(["pid", "season"])
    D[f"s_{stat}"] = g[stat].cumsum() - D[stat]
    tot = D.groupby(["pid", "season"])[[stat, "min"]].sum().reset_index()
    seasons = sorted(D.season.unique()); nxt = {s: seasons[i + 1] for i, s in enumerate(seasons[:-1])}
    tot["season"] = tot.season.map(nxt); tot = tot.dropna().rename(columns={stat: f"p_{stat}", "min": f"pm_{stat}"})
    D = D.merge(tot, on=["pid", "season"], how="left").fillna({f"p_{stat}": 0, f"pm_{stat}": 0})
    fr = D.groupby(["season", "fam"]).apply(lambda d: d[stat].sum() / d["min"].sum(), include_groups=False).rename(f"fr_{stat}")
    D = D.merge(fr.reset_index(), on=["season", "fam"], how="left")
    D[f"rate_{stat}"] = (D[f"s_{stat}"] + 0.7 * D[f"p_{stat}"] + 150 * D[f"fr_{stat}"]) / (D.s_min + 0.7 * D[f"pm_{stat}"] + 150)
    tg = D.groupby(["gid", "team", "opp", "date", "season"])[stat].sum().reset_index().sort_values("date")
    n = tg.groupby(["season", "opp"]).cumcount()
    tg["allowed"] = tg.groupby(["season", "opp"])[stat].transform(lambda s: s.shift(1).expanding().mean())
    lg = tg.groupby("season")[stat].transform("mean")
    tg[f"opp_{stat}"] = ((tg.allowed.fillna(lg) * n + 10 * lg) / (n + 10)) / lg
    return D.merge(tg[["gid", "team", f"opp_{stat}"]], on=["gid", "team"], how="left")


def main():
    D = pd.read_parquet(os.path.join(HERE, "nba_minutes.parquet"))
    D = D.sort_values(["pid", "date", "gid"]).reset_index(drop=True)
    for c in STATS + ["min", "stl", "blk"]: D[c] = D[c].astype(float).fillna(0)
    D["fam"] = D.fam.fillna("?")
    D["s_min"] = D.groupby(["pid", "season"])["min"].cumsum() - D["min"]
    for st in STATS: D = prep(D, st)
    D["implied"] = D.total / 2 - D.spread / 2
    D["limp"] = np.log((D.implied / D.groupby("season").implied.transform("mean")).fillna(1.0).clip(0.6, 1.4))
    D["home"] = D.home.astype(float)

    # 2. do they move together beyond minutes? residuals given actual minutes (per-minute rate x minutes)
    A = D[D["min"] >= 10]
    rz = {}
    for st in STATS:
        mu = A[f"rate_{st}"] * A["min"]; rz[st] = (A[st] - mu) / np.sqrt(mu.clip(0.3))
    print("residual correlation given minutes played (beyond minutes, do they move together?):")
    for a, b in (("pts", "reb"), ("pts", "ast"), ("reb", "ast")):
        print(f"  {a}-{b}: {np.corrcoef(rz[a], rz[b])[0, 1]:+.3f}")
    print(f"  raw correlation (minutes included): pts-reb {np.corrcoef(A.pts, A.reb)[0, 1]:+.3f}, pts-ast {np.corrcoef(A.pts, A.ast)[0, 1]:+.3f}, reb-ast {np.corrcoef(A.reb, A.ast)[0, 1]:+.3f}\n")

    D = D[D.mproj.notna() & (D.mproj > 3)].copy()
    D["off"] = np.log(D.mproj.clip(1))
    cats = D[["pts", "reb", "ast", "stl", "blk"]] >= 10
    D["dd"] = (cats.sum(axis=1) >= 2).astype(float); D["td"] = (cats.sum(axis=1) >= 3).astype(float)
    D = D.sort_values(["pid", "date", "gid"])
    for c in ("dd", "td"):
        base = D.groupby("season")[c].transform("mean"); nn = D.groupby("pid").cumcount().clip(upper=40)
        l = D.groupby("pid")[c].transform(lambda s: s.shift(1).rolling(40, min_periods=1).mean()).fillna(0)
        D[f"l40_{c}"] = (l * nn + 10 * base) / (nn + 10)
    out = []; ss = sorted(D.season.unique()); alphas = {}
    for s in ss[1:]:
        tr, te = D[D.season < s], D[D.season == s].copy()
        mus = {}
        for st in STATS:
            cols = [np.log(tr[f"rate_{st}"].clip(1e-3)), tr.limp, np.log(tr[f"opp_{st}"].fillna(1).clip(0.7, 1.3)), tr.home]
            X = np.column_stack([np.ones(len(tr))] + cols); b = glm_poisson(X, tr[st].values, tr.off.values)
            ce = [np.log(te[f"rate_{st}"].clip(1e-3)), te.limp, np.log(te[f"opp_{st}"].fillna(1).clip(0.7, 1.3)), te.home]
            mus[st] = np.exp(np.column_stack([np.ones(len(te))] + ce) @ b + te.off.values)
            trmus = locals().setdefault("trmus", {}); trmus[st] = np.exp(X @ b + tr.off.values)
            te[f"mu_{st}"] = mus[st]
            # the NB layer for this stat, chosen by what predicts HIS 10+ line on the training
            # seasons (moments overstate points' spread: they come in 2s and 3s, which is noise
            # at the 10 line, not signal) — minutes-mixed, as priced
            mtr = np.exp(X @ b + tr.off.values)
            smp = np.random.default_rng(1).choice(len(tr), min(25000, len(tr)), replace=False)
            y10 = (tr[st].values[smp] >= 10).astype(float)
            def p10(a, mu=mtr[smp], mp=tr.mproj.values[smp]):
                out = np.zeros(len(mu)); xx, ww = NODES; ww = ww / ww.sum()
                for xi, wi in zip(xx, ww):
                    lam = mu * np.clip(mp + SD_MIN * xi, 1, 48) / np.clip(mp, 1, None); r = 1 / a
                    out += wi * nbinom.sf(9, r, r / (r + lam))
                return out
            alphas[st] = min((ll(p10(a), y10), a) for a in (0.001, 0.02, 0.05, 0.1, 0.15, 0.2, 0.3))[1]
        # the shared night factor's size, chosen on the training seasons
        smp = np.random.default_rng(2).choice(len(tr), min(30000, len(tr)), replace=False)
        sub = {k: v[smp] for k, v in trmus.items()}
        def score(v):
            a, b2 = price(sub, tr.mproj.values[smp], alphas, v)
            return ll(a, tr.dd.values[smp]) + ll(b2, tr.td.values[smp])
        v = min((score(v), v) for v in (0.0, 0.01, 0.02, 0.04, 0.06, 0.09))[1]
        te["p_dd"], te["p_td"] = price(mus, te.mproj.values, alphas, v)
        te["p_dd0"], te["p_td0"] = price(mus, te.mproj.values, alphas, 0.0)
        te["v"] = v
        out.append(te)
    R = pd.concat(out)
    print(f"{len(R):,} player-games walk-forward ({ss[1]}..{ss[-1]}) · NB layers (last fit) {({k: round(v, 3) for k, v in alphas.items()})} · shared night variance per season {R.groupby('season').v.first().to_dict()}\n")
    for c, lab in (("dd", "double-double"), ("td", "triple-double")):
        y = R[c].values
        print(f"{lab}: base {y.mean():.4f} · log loss  his last-40 {ll(R[f'l40_{c}'], y):.5f}   independent {ll(R[f'p_{c}0'], y):.5f}   + shared night {ll(R[f'p_{c}'], y):.5f}")
        q = pd.qcut(R[f"p_{c}"].rank(method="first"), 8, labels=False)
        print("  priced → actual by octile: " + "  ".join(f"{R[f'p_{c}'][q == j].mean():.4f}→{y[q == j].mean():.4f}" for j in range(8)))
        top = R.nlargest(2000, f"p_{c}"); print(f"  top 2,000 priced: {top[f'p_{c}'].mean():.3f} priced, {top[c].mean():.3f} hit\n")
    R[["gid", "pid", "name", "date", "season", "dd", "td", "p_dd", "p_td", "mproj", "mu_pts", "mu_reb", "mu_ast"]].to_parquet(os.path.join(HERE, "nba_ddtd_oos.parquet"))


if __name__ == "__main__":
    main()
