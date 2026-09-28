"""Threes: which recent-form fix? (research) — follows nba_threes_form.py.

    python3 research/nba_threes_form2.py

Walk-forward, every variant priced through the SAME ladder (NB alpha 0.1 over
minutes N(proj, 5.2)), against the shipped model (nba_threes_oos.parquet):
  A  shipped            rate, implied, opp, home
  B  + form             the stats engine's columns for tpm (r10, early, r10 x early)
  C  B + attempts form  his last 10 games' 3PA per minute against his 3PA rate
                        (the non-shooter: stopped taking them)
  D  B + drought        log(1 + games since his last made three, capped 40;
                        none on record = 40) — the build's state has it (dr.t1)
Scored on 1+ and 3+ log loss, and on the drought gap nba_due.py found.
"""
import os
import numpy as np
import pandas as pd
import nba_stats as NS
import nba_threes as TH
from nba_due import droughts, offset_logit

HERE = os.path.dirname(os.path.abspath(__file__))


def main():
    NS.STATS = ["tpm"]
    D, _, _ = NS.build()
    D = D[D.tpm.notna()].copy()
    # attempts form, built the way nba_stats.build() builds r10 (the team file has no 3PA, so not through it)
    D = D.sort_values(["pid", "date", "gid"])
    D["tpa"] = D.tpa.astype(float).fillna(0)
    g = D.groupby(["pid", "season"])
    D["s_tpa"] = g.tpa.cumsum() - D.tpa
    ss0 = sorted(D.season.unique()); nxt = {x: ss0[i + 1] for i, x in enumerate(ss0[:-1])}
    pt = D.groupby(["pid", "season"]).tpa.sum().reset_index(); pt["season"] = pt.season.map(nxt)
    D = D.merge(pt.dropna().rename(columns={"tpa": "p_tpa"}), on=["pid", "season"], how="left").fillna({"p_tpa": 0})
    fr = D.groupby(["season", "fam"]).apply(lambda d: d.tpa.sum() / d["min"].sum(), include_groups=False).rename("fr_tpa").reset_index()
    frp = fr.assign(season=fr.season.map(nxt)).dropna(); fr = pd.concat([frp, fr[fr.season == ss0[0]]]).drop_duplicates(["season", "fam"])
    D = D.merge(fr, on=["season", "fam"], how="left").sort_values(["pid", "date", "gid"])
    D["rate_tpa"] = (D.s_tpa + 0.5 * D.p_tpa + 300 * D.fr_tpa) / (D.s_min + 0.5 * D.p_min + 300)
    rs = D.groupby("pid").tpa.transform(lambda x: x.shift(1).rolling(10, min_periods=1).sum()).fillna(0)
    rm = D.groupby("pid")["min"].transform(lambda x: x.shift(1).rolling(10, min_periods=1).sum()).fillna(0)
    D["r10_tpa"] = np.log(((rs + 120 * D.rate_tpa) / (rm + 120)).clip(1e-3)) - np.log(D.rate_tpa.clip(1e-3))
    # drought going in: games PLAYED (regular season) since his last made three
    M = pd.read_parquet(os.path.join(HERE, "nba_minutes.parquet"))
    M = M[(M.type == 2) & (~M.dnp)][["gid", "pid", "date", "tpm"]].copy(); M["h1"] = M.tpm >= 1
    dr = droughts(M, "pid", "h1")[["gid", "pid", "drought"]]
    D = D.merge(dr, on=["gid", "pid"], how="left")
    D["ldr"] = np.log1p(D.drought.fillna(40).clip(upper=40))
    base = lambda d: NS.X_of(d, "tpm")
    V = {
        "B": base,
        "C": lambda d: np.column_stack([base(d), d.r10_tpa]),
        "D": lambda d: np.column_stack([base(d), d.ldr]),
        "C+D": lambda d: np.column_stack([base(d), d.r10_tpa, d.ldr]),
        "D82": lambda d: np.column_stack([base(d), np.log1p(d.drought.fillna(82).clip(upper=82))]),
        "D200": lambda d: np.column_stack([base(d), np.log1p(d.drought.fillna(200).clip(upper=200))]),
        "D82+sq": lambda d: np.column_stack([base(d), np.log1p(d.drought.fillna(82).clip(upper=82)), np.log1p(d.drought.fillna(82).clip(upper=82)) ** 2]),
    }
    ss = sorted(D.season.unique())
    out = []
    for s in ss[1:]:
        tr, te = D[D.season < s], D[D.season == s].copy()
        for k, X in V.items():
            b = TH.glm_poisson(X(tr), tr.tpm.values, tr.off.values)
            te[f"mu_{k}"] = np.exp(X(te) @ b + te.off.values)
            if s == ss[-1]: print(f"{k} last fit tail coefs: {np.round(b[-3:], 3)}")
        out.append(te)
    R = pd.concat(out)
    old = pd.read_parquet(os.path.join(HERE, "nba_threes_oos.parquet"))[["gid", "pid", "n_1", "n_3", "n_5"]]
    R = R.drop(columns=[c for c in R.columns if c.startswith("n_")]).merge(old, on=["gid", "pid"])
    y1, y3, y5 = [(R.tpm >= k).astype(float).values for k in (1, 3, 5)]
    lg = lambda p: np.log(np.clip(p, 1e-6, 1 - 1e-6) / (1 - np.clip(p, 1e-6, 1 - 1e-6)))
    print(f"\n{len(R):,} player-games ({R.season.min()}..{R.season.max()})")
    print(f"{'variant':9s} {'1+ LL':>8s} {'3+ LL':>8s} {'5+ LL':>8s}   drought slope, 1+ (t)   longest 1%: priced/actual")
    rows = [("A", R.n_1.values, R.n_3.values, R.n_5.values)]
    for k in V:
        L = TH.ladder(R[f"mu_{k}"].values, R.mproj.values, alpha=0.1)
        rows.append((k, L[:, 0], L[:, 2], L[:, 4]))
    ok = R.drought.notna().values
    for k, p1, p3, p5 in rows:
        x = np.log1p(R.drought.values[ok] * p1[ok])
        b, se, _ = offset_logit(y1[ok], lg(p1[ok]), x)
        top = ok & (R.drought.fillna(-1).values >= np.nanpercentile(R.drought.values[ok], 99))
        print(f"{k:9s} {TH.ll(p1, y1):8.5f} {TH.ll(p3, y3):8.5f} {TH.ll(p5, y5):8.5f}   {b:+.3f} ± {se:.3f} (t {b / se:+.1f})       {p1[top].mean():.3f}/{y1[top].mean():.3f}")
    # D82+sq ships: best on every rung; C (3PA form) needs per-game 3PA the state doesn't keep
    L = TH.ladder(R["mu_D82+sq"].values, R.mproj.values, alpha=0.1)
    q = pd.qcut(L[:, 0], 10, labels=False, duplicates="drop")
    print(f"\ncalibration, D82+sq, 1+ by decile: " + "  ".join(f"{L[:, 0][q == j].mean():.3f}→{y1[q == j].mean():.3f}" for j in range(10)))
    for k in range(5): R[f"n_{k + 1}"] = L[:, k]
    R["mu"] = R["mu_D82+sq"]
    R[["gid", "pid", "name", "date", "season", "tpm", "mu", "mproj"] + [f"n_{k}" for k in range(1, 6)]].to_parquet(os.path.join(HERE, "nba_threes_form_oos.parquet"))
    print("wrote nba_threes_form_oos.parquet (D82+sq)")


if __name__ == "__main__":
    main()


def export_threes():
    """The shipped threes model (D82+sq), fit on every season, for nba_model.json["threes"].
    scripts/nba-models.js threesMu applies it: the stats engine's columns for tpm
    (nba_stats.X_of) plus log(1 + drought) and its square, the drought capped 82
    games (none on record = 82) — the build's state counts it the same (dr.t1)."""
    NS.STATS = ["tpm"]
    D, league, _ = NS.build()
    D = D[D.tpm.notna()].copy()
    M = pd.read_parquet(os.path.join(HERE, "nba_minutes.parquet"))
    M = M[(M.type == 2) & (~M.dnp)][["gid", "pid", "date", "tpm"]].copy(); M["h1"] = M.tpm >= 1
    D = D.merge(droughts(M, "pid", "h1")[["gid", "pid", "drought"]], on=["gid", "pid"], how="left")
    # the table starts a season after the cache: in its first season "no make on record" can just mean
    # "made one the season before" (the build knows — research/nba_parity.mjs). Those rows sit out.
    D = D[~(D.drought.isna() & (D.season == D.season.min()))].copy()
    ldr = np.log1p(D.drought.fillna(82).clip(upper=82))
    X = np.column_stack([NS.X_of(D, "tpm"), ldr, ldr ** 2])
    b = TH.glm_poisson(X, D.tpm.values, D.off.values)
    cols = ["const", "lrate", "form", "limp", "lopp", "home", "early", "form_x_early", "ldr", "ldr2"]
    return {
        "note": "research/nba_threes_form2.py — made threes: Poisson GLM on the stats engine's columns (his rate, last-10 form, implied, opponent, home, early season) plus log(1 + games since his last made three) and its square; NB alpha 0.1 over minutes.",
        "cols": cols, "coef": dict(zip(cols, [float(x) for x in b])), "rows": int(len(D)),
        "shrink_min": 300, "prev_weight": 0.5, "form_k": 120, "opp_shrink_games": 10, "drought_cap": 82,
        "alpha": 0.1, "sd_min": 5.2, "clip": {"imp": [0.6, 1.4], "opp": [0.7, 1.3]}, "rungs": [1, 2, 3, 4, 5],
        "league": {"fam_rate": league["fam_rate"]["tpm"], "allowed": league["allowed"]["tpm"], "implied": league["implied"]},
    }
