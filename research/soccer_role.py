"""The role model shared by the soccer count models (shots, on target, goals): before
the lineups, P(start) and P(comes off the bench | doesn't start); with them, a named
sub comes on at the league's rate for named subs. Ported in scripts/soccer-shots.js
roleProbs. Rows: research/soccer_goals_rows.mjs."""
import numpy as np
from soccer_fit import logistic_glm

def role_X(t):
    lm = np.log(np.maximum(t.min5.values, 1) / 90)
    sh90 = (t['sh'].values + 3 * 1.0) / (t['min'].values / 90 + 3)          # a quality proxy: better players start
    X = np.column_stack([t.st5.values / 5, t.lastSt.values, t.subs5.values / 5, lm, t.st10.values / 10, np.log(sh90)])
    return np.column_stack([X, X[:, 0] * X[:, 4], X[:, 0] * X[:, 5], X[:, 4] * X[:, 5]])   # recent starts x start share x quality
def fit_role(t):
    b0s, bs = logistic_glm(role_X(t), t.started.values.astype(float))
    ns = t[t.started == 0]
    b0b, bb = logistic_glm(role_X(ns), ns.played.values.astype(float))
    nb = t[(t.started == 0) & (t.squad == 1)]          # named a sub: does he come on (the lineup-known case)
    return {'start': [float(b0s), *map(float, bs)], 'sub': [float(b0b), *map(float, bb)], 'benchOn': float(nb.played.mean())}
def role_p(t, R):
    X = role_X(t); sg = lambda c: 1 / (1 + np.exp(-(c[0] + X @ np.array(c[1:]))))
    ps = sg(R['start']); pb = (1 - ps) * sg(R['sub'])
    return ps, pb

