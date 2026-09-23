"""Do ESPN closing lines help the anytime-goal model (Picks)?

The NFL TD board leaned hard on the team's implied total; the NHL goals model
has only team rates (goals-for, opponent goals-against). This joins each
skater-game to its team's implied goals (research/nhl_odds.py) and reruns the
Picks walk-forward on the same rows, raw and with the shipped isotonic layer.

    python3 research/nhl_goals_odds.py
"""
import sys
import numpy as np
import pandas as pd
sys.argv = sys.argv[:1]
import nhl_goals as G
from nhl_odds import load

o = load()
mp = {}
for r in o.itertuples():
    mp[(r.season, r.date, r.home)] = (r.imp_home, r.imp_away, r.lam)
    mp[(r.season, r.date, r.away)] = (r.imp_away, r.imp_home, r.lam)
D = G.D
v = [mp.get((s, d, t), (np.nan,) * 3) for s, d, t in zip(D.season, D.date, D.team)]
D["team_imp"], D["opp_imp"], D["total_imp"] = [np.array(x) for x in zip(*v)]
print(f"skater-games with a line: {D.team_imp.notna().mean():.2%}")
D = D[D.team_imp.notna()].copy()
for c in ("team_imp", "opp_imp", "total_imp"):
    D["log_" + c] = np.log(D[c])
G.D = D                                   # walk() reads the module global
print(f"{len(D):,} skater-games · ATG base {D.scored.mean():.4f}\n")

S = G.SHIPPED
TEAM = ["opp_ga_prior", "team_gf_prior"]
PLAYER = [f for f in S if f not in TEAM + ["is_home"]]
RUNS = [
    ("shipped (team rates)",                    S),
    ("shipped + team implied goals",            S + ["log_team_imp"]),
    ("team rates -> team implied goals",        PLAYER + ["is_home", "log_team_imp"]),
    ("team rates -> implied goals + total",     PLAYER + ["is_home", "log_team_imp", "log_total_imp"]),
    ("player terms only (no team context)",     PLAYER + ["is_home"]),
]
print(f"{'model':40s} {'logloss':>8s} {'Brier':>8s} {'AUC':>6s} {'ECE':>6s} {'top10%':>7s}   | isotonic: {'logloss':>8s} {'ECE':>6s}")
base = None
for name, f in RUNS:
    m, mi = G.walk(f), G.walk(f, iso=True)
    base = base or m["ll"]
    print(f"{name:40s} {m['ll']:8.5f} {m['brier']:8.5f} {m['auc']:6.4f} {m['ece']:6.4f} {m['top']:7.3f}   |           {mi['ll']:8.5f} {mi['ece']:6.4f}"
          f"   ({(m['ll'] / base - 1) * 100:+.2f}%)")

# Which terms survive next to the line? The standardized coefficients, fit on everything.
f = S + ["log_team_imp"]
ref = {k: (D[k].mean(), D[k].std()) for k in f}
b = G.poisson_irls(G.design(D, f, ref), D.goals.to_numpy(float))
print("\nstandardized coefficients, shipped + implied goals:")
for k, c in zip(["intercept"] + f + ["is_D"], b):
    print(f"  {k:16s} {c:+.4f}")
