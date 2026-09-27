"""NHL pairs the first pass didn't cover (research/sgp_nhl.py machinery)."""
import json, numpy as np, pandas as pd
import sgp_nhl as N
from sgp_core import fit_rho
S = N.skaters(); G = N.goalies()
out = json.load(open('sgp_nhl.json'))
def rec(key, lab, a, b, ka, kb, grp):
    if len(a) > N.MAX_PAIRS:
        ix = N.RNG.choice(len(a), N.MAX_PAIRS, replace=False); a, b, grp = a.iloc[ix], b.iloc[ix], grp.iloc[ix]
    r = fit_rho(a['p_' + ka], b['p_' + kb], a['y_' + ka], b['y_' + kb], groups=grp); out[key] = {**r, 'label': lab}
    print(f"{lab:52s} ρ {r['rho']:+.3f} [{r['lo']:+.3f}, {r['hi']:+.3f}]  lift {r['lift_at_avg']:.3f}", flush=True)
X = S[['gkey', 'pid', 'team'] + [f'{p}_{k}' for p in ('p', 'y') for k in 'gapshb']]
P = X.merge(X, on='gkey', suffixes=('_a', '_b')); tm = P[(P.team_a == P.team_b) & (P.pid_a != P.pid_b)]
A = lambda d, s: d[[c for c in d.columns if c.endswith(s)]].rename(columns=lambda c: c[:-2])
rec('g_p_team', 'goal + point · teammates', A(tm, '_a'), A(tm, '_b'), 'g', 'p', tm.gkey)
rec('a_p_team', 'assist + point · teammates', A(tm, '_a'), A(tm, '_b'), 'a', 'p', tm.gkey)
GS = G[['gkey', 'team', 'p_sv', 'y_sv', 'p_ga', 'y_ga']].merge(S[['gkey', 'team', 'p_a', 'y_a', 'p_p', 'y_p']], on='gkey', suffixes=('_gk', ''))
vs = GS[GS.team_gk != GS.team]
rec('ga_a_opp', "goalie GA over 2.5 + an opposing skater's assist", vs, vs, 'ga', 'a', vs.gkey)
rec('sv_a_opp', "goalie saves over + an opposing skater's assist", vs, vs, 'sv', 'a', vs.gkey)
rec('sv_p_opp', "goalie saves over + an opposing skater's point", vs, vs, 'sv', 'p', vs.gkey)
json.dump(out, open('sgp_nhl.json', 'w'), indent=1); print('updated sgp_nhl.json')
