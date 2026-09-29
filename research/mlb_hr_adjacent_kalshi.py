"""Kalshi's homer-adjacent markets — 4+ total bases, 3+ hits+runs+RBIs — pre-game (research).

    python3 research/mlb_hr_adjacent_kalshi.py index    # every settled TB 4+ / HRR 3+ market, Aug-Sep 2026
    python3 research/mlb_hr_adjacent_kalshi.py prices   # pre-game prices for the batter-games we priced

A homer wins both on its own (a solo shot is 4 TB and H+R+RBI = 3), so each is
the HR market plus the ways to get there without one. research/mlb_hr_adjacent.py
asks what that extra costs. Same machinery as mlb_hr_kalshi.py (public API,
hourly candlesticks, the last YES ask/bid before first pitch); only the rows in
mlb_hr_roi_model.parquet (Aug 1 - Sep 25, our HR price + Kalshi's) with our HR
price >= P_MIN are fetched — the bats you'd actually be looking at.
Cached under research/.cache/kalshi_adj/.
"""
import json, os, re, sys
from concurrent.futures import ThreadPoolExecutor
import pandas as pd
import mlb_hr_kalshi as K

HERE = os.path.dirname(os.path.abspath(__file__))
CACHE = os.path.join(HERE, ".cache", "kalshi_adj")
SERIES = {"tb4": ("KXMLBTB", r"^(.*?):\s*4\+ total bases"), "hrr3": ("KXMLBHRR", r"^(.*?):\s*3\+ hits \+ runs \+ RBIs")}
P_MIN = 0.11


def parse_event(t):
    return K.parse_event(re.sub(r"^KXMLB[A-Z]+-", "KXMLBHR-", t))


def index():
    os.makedirs(CACHE, exist_ok=True)
    for key, (series, rx) in SERIES.items():
        out, cur = [], ""
        while True:
            j = K.get(f"{K.API}/markets?series_ticker={series}&status=settled&limit=1000" + (f"&cursor={cur}" if cur else ""))
            if not j: break
            for m in j.get("markets", []):
                t = re.match(rx, m.get("title", ""))
                if not t: continue
                date, start = parse_event(m["event_ticker"])
                if date and date >= "2026-08-01":
                    out.append({"ticker": m["ticker"], "event": m["event_ticker"], "date": date, "start": start,
                                "name": t.group(1), "key": K.norm(t.group(1)), "result": m.get("result")})
            cur = j.get("cursor")
            if not cur or not j.get("markets"): break
        json.dump(out, open(os.path.join(CACHE, f"index-{key}.json"), "w"))
        print(f"{series}: {len(out)} settled markets since Aug 1", flush=True)


def pregame(series, m):
    j = K.get(f"{K.API}/series/{series}/markets/{m['ticker']}/candlesticks?start_ts={m['start'] - 36 * 3600}&end_ts={m['start']}&period_interval=60")
    c = [x for x in (j or {}).get("candlesticks", []) if x["end_period_ts"] <= m["start"]]
    if not c: return None
    last = c[-1]
    ask = last.get("yes_ask", {}).get("close_dollars"); bid = last.get("yes_bid", {}).get("close_dollars")
    return {"ask": float(ask) if ask else None, "bid": float(bid) if bid else None}


def prices():
    R = pd.read_parquet(os.path.join(HERE, "mlb_hr_roi_model.parquet"))
    R = R[R.p >= P_MIN]
    want = {(d, K.norm(n)) for d, n in zip(R.date, R.name)}
    for key, (series, _) in SERIES.items():
        idx = [m for m in json.load(open(os.path.join(CACHE, f"index-{key}.json"))) if (m["date"], m["key"]) in want]
        f = os.path.join(CACHE, f"prices-{key}.json")
        have = json.load(open(f)) if os.path.exists(f) else {}
        need = [m for m in idx if m["ticker"] not in have]
        print(f"{series}: {len(idx)} markets for our bats, {len(need)} to fetch", flush=True)
        with ThreadPoolExecutor(6) as ex:
            for i, (m, p) in enumerate(zip(need, ex.map(lambda m: pregame(series, m), need))):
                have[m["ticker"]] = p
                if i % 1000 == 999:
                    json.dump(have, open(f, "w")); print(f"  {i + 1}/{len(need)}", flush=True)
        json.dump(have, open(f, "w"))


if __name__ == "__main__":
    {"index": index, "prices": prices}[sys.argv[1]]()
