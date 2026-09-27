"""What Kalshi's Combos charge for same-game legs (research).

    python3 research/sgp_kalshi.py      # writes research/sgp_kalshi.json

Kalshi's Combos (multivariate markets) are its legal parlays. Open ones are
priced on request (RFQ) — invisible without an API key — but settled ones keep
the legs and the price they last traded at. So for every settled, traded
same-game combo: each leg's own pre-game price (hourly candle before first
pitch / kickoff) and the combo's traded price. price / product of legs is the
market makers' correlation AND margin together, by leg-type combination — what
an exchange SGP costs, and whether it leans the same way our measured
correlations do.
"""
import json, os, re, sys, time
from concurrent.futures import ThreadPoolExecutor
from collections import defaultdict
import numpy as np
sys.path.insert(0, os.path.dirname(__file__))
import mlb_hr_kalshi as K

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "sgp_kalshi.json")
SERIES = ["KXMVESPORTSMULTIGAMEEXTENDED", "KXMVECROSSCATEGORY", "KXMVENFLSINGLEGAME"]
GAME = re.compile(r"^(KX[A-Z0-9]+?)-(\d\d[A-Z]{3}\d\d\d{0,4}[A-Z]+)")   # series, game code


def legtype(event_ticker):
    s = event_ticker.split("-")[0]
    return s.replace("KX", "")


def settled_combos(series, pages=40):
    out, cur = [], ""
    for _ in range(pages):
        j = K.get(f"{K.API}/markets?series_ticker={series}&status=settled&limit=1000" + (f"&cursor={cur}" if cur else ""))
        if not j: break
        for m in j.get("markets", []):
            legs = m.get("mve_selected_legs") or []
            if len(legs) < 2 or not (float(m.get("volume_fp") or 0) > 0) or not m.get("last_price_dollars"): continue
            games = set()
            for l in legs:
                g = GAME.match(l["event_ticker"]); games.add(g.group(2)[:7] + g.group(2)[-6:] if g else l["event_ticker"])
            gcode = {GAME.match(l["event_ticker"]).group(2) if GAME.match(l["event_ticker"]) else None for l in legs}
            if len(gcode) != 1 or None in gcode: continue                  # one game only
            out.append({"t": m["ticker"], "price": float(m["last_price_dollars"]), "vol": float(m["volume_fp"]),
                        "legs": [{"mk": l["market_ticker"], "ev": l["event_ticker"], "side": l["side"]} for l in legs]})
        cur = j.get("cursor")
        if not cur: break
    return out


def leg_price(mk, ev):
    """Last hourly YES price before the game starts (the event ticker's time)."""
    m = re.search(r"-(\d\d)([A-Z]{3})(\d\d)(\d\d)(\d\d)", ev)
    if not m: return None
    from datetime import datetime
    yy, mon, dd, hh, mi = m.groups()
    st = int(datetime(2000 + int(yy), K.MON[mon], int(dd), int(hh), int(mi), tzinfo=K.ET).timestamp())
    series = ev.split("-")[0]
    j = K.get(f"{K.API}/series/{series}/markets/{mk}/candlesticks?start_ts={st - 36 * 3600}&end_ts={st}&period_interval=60")
    c = [x for x in (j or {}).get("candlesticks", []) if x["end_period_ts"] <= st]
    if not c: return None
    last = c[-1]
    a = last.get("yes_ask", {}).get("close_dollars") or last.get("yes_ask", {}).get("close")
    b = last.get("yes_bid", {}).get("close_dollars") or last.get("yes_bid", {}).get("close")
    if a is None or b is None: return None
    a, b = float(a), float(b)
    return (a + b) / 2 if a > 0 and b > 0 and a < 1 else None


def main():
    combos = []
    for s in SERIES:
        c = settled_combos(s); print(f"{s}: {len(c)} traded single-game combos", flush=True); combos += c
    legs = sorted({(l["mk"], l["ev"]) for c in combos for l in c["legs"]})
    print(f"pricing {len(legs)} legs…", flush=True)
    with ThreadPoolExecutor(6) as ex:
        P = dict(zip(legs, ex.map(lambda x: leg_price(*x), legs)))
    groups = defaultdict(list); rows = []
    for c in combos:
        ps = []
        for l in c["legs"]:
            p = P.get((l["mk"], l["ev"]))
            if p is None: ps = None; break
            ps.append(p if l["side"] == "yes" else 1 - p)
        if not ps: continue
        prod = float(np.prod(ps)); ratio = c["price"] / prod
        key = " + ".join(sorted(f"{legtype(l['ev'])}:{l['side']}" for l in c["legs"]))
        groups[key].append(ratio); rows.append({**c, "prod": prod, "ratio": ratio, "key": key})
    print(f"\n{len(rows)} combos with every leg priced · overall median price/product {np.median([r['ratio'] for r in rows]):.3f}\n")
    summ = []
    for k, v in sorted(groups.items(), key=lambda kv: -len(kv[1])):
        if len(v) < 5: continue
        summ.append({"legs": k, "n": len(v), "median_ratio": round(float(np.median(v)), 3), "iqr": [round(float(np.percentile(v, 25)), 3), round(float(np.percentile(v, 75)), 3)]})
        print(f"  {k:60s} n {len(v):4d}  median price/product {np.median(v):.3f}  IQR {np.percentile(v, 25):.2f}-{np.percentile(v, 75):.2f}")
    json.dump({"summary": summ, "n": len(rows)}, open(OUT, "w"), indent=1)
    print(f"wrote {OUT}")


if __name__ == "__main__":
    main()
