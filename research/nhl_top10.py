"""How often do our top 10 goal scorers each night score? (research, 2026-10-16, for Frank the Bank)

    python3 research/nhl_top10.py

Every night, the 10 shortest anytime-goal prices on the board, bet $1 each:
  * at our fair price (what a calibrated price returns: about break-even, by construction)
  * at a price 5% better than our fair (decimal odds x 1.05: what line shopping might find)

Backtest: the shipped goals model walk-forward (each season priced by a model fitted on the seasons before
it, isotonic calibration from the earlier out-of-sample seasons, as the build does), 2023-24 to 2025-26.
Live: this season's graded nights from nhl/data.json picksHistory (frozen at puck drop, scratches voided).
"""
import json, os, sys
import numpy as np, pandas as pd

HERE = os.path.dirname(os.path.abspath(__file__)); ROOT = os.path.dirname(HERE)
sys.path.insert(0, HERE)
import nhl_goals as G


def backtest():
    D = G.D; seasons = sorted(D.season.unique()); out, prev = [], []
    for s in seasons[1:]:
        tr, te = D[D.season < s], D[D.season == s]
        mu, *_ = G.fit_mu(tr, te, G.SHIPPED)
        p = 1 - np.exp(-mu); y = te.scored.to_numpy()
        pc = G.isotonic_apply(np.concatenate([a for a, _ in prev]), np.concatenate([b for _, b in prev]), p) if prev else p
        prev.append((p, y))
        out.append(pd.DataFrame({'season': s, 'date': te.date.astype(str).to_numpy(), 'p': pc, 'y': y}))
    return pd.concat(out)


def live():
    H = json.load(open(os.path.join(ROOT, 'nhl/data.json'))).get('picksHistory', {})
    rows = [{'season': 20262027, 'date': d, 'p': x[1], 'y': float(x[2])} for d, xs in H.items() for x in xs if x[2] in (0, 1)]
    return pd.DataFrame(rows)


def report(df, label, top=10):
    t = df.sort_values('p', ascending=False).groupby('date').head(top).copy()
    t['rank'] = t.groupby('date').p.rank(ascending=False, method='first').astype(int)
    nights = t.date.nunique()
    pnl_fair = (t.y / t.p - 1).sum()                       # $1 at decimal odds 1/p: win pays 1/p - 1, loss -1
    pnl_5 = (t.y * 1.05 / t.p - 1).sum()
    per = t.groupby('date').y.sum()
    print(f"\n{label}: {nights} nights, {len(t)} picks (top {top} by price each night)")
    print(f"  hit {t.y.mean() * 100:.1f}%  vs priced {t.p.mean() * 100:.1f}%   ({t.y.sum():.0f} goals scored, {t.p.sum():.0f} expected)")
    print(f"  per night: {per.mean():.2f} of {top} score on average; at least one scores {(per >= 1).mean() * 100:.0f}% of nights; "
          f"3+ score {(per >= 3).mean() * 100:.0f}% of nights")
    print(f"  $1 each at our fair price: {pnl_fair:+.1f} units ({pnl_fair / len(t) * 100:+.1f}% ROI)")
    print(f"  $1 each at a 5% better price: {pnl_5:+.1f} units ({pnl_5 / len(t) * 100:+.1f}% ROI)")
    by = t.groupby('rank').agg(n=('y', 'size'), hit=('y', 'mean'), priced=('p', 'mean')).reset_index()
    print('  by rank:  ' + '  '.join(f"#{r.rank} {r.hit * 100:.0f}%/{r.priced * 100:.0f}%" for r in by.itertuples()))
    if 'season' in t and t.season.nunique() > 1:
        for s, g in t.groupby('season'):
            print(f"    {str(s)[:4]}-{str(s)[6:]}: hit {g.y.mean() * 100:.1f}% vs priced {g.p.mean() * 100:.1f}%  ROI fair {(g.y / g.p - 1).mean() * 100:+.1f}%  at +5% {(g.y * 1.05 / g.p - 1).mean() * 100:+.1f}%")
    return {'nights': int(nights), 'picks': int(len(t)), 'hit': round(float(t.y.mean()), 4), 'priced': round(float(t.p.mean()), 4),
            'roi_fair': round(float(pnl_fair / len(t)), 4), 'roi_5': round(float(pnl_5 / len(t)), 4),
            'per_night': round(float(per.mean()), 2), 'any_night': round(float((per >= 1).mean()), 3)}


if __name__ == '__main__':
    out = {'backtest_top10': report(backtest(), 'BACKTEST 2023-24 to 2025-26 (walk-forward)')}
    L = live()
    if len(L): out['live_top10'] = report(L, 'THIS SEASON, live (frozen at puck drop)')
    out['backtest_top5'] = report(backtest(), 'BACKTEST, top 5', top=5)
    json.dump(out, open(os.path.join(HERE, 'nhl_top10.json'), 'w'), indent=1)
    print('\nwrote research/nhl_top10.json')
