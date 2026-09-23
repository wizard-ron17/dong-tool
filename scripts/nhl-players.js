// nhl/players.json — what the player card loads when it opens, kept out of
// data.json so the home page never pays for it. Two things live here:
//
//   p      every skater's and goalie's game log this season, one row per game
//   goals  every goal this season with its clip and detail, so a player's
//          Goals tab reaches back to opening night — the recap only keeps three
//          weeks, and the clip ids and puck speeds are gone once it drops them
//
// Both are ARCHIVES: a finished date is fetched once and kept, so a build costs
// two warehouse requests per new game date (skaters, goalies) and nothing else.
// The warehouse's per-date rows carry no opponent, and a traded player's row
// names the club he finished with rather than the one he played for, so both
// are resolved against the schedule — the same fix the shots model needed.
import fs from 'node:fs';
import { restPaged } from './nhl-api.js';

const PATH = new URL('../nhl/players.json', import.meta.url);
const REFRESH = 2;        // re-pull the newest dates we have, for late stat corrections
const MAX_NEW = 60;       // dates fetched per build — a cold start catches up over a few runs

// A row's first cell is its date as a day number from July 1 of the season's
// first year — 52,000 game rows by April, and an ISO date is ten bytes of each.
export const SK_COLS = ['day', 'opp', 'home', 'g', 'a', 's', 'toi', 'ppg', 'pm', 'pim'];
export const GL_COLS = ['day', 'opp', 'home', 'dec', 'sa', 'sv', 'ga', 'toi', 'so'];

/**
 * @param {object} o
 * @param {number} o.season     e.g. 20262027
 * @param {Array}  o.schedule   the season's games (gameId, date, away, home, state, type)
 * @param {object} o.recap      date -> goals, as data.json carries them
 * @param {object} o.recapGames gameId -> game
 */
export async function buildPlayersLog({ season, schedule, recap, recapGames, path = PATH }) {
  let prev = null;
  try { prev = JSON.parse(fs.readFileSync(path, 'utf8')); } catch (e) { /* first build */ }
  if (prev?.season !== season) prev = null;           // a new season starts clean
  const yr = Math.floor(season / 10000);
  const epoch = Date.UTC(yr, 6, 1);
  const dayOf = (d) => Math.round((Date.parse(d + 'T00:00:00Z') - epoch) / 864e5);
  const out = { season, epoch: `${yr}-07-01`, cols: { sk: SK_COLS, gl: GL_COLS }, dates: prev?.dates || [], p: prev?.p || {}, goals: prev?.goals || [] };

  // ── Game logs ──────────────────────────────────────────────────────────
  const final = (g) => g.state === 'OFF' || g.state === 'FINAL';
  const byDate = {};
  for (const g of schedule) if (g.type >= 2) (byDate[g.date] ??= []).push(g);
  // A date is done when every game on it is — a half-played night would be
  // archived with half its rows and never looked at again.
  const done = Object.keys(byDate).filter(d => byDate[d].every(final)).sort();
  const have = new Set(out.dates);
  const todo = [...new Set([...out.dates.slice(-REFRESH), ...done.filter(d => !have.has(d))])]
    .filter(d => done.includes(d)).sort().slice(0, MAX_NEW + REFRESH);

  const oppOn = (d, teams) => {
    for (const t of teams) {
      const g = (byDate[d] || []).find(x => x.away === t || x.home === t);
      if (g) return { team: t, opp: g.away === t ? g.home : g.away, home: g.home === t ? 1 : 0 };
    }
    return { team: teams[teams.length - 1], opp: '', home: 0 };
  };
  const put = (pid, who, row) => {
    const e = (out.p[pid] ??= { n: who.n, pos: who.pos, tm: who.tm, g: [] });
    Object.assign(e, who);                              // newest name/club/position wins
    e.g = e.g.filter(r => r[0] !== row[0]);
    e.g.push(row);
    e.g.sort((a, b) => a[0] - b[0]);
  };

  for (const d of todo) {
    const exp = `gameDate>="${d}" and gameDate<="${d}" and gameTypeId>=2`;
    const [sk, gl] = await Promise.all([
      restPaged(`/skater/summary?cayenneExp=${exp}`, Infinity, [{ property: 'playerId', direction: 'ASC' }]),
      restPaged(`/goalie/summary?cayenneExp=${exp}`, Infinity, [{ property: 'playerId', direction: 'ASC' }]),
    ]);
    for (const r of sk) {
      const o = oppOn(d, String(r.teamAbbrevs || '').split(','));
      put(r.playerId, { n: r.skaterFullName, pos: r.positionCode, tm: o.team },
        [dayOf(d), o.opp, o.home, r.goals || 0, r.assists || 0, r.shots || 0, Math.round(r.timeOnIcePerGame || 0),
         r.ppGoals || 0, r.plusMinus || 0, r.penaltyMinutes || 0]);
    }
    for (const r of gl) {
      const o = oppOn(d, String(r.teamAbbrevs || '').split(','));
      const dec = r.wins ? 'W' : r.losses ? 'L' : r.otLosses ? 'O' : '';
      put(r.playerId, { n: r.goalieFullName, pos: 'G', tm: o.team },
        [dayOf(d), o.opp, o.home, dec, r.shotsAgainst || 0, r.saves || 0, r.goalsAgainst || 0, Math.round(r.timeOnIce || 0), r.shutouts || 0]);
    }
    if (!have.has(d)) { out.dates.push(d); have.add(d); }
  }
  out.dates.sort();

  // ── Goal archive ───────────────────────────────────────────────────────
  // The recap's goals, filed by game and goal number. A goal already filed is
  // replaced, not duplicated, so a speed that arrives a build late still lands.
  // Only this season's games: a September build's recap reaches back into last
  // season's playoffs, which belong to that season's card, not this one's.
  const idx = new Map(out.goals.map((g, i) => [`${g.gameId}|${g.k}`, i]));
  for (const [d, list] of Object.entries(recap || {}))
    for (const g of list) {
      if (Math.floor(g.gameId / 1e6) !== yr) continue;
      // mug is rebuilt client-side from season/team/pid; the rest the card shows
      const { assists, clip, dx, mug, ...keep } = g;
      const row = { ...keep, date: d, type: recapGames?.[g.gameId]?.type ?? null };
      const k = `${g.gameId}|${g.k}`;
      if (idx.has(k)) out.goals[idx.get(k)] = row; else { idx.set(k, out.goals.length); out.goals.push(row); }
    }
  out.goals.sort((a, b) => a.date.localeCompare(b.date) || a.gameId - b.gameId || a.k - b.k);

  out.generated = new Date().toISOString();
  fs.writeFileSync(path, JSON.stringify(out));
  const kb = (fs.statSync(path).size / 1024).toFixed(0);
  console.log(`  players.json: ${Object.keys(out.p).length} players, ${out.dates.length} dates` +
    `${todo.length ? ` (${todo.length} fetched)` : ''}, ${out.goals.length} goals — ${kb} KB`);
  return out;
}
