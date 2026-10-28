"""Power-play unit on top of the points / assists / PP points means (research, 2026-10-28).

    node research/nhl_combo_fetch.mjs     # 2025-26 lines from the shift charts (cached)
    python3 research/nhl_pp_unit.py       # prints the test, writes pp_unit into research/nhl_points_model.json

The points models carry power-play MINUTES (pptoi_l5, pptoi_l10) but not the unit. Graded against the
SmartStake closes (10/16-10/27, ~600 PP1 player-games) the first unit ran far above our price AND the
market's: points 1+ hit .594 vs ours .521 / close .541, assists .434 vs .380 / .388 (beside the close
z +3.9 / +3.6); every PP1 points over at Ron's books returned +3.3%, every no-PP under +3.6%.

Here, on all of 2025-26 with each team's PREVIOUS game's units (what is known before puck drop, the
way scripts/nhl-combos.js gives them to the build): the shipped means, fitted on the seasons before,
are the offset; an intercept plus PP1 and PP2 terms are fitted on one half of the season and scored
on the other, both ways. PP1 is underpriced in every month of the season (points +1 to +4pp).
"""
import json, os, sys
sys.argv = sys.argv[:1] + ['--export']          # import nhl_points without running its ladders
import numpy as np, pandas as pd
import nhl_points as NP
from nhl_sog import poisson_irls
from nhl_goals import isotonic_fit

HERE = os.path.dirname(os.path.abspath(__file__))
MODEL = os.path.join(HERE, 'nhl_points_model.json')
S = 20252026

combos = json.load(open(os.path.join(HERE, '.cache/nhl_combos_2025.json')))
pre, last = {}, {}                                # (date, team) -> {pid: unit} from the team's previous game
for gid, g in sorted(((k, v) for k, v in combos.items() if v), key=lambda kv: kv[1]['date'] + kv[0]):
    for team, t in g['teams'].items():
        if team in last: pre[(g['date'], team)] = last[team]
        last[team] = {int(p): i + 1 for i, grp in enumerate(t['pp']) for p in grp}

D = NP.D
tr, te = D[D.season < S], D[D.season == S].copy()
key = list(zip(te.date, te.team))
te['ppu'] = [pre[k].get(int(p), 0) if k in pre else np.nan for k, p in zip(key, te.pid)]
te = te[te.ppu.notna()].copy()
te['pp1'] = (te.ppu == 1).astype(float); te['pp2'] = (te.ppu == 2).astype(float)
print(f'{len(te):,} 2025-26 skater-games with the previous game\'s PP units; share by unit',
      te.ppu.value_counts(normalize=True).sort_index().round(3).to_dict())


def offset(target):
    """log of the shipped mean, fitted on the seasons before (PP points through its isotonic map, as the build)."""
    feats = NP.SHIPPED[target]
    ref = {f: (tr[f].mean(), tr[f].std() or 1.0) for f in feats}
    b = poisson_irls(NP.design(tr, feats, ref), tr[target].to_numpy(float))
    mu = np.exp(np.clip(NP.design(te, feats, ref) @ b, -8, 3))
    if target == 'ppp':
        mtr = np.exp(np.clip(NP.design(tr, feats, ref) @ b, -8, 3))
        kx, ky = isotonic_fit(1 - np.exp(-mtr), (tr.ppp.to_numpy() > 0).astype(float))
        mu = -np.log(1 - np.clip(np.interp(1 - np.exp(-mu), kx, ky), 1e-5, 0.97))
    return np.log(mu)


def fit(off, X, y):
    w = np.zeros(X.shape[1])
    for _ in range(40):
        mu = np.exp(off + X @ w); w += np.linalg.solve((X * mu[:, None]).T @ X + 1e-6 * np.eye(len(w)), X.T @ (y - mu))
    return w


def ll1(mu, y):
    h = (y > 0).astype(float); p = np.clip(1 - np.exp(-mu), 1e-6, 1 - 1e-6)
    return float(-(h * np.log(p) + (1 - h) * np.log(1 - p)).mean())


out = {}
X = np.column_stack([np.ones(len(te)), te.pp1, te.pp2])
for target in ('pts', 'a', 'ppp'):
    off, y = offset(target), te[target].to_numpy(float)
    h1 = (te.date < '2026-01-01').to_numpy()
    r = []
    for a, b in ((h1, ~h1), (~h1, h1)):
        w0 = fit(off[a], X[a, :1], y[a]); w = fit(off[a], X[a], y[a])
        r.append((b.sum(), ll1(np.exp(off[b] + X[b, :1] @ w0), y[b]), ll1(np.exp(off[b] + X[b] @ w), y[b])))
    n = sum(x[0] for x in r); l0 = sum(x[0] * x[1] for x in r) / n; l1 = sum(x[0] * x[2] for x in r) / n
    w = fit(off, X, y)
    g = te.assign(p=1 - np.exp(-np.exp(off)), q=1 - np.exp(-np.exp(off + X @ w)), h=(y > 0)).groupby('ppu').agg(
        n=('h', 'size'), shipped=('p', 'mean'), with_unit=('q', 'mean'), hit=('h', 'mean')).round(3)
    print(f'\n{target}: cross-fit 1+ log loss, level only {l0:.5f} -> + PP unit {l1:.5f} ({(l1 / l0 - 1) * 100:+.2f}%)'
          f'   log-multipliers: all {w[0]:+.3f}  PP1 {w[1]:+.3f}  PP2 {w[2]:+.3f}')
    print(g.to_string())
    out[target] = {'all': float(w[0]), 'pp1': float(w[1]), 'pp2': float(w[2])}

M = json.load(open(MODEL))
M['pp_unit'] = {**out, 'note': "log-multipliers on each mean when the player's team's previous game gave his PP unit "
                "(scripts/nhl-combos.js): 'all' for every skater with a known unit (0 = none), plus pp1 / pp2. "
                "Fitted on 2025-26 with the shipped means as offset (research/nhl_pp_unit.py)."}
json.dump(M, open(MODEL, 'w'), indent=1)
print(f'\nwrote pp_unit into {MODEL}')
