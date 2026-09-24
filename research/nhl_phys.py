"""Hits and blocked shots — walk-forward ladders for two new /nhl tools.

Same machinery as the shots model (research/nhl_sog.py): Poisson means on
log-scale rates, negative-binomial tails decided on held-out lines, every
season predicted by a model fitted only on the seasons before it.

Features, all as-of:
  own rate      career per game (shrunk to his position), last 5, last 10
  ice time      career and last 5; penalty-kill minutes (blocks happen on the PK)
  team context  shot attempts his club allows a game (more time defending: more
                blocks, more hits); attempts the opponent takes a game
  home ice      and the ARENA: hits and blocks are counted by the home rink's
                scorekeepers, and some count far more than others — the rink's
                own rate against the league, as-of, shrunk
Lines: hits 0.5-4.5, blocks 0.5-3.5.

    python3 research/nhl_phys.py            # ladders
    python3 research/nhl_phys.py --export   # -> research/nhl_phys_model.json
"""
import json, os, sys
import numpy as np
import pandas as pd
from scipy.stats import poisson

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from nhl_sog import poisson_irls, nb_dispersion, nb_sf
from nhl_sog_data import asof_mean

LINES = {"hits": [0.5, 1.5, 2.5, 3.5, 4.5], "bks": [0.5, 1.5, 2.5, 3.5]}
K = 16.0


def build():
    D = pd.read_parquet(os.path.join(HERE, "nhl_sog.parquet"))
    D = D.sort_values(["pid", "season", "date"]).reset_index(drop=True)
    for c in ("hits", "bks"):
        tgt = D.groupby("role")[c].transform("mean")        # position baseline (pooled; a mean, no future outcomes of his)
        D[c + "_prior"] = asof_mean(D, "pid", c, "one", K, tgt)
        for w in (5, 10):
            D[f"{c}_l{w}"] = D.groupby("pid", sort=False)[c].transform(lambda s, w=w: s.shift(1).rolling(w, min_periods=2).mean()).fillna(D[c + "_prior"])
    D["shtoi_prior"] = asof_mean(D, "pid", "shtoi", "one", 8.0, D.groupby("role").shtoi.transform("mean"))
    D["shtoi_l5"] = D.groupby("pid", sort=False).shtoi.transform(lambda s: s.shift(1).rolling(5, min_periods=2).mean()).fillna(D.shtoi_prior)
    # team-games: attempts for / against, hits and blocks, and where it was played
    T = D.groupby(["season", "date", "team", "opp"]).agg(cf=("icf", "sum"), hits=("hits", "sum"), bks=("bks", "sum"),
                                                         home=("is_home", "max")).reset_index()
    ca = T.set_index(["date", "team"]).cf.to_dict()
    T["ca"] = [ca.get((d, o), np.nan) for d, o in zip(T.date, T.opp)]
    T = T.dropna(subset=["ca"]).sort_values(["team", "date"]).reset_index(drop=True); T["one"] = 1.0
    T["ca_prior"] = asof_mean(T, "team", "ca", "one", 10.0, T.ca.mean())
    T["cf_prior"] = asof_mean(T, "team", "cf", "one", 10.0, T.cf.mean())
    # arena: both clubs' hits (blocks) in games at this rink, per game, vs the league — as-of
    G = T[T.home == 1][["season", "date", "team", "opp"]].rename(columns={"team": "arena"})
    tot = T.set_index(["date", "team"])[["hits", "bks"]]
    G["hits"] = [tot.loc[(d, a), "hits"] + tot.loc[(d, o), "hits"] if (d, o) in tot.index else np.nan for d, a, o in zip(G.date, G.arena, G.opp)]
    G["bks"] = [tot.loc[(d, a), "bks"] + tot.loc[(d, o), "bks"] if (d, o) in tot.index else np.nan for d, a, o in zip(G.date, G.arena, G.opp)]
    G = G.dropna().sort_values(["arena", "date"]).reset_index(drop=True); G["one"] = 1.0
    # this season's games at the rink only: scorekeepers change between seasons
    # (Edmonton logged 25-28 hits a club-game for two seasons, then 17.7), and
    # a rink's rate carried across seasons HURT the hits model (t -3.13)
    G["arena_s"] = G.arena + "|" + G.season.astype(str)
    for c in ("hits", "bks"):
        G[f"arena_{c}"] = asof_mean(G, "arena_s", c, "one", 10.0, G[c].mean()) / G[c].mean()
    arena = G.set_index(["date", "arena"])[["arena_hits", "arena_bks"]].to_dict("index")
    tk = T.set_index(["date", "team"])[["ca_prior", "cf_prior"]].to_dict("index")
    D["team_ca_prior"] = [tk.get((d, t), {}).get("ca_prior", np.nan) for d, t in zip(D.date, D.team)]
    D["opp_cf_prior"] = [tk.get((d, o), {}).get("cf_prior", np.nan) for d, o in zip(D.date, D.opp)]
    host = [t if h else o for t, o, h in zip(D.team, D.opp, D.is_home)]
    D["arena_hits"] = [arena.get((d, a), {}).get("arena_hits", 1.0) for d, a in zip(D.date, host)]
    D["arena_bks"] = [arena.get((d, a), {}).get("arena_bks", 1.0) for d, a in zip(D.date, host)]
    for c in ("team_ca_prior", "opp_cf_prior"): D[c] = D[c].fillna(D[c].mean())
    # game state before the puck drops: the closing line's win chance. Underdogs
    # expect to trail, and trailing clubs chase the puck — more hits, more blocks.
    # Tested with Ron's other ideas (research session 2026-09-24): underdog t +3.5
    # hits / +4.0 blocks; hits/60 x ice time +0.05 per 1,000 (redundant with rate
    # x ice time on the log scale); same-division games nothing.
    try:
        from nhl_odds import load as load_odds
        k = np.arange(15); wp = {}
        for r in load_odds().itertuples():
            m = np.outer(poisson.pmf(k, r.imp_home), poisson.pmf(k, r.imp_away))
            h = np.tril(m, -1).sum() + 0.5 * np.trace(m)
            wp[(r.date, r.home)] = h; wp[(r.date, r.away)] = 1 - h
        D["underdog"] = [0.5 - wp[(d, t)] if (d, t) in wp else 0.0 for d, t in zip(D.date, D.team)]
    except Exception:
        D["underdog"] = 0.0
    LOG = {"hits_prior": 0.05, "hits_l5": 0.2, "hits_l10": 0.2, "bks_prior": 0.05, "bks_l5": 0.2, "bks_l10": 0.2,
           "toi_prior": 30, "toi_l5": 30, "shtoi_prior": 5, "shtoi_l5": 5, "team_ca_prior": 1, "opp_cf_prior": 1,
           "arena_hits": 0.01, "arena_bks": 0.01}
    for c, o in LOG.items(): D["log_" + c] = np.log(D[c].clip(lower=0) + o)
    return D, LOG


def design(df, feats, ref):
    X = [np.ones(len(df))] + [(df[f].to_numpy(float) - ref[f][0]) / ref[f][1] for f in feats]
    X.append((df.role.to_numpy() == "D").astype(float))
    return np.column_stack(X)


def walk(D, target, feats, dist="nb"):
    rows, P = [], []
    for s in sorted(D.season.unique())[1:]:
        tr, te = D[D.season < s], D[D.season == s]
        ref = {f: (tr[f].mean(), tr[f].std() or 1.0) for f in feats}
        b = poisson_irls(design(tr, feats, ref), tr[target].to_numpy(float))
        mu_tr = np.exp(np.clip(design(tr, feats, ref) @ b, -6, 4)); mu = np.exp(np.clip(design(te, feats, ref) @ b, -6, 4))
        a = nb_dispersion(tr[target].to_numpy(float), mu_tr)
        y = te[target].to_numpy(float)
        ll = []
        for L in LINES[target]:
            p = nb_sf(L, mu, a) if dist == "nb" else np.clip(poisson.sf(np.floor(L), mu), 1e-6, 1 - 1e-6)
            h = (y > L).astype(float); ll.append(-(h * np.log(p) + (1 - h) * np.log(1 - p)))
        rows.append(np.mean(ll, axis=0)); P.append(pd.DataFrame({"mu": mu, "y": y, "alpha": a}, index=te.index))
    return np.concatenate(rows), pd.concat(P)


def ladder(D, target):
    c = target
    L = [("0  position only", []),
         ("1  + career rate", [f"log_{c}_prior"]),
         ("2  + last 5 / last 10", [f"log_{c}_prior", f"log_{c}_l5", f"log_{c}_l10"]),
         ("3  + ice time", [f"log_{c}_prior", f"log_{c}_l5", f"log_{c}_l10", "log_toi_prior", "log_toi_l5"]),
         ("4  + penalty-kill time", [f"log_{c}_prior", f"log_{c}_l5", f"log_{c}_l10", "log_toi_prior", "log_toi_l5", "log_shtoi_l5"]),
         ("5  + attempts his club allows", [f"log_{c}_prior", f"log_{c}_l5", f"log_{c}_l10", "log_toi_prior", "log_toi_l5", "log_shtoi_l5", "log_team_ca_prior"]),
         ("6  + opponent attempts", [f"log_{c}_prior", f"log_{c}_l5", f"log_{c}_l10", "log_toi_prior", "log_toi_l5", "log_shtoi_l5", "log_team_ca_prior", "log_opp_cf_prior"]),
         ("7  + home ice", [f"log_{c}_prior", f"log_{c}_l5", f"log_{c}_l10", "log_toi_prior", "log_toi_l5", "log_shtoi_l5", "log_team_ca_prior", "log_opp_cf_prior", "is_home"]),
         ("8  + the arena's scorer", [f"log_{c}_prior", f"log_{c}_l5", f"log_{c}_l10", "log_toi_prior", "log_toi_l5", "log_shtoi_l5", "log_team_ca_prior", "log_opp_cf_prior", "is_home", f"log_arena_{c}"])]
    print(f"\n{c.upper()} — mean log loss over lines {LINES[c]} (NB tails), paired t vs the rung above")
    prev = None; out = {}
    for name, f in L:
        l, P = walk(D, c, f)
        t = "" if prev is None else f"  t {((prev - l).mean() / ((prev - l).std() / np.sqrt(len(l)))):+.2f}"
        print(f"  {name:34s} {l.mean():.5f}{t}")
        prev = l; out[name] = (f, l, P)
    return out


if __name__ == "__main__" and "--export" not in sys.argv:
    D, LOG = build()
    print(f"{len(D):,} skater-games")
    res = {c: ladder(D, c) for c in ("hits", "bks")}
    for c in ("hits", "bks"):
        f, l, _ = list(res[c].values())[-1]
        lp, _ = walk(D, c, f, "poisson")
        print(f"\n{c}: full model, NB {l.mean():.5f} vs Poisson {lp.mean():.5f}")


# ── Shipped + export ────────────────────────────────────────────────────────
# What survived. Hits: penalty-kill time (t -0.78) and his club's attempts
# allowed (t +0.09) out. Blocks: his club's attempts allowed (t +0.23) and home
# ice (t +0.90) out. The rink's scorer is season-to-date only.
SHIPPED = {
    "hits": ["log_hits_prior", "log_hits_l5", "log_hits_l10", "log_toi_prior", "log_toi_l5", "log_opp_cf_prior", "is_home", "log_arena_hits", "underdog"],
    "bks": ["log_bks_prior", "log_bks_l5", "log_bks_l10", "log_toi_prior", "log_toi_l5", "log_shtoi_l5", "log_opp_cf_prior", "log_arena_bks", "underdog"],
}


def calibration(D, c):
    l, P = walk(D, c, SHIPPED[c])
    a = P.alpha.iloc[-1]
    P["bin"] = pd.cut(P.mu, [0, 0.5, 1, 1.5, 2, 3, 99])
    g = P.groupby("bin", observed=True).agg(n=("y", "size"), proj=("mu", "mean"), got=("y", "mean"))
    print(f"\n{c}: shipped set, log loss {l.mean():.5f}\n" + g.round(3).to_string())
    for L in LINES[c]:
        p = np.array([nb_sf(L, np.array([m]), al)[0] for m, al in zip(P.mu, P.alpha)]) if len(P) < 1 else nb_sf(L, P.mu.to_numpy(), a)
        print(f"  over {L}: priced {p.mean():.3f}, went {(P.y > L).mean():.3f}")
    return l


def export(D, LOG):
    out = {"note": "Hits and blocked shots (research/nhl_phys.py): Poisson means on log-scale rates, negative-binomial tails, walk-forward. "
                   "The rink's scorer is season-to-date (scorekeepers change between seasons).",
           "shrink_games": K, "arena_shrink_games": 10.0, "log_offset": LOG, "rows": int(len(D)),
           "seasons": [int(s) for s in sorted(D.season.unique())],
           "role": {r: {"hits": float(D[D.role == r].hits.mean()), "bks": float(D[D.role == r].bks.mean()),
                        "shtoi": float(D[D.role == r].shtoi.mean()), "toi": float(D[D.role == r].toi.mean())} for r in ("F", "D")},
           "league": {"cf": float(D.opp_cf_prior.mean()), "arena_hits": float(D.hits.sum() / D.groupby(["date", "team"]).ngroups * 2),
                      "arena_bks": float(D.bks.sum() / D.groupby(["date", "team"]).ngroups * 2)}}
    for c in ("hits", "bks"):
        f = SHIPPED[c]
        ref = {x: (D[x].mean(), D[x].std() or 1.0) for x in f}
        b = poisson_irls(design(D, f, ref), D[c].to_numpy(float))
        mu = np.exp(np.clip(design(D, f, ref) @ b, -6, 4))
        l, P = walk(D, c, f)
        # the Results tab's backtest panel: every held-out skater-game
        a = P.alpha.to_numpy(); mu_o = P.mu.to_numpy(); y = P.y.to_numpy()
        by_line = [{"line": L, "n": int(len(y)), "pred": float(nb_sf(L, mu_o, a[0]).mean()), "act": float((y > L).mean())} for L in LINES[c]]
        # the quoted line: the one closest to even for each skater
        quoted = np.array([min(LINES[c], key=lambda L: abs(nb_sf(L, np.array([m]), a[0])[0] - 0.5)) for m in mu_o])
        pq = np.array([nb_sf(L, np.array([m]), a[0])[0] for L, m in zip(quoted, mu_o)]); hq = y > quoted
        by_price = []
        for lo, hi, lab in ((0, 0.4, "under 40%"), (0.4, 0.5, "40-50%"), (0.5, 0.6, "50-60%"), (0.6, 1.01, "60%+")):
            m = (pq >= lo) & (pq < hi)
            if m.sum(): by_price.append({"lab": lab, "n": int(m.sum()), "pred": float(pq[m].mean()), "act": float(hq[m].mean())})
        edges = [0, 0.5, 1, 1.5, 2, 3, 99]
        by_proj = []
        for lo, hi in zip(edges[:-1], edges[1:]):
            m = (mu_o > lo) & (mu_o <= hi)
            if m.sum(): by_proj.append({"lab": f"{lo}-{hi}" if hi < 99 else f"{lo}+", "n": int(m.sum()), "proj": float(mu_o[m].mean()), "act": float(y[m].mean())})
        out[c] = {"features": f, "coef": dict(zip(["intercept"] + f + ["is_D"], [float(x) for x in b])),
                  "scale": {x: {"mean": float(ref[x][0]), "sd": float(ref[x][1])} for x in f},
                  "alpha": float(nb_dispersion(D[c].to_numpy(float), mu)), "lines": LINES[c],
                  "backtest": {"log_loss": round(float(l.mean()), 5), "rows": int(len(y)), "mae": round(float(np.abs(y - mu_o).mean()), 3),
                               "seasons": [int(x) for x in sorted(D.season.unique())[1:]], "by_line": by_line, "by_price": by_price, "by_proj": by_proj}}
    json.dump(out, open(os.path.join(HERE, "nhl_phys_model.json"), "w"), indent=1)
    print("wrote nhl_phys_model.json")


if __name__ == "__main__" and "--export" in sys.argv:
    D, LOG = build()
    for c in ("hits", "bks"): calibration(D, c)
    export(D, LOG)
