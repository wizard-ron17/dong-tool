// Line combinations from the NHL's own shift charts (api.nhle.com/stats/rest/en/shiftcharts).
//
// Nobody publishes a free line chart (DailyFaceoff blocks scripts, RotoWire's depth charts are
// subscriber-only), so the lines are read off what happened: every second of a game, who was on the
// ice for each team. At 5v5, the three forwards together are a line and the two defencemen a pair;
// across a game the pairs of players who shared the ice most are the combinations. Power plays are
// read the same way (a team with more skaters than the other), grouped into the 1st and 2nd unit.
//
//   derive(gameId)            -> { teams: { ABBR: { F: [[pid x3] x4], D: [[pid x2] x3], pp: [[pid..] x2],
//                                  toi: { pid: [evSec, ppSec] } } }, pos: { pid: 'C'|'L'|'R'|'D' } }
//
// A line is a tier by ice time, not a promise: line 1 is whichever trio the coach used most. Shift charts
// exist for finished games only (and the feed has gaps, e.g. Sep 30 - Oct 6 2026), so a game with no
// shifts yields null and the caller falls back to an older game.
import { web, rest } from './nhl-api.js';

const sec = (s) => { const [m, x] = String(s || '0:0').split(':').map(Number); return m * 60 + (x || 0); };

/** Greedy grouping: the player with the most time anchors a group, then the `size - 1` players who shared the ice with him most. */
function group(players, co, toi, size, max) {
  const left = new Set(players), out = [];
  while (left.size >= Math.min(size, 2) && out.length < max) {
    const anchor = [...left].sort((a, b) => (toi[b] || 0) - (toi[a] || 0))[0];
    left.delete(anchor);
    const mates = [...left].sort((a, b) => (co[anchor + '|' + b] || co[b + '|' + anchor] || 0) - (co[anchor + '|' + a] || co[a + '|' + anchor] || 0) || (toi[b] || 0) - (toi[a] || 0)).slice(0, size - 1);
    mates.forEach(m => left.delete(m));
    out.push([anchor, ...mates]);
  }
  // order the groups by the time they played together, most first
  // rank by the middle member (the best of a pair), so one player knocked out of the game early doesn't sink his line
  const t = (g) => { const v = g.map(p => toi[p] || 0).sort((a, b) => b - a); return size >= 3 ? v[Math.floor(v.length / 2)] : v[0]; };
  return out.sort((a, b) => t(b) - t(a));
}

export async function derive(gameId) {
  const [sc, box] = await Promise.all([rest(`/shiftcharts?cayenneExp=gameId=${gameId}`), web(`/gamecenter/${gameId}/boxscore`)]);
  const rows = sc?.data || [];
  if (!rows.length) return null;
  const pos = {}, names = {}, goalies = new Set(), abbrOf = { [box.awayTeam.id]: box.awayTeam.abbrev, [box.homeTeam.id]: box.homeTeam.abbrev };
  for (const side of ['awayTeam', 'homeTeam']) {
    const pg = box.playerByGameStats?.[side] || {};
    for (const p of [...(pg.forwards || []), ...(pg.defense || [])]) { pos[p.playerId] = p.position; names[p.playerId] = p.name?.default; }
    for (const p of pg.goalies || []) goalies.add(p.playerId);
  }
  // who is on the ice each second, per team (period 4+ is overtime: 5 minutes, 3v3)
  const periods = [...new Set(rows.map(r => r.period))].sort((a, b) => a - b);
  const teams = {}, tid = (r) => abbrOf[r.teamId] || r.teamAbbrev;
  for (const per of periods) {
    const len = per <= 3 ? 1200 : 300, on = {};            // on[abbr][t] = [pid...]
    for (const r of rows) {
      if (r.period !== per || goalies.has(r.playerId) || !pos[r.playerId]) continue;
      const a = tid(r), s = sec(r.startTime), e = Math.min(len, sec(r.endTime));
      const o = (on[a] ||= Array.from({ length: len }, () => []));
      for (let t = s; t < e; t++) o[t].push(r.playerId);
    }
    const abbrs = Object.keys(on);
    if (abbrs.length !== 2) continue;
    for (let t = 0; t < len; t++) {
      for (const [a, b] of [[abbrs[0], abbrs[1]], [abbrs[1], abbrs[0]]]) {
        const mine = on[a][t], theirs = on[b][t];
        const T = (teams[a] ||= { co: {}, evToi: {}, ppToi: {}, ppCo: {} });
        if (mine.length === 5 && theirs.length === 5 && per <= 3) {          // 5v5
          const F = mine.filter(p => pos[p] !== 'D'), D = mine.filter(p => pos[p] === 'D');
          for (const p of mine) T.evToi[p] = (T.evToi[p] || 0) + 1;
          if (F.length === 3 && D.length === 2) {
            for (let i = 0; i < 3; i++) for (let j = i + 1; j < 3; j++) T.co[F[i] + '|' + F[j]] = (T.co[F[i] + '|' + F[j]] || 0) + 1;
            T.co[D[0] + '|' + D[1]] = (T.co[D[0] + '|' + D[1]] || 0) + 1;
          }
        } else if (mine.length > theirs.length && mine.length >= 4 && per <= 3) {   // power play
          for (const p of mine) T.ppToi[p] = (T.ppToi[p] || 0) + 1;
          for (let i = 0; i < mine.length; i++) for (let j = i + 1; j < mine.length; j++) T.ppCo[mine[i] + '|' + mine[j]] = (T.ppCo[mine[i] + '|' + mine[j]] || 0) + 1;
        }
      }
    }
  }
  const out = {};
  for (const [a, T] of Object.entries(teams)) {
    const F = Object.keys(T.evToi).filter(p => pos[p] !== 'D').map(Number), D = Object.keys(T.evToi).filter(p => pos[p] === 'D').map(Number);
    const toi = {}; for (const p of new Set([...Object.keys(T.evToi), ...Object.keys(T.ppToi)])) toi[p] = [T.evToi[p] || 0, T.ppToi[p] || 0];
    const evSec = (p) => T.evToi[p] || 0, ppSec = (p) => T.ppToi[p] || 0;
    const fl = group(F.sort((x, y) => evSec(y) - evSec(x)).slice(0, 12), T.co, T.evToi, 3, 4);
    const dp = group(D.sort((x, y) => evSec(y) - evSec(x)).slice(0, 6), T.co, T.evToi, 2, 3);
    const ppPlayers = Object.keys(T.ppToi).map(Number).sort((x, y) => ppSec(y) - ppSec(x));
    const pp = group(ppPlayers.slice(0, 10), T.ppCo, T.ppToi, 5, 2);
    out[a] = { F: fl, D: dp, pp, toi };
  }
  return { gameId, date: box.gameDate, teams: out, pos, names };
}


// ── The slate's lines: every team's latest lines, and what changed from its previous games ─────────────
// History is kept so a build only reads the finished games it hasn't seen (nhl/combos-history.json).
import fs from 'node:fs';
const HIST_PATH = process.env.NHL_COMBOS_PATH ? new URL('file://' + process.env.NHL_COMBOS_PATH) : new URL('../nhl/combos-history.json', import.meta.url);
const KEEP = 5;            // each team's last 5 games are kept: the newest is the line-up, up to 3 before it the baseline
const readJSON = (u, d) => { try { return JSON.parse(fs.readFileSync(u, 'utf8')); } catch (e) { return d; } };
async function pool(items, n, fn) { const out = []; let i = 0; await Promise.all(Array.from({ length: n }, async () => { while (i < items.length) { const k = i++; out[k] = await fn(items[k]); } })); return out; }

/** pid -> [tier, pp]: tier 'L1'..'L4' (forwards) or 'D1'..'D3'; pp 0 (no unit), 1 or 2 */
function tiers(t) {
  const m = {};
  t.F.forEach((g, i) => g.forEach(p => { m[p] = ['L' + (i + 1), 0]; }));
  t.D.forEach((g, i) => g.forEach(p => { m[p] = ['D' + (i + 1), 0]; }));
  t.pp.forEach((g, i) => g.forEach(p => { (m[p] ||= [null, 0])[1] = i + 1; }));
  return m;
}
const mode = (a) => { const c = {}; a.forEach(x => { c[x] = (c[x] || 0) + 1; }); return Object.entries(c).sort((x, y) => y[1] - x[1])[0]?.[0]; };

export async function buildLines({ schedule, maxNew = 60, log = console.log }) {
  const H = readJSON(HIST_PATH, { games: {}, none: {} });
  H.games ||= {}; H.none ||= {};
  const fin = schedule.filter(g => g.type === 2 && g.state === 'OFF').sort((a, b) => b.date.localeCompare(a.date) || b.gameId - a.gameId);
  const byTeam = {};
  for (const g of fin) for (const a of [g.home, g.away]) { const L = (byTeam[a] ||= []); if (L.length < KEEP + 3) L.push(g); }
  const want = new Map();
  for (const L of Object.values(byTeam)) for (const g of L.slice(0, KEEP + 3)) {
    const nth = L.indexOf(g); if (nth >= KEEP + 3) continue;
    // a game with no shifts is asked again for a few days (the feed fills in late), then given up on
    const age = (Date.now() - Date.parse(g.date)) / 864e5;
    if (!H.games[g.gameId] && !(H.none[g.gameId] && age > 4)) want.set(g.gameId, g);
  }
  const todo = [...want.values()].sort((a, b) => b.date.localeCompare(a.date)).slice(0, maxNew);
  let got = 0;
  await pool(todo, 4, async (g) => {
    try {
      const d = await derive(g.gameId);
      if (!d) { H.none[g.gameId] = g.date; return; }
      delete H.none[g.gameId];
      H.games[g.gameId] = { date: d.date, teams: d.teams, pos: d.pos, names: d.names }; got++;
    } catch (e) { log(`  lines: ${g.gameId} skipped (${e.message})`); }
  });
  // compose: per team, its newest game with shifts is the line-up, the ones before it the baseline
  const teams = {}, pos = {}, names = {};
  for (const [a, L] of Object.entries(byTeam)) {
    const have = L.map(g => H.games[g.gameId]).filter(x => x?.teams?.[a]);
    if (!have.length) continue;
    const latest = have[0], base = have.slice(1, 4), T = { ...latest.teams[a] };
    // ice time over the last few games (not one game's flow) orders the lines: a line that happened to play
    // 9 minutes in a blowout is still the first line. Ranked by the middle member (the best of a pair).
    const avgEv = (games) => { const m = {}; for (const g of games) for (const [p, v] of Object.entries(g.teams[a].toi)) (m[p] ||= []).push(v[0] / 60); return Object.fromEntries(Object.entries(m).map(([p, v]) => [p, v.reduce((x, y) => x + y, 0) / v.length])); };
    const recent = avgEv(have.slice(0, 3)), prior = avgEv(base);
    const mid = (g, size) => { const v = g.map(p => recent[p] || 0).sort((x, y) => y - x); return size >= 3 ? v[Math.floor(v.length / 2)] : v[0]; };
    T.F = [...T.F].sort((x, y) => mid(y, 3) - mid(x, 3)); T.D = [...T.D].sort((x, y) => mid(y, 2) - mid(x, 2));
    const now = tiers(T), before = base.map(g => tiers(g.teams[a]));
    const chg = [];
    // Role changes are about who he skates with, not where the coach's minutes fell in one game:
    //   up    he was well outside the top six forwards (7th-8th D) over the previous games and now skates with two of them
    //   down  he was in the top five (top two D) and now skates with none of the top six (a bottom-pair partner)
    //   pp    he moved on or off the first power-play unit
    const rank = (pids) => pids.filter(p => prior[p] != null).sort((x, y) => prior[y] - prior[x]);
    const posOf = (p) => (base.find(g => g.pos[p]) || latest).pos[p];
    const fOrder = rank(Object.keys(prior).filter(p => posOf(p) !== 'D')).map(Number), dOrder = rank(Object.keys(prior).filter(p => posOf(p) === 'D')).map(Number);
    const topF = new Set(fOrder.slice(0, 6)), topD = new Set(dOrder.slice(0, 4));
    const rF = (p) => fOrder.indexOf(p), rD = (p) => dOrder.indexOf(p);   // 0 = most ice time
    const seenIn = (p) => base.filter(g => g.teams[a].toi[p]).length;
    if (base.length >= 2) {
      for (const g of T.F) for (const p of g) { if (seenIn(p) < 2) continue;
        const mates = g.filter(x => x !== p), tops = mates.filter(x => topF.has(x)).length;
        if (rF(p) >= 8 && tops >= 2) chg.push([p, 'up']); else if (rF(p) >= 0 && rF(p) <= 4 && tops === 0) chg.push([p, 'down']); }
      for (const g of T.D) for (const p of g) { if (seenIn(p) < 2) continue;
        const mate = g.find(x => x !== p);
        if (rD(p) >= 5 && topD.has(mate)) chg.push([p, 'up']); else if (rD(p) >= 0 && rD(p) <= 1 && mate != null && rD(mate) >= 4) chg.push([p, 'down']); }
    }
    for (const [p, [, pp]] of Object.entries(now)) {
      const hist = before.map(b => b[p]).filter(Boolean);
      if (hist.length < 2) continue;
      const bp = +mode(hist.map(h => h[1]));
      if ((pp === 1 || bp === 1) && pp !== bp) chg.push([+p, 'pp', bp, pp]);
    }
    // played in the previous games (at least twice, 6+ minutes), not in the last one: out, or scratched
    const out = [];
    for (const p of new Set(before.flatMap(b => Object.keys(b)))) {
      if (now[p]) continue; const n = before.filter(b => b[p]).length;
      if (n >= 2 && (prior[p] || 0) >= 6) out.push(+p);
    }
    // a line is new when two of its players hadn't shared a line in the previous games
    const withLines = base.map(g => [...g.teams[a].F, ...g.teams[a].D]);
    const tg = (x, y) => withLines.some(ls => ls.some(g => g.includes(x) && g.includes(y)));
    const fresh = base.length >= 2 ? T.F.map(g => g.length >= 3 && !(tg(g[0], g[1]) && tg(g[0], g[2]) && tg(g[1], g[2]))) : T.F.map(() => false);
    const freshD = base.length >= 2 ? T.D.map(g => g.length >= 2 && !tg(g[0], g[1])) : T.D.map(() => false);
    const toi = {}; for (const [p, v] of Object.entries(T.toi)) toi[p] = [Math.round(v[0] / 6) / 10, Math.round(v[1] / 6) / 10];
    teams[a] = { gameId: +Object.keys(H.games).find(id => H.games[id] === latest), date: latest.date, n: have.length - 1, F: T.F, D: T.D, pp: T.pp, toi, chg, out, fresh, freshD };
    for (const p of Object.keys(toi)) { pos[p] = latest.pos[p]; names[p] = latest.names[p]; }
    for (const p of [...chg.map(c => c[0]), ...out]) { for (const g of have) if (g.pos[p]) { pos[p] ||= g.pos[p]; names[p] ||= g.names[p]; } }
  }
  // keep only what a team's current window needs
  const keepIds = new Set(Object.values(byTeam).flatMap(L => L.slice(0, KEEP).map(g => String(g.gameId))));
  for (const id of Object.keys(H.games)) if (!keepIds.has(id)) delete H.games[id];
  fs.writeFileSync(HIST_PATH, JSON.stringify(H));
  log(`  lines: ${got} new games read, ${Object.keys(teams).length} teams, ${Object.values(teams).reduce((n, t) => n + t.chg.length, 0)} role changes`);
  return { teams, pos, names };
}

// node scripts/nhl-combos.js <gameId>   prints each team's lines for that game (needs names: from the boxscore)
if (process.argv[1] && process.argv[1].endsWith('nhl-combos.js') && process.argv[2]) {
  const id = process.argv[2], d = await derive(id);
  if (!d) { console.log('no shifts for', id); process.exit(0); }
  const box = await web(`/gamecenter/${id}/boxscore`), name = {};
  for (const s of ['awayTeam', 'homeTeam']) for (const p of [...(box.playerByGameStats[s].forwards || []), ...(box.playerByGameStats[s].defense || [])]) name[p.playerId] = p.name.default;
  const fmt = (g, a) => g.map(p => `${name[p] || p}${a ? '' : ''}`).join(' - ');
  for (const [a, t] of Object.entries(d.teams)) {
    console.log(`\n${a}`);
    t.F.forEach((g, i) => console.log(`  L${i + 1}  ${fmt(g)}   ${(g.reduce((s, p) => s + t.toi[p][0], 0) / g.length / 60).toFixed(1)} min`));
    t.D.forEach((g, i) => console.log(`  D${i + 1}  ${fmt(g)}   ${(g.reduce((s, p) => s + t.toi[p][0], 0) / g.length / 60).toFixed(1)} min`));
    t.pp.forEach((g, i) => console.log(`  PP${i + 1} ${fmt(g)}   ${(g.reduce((s, p) => s + t.toi[p][1], 0) / g.length / 60).toFixed(1)} min`));
  }
}
