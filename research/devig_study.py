"""Which devig method, where? Scored against real outcomes (research).

    python3 research/devig_study.py fetch     # ESPN closing lines + finals, cached
    python3 research/devig_study.py           # the comparison

Ron's odds-viewer turns a book's two-sided price into a "fair" probability by
removing the vig — multiplicative, additive, power or probit — and its "Worst
Case" subtracts the WHOLE overround from the side you bet. Which is right
depends on how the book spreads its margin: evenly (multiplicative), or loaded
onto the longshot (the favorite-longshot bias — power / probit shift more of
it there). Measured, not assumed: every two-way closing market ESPN keeps
(ESPN BET: moneylines, spreads, totals) with the game's result, each method's
fair probability scored by log loss — split by how lopsided the price is.

Sports: NFL 2024-25, NBA 2024-25, NHL 2024-25, MLB 2025, and college football
2024 + men's college basketball 2024-25 for the real longshots (+1000 and
beyond). Cached under research/.cache/espn_odds/.
"""
import json, math, os, ssl, sys, time, urllib.request
from concurrent.futures import ThreadPoolExecutor
from datetime import date, timedelta

HERE = os.path.dirname(os.path.abspath(__file__))
CACHE = os.path.join(HERE, ".cache", "espn_odds")
_SSL = ssl._create_unverified_context()
SPORTS = {   # league path, date range, scoreboard extras
    "nfl":   ("football/nfl", [("2024-09-05", "2025-01-05"), ("2025-09-04", "2026-01-04")], ""),
    "nba":   ("basketball/nba", [("2024-10-22", "2025-04-13")], ""),
    "nhl":   ("hockey/nhl", [("2024-10-04", "2025-04-17")], ""),
    "mlb":   ("baseball/mlb", [("2025-03-18", "2025-09-28")], ""),
    "cfb":   ("football/college-football", [("2024-08-24", "2024-12-14")], "&groups=80&limit=300"),
    "cbb":   ("basketball/mens-college-basketball", [("2024-11-04", "2025-03-16")], "&groups=50&limit=500"),
}


def get(url, tries=4):
    for i in range(tries):
        try:
            # no custom User-Agent: ESPN answers 403 to one (the runtime's default goes through)
            with urllib.request.urlopen(url, timeout=30, context=_SSL) as r:
                return json.load(r)
        except Exception:
            time.sleep(1.2 * (i + 1))
    return None


def days(a, b):
    d, e = date.fromisoformat(a), date.fromisoformat(b)
    while d <= e: yield d.strftime("%Y%m%d"); d += timedelta(days=1)


def fetch():
    for sp, (path, ranges, extra) in SPORTS.items():
        os.makedirs(os.path.join(CACHE, sp), exist_ok=True)
        games = []
        for a, b in ranges:
            with ThreadPoolExecutor(8) as ex:
                for d, j in zip(list(days(a, b)), ex.map(lambda d: get(f"https://site.api.espn.com/apis/site/v2/sports/{path}/scoreboard?dates={d}{extra}"), list(days(a, b)))):
                    for e in (j or {}).get("events", []):
                        c = e["competitions"][0]
                        if not c.get("status", {}).get("type", {}).get("completed"): continue
                        side = {x["homeAway"]: x for x in c["competitors"]}
                        try: games.append({"id": e["id"], "date": d, "home": float(side["home"]["score"]), "away": float(side["away"]["score"])})
                        except (KeyError, TypeError, ValueError): pass
        out = os.path.join(CACHE, sp, "odds.jsonl")
        have = set()
        if os.path.exists(out):
            for l in open(out): have.add(json.loads(l)["id"])
        need = [g for g in games if g["id"] not in have]
        print(f"{sp}: {len(games)} finals, {len(need)} to fetch", flush=True)
        lg = path.split("/")
        def odds(g):
            j = get(f"https://sports.core.api.espn.com/v2/sports/{lg[0]}/leagues/{lg[1]}/events/{g['id']}/competitions/{g['id']}/odds")
            items = [i for i in (j or {}).get("items", []) if "Live" not in (i.get("provider", {}).get("name") or "")]
            if not items: return None
            it = items[0]
            c = lambda side, k: ((it.get(side) or {}).get("close") or {}).get(k, {}).get("american")
            return {**g, "book": it.get("provider", {}).get("name"),
                    "mlH": c("homeTeamOdds", "moneyLine"), "mlA": c("awayTeamOdds", "moneyLine"),
                    "spread": it.get("spread"), "spH": c("homeTeamOdds", "spread"), "spA": c("awayTeamOdds", "spread"),
                    "total": ((it.get("close") or {}).get("total") or {}).get("alternateDisplayValue") or it.get("overUnder"),
                    "ov": ((it.get("close") or {}).get("over") or {}).get("american"), "un": ((it.get("close") or {}).get("under") or {}).get("american")}
        with open(out, "a") as f, ThreadPoolExecutor(8) as ex:
            for i, r in enumerate(ex.map(odds, need)):
                if r: f.write(json.dumps(r) + "\n")
                if i % 1000 == 999: print(f"  {i + 1}/{len(need)}", flush=True)


# ── the devig methods, as odds-viewer/index.html devigMarket() does them ──
def am2p(a):
    a = float(str(a).replace("+", "")) if a not in (None, "", "EVEN", "even") else (100.0 if a in ("EVEN", "even") else None)
    if a is None or a == 0: return None
    return 100 / (a + 100) if a > 0 else -a / (-a + 100)
PHI = lambda z: 0.5 * math.erfc(-z / math.sqrt(2))
def PHIINV(p):
    lo, hi = -9.0, 9.0
    for _ in range(80):
        m = (lo + hi) / 2
        if PHI(m) < p: lo = m
        else: hi = m
    return (lo + hi) / 2
def devig(p, method):
    t = sum(p)
    if method == "mult": return [x / t for x in p]
    if method == "add": return [max(0.001, x - (t - 1) / len(p)) for x in p]
    if method == "power":
        lo, hi = 0.01, 20
        for _ in range(64):
            m = (lo + hi) / 2
            if sum(x ** (1 / m) for x in p) > 1: hi = m
            else: lo = m
        k = (lo + hi) / 2; q = [x ** (1 / k) for x in p]; s = sum(q); return [x / s for x in q]
    if method == "probit":
        z = [PHIINV(min(max(x, 1e-4), 1 - 1e-4)) for x in p]; lo, hi = -5, 5
        for _ in range(64):
            m = (lo + hi) / 2
            if sum(PHI(v - m) for v in z) > 1: lo = m
            else: hi = m
        f = [PHI(v - (lo + hi) / 2) for v in z]; s = sum(f); return [x / s for x in f]
    if method == "shin":
        # Shin (1993): insider share z, solved so the fair probabilities sum to 1
        def fair(z): return [(math.sqrt(z * z + 4 * (1 - z) * x * x / t) - z) / (2 * (1 - z)) for x in p]
        lo, hi = 0.0, 0.5
        for _ in range(80):
            z = (lo + hi) / 2
            if sum(fair(z)) > 1: lo = z
            else: hi = z
        q = fair((lo + hi) / 2); s = sum(q); return [x / s for x in q]
    if method == "allvig": return [max(0.001, x - (t - 1)) for x in p]          # odds-viewer's old "Worst Case"
    if method == "worst4":                                                       # the lowest of the four, per side
        ms = [devig(p, m) for m in ("mult", "add", "power", "probit")]; return [min(m[i] for m in ms) for i in range(len(p))]
    raise ValueError(method)
METHODS = ["mult", "add", "power", "probit", "shin", "worst4", "allvig"]


def markets():
    """Every two-way close with its result: (sport, kind, [p_side1, p_side2], side1 won?)."""
    for sp in SPORTS:
        f = os.path.join(CACHE, sp, "odds.jsonl")
        if not os.path.exists(f): continue
        for l in open(f):
            g = json.loads(l)
            if g["home"] == g["away"]: continue
            h, a = am2p(g.get("mlH")), am2p(g.get("mlA"))
            if h and a: yield sp, "moneyline", [h, a], g["home"] > g["away"]
            h, a = am2p(g.get("spH")), am2p(g.get("spA"))
            try: sp_ = float(g.get("spread"))
            except (TypeError, ValueError): sp_ = None
            if h and a and sp_ is not None:
                m = g["home"] - g["away"] + sp_                    # home covers when margin + home spread > 0
                if m != 0: yield sp, "spread", [h, a], m > 0
            o, u = am2p(g.get("ov")), am2p(g.get("un"))
            try: tot = float(str(g.get("total")).lstrip("ou"))
            except (TypeError, ValueError): tot = None
            if o and u and tot:
                pts = g["home"] + g["away"]
                if pts != tot: yield sp, "total", [o, u], pts > tot


def main():
    rows = list(markets())
    print(f"{len(rows):,} two-way closing markets with results\n")
    # band by the underdog's raw price: how lopsided the market is
    def band(p):
        dog = min(p) / sum(p)
        return ("near even (dog 40-50%)" if dog >= 0.40 else "moderate (dog 25-40%)" if dog >= 0.25 else
                "longshot (dog 10-25%)" if dog >= 0.10 else "big longshot (dog < 10%)")
    B = {}
    for sp, kind, p, y in rows: B.setdefault(band(p), []).append((p, y))
    ll = lambda q, y: -math.log(max(1e-6, q if y else 1 - q))
    print(f"{'band':28s} {'n':>6s} {'hold':>6s}  " + "  ".join(f"{m:>7s}" for m in METHODS) + "   (log loss of the side-1 fair prob, lower is better)")
    for b in ["near even (dog 40-50%)", "moderate (dog 25-40%)", "longshot (dog 10-25%)", "big longshot (dog < 10%)"]:
        R = B.get(b, [])
        if not R: continue
        hold = sum(sum(p) - 1 for p, _ in R) / len(R)
        # worst4 / allvig don't sum to 1: score the side-1 estimate as given
        L = {m: sum(ll(devig(p, m)[0], y) for p, y in R) / len(R) for m in METHODS}
        best = min((m for m in METHODS if m not in ("worst4", "allvig")), key=L.get)
        print(f"{b:28s} {len(R):6,} {hold:6.1%}  " + "  ".join(f"{L[m]:7.4f}{'*' if m == best else ' '}" for m in METHODS))
    # the underdog side itself: each method's fair chance vs how often dogs actually won
    print(f"\nthe UNDERDOG side, by its raw price: fair chance per method vs actual win rate")
    print(f"{'dog raw implied':20s} {'n':>6s} {'actual':>7s}  " + "  ".join(f"{m:>7s}" for m in METHODS))
    D = []
    for sp, kind, p, y in rows:
        i = 0 if p[0] < p[1] else 1
        D.append((p, i, y if i == 0 else not y))
    for lo, hi in [(0.40, 0.50), (0.30, 0.40), (0.20, 0.30), (0.12, 0.20), (0.06, 0.12), (0, 0.06)]:
        R = [(p, i, w) for p, i, w in D if lo <= p[i] < hi]
        if len(R) < 60: continue
        act = sum(w for _, _, w in R) / len(R)
        print(f"{f'{lo:.0%}-{hi:.0%}':20s} {len(R):6,} {act:7.3f}  " + "  ".join(f"{sum(devig(p, m)[i] for p, i, _ in R) / len(R):7.3f}" for m in METHODS))
    # by market type, all bands
    print(f"\nby market (log loss):")
    for kind in ("moneyline", "spread", "total"):
        R = [(p, y) for sp, k, p, y in rows if k == kind]
        if R: print(f"  {kind:10s} {len(R):6,}  " + "  ".join(f"{m} {sum(ll(devig(p, m)[0], y) for p, y in R) / len(R):.4f}" for m in METHODS[:5]))


if __name__ == "__main__":
    fetch() if len(sys.argv) > 1 and sys.argv[1] == "fetch" else main()
