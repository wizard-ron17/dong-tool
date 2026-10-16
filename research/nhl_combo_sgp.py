"""Do linemates score together? Same-game parlay lifts by line relation (research, 2026-10-16).

    node research/nhl_combo_fetch.mjs        # every 2025-26 game's lines from the shift charts (cached)
    python3 research/nhl_combo_sgp.py        # that game's own lines (the ceiling)
    python3 research/nhl_combo_sgp.py --pregame   # the previous game's lines: what is known before puck drop

research/nhl_pairs.py measured two teammates' goals at 0.98x the naive product: nearly independent.
That pooled every pair of teammates. Shift charts now give each game's actual lines, so the pairs
split by how they share the ice:

  line     same 5v5 forward line, or the same defence pair
  pp       same power-play unit, not linemates
  both     linemates AND the same power-play unit
  apart    teammates who share neither

For each relation and market, lift = (games where both legs hit) / (sum over pairs of pA x pB), each
player's p his own rate over the season's games he dressed for. Lift 1.00 is independent; the CI
comes from resampling whole games. Markets: goal + goal, goal + point (A scores, B gets a point,
ordered), point + point, goal + assist (ordered: B assists on any goal).
"""
import json, os, random
from collections import defaultdict

HERE = os.path.dirname(os.path.abspath(__file__)); ROOT = os.path.dirname(HERE)
combos = json.load(open(os.path.join(HERE, '.cache/nhl_combos_2025.json')))
goals = json.load(open(os.path.join(ROOT, 'nhl/pairs-20252026.json')))['goals']

# per game, team: who scored / assisted (skaters only; own goals and awarded goals skipped)
G = defaultdict(lambda: defaultdict(lambda: [0, 0]))      # (gid, team) -> pid -> [goals, assists]
for d, gid, team, s, ast, st, mod in goals:
    if mod in ('own-goal', 'awarded', 'awarded-empty-net'): continue
    G[(gid, team)][s][0] += 1
    for a in ast: G[(gid, team)][a][1] += 1

import sys
PREGAME = '--pregame' in sys.argv     # relations from the team's PREVIOUS game's lines: what is known before puck drop
prev = {}                             # (team) -> last game's (line, pp) maps, walked in game order
rows = []          # one per (game, team): dressed skaters, their relation sets, outcomes
gp = defaultdict(int); hits = defaultdict(lambda: [0, 0, 0])   # pid -> games; [goal, point, assist] games
for gid, g in sorted(combos.items(), key=lambda kv: (kv[1] or {}).get('date', '') + kv[0]):
    if not g: continue
    for team, t in g['teams'].items():
        dressed = [int(p) for p in t['toi']]
        out = G.get((int(gid), team), {})
        res = {p: out.get(p, [0, 0]) for p in dressed}
        line = {}
        for i, grp in enumerate(t['F']): [line.__setitem__(p, 'F%d' % i) for p in grp]
        for i, grp in enumerate(t['D']): [line.__setitem__(p, 'D%d' % i) for p in grp]
        pp = {}
        for i, grp in enumerate(t['pp']): [pp.__setitem__(p, i) for p in grp]
        if PREGAME:
            known = prev.get(team); prev[team] = (line, pp)
            if not known: continue
            line, pp = known
        rows.append((gid, dressed, line, pp, res))
        for p in dressed:
            gp[p] += 1; r = res[p]
            hits[p][0] += r[0] > 0; hits[p][1] += (r[0] + r[1]) > 0; hits[p][2] += r[1] > 0
rate = {p: [h / gp[p] for h in hits[p]] for p in gp}

def relation(a, b, line, pp):
    same_line = a in line and line.get(a) == line.get(b)
    same_pp = a in pp and pp.get(a) == pp.get(b)
    return 'both' if same_line and same_pp else 'line' if same_line else 'pp' if same_pp else 'apart'

MARKETS = {   # (outcome index for A, for B): 0 goal, 1 point, 2 assist
    'goal+goal': (0, 0), 'goal+point': (0, 1), 'point+point': (1, 1), 'goal+assist': (0, 2)}
REL = ['both', 'line', 'pp', 'apart']

# per game accumulators so the CI can resample games
acc = []   # list of dicts: (market, rel) -> [observed, expected, pairs]
for gid, dressed, line, pp, res in rows:
    a_ = defaultdict(lambda: [0.0, 0.0, 0])
    hit = lambda p, k: (res[p][0] > 0, (res[p][0] + res[p][1]) > 0, res[p][1] > 0)[k]
    for i, a in enumerate(dressed):
        for b in dressed:
            if a == b or gp[a] < 20 or gp[b] < 20: continue
            rel = relation(a, b, line, pp)
            for m, (ka, kb) in MARKETS.items():
                if ka == kb and b < a: continue           # symmetric markets: each pair once
                e = a_[(m, rel)]
                e[0] += hit(a, ka) and hit(b, kb); e[1] += rate[a][ka] * rate[b][kb]; e[2] += 1
    acc.append(a_)

def lift(sample):
    o = defaultdict(float); x = defaultdict(float); n = defaultdict(int)
    for a_ in sample:
        for k, (ob, ex, c) in a_.items(): o[k] += ob; x[k] += ex; n[k] += c
    return {k: (o[k] / x[k] if x[k] else None, n[k], o[k], x[k]) for k in x}

full = lift(acc)
random.seed(0); boots = [lift(random.choices(acc, k=len(acc))) for _ in range(200)]
out = {}
print(f"{len(rows)} team-games, {len(gp)} skaters (20+ games for pairs)\n")
print(f"{'market':12s} {'relation':7s} {'lift':>6s} {'95% CI':>15s} {'pairs':>9s} {'both hit':>9s}")
for m in MARKETS:
    for rel in REL:
        L, n, ob, ex = full[(m, rel)]
        bs = sorted(b[(m, rel)][0] for b in boots if (m, rel) in b)
        lo, hi = bs[int(0.025 * len(bs))], bs[int(0.975 * len(bs)) - 1]
        out.setdefault(m, {})[rel] = {'lift': round(L, 3), 'lo': round(lo, 3), 'hi': round(hi, 3), 'pairs': n, 'both': int(ob)}
        print(f"{m:12s} {rel:7s} {L:6.3f}   [{lo:.3f}, {hi:.3f}] {n:9,d} {int(ob):9,d}")
    print()
prior = json.load(open(os.path.join(HERE, 'nhl_combo_sgp.json'))) if os.path.exists(os.path.join(HERE, 'nhl_combo_sgp.json')) else {}
prior['pregame' if PREGAME else 'same_game'] = {'season': '2025-26', 'team_games': len(rows), 'lifts': out}
prior['note'] = ('Lift vs the naive product for two teammates by how they share the ice. same_game: that game\'s own lines '
                 '(the ceiling); pregame: the lines from the team\'s previous game, which is what is known before puck drop.')
json.dump(prior, open(os.path.join(HERE, 'nhl_combo_sgp.json'), 'w'), indent=1)
print('wrote research/nhl_combo_sgp.json')
