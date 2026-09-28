// Birthdays, Milestones and Due — the three /nba watch lists that are for fun.
// Ported from scripts/nhl-fun.js.
//
//   milestones  career regular-season totals against the next round number.
//               ESPN's career line through LAST season is fetched once a season
//               per player (nba/career.json); this season comes off the build's
//               own state (nba/players.json), so it moves game by game.
//   due         tonight's board, with each player's drought going in (the state's
//               dr counters, seeded across the summer by nba/priors.json)
//   birthdays   every current roster's birthdays, three days back to a week out
//
// None of it is a signal, and the pages say so with numbers:
//   birthdays   351 birthday games, 11.10 points on an 11.11 projection
//               (research/nba_fun_data.py)
//   due         first basket: dead even after long droughts; threes and doubles:
//               long droughts hit LESS than priced, never more (research/nba_due.py)
import fs from 'node:fs';
import { get, pool } from './nba-api.js';

const FUN = JSON.parse(fs.readFileSync(new URL('../research/nba_fun.json', import.meta.url), 'utf8'));
const CAREER_PATH = new URL('../nba/career.json', import.meta.url);
const MS_PATH = new URL('../nba/milestones-history.json', import.meta.url);
const CAREER_URL = (id) => `https://site.web.api.espn.com/apis/common/v3/sports/basketball/nba/athletes/${id}/stats`;

// Rungs, and how close counts as a chase — about a week for a player who piles them up.
export const MS_RUNGS = {
  pts: { every: 1000, min: 1000, within: 100, label: 'Points' },
  reb: { every: 500,  min: 500,  within: 40,  label: 'Rebounds' },
  ast: { every: 500,  min: 500,  within: 35,  label: 'Assists' },
  tpm: { every: 100,  min: 100,  within: 10,  label: 'Threes' },
  stl: { every: 100,  min: 100,  within: 5,   label: 'Steals' },
  blk: { every: 100,  min: 100,  within: 5,   label: 'Blocks' },
  dd:  { every: 50,   min: 50,   within: 4,   label: 'Double-Doubles' },
  td:  { every: 10,   min: 10,   within: 2,   label: 'Triple-Doubles' },
  gp:  { every: 100,  min: 100,  within: 4,   label: 'Games' },
};
const MS_STATS = Object.keys(MS_RUNGS);
const BD_BEFORE = 3, BD_AFTER = 7;
// Due: a drought shows once it's 3+ games and he'd have expected a hit in it (games x tonight's price >= 1)
export const DUE_MARKETS = { t1: 'Threes', t3: '3+ Threes', dd: 'Double-Double', td: 'Triple-Double', fb: 'First Basket' };

const DAY = 864e5;
const dnum = (ymd) => Date.parse(ymd + 'T00:00:00Z') / DAY;

/** His ESPN career line through the season before `year` (ESPN names a season by its ending year). */
async function careerThrough(pid, year) {
  const j = await get(CAREER_URL(pid));
  const out = Object.fromEntries(MS_STATS.map(k => [k, 0]));
  const cat = (n) => (j.categories || []).find(c => c.name === n);
  // a traded player has a row per club AND a season "Totals" row: the club rows only
  const rows = (c) => (c?.statistics || []).filter(r => r.season?.year < year && !/totals/i.test(r.teamSlug || ''));
  const col = (c, name) => (c?.names || []).indexOf(name);
  const A = cat('averages'), T = cat('totals'), X = cat('miscellaneous');
  for (const r of rows(A)) out.gp += +r.stats[col(A, 'gamesPlayed')] || 0;
  const tk = { pts: 'points', reb: 'totalRebounds', ast: 'assists', stl: 'steals', blk: 'blocks' };
  for (const r of rows(T)) {
    for (const [k, n] of Object.entries(tk)) out[k] += +r.stats[col(T, n)] || 0;
    out.tpm += parseInt(r.stats[col(T, 'threePointFieldGoalsMade-threePointFieldGoalsAttempted')], 10) || 0;
  }
  for (const r of rows(X)) { out.dd += +r.stats[col(X, 'doubleDouble')] || 0; out.td += +r.stats[col(X, 'tripleDouble')] || 0; }
  return out;
}

/**
 * @param o.year      the ESPN season year (2027 = 2026-27)
 * @param o.today     ET date
 * @param o.rosters   Map team ab -> ESPN roster athletes
 * @param o.state     nba/players.json as updated this run
 * @param o.schedule  the schedule window
 * @param o.recap     recent finals (for a milestone's opponent)
 * @param o.boards    { threes, doubles, first, pts } tonight's rows
 */
export async function buildFun({ year, today, rosters, state, schedule, recap, boards }) {
  const roster = new Map();
  for (const [ab, list] of rosters) for (const a of list || []) roster.set(String(a.id), {
    team: ab, pos: a.position?.abbreviation || null, mug: a.headshot?.href || null,
    bd: a.dateOfBirth ? a.dateOfBirth.slice(0, 10) : null, name: a.displayName });

  // ── Career through last season: fetched once a season per player ──
  let car = { year, p: {} };
  try { const c = JSON.parse(fs.readFileSync(CAREER_PATH, 'utf8')); if (c.year === year) car = c; } catch (e) { /* first build */ }
  const need = [...roster.keys()].filter(pid => !car.p[pid]);
  let fetched = 0;
  await pool(need, 8, async (pid) => { try { car.p[pid] = await careerThrough(pid, year); fetched++; } catch (e) { /* next build */ } });
  fs.writeFileSync(CAREER_PATH, JSON.stringify(car));
  const career = (pid) => {
    const c = car.p[pid]; if (!c) return null;
    const s = state.players[pid] || {};
    return Object.fromEntries(MS_STATS.map(k => [k, (c[k] || 0) + (s[k] || 0)]));
  };

  // ── Milestone chases ──
  const milestones = [];
  for (const [pid, rs] of roster) {
    const c = career(pid); if (!c) continue;
    for (const k of MS_STATS) {
      const R = MS_RUNGS[k], v = c[k];
      const next = Math.max(R.min, (Math.floor(v / R.every) + 1) * R.every);
      if (next - v <= R.within && v > 0)
        milestones.push({ pid, name: rs.name, team: rs.team, pos: rs.pos, mug: rs.mug, stat: k, career: v, next, away: next - v });
    }
  }
  milestones.sort((x, y) => x.away / MS_RUNGS[x.stat].within - y.away / MS_RUNGS[y.stat].within || y.next - x.next);

  // ── Milestones reached: the Results tab ──
  // Each build keeps every rostered player's career line; a rung crossed since
  // the last build is logged against his newest game. How long he sat on the
  // watch list rides along from when he first appeared.
  let msLog = { year, snap: {}, watch: {}, reached: [] };
  try { const h = JSON.parse(fs.readFileSync(MS_PATH, 'utf8')); msLog = { ...msLog, ...h }; } catch (e) { /* first build */ }
  if (msLog.year !== year) msLog = { year, snap: {}, watch: {}, reached: [] };
  const oppOn = (team, date) => {
    const g = (recap || []).find(x => x.date === date && (x.home.ab === team || x.away.ab === team));
    return g ? (g.home.ab === team ? g.away.ab : g.home.ab) : '';
  };
  for (const [pid, rs] of roster) {
    const cv = career(pid); if (!cv) continue;
    const prev = msLog.snap[pid];
    if (prev) for (const k of MS_STATS) {
      if (prev[k] == null || !(cv[k] > prev[k])) continue;
      const R = MS_RUNGS[k];
      for (let n = Math.max(R.min, (Math.floor(prev[k] / R.every) + 1) * R.every); n <= cv[k]; n += R.every) {
        const last = state.players[pid]?.last10?.at(-1);
        const date = last?.d || today;
        const ev = { pid, name: rs.name, team: rs.team, pos: rs.pos, mug: rs.mug, stat: k, n, date, opp: oppOn(rs.team, date) };
        const w = msLog.watch[`${pid}|${k}|${n}`];
        if (w) Object.assign(ev, { since: w.since, from: w.from });
        if (!msLog.reached.some(x => x.pid === pid && x.stat === k && x.n === n)) msLog.reached.push(ev);
      }
    }
    msLog.snap[pid] = cv;
  }
  const nowKeys = new Set();
  for (const m of milestones) {
    const key = `${m.pid}|${m.stat}|${m.next}`; nowKeys.add(key);
    msLog.watch[key] ??= { since: today, from: m.career };
  }
  for (const k of Object.keys(msLog.watch)) if (!nowKeys.has(k)) delete msLog.watch[k];
  msLog.reached.sort((a, b) => b.date.localeCompare(a.date));
  fs.writeFileSync(MS_PATH, JSON.stringify(msLog));

  // ── Due: tonight's board with each player's drought going in ──
  const due = Object.fromEntries(Object.keys(DUE_MARKETS).map(k => [k, []]));
  const add = (k, r, p) => {
    const s = state.players[r.pid]; const n = s?.dr?.[k];
    if (n == null || !(p > 0) || n < 3 || n * p < 1) return;
    due[k].push({ pid: r.pid, name: r.name, team: r.team, opp: r.opp, home: r.home, pos: r.pos, gid: r.gid,
      mug: roster.get(String(r.pid))?.mug || null, n, last: s.drd?.[k] || null, p: +p.toFixed(4) });
  };
  for (const r of boards.threes || []) { add('t1', r, r.p[0]); add('t3', r, r.p[2]); }
  for (const r of boards.doubles || []) { add('dd', r, r.dd); add('td', r, r.td); }
  for (const g of boards.first || []) for (const x of g.players) {
    const opp = x.team === g.home ? g.away : g.home;
    add('fb', { ...x, opp, home: x.team === g.home, gid: g.gid }, x.p);
  }
  for (const k of Object.keys(due)) due[k].sort((a, b) => b.p - a.p);

  // ── Birthdays this week, and whether he plays on the day ──
  const t0 = dnum(today), yr = +today.slice(0, 4);
  const gameOn = {};
  // preseason counts as a game on the day, labelled as one
  for (const g of schedule) if ([1, 2, 3, 5].includes(g.type)) for (const t of [g.away.ab, g.home.ab]) gameOn[`${t}|${g.date}`] = g;
  const proj = new Map((boards.pts || []).map(r => [String(r.pid), r]));
  const birthdays = [];
  for (const [pid, rs] of roster) {
    if (!rs.bd) continue;
    const md = rs.bd.slice(4) === '-02-29' ? '-02-28' : rs.bd.slice(4);
    const cand = [yr - 1, yr, yr + 1].map(y => `${y}${md}`).find(d => { const off = dnum(d) - t0; return off >= -BD_BEFORE && off <= BD_AFTER; });
    if (!cand) continue;
    const g = gameOn[`${rs.team}|${cand}`];
    const pr = proj.get(pid);
    const row = state.players[pid]?.last10?.find(x => x.d === cand);
    birthdays.push({
      pid, name: rs.name, team: rs.team, pos: rs.pos, mug: rs.mug,
      day: cand, off: dnum(cand) - t0, turning: +cand.slice(0, 4) - +rs.bd.slice(0, 4),
      game: g ? { gid: g.id, opp: g.away.ab === rs.team ? g.home.ab : g.away.ab, home: g.home.ab === rs.team, start: g.start, pre: g.type === 1 } : null,
      mu: pr && pr.gid === g?.id ? pr.mu : null,
      rec: FUN.bday.rec[pid] || null,
      res: row ? { pts: row.pts, reb: row.reb, ast: row.ast, tpm: row.tpm } : null,
    });
  }
  birthdays.sort((a, b) => a.off - b.off || (b.game ? 1 : 0) - (a.game ? 1 : 0) || a.name.localeCompare(b.name));

  return { birthdays, bdStats: FUN.bday.stats, milestones, rungs: MS_RUNGS, msReached: msLog.reached, due, dueMarkets: DUE_MARKETS,
    careerFetched: fetched };
}
