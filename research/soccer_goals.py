"""MLS anytime goalscorer: walk-forward fit, report, and export (v2: the role mixture).

    node research/soccer_fetch.mjs && node research/soccer_goals_rows.mjs
    python3 research/soccer_goals.py            # report + write soccer/goals-model.json

Rows are made by the build's own code (scripts/soccer-goals.js), one per player
in a side's rotation before every game, so a research row is what the build
would have priced. A player who then didn't play is a row with no goal.

v2 (10/19), as shots: a goal is a mixture over his role, because one
distribution can't be both "he sits" and "he starts":
  P(goal) = P(start) (1 - e^(-a mu_s^k)) + P(on) (1 - e^(-a mu_b^k))
  role:   research/soccer_role.py (shared with shots). With the lineups out,
          XI starts and a named sub comes on at the league's rate.
  mu:     non-penalty goals given the role, Poisson on that role's minutes (his
          last ten starts or sub appearances), his goals / shots / on target
          per 90 shrunk to his position's, the team's goals off the line, home,
          started; plus his penalty share x the team's rate x conversion x the
          role's share of 90.
  (a, k): a two-number stretch per mode, fitted on the training rows.
v1 (one Poisson on expected minutes, then the stretch) scored log loss 0.17185
walk-forward 2024-26; v2 ties it before the lineups and is far sharper after.
Walk-forward by season: 2022 is burn-in, each later season priced by a model
fitted on the seasons before it.
"""
import json, os, sys, warnings
warnings.filterwarnings('ignore')
import numpy as np, pandas as pd
from soccer_fit import poisson_glm, log_loss, roc_auc_score
from soccer_role import fit_role, role_p

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
d = pd.read_csv(os.path.join(ROOT, 'research/.cache/soccer/goal_rows.csv'))
d = d[d.imp.notna()].copy().reset_index(drop=True)
d['y'] = (d.goals > 0).astype(int)
SEASONS = sorted(d.season.unique()); TEST = [s for s in SEASONS if s >= 2023]
ST_MIN, SUB_MIN, CONV, PEN_K = 80.0, 21.0, 0.79, 3.0     # a role's minutes with no history in it; MLS penalty conversion 2022-26

def priors(t):
    p = t[t.played == 1]; out = {}
    for pos, g in p.groupby('pos'):
        n90 = g.mins.sum() / 90
        out[pos] = {'g90': max(g.npg.sum() / n90, 0.005), 'sh90': g.shots.sum() / n90, 'sot90': g.sots.sum() / n90}
    return out
def X_of(t, M, started):
    pr = pd.DataFrame(M['priors']).T
    P = pr.reindex(t.pos.fillna('MID')).fillna(pr.loc['MID']).reset_index(drop=True)
    K = M['shrink']; n90 = (t['min'] / 90).values; st = np.asarray(started, float)
    g90 = (t['np'].values + K['g'] * P.g90.values) / (n90 + K['g'])
    sh90 = (t['sh'].values + K['sh'] * P.sh90.values) / (n90 + K['sh'])
    sot90 = (t['sot'].values + K['sh'] * P.sot90.values) / (n90 + K['sh'])
    em = np.where(st == 1, t.stMin.fillna(ST_MIN).values, t.subMin.fillna(SUB_MIN).values)
    return pd.DataFrame({'lrm': np.log(np.maximum(em, 1) / 90), 'lg': np.log(g90), 'lsh': np.log(sh90), 'lsot': np.log(sot90),
                         'limp': np.log(t.imp.values / M['league']['imp']), 'home': t.home.values.astype(float), 'st': st}), em
FEATS = ['lrm', 'lg', 'lsh', 'lsot', 'limp', 'home', 'st']
def mu_role(t, M, started):
    X, em = X_of(t, M, started); c = M['coef']
    mu = np.exp(c['b0'] + sum(c[f] * X[f].values for f in FEATS))
    share = np.where(t.pkN > 0, t.pkShare * t.pkN / (t.pkN + M['pen']['k']), 0)
    return mu + share * M['pen']['rate'] * (t.imp.values / M['league']['imp']) * M['pen']['conv'] * np.minimum(1, em / 90)
def parts(t, M, known=None):
    """mu if he starts, mu off the bench, P(start), P(on)."""
    n = len(t); ms, mb = mu_role(t, M, np.ones(n)), mu_role(t, M, np.zeros(n))
    if known is None: ps, pb = role_p(t, M['role'])
    else: st, sq = known; ps = st.astype(float); pb = np.where((st == 0) & (sq == 1), M['role']['benchOn'], 0.0)
    return ms, mb, ps, pb
mix = lambda ms, mb, ps, pb, a, k: ps * (1 - np.exp(-a * ms ** k)) + pb * (1 - np.exp(-a * mb ** k))
def fit_cal(y, ms, mb, ps, pb):
    best = None
    for k in np.arange(0.95, 1.41, 0.02):
        ms_k, mb_k = ms ** k, mb ** k
        for a in np.arange(0.8, 1.45, 0.02):
            p = np.clip(ps * (1 - np.exp(-a * ms_k)) + pb * (1 - np.exp(-a * mb_k)), 1e-9, 1 - 1e-9)
            ll = -np.mean(y * np.log(p) + (1 - y) * np.log(1 - p))
            if best is None or ll < best[0]: best = (ll, a, k)
    return {'a': round(float(best[1]), 3), 'k': round(float(best[2]), 3)}
def fit(t, shrink):
    M = {'version': 2, 'priors': priors(t), 'shrink': shrink, 'league': {'imp': float(t.drop_duplicates(['gid', 'team']).imp.mean())},
         'role': fit_role(t), 'pen': {'k': PEN_K, 'conv': CONV}, 'roleMin': {'start': ST_MIN, 'sub': SUB_MIN}}
    M['pen']['rate'] = float(t.groupby(['gid', 'team']).pkg.sum().mean() / CONV)
    p = t[t.played == 1]; X, _ = X_of(p, M, p.started.values)
    b0, b = poisson_glm(X[FEATS].values, p.npg.values.astype(float))
    M['coef'] = {'b0': float(b0), **{f: float(x) for f, x in zip(FEATS, b)}}
    y = t.y.values
    M['cal'] = {'pre': fit_cal(y, *parts(t, M)), 'known': fit_cal(y, *parts(t, M, (t.started.values, t.squad.values)))}
    return M
def predict(t, M, known=None):
    c = M['cal']['known' if known is not None else 'pre']
    return mix(*parts(t, M, known), c['a'], c['k'])

def walk(shrink):
    out = []
    for s in TEST:
        tr, te = d[d.season < s], d[d.season == s].copy(); M = fit(tr, shrink)
        te['p'] = predict(te, M); te['pk'] = predict(te, M, (te.started.values, te.squad.values)); te['cal'] = str(M['cal']); out.append(te)
    return pd.concat(out)
def score(p, y): p = np.clip(np.asarray(p), 1e-6, 1 - 1e-6); return log_loss(y, p), roc_auc_score(y, p)

if __name__ == '__main__':
    best = None
    for kg in [15, 25, 40]:
        for ks in [1.5, 3]:
            P = walk({'g': kg, 'sh': ks}); ev = P[P.season > TEST[0]]; ll = score(ev.p, ev.y)[0]
            if best is None or ll < best[0]: best = (ll, {'g': kg, 'sh': ks}, P)
    _, SH, P = best; ev = P[P.season > TEST[0]]; y = ev.y.values
    print(f"shrink {SH}; walk-forward {TEST[1]}-{TEST[-1]}, {len(ev):,} player-games, {y.sum():,} scorers ({y.mean():.3f}); v1 shipped: log loss 0.17185, AUC 0.8295")
    base = ev.groupby('pos').y.transform('mean')
    for name, p in [('position base rate', base), ('pre-lineup', ev.p), ('lineups out', ev.pk)]:
        ll, auc = score(p, y); print(f"  {name:20s} log loss {ll:.5f}  AUC {auc:.4f}  mean {np.mean(p):.4f}")
    for name, col in [('pre-lineup', 'p'), ('lineups out', 'pk')]:
        p = ev[col].values; q = pd.qcut(p, 10, labels=False, duplicates='drop')
        print(f"calibration, {name}:", '  '.join(f"{p[q == i].mean():.3f}→{y[q == i].mean():.3f}" for i in range(int(q.max()) + 1)))
        for lo, hi in [(0.2, 0.3), (0.3, 0.4), (0.4, 1)]:
            m = (p >= lo) & (p < hi); print(f"   {lo:.0%}-{hi:.0%}: {m.sum():,} priced {p[m].mean():.3f}, scored {y[m].mean():.3f}")
    print('stretch by season:', P.groupby('season').cal.first().to_dict())
    for s, g in P.groupby('season'): print(f"  {s}: AUC {roc_auc_score(g.y, g.p):.4f}, mean {g.p.mean():.4f} vs {g.y.mean():.4f}")

    M = fit(d, SH)
    M['meta'] = {'fitted': pd.Timestamp.now().strftime('%Y-%m-%d'), 'rows': int(len(d)), 'seasons': [int(s) for s in SEASONS],
                 'walkForward': {'logLoss': round(score(ev.p, y)[0], 5), 'auc': round(score(ev.p, y)[1], 4),
                                 'logLossKnown': round(score(ev.pk, y)[0], 5), 'aucKnown': round(score(ev.pk, y)[1], 4), 'seasons': [int(s) for s in TEST[1:]]}}
    print('\nexport', {k: round(v, 3) for k, v in M['coef'].items()}, M['cal'], 'pen', M['pen'])
    if '--no-write' not in sys.argv:
        json.dump(M, open(os.path.join(ROOT, 'soccer/goals-model.json'), 'w'), indent=1)
        print('wrote soccer/goals-model.json')
        # every row priced by the exported model, pre-lineup and with the lineups known, for research/soccer_goals_parity.mjs
        d.assign(p=predict(d, M), pk=predict(d, M, (d.started.values, d.squad.values)))[['gid', 'pid', 'team', 'started', 'squad', 'p', 'pk']] \
         .to_csv(os.path.join(ROOT, 'research/.cache/soccer/goal_preds.csv'), index=False)
