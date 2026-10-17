"""Receptions: does a player's own track record against the model sharpen it? (research, 2026-10-17)

    python3 research/receptions_persist.py

Two weeks of market prices (SmartStake week 6, Kalshi week 3) put listed stars ~20% above our projection,
and they caught it (week 6: market 7.00, actual 7.18, ours 5.85 in the top group). Over 2016-2025 the top of
the board is calibrated ON AVERAGE (got / projected 0.97-1.09 per season), so the miss is not the level: the
recalibration pulls every high projection down by the same amount, right for a hot stretch and wrong for a
player who has out-caught his projection for years. The market prices that persistence (memory:
nfl-market-case-study, "our LEVEL lags on player-persistent outliers").

Test: each row's walk-forward projection (model fitted on earlier seasons, shipped recalibration shape fitted
on earlier seasons' out-of-sample pairs) times the player's shrunk track record,
    m = (sum of his past catches + K) / (sum of his past projections + K)        (only rows before this one)
raised to a power b fitted on earlier seasons. Scored on 2021-2025 by ladder log loss and top-of-board calibration.
"""
import os, sys
import numpy as np, pandas as pd
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
import receptions as R

d = R.D.copy(); d = d[d.games_prior >= 3].dropna(subset=R.BASE).copy()
d = d.sort_values(['season', 'week']).reset_index(drop=True)
LINES = [1.5, 2.5, 3.5, 4.5, 5.5, 6.5, 7.5]

def fit_map(om, oa, nb=40):
    o = np.argsort(om); om, oa = om[o], oa[o]
    e = np.linspace(0, len(om), nb + 1).astype(int)
    bx = np.array([om[a:b].mean() for a, b in zip(e[:-1], e[1:])]); by = np.maximum.accumulate([oa[a:b].mean() for a, b in zip(e[:-1], e[1:])])
    return bx, by

def apply_map(bx, by, x):
    out = np.interp(x, bx, by); hi = x > bx[-1]
    out[hi] = by[-1] + (by[-1] - by[-3]) / (bx[-1] - bx[-3]) * (x[hi] - bx[-1])   # mu_cal_extend, as the build
    return out

# walk-forward raw projections for every season from 2017 on
raw = np.full(len(d), np.nan)
for s in sorted(d.season.unique())[1:]:
    tr, te = d[d.season < s], d[d.season == s]
    ref = {f: (tr[f].to_numpy(float).mean(), tr[f].to_numpy(float).std() + 1e-9) for f in R.BASE}
    b = R.poisson_irls(R.design(tr, R.BASE, ref), tr.rec.to_numpy(float))
    raw[te.index] = np.exp(np.clip(R.design(te, R.BASE, ref) @ b, -8, 4))
d['raw'] = raw
# recalibration map for season s fitted on the out-of-sample pairs of seasons before s
mu = np.full(len(d), np.nan)
for s in sorted(d.season.unique())[2:]:
    pr = d[(d.season < s) & d.raw.notna()]
    bx, by = fit_map(pr.raw.to_numpy(), pr.rec.to_numpy(float))
    te = d[d.season == s]; mu[te.index] = apply_map(bx, by, te.raw.to_numpy())
d['mu'] = mu
d = d[d.mu.notna()].reset_index(drop=True)
d = d.sort_values(['pid', 'season', 'week']).reset_index(drop=True)
g = d.groupby('pid', sort=False)
d['cum_rec'] = g.rec.cumsum() - d.rec; d['cum_mu'] = g.mu.cumsum() - d.mu
d['n_prior'] = g.cumcount()

def nb_ll(mu, y):
    a = np.maximum(1.58767 * mu ** 0.91554 - mu, 0.005 * mu ** 2) / mu ** 2      # the shipped varPow spread
    tot = 0
    for L in LINES:
        p = np.clip(R.nb_sf(L, mu, a), 1e-6, 1 - 1e-6); h = (y > L)
        tot += -(h * np.log(p) + (1 - h) * np.log(1 - p)).mean()
    return tot / len(LINES)

res = []
test = sorted(d.season.unique())[1:]
for K in (10, 20, 40, 80):
    m = (d.cum_rec + K) / (d.cum_mu + K)
    for s in test:
        tr, te = d[d.season < s], d[d.season == s]
        # b fitted on earlier seasons: grid on log loss
        bs = np.linspace(0, 1.2, 13)
        lt = [nb_ll(tr.mu.to_numpy() * m[tr.index].to_numpy() ** b_, tr.rec.to_numpy(float)) for b_ in bs]
        b_ = bs[int(np.argmin(lt))]
        y = te.rec.to_numpy(float); mu0 = te.mu.to_numpy(); mu1 = mu0 * m[te.index].to_numpy() ** b_
        top = mu0 > 5
        res.append({'K': K, 'season': s, 'b': b_, 'll_base': nb_ll(mu0, y), 'll_persist': nb_ll(mu1, y),
                    'top_got_over_base': y[top].sum() / mu0[top].sum(), 'top_got_over_persist': y[top].sum() / mu1[top].sum(),
                    'mae_base': np.abs(y - mu0).mean(), 'mae_persist': np.abs(y - mu1).mean()})
T = pd.DataFrame(res)
print(T.round(4).to_string(index=False))
print('\nmean over test seasons:'); print(T.groupby('K')[['b', 'll_base', 'll_persist', 'mae_base', 'mae_persist']].mean().round(5))

# ── v2: the track record goes in BEFORE the recalibration, and the map is refitted on (mu x m^b, actual) ──
print('\nv2: track record, then a map refitted on earlier seasons')
res2 = []
K = 10
m = ((d.cum_rec + K) / (d.cum_mu + K)).to_numpy()
seasons = sorted(d.season.unique())
for b_ in (0.4, 0.6, 0.8, 1.0):
    x = d.mu.to_numpy() * m ** b_
    for s in seasons[1:]:
        tr = (d.season < s).to_numpy(); te = (d.season == s).to_numpy()
        bx, by = fit_map(x[tr], d.rec.to_numpy(float)[tr])
        mu1 = apply_map(bx, by, x[te]); mu0 = d.mu.to_numpy()[te]; y = d.rec.to_numpy(float)[te]
        top0, top1 = mu0 > 5, mu1 > 5
        stars = (d.rec_l3.to_numpy()[te] >= 7) & (d.rec_prior.to_numpy()[te] >= 5)
        res2.append({'b': b_, 'season': s, 'll_base': nb_ll(mu0, y), 'll_v2': nb_ll(mu1, y),
                     'top_base': y[top0].sum() / mu0[top0].sum(), 'top_v2': y[top1].sum() / mu1[top1].sum(),
                     'stars_base': y[stars].sum() / mu0[stars].sum(), 'stars_v2': y[stars].sum() / mu1[stars].sum(), 'level_v2': y.sum() / mu1.sum()})
T2 = pd.DataFrame(res2)
print(T2.groupby('b')[['ll_base', 'll_v2', 'top_base', 'top_v2', 'stars_base', 'stars_v2', 'level_v2']].mean().round(4).to_string())
print(T2[T2.b == 0.8].round(4).to_string(index=False))

# ── v3: the track record over the window the BUILD can see (last season + this season to date) ──
print('\nv3: two-season window (what scripts/picks.js loads), map refitted')
d['ord'] = np.arange(len(d))
# within-window sums: cumulative over (pid) minus everything before season-1
cs = d.groupby(['pid', 'season']).agg(sr=('rec', 'sum'), sm=('mu', 'sum')).reset_index()
cs['prev_sr'] = cs.groupby('pid').sr.shift(1).where(cs.groupby('pid').season.shift(1) == cs.season - 1, 0).fillna(0)
cs['prev_sm'] = cs.groupby('pid').sm.shift(1).where(cs.groupby('pid').season.shift(1) == cs.season - 1, 0).fillna(0)
d = d.merge(cs[['pid', 'season', 'prev_sr', 'prev_sm']], on=['pid', 'season'], how='left').sort_values('ord').reset_index(drop=True)
gs = d.groupby(['pid', 'season'], sort=False)
d['w_rec'] = d.prev_sr + gs.rec.cumsum() - d.rec; d['w_mu'] = d.prev_sm + gs.mu.cumsum() - d.mu
res3 = []
for K in (5, 10, 20):
    m = ((d.w_rec + K) / (d.w_mu + K)).to_numpy()
    for b_ in (0.6, 0.8, 1.0):
        x = d.mu.to_numpy() * m ** b_
        for s in seasons[1:]:
            tr = (d.season < s).to_numpy(); te = (d.season == s).to_numpy()
            bx, by = fit_map(x[tr], d.rec.to_numpy(float)[tr])
            mu1 = apply_map(bx, by, x[te]); mu0 = d.mu.to_numpy()[te]; y = d.rec.to_numpy(float)[te]
            top1 = mu1 > 5
            res3.append({'K': K, 'b': b_, 'season': s, 'll_base': nb_ll(mu0, y), 'll_v3': nb_ll(mu1, y), 'top_v3': y[top1].sum() / mu1[top1].sum(), 'level_v3': y.sum() / mu1.sum()})
T3 = pd.DataFrame(res3)
S3 = T3.groupby(['K', 'b'])[['ll_base', 'll_v3', 'top_v3', 'level_v3']].mean()
S3['seasons_better'] = T3.assign(w=T3.ll_v3 < T3.ll_base).groupby(['K', 'b']).w.sum()
print(S3.round(5).to_string())

# ── v4, shipped: the track record as the BUILD computes it (research/receptions_track.mjs runs scripts/receptions.js
# trackRecord for every player-week 2018-2025 with only the two seasons of play-by-play the build loads, so last
# season's games are scored off one season of history). Recomputed here in Python it read differently (corr 0.90):
# the window, not the model. So the test and the export both use the build's numbers. ──
PERSIST_K, PERSIST_B = 5.0, 0.5          # K is baked into rec_track.csv (research/receptions_model.json persist.k)
TRACK = os.path.join(HERE, '.cache', 'rec_track.csv')
if os.path.exists(TRACK):
    tk = pd.read_csv(TRACK)
    d = d.drop(columns=[c for c in ('m',) if c in d]).merge(tk, on=['pid', 'season', 'week'], how='left')
    d['m'] = d.m.fillna(1.0)
    print(f'\nv4: the build\'s track record ({tk.m.notna().sum():,} player-weeks), map refitted on earlier seasons')
    res4 = []
    for b_ in (0.3, 0.4, 0.5, 0.6, 0.8):
        x = d.mu.to_numpy() * d.m.to_numpy() ** b_
        for s_ in seasons[1:]:
            tr = (d.season < s_).to_numpy(); te = (d.season == s_).to_numpy()
            bx, by = fit_map(x[tr], d.rec.to_numpy(float)[tr])
            mu1 = apply_map(bx, by, x[te]); mu0 = d.mu.to_numpy()[te]; y = d.rec.to_numpy(float)[te]
            stars = (d.rec_l3.to_numpy()[te] >= 7) & (d.rec_prior.to_numpy()[te] >= 5)
            res4.append({'b': b_, 'season': s_, 'll_base': nb_ll(mu0, y), 'll_v4': nb_ll(mu1, y), 'top_v4': y[mu1 > 5].sum() / mu1[mu1 > 5].sum(),
                         'stars_base': y[stars].sum() / mu0[stars].sum(), 'stars_v4': y[stars].sum() / mu1[stars].sum()})
    T4 = pd.DataFrame(res4)
    S4 = T4.groupby('b')[['ll_base', 'll_v4', 'top_v4', 'stars_base', 'stars_v4']].mean()
    S4['seasons_better'] = T4.assign(w=T4.ll_v4 < T4.ll_base).groupby('b').w.sum()
    print(S4.round(5).to_string())

if '--export' in sys.argv:
    import json
    path = os.path.join(HERE, 'receptions_model.json'); M = json.load(open(path))
    ref = {f: (M['scale'][f]['mean'], M['scale'][f]['sd']) for f in R.BASE}
    names = ['intercept'] + R.BASE + ['pos_' + p for p in R.POS[1:]]
    coef = np.array([M['coef'][n] for n in names])
    raw_s = np.exp(np.clip(R.design(d, R.BASE, ref) @ coef, -8, 4))
    base = apply_map(np.array(M['mu_cal']['x']), np.array(M['mu_cal']['y']), raw_s)   # the build's baseMu
    x = base * d.m.to_numpy() ** PERSIST_B
    bx, by = fit_map(x, d.rec.to_numpy(float))
    M['persist'] = {'k': PERSIST_K, 'b': PERSIST_B,
                    'note': ('His catches over his base projections (the shipped model before this step, as the build scores them) across '
                             'last season and this season to date: m = (sum rec + k) / (sum base + k); base x m^b, then this map. '
                             'research/receptions_persist.py (v4, on the build\'s own track record): walk-forward ladder log loss '
                             '0.29687 -> 0.29508, 6 of 7 seasons; stars (last-3 7+, prior 5+) got/projected 1.020 -> 1.002.'),
                    'cal': {'x': [round(float(v), 4) for v in bx], 'y': [round(float(v), 4) for v in by]}}
    json.dump(M, open(path, 'w'), indent=1)
    out = apply_map(bx, by, x)
    print(f'wrote persist into {path}: {len(bx)} knots; got/projected by season: '
          + ', '.join(f"{s_}: {d.rec[d.season == s_].sum() / out[(d.season == s_).to_numpy()].sum():.3f}" for s_ in sorted(d.season.unique())))
