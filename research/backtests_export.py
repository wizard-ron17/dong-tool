"""Backtest tables for the pages' Backtest drawers (research, 2026-10-16).

    python3 research/backtests_export.py          # writes nba/backtests.json and mlb/backtests.json

The NHL and NFL tools carry their backtests in the build's data.json. NBA and MLB did not, so
this turns the walk-forward predictions research already scored into the same two tables every
drawer shows, pre-formatted for backtest.js:

  every line      the chance we priced at each line vs how often it happened
  price meaning   every priced line pooled and bucketed by its price: does a price mean what it says?

Sources (every prediction is out of sample, from a model that never saw the game):
  NBA threes   nba_threes_form_oos.parquet   the shipped form + drought model, 5 seasons
  NBA stats    nba_stats_oos.parquet         points / rebounds / assists / PRA / steals / blocks / stocks
  NBA doubles  nba_stats_dd_oos.parquet      double-double and triple-double
  MLB pitchers mlb_kbb_replay.parquet        every 2026 start, the board's K / BB projection priced Poisson
  MLB batters  mlb_batter_kbb.py             2025-tuned, scored on 2026 (the build's ladders)
  MLB HR       mlb_hr_replay.py              fit on 2026 before Aug 1, scored Aug 1 onward, the shipped features
"""
import json, os, sys
import numpy as np, pandas as pd
from scipy.stats import poisson

HERE = os.path.dirname(os.path.abspath(__file__)); ROOT = os.path.dirname(HERE)
sys.path.insert(0, HERE)
BUCKETS = [(0, .10, 'under 10%'), (.10, .30, '10-30%'), (.30, .50, '30-50%'), (.50, .70, '50-70%'), (.70, 1.01, '70%+')]
pc = lambda v: f'{v * 100:.1f}%'
n_ = lambda v: f'{int(v):,}'


def tables(frame, unit, line_label):
    """frame: rung (the line), p (our chance), y (it happened). Returns the two sections."""
    L = frame.groupby('rung').agg(n=('y', 'size'), p=('p', 'mean'), y=('y', 'mean')).reset_index().sort_values('rung')
    secs = [{'h': 'Every line, every ' + unit, 'head': ['Line', 'Games', 'Priced', 'Hit'],
             'rows': [[line_label(r.rung), n_(r.n), pc(r.p), '<b>' + pc(r.y) + '</b>'] for r in L.itertuples()]}]
    rows = []
    for lo, hi, lab in BUCKETS:
        b = frame[(frame.p >= lo) & (frame.p < hi)]
        if len(b): rows.append([lab, n_(len(b)), pc(b.p.mean()), '<b>' + pc(b.y.mean()) + '</b>'])
    secs.append({'h': 'Does a price mean what it says? Every line pooled, by its price', 'head': ['Priced', 'Predictions', 'Priced', 'Hit'], 'rows': rows})
    return secs


def tool(frame, rows, seasons, unit, line_label, note, tail='every season predicted cold'):
    return {'title': f'Backtest — {rows:,} {unit}s, {tail}', 'sections': tables(frame, unit, line_label),
            'note': f'Seasons {seasons}. {note}'}


def nba():
    out = {}
    th = pd.read_parquet(os.path.join(HERE, 'nba_threes_form_oos.parquet'))
    fr = pd.concat([pd.DataFrame({'rung': k, 'p': th[f'n_{k}'], 'y': (th.tpm >= k).astype(float)}) for k in range(1, 6)])
    out['3pm'] = tool(fr, len(th), f'{th.season.min()} to {th.season.max()}', 'player-game', lambda k: f'o{k - 0.5:g}',
                      "Made threes: the board's own model (projected minutes x his threes per minute, plus recent form and drought), each season fitted only on the seasons before it.")
    st = pd.read_parquet(os.path.join(HERE, 'nba_stats_oos.parquet'))
    names = {'pts': 'points', 'reb': 'rebounds', 'ast': 'assists', 'pra': 'points + rebounds + assists', 'stl': 'steals', 'blk': 'blocks', 'stk': 'steals + blocks'}
    for k, nm in names.items():
        d = st[st.stat == k]; first = d[d.rung == d.rung.min()]
        out[k] = tool(d, len(first), f'{d.season.min()} to {d.season.max()}', 'player-game', lambda r: f'o{r - 0.5:g}',
                      f'The {nm} board: projected minutes times his rate, spread over his minutes, each season predicted by a model fitted on the seasons before it.')
    dd = pd.read_parquet(os.path.join(HERE, 'nba_stats_dd_oos.parquet'))
    for k, nm in (('dd', 'double-double'), ('td', 'triple-double')):
        d = dd[dd.stat == k]
        if len(d): out[k] = tool(d, len(d), f'{d.season.min()} to {d.season.max()}', 'player-game', lambda r, nm=nm: nm.title(), f'Chance of a {nm}, each season predicted cold.')
    return out


def mlb():
    out = {}
    k = pd.read_parquet(os.path.join(HERE, 'mlb_kbb_replay.parquet'))
    span = f'{k.date.min()[:7]} to {k.date.max()[:7]} 2026'
    for stat, proj, lines, nm in (('k', 'k_proj', range(2, 10), 'strikeouts'), ('bb', 'bb_proj', range(0, 4), 'walks')):
        fr = pd.concat([pd.DataFrame({'rung': L + 0.5, 'p': poisson.sf(L, k[proj]), 'y': (k[stat] > L).astype(float)}) for L in lines])
        out['pitcher_' + stat] = tool(fr, len(k), span, 'start', lambda r: f'o{r:g}',
                                      f"The board's projection ({nm}) priced as a count around it. One season, so no earlier seasons to fit on: the projection only uses games before each start.", tail='each one priced before it was played')
    import sgp_mlb_batter as SB
    bt = SB.batter_frame()
    for stat, rungs, nm in (('k', (1, 2, 3), 'strikeouts'), ('bb', (1,), 'walks')):
        cols = [(r, f'p{stat}{r}', f'y{stat}{r}') for r in rungs if f'p{stat}{r}' in bt]
        fr = pd.concat([pd.DataFrame({'rung': r - 0.5, 'p': bt[p], 'y': bt[y].astype(float)}) for r, p, y in cols])
        out['batter_' + stat] = tool(fr, len(bt), '2026', 'batter-game', lambda r: f'o{r:g}',
                                     f"Batter {nm}: his rate against the starter for the plate appearances he'll get off him, then the pen. Tuned on 2025, scored on every 2026 batter-game it never saw.", tail='each one priced before it was played')
    import mlb_hr_replay as R
    df, _, _, _ = R.v1_frame()
    d = df[df.season == 2026]; tr, te = d[d.date < '2026-08-01'], d[d.date >= '2026-08-01']
    w, _ = R.fit_logistic(R.design(tr, R.V1), tr.y.to_numpy())
    a = 0.0; z = R.design(tr, R.V1) @ w
    for _ in range(60):
        q = 1 / (1 + np.exp(-(a + R.PLATT_B * z))); a += (tr.y.mean() - q.mean()) / (q * (1 - q)).mean()
    p = 1 / (1 + np.exp(-(a + R.PLATT_B * (R.design(te, R.V1) @ w))))
    fr = pd.DataFrame({'rung': 0.5, 'p': p, 'y': te.y.to_numpy().astype(float)})
    hr_b = [(0, .04, 'under 4%'), (.04, .07, '4-7%'), (.07, .10, '7-10%'), (.10, .14, '10-14%'), (.14, 1.01, '14%+')]
    rows = []
    for lo, hi, lab in hr_b:
        b = fr[(fr.p >= lo) & (fr.p < hi)]
        if len(b): rows.append([lab, n_(len(b)), pc(b.p.mean()), '<b>' + pc(b.y.mean()) + '</b>'])
    out['hr'] = {'title': f'Backtest — {len(te):,} held-out starter-games, fitted before they were played',
                 'sections': [{'h': 'Does a price mean what it says? 1+ HR, by its price', 'head': ['Priced', 'Starter-games', 'Priced', 'Hit'], 'rows': rows},
                              {'h': 'Overall', 'head': ['', 'Starter-games', 'Priced', 'Hit'], 'rows': [['1+ HR', n_(len(te)), pc(fr.p.mean()), '<b>' + pc(fr.y.mean()) + '</b>']]}],
                 'note': "The shipped features (batter, barrel and blast rates, the starter's barrels allowed, lineup slot, park), fitted on 2026 games before Aug 1 and scored on Aug 1 onward. Only one season carries the contact data, so this is a held-out stretch rather than seasons of history."}
    return out


if __name__ == '__main__':
    stamp = pd.Timestamp.now().strftime('%Y-%m-%d')
    for sport, fn in (('nba', nba), ('mlb', mlb)):
        t = fn()
        json.dump({'generated': stamp, 'tools': t}, open(os.path.join(ROOT, sport, 'backtests.json'), 'w'), separators=(',', ':'))
        print(sport, {k: (len(v['sections'][0]['rows']), v['title'][:44]) for k, v in t.items()})
