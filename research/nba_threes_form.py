"""Threes + recent form: does the stats engine's last-10 term fix the drought gap? (research)

    python3 research/nba_threes_form.py

research/nba_due.py found the threes model prices long droughts too HIGH: 72+
games without a made three priced 11%, hit 1.3%. The threes GLM has no recent
form (the stats engine does: r10 = his last 10 games' per-minute rate shrunk
120 minutes to his rate, with the early-season terms). This fits the threes
count with the stats engine's own columns, walk-forward, prices both through
the SAME ladder (NB alpha 0.1 over minutes) and compares, then re-runs the
drought test on the new price.
"""
import os
import numpy as np
import pandas as pd
import nba_stats as NS
import nba_threes as TH
from nba_due import droughts, report

HERE = os.path.dirname(os.path.abspath(__file__))


def main():
    NS.STATS = ["tpm"]
    D, _, _ = NS.build()
    D = D[D.tpm.notna()].copy()
    ss = sorted(D.season.unique())
    old = pd.read_parquet(os.path.join(HERE, "nba_threes_oos.parquet"))[["gid", "pid", "mu", "n_1", "n_3"]]
    out = []
    for s in ss[1:]:
        tr, te = D[D.season < s], D[D.season == s].copy()
        b = TH.glm_poisson(NS.X_of(tr, "tpm"), tr.tpm.values, tr.off.values)
        te["mu_f"] = np.exp(NS.X_of(te, "tpm") @ b + te.off.values)
        out.append(te[["gid", "pid", "date", "season", "tpm", "mproj", "mu_f"]]); coef = b
    R = pd.concat(out).merge(old, on=["gid", "pid"])
    L = TH.ladder(R.mu_f.values, R.mproj.values, alpha=0.1)
    R["f_1"], R["f_3"] = L[:, 0], L[:, 2]
    print(f"\n{len(R):,} player-games, both models priced ({R.season.min()}..{R.season.max()})")
    print("last fit: " + ", ".join(f"{k} {v:+.3f}" for k, v in zip(["const", "rate", "r10", "imp", "opp", "home", "early", "r10 x early"], coef)))
    pll = lambda mu, y: float((mu - y * np.log(mu.clip(1e-9))).mean())
    print(f"\n{'':22s} {'current':>9s} {'+ form':>9s}")
    print(f"{'Poisson deviance-ish':22s} {pll(R.mu.values, R.tpm.values):9.5f} {pll(R.mu_f.values, R.tpm.values):9.5f}")
    for k, a, f in ((1, "n_1", "f_1"), (3, "n_3", "f_3")):
        y = (R.tpm >= k).astype(float).values
        print(f"{f'{k}+ log loss':22s} {TH.ll(R[a].values, y):9.5f} {TH.ll(R[f].values, y):9.5f}")
    # the drought test again, on the new price
    M = pd.read_parquet(os.path.join(HERE, "nba_minutes.parquet"))
    M = M[(M.type == 2) & (~M.dnp)][["gid", "pid", "date", "tpm"]].copy(); M["h1"] = M.tpm >= 1; M["h3"] = M.tpm >= 3
    for name, hit, p in (("1+ three, + form", "h1", "f_1"), ("3+ threes, + form", "h3", "f_3")):
        d = droughts(M, "pid", hit)[["gid", "pid", "drought", hit]]
        report(name, R.merge(d, on=["gid", "pid"]), p, hit, 0.05)


if __name__ == "__main__":
    main()
