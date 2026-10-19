// Ron's Goal Tool — anytime goalscorer: the history the model reads, its
// features, and the price. Shared by the build (scripts/build-soccer.js) and
// the research replay (research/soccer_goals_rows.mjs), so a backtest row and a
// live price are made by the same code. The model's numbers are fitted in
// research/soccer_goals.py and read from soccer/goals-model.json; nothing here fits.
//
// The price (v2, 10/19) is a mixture over his role, as shots: P(start) and
// P(comes on) from the shared role model (soccer-shots.js roleProbs), or known
// once the lineups post. Given the role, his goals are
//   non-penalty: Poisson, log mu = b0 + b·[log the minutes that role gets him,
//     his goal / shot / on-target rates (shrunk to his position's), his team's
//     goals off the line, home, started]
//   penalties:   his share of his team's recent penalties x the team's penalty
//     rate x conversion x the role's share of the 90
// then p = 1 - exp(-a mu^k) per role: a two-number stretch fitted per mode
// (before the lineups, and with them).
import { posFam } from './soccer-state.js';
import { roleProbs } from './soccer-shots.js';

export const GOALS_VERSION = 2;          // the history's shape; 2: team games carry shots for and against (the model's own version is in goals-model.json)
const HIST = 40;          // a player's appearances kept (about a season)
const TEAM_HIST = 40;     // a team's games kept (penalty shares, the last five)
const LAST = 5;           // the team games his expected minutes are read off

export function freshGoalState() { return { version: GOALS_VERSION, teams: {}, players: {} }; }

/** Roll one reduced final (soccer-state.js reduceSummary) into the history. */
export function applyGoalGame(GS, r) {
  if (r.slug === 'all-star-game') return;
  for (const ab of [r.home.ab, r.away.ab]) {
    const T = (GS.teams[ab] ||= { games: [] });
    if (T.games.some(g => g.id === r.id)) return;           // already in
    // team shots are the players' own, summed (the team box reads 0 when ESPN has none); a game where neither side shot is missing data
    const opp = ab === r.home.ab ? r.away.ab : r.home.ab;
    const sum = (t, k) => r.players.filter(p => p.team === t).reduce((n, p) => n + (p[k] || 0), 0);
    const ok = sum(ab, 'sh') + sum(opp, 'sh') > 0;
    T.games.push({ id: r.id, d: r.date, pka: r.players.filter(p => p.team === ab).reduce((n, p) => n + (p.pka || 0), 0),
      sh: ok ? sum(ab, 'sh') : null, sot: ok ? sum(ab, 'sot') : null, sha: ok ? sum(opp, 'sh') : null, sota: ok ? sum(opp, 'sot') : null });
    if (T.games.length > TEAM_HIST) T.games.shift();
  }
  for (const p of r.players) {
    const P = (GS.players[p.pid] ||= { name: p.name, apps: [] });
    P.name = p.name; P.team = p.team;
    // [game id, date, team, minutes, started, np goals, penalties taken, penalty goals, shots, on target, position family]
    P.apps.push([r.id, r.date, p.team, p.min, p.starter ? 1 : 0, p.g - (p.pk || 0), p.pka || 0, p.pk || 0, p.sh, p.sot, posFam(p.gpos) || '']);
    if (P.apps.length > HIST) P.apps.shift();
  }
  for (const [ab, ids] of Object.entries(r.bench || {})) for (const pid of ids) {
    const P = (GS.players[pid] ||= { name: null, apps: [] });
    P.team = ab; P.lastBench = r.id;
  }
}

/**
 * A player's raw features before a game for `team` (counts, not yet shrunk:
 * the model's priors and weights live in goals-model.json). Null when he has
 * no appearance for this team in its last ten games (he isn't in its rotation).
 */
export function goalFeatures(GS, pid, team) {
  const P = GS.players[pid], T = GS.teams[team];
  if (!P || !T || !T.games.length) return null;
  const byId = new Map(P.apps.map(a => [a[0], a]));
  const last = T.games.slice(-LAST), last10 = T.games.slice(-10);
  if (!last10.some(g => byId.get(g.id)?.[2] === team)) return null;
  const m = last.map(g => { const a = byId.get(g.id); return a && a[2] === team ? a[3] : 0; });
  const st = last.map(g => { const a = byId.get(g.id); return a && a[2] === team ? a[4] : 0; });
  // expected minutes: the last five team games, the latest weighted most (5..1)
  const w = m.map((_, i) => i + 1 + (LAST - m.length)), W = w.reduce((a, b) => a + b, 0);
  const min5 = m.reduce((a, x, i) => a + x * w[i], 0) / W;
  const tot = P.apps.reduce((o, a) => { o.min += a[3]; o.np += a[5]; o.sh += a[8]; o.sot += a[9]; return o; }, { min: 0, np: 0, sh: 0, sot: 0 });
  // his position: the family he has started at most (his sub appearances say SUB)
  const fam = {}; for (const a of P.apps) if (a[10]) fam[a[10]] = (fam[a[10]] || 0) + 1;
  const pos = Object.entries(fam).sort((a, b) => b[1] - a[1])[0]?.[0] || 'MID';
  // penalties: his share of his team's attempts over the games he was there for (the team's last 40)
  const teamIds = new Set(T.games.map(g => g.id));
  const mine = P.apps.filter(a => teamIds.has(a[0]) && a[2] === team);
  const tPka = T.games.reduce((n, g) => n + g.pka, 0), pPka = mine.reduce((n, a) => n + a[6], 0);
  // his role: did he start the team's last game, how often he came off its bench, and the minutes each role gets him
  // (his last ten starts and last ten sub appearances, any team; the league's typical when he has none)
  const subs5 = m.filter((x, i) => x > 0 && !st[i]).length;
  const sts = P.apps.filter(a => a[4]).slice(-10), sbs = P.apps.filter(a => !a[4]).slice(-10);
  const stMin = sts.length ? sts.reduce((n, a) => n + a[3], 0) / sts.length : null, subMin = sbs.length ? sbs.reduce((n, a) => n + a[3], 0) / sbs.length : null;
  // recent form: his last five appearances (any team)
  const r5 = P.apps.slice(-5).reduce((o, a) => { o.min += a[3]; o.sh += a[8]; o.sot += a[9]; return o; }, { min: 0, sh: 0, sot: 0 });
  return { pos, min5: +min5.toFixed(2), lastSt: st[st.length - 1], subs5, stMin: stMin == null ? null : +stMin.toFixed(1), subMin: subMin == null ? null : +subMin.toFixed(1),
    nSt: sts.length, nSub: sbs.length, st10: P.apps.slice(-10).filter(a => a[4]).length, rmin: r5.min, rsh: r5.sh, rsot: r5.sot, st5: st.reduce((a, b) => a + b, 0), lastMin: m[m.length - 1],
    apps: P.apps.length, min: tot.min, np: tot.np, sh: tot.sh, sot: tot.sot,
    pkShare: tPka ? pPka / tPka : 0, pkN: tPka, teamGames: T.games.length };
}

/**
 * A side's shooting matchup before a game: its own shots and shots on target a
 * game and what the opponent allows, over each one's last TEAM_N games with a box.
 */
const TEAM_N = 20;
export function teamFeatures(GS, team, opp) {
  const avg = (ab, k) => { const g = (GS.teams[ab]?.games || []).filter(x => x[k] != null).slice(-TEAM_N); return g.length ? { v: g.reduce((a, x) => a + x[k], 0) / g.length, n: g.length } : { v: null, n: 0 }; };
  const t = avg(team, 'sh'), ts = avg(team, 'sot'), o = avg(opp, 'sha'), os = avg(opp, 'sota');
  return { tsh: t.v, tsot: ts.v, osha: o.v, osota: os.v, tn: t.n, on: o.n };
}

/** One role's non-penalty goal mean and penalty mean: the minutes that role gets him (started 1/0). */
function goalRole(f, ctx, M, started) {
  const pr = M.priors[f.pos] || M.priors.MID, K = M.shrink, n90 = f.min / 90;
  const g90 = (f.np + K.g * pr.g90) / (n90 + K.g), sh90 = (f.sh + K.sh * pr.sh90) / (n90 + K.sh), sot90 = (f.sot + K.sh * pr.sot90) / (n90 + K.sh);
  const em = started ? (f.stMin ?? M.roleMin.start) : (f.subMin ?? M.roleMin.sub);
  const imp = ctx.imp ?? M.league.imp;
  const x = { lrm: Math.log(Math.max(em, 1) / 90), lg: Math.log(g90), lsh: Math.log(sh90), lsot: Math.log(sot90),
    limp: Math.log(imp / M.league.imp), home: ctx.home ? 1 : 0, st: started };
  const c = M.coef;
  const np = Math.exp(c.b0 + c.lrm * x.lrm + c.lg * x.lg + c.lsh * x.lsh + c.lsot * x.lsot + c.limp * x.limp + c.home * x.home + c.st * x.st);
  // penalties: shrink his share toward none (a one-penalty sample says little), times the team's rate and conversion
  const share = f.pkN ? (f.pkShare * f.pkN) / (f.pkN + M.pen.k) : 0;
  const pk = share * M.pen.rate * (imp / M.league.imp) * M.pen.conv * Math.min(1, em / 90);
  return { np, pk, mu: np + pk, x, em, g90, sh90, sot90 };
}

/**
 * The anytime price: a mixture over his role (soccer-shots.js roleProbs, the
 * same role model), each role's goals Poisson, then the mode's stretch
 * p = 1 - exp(-a mu^k). xi: null before the lineups, else 'XI' / 'bench'.
 */
export function goalPrice(f, ctx, M, xi = null) {
  const { ps, pb } = xi == null ? roleProbs(f, M.role) : { ps: xi === 'XI' ? 1 : 0, pb: xi === 'bench' ? M.role.benchOn : 0 };
  const S = goalRole(f, ctx, M, 1), B = goalRole(f, ctx, M, 0), c = M.cal[xi == null ? 'pre' : 'known'];
  const p = ps * (1 - Math.exp(-c.a * S.mu ** c.k)) + pb * (1 - Math.exp(-c.a * B.mu ** c.k));
  const em = ps * S.em + pb * B.em;      // the minutes the price expects (the board's MIN)
  return { p, ps, pb, S, B, mu: ps * S.mu + pb * B.mu, muPk: ps * S.pk + pb * B.pk,
    x: { em, g90: S.g90, sh90: S.sh90, sot90: S.sot90 } };
}

/**
 * His price taken apart, for the card's tornado: each group of terms as a log
 * multiplier on his expected goals against a reference starter (his
 * position's league rates, 80 minutes, the league's team goals, away, no
 * penalties). Minutes, shooting, finishing, team goals, home and penalties are
 * his goals IF HE STARTS; "role" is the rest: his chances of starting or
 * coming on, and the calibration. The terms sum to log(-ln(1 - p) / base).
 */
const REF_MIN = 80;
export function goalFactors(f, ctx, M, P = goalPrice(f, ctx, M)) {
  const c = M.coef, x = P.S.x, pr = M.priors[f.pos] || M.priors.MID, lr = Math.log(REF_MIN / 90);
  const base = Math.exp(c.b0 + c.lrm * lr + c.lg * Math.log(pr.g90) + c.lsh * Math.log(pr.sh90) + c.lsot * Math.log(pr.sot90) + c.st);
  const d = {
    min: c.lrm * (x.lrm - lr),
    shoot: c.lsh * (x.lsh - Math.log(pr.sh90)) + c.lsot * (x.lsot - Math.log(pr.sot90)),
    finish: c.lg * (x.lg - Math.log(pr.g90)),
    team: c.limp * x.limp, home: c.home * x.home,
    pens: Math.log(P.S.mu / P.S.np),
  };
  const muEff = -Math.log(1 - Math.min(P.p, 0.999));
  d.role = Math.log(muEff / base) - Object.values(d).reduce((a, v) => a + v, 0);
  for (const k in d) d[k] = +d[k].toFixed(4);
  return { base: +base.toFixed(4), d };
}
