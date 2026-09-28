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


def nb_sf9(lam, spec):
    """P(stat >= 10) given lam. spec = alpha (fixed NB) or (a, p): variance a x lam^p given minutes."""
    if isinstance(spec, tuple):
        a, pw = spec; var = a * np.power(np.clip(lam, 0.05, None), pw)
        alpha = np.clip((var - lam) / np.clip(lam, 0.05, None) ** 2, 1e-3, None)
    else:
        alpha = max(spec, 1e-4)
    r = 1 / alpha
    return nbinom.sf(9, r, r / (r + lam))


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
                p.append(nb_sf9(mus[st] * scale * gi, alphas[st]))
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
    # recent form: his last 10 games' rate, shrunk to the longer one (k = 120 min) — weight 0.61 for points
    rs = D.groupby("pid")[stat].transform(lambda x: x.shift(1).rolling(10, min_periods=1).sum()).fillna(0)
    rm = D.groupby("pid")["min"].transform(lambda x: x.shift(1).rolling(10, min_periods=1).sum()).fillna(0)
    D[f"r10_{stat}"] = np.log(((rs + 120 * D[f"rate_{stat}"]) / (rm + 120)).clip(1e-3)) - np.log(D[f"rate_{stat}"].clip(1e-3))
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
            cols = [np.log(tr[f"rate_{st}"].clip(1e-3)), tr[f"r10_{st}"], tr.limp, np.log(tr[f"opp_{st}"].fillna(1).clip(0.7, 1.3)), tr.home]
            X = np.column_stack([np.ones(len(tr))] + cols); b = glm_poisson(X, tr[st].values, tr.off.values)
            ce = [np.log(te[f"rate_{st}"].clip(1e-3)), te[f"r10_{st}"], te.limp, np.log(te[f"opp_{st}"].fillna(1).clip(0.7, 1.3)), te.home]
            mus[st] = np.exp(np.column_stack([np.ones(len(te))] + ce) @ b + te.off.values)
            trmus = locals().setdefault("trmus", {}); trmus[st] = np.exp(X @ b + tr.off.values)
            te[f"mu_{st}"] = mus[st]
            # spread given minutes: variance = a x mu^p, fit on the training rows' residuals with
            # mu scaled to the minutes he actually played (the minutes spread is mixed in separately)
            mtr = np.exp(X @ b + tr.off.values) * (tr["min"].values / tr.mproj.values.clip(1))
            bins = pd.qcut(mtr, 20, labels=False, duplicates="drop")
            bv = pd.DataFrame({"m": mtr, "v": (tr[st].values - mtr) ** 2, "b": bins}).groupby("b").mean()
            pw, la = np.polyfit(np.log(bv.m.clip(0.05)), np.log(bv.v.clip(0.05)), 1)
            alphas[st] = (float(np.exp(la)), float(pw))
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
        prev = pd.concat(out) if out else None
        for c in ("dd", "td"):
            if prev is not None and len(prev) > 5000:
                # the model's price blended with HIS OWN recent rate (last 40, shrunk): some players
                # get it nearly every night in a way season rates don't carry — fit on earlier seasons
                lgt = lambda x: np.log(np.clip(x, 1e-6, 1 - 1e-6) / (1 - np.clip(x, 1e-6, 1 - 1e-6)))
                X2 = np.column_stack([np.ones(len(prev)), lgt(prev[f"p_{c}"]), lgt(prev[f"l40_{c}"])]); bb = np.array([0.0, 1.0, 0.0]); yy = prev[c].values
                for _ in range(40):
                    q = 1 / (1 + np.exp(-X2 @ bb)); W = q * (1 - q)
                    bb += np.linalg.solve(X2.T @ (X2 * W[:, None]) + 1e-8 * np.eye(3), X2.T @ (yy - q))
                te[f"c_{c}"] = 1 / (1 + np.exp(-(bb[0] + bb[1] * lgt(te[f"p_{c}"]) + bb[2] * lgt(te[f"l40_{c}"]))))
                te[f"cal_{c}"] = f"{bb[0]:+.2f} model {bb[1]:.2f} his-rate {bb[2]:.2f}"
            else:
                te[f"c_{c}"] = te[f"p_{c}"]; te[f"cal_{c}"] = "none"
        out.append(te)
    R = pd.concat(out)
    print(f"{len(R):,} player-games walk-forward ({ss[1]}..{ss[-1]}) · NB layers (last fit) {({k: tuple(round(x, 2) for x in v) for k, v in alphas.items()})} · shared night variance per season {R.groupby('season').v.first().to_dict()}\n")
    for c, lab in (("dd", "double-double"), ("td", "triple-double")):
        y = R[c].values
        print(f"{lab}: base {y.mean():.4f} · log loss  his last-40 {ll(R[f'l40_{c}'], y):.5f}   independent {ll(R[f'p_{c}0'], y):.5f}   + shared night {ll(R[f'p_{c}'], y):.5f}   + his own rate {ll(R[f'c_{c}'], y):.5f}")
        print(f"  blend fit per season: {R.groupby('season')[f'cal_{c}'].first().to_dict()}")
        for col, lab2 in ((f"p_{c}", "model"), (f"c_{c}", "calibrated")):
            q = pd.qcut(R[col].rank(method="first"), 8, labels=False)
            print(f"  {lab2:10s} priced → actual by octile: " + "  ".join(f"{R[col][q == j].mean():.4f}→{y[q == j].mean():.4f}" for j in range(8)))
            top = R.nlargest(2000, col); print(f"  {lab2:10s} top 2,000: {top[col].mean():.3f} priced, {top[c].mean():.3f} hit")
        print()
    R[["gid", "pid", "name", "date", "season", "dd", "td", "p_dd", "p_td", "c_dd", "c_td", "mproj", "mu_pts", "mu_reb", "mu_ast"]].to_parquet(os.path.join(HERE, "nba_ddtd_oos.parquet"))


if __name__ == "__main__":
    main()
