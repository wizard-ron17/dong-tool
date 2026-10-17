"""QB rushing: a starter's track record against the model (research, 2026-10-17).

    node research/qbrush_track.mjs && python3 research/qbrush_track.py [--export]

research/yards_persist.py: scaling the walk-forward QB-rush projection by his own (rush + K) / (projection + K)
cut ladder log loss 0.6695 -> 0.6604 and MAE 13.0 -> 12.5. That used research's full history; the build sees two
seasons. So this tests on the build's own sums (qbrush_track.mjs runs scripts/yards.js qbRushSums for every start
2018-2025 with only S-1 and S loaded), K and b fitted on earlier seasons, the ratio table refitted on the scaled
projection the same way research/yards.py builds it. --export writes markets.qbrush.track and the new ratio table.
"""
import os, sys, json, warnings
warnings.filterwarnings('ignore')
import numpy as np, pandas as pd
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
import yards as Y

d = Y.load_pbp(port=True); ctx = Y.game_ctx(d); qb = Y.qb_frame(d, ctx)
lab, y, pop, fs = Y.MARKETS['qbrush']
q = qb[pop(qb) & (qb.games_prior >= 3)].dropna(subset=fs + [y]).copy(); q['line'] = np.floor(q[y + '_prior']) + 0.5
_, _, t = Y.walk(q, fs, y, 'line', first=2019)
S = pd.read_csv(os.path.join(HERE, '.cache', 'qbrush_track.csv'))
t = t.merge(S, on=['pid', 'season', 'week'], how='left').fillna({'rush_y': 0, 'base': 0}) if 'rush_y' in t else t.merge(S.rename(columns={'rush': 'trk_rush'}), on=['pid', 'season', 'week'], how='left')
t[['trk_rush', 'base']] = t[['trk_rush', 'base']].fillna(0)
print(f'{len(t):,} starts, {t.base.gt(0).mean():.0%} with a track record in the window')

def ladder_ll(tr_mu, tr_y, te_mu, te_y, anchor):
    """log loss over a ladder of lines set off `anchor` (his own rushing average): the SAME lines for every model."""
    r = tr_y / np.maximum(tr_mu, 1e-6); out = []
    for k in (0.5, 0.75, 1.0, 1.25, 1.5):
        L = np.floor(anchor * k) + 0.5; o = (te_y > L).astype(float)
        p = Y.p_over(L, te_mu, r, tr_mu); out.append(-np.mean(o * np.log(p) + (1 - o) * np.log(1 - p)))
    return float(np.mean(out))

res = []
for K in (100, 200, 300, 500):
    m = ((t.trk_rush + K) / (t.base + K)).to_numpy()
    for b in (0.5, 0.75, 1.0):
        mu1 = t.mu.to_numpy() * m ** b
        for s in sorted(t.season.unique())[1:]:
            tr = (t.season < s).to_numpy(); te = (t.season == s).to_numpy(); yy = t[y].to_numpy(float)
            A = t.rush_prior.to_numpy()[te]
            res.append({'K': K, 'b': b, 'season': s, 'll0': ladder_ll(t.mu.to_numpy()[tr], yy[tr], t.mu.to_numpy()[te], yy[te], A),
                        'll1': ladder_ll(mu1[tr], yy[tr], mu1[te], yy[te], A), 'mae0': np.abs(yy[te] - t.mu.to_numpy()[te]).mean(), 'mae1': np.abs(yy[te] - mu1[te]).mean()})
R = pd.DataFrame(res)
T = R.groupby(['K', 'b'])[['ll0', 'll1', 'mae0', 'mae1']].mean(); T['better'] = R.assign(w=R.ll1 < R.ll0).groupby(['K', 'b']).w.sum()
print(T.round(5).to_string())
K, B = 200, 0.75          # best walk-forward: ladder log loss 0.63578 -> 0.62967, 6 of 6 seasons; MAE 13.01 -> 12.71
if '--export' in sys.argv:
    mu1 = t.mu * ((t.trk_rush + K) / (t.base + K)) ** B
    edges, buckets = Y.ratio_table(t.assign(mu=mu1), y)
    p = os.path.join(HERE, 'yards_model.json'); M = json.load(open(p))
    M['markets']['qbrush']['track'] = {'k': K, 'b': B, 'note': 'research/qbrush_track.py: his rushing over the base projection across last season and this one, ((rush + k) / (base + k))^b; ratio table refitted on the scaled projection'}
    M['markets']['qbrush']['ratio_edges'], M['markets']['qbrush']['ratio_q'] = edges, buckets
    json.dump(M, open(p, 'w'), indent=1); print('wrote', p, 'K', K, 'b', B)
