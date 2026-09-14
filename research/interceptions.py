"""Interceptions: QB over 0.5 / 1.5 interceptions. Research before building.

Hypotheses under test:
  H1 (Power Rank, 2014)  completion % predicts interception rate. Their 32% of
     variance is the SAME career's numbers, which is description. The question
     that matters for pricing is whether LAST season's completion % predicts
     NEXT season's interceptions better than last season's interceptions do.
  H2 (Ron's matchup)     a QB's own interception rate against the defense's
     interception rate, the way the MLB K/BB tools meet pitcher and batter.
     Tested both as a fitted GLM and as a fixed log5 with no fitting at all.
  H3 which history       last season, two seasons, or career.

Method is the completions one: QB starts 2016-2025, every prior strictly
as-of the game (no leakage), walk-forward by season, log loss on the market
outcome P(1+ INT) and P(2+ INT).

    python3 research/interceptions.py
"""
import os, sys, warnings
warnings.filterwarnings('ignore')
import numpy as np
import pandas as pd

sys.path.insert(0, os.path.dirname(__file__))
from completions import CACHE, windowed_prior  # noqa: E402

SEASONS = list(range(2016, 2026))
COLS = ["game_id", "season", "week", "season_type", "posteam", "defteam", "home_team",
        "pass_attempt", "complete_pass", "interception", "passer_player_id", "sack",
        "air_yards", "cpoe", "qb_hit", "pass_defense_1_player_id", "spread_line", "total_line", "wind", "roof"]


def load():
    d = pd.concat([pd.read_parquet(f"{CACHE}/pbp_{y}.parquet", columns=COLS) for y in SEASONS],
                  ignore_index=True)
    d = d[d.posteam.notna()]
    # pass_attempt is 1 on sacks too. Kept that way on purpose: the Node port
    # (scripts/picks.js loadPbpLogs) counts attempts off the same flag.
    p = d[(d.pass_attempt == 1) & d.passer_player_id.notna()].copy()
    # a "bad ball": intercepted or broken up. nflverse records a pass defensed on
    # every interception, so this column alone counts both.
    p["bad"] = p.pass_defense_1_player_id.notna().astype(int)
    qb = p.groupby(["game_id", "season", "week", "posteam", "passer_player_id"], as_index=False).agg(
        att=("pass_attempt", "sum"), cmp=("complete_pass", "sum"), ints=("interception", "sum"), bad=("bad", "sum"),
        air=("air_yards", "sum"), air_cnt=("air_yards", "count"),
        cpoe=("cpoe", "sum"), cpoe_cnt=("cpoe", "count"))
    qb = qb.sort_values("att", ascending=False).groupby(["game_id", "posteam"], as_index=False).first()
    g = d.groupby(["game_id", "posteam"], as_index=False).agg(
        defteam=("defteam", "first"), home=("home_team", "first"),
        sp=("spread_line", "first"), tot=("total_line", "first"),
        wind=("wind", "first"), roof=("roof", "first"))
    qb = qb.merge(g, on=["game_id", "posteam"], how="left").rename(columns={"posteam": "team", "passer_player_id": "pid"})
    home = qb.team == qb.home
    qb["implied"] = np.where(home, qb.tot / 2 + qb.sp / 2, qb.tot / 2 - qb.sp / 2)
    qb["fav"] = np.where(home, qb.sp, -qb.sp)            # + = his team favoured
    qb["indoor"] = qb.roof.isin(["dome", "closed"]).astype(int)
    qb["wind"] = np.where(qb.indoor == 1, 0.0, qb.wind.fillna(0.0))
    # every pass thrown AT a defense, by anyone
    dfn = p.groupby(["game_id", "season", "week", "defteam"], as_index=False).agg(
        d_att=("pass_attempt", "sum"), d_int=("interception", "sum"), d_cmp=("complete_pass", "sum"), d_bad=("bad", "sum"))
    return qb, dfn


def rate_prior(df, key, num, den, k_den, window, name):
    """Attempt-weighted rate over the as-of window, shrunk toward the league rate
    by k_den pseudo-attempts: (ints + k*league) / (att + k)."""
    df = windowed_prior(df, key, num, k=0.0, window=window)
    df = windowed_prior(df, key, den, k=0.0, window=window)
    n = df[num + "_n"].to_numpy(float)
    s_num = df[num + "_prior"].fillna(0).to_numpy(float) * n
    s_den = df[den + "_prior"].fillna(0).to_numpy(float) * n
    lg = df[num].sum() / df[den].sum()
    df[name] = (s_num + k_den * lg) / (s_den + k_den)
    df[name + "_att"] = s_den
    return df.drop(columns=[num + "_prior", den + "_prior", num + "_n", den + "_n"])


def build(window=2, k_int=400, k_cmp=150, k_def=600, k_bad=300, k_dbad=600):
    qb, dfn = load()
    qb = qb[(qb.att >= 10) & qb.implied.notna()].copy()
    qb = rate_prior(qb, "pid", "ints", "att", k_int, window, "int_rate")
    qb = rate_prior(qb, "pid", "cmp", "att", k_cmp, window, "cmp_rate")
    qb = rate_prior(qb, "pid", "bad", "att", k_bad, window, "bad_rate")
    qb = rate_prior(qb, "pid", "cpoe", "cpoe_cnt", 150, window, "cpoe_p")   # already a residual; shrinks to league mean
    qb = rate_prior(qb, "pid", "air", "air_cnt", 150, window, "adot")
    qb = windowed_prior(qb, "pid", "att", k=3.0, window=window)
    dfn = rate_prior(dfn, "defteam", "d_int", "d_att", k_def, window, "def_int")
    dfn = rate_prior(dfn, "defteam", "d_cmp", "d_att", k_def, window, "def_cmp")
    dfn = rate_prior(dfn, "defteam", "d_bad", "d_att", k_dbad, window, "def_bad")
    qb = qb.merge(dfn[["game_id", "defteam", "def_int", "def_cmp", "def_bad"]], on=["game_id", "defteam"], how="left")
    qb["lg_int"] = qb.ints.sum() / qb.att.sum()
    for c in ("int_rate", "def_int", "bad_rate", "def_bad"):
        qb["log_" + c] = np.log(qb[c])
    qb["log_att"] = np.log(qb.att_prior)
    return qb


# ── reliability: is each rate a trait, or noise? ───────────────────────────
def split_half(qb, num, den, key="pid", min_den=150):
    """Odd vs even games within a season, Spearman-Brown corrected."""
    x = qb.sort_values([key, "season", "week"]).copy()
    x["half"] = x.groupby([key, "season"]).cumcount() % 2
    h = x.groupby([key, "season", "half"])[[num, den]].sum().unstack("half")
    h = h[(h[(den, 0)] >= min_den) & (h[(den, 1)] >= min_den)]
    r = np.corrcoef(h[(num, 0)] / h[(den, 0)], h[(num, 1)] / h[(den, 1)])[0, 1]
    return 2 * r / (1 + r), len(h)


def year_to_year(qb, min_att=250):
    s = qb.groupby(["pid", "season"])[["ints", "cmp", "att", "cpoe", "cpoe_cnt", "air", "air_cnt"]].sum().reset_index()
    s = s[s.att >= min_att]
    s["int_r"] = s.ints / s.att; s["cmp_r"] = s.cmp / s.att
    s["cpoe_r"] = s.cpoe / s.cpoe_cnt; s["adot"] = s.air / s.air_cnt
    nxt = s.copy(); nxt["season"] -= 1
    m = s.merge(nxt[["pid", "season", "int_r"]], on=["pid", "season"], suffixes=("", "_next"))
    out = {c: np.corrcoef(m[c], m.int_r_next)[0, 1] for c in ("int_r", "cmp_r", "cpoe_r", "adot")}
    # both together: does completion % add to last year's INT rate?
    X = np.column_stack([np.ones(len(m)), m.int_r, m.cmp_r])
    b, *_ = np.linalg.lstsq(X, m.int_r_next, rcond=None)
    r2_both = 1 - ((m.int_r_next - X @ b) ** 2).sum() / ((m.int_r_next - m.int_r_next.mean()) ** 2).sum()
    return out, r2_both, len(m)


# ── walk-forward pricing ──────────────────────────────────────────────────
def irls(X, y, ridge=1.0, it=50):
    b = np.zeros(X.shape[1]); b[0] = np.log(max(y.mean(), 1e-3))
    for _ in range(it):
        mu = np.exp(np.clip(X @ b, -8, 3)); W = np.clip(mu, 1e-6, None)
        R = np.eye(X.shape[1]) * ridge; R[0, 0] = 0
        try: b += np.linalg.solve(X.T @ (X * W[:, None]) + R, X.T @ (y - mu) - R @ b)
        except np.linalg.LinAlgError: break
    return b


def ll(p, o):
    p = np.clip(p, 1e-6, 1 - 1e-6)
    return float(-np.mean(o * np.log(p) + (1 - o) * np.log(1 - p)))


def probs(mu):
    """Poisson P(1+), P(2+). Checked below against the data's dispersion."""
    p0 = np.exp(-mu); p1 = mu * p0
    return 1 - p0, 1 - p0 - p1


def walk(q, fs=None, fixed=None, first=2019):
    """fs: GLM features (standardised). fixed: a function df -> mu, no fitting."""
    rows = []
    for s in range(first, 2026):
        tr, te = q[q.season < s], q[q.season == s]
        if fixed is not None:
            mu = fixed(te)
        else:
            ref = {f: (tr[f].mean(), tr[f].std() + 1e-9) for f in fs}
            X = lambda d: np.column_stack([np.ones(len(d))] + [(d[f] - ref[f][0]) / ref[f][1] for f in fs])
            b = irls(X(tr), tr.ints.to_numpy(float))
            mu = np.exp(np.clip(X(te) @ b, -8, 3))
        rows.append(te.assign(mu=mu))
    t = pd.concat(rows)
    p1, p2 = probs(t.mu.to_numpy())
    o1, o2 = (t.ints >= 1).to_numpy(float), (t.ints >= 2).to_numpy(float)
    return ll(p1, o1), ll(p2, o2), t


def main():
    print("Interceptions research — QB starts 2016-2025\n")
    q = build(window=2)
    print(f"league INT rate {q.ints.sum() / q.att.sum():.4f} per attempt · "
          f"{(q.ints >= 1).mean():.3f} of starts have 1+ · {(q.ints >= 2).mean():.3f} have 2+")
    v = q.ints.var() / q.ints.mean()
    print(f"variance/mean of INTs per start {v:.2f} (1.00 = Poisson)\n")

    print("RELIABILITY (split-half, Spearman-Brown) — trait or noise?")
    for lab, num, den, key in (("QB INT rate", "ints", "att", "pid"), ("QB completion %", "cmp", "att", "pid"),
                               ("QB CPOE", "cpoe", "cpoe_cnt", "pid"), ("QB depth of target", "air", "air_cnt", "pid")):
        r, n = split_half(q, num, den, key); print(f"  {lab:28s} {r:+.3f}  ({n} QB-seasons)")
    _, dfn = load()
    for lab, num in (("Defense INT rate", "d_int"), ("Defense completion % allowed", "d_cmp")):
        r, n = split_half(dfn, num, "d_att", "defteam", min_den=200); print(f"  {lab:28s} {r:+.3f}  ({n} team-seasons)")

    r, n = split_half(q, "bad", "att", "pid"); print(f"  {'QB bad-ball rate':28s} {r:+.3f}  ({n} QB-seasons)")
    r, n = split_half(dfn, "d_bad", "d_att", "defteam", min_den=200); print(f"  {'Defense bad-ball rate':28s} {r:+.3f}  ({n} team-seasons)")
    yy, r2both, n = year_to_year(q)
    print(f"\nH1: THIS season's number vs NEXT season's INT rate ({n} QB pairs, 250+ att both years)")
    print(f"  INT rate  r={yy['int_r']:+.3f}   completion %  r={yy['cmp_r']:+.3f}   "
          f"CPOE r={yy['cpoe_r']:+.3f}   depth r={yy['adot']:+.3f}")
    print(f"  R² INT rate alone {yy['int_r']**2:.3f} · completion % alone {yy['cmp_r']**2:.3f} · both {r2both:.3f}")

    q3 = q[q.att_n >= 3].copy()
    lg = q3.ints.sum() / q3.att.sum()
    print(f"\nPRICING, walk-forward 2019-2025 ({len(q3):,} starts with 3+ prior starts) — log loss, lower is better")
    print(f"  {'model':52s} {'1+ INT':>9s} {'2+ INT':>9s}")
    base1, base2, _ = walk(q3, fixed=lambda d: d.att_prior * lg)
    print(f"  {'A  league rate x his attempts':52s} {base1:9.5f} {base2:9.5f}")
    rows = [
        ("B  + his INT rate (fixed, no fit)",           None, lambda d: d.att_prior * d.int_rate),
        ("C  + defense INT rate (fixed log5: Ron)",      None, lambda d: d.att_prior * d.int_rate * d.def_int / lg),
        ("D  GLM: attempts, his INT rate",              ["log_att", "log_int_rate"], None),
        ("E  D + defense INT rate (fitted matchup)",    ["log_att", "log_int_rate", "log_def_int"], None),
        ("F  D + completion % (Power Rank)",            ["log_att", "log_int_rate", "cmp_rate"], None),
        ("G  D + CPOE",                                 ["log_att", "log_int_rate", "cpoe_p"], None),
        ("H  D + depth of target",                      ["log_att", "log_int_rate", "adot"], None),
        ("I  D + game script (implied total, spread)",  ["log_att", "log_int_rate", "implied", "fav"], None),
        ("J  D + wind",                                 ["log_att", "log_int_rate", "wind"], None),
        ("K  everything",                               ["log_att", "log_int_rate", "log_def_int", "cmp_rate", "cpoe_p",
                                                         "adot", "implied", "fav", "wind", "def_cmp"], None),
    ]
    for lab, fs, fx in rows:
        a, b, _ = walk(q3, fs=fs, fixed=fx)
        print(f"  {lab:52s} {a:9.5f} {b:9.5f}   ({a - base1:+.5f})")

    print("\nH3: which history window (model E)")
    for w in (1, 2, 99):
        qw = build(window=w); qw = qw[qw.att_n >= 3]
        a, b, _ = walk(qw, fs=["log_att", "log_int_rate", "log_def_int"])
        print(f"  window {('career' if w == 99 else str(w) + ' season'):10s} {a:9.5f} {b:9.5f}   ({len(qw):,} starts)")


def paired(ta, tb):
    """Per-start log-loss difference (b - a) on the 1+ market: mean and SE."""
    m = ta[["game_id", "pid", "ints", "mu"]].merge(tb[["game_id", "pid", "mu"]], on=["game_id", "pid"], suffixes=("_a", "_b"))
    o = (m.ints >= 1).to_numpy(float)
    def rowll(mu):
        p = np.clip(1 - np.exp(-mu), 1e-6, 1 - 1e-6); return -(o * np.log(p) + (1 - o) * np.log(1 - p))
    d = rowll(m.mu_b.to_numpy()) - rowll(m.mu_a.to_numpy())
    return d.mean(), d.std(ddof=1) / np.sqrt(len(d)), len(d)


def auc(p, o):
    order = np.argsort(p); ranks = np.empty(len(p)); ranks[order] = np.arange(1, len(p) + 1)
    pos = o == 1
    return (ranks[pos].sum() - pos.sum() * (pos.sum() + 1) / 2) / (pos.sum() * (~pos).sum())


def deep():
    q = build(window=2); q = q[q.att_n >= 3].copy()
    lg = q.ints.sum() / q.att.sum()
    print("\nDEEP — same 2019-2025 sample, paired vs model A (negative = better; |t|>2 ≈ real)")
    _, _, tA = walk(q, fixed=lambda d: d.att_prior * lg)
    base = ["log_att", "implied", "fav"]
    specs = [
        ("S  attempts + game script",                     base),
        ("S + his INT rate",                              base + ["log_int_rate"]),
        ("S + his bad-ball rate (Power Rank 2020)",       base + ["log_bad_rate"]),
        ("S + completion % (Power Rank 2014)",            base + ["cmp_rate"]),
        ("S + defense INT rate (Ron's matchup)",          base + ["log_def_int"]),
        ("S + defense bad-ball rate",                     base + ["log_def_bad"]),
        ("S + QB INT + defense INT (matchup, fitted)",    base + ["log_int_rate", "log_def_int"]),
        ("S + QB bad-ball + defense bad-ball",            base + ["log_bad_rate", "log_def_bad"]),
        ("S + all four rates",                            base + ["log_int_rate", "log_def_int", "log_bad_rate", "log_def_bad"]),
        ("S + all four + depth + CPOE",                   base + ["log_int_rate", "log_def_int", "log_bad_rate", "log_def_bad", "adot", "cpoe_p"]),
    ]
    o = (q.ints >= 1).to_numpy(float)
    for lab, fs in specs:
        l1, l2, t = walk(q, fs=fs)
        dm, se, n = paired(tA, t)
        p1 = 1 - np.exp(-t.mu.to_numpy())
        print(f"  {lab:46s} 1+ {l1:.5f}  2+ {l2:.5f}  d={dm:+.5f} t={dm / se:+.1f}  AUC {auc(p1, (t.ints >= 1).to_numpy()):.3f}")

    print("\nSHRINKAGE — pseudo-attempts toward league (model: S + QB INT + defense INT)")
    for k_int in (400, 1500, 4000):
        for k_def in (600, 2000, 6000):
            qq = build(window=2, k_int=k_int, k_def=k_def); qq = qq[qq.att_n >= 3]
            l1, l2, _ = walk(qq, fs=base + ["log_int_rate", "log_def_int"])
            print(f"  k_int {k_int:5d} k_def {k_def:5d}   1+ {l1:.5f}  2+ {l2:.5f}")

    print("\nWINDOW — same starts for all three (model: S + QB INT + defense INT)")
    keys = None; res = {}
    for w in (1, 2, 99):
        qw = build(window=w); qw = qw[qw.att_n >= 3]
        res[w] = qw; k = set(zip(qw.game_id, qw.pid)); keys = k if keys is None else keys & k
    for w, qw in res.items():
        qw = qw[[ (g, p) in keys for g, p in zip(qw.game_id, qw.pid)]]
        l1, l2, _ = walk(qw, fs=base + ["log_int_rate", "log_def_int"])
        print(f"  {('career' if w == 99 else str(w) + ' season'):10s} 1+ {l1:.5f}  2+ {l2:.5f}   ({len(qw):,} starts)")


FEATS = ["log_att", "implied", "fav", "log_bad_rate", "log_def_int"]
K_ATT, K_BAD, K_DEF = 3.0, 300, 600
LINES = [0.5, 1.5, 2.5]


def export():
    """The shipped model: attempts + game script + QB bad-ball rate + defense
    INT rate, Poisson mean priced negative binomial."""
    import json
    q = build(window=2, k_bad=K_BAD, k_def=K_DEF)
    q3 = q[q.att_n >= 3].copy()
    l1, l2, t = walk(q3, fs=FEATS)
    t["p1"] = 1 - np.exp(-t.mu)
    t["qn"] = pd.qcut(t.p1, 5, labels=False)
    print(f"walk-forward 1+ {l1:.5f}  2+ {l2:.5f}")
    print(t.assign(hit=(t.ints >= 1)).groupby("qn").agg(n=("hit", "size"), said=("p1", "mean"), hit=("hit", "mean")).round(3))

    # thin history: a starter with 0-2 recent starts is shrunk to a league QB;
    # measure what that costs, relative to the trained population
    rows = []
    for s_ in range(2019, 2026):
        tr, te = q[(q.season < s_) & (q.att_n >= 3)], q[q.season == s_]
        ref = {f: (tr[f].mean(), tr[f].std() + 1e-9) for f in FEATS}
        X = lambda d: np.column_stack([np.ones(len(d))] + [(d[f] - ref[f][0]) / ref[f][1] for f in FEATS])
        b = irls(X(tr), tr.ints.to_numpy(float))
        rows.append(te.assign(mu=np.exp(np.clip(X(te) @ b, -8, 3))))
    tt = pd.concat(rows)
    ratio = lambda g: float(g.ints.sum() / g.mu.sum())
    ref3 = ratio(tt[tt.att_n >= 3])
    thin = {"0": ratio(tt[tt.att_n == 0]) / ref3, "1": ratio(tt[tt.att_n.between(1, 2)]) / ref3}
    thin["2"] = thin["1"]
    print("thin history: n0 %d n1-2 %d" % ((tt.att_n == 0).sum(), tt.att_n.between(1, 2).sum()),
          {k: round(v, 3) for k, v in thin.items()})

    ref = {f: (float(q3[f].mean()), float(q3[f].std() + 1e-9)) for f in FEATS}
    X = np.column_stack([np.ones(len(q3))] + [(q3[f] - ref[f][0]) / ref[f][1] for f in FEATS])
    y = q3.ints.to_numpy(float)
    b = irls(X, y); mu = np.exp(X @ b)
    alpha = max(float((((y - mu) ** 2) - mu).sum() / (mu ** 2).sum()), 1e-4)
    league = {"att": float(q3.att.mean()),
              "bad_rate": float(q.bad.sum() / q.att.sum()),
              "def_int": float(q.ints.sum() / q.att.sum())}
    out = {
        "note": ("QB interceptions. Poisson GLM for the mean, priced negative binomial. "
                 "Features: projected attempts, implied team total, spread, the QB's bad-ball rate "
                 "(INT + passes defensed per attempt) and the opponent defense's INT rate, all "
                 "2-season-windowed and shrunk. His own INT rate is left out: split-half 0.10, noise."),
        "features": FEATS, "coef": {n: float(v) for n, v in zip(["intercept"] + FEATS, b)},
        "scale": {f: {"mean": ref[f][0], "sd": ref[f][1]} for f in FEATS},
        "alpha": alpha, "lines": LINES, "window": 2,
        "shrink": {"att_starts": K_ATT, "bad_att": K_BAD, "def_att": K_DEF},
        "league": league, "thin_factor": {k: round(v, 4) for k, v in thin.items()},
        "trained_on": "2016-2025", "n_rows": int(len(q3)),
    }
    json.dump(out, open(os.path.join(os.path.dirname(__file__), "interceptions_model.json"), "w"), indent=1)
    print("wrote interceptions_model.json", {k: round(v, 4) for k, v in out["coef"].items()}, "alpha", round(alpha, 4), league)


if __name__ == "__main__":
    if "--export" in sys.argv: export()
    elif "--deep" in sys.argv: deep()
    else: main()
