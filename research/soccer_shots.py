"""MLS player shots and shots on target: walk-forward fit, report, and export.

    node research/soccer_fetch.mjs && node research/soccer_goals_rows.mjs
    python3 research/soccer_shots.py            # report + write soccer/shots-model.json

Same rows as the goals model (research/soccer_goals_rows.mjs, made by the
build's own scripts/soccer-goals.js), pre-lineup: a player who then didn't
play is a row with zero shots.

A shot count is a mixture over the player's role, because one distribution
can't be both "he sits: 0" and "he starts: 2.5": a single negative binomial
fitted the top shooters' MEAN but underpriced their 2+ by ~5pp (10% of them
don't play, and when they start they average 2.5, not 2.0).
  role:  P(start) and P(comes off the bench | doesn't start), logistic on his
         starts in the team's last five, whether he started its last game, his
         sub appearances in the last five, his expected minutes, his start
         share over his last ten appearances, his shooting (a quality proxy),
         and their pairwise products. Once the
         lineups post the build knows the first, and uses P(on | named sub).
  count: given the role, a negative binomial with
         log mu = b0 + b . [log the minutes that role gets him (his last ten
         starts or sub appearances) and its square, his shots (and for on
         target, on target) per 90 shrunk to his position's, that x started,
         the opponent's shots allowed a game (last 20, vs the league), home,
         started]
         and dispersion alpha = exp(c0 + c1 log mu) per role.
Every line (o0.5 .. o4.5 shots, o0.5 .. o2.5 on target) is read off the mixture.
The line's goals for his team and the team's own shot volume were tried as
terms and each made the fit worse walk-forward; recent form (last five
appearances) added nothing. Walk-forward by season, 2022 burn-in.
Known misses (2024-26): pre-lineup, the top decile at o1.5 shots prices ~.536
and hits ~.569 (stars start a little more, and shoot a little more when they
do, than the model says); with lineups known it's calibrated to the point.
On target runs ~5% under in 2025-26 as the league's on-target rate rose.
"""
import json, math, os, sys, warnings
warnings.filterwarnings('ignore')
import numpy as np, pandas as pd
from scipy.special import gammaln
from soccer_fit import poisson_glm, logistic_glm, log_loss, roc_auc_score

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
d = pd.read_csv(os.path.join(ROOT, 'research/.cache/soccer/goal_rows.csv'))
d = d[d.imp.notna() & d.tsh.notna() & d.osha.notna()].copy().reset_index(drop=True)
SEASONS = sorted(d.season.unique()); TEST = [s for s in SEASONS if s >= 2023]
MK = {'sh': {'y': 'shots', 'lines': [0.5, 1.5, 2.5, 3.5, 4.5]}, 'sot': {'y': 'sots', 'lines': [0.5, 1.5, 2.5]}}
ST_MIN, SUB_MIN = 80.0, 21.0      # a role's minutes when he has no history in it (the league's typical)

# ── role ──
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

# ── count given role ──
def priors(t):
    p = t[t.played == 1]; out = {}
    for pos, g in p.groupby('pos'):
        n90 = g.mins.sum() / 90; out[pos] = {'sh90': g.shots.sum() / n90, 'sot90': g.sots.sum() / n90}
    return out
def count_X(t, M, kind, started):
    pr = pd.DataFrame(M['priors']).T
    P = pr.reindex(t.pos.fillna('MID')).fillna(pr.loc['MID']).reset_index(drop=True)
    K = M['shrink']; n90 = (t['min'] / 90).values
    sh90 = (t['sh'].values + K * P.sh90.values) / (n90 + K)
    sot90 = (t['sot'].values + K * P.sot90.values) / (n90 + K)
    st = np.asarray(started, float)
    em = np.where(st == 1, t.stMin.fillna(ST_MIN).values, t.subMin.fillna(SUB_MIN).values)
    X = {'lrm': np.log(np.maximum(em, 1) / 90), 'lsh': np.log(sh90), 'lsot': np.log(sot90),
         'losha': np.log(t.osha.values / M['league']['tsh']), 'home': t.home.values.astype(float), 'st': st}
    X['lrm2'] = X['lrm'] ** 2; X['lsh_st'] = X['lsh'] * st          # a starter's shooting counts for more than a sub's
    return pd.DataFrame(X)
FEATS = {'sh': ['lrm', 'lrm2', 'lsh', 'lsh_st', 'losha', 'home', 'st'], 'sot': ['lrm', 'lrm2', 'lsot', 'lsh', 'lsh_st', 'losha', 'home', 'st']}
def mu_role(t, M, kind, started):
    X = count_X(t, M, kind, started); c = M['coef']
    return np.exp(c['b0'] + sum(c[f] * X[f].values for f in FEATS[kind]))

def nb_logpmf(y, mu, a):
    r = 1 / a
    return gammaln(y + r) - gammaln(r) - gammaln(y + 1) + r * np.log(r / (r + mu)) + y * np.log(mu / (r + mu))
def nb_pmf_upto(mu, a, K):
    """[P(X=0..K)] per row."""
    r = 1 / a; out = [(r / (r + mu)) ** r]
    for x in range(1, K + 1): out.append(out[-1] * (x - 1 + r) / x * (mu / (r + mu)))
    return np.array(out)
def disp(M, mu, role):
    c = M['disp'][role]; return np.exp(c[0] + c[1] * np.log(mu))

def fit(t, kind, shrink=3.0):
    M = {'priors': priors(t), 'shrink': shrink, 'league': {'tsh': float(t.drop_duplicates(['gid', 'team']).tsh.mean())}, 'role': fit_role(t)}
    p = t[t.played == 1]; y = p[MK[kind]['y']].values.astype(float)
    X = count_X(p, M, kind, p.started.values)
    b0, b = poisson_glm(X[FEATS[kind]].values, y)
    M['coef'] = {'b0': float(b0), **{f: float(v) for f, v in zip(FEATS[kind], b)}}
    M['disp'] = {}
    for role, sel in [('start', p.started.values == 1), ('sub', p.started.values == 0)]:
        mu = mu_role(p[sel], M, kind, np.full(sel.sum(), 1 if role == 'start' else 0)); yy = y[sel]
        best = min(((c0, c1) for c0 in np.arange(-3, 1.01, 0.1) for c1 in np.arange(-1.5, 0.51, 0.1)),
                   key=lambda c: -nb_logpmf(yy, mu, np.exp(c[0] + c[1] * np.log(mu))).sum())
        M['disp'][role] = [round(float(best[0]), 2), round(float(best[1]), 2)]
    return M

def pmf(t, M, kind, K=10, known=None):
    """The mixture's P(X=0..K) per row. known: None (pre-lineup), or arrays started / squad (lineups out)."""
    n = len(t); ms = mu_role(t, M, kind, np.ones(n)); mb = mu_role(t, M, kind, np.zeros(n))
    if known is None: ps, pb = role_p(t, M['role'])
    else:
        st, sq = known; ps = st.astype(float); pb = np.where((st == 0) & (sq == 1), M['role']['benchOn'], 0.0)
    P = ps * nb_pmf_upto(ms, disp(M, ms, 'start'), K) + pb * nb_pmf_upto(mb, disp(M, mb, 'sub'), K)
    P[0] += 1 - ps - pb
    return P, ps * ms + pb * mb

def walk(kind):
    out = []
    for s in TEST:
        tr, te = d[d.season < s], d[d.season == s].copy()
        M = fit(tr, kind)
        P, mu = pmf(te, M, kind); te['mu'] = mu
        for i in range(11): te[f'p{i}'] = P[i]
        Pk, muk = pmf(te, M, kind, known=(te.started.values, te.squad.values))
        for i in range(11): te[f'k{i}'] = Pk[i]
        out.append(te)
    return pd.concat(out)

def over(P, L, pre='p'): return 1 - sum(P[f'{pre}{i}'] for i in range(int(L) + 1))

models = {}
for kind in ['sh', 'sot']:
    y_ = MK[kind]['y']
    print(f"\n════ {'SHOTS' if kind == 'sh' else 'SHOTS ON TARGET'} ════")
    P = walk(kind); ev = P[P.season > TEST[0]]; y = np.minimum(ev[y_].values, 10)
    ll = -np.mean(np.log(np.clip(np.choose(y, [ev[f'p{i}'].values for i in range(11)]), 1e-12, 1)))
    print(f"walk-forward {TEST[1]}-{TEST[-1]}: {len(ev):,} player-games, mean {ev[y_].mean():.3f} vs projected {ev.mu.mean():.3f}, count log lik/row {ll:.4f}")
    print(f"{'line':>6} {'rate':>6} | {'pre-lineup LL':>13} {'AUC':>6} {'top 10%':>14} | {'lineups-out LL':>14} {'AUC':>6}")
    for L in MK[kind]['lines']:
        h = (ev[y_].values > L).astype(int); p = np.clip(over(ev, L).values, 1e-6, 1 - 1e-6); pk = np.clip(over(ev, L, 'k').values, 1e-6, 1 - 1e-6)
        top = p >= np.quantile(p, .9)
        print(f"  o{L:<4} {h.mean():6.3f} | {log_loss(h, p):13.5f} {roc_auc_score(h, p):6.3f} {p[top].mean():6.3f}→{h[top].mean():.3f} | {log_loss(h, pk):14.5f} {roc_auc_score(h, pk):6.3f}")
    L = 1.5 if kind == 'sh' else 0.5
    p = over(ev, L).values; h = ev[y_].values > L; q = pd.qcut(p, 10, labels=False, duplicates='drop')
    print(f'calibration o{L} (pre-lineup):', '  '.join(f"{p[q == i].mean():.2f}→{h[q == i].mean():.2f}" for i in range(int(q.max()) + 1)))
    pk = over(ev, L, 'k').values; q = pd.qcut(pk, 10, labels=False, duplicates='drop')
    print(f'calibration o{L} (lineups out):', '  '.join(f"{pk[q == i].mean():.2f}→{h[q == i].mean():.2f}" for i in range(int(q.max()) + 1)))
    for s, g in P.groupby('season'): print(f"  {s}: projected {g.mu.mean():.3f} vs {g[y_].mean():.3f}")
    M = fit(d, kind); M['lines'] = MK[kind]['lines']
    M['meta'] = {'walkForward': {'seasons': [int(s) for s in TEST[1:]], 'countLogLik': round(float(ll), 5),
                 'auc': {str(L): round(roc_auc_score((ev[y_].values > L).astype(int), over(ev, L).values), 4) for L in MK[kind]['lines']}}}
    models[kind] = M
    print('export', M['coef'], M['disp'], M['role'])

if '--no-write' not in sys.argv:
    models['meta'] = {'fitted': pd.Timestamp.now().strftime('%Y-%m-%d'), 'rows': int(len(d)), 'stMin': ST_MIN, 'subMin': SUB_MIN}
    json.dump(models, open(os.path.join(ROOT, 'soccer/shots-model.json'), 'w'), indent=1)
    print('\nwrote soccer/shots-model.json')
    # every row's pre-lineup ladder by the exported models, for the build-side parity check
    out = d[['gid', 'pid', 'team']].copy()
    for kind in ['sh', 'sot']:
        P, mu = pmf(d, models[kind], kind); out[f'mu_{kind}'] = mu
        for L in models[kind]['lines']: out[f'{kind}_{L}'] = 1 - P[:int(L) + 1].sum(axis=0)
    out.to_csv(os.path.join(ROOT, 'research/.cache/soccer/shot_preds.csv'), index=False)
