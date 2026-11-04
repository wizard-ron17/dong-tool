"""Who inherits vacated minutes (research, 11/04). nba_minutes.py's model gives every teammate the same small share of
the minutes his rotation teammates usually play who are out tonight (vacated x 0.057, same-position vac_pos ~0), and the
live NBA gap to the close lands on next-man-up nights (research notes: nba-gap-split): the bench under-projected ~2 min.

    python3 research/nba_vacated.py          # reads nba_minutes.parquet (nba_minutes.py writes it)

Candidate features, added to the shipped columns, least squares fit on earlier seasons, scored on the next (2021-22 on; rows from 2020-21, where the shipped mproj starts):
  bench      vacated x (1 - start10), vac_pos x (1 - start10): the minutes flow to the bench, not the starters
  next man   the same-position vacated minutes, split by where he stands among his position's healthy players by
             last-10 minutes (1st, 2nd, 3rd, rest): the next man up, by name
  depth      healthy rotation players left (10+ min last 10) and the minutes they usually play short of 240, times his share
Both the pre-lineup model and the lineup model (starting known). Scored: MAE / RMSE overall, on bench rows with 15+
vacated, and on rows the shipped model misses by 8+.
"""
import os
import numpy as np, pandas as pd
HERE = os.path.dirname(os.path.abspath(__file__))

import sys; sys.path.insert(0, HERE)
import nba_minutes as NM
# the full game rows, DNPs included (the saved parquet keeps played games only), with nba_minutes.py's own inputs
P = NM.features(NM.load())
P['m10_any'] = P.m10_any.fillna(0)
# who the team has tonight, as a pre-game reader would know it: everyone listed for the game EXCEPT the absences the
# build sees (a rotation player out who played lately = vacated; anyone not seen for 4+ team games = long-term out).
# A bench player who ends up not playing still counts (nobody knew he'd sit). 'played' is the hindsight version.
P['new_out'] = P.dnp & (P.m10_any >= 10) & ((P.tn - P.last_played_tn) <= 3)
P['long_out'] = P.dnp & ~((P.tn - P.last_played_tn) <= 3)
for lab, keep in (('pre', ~(P.new_out | P.long_out)), ('played', ~P.dnp)):
    A = P[keep]
    agg = A.groupby(['gid', 'team']).m10_any.agg(n_rot=lambda s: (s >= 10).sum(), m10_sum=lambda s: s.clip(lower=0).sum()).add_suffix('_' + lab).reset_index()
    P = P.merge(agg, on=['gid', 'team'], how='left')
P['frank'] = P[~(P.new_out | P.long_out)].groupby(['gid', 'team', 'fam']).m10_any.rank(ascending=False, method='first') - 1
D = P[(~P.dnp) & P.m5.notna() & (P.type == 2)].copy()                 # as nba_minutes.py main()
D['mprev'] = D.mprev.fillna(D.m10); D['mseason'] = D.mseason.fillna(D.m10)
D['abs_sp'] = D.spread.abs().fillna(D.spread.abs().median()); D['st'] = D.starter.astype(float)
D['early'] = np.exp(-D.n_prior.fillna(0) / 3); D['st_x_sp'] = D.st * D.abs_sp; D['vac_x_st'] = D.vacated * D.st
for c in ('m3', 'm5'): D[c] = D[c].fillna(D.m10)
D['bench'] = 1 - D.start10.fillna(0)
D['vac_bench'] = D.vacated * D.bench
D['vacpos_bench'] = D.vac_pos * D.bench
for k, lab in ((0, 'r1'), (1, 'r2'), (2, 'r3')): D[f'vacpos_{lab}'] = D.vac_pos * (D.frank == k)
D['vacpos_r4'] = D.vac_pos * (D.frank >= 3)
for lab in ('pre', 'played'):
    slack = (240 - D[f'm10_sum_{lab}']).clip(-60, 120)
    D[f'slack_share_{lab}'] = slack * D.m10_any / D[f'm10_sum_{lab}'].clip(lower=1)
    D[f'few_rot_{lab}'] = (9 - D[f'n_rot_{lab}']).clip(lower=0)

BASE_PRE = ['m3', 'm5', 'm10', 'mseason', 'mprev', 'start10', 'vacated', 'vac_pos', 'abs_sp', 'b2b', 'rest', 'early']
BASE_LU = BASE_PRE + ['st', 'st_x_sp', 'vac_x_st']
ADD = {
    'base': [],
    'bench': ['vac_bench', 'vacpos_bench'],
    'next man': ['vacpos_r1', 'vacpos_r2', 'vacpos_r3', 'vacpos_r4'],
    'next man + bench': ['vacpos_r1', 'vacpos_r2', 'vacpos_r3', 'vacpos_r4', 'vac_bench'],
    'depth (who played: hindsight)': ['slack_share_played', 'few_rot_played'],
    'depth (pre-game)': ['slack_share_pre', 'few_rot_pre'],
    'all (pre-game)': ['vac_bench', 'vacpos_r1', 'vacpos_r2', 'vacpos_r3', 'vacpos_r4', 'slack_share_pre', 'few_rot_pre'],
}


def fit(tr, cols):
    X = np.c_[np.ones(len(tr)), tr[cols].fillna(0).values]
    return np.linalg.lstsq(X, tr['min'].values, rcond=None)[0]


def pred(b, te, cols): return np.c_[np.ones(len(te)), te[cols].fillna(0).values] @ b


def main():
    seasons = sorted(D.season.unique()); tests = seasons[1:]          # every season with one before it to fit on
    for lab, base in (('PRE-LINEUP', BASE_PRE), ('LINEUP KNOWN', BASE_LU)):
        print(f'\n{lab} model, walk-forward {tests[0]}..{tests[-1]}:')
        out = {k: [] for k in ADD}
        for s in tests:
            tr, te = D[D.season < s], D[D.season == s]
            for k, add in ADD.items():
                cols = base + add; b = fit(tr, cols); e = pred(b, te, cols) - te['min'].values
                out[k].append(pd.DataFrame({'e': e, 'bench': te.bench.values, 'vac': te.vacated.values, 'gid': te.gid.values, 'season': s}))
        B = pd.concat(out['base']); big = (B.e.abs() >= 8).values
        sel = {'all rows': np.ones(len(B), bool), 'bench, 15+ vacated': ((B.bench >= 0.5) & (B.vac >= 15)).values, 'base misses 8+': big}
        print(f'  {"":30s} ' + '  '.join(f'{n:>24s}' for n in sel))
        for k in ADD:
            E = pd.concat(out[k]); cells = []
            for n, m in sel.items():
                e = E.e.values[m]; cells.append(f'MAE {np.abs(e).mean():5.3f} bias {e.mean():+5.2f}')
            print(f'  {k:30s} ' + '  '.join(f'{c:>24s}' for c in cells))
        # the per-season gain of the best set over base, so one season can't carry it
        for k in ('next man + bench', 'depth (pre-game)'):
            g = [np.abs(pd.concat(out['base'])[pd.concat(out['base']).season == s].e).mean() - np.abs(pd.concat(out[k])[pd.concat(out[k]).season == s].e).mean() for s in tests]
            print(f'  MAE gain of {k!r} by season: ' + ' '.join(f'{x:+.3f}' for x in g))
        b = fit(D, base + ADD['depth (pre-game)']); print('  depth coefficients (all seasons):', {c: round(float(v), 3) for c, v in zip(['const'] + base + ADD['depth (pre-game)'], b) if c in ADD['depth (pre-game)']})


if __name__ == '__main__':
    main()
