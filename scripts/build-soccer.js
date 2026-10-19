// Ron's Goal Tool — soccer data build (MLS first). Mirrors build-nba.js: fetch
// the open ESPN endpoints (no key), shape them, write soccer/data.json.
//   site /scoreboard?dates=  -> the season, its calendar of match days, the
//                               schedule window, DraftKings lines, scores
//   site /teams, v2 /standings -> every club, its table row
//   site /teams/{id}/roster  -> current squads (who plays where, and for whom)
//   site /summary?event=     -> each final: lineups, subs, goals, player box
//
// Player state (soccer/players.json) is the season's running totals, rolled
// forward from new finals only. The recap's per-player box scores live in
// soccer/recap.json (lazy-loaded), the league trend's rows in
// soccer/league-days.json. Nothing here needs editing next season: the season
// and its match days are read off the feed.
import fs from 'node:fs';
import { get, pool, SITE, SITE2, etDate, shiftDate, compact } from './soccer-api.js';
import { reduceSummary, freshState, applyGame, posFam, STATE_VERSION } from './soccer-state.js';

const AHEAD = 14;        // schedule days ahead (a week has a weekend and maybe a midweek round)
const BEHIND = 4;        // ...and behind (last weekend's finals stay on the schedule)
const RECAP_DAYS = 28;   // finals kept for the recap
const LEADERS = 300;     // players on the Stats board
const STATE_PATH = new URL('../soccer/players.json', import.meta.url);
const RECAP_PATH = new URL('../soccer/recap.json', import.meta.url);
const DAYS_PATH = new URL('../soccer/league-days.json', import.meta.url);
const OUT = new URL('../soccer/data.json', import.meta.url);

const readJSON = (u, d) => { try { return JSON.parse(fs.readFileSync(u, 'utf8')); } catch (e) { return d; } };
const num = (v) => { const x = parseFloat(v); return Number.isFinite(x) ? x : null; };

// ── Lines: DraftKings' three-way moneyline and total, devigged, and the goals they imply ──
const am2p = (o) => { const x = num(o); return x == null ? null : x > 0 ? 100 / (x + 100) : -x / (-x + 100); };
/** Power devig: the k that makes the prices' p^k sum to one (research/devig_study.py: power is best or tied). */
function devig(ps) {
  if (ps.some(p => p == null)) return null;
  let lo = 0.5, hi = 2;
  for (let i = 0; i < 60; i++) { const k = (lo + hi) / 2, s = ps.reduce((a, p) => a + p ** k, 0); if (s > 1) lo = k; else hi = k; }
  const k = (lo + hi) / 2; return ps.map(p => p ** k);
}
const pois = (l, K = 12) => { const o = [Math.exp(-l)]; for (let i = 1; i <= K; i++) o.push(o[i - 1] * l / i); return o; };
/** The goal model's outcome probabilities for (home, away) means: win/draw/win and the over at line L (pushes dropped, quarter lines split). */
function outcome(lh, la, L) {
  const H = pois(lh), A = pois(la); let ph = 0, pd = 0, pa = 0; const tot = new Array(26).fill(0);
  for (let i = 0; i < H.length; i++) for (let j = 0; j < A.length; j++) { const p = H[i] * A[j]; if (i > j) ph += p; else if (i === j) pd += p; else pa += p; tot[i + j] += p; }
  const over = (x) => { let o = 0, u = 0; for (let t = 0; t < tot.length; t++) { if (t > x) o += tot[t]; else if (t < x) u += tot[t]; } return o / (o + u); };
  const q = L * 4 % 2 === 1 ? (over(L - 0.25) + over(L + 0.25)) / 2 : over(L);
  return { ph, pd, pa, over: q };
}
/** The (home, away) goal means that best reproduce the devigged 1X2 and total: a coarse grid, then a fine one. */
function impliedGoals(P, L, pOver) {
  const err = (lh, la) => { const o = outcome(lh, la, L); return (o.ph - P[0]) ** 2 + (o.pd - P[1]) ** 2 + (o.pa - P[2]) ** 2 + (pOver == null ? 0 : (o.over - pOver) ** 2); };
  let best = [1.4, 1.1], be = Infinity;
  for (let lh = 0.2; lh <= 4; lh += 0.05) for (let la = 0.2; la <= 4; la += 0.05) { const e = err(lh, la); if (e < be) { be = e; best = [lh, la]; } }
  const [h0, a0] = best;
  for (let lh = h0 - 0.05; lh <= h0 + 0.05; lh += 0.005) for (let la = a0 - 0.05; la <= a0 + 0.05; la += 0.005) { const e = err(lh, la); if (e < be) { be = e; best = [lh, la]; } }
  return best.map(x => +x.toFixed(2));
}
function linesOf(o) {
  if (!o) return null;
  const close = (x) => x?.close?.odds ?? x?.open?.odds;
  const mlHome = num(close(o.moneyline?.home)), mlAway = num(close(o.moneyline?.away)), mlDraw = num(o.drawOdds?.moneyLine);
  const total = num(o.overUnder);
  const over = num(o.total?.over?.close?.odds ?? o.total?.over?.open?.odds), under = num(o.total?.under?.close?.odds ?? o.total?.under?.open?.odds);
  const spread = num(o.pointSpread?.home?.close?.line ?? o.pointSpread?.home?.open?.line);
  const L = { book: o.provider?.name || null, mlHome, mlDraw, mlAway, total, over, under, spread,
    spreadHome: num(o.pointSpread?.home?.close?.odds), spreadAway: num(o.pointSpread?.away?.close?.odds),
    openHome: num(o.moneyline?.home?.open?.odds), openAway: num(o.moneyline?.away?.open?.odds) };
  const P = devig([am2p(mlHome), am2p(mlDraw), am2p(mlAway)]);
  if (P) {
    const T = over != null && under != null ? devig([am2p(over), am2p(under)]) : null;
    [L.pHome, L.pDraw, L.pAway] = P.map(p => +p.toFixed(3));
    if (total != null) [L.impHome, L.impAway] = impliedGoals(P, total, T ? T[0] : null);
  }
  return L;
}

async function main() {
  fs.mkdirSync(new URL('../soccer/', import.meta.url), { recursive: true });   // the first build makes the folder
  const today = etDate();
  // ── 1) The season and its calendar of match days ────────────────────────
  const sb0 = await get(`${SITE}/scoreboard?dates=${compact(today)}`);
  const lg = sb0.leagues?.[0] || {};
  const season = lg.season?.displayName || String(lg.season?.year || today.slice(0, 4));   // "2026 MLS"
  const calendar = [...new Set((lg.calendar || []).map(d => (typeof d === 'string' ? d : d.startDate || '').slice(0, 10)).filter(Boolean))].sort();
  const seasonStart = calendar[0] || today;
  console.log(`Season ${season}: ${calendar.length} match days, ${seasonStart} → ${calendar[calendar.length - 1]} (${lg.season?.type?.name || ''})`);

  // events on the calendar's days in [from, to] (one scoreboard each)
  const dayCache = new Map([[today, sb0.events || []]]);
  async function events(from, to) {
    const days = calendar.filter(d => d >= from && d <= to);
    const all = await pool(days, 6, async (d) => {
      if (!dayCache.has(d)) { try { dayCache.set(d, (await get(`${SITE}/scoreboard?dates=${compact(d)}`)).events || []); } catch (e) { dayCache.set(d, []); } }
      return dayCache.get(d);
    });
    const byId = new Map(); for (const e of all.flat()) byId.set(e.id, e);
    return [...byId.values()];
  }

  // ── 2) Teams, the table, current squads ─────────────────────────────────
  const tj = await get(`${SITE}/teams`);
  const teams = {};
  for (const x of tj.sports?.[0]?.leagues?.[0]?.teams || []) {
    const t = x.team;
    teams[t.abbreviation] = { id: t.id, ab: t.abbreviation, name: t.shortDisplayName, full: t.displayName,
      color: t.color ? '#' + t.color : null, alt: t.alternateColor ? '#' + t.alternateColor : null,
      logo: (t.logos || []).find(l => l.rel?.includes('default'))?.href || t.logos?.[0]?.href || null,
      logoDark: (t.logos || []).find(l => l.rel?.includes('dark') && l.rel.includes('full') && l.href.includes('500-dark'))?.href || null };
  }
  try {
    const st = await get(`${SITE2}/standings`);
    for (const conf of st.children || []) for (const e of conf.standings?.entries || []) {
      const t = teams[e.team?.abbreviation]; if (!t) continue;
      const v = Object.fromEntries((e.stats || []).map(s => [s.name, s]));
      Object.assign(t, { conf: conf.abbreviation || conf.name?.split(' ')[0], rank: num(v.rank?.value), gp: num(v.gamesPlayed?.value),
        w: num(v.wins?.value) ?? 0, d: num(v.ties?.value) ?? 0, l: num(v.losses?.value) ?? 0, pts: num(v.points?.value),
        gf: num(v.pointsFor?.value), ga: num(v.pointsAgainst?.value) });
    }
  } catch (e) { console.log('standings unavailable'); }
  const rosters = new Map(await pool(Object.values(teams), 6, async (t) => {
    try { return [t.ab, (await get(`${SITE}/teams/${t.id}/roster`)).athletes || []]; } catch (e) { return [t.ab, null]; }
  }));
  const squad = {};                                // pid -> { team, pos, jersey, age }
  for (const [ab, list] of rosters) for (const a of list || [])
    squad[a.id] = { team: ab, pos: posFam(a.position?.abbreviation), hs: a.headshot ? 1 : 0 };

  // ── 3) The schedule window: lines and scores ────────────────────────────
  const schedule = (await events(shiftDate(today, -BEHIND), shiftDate(today, AHEAD))).map(e => {
    const c = e.competitions[0], side = Object.fromEntries(c.competitors.map(x => [x.homeAway, x]));
    const team = (x) => ({ ab: x.team.abbreviation, score: num(x.score), rec: x.records?.[0]?.summary || null, form: x.form || null });
    return { id: e.id, start: e.date, date: etDate(new Date(e.date)), slug: e.season?.slug || null,
      state: c.status?.type?.state || 'pre', detail: c.status?.type?.shortDetail || '', venue: c.venue?.fullName || null,
      note: c.notes?.[0]?.headline || null, conf: c.group?.abbreviation || null, tv: c.broadcasts?.[0]?.names?.[0] || null,
      home: team(side.home), away: team(side.away), lines: linesOf(c.odds?.[0]) };
  }).sort((a, b) => a.start.localeCompare(b.start) || a.id.localeCompare(b.id));
  const nextDay = calendar.find(d => d > shiftDate(today, AHEAD)) || null;   // past the window: the Home page's "next up"
  console.log(`Schedule: ${schedule.length} games ${shiftDate(today, -BEHIND)} → ${shiftDate(today, AHEAD)}, ${schedule.filter(g => g.lines?.impHome != null).length} with implied goals`);

  // ── 4) Player state from new finals ─────────────────────────────────────
  let state = readJSON(STATE_PATH, null);
  if (!state || state.season !== season || (state.version !== STATE_VERSION && !state.done.length)) state = freshState(season, state);
  const scanFrom = state.done.length ? shiftDate(today, -RECAP_DAYS) : seasonStart;
  const past = (await events(scanFrom < shiftDate(today, -RECAP_DAYS) ? scanFrom : shiftDate(today, -RECAP_DAYS), today))
    .filter(e => e.competitions?.[0]?.status?.type?.state === 'post' && e.competitions[0].status.type.completed !== false);
  const finals = past.map(e => ({ id: e.id, date: etDate(new Date(e.date)), slug: e.season?.slug || null }))
    .sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id));
  const seen = new Set(state.done);
  const recapOld = readJSON(RECAP_PATH, { games: {} });
  const recapFrom = shiftDate(today, -RECAP_DAYS);
  const todo = finals.filter(f => !seen.has(f.id));
  const recapTodo = finals.filter(f => f.date >= recapFrom && !recapOld.games?.[f.id]);
  const want = [...new Map([...todo, ...recapTodo].map(f => [f.id, f])).values()];
  const got = new Map(await pool(want, 6, async (f) => {
    try { return [f.id, reduceSummary(await get(`${SITE}/summary?event=${f.id}`), f)]; } catch (e) { return [f.id, null]; }
  }));
  let applied = 0;
  for (const f of todo) { const r = got.get(f.id); if (r) { applyGame(state, r); applied++; } }
  console.log(`Player state: ${applied}/${todo.length} new finals applied (${state.done.length} this season)`);

  // ── 5) Recap: the last four weeks of finals ─────────────────────────────
  // data.json carries each game's goals and team box (Home, Recap, Schedule);
  // recap.json the per-player box, loaded when a final is opened.
  const recapGames = { ...(recapOld.games || {}) };
  for (const f of recapTodo) {
    const r = got.get(f.id); if (!r) continue;
    recapGames[f.id] = { date: r.date, slug: r.slug, len: r.len, home: r.home, away: r.away, goals: r.goals, box: r.box,
      // [pid, name, team, gamePos, starter, min, g, a, sh, sot, yc, rc, headshot]
      players: r.players.map(p => [p.pid, p.name, p.team, p.gpos, p.starter ? 1 : 0, p.min, p.g, p.a, p.sh, p.sot, p.yc, p.rc, p.hs]) };
  }
  for (const [id, g] of Object.entries(recapGames)) if (g.date < recapFrom) delete recapGames[id];
  fs.writeFileSync(RECAP_PATH, JSON.stringify({ season, games: recapGames }));
  const recap = Object.entries(recapGames).map(([id, g]) => ({ id, date: g.date, slug: g.slug, len: g.len, home: g.home, away: g.away, goals: g.goals, box: g.box }))
    .sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id));
  console.log(`Recap: ${recap.length} finals since ${recapFrom} (${recapTodo.length} new)`);

  // ── 6) League days: one row per regular-season final, for the Stats trend ─
  const LD = readJSON(DAYS_PATH, null);
  const days = LD?.season === season ? LD : { season, games: {} };
  for (const f of todo) {
    const r = got.get(f.id); if (!r || f.slug !== 'regular-season') continue;
    const b = r.box;
    days.games[f.id] = [r.date, r.away.ab, r.home.ab, r.away.score, r.home.score, b[r.away.ab]?.sh ?? null, b[r.home.ab]?.sh ?? null, b[r.away.ab]?.sot ?? null, b[r.home.ab]?.sot ?? null];
  }
  fs.writeFileSync(DAYS_PATH, JSON.stringify(days));
  console.log(`League days: ${Object.keys(days.games).length} regular-season finals logged`);

  // ── 7) Leaders: season totals; last season's until 30 players have played ─
  const played = Object.entries(state.players).filter(([, p]) => p.gp > 0);
  const fromPrev = played.length < 30 && state.prev;
  const src = fromPrev ? Object.entries(state.prev.players) : played;
  const famOf = (pid, p) => squad[pid]?.pos || Object.entries(p.fam || {}).sort((a, b) => b[1] - a[1])[0]?.[0] || null;
  // a player files under his current squad (he may have moved since), else the club he last played for
  const row = ([pid, p]) => ({ pid, name: p.name, team: (fromPrev ? p.team : squad[pid]?.team || p.team), pos: famOf(pid, p),
    hs: squad[pid]?.hs || p.hs ? 1 : 0, gp: p.gp, gs: p.gs, min: p.min, g: p.g, a: p.a, sh: p.sh, sot: p.sot, pk: p.pk, yc: p.yc, rc: p.rc });
  const leaders = src.filter(([, p]) => p.min > 0).map(row)
    .sort((a, b) => b.g - a.g || b.a - a.a || b.sot - a.sot || b.min - a.min).slice(0, LEADERS);
  // ...plus everyone else's attacking totals, so a sort by shots or assists isn't cut off by the goals ranking
  const inTop = new Set(leaders.map(l => l.pid));
  leaders.push(...src.filter(([pid, p]) => p.min > 0 && !inTop.has(pid) && (p.sh >= 10 || p.a >= 2 || p.min >= 900)).map(row));

  const data = { generated: new Date().toISOString(), today, league: 'MLS', season, seasonStart, calendar, nextDay,
    leadersFrom: fromPrev ? state.prev.season : season, teams, schedule, recap, leaders };
  fs.writeFileSync(OUT, JSON.stringify(data));
  fs.writeFileSync(STATE_PATH, JSON.stringify(state));
  console.log(`Wrote soccer/data.json — ${Object.keys(teams).length} teams, ${schedule.length} scheduled, ${recap.length} recapped, ${leaders.length} players (${fromPrev ? 'last season' : 'this season'})`);
}

main().catch(e => { console.error(e); process.exit(1); });
