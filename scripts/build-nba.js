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
import { reduceSummary, freshState, applyGame, BOX, STATE_VERSION } from './nba-state.js';
import { MODEL, fam, minutesInputs, projectMinutes, threesRate, oppThreesRatio, threesMu, threesLadder, pWinTip, pTeamFirst, fbWeight,
  statRate, statForm, statOpp, statMu, statLadder, doublesPrice } from './nba-models.js';
import { buildFun } from './nba-fun.js';
import { recapDetail, saveRecap, recapHas, savePrices, leagueRow, saveLeagueDays } from './nba-recap.js';

const AHEAD = 10;        // schedule days ahead
const BEHIND = 3;        // ...and behind (yesterday's finals stay on the schedule)
const RECAP_DAYS = 21;   // finals kept for the recap
const LEADERS = 250;     // players on the Stats board
const STATE_PATH = new URL('../nba/players.json', import.meta.url);
const PRIORS_PATH = new URL('../nba/priors.json', import.meta.url);
const OUT = new URL('../nba/data.json', import.meta.url);

const readJSON = (u, d) => { try { return JSON.parse(fs.readFileSync(u, 'utf8')); } catch (e) { return d; } };
const num = (v) => { const x = parseFloat(v); return Number.isFinite(x) ? x : null; };
const PHASE = { 1: 'pre', 2: 'reg', 3: 'post', 4: 'off', 5: 'playin' };

// The NBA scoreboard takes one day at a time (a dates=a-b range is a 400, unlike
// the NFL's), so a window is fetched day by day and merged.
async function events(from, to) {
  const days = []; for (let d = from; d <= to; d = shiftDate(d, 1)) days.push(d);
  const all = await pool(days, 6, async (d) => { try { return (await get(`${SITE}/scoreboard?dates=${compact(d)}&limit=100`)).events || []; } catch (e) { return []; } });
  const byId = new Map(); for (const e of all.flat()) byId.set(e.id, e);
  return [...byId.values()];
}

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
  // a new season, or a state from before a shape change (re-seeded only while no games of the season are in it)
  if (!state || state.season !== label || (state.version !== STATE_VERSION && !state.done.length)) state = freshState(label, priors);
  const seasonStart = phases.find(p => p.key === 'reg')?.start || now.start;
  const scanFrom = state.done.length ? shiftDate(today, -RECAP_DAYS) : seasonStart;
  // the recap also covers preseason finals (never the models' state), so its window always reaches back
  const recapFrom = shiftDate(today, -RECAP_DAYS);
  const finalsAll = [];
  var pastEvents = await events(scanFrom < recapFrom ? scanFrom : recapFrom, today);
  for (const e of pastEvents) {
    if (e.competitions?.[0]?.status?.type?.state !== 'post') continue;
    if (![1, 2, 3, 5].includes(e.season?.type)) continue;
    finalsAll.push({ id: e.id, date: etDate(new Date(e.date)), type: e.season.type });
  }
  const finals = finalsAll.filter(f => f.type !== 1 && f.date >= scanFrom);
  const seen = new Set(state.done), inRecap = recapHas();
  const todo = finals.filter(f => !seen.has(f.id)).sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id));
  const recapTodo = finalsAll.filter(f => f.date >= recapFrom && !inRecap.has(f.id));
  const want = [...new Map([...todo, ...recapTodo].map(f => [f.id, f])).values()];
  const got = new Map(await pool(want, 6, async (f) => {
    try { const s = await get(`${SITE}/summary?event=${f.id}`); return [f.id, { s, r: reduceSummary(s, f) }]; } catch (e) { return [f.id, null]; }
  }));
  for (const f of todo) { const x = got.get(f.id); if (x?.r) applyGame(state, x.r); }
  console.log(`Player state: ${todo.length} new finals applied (${state.done.length} this season)`);
  console.log(`League days: ${saveLeagueDays(todo.map(f => { const x = got.get(f.id); return x?.r ? leagueRow(x.r) : null; }), label)} regular-season finals logged`);
  const recapKept = saveRecap(recapTodo.map(f => { const x = got.get(f.id); return x?.r ? recapDetail(x.s, f, x.r) : null; }), today, RECAP_DAYS, shiftDate);
  console.log(`Recap detail: ${recapTodo.length} new finals, ${recapKept} kept`);

  // ── 5) Recap: the finals of the last three weeks, with each side's leaders ─
  const recap = [];
  if (finalsAll.length) {
    const recent = finalsAll.filter(f => f.date >= recapFrom).map(f => f.id);
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

  // ── 8) The threes board: the next regular-season / playoff slate ──────────
  // Priced off CURRENT rosters (a player files under the club he last played
  // for — offseason movers would be priced for the wrong team), with tonight's
  // injury report: OUT sits and his minutes count as vacated for the rotation.
  // A started game's rows are frozen as they stood before tip.
  const OUT_STATUS = /^(out|doubtful|suspension|suspended)/i;
  let slate = schedule.filter(g => [2, 3, 5].includes(g.type) && g.date >= today);
  if (!slate.length) {
    for (let d = shiftDate(today, AHEAD + 1); d <= shiftDate(today, 40) && !slate.length; d = shiftDate(d, 1)) {
      const ev = await events(d, d);
      slate = ev.filter(e => [2, 3, 5].includes(e.season?.type)).map(e => {
        const c = e.competitions[0], side = Object.fromEntries(c.competitors.map(x => [x.homeAway, x])), o = c.odds?.[0];
        const sp = num(o?.spread), tot = num(o?.overUnder);
        return { id: e.id, start: e.date, date: etDate(new Date(e.date)), type: e.season.type, state: c.status?.type?.state || 'pre',
          home: { ab: side.home.team.abbreviation }, away: { ab: side.away.team.abbreviation },
          lines: sp != null && tot != null ? { spread: sp, total: tot, impHome: +(tot / 2 - sp / 2).toFixed(1), impAway: +(tot / 2 + sp / 2).toFixed(1) } : null };
      });
    }
  }
  const boardDate = slate.length ? slate[0].date : null;
  slate = slate.filter(g => g.date === boardDate);
  const prevData = readJSON(OUT, {});
  const frozen = (prevData.threes?.date === boardDate ? prevData.threes.rows : []) || [];
  const rows = [];
  const teamCtx = {};                          // gid -> team -> the priced players, for first basket
  const STATS = Object.keys(MODEL.stats.models);
  const statRows = Object.fromEntries(STATS.map(st => [st, []])), ddRows = [];
  const frozenStats = prevData.stats?.date === boardDate ? prevData.stats : null;
  const priorPrev = priors?.players || {};
  // every club's current roster, once: the boards price off it, and the watch lists read birthdays and faces from it
  const rosters = new Map(await pool(Object.values(teams), 6, async (t) => {
    try { return [t.ab, (await get(`${SITE}/teams/${t.id}/roster`)).athletes || []]; } catch (e) { return [t.ab, null]; }
  }));
  for (const g of slate) {
    if (g.state !== 'pre') {
      rows.push(...frozen.filter(r => r.gid === g.id));
      for (const st of STATS) statRows[st].push(...(frozenStats?.boards?.[st]?.rows || []).filter(r => r.gid === g.id));
      ddRows.push(...(frozenStats?.doubles || []).filter(r => r.gid === g.id));
      continue;
    }
    for (const [me, opp, home] of [[g.home.ab, g.away.ab, true], [g.away.ab, g.home.ab, false]]) {
      const roster = rosters.get(me); if (!roster) continue;
      const T = state.teams?.[me], tDates = T?.dates || [];
      const recent3 = tDates.slice(-3)[0] || null;
      const isOut = (a) => OUT_STATUS.test(injuries[a.id]?.status || '');
      // minutes newly vacated: rotation (10+ min last 10) teammates out tonight who played in the team's last 3 games
      let vac = 0; const vacFam = {};
      for (const a of roster) {
        if (!isOut(a)) continue;
        const s = state.players[a.id]; if (!s?.last10?.length) continue;
        const inp = minutesInputs(s, priorPrev[a.id]?.prev);
        const lastD = s.last10[s.last10.length - 1].d;
        if ((inp.m10 ?? 0) >= MODEL.minutes.rotation_min && recent3 && lastD >= recent3) {
          vac += inp.m10; const f = fam(a.position?.abbreviation || s.pos); vacFam[f] = (vacFam[f] || 0) + inp.m10;
        }
      }
      const L = g.lines, sp = L?.spread != null ? (home ? L.spread : -L.spread) : null;
      const implied = L ? (home ? L.impHome : L.impAway) : null;
      const teamLast = T?.last || null, b2b = teamLast === shiftDate(g.date, -1);
      const ctxList = ((teamCtx[g.id] ||= {})[me] = []);
      for (const a of roster) {
        if (isOut(a)) continue;
        const s = state.players[a.id]; if (!s?.last10?.length) continue;
        const prevTot = priorPrev[a.id]?.prev || null, pos = a.position?.abbreviation || s.pos;
        const inp = minutesInputs(s, prevTot);
        const M = projectMinutes(inp, { date: g.date, teamLast, absSpread: sp != null ? Math.abs(sp) : null, b2b,
          vacated: vac, vacPos: vacFam[fam(pos)] || 0 });
        ctxList.push({ a, s, pos, min: M.min, start10: inp.start10 ?? 0, margin: sp != null ? -sp : 0 });
        if (M.min < 8) continue;                                  // not a rotation player tonight
        // every counting-stat ladder and the double / triple-double, off the same minutes (research/nba_stats.py)
        const base = { gid: g.id, start: g.start, pid: a.id, name: a.displayName, team: me, opp, home, pos, min: +M.min.toFixed(1), sd: +M.sd.toFixed(2), q: injuries[a.id]?.status || null };
        const mus = {};
        for (const st of STATS) {
          const r0 = statRate(st, s, prevTot, pos);
          const mu = statMu(st, { rate: r0, form: statForm(st, s, r0), implied, oppRatio: statOpp(st, state.teams?.[opp]), home, mproj: M.min, early: inp.early });
          mus[st] = mu;
          // the card's key metrics: his per-game rate (this season, else last), his last ten, the matchup
          const parts = { pra: ['pts', 'reb', 'ast'], stk: ['stl', 'blk'] }[st] || [st];
          const per = (o, n) => n ? +(parts.reduce((x, k) => x + (o?.[k] || 0), 0) / n).toFixed(1) : null;
          const R10 = s.reg10 || [];
          statRows[st].push({ ...base, mu: +mu.toFixed(2), p: statLadder(st, mu, M.min, M.sd).map(x => +x.toFixed(4)),
            f: { avg: s.gp ? per(s, s.gp) : per(prevTot, prevTot?.gp), avgWhen: s.gp ? 'season' : 'last season',
                 l10: per(R10.reduce((o, g) => { for (const k of parts) o[k] = (o[k] || 0) + (g[k] || 0); return o; }, {}), R10.length),
                 opp: +statOpp(st, state.teams?.[opp]).toFixed(3), imp: implied, st10: +(inp.start10 ?? 0).toFixed(2) } });
        }
        const dbl = doublesPrice(mus, M.min, M.sd, s.cats40);
        ddRows.push({ ...base, pts: +mus.pts.toFixed(1), reb: +mus.reb.toFixed(1), ast: +mus.ast.toFixed(1),
          dd: +dbl.dd.toFixed(4), td: +dbl.td.toFixed(5), ddOwn: +dbl.ddOwn.toFixed(3), tdOwn: +dbl.tdOwn.toFixed(4),
          l40: (s.cats40 || '').length, dd40: [...(s.cats40 || '')].filter(c => +c >= 2).length, td40: [...(s.cats40 || '')].filter(c => +c >= 3).length });
        const rate = threesRate(s, prevTot, pos);
        const form3 = statForm('tpm', s, rate);
        const mu = threesMu({ rate, form: form3, implied, oppRatio: oppThreesRatio(state.teams?.[opp]), home, mproj: M.min,
          early: inp.early, drought: s.dr?.t1 ?? null });
        const p = threesLadder(mu, M.min, M.sd);
        rows.push({ gid: g.id, start: g.start, pid: a.id, name: a.displayName, team: me, opp, home, pos,
          min: +M.min.toFixed(1), sd: +M.sd.toFixed(2), mu: +mu.toFixed(3), p: p.map(x => +x.toFixed(4)),
          f: { m10: +(inp.m10 ?? 0).toFixed(1), st10: +(inp.start10 ?? 0).toFixed(2), rate: +(rate * 36).toFixed(2),
               tpa: s.gp ? +(s.tpa / s.gp).toFixed(1) : (prevTot?.gp ? +(prevTot.tpa / prevTot.gp).toFixed(1) : null),
               vac: +vac.toFixed(1), opp: +oppThreesRatio(state.teams?.[opp]).toFixed(3), imp: implied, q: injuries[a.id]?.status || null,
               l10: (s.reg10 || []).length ? +((s.reg10 || []).reduce((x, g) => x + (g.tpm || 0), 0) / s.reg10.length).toFixed(1) : null,
               form: +form3.toFixed(3), dr: s.dr?.t1 ?? null } });
      }
    }
  }
  rows.sort((a, b) => b.p[0] - a.p[0]);

  // ── 9) First basket, the same slate ──────────────────────────────────────
  // Lineups post ~30 min before tip, so the five are PROJECTED until then: the
  // five who've started most of his team's last ten, minutes breaking ties. The
  // jumper is the projected starter with the most opening tips (nearly always
  // the centre). A starter scored the first basket in every game researched.
  const frozenFb = (prevData.first?.date === boardDate ? prevData.first.games : []) || [];
  const fbGames = [];
  for (const g of slate) {
    if (g.state !== 'pre') { fbGames.push(...frozenFb.filter(x => x.gid === g.id)); continue; }
    const side = {};
    for (const ab of [g.home.ab, g.away.ab]) {
      const L = (teamCtx[g.id]?.[ab] || []).filter(x => x.min >= 12)
        .sort((x, y) => y.start10 - x.start10 || y.min - x.min).slice(0, 5);
      if (L.length < 5) { side[ab] = null; continue; }
      const jumper = [...L].sort((x, y) => (y.s.tipn || 0) - (x.s.tipn || 0) || (fam(y.pos) === 'C') - (fam(x.pos) === 'C') || y.min - x.min)[0];
      side[ab] = { L, jumper, margin: L[0].margin };
    }
    const H = side[g.home.ab], A = side[g.away.ab];
    if (!H || !A) continue;
    const pHomeTip = pWinTip(H.jumper.s, A.jumper.s);
    const pHome = pTeamFirst(pHomeTip, H.margin), pAway = pTeamFirst(1 - pHomeTip, A.margin);
    const norm = pHome + pAway;                                        // the two teams' chances, made to sum to 1
    const players = [];
    for (const [ab, S, pt] of [[g.home.ab, H, pHome / norm], [g.away.ab, A, pAway / norm]]) {
      const w = S.L.map(x => fbWeight(x.s, x.pos)), W = w.reduce((a, b) => a + b, 0);
      S.L.forEach((x, i) => players.push({ pid: x.a.id, name: x.a.displayName, team: ab, pos: x.pos, jumper: x === S.jumper,
        p: +(pt * w[i] / W).toFixed(4), fb: x.s.fb || 0, starts: x.s.starts || 0, st10: +x.start10.toFixed(2) }));
    }
    players.sort((a, b) => b.p - a.p);
    fbGames.push({ gid: g.id, start: g.start, home: g.home.ab, away: g.away.ab,
      tip: { home: H.jumper.a.displayName, away: A.jumper.a.displayName, pHome: +pHomeTip.toFixed(3) },
      pHomeFirst: +(pHome / norm).toFixed(3), players });
  }
  const first = boardDate ? { date: boardDate, generated: new Date().toISOString(), projected: true, games: fbGames } : null;
  console.log(`First basket: ${fbGames.length} games priced`);
  for (const st of STATS) statRows[st].sort((a, b) => b.mu - a.mu);
  ddRows.sort((a, b) => b.dd - a.dd);
  // the spread each distribution uses, so the page's ladder card draws what the build priced
  const stats = boardDate ? { date: boardDate, generated: new Date().toISOString(),
    spread: Object.fromEntries(STATS.map(st => [st, { a: MODEL.stats.models[st].a, p: MODEL.stats.models[st].p }])),
    boards: Object.fromEntries(STATS.map(st => [st, { rungs: MODEL.stats.models[st].rungs, rows: statRows[st] }])), doubles: ddRows } : null;
  console.log(`Stats boards: ${STATS.map(st => `${st} ${statRows[st].length}`).join(', ')} · doubles ${ddRows.length}`);
  const threes = boardDate ? { date: boardDate, generated: new Date().toISOString(), rungs: MODEL.threes.rungs, alpha: MODEL.threes.alpha, rows } : null;
  console.log(`Threes board: ${rows.length} players, ${boardDate || 'no slate'}${frozen.length ? ` (${rows.filter(r => frozen.includes(r)).length} frozen)` : ''}`);

  savePrices(boardDate, { threes: rows, doubles: ddRows, first: fbGames }, today, shiftDate);

  // ── 11) Watch lists: Milestones, Due, Birthdays ──────────────────────────
  let fun = null;
  try {
    fun = await buildFun({ year, today, rosters, state, schedule, recap,
      boards: { threes: rows, doubles: ddRows, first: fbGames, pts: statRows.pts } });
    console.log(`Watch lists: ${fun.milestones.length} milestone chases (${fun.careerFetched} careers fetched), ${fun.birthdays.length} birthdays, due ${Object.entries(fun.due).map(([k, v]) => `${k} ${v.length}`).join(' ')}`);
    delete fun.careerFetched;
  } catch (e) { console.warn(`  watch lists not built: ${e.message}`); }

  const data = { generated: new Date().toISOString(), today, season: label, phase: now.key, phaseName: now.name, phases,
    leadersFrom: fromPriors ? state.priorsSeason : label, teams, schedule, recap, injuries, leaders, threes, first, stats, fun };
  fs.writeFileSync(OUT, JSON.stringify(data));
  fs.writeFileSync(STATE_PATH, JSON.stringify(state));
  console.log(`Wrote nba/data.json — ${Object.keys(teams).length} teams, ${schedule.length} scheduled, ${recap.length} recapped, ${leaders.length} leaders (${fromPriors ? 'last season' : 'this season'}), ${Object.keys(injuries).length} injured`);
}

main().catch(e => { console.error(e); process.exit(1); });
