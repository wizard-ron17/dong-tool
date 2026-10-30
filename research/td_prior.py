"""Anytime TD: players priced off the POSITION PRIOR (research, 2026-10-30).

    node research/td_prior_replay.mjs && python3 research/td_prior.py [--export]

A player with no games in the 2-season window gets his position's mean touches, TD share and red-zone
touches (scripts/picks.js usage priors); only his snap share steps down with the depth chart. Training
rows are players who played, so a prior row there is a rookie getting snaps. The live board also
prices depth-chart backups: Jaydn Ott (KC RB4) was 18.8% on 2026-10-30, books about 2%.

Prior rows are the ones whose touches equal their position's prior that season (the value most rows
share), which is the build's own test: no games in the window. Fitted on the 2025 live-pipeline replay (outcomes over every snap-pool
player), checked on 2026 weeks 2-6 (outcomes over players with a touch, so its hit rates run a little
high), as research/td_depth_live.py does.
"""
import os, sys, json
import numpy as np, pandas as pd
HERE = os.path.dirname(os.path.abspath(__file__)); C = os.path.join(HERE, '.cache')
lg = lambda q: np.log(q / (1 - q)); ex = lambda z: 1 / (1 + np.exp(-z))
ll = lambda q, y: -np.mean(y * np.log(q) + (1 - y) * np.log(1 - q))

R = pd.read_csv(os.path.join(C, 'td_prior_replay.csv'))
R['tk'] = R.touches.round(4)
# the position prior is one value per season and position (priorFor): the touches value most rows share.
# A weekly "two players tie" rule also catches round-number coincidences (0, 2 touches) and shared partial
# shrinks, so this is the one that matches the build's own test (no games in the window).
mode = R.groupby(['season', 'pos']).tk.agg(lambda s: s.value_counts().idxmax())
R['prior'] = R.tk.to_numpy() == R.set_index(['season', 'pos']).index.map(mode).to_numpy()
R['rk'] = R.depth.fillna(4).clip(upper=4).astype(int)

d25 = pd.read_parquet(os.path.join(HERE, 'dataset.parquet'), columns=['season', 'week', 'pid', 'scored'])
d25 = d25[d25.season == 2025]
rec = json.load(open(os.path.join(HERE, '..', 'nfl', 'data.json')))['tdRecap']
sc = {(int(w), x['pid']) for w, xs in rec.items() for x in xs if x.get('type') != 'pass'}
a26 = pd.read_csv(os.path.join(C, 'nfl_act_2026.csv'))[['pid', 'week']].drop_duplicates().assign(season=2026)
a26['scored'] = [float((w, p) in sc) for w, p in zip(a26.week, a26.pid)]
played = pd.concat([d25, a26])
print(f"replay rows {len(R)}, on the prior {R.prior.sum()} ({R.prior.mean():.1%}); "
      f"of those, played {R[R.prior].merge(played, on=['season', 'week', 'pid']).shape[0]}")
R = R.merge(played, on=['season', 'week', 'pid'])
R = R[R.pos != 'QB']                                   # QBs run on the passing-TD-free rush model; prior QBs are rare
fit, chk = R[R.season == 2025], R[(R.season == 2026) & (R.week <= 6)]

def table(h, title):
    print(f'\n{title}')
    print(h.groupby(['prior', 'pos', 'rk']).agg(n=('scored', 'size'), priced=('p', 'mean'), hit=('scored', 'mean')).round(3).to_string())
table(fit, '2025 live pipeline: priced vs hit, prior rows vs the rest, by position x depth')

# one logit shift per depth bucket for prior rows (starters 1, backups 2, deep 3+), fitted on 2025
def bucket(rk): return np.where(rk <= 1, 1, np.where(rk == 2, 2, 3))
shift = {}
f = fit[fit.prior]
# backups and deeper share one shift: split by position or depth they fit 2025 better and 2026 worse
f = f[f.rk >= 2]
for b in (2,):
    h = f
    if len(h) < 40: continue
    cs = np.linspace(-3, 1, 81); z = lg(h.p.clip(1e-4, 1 - 1e-4).to_numpy()); y = h.scored.to_numpy(float)
    shift[b] = float(cs[int(np.argmin([ll(ex(z + c), y) for c in cs]))])
    print(f'  depth bucket {b}: n {len(h)}, priced {h.p.mean():.3f}, hit {y.mean():.3f}, shift {shift[b]:+.2f}')

for name, h in (('2025 (fit)', fit), ('2026 wk 2-6 (check)', chk)):
    q0 = h.p.clip(1e-4, 1 - 1e-4).to_numpy(); y = h.scored.to_numpy(float)
    c = np.where(h.prior & (h.rk >= 2), shift.get(2, 0.0), 0.0); q1 = ex(lg(q0) + c)
    m = h.prior.to_numpy()
    print(f'\n{name}: all {len(h)} log loss {ll(q0, y):.5f} -> {ll(q1, y):.5f}; '
          f'prior rows {m.sum()}: priced {q0[m].mean():.3f} -> {q1[m].mean():.3f}, hit {y[m].mean():.3f}, '
          f'log loss {ll(q0[m], y[m]):.4f} -> {ll(q1[m], y[m]):.4f}')

if sys.argv[-1] == '--export':
    p = os.path.join(HERE, 'depth_model.json'); M = json.load(open(p))
    M['td_prior'] = round(shift[2], 2)
    M['td_prior_note'] = ('Anytime TD: a logit shift on a backup (depth rank 2+) priced off the position prior (no games in '
                          'the window), fitted on the 2025 live-pipeline replay and checked on 2026 (research/td_prior.py).')
    json.dump(M, open(p, 'w'), indent=1); print('wrote', p, M['td_prior'])
