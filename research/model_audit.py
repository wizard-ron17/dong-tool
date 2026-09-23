"""One scorecard for every model that prices a market — NHL, NFL and MLB.

Each model is re-run exactly as it ships, walk-forward (every season predicted
by a model fitted only on the seasons before it), and scored on the SAME
metrics at a headline line books actually hang:

  AUC        ranking: how often a hit is priced above a miss (0.5 = coin flip)
  skill      1 - logloss / logloss(base rate): information over guessing the
             average (0 = none). Unlike raw log loss or Brier, this is
             comparable across markets with different base rates.
  ECE        calibration: mean |priced - actual| across price deciles, in
             percentage points
  top10      hit rate of the top tenth of the board, and its lift over base

MLB is scored from the site's own LIVE graded history (mlb/data.json), since
its research data isn't on disk; its models publish a score, not a probability,
so it gets ranking metrics only where that's all there is.

    python3 research/model_audit.py            # -> research/model_audit.json + a table
"""
import json, os, sys, traceback
import numpy as np
import pandas as pd
from scipy.stats import poisson, binom

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
_ARGV = list(sys.argv); sys.argv = sys.argv[:1]
RESULTS = []


def auc(p, y):
    p, y = np.asarray(p, float), np.asarray(y, float)
    o = np.argsort(p, kind="mergesort"); r = np.empty(len(p)); r[o] = np.arange(1, len(p) + 1)
    # average ranks on ties
    s = pd.Series(p).rank(method="average").to_numpy()
    n1 = y.sum(); n0 = len(y) - n1
    return float((s[y == 1].sum() - n1 * (n1 + 1) / 2) / (n1 * n0)) if n1 and n0 else float("nan")


def score(sport, market, line, p, y, n_seasons, note="", tool=""):
    p = np.clip(np.asarray(p, float), 1e-6, 1 - 1e-6); y = np.asarray(y, float)
    base = y.mean()
    ll = float(-(y * np.log(p) + (1 - y) * np.log(1 - p)).mean())
    llb = float(-(base * np.log(base) + (1 - base) * np.log(1 - base)))
    q = pd.qcut(pd.Series(p).rank(method="first"), 10, labels=False)
    t = pd.DataFrame({"p": p, "y": y, "q": q}).groupby("q").agg(p=("p", "mean"), y=("y", "mean"), n=("p", "size"))
    ece = float(np.average((t.p - t.y).abs(), weights=t.n))
    r = dict(sport=sport, market=market, line=line, tool=tool, n=int(len(y)), seasons=n_seasons, base=float(base),
             auc=auc(p, y), skill=float(1 - ll / llb), brier_skill=float(1 - ((p - y) ** 2).mean() / (base * (1 - base))),
             ece=ece * 100, top10=float(t.y.iloc[-1]), top10_priced=float(t.p.iloc[-1]), lift=float(t.y.iloc[-1] / base),
             bottom10=float(t.y.iloc[0]), note=note)
    RESULTS.append(r)
    print(f"  {sport} {market:28s} n {r['n']:>7,}  AUC {r['auc']:.3f}  skill {r['skill'] * 100:5.1f}%  ECE {r['ece']:.2f}pp  "
          f"top10 {r['top10'] * 100:4.1f}% (x{r['lift']:.2f})  base {base * 100:4.1f}%", flush=True)


def guard(name, fn):
    try:
        fn()
    except Exception as e:
        print(f"  !! {name} failed: {e}", flush=True)
        traceback.print_exc(limit=2)


# ── NHL ─────────────────────────────────────────────────────────────────────
def nhl_goals():
    import nhl_goal_types as T, nhl_goals as G
    from nhl_goals import isotonic_fit
    F = T.seq_flags(); games = F[F.pid < 0]; F = F[F.pid > 0]
    O = T.oos_anytime().merge(F, on=["season", "date", "pid"], how="left")
    for c in ("first", "last", "p1"): O[c] = O[c].fillna(0)
    have = set(zip(games.season, games.date)); O = O[[(s, d) in have for s, d in zip(O.season, O.date)]].copy()
    O["mu"] = -np.log(1 - O.p_any); ns = O.season.nunique()
    score("NHL", "Anytime goal", "1+", O.p_any, O.scored, ns, tool="Picks")
    score("NHL", "2+ goals", "2+", 1 - np.exp(-O.mu) * (1 + O.mu), O.goals >= 2, ns, tool="Picks")
    score("NHL", "Hat trick", "3+", 1 - np.exp(-O.mu) * (1 + O.mu + O.mu ** 2 / 2), O.goals >= 3, ns, tool="Picks")
    O["game"] = O.groupby(["season", "date"]).ngroup().astype(str) + "|" + O[["team", "opp"]].apply(lambda r: "|".join(sorted(r)), axis=1)
    M = O.groupby("game").mu.transform("sum"); pf = O.mu / M * (1 - np.exp(-M))
    score("NHL", "First goal", "1st", pf, O["first"] > 0, ns, tool="Picks")
    score("NHL", "Last goal", "last", pf, O["last"] > 0, ns, tool="Picks")
    s1 = json.load(open(os.path.join(HERE, "nhl_goal_types_model.json")))["s1"]
    score("NHL", "1st-period goal", "1+ in P1", 1 - np.exp(-s1 * O.mu), O.p1 > 0, ns, tool="Picks", note="s1 from all seasons")
    # PP goal: its own model, nested isotonic
    D = G.D
    for c, off in T.PP_LOG.items(): D["log_" + c] = np.log(D[c].clip(lower=0) + off)
    seasons = sorted(D.season.unique()); P, Y, prev = [], [], []
    for s in seasons[1:]:
        tr, te = D[D.season < s], D[D.season == s]
        mu, *_ = G.fit_mu(tr, te, T.PP_FEATS, "ppg"); p = 1 - np.exp(-mu); y = (te.ppg > 0).to_numpy(float)
        if prev:
            kx, ky = isotonic_fit(np.concatenate([a for a, _ in prev]), np.concatenate([b for _, b in prev]))
            prev.append((p, y)); p = np.clip(np.interp(p, kx, ky), 1e-5, 0.9)
        else: prev.append((p, y))
        P.append(p); Y.append(y)
    score("NHL", "PP goal", "1+", np.concatenate(P), np.concatenate(Y), len(P), tool="Picks")


def nhl_sog():
    import nhl_sog as S
    from nhl_sog import poisson_irls, nb_dispersion, nb_sf
    D = S.D; P, Y = [], []
    for s in sorted(D.season.unique())[1:]:
        tr, te = D[D.season < s], D[D.season == s]
        ref = {f: (tr[f].mean(), tr[f].std() or 1.0) for f in S.SHIPPED}
        b = poisson_irls(S.design(tr, S.SHIPPED, ref), tr.sog.to_numpy(float))
        mu = np.exp(np.clip(S.design(te, S.SHIPPED, ref) @ b, -6, 6))
        a = nb_dispersion(tr.sog.to_numpy(float), np.exp(np.clip(S.design(tr, S.SHIPPED, ref) @ b, -6, 6)))
        P.append(nb_sf(2.5, mu, a)); Y.append((te.sog > 2.5).to_numpy(float))
    score("NHL", "Shots on goal", "o2.5", np.concatenate(P), np.concatenate(Y), len(P), tool="Shots")


def nhl_saves():
    import nhl_saves as S
    P, Y, PG, YG = [], [], [], []
    import nhl_saves_cal as C
    for s in S.SEASONS[1:]:
        tr, te = S.D[S.D.season < s], S.D[S.D.season == s]
        m = S.sv_fit(tr); mu = m["mu_of"](te)
        P.append(S.sv_sf(24.5, mu, m)); Y.append((te.sv > 24.5).to_numpy(float))
        b, ref = S.fit(tr, S.GA_SHIPPED, "ga"); k = C.nested_k(tr, S.GA_SHIPPED, "ga", 1.0); mbar = tr.ga.mean()
        mg = mbar + k * (S.predict(te, b, ref, S.GA_SHIPPED) - mbar)
        mg_tr = mbar + k * (S.predict(tr, b, ref, S.GA_SHIPPED) - mbar)
        d = S.ga_disp(tr.ga.to_numpy(float), mg_tr)
        PG.append(S.ga_sf(2.5, mg, d, "binom")); YG.append((te.ga > 2.5).to_numpy(float))
    score("NHL", "Saves", "o24.5", np.concatenate(P), np.concatenate(Y), len(P), tool="Saves")
    score("NHL", "Goals allowed", "o2.5", np.concatenate(PG), np.concatenate(YG), len(PG), tool="Goals Allowed")


def nhl_points():
    import nhl_points as N
    from nhl_goals import isotonic_fit
    for key, lab in (("pts", "Points"), ("a", "Assists"), ("ppp", "PP points")):
        r = N.walk(key, N.SHIPPED[key])
        mu, y = r["mu"], r["y"]
        p = 1 - np.exp(-mu)
        if key == "ppp":   # nested isotonic, as it ships
            n_s = [len(N.D[N.D.season == s]) for s in N.SEASONS[1:]]
            cuts = np.cumsum([0] + n_s); out = [p[:cuts[1]]]
            for i in range(1, len(n_s)):
                kx, ky = isotonic_fit(p[:cuts[i]], (y[:cuts[i]] > 0).astype(float))
                out.append(np.clip(np.interp(p[cuts[i]:cuts[i + 1]], kx, ky), 1e-5, 0.97))
            p = np.concatenate(out)
        score("NHL", lab, "o0.5", p, y > 0.5, len(N.SEASONS) - 1, tool="Points")
        if key == "pts":
            score("NHL", "Points 2+", "o1.5", 1 - np.exp(-mu) * (1 + mu), y > 1.5, len(N.SEASONS) - 1, tool="Points")


# ── NFL ─────────────────────────────────────────────────────────────────────
def nfl_td():
    o = pd.read_parquet(os.path.join(HERE, "oos_preds.parquet"))
    score("NFL", "Anytime TD", "1+", o.p, o.y, o.season.nunique(), tool="Picks",
          note="saved walk-forward predictions of the shipped model (oos_preds.parquet)")


def nfl_passing():
    import passing_export as PE
    from passing_td import fit_poisson, pois_at_least, SEASONS
    df = pd.read_parquet(os.path.join(HERE, "passing_td.parquet"))
    mu_, sd_ = df[PE.FEATS].mean(), df[PE.FEATS].std().replace(0, 1)
    M, Y = [], []
    for ts in [s for s in SEASONS if s >= PE.TEST_FROM]:
        tr, te = df[df.season < ts], df[df.season == ts]
        if len(tr) < 500 or not len(te): continue
        w = fit_poisson(PE.design(tr, mu_, sd_), tr.ptd.values)
        M.append(np.exp(np.clip(PE.design(te, mu_, sd_) @ w, -20, 20))); Y.append(te.ptd.values)
    m, y = np.concatenate(M), np.concatenate(Y)
    score("NFL", "Passing TDs", "o1.5", pois_at_least(m, 2), y >= 2, len(M), tool="Picks",
          note="raw Poisson; the board adds a per-line isotonic map, so live calibration is tighter")


def nfl_receptions():
    import receptions as R
    from receptions import nb_sf
    mu, y = R.oos_mu_pairs()
    M = json.load(open(os.path.join(HERE, "receptions_model.json")))
    x, yy = np.array(M["mu_cal"]["x"]), np.array(M["mu_cal"]["y"])
    # the board's mean calibration, as scripts/receptions.js applies it
    mc = np.where(mu <= x[0], yy[0] * mu / x[0], np.where(mu >= x[-1], yy[-1], np.interp(mu, x, yy)))
    score("NFL", "Receptions", "o3.5", nb_sf(3.5, mc, M["alpha"]), y > 3.5, 7, tool="Receptions",
          note="as priced (NB + mu_cal); mu_cal was fitted on these same OOS pairs, so calibration is slightly flattering")


def nfl_yards():
    import yards as Y
    d = Y.load_pbp(port=True); ctx = Y.game_ctx(d)
    skill, lg = Y.skill_frame(d); qb = Y.qb_frame(d, ctx)
    for key, (lab, y, pop, fs) in Y.MARKETS.items():
        base = qb if key in ("pass", "qbrush") else skill
        q = base[pop(base) & (base.games_prior >= 3)].dropna(subset=fs + [y]).copy()
        q["line"] = np.floor(q[y + "_prior"]) + 0.5
        _, _, t = Y.walk(q, fs, y, "line")
        score("NFL", lab, "prior-based line", t.p, (t[y] > t.line), t.season.nunique(), tool="Yards",
              note="line = his own prior rounded to .5, the way the research prices it")


def nfl_completions():
    import completions as C
    q = C.build(); q = q[q.cmp_n >= 3].copy()
    _, _, t = C.walk(q, C.BASE)
    m = json.load(open(os.path.join(HERE, "completions_model.json")))
    a = m["alpha"]
    L = (np.floor(t.mu) + 0.5).to_numpy(); mu = t.mu.to_numpy(); p = np.empty(len(mu))
    for v in np.unique(L):                       # nb_sf takes one line at a time
        w = L == v; p[w] = C.nb_sf(v, mu[w], a)
    score("NFL", "Completions", "line at projection", p, t.cmp.to_numpy() > L, t.season.nunique(), tool="Completions",
          note="line = projection rounded down to .5, so every start sits near a coin flip")


def nfl_interceptions():
    import interceptions as I
    q = I.build(window=2)
    m = json.load(open(os.path.join(HERE, "interceptions_model.json")))
    fs = m["features"]
    _, _, t = I.walk(q, fs)
    p1, _ = I.probs(t.mu.to_numpy())
    score("NFL", "Interceptions", "o0.5", p1, t.ints >= 1, t.season.nunique(), tool="Interceptions")


def nfl_kickers():
    import kickers as K
    d = K.load(); g = K.features(K.team_games(d)); q = g[g.season >= 2017].copy()
    for y, fs, lab in (("fgm", K.FGM_FS, "Kicker FG made"), ("patm", K.PAT_FS, "Kicker PATs made")):
        t = K.walk(q, fs, y)
        score("NFL", lab, f"o{K.LINES[y]}", t.p, t[y] > K.LINES[y], t.season.nunique(), tool="Kickers")


# ── MLB (live graded history) ───────────────────────────────────────────────
def mlb_live():
    d = json.load(open(os.path.join(HERE, "..", "mlb", "data.json")))
    rows = [(x["score"], float(x["hit"])) for day in d.get("picksHistory", []) for x in day["picks"]]
    s, y = np.array([r[0] for r in rows]), np.array([r[1] for r in rows])
    days = len(d.get("picksHistory", []))
    RESULTS.append(dict(sport="MLB", market="HR Picks (Chalk)", line="1+ HR", tool="Picks", n=len(y), seasons=f"{days} live days",
                        base=float(y.mean()), auc=auc(s, y), skill=None, brier_skill=None, ece=None,
                        top10=float(y[s >= np.quantile(s, 0.9)].mean()), top10_priced=None, lift=None, bottom10=float(y[s <= np.quantile(s, 0.1)].mean()),
                        note="live picks only (~16 a day, the top of the board), scored by pick score, not a probability; AUC is WITHIN the picks"))
    print(f"  MLB HR Picks (live)  n {len(y)}  hit {y.mean() * 100:.1f}%  AUC within picks {auc(s, y):.3f}")
    vr = [(x["score"], float(x["hit"])) for day in d.get("valueHistory", []) for x in day.get("value", [])]
    if vr:
        s2, y2 = np.array([r[0] for r in vr]), np.array([r[1] for r in vr])
        RESULTS.append(dict(sport="MLB", market="HR Picks (Value)", line="1+ HR", tool="Picks", n=len(y2), seasons=f"{len(d['valueHistory'])} live days",
                            base=float(y2.mean()), auc=auc(s2, y2), skill=None, brier_skill=None, ece=None, top10=None, top10_priced=None,
                            lift=None, bottom10=None, note="live, within the Value list"))
        print(f"  MLB HR Value (live)  n {len(y2)}  hit {y2.mean() * 100:.1f}%  AUC within {auc(s2, y2):.3f}")
    st = [(x["stealScore"], float(x["stole"])) for day in d.get("stealsHistory", []) for x in day["players"] if x.get("played")]
    if st:
        s3, y3 = np.array([r[0] for r in st]), np.array([r[1] for r in st])
        RESULTS.append(dict(sport="MLB", market="Stolen base", line="1+ SB", tool="Steals", n=len(y3), seasons=f"{len(d['stealsHistory'])} live days",
                            base=float(y3.mean()), auc=auc(s3, y3), skill=None, brier_skill=None, ece=None, top10=float(y3[s3 >= np.quantile(s3, 0.9)].mean()),
                            top10_priced=None, lift=float(y3[s3 >= np.quantile(s3, 0.9)].mean() / y3.mean()), bottom10=None, note="live, players who played; score not a probability"))
        print(f"  MLB Steals (live)  n {len(y3)}  stole {y3.mean() * 100:.1f}%  AUC {auc(s3, y3):.3f}")
    # Ks and walks: the tool grades itself at both of its lines (kbbHistory.lineStats):
    # what the board priced the over at vs how often it hit, every start.
    for key, lab in (("k", "Pitcher strikeouts"), ("bb", "Pitcher walks")):
        H = d.get("kbbHistory", {}).get(key)
        if not H: continue
        tiers = {t["tier"]: t for t in H["lineStats"]}
        cal = [(t["tier"], t["modelWin"], t["hits"] / t["n"]) for t in H["lineStats"]]
        RESULTS.append(dict(sport="MLB", market=lab, line="board's low + high lines", tool="Pitchers", n=int(H["starts"]),
                            seasons=f"{H['slates']} live slates", base=None, auc=None, skill=None, brier_skill=None,
                            ece=float(np.mean([abs(a - b) for _, a, b in cal]) * 100), top10=None, top10_priced=None, lift=None, bottom10=None,
                            cal=cal, proj_bias=H["projBias"],
                            note="LIVE self-grading: priced vs hit at each line; per-start probabilities aren't stored, so no AUC"))
        print(f"  MLB {lab}: " + "  ".join(f"{t}: priced {a * 100:.1f}% hit {b * 100:.1f}%" for t, a, b in cal)
              + f"  | projection bias {H['projBias']}")


if __name__ == "__main__":
    print("NHL"); [guard(n, f) for n, f in (("goals", nhl_goals), ("sog", nhl_sog), ("saves", nhl_saves), ("points", nhl_points))]
    print("NFL"); [guard(n, f) for n, f in (("td", nfl_td), ("passing", nfl_passing), ("receptions", nfl_receptions),
                                            ("interceptions", nfl_interceptions), ("kickers", nfl_kickers),
                                            ("completions", nfl_completions), ("yards", nfl_yards))]
    print("MLB"); guard("mlb", mlb_live)
    json.dump(RESULTS, open(os.path.join(HERE, "model_audit.json"), "w"), indent=1, default=float)
    print(f"\nwrote research/model_audit.json — {len(RESULTS)} markets")
