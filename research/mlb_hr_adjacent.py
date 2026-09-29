"""Homer-adjacent markets: attack the same bats with o3.5 TB or o2.5 H+R+RBI instead? (research)

    python3 research/mlb_hr_adjacent.py

A homer wins both on its own — a solo shot is 4 total bases and H+R+RBI = 3 —
so each market is the HR bet plus every way of getting there without one.
Three questions:
  1. How often does each hit WITHOUT a homer? (box scores, every starter
     2025-26 — research/mlb_hr_replay_fetch.py — and our HR targets)
  2. Do we pay for the extra wins? Kalshi's pre-game price vs how often each
     actually hit, on the same batter-games (Aug 1 - Sep 25 2026, our HR
     price >= 11%: research/mlb_hr_adjacent_kalshi.py)
  3. Safer, or just smaller? Flat 1 unit on each market for the same bats, at
     the ask with Kalshi's taker fee: hit rate, average odds, ROI, the worst
     losing run and the spread of a 100-bet stretch.
"""
import json, os
import numpy as np
import pandas as pd
import mlb_hr_kalshi as K

HERE = os.path.dirname(os.path.abspath(__file__))
FEE = lambda a: 0.07 * a * (1 - a)
am = lambda p: '—' if not (0 < p < 1) else (f"{-100 * p / (1 - p):.0f}" if p >= 0.5 else f"+{100 * (1 - p) / p:.0f}")


def main():
    B = pd.read_parquet(os.path.join(HERE, "mlb_hr_replay_raw.parquet"))
    B["hrr"] = B.h + B.r + B.rbi
    B["TB4"], B["HRR3"], B["HR"] = B.tb >= 4, B.hrr >= 3, B.hr >= 1

    # ── 1. without a homer ───────────────────────────────────────────────
    def line(d, lab):
        n = len(d); hr, tb, hh = d.HR.mean(), d.TB4.mean(), d.HRR3.mean()
        tb0, hh0 = (d.TB4 & ~d.HR).mean(), (d.HRR3 & ~d.HR).mean()
        print(f"  {lab:34s} n {n:7,}  HR {hr:5.1%}  TB4+ {tb:5.1%} (no-HR {tb0:5.1%}, {tb0 / tb:4.0%} of its wins)  HRR3+ {hh:5.1%} (no-HR {hh0:5.1%}, {hh0 / hh:4.0%})")
    print("1. How often each hits, and how much of it comes without a homer")
    line(B, "every starter 2025-26")
    # power, by his season HR rate (descriptive: in-season)
    rate = B.groupby(["season", "pid"]).apply(lambda d: d.hr.sum() / max(1, d.pa.sum()), include_groups=False).rename("hrpa")
    B = B.merge(rate.reset_index(), on=["season", "pid"])
    for lo, hi, lab in [(0, .02, "HR/PA under 2%"), (.02, .035, "HR/PA 2-3.5%"), (.035, .05, "HR/PA 3.5-5%"), (.05, 1, "HR/PA 5%+ (sluggers)")]:
        line(B[(B.hrpa >= lo) & (B.hrpa < hi)], lab)
    R = pd.read_parquet(os.path.join(HERE, "mlb_hr_roi_model.parquet"))[["date", "game_pk", "pid", "name", "p", "ask", "bid"]]
    R = R.merge(B[["game_pk", "pid", "HR", "TB4", "HRR3", "tb", "hrr", "slot"]], on=["game_pk", "pid"])
    print(f"\n  our HR targets (Aug 1 - Sep 25 2026, our price), n {len(R):,}:")
    for lo, hi in [(0, .11), (.11, .14), (.14, .17), (.17, 1)]:
        line(R[(R.p >= lo) & (R.p < hi)], f"our HR price {lo:.0%}-{hi:.0%}" if hi < 1 else f"our HR price {lo:.0%}+")
    # the extra wins, as a multiple of the homer: P(TB4) / P(HR) by our price
    print("\n  each homer 'buys' how many adjacent wins (P(market) / P(HR)):")
    for lo, hi in [(.11, .14), (.14, .17), (.17, 1)]:
        d = R[(R.p >= lo) & (R.p < hi)]
        print(f"    our HR price {lo:.0%}{'-' + format(hi, '.0%') if hi < 1 else '+'}: TB4+ {d.TB4.mean() / d.HR.mean():.2f}x   HRR3+ {d.HRR3.mean() / d.HR.mean():.2f}x")

    # ── 2 and 3. what the market charges, and what flat betting returned ──
    C = os.path.join(HERE, ".cache", "kalshi_adj")
    mk = {}
    for key in ("tb4", "hrr3"):
        idx = pd.DataFrame(json.load(open(os.path.join(C, f"index-{key}.json"))))
        pr = json.load(open(os.path.join(C, f"prices-{key}.json")))
        idx["ask_" + key] = idx.ticker.map(lambda t: (pr.get(t) or {}).get("ask"))
        idx["bid_" + key] = idx.ticker.map(lambda t: (pr.get(t) or {}).get("bid"))
        idx["res_" + key] = idx.result.eq("yes")
        mk[key] = idx[["date", "key", "ask_" + key, "bid_" + key, "res_" + key]].drop_duplicates(["date", "key"])
    R["key"] = R.name.map(K.norm)
    M = R[R.p >= 0.11].merge(mk["tb4"], on=["date", "key"]).merge(mk["hrr3"], on=["date", "key"])
    M = M.dropna(subset=["ask", "ask_tb4", "ask_hrr3"])
    print(f"\n2. What Kalshi charges — {len(M):,} batter-games with all three priced (our HR price 11%+)")
    print(f"   {'market':14s} {'ask':>6s} {'mid':>6s} {'actual':>7s} {'ask / actual':>13s}  typical odds at the ask")
    for lab, a, b, y in [("HR 1+", "ask", "bid", "HR"), ("TB 4+", "ask_tb4", "bid_tb4", "TB4"), ("H+R+RBI 3+", "ask_hrr3", "bid_hrr3", "HRR3")]:
        ask, mid, act = M[a].mean(), ((M[a] + M[b].fillna(M[a])) / 2).mean(), M[y].mean()
        print(f"   {lab:14s} {ask:6.3f} {mid:6.3f} {act:7.3f} {ask / act:13.2f}  {am(ask)}")
    print("   (ask / actual above 1 = you pay more than it hits: the house's cut plus any mispricing)")

    print("\n3. Flat 1 unit on every one of these bats, at the ask with the taker fee")
    rng = np.random.default_rng(3)
    for lab, a, y in [("HR 1+", "ask", "HR"), ("TB 4+", "ask_tb4", "TB4"), ("H+R+RBI 3+", "ask_hrr3", "HRR3")]:
        cost = M[a] + FEE(M[a]); pl = np.where(M[y], 1 / cost - 1, -1.0)
        runs, cur = [], 0
        for w in M[y].to_numpy():
            cur = 0 if w else cur + 1; runs.append(cur)
        boots = [pl[rng.integers(0, len(pl), 100)].sum() for _ in range(4000)]
        print(f"   {lab:12s} hit {M[y].mean():5.1%} · avg ask {am(M[a].mean())} · ROI {pl.mean() * 100:+5.1f}% ± {pl.std() / np.sqrt(len(pl)) * 100:.1f}"
              f" · worst losing run {max(runs)} · 100 bets: 10th-90th pct {np.percentile(boots, 10):+.1f}u to {np.percentile(boots, 90):+.1f}u")
    # the same, only where OUR HR price beats Kalshi's HR ask (the bets you'd actually make)
    E = M[M.p > M.ask + FEE(M.ask)]
    print(f"\n   ...only the bats where our HR price beats Kalshi's HR ask ({len(E):,}):")
    for lab, a, y in [("HR 1+", "ask", "HR"), ("TB 4+", "ask_tb4", "TB4"), ("H+R+RBI 3+", "ask_hrr3", "HRR3")]:
        cost = E[a] + FEE(E[a]); pl = np.where(E[y], 1 / cost - 1, -1.0)
        print(f"   {lab:12s} hit {E[y].mean():5.1%} · avg ask {am(E[a].mean())} · ROI {pl.mean() * 100:+5.1f}% ± {pl.std() / np.sqrt(len(pl)) * 100:.1f}")
    M.to_parquet(os.path.join(HERE, "mlb_hr_adjacent.parquet"))


if __name__ == "__main__":
    main()
