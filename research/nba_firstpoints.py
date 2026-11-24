"""First POINTS (free throws count): what most books sell as "first basket" (11/24).

    python3 research/nba_firstpoints.py

FanDuel's First Basket, DraftKings' 1st Points Scorer, theScore's "(Incld. Free Throws)", Hard Rock's First Player
To Score and PropBuilder's First Point Scorer all settle on the game's first points, free throws in. Only BetMGM's
First Field Goal Scorer is what the build priced. Ron 11/24: one market, priced the way the books settle it.

    P(he scores first points) = (1 - f) x P(he scores the first field goal)          the build's price, unchanged
                              + f x P(his team goes to the line first) x his share of his five's free throws

f = how often a game opens with free throws. Checked walk-forward by season (each season scored on the ones before):
  1. f, season by season
  2. in free-throw openers: which team (tip winner? favourite? the other side of the first FG?)
  3. in free-throw openers: which of his five (free throws a game ^ b, against shots a game and a flat 1/5)
"""
import glob, json, os
from collections import defaultdict
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))


def load():
    G = []
    for f in glob.glob(os.path.join(HERE, ".cache", "nba", "*", "*.json")):
        d = json.load(open(f)); g = d["game"]
        if g["type"] != 2 or not g.get("first_fg") or not isinstance(g.get("first_pts"), dict): continue
        g["players"] = d["players"]; G.append(g)
    G.sort(key=lambda g: (g["date"], g["id"]))
    return G


def main():
    G = load()
    seasons = sorted({g["season"] for g in G})
    isft = lambda g: "free throw" in str(g["first_pts"].get("type", "")).lower()
    print(f"{len(G):,} regular-season games, {seasons[0]}..{seasons[-1]}\n")

    # 1) f by season, and the trailing estimate the build would use
    print("1) games opening with free throws")
    for s in seasons:
        S = [g for g in G if g["season"] == s]
        print(f"   {s}: {np.mean([isft(g) for g in S]):.3f}  ({len(S)} games)")

    # season-to-date per-game stats before each game (+ last season at half weight), per player
    acc = defaultdict(lambda: defaultdict(float))          # (season, pid) -> totals
    rows = []                                                # one per free-throw opener: its ten starters' features
    allrows = []                                             # one per game: team-first features
    for g in G:
        s = g["season"]; prev = seasons[seasons.index(s) - 1] if seasons.index(s) else None
        st = [p for p in g["players"] if p.get("starter")]
        def per(pid, k):
            a, b = acc[(s, pid)], acc[(prev, pid)] if prev else {}
            gp = a.get("gp", 0) + 0.5 * b.get("gp", 0)
            return (a.get(k, 0) + 0.5 * b.get(k, 0)) / gp if gp else None
        if len(st) == 10:
            fp = g["first_pts"]; ftT = fp["team"] if isft(g) else None
            feats = [{"pid": str(p["pid"]), "team": p["team"], "fta": per(str(p["pid"]), "fta"), "fga": per(str(p["pid"]), "fga"),
                      "pf_opp": None} for p in st]
            allrows.append({"season": s, "ft": isft(g), "ftT": ftT, "fgT": g["first_fg"]["team"], "tip": g.get("tip_team"),
                            "home": g["home"], "spread": g.get("spread"), "who": str(fp["pid"]), "feats": feats})
        for p in g["players"]:
            if p.get("dnp") or not p.get("min"): continue
            a = acc[(s, str(p["pid"]))]; a["gp"] += 1
            for k in ("fta", "fga"): a[k] += p.get(k) or 0

    FT = [r for r in allrows if r["ft"]]
    print(f"\n2) which team goes to the line first ({len(FT)} free-throw openers with ten starters)")
    t = [r for r in FT if r["tip"]]
    print(f"   the team that won the tip: {np.mean([r['ftT'] == r['tip'] for r in t]):.3f}  ({len(t)})")
    fav = [r for r in FT if r["spread"] not in (None, 0)]
    favT = lambda r: r["home"] if r["spread"] < 0 else ([f["team"] for f in r["feats"] if f["team"] != r["home"]] or [None])[0]
    print(f"   the favourite: {np.mean([r['ftT'] == favT(r) for r in fav]):.3f}  ({len(fav)})")
    print(f"   the home team: {np.mean([r['ftT'] == r['home'] for r in FT]):.3f}")
    # in all games: does the first-FG team model carry over to first points? first-points team = first-FG team how often
    print(f"   (all games: first-points team = first-FG team {np.mean([ (r['ftT'] or r['fgT']) == r['fgT'] for r in allrows]):.3f})")

    # 3) within the five: the shooter of the opening free throws
    print("\n3) who on that team (walk-forward by season, log loss of the shooter among his five; flat 1/5 = 1.6094)")
    def ll_for(R, key, b):
        out = []
        for r in R:
            five = [f for f in r["feats"] if f["team"] == r["ftT"]]
            if len(five) != 5 or any(f[key] is None for f in five) or r["who"] not in {f["pid"] for f in five}: continue
            w = np.array([max(f[key], 0.05) ** b for f in five]); w /= w.sum()
            out.append(-np.log(w[[f["pid"] for f in five].index(r["who"])]))
        return out
    bs = np.round(np.arange(0, 2.01, 0.1), 2)
    tot = {"flat": [], "fga": [], "fta": []}
    for s in seasons[2:]:
        train = [r for r in FT if r["season"] < s]; test = [r for r in FT if r["season"] == s]
        line = []
        for key in ("fga", "fta"):
            b = min(bs, key=lambda b: np.mean(ll_for(train, key, b)))
            v = ll_for(test, key, b); tot[key] += v; line.append(f"{key}^{b:.1f} {np.mean(v):.4f}")
        flat = ll_for(test, "fta", 0); tot["flat"] += flat
        print(f"   {s}: n {len(flat):4}  flat {np.mean(flat):.4f}  " + "  ".join(line))
    print("   pooled: " + "  ".join(f"{k} {np.mean(v):.4f}" for k, v in tot.items()))
    ball = min(bs, key=lambda b: np.mean(ll_for(FT, "fta", b)))
    print(f"   free throws a game, power fit on every season: {ball}")

    # the build's f: the last two full seasons and this one, game-weighted (the rate has crept up: .071 in 2023-24, .10 now)
    R = [g for g in G if g["season"] in seasons[-3:]]
    f = float(np.mean([isft(g) for g in R]))
    print(f"\nf for the build ({', '.join(seasons[-3:])}, {len(R)} games): {f:.4f}")
    if "--export" in __import__("sys").argv:
        p = os.path.join(HERE, "nba_model.json"); M = json.load(open(p))
        M["first"]["ft"] = {"note": "research/nba_firstpoints.py (11/24): the books settle first basket on first POINTS, free throws in. "
            "P(first points) = P(his team first) x [(1 - open) x his field-goal share + open x his free-throw share]; free-throw share = "
            "fta_pg^b over his five, fta_pg = (season FTA + prev_w x last season's) / (games + prev_w x last season's), floor 0.05. "
            "The team half is the field-goal model's (the tip winner goes to the line first 70%, close to its 64%).",
            "open": round(f, 4), "b": float(ball), "prev_w": 0.5, "floor": 0.05}
        json.dump(M, open(p, "w"), indent=1); print("exported", M["first"]["ft"])


if __name__ == "__main__":
    main()
