"""Is anyone "due"? Droughts against the model's own price (research).

    python3 research/nba_due.py

/nhl's Due page lists goal droughts and says in numbers that they are not a
signal. This asks the same of the NBA markets Ron named: a made three, 3+
threes, a double-double, a triple-double, the first basket.

For each market, every walk-forward priced player-game (the OOS files the model
research wrote) gets his drought going in: regular-season games PLAYED since he
last hit it (first basket: STARTS since his last), across season breaks. A
player with no hit on record yet is left out — his drought has no start.

"Due" would mean the market hits MORE often after a long drought than the model
priced. The test: actual vs priced by how long the drought is against the
price (drought x p = how many he'd have expected in that span), and a logistic
with the model's logit as an offset plus log(1 + drought x p). A positive,
significant slope = due; negative = cold (the model's rate is too high for a
player who's fallen off); ~0 = the model already has it.
"""
import os
import numpy as np
import pandas as pd

HERE = os.path.dirname(os.path.abspath(__file__))


def droughts(df, key, hit):
    """Games since his last hit before each row (NaN until his first hit), rows in date order per player."""
    df = df.sort_values([key, "date", "gid"]).copy()
    out = np.full(len(df), np.nan); last = {}; n = {}
    for i, (pid, h) in enumerate(zip(df[key].values, df[hit].values)):
        if pid in last: out[i] = n[pid]
        n[pid] = n.get(pid, 0) + 1
        if h: last[pid] = True; n[pid] = 0
    df["drought"] = out
    return df


def offset_logit(y, off, x):
    """Logistic y ~ offset(off) + a + b x. Returns b, se(b), log-loss gain vs the offset alone."""
    X = np.column_stack([np.ones(len(x)), x]); b = np.zeros(2)
    for _ in range(50):
        p = 1 / (1 + np.exp(-(off + X @ b))); W = p * (1 - p)
        H = X.T @ (X * W[:, None]); b += np.linalg.solve(H + 1e-9 * np.eye(2), X.T @ (y - p))
    p = 1 / (1 + np.exp(-(off + X @ b))); se = np.sqrt(np.linalg.inv(X.T @ (X * (p * (1 - p))[:, None]))[1, 1])
    ll = lambda q: -(y * np.log(q) + (1 - y) * np.log(1 - q)).mean()
    return b[1], se, ll(1 / (1 + np.exp(-off))) - ll(p)


def report(name, R, p, y, floor):
    R = R[R.drought.notna() & (R[p] > floor) & (R[p] < 0.98)].copy()
    R["x"] = R.drought * R[p]
    print(f"\n{name}: {len(R):,} priced player-games, {int(R[y].sum()):,} hits")
    print(f"  {'drought vs price':24s} {'n':>8s} {'priced':>8s} {'actual':>8s} {'act/priced':>11s}")
    bins = [-0.01, 0.5, 1, 2, 3, 5, 1e9]; labs = ["under half a hit due", "0.5-1 hits due", "1-2 due", "2-3 due", "3-5 due", "5+ due"]
    R["b"] = pd.cut(R.x, bins, labels=labs)
    for b, r in R.groupby("b", observed=True):
        print(f"  {b:24s} {len(r):8,} {r[p].mean():8.3f} {r[y].mean():8.3f} {r[y].mean() / r[p].mean():11.3f}")
    lg = lambda q: np.log(q / (1 - q))
    b, se, gain = offset_logit(R[y].values.astype(float), lg(R[p].clip(1e-4, 1 - 1e-4).values), np.log1p(R.x.values))
    print(f"  slope on log(1 + drought x p): {b:+.3f} ± {se:.3f} (t {b / se:+.1f}), log-loss gain {gain * 1e4:+.1f} bp")
    L = R.sort_values("drought", ascending=False).head(max(50, len(R) // 100))
    print(f"  longest 1% of droughts ({L.drought.min():.0f}+ games): priced {L[p].mean():.3f}, actual {L[y].mean():.3f} (n {len(L):,})")
    return R


def main():
    # every played regular-season game, for droughts that start before the priced seasons
    M = pd.read_parquet(os.path.join(HERE, "nba_minutes.parquet"))
    M = M[(M.type == 2) & (~M.dnp)][["gid", "pid", "date", "tpm", "pts", "reb", "ast", "stl", "blk"]].copy()
    cats = (M[["pts", "reb", "ast", "stl", "blk"]] >= 10).sum(axis=1)
    M["h1"], M["h3"], M["dd"], M["td"] = M.tpm >= 1, M.tpm >= 3, cats >= 2, cats >= 3
    T = pd.read_parquet(os.path.join(HERE, "nba_threes_oos.parquet"))
    DD = pd.read_parquet(os.path.join(HERE, "nba_ddtd_oos.parquet"))
    print(f"{len(M):,} played regular-season games; OOS seasons {T.season.min()}..{T.season.max()}")
    for name, hit, src, p, y, floor in (("1+ made three", "h1", T, "n_1", "h1", 0.05), ("3+ made threes", "h3", T, "n_3", "h3", 0.05),
                                        ("double-double", "dd", DD, "c_dd", "dd", 0.03), ("triple-double", "td", DD, "c_td", "td", 0.005)):
        d = droughts(M, "pid", hit)[["gid", "pid", "drought", hit]]
        R = src.drop(columns=[c for c in ("dd", "td") if c in src.columns]).merge(d, on=["gid", "pid"])
        report(name, R, p, y, floor)

    # first basket: starts since his last, off the walk-forward's own starter-games
    import nba_firstbasket2 as FB
    F = FB.main(export=False)
    F = droughts(F.rename(columns={"y": "fb"}), "pid", "fb")
    report("first basket (starts)", F, "tip_line_own", "fb", 0.0)


if __name__ == "__main__":
    main()
