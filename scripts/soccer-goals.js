// Ron's Goal Tool — anytime goalscorer: the history the model reads, its
// features, and the price. Shared by the build (scripts/build-soccer.js) and
// the research replay (research/soccer_goals_rows.mjs), so a backtest row and a
// live price are made by the same code. The model's numbers are fitted in
// research/soccer_goals.py and read from soccer/goals-model.json; nothing here fits.
//
// A player's goals = non-penalty goals + penalties:
//   non-penalty: Poisson, log mu = b0 + b·[log expected minutes (and squared),
//     starts in the last five, his shooting and scoring rates (shrunk to his
//     position's), his team's goals off the line, home]
//   penalties:   his share of his team's recent penalties x the team's penalty
//     rate x conversion x his share of the 90
// then p = 1 - exp(-a mu^k): a two-number stretch fitted with the model
// (isotonic lost to the raw price walk-forward).
import { posFam } from './soccer-state.js';

export const GOALS_VERSION = 1;
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
    T.games.push({ id: r.id, d: r.date, pka: r.players.filter(p => p.team === ab).reduce((n, p) => n + (p.pka || 0), 0) });
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
  return { pos, min5: +min5.toFixed(2), st5: st.reduce((a, b) => a + b, 0), lastMin: m[m.length - 1],
    apps: P.apps.length, min: tot.min, np: tot.np, sh: tot.sh, sot: tot.sot,
    pkShare: tPka ? pPka / tPka : 0, pkN: tPka, teamGames: T.games.length };
}

/** The model's inputs from raw features: shrunk per-90 rates and the logs the regression reads. */
export function goalInputs(f, ctx, M) {
  const pr = M.priors[f.pos] || M.priors.MID, K = M.shrink;    // K: prior weight in 90s
  const n90 = f.min / 90;
  const g90 = (f.np + K.g * pr.g90) / (n90 + K.g), sh90 = (f.sh + K.sh * pr.sh90) / (n90 + K.sh), sot90 = (f.sot + K.sot * pr.sot90) / (n90 + K.sot);
  const em = Math.max(f.min5, 1), lmin = Math.log(em / 90);
  return { lmin, lmin2: lmin * lmin, st: f.st5 / 5, lg: Math.log(g90), lsh: Math.log(sh90), lsot: Math.log(sot90),
    limp: Math.log((ctx.imp ?? M.league.imp) / M.league.imp), home: ctx.home ? 1 : 0, g90, sh90, sot90, em };
}

/** mu (non-penalty and penalty) and the calibrated anytime price. */
export function goalPrice(f, ctx, M) {
  const x = goalInputs(f, ctx, M), c = M.coef;
  const muNp = Math.exp(c.b0 + c.lmin * x.lmin + c.lmin2 * x.lmin2 + c.st * x.st + c.lg * x.lg + c.lsh * x.lsh + c.lsot * x.lsot + c.limp * x.limp + c.home * x.home);
  // penalties: shrink his share toward none (a one-penalty sample says little), times the team's rate and conversion
  const share = f.pkN ? (f.pkShare * f.pkN) / (f.pkN + M.pen.k) : 0;
  const muPk = share * M.pen.rate * ((ctx.imp ?? M.league.imp) / M.league.imp) * M.pen.conv * Math.min(1, x.em / 90);
  const mu = muNp + muPk;
  return { muNp, muPk, mu, p: 1 - Math.exp(-M.cal.a * mu ** M.cal.k), x };
}
