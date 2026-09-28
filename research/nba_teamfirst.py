"""Does a TEAM score first a lot, beyond the tip? (research)

    python3 research/nba_teamfirst.py

Online walk-forward in date order. Baseline: P(team first) from the tip as
first_basket v2 prices it (jumpers' tip records, log5, then the measured
tip-winner edge). Added, each tested for signal beyond that baseline:
  fast start   the team's first-score record so far vs what its tips
               predicted (the residual), shrunk (k = 40 games)
  opp          the opponent's residual, first-score ALLOWED the same way
  line         the team's implied points minus the opponent's (from the
               spread) — a better offense should score first more
  split-half   is "fast start" a stable team trait at all? odd vs even
               games within a season
Logistic on the baseline logit plus each term, fit on earlier seasons and
scored on the next.
"""
import glob, json, os
from collections import defaultdict
import numpy as np
import pandas as pd

HERE = os.path.dirname(os.path.abspath(__file__))
lg = lambda p: np.log(p / (1 - p))


def fit(X, y, iters=50):
    b = np.zeros(X.shape[1])
    for _ in range(iters):
        p = 1 / (1 + np.exp(-X @ b)); W = p * (1 - p)
        b += np.linalg.solve(X.T @ (X * W[:, None]) + 1e-6 * np.eye(len(b)), X.T @ (y - p))
    return b


def ll(p, y): p = np.clip(p, 1e-6, 1 - 1e-6); return float(-(y * np.log(p) + (1 - y) * np.log(1 - p)).mean())


def main():
    games = []
    for f in glob.glob(os.path.join(HERE, ".cache", "nba", "*", "*.json")):
        d = json.load(open(f)); g = d["game"]
        if g["type"] != 2 or not g.get("first_fg") or not g.get("tip_team"): continue
        jt = {p["pid"]: p["team"] for p in d["players"] if p["starter"]}
        games.append((g["date"], g, jt))
    games.sort(key=lambda x: x[0])
    tipw, tipn = defaultdict(float), defaultdict(float)
    res, n = defaultdict(float), defaultdict(float)          # team -> sum(actual - expected first), games
    ares, an = defaultdict(float), defaultdict(float)        # team as opponent -> allowed residual
    e_w, e_n, rows = 0.0, 0.0, []
    half = defaultdict(lambda: [0.0, 0.0, 0.0, 0.0])          # (season, team) -> odd res, odd n, even res, even n
    for _, g, jt in games:
        jump = g.get("jump") or []
        if not (len(jump) == 2 and all(j in jt for j in jump) and jt[jump[0]] != jt[jump[1]]): continue
        a, b = jump; K = 20
        ra = (tipw[a] + K * .5) / (tipn[a] + K); rb = (tipw[b] + K * .5) / (tipn[b] + K)
        pa = ra * (1 - rb) / (ra * (1 - rb) + rb * (1 - ra)); e = (e_w + 20 * .62) / (e_n + 20)
        ph = (pa if jt[a] == g["home"] else 1 - pa); p_home = ph * e + (1 - ph) * (1 - e)
        H, A = g["home"], g["away"]
        sh = lambda t: res[t] / (n[t] + 40); sa = lambda t: ares[t] / (an[t] + 40)
        spread = g.get("spread")
        rows.append({"season": g["season"], "y": float(g["first_fg"]["team"] == H), "base": p_home,
                     "fast": sh(H) - sh(A), "opp": sa(A) - sa(H),
                     "line": -spread if spread is not None else np.nan})
        # update
        y = float(g["first_fg"]["team"] == H)
        for t, exp, act in ((H, p_home, y), (A, 1 - p_home, 1 - y)):
            res[t] += act - exp; n[t] += 1
            o = A if t == H else H; ares[o] += act - exp; an[o] += 1
            k = half[(g["season"], t)]; i = 0 if int(n[t]) % 2 else 2; k[i] += act - exp; k[i + 1] += 1
        for j in jump: tipn[j] += 1; tipw[j] += float(jt[j] == g["tip_team"])
        e_n += 1; e_w += float(g["tip_team"] == g["first_fg"]["team"])
    R = pd.DataFrame(rows)
    hv = np.array([[v[0] / v[1], v[2] / v[3]] for v in half.values() if v[1] >= 20 and v[3] >= 20])
    print(f"{len(R):,} games · home scores first {R.y.mean():.3f}\n")
    print(f"is 'fast start' a team trait? split-half correlation of a team's first-score residual, odd vs even games: {np.corrcoef(hv[:, 0], hv[:, 1])[0, 1]:+.3f} ({len(hv)} team-seasons)")
    seasons = sorted(R.season.unique())
    out = defaultdict(list)
    for s in seasons[2:]:
        tr, te = R[R.season < s], R[R.season == s]
        for name, cols in (("tip only", []), ("+ fast start", ["fast"]), ("+ opp allowed", ["opp"]), ("+ line", ["line"]), ("+ all", ["fast", "opp", "line"])):
            T = tr.dropna(subset=cols); E = te.dropna(subset=cols)
            X = np.column_stack([np.ones(len(T)), lg(T.base)] + [T[c] for c in cols]); b = fit(X, T.y.values)
            Xe = np.column_stack([np.ones(len(E)), lg(E.base)] + [E[c] for c in cols])
            out[name].append((ll(1 / (1 + np.exp(-Xe @ b)), E.y.values), len(E), b))
    print(f"\nwalk-forward log loss ({seasons[2]}..{seasons[-1]}), team-scores-first:")
    for k, v in out.items():
        L = sum(a * n for a, n, _ in v) / sum(n for _, n, _ in v)
        print(f"  {k:16s} {L:.5f}   last fit coefs {np.round(v[-1][2], 3)}")
    # size: how far apart does the line put teams?
    R2 = R.dropna(subset=["line"]).copy(); R2["q"] = pd.qcut(R2.line, 5, labels=False)
    print("\nhome scores first by the line (home implied minus away), tip-model priced vs actual:")
    for q, r in R2.groupby("q"): print(f"  line {r.line.mean():+5.1f}  tip model {r.base.mean():.3f}  actual {r.y.mean():.3f}  (n {len(r):,})")


if __name__ == "__main__":
    main()
