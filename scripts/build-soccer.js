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
import { am2p, devig, impliedGoals } from './soccer-lines.js';
import { freshGoalState, applyGoalGame, goalFeatures, teamFeatures, goalPrice, goalFactors, GOALS_VERSION } from './soccer-goals.js';
import { shotLadder } from './soccer-shots.js';

const AHEAD = 14;        // schedule days ahead (a week has a weekend and maybe a midweek round)
const BEHIND = 4;        // ...and behind (last weekend's finals stay on the schedule)
const RECAP_DAYS = 28;   // finals kept for the recap
const LEADERS = 300;     // players on the Stats board
const STATE_PATH = new URL('../soccer/players.json', import.meta.url);
const RECAP_PATH = new URL('../soccer/recap.json', import.meta.url);
const DAYS_PATH = new URL('../soccer/league-days.json', import.meta.url);
const OUT = new URL('../soccer/data.json', import.meta.url);
const GOAL_STATE = new URL('../soccer/goal-state.json', import.meta.url);   // the goal model's history (soccer-goals.js)
const GOAL_MODEL = new URL('../soccer/goals-model.json', import.meta.url);  // research/soccer_goals.py
const GOAL_HIST = new URL('../soccer/goals-history.json', import.meta.url); // each game's last pre-kickoff prices, for grading
const SHOT_MODEL = new URL('../soccer/shots-model.json', import.meta.url);  // research/soccer_shots.py
const PMF_TOP = { sh: 7, sot: 4 };   // a stored distribution's last bucket holds the tail (7+ shots, 4+ on target)
const SEED_SEASONS = 2;    // the goal history starts this many seasons back (a player's last 40 appearances)
const HIST_DAYS = 35;      // graded prices kept

const readJSON = (u, d) => { try { return JSON.parse(fs.readFileSync(u, 'utf8')); } catch (e) { return d; } };
const num = (v) => { const x = parseFloat(v); return Number.isFinite(x) ? x : null; };

// DraftKings' three-way moneyline and total off the scoreboard, devigged, and the goals they imply
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

  // ── 4b) The goal model's history: two seasons back on the first run, then new finals ──
  let GS = readJSON(GOAL_STATE, null);
  if (!GS || GS.version !== GOALS_VERSION) {
    GS = freshGoalState();
    const yr = +season.slice(0, 4) || +today.slice(0, 4), seed = [];
    for (let y = yr - SEED_SEASONS; y <= yr; y++) {
      const cal = y === yr ? calendar : [...new Set(((await get(`${SITE}/scoreboard?dates=${y}0510`)).leagues?.[0]?.calendar || [])
        .map(d => (typeof d === 'string' ? d : d.startDate || '').slice(0, 10)))].filter(d => d.startsWith(String(y)));
      const evs = (await pool(cal.filter(d => d <= today), 6, async (d) => { try { return (await get(`${SITE}/scoreboard?dates=${compact(d)}`)).events || []; } catch (e) { return []; } })).flat();
      seed.push(...evs.filter(e => e.competitions?.[0]?.status?.type?.state === 'post').map(e => ({ id: e.id, date: etDate(new Date(e.date)), start: e.date, slug: e.season?.slug || null })));
    }
    const uniq = [...new Map(seed.map(f => [f.id, f])).values()].sort((a, b) => a.start.localeCompare(b.start) || a.id.localeCompare(b.id));
    const red = await pool(uniq, 6, async (f) => got.get(f.id) || (await get(`${SITE}/summary?event=${f.id}`).then(s => reduceSummary(s, f)).catch(() => null)));
    for (const r of red) if (r) applyGoalGame(GS, r);
    console.log(`Goal history seeded: ${red.filter(Boolean).length} finals since ${SEED_SEASONS} seasons back`);
  } else {
    for (const f of finals) { const r = got.get(f.id); if (r) applyGoalGame(GS, r); }   // applyGoalGame skips a game it has
  }
  // a player not seen in 400 days has left the league's rotations
  const cut = shiftDate(today, -400);
  for (const [pid, P] of Object.entries(GS.players)) if (!(P.apps.at(-1)?.[1] >= cut)) delete GS.players[pid];
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

  // ── 6b) Goals, shots and shots on target: every player in a rotation, priced for his team's next game ──
  // Each team's next game still to play (the rest of the schedule's two weeks
  // can wait for fresher minutes), priced off current squads; a game that has
  // kicked off keeps its rows as they stood before kickoff for the day.
  // Lineups post about an hour out: once they do, a player outside the
  // matchday squad drops off, and goals, shots and on target re-price off the
  // known role (XI, or a named sub, who comes on about 56% of the time).
  const GM = readJSON(GOAL_MODEL, null);
  let goals = null;
  if (GM) {
    const SM = readJSON(SHOT_MODEL, null);
    const next = new Map();                               // team -> its next game still to play
    for (const g of schedule) if (g.state === 'pre' && g.date >= today) for (const ab of [g.home.ab, g.away.ab]) if (!next.has(ab)) next.set(ab, g);
    const prevData = readJSON(OUT, {});
    const frozen = prevData.goals?.rows || [];
    const started = schedule.filter(g => g.state !== 'pre' && Date.now() - Date.parse(g.start) < 18 * 3600e3 && frozen.some(r => r.gid === g.id));
    const round = [...new Map([...started, ...next.values()].map(g => [g.id, g])).values()].sort((a, b) => a.start.localeCompare(b.start));
    const first = round.find(g => g.state === 'pre')?.date || round[0]?.date;
    const rows = [];
    for (const g of round) {
      if (g.state !== 'pre') { rows.push(...frozen.filter(r => r.gid === g.id)); continue; }
      let squads = null;                                     // the matchday squads, once posted
      if (Date.parse(g.start) - Date.now() < 3 * 3600e3) {
        try {
          const s = await get(`${SITE}/summary?event=${g.id}`);
          const R = (s.rosters || []).filter(r => r.roster?.length);
          if (R.length === 2) squads = Object.fromEntries(R.map(r => [r.team?.abbreviation, new Map(r.roster.map(x => [x.athlete?.id, x.starter ? 'XI' : 'bench']))]));
        } catch (e) { /* no lineups yet */ }
      }
      for (const [ab, opp, home] of [[g.home.ab, g.away.ab, true], [g.away.ab, g.home.ab, false]]) {
        const imp = g.lines?.impHome != null ? (home ? g.lines.impHome : g.lines.impAway) : null;
        const tf = teamFeatures(GS, ab, opp);
        for (const a of rosters.get(ab) || []) {
          const f = goalFeatures(GS, a.id, ab); if (!f) continue;
          const xi = squads?.[ab] ? squads[ab].get(a.id) || 'out' : null;
          if (xi === 'out') continue;
          // every price is "if he plays": books void a player prop when he doesn't take part, so his
          // chance of sitting comes out (it put a fringe player at +4595 against a book's +307)
          const P0 = goalPrice(f, { imp, home }, GM, xi), play = P0.ps + P0.pb;
          if (!(play > 0.01)) continue;
          const P = { ...P0, p: P0.p / play }, FX = goalFactors(f, { imp, home }, GM, P);
          // shots and on target: the distribution (its last bucket the tail) and the role it assumes
          const shot = {};
          if (SM && tf.osha != null) for (const kind of ['sh', 'sot']) {
            const S = shotLadder(f, tf, { home }, SM, kind, xi);
            const cond = S.pmf.map((v, i) => Math.max(0, i === 0 ? v - (1 - play) : v) / play);    // if he plays
            const top = PMF_TOP[kind], pmf = cond.slice(0, top); pmf.push(Math.max(0, 1 - pmf.reduce((x, y) => x + y, 0)));
            shot[kind] = { pmf: pmf.map(v => +v.toFixed(4)), ps: +S.ps.toFixed(3), pb: +S.pb.toFixed(3),
              mu: +(S.mu / play).toFixed(3), muSt: +S.muStart.toFixed(2), muSub: +S.muSub.toFixed(2), r90: +(kind === 'sh' ? S.sh90 : S.sot90).toFixed(2) };
          }
          if (shot.sh) Object.assign(shot, { stMin: f.stMin, subMin: f.subMin, osha: +tf.osha.toFixed(1) });
          rows.push({ gid: g.id, start: g.start, pid: a.id, name: a.displayName, team: ab, opp, home, pos: squad[a.id]?.pos || f.pos, hs: squad[a.id]?.hs || 0,
            p: +P.p.toFixed(4), pAll: +P0.p.toFixed(4), play: +play.toFixed(3), ps: +P.ps.toFixed(3), pb: +P.pb.toFixed(3), mu: +(P.mu / play).toFixed(3), muPk: +P.muPk.toFixed(3), em: +P.x.em.toFixed(1), st5: f.st5, imp, noLine: imp == null ? 1 : 0, xi,
            g90: +P.x.g90.toFixed(3), sh90: +P.x.sh90.toFixed(2), sot90: +P.x.sot90.toFixed(2), pk: +(f.pkShare || 0).toFixed(2), pkN: f.pkN,
            apps: f.apps, np: f.np, shots: f.sh, sots: f.sot, min: f.min, fx: FX, ...shot });
        }
      }
    }
    rows.sort((a, b) => b.p - a.p);
    goals = { from: first || null, to: round.at(-1)?.date || null, generated: new Date().toISOString(),
      model: GM.meta?.walkForward || null, shotsModel: SM ? { sh: SM.sh.meta?.walkForward, sot: SM.sot.meta?.walkForward, lines: { sh: SM.sh.lines, sot: SM.sot.lines } } : null, rows };
    // the last pre-kickoff price of every priced player, by date and game: Recap and Schedule grade off it
    const H = readJSON(GOAL_HIST, { days: {} });
    // { g: P(goal), sh: [mu, P(o0.5), P(o1.5) …], sot: […] } per player (a bare number is an older goal-only entry)
    const lad = (S, kind) => S ? [S.mu, ...SM[kind].lines.map(L => +(1 - S.pmf.slice(0, Math.floor(L) + 1).reduce((x, y) => x + y, 0)).toFixed(4))] : undefined;
    for (const r of rows) if (new Date(r.start) > new Date()) {
      const d = etDate(new Date(r.start));
      ((H.days[d] ||= {})[r.gid] ||= {})[r.pid] = { g: r.p, sh: lad(r.sh, 'sh'), sot: lad(r.sot, 'sot') };
    }
    for (const d of Object.keys(H.days)) if (d < shiftDate(today, -HIST_DAYS)) delete H.days[d];
    fs.writeFileSync(GOAL_HIST, JSON.stringify(H));
    const topSh = rows.filter(r => r.sh).sort((a, b) => b.sh.mu - a.sh.mu)[0];
    console.log(`Goals: ${rows.length} players priced across ${round.length} games (${first || 'no round'}), top ${rows[0] ? `${rows[0].name} ${(rows[0].p * 100).toFixed(1)}%` : '—'}; shots ${rows.filter(r => r.sh).length}${topSh ? `, top ${topSh.name} ${topSh.sh.mu.toFixed(2)}` : ''}`);
  } else console.log('Goals: no soccer/goals-model.json, board skipped');

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
    leadersFrom: fromPrev ? state.prev.season : season, teams, schedule, recap, leaders, goals };
  fs.writeFileSync(OUT, JSON.stringify(data));
  fs.writeFileSync(STATE_PATH, JSON.stringify(state));
  fs.writeFileSync(GOAL_STATE, JSON.stringify(GS));
  console.log(`Wrote soccer/data.json — ${Object.keys(teams).length} teams, ${schedule.length} scheduled, ${recap.length} recapped, ${leaders.length} players (${fromPrev ? 'last season' : 'this season'})`);
}

main().catch(e => { console.error(e); process.exit(1); });
