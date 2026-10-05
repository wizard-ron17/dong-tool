"""2+ HRs and the game's first homer, from the HR model's P(1+): walk-forward test.

    python3 research/mlb_hr_multi.py

P(1+ HR) per starter-game comes from mlb_hr_replay.py's model ("+ opposing
starter HR rate"), fit on 2026 Apr-Jul and predicted on Aug-Sep (out of sample).
Both conversions are tested on Aug-Sep only.

2+ HRs: back out a per-PA rate q from P(1+) and the slot's PA count
distribution, P(1+) = 1 - sum_n w_n (1-q)^n, then P(2+) from the same mix.
Compared with a Poisson read of P(1+).

First homer: per game, both lineups and every bat's q; half-innings take their
PA count from the empirical distribution (Savant cache), the order carries
over, and each PA homers with the batter's q. Monte Carlo gives P(first HR is
batter i) and P(no HR). Graded against the game's real first homer (earliest
at-bat with a home run in the Savant cache). Compared with the naive split:
P(any HR) x p_i / sum p.
"""
import glob, os, sys
import numpy as np
import pandas as pd

HERE = os.path.dirname(os.path.abspath(__file__))
import mlb_hr_replay as R


def oos_p1():
    df = R.build(pd.read_parquet(R.RAW))
    d = df[df.season == 2026].copy()
    tr, te = d[d.date < "2026-08-01"], d[d.date >= "2026-08-01"].copy()
    f = ["bat_rate", "slot", "park", "home", "sp_rate"]
    w, _ = R.fit_logistic(R.design(tr, f), tr.y.to_numpy())
    te["p1"] = 1 / (1 + np.exp(-R.design(te, f) @ w))
    return te, df


def pa_dist(df):
    out = {}
    for s, g in df[df.season == 2025].groupby("slot"):
        c = g.pa.clip(1, 7).value_counts().reindex(range(1, 8), fill_value=0)
        out[int(s)] = (c / c.sum()).to_numpy()
    return out


def solve_q(p1, slot, dist):
    lo, hi = np.zeros(len(p1)), np.full(len(p1), 0.5)
    W = np.stack([dist[s] for s in slot])                  # rows: P(PA = 1..7)
    n = np.arange(1, 8)
    for _ in range(50):
        mid = (lo + hi) / 2
        f = 1 - (W * (1 - mid[:, None]) ** n).sum(1)
        hi = np.where(f > p1, mid, hi); lo = np.where(f > p1, lo, mid)
    return (lo + hi) / 2, W


def ll(y, p):
    p = np.clip(p, 1e-6, 1 - 1e-6)
    return float(-(y * np.log(p) + (1 - y) * np.log(1 - p)).mean())


def two_plus(te, dist):
    slot = te.slot.astype(int).to_numpy(); p1 = te.p1.to_numpy()
    q, W = solve_q(p1, slot, dist)
    n = np.arange(1, 8)
    p0 = (W * (1 - q[:, None]) ** n).sum(1)
    p1x = (W * n * q[:, None] * (1 - q[:, None]) ** (n - 1)).sum(1)
    p2 = 1 - p0 - p1x
    lam = -np.log(1 - p1); p2pois = 1 - np.exp(-lam) * (1 + lam)
    y = (te.hr >= 2).astype(int).to_numpy()
    print(f"2+ HR, Aug-Sep 2026: n {len(y):,}, actual {y.mean()*100:.2f}% | mean pred: slot-PA {p2.mean()*100:.2f}%  Poisson {p2pois.mean()*100:.2f}%")
    base = ll(y, np.full(len(y), y.mean()))
    print(f"  logloss: slot-PA {ll(y, p2):.5f}  Poisson {ll(y, p2pois):.5f}  base rate (hindsight) {base:.5f}")
    t = pd.DataFrame({"p": p2, "y": y}); t["bin"] = pd.qcut(t.p, 5, labels=False)
    print(t.groupby("bin").agg(n=("y", "size"), pred=("p", "mean"), actual=("y", "mean")).round(4).to_string())
    return q


def first_hr_truth():
    fs = sorted(f for f in glob.glob(os.path.join(HERE, ".cache/savant_pa/2026-0[89]*.parquet")) if not f.endswith("_pit.parquet"))
    parts = [pd.read_parquet(f) for f in fs]
    d = pd.concat([x for x in parts if "game_pk" in x.columns and len(x)], ignore_index=True)
    d = d[d.events.notna()]
    hr = d[d.events == "home_run"].sort_values(["game_pk", "at_bat_number"]).groupby("game_pk").batter.first()
    games = d.game_pk.unique()
    halves = d.groupby(["game_pk", "inning", "top"]).size()
    return hr, set(games), halves.clip(3, 12).value_counts(normalize=True).sort_index()


def first_hr(te, q, sims=4000, seed=7):
    hr_first, games_seen, half_pa = first_hr_truth()
    te = te.assign(q=q)
    rng = np.random.default_rng(seed)
    sizes, probs = half_pa.index.to_numpy(), half_pa.to_numpy()
    rows = []
    for gpk, g in te.groupby("game_pk"):
        if gpk not in games_seen: continue
        sides = []
        for home in (0, 1):                                     # away bats first (top), then home
            s = g[g.home == home].sort_values("slot")
            if len(s) != 9 or list(s.slot) != list(range(1, 10)): break
            sides.append(s)
        if len(sides) != 2: continue
        qa, qh = sides[0].q.to_numpy(), sides[1].q.to_numpy()
        # per sim: walk half-innings, record the first HR (side, slot) or none
        first = np.full(sims, -1)                               # 0-8 away slot, 9-17 home slot, -1 none
        pos = np.zeros((sims, 2), dtype=int)
        alive = np.ones(sims, dtype=bool)
        for inning in range(9):
            for side in (0, 1):
                n = rng.choice(sizes, size=sims, p=probs)
                qs = qa if side == 0 else qh
                for k in range(sizes.max()):
                    act = alive & (k < n)
                    if not act.any(): break
                    slot_i = (pos[:, side] + k) % 9
                    hit = act & (rng.random(sims) < qs[slot_i])
                    first[hit] = slot_i[hit] + 9 * side
                    alive &= ~hit
                pos[:, side] = (pos[:, side] + n) % 9
        counts = np.bincount(first + 1, minlength=19) / sims    # [none, away1..9, home1..9]
        truth = hr_first.get(gpk)
        ids = list(sides[0].pid.astype(int)) + list(sides[1].pid.astype(int))
        p1 = np.concatenate([sides[0].p1.to_numpy(), sides[1].p1.to_numpy()])
        p_any = 1 - counts[0]
        naive = p_any * p1 / p1.sum()
        for i, pid in enumerate(ids):
            rows.append((gpk, pid, counts[i + 1], naive[i], int(truth == pid)))
        rows.append((gpk, 0, counts[0], counts[0], int(truth is None)))   # a bench bat's first homer counts against every starter
    t = pd.DataFrame(rows, columns=["game_pk", "pid", "p", "naive", "y"])
    bats = t[t.pid != 0]
    print(f"\nfirst HR, Aug-Sep 2026: {t.game_pk.nunique()} games, {len(bats):,} bats | first HR by a starter in "
          f"{bats.y.sum()} games, no HR in {int(t[t.pid == 0].y.sum())}")
    print(f"  per-bat logloss: simulated {ll(bats.y.to_numpy(), bats.p.to_numpy()):.5f}  naive split {ll(bats.y.to_numpy(), bats.naive.to_numpy()):.5f}")
    print(f"  mean pred per bat {bats.p.mean()*100:.2f}% vs actual {bats.y.mean()*100:.2f}%")
    bats = bats.assign(bin=pd.qcut(bats.p, 6, labels=False))
    print(bats.groupby("bin").agg(n=("y", "size"), pred=("p", "mean"), naive=("naive", "mean"), actual=("y", "mean")).round(4).to_string())
    nh = t[t.pid == 0]
    print(f"  P(no HR in game): pred {nh.p.mean()*100:.1f}% vs actual {nh.y.mean()*100:.1f}%")


def main():
    te, df = oos_p1()
    dist = pa_dist(df)
    q = two_plus(te, dist)
    first_hr(te, q)


if __name__ == "__main__":
    main()
