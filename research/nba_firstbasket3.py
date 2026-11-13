"""First basket v3: does first-shot share sharpen who scores it? (research, Ron 11/13)

    python3 research/nba_first_shots.py     # first: each game's first field-goal attempts (.cache/nba_fs)
    python3 research/nba_firstbasket3.py

v2 (nba_firstbasket2.py, what ships) splits the price into P(team first) from the tip and the line, times his
share within the team from his own first baskets per start. Every outside first-basket model leans on a third
input v2 never had: FIRST-SHOT SHARE, how often he takes his team's first field-goal attempt (35%+ takers scored
first ~25% vs ~6% for the bottom quarter, heatcheckhq's 500-prop study, unverified). Here, walk-forward in date
order (only earlier games), each starter's
    fs = (games he took his team's first FGA + K x 0.2) / (his starts + K)
and his within-team weight becomes own^a x fs^b (renormalised over the team's five), a and b fit on earlier
seasons, scored on the next. Compared with v2 on the same games, by log loss and AUC.
"""
import glob, io, json, os, sys, contextlib
from collections import defaultdict
import numpy as np, pandas as pd
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
argv, sys.argv = sys.argv, sys.argv[:1]
import nba_firstbasket2 as F2
sys.argv = argv
K = 10


def ll(p, y): p = np.clip(np.asarray(p, float), 1e-6, 1 - 1e-6); return float(np.mean(-(y * np.log(p) + (1 - y) * np.log(1 - p))))


def auc(p, y):
    o = np.argsort(p, kind='mergesort'); r = np.empty(len(p)); r[o] = np.arange(1, len(p) + 1); n1 = y.sum(); n0 = len(y) - n1
    return (r[y == 1].sum() - n1 * (n1 + 1) / 2) / (n1 * n0)


def main():
    with contextlib.redirect_stdout(io.StringIO()): R = F2.main(export=False)
    FS = {}
    for f in glob.glob(os.path.join(HERE, '.cache', 'nba_fs', '*.json')):
        d = json.load(open(f)); FS[str(d['eid'])] = d['fga']
    # team id per player from the cached box scores (the play-by-play carries ESPN team ids, the box the abbreviation)
    tid = {}
    for f in glob.glob(os.path.join(HERE, '.cache', 'nba', '*', '*.json')):
        d = json.load(open(f)); gid = str(d['game']['id'])
        if gid in FS:
            for a in FS[gid]:
                if a[2]: tid[(gid, str(a[2]))] = str(a[1])
    R = R[R.gid.astype(str).isin(FS)].sort_values(['date', 'gid']).copy()
    # each team's first FGA taker per game: the earliest attempt by a player on that team
    first_by = {}
    for gid, rows in FS.items():
        for t, team, pid, made in rows:
            if (gid, str(team)) not in first_by and pid: first_by[(gid, str(team))] = str(pid)
    took, starts, fsv = defaultdict(float), defaultdict(float), []
    for gid, G in R.groupby('gid', sort=False):           # date order: each game priced from the games before it
        gid = str(gid); vals = []
        for _, r in G.iterrows():
            pid = str(r.pid); vals.append((took[pid] + K * 0.2) / (starts[pid] + K))
        fsv.extend(vals)
        for _, r in G.iterrows():
            pid = str(r.pid); team = tid.get((gid, pid))
            if team is None: continue
            starts[pid] += 1; took[pid] += float(first_by.get((gid, team)) == pid)
    R['fs'] = fsv
    # v2's price = P(team first) x share; share is his own record's weight over his team's five
    R['pt'] = R.tip_line_own / R.share.clip(1e-6)
    R['key'] = R.gid.astype(str) + '|' + R.team.astype(str)
    def price(df, a, b):
        w = df.share.clip(1e-6) ** a * df.fs.clip(1e-6) ** b
        return df.pt * w / w.groupby(df.key).transform('sum')
    grid = [(a, b) for a in (0.0, 0.5, 1.0, 1.5) for b in (0.0, 0.5, 1.0, 1.5, 2.0)]
    print(f"{R.gid.nunique():,} games with first-shot data ({R.season.min()}..{R.season.max()}), {len(R):,} starter-games")
    print("season   n        v2 (ships)          + first-shot share (a, b fit on earlier seasons)")
    for s in sorted(R.season.unique())[1:]:
        tr, te = R[R.season < s], R[R.season == s]
        if len(te) < 500 or len(tr) < 2000: continue
        a, b = min(grid, key=lambda ab: ll(price(tr, *ab), tr.y.values))
        q = price(te, a, b)
        print(f"{s}  {len(te):7,}  {ll(te.tip_line_own, te.y.values):.5f} AUC {auc(te.tip_line_own.values, te.y.values):.3f}   "
              f"{ll(q, te.y.values):.5f} AUC {auc(q.values, te.y.values):.3f}  (own^{a} x fs^{b})")
    # the raw relation: first basket rate by first-shot share quartile
    R['fsq'] = pd.qcut(R.fs, 4, labels=['bottom', 'q2', 'q3', 'top'])
    print('\nfirst-basket rate by first-shot share (walk-forward):', R.groupby('fsq', observed=True).agg(n=('y', 'size'), fs=('fs', 'mean'), fb=('y', 'mean')).round(3).to_dict('index'))


if __name__ == '__main__':
    main()
