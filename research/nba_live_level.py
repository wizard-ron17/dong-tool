"""Live NBA stat-board level (11/13): the boards' final pre-game rows per day (git history of nba/data.json) joined to
box scores (nba/players.json last10), then a walk-forward rolling level re-priced on every rung. Step 1 writes rows.pkl.
    python3 research/nba_live_level.py      (run from research/; writes .cache/live_rows.pkl)
Result 11/03-11/12: points -0.87%, PRA -1.40%, reb -0.19%, ast -0.16% (14 days, shrink one day) -> build-nba.js statLevel."""
# final pre-game board rows per ET day since 10/30 + actuals from players.json last10
import json, subprocess, pandas as pd, numpy as np
REPO = '/Users/ron/Desktop/dong-tool'
log = [l.split() for l in subprocess.check_output(['git','-C',REPO,'log','--since=2026-10-29','--format=%H %cI','--','nba/data.json']).decode().split('\n') if l]
last = {}
for h, t in log:                                   # newest first: first seen per board date = the day's last build
    d = json.loads(subprocess.check_output(['git','-C',REPO,'show',f'{h}:nba/data.json']))
    bd = d['stats'].get('date')
    if not bd or bd in last or bd < '2026-10-30' or bd > '2026-11-12': continue
    last[bd] = d
    if len(last) >= 14: break
rows = []
for bd, d in last.items():
    sp = d['stats']['spread']
    for st in ('pts', 'pra', 'reb', 'ast'):
        B = d['stats']['boards'][st]; R = B['rungs']
        for r in B['rows']:
            rows.append(dict(date=bd, st=st, pid=str(r['pid']), name=r['name'], team=r['team'], min=r['min'], sd=r.get('sd'), mu=r['mu'], lu=r.get('lu'), stt=r.get('st'), p=r['p'], rungs=R))
X = pd.DataFrame(rows)
P = json.load(open(f'{REPO}/nba/players.json'))['players']
act = {}
for pid, s in P.items():
    for g in s.get('last10', []): act[(pid, g['d'])] = g
def A(r):
    g = act.get((r.pid, r.date))
    if not g: return pd.Series([np.nan]*4)
    v = {'pts': g['pts'], 'reb': g['reb'], 'ast': g['ast'], 'pra': g['pts'] + g['reb'] + g['ast']}[r.st]
    return pd.Series([g['min'], v, g.get('st'), 1])
X[['amin', 'act', 'astart', 'has']] = X.apply(A, axis=1)
print(X.groupby('date').has.agg(['size', 'sum']).T.to_string())
X.to_pickle('.cache/live_rows.pkl'); print(len(X), X.has.sum())

X = pd.read_pickle('.cache/live_rows.pkl'); X = X[(X.has == 1) & (X.amin > 0)].copy()
lg = lambda p: np.log(np.clip(p, 1e-5, 1 - 1e-5) / (1 - np.clip(p, 1e-5, 1 - 1e-5)))
def reprice(p, rungs, f):
    # P(X >= k | mu f) ~ P(X >= k / f | mu): interpolate logit p in log k
    lk = np.log(rungs); z = lg(np.array(p)); q = np.interp(np.log(np.array(rungs) / f), lk, z, left=None, right=None)
    # extrapolate linearly past the ends
    s0 = (z[1] - z[0]) / (lk[1] - lk[0]); s1 = (z[-1] - z[-2]) / (lk[-1] - lk[-2]); x = np.log(np.array(rungs) / f)
    q = np.where(x < lk[0], z[0] + s0 * (x - lk[0]), np.where(x > lk[-1], z[-1] + s1 * (x - lk[-1]), q))
    return 1 / (1 + np.exp(-q))
def LL(p, y): p = np.clip(p, 1e-5, 1 - 1e-5); return -(y * np.log(p) + (1 - y) * np.log(1 - p))
days = sorted(X.date.unique())
for st in ('pts', 'pra', 'reb', 'ast'):
    S = X[X.st == st]
    out = {}
    for W in (7, 14):
        for K in (0.0, 0.5, 1.0, 2.0):            # shrink: K x one day's projected total
            tot0 = tot1 = n = 0; fs = []
            for d in days[4:]:
                prior = S[(S.date < d) & (S.date >= days[max(0, days.index(d) - W)])]
                day_mu = S[S.date == d].mu.sum()
                f = (prior.act.sum() + K * day_mu) / (prior.mu.sum() + K * day_mu) if len(prior) else 1
                f = min(max(f, 0.85), 1.15); fs.append(f)
                for r in S[S.date == d].itertuples():
                    y = (r.act >= np.array(r.rungs)).astype(float)
                    tot0 += LL(np.array(r.p), y).sum(); tot1 += LL(reprice(r.p, r.rungs, f), y).sum(); n += len(y)
            out[(W, K)] = (tot1 / n, tot0 / n, np.round(fs, 3))
    base = list(out.values())[0][1]
    print(f"{st}: as built {base:.5f}")
    for (W, K), (v, _, fs) in out.items():
        print(f"   window {W:2d}d shrink {K}: {v:.5f} ({(v / base - 1) * 100:+.2f}%)  factors {fs.min():.3f}..{fs.max():.3f}")
