"""Each game's first shot attempts (research, Ron 11/13: first basket is missing early usage).

    python3 research/nba_first_shots.py          # fetch (cached), then nothing else: nba_firstbasket3.py reads it

The research cache (nba_fetch.py) kept only the first MADE basket and the tip. Who takes his team's first ATTEMPT
is the input every first-basket model in the wild leans on (first-shot share: 35%+ takers scored first ~25% vs 6%
for the bottom quarter, heatcheckhq's 500-prop study; unverified), and the books price it as its own prop. One ESPN
summary call per game (nba_fetch.get: no custom UA, ESPN 403s one); the first 8 field-goal attempts, free throws out:
[seconds into the game, team id, player id, made]. Cached per game in .cache/nba_fs/.
"""
import glob, json, os, sys
from concurrent.futures import ThreadPoolExecutor
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
argv, sys.argv = sys.argv, sys.argv[:1]
import nba_fetch as N
sys.argv = argv
OUT = os.path.join(HERE, '.cache', 'nba_fs'); os.makedirs(OUT, exist_ok=True)
SEASONS = {'2023-24', '2024-25', '2025-26', '2026-27'}


def secs(p):
    per = (p.get('period') or {}).get('number') or 1; c = (p.get('clock') or {}).get('displayValue') or '12:00'
    m, s_ = (c.split(':') + ['0'])[:2]
    try: left = int(m) * 60 + float(s_)
    except ValueError: left = 0
    return (per - 1) * 720 + (720 - left)


def one(eid):
    f = os.path.join(OUT, f'{eid}.json')
    if os.path.exists(f): return 'cached'
    s = N.get(f'{N.SITE}/summary?event={eid}')
    if not s: return 'fail'
    P = s.get('plays') or []
    sh = [p for p in P if p.get('shootingPlay') and 'free throw' not in ((p.get('type') or {}).get('text') or '').lower()][:8]
    rows = []
    for p in sh:
        who = next((a['athlete']['id'] for a in p.get('participants') or [] if a.get('athlete')), None)
        rows.append([round(secs(p), 1), (p.get('team') or {}).get('id'), who, bool(p.get('scoringPlay'))])
    json.dump({'eid': eid, 'fga': rows}, open(f, 'w'))
    return 'ok'


def main():
    eids = []
    for f in glob.glob(os.path.join(HERE, '.cache', 'nba', '*', '*.json')):
        g = json.load(open(f))['game']
        if g.get('type') == 2 and g.get('season') in SEASONS: eids.append(str(g['id']))
    print(f'{len(eids):,} regular-season games to read')
    with ThreadPoolExecutor(4) as ex: res = list(ex.map(one, eids))
    print({k: res.count(k) for k in set(res)})


if __name__ == '__main__':
    main()
