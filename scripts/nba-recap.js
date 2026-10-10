// The Recap's detail for /nba — built around the markets the tool prices:
// the first basket, every three, and the double/triple-doubles.
//
// ESPN's play-by-play carries a floor position for every field-goal attempt
// (none for free throws): x across the court 0-50 ft, y out from the rim, both
// teams folded onto one half. Fitted against the shot distances in the play
// text, the rim sits at (25, 1), whole-foot rounding, 0.4 ft mean error. The
// page draws a half court on that frame and animates the shots — there are no
// NBA clips to show (nba.com refuses scripts; ESPN's video slot is empty).
//
//   nba/recap.json           every final of the last RECAP_DAYS, detail per game
//   nba/prices-history.json  the boards' last pre-tip prices, by date — the
//                            page grades a night against what we priced
import fs from 'node:fs';

const RECAP_PATH = new URL('../nba/recap.json', import.meta.url);
const HIST_PATH = new URL('../nba/prices-history.json', import.meta.url);
const HIST_DAYS = 30;
const clockSec = (s) => { const m = /^(\d+):(\d+)/.exec(s || ''); return m ? +m[1] * 60 + +m[2] : 0; };
const onFloor = (c) => c && c.x > -100 && c.y > -100;
// the shot's kind, short: "Step Back Jump Shot" -> "step-back jumper"
const kind = (t) => (t || '').toLowerCase().replace(/ shot$/, '').replace(/jump$/, 'jumper').replace(/step back/, 'step-back')
  .replace(/pullup/, 'pull-up').replace(/fade away/, 'fadeaway').replace(/ jump /, ' ')
  .replace(/^jump shot bank$/, 'bank jumper').replace(/^heave jumper$/, 'heave');

/**
 * One final, from its ESPN summary and the reduced box (scripts/nba-state.js reduceSummary).
 * threes: [shooter, x, y, made 0/1, period, seconds left, assister | null, kind]
 * box:    pid -> [name, team, starter, min, pts, reb, ast, stl, blk, tpm, tpa]
 */
export function recapDetail(s, ev, r) {
  const comp = s.header?.competitions?.[0]; if (!comp || !r) return null;
  const side = Object.fromEntries(comp.competitors.map(c => [c.homeAway, c]));
  const tid = Object.fromEntries(comp.competitors.map(c => [c.team.id, c.team.abbreviation]));
  const plays = s.plays || [];
  const ath = (p, i) => p.participants?.[i]?.athlete?.id || null;
  const threes = [];
  for (const p of plays) {
    if (!p.shootingPlay || p.pointsAttempted !== 3 || !onFloor(p.coordinate)) continue;
    const made = p.scoringPlay ? 1 : 0;
    threes.push([ath(p, 0), p.coordinate.x, p.coordinate.y, made, p.period?.number || 0, clockSec(p.clock?.displayValue),
      made && /assists\)/.test(p.text || '') ? ath(p, 1) : null, kind(p.type?.text)]);
  }
  // the first basket: the first made field goal (reduceSummary's rule), with where and how
  const fg = plays.find(p => p.scoringPlay && p.shootingPlay && (p.scoreValue || 0) >= 2 && !/free throw/i.test(p.type?.text || ''));
  const fb = fg ? { pid: ath(fg, 0), team: tid[fg.team?.id] || null, v: fg.scoreValue, x: onFloor(fg.coordinate) ? fg.coordinate.x : null,
    y: onFloor(fg.coordinate) ? fg.coordinate.y : null, per: fg.period?.number || 1, sec: clockSec(fg.clock?.displayValue),
    kind: kind(fg.type?.text), ast: /assists\)/.test(fg.text || '') ? ath(fg, 1) : null, text: fg.text || '' } : null;
  const box = {};
  for (const p of r.players) if (!p.dnp) box[p.pid] = [p.name, p.team, p.st, Math.round(p.min), p.pts, p.reb, p.ast, p.stl, p.blk, p.tpm, p.tpa];
  const sc = (x) => +x.score || 0;
  return { gid: ev.id, date: ev.date, type: ev.type, home: side.home.team.abbreviation, away: side.away.team.abbreviation,
    hs: sc(side.home), as: sc(side.away), ot: Math.max(0, (comp.status?.period || 4) - 4),
    tip: r.g.tip ? { won: r.g.tip, jump: r.g.jump || [] } : null, fb, threes, box };
}

/**
 * nba/league-days.json: one row per regular-season final, kept for the whole season (the
 * Stats tab's League trend chart: threes made per game, by day). Unlike the recap it is
 * never trimmed. Keyed by game id, so a re-fetched final just rewrites its own row.
 *   games: id -> [date, away, home, 3PM away, 3PM home, 3PA away, 3PA home]
 * A new season starts the file over. Games tallied before this file existed are not backfilled.
 */
const DAYS_PATH = new URL('../nba/league-days.json', import.meta.url);
export function leagueRow(r) {
  const { g, players } = r;
  if (g.type !== 2 || !players.some(p => !p.dnp)) return null;
  const sum = (team, k) => players.filter(p => p.team === team).reduce((a, p) => a + p[k], 0);
  return [g.id, [g.date, g.away, g.home, sum(g.away, 'tpm'), sum(g.home, 'tpm'), sum(g.away, 'tpa'), sum(g.home, 'tpa')]];
}
export function saveLeagueDays(rows, season) {
  let L = { season, games: {} };
  try { const j = JSON.parse(fs.readFileSync(DAYS_PATH, 'utf8')); if (j.season === season) L = j; } catch (e) { /* first build, or a new season */ }
  for (const r of rows) if (r) L.games[r[0]] = r[1];
  fs.writeFileSync(DAYS_PATH, JSON.stringify(L));
  return Object.keys(L.games).length;
}

/** Keep the last `days` of finals: the new ones added, the old ones dropped. */
export function saveRecap(details, today, days, shiftDate) {
  let R = { games: {} };
  try { R = JSON.parse(fs.readFileSync(RECAP_PATH, 'utf8')); } catch (e) { /* first build */ }
  for (const d of details) if (d) R.games[d.gid] = d;
  const from = shiftDate(today, -days);
  for (const [id, g] of Object.entries(R.games)) if (g.date < from) delete R.games[id];
  fs.writeFileSync(RECAP_PATH, JSON.stringify(R));
  return Object.keys(R.games).length;
}
export const recapHas = () => { try { return new Set(Object.keys(JSON.parse(fs.readFileSync(RECAP_PATH, 'utf8')).games)); } catch (e) { return new Set(); } };

/**
 * The boards' prices for a slate date, rewritten every build until the slate is
 * over — rows freeze at tip, so what stays is the last pre-tip price.
 *   t3:  pid -> [mu, P(1+) .. P(5+)]      dbl: pid -> [P(DD), P(TD)]
 *   fb:  gid -> pid -> P(first basket)
 */
export function savePrices(date, { threes, doubles, first }, today, shiftDate) {
  if (!date) return;
  let H = { days: {} };
  try { H = JSON.parse(fs.readFileSync(HIST_PATH, 'utf8')); } catch (e) { /* first build */ }
  H.days[date] = {
    t3: Object.fromEntries((threes || []).map(r => [r.pid, [r.mu, ...r.p]])),
    dbl: Object.fromEntries((doubles || []).map(r => [r.pid, [r.dd, r.td]])),
    fb: Object.fromEntries((first || []).map(g => [g.gid, Object.fromEntries(g.players.map(x => [x.pid, x.p]))])),
  };
  const from = shiftDate(today, -HIST_DAYS);
  for (const d of Object.keys(H.days)) if (d < from) delete H.days[d];
  fs.writeFileSync(HIST_PATH, JSON.stringify(H));
}
