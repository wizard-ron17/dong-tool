// The full-slate HR log — research data, not shown on the site.
//
// picksHistory logs only the board (Chalk-level bats, ~16 a day), which is
// too few and too pre-selected to measure anything: 474 logged picks couldn't
// resolve base power itself. This logs EVERY scored lineup bat, every day:
// his odds (pHR), Pick Score, every matchup factor as scored, and Kalshi's
// price when it has one — then the next morning's build grades it.
//
// It exists to answer, with real prices: do the matchup factors add anything
// beyond the odds model (and so deserve a weight in it)? Does Bueno's method
// (low power, great spot) find homers? Where are we and the market apart,
// and who was right?
//
// One file per day, research/logs/mlb-slate/{date}.json. A game's rows freeze
// at first pitch (bet-time values); once graded a file never changes again.
import fs from 'node:fs';
import { normName } from './news.js';

const DIR = new URL('../research/logs/mlb-slate/', import.meta.url);
const file = (date) => new URL(`${date}.json`, DIR);
const r3 = (v) => v == null ? null : Math.round(v * 1000) / 1000;

/** Kalshi's HR 1+ book, name -> { bid, ask }, two-sided only. Public, no key. */
export async function fetchKalshiHR() {
  try {
    const j = await (await fetch('https://api.elections.kalshi.com/trade-api/v2/markets?series_ticker=KXMLBHR&status=open&limit=1000')).json();
    const out = {};
    for (const m of j.markets || []) {
      const t = (m.title || '').match(/^(.*?):\s*1\+/); if (!t) continue;
      const bid = +(m.yes_bid_dollars ?? 0), ask = +(m.yes_ask_dollars ?? 1);
      if (bid > 0 && ask < 1) out[normName(t[1])] = { bid, ask };
    }
    return out;
  } catch (e) { return {}; }
}

/** Log today's scored bats; games already under way keep their pre-game rows. */
export function logSlate(date, rows, schedule, names, kalshi = {}) {
  fs.mkdirSync(DIR, { recursive: true });
  let prev = {};
  try { prev = JSON.parse(fs.readFileSync(file(date), 'utf8')); } catch (e) { /* first build of the day */ }
  const prevRows = new Map((prev.rows || []).map(r => [`${r.pid}|${r.pk}`, r]));
  const gameOf = (r) => schedule.find(g => {
    const me = g.home.teamAbbr === r.team ? g.home : g.away.teamAbbr === r.team ? g.away : null;
    const opp = me === g.home ? g.away : g.home;
    return me && String(opp.probablePitcherId ?? '') === String(r.oppPid ?? '');
  }) || schedule.find(g => g.home.teamAbbr === r.team || g.away.teamAbbr === r.team);
  const out = [];
  for (const r of rows) {
    const g = gameOf(r); if (!g) continue;
    const key = `${r.pid}|${g.gamePk}`;
    if (g.started && prevRows.has(key)) { out.push(prevRows.get(key)); continue; }   // frozen at first pitch
    const k = kalshi[normName(names[r.pid] || '')] || null;
    out.push({
      pid: r.pid, name: names[r.pid] || r.pid, team: r.team, opp: r.oppTeam, sp: r.oppPid, pk: g.gamePk,
      ord: r.lineupOrder || null, proj: !!r.projected, pHR: r.pHR ?? null,
      score: r3(r.pickScore), mf: r3(r.matchupFactor), base: r.basePower != null ? Math.round(r.basePower * 1e5) / 1e5 : null,
      f: { recent: r3(r.recentFormRatio), bplat: r3(r.batterPlatoonRatio), svuln: r3(r.pitcherPlatoonRatio),
           stuff: r3(r.pitcherStuffRatio), penv: r3(r.bullpenPlatoonFactor), pa: r3(r.lineupPAFactor),
           park: r3(r.parkRatio), wx: r3(r.weatherRatio) },
      k,
    });
  }
  // a started game whose bats dropped out of today's scoring still keeps its rows
  for (const [key, r] of prevRows) if (!out.some(x => `${x.pid}|${x.pk}` === key) && schedule.some(g => g.gamePk === r.pk && g.started)) out.push(r);
  fs.writeFileSync(file(date), JSON.stringify({ date, updated: new Date().toISOString(), rows: out }));
  return out.length;
}

/** Grade finished days (`scorable` = the build's own rule for picksHistory):
 *  HRs per bat from dailyHRs. Idempotent. */
export function gradeSlates(scorable, dailyHRs) {
  let files = [];
  try { files = fs.readdirSync(DIR).filter(f => f.endsWith('.json')); } catch (e) { return 0; }
  let n = 0;
  for (const f of files) {
    const date = f.slice(0, 10);
    if (!scorable(date)) continue;
    const j = JSON.parse(fs.readFileSync(file(date), 'utf8'));
    if (j.graded) continue;
    const day = dailyHRs[date] ?? {};
    for (const r of j.rows) r.hr = day[r.pid] ?? 0;
    j.graded = new Date().toISOString();
    fs.writeFileSync(file(date), JSON.stringify(j));
    n++;
  }
  return n;
}
