"""Implied team goals from ESPN closing lines, joined onto the goalie starts.

For each game: the total's over/under prices, de-vigged, fix the expected total
goals (lambda such that P(Poisson(lambda) > line) = fair P(over)); the
moneyline, de-vigged, splits it (lambda_h + lambda_a = lambda, with the home
side's regulation win plus half of the ties matching the fair home price).

    python3 research/nhl_odds.py    # coverage + ladders with / without the lines
"""
import json, os, glob, sys
import numpy as np
import pandas as pd
from scipy.stats import poisson
from scipy.optimize import brentq

CACHE = os.environ.get("NHL_CACHE") or "/tmp/nhl-cache"


def implied_prob(american):
    a = float(american)
    return 100 / (a + 100) if a > 0 else -a / (-a + 100)


def fair_pair(a, b):
    pa, pb = implied_prob(a), implied_prob(b)
    return pa / (pa + pb)


def total_lambda(line, p_over):
    f = lambda lam: poisson.sf(np.floor(line), lam) - p_over
    return brentq(f, 1.0, 14.0)


def win_prob(lh, la, K=15):
    ph, pa = poisson.pmf(np.arange(K), lh), poisson.pmf(np.arange(K), la)
    m = np.outer(ph, pa)
    return np.tril(m, -1).sum() + 0.5 * np.trace(m)      # home ahead + half the ties (OT/SO)


def split(lam, p_home):
    f = lambda s: win_prob(lam * s, lam * (1 - s)) - p_home
    try:
        return brentq(f, 0.2, 0.8)
    except ValueError:
        return 0.5


def load():
    rows = []
    for p in glob.glob(os.path.join(CACHE, "20*", "20*-*-*", "odds.json")):
        season = int(p.split(os.sep)[-3]); date = p.split(os.sep)[-2]
        for g in json.load(open(p)):
            if None in (g.get("total"), g.get("over"), g.get("under"), g.get("ml_home"), g.get("ml_away")):
                continue
            try:
                lam = total_lambda(g["total"], fair_pair(g["over"], g["under"]))
                s = split(lam, fair_pair(g["ml_home"], g["ml_away"]))
            except (ValueError, ZeroDivisionError):
                continue
            rows.append(dict(season=season, date=date, home=g["home"], away=g["away"], total=g["total"],
                             lam=lam, imp_home=lam * s, imp_away=lam * (1 - s), provider=g.get("provider")))
    return pd.DataFrame(rows)


def attach(D):
    """opp_imp / team_imp / total_imp for each start; NaN where no line."""
    o = load()
    mp = {}
    for r in o.itertuples():
        mp[(r.season, r.date, r.home)] = (r.imp_home, r.imp_away, r.lam)
        mp[(r.season, r.date, r.away)] = (r.imp_away, r.imp_home, r.lam)
    v = [mp.get((s, d, t), (np.nan,) * 3) for s, d, t in zip(D.season, D.date, D.team)]
    D = D.copy()
    D["team_imp"], D["opp_imp"], D["total_imp"] = [np.array(x) for x in zip(*v)]
    return D, o


if __name__ == "__main__":
    sys.argv = sys.argv[:1]
    import nhl_saves as S
    D, o = attach(S.D)
    print(f"{len(o):,} games with lines · providers {o.provider.value_counts().to_dict()}")
    print(f"starts with a line: {D.opp_imp.notna().mean():.1%} · by season {D.groupby('season').opp_imp.apply(lambda x: round(x.notna().mean(), 3)).to_dict()}")
    print(f"implied goals: mean {o.imp_home.mean():.2f} home / {o.imp_away.mean():.2f} away · total {o.lam.mean():.2f}")
