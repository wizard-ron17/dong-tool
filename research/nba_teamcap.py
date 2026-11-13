"""Minutes: a team cap on the depth boosts (research, Ron 11/13: points / PRA lose to the close).

    python3 research/nba_teamcap.py

Live 11/05-11/11 (cv/nbagap2): our minutes tie the market's overall (|err| 4.26 each) and when we're within 3 minutes
of it our points beat the close; the whole loss is on nights we project a team far over 240. 11/07 CHA, three starters
out: 315 projected minutes for 12 players (Allen 39.9, market 24, played 22). Each player's minutes model hands him
his own share of the vacated / slack minutes, so every man gets the whole boost at once. The 10/29 team-240 rescale
was tested on rows that PLAYED only (no DNPs): it can't see the over-allocation. Here, walk-forward as nba_minutes.py,
every AVAILABLE player-game (the build's view: not a known or long-term absence, a DNP counts as 0 actual), team sum
over those projected 8+ (the build's board), and three rules when that sum runs over a cap C:
    none      as shipped
    scale     every player x C / sum
    boost     only the depth terms (vacated, vac_pos, few_rot, slack_share, their bench / starter splits) shrink, by the
              factor that brings the sum to C (never below 0: the base model is left alone)
Scored on the players who played (the ones the boards price): MAE and bias, by the uncapped team sum.
"""
import os, sys
import numpy as np, pandas as pd
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
argv, sys.argv = sys.argv, sys.argv[:1]
import nba_minutes as NM
sys.argv = argv
DEPTH = ["vacated", "vac_pos", "few_rot", "slack_share", "few_rot_b", "slack_b", "vac_x_st"]


def prep():
    P = NM.features(NM.load())
    P = P.sort_values(["pid", "team", "tn"])
    new_out = P.dnp & (P.m10_any >= 10) & ((P.tn - P.last_played_tn) <= 3)
    prev_dnp = P.groupby(["pid", "team"]).dnp.shift(1).fillna(False).astype(bool)
    long_out = P.dnp & ~((P.tn - P.last_played_tn) <= 3)
    P["avail"] = ~((new_out & prev_dnp) | long_out)
    # a DNP row carries no rolling minutes of its own (features() computes them on played rows): take his last ones
    for c in ("m3", "m5", "m10", "start10", "mseason", "mprev", "n_prior"):
        P[c] = P.groupby("pid")[c].transform(lambda s: s.ffill())
    P = P[(P.type == 2) & P.m5.notna()].copy()
    P["mprev"] = P.mprev.fillna(P.m10); P["mseason"] = P.mseason.fillna(P.m10)
    P["abs_sp"] = P.spread.abs().fillna(P.spread.abs().median())
    P["st"] = P.starter.astype(float)
    P["early"] = np.exp(-P.n_prior.fillna(0) / 3)
    P["st_x_sp"] = P.st * P.abs_sp; P["vac_x_st"] = P.vacated * P.st
    NM.depth_cols(P)
    P["y"] = np.where(P.dnp, 0.0, P["min"].astype(float))
    return P


def main():
    P = prep()
    cols = NM.BASE_COLS + ["st", "st_x_sp", "vac_x_st"]
    seasons = sorted(P.season.unique()); out = []
    for s in seasons[2:]:
        tr = P[(P.season < s) & ~P.dnp]; te = P[(P.season == s) & P.avail].copy()
        X = np.column_stack([np.ones(len(tr))] + [tr[c].values for c in cols])
        b = dict(zip(["const"] + cols, np.linalg.lstsq(X, tr["min"].values, rcond=None)[0]))
        te["proj"] = b["const"] + sum(b[c] * te[c].values for c in cols)
        te["boost"] = sum(b[c] * te[c].values for c in DEPTH)
        out.append(te)
    T = pd.concat(out)
    T["proj"] = T.proj.clip(0, 44)
    on = T.proj >= 8
    T["tsum"] = T.proj.where(on, 0).groupby([T.gid, T.team]).transform("sum")
    T["bsum"] = T.boost.where(on, 0).groupby([T.gid, T.team]).transform("sum")
    pl = ~T.dnp & on
    print(f"{T.gid.nunique():,} games, {pl.sum():,} priced player-games that played ({seasons[2]}..{seasons[-1]})")
    print("uncapped team sum (8+ min projected):", T.drop_duplicates(["gid", "team"]).tsum.describe(percentiles=[.5, .9, .99]).round(1).to_dict())
    T["tb"] = pd.cut(T.tsum, [0, 250, 265, 280, 300, 999])
    def rule(name, C):
        if name == "none": return T.proj
        if name == "scale": return np.where(T.tsum > C, T.proj * C / T.tsum, T.proj)
        k = np.where((T.tsum > C) & (T.bsum > 0), np.clip(1 - (T.tsum - C) / T.bsum.clip(lower=1e-6), 0, 1), 1.0)
        return T.proj - (1 - k) * T.boost.clip(lower=0)
    print(f"\n{'rule':16s} {'MAE':>6s} {'bias':>6s}   by uncapped team sum: bias (MAE)")
    for name, C in [("none", 0)] + [(r, c) for r in ("scale", "boost") for c in (240, 250, 260, 270)]:
        m = rule(name, C); e = (m - T.y)[pl]
        by = pd.DataFrame({"e": e, "tb": T.tb[pl]}).groupby("tb", observed=True).e.agg(lambda v: f"{v.mean():+.2f} ({v.abs().mean():.2f})")
        print(f"{name + ' ' + str(C) if C else name:16s} {e.abs().mean():6.3f} {e.mean():+6.2f}   " + "  ".join(f"{k}: {v}" for k, v in by.items()))
    print("\nrows by uncapped sum:", T[pl].tb.value_counts(sort=False).to_dict())
    # per season, the best rule vs none
    for s, G in T[pl].groupby("season"):
        g = G.index
        print(f"  {s}: none {np.abs(T.proj[g] - T.y[g]).mean():.3f}  boost 250 {np.abs(pd.Series(rule('boost', 250), index=T.index)[g] - T.y[g]).mean():.3f}  scale 250 {np.abs(pd.Series(rule('scale', 250), index=T.index)[g] - T.y[g]).mean():.3f}")


if __name__ == "__main__" and "seg" not in sys.argv and "ceil" not in sys.argv and "part" not in sys.argv:
    main()


def segments():
    """Where research's own projection runs high: projected band, promotions, vacated."""
    P = prep(); cols = NM.BASE_COLS + ["st", "st_x_sp", "vac_x_st"]; seasons = sorted(P.season.unique()); out = []
    for s in seasons[2:]:
        tr = P[(P.season < s) & ~P.dnp]; te = P[(P.season == s) & ~P.dnp].copy()
        X = np.column_stack([np.ones(len(tr))] + [tr[c].values for c in cols]); b = np.linalg.lstsq(X, tr["min"].values, rcond=None)[0]
        te["proj"] = np.column_stack([np.ones(len(te))] + [te[c].values for c in cols]) @ b; out.append(te)
    T = pd.concat(out); T["e"] = T.proj.clip(0, 44) - T["min"]
    T["pb"] = pd.cut(T.proj, [0, 20, 28, 34, 38, 99]); T["promo"] = (T.st == 1) & (T.start10 < 0.3)
    T["vb"] = pd.cut(T.vacated, [-1, 0, 20, 50, 999])
    f = lambda G: G.e.agg(["size", "mean", lambda v: v.abs().mean()]).round(2).to_dict()
    print("by projected band:", {str(k): f(G) for k, G in T.groupby("pb", observed=True)})
    print("promoted starters (st 1, start10 < .3) by vacated:", {str(k): f(G) for k, G in T[T.promo].groupby("vb", observed=True)})
    print("regular starters by vacated:", {str(k): f(G) for k, G in T[(T.st == 1) & ~T.promo].groupby("vb", observed=True)})
    print("this season by projected band:", {str(k): f(G) for k, G in T[T.season == seasons[-1]].groupby("pb", observed=True)})


if __name__ == "__main__" and "seg" in sys.argv:
    segments()


def ceiling():
    """A soft ceiling: proj' = proj below K, K + c (proj - K) above. K, c fit on earlier seasons' walk-forward rows."""
    P = prep(); cols = NM.BASE_COLS + ["st", "st_x_sp", "vac_x_st"]; seasons = sorted(P.season.unique()); out = []
    for s in seasons[1:]:
        tr = P[(P.season < s) & ~P.dnp]; te = P[(P.season == s) & ~P.dnp].copy()
        X = np.column_stack([np.ones(len(tr))] + [tr[c].values for c in cols]); b = np.linalg.lstsq(X, tr["min"].values, rcond=None)[0]
        te["proj"] = (np.column_stack([np.ones(len(te))] + [te[c].values for c in cols]) @ b).clip(0, 44); out.append(te)
    T = pd.concat(out)
    ap = lambda p, K, c: np.where(p > K, K + c * (p - K), p)
    grid = [(K, c) for K in (30, 32, 34, 35, 36, 37, 38) for c in (0.0, 0.25, 0.4, 0.5, 0.6, 0.75, 1.0)]
    tot = {"none": [], "fit": []}
    for s in seasons[2:]:
        tr, te = T[T.season < s], T[T.season == s]
        K, c = min(grid, key=lambda kc: np.abs(ap(tr.proj.values, *kc) - tr["min"].values).mean())
        a0 = np.abs(te.proj - te["min"]); a1 = np.abs(ap(te.proj.values, K, c) - te["min"].values)
        hi = te.proj > 34
        print(f"  {s}: K {K} c {c}  MAE {a0.mean():.4f} -> {a1.mean():.4f}   proj 34+ (n {hi.sum()}): bias {(te.proj - te['min'])[hi].mean():+.2f} -> {(ap(te.proj.values, K, c) - te['min'].values)[hi.values].mean():+.2f}")
    K, c = min(grid, key=lambda kc: np.abs(ap(T.proj.values, *kc) - T["min"].values).mean())
    print(f"all seasons: K {K} c {c}")


if __name__ == "__main__" and "ceil" in sys.argv:
    ceiling()


def partial():
    P = prep(); cols = NM.BASE_COLS + ["st", "st_x_sp", "vac_x_st"]; seasons = sorted(P.season.unique()); out = []
    for s in seasons[2:]:
        tr = P[(P.season < s) & ~P.dnp]; te = P[(P.season == s) & P.avail].copy()
        X = np.column_stack([np.ones(len(tr))] + [tr[c].values for c in cols]); b = dict(zip(["const"] + cols, np.linalg.lstsq(X, tr["min"].values, rcond=None)[0]))
        te["proj"] = (b["const"] + sum(b[c] * te[c].values for c in cols)).clip(0, 44); te["boost"] = sum(b[c] * te[c].values for c in DEPTH); out.append(te)
    T = pd.concat(out); on = T.proj >= 8
    T["tsum"] = T.proj.where(on, 0).groupby([T.gid, T.team]).transform("sum"); T["bsum"] = T.boost.clip(lower=0).where(on, 0).groupby([T.gid, T.team]).transform("sum")
    pl = ~T.dnp & on; T["tb"] = pd.cut(T.tsum, [0, 265, 280, 300, 999])
    for C in (250, 265, 280):
        for f in (0.25, 0.5):
            cut = (f * (T.tsum - C)).clip(lower=0)
            k = 1 - (cut / T.bsum.clip(lower=1e-6)).clip(0, 1)
            m = (T.proj - (1 - k) * T.boost.clip(lower=0)).clip(upper=37)
            e = (m - T.y)[pl]; e0 = (T.proj.clip(upper=37) - T.y)[pl]
            by = pd.DataFrame({"e": e, "tb": T.tb[pl]}).groupby("tb", observed=True).e.agg(lambda v: f"{v.mean():+.2f}/{v.abs().mean():.2f}")
            seas = (pd.DataFrame({"a": e.abs(), "b": e0.abs(), "s": T.season[pl]}).groupby("s").apply(lambda g: g.a.mean() < g.b.mean(), include_groups=False)).sum()
            print(f"C {C} f {f}: MAE {e.abs().mean():.4f} vs cap-37 only {e0.abs().mean():.4f}  better in {seas}/{T.season.nunique()} seasons  " + " ".join(f"{k}:{v}" for k, v in by.items()))


if __name__ == "__main__" and "part" in sys.argv:
    partial()
