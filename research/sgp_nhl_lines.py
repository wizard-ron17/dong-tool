"""NHL teammate correlations split by line relation, as copula rho (research, 2026-10-16).

    node research/nhl_combo_fetch.mjs        # 2025-26 lines from the shift charts (cached)
    python3 research/sgp_nhl_lines.py        # prints the table, writes research/sgp_nhl_lines.json

research/sgp_nhl.py fits one rho per teammate market pair (goal + assist 0.142, point + point 0.142...)
over every pair of teammates, each leg's own walk-forward model probability as its margin. That pools
linemates with players who never share a shift. research/nhl_combo_sgp.py showed the lift is mostly
the linemates (goal + teammate's point: 1.36x for linemates, 1.09x apart, on raw rates). This refits
the same rhos by relation, with the model margins, on 2025-26 (the season the shift charts cover),
using the lines from each team's PREVIOUS game: what is known before puck drop.

  line   same 5v5 forward line or defence pair (and not the same PP unit)
  pp     same power-play unit only
  both   linemates and the same power-play unit
  apart  neither
"""
import json, os, sys
from collections import defaultdict
import numpy as np, pandas as pd
sys.path.insert(0, os.path.dirname(__file__))
from sgp_core import fit_rho
import sgp_nhl as SN

HERE = os.path.dirname(os.path.abspath(__file__))
RNG = np.random.default_rng(11)
MAX_PAIRS = 200_000

combos = json.load(open(os.path.join(HERE, '.cache/nhl_combos_2025.json')))
# each team's lines as known BEFORE each game: its previous game's
pre = {}                     # (date, team) -> (line map, pp map)
last = {}
for gid, g in sorted(((k, v) for k, v in combos.items() if v), key=lambda kv: kv[1]['date'] + kv[0]):
    for team, t in g['teams'].items():
        if team in last: pre[(g['date'], team)] = last[team]
        line, pp = {}, {}
        for i, grp in enumerate(t['F']): line.update({p: 'F%d' % i for p in grp})
        for i, grp in enumerate(t['D']): line.update({p: 'D%d' % i for p in grp})
        for i, grp in enumerate(t['pp']): pp.update({p: i for p in grp})
        last[team] = (line, pp)


def relation(row):
    k = pre.get((row.date, row.team_a))
    if not k: return None
    line, pp = k
    a, b = int(row.pid_a), int(row.pid_b)
    sl = a in line and line.get(a) == line.get(b); sp = a in pp and pp.get(a) == pp.get(b)
    return 'both' if sl and sp else 'line' if sl else 'pp' if sp else 'apart'


def main():
    S = SN.skaters()
    S = S[S.season == 20252026].copy()
    S['date'] = S.date.astype(str)
    cols = ['gkey', 'date', 'pid', 'team'] + [f'{p}_{k}' for p in ('p', 'y') for k in 'gap']
    X = S[cols]
    P = X.merge(X, on=['gkey', 'date'], suffixes=('_a', '_b'))
    P = P[(P.team_a == P.team_b) & (P.pid_a < P.pid_b)].reset_index(drop=True)
    P['rel'] = [relation(r) for r in P[['date', 'team_a', 'pid_a', 'pid_b']].itertuples(index=False)]
    P = P.dropna(subset=['rel'])
    print(f'teammate pairs with pre-game lines: {len(P):,}', P.rel.value_counts().to_dict())
    A = lambda d, s: d[[c for c in d.columns if c.endswith(s)]].rename(columns=lambda c: c[:-2])
    out = defaultdict(dict)
    # the parlay engine's teammate keys (parlay.js SGP_NHL): gA, aA, pP, gP, aP, gG
    for key, ka, kb in (('gG', 'g', 'g'), ('gA', 'g', 'a'), ('aA', 'a', 'a'), ('pP', 'p', 'p'), ('gP', 'g', 'p'), ('aP', 'a', 'p')):
        for rel in ('both', 'line', 'pp', 'apart'):
            d = P[P.rel == rel]
            if len(d) > MAX_PAIRS: d = d.iloc[RNG.choice(len(d), MAX_PAIRS, replace=False)]
            a, b = A(d, '_a'), A(d, '_b')
            if ka != kb:   # ordered markets: both directions count (A's goal + B's assist, and B's goal + A's assist)
                a, b = pd.concat([a, b], ignore_index=True), pd.concat([b, a], ignore_index=True)
                grp = pd.concat([d.gkey, d.gkey], ignore_index=True)
            else: grp = d.gkey
            res = fit_rho(a['p_' + ka], b['p_' + kb], a['y_' + ka], b['y_' + kb], groups=grp)
            out[key][rel] = {k: res[k] for k in ('rho', 'lo', 'hi', 'n', 'lift_at_avg')}
            ci = f"[{res['lo']:+.3f}, {res['hi']:+.3f}]" if res['lo'] is not None else ''
            print(f'{key:3s} {rel:6s} rho {res["rho"]:+.3f} {ci:18s} n {res["n"]:7d}  lift {res["lift_at_avg"]:.3f}', flush=True)
        print()
    json.dump({'season': '2025-26', 'lines': 'previous game (pre-game)', 'rho': out}, open(os.path.join(HERE, 'sgp_nhl_lines.json'), 'w'), indent=1)
    print('wrote research/sgp_nhl_lines.json')


if __name__ == '__main__':
    main()
