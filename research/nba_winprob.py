"""Live win probability for the NBA Schedule's Game tab (Ron 11/14: the NBA schedule needs what the other sports have).

    python3 research/nba_winprob.py

Stern's random walk off the closing spread: home margin at the end = lead now + (expected margin) x (time left share)
+ noise with variance sigma^2 x (time left share). P(home wins) = Phi((lead + m r) / (sigma sqrt r)), m = -spread (home).
sigma from margin - spread over every regular-season game with a close (.cache/nba, 2018-2027): 12.5-14.4 a season,
13.6 the last three. Here: scored on play-by-play (ESPN summaries, cached compact to .cache/nba_pbp), this season's
finals and a sample of last season's, every 30 game seconds: log loss, calibration by decile, vs the pregame-only price.
"""
import json, os, glob, random, subprocess, math
import numpy as np
HERE = os.path.dirname(os.path.abspath(__file__)); C = os.path.join(HERE, '.cache', 'nba_pbp'); os.makedirs(C, exist_ok=True)
SUM = 'https://site.api.espn.com/apis/site/v2/sports/basketball/nba/summary?event='

def pbp(gid):
    f = os.path.join(C, f'{gid}.json')
    if os.path.exists(f): return json.load(open(f))
    j = json.loads(subprocess.run(['curl', '-s', '--max-time', '30', SUM + gid], capture_output=True, text=True).stdout)   # no User-Agent games: ESPN 403s a custom one
    out = []
    for p in j.get('plays') or []:
        per = p['period']['number']; clk = p['clock']['displayValue']
        m, s = (clk.split(':') + ['0'])[:2] if ':' in clk else ('0', clk)
        left = float(m) * 60 + float(s)
        t = (per - 1) * 720 + (720 - left) if per <= 4 else 2880 + (per - 5) * 300 + (300 - left)
        out.append([round(t, 1), p['homeScore'], p['awayScore']])
    json.dump(out, open(f, 'w')); return out

def Phi(z): return 0.5 * (1 + math.erf(z / math.sqrt(2)))
def wp(lead, m, r, sig): return Phi((lead + m * r) / (sig * math.sqrt(max(r, 1e-4)))) if r > 0 else (1.0 if lead > 0 else 0.0 if lead < 0 else 0.5)

def main():
    games = []
    for f in glob.glob(os.path.join(HERE, '.cache', 'nba', '*', '*.json')):
        g = json.load(open(f))['game']
        if g['type'] == 2 and g.get('spread') is not None and g['season'] in ('2026-27', '2025-26') and g.get('home_pts') is not None: games.append(g)
    random.seed(1); cur = [g for g in games if g['season'] == '2026-27']; prev = random.sample([g for g in games if g['season'] == '2025-26'], 200)
    rows = []
    for g in cur + prev:
        try: P = pbp(str(g['id']))
        except Exception as e: continue
        if not P: continue
        y = 1.0 if g['home_pts'] > g['away_pts'] else 0.0; m = -g['spread']
        for t in range(0, 2880, 30):
            prior = [x for x in P if x[0] <= t]; h, a = (prior[-1][1], prior[-1][2]) if prior else (0, 0)
            rows.append((g['season'], t, h - a, m, y))
    R = np.array([(t, l, m, y) for _, t, l, m, y in rows], float)
    print(f'{len(cur)} + {len(prev)} games, {len(R):,} checkpoints')
    for sig in (12.0, 13.0, 13.6, 14.5):
        p = np.array([wp(l, m, 1 - t / 2880, sig) for t, l, m, y in R]).clip(1e-4, 1 - 1e-4)
        ll = -np.mean(R[:, 3] * np.log(p) + (1 - R[:, 3]) * np.log(1 - p))
        b = np.digitize(p, np.linspace(0.1, 0.9, 9)); ece = sum(abs(p[b == k].mean() - R[b == k, 3].mean()) * (b == k).sum() for k in np.unique(b)) / len(p)
        print(f'  sigma {sig}: log loss {ll:.4f}  ECE {ece*100:.2f}pp')
    p0 = np.array([wp(0, m, 1, 13.6) for t, l, m, y in R]).clip(1e-4, 1 - 1e-4)
    print('  pregame only:', round(-np.mean(R[:, 3] * np.log(p0) + (1 - R[:, 3]) * np.log(1 - p0)), 4))
    p = np.array([wp(l, m, 1 - t / 2880, 13.6) for t, l, m, y in R])
    for q in range(4):
        k = (R[:, 0] >= q * 720) & (R[:, 0] < (q + 1) * 720); pk = p[k]
        bb = np.digitize(pk, np.linspace(0.1, 0.9, 9))
        print(f'  Q{q+1}: ECE {sum(abs(pk[bb==j].mean()-R[k][bb==j,3].mean())*(bb==j).sum() for j in np.unique(bb))/len(pk)*100:.2f}pp')

if __name__ == '__main__' and 'fit' not in os.sys.argv: main()


def fit():
    """Leads shrink: P = Phi((k lead + m r) / (sigma sqrt r)). k, sigma fit on 2025-26's sample, scored on 2026-27."""
    games = [json.load(open(f))['game'] for f in glob.glob(os.path.join(HERE, '.cache', 'nba', '*', '*.json'))]
    games = {str(g['id']): g for g in games if g['type'] == 2 and g.get('spread') is not None and g.get('home_pts') is not None}
    R = []
    for f in glob.glob(os.path.join(C, '*.json')):
        g = games.get(os.path.basename(f)[:-5]); P = json.load(open(f))
        if not g or not P: continue
        y = 1.0 if g['home_pts'] > g['away_pts'] else 0.0
        for t in range(0, 2880, 30):
            prior = [x for x in P if x[0] <= t]; h, a = (prior[-1][1], prior[-1][2]) if prior else (0, 0)
            R.append((g['season'] == '2026-27', t, h - a, -g['spread'], y))
    R = np.array(R, float); te = R[:, 0] == 1
    def score(k, sig, M):
        r = 1 - M[:, 1] / 2880
        p = np.array([Phi(z) for z in (k * M[:, 2] + M[:, 3] * r) / (sig * np.sqrt(r))]).clip(1e-4, 1 - 1e-4)
        ll = -np.mean(M[:, 4] * np.log(p) + (1 - M[:, 4]) * np.log(1 - p))
        b = np.digitize(p, np.linspace(0.1, 0.9, 9)); ece = sum(abs(p[b == j].mean() - M[b == j, 4].mean()) * (b == j).sum() for j in np.unique(b)) / len(p)
        return ll, ece
    grid = [(k, s) for k in (0.45, 0.5, 0.55, 0.6, 0.65, 0.7, 0.8, 0.9, 1.0) for s in (10.5, 11.5, 12.5, 13.5, 14.5, 15.5)]
    best = min(grid, key=lambda ks: score(*ks, R[~te])[0])
    print('fit on 2025-26:', best)
    for name, ks in (('stern 13.6', (1.0, 13.6)), ('fit', best)):
        ll, ece = score(*ks, R[te]); print(f'  2026-27 {name}: log loss {ll:.4f}  ECE {ece*100:.2f}pp')

if __name__ == '__main__' and 'fit' in os.sys.argv: fit()
