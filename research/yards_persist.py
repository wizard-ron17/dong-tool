"""Yards: does a player's own track record against the model sharpen it? (research, 2026-10-17)

    python3 research/yards_persist.py

The receptions model gained from it (research/receptions_persist.py): the market prices receivers who beat
their projection year after year, and our features (2-season priors shrunk to the position, last-3) don't.
SmartStake's week-6 closes had our receiving and rushing yards overs 5-15pp under the market. Same test here,
per market: each row's walk-forward projection times m^b, m = (his past yards + K) / (his past projections + K)
over last season and this one, b fitted on earlier seasons; scored on 2020-2025 by MAE, log loss at a line on
his own average, and calibration of the top quintile.
"""
import os, sys, warnings
warnings.filterwarnings('ignore')
import numpy as np, pandas as pd
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
import yards as Y

d = Y.load_pbp(port=True); ctx = Y.game_ctx(d)
skill, lg = Y.skill_frame(d); qb = Y.qb_frame(d, ctx)

def track(t, y, K):
    """within the 2-season window, everything before this row"""
    t = t.sort_values(['pid', 'season', 'week']).reset_index(drop=True)
    cs = t.groupby(['pid', 'season']).agg(sy=(y, 'sum'), sm=('mu', 'sum')).reset_index()
    prev = cs.groupby('pid').season.shift(1) == cs.season - 1
    cs['psy'] = cs.groupby('pid').sy.shift(1).where(prev, 0).fillna(0); cs['psm'] = cs.groupby('pid').sm.shift(1).where(prev, 0).fillna(0)
    t = t.merge(cs[['pid', 'season', 'psy', 'psm']], on=['pid', 'season'], how='left')
    g = t.groupby(['pid', 'season'], sort=False)
    t['m'] = (t.psy + g[y].cumsum() - t[y] + K) / (t.psm + g.mu.cumsum() - t.mu + K)
    return t

rows = []
for key, (lab, y, pop, fs) in Y.MARKETS.items():
    base = qb if key in ('pass', 'qbrush') else skill
    q = base[pop(base) & (base.games_prior >= 3)].dropna(subset=fs + [y]).copy()
    q['line'] = np.floor(q[y + '_prior']) + 0.5
    _, _, t = Y.walk(q, fs, y, 'line', first=2018)          # walk-forward mu per row, 2018-2025
    for K in (100, 300):
        tt = track(t, y, K)
        for s in range(2020, 2026):
            tr, te = tt[tt.season < s], tt[tt.season == s]
            def score(bb, d_):
                mu = d_.mu.to_numpy() * d_.m.to_numpy() ** bb
                return mu
            # b on earlier seasons by MAE... and by log loss through the ratio pricing
            best, bl = 0, 1e9
            for bb in (0, 0.25, 0.5, 0.75, 1.0):
                mtr = score(bb, tr); e = np.abs(tr[y].to_numpy() - mtr).mean()
                if e < bl: bl, best = e, bb
            mu0 = te.mu.to_numpy(); mu1 = score(best, te); yy = te[y].to_numpy(float); L = te.line.to_numpy()
            r0 = tr[y].to_numpy(float) / np.maximum(tr.mu.to_numpy(), 1e-6); r1 = tr[y].to_numpy(float) / np.maximum(score(best, tr), 1e-6)
            p0 = Y.p_over(L, mu0, r0, tr.mu.to_numpy()); p1 = Y.p_over(L, mu1, r1, score(best, tr))
            o = (yy > L).astype(float); ll = lambda p: -np.mean(o * np.log(p) + (1 - o) * np.log(1 - p))
            top = mu0 >= np.quantile(mu0, 0.8)
            rows.append({'market': key, 'K': K, 'season': s, 'b': best, 'mae0': np.abs(yy - mu0).mean(), 'mae1': np.abs(yy - mu1).mean(),
                         'll0': ll(p0), 'll1': ll(p1), 'top0': yy[top].sum() / mu0[top].sum(), 'top1': yy[top].sum() / mu1[top].sum(), 'level0': yy.sum() / mu0.sum()})
R = pd.DataFrame(rows)
S = R.groupby(['market', 'K'])[['b', 'mae0', 'mae1', 'll0', 'll1', 'top0', 'top1', 'level0']].mean()
S['seasons_better_ll'] = R.assign(w=R.ll1 < R.ll0).groupby(['market', 'K']).w.sum()
print(S.round(4).to_string())
print(R[R.K == 100].pivot(index='season', columns='market', values='level0').round(3))
