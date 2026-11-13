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


def auc(p, y):
    o = np.argsort(p, kind='mergesort'); r = np.empty(len(p)); r[o] = np.arange(1, len(p) + 1)
    n1 = y.sum(); n0 = len(y) - n1
    return float((r[y == 1].sum() - n1 * (n1 + 1) / 2) / (n1 * n0)) if n1 and n0 else None


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
    # AUC: does the price rank the hits above the misses? The honest test for near-even lines, where skill vs the base
    # rate is tiny by design (the line is picked to be ~50%). Below 0.52 on 300+ games = no information: flagged.
    A = auc(p, y)
    if A is not None and n >= 300 and A < 0.52: flags.append(f'no ranking skill: AUC {A:.3f}')
    return {'n': n, 'priced': round(float(p.mean()), 4), 'hit': round(float(y.mean()), 4), 'level_z': round(float(zl), 1), 'auc': round(A, 3) if A else None,
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


def nhl():
    """NHL: every history grades itself (the build freezes the pre-game board and fills in the result; -1 = didn't dress,
    null = not final yet). Layouts from scripts/build-nhl.js."""
    out = {}
    def add(m, d, p, y):
        if p is not None and 0 < p < 1: out.setdefault(m, []).append((d, p, y))
    ok = lambda v: v is not None and v != -1
    G = load('nhl/picks-history.json')       # [pid, p, scored, gid, p2, p3, pFirst, pLast, pP1, pPP, goals, first, last, p1Goals, ppGoals, ...]
    for d, rows in G.items():
        for r in rows:
            if not ok(r[2]) or len(r) < 15 or r[10] is None or r[10] == -1: continue
            add('Anytime goal', d, r[1], int(r[2] == 1)); add('2+ goals', d, r[4], int(r[10] >= 2)); add('Hat trick', d, r[5], int(r[10] >= 3))
            add('First goal', d, r[6], int(r[11] == 1)); add('Last goal', d, r[7], int(r[12] == 1))
            if ok(r[13]): add('1st-period goal', d, r[8], int(r[13] >= 1))
            if ok(r[14]): add('Power-play goal', d, r[9], int(r[14] >= 1))
    for d, rows in load('nhl/shots-history.json').items():      # [pid, mu, line, pOver, got, gid, ...]
        for r in rows:
            if ok(r[4]): add('Shots on goal over the line', d, r[3], int(r[4] > r[2]))
    for d, rows in load('nhl/phys-history.json').items():       # [pid, muH, Lh, pH, gotH, gid, name, team, opp, muB, Lb, pB, gotB]
        for r in rows:
            if ok(r[4]): add('Hits over the line', d, r[3], int(r[4] > r[2]))
            if len(r) > 12 and ok(r[12]): add('Blocks over the line', d, r[11], int(r[12] > r[10]))
    for d, rows in load('nhl/saves-history.json').items():      # [pid, mu, line, pOver, got, gid, name, team, opp, muGa, Lga, pGa, gotGa]
        for r in rows:
            if ok(r[4]): add('Saves over the line', d, r[3], int(r[4] > r[2]))
            if len(r) > 12 and ok(r[12]): add('Goals allowed over the line', d, r[11], int(r[12] > r[10]))
    for d, rows in load('nhl/points-history.json').items():     # [pid, gid, name, team, opp, muP, Lp, pP, gotP, muA, La, pA, gotA, muPpp, Lppp, pPpp, gotPpp]
        for r in rows:
            if ok(r[8]): add('Points over the line', d, r[7], int(r[8] > r[6]))
            if len(r) > 12 and ok(r[12]): add('Assists over the line', d, r[11], int(r[12] > r[10]))
            if len(r) > 16 and ok(r[16]): add('PP points over the line', d, r[15], int(r[16] > r[14]))
    return out


def nfl():
    """NFL: nfl/results.json, one frozen pre-kickoff board per game and its graded res. A player not in the box score
    (res.inBox) or listed DNP is left out. Yards have no price on the board (median only), so they aren't graded."""
    out = {}
    def add(m, d, p, y):
        if p is not None and 0 < p < 1: out.setdefault(m, []).append((d, p, y))
    for g in load('nfl/results.json')['games'].values():
        R = g.get('res'); d = (g.get('kick') or '')[:10]
        if not g.get('final') or not R: continue
        played = set(R.get('inBox') or []) - set(R.get('dnp') or [])
        for r in g.get('td') or []:              # [id, name, team, pos, pAny, p2, pFirst, pLast]
            pid = r[0]
            if pid not in played: continue
            n = (R.get('td') or {}).get(pid, 0) or 0
            add('Anytime TD', d, r[4], int(n >= 1)); add('2+ TDs', d, r[5], int(n >= 2))
            add('First TD', d, r[6], int(R.get('first') == pid)); add('Last TD', d, r[7], int(R.get('last') == pid))
        for key, res, m, li in (('rec', 'rec', 'Receptions over the line', 5), ('cmp', 'cmp', 'Completions over the line', 4)):
            for r in g.get(key) or []:           # rec [id, name, team, pos, mu, line, pOver, (raw mu)]; cmp [id, name, team, mu, line, pOver]
                pid, line, pov = r[0], r[li], r[li + 1]
                got = (R.get(res) or {}).get(pid)
                if pid in played and got is not None: add(m, d, pov, int(got > line))
        for key, res, m in (('pass', 'ptd', 'Passing TDs'), ('int', 'ints', 'Interceptions')):
            for r in g.get(key) or []:           # [id, name, team, mu, P(1+), P(2+), (P(3+))]
                pid = r[0]; got = (R.get(res) or {}).get(pid)
                if pid not in played or got is None: continue
                for k, i in ((1, 4), (2, 5), (3, 6)):
                    if i < len(r): add(f'{m} {k}+', d, r[i], int(got >= k))
    return out


def soccer():
    """MLS: soccer/goals-history.json (each game's last pre-kickoff prices: {gid: {pid: {g, sh: [mu, P1+...], sot: [mu, P1+...]}}})
    against soccer/recap.json player rows [pid, name, team, pos, starter, min, g, a, sh, sot, ...]. Prices are 'if he plays':
    no minutes = left out."""
    out = {}
    def add(m, d, p, y):
        if p is not None and 0 < p < 1: out.setdefault(m, []).append((d, p, y))
    H = load('soccer/goals-history.json')['days']; R = load('soccer/recap.json')['games']
    box = {gid: {r[0]: r for r in (g.get('players') or [])} for gid, g in R.items()}
    for d, games in H.items():
        for gid, ps in games.items():
            B = box.get(gid)
            if not B: continue
            for pid, v in ps.items():
                r = B.get(pid)
                if not r or not r[5]: continue
                add('Anytime goal', d, v.get('g'), int((r[6] or 0) >= 1))
                for key, i, lab in (('sh', 8, 'Shots'), ('sot', 9, 'Shots on target')):
                    L = v.get(key) or []
                    for k in (1, 2, 3):
                        if k < len(L): add(f'{lab} {k}+', d, L[k], int((r[i] or 0) >= k))
    return out


SPORTS = {'NBA': nba, 'NHL': nhl, 'NFL': nfl, 'MLS': soccer}


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
    print('\n  market                          window   n      priced  hit     slope  AUC    skill')
    for sp, mk in report['sports'].items():
        for m, res in mk.items():
            for w in ('season', 'last30'):
                r = res[w]
                if r: print(f"  {sp} {m:28s} {w:7s} {r['n']:6,} {r['priced']:7.1%} {r['hit']:7.1%} {r['slope']:6.2f} {r['auc'] or 0:6.3f} {r['skill']:6.3f}{'  FLAG' if r['flags'] else ''}")


if __name__ == '__main__':
    main()
