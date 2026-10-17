"""Anytime TD: a depth-chart shift fitted on the LIVE pipeline (research, 2026-10-17).

    node research/depth_live_replay.mjs && python3 research/td_depth_live.py

Live 2026 had starters under-priced (RB1 39.0 vs 43.8%, TE1 21.6 vs 26.2, WR1 29.6 vs 32.5, QB1 13.2 vs 15.7)
and backups a touch over. research/td_track.py: across 2018-2025 each room's top-priced player scored more than
priced every season, and a logit shift per position x room rank was stable from 2020 (RB1 +0.10-0.15, WR1 +0.10,
TE1 +0.075, RB3 -0.20; log loss -0.12%). Research has no role step and the live board does (it already moves
prices on the depth chart), so the shift is fitted here on the board rebuilt through buildPicks for 2025 weeks
2-18 (depth = the published chart's rank as the role step reads it) and checked on 2026 weeks 2-6.
"""
import os, json
import numpy as np, pandas as pd
HERE = os.path.dirname(os.path.abspath(__file__)); C = os.path.join(HERE, '.cache')
lg = lambda q: np.log(q / (1 - q)); ex = lambda z: 1 / (1 + np.exp(-z))
ll = lambda q, y: -np.mean(y * np.log(q) + (1 - y) * np.log(1 - q))

R = pd.read_csv(os.path.join(C, 'depth_replay.csv')); R = R[R.board == 'td'].rename(columns={'mu': 'p'})
# outcomes: 2025 from the research frame (every snap-pool player-game), 2026 from the TD recap over snap-count players
d25 = pd.read_parquet(os.path.join(HERE, 'dataset.parquet'), columns=['season', 'week', 'pid', 'scored'])
d25 = d25[d25.season == 2025]
rec = json.load(open(os.path.join(HERE, '..', 'nfl', 'data.json')))['tdRecap']
sc = {(int(w), x['pid']) for w, xs in rec.items() for x in xs if x.get('type') != 'pass'}
a26 = pd.read_csv(os.path.join(C, 'nfl_act_2026.csv'))[['pid', 'week']].assign(season=2026)
a26['scored'] = [float((w, p) in sc) for w, p in zip(a26.week, a26.pid)]
R = R.merge(pd.concat([d25, a26]), on=['season', 'week', 'pid'])
R['rk'] = R.depth.fillna(4).clip(upper=4).astype(int)
fit, chk = R[R.season == 2025], R[R.season == 2026]
print('2025 (live pipeline): priced vs hit by position x depth')
print(fit.groupby(['pos', 'rk']).agg(n=('scored', 'size'), p=('p', 'mean'), hit=('scored', 'mean')).round(3).to_string())
shift = {}
for (pos, rk), h in fit.groupby(['pos', 'rk']):
    if len(h) < 80: continue
    cs = np.linspace(-0.5, 0.5, 41); z = lg(h.p.clip(1e-4, 1 - 1e-4).to_numpy()); y = h.scored.to_numpy(float)
    shift[f'{pos}|{rk}'] = float(cs[int(np.argmin([ll(ex(z + c), y) for c in cs]))])
print('\nshifts fitted on 2025:', shift)
c = np.array([shift.get(f'{a}|{b}', 0.0) for a, b in zip(chk.pos, chk.rk)])
q0 = chk.p.clip(1e-4, 1 - 1e-4).to_numpy(); q1 = ex(lg(q0) + c); y = chk.scored.to_numpy(float)
print(f'\n2026 check ({len(chk)} player-games): log loss {ll(q0, y):.5f} -> {ll(q1, y):.5f}')
chk = chk.assign(q1=q1)
print(chk.groupby(['pos', 'rk']).agg(n=('scored', 'size'), p0=('p', 'mean'), p1=('q1', 'mean'), hit=('scored', 'mean')).round(3).to_string())
# the same cells only where the research test agrees in sign (stable 2020-2025)

# Starters only: the cells that agree in sign everywhere (research 2020-2025, the live pipeline 2025, live 2026).
# The backup cells flip season to season (RB2, WR2 under-priced in 2025, over in 2026).
START = {k: v for k, v in shift.items() if k.endswith('|1')}
c = np.array([START.get(f'{a}|{b}', 0.0) for a, b in zip(chk.pos, chk.rk)]); q2 = ex(lg(q0) + c)
print(f'\nstarters only {START}: 2026 log loss {ll(q0, y):.5f} -> {ll(q2, y):.5f}')
for pos in ('QB', 'RB', 'TE', 'WR'):
    m = ((chk.pos == pos) & (chk.rk == 1)).to_numpy()
    print(f'  {pos}1 n {m.sum()}: priced {q0[m].mean():.3f} -> {q2[m].mean():.3f}, hit {y[m].mean():.3f}; log loss {ll(q0[m], y[m]):.4f} -> {ll(q2[m], y[m]):.4f}')
if __import__('sys').argv[-1] == '--export':
    p = os.path.join(HERE, 'depth_model.json'); M = json.load(open(p))
    M['td_starter'] = {k.split('|')[0]: round(v, 3) for k, v in START.items()}
    M['td_note'] = ('Anytime TD: a logit shift on a starter\'s price (depth rank 1), fitted on the live pipeline over 2025 weeks 2-18 '
                    '(research/td_depth_live.py); the backup cells flip season to season and are not used.')
    json.dump(M, open(p, 'w'), indent=1); print('wrote', p, M['td_starter'])
