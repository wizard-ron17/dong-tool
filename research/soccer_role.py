"""The role model shared by the soccer count models (shots, on target, goals). Before the
lineups: whether he plays at all, P(start) + P(comes off the bench | doesn't start), and,
given he plays, whether he starts (v2, 10/19: a direct logistic on the rows where he
played, with his starts per appearance and his last game's minutes; walk-forward
2024-26 log loss 0.4174 vs 0.4317 for the split the first two implied). Prices are "if
he plays" (books void a player who doesn't), so the split is what moves them. With the
lineups out, XI starts and a named sub comes on at the league's rate for named subs.
Ported in scripts/soccer-shots.js roleProbs. Rows: research/soccer_goals_rows.mjs."""
import numpy as np
from soccer_fit import logistic_glm

def role_X(t):
    lm = np.log(np.maximum(t.min5.values, 1) / 90)
    sh90 = (t['sh'].values + 3 * 1.0) / (t['min'].values / 90 + 3)          # a quality proxy: better players start
    X = np.column_stack([t.st5.values / 5, t.lastSt.values, t.subs5.values / 5, lm, t.st10.values / 10, np.log(sh90)])
    return np.column_stack([X, X[:, 0] * X[:, 4], X[:, 0] * X[:, 5], X[:, 4] * X[:, 5]])   # recent starts x start share x quality
def split_X(t):
    """The start-given-he-plays inputs: the role inputs, his starts per appearance (last ten), his last game's minutes."""
    share = t.st10.values / np.maximum(np.minimum(t.apps.values, 10), 1)
    return np.column_stack([role_X(t), share, t.lastMin.values / 90])
def fit_role(t):
    b0s, bs = logistic_glm(role_X(t), t.started.values.astype(float))
    ns = t[t.started == 0]
    b0b, bb = logistic_glm(role_X(ns), ns.played.values.astype(float))
    pl = t[t.played == 1]
    b0q, bq = logistic_glm(split_X(pl), pl.started.values.astype(float))
    nb = t[(t.started == 0) & (t.squad == 1)]          # named a sub: does he come on (the lineup-known case)
    return {'start': [float(b0s), *map(float, bs)], 'sub': [float(b0b), *map(float, bb)], 'split': [float(b0q), *map(float, bq)],
            'benchOn': float(nb.played.mean())}
def role_p(t, R):
    """P(start), P(comes on): his chance of playing at all times, given he plays, the split."""
    X = role_X(t); sg = lambda c, A: 1 / (1 + np.exp(-(c[0] + A @ np.array(c[1:]))))
    ps = sg(R['start'], X); pb = (1 - ps) * sg(R['sub'], X)
    if 'split' not in R: return ps, pb
    play, q = ps + pb, sg(R['split'], split_X(t))
    return play * q, play * (1 - q)

