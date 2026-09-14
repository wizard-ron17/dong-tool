// Live results log for the NFL boards — what we priced before each game, and
// what actually happened, graded one game at a time.
//
// Two jobs, both run on every build:
//
//   snapshot  For every game that has not kicked off yet, (re)write its entry
//             from the current board. A build after kickoff leaves the entry
//             alone, so each game keeps the LAST board published before it
//             started — injuries, inactives and all. The old picksHistory froze
//             a whole week on its first build, days early, and never updated.
//
//   grade     For every logged game ESPN reports as final, read its box score
//             and record the outcome for each logged player. No waiting for the
//             week to finish, and no waiting for nflverse's overnight refresh.
//
// Lives in nfl/results.json, not data.json: the app only needs it when someone
// opens a Results tab, and it grows every week.
import fs from 'node:fs';
import { UA, REL, fetchOptional, parseCsv, num } from './nflverse.js';

const ESPN = 'https://site.api.espn.com/apis/site/v2/sports/football/nfl';
const ESPN_TEAM = { WSH: 'WAS', LAR: 'LA' };          // ESPN abbreviation -> nflverse
const KEEP_SEASONS = 2;

const r3 = (x) => (x == null ? null : Math.round(x * 1000) / 1000);
const r2 = (x) => (x == null ? null : Math.round(x * 100) / 100);

/** Kickoff as a Date. nfldata's gameday/gametime are US Eastern wall-clock. */
export function kickoffUtc(gameday, gametime) {
  if (!gameday) return null;
  const [y, m, d] = gameday.split('-').map(Number);
  const [hh, mm] = (gametime || '13:00').split(':').map(Number);
  // Guess UTC = ET + 4h, then correct by the real New York offset on that date
  // so games after the November DST change land right too.
  const guess = new Date(Date.UTC(y, m - 1, d, hh + 4, mm));
  const ny = new Date(guess.toLocaleString('en-US', { timeZone: 'America/New_York' }));
  const utc = new Date(guess.toLocaleString('en-US', { timeZone: 'UTC' }));
  const offsetH = Math.round((utc - ny) / 36e5);       // 4 in EDT, 5 in EST
  return new Date(Date.UTC(y, m - 1, d, hh + offsetH, mm));
}

export function readLog(path) {
  try { return JSON.parse(fs.readFileSync(path, 'utf8')); } catch (e) { return { games: {} }; }
}

const nearest = (lines, mu) => lines.reduce((b, L) => (Math.abs(L - mu) < Math.abs(b - mu) ? L : b), lines[0]);

/**
 * Board rows for one game, compact. Arrays rather than objects: a season of
 * these is several hundred thousand values.
 *   td   [pid, name, team, pos, p(1+), p(2+), p(first), p(last)]
 *   pass [pid, name, team, proj, p(1+), p(2+), p(3+)]
 *   rec  [pid, name, team, pos, mu, line, p(over line)]
 *   cmp  [pid, name, team, mu, line, p(over line)]
 *   int  [pid, name, team, mu, p(over 0.5), p(over 1.5)]
 * rec/cmp keep the projection, so the app can price any other line from the
 * model's alpha without storing the whole ladder.
 */
function boardFor(gameId, b) {
  const out = {};
  if (b.picks?.length) {
    out.td = b.picks.filter(p => p.gameId === gameId)
      .map(p => [p.pid, p.name, p.team, p.pos, r3(p.p), r3(p.p2), r3(p.pFirst), r3(p.pLast)]);
    out.pass = b.picks.filter(p => p.gameId === gameId && p.pass?.p)
      .map(p => [p.pid, p.name, p.team, r2(p.pass.proj), r3(p.pass.p['1']), r3(p.pass.p['2']), r3(p.pass.p['3'])]);
  }
  if (b.receptions?.length && b.recLines?.length) {
    out.rec = b.receptions.filter(r => r.gameId === gameId).map(r => {
      const L = nearest(b.recLines, r.mu);
      return [r.pid, r.name, r.team, r.pos, r2(r.mu), L, r3(r.p[L] ?? r.p[String(L)])];
    });
  }
  if (b.completions?.length && b.cmpLines?.length) {
    out.cmp = b.completions.filter(r => r.gameId === gameId).map(r => {
      const L = nearest(b.cmpLines, r.mu);
      return [r.pid, r.name, r.team, r2(r.mu), L, r3(r.p[L] ?? r.p[String(L)])];
    });
  }
  if (b.interceptions?.length) {
    out.int = b.interceptions.filter(r => r.gameId === gameId)
      .map(r => [r.pid, r.name, r.team, r3(r.mu), r3(r.p['0.5']), r3(r.p['1.5'])]);
  }
  return out;
}

/**
 * Write each not-yet-started game in the board's week from the current board.
 *   board: { season, week, generatedAt, picks, receptions, recLines, completions, cmpLines }
 *   now:   the moment "before kickoff" is judged against (a Date)
 */
export function snapshot(log, schedule, board, now = new Date()) {
  let wrote = 0;
  for (const g of schedule) {
    if (g.week !== board.week) continue;
    const kick = kickoffUtc(g.gameday, g.gametime);
    if (!kick || now >= kick) continue;              // started: keep what we had
    const prev = log.games[g.gameId];
    const rows = boardFor(g.gameId, board);
    // A market the board does not carry this build (a failed sub-model) must
    // not erase what an earlier build logged for it.
    log.games[g.gameId] = {
      id: g.gameId, season: board.season, week: g.week, kick: kick.toISOString(),
      away: g.away, home: g.home, snapAt: board.generatedAt,
      td: rows.td ?? prev?.td, pass: rows.pass ?? prev?.pass,
      rec: rows.rec ?? prev?.rec, cmp: rows.cmp ?? prev?.cmp, int: rows.int ?? prev?.int,
      final: false, res: null,
    };
    wrote++;
  }
  return wrote;
}

async function getJson(url) {
  for (let a = 0; a < 3; a++) {
    try {
      const r = await fetch(url, { headers: { 'User-Agent': UA } });
      if (r.ok) return await r.json();
    } catch (e) {}
    await new Promise(r => setTimeout(r, 1200));
  }
  return null;
}

const statIdx = (cat, label) => cat.labels.indexOf(label);

/**
 * One final game's outcomes, keyed by gsis id.
 *   td  every touchdown a player is credited with — rushing, receiving,
 *       kick/punt return, defensive — which is how books settle anytime TD.
 *       A quarterback's passing touchdowns are not his.
 *   first/last  the scorer of the game's first and last touchdown
 */
function readBox(summary, espnToGsis, nameTeamToGsis) {
  const td = {}, ptd = {}, rec = {}, cmp = {}, att = {}, ints = {}, inBox = new Set();
  const names = [];                                  // [displayName, gsis] for scoring-play text
  const gsisOf = (ath, team) => espnToGsis.get(String(ath.id))
    ?? nameTeamToGsis.get(`${(ath.displayName || '').toLowerCase()}|${team}`) ?? null;
  for (const side of summary.boxscore?.players ?? []) {
    const team = ESPN_TEAM[side.team.abbreviation] ?? side.team.abbreviation;
    for (const cat of side.statistics ?? []) {
      for (const a of cat.athletes ?? []) {
        const pid = gsisOf(a.athlete, team);
        if (!pid) continue;
        inBox.add(pid);
        names.push([a.athlete.displayName, pid]);
        const s = a.stats || [];
        const v = (label) => { const i = statIdx(cat, label); return i < 0 ? 0 : (parseFloat(s[i]) || 0); };
        if (cat.name === 'passing') {
          const [c, at] = String(s[statIdx(cat, 'C/ATT')] || '0/0').split('/').map(Number);
          cmp[pid] = c || 0; att[pid] = at || 0; ptd[pid] = v('TD'); ints[pid] = v('INT');
        } else if (cat.name === 'receiving') {
          rec[pid] = v('REC'); td[pid] = (td[pid] || 0) + v('TD');
        } else if (['rushing', 'kickReturns', 'puntReturns', 'defensive'].includes(cat.name)) {
          td[pid] = (td[pid] || 0) + v('TD');
        }
      }
    }
  }
  // First/last TD from the scoring plays, which name the scorer first
  // ("Cam Skattebo 3 Yd Rush (… Kick)"). Longest matching name wins, so a
  // "Josh Allen" never steals a "Josh Allen Jr." score.
  names.sort((a, b) => b[0].length - a[0].length);
  // A touchdown is a scoring play worth 6+ points. ESPN's play labels are not
  // reliable for this — a strip-sack returned for a score is filed as "Sack Opp
  // Fumble Recovery" with no "touchdown" anywhere in it.
  let pa = 0, ph = 0;
  const tdPlays = (summary.scoringPlays ?? []).filter(p => {
    const jump = (+p.awayScore - pa) + (+p.homeScore - ph);
    pa = +p.awayScore; ph = +p.homeScore;
    return jump >= 6;
  });
  const scorer = (p) => (names.find(([n]) => (p.text || '').startsWith(n)) || [])[1] ?? null;
  return {
    td, ptd, rec, cmp, att, ints, inBox: [...inBox],
    first: tdPlays.length ? scorer(tdPlays[0]) : null,
    last: tdPlays.length ? scorer(tdPlays[tdPlays.length - 1]) : null,
  };
}

/**
 * Grade every logged game that has finished and is not graded yet.
 *   ids: { espnToGsis: Map, nameTeamToGsis: Map }  (only needed if anything grades)
 * Returns { graded, live } where live marks games in progress for the app.
 */
export async function grade(log, loadIds, now = new Date()) {
  // Also re-read a final game graded before a stat was tracked (interceptions
  // arrived after week 1 was already graded) — once, then it has the field.
  const stale = (g) => g.final && g.res && g.res.ints === undefined;
  const due = Object.values(log.games).filter(g => (!g.final && new Date(g.kick) <= now) || stale(g));
  if (!due.length) return { graded: 0 };
  let ids = null, graded = 0;
  const weeks = [...new Set(due.map(g => `${g.season}|${g.week}`))];
  for (const wk of weeks) {
    const [season, week] = wk.split('|').map(Number);
    const sb = await getJson(`${ESPN}/scoreboard?dates=${season}&seasontype=2&week=${week}`);
    if (!sb?.events) { console.log(`  results: ESPN scoreboard unavailable for ${season} wk ${week}`); continue; }
    for (const ev of sb.events) {
      const comp = ev.competitions?.[0];
      const teams = Object.fromEntries((comp?.competitors ?? []).map(c => [c.homeAway, ESPN_TEAM[c.team.abbreviation] ?? c.team.abbreviation]));
      const g = due.find(x => x.week === week && x.home === teams.home && x.away === teams.away);
      if (!g) continue;
      if (!ev.status?.type?.completed) { g.live = ev.status?.type?.state === 'in'; continue; }
      const keep = stale(g) ? { dnp: g.res.dnp, snapsChecked: g.res.snapsChecked, gradedAt: g.gradedAt } : null;
      const summary = await getJson(`${ESPN}/summary?event=${ev.id}`);
      if (!summary?.boxscore) continue;
      ids ??= await loadIds();
      g.res = readBox(summary, ids.espnToGsis, ids.nameTeamToGsis);
      g.score = { away: +(comp.competitors.find(c => c.homeAway === 'away')?.score ?? 0),
                  home: +(comp.competitors.find(c => c.homeAway === 'home')?.score ?? 0) };
      g.final = true; delete g.live; g.gradedAt = now.toISOString();
      if (keep) {                                   // a re-read keeps what the first grading settled
        if (keep.snapsChecked) { g.res.dnp = keep.dnp; g.res.snapsChecked = true; }
        g.gradedAt = keep.gradedAt;
      }
      graded++;
    }
  }
  return { graded };
}

/**
 * Sat out, or played and did nothing? ESPN's box score only lists players who
 * recorded a stat, so a receiver missing from it either caught nothing (a loss
 * on the over) or never played (books void the bet). nflverse snap counts tell
 * them apart, but only the morning after — until then the row reads as 0 and
 * `snapsChecked` stays false.
 *   ids.xwalk: pfr id -> gsis id
 */
export async function resolveDnp(log, loadIds) {
  const open = Object.values(log.games).filter(g => g.final && !g.res?.snapsChecked);
  if (!open.length) return 0;
  const bySeason = {};
  for (const g of open) (bySeason[g.season] ??= []).push(g);
  let ids = null, resolved = 0;
  for (const [season, games] of Object.entries(bySeason)) {
    const txt = await fetchOptional(`${REL}/snap_counts/snap_counts_${season}.csv`);
    if (!txt) continue;
    ids ??= await loadIds();
    const { idx, rows } = parseCsv(txt);
    const played = new Set(), teamsIn = new Set();          // `${week}|${team}`
    for (const r of rows) {
      teamsIn.add(`${r[idx.week]}|${r[idx.team]}`);
      if (!(num(r[idx.offense_snaps]) > 0 || num(r[idx.defense_snaps]) > 0 || num(r[idx.st_snaps]) > 0)) continue;
      const pid = ids.xwalk.get(r[idx.pfr_player_id]);
      if (pid) played.add(`${r[idx.week]}|${pid}`);
    }
    for (const g of games) {
      if (!teamsIn.has(`${g.week}|${g.home}`) || !teamsIn.has(`${g.week}|${g.away}`)) continue;
      const box = new Set(g.res.inBox);
      const logged = new Set([...(g.td ?? []), ...(g.pass ?? []), ...(g.rec ?? []), ...(g.cmp ?? []), ...(g.int ?? [])].map(r => r[0]));
      g.res.dnp = [...logged].filter(pid => !box.has(pid) && !played.has(`${g.week}|${pid}`));
      g.res.snapsChecked = true;
      resolved++;
    }
  }
  return resolved;
}

/** Drop seasons beyond KEEP_SEASONS so the file cannot grow without bound. */
export function trim(log) {
  const seasons = [...new Set(Object.values(log.games).map(g => g.season))].sort((a, b) => b - a);
  const keep = new Set(seasons.slice(0, KEEP_SEASONS));
  for (const [id, g] of Object.entries(log.games)) if (!keep.has(g.season)) delete log.games[id];
}
