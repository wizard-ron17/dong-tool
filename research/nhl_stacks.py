"""Scorer + assister stacks: does "A scores and B gets an assist" beat the product?

The hockey version of the NFL's QB -> receiver stack. The NFL one runs 33%
above independence because the two legs are the same event. Here they are only
sometimes the same event — B's assist can come on anybody's goal — so the lift
should depend on how tied the two are: linemates who keep setting each other up
versus two teammates who never share a shift.

For every game, every ordered pair of teammates who both dressed:
  p_A = shipped goals model, walk-forward (research/nhl_due.py)
  q_B = shipped assists model, walk-forward (research/nhl_points.py)
  hit = A scored at least once AND B had at least one assist
  multiplier = sum(hit) / sum(p_A * q_B), by how many earlier games THIS SEASON
               B assisted a goal of A's (0, 1, 2, 3-4, 5+)

Each season's prices are rescaled to its own level first (nhl_pairs.py showed a
2% level miss reads as a 4% "correlation"). Fit 2023-24 + 2024-25, checked
2025-26. Goal-level assists come from research/nhl_assist_fetch.py.

    python3 research/nhl_stacks.py        # prints; writes nhl_stacks_model.json
"""
import glob, json, os, sys
import numpy as np
import pandas as pd

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
CACHE = os.environ.get("NHL_CACHE") or "/tmp/nhl-cache"
BINS = [(0, 0, "never"), (1, 1, "1 game"), (2, 2, "2 games"), (3, 4, "3-4 games"), (5, 999, "5+ games")]


def prices():
    from nhl_goals import D as G
    from nhl_due import walk as gwalk, FEATS
    import nhl_points as NP
    G = G.drop_duplicates(["pid", "date"])
    pg = gwalk(G, FEATS)
    g = G.loc[pg.index, ["season", "date", "pid", "team", "opp", "goals"]].assign(p=pg.values)
    r = NP.walk("a", NP.SHIPPED["a"])
    idx = np.concatenate([NP.D.index[NP.D.season == s] for s in NP.SEASONS[1:]])
    a = NP.D.loc[idx, ["pid", "date", "a"]].assign(q=1 - np.exp(-r["mu"]))
    m = g.merge(a.drop_duplicates(["pid", "date"]), on=["pid", "date"], how="inner")
    for c, y in (("p", m.goals > 0), ("q", m.a > 0)):
        m[c] = m[c] * y.groupby(m.season).transform("sum") / m.groupby("season")[c].transform("sum")
    return m


def links():
    rows = []
    for f in glob.glob(os.path.join(CACHE, "20*", "*", "goals_a.json")):
        season = int(f.split(os.sep)[-3]); date = f.split(os.sep)[-2]
        for g in json.load(open(f)):
            seen = set()
            for x in g["goals"]:
                if x.get("ptype") == "SO" or not x.get("pid"): continue
                for b in x.get("a") or []:
                    if b and (x["pid"], b) not in seen:
                        seen.add((x["pid"], b)); rows.append((season, date, x["pid"], b))
    return pd.DataFrame(rows, columns=["season", "date", "A", "B"])


if __name__ == "__main__":
    M = prices()
    E = links()
    print(f"{len(M):,} priced skater-games · {len(E):,} scorer->assister game links\n")
    # every ordered teammate pair in every game
    L = M[["season", "date", "team", "pid", "p", "goals"]].rename(columns={"pid": "A"})
    R = M[["date", "team", "pid", "q", "a"]].rename(columns={"pid": "B"})
    P = L.merge(R, on=["date", "team"]); P = P[P.A != P.B]
    P["hit"] = ((P.goals > 0) & (P.a > 0)).astype(float)
    P["pq"] = P.p * P.q
    # prior links this season: stack events and pair rows, events sort after rows on a date
    ev = E.assign(kind=1, pq=np.nan)
    rw = P[["season", "date", "A", "B"]].assign(kind=0)
    Z = pd.concat([rw.reset_index(), ev], ignore_index=True).sort_values(["season", "A", "B", "date", "kind"])
    Z["prior"] = Z.groupby(["season", "A", "B"]).kind.cumsum() - Z.kind
    P["prior"] = Z[Z.kind == 0].set_index("index").prior.reindex(P.index).to_numpy()
    out = {}
    for lab, S in (("fit 2023-24 + 2024-25", P[P.season < 20252026]), ("check 2025-26", P[P.season == 20252026]), ("pooled", P)):
        print(lab)
        res = {}
        for lo, hi, name in BINS:
            s = S[(S.prior >= lo) & (S.prior <= hi)]
            mult = s.hit.sum() / s.pq.sum()
            res[name] = {"mult": round(float(mult), 3), "pairs": int(len(s)), "hits": int(s.hit.sum())}
            print(f"  B assisted A {name:10s} before: {mult:.3f}   ({len(s):,} pair-games, {int(s.hit.sum()):,} hit)")
        top = S[(S.p >= 0.2) & (S.prior >= 3)]
        print(f"  A priced 20%+, 3+ links: {top.hit.sum() / top.pq.sum():.3f} ({len(top):,})\n")
        out[lab] = res
    json.dump({"note": "Scorer + assister stack multipliers vs the naive product (research/nhl_stacks.py), by earlier games this season B assisted A. Pooled 2023-24 to 2025-26.",
               "bins": [{"lo": lo, "hi": hi, "mult": out["pooled"][name]["mult"]} for lo, hi, name in BINS],
               "check": out["check 2025-26"]},
              open(os.path.join(HERE, "nhl_stacks_model.json"), "w"), indent=1)
