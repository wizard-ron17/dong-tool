"""Anytime TD: a player's track record against his own prices (research, 2026-10-17).

    python3 research/td_track.py

Live 2026 (weeks 1-6, boards as built before kickoff): starters under-priced (RB1 39.0% vs 43.8% hit, TE1
21.6 vs 26.2, WR1 29.6 vs 32.5, QB1 13.2 vs 15.7), backups slightly over; the SmartStake week had the market
above us on the high-probability scorers, and right. memory nfl-exchange-first-look: "player-specific stars
(Gibbs 59 vs market 69.5) need the hit-rate prior, not calibration". Receptions and QB rushing both gained from
a track record (research/receptions_persist.py, research/qbrush_track.py), so the same test here:
    logit p' = logit p + b * ln m,   m = (his TD games + K) / (sum of his walk-forward prices + K)
over last season and this one to date (the window the build loads), b and K fitted on earlier seasons.
"""
import os, sys
import numpy as np, pandas as pd
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
import backtest as bt

df = pd.read_parquet(bt.DATA).sort_values(['season', 'week']).reset_index(drop=True)
F = bt.MODELS[bt.FINAL]
p = np.full(len(df), np.nan)
for s in sorted(df.season.unique())[1:]:
    tr, te = (df.season < s).to_numpy(), (df.season == s).to_numpy()
    X, mu, sd = bt.design(df[tr], F); w = bt.fit_logistic(X, df.scored.to_numpy(float)[tr])
    Xt, _, _ = bt.design(df[te], F, mu, sd); p[te] = bt.predict(Xt, w)
df['p'] = p; df = df[df.p.notna()].sort_values(['pid', 'season', 'week']).reset_index(drop=True)
cs = df.groupby(['pid', 'season']).agg(sy=('scored', 'sum'), sp=('p', 'sum')).reset_index()
prev = cs.groupby('pid').season.shift(1) == cs.season - 1
cs['psy'] = cs.groupby('pid').sy.shift(1).where(prev, 0).fillna(0); cs['psp'] = cs.groupby('pid').sp.shift(1).where(prev, 0).fillna(0)
df = df.merge(cs[['pid', 'season', 'psy', 'psp']], on=['pid', 'season'], how='left')
g = df.groupby(['pid', 'season'], sort=False)
df['wy'] = df.psy + g.scored.cumsum() - df.scored; df['wp'] = df.psp + g.p.cumsum() - df.p
lg = lambda q: np.log(q / (1 - q)); ex = lambda z: 1 / (1 + np.exp(-z))
ll = lambda q, y: -np.mean(y * np.log(q) + (1 - y) * np.log(1 - q))
res = []
seasons = sorted(df.season.unique())
for K in (2, 4, 8):
    lm = np.log((df.wy + K) / (df.wp + K)).to_numpy()
    for s in seasons[1:]:
        tr, te = (df.season < s).to_numpy(), (df.season == s).to_numpy(); y = df.scored.to_numpy(float); z = lg(df.p.to_numpy())
        bs = np.linspace(0, 1, 11); b = bs[int(np.argmin([ll(ex(z[tr] + bb * lm[tr]), y[tr]) for bb in bs]))]
        q1 = ex(z[te] + b * lm[te]); q0 = df.p.to_numpy()[te]
        st = te & (df.groupby(['season', 'week', 'team', 'position']).p.rank(ascending=False) == 1).to_numpy()   # each team's top-priced at his position
        res.append({'K': K, 'season': s, 'b': b, 'll0': ll(q0, y[te]), 'll1': ll(q1, y[te]),
                    'top_hit': y[st].mean(), 'top_p0': df.p.to_numpy()[st].mean(), 'top_p1': ex(z[st] + b * lm[st]).mean()})
R = pd.DataFrame(res)
T = R.groupby('K')[['b', 'll0', 'll1', 'top_hit', 'top_p0', 'top_p1']].mean(); T['better'] = R.assign(w=R.ll1 < R.ll0).groupby('K').w.sum()
print(T.round(5).to_string()); print(R[R.K == 4].round(4).to_string(index=False))

# ── rank in his team's position room (by our own price), as a logit shift per position x rank, walk-forward ──
print('\nroom rank: logit shift per position x rank (1-3, 4 = deeper), fitted on earlier seasons')
df['rk'] = df.groupby(['season', 'week', 'team', 'position']).p.rank(ascending=False, method='first').clip(upper=4).astype(int)
print(df.groupby(['position', 'rk']).apply(lambda h: pd.Series({'n': len(h), 'p': h.p.mean(), 'hit': h.scored.mean()})).unstack('rk').round(3).to_string())
res = []
for s in seasons[1:]:
    tr, te = df[df.season < s], df[df.season == s]
    shift = {}
    for (pos, rk), h in tr.groupby(['position', 'rk']):
        zz = lg(h.p.to_numpy()); yy = h.scored.to_numpy(float)
        cs_ = np.linspace(-0.5, 0.5, 41); shift[(pos, rk)] = cs_[int(np.argmin([ll(ex(zz + c), yy) for c in cs_]))]
    c = np.array([shift.get((a, b), 0.0) for a, b in zip(te.position, te.rk)])
    y = te.scored.to_numpy(float)
    res.append({'season': s, 'll0': ll(te.p.to_numpy(), y), 'll1': ll(ex(lg(te.p.to_numpy()) + c), y), 'rb1': shift.get(('RB', 1)), 'wr1': shift.get(('WR', 1)), 'te1': shift.get(('TE', 1)), 'rb3': shift.get(('RB', 3))})
R2 = pd.DataFrame(res); print(R2.round(4).to_string(index=False))
print(f'mean log loss {R2.ll0.mean():.5f} -> {R2.ll1.mean():.5f}, {(R2.ll1 < R2.ll0).sum()} of {len(R2)} seasons better')
