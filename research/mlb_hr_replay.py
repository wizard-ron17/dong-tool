"""P(HR) for a starting batter, from a replay of every 2025-26 starter-game.

    python3 research/mlb_hr_replay_fetch.py 2025 2026   # boxscores (cached)
    python3 research/mlb_hr_replay.py

Why: /mlb shows a pick score, not odds. The naive conversion
P = 1-(1-score/100)^AB comes out ~2x too high on logged board picks (34% vs
18%), and the board only covers the top of the range. This fits the level and
the power curve across EVERY starter, strictly out of sample, with the pieces
the live build can reproduce: season HR/AB to date shrunk toward last season
and the league, lineup slot, home, park, and the opposing starter's HR rate to
date (the crude pitcher-vulnerability test).

All features use games on EARLIER dates only. Fit: 2026 Apr-Jul. Test: 2026
Aug-Sep (2025 supplies the priors).
"""
import os
import sys

import numpy as np
import pandas as pd

RAW = os.path.join(os.path.dirname(__file__), "mlb_hr_replay_raw.parquet")


def fit_logistic(X, y, ridge=1e-4, iters=60):
    w = np.zeros(X.shape[1])
    for _ in range(iters):
        p = 1 / (1 + np.exp(-X @ w))
        H = X.T @ (X * (p * (1 - p))[:, None]) + ridge * np.eye(X.shape[1])
        w += np.linalg.solve(H, X.T @ (y - p) - ridge * w)
    return w, np.sqrt(np.diag(np.linalg.inv(H)))


def log_loss(y, p):
    p = np.clip(p, 1e-9, 1 - 1e-9)
    return -np.mean(y * np.log(p) + (1 - y) * np.log(1 - p))


def to_date(df, key, num, den, out):
    """Per (key, season): cumulative num/den over strictly earlier DATES."""
    daily = df.groupby([key, "season", "date"], as_index=False)[[num, den]].sum().sort_values([key, "season", "date"])
    g = daily.groupby([key, "season"], sort=False)
    daily[out + "_n"] = g[num].cumsum() - daily[num]
    daily[out + "_d"] = g[den].cumsum() - daily[den]
    return df.merge(daily[[key, "season", "date", out + "_n", out + "_d"]], on=[key, "season", "date"], how="left")


def build(df, k_bat=400, k_prior=300, k_sp=800, k_park=2000):
    df = df.copy()
    df["y"] = (df.hr > 0).astype(float)
    lg_ab = df.hr.sum() / df.ab.sum()
    # batter: season to date, prior season total
    df = to_date(df, "pid", "hr", "ab", "bat")
    last = df.groupby(["pid", "season"])[["hr", "ab"]].sum().reset_index()
    last["season"] += 1
    df = df.merge(last.rename(columns={"hr": "prev_hr", "ab": "prev_ab"}), on=["pid", "season"], how="left").fillna({"prev_hr": 0, "prev_ab": 0})
    prior = (df.prev_hr + k_prior * lg_ab) / (df.prev_ab + k_prior)
    df["bat_rate"] = (df.bat_n + k_bat * prior) / (df.bat_d + k_bat)
    # opposing starter: HR per batter faced, to date + last season. Each game's
    # line is repeated on every opposing batter's row, so dedupe to one per game.
    sp = df.drop_duplicates(["game_pk", "opp_sp"])[["opp_sp", "season", "date", "sp_hr", "sp_bf"]]
    lg_bf = sp.sp_hr.sum() / sp.sp_bf.sum()
    spd = sp.groupby(["opp_sp", "season", "date"], as_index=False)[["sp_hr", "sp_bf"]].sum().sort_values(["opp_sp", "season", "date"])
    g = spd.groupby(["opp_sp", "season"], sort=False)
    spd["sp_n"] = g.sp_hr.cumsum() - spd.sp_hr
    spd["sp_d"] = g.sp_bf.cumsum() - spd.sp_bf
    splast = sp.groupby(["opp_sp", "season"])[["sp_hr", "sp_bf"]].sum().reset_index()
    splast["season"] += 1
    spd = spd.merge(splast.rename(columns={"sp_hr": "sp_prev_hr", "sp_bf": "sp_prev_bf"}), on=["opp_sp", "season"], how="left").fillna(0)
    sp_prior = (spd.sp_prev_hr + k_sp * lg_bf) / (spd.sp_prev_bf + k_sp)
    spd["sp_rate"] = (spd.sp_n + k_sp * sp_prior) / (spd.sp_d + k_sp)
    df = df.merge(spd[["opp_sp", "season", "date", "sp_rate"]], on=["opp_sp", "season", "date"], how="left")
    df["sp_rate"] = df.sp_rate.fillna(lg_bf)
    # park: last season's HR per AB there, relative to league
    pk = df.groupby(["venue", "season"])[["hr", "ab"]].sum().reset_index()
    pk["season"] += 1
    df = df.merge(pk.rename(columns={"hr": "pk_hr", "ab": "pk_ab"}), on=["venue", "season"], how="left").fillna({"pk_hr": 0, "pk_ab": 0})
    df["park"] = ((df.pk_hr + k_park * lg_ab) / (df.pk_ab + k_park)) / lg_ab
    df["lg_ab"], df["lg_bf"] = lg_ab, lg_bf
    return df


def design(d, feats):
    cols = [np.ones(len(d))]
    for f in feats:
        if f == "slot":
            for s in range(2, 10):
                cols.append((d.slot == s).to_numpy(float))
        elif f == "home":
            cols.append(d.home.to_numpy(float))
        else:
            cols.append(np.log(d[f].to_numpy(float)))
    return np.column_stack(cols)


def main():
    df = build(pd.read_parquet(RAW))
    d = df[df.season == 2026].copy()
    tr, te = d[d.date < "2026-08-01"], d[d.date >= "2026-08-01"]
    y_tr, y_te = tr.y.to_numpy(), te.y.to_numpy()
    print(f"2026 starter-games: train {len(tr)} (HR {y_tr.mean():.3f}), test {len(te)} (HR {y_te.mean():.3f})")
    print(f"league HR/AB {df.lg_ab.iloc[0]:.4f}, starters average {d.ab.mean():.2f} AB\n")
    base = log_loss(y_te, np.full(len(y_te), y_tr.mean()))
    # the naive structural conversion, for reference
    naive = 1 - (1 - te.bat_rate) ** 3.6
    print(f"{'model':34s} {'test logloss':>12s} {'vs base':>8s}")
    print(f"{'base rate':34s} {base:12.5f}")
    print(f"{'naive 1-(1-rate)^3.6 (no fit)':34s} {log_loss(y_te, naive):12.5f} {100*(base-log_loss(y_te, naive))/base:7.2f}%")
    models = {
        "batter rate": ["bat_rate"],
        "+ slot": ["bat_rate", "slot"],
        "+ slot + park": ["bat_rate", "slot", "park"],
        "+ slot + park + home": ["bat_rate", "slot", "park", "home"],
        "+ opposing starter HR rate": ["bat_rate", "slot", "park", "home", "sp_rate"],
    }
    fits = {}
    for name, f in models.items():
        w, se = fit_logistic(design(tr, f), y_tr)
        p = 1 / (1 + np.exp(-design(te, f) @ w))
        fits[name] = (w, se, p, f)
        print(f"{name:34s} {log_loss(y_te, p):12.5f} {100*(base-log_loss(y_te, p))/base:7.2f}%")
    w, se, p, f = fits["+ opposing starter HR rate"]
    names = ["const"] + [x for ff in f for x in ([f"slot{s}" for s in range(2, 10)] if ff == "slot" else [ff])]
    print("\ncoefficients (full model, train):")
    for n, b, s in zip(names, w, se):
        print(f"  {n:10s} {b:7.3f}  z {b/s:6.1f}")
    print("\ncalibration on test, decile bins:")
    t = te.assign(p=p)
    t["bin"] = pd.qcut(t.p, 10, labels=False)
    print(t.groupby("bin").agg(n=("y", "size"), pred=("p", "mean"), actual=("y", "mean")).round(3).to_string())
    top = t[t.p >= t.p.quantile(0.98)]
    print(f"top 2%: pred {top.p.mean():.3f} actual {top.y.mean():.3f} (n {len(top)})")


if __name__ == "__main__":
    main()
