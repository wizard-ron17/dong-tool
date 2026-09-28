"""Compare the build's replayed inputs (nba_parity.csv) with research's (research)."""
import os
import numpy as np
import pandas as pd

HERE = os.path.dirname(os.path.abspath(__file__))
B = pd.read_csv(os.path.join(HERE, "nba_parity.csv"), dtype={"gid": str, "pid": str})
R = pd.read_parquet(os.path.join(HERE, "nba_minutes.parquet"))
R = R.sort_values(["pid", "date", "gid"]).reset_index(drop=True)
for c in ("tpm", "min"): R[c] = R[c].astype(float).fillna(0)
R["fam"] = R.fam.fillna("?")
g = R.groupby(["pid", "season"])
R["s_tpm"] = g.tpm.cumsum() - R.tpm; R["s_min"] = g["min"].cumsum() - R["min"]
tot = R.groupby(["pid", "season"])[["tpm", "min"]].sum().reset_index()
ss = sorted(R.season.unique()); nxt = {s: ss[i + 1] for i, s in enumerate(ss[:-1])}
tot["season"] = tot.season.map(nxt); tot = tot.dropna().rename(columns={"tpm": "p_tpm", "min": "p_min"})
R = R.merge(tot, on=["pid", "season"], how="left").fillna({"p_tpm": 0, "p_min": 0})
fr = R.groupby(["season", "fam"]).apply(lambda d: d.tpm.sum() / d["min"].sum(), include_groups=False).rename("fam_rate").reset_index()
fr_prev = fr.assign(season=fr.season.map(nxt)).dropna()                   # last season's, as research now uses
fr = pd.concat([fr_prev, fr[fr.season == min(fr.season)]]).drop_duplicates(["season", "fam"])
R = R.merge(fr, on=["season", "fam"], how="left")
R["rate3"] = (R.s_tpm + 0.5 * R.p_tpm + 300 * R.fam_rate) / (R.s_min + 0.5 * R.p_min + 300)
R["mprev_r"] = R.mprev.fillna(R.m10); R["mseason_r"] = R.mseason.fillna(R.m10)
M = B.merge(R[["gid", "pid", "m3", "m5", "m10", "mseason_r", "mprev_r", "start10", "rest", "rate3"]].rename(columns=lambda c: c + "_r" if c in ("m3", "m5", "m10", "start10", "rest", "rate3") else c), on=["gid", "pid"])
M = M[M.season >= ss[1]]
print(f"{len(M):,} player-games matched (seasons {ss[1]}..{ss[-1]})\n")
print(f"{'input':10s} {'mean |diff|':>12s} {'share within 1%':>16s} {'corr':>7s}")
for b, r in (("m3", "m3_r"), ("m5", "m5_r"), ("m10", "m10_r"), ("mseason", "mseason_r"), ("mprev", "mprev_r"), ("start10", "start10_r"), ("rest", "rest_r"), ("rate3", "rate3_r")):
    x, y = M[b].astype(float), M[r].astype(float); ok = x.notna() & y.notna()
    d = (x[ok] - y[ok]).abs(); within = (d <= 0.01 * y[ok].abs().clip(lower=0.01)).mean()
    print(f"{b:10s} {d.mean():12.4f} {within:16.1%} {np.corrcoef(x[ok], y[ok])[0, 1]:7.4f}")
