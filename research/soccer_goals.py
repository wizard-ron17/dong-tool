"""MLS anytime goalscorer: walk-forward fit, report, and export.

    node research/soccer_fetch.mjs && node research/soccer_goals_rows.mjs
    python3 research/soccer_goals.py            # report + write soccer/goals-model.json

Rows are made by the build's own code (scripts/soccer-goals.js), one per player
in a side's rotation before every game, so a research row is what the build
would have priced. Pre-lineup: a player who then didn't play is a row with no
goal, as he is for a bettor at the time.

Model (see soccer-goals.js goalPrice): non-penalty goals ~ Poisson(exp(b . x)),
x = log expected minutes (and its square), starts in the last five, log shrunk
goals/90, shots/90, on target/90, log of his team's goals off the line
(relative to the league's), home; plus a penalty term (his share of the team's
recent attempts x team rate x conversion); then p = 1 - exp(-a mu^k). Isotonic
was tried and lost to the raw price walk-forward. Walk-forward by season:
2022 is burn-in (no history before it), each later season is predicted by a
model fitted on the seasons before it.
"""
import json, math, os, sys, warnings
warnings.filterwarnings('ignore')
import numpy as np, pandas as pd

from soccer_fit import poisson_glm, log_loss, roc_auc_score


ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
d = pd.read_csv(os.path.join(ROOT, 'research/.cache/soccer/goal_rows.csv'))
d = d[d.imp.notna()].copy()
d['y'] = (d.goals > 0).astype(int)
SEASONS = sorted(d.season.unique())
TEST = [s for s in SEASONS if s >= 2023]

def priors(t):
    """League per-90 rates by position family, off the training rows that played."""
    p = t[t.played == 1]
    out = {}
    for pos, g in p.groupby('pos'):
        n90 = g.mins.sum() / 90
        out[pos] = {'g90': max(g.npg.sum() / n90, 0.005), 'sh90': max(g.shots.sum() / n90, 0.05), 'sot90': max(g.sots.sum() / n90, 0.02)}
    return out

def design(t, M):
    pr = pd.DataFrame(M['priors']).T
    P = pr.reindex(t.pos.fillna('MID')).fillna(pr.loc['MID']).reset_index(drop=True)
    K = M['shrink']; n90 = (t['min'] / 90).values
    g90 = (t['np'].values + K['g'] * P.g90.values) / (n90 + K['g'])
    sh90 = (t.sh.values + K['sh'] * P.sh90.values) / (n90 + K['sh'])
    sot90 = (t.sot.values + K['sot'] * P.sot90.values) / (n90 + K['sot'])
    em = np.maximum(t.min5.values, 1)
    lmin = np.log(em / 90)
    X = pd.DataFrame({'lmin': lmin, 'lmin2': lmin ** 2, 'st': t.st5.values / 5, 'lg': np.log(g90), 'lsh': np.log(sh90), 'lsot': np.log(sot90),
                      'limp': np.log(t.imp.values / M['league']['imp']), 'home': t.home.values})
    return X, em

def pen_mu(t, M, em):
    k = M['pen']['k']; share = np.where(t.pkN > 0, t.pkShare * t.pkN / (t.pkN + k), 0)
    return share * M['pen']['rate'] * (t.imp.values / M['league']['imp']) * M['pen']['conv'] * np.minimum(1, em / 90)

FEATS = ['lmin', 'lmin2', 'st', 'lg', 'lsh', 'lsot', 'limp', 'home']
def fit(t, shrink, feats=FEATS, pen_k=3.0):
    team_games = t.groupby(['gid', 'team']).size().shape[0]
    pka = t.groupby(['gid', 'team']).pkg.sum()   # penalty GOALS per team-game (attempts aren't in the outcome columns)
    M = {'priors': priors(t), 'shrink': shrink, 'league': {'imp': float(t.drop_duplicates(['gid', 'team']).imp.mean())},
         'pen': {'k': pen_k, 'rate': None, 'conv': None}}
    # team penalty attempts per game and conversion, off the players' own rows
    att = t[t.played == 1]
    M['pen']['conv'] = 0.79                       # MLS 2022-26: 629 scored of 783 taken (soccer_fetch)
    M['pen']['rate'] = float(pka.sum() / team_games / M['pen']['conv'])
    X, em = design(t, M)
    b0, b = poisson_glm(X[feats].values, t.npg.values.astype(float))
    M['coef'] = {'b0': float(b0), **{f: 0.0 for f in FEATS}, **{f: float(x) for f, x in zip(feats, b)}}
    # calibration: p = 1 - exp(-a * mu^k), fitted on the training rows (a smooth 2-parameter stretch;
    # isotonic, walk-forward, was too noisy on a season or two and lost to the raw price)
    mu = mu_of(t, M); y = (t.goals > 0).values
    best = None
    for k in np.arange(0.9, 1.3, 0.01):
        for a in np.arange(0.8, 1.25, 0.01):
            p = np.clip(1 - np.exp(-a * mu ** k), 1e-9, 1 - 1e-9); ll = -np.mean(y * np.log(p) + (1 - y) * np.log(1 - p))
            if best is None or ll < best[0]: best = (ll, a, k)
    M['cal'] = {'a': round(float(best[1]), 3), 'k': round(float(best[2]), 3)}
    return M

def mu_of(t, M):
    X, em = design(t, M); c = M['coef']
    return np.exp(c['b0'] + sum(c[f] * X[f].values for f in FEATS)) + pen_mu(t, M, em)
def predict(t, M, cal=True):
    mu = mu_of(t, M); a, k = (M['cal']['a'], M['cal']['k']) if cal and 'cal' in M else (1, 1)
    return 1 - np.exp(-a * mu ** k)

def walk(shrink, feats=FEATS, pen_k=3.0, quiet=True):
    preds = []
    for s in TEST:
        tr, te = d[d.season < s], d[d.season == s].copy()
        M = fit(tr, shrink, feats, pen_k)
        te['raw'] = predict(te, M, cal=False); te['cal'] = predict(te, M); preds.append(te)
    return pd.concat(preds)

def score(p, y): return log_loss(y, np.clip(p, 1e-6, 1 - 1e-6)), roc_auc_score(y, p)

# ── shrinkage: picked by out-of-sample log loss ──
best = None
for kg in [8, 15, 25, 40, 60]:
    for ks in [1.5, 3, 5]:
        sh = {'g': kg, 'sh': ks, 'sot': ks}
        P = walk(sh); ll, auc = score(P.raw, P.y)
        if best is None or ll < best[0]: best = (ll, auc, sh)
print(f"shrink {best[2]}: walk-forward log loss {best[0]:.5f}, AUC {best[1]:.4f}")
SH = best[2]
P = walk(SH)

ev = P[P.season > TEST[0]]
base = ev.groupby('pos').y.transform('mean')
print(f"\nseasons {TEST[1]}-{TEST[-1]}, {len(ev):,} player-games, {ev.y.sum():,} scorers ({ev.y.mean():.3f})")
for name, p in [('position base rate', base), ('raw model', ev.raw), ('calibrated (shipped)', ev.cal)]:
    ll, auc = score(p, ev.y); print(f"  {name:20s} log loss {ll:.5f}  AUC {auc:.4f}  mean {p.mean():.4f}")
# what each term buys (drop one, walk-forward raw log loss)
print('\ndrop one term (raw, all test seasons):')
ll0 = score(P.raw, P.y)[0]
for f in FEATS:
    Q = walk(SH, [x for x in FEATS if x != f]); print(f"  -{f:5s} log loss {score(Q.raw, Q.y)[0]:.5f} ({score(Q.raw, Q.y)[0] - ll0:+.5f})")
Q = walk(SH, pen_k=1e9); print(f"  -pens  log loss {score(Q.raw, Q.y)[0]:.5f} ({score(Q.raw, Q.y)[0] - ll0:+.5f})")
col = 'cal'
print('\ncalibration (shipped price, deciles):')
ev = ev.assign(bin=pd.qcut(ev[col], 10, duplicates='drop'))
for b, g in ev.groupby('bin', observed=True): print(f"  {g[col].mean():.3f} -> {g.y.mean():.3f}  (n {len(g):,})")
for lo, hi in [(0.2, 0.3), (0.3, 0.4), (0.4, 1)]:
    t = ev[(ev[col] >= lo) & (ev[col] < hi)]
    print(f"  {lo:.0%}-{hi:.0%}: {len(t):,} rows, priced {t[col].mean():.3f}, scored {t.y.mean():.3f}")
for s, g in P.groupby('season'): print(f"  {s}: AUC {roc_auc_score(g.y, g[col]):.4f}, mean {g[col].mean():.4f} vs {g.y.mean():.4f}")
pl = ev[ev.played == 1]
print(f"  among players who played: AUC {roc_auc_score(pl.y, pl[col]):.4f}")

# ── export: fitted on every season ──
M = fit(d, SH)
M['meta'] = {'fitted': pd.Timestamp.now().strftime('%Y-%m-%d'), 'rows': int(len(d)), 'seasons': [int(s) for s in SEASONS],
             'walkForward': {'logLoss': round(score(ev[col], ev.y)[0], 5), 'auc': round(score(ev[col], ev.y)[1], 4), 'seasons': [int(s) for s in TEST[1:]]}}
print('\nexport coef', {k: round(v, 3) for k, v in M['coef'].items()}, 'pen', M['pen'])
if '--no-write' not in sys.argv:
    json.dump(M, open(os.path.join(ROOT, 'soccer/goals-model.json'), 'w'), indent=1)
    print('wrote soccer/goals-model.json')
    # every row priced by the exported model, for the build-side parity check (research/soccer_goals_parity.mjs)
    d.assign(p=predict(d, M))[['gid', 'pid', 'team', 'p']].to_csv(os.path.join(ROOT, 'research/.cache/soccer/goal_preds.csv'), index=False)
