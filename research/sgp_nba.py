"""NBA same-game parlay correlations (research): sgp_core's copula ρ per pair type, measured walk-forward.

    python3 research/sgp_nba.py            # fit, print, write research/sgp_nba.json

Margins are the shipped stat engine's own walk-forward ladders (nba_stats.py: each season priced by fits on the
seasons before it; threes from nba_threes_form_oos.parquet), so ρ is only what's left after the prices. Each player-
game takes, per stat, the rung nearest even money (where a main line sits); rotation players only (projected 15+
minutes), the ones books hang lines on. Pair types:
  same player   every two of pts, reb, ast, 3pm, stl, blk, pra, stk (pra/stk contain their parts: measured anyway,
                so the slip knows how close to one bet they are)
  teammates     every pairing of pts, reb, ast, 3pm, pra, stl, blk, same stat and cross (one's points, the other's assists)
  opponents     the same pairings (one side's rebounds and the other's assists: misses become boards)
A pair ships when its 95% game-bootstrap CI excludes 0; otherwise it's 'measured independent'.
NBA rule (memo to partner books, 10/16/2026): no parlays of 2+ unders on ONE player at partner books; exchanges
(Kalshi, Polymarket) are outside it. That's a book rule, not a correlation: the slip/builder enforces it.
"""
import itertools, json, os, sys
import numpy as np, pandas as pd
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
import nba_stats as NS
from sgp_core import fit_rho

ST = ["pts", "reb", "ast", "pra", "stl", "blk", "stk"]


def frame():
    """One row per (player-game, stat): the near-even rung's walk-forward p and the outcome."""
    D, _, _ = NS.build()
    ss = sorted(D.season.unique()); ss = [ss[0]] + ss
    SD = json.load(open(os.path.join(HERE, "nba_model.json")))["minutes"]["lineup"]["sd"]
    out = []
    for s in ss[2:]:
        tr, te = D[D.season < s], D[D.season == s]
        te = te[te.mproj >= 15]
        for st in ST:
            b, a, pw = NS.fit_stat(tr, st); mu = np.exp(NS.X_of(te, st) @ b + te.off.values)
            R = NS.RUNGS[st]; L = NS.ladder(mu, te.mproj.values, SD, a, pw, R)
            j = np.abs(L - 0.5).argmin(axis=1)
            out.append(pd.DataFrame({"gid": te.gid.values, "pid": te.pid.values, "team": te.team.values, "season": s, "stat": st,
                                     "p": L[np.arange(len(te)), j], "y": (te[st].values >= np.array(R)[j]).astype(float)}))
        print(f"  {s}: {len(te):,} player-games", flush=True)
    F = pd.concat(out, ignore_index=True)
    T = pd.read_parquet(os.path.join(HERE, "nba_threes_form_oos.parquet"))
    T = T[T.mproj >= 15]; P = T[[f"n_{k}" for k in range(1, 6)]].values; j = np.abs(P - 0.5).argmin(axis=1)
    T = T.merge(D[["gid", "pid", "team"]].drop_duplicates(), on=["gid", "pid"], how="inner")
    P = T[[f"n_{k}" for k in range(1, 6)]].values; j = np.abs(P - 0.5).argmin(axis=1)
    F = pd.concat([F, pd.DataFrame({"gid": T.gid.values, "pid": T.pid.values, "team": T.team.values, "season": T.season.values, "stat": "3pm",
                                    "p": P[np.arange(len(T)), j], "y": (T.tpm.values >= j + 1).astype(float)})], ignore_index=True)
    return F


def fit(A, B, label, groups):
    r = fit_rho(A.p.values, B.p.values, A.y.values, B.y.values, groups=groups, boot=40)
    ok = r.get("lo") is not None and (r["lo"] > 0 or r["hi"] < 0)
    print(f"  {label:28s} n {len(A):7,d}  ρ {r['rho']:+.3f}  [{r.get('lo', np.nan):+.3f}, {r.get('hi', np.nan):+.3f}]  {'SHIP' if ok else 'indep'}", flush=True)
    return {"rho": round(float(r["rho"]), 3), "lo": round(float(r["lo"]), 3), "hi": round(float(r["hi"]), 3), "n": int(len(A)), "ship": bool(ok)}


def main():
    F = frame(); S = F.set_index(["gid", "pid", "stat"]).sort_index()
    rng = np.random.default_rng(7); res = {"same": {}, "mate": {}, "opp": {}}
    print(f"\n{F[['gid', 'pid']].drop_duplicates().shape[0]:,} player-games, {F.gid.nunique():,} games")
    W = F.pivot_table(index=["gid", "pid", "team"], columns="stat", values=["p", "y"]).dropna(subset=[("p", "pts")]).reset_index()
    print("\nsame player")
    for a, b in itertools.combinations(ST + ["3pm"], 2):
        m = W[("p", a)].notna() & W[("p", b)].notna(); X = W[m]
        res["same"][f"{a}+{b}"] = fit(pd.DataFrame({"p": X[("p", a)], "y": X[("y", a)]}), pd.DataFrame({"p": X[("p", b)], "y": X[("y", b)]}), f"{a}+{b}", X.gid.values)
    # pairs of players in one game: teammates and opponents
    G = F[["gid", "pid", "team"]].drop_duplicates()
    pr = G.merge(G, on="gid", suffixes=("1", "2")); pr = pr[pr.pid1 < pr.pid2]
    for kind, sel in (("mate", pr.team1 == pr.team2), ("opp", pr.team1 != pr.team2)):
        Pk = pr[sel]
        if len(Pk) > 250000: Pk = Pk.iloc[rng.choice(len(Pk), 250000, replace=False)]
        print(f"\n{'teammates' if kind == 'mate' else 'opponents'} ({len(Pk):,} pairs)")
        # every pairing of the main stats, same stat and cross-stat (11/04: a CHI@NY slip had an opponent's rebounds with
        # a teammate pair's assists and threes, none of them measured, so the slip multiplied them)
        CS = ["pts", "reb", "ast", "3pm", "pra", "stl", "blk"]
        pairs = list(itertools.combinations_with_replacement(CS, 2))
        for a, b in pairs:
            A = F[F.stat == a][["gid", "pid", "p", "y"]]; B = F[F.stat == b][["gid", "pid", "p", "y"]]
            J = Pk.merge(A.rename(columns={"pid": "pid1", "p": "p1", "y": "y1"}), on=["gid", "pid1"]).merge(B.rename(columns={"pid": "pid2", "p": "p2", "y": "y2"}), on=["gid", "pid2"])
            if a != b:   # one's points, the other's assists: both orders
                J2 = Pk.merge(A.rename(columns={"pid": "pid2", "p": "p1", "y": "y1"}), on=["gid", "pid2"]).merge(B.rename(columns={"pid": "pid1", "p": "p2", "y": "y2"}), on=["gid", "pid1"])
                J = pd.concat([J, J2], ignore_index=True)
            res[kind][f"{a}+{b}"] = fit(pd.DataFrame({"p": J.p1, "y": J.y1}), pd.DataFrame({"p": J.p2, "y": J.y2}), f"{a}+{b}", J.gid.values)
    res["note"] = ("research/sgp_nba.py: copula rho per pair type, walk-forward margins (nba_stats.py ladders, threes form), near-even rung, "
                   "rotation players (proj 15+ min), game bootstrap CI; ship = CI excludes 0. Seasons " + ", ".join(sorted(F.season.unique())))
    json.dump(res, open(os.path.join(HERE, "sgp_nba.json"), "w"), indent=1)
    print("\nwrote research/sgp_nba.json")


if __name__ == "__main__":
    main()
