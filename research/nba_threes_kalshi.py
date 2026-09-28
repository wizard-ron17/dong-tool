"""Our NBA ladders vs Kalshi's pre-game prices, 2025-26 regular season (research).

    python3 research/nba_threes_kalshi.py [n]                                  # threes
    python3 research/nba_threes_kalshi.py n KXNBAPTS nba_points_oos.parquet nb_  # points

Kalshi's KXNBA3PT markets ("Player: N+ threes") from the archive, matched to
nba_threes.py's walk-forward prices (nba_threes_oos.parquet) by date, name and
rung. Kalshi's price is the last hourly candle's bid/ask mid before tip
(occurrence_datetime is the scheduled end, ~3h after tip). Two-sided books
only. Reports log loss, outcome ~ logit(Kalshi) + logit(ours), and what betting
our edges at the ask would have returned — the same tests as MLB HR vs Kalshi.
"""
import os, random, re, time
from datetime import datetime, timedelta, timezone
from concurrent.futures import ThreadPoolExecutor
import numpy as np
import pandas as pd
import mlb_hr_kalshi as K

HERE = os.path.dirname(os.path.abspath(__file__))
MON = K.MON


def markets(series, pages=12):
    out, cur = [], ""
    for _ in range(pages):
        j = K.get(f"{K.API}/historical/markets?series_ticker={series}&limit=1000" + (f"&cursor={cur}" if cur else "")) or {}
        out += j.get("markets", []); cur = j.get("cursor")
        if not cur: break
        time.sleep(0.3)
    return out


def price(m):
    # tip: the scheduled end less ~3h, or (older records carry no end) the close less 3.5h
    if m.get("occurrence_datetime"):
        tip = int((datetime.fromisoformat(m["occurrence_datetime"].replace("Z", "+00:00")) - timedelta(hours=3)).timestamp())
    elif m.get("close_time"):
        tip = int((datetime.fromisoformat(m["close_time"].replace("Z", "+00:00")) - timedelta(hours=3.5)).timestamp())
    else:
        return None
    # archived markets serve their candles from the archive, with plain "close" prices
    j = K.get(f"{K.API}/historical/markets/{m['ticker']}/candlesticks?start_ts={tip - 30 * 3600}&end_ts={tip}&period_interval=60") or {}
    c = [x for x in j.get("candlesticks", []) if x["end_period_ts"] <= tip]
    if not c: return None
    px = lambda side: c[-1].get(side, {}).get("close", c[-1].get(side, {}).get("close_dollars"))
    a = px("yes_ask"); b = px("yes_bid")
    if a is None or b is None: return None
    a, b = float(a), float(b)
    return (a, b) if 0 < b <= a < 1 else None


def ll(p, y): p = np.clip(p, 1e-4, 1 - 1e-4); return float(-(y * np.log(p) + (1 - y) * np.log(1 - p)).mean())


def main(n_sample=900, series="KXNBA3PT", oos="nba_threes_oos.parquet", col="n_"):
    R = pd.read_parquet(os.path.join(HERE, oos))
    if "c_dd" in R: R["x_2"], R["x_3"] = R.c_dd, R.c_td        # double / triple-double as "rungs" 2 and 3
    R = R[R.season == R.season.max()].copy(); R["key"] = R.name.map(K.norm) + "|" + R.date
    M = markets(series)
    have = {int(c[len(col):]) for c in R.columns if c.startswith(col) and c[len(col):].isdigit()}
    rows = []
    for m in M:
        t = re.match(r"^(.*?):\s*(\d+)\+", m.get("title") or ""); d = re.search(r"-(\d\d)([A-Z]{3})(\d\d)", m["event_ticker"])
        dt_ = re.match(r"^(.*?):\s*(Double|Triple) Double", m.get("title") or "")
        if dt_: t = None; nm, k = dt_.group(1), 2 if dt_.group(2) == "Double" else 3
        elif t: nm, k = t.group(1), int(t.group(2))
        if not (t or dt_) or not d or m.get("result") not in ("yes", "no"): continue
        date = f"20{d.group(1)}-{MON[d.group(2)]:02d}-{int(d.group(3)):02d}"
        if k not in have: continue
        rows.append({"key": K.norm(nm) + "|" + date, "k": k, "y": float(m["result"] == "yes"), "m": m})
    Q = pd.DataFrame(rows).merge(R, on="key")
    Q["ours"] = [r[f"{col}{k}"] for k, (_, r) in zip(Q.k, Q.iterrows())]
    print(f"{len(M):,} archived markets · {len(Q):,} matched to our regular-season prices")
    random.seed(0); S = Q.sample(min(n_sample, len(Q)), random_state=0).reset_index(drop=True)
    with ThreadPoolExecutor(4) as ex: px = list(ex.map(lambda m: price(m), S.m))
    S["ask"] = [p[0] if p else np.nan for p in px]; S["bid"] = [p[1] if p else np.nan for p in px]
    S = S.dropna(subset=["ask"]); S["mid"] = (S.ask + S.bid) / 2
    y = S.y.values
    print(f"{len(S):,} with a two-sided pre-game book · hit {y.mean():.3f}, ours {S.ours.mean():.3f}, Kalshi mid {S.mid.mean():.3f}, avg spread {(S.ask - S.bid).mean() * 100:.1f}c\n")
    print(f"log loss   ours {ll(S.ours, y):.5f}   Kalshi mid {ll(S.mid, y):.5f}")
    lg = lambda p: np.log(np.clip(p, 1e-4, 1 - 1e-4) / (1 - np.clip(p, 1e-4, 1 - 1e-4)))
    X = np.column_stack([np.ones(len(S)), lg(S.mid), lg(S.ours)]); b = np.zeros(3)
    for _ in range(40):
        p = 1 / (1 + np.exp(-X @ b)); W = p * (1 - p); H = X.T @ (X * W[:, None])
        b += np.linalg.solve(H + 1e-8 * np.eye(3), X.T @ (y - p))
    se = np.sqrt(np.diag(np.linalg.inv(H)))
    print(f"outcome ~ logit(Kalshi) + logit(ours): Kalshi {b[1]:+.2f} (z {b[1] / se[1]:.1f}), ours {b[2]:+.2f} (z {b[2] / se[2]:.1f})")
    print(f"correlation ours vs mid {np.corrcoef(S.ours, S.mid)[0, 1]:.3f}\n")
    fee = lambda a: 0.07 * a * (1 - a)
    for thr in (0.0, 0.05, 0.10):
        pnl = []
        for _, r in S.iterrows():
            ya, na = r.ask, 1 - r.bid
            eo = (r.ours - ya - fee(ya)) / (ya + fee(ya)); eu = ((1 - r.ours) - na - fee(na)) / (na + fee(na))
            if max(eo, eu) <= thr: continue
            yes = eo > eu; cost = (ya + fee(ya)) if yes else (na + fee(na)); win = (r.y == 1) if yes else (r.y == 0)
            pnl.append((1 / cost - 1) if win else -1)
        if pnl: print(f"bet where our edge > {thr:.0%} at the ask (fees in): {len(pnl)} bets, ROI {np.mean(pnl) * 100:+.1f}% ± {np.std(pnl) / np.sqrt(len(pnl)) * 100:.1f}")
    print("\nby rung (log loss ours / Kalshi mid, n):")
    for k, r in S.groupby("k"):
        if len(r) >= 40: print(f"  {k}+  {ll(r.ours, r.y.values):.4f} / {ll(r.mid, r.y.values):.4f}  (n {len(r)}, hit {r.y.mean():.3f}, ours {r.ours.mean():.3f}, mid {r.mid.mean():.3f})")
    S.drop(columns=["m"]).to_parquet(os.path.join(HERE, f"nba_{series.lower()}_kalshi.parquet"))


if __name__ == "__main__":
    import sys
    a = sys.argv[1:]
    main(int(a[0]) if a else 900, *(a[1:4]))
