"""SOG runs 5.7% COLD live (2026-10, 17 nights) though walk-forward it ran ~3% hot. Why, and the fix.
(research, 2026-10-16)

    python3 research/nhl_sog_teamrate.py

Cause: a parity break in the team-context features. Research builds opp_sa_prior / team_sf_prior as a
career-long as-of mean per team (shrunk, never resetting), so in 2025-26 it averaged 29.6 shots a game
while teams actually took 27.6. The build (scripts/nhl-shots.js) feeds this season + 0.35 x last season,
about 27. The coefficient was learned on the lagging scale, so the live feature reads ~1 SD low and every
projection comes out ~5% short.

Variants, walk-forward (fit on earlier seasons, predict each season cold):
  V0  shipped (research's career-long team means)
  V1  the build's definition: this season to date + 0.35 x last season (what production feeds)
  V2  V1 relative to the league's rate under the same definition (a level-free matchup term)
  V3  V2, plus the training seasons weighted toward the recent (league shot volume fell every season)
Each is scored on the ladder log loss and on the level: actual / projected overall and in October.
"""
import os, sys
import numpy as np, pandas as pd
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
import nhl_sog as m
D = m.D.copy()

# nhl_sog.D now carries the build's definition in opp_sa_prior / team_sf_prior (with_build_team_rates)
# and the crawl's career-long means as opp_sa_career / team_sf_career.
D['opp_sa_b'], D['team_sf_b'] = D.opp_sa_prior, D.team_sf_prior
D['opp_sa_rel'] = np.log(D.opp_sa_b / D.lg_b); D['team_sf_rel'] = np.log(D.team_sf_b / D.lg_b)
CAREER = {'opp_sa_prior': 'opp_sa_career', 'team_sf_prior': 'team_sf_career'}
print('team features by season (mean):'); print(D.groupby('season')[['opp_sa_career', 'opp_sa_b', 'lg_b']].mean().round(2), '\n')

BASE = [f for f in m.SHIPPED if f not in ('opp_sa_prior', 'team_sf_prior')]
V0F = [CAREER.get(f, f) for f in m.SHIPPED]
VARS = {'V0 shipped': (V0F, None), 'V0 fed the build features (= live)': (V0F, 'live'), 'V1 build definition': (BASE + ['opp_sa_b', 'team_sf_b'], None),
        'V2 relative to league': (BASE + ['opp_sa_rel', 'team_sf_rel'], None), 'V3 V2 + recent-weighted': (BASE + ['opp_sa_rel', 'team_sf_rel'], 0.6)}

def poisson_w(X, y, w, ridge=1.0, it=50):
    b = np.zeros(X.shape[1]); b[0] = np.log(max(np.average(y, weights=w), 1e-6))
    for _ in range(it):
        eta = np.clip(X @ b, -6, 6); mu = np.exp(eta); W = mu * w
        z = eta + (y - mu) / np.maximum(mu, 1e-6)
        A = X.T @ (X * W[:, None]) + ridge * np.eye(X.shape[1]); A[0, 0] -= ridge
        nb = np.linalg.solve(A, X.T @ (W * z))
        if np.max(np.abs(nb - b)) < 1e-9: b = nb; break
        b = nb
    return b

seasons = sorted(D.season.unique()); res = []
for name, (feats, decay) in VARS.items():
    for s in seasons[1:]:
        tr, te = D[D.season < s], D[D.season == s]
        ref = {f: (tr[f].mean(), tr[f].std() or 1.0) for f in feats}
        w = np.ones(len(tr)) if decay in (None, 'live') else decay ** ((s - tr.season.to_numpy()) // 10001 - 1)
        Xtr = m.design(tr, feats, ref); b = poisson_w(Xtr, tr.sog.to_numpy(float), w)
        mu_tr = np.exp(np.clip(Xtr @ b, -6, 6)); alpha = m.nb_dispersion(tr.sog.to_numpy(float), mu_tr)
        te_x = te.assign(opp_sa_career=te.opp_sa_b, team_sf_career=te.team_sf_b) if decay == 'live' else te   # trained one way, fed the other
        mu = np.exp(np.clip(m.design(te_x, feats, ref) @ b, -6, 6)); y = te.sog.to_numpy(float)
        ll = np.mean([-(np.where(y > L, np.log(m.nb_sf(L, mu, alpha)), np.log(1 - m.nb_sf(L, mu, alpha)))).mean() for L in m.LINES])
        oc = pd.to_datetime(te.date).dt.month.to_numpy() == 10
        res.append({'variant': name, 'season': s, 'll': ll, 'ratio': y.sum() / mu.sum(), 'oct_ratio': y[oc].sum() / mu[oc].sum()})
R = pd.DataFrame(res)
print(R.pivot(index='variant', columns='season', values=['ll', 'ratio', 'oct_ratio']).round(4).to_string())
print('\nmean ladder log loss over the test seasons:'); print(R.groupby('variant').ll.mean().round(5))
