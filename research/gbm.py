"""Does gradient boosting beat the shipped logistic on anytime touchdowns?

The Picks model (research/backtest.py, M9) is a logistic on seven features.
Boosting is the obvious thing to try next: it finds interactions and non-linear
shapes on its own. This runs it under exactly the same rule — fit on every
earlier season, predict the next one cold — and scores it the same way.

Three candidates against M9:
  xgb same      the same seven features
  xgb all       every usable column in the dataset (the kitchen sink)
  blend         mean of M9 and the better xgb, which is what usually wins when
                a linear model and a tree model disagree for different reasons

Judged on pooled out-of-sample log loss (the thing a price is scored by), AUC,
calibration error, and a paired per-row t-test against M9 — the same |t| > 2.5
bar every other feature on this site had to clear.

    python3 research/gbm.py
"""
import os, sys, warnings
warnings.filterwarnings("ignore")
import numpy as np
import pandas as pd
import xgboost as xgb

sys.path.insert(0, os.path.dirname(__file__))
from backtest import DATA, MODELS, FINAL, design, fit_logistic, predict, log_loss, auc   # noqa: E402

SAME = MODELS[FINAL]
ALL = ["snap_share_prior", "implied_total", "rz_touches_log", "snap_last3", "snap_last5", "snap_trend",
       "mates_out", "new_absence", "td_share_log", "td_share_prior", "touches_prior", "rz_touches_prior",
       "td_per_touch_prior", "total_line", "spread_line", "d_td_vs_pos", "d_rz_td_rate", "d_plays_all",
       "d_rz_trips_all", "t_plays", "t_rz_trips", "t_rz_tds", "week"]
POS = ["RB", "WR", "TE", "QB", "FB"]
PARAMS = dict(objective="binary:logistic", eval_metric="logloss", max_depth=4, eta=0.04,
              subsample=0.8, colsample_bytree=0.8, min_child_weight=30, reg_lambda=2.0,
              nthread=4, tree_method="hist")


def xmat(df, feats):
    X = df[feats].to_numpy(float)
    P = np.column_stack([(df["position"] == p).to_numpy(float) for p in POS])
    return np.hstack([X, P])


def ece(y, p, bins=10):
    q = pd.qcut(pd.Series(p), bins, labels=False, duplicates="drop")
    d = pd.DataFrame({"y": y, "p": p, "b": q})
    g = d.groupby("b").agg(n=("y", "size"), pred=("p", "mean"), act=("y", "mean"))
    return float((g.n / g.n.sum() * (g.pred - g.act).abs()).sum())


def run(rounds=500):
    df = pd.read_parquet(DATA).sort_values(["season", "week"]).reset_index(drop=True)
    seasons = sorted(df.season.unique())
    out = {k: [] for k in ("M9", "xgb same", "xgb all", "blend")}
    ys = []
    for S in seasons[1:]:
        tr, te = df[df.season < S], df[df.season == S]
        y_tr, y_te = tr.scored.to_numpy(float), te.scored.to_numpy(float)
        ys.append(pd.DataFrame({"season": S, "y": y_te, "pos": te.position.values}))

        Xtr, mu, sd = design(tr, SAME)
        Xte, _, _ = design(te, SAME, mu, sd)
        p9 = predict(Xte, fit_logistic(Xtr, y_tr))
        out["M9"].append(p9)

        for name, feats in (("xgb same", SAME), ("xgb all", ALL)):
            # the last training season is the early-stopping holdout, so no
            # test-season row is ever seen while fitting
            cut = seasons[seasons.index(S) - 1]
            fit, val = tr[tr.season < cut], tr[tr.season == cut]
            if len(fit) < 2000: fit, val = tr, tr
            d_fit = xgb.DMatrix(xmat(fit, feats), label=fit.scored.to_numpy(float))
            d_val = xgb.DMatrix(xmat(val, feats), label=val.scored.to_numpy(float))
            bst = xgb.train(PARAMS, d_fit, rounds, evals=[(d_val, "val")],
                            early_stopping_rounds=40, verbose_eval=False)
            best = bst.best_iteration + 1
            # refit on everything before S for that many rounds
            d_tr = xgb.DMatrix(xmat(tr, feats), label=y_tr)
            bst = xgb.train(PARAMS, d_tr, best, verbose_eval=False)
            out[name].append(bst.predict(xgb.DMatrix(xmat(te, feats))))
        out["blend"].append((out["M9"][-1] + out["xgb same"][-1]) / 2)

    Y = pd.concat(ys, ignore_index=True)
    y = Y.y.to_numpy(float)
    P = {k: np.concatenate(v) for k, v in out.items()}
    print(f"anytime touchdown, walk-forward {seasons[1]}-{seasons[-1]} · {len(y):,} player-games · base rate {y.mean():.3f}\n")
    print(f"{'model':<10} {'log loss':>9} {'vs M9':>9} {'AUC':>7} {'ECE':>7}  paired t vs M9")
    l9 = -(y * np.log(np.clip(P['M9'], 1e-12, 1)) + (1 - y) * np.log(np.clip(1 - P['M9'], 1e-12, 1)))
    for k, p in P.items():
        li = -(y * np.log(np.clip(p, 1e-12, 1)) + (1 - y) * np.log(np.clip(1 - p, 1e-12, 1)))
        dd = li - l9
        t = dd.mean() / (dd.std(ddof=1) / np.sqrt(len(dd))) if k != "M9" else 0.0
        flag = "  <-- REAL" if t < -2.5 else ("  (worse)" if t > 2.5 else "")
        print(f"{k:<10} {li.mean():>9.5f} {li.mean() - l9.mean():>+9.5f} {auc(y, p):>7.4f} {ece(y, p):>7.4f}  {t:>+6.1f}{flag}")

    print("\nby season (log loss)")
    for S in seasons[1:]:
        m = Y.season == S
        print(f"  {S}  " + "  ".join(f"{k} {log_loss(y[m], P[k][m]):.5f}" for k in P))

    print("\nblend weights (w x xgb + (1-w) x M9), pooled and recent-only")
    late = Y.season >= 2021
    print(f"  {'w':>4} {'all seasons':>12} {'2021-2025':>11}   (log loss)")
    for src in ("xgb same", "xgb all"):
        print(f"  — {src}")
        for w in (0, 0.25, 0.4, 0.5, 0.6, 0.75, 1):
            pb = w * P[src] + (1 - w) * P["M9"]
            print(f"  {w:>4} {log_loss(y, pb):>12.5f} {log_loss(y[late], pb[late]):>11.5f}")
    print(f"  M9 alone, 2021-2025: {log_loss(y[late], P['M9'][late]):.5f} · AUC {auc(y[late], P['M9'][late]):.4f}")
    best_late = 0.5 * P["xgb all"][late] + 0.5 * P["M9"][late]
    print(f"  50/50 with xgb all, 2021-2025: {log_loss(y[late], best_late):.5f} · AUC {auc(y[late], best_late):.4f} · ECE {ece(y[late], best_late):.4f}")

    print("\ntop of the board (pooled): the 20 shortest prices each week")
    for k, p in P.items():
        d2 = pd.DataFrame({"y": y, "p": p, "season": Y.season.values})
        d2["wk"] = np.arange(len(d2))
        top = d2.sort_values("p", ascending=False).groupby("season").head(200)
        print(f"  {k:<10} said {top.p.mean():.3f} hit {top.y.mean():.3f} (n={len(top)})")

    print("\nwhere they differ most (pooled, |xgb same - M9| deciles)")
    d = pd.DataFrame({"y": y, "m9": P["M9"], "xg": P["xgb same"], "pos": Y.pos.values})
    d["gap"] = d.xg - d.m9
    d["b"] = pd.qcut(d.gap, 10, labels=False)
    g = d.groupby("b").agg(n=("y", "size"), m9=("m9", "mean"), xgb=("xg", "mean"), actual=("y", "mean"))
    print(g.round(4).to_string())


if __name__ == "__main__":
    run()


# ── the same question on a continuous market: yards ─────────────────────────
def yards(market="rec", first=2019):
    """Quasi-Poisson IRLS (shipped) vs boosting, scored the way the board is:
    log loss of P(over) at the line nearest the projection, plus MAE."""
    import yards as Y
    d = Y.load_pbp()
    ctx = Y.game_ctx(d)
    dfp = Y.defense_table(d)
    sk, _ = Y.skill_frame(d)
    rp = pd.read_parquet(os.path.join(os.path.dirname(__file__), "receptions.parquet"))[["game_id", "pid", "rec", "rec_l3"]]
    sk = sk.merge(rp, on=["game_id", "pid"], how="left")
    lab, target, pop, fs = Y.MARKETS[market]
    src = Y.qb_frame(d, ctx) if market in ("pass", "qbrush") else sk
    q = src[pop(src) & (src.games_prior >= 3)].dropna(subset=fs + [target]).copy()
    q["line"] = np.floor(q[target + "_prior"]) + 0.5
    parts = []
    for S in range(first, 2026):
        tr, te = q[q.season < S], q[q.season == S]
        mu_tr, mu_te = Y.fit_predict(tr, te, fs, target)
        ratio = tr[target].to_numpy(float) / np.maximum(mu_tr, 1e-6)
        p_irls = Y.p_over(te.line.to_numpy(float), mu_te, ratio, mu_tr)
        cut = S - 1
        fit, val = tr[tr.season < cut], tr[tr.season == cut]
        if len(fit) < 2000: fit, val = tr, tr
        # a few rushing lines are negative (sacks, losses); Poisson needs >= 0
        P2 = dict(PARAMS); P2.update(objective="count:poisson", eval_metric="poisson-nloglik")
        ylab = lambda f: np.clip(f[target].to_numpy(float), 0, None)
        bst = xgb.train(P2, xgb.DMatrix(fit[fs].to_numpy(float), label=ylab(fit)), 600,
                        evals=[(xgb.DMatrix(val[fs].to_numpy(float), label=ylab(val)), "val")],
                        early_stopping_rounds=40, verbose_eval=False)
        n_best = bst.best_iteration + 1
        bst = xgb.train(P2, xgb.DMatrix(tr[fs].to_numpy(float), label=ylab(tr)), n_best, verbose_eval=False)
        mx_tr = bst.predict(xgb.DMatrix(tr[fs].to_numpy(float)))
        mx_te = bst.predict(xgb.DMatrix(te[fs].to_numpy(float)))
        ratio_x = tr[target].to_numpy(float) / np.maximum(mx_tr, 1e-6)
        p_xgb = Y.p_over(te.line.to_numpy(float), mx_te, ratio_x, mx_tr)
        mu_bl = 0.5 * mu_te + 0.5 * mx_te
        ratio_b = tr[target].to_numpy(float) / np.maximum(0.5 * mu_tr + 0.5 * mx_tr, 1e-6)
        p_bl = Y.p_over(te.line.to_numpy(float), mu_bl, ratio_b, 0.5 * mu_tr + 0.5 * mx_tr)
        parts.append(te.assign(mu=mu_te, mx=mx_te, mb=mu_bl, p_irls=p_irls, p_xgb=p_xgb, p_bl=p_bl))
    t = pd.concat(parts)
    o = (t[target] > t.line).to_numpy(float)
    print(f"\n{lab} · walk-forward {first}-2025 · {len(t):,} player-games")
    base = None
    for name, pcol, mcol in (("IRLS (shipped)", "p_irls", "mu"), ("xgboost", "p_xgb", "mx"), ("50/50 blend", "p_bl", "mb")):
        p = np.clip(t[pcol].to_numpy(float), 1e-6, 1 - 1e-6)
        li = -(o * np.log(p) + (1 - o) * np.log(1 - p))
        if base is None: base = li
        dd = li - base
        tt = 0.0 if name.startswith("IRLS") else dd.mean() / (dd.std(ddof=1) / np.sqrt(len(dd)))
        flag = "  <-- REAL" if tt < -2.5 else ("  (worse)" if tt > 2.5 else "")
        print(f"  {name:<15} line log loss {li.mean():.5f}  MAE {np.abs(t[target] - t[mcol]).mean():6.2f}  t={tt:+.1f}{flag}")
