"""Calibration watch (Ron, 11/13: "shouldn't all of our models be checking themselves?").

    python3 research/calibration_watch.py            # every sport it knows, from raw GitHub (the live files)
    python3 research/calibration_watch.py --local    # from this checkout instead

Every night, each live model's own pre-game prices (the builds' price histories) are joined to what happened and
checked, per market, over the last 30 days and the season so far:
  level   the average price against the hit rate, with a z-score (is the gap more than noise?)
  slope   logit(hit) = a + b x logit(price): b < 1 means too steep, b > 1 too flat (with a 90% range)
  bands   calibration by price band, each band's gap and its z
  skill   log loss against guessing the base rate
A market is FLAGGED when its level is off by z >= 3, its slope's range excludes 1 by a margin, or a band with 40+
games is off by z >= 3. Flags print first and land in research/calibration_watch.json (read at session start; the
next step is a gated rolling recalibration for a flagged model, kept only where it beats the raw model out of sample).

NBA (first, 11/13): nba/prices-history.json (dbl: [dd, td]; t3: [mu, P(1+), P(2+), ...]; st: {stat: {pid: [mu, line,
P(over)]}}; fb: {gid: {pid: p}}) against nba/gamelog.json box scores and nba/recap.json first baskets. A player with
no box score that day (didn't play) is left out, as the books void him.
"""
import json, math, os, subprocess, sys
from datetime import date, timedelta
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__)); ROOT = os.path.dirname(HERE)
RAW = 'https://raw.githubusercontent.com/wizard-ron17/dong-tool/main'
LOCAL = '--local' in sys.argv
# --out FILE: where the report goes (the nightly job writes ~/ron-engine/calibration_watch.json, never into the repo)
OUT = sys.argv[sys.argv.index('--out') + 1] if '--out' in sys.argv else os.path.join(HERE, 'calibration_watch.json')


def load(path):
    if LOCAL:
        with open(os.path.join(ROOT, path)) as f: return json.load(f)
    # curl, not urllib: the python.org build on Ron's Mac has no CA bundle (SSL: CERTIFICATE_VERIFY_FAILED)
    return json.loads(subprocess.run(['curl', '-sSfL', '--max-time', '90', f'{RAW}/{path}'], check=True, capture_output=True).stdout)


def lg(p): p = np.clip(p, 1e-5, 1 - 1e-5); return np.log(p / (1 - p))
def sg(z): return 1 / (1 + np.exp(-z))


def logit_fit(x, y, it=60):
    A = np.column_stack([np.ones(len(x)), x]); b = np.zeros(2); H = None
    for _ in range(it):
        m = sg(A @ b); W = m * (1 - m); H = A.T @ (A * W[:, None]) + 1e-9 * np.eye(2); b += np.linalg.solve(H, A.T @ (y - m))
    se = np.sqrt(np.diag(np.linalg.inv(H)))
    return b, se


def check(p, y):
    p, y = np.asarray(p, float), np.asarray(y, float); n = len(p)
    if n < 30 or y.sum() < 5 or y.sum() > n - 5: return None
    ll = float(np.mean(-(y * np.log(np.clip(p, 1e-6, 1)) + (1 - y) * np.log(np.clip(1 - p, 1e-6, 1)))))
    base = y.mean(); ll0 = float(-(base * math.log(base) + (1 - base) * math.log(1 - base)))
    gap = p.mean() - y.mean(); zl = gap / math.sqrt(max(np.sum(p * (1 - p)), 1e-9)) * n
    (a, b), (sa, sb) = logit_fit(lg(p), y)
    edges = [0, .05, .1, .2, .35, .5, .65, .8, 1.0001]; bands = []
    for lo, hi in zip(edges[:-1], edges[1:]):
        k = (p >= lo) & (p < hi)
        if k.sum() < 15: continue
        g = p[k].mean() - y[k].mean(); z = g / math.sqrt(max(np.sum(p[k] * (1 - p[k])), 1e-9)) * k.sum()
        bands.append({'band': f'{lo:.0%}-{min(hi, 1):.0%}', 'n': int(k.sum()), 'priced': round(float(p[k].mean()), 4), 'hit': round(float(y[k].mean()), 4), 'z': round(float(z), 1)})
    flags = []
    if abs(zl) >= 3: flags.append(f"level {'high' if gap > 0 else 'low'} {gap * 100:+.1f} pts (z {zl:.1f})")
    if b - 1.645 * sb > 1.1: flags.append(f'too flat: slope {b:.2f} ({b - 1.645 * sb:.2f} to {b + 1.645 * sb:.2f})')
    if b + 1.645 * sb < 0.9: flags.append(f'too steep: slope {b:.2f} ({b - 1.645 * sb:.2f} to {b + 1.645 * sb:.2f})')
    for B in bands:
        if B['n'] >= 40 and abs(B['z']) >= 3: flags.append(f"{B['band']} band {'high' if B['priced'] > B['hit'] else 'low'}: priced {B['priced']:.1%}, hit {B['hit']:.1%} (n {B['n']}, z {B['z']})")
    return {'n': n, 'priced': round(float(p.mean()), 4), 'hit': round(float(y.mean()), 4), 'level_z': round(float(zl), 1),
            'slope': round(float(b), 2), 'slope_se': round(float(sb), 2), 'logloss': round(ll, 4), 'skill': round(1 - ll / ll0, 3), 'bands': bands, 'flags': flags}


def nba():
    H = load('nba/prices-history.json')['days']; G = load('nba/gamelog.json'); R = load('nba/recap.json')
    C = G['cols']; ix = {c: i for i, c in enumerate(C)}
    box = {}                                    # (pid, date) -> row
    for pid, rows in G['p'].items():
        for r in rows: box[(pid, r[ix['date']])] = r
    fb_of = {g['gid']: (g.get('fb') or {}).get('pid') for g in R.get('games', [])} if isinstance(R.get('games'), list) else {g['gid']: (g.get('fb') or {}).get('pid') for g in R.get('games', {}).values()}
    out = {}
    def add(m, d, p, y): out.setdefault(m, []).append((d, p, y))
    for d, day in H.items():
        for pid, v in (day.get('dbl') or {}).items():
            b = box.get((pid, d))
            if not b or not b[ix['min']]: continue
            cats = sum(1 for k in ('pts', 'reb', 'ast', 'stl', 'blk') if (b[ix[k]] or 0) >= 10)
            add('Double-double', d, v[0], int(cats >= 2)); add('Triple-double', d, v[1], int(cats >= 3))
        for pid, v in (day.get('t3') or {}).items():
            b = box.get((pid, d))
            if not b or not b[ix['min']]: continue
            for k in (1, 2, 3):
                if k < len(v): add(f'Threes {k}+', d, v[k], int((b[ix['tpm']] or 0) >= k))
        for st, rows in (day.get('st') or {}).items():
            parts = {'pra': ('pts', 'reb', 'ast'), 'stk': ('stl', 'blk')}.get(st, (st,))
            if any(p not in ix for p in parts): continue
            for pid, v in rows.items():
                b = box.get((pid, d))
                if not b or not b[ix['min']]: continue
                tot = sum(b[ix[p]] or 0 for p in parts); add(f'{st.upper()} over the line', d, v[2], int(tot > v[1]))
        for gid, ps in (day.get('fb') or {}).items():
            w = fb_of.get(gid)
            if not w: continue
            for pid, p in ps.items(): add('First basket', d, p, int(str(pid) == str(w)))
    return out


SPORTS = {'NBA': nba}


def main():
    today = date.today(); d30 = (today - timedelta(days=30)).isoformat()
    report = {'at': today.isoformat(), 'sports': {}}; flagged = []
    for sp, fn in SPORTS.items():
        try: M = fn()
        except Exception as e: print(f'{sp}: could not load ({e})'); continue
        report['sports'][sp] = {}
        for m, rows in sorted(M.items()):
            p = np.array([r[1] for r in rows]); y = np.array([r[2] for r in rows]); dd = np.array([r[0] for r in rows])
            res = {'season': check(p, y), 'last30': check(p[dd >= d30], y[dd >= d30])}
            report['sports'][sp][m] = res
            for w in ('last30', 'season'):
                if res[w] and res[w]['flags']: flagged.append((sp, m, w, res[w])); break
    with open(OUT, 'w') as f: json.dump(report, f, indent=1)
    print(f"calibration watch {report['at']}: {sum(len(v) for v in report['sports'].values())} markets, {len(flagged)} flagged")
    for sp, m, w, r in flagged:
        print(f"\n  FLAG {sp} {m} ({w}, n {r['n']}): priced {r['priced']:.1%}, hit {r['hit']:.1%}, slope {r['slope']}")
        for f in r['flags']: print(f'     - {f}')
    print('\n  market                      window   n      priced  hit     slope  skill')
    for sp, mk in report['sports'].items():
        for m, res in mk.items():
            for w in ('season', 'last30'):
                r = res[w]
                if r: print(f"  {sp} {m:24s} {w:7s} {r['n']:6,} {r['priced']:7.1%} {r['hit']:7.1%} {r['slope']:6.2f} {r['skill']:6.3f}{'  FLAG' if r['flags'] else ''}")


if __name__ == '__main__':
    main()
