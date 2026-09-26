"""Kalshi's settled MLB home-run markets and their pre-game prices (research).

    python3 research/mlb_hr_kalshi.py index      # every settled 1+ HR market
    python3 research/mlb_hr_kalshi.py prices     # pre-game ask for the ones we need

Kalshi keeps every settled KXMLBHR market (one event per game, one market per
player and rung) with hourly candlesticks, including the YES ask. That makes a
real ROI backtest possible: the price you could have bought at just before first
pitch, not a guess. Public API, no key. Cached under research/.cache/kalshi_hr/.

Event tickers read KXMLBHR-26SEP252215LADSF: date, first pitch (ET, 24h), then
the two clubs. Market titles read "Teoscar Hernández: 1+ home runs?".
"""
import json
import os
import re
import sys
import time
import unicodedata
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime
from zoneinfo import ZoneInfo

import ssl
try:
    import certifi
    _SSL = ssl.create_default_context(cafile=certifi.where())
except ImportError:
    _SSL = ssl.create_default_context()

API = "https://api.elections.kalshi.com/trade-api/v2"
HERE = os.path.dirname(os.path.abspath(__file__))
CACHE = os.path.join(HERE, ".cache", "kalshi_hr")
INDEX = os.path.join(CACHE, "index.json")
PRICES = os.path.join(CACHE, "prices.json")
ET = ZoneInfo("America/New_York")
MON = {m: i for i, m in enumerate(["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"], 1)}


def get(url, tries=5):
    for i in range(tries):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": "dong-tool-research"}), timeout=30, context=_SSL) as r:
                return json.load(r)
        except Exception:
            time.sleep(1.5 * (i + 1))
    return None


def norm(s):
    s = unicodedata.normalize("NFD", s or "").encode("ascii", "ignore").decode().lower()
    s = re.sub(r"[.'’`-]", " ", s)
    s = re.sub(r"\b(jr|sr|ii|iii|iv|v)\b", " ", s)
    return re.sub(r"\s+", " ", s).strip()


def parse_event(t):
    """KXMLBHR-26SEP252215LADSF -> (date 'YYYY-MM-DD', first pitch as epoch seconds)."""
    m = re.match(r"KXMLBHR-(\d\d)([A-Z]{3})(\d\d)(\d\d)(\d\d)", t)
    if not m:
        return None, None
    yy, mon, dd, hh, mi = m.groups()
    dt = datetime(2000 + int(yy), MON[mon], int(dd), int(hh), int(mi), tzinfo=ET)
    return dt.strftime("%Y-%m-%d"), int(dt.timestamp())


def index():
    """Every settled 1+ HR market: ticker, event, date, first pitch, player, result."""
    os.makedirs(CACHE, exist_ok=True)
    out, pages = [], 0
    # recent settled markets, then the archive (Kalshi moves older settled
    # markets to /historical — before its cutoff, late July in 2026)
    for base in (f"{API}/markets?series_ticker=KXMLBHR&status=settled&limit=1000", f"{API}/historical/markets?series_ticker=KXMLBHR&limit=1000"):
      cur = ""
      while True:
        j = get(base + (f"&cursor={cur}" if cur else ""))
        if not j:
            break
        for m in j.get("markets", []):
            t = re.match(r"^(.*?):\s*1\+", m.get("title", ""))
            if not t:
                continue
            date, start = parse_event(m["event_ticker"])
            if not date:
                continue
            out.append({"ticker": m["ticker"], "event": m["event_ticker"], "date": date, "start": start,
                        "name": t.group(1), "key": norm(t.group(1)), "result": m.get("result")})
        pages += 1
        cur = j.get("cursor")
        if not cur or not j.get("markets"):
            break
    seen = set()
    out = [m for m in out if not (m["ticker"] in seen or seen.add(m["ticker"]))]
    json.dump(out, open(INDEX, "w"))
    dates = sorted({x["date"] for x in out})
    print(f"indexed {len(out)} settled 1+ HR markets over {len(dates)} dates ({dates[0]} … {dates[-1]}), {pages} pages")


def pregame_ask(m):
    """The last hourly YES ask before first pitch (and the bid, for the mid)."""
    j = get(f"{API}/series/KXMLBHR/markets/{m['ticker']}/candlesticks?start_ts={m['start'] - 36 * 3600}&end_ts={m['start']}&period_interval=60")
    c = [x for x in (j or {}).get("candlesticks", []) if x["end_period_ts"] <= m["start"]]
    if not c:
        return None
    last = c[-1]
    ask = last.get("yes_ask", {}).get("close_dollars"); bid = last.get("yes_bid", {}).get("close_dollars")
    return {"ask": float(ask) if ask else None, "bid": float(bid) if bid else None, "ts": last["end_period_ts"]}


def prices(tickers):
    """Pre-game prices for these tickers, cached; returns {ticker: {...}}."""
    have = json.load(open(PRICES)) if os.path.exists(PRICES) else {}
    idx = {m["ticker"]: m for m in json.load(open(INDEX))}
    need = [t for t in tickers if t not in have and t in idx]
    print(f"prices: {len(have)} cached, fetching {len(need)}", flush=True)
    with ThreadPoolExecutor(6) as ex:
        for i, (t, p) in enumerate(zip(need, ex.map(lambda t: pregame_ask(idx[t]), need))):
            have[t] = p
            if i % 500 == 499:
                json.dump(have, open(PRICES, "w")); print(f"  {i + 1}/{len(need)}", flush=True)
    json.dump(have, open(PRICES, "w"))
    return have


if __name__ == "__main__" and len(sys.argv) > 1 and sys.argv[1] == "index":
    index()
