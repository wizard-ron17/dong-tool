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
  const t = (g) => g.reduce((a, p) => a + (toi[p] || 0), 0) / g.length;
  return out.sort((a, b) => t(b) - t(a));
}

export async function derive(gameId) {
  const [sc, box] = await Promise.all([rest(`/shiftcharts?cayenneExp=gameId=${gameId}`), web(`/gamecenter/${gameId}/boxscore`)]);
  const rows = sc?.data || [];
  if (!rows.length) return null;
  const pos = {}, goalies = new Set(), abbrOf = { [box.awayTeam.id]: box.awayTeam.abbrev, [box.homeTeam.id]: box.homeTeam.abbrev };
  for (const side of ['awayTeam', 'homeTeam']) {
    const pg = box.playerByGameStats?.[side] || {};
    for (const p of [...(pg.forwards || []), ...(pg.defense || [])]) pos[p.playerId] = p.position;
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
  return { gameId, date: box.gameDate, teams: out, pos };
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
