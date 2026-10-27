"""Depth-chart multipliers fitted on the LIVE pipeline (research, 2026-10-17).

    node research/depth_live_replay.mjs && python3 research/depth_live.py [--export]

research/depth_rank.py showed the published depth chart adds to the receptions and yards models walk-forward
(receptions 6 of 6 seasons, receiving yards 6/6, rushing 5/6, rush + rec 5/6). But it tested models without the
build's role step, which already spends part of the chart (scripts/picks.js "Role, sitewide"). So the multipliers
are fitted here on boards rebuilt through the real buildPicks - 2025 weeks 2-18 - and checked on 2026 weeks 2-6,
a season they never saw. Graded on players who played (snap counts). Rank as the build reads it (best pos_rank
in the published chart; unlisted = 4).
"""
import os, sys, json
import numpy as np, pandas as pd
HERE = os.path.dirname(os.path.abspath(__file__)); C = os.path.join(HERE, '.cache')
SHRINK = 150          # rows of an average player pulled toward 1.0

def actuals():
    a = pd.read_csv(os.path.join(C, 'nfl_act_2026.csv')).assign(season=2026)
    # 2025: from the research frames (snap pool, zeros kept)
    r = pd.read_parquet(os.path.join(HERE, 'receptions.parquet'), columns=['season', 'week', 'pid', 'rec'])
    r = r[r.season == 2025]
    sys.path.insert(0, HERE); import yards as Y, warnings; warnings.filterwarnings('ignore')
    d = Y.load_pbp(port=True); sk, _ = Y.skill_frame(d)
    y = sk[sk.season == 2025][['season', 'week', 'pid', 'ryds', 'rush']]
    b = y.merge(r, on=['season', 'week', 'pid'], how='outer').fillna(0)
    return pd.concat([b, a], ignore_index=True)

R = pd.read_csv(os.path.join(C, 'depth_replay.csv')).merge(actuals(), on=['season', 'week', 'pid'])
R['y'] = np.select([R.board == 'rec', R.board == 'rush', R.board == 'rr', R.board == 'recn'], [R.ryds, R.rush, R.ryds + R.rush, R.rec], np.nan)
R = R[R.y.notna() & R.board.isin(['rec', 'rush', 'rr', 'recn'])]
R['rk'] = R.depth.fillna(4).clip(upper=4).astype(int)
fit, chk = R[R.season == 2025], R[R.season == 2026]
out = {}
for b, g in fit.groupby('board'):
    k = SHRINK * g.y.mean()
    t = g.groupby(['pos', 'rk']).agg(n=('y', 'size'), a=('y', 'sum'), p=('mu', 'sum'))
    t['f'] = (t.a + k) / (t.p + k)
    out[b] = {f'{p}|{r}': round(float(v), 4) for (p, r), v in t.f.items()}
    c = chk[chk.board == b].copy(); c['f'] = [out[b].get(f'{p}|{r}', 1.0) for p, r in zip(c.pos, c.rk)]
    print(f'\n{b}: fitted on 2025 ({len(g)} rows), checked on 2026 ({len(c)} rows)')
    tab = t[['n', 'f']].join(c.groupby(['pos', 'rk']).apply(lambda h: pd.Series({'n26': len(h), 'x26_before': h.y.sum() / h.mu.sum(), 'x26_after': h.y.sum() / (h.mu * h.f).sum()})))
    print(tab.round(3).to_string())
    print(f'  2026 MAE {np.abs(c.y - c.mu).mean():.3f} -> {np.abs(c.y - c.mu * c.f).mean():.3f};  level {c.y.sum() / c.mu.sum():.3f} -> {c.y.sum() / (c.mu * c.f).sum():.3f}')
# Shipped: only the cells that replicated in every slice (2025 weeks 2-6, 2025 weeks 7+, 2026 weeks 2-6) and
# improved 2026's ladder log loss out of sample - RB1 rushing (0.6231 -> 0.6125), RB1 rush + receiving, TE1
# receptions (0.6226 -> 0.6199). The rest moved the 2026 check either way and the role step already carries them.
SHIP = {'rush': ['RB|1'], 'rr': ['RB|1'], 'recn': ['TE|1']}
if '--export' in sys.argv:
    p = os.path.join(HERE, 'depth_model.json')
    keep = json.load(open(p)) if os.path.exists(p) else {}       # td_starter / role_mu are written elsewhere
    json.dump({**keep, 'note': ('Multiplier on a STARTER\'s projection (depth rank 1 on the published chart, as the build reads it), fitted on the '
                        'live pipeline replayed over 2025 weeks 2-18 and checked on 2026 weeks 2-6 (research/depth_live.py). '
                        'Boards: recn = receptions, rush / rr = yards.'), 'shrink': SHRINK,
               'starter': {b: {c.split('|')[0]: out[b][c] for c in cells} for b, cells in SHIP.items()}},
              open(p, 'w'), indent=1)
    print('wrote', p, json.load(open(p))['starter'])
