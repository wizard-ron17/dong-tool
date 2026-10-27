"""A starter's leash (batters faced, outs) and K rate, walk-forward: does it fix the pitcher K price?

    python3 research/mlb_outs_fetch.py && python3 research/mlb_outs_rows.py
    python3 research/mlb_outs.py          # writes research/.cache/mlb_box/outs_preds.parquet

The build prices a start's Ks as rate x his average batters faced per start, Poisson, and
that lost to the SmartStake closes (10/23: anti-signal). This fits both halves properly:
  leash: batters faced and outs, linear on what's known before first pitch: his season
         average (last season at half weight, shrunk to league), his last three starts'
         BF and pitches, pitches per batter, rest, an IL return, his relief share, his
         team's starters, the opponent's on-base and K rates, September, home, a short
         last outing. Its spread is the training residuals around the projection.
  rate:  K per batter, Poisson weighted by BF, on the logit of his shrunk rate, the
         opponent's, recent form (last five starts), fastball velocity off his norm, home.
  Ks:    binomial on the rate, mixed over the leash's batters-faced distribution.

Result, Aug 1 - Sep 28 2026 (fitted on everything before Aug 1), 10/27:
  batters faced RMSE 3.92 vs 4.50 for the build's season average (MAE 2.94 vs 3.16).
  vs the closes (~/smartstake-data/study/mlb_outs_closes.py, 1,378 starts at the K main line):
    K log loss: close .681, this .716, build's old Poisson .741; beside the close ours
    beta -0.19 (z -1.6). The market is still better.
    Splitting the K miss: our BF disagreement with the market's (read off its outs line)
    carries nothing (slope +0.01); our K-RATE disagreement is the anti-signal (-0.31).
    Outs: close log loss .690, ours beta -0.04. The market's outs line correlates .62 with
    actual outs; no edge.
  Platoon (opponent K% vs his hand) added nothing; velocity and recent form a little.
  The fit shrinks both pitcher and opponent K rates harder than the build (logit
  coefficients .73 / .70), matching where the market's own misses lean.
"""
import os
import numpy as np, pandas as pd
from numpy.linalg import lstsq
from scipy.special import logit
from soccer_fit import poisson_glm

HERE = os.path.dirname(os.path.abspath(__file__))
C = os.path.join(HERE, ".cache", "mlb_box")
SAV = os.path.join(HERE, ".cache", "savant_pa")
LG_BF, LG_K = 21.8, 0.222
CUT = "2026-08-01"


def leash_X(R, K=5):
    X = pd.DataFrame(index=R.index)
    py = np.where(R.py_gs > 0, R.py_bf / R.py_gs.clip(lower=1), 0)
    w_py = 0.5 * R.py_gs.clip(upper=30)
    X["avg"] = (R.gs_bf + w_py * py + K * LG_BF) / (R.gs_n + w_py + K)
    X["l3_bf"] = R.l3_bf.fillna(X.avg); X["l1_bf"] = R.l1_bf.fillna(X.avg)
    X["l1_p"] = R.l1_p.fillna(85); X["l3_p"] = R.l3_p.fillna(85)
    X["ppbf"] = (R.gs_p + 3.9 * 30) / (R.gs_bf + 30)
    X["rest"] = R.rest_st.fillna(30).clip(upper=40)
    X["il"] = (R.rest_app.fillna(99) >= 20).astype(int)
    X["first"] = (R.gs_n == 0).astype(int)
    X["relsh"] = R.rel_n / (R.rel_n + R.gs_n).clip(lower=1)
    X["tm"] = (R.tm_bf + 30 * LG_BF) / (R.tm_gs + 30)
    X["op_on"] = (R.op_on + 500 * .31) / (R.op_bf + 500)
    X["op_k"] = (R.op_k + 500 * .225) / (R.op_bf + 500)
    X["kr"] = (R.all_k + 70 * .225) / (R.all_bf + 70)
    X["onr"] = (R.all_on + 100 * .31) / (R.all_bf + 100)
    X["sep"] = (R.month >= 9).astype(int)
    X["home"] = R.home
    X["short_l1"] = (R.l1_p.fillna(85) < 60).astype(int)
    return X


def rate_F(R):
    L = pd.read_parquet(os.path.join(C, "lines.parquet"))
    velo = pd.concat([x for x in (pd.read_parquet(os.path.join(SAV, f)) for f in sorted(os.listdir(SAV)) if f.endswith("_pit.parquet")) if len(x) and "game_pk" in x])
    velo["pid"] = velo.pitcher.astype(int).astype(str); velo["gpk"] = velo.game_pk.astype(int)
    st = L[L.gs == 1].sort_values("start_time").merge(velo[["gpk", "pid", "fb_velo"]], on=["gpk", "pid"], how="left")
    st["season"] = st.date.str[:4]; gp = st.groupby("pid")
    st["k5"] = gp.k.transform(lambda s: s.shift().rolling(5, 1).sum()); st["bf5"] = gp.bf.transform(lambda s: s.shift().rolling(5, 1).sum())
    st["v_ssn"] = st.groupby(["pid", "season"]).fb_velo.transform(lambda s: s.shift().expanding().mean())
    st["v_l1"] = gp.fb_velo.transform(lambda s: s.shift())
    st["v_py"] = gp.fb_velo.transform(lambda s: s.shift().rolling(30, 5).mean())
    R = R.merge(st[["gpk", "pid", "k5", "bf5", "v_ssn", "v_l1", "v_py"]], on=["gpk", "pid"], how="left")
    R["kr"] = (R.all_k + 0.5 * R.py_k + 70 * LG_K) / (R.all_bf + 0.5 * R.py_all_bf + 70)
    okr = (R.op_k + 300 * LG_K) / (R.op_bf + 300)
    r5 = (R.k5.fillna(0) + 60 * R.kr) / (R.bf5.fillna(0) + 60)
    F = pd.DataFrame({"lk": logit(R.kr), "lo": logit(okr), "l5": logit(r5) - logit(R.kr),
                      "vdrop": (R.v_l1 - R.v_ssn).where(R.gs_n >= 2, 0).fillna(0).clip(-4, 4),
                      "vyr": (R.v_ssn - R.v_py).fillna(0).clip(-4, 4), "home": R.home})
    return R, F


if __name__ == "__main__":
    R = pd.read_parquet(os.path.join(C, "start_rows.parquet"))
    R, F = rate_F(R)
    X = leash_X(R); A = lambda M: np.column_stack([np.ones(len(M)), M])
    tr, te = R.date < CUT, R.date >= CUT
    avg_bf = np.where(R.gs_n > 0, R.gs_bf / R.gs_n.clip(lower=1), 22)
    for t in ["bf", "outs"]:
        b = lstsq(A(X[tr].values), R[t][tr].values, rcond=None)[0]; R["m_" + t] = A(X.values) @ b
        R["res_" + t] = np.where(tr, R[t] - R["m_" + t], np.nan)          # the leash's spread, training rows only
        e = R["m_" + t][te] - R[t][te]
        print(f"{t}: test MAE {e.abs().mean():.3f} RMSE {np.sqrt((e ** 2).mean()):.3f}", end="")
        if t == "bf": e0 = avg_bf[te] - R.bf[te]; print(f"  (build's season average: MAE {np.abs(e0).mean():.3f} RMSE {np.sqrt((e0 ** 2).mean()):.3f})")
        else: print()
    ok = tr & (R.bf > 0)
    b0, b = poisson_glm(F[ok].values, (R.k[ok] / R.bf[ok]).values, w=R.bf[ok].values)
    R["pk"] = np.clip(np.exp(b0 + F.values @ b), 1e-4, .9)
    print("K rate:", {k: round(float(v), 3) for k, v in zip(["b0"] + list(F.columns), [b0, *b])})
    R.to_parquet(os.path.join(C, "outs_preds.parquet"))
    print(f"wrote outs_preds.parquet ({te.sum():,} test starts from {CUT})")
