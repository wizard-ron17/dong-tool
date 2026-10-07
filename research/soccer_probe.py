"""Soccer scouting probe (2026-10-06): re-runs the checks in soccer_scouting.md.

    python3 research/soccer_probe.py            # all checks
    python3 research/soccer_probe.py asa        # ASA base rates only
    python3 research/soccer_probe.py kalshi     # Kalshi soccer volume only

Light on purpose: one ASA season, one football-data CSV, one Kalshi call per series.
"""
import collections, csv, io, json, ssl, statistics, sys, urllib.request

CTX = ssl._create_unverified_context()      # Kalshi from Python needs this (see CLAUDE.md)


def get(url, headers=None):
    req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0', **(headers or {})})
    return urllib.request.urlopen(req, context=CTX, timeout=60).read()


def asa(season='2025'):
    """Per player-game base rates from American Soccer Analysis (first 10,000 rows of the season)."""
    rows = json.loads(get(f'https://app.americansocceranalysis.com/api/v1/mls/players/xgoals'
                          f'?season_name={season}&split_by_games=true'))
    r60 = [r for r in rows if r['minutes_played'] >= 60]
    groups = {'all 60+': r60, 'ST/W/AM': [r for r in r60 if r['general_position'] in ('ST', 'W', 'AM')],
              'ST': [r for r in r60 if r['general_position'] == 'ST']}
    for name, R in groups.items():
        rate = lambda f: sum(1 for r in R if f(r)) / len(R)
        print(f'{name:8s} n={len(R):5d}  goal {rate(lambda r: r["goals"] > 0):.3f}  1+SOT {rate(lambda r: r["shots_on_target"] >= 1):.3f}'
              f'  2+shots {rate(lambda r: r["shots"] >= 2):.3f}  assist {rate(lambda r: r["primary_assists"] > 0):.3f}'
              f'  xG {statistics.mean(r["xgoals"] for r in R):.3f}')
    agg = collections.defaultdict(lambda: [0.0, 0])
    for r in groups['ST/W/AM']:
        agg[r['player_id']][0] += r['xgoals']; agg[r['player_id']][1] += r['minutes_played']
    x = sorted(v[0] / v[1] * 90 for v in agg.values() if v[1] >= 600)
    print(f'attacker xG/90 (600+ min, n={len(x)}): p10 {x[len(x) // 10]:.3f}  median {x[len(x) // 2]:.3f}  p90 {x[9 * len(x) // 10]:.3f}')


def football_data():
    """MLS closing-line coverage on football-data.co.uk."""
    text = get('https://football-data.co.uk/new/USA.csv').decode('utf-8-sig')
    rows = list(csv.DictReader(io.StringIO(text)))
    by = collections.Counter(r['Season'] for r in rows)
    print(f'football-data MLS: {len(rows)} games, Pinnacle close on {sum(1 for r in rows if r["PSCH"])};'
          f' seasons {min(by)}–{max(by)}')


def kalshi():
    """Volume over each series' latest <=1000 markets (the ufc_golf_scouting.md method)."""
    series = ['KXMLBHR', 'KXMLSGAME', 'KXMLSTOTAL', 'KXMLSSPREAD', 'KXMLSBTTS', 'KXMLSGOAL', 'KXMLSFIRSTGOAL',
              'KXEPLGAME', 'KXEPLTOTAL', 'KXEPLBTTS', 'KXEPLGOAL', 'KXEPLFIRSTGOAL',
              'KXUCLGAME', 'KXUCLGOAL', 'KXLALIGAGAME', 'KXLALIGAGOAL']
    for t in series:
        ms = json.loads(get(f'https://api.elections.kalshi.com/trade-api/v2/markets?series_ticker={t}&limit=1000')).get('markets', [])
        vol = sum(float(m.get('volume_fp', m.get('volume', 0)) or 0) for m in ms)
        close = sorted(m.get('close_time', '')[:10] for m in ms)
        print(f'{t:16s} {vol / 1e6:8.2f}M  {len(ms):4d} markets  {close[0] if close else ""} .. {close[-1] if close else ""}')


if __name__ == '__main__':
    which = sys.argv[1] if len(sys.argv) > 1 else 'all'
    if which in ('all', 'asa'): asa()
    if which in ('all', 'fd'): football_data()
    if which in ('all', 'kalshi'): kalshi()
