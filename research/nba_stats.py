"""One engine for the NBA counting-stat boards: points, rebounds, assists, PRA,
steals, blocks, stocks — plus double/triple-doubles built from pts/reb/ast (research).

    python3 research/nba_stats.py            # walk-forward check, then export into nba_model.json
    python3 research/nba_stats.py oos        # walk-forward only: save nba_stats_oos.parquet (the model audit scores it), no export

Every stat is the same shape (nba_points.py found it, round three):
  mu = projected minutes (nba_minutes.py) x his per-minute rate, times the game
     his rate   season to date + 0.5 x last season, shrunk 300 minutes to his
                position family's rate — LAST season's family rate (the build
                can't know this season's; research/nba_parity.mjs)
     form       his last-10 rate against that rate (shrunk 120 minutes)
     the game   his team's implied points / last season's league mean, the
                opponent's allowance of this stat per game so far (shrunk 10
                games) / last season's league mean, home
  Poisson GLM on log mu, log(projected minutes) as the offset.
  spread: variance given minutes = a x lam^p, fit on the training rows at the
  minutes he actually played; the ladder mixes over minutes N(proj, sd).
Double/triple-double (nba_ddtd.py): pts, reb, ast independent GIVEN minutes
(residual r <= .07), a shared night factor g ~ Gamma(1, v) on all three, and
his own last-40 double-double rate blended in on the logit scale.
"""
import json, sys, os
import numpy as np
import pandas as pd
from scipy.stats import nbinom, gamma as gamma_dist

HERE = os.path.dirname(os.path.abspath(__file__))
STATS = ["pts", "reb", "ast", "pra", "stl", "blk", "stk"]
RUNGS = {"pts": [10, 15, 20, 25, 30, 35], "reb": [4, 6, 8, 10, 12, 14], "ast": [2, 4, 6, 8, 10, 12],
         "pra": [15, 20, 25, 30, 35, 40, 45], "stl": [1, 2, 3], "blk": [1, 2, 3], "stk": [1, 2, 3, 4]}
NODES = np.polynomial.hermite_e.hermegauss(9)


def glm_poisson(X, y, off, iters=30):
    b = np.zeros(X.shape[1]); b[0] = np.log(max(y.mean(), 1e-3)) - off.mean()
    for _ in range(iters):
        mu = np.exp(np.clip(X @ b + off, -20, 6))
        b += np.linalg.solve(X.T @ (X * mu[:, None]) + 1e-6 * np.eye(len(b)), X.T @ (y - mu))
    return b


def ll(p, y): p = np.clip(p, 1e-6, 1 - 1e-6); return float(-(y * np.log(p) + (1 - y) * np.log(1 - p)).mean())


def sf_pow(k, lam, a, pw):
    """P(X >= k), NB whose variance is a x lam^p (floored at Poisson)."""
    var = a * np.power(np.clip(lam, 0.02, None), pw)
    alpha = np.clip((var - lam) / np.clip(lam, 0.02, None) ** 2, 1e-4, None); r = 1 / alpha
    return nbinom.sf(k - 1, r, r / (r + lam))


def ladder(mu, mproj, sd, a, pw, rungs, g=1.0):
    x, w = NODES; w = w / w.sum(); out = np.zeros((len(mu), len(rungs)))
    for xi, wi in zip(x, w):
        lam = mu * g * np.clip(mproj + sd * xi, 1, 48) / np.clip(mproj, 1, None)
        out += wi * np.column_stack([sf_pow(k, lam, a, pw) for k in rungs])
    return out


def build():
    D = pd.read_parquet(os.path.join(HERE, "nba_minutes.parquet"))
    D = D.sort_values(["pid", "date", "gid"]).reset_index(drop=True)
    for c in ("pts", "reb", "ast", "stl", "blk", "min"): D[c] = D[c].astype(float).fillna(0)
    D["pra"] = D.pts + D.reb + D.ast; D["stk"] = D.stl + D.blk
    D["fam"] = D.fam.fillna("?")
    ss = sorted(D.season.unique()); nxt = {s: ss[i + 1] for i, s in enumerate(ss[:-1])}
    g = D.groupby(["pid", "season"])
    D["s_min"] = g["min"].cumsum() - D["min"]
    pm = D.groupby(["pid", "season"])["min"].sum().reset_index(); pm["season"] = pm.season.map(nxt)
    D = D.merge(pm.dropna().rename(columns={"min": "p_min"}), on=["pid", "season"], how="left").fillna({"p_min": 0})
    D["implied"] = D.total / 2 - D.spread / 2
    imp_s = D.groupby("season").implied.mean(); D["limp"] = np.log((D.implied / D.season.map(imp_s.shift(1).fillna(imp_s))).fillna(1.0).clip(0.6, 1.4))
    D["home"] = D.home.astype(float)
    TG = pd.read_parquet(os.path.join(HERE, "nba_team_games.parquet"))   # every played row, as the build counts
    league = {"implied": float(D[D.season == ss[-1]].implied.mean()), "fam_rate": {}, "allowed": {}}
    for st in STATS:
        D[f"s_{st}"] = g[st].cumsum() - D[st]
        pt = D.groupby(["pid", "season"])[st].sum().reset_index(); pt["season"] = pt.season.map(nxt)
        D = D.merge(pt.dropna().rename(columns={st: f"p_{st}"}), on=["pid", "season"], how="left").fillna({f"p_{st}": 0})
        fr = D.groupby(["season", "fam"]).apply(lambda d, st=st: d[st].sum() / d["min"].sum(), include_groups=False).rename(f"fr_{st}").reset_index()
        league["fam_rate"][st] = {k: float(v) for k, v in fr[fr.season == ss[-1]].set_index("fam")[f"fr_{st}"].items()}
        frp = fr.assign(season=fr.season.map(nxt)).dropna()
        fr = pd.concat([frp, fr[fr.season == ss[0]]]).drop_duplicates(["season", "fam"])
        D = D.merge(fr, on=["season", "fam"], how="left")
        D[f"rate_{st}"] = (D[f"s_{st}"] + 0.5 * D[f"p_{st}"] + 300 * D[f"fr_{st}"]) / (D.s_min + 0.5 * D.p_min + 300)
        rs = D.groupby("pid")[st].transform(lambda x: x.shift(1).rolling(10, min_periods=1).sum()).fillna(0)
        rm = D.groupby("pid")["min"].transform(lambda x: x.shift(1).rolling(10, min_periods=1).sum()).fillna(0)
        D[f"r10_{st}"] = np.log(((rs + 120 * D[f"rate_{st}"]) / (rm + 120)).clip(1e-3)) - np.log(D[f"rate_{st}"].clip(1e-3))
        tg = TG.assign(pra=TG.pts + TG.reb + TG.ast, stk=TG.stl + TG.blk)[["gid", "team", "opp", "date", "season", st]].sort_values("date")
        n = tg.groupby(["season", "opp"]).cumcount()
        allowed = tg.groupby(["season", "opp"])[st].transform(lambda x: x.shift(1).expanding().mean())
        al = tg.groupby("season")[st].mean(); lg = tg.season.map(al.shift(1).fillna(al))
        league["allowed"][st] = float(al.loc[ss[-1]])
        tg[f"opp_{st}"] = ((allowed.fillna(lg) * n + 10 * lg) / (n + 10)) / lg
        D = D.merge(tg[["gid", "team", f"opp_{st}"]], on=["gid", "team"], how="left")
    D = D[D.mproj.notna() & (D.mproj > 3)].copy()
    D["off"] = np.log(D.mproj.clip(1))
    D["early"] = np.exp(-D.n_prior.fillna(0) / 3)                       # 1 in his first game of the season, ~0 by the tenth
    cats = D[["pts", "reb", "ast", "stl", "blk"]] >= 10
    D["dd"] = (cats.sum(axis=1) >= 2).astype(float); D["td"] = (cats.sum(axis=1) >= 3).astype(float)
    D = D.sort_values(["pid", "date", "gid"])
    for c in ("dd", "td"):
        base = D.groupby("season")[c].transform("mean"); nn = D.groupby("pid").cumcount().clip(upper=40)
        l = D.groupby("pid")[c].transform(lambda s: s.shift(1).rolling(40, min_periods=1).mean()).fillna(0)
        D[f"l40_{c}"] = (l * nn + 10 * base) / (nn + 10)
    return D, league, ss


def X_of(d, st):
    return np.column_stack([np.ones(len(d)), np.log(d[f"rate_{st}"].clip(1e-4)), d[f"r10_{st}"], d.limp,
                            np.log(d[f"opp_{st}"].fillna(1).clip(0.7, 1.3)), d.home, d.early, d[f"r10_{st}"] * d.early])


def fit_stat(tr, st):
    X = X_of(tr, st); b = glm_poisson(X, tr[st].values, tr.off.values)
    mu_act = np.exp(X @ b + tr.off.values) * (tr["min"].values / tr.mproj.values.clip(1))   # at the minutes he played
    bins = pd.qcut(mu_act, 20, labels=False, duplicates="drop")
    bv = pd.DataFrame({"m": mu_act, "v": (tr[st].values - mu_act) ** 2, "b": bins}).groupby("b").mean()
    pw, la = np.polyfit(np.log(bv.m.clip(0.02)), np.log(bv.v.clip(0.02)), 1)
    return b, float(np.exp(la)), float(pw)


def main():
    D, league, _ = build()
    ss = sorted(D.season.unique())                          # seasons with a walk-forward minutes projection
    ss = [ss[0]] + ss                                       # so ss[2:] scores from the second of them
    SD = json.load(open(os.path.join(HERE, "nba_model.json")))["minutes"]["lineup"]["sd"]
    print(f"{len(D):,} player-games · walk-forward {ss[2]}..{ss[-1]} · minutes spread {SD:.2f}\n")
    res, ddrows = {st: [] for st in STATS}, []
    for s in ss[2:]:
        tr, te = D[D.season < s], D[D.season == s].copy()
        fits = {st: fit_stat(tr, st) for st in STATS}
        for st in STATS:
            b, a, pw = fits[st]; mu = np.exp(X_of(te, st) @ b + te.off.values)
            L = ladder(mu, te.mproj.values, SD, a, pw, RUNGS[st])
            res[st].append((te[st].values, L, te.pid.values))
            te[f"mu_{st}"] = mu
        # double / triple-double: pts, reb, ast independent given minutes, a shared night factor, his own rate
        def dd_price(d, v):
            x, w = NODES; w = w / w.sum()
            gs, gw = (gamma_dist.ppf((np.arange(7) + 0.5) / 7, 1 / v, scale=v), np.full(7, 1 / 7)) if v > 0 else (np.array([1.0]), np.array([1.0]))
            pdd = np.zeros(len(d)); ptd = np.zeros(len(d))
            for xi, wi in zip(x, w):
                sc = np.clip(d.mproj.values + SD * xi, 1, 48) / np.clip(d.mproj.values, 1, None)
                for gi, gwi in zip(gs, gw):
                    p = [sf_pow(10, d[f"mu_{st}"].values * sc * gi, fits[st][1], fits[st][2]) for st in ("pts", "reb", "ast")]
                    pdd += wi * gwi * (p[0] * p[1] + p[0] * p[2] + p[1] * p[2] - 2 * p[0] * p[1] * p[2]); ptd += wi * gwi * p[0] * p[1] * p[2]
            return pdd, ptd
        smp = tr.sample(min(30000, len(tr)), random_state=2).copy()
        for st in ("pts", "reb", "ast"): smp[f"mu_{st}"] = np.exp(X_of(smp, st) @ fits[st][0] + smp.off.values)
        v = min((ll(dd_price(smp, v)[0], smp.dd.values) + ll(dd_price(smp, v)[1], smp.td.values), v) for v in (0.0, 0.02, 0.04, 0.06))[1]
        te["p_dd"], te["p_td"] = dd_price(te, v); te["v"] = v
        ddrows.append(te[["season", "pid", "dd", "td", "p_dd", "p_td", "l40_dd", "l40_td", "v"]])
    print(f"{'stat':5s} rungs → log loss (model / his last-20 hit rate)")
    for st in STATS:
        Y = np.concatenate([y for y, _, _ in res[st]]); L = np.vstack([l for _, l, _ in res[st]]); P = np.concatenate([p for _, _, p in res[st]])
        cells = []
        for j, k in enumerate(RUNGS[st]):
            y = (Y >= k).astype(float)
            h = pd.Series(y).groupby(P).transform(lambda s: s.shift(1).rolling(20, min_periods=1).mean()).fillna(y.mean()).values
            cells.append(f"{k}+ {ll(L[:, j], y):.4f}/{ll(h, y):.4f}")
        print(f"{st:5s} " + "  ".join(cells))
    R = pd.concat(ddrows); lgt = lambda x: np.log(np.clip(x, 1e-6, 1 - 1e-6) / (1 - np.clip(x, 1e-6, 1 - 1e-6)))
    blend, DDOUT = {}, {"dd": [], "td": []}
    for c in ("dd", "td"):
        # his own rate blended on the logit scale — fit on earlier seasons, scored on the next
        out = []
        for s in sorted(R.season.unique())[1:]:
            tr, te = R[R.season < s], R[R.season == s]
            X = np.column_stack([np.ones(len(tr)), lgt(tr[f"p_{c}"]), lgt(tr[f"l40_{c}"])]); bb = np.array([0, 1.0, 0]); yy = tr[c].values
            for _ in range(40):
                q = 1 / (1 + np.exp(-X @ bb)); W = q * (1 - q); bb += np.linalg.solve(X.T @ (X * W[:, None]) + 1e-8 * np.eye(3), X.T @ (yy - q))
            out.append((te[c].values, 1 / (1 + np.exp(-(bb[0] + bb[1] * lgt(te[f"p_{c}"]) + bb[2] * lgt(te[f"l40_{c}"])))), te[f"l40_{c}"].values, te[f"p_{c}"].values, s))
            DDOUT[c].append(out[-1])
            blend[c] = [float(x) for x in bb]
        y = np.concatenate([o[0] for o in out]); pb = np.concatenate([o[1] for o in out]); pl = np.concatenate([o[2] for o in out]); pm = np.concatenate([o[3] for o in out])
        top = np.argsort(-pb)[:2000]
        print(f"\n{c}: log loss his last-40 {ll(pl, y):.5f} · model {ll(pm, y):.5f} · blended {ll(pb, y):.5f} · top 2,000 priced {pb[top].mean():.3f} hit {y[top].mean():.3f}")

    if ONLY_OOS:
        # Keep the diagnostic export opt-in; normal model builds should not write extra artifacts.
        oos = []
        for st in STATS:
            for (y, L, _), s in zip(res[st], ss[2:]):
                for j, k in enumerate(RUNGS[st]):
                    oos.append(pd.DataFrame({"season": s, "stat": st, "rung": k, "p": L[:, j], "y": (y >= k).astype(float)}))
        O = pd.concat(oos, ignore_index=True)
        O.to_parquet(os.path.join(HERE, "nba_stats_oos.parquet"))
        DD = pd.concat([pd.DataFrame({"season": o[4], "stat": c, "rung": 1, "p": o[1], "y": o[0].astype(float)}) for c, outs in DDOUT.items() for o in outs], ignore_index=True)
        DD.to_parquet(os.path.join(HERE, "nba_stats_dd_oos.parquet"))
        print(f"\nsaved nba_stats_oos.parquet ({len(O):,} rows) and nba_stats_dd_oos.parquet ({len(DD):,})")
        return

    # export: every stat fit on all seasons
    fits = {st: fit_stat(D, st) for st in STATS}
    M = json.load(open(os.path.join(HERE, "nba_model.json")))
    M["stats"] = {
        "note": "research/nba_stats.py — mu = projected minutes x his rate x the game (Poisson GLM, log(minutes) offset); variance given minutes = a x lam^p; ladder mixed over minutes.",
        "cols": ["const", "lrate", "r10", "limp", "lopp", "home", "early", "r10_x_early"], "shrink_min": 300, "prev_weight": 0.5, "form_k": 120,
        "opp_shrink_games": 10, "clip": {"imp": [0.6, 1.4], "opp": [0.7, 1.3]},
        "models": {st: {"coef": [float(x) for x in fits[st][0]], "a": fits[st][1], "p": fits[st][2], "rungs": RUNGS[st]} for st in STATS},
        "league": league,
        "dd": {"v": float(R.v.iloc[-1]), "g_nodes": [float(x) for x in (gamma_dist.ppf((np.arange(7) + 0.5) / 7, 1 / R.v.iloc[-1], scale=R.v.iloc[-1]) if R.v.iloc[-1] > 0 else [1.0])], "blend_dd": blend["dd"], "blend_td": blend["td"], "l40_prior": 10,
               "base_dd": float(D[D.season == ss[-1]].dd.mean()), "base_td": float(D[D.season == ss[-1]].td.mean())},
    }
    json.dump(M, open(os.path.join(HERE, "nba_model.json"), "w"), indent=1)
    print("\nexported stats models:", {st: (round(fits[st][1], 2), round(fits[st][2], 2)) for st in STATS}, "dd", M["stats"]["dd"])


ONLY_OOS = len(sys.argv) > 1 and sys.argv[1] == "oos"
if __name__ == "__main__":
    main()
