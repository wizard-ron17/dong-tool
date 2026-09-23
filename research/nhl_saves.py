"""Goalie saves and goals allowed — walk-forward ladders, calibration, export.

Saves: Poisson GLM for the mean, priced through a negative binomial (starts
run variance/mean 2.2 — the most over-dispersed market we measured). Goals
allowed: a Poisson GLM mean, priced through a distribution TIGHTER than
Poisson (variance/mean 0.84 — a goalie who leaks gets pulled, which truncates
the tail); the ladder decides between Poisson and a binomial matched to the
measured dispersion.

    python3 research/nhl_saves.py              # ladders + calibration
    python3 research/nhl_saves.py --export     # write nhl_saves_model.json
"""
import json, os, sys
import numpy as np
import pandas as pd
from scipy.stats import binom, poisson
from nhl_sog import poisson_irls, nb_dispersion, nb_sf

HERE = os.path.dirname(os.path.abspath(__file__))
D = pd.read_parquet(os.path.join(HERE, "nhl_saves.parquet"))

# Rates on a log scale, per the shots-model calibration finding.
LOG_FEATS = ["sv_prior", "sv_l5", "sv_l10", "sa_prior", "sa_l10", "team_sa_prior", "team_sa_l10",
             "opp_sf_prior", "opp_sf_l10", "ga_prior", "ga_l10", "team_ga_prior", "opp_gf_prior"]
for f in LOG_FEATS:
    D["log_" + f] = np.log(D[f].clip(lower=0) + 0.1)
# save % enters as log odds of a GOAL — the quantity goals allowed is proportional to
D["lgt_miss"] = np.log((1 - D.svp_prior) / D.svp_prior)
# ── The shipped saves design ────────────────────────────────────────────────
# League saves per start fell every season (27.3 -> 24.1 over the four here), and
# a model fitted on earlier seasons lands off-level on later ones: out of sample
# the plain GLM ran 0.4-0.9 saves low a season. So the league LEVEL is an
# offset (coefficient fixed at 1) and every other rate is RELATIVE to that
# night's slate: mu = league_30d x exp(relative terms).
from nhl_saves_data import load_goalies
LVL_DAYS, LVL_MIN = 30, 50
def _league_level():
    g = load_goalies(); g = g[g.start == 1]
    day = g.groupby("date").agg(sv=("sv", "sum"), n=("sv", "size")).sort_index()
    day.index = pd.to_datetime(day.index)
    r = day.rolling(f"{LVL_DAYS}D", closed="left").sum()
    lvl = (r.sv / r.n).where(r.n >= LVL_MIN)
    # the season's first weeks sit after the offseason gap: last season's level
    per_season = g.groupby("season").sv.mean()
    prev = D.season.map(lambda s_: per_season.get(s_ - 10001, np.nan))
    out = pd.to_datetime(D.date).map(lvl).to_numpy()
    return np.where(np.isnan(out), prev.fillna(g.sv.mean()).to_numpy(), out)
D["lg_sv"] = _league_level()
for f in ("sv_prior", "sv_l5", "sv_l10", "team_sa_prior", "team_sa_l10", "opp_sf_prior", "opp_sf_l10"):
    D["rel_" + f] = np.log(D[f] / D.groupby(["season", "date"])[f].transform("mean"))
SV_REL = ["rel_sv_prior", "rel_sv_l5", "rel_sv_l10", "rel_team_sa_prior", "rel_team_sa_l10",
          "rel_opp_sf_prior", "rel_opp_sf_l10", "lgt_miss", "is_home", "team_b2b", "opp_b2b"]


def irls_off(X, y, off, ridge=1.0, it=60):
    """Poisson IRLS with a fixed offset."""
    b = np.zeros(X.shape[1]); b[0] = np.log(y.mean()) - off.mean()
    for _ in range(it):
        eta = np.clip(X @ b + off, -6, 6); mu = np.exp(eta)
        z = eta - off + (y - mu) / mu
        A = X.T @ (X * mu[:, None]) + ridge * np.eye(X.shape[1]); A[0, 0] -= ridge
        nb_ = np.linalg.solve(A, X.T @ (mu * z))
        if np.max(np.abs(nb_ - b)) < 1e-10: return nb_
        b = nb_
    return b


def sv_fit(tr):
    """Mean + the two-component price. Saves have a LEFT tail — a goalie who gets
    pulled keeps about half a game's saves — which a single right-skewed NB
    cannot draw: its median sits below its mean and every over near the middle
    hits more than priced. So: (1 - pi) x NB(full game) + pi x NB(pulled)."""
    feats = list(SV_REL)                          # captured: the closure must not follow a later rebind
    ref = {f: (tr[f].mean(), tr[f].std() or 1.0) for f in feats}
    b = irls_off(design(tr, feats, ref), tr.sv.to_numpy(float), np.log(tr.lg_sv.to_numpy()))
    mu_of = lambda df: np.exp(np.clip(design(df, feats, ref) @ b + np.log(df.lg_sv.to_numpy()), -6, 6))
    mu, y, pl = mu_of(tr), tr.sv.to_numpy(float), tr.pulled.to_numpy() == 1
    m = dict(b=b, ref=ref, pi=float(pl.mean()),
             cf=float(y[~pl].sum() / mu[~pl].sum()), cp=float(y[pl].sum() / mu[pl].sum()))
    m["af"] = nb_dispersion(y[~pl], m["cf"] * mu[~pl]); m["ap"] = nb_dispersion(y[pl], m["cp"] * mu[pl])
    m["mu_of"] = mu_of
    return m


def sv_sf(L, mu, m):
    return (1 - m["pi"]) * nb_sf(L, m["cf"] * mu, m["af"]) + m["pi"] * nb_sf(L, m["cp"] * mu, m["ap"])


SV_LINES = [20.5, 22.5, 24.5, 26.5, 28.5, 30.5, 32.5]
GA_LINES = [0.5, 1.5, 2.5, 3.5, 4.5]
SEASONS = sorted(D.season.unique())


def design(df, feats, ref):
    X = [np.ones(len(df))]
    for f in feats:
        X.append((df[f].to_numpy(float) - ref[f][0]) / ref[f][1])
    return np.column_stack(X)


def fit(tr, feats, target):
    ref = {f: (tr[f].mean(), tr[f].std() or 1.0) for f in feats}
    b = poisson_irls(design(tr, feats, ref), tr[target].to_numpy(float))
    return b, ref


def predict(df, b, ref, feats):
    return np.exp(np.clip(design(df, feats, ref) @ b, -6, 6))


def ll(p, hit):
    p = np.clip(p, 1e-6, 1 - 1e-6)
    return float(-(hit * np.log(p) + (1 - hit) * np.log(1 - p)).mean())


# ── Goals-allowed distributions ─────────────────────────────────────────────
# Binomial(n, q) with n chosen so Var/Mean = d: Var = mu(1 - q) = mu*d -> q = 1-d,
# n = mu/q. d is measured on the TRAINING residuals, never the test season.
def ga_disp(y, mu):
    return float(np.clip(((y - mu) ** 2).sum() / mu.sum(), 0.3, 1.0))


def ga_sf(line, mu, d, kind):
    if kind == "poisson" or np.all(np.asarray(d) >= 0.999):
        return poisson.sf(np.floor(line), mu)
    q = 1 - d
    n = np.maximum(np.round(mu / q), np.ceil(line) + 1)
    return binom.sf(np.floor(line), n, mu / n)


def walk(feats, target, kind=None):
    rows = []
    for s in SEASONS[1:]:
        tr, te = D[D.season < s], D[D.season == s]
        b, ref = fit(tr, feats, target)
        mu_tr, mu = predict(tr, b, ref, feats), predict(te, b, ref, feats)
        y_tr, y = tr[target].to_numpy(float), te[target].to_numpy(float)
        if target == "sv":
            a = nb_dispersion(y_tr, mu_tr)
            lls = [ll(nb_sf(L, mu, a), (y > L).astype(float)) for L in SV_LINES]
        else:
            d = ga_disp(y_tr, mu_tr)
            lls = [ll(ga_sf(L, mu, d, kind), (y > L).astype(float)) for L in GA_LINES]
        rows.append((len(te), float(np.abs(y - mu).mean()), float(np.mean(lls))))
    n = sum(r[0] for r in rows)
    return dict(mae=sum(r[1] * r[0] for r in rows) / n, ll=sum(r[2] * r[0] for r in rows) / n)


SV_LADDER = [
    ("S0  league mean",                     []),
    ("S1  + goalie saves/start",            ["log_sv_prior"]),
    ("S2  + last-5/10 saves",               ["log_sv_prior", "log_sv_l5", "log_sv_l10"]),
    ("S3  + own team shots against",        ["log_sv_prior", "log_sv_l5", "log_sv_l10", "log_team_sa_prior", "log_team_sa_l10"]),
    ("S4  + opponent shots for",            ["log_sv_prior", "log_sv_l5", "log_sv_l10", "log_team_sa_prior", "log_team_sa_l10", "log_opp_sf_prior", "log_opp_sf_l10"]),
    ("S5  + save %",                        ["log_sv_prior", "log_sv_l5", "log_sv_l10", "log_team_sa_prior", "log_team_sa_l10", "log_opp_sf_prior", "log_opp_sf_l10", "lgt_miss"]),
    ("S6  + home, back-to-backs",           ["log_sv_prior", "log_sv_l5", "log_sv_l10", "log_team_sa_prior", "log_team_sa_l10", "log_opp_sf_prior", "log_opp_sf_l10", "lgt_miss", "is_home", "team_b2b", "opp_b2b"]),
    ("S7  + pull rate",                     ["log_sv_prior", "log_sv_l5", "log_sv_l10", "log_team_sa_prior", "log_team_sa_l10", "log_opp_sf_prior", "log_opp_sf_l10", "lgt_miss", "is_home", "team_b2b", "opp_b2b", "pull_prior"]),
]
GA_LADDER = [
    ("G0  league mean",                     []),
    ("G1  + goalie GA/start",               ["log_ga_prior"]),
    ("G2  + save %",                        ["log_ga_prior", "lgt_miss"]),
    ("G3  + own team GA, shots against",    ["log_ga_prior", "lgt_miss", "log_team_ga_prior", "log_team_sa_prior"]),
    ("G4  + opponent goals/shots for",      ["log_ga_prior", "lgt_miss", "log_team_ga_prior", "log_team_sa_prior", "log_opp_gf_prior", "log_opp_sf_prior"]),
    ("G5  + last-10 GA",                    ["log_ga_prior", "lgt_miss", "log_team_ga_prior", "log_team_sa_prior", "log_opp_gf_prior", "log_opp_sf_prior", "log_ga_l10"]),
    ("G6  + home, back-to-backs",           ["log_ga_prior", "lgt_miss", "log_team_ga_prior", "log_team_sa_prior", "log_opp_gf_prior", "log_opp_sf_prior", "log_ga_l10", "is_home", "team_b2b", "opp_b2b"]),
]


def sv_walk():
    rows = []
    for s_ in SEASONS[1:]:
        tr, te = D[D.season < s_], D[D.season == s_]
        m = sv_fit(tr); mu = m["mu_of"](te); y = te.sv.to_numpy(float)
        rows.append((len(te), float(np.abs(y - mu).mean()), float(np.mean([ll(sv_sf(L, mu, m), (y > L).astype(float)) for L in SV_LINES]))))
    n = sum(r[0] for r in rows)
    return dict(mae=sum(r[1] * r[0] for r in rows) / n, ll=sum(r[2] * r[0] for r in rows) / n)


def ladders():
    print(f"{len(D):,} starts · test seasons {SEASONS[1:]}\n")
    print("SAVES — NB ladder log loss over lines", SV_LINES)
    base = None
    for name, f in SV_LADDER:
        r = walk(f, "sv")
        base = base or r["ll"]
        print(f"  {name:36s} ll {r['ll']:.5f} ({(r['ll'] / base - 1) * 100:+.2f}%)  mae {r['mae']:.3f}")
    r = sv_walk()
    print(f"  {'SHIPPED league level x relative, pull mix':36s} ll {r['ll']:.5f} ({(r['ll'] / base - 1) * 100:+.2f}%)  mae {r['mae']:.3f}")
    print("\nGOALS ALLOWED — ladder log loss over lines", GA_LINES)
    base = None
    for name, f in GA_LADDER:
        rp, rb = walk(f, "ga", "poisson"), walk(f, "ga", "binom")
        base = base or rp["ll"]
        print(f"  {name:36s} poisson {rp['ll']:.5f} ({(rp['ll'] / base - 1) * 100:+.2f}%)  "
              f"binomial {rb['ll']:.5f} ({(rb['ll'] / base - 1) * 100:+.2f}%)  mae {rp['mae']:.3f}")


def control(feats, target):
    """Shuffle the features within season: any gain that survives is leakage."""
    global D
    keep = D
    rng = np.random.default_rng(7)
    D = D.copy()
    for f in feats:
        D[f] = D.groupby("season")[f].transform(lambda x: x.sample(frac=1, random_state=int(rng.integers(1e9))).to_numpy())
    r = walk(feats, target, "binom")
    D = keep
    return r


# SAVES ships S6. Pull rate (S7) and save % (S5) added nothing. The top decile
# of projections runs ~1.5 saves hot out of sample — ENTIRELY pulls: with the
# goalie's full-game starts only, the top quintile is exact (29.16 vs 29.16).
# Tried and rejected, all walk-forward (research/nhl_saves_cal.py + session
# notes): heavy ridge (no change), nested linear shrink (ll worse), nested
# isotonic (quoted ECE 1.46 -> 2.71pp), a full-game / pulled NB mixture with a
# logistic pull risk (2.02pp), and a nested log-quadratic curve (2.58pp).
# SUPERSEDED by sv_fit(): the level offset + relative features + pull mixture
# took quoted-line error to 0.54pp, fixed the top end (28.2 projected vs 28.1),
# and has the best log loss of anything tried. SV_SHIPPED stays for the ladder.
SV_SHIPPED = SV_LADDER[-2][1]
# GOALS ALLOWED is close to a null — the ladder's best is -0.3% over the league
# mean, and its spread is far too wide (projected 3.6 went 3.1). What survives:
# a lean team-level model shrunk toward the mean by a factor fitted on nested
# out-of-sample predictions (k 0.64 on all seasons; ~0.79 walk-forward), priced through a binomial matched to the
# measured under-dispersion (o1.5: 0.790 predicted vs 0.790 actual; Poisson
# says 0.760). The rest of goals allowed is the game total — a betting-line
# input this feed does not have.
GA_SHIPPED = ["log_team_ga_prior", "log_opp_gf_prior", "is_home", "team_b2b", "opp_b2b"]
GA_KIND = "binom"


def oos():
    """Out-of-sample predictions for every test season, for the tables below."""
    out = []
    for s in SEASONS[1:]:
        tr, te = D[D.season < s], D[D.season == s].copy()
        m = sv_fit(tr); te["mu_sv"] = m["mu_of"](te); te["_m"] = [m] * len(te)
        b, ref = fit(tr, GA_SHIPPED, "ga"); te["mu_ga"] = predict(te, b, ref, GA_SHIPPED)
        te["d"] = ga_disp(tr.ga.to_numpy(float), predict(tr, b, ref, GA_SHIPPED))
        out.append(te)
    return pd.concat(out)


def calibration():
    o = oos()
    print("\nSAVES by projection (out of sample)")
    o["bin"] = pd.cut(o.mu_sv, [0, 22, 24, 26, 28, 30, 99])
    print(o.groupby("bin", observed=True).agg(n=("sv", "size"), proj=("mu_sv", "mean"), actual=("sv", "mean")).round(2).to_string())
    print("\nSAVES quoted-line calibration: at each start, the line nearest even")
    rows = []
    Ls = np.arange(14.5, 41.5)
    for s_, g in o.groupby("season"):
        m = g._m.iloc[0]; mu = g.mu_sv.to_numpy()
        M = np.column_stack([sv_sf(L, mu, m) for L in Ls]); j = np.abs(M - 0.5).argmin(1)
        rows += list(zip(M[np.arange(len(g)), j], (g.sv.to_numpy() > Ls[j]).astype(float)))
    q = pd.DataFrame(rows, columns=["p", "hit"]); q["b"] = pd.cut(q.p, [0, .45, .5, .55, 1])
    t = q.groupby("b", observed=True).agg(n=("p", "size"), p=("p", "mean"), hit=("hit", "mean"))
    print(t.round(3).to_string()); print(f"  ECE {np.average((t.p - t.hit).abs(), weights=t.n) * 100:.2f}pp")
    print("\nSAVES by goalie (25+ starts, OOS): top/bottom residual")
    g = o.groupby("name").agg(n=("sv", "size"), proj=("mu_sv", "mean"), actual=("sv", "mean"))
    g = g[g.n >= 25]; g["res"] = (g.actual / g.proj - 1) * 100
    print(g.sort_values("res").iloc[[0, 1, 2, -3, -2, -1]].round(2).to_string())
    print(f"  spread of per-goalie residual: sd {g.res.std():.2f}%  (|res|>5%: {(g.res.abs() > 5).mean():.0%})")

    print("\nGOALS ALLOWED by projection (out of sample)")
    o["gbin"] = pd.cut(o.mu_ga, [0, 2.4, 2.7, 3.0, 3.3, 99])
    print(o.groupby("gbin", observed=True).agg(n=("ga", "size"), proj=("mu_ga", "mean"), actual=("ga", "mean")).round(3).to_string())
    print("\nGOALS ALLOWED by line: predicted P(over) vs actual")
    for L in GA_LINES:
        pp = ga_sf(L, o.mu_ga.to_numpy(), float(o.d.mean()), "poisson")
        pb = ga_sf(L, o.mu_ga.to_numpy(), float(o.d.mean()), "binom")
        print(f"  o{L}: actual {(o.ga > L).mean():.3f}   binomial {pb.mean():.3f}   poisson {pp.mean():.3f}")


def backtest():
    """Walk-forward tables for the app's Results drawer, one per market —
    the same three shots/model.backtest carries."""
    import nhl_saves_cal as C
    o = []
    for s_ in SEASONS[1:]:
        tr, te = D[D.season < s_], D[D.season == s_].copy()
        m = sv_fit(tr); te["mu_sv"] = m["mu_of"](te)
        for k in ("pi", "cf", "cp", "af", "ap"): te["_" + k] = m[k]
        b, ref = fit(tr, GA_SHIPPED, "ga")
        k, m = C.nested_k(tr, GA_SHIPPED, "ga", 1.0), float(tr.ga.mean())
        mu_tr = m + k * (predict(tr, b, ref, GA_SHIPPED) - m)
        te["mu_ga"] = m + k * (predict(te, b, ref, GA_SHIPPED) - m)
        te["d"] = ga_disp(tr.ga.to_numpy(float), mu_tr)
        o.append(te)
    o = pd.concat(o)
    out = {"rows": int(len(o)), "seasons": [int(x) for x in SEASONS[1:]]}
    for key, mu, y, lines, sf, bins in (
            ("saves", o.mu_sv.to_numpy(), o.sv.to_numpy(float), np.arange(14.5, 41.5),
             lambda L, mu_: sv_sf(L, mu_, {k: o["_" + k].to_numpy() for k in ("pi", "cf", "cp", "af", "ap")}),
             [0, 22, 24, 26, 28, 30, 99]),
            ("ga", o.mu_ga.to_numpy(), o.ga.to_numpy(float), np.arange(0.5, 7.5),
             lambda L, mu_: ga_sf(L, mu_, o.d.to_numpy(), GA_KIND), [0, 2.6, 2.75, 2.9, 3.05, 99])):
        M = np.column_stack([sf(L, mu) for L in lines])
        j = np.abs(M - 0.5).argmin(1)
        pq, hq = M[np.arange(len(y)), j], (y > lines[j]).astype(float)
        by_price = []
        for lo, hi, lab in ((0, .45, "under 45%"), (.45, .5, "45-50%"), (.5, .55, "50-55%"), (.55, 1.01, "55%+")):
            w = (pq >= lo) & (pq < hi)
            if w.sum() >= 30: by_price.append({"lab": lab, "n": int(w.sum()), "pred": float(pq[w].mean()), "act": float(hq[w].mean())})
        by_line = [{"line": float(L), "n": int(len(y)), "pred": float(sf(L, mu).mean()), "act": float((y > L).mean())}
                   for L in (SV_LINES if key == "saves" else GA_LINES)]
        lab = lambda lo, hi: f"under {hi:g}" if lo == 0 else f"{lo:g}+" if hi == 99 else f"{lo:g}–{hi:g}"
        cut = pd.cut(mu, bins, labels=[lab(lo, hi) for lo, hi in zip(bins[:-1], bins[1:])])
        by_proj = [{"lab": str(iv), "n": int(g.shape[0]), "proj": float(g.mu.mean()), "act": float(g.y.mean())}
                   for iv, g in pd.DataFrame({"mu": mu, "y": y}).groupby(cut, observed=True)]
        out[key] = {"by_price": by_price, "by_line": by_line, "by_proj": by_proj, "mae": round(float(np.abs(y - mu).mean()), 2)}
    return out


def _agg_to_start():
    """Mean saves on START rows over (all saves / games started): the build only
    has the latter for last season. 0.974, steady across all four seasons."""
    g = load_goalies()
    return float(np.mean([x[x.start == 1].sv.mean() / (x.sv.sum() / x.start.sum()) for _, x in g.groupby("season")]))


def export():
    import nhl_saves_cal as C
    # the GA shrink factor, fitted on nested OOS predictions across all seasons
    ga_k = C.nested_k(D, GA_SHIPPED, "ga", 1.0)
    out = {}
    m = sv_fit(D)
    out["saves"] = {"features": SV_REL, "coef": {n: float(v) for n, v in zip(["intercept"] + SV_REL, m["b"])},
                    "scale": {f: {"mean": m["ref"][f][0], "sd": m["ref"][f][1]} for f in SV_REL},
                    "level": {"days": LVL_DAYS, "min_starts": LVL_MIN, "agg_to_start": _agg_to_start(),
                              "note": "league saves per start over the 30 days before the game, starts only, when "
                                      "there are 50+; otherwise last season's, which the build reads off the season "
                                      "aggregate (total saves / games started, relief included) x agg_to_start"},
                    "mix": {k: m[k] for k in ("pi", "cf", "cp", "af", "ap")}, "lines": SV_LINES,
                    # the single-NB alpha, for anything that wants one distribution
                    "alpha": nb_dispersion(D.sv.to_numpy(float), m["mu_of"](D))}
    for key, feats, target in (("ga", GA_SHIPPED, "ga"),):
        ref = {f: (float(D[f].mean()), float(D[f].std() or 1.0)) for f in feats}
        X = design(D, feats, ref)
        y = D[target].to_numpy(float)
        b = poisson_irls(X, y)
        mu = np.exp(np.clip(X @ b, -6, 6))
        m = {"features": feats, "coef": {n: float(v) for n, v in zip(["intercept"] + feats, b)},
             "scale": {f: {"mean": ref[f][0], "sd": ref[f][1]} for f in feats}}
        if target == "sv": m["alpha"] = nb_dispersion(y, mu); m["lines"] = SV_LINES
        else:
            mbar = float(y.mean())
            mu = mbar + ga_k * (mu - mbar)
            m["shrink_k"] = ga_k; m["shrink_to"] = mbar
            m["disp"] = ga_disp(y, mu); m["kind"] = GA_KIND; m["lines"] = GA_LINES
        out[key] = m
    out["log_offset"] = 0.1
    out["shrink"] = {"sv_pct_shots": 1500.0, "rate_starts": 8.0, "pull_starts": 16.0}
    out["league"] = {k: float(D[k].mean()) for k in ("sv", "sa", "ga", "svp_prior", "pulled",
                                                    "team_sa_prior", "opp_sf_prior", "team_ga_prior", "opp_gf_prior")}
    out["seasons"] = [int(s) for s in SEASONS]; out["rows"] = int(len(D))
    out["note"] = ("Goalie saves (Poisson GLM mean, negative-binomial price) and goals allowed "
                   "(Poisson GLM mean, priced through a binomial matched to the measured "
                   "under-dispersion). Rates on a log scale; save % as log odds of a goal, shrunk "
                   "with 1,500 shots of league average.")
    out["backtest"] = backtest()
    p = os.path.join(HERE, "nhl_saves_model.json")
    json.dump(out, open(p, "w"), indent=1)
    print(f"wrote {p}  alpha={out['saves']['alpha']:.4f}  ga disp={out['ga']['disp']:.3f}")


if __name__ == "__main__":
    if "--export" in sys.argv:
        export()
    else:
        ladders()
        print("\nNEGATIVE CONTROL (features shuffled within season)")
        print("  saves:", {k: round(v, 5) for k, v in control(SV_SHIPPED, "sv").items()})
        print("  GA:   ", {k: round(v, 5) for k, v in control(GA_SHIPPED, "ga").items()})
        calibration()
