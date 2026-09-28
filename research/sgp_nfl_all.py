"""Every pair the NFL slip can hold, measured (research) — follows sgp_nfl.py.

    PICKS_CACHE=<nflverse pbp cache> python3 research/sgp_nfl_all.py   # -> sgp_nfl_all.json

sgp_nfl.py measured the pairs we thought mattered; a slip can hold any two
legs of one game, and every pair it couldn't find priced as "a multiplied
estimate". This measures them all, the same way (sgp_core.fit_rho: a Gaussian
copula ρ with each leg's own walk-forward probability as its margin, 95% CI by
bootstrapping games), for every pair of market kinds x relationship:

  kinds    rec, yrec (receiving yds), yrush (rushing yds), cmp, ypass, int,
           ptd (2+ pass TDs), and the anytime TD by position: td_wr (WR/TE),
           td_rb, td_qb — the QB's receiver's TD is his own passing TD, his
           back's isn't
  same     one player, two markets        team   teammates      opp   opponents

The page prices ρ where the interval excludes zero and calls the rest
MEASURED independent — no longer "unmeasured". Pairs with too few games stay
unmeasured (n < MIN_N).
"""
import itertools, json, os, sys
import numpy as np, pandas as pd
sys.path.insert(0, os.path.dirname(__file__))
from sgp_core import fit_rho
import sgp_nfl as S

HERE = os.path.dirname(os.path.abspath(__file__))
RNG = np.random.default_rng(7)
CAP, BOOT, MIN_N = 60_000, 30, 1500


def long_table():
    R, U, Q, Kx, T = S.margins()
    part = lambda df, src, kind: df[["game_id", "team", "pid", f"p_{src}", f"y_{src}"]].rename(columns={f"p_{src}": "p", f"y_{src}": "y"}).assign(kind=kind)
    T = T.copy(); T["kind"] = np.where(T.position.isin(["WR", "TE"]), "td_wr", np.where(T.position == "RB", "td_rb", np.where(T.position == "QB", "td_qb", None)))
    tds = T[T.kind.notna()][["game_id", "team", "pid", "p_td", "y_td", "kind"]].rename(columns={"p_td": "p", "y_td": "y"})
    L = pd.concat([part(R, "rec", "rec"), part(R, "ryds", "yrec"), part(U, "rush", "yrush"), part(Q, "cmp", "cmp"),
                   part(Q, "pyds", "ypass"), part(Q, "int", "int"), part(Q, "ptd", "ptd"), tds], ignore_index=True)
    L["y"] = L.y.astype(bool)
    return L


def main():
    L = long_table()
    kinds = sorted(L.kind.unique())
    print(f"{len(L):,} leg-games, kinds {kinds}", flush=True)
    by = {k: L[L.kind == k] for k in kinds}
    out = {}
    for ka, kb in itertools.combinations_with_replacement(kinds, 2):
        A, B = by[ka], by[kb]
        for rel in ("same", "team", "opp"):
            if rel == "same":
                if ka == kb: continue
                P = A.merge(B, on=["game_id", "pid"], suffixes=("_a", "_b"))
            else:
                P = A.merge(B, on="game_id", suffixes=("_a", "_b"))
                P = P[(P.team_a == P.team_b) & (P.pid_a != P.pid_b)] if rel == "team" else P[P.team_a != P.team_b]
                if ka == kb: P = P[P.pid_a < P.pid_b] if rel == "team" else P[P.team_a < P.team_b]
            key = f"{rel}|{ka}|{kb}"
            if len(P) < MIN_N: out[key] = {"n": int(len(P))}; continue
            if len(P) > CAP: P = P.iloc[RNG.choice(len(P), CAP, replace=False)]
            r = fit_rho(P.p_a, P.p_b, P.y_a, P.y_b, groups=P.game_id, boot=BOOT)
            out[key] = {k: r[k] for k in ("rho", "lo", "hi", "n")}
            sig = r["lo"] > 0 or r["hi"] < 0
            print(f"{key:26s} ρ {r['rho']:+.3f} [{r['lo']:+.3f}, {r['hi']:+.3f}] n {r['n']:6d}{'  *' if sig else ''}", flush=True)
    json.dump(out, open(os.path.join(HERE, "sgp_nfl_all.json"), "w"), indent=1)
    print("wrote research/sgp_nfl_all.json")


if __name__ == "__main__":
    main()
