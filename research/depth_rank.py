"""Does the published depth chart add to the receptions and yards models? (research, 2026-10-17)

    python3 research/depth_rank.py

Graded live (2026 weeks 1-6, the boards as built before kickoff): starters on the published depth chart were
under-projected and backups over-projected, at every position - WR1 receiving yards x1.19, TE1 receptions
x1.17, RB1 rushing x1.12, RB3 rushing x0.82. The models only see usage (snap share, targets, last-3); research
never had the chart itself (scripts/picks.js uses it for role, but research/role_adjust.py tested a proxy, the
team's snap order). nflverse publishes it weekly back to 2016 (research/.cache/nfl/depth_YYYY.csv).

Rank = his best depth slot that week (rank 1 = a starter at some slot, the build's rule): through 2024 the
weekly chart's depth_team; 2025 is daily snapshots (pos_rank), the last one before the week's first game.
Test: actual / walk-forward projection by position x rank, per season; then a multiplier per position x rank
fitted on earlier seasons, scored walk-forward.
"""
import os, sys, warnings
warnings.filterwarnings('ignore')
import numpy as np, pandas as pd
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
C = os.path.join(HERE, '.cache', 'nfl')
POS = {'WR': 'WR', 'TE': 'TE', 'RB': 'RB', 'HB': 'RB', 'FB': 'FB'}

def ranks():
    out = []
    for y in range(2018, 2025):
        d = pd.read_csv(os.path.join(C, f'depth_{y}.csv'), usecols=['season', 'week', 'game_type', 'formation', 'depth_team', 'gsis_id', 'position'], low_memory=False)
        d = d[(d.formation == 'Offense') & d.position.isin(POS) & d.gsis_id.notna()]
        d['rank'] = pd.to_numeric(d.depth_team, errors='coerce')
        out.append(d.groupby(['season', 'week', 'gsis_id'])['rank'].min().reset_index())
    # 2025: daily snapshots; the last one strictly before each week's first game
    d = pd.read_csv(os.path.join(C, 'depth_2025.csv'), usecols=['dt', 'gsis_id', 'pos_abb', 'pos_rank'], low_memory=False)
    d = d[d.pos_abb.isin(POS) & d.gsis_id.notna()]; d['day'] = d.dt.str.slice(0, 10)
    games = pd.read_csv(os.path.join(C, 'games.csv'), usecols=['game_id', 'season', 'week', 'gameday'])
    first = games[games.season == 2025].groupby('week').gameday.min()
    days = np.sort(d.day.unique())
    for w, gd in first.items():
        prior = days[days < gd]
        if not len(prior): continue
        snap = d[d.day == prior[-1]]
        r = snap.groupby('gsis_id').pos_rank.min().rename('rank').reset_index(); r['season'] = 2025; r['week'] = w
        out.append(r)
    R = pd.concat(out, ignore_index=True).rename(columns={'gsis_id': 'pid'})
    return R

if __name__ == '__main__':
    R = ranks(); R.to_parquet(os.path.join(HERE, '.cache', 'depth_ranks.parquet'))
    print(R.groupby('season').size().to_dict())
    # receptions: walk-forward projection with the shipped track record (receptions_persist.py v4)
    import receptions_persist as P     # runs its walk-forward and leaves d with mu (base) and m (build track record)
    d = P.d.copy(); b_ = P.PERSIST_B
    x = d.mu.to_numpy() * d.m.to_numpy() ** b_
    mu1 = np.full(len(d), np.nan)
    for s in sorted(d.season.unique())[1:]:
        tr = (d.season < s).to_numpy(); te = (d.season == s).to_numpy()
        bx, by = P.fit_map(x[tr], d.rec.to_numpy(float)[tr]); mu1[te] = P.apply_map(bx, by, x[te])
    d['pred'] = mu1; d = d[d.pred.notna()].merge(R, on=['pid', 'season', 'week'], how='left')
    d['rk'] = d['rank'].fillna(9).clip(upper=4).astype(int)
    T = d.groupby(['position', 'rk']).apply(lambda g: pd.Series({'n': len(g), 'x': g.rec.sum() / g.pred.sum()})).unstack('rk')
    print('\nreceptions: actual / projection (shipped model + track record), all seasons, by position x depth rank (4 = 4+ or unlisted)')
    print(T.round(3).to_string())
    S = d[d.position == 'WR'].groupby(['season', 'rk']).apply(lambda g: g.rec.sum() / g.pred.sum()).unstack('rk')
    print('\nWR by season:'); print(S.round(3).to_string())
    d.to_parquet(os.path.join(HERE, '.cache', 'rec_depth_frame.parquet'))

def depth_test(d, y, pred, ll_fn, label, shrink=200.0):
    """multiplier per position x rank = (sum actual + shrink) / (sum projected + shrink) on earlier seasons."""
    res = []
    for s in sorted(d.season.unique())[1:]:
        tr, te = d[d.season < s], d[d.season == s]
        g = tr.groupby(['position', 'rk']).agg(a=(y, 'sum'), p=(pred, 'sum'))
        k = shrink * tr[y].mean()                      # shrink in units of an average row
        f = ((g.a + k) / (g.p + k)).rename('f')
        te = te.merge(f.reset_index(), on=['position', 'rk'], how='left'); te['f'] = te.f.fillna(1.0)
        res.append({'season': s, 'base': ll_fn(te[pred].to_numpy(), te[y].to_numpy(float)), 'depth': ll_fn(te[pred].to_numpy() * te.f.to_numpy(), te[y].to_numpy(float)),
                    'mae0': np.abs(te[y] - te[pred]).mean(), 'mae1': np.abs(te[y] - te[pred] * te.f).mean()})
    T = pd.DataFrame(res)
    print(f'\n{label}: walk-forward, the depth multiplier fitted on earlier seasons')
    print(T.round(5).to_string(index=False))
    print(f'  mean: log loss {T.base.mean():.5f} -> {T.depth.mean():.5f} ({(T.depth < T.base).sum()} of {len(T)} seasons better); MAE {T.mae0.mean():.4f} -> {T.mae1.mean():.4f}')

if __name__ == '__main__':
    depth_test(d, 'rec', 'pred', P.nb_ll, 'Receptions (ladder log loss)')

def yards_depth(R):
    import yards as Y
    dd = Y.load_pbp(port=True); ctx = Y.game_ctx(dd); skill, lg = Y.skill_frame(dd)
    for key in ('rec', 'rush', 'rr'):
        lab, y, pop, fs = Y.MARKETS[key]
        q = skill[pop(skill) & (skill.games_prior >= 3)].dropna(subset=fs + [y]).copy(); q['line'] = np.floor(q[y + '_prior']) + 0.5
        _, _, t = Y.walk(q, fs, y, 'line', first=2019)
        t = t.merge(R, on=['pid', 'season', 'week'], how='left'); t['rk'] = t['rank'].fillna(9).clip(upper=4).astype(int)
        A = t.groupby(['position', 'rk']).apply(lambda g: pd.Series({'n': len(g), 'x': g[y].sum() / g.mu.sum()})).unstack('rk')
        print(f'\n{lab}: actual / projection by position x depth rank'); print(A.round(3).to_string())
        res = []
        for s in sorted(t.season.unique())[1:]:
            tr, te = t[t.season < s], t[t.season == s]
            g = tr.groupby(['position', 'rk']).agg(a=(y, 'sum'), p=('mu', 'sum')); k = 200 * tr[y].mean()
            f = ((g.a + k) / (g.p + k)).rename('f').reset_index()
            tr = tr.merge(f, on=['position', 'rk'], how='left').fillna({'f': 1.0}); te = te.merge(f, on=['position', 'rk'], how='left').fillna({'f': 1.0})
            L = te.line.to_numpy(); yy = te[y].to_numpy(float); o = (yy > L).astype(float)
            ll = lambda p: -np.mean(o * np.log(p) + (1 - o) * np.log(1 - p))
            r0 = tr[y].to_numpy(float) / np.maximum(tr.mu.to_numpy(), 1e-6); r1 = tr[y].to_numpy(float) / np.maximum((tr.mu * tr.f).to_numpy(), 1e-6)
            p0 = Y.p_over(L, te.mu.to_numpy(), r0, tr.mu.to_numpy()); p1 = Y.p_over(L, (te.mu * te.f).to_numpy(), r1, (tr.mu * tr.f).to_numpy())
            res.append({'season': s, 'll0': ll(p0), 'll1': ll(p1), 'mae0': np.abs(yy - te.mu).mean(), 'mae1': np.abs(yy - te.mu * te.f).mean()})
        T = pd.DataFrame(res)
        print(f'  walk-forward: log loss {T.ll0.mean():.5f} -> {T.ll1.mean():.5f} ({(T.ll1 < T.ll0).sum()} of {len(T)} better); MAE {T.mae0.mean():.3f} -> {T.mae1.mean():.3f} ({(T.mae1 < T.mae0).sum()} of {len(T)} better)')

if __name__ == '__main__':
    yards_depth(R)
