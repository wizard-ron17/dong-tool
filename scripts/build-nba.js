// Ron's Hoop Tool — NBA data build. Mirrors build-nhl.js: fetch the open ESPN
// endpoints (no key), shape them, write nba/data.json. Sources:
//   core /seasons/{year}             -> which season we're in, and its phases
//   site /teams, v2 /standings       -> every club, its record
//   site /scoreboard?dates=a-b       -> the schedule window, lines, scores
//   site /summary?event=             -> each final's box score, the opening tip
//                                       and the first basket (player state)
//   site /injuries                   -> who's out
//
// Player state (nba/players.json) is the models' memory: every player's season
// totals, his last 10 games, starts, first baskets and tip record — updated from
// new finals only, never re-fetched. nba/priors.json (research/nba_priors_export.py)
// carries last season and seeds it, so opening night already has recent form.
// Nothing here needs editing next October: the season is read off the feed.
import fs from 'node:fs';
import { get, pool, SITE, SITE2, CORE, etDate, shiftDate, compact } from './nba-api.js';

const AHEAD = 10;        // schedule days ahead
const BEHIND = 3;        // ...and behind (yesterday's finals stay on the schedule)
const RECAP_DAYS = 21;   // finals kept for the recap
const LEADERS = 250;     // players on the Stats board
const BOX = ['min', 'pts', 'fgm', 'fga', 'tpm', 'tpa', 'ftm', 'fta', 'oreb', 'dreb', 'reb', 'ast', 'stl', 'blk', 'to'];
const STATE_PATH = new URL('../nba/players.json', import.meta.url);
const PRIORS_PATH = new URL('../nba/priors.json', import.meta.url);
const OUT = new URL('../nba/data.json', import.meta.url);

const readJSON = (u, d) => { try { return JSON.parse(fs.readFileSync(u, 'utf8')); } catch (e) { return d; } };
const num = (v) => { const x = parseFloat(v); return Number.isFinite(x) ? x : null; };
const made = (v) => { const m = /^(\d+)-(\d+)/.exec(v || ''); return m ? [+m[1], +m[2]] : [0, 0]; };
const PHASE = { 1: 'pre', 2: 'reg', 3: 'post', 4: 'off', 5: 'playin' };

// The NBA scoreboard takes one day at a time (a dates=a-b range is a 400, unlike
// the NFL's), so a window is fetched day by day and merged.
async function events(from, to) {
  const days = []; for (let d = from; d <= to; d = shiftDate(d, 1)) days.push(d);
  const all = await pool(days, 6, async (d) => { try { return (await get(`${SITE}/scoreboard?dates=${compact(d)}&limit=100`)).events || []; } catch (e) { return []; } });
  const byId = new Map(); for (const e of all.flat()) byId.set(e.id, e);
  return [...byId.values()];
}

// ── A game, reduced the way research/nba_fetch.py reduces it ─────────────────
function reduceSummary(s, ev) {
  const comp = s.header?.competitions?.[0]; if (!comp) return null;
  const side = Object.fromEntries(comp.competitors.map(c => [c.homeAway, c]));
  const tid = Object.fromEntries(comp.competitors.map(c => [c.team.id, c.team.abbreviation]));
  const g = { id: ev.id, date: ev.date, type: ev.type, home: side.home.team.abbreviation, away: side.away.team.abbreviation };
  const plays = s.plays || [];
  const jb = plays.slice(0, 5).find(p => /jump/i.test(p.type?.text || ''));
  if (jb) {
    g.jump = (jb.participants || []).map(a => a.athlete?.id).filter(Boolean).slice(0, 2);
    g.tip = tid[jb.team?.id] || null;
  }
  const fg = plays.find(p => p.scoringPlay && p.shootingPlay && (p.scoreValue || 0) >= 2 && !/free throw/i.test(p.type?.text || ''));
  if (fg) g.fb = { pid: fg.participants?.[0]?.athlete?.id || null, team: tid[fg.team?.id] || null, v: fg.scoreValue };
  const players = [];
  for (const t of s.boxscore?.players || []) {
    const st = t.statistics?.[0]; if (!st) continue;
    for (const a of st.athletes || []) {
      const id = a.athlete?.id; if (!id) continue;
      const v = Object.fromEntries((st.labels || []).map((l, i) => [l, a.stats?.[i]]));
      const [fgm, fga] = made(v.FG), [tpm, tpa] = made(v['3PT']), [ftm, fta] = made(v.FT);
      const min = num(v.MIN) || 0;
      players.push({ pid: id, name: a.athlete.displayName, team: t.team.abbreviation, pos: a.athlete.position?.abbreviation || null,
        st: a.starter ? 1 : 0, dnp: !!a.didNotPlay || !(min > 0), reason: a.reason || null,
        min, pts: num(v.PTS) || 0, fgm, fga, tpm, tpa, ftm, fta, oreb: num(v.OREB) || 0, dreb: num(v.DREB) || 0,
        reb: num(v.REB) || 0, ast: num(v.AST) || 0, stl: num(v.STL) || 0, blk: num(v.BLK) || 0, to: num(v.TO) || 0 });
    }
  }
  return { g, players };
}

// ── Player state: the models' memory, updated from new finals only ──────────
function freshState(season, priors) {
  const players = {};
  for (const [pid, p] of Object.entries(priors?.players || {})) {
    players[pid] = { name: p.name, team: p.team, pos: p.pos, gp: 0, gs: 0, ...Object.fromEntries(BOX.map(k => [k, 0])),
      last10: p.last10 || [], fb: p.fb || 0, starts: p.starts || 0, tipn: p.tipn || 0, tipw: p.tipw || 0 };
  }
  return { season, priorsSeason: priors?.season || null, done: [], players };
}
function applyGame(state, r) {
  const { g, players } = r;
  const starters = players.filter(p => p.st && !p.dnp);
  if (g.type === 2 && g.fb?.pid && starters.length === 10) {
    for (const p of starters) (state.players[p.pid] ||= newPlayer(p)).starts++;
    (state.players[g.fb.pid] ||= newPlayer({ name: '', team: g.fb.team })).fb++;
  }
  const jt = Object.fromEntries(starters.map(p => [p.pid, p.team]));
  if (g.tip) for (const j of g.jump || []) if (jt[j]) { const s = (state.players[j] ||= newPlayer({})); s.tipn++; if (jt[j] === g.tip) s.tipw++; }
  for (const p of players) {
    if (p.dnp) continue;
    const s = (state.players[p.pid] ||= newPlayer(p));
    Object.assign(s, { name: p.name, team: p.team, pos: p.pos || s.pos });
    if (g.type === 2) { s.gp++; s.gs += p.st; for (const k of BOX) s[k] += p[k]; }
    s.last10 = [...(s.last10 || []), { d: g.date, st: p.st, ...Object.fromEntries(BOX.map(k => [k, p[k]])) }].slice(-10);
  }
  state.done.push(g.id);
}
const newPlayer = (p) => ({ name: p.name || '', team: p.team || null, pos: p.pos || null, gp: 0, gs: 0,
  ...Object.fromEntries(BOX.map(k => [k, 0])), last10: [], fb: 0, starts: 0, tipn: 0, tipw: 0 });

async function main() {
  const today = etDate();
  // ── 1) The season and its phases ──────────────────────────────────────
  const [y, m] = today.split('-').map(Number);
  const year = m >= 7 ? y + 1 : y;                 // ESPN names a season by its ending year
  const S = await get(`${CORE}/seasons/${year}`);
  const types = await get(S.types.$ref.replace('http:', 'https:'));
  const phases = [];
  for (const it of types.items || []) {
    const t = await get(it.$ref.replace('http:', 'https:'));
    phases.push({ id: +t.id, key: PHASE[+t.id] || String(t.id), name: t.name, start: t.startDate?.slice(0, 10), end: t.endDate?.slice(0, 10) });
  }
  const now = phases.find(p => p.start <= today && today < p.end) || phases[0];
  const label = S.displayName;
  console.log(`Season ${label}: ${now.name} (${now.start} → ${now.end})`);

  // ── 2) Teams and standings ────────────────────────────────────────────
  const tj = await get(`${SITE}/teams`);
  const teams = {};
  for (const x of tj.sports?.[0]?.leagues?.[0]?.teams || []) {
    const t = x.team;
    teams[t.abbreviation] = { id: t.id, ab: t.abbreviation, name: t.shortDisplayName, full: t.displayName, loc: t.location,
      color: t.color ? '#' + t.color : null, alt: t.alternateColor ? '#' + t.alternateColor : null,
      // both cuts, by what the feed labels them (ESPN's 500-dark folder is incomplete)
      logo: (t.logos || []).find(l => l.rel?.includes('default'))?.href || t.logos?.[0]?.href || null,
      logoDark: (t.logos || []).find(l => l.rel?.includes('dark') && !l.rel.includes('scoreboard'))?.href || null };
  }
  const st = await get(`${SITE2}/standings`);
  for (const conf of st.children || []) for (const e of conf.standings?.entries || []) {
    const t = teams[e.team.abbreviation]; if (!t) continue;
    const v = Object.fromEntries(e.stats.map(s => [s.name, s]));
    Object.assign(t, { conf: conf.abbreviation || (conf.name.startsWith('East') ? 'East' : 'West'),
      w: +(v.wins?.value ?? 0), l: +(v.losses?.value ?? 0), seed: +(v.playoffSeed?.value ?? 0) || null,
      ppg: num(v.avgPointsFor?.value), oppg: num(v.avgPointsAgainst?.value), streak: v.streak?.displayValue || null });
  }

  // ── 3) Schedule window: lines and scores ──────────────────────────────
  const schedule = (await events(shiftDate(today, -BEHIND), shiftDate(today, AHEAD))).map(e => {
    const c = e.competitions[0], side = Object.fromEntries(c.competitors.map(x => [x.homeAway, x]));
    const o = c.odds?.[0];
    const sp = num(o?.spread), tot = num(o?.overUnder);
    const lines = o ? { book: o.provider?.name || null, spread: sp, total: tot, detail: o.details || null,
      mlHome: num(o.homeTeamOdds?.moneyLine), mlAway: num(o.awayTeamOdds?.moneyLine),
      // implied points: total/2 minus half the home spread (negative spread = home favoured)
      impHome: sp != null && tot != null ? +(tot / 2 - sp / 2).toFixed(1) : null,
      impAway: sp != null && tot != null ? +(tot / 2 + sp / 2).toFixed(1) : null } : null;
    const team = (x) => ({ ab: x.team.abbreviation, score: num(x.score), rec: x.records?.[0]?.summary || null });
    return { id: e.id, start: e.date, date: etDate(new Date(e.date)), type: e.season?.type ?? null,
      state: c.status?.type?.state || 'pre', detail: c.status?.type?.shortDetail || '', venue: c.venue?.fullName || null,
      note: c.notes?.[0]?.headline || null, home: team(side.home), away: team(side.away), lines };
  }).sort((a, b) => a.start.localeCompare(b.start));
  console.log(`Schedule: ${schedule.length} games ${shiftDate(today, -BEHIND)} → ${shiftDate(today, AHEAD)}`);

  // ── 4) Player state from new finals (regular season, play-in, playoffs) ─
  const priors = readJSON(PRIORS_PATH, null);
  let state = readJSON(STATE_PATH, null);
  if (!state || state.season !== label) state = freshState(label, priors);
  const seasonStart = phases.find(p => p.key === 'reg')?.start || now.start;
  const scanFrom = state.done.length ? shiftDate(today, -RECAP_DAYS) : seasonStart;
  const finals = [];
  if (scanFrom <= today) {
    var pastEvents = await events(scanFrom, today);
    for (const e of pastEvents) {
      if (e.competitions?.[0]?.status?.type?.state !== 'post') continue;
      if (![2, 3, 5].includes(e.season?.type)) continue;
      finals.push({ id: e.id, date: etDate(new Date(e.date)), type: e.season.type });
    }
  }
  const seen = new Set(state.done);
  const todo = finals.filter(f => !seen.has(f.id)).sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id));
  const reduced = await pool(todo, 6, async (f) => { try { return reduceSummary(await get(`${SITE}/summary?event=${f.id}`), f); } catch (e) { return null; } });
  for (const r of reduced) if (r) applyGame(state, r);
  console.log(`Player state: ${todo.length} new finals applied (${state.done.length} this season)`);

  // ── 5) Recap: the finals of the last three weeks, with each side's leaders ─
  const recap = [];
  if (finals.length) {
    const recent = finals.filter(f => f.date >= shiftDate(today, -RECAP_DAYS)).map(f => f.id);
    const byId = new Map(pastEvents.map(e => [e.id, e]));
    for (const id of recent) {
      const e = byId.get(id); if (!e) continue;
      const c = e.competitions[0], side = Object.fromEntries(c.competitors.map(x => [x.homeAway, x]));
      const lead = (x) => Object.fromEntries((x.leaders || []).map(L => [L.name, L.leaders?.[0] ? { pid: L.leaders[0].athlete?.id, name: L.leaders[0].athlete?.shortName, v: L.leaders[0].displayValue } : null]));
      recap.push({ id, date: etDate(new Date(e.date)), type: e.season?.type, note: c.notes?.[0]?.headline || null,
        home: { ab: side.home.team.abbreviation, score: num(side.home.score), leaders: lead(side.home) },
        away: { ab: side.away.team.abbreviation, score: num(side.away.score), leaders: lead(side.away) } });
    }
  }

  // ── 6) Injuries ───────────────────────────────────────────────────────
  const injuries = {};
  try {
    const ij = await get(`${SITE}/injuries`);
    for (const t of ij.injuries || []) for (const x of t.injuries || []) {
      const id = x.athlete?.links?.[0]?.href?.match(/\/id\/(\d+)/)?.[1] || x.athlete?.id; if (!id) continue;
      injuries[id] = { status: x.status || x.type?.description || null, detail: x.shortComment || null, date: x.date?.slice(0, 10) || null };
    }
  } catch (e) { console.log('injuries unavailable'); }

  // ── 7) Leader boards: this season, or last season's before opening night ─
  const played = Object.entries(state.players).filter(([, p]) => p.gp > 0);
  const fromPriors = played.length < 30;
  const src = fromPriors
    ? Object.entries(priors?.players || {}).filter(([, p]) => p.prev?.gp >= 10).map(([pid, p]) => [pid, { ...p, ...p.prev }])
    : played;
  const leaders = src.map(([pid, p]) => {
    const g = p.gp || 1, r = (k) => +(p[k] / g).toFixed(1);
    return { pid, name: p.name, team: p.team, pos: p.pos, gp: p.gp, gs: p.gs, min: r('min'), pts: r('pts'), reb: r('reb'), ast: r('ast'),
      tpm: r('tpm'), stl: r('stl'), blk: r('blk'), tpPct: p.tpa ? +(p.tpm / p.tpa).toFixed(3) : null, fgPct: p.fga ? +(p.fgm / p.fga).toFixed(3) : null };
  }).filter(x => x.gp >= (fromPriors ? 20 : 1)).sort((a, b) => b.pts - a.pts).slice(0, LEADERS);

  const data = { generated: new Date().toISOString(), today, season: label, phase: now.key, phaseName: now.name, phases,
    leadersFrom: fromPriors ? state.priorsSeason : label, teams, schedule, recap, injuries, leaders };
  fs.writeFileSync(OUT, JSON.stringify(data));
  fs.writeFileSync(STATE_PATH, JSON.stringify(state));
  console.log(`Wrote nba/data.json — ${Object.keys(teams).length} teams, ${schedule.length} scheduled, ${recap.length} recapped, ${leaders.length} leaders (${fromPriors ? 'last season' : 'this season'}), ${Object.keys(injuries).length} injured`);
}

main().catch(e => { console.error(e); process.exit(1); });
