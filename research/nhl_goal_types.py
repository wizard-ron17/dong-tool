"""Goal-scorer markets beyond anytime: 2+, 3+, first goal, last goal, first-
period goal, power-play goal. Walk-forward, off the Picks model's own
out-of-sample anytime prices — the markets must be consistent with the board
they hang off.

Maths (goals per skater-game are Poisson, var/mean 1.004):
  mu      = -ln(1 - p_anytime)            the calibrated expected goals
  2+ / 3+ = Poisson tails of mu
  P1      = 1 - exp(-s1 * mu)             s1 = share of goals scored in period 1
  first   = (mu_i / M_game) * P(game has a goal)   competing Poisson clocks:
            whoever's clock rings first; M_game = expected goals by everyone
  last    = same shape, but empty-net goals are not random — the leading side
            scores them, and not with its defencemen — so it is checked apart
  PP      = its own Poisson model on power-play goals (the EV/PP split lost
            for ANYTIME, but a PP-goal price needs mu_pp specifically)

    python3 research/nhl_goal_seq_fetch.py    # the goal order for every game
    python3 research/nhl_goal_types.py
"""
import json, os, glob, sys
import numpy as np
import pandas as pd
_ARGS = list(sys.argv)
sys.argv = sys.argv[:1]
import nhl_goals as G
from nhl_goals import isotonic_fit

CACHE = os.environ.get("NHL_CACHE") or "/tmp/nhl-cache"
D = G.D


def seq_flags():
    """(season, date, pid) -> first / last / p1 goals / en goals, from the goal order."""
    rows = []
    for p in glob.glob(os.path.join(CACHE, "20*", "20*-*-*", "goals.json")):
        season, date = int(p.split(os.sep)[-3]), p.split(os.sep)[-2]
        for g in json.load(open(p)):
            gl = [x for x in g["goals"] if x.get("ptype") != "SO" and x.get("pid")]
            if not gl:
                continue
            first, last = gl[0]["pid"], gl[-1]["pid"]
            seen = {}
            for x in gl:
                r = seen.setdefault(x["pid"], dict(p1=0, en=0))
                if x.get("per") == 1: r["p1"] += 1
                if x.get("mod") == "empty-net": r["en"] += 1
            for pid, r in seen.items():
                rows.append(dict(season=season, date=date, pid=pid, first=int(pid == first), last=int(pid == last),
                                 last_en=int(pid == last and gl[-1].get("mod") == "empty-net"), **r))
            # games with a goal, for the P(any goal) term and per-game checks
            rows.append(dict(season=season, date=date, pid=-g["gid"], first=0, last=0, last_en=int(gl[-1].get("mod") == "empty-net"), p1=0, en=0))
    return pd.DataFrame(rows)


def oos_anytime():
    """The Picks board's out-of-sample prices: shipped features, isotonic fitted
    only on earlier out-of-sample seasons (walk(iso=True)'s scheme)."""
    seasons = sorted(D.season.unique())
    out, prev = [], []
    for s in seasons[1:]:
        tr, te = D[D.season < s], D[D.season == s].copy()
        mu, *_ = G.fit_mu(tr, te, G.SHIPPED)
        p = 1 - np.exp(-mu)
        if prev:
            px, py = np.concatenate([a for a, _ in prev]), np.concatenate([b for _, b in prev])
            kx, ky = isotonic_fit(px, py)
            prev.append((p, te.scored.to_numpy())); p = np.clip(np.interp(p, kx, ky), 1e-4, 0.95)
        else:
            prev.append((p, te.scored.to_numpy()))
        te["p_any"] = p
        out.append(te)
    return pd.concat(out)


def calib(p, y, bins=10):
    q = pd.qcut(pd.Series(p).rank(method="first"), bins, labels=False)
    t = pd.DataFrame({"p": p, "y": y, "q": q}).groupby("q").agg(p=("p", "mean"), y=("y", "mean"), n=("p", "size"))
    ece = float(np.average((t.p - t.y).abs(), weights=t.n))
    return t, ece


def ll(p, y):
    p = np.clip(p, 1e-6, 1 - 1e-6)
    return float(-(y * np.log(p) + (1 - y) * np.log(1 - p)).mean())


def report(name, p, y, base=None):
    t, ece = calib(p, y)
    b = "" if base is None else f"  vs flat base-rate {ll(np.full(len(y), base), y):.5f}"
    print(f"\n{name}: predicted {p.mean():.4f} vs actual {y.mean():.4f} · log loss {ll(p, y):.5f}{b} · ECE {ece * 100:.2f}pp")
    print("  deciles  " + "  ".join(f"{a:.3f}/{c:.3f}" for a, c in zip(t.p, t.y)))


if __name__ == "__main__" and "--export" in _ARGS:
    pass  # handled at the bottom, once export() is defined
elif __name__ == "__main__":
    F = seq_flags()
    games = F[F.pid < 0]
    F = F[F.pid > 0]
    O = oos_anytime()
    O = O.merge(F, on=["season", "date", "pid"], how="left")
    for c in ("first", "last", "last_en", "p1", "en"):
        O[c] = O[c].fillna(0)
    # rows with no goal-order data at all (a date the fetch missed) are dropped
    have = set(zip(games.season, games.date))
    O = O[[(s, d) in have for s, d in zip(O.season, O.date)]].copy()
    O["mu"] = -np.log(1 - O.p_any)
    print(f"{len(O):,} skater-games OOS, {O.season.nunique()} seasons, {len(games):,} games with a goal")

    # ── 2+ / 3+ ────────────────────────────────────────────────────────────
    report("2+ goals (Poisson tail of the anytime mu)", 1 - np.exp(-O.mu) * (1 + O.mu), (O.goals >= 2).astype(float), (O.goals >= 2).mean())
    report("3+ goals (hat trick)", 1 - np.exp(-O.mu) * (1 + O.mu + O.mu ** 2 / 2), (O.goals >= 3).astype(float), (O.goals >= 3).mean())

    # ── first period ───────────────────────────────────────────────────────
    # s1 from each training window: goals in period 1 over all goals, never the test season
    res = []
    for s in sorted(O.season.unique()):
        tr = F[F.season < s]
        s1 = tr.p1.sum() / D[D.season < s].goals.sum() if len(tr) else 0.30
        x = O[O.season == s]
        res.append((1 - np.exp(-s1 * x.mu), (x.p1 > 0).astype(float)))
    report("1st-period goal (s1 x mu)", np.concatenate([a for a, _ in res]), np.concatenate([b for _, b in res]))

    # ── first / last goal: competing clocks over the players who DRESSED ──
    # The rows here are exactly the dressed skaters, so M_game = their mu sum.
    O["game"] = O.groupby(["season", "date"]).ngroup().astype(str) + "|" + O[["team", "opp"]].apply(lambda r: "|".join(sorted(r)), axis=1)
    M = O.groupby("game").mu.transform("sum")
    pg = 1 - np.exp(-M)                                           # P(at least one goal) under the same clocks
    O["p_first"] = O.mu / M * pg
    report("First goal (mu share x P(any goal))", O.p_first.to_numpy(), O["first"].to_numpy(), O["first"].mean())
    print(f"  per-game sum of first-goal prices: mean {O.groupby('game').p_first.sum().mean():.3f} (a goal-scorer is always a skater, so ~1)")
    O["p_last"] = O.p_first
    report("Last goal, same shape", O.p_last.to_numpy(), O["last"].to_numpy(), O["last"].mean())
    print(f"  last goals that were empty-netters: {games.last_en.mean():.1%} of games")
    for role in ("F", "D"):
        x = O[O.role == role]
        print(f"  {role}: first predicted {x.p_first.mean():.4f} actual {x['first'].mean():.4f} · last predicted {x.p_last.mean():.4f} actual {x['last'].mean():.4f}")

    # ── power-play goal ────────────────────────────────────────────────────
    # naive: the anytime mu times the league PP share
    res_n, res_m = [], []
    PPF = ["ppg_prior", "pptoi_l5", "sog_prior", "shpct_prior", "toi_l5", "opp_pk_prior", "team_gf_prior", "is_home"]
    for s in sorted(O.season.unique()):
        tr, te = D[D.season < s], D[D.season == s]
        share = tr.ppg.sum() / tr.goals.sum()
        x = O[O.season == s]
        res_n.append((1 - np.exp(-share * x.mu), (x.ppg > 0).astype(float)))
        mu_pp, *_ = G.fit_mu(tr, te, PPF, "ppg")
        te2 = te.assign(mu_pp=mu_pp)[["season", "date", "pid", "mu_pp"]]
        xx = x.merge(te2, on=["season", "date", "pid"], how="left")
        res_m.append((1 - np.exp(-xx.mu_pp.to_numpy()), (xx.ppg > 0).astype(float).to_numpy()))
    yb = np.concatenate([b for _, b in res_n])
    report("PP goal, naive (anytime mu x PP share)", np.concatenate([a for a, _ in res_n]), yb, yb.mean())
    report("PP goal, own model (PP minutes, PP goals, opp PK...)", np.concatenate([a for a, _ in res_m]), np.concatenate([b for _, b in res_m]), yb.mean())


# ── Export ──────────────────────────────────────────────────────────────────
# What survived (see the session notes in the commit):
#   2+ / 3+     Poisson tails of the anytime mu — ECE 0.18 / 0.06pp
#   1st period  s1 x mu — ECE 0.31pp
#   first/last  mu share of the DRESSED skaters x P(any goal) — ECE 0.17 / 0.21pp;
#               a defenceman factor on last goal moved nothing (0.24 -> 0.22pp)
#   PP goal     own Poisson on power-play goals, rates on a LOG scale (raw-scale
#               ECE 0.92pp -> 0.28), plus isotonic fitted on walk-forward OOS
#               (0.14pp). A PP-unit-share term (needs tonight's lineup) added
#               only 0.0003 log loss and is left out.
PP_LOG = {"ppg_prior": 0.005, "pptoi_l5": 5.0, "pptoi_l10": 5.0, "sog_prior": 0.1}
PP_FEATS = ["log_ppg_prior", "log_pptoi_l5", "log_pptoi_l10", "log_sog_prior",
            "shpct_prior", "opp_pk_prior", "team_gf_prior", "is_home"]


def export(path=None):
    for c, off in PP_LOG.items():
        D["log_" + c] = np.log(D[c].clip(lower=0) + off)
    seasons = sorted(D.season.unique())
    # PP model: coefficients on everything; isotonic on pooled walk-forward OOS
    P, Y = [], []
    for s in seasons[1:]:
        tr, te = D[D.season < s], D[D.season == s]
        mu, *_ = G.fit_mu(tr, te, PP_FEATS, "ppg")
        P.append(1 - np.exp(-mu)); Y.append((te.ppg > 0).astype(float).to_numpy())
    kx, ky = isotonic_fit(np.concatenate(P), np.concatenate(Y))
    ref = {f: (float(D[f].mean()), float(D[f].std() or 1.0)) for f in PP_FEATS}
    b = G.poisson_irls(G.design(D, PP_FEATS, ref), D.ppg.to_numpy(float))
    pp_oos = np.clip(np.interp(np.concatenate(P), kx, ky), 1e-5, 0.9)

    F = seq_flags(); games = F[F.pid < 0]; F = F[F.pid > 0]
    s1 = float(F.p1.sum() / D.goals.sum())
    # Per-market max-price cuts, measured out of sample: the hit rate each cut
    # actually produced and how many skaters a night clear it (the NFL chips).
    O = oos_anytime().merge(F, on=["season", "date", "pid"], how="left")
    for c in ("first", "last", "p1"): O[c] = O[c].fillna(0)
    have = set(zip(games.season, games.date)); O = O[[(s, d) in have for s, d in zip(O.season, O.date)]].copy()
    O["mu"] = -np.log(1 - O.p_any)
    O["game"] = O.groupby(["season", "date"]).ngroup().astype(str) + "|" + O[["team", "opp"]].apply(lambda r: "|".join(sorted(r)), axis=1)
    M = O.groupby("game").mu.transform("sum"); O["p_first"] = O.mu / M * (1 - np.exp(-M))
    nights = O.groupby(["season", "date"]).ngroups
    mk = {
        "p2":  (1 - np.exp(-O.mu) * (1 + O.mu), O.goals >= 2, (800, 1200, 1600, 2400)),
        "p3":  (1 - np.exp(-O.mu) * (1 + O.mu + O.mu ** 2 / 2), O.goals >= 3, (5000, 8000, 12000)),
        "pFirst": (O.p_first, O["first"] > 0, (1400, 1900, 2400, 3400)),
        "pLast":  (O.p_first, O["last"] > 0, (1400, 1900, 2400, 3400)),
        "pP1": (1 - np.exp(-s1 * O.mu), O.p1 > 0, (900, 1200, 1600, 2400)),
    }
    # P was stacked season by season; D is sorted by player, so rebuild the rows
    # in that same season-by-season order before pairing them with P
    oos = pd.concat([D[D.season == s_] for s_ in seasons[1:]]).assign(pp=pp_oos)
    mk["pPP"] = (oos.pp, oos.ppg > 0, (500, 800, 1200, 1900))
    cuts = {}
    for key, (p, y, odds) in mk.items():
        p, y = np.asarray(p, float), np.asarray(y, float)
        n_n = nights if key != "pPP" else oos.groupby(["season", "date"]).ngroups
        cuts[key] = {"base": round(float(y.mean() * 100), 2), "cuts": [
            {"v": o, "p": round(100 / (o + 100), 5), "hit": round(float(y[p >= 100 / (o + 100)].mean() * 100), 1) if (p >= 100 / (o + 100)).any() else None,
             "per": round(float((p >= 100 / (o + 100)).sum() / n_n), 1)} for o in odds]}
    model = {
        "note": "Goal-scorer markets beyond anytime; research/nhl_goal_types.py",
        "s1": s1,
        "pp": {"features": PP_FEATS, "log_offset": PP_LOG,
               "coef": {n: float(v) for n, v in zip(["intercept"] + PP_FEATS + ["is_D"], b)},
               "scale": {f: {"mean": ref[f][0], "sd": ref[f][1]} for f in PP_FEATS},
               "iso": {"x": [float(v) for v in kx], "y": [float(v) for v in ky]},
               "shrink_games": 16.0,
               "role": {r: {"ppg": float(D[D.role == r].ppg.mean())} for r in ("F", "D")},
               "league": {"opp_pk": float(D.opp_pk_prior.mean())}},
        "cuts": cuts,
    }
    path = path or os.path.join(os.path.dirname(os.path.abspath(__file__)), "nhl_goal_types_model.json")
    json.dump(model, open(path, "w"), indent=1)
    print(f"wrote {path}  s1={s1:.4f}")
    for k, v in cuts.items():
        print(f"  {k:6s} base {v['base']:5.2f}%  " + "  ".join(f"+{c['v']}: {c['hit']}% ({c['per']}/night)" for c in v["cuts"]))


if __name__ == "__main__" and "--export" in _ARGS:
    export()
