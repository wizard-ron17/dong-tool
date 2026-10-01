"""Top-of-board calibration for the goal markets derived from the anytime price (research).

    python3 research/nhl_goal_cal.py            # walk-forward test
    python3 research/nhl_goal_cal.py export     # + write the maps into nhl_goal_types_model.json

2+ goals, hat tricks, first / last goal and 1st-period goals are all derived
from each skater's anytime-goal rate (scripts/nhl-goals.js goalMarkets): a
Poisson count for 2+ and 3+, his share of the game's goals for first and last,
the period share for P1. The model audit (research/model_audit.py) found the
TOP of those boards priced 10-18% hot: a Poisson count lets a star stack goals
more easily than stars actually do, and the race shares lean the same way.

The fix tested here is two numbers per market, a logistic recalibration
    logit(p') = a + b * logit(p)
fit on the seasons before the one it prices (the way it will run live), scored
on log loss and on the top tenth of the board (priced vs hit). Two parameters,
not an isotonic curve: 288 hat tricks can't support a flexible shape.
"""
import json, os, sys
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
_ARGV = list(sys.argv); sys.argv = sys.argv[:1]

import nhl_goal_types as T

P3_PRIOR_HITS = 50


def logit(p): p = np.clip(p, 1e-6, 1 - 1e-6); return np.log(p / (1 - p))


def platt(p, y, iters=50):
    """Fit logit(p') = a + b logit(p) by Newton's method."""
    x = logit(p); a, b = 0.0, 1.0
    for _ in range(iters):
        q = 1 / (1 + np.exp(-(a + b * x))); w = q * (1 - q) + 1e-9
        g = np.array([np.sum(y - q), np.sum((y - q) * x)])
        H = np.array([[np.sum(w), np.sum(w * x)], [np.sum(w * x), np.sum(w * x * x)]]) + 1e-9 * np.eye(2)
        a, b = np.array([a, b]) + np.linalg.solve(H, g)
    return float(a), float(b)


def apply(p, ab): a, b = ab; return 1 / (1 + np.exp(-(a + b * logit(p))))


def ll(p, y): p = np.clip(p, 1e-9, 1 - 1e-9); return float(-(y * np.log(p) + (1 - y) * np.log(1 - p)).mean())


def top(p, y):
    k = np.argsort(-p)[: max(1, len(p) // 10)]
    return float(p[k].mean()), float(y[k].mean()), int(y[k].sum())


def top_rel_error(priced, hit):
    return abs(priced - hit) / max(hit, 1e-4)


def top_scale(p, y):
    """Shrink a rare-event market toward fair by one season's worth of hits."""
    ix = np.argsort(-p)[:max(1, len(p) // 10)]
    return float((y[ix].sum() + P3_PRIOR_HITS) / (p[ix].sum() + P3_PRIOR_HITS))


def markets():
    """Every skater-game with the derived prices, as the build computes them, and what happened."""
    F = T.seq_flags(); games = F[F.pid < 0]; F = F[F.pid > 0]
    O = T.oos_anytime().merge(F, on=["season", "date", "pid"], how="left")
    for c in ("first", "last", "p1"): O[c] = O[c].fillna(0)
    have = set(zip(games.season, games.date)); O = O[[(s, d) in have for s, d in zip(O.season, O.date)]].copy()
    O["mu"] = -np.log(1 - O.p_any)
    O["game"] = O.groupby(["season", "date"]).ngroup().astype(str) + "|" + O[["team", "opp"]].apply(lambda r: "|".join(sorted(r)), axis=1)
    M = O.groupby("game").mu.transform("sum")
    s1 = json.load(open(os.path.join(HERE, "nhl_goal_types_model.json")))["s1"]
    return O, {
        "p2":    (1 - np.exp(-O.mu) * (1 + O.mu), (O.goals >= 2).astype(float)),
        "p3":    (1 - np.exp(-O.mu) * (1 + O.mu + O.mu ** 2 / 2), (O.goals >= 3).astype(float)),
        "first": (O.mu / M * (1 - np.exp(-M)), (O["first"] > 0).astype(float)),
        "last":  (O.mu / M * (1 - np.exp(-M)), (O["last"] > 0).astype(float)),
        "p1":    (1 - np.exp(-s1 * O.mu), (O.p1 > 0).astype(float)),
    }


def walkforward():
    O, MK = markets()
    seasons = sorted(O.season.unique())
    out = {}
    for k, (p, y) in MK.items():
        p, y = np.asarray(p, float), np.asarray(y, float)
        P0, P1, Y = [], [], []
        for s in seasons[1:]:
            tr, te = (O.season < s).to_numpy(), (O.season == s).to_numpy()
            if k == "p3":
                P1.append(np.clip(p[te] * top_scale(p[tr], y[tr]), 1e-9, 1 - 1e-9))
            else:
                ab = platt(p[tr], y[tr])
                P1.append(apply(p[te], ab))
            P0.append(p[te]); Y.append(y[te])
        P0, P1, Y = np.concatenate(P0), np.concatenate(P1), np.concatenate(Y)
        t0, t1 = top(P0, Y), top(P1, Y)
        out[k] = dict(ab=platt(p, y) if k != "p3" else None,
                  scale=top_scale(p, y) if k == "p3" else None,
                  ll_raw=ll(P0, Y), ll_cal=ll(P1, Y),
                      top_raw=t0[0], top_cal=t1[0], top_hit=t0[1],
                      top_err_raw=top_rel_error(t0[0], t0[1]),
                      top_err_cal=top_rel_error(t1[0], t1[1]),
                      raw_prices=P0, calibrated_prices=P1, outcomes=Y,
                      test_seasons=len(seasons) - 1)
    return O, out


def main(export=False):
    O, out = walkforward()
    seasons = sorted(O.season.unique())
    print(f"{len(O):,} skater-games, seasons {seasons}; each season recalibrated from the ones before it\n")
    print(f"{'market':7s} {'hits':>5s} | {'log loss raw':>12s} {'recal':>8s} | {'top 10%: raw priced':>19s} {'recal priced':>12s} {'hit':>7s}")
    for k, v in out.items():
        print(f"{k:7s} {int(v['outcomes'].sum()):5d} | {v['ll_raw']:12.6f} {v['ll_cal']:8.6f} | "
              f"{v['top_raw'] * 100:18.2f}% {v['top_cal'] * 100:11.2f}% {v['top_hit'] * 100:6.2f}%")
        print(f"  ({int(v['outcomes'][np.argsort(-v['raw_prices'])[:max(1, len(v['raw_prices']) // 10)]].sum())} hits in the top tenth)")
    if export:
        path = os.path.join(HERE, "nhl_goal_types_model.json")
        M = json.load(open(path))
        # The derived boards. Keep a layer only when walk-forward top-decile
        # relative error actually falls (last goal ran cold, and its layer fixes
        # that and log loss both).
        wanted = {"p2", "first", "last", "p1"}
        M["cal"] = {k: [round(v["ab"][0], 5), round(v["ab"][1], 5)]
                    for k, v in out.items()
                    if k in wanted and v["top_err_cal"] < v["top_err_raw"]}
        M["cal_scale"] = {"p3": round(out["p3"]["scale"], 5)} if out["p3"]["top_err_cal"] < out["p3"]["top_err_raw"] else {}
        M["cal_note"] = ("Derived goal markets: logistic layers are logit(p') = a + b logit(p); p3 uses a top-decile scale "
                 f"with {P3_PRIOR_HITS} pseudo-hits. Fit on all seasons; ship only when walk-forward top-decile relative error fell.")
        json.dump(M, open(path, "w"), indent=1)
        print(f"\nexported cal for: {sorted(M['cal'])} -> nhl_goal_types_model.json")
    return out


if __name__ == "__main__":
    main(export="export" in _ARGV[1:])
