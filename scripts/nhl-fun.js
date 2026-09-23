// Birthdays, Milestones and Due — the three /nhl pages that are for fun.
//
// The standing data is research/nhl_fun.json (research/nhl_fun_data.py): career
// totals and each skater's goal drought through the last finished season, plus
// the birthday record. This adds the current season on top, so the file only
// needs pulling again when a season is missing from it.
//
// None of it is a signal, and the explainers say so with numbers:
//   birthdays  57 goals in 377 birthday games, 15.1% against a 15.3% price
//   due        a long drought prices slightly HIGH, not low (30+ games without
//              a goal: 5.2% actual on a 5.7% price) and shots / ice time since
//              the last goal add nothing to the goals model (research/nhl_due.py)
import fs from 'node:fs';
import { web, restPaged } from './nhl-api.js';

const FUN = JSON.parse(fs.readFileSync(new URL('../research/nhl_fun.json', import.meta.url), 'utf8'));

// Rungs and how close counts as a chase — a distance someone covers in a few weeks.
export const MS_RUNGS = {
  g:   { every: 50,  min: 50,  within: 10, label: 'Goals' },
  a:   { every: 100, min: 100, within: 15, label: 'Assists' },
  pts: { every: 100, min: 100, within: 15, label: 'Points' },
  gp:  { every: 100, min: 100, within: 8,  label: 'Games' },
  w:   { every: 50,  min: 50,  within: 6,  label: 'Wins' },
};
const BD_BEFORE = 3, BD_AFTER = 7;
const MS_PATH = new URL('../nhl/milestones-history.json', import.meta.url);        // birthdays from 3 days ago through a week out

const DAY = 864e5;
const dnum = (ymd) => Date.parse(ymd + 'T00:00:00Z') / DAY;

/**
 * @param o.season   the current season id
 * @param o.hist     the last finished season id
 * @param o.today    ET date
 * @param o.schedule this season's games
 * @param o.picks    tonight's goal board
 * @param o.log      players.json as built this run (game logs this season)
 */
export async function buildFun({ season, hist, today, schedule, picks, log }) {
  // ── Every club's current roster: who is active, his face, his birthday ──
  const clubs = [...new Set(schedule.filter(g => g.type === 2).flatMap(g => [g.away, g.home]))];
  const roster = new Map();
  await Promise.all(clubs.map(async (ab) => {
    try {
      const r = await web(`/roster/${ab}/current`);
      for (const grp of ['forwards', 'defensemen', 'goalies'])
        for (const x of r[grp] || []) roster.set(String(x.id), {
          team: ab, pos: x.positionCode, mug: x.headshot || null, bd: x.birthDate || null,
          name: `${x.firstName?.default ?? ''} ${x.lastName?.default ?? ''}`.trim(),
        });
    } catch (e) { /* a club missing here is missing from all three pages, not wrong on them */ }
  }));

  // ── Career totals: the file, plus any season it doesn't have yet ──
  const car = {}, gcar = {};
  for (const [pid, [n, pos, gp, g, a, pts]] of Object.entries(FUN.career)) car[pid] = { n, pos, gp, g, a, pts };
  for (const [pid, [n, gp, w, so]] of Object.entries(FUN.goalies)) gcar[pid] = { n, gp, w, so };
  for (const s of [...new Set([hist, season])].filter(s => s > FUN.through)) {
    const exp = `seasonId=${s} and gameTypeId=2`;
    const [sk, gl] = await Promise.all([
      restPaged(`/skater/summary?cayenneExp=${exp}`, Infinity, [{ property: 'playerId', direction: 'ASC' }]),
      restPaged(`/goalie/summary?cayenneExp=${exp}`, Infinity, [{ property: 'playerId', direction: 'ASC' }]),
    ]);
    for (const r of sk) {
      const e = (car[r.playerId] ??= { n: r.skaterFullName, pos: r.positionCode, gp: 0, g: 0, a: 0, pts: 0 });
      e.gp += r.gamesPlayed || 0; e.g += r.goals || 0; e.a += r.assists || 0; e.pts += r.points || 0;
    }
    for (const r of gl) {
      const e = (gcar[r.playerId] ??= { n: r.goalieFullName, gp: 0, w: 0, so: 0 });
      e.gp += r.gamesPlayed || 0; e.w += r.wins || 0; e.so += r.shutouts || 0;
    }
  }

  const milestones = [];
  const chase = (pid, rs, stat, v, extra) => {
    const R = MS_RUNGS[stat];
    const next = Math.max(R.min, (Math.floor(v / R.every) + 1) * R.every);
    if (next - v <= R.within)
      milestones.push({ pid: +pid, name: rs.name, team: rs.team, pos: rs.pos, mug: rs.mug, stat, career: v, next, away: next - v, ...extra });
  };
  for (const [pid, rs] of roster) {
    if (rs.pos === 'G') {
      const c = gcar[pid]; if (!c) continue;
      chase(pid, rs, 'w', c.w); chase(pid, rs, 'gp', c.gp);
    } else {
      const c = car[pid]; if (!c) continue;
      for (const k of ['g', 'a', 'pts', 'gp']) chase(pid, rs, k, c[k]);
    }
  }
  milestones.sort((x, y) => x.away / MS_RUNGS[x.stat].within - y.away / MS_RUNGS[y.stat].within || y.next - x.next);

  // ── Milestones reached: the Results tab ──
  // Each build keeps every rostered player's career line; a rung crossed since
  // the last build is logged against the game he crossed it in — the newest in
  // his log — and a goal milestone against the goal itself, clip and all. How
  // long he sat on the watch list rides along from when he first appeared.
  let msLog = { season, snap: {}, watch: {}, reached: [] };
  try { const h = JSON.parse(fs.readFileSync(MS_PATH, 'utf8')); msLog = { ...msLog, ...h }; } catch (e) { /* first build */ }
  if (msLog.season !== season) { msLog.season = season; msLog.reached = []; msLog.watch = {}; }
  const epochMs = log ? dnum(log.epoch) : 0;
  const dayOf = (n) => new Date((epochMs + n) * DAY).toISOString().slice(0, 10);
  const nowKeys = new Set();
  for (const [pid, rs] of roster) {
    const c = rs.pos === 'G' ? gcar[pid] : car[pid]; if (!c) continue;
    const stats = rs.pos === 'G' ? ['gp', 'w'] : ['gp', 'g', 'a', 'pts'];
    const cv = Object.fromEntries(stats.map(k => [k, c[k]]));
    const prev = msLog.snap[pid];
    if (prev) for (const k of stats) {
      if (prev[k] == null || !(cv[k] > prev[k])) continue;
      const R = MS_RUNGS[k];
      for (let n = Math.max(R.min, (Math.floor(prev[k] / R.every) + 1) * R.every); n <= cv[k]; n += R.every) {
        const games = log?.p?.[pid]?.g || [], last = games[games.length - 1];
        const ev = { pid: +pid, name: rs.name, team: rs.team, pos: rs.pos, mug: rs.mug, stat: k, n,
                     date: last ? dayOf(last[0]) : today, opp: last?.[1] || '' };
        if (k === 'g') {
          // the n-th career goal is this season's (n - goals before it)-th
          const mine = (log?.goals || []).filter(x => x.pid === +pid && x.type === 2)
            .sort((a, b) => a.date.localeCompare(b.date) || a.gameId - b.gameId || a.k - b.k);
          const g = mine[n - (cv.g - mine.length) - 1];
          if (g) Object.assign(ev, { date: g.date, gameId: g.gameId, k: g.k, vid: g.vid || null,
                                     opp: g.team === g.a ? g.h : g.a });
        }
        const w = msLog.watch[`${pid}|${k}|${n}`];
        if (w) Object.assign(ev, { since: w.since, from: w.from });
        if (!msLog.reached.some(x => x.pid === ev.pid && x.stat === k && x.n === n)) msLog.reached.push(ev);
      }
    }
    msLog.snap[pid] = cv;
  }
  for (const m of milestones) {
    const key = `${m.pid}|${m.stat}|${m.next}`; nowKeys.add(key);
    msLog.watch[key] ??= { since: today, from: m.career };
  }
  for (const k of Object.keys(msLog.watch)) if (!nowKeys.has(k)) delete msLog.watch[k];
  msLog.reached.sort((a, b) => b.date.localeCompare(a.date));
  fs.writeFileSync(MS_PATH, JSON.stringify(msLog));

  // ── Goal droughts for tonight's board ──
  // This season off players.json; a skater without a goal yet this season
  // carries last season's drought on top of it.
  const epoch = log ? dnum(log.epoch) : 0;
  const onDay = (n) => new Date((epoch + n) * DAY).toISOString().slice(0, 10);
  const due = [];
  for (const p of picks) {
    const rows = log?.p?.[p.pid]?.g || [];          // [day, opp, home, g, a, s, toi, ...]
    let last = -1;
    rows.forEach((r, i) => { if (r[3] > 0) last = i; });
    const after = rows.slice(last + 1);
    const carry = last < 0 ? FUN.drought[p.pid] : null;
    if (last < 0 && !carry) continue;                // no record of him scoring, or of him at all
    const games = after.length + (carry?.[0] ?? 0);
    const shots = after.reduce((s, r) => s + r[5], 0) + (carry?.[1] ?? 0);
    const toi = Math.round(after.reduce((s, r) => s + r[6], 0) / 60) + (carry?.[2] ?? 0);
    due.push({ pid: p.pid, games, shots, toi, last: last >= 0 ? onDay(rows[last][0]) : carry?.[3] ?? null, carried: last < 0 });
  }

  // ── Birthdays this week, and whether he plays on the day ──
  const t0 = dnum(today), yr = +today.slice(0, 4);
  const gameOn = {};
  // preseason counts as a game on the day, labelled as one; it isn't graded
  for (const g of schedule) if (g.type === 1 || g.type === 2) for (const t of [g.away, g.home]) gameOn[`${t}|${g.date}`] = g;
  const price = new Map(picks.map(p => [String(p.pid), p]));
  const birthdays = [];
  for (const [pid, rs] of roster) {
    if (!rs.bd) continue;
    // this year's birthday, or next/last year's when the window wraps New Year
    const cand = [yr - 1, yr, yr + 1].map(y => `${y}${rs.bd.slice(4)}`).find(d => {
      const off = dnum(d) - t0; return off >= -BD_BEFORE && off <= BD_AFTER;
    });
    if (!cand) continue;
    const g = gameOn[`${rs.team}|${cand}`];
    const pk = price.get(pid);
    const row = log?.p?.[pid]?.g?.find(r => onDay(r[0]) === cand);
    birthdays.push({
      pid: +pid, name: rs.name, team: rs.team, pos: rs.pos, mug: rs.mug,
      day: cand, off: dnum(cand) - t0, turning: +cand.slice(0, 4) - +rs.bd.slice(0, 4),
      game: g ? { gameId: g.gameId, opp: g.away === rs.team ? g.home : g.away, home: g.home === rs.team, start: g.start, pre: g.type === 1 } : null,
      p: pk && pk.date === cand ? pk.p : null,
      rec: FUN.bday.rec[pid] || null,
      res: row ? (rs.pos === 'G' ? { dec: row[3], sv: row[5], ga: row[6] } : { g: row[3], a: row[4], s: row[5] }) : null,
    });
  }
  birthdays.sort((a, b) => a.off - b.off || (b.game ? 1 : 0) - (a.game ? 1 : 0) || a.name.localeCompare(b.name));

  return { birthdays, bdStats: FUN.bday.stats, milestones, rungs: MS_RUNGS, msReached: msLog.reached, due, through: FUN.through };
}
