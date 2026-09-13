"""Completions: QB completion over/unders. Model, defense test, export.

Built on the receptions lessons, not rediscovered:
  * priors are windowed to 2 seasons, because that is all the Node port can
    compute (it loads two seasons of play-by-play). Receptions fitted on career
    priors the port never produced and the results replay caught a 12-point
    miscalibration.
  * the price is negative binomial. Completions are MORE over-dispersed than
    receptions: variance/mean 1.5-1.9 against 1.1-1.3.
  * wind is a measured multiplier on the mean, not a coefficient — as a
    coefficient against a mostly-zero column it came out far too weak.

What we already know about this market (measured before building):
  * the usage model barely beats a career average (MAE 4.663 -> 4.613), and
    last-3 is WORSE than the career prior — QB volume is season-stable.
  * summing receiver projections adds 0.4%: their errors share team volume and
    compound instead of cancelling.
  * wind is large: -10.1% completions at 20+ mph, -3.1 sigma, through fewer
    attempts AND a lower completion rate.

    python3 research/completions.py
"""
import json, os
import numpy as np
import pandas as pd

HERE = os.path.dirname(__file__)
CACHE = os.environ.get("PICKS_CACHE",
    "/private/tmp/claude-501/-Users-ron-Desktop-dong-tool/"
    "5857f821-b559-469c-a8ee-a9ffc542c6c6/scratchpad/nflcache")
SEASONS = list(range(2016, 2026))
K = 3.0
WINDOW = 2
LINES = [x + 0.5 for x in range(14, 29)]          # 14.5 .. 28.5
COLS = ["game_id", "season", "week", "posteam", "defteam", "home_team",
        "pass_attempt", "complete_pass", "passer_player_id", "sack",
        "spread_line", "total_line", "wind", "roof"]


def load():
    d = pd.concat([pd.read_parquet(f"{CACHE}/pbp_{y}.parquet", columns=COLS) for y in SEASONS],
                  ignore_index=True)
    d = d[d.posteam.notna()]
    p = d[(d.pass_attempt == 1) & d.passer_player_id.notna()]
    qb = p.groupby(["game_id", "season", "week", "posteam", "passer_player_id"], as_index=False).agg(
        att=("pass_attempt", "sum"), cmp=("complete_pass", "sum"))
    # the starter is the QB who threw most for his team; the market only quotes him
    qb = qb.sort_values("att", ascending=False).groupby(["game_id", "posteam"], as_index=False).first()
    g = d.groupby(["game_id", "posteam"], as_index=False).agg(
        defteam=("defteam", "first"), home=("home_team", "first"),
        sp=("spread_line", "first"), tot=("total_line", "first"),
        wind=("wind", "first"), roof=("roof", "first"))
    # defense faced: every pass attempt against this defense, any passer
    df_ = p.groupby(["game_id", "season", "week", "defteam"], as_index=False).agg(
        def_att=("pass_attempt", "sum"), def_cmp=("complete_pass", "sum"))
    qb = qb.merge(g, on=["game_id", "posteam"], how="left")
    qb = qb.rename(columns={"posteam": "team", "passer_player_id": "pid"})
    is_home = qb.team == qb.home
    qb["implied"] = np.where(is_home, qb.tot / 2 + qb.sp / 2, qb.tot / 2 - qb.sp / 2)
    qb["indoor"] = qb.roof.isin(["dome", "closed"]).astype(int)
    qb["wind"] = np.where(qb.indoor == 1, 0.0, qb.wind.fillna(0.0))
    return qb, df_


def windowed_prior(df, key, col, n_col=None, k=K, window=WINDOW, target=None):
    """Shrunk mean of `col` over the entity's earlier rows inside a `window`-season
    window — the same as-of subtraction as build_dataset.add_form."""
    df = df.sort_values([key, "season", "week"]).reset_index(drop=True)
    g = df.groupby(key, sort=False)[col]
    s = (g.cumsum() - df[col]).to_numpy(float)
    n = g.cumcount().to_numpy(float)
    per = (df.groupby([key, "season"])[col].agg(s="sum", n="size").reset_index()
             .sort_values([key, "season"]))
    pg = per.groupby(key); per["cs"] = pg["s"].cumsum(); per["cn"] = pg["n"].cumsum()
    left = pd.DataFrame({key: df[key].values, "k2": df["season"].values - window,
                         "_i": np.arange(len(df))}).sort_values("k2")
    a = pd.merge_asof(left, per[[key, "season", "cs", "cn"]].sort_values("season"),
                      left_on="k2", right_on="season", by=key, direction="backward").sort_values("_i")
    s = np.maximum(s - a.cs.fillna(0).to_numpy(), 0)
    n = np.maximum(n - a.cn.fillna(0).to_numpy(), 0)
    t = df[col].mean() if target is None else target
    df[col + "_prior"] = (s + k * t) / (n + k)
    df[col + "_n"] = n
    return df


def build():
    qb, dfn = load()
    qb = qb[qb.att >= 10].copy()
    qb["rate"] = qb.cmp / qb.att
    for c in ("cmp", "att", "rate"):
        qb = windowed_prior(qb, "pid", c)
    qb = qb.sort_values(["pid", "season", "week"]).reset_index(drop=True)
    qb["cmp_l3"] = qb.groupby("pid").cmp.transform(lambda s: s.shift(1).rolling(3, min_periods=1).mean())
    qb["cmp_l3"] = qb.cmp_l3.fillna(qb.cmp_prior)
    # defense: completions allowed per game and completion rate allowed, prior only
    dfn["def_rate"] = dfn.def_cmp / dfn.def_att.clip(lower=1)
    for c in ("def_cmp", "def_rate"):
        dfn = windowed_prior(dfn, "defteam", c)
    qb = qb.merge(dfn[["game_id", "defteam", "def_cmp_prior", "def_rate_prior"]],
                  on=["game_id", "defteam"], how="left")
    qb = qb.dropna(subset=["implied", "def_cmp_prior"])
    return qb


def irls(X, y, ridge=1.0, it=40):
    b = np.zeros(X.shape[1]); b[0] = np.log(max(y.mean(), 1e-3))
    for _ in range(it):
        mu = np.exp(np.clip(X @ b, -8, 5)); W = np.clip(mu, 1e-6, None)
        R = np.eye(X.shape[1]) * ridge; R[0, 0] = 0
        try: b += np.linalg.solve(X.T @ (X * W[:, None]) + R, X.T @ (y - mu) - R @ b)
        except np.linalg.LinAlgError: break
    return b


def design(df, fs, ref):
    return np.column_stack([np.ones(len(df))] + [(df[f].to_numpy(float) - ref[f][0]) / ref[f][1] for f in fs])


def nb_alpha(y, mu):
    return max(float((((y - mu) ** 2) - mu).sum() / (mu ** 2).sum()), 1e-4)


def nb_sf(line, mu, alpha):
    k = int(np.floor(line)); r = 1.0 / alpha; p = r / (r + mu)
    term = p ** r; cdf = term.copy()
    for i in range(1, k + 1):
        term = term * (r + i - 1) / i * (1 - p); cdf = cdf + term
    return np.clip(1 - cdf, 1e-6, 1 - 1e-6)


def walk(q, fs, first=2019):
    out, pairs = [], []
    for s in sorted(q.season.unique()):
        if s < first: continue
        tr = q[q.season < s]; te = q[q.season == s]
        if len(tr) < 800 or len(te) < 100: continue
        ref = {f: (tr[f].to_numpy(float).mean(), tr[f].to_numpy(float).std() + 1e-9) for f in fs}
        b = irls(design(tr, fs, ref), tr.cmp.to_numpy(float))
        mtr = np.exp(np.clip(design(tr, fs, ref) @ b, -8, 5))
        a = nb_alpha(tr.cmp.to_numpy(float), mtr)
        mu = np.exp(np.clip(design(te, fs, ref) @ b, -8, 5)); y = te.cmp.to_numpy(float)
        lls, n = 0.0, 0
        for L in LINES:
            m = (mu > L - 2) & (mu < L + 2)
            if m.sum() < 30: continue
            p = nb_sf(L, mu[m], a); o = (y[m] > L).astype(float)
            lls += -np.sum(o * np.log(p) + (1 - o) * np.log(1 - p)); n += m.sum()
        out.append((len(te), np.abs(y - mu).mean(), lls / max(n, 1)))
        pairs.append(te.assign(mu=mu))
    w = np.array([o[0] for o in out], float); w /= w.sum()
    return (sum(wi * o[1] for wi, o in zip(w, out)), sum(wi * o[2] for wi, o in zip(w, out)),
            pd.concat(pairs))


BASE = ["cmp_prior", "att_prior", "rate_prior", "implied"]


def main():
    q = build()
    q = q[q.cmp_n >= 3].copy()
    print(f"QB starts with 3+ prior starts in window: {len(q):,}\n")
    print("  %-46s %-8s %s" % ("feature set", "MAE", "line log loss"))
    base = walk(q, BASE)
    print("  %-46s %-8.3f %.5f" % ("BASE (usage + implied total)", base[0], base[1]))
    for lab, extra in (("+ last-3 completions", ["cmp_l3"]),
                       ("+ opp completions allowed / game", ["def_cmp_prior"]),
                       ("+ opp completion % allowed", ["def_rate_prior"]),
                       ("+ both pass-defense terms", ["def_cmp_prior", "def_rate_prior"])):
        r = walk(q, BASE + extra)
        flag = "   <-- REAL" if r[1] < base[1] - 0.001 else ""
        print("  %-46s %-8.3f %.5f  (%+.5f)%s" % (lab, r[0], r[1], r[1] - base[1], flag))


if __name__ == "__main__":
    main()


def factor_table(t, col, bins, monotone, min_n=80):
    """(x, multiplier) from out-of-sample actual/predicted by bin. x is each
    bin's MEAN, not its midpoint, so a skewed tail keeps its real location."""
    xs, ys = [], []
    for lo, hi in bins:
        g = t[(t[col] >= lo) & (t[col] < hi)]
        if len(g) < min_n: continue
        xs.append(float(g[col].mean())); ys.append(float(g.cmp.mean() / g.mu.mean()))
    ys = np.array(ys)
    ys = np.maximum.accumulate(ys) if monotone == "up" else np.minimum.accumulate(ys)
    return [round(v, 4) for v in xs], [round(float(v), 4) for v in ys]


def export():
    q = build(); q = q[q.cmp_n >= 3].copy()
    _, _, t = walk(q, BASE)

    # projection bias check (receptions needed a recalibration at the top)
    print("  bias by projection:")
    for lo, hi in [(0, 18), (18, 21), (21, 24), (24, 40)]:
        g = t[(t.mu >= lo) & (t.mu < hi)]
        print("    %5.1f-%-5.1f n=%-5d proj %.2f act %.2f" % (lo, hi, len(g), g.mu.mean(), g.cmp.mean()))

    # WIND: measured from out-of-sample error on outdoor starts
    out = t[t.indoor == 0]
    # the 20+ tail is small (~50 starts) but it is the only part that matters;
    # dropping it would clamp the curve at 16.5 mph and under-correct every
    # genuinely windy game
    wx, wy = factor_table(out, "wind", [(0, 5), (5, 10), (10, 15), (15, 20), (20, 70)], "down", min_n=40)
    base = wy[0]; wy = [min(1.0, round(v / base, 4)) for v in wy]
    # DEFENSE: completion % allowed. Softer defense never lowers the factor.
    t2 = t.copy()
    qs = np.quantile(t2.def_rate_prior, [0, .2, .4, .6, .8, 1.0]); qs[-1] += 1e-6
    dx, dy = factor_table(t2, "def_rate_prior", list(zip(qs[:-1], qs[1:])), "up")
    mid = float(np.interp(t2.def_rate_prior.median(), dx, dy))
    dy = [round(min(1.05, max(0.9, v / mid)), 4) for v in dy]

    ref = {f: (float(q[f].mean()), float(q[f].std() + 1e-9)) for f in BASE}
    X = design(q, BASE, ref); y = q.cmp.to_numpy(float)
    b = irls(X, y); mu = np.exp(np.clip(X @ b, -8, 5))
    alpha = nb_alpha(y, mu)
    outj = {
        "note": ("QB completions. Poisson GLM for the mean on 2-season-windowed priors, "
                 "priced negative binomial. Wind and opponent pass defense are measured "
                 "multipliers on the mean, not coefficients: both only bite at the extreme."),
        "features": BASE, "coef": {n: float(v) for n, v in zip(["intercept"] + BASE, b)},
        "scale": {f: {"mean": ref[f][0], "sd": ref[f][1]} for f in BASE},
        "alpha": float(alpha), "lines": LINES, "shrink_k": K, "window": WINDOW,
        "league": {"cmp": float(q.cmp.mean()), "att": float(q.att.mean()), "rate": float(q.rate.mean()),
                   "def_rate": float(q.def_rate_prior.mean())},
        "wind_factor": {"x": wx, "y": wy},
        "def_factor": {"x": dx, "y": dy},
        "trained_on": "2016-2025", "n_rows": int(len(q)),
    }
    json.dump(outj, open(os.path.join(HERE, "completions_model.json"), "w"), indent=1)
    print("\nwrote completions_model.json  alpha %.4f  n=%d" % (alpha, len(q)))
    print("  wind factor:", list(zip(wx, wy)))
    print("  def  factor:", list(zip(dx, dy)))
