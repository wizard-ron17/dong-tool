"""Re-test the features we wrote off, on a log scale.

Every null before M9 was judged with a term linear in the standardised value.
Two of those features (red-zone touches, TD share) turned out to be real once
logged, and touches — written off at t -2.0 raw — is the biggest add the ladder
has taken since last-3 snap share (t -6.4 logged). So the earlier verdicts were
tests of a shape, not of the information.

This re-runs every candidate column against the current model, raw and logged,
under the same walk-forward rule and the same |t| > 2.5 bar.

    python3 research/rescale.py
"""
import os, sys, warnings
warnings.filterwarnings("ignore")
import numpy as np
import pandas as pd

sys.path.insert(0, os.path.dirname(__file__))
from backtest import DATA, MODELS, FINAL, design, fit_logistic, predict, auc   # noqa: E402

BASE = MODELS[FINAL]
# every numeric column the model does not already use
CANDIDATES = ["touches_prior", "rz_touches_prior", "td_share_prior", "td_per_touch_prior",
              "snap_last5", "snap_trend", "total_line", "spread_line",
              "d_td_vs_pos", "d_rz_td_rate", "d_plays_all", "d_rz_trips_all",
              "t_plays", "t_rz_trips", "t_rz_tds"]


def walk(df, fs, seasons):
    ps, ys, ss = [], [], []
    for S in seasons[1:]:
        tr, te = df[df.season < S], df[df.season == S]
        Xtr, mu, sd = design(tr, fs)
        Xte, _, _ = design(te, fs, mu, sd)
        ps.append(predict(Xte, fit_logistic(Xtr, tr.scored.to_numpy(float))))
        ys.append(te.scored.to_numpy(float)); ss.append(np.full(len(te), S))
    return np.concatenate(ps), np.concatenate(ys), np.concatenate(ss)


def main():
    df = pd.read_parquet(DATA).sort_values(["season", "week"]).reset_index(drop=True)
    seasons = sorted(df.season.unique())
    p0, y, S = walk(df, BASE, seasons)
    row = lambda p: -(y * np.log(np.clip(p, 1e-12, 1)) + (1 - y) * np.log(np.clip(1 - p, 1e-12, 1)))
    l0 = row(p0)
    print(f"base = {FINAL}: log loss {l0.mean():.5f} · AUC {auc(y, p0):.4f} · {len(y):,} player-games, walk-forward {seasons[1]}-{seasons[-1]}")
    print(f"\n{'candidate':<22} {'scale':>6} {'log loss':>9} {'delta':>9} {'AUC':>7}    t   seasons")
    hits = []
    for c in CANDIDATES:
        if c not in df.columns: continue
        for scale in ("raw", "log"):
            col = f"__{c}_{scale}"
            v = df[c].to_numpy(float)
            df[col] = np.log1p(np.clip(v, 0, None)) if scale == "log" else v
            if df[col].std() < 1e-9: continue
            p, _, _ = walk(df, BASE + [col], seasons)
            li = row(p); dd = li - l0
            t = dd.mean() / (dd.std(ddof=1) / np.sqrt(len(dd)))
            better = sum(li[S == s].mean() < l0[S == s].mean() for s in seasons[1:])
            flag = "  <-- REAL" if t < -2.5 else ""
            if t < -2.5: hits.append((c, scale, t, li.mean()))
            print(f"{c:<22} {scale:>6} {li.mean():>9.5f} {li.mean() - l0.mean():>+9.5f} {auc(y, p):>7.4f} {t:>+6.1f}   {better}/{len(seasons)-1}{flag}")
    if not hits:
        print("\nnothing clears the bar on either scale.")
        return
    print("\nsurvivors, added together:")
    cols = [f"__{c}_{s}" for c, s, _, _ in sorted(hits, key=lambda h: h[2])]
    for i in range(1, len(cols) + 1):
        p, _, _ = walk(df, BASE + cols[:i], seasons)
        li = row(p); dd = li - l0
        print(f"  + {cols[i-1]:<28} {li.mean():.5f} ({li.mean() - l0.mean():+.5f}) AUC {auc(y, p):.4f}  t {dd.mean() / (dd.std(ddof=1) / np.sqrt(len(dd))):+.1f}")


if __name__ == "__main__":
    main()
