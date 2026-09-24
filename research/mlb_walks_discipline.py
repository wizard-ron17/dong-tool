"""Chase rate and strike-throwing vs the Walks projection — are they already in it?

Ron's two candidates:
  1. batter / team chase rate — maybe already baked into their walk rate
  2. pitcher strike / ball rate — maybe already baked into his walk rate

From Baseball Savant pitch data (research/mlb_savant_fetch.py), all as-of this
season (games before the start), shrunk toward the league:
  p_ball     his share of pitches called balls
  p_zone     his share of pitches in the strike zone
  p_fps      his first-pitch strike rate
  p_chase    the chase rate he induces (swings at his pitches out of the zone)
  t_chase    the opposing club's chase rate
  lu_chase   the opposing lineup that actually started, each batter's chase
             rate weighted by his lineup spot

Each enters a Poisson GLM on walks next to log(shipped projection), refit
monthly on the months before it (as research/mlb_walks_features.py), and is
compared start by start with the projection alone: log-loss gain across the
walk lines books hang (0.5 .. 3.5), paired t, and Over 1.5 for the board's
top 8.

    python3 research/mlb_walks_discipline.py
"""
import glob, json, os, sys
import numpy as np
import pandas as pd
from scipy.stats import poisson

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from nhl_sog import poisson_irls
SPOT_PA = [4.65, 4.55, 4.45, 4.35, 4.25, 4.15, 4.05, 3.95, 3.85]


def savant(season="2026"):
    P, B = [], []
    for f in sorted(glob.glob(os.path.join(HERE, ".cache", "savant", f"{season}-*.json"))):
        d = os.path.basename(f)[:-5]; j = json.load(open(f))
        P += [{**r, "date": d} for r in j["pitchers"]]; B += [{**r, "date": d} for r in j["batters"]]
    return pd.DataFrame(P), pd.DataFrame(B)


def asof(df, key, num, den, k, prior):
    df = df.sort_values([key, "date"])
    cn = df.groupby(key, sort=False)[num].cumsum() - df[num]
    cd = df.groupby(key, sort=False)[den].cumsum() - df[den]
    return ((cn + k * prior) / (cd + k)).reindex(df.index)


def build():
    W = pd.read_parquet(os.path.join(HERE, "mlb_walks_features.parquet"))
    P, B = savant()
    # a doubleheader day can hold two rows for a club; the starter's own row per date is unique
    P = P.groupby(["date", "pid"], as_index=False).agg({"gpk": "first", "n": "sum", "ball": "sum", "strike": "sum", "inz": "sum",
                                                        "first": "sum", "fps": "sum", "outz": "sum", "chase": "sum", "pa": "sum",
                                                        "k": "sum", "bb": "sum", "team": "first", "sp": "max"})
    lg = {"ball": P.ball.sum() / P.n.sum(), "zone": P.inz.sum() / P.n.sum(), "fps": P.fps.sum() / P["first"].sum(),
          "chase": P.chase.sum() / P.outz.sum()}
    P["p_ball"] = asof(P, "pid", "ball", "n", 600, lg["ball"])
    P["p_zone"] = asof(P, "pid", "inz", "n", 600, lg["zone"])
    P["p_fps"] = asof(P, "pid", "fps", "first", 150, lg["fps"])
    P["p_chase"] = asof(P, "pid", "chase", "outz", 300, lg["chase"])
    # batters and clubs
    B["b_chase"] = asof(B, "pid", "chase", "outz", 150, lg["chase"])
    T = B.groupby(["date", "gpk", "team"]).agg(outz=("outz", "sum"), chase=("chase", "sum")).reset_index()
    T["t_chase"] = asof(T, "team", "chase", "outz", 1500, lg["chase"])
    tch = T.set_index(["gpk", "team"]).t_chase.to_dict()
    lineups = {k: g.sort_values("slot") for k, g in B[B.slot <= 9].groupby(["gpk", "team"])}
    def lu(gpk, team):
        g = lineups.get((gpk, team))
        if g is None or len(g) < 8: return np.nan
        w = np.array([SPOT_PA[s - 1] for s in g.slot])
        return float((w * g.b_chase.to_numpy()).sum() / w.sum())
    W["pid_i"] = W.pid.astype(int)
    D = W.merge(P.rename(columns={"pid": "pid_i"})[["date", "pid_i", "gpk", "p_ball", "p_zone", "p_fps", "p_chase"]],
                on=["date", "pid_i"], how="inner")
    D["t_chase"] = [tch.get((g, o), np.nan) for g, o in zip(D.gpk, D.opp)]
    D["lu_chase"] = [lu(g, o) for g, o in zip(D.gpk, D.opp)]
    print(f"{len(D):,} of {len(W):,} starts matched to Savant; lineup chase for {D.lu_chase.notna().mean():.1%}")
    print("correlations with what the projection already uses:")
    print(f"  his ball rate vs his walk-rate term:        {np.corrcoef(D.p_ball, D.exp)[0, 1]:+.2f}")
    print(f"  his first-pitch strikes vs walk-rate term:  {np.corrcoef(D.p_fps, D.exp)[0, 1]:+.2f}")
    ok = D.t_chase.notna()
    print(f"  club chase vs club walk rate:               {np.corrcoef(D.t_chase[ok], D.tm_bb[ok])[0, 1]:+.2f}")
    for c in ("p_ball", "p_zone", "p_fps", "p_chase", "t_chase", "lu_chase"):
        D["log_" + c] = np.log(D[c].clip(lower=1e-3))
    return D


def design(df, fs, ref):
    return np.column_stack([np.ones(len(df))] + [(df[f].to_numpy(float) - ref[f][0]) / ref[f][1] for f in fs])


def walk(D, fs):
    mu = pd.Series(np.nan, index=D.index)
    for m in sorted(D.date.str[:7].unique()):
        tr, te = D[D.date < m + "-01"], D[D.date.str[:7] == m]
        if len(tr) < 400 or not len(te): continue
        ref = {f: (tr[f].mean(), tr[f].std() or 1.0) for f in fs}
        b = poisson_irls(design(tr, fs, ref), tr.bb.to_numpy(float))
        mu[te.index] = np.exp(np.clip(design(te, fs, ref) @ b, -6, 3))
    return mu


def row_ll(mu, y):
    out = []
    for L in (0.5, 1.5, 2.5, 3.5):
        p = np.clip(poisson.sf(np.floor(L), mu), 1e-6, 1 - 1e-6); h = (y > L).astype(float)
        out.append(-(h * np.log(p) + (1 - h) * np.log(1 - p)))
    return np.mean(out, axis=0)


if __name__ == "__main__":
    D = build().dropna(subset=["log_t_chase"]).copy()
    D["log_lu_chase"] = D.log_lu_chase.fillna(D.log_t_chase)
    base = ["log_proj"]
    m0 = walk(D, base); idx = m0.dropna().index
    y = D.loc[idx, "bb"].to_numpy(float); l0 = row_ll(m0[idx].to_numpy(), y)
    top = lambda mu: D.loc[idx].assign(mu=mu[idx]).assign(rk=lambda x: x.groupby("date").mu.rank(ascending=False, method="first"))
    t0 = top(m0); t0 = t0[t0.rk <= 8]
    print(f"\n{len(idx):,} held-out starts · projection alone: top-8 Over 1.5 hit {(t0.bb >= 2).mean() * 100:.1f}%")
    for lab, fs in (("his ball rate", ["log_p_ball"]), ("his zone rate", ["log_p_zone"]), ("his first-pitch strikes", ["log_p_fps"]),
                    ("chase rate he induces", ["log_p_chase"]), ("opposing club's chase rate", ["log_t_chase"]),
                    ("opposing lineup's chase rate", ["log_lu_chase"]),
                    ("all six", ["log_p_ball", "log_p_zone", "log_p_fps", "log_p_chase", "log_t_chase", "log_lu_chase"])):
        m1 = walk(D, base + fs)
        d = l0 - row_ll(m1[idx].to_numpy(), y)
        t = d.mean() / (d.std() / np.sqrt(len(d)))
        tt = top(m1); tt = tt[tt.rk <= 8]
        print(f"  + {lab:28s} {d.mean() * 1000:+.3f} per 1,000   t {t:+.2f}{'  <-- counts' if t > 2.5 else ''}   top-8 o1.5 hit {(tt.bb >= 2).mean() * 100:.1f}%")
