// Sportsbook lines off ESPN's public scoreboard, for the MLB and NFL schedules
// (the NHL's own copy lives in nhl-lines.js): the DraftKings moneyline, spread
// (run line / puck line) and total, each as it OPENED and as it stands now,
// plus the path in between.
//
// ESPN only carries open and current. The path is ours: every build that sees
// a game's line different from the last one it recorded appends a move, so a
// line's history is as fine-grained as the build schedule that watched it —
// hourly for MLB, daily through the week and hourly on game days for the NFL.
// The history rides on each game in data.json and is carried build to build.
//
// Display only. The NFL Picks model keeps using nflverse's lines as its input.

const SB = {
  nfl: 'https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard?dates=',
  mlb: 'https://site.api.espn.com/apis/site/v2/sports/baseball/mlb/scoreboard?dates=',
};
const num = (x) => { const v = parseFloat(String(x ?? '').replace(/^[ou]/, '')); return Number.isFinite(v) ? v : null; };

async function scoreboard(sport, date) {
  for (let i = 1; i <= 3; i++) {
    try {
      const r = await fetch(SB[sport] + date.replace(/-/g, ''), { headers: { 'User-Agent': 'dong-tool/1.0' } });
      if (r.ok) return await r.json();
    } catch (e) { /* retry */ }
    await new Promise(res => setTimeout(res, 500 * i));
  }
  return null;
}

/**
 * @param sport  'nfl' | 'mlb'
 * @param dates  YYYY-MM-DD dates to look up
 * @param ab     ESPN abbreviation -> the app's own
 * @returns [{ date, start, away, home, line }] where line =
 *   { book, cur: { sp, tot, mlH, mlA, spO, oO, uO }, open: { sp, tot, mlH, mlA } }
 *   sp is the HOME side's spread (negative = home favoured)
 */
export async function fetchEspnLines(sport, dates, ab = {}) {
  const out = [];
  const A = (x) => ab[x] || x;
  for (const d of dates) {
    const sb = await scoreboard(sport, d);
    for (const ev of sb?.events || []) {
      const c = ev.competitions?.[0], o = c?.odds?.[0];
      if (!o) continue;
      const side = Object.fromEntries((c.competitors || []).map(x => [x.homeAway, A(x.team?.abbreviation)]));
      const ps = o.pointSpread || {}, tt = o.total || {}, ml = o.moneyline || {};
      const at = (x, k) => x?.[k] || {};
      const cur = {
        sp: num(at(ps.home, 'close').line),
        tot: num(at(tt.over, 'close').line) ?? o.overUnder ?? null,
        mlH: num(at(ml.home, 'close').odds), mlA: num(at(ml.away, 'close').odds),
        spO: num(at(ps.home, 'close').odds), oO: num(at(tt.over, 'close').odds), uO: num(at(tt.under, 'close').odds),
      };
      const open = { sp: num(at(ps.home, 'open').line), tot: num(at(tt.over, 'open').line),
                     mlH: num(at(ml.home, 'open').odds), mlA: num(at(ml.away, 'open').odds) };
      out.push({ date: d, start: ev.date || c.date || null, away: side.away, home: side.home,
                 line: { book: o.provider?.name || null, cur, open } });
    }
  }
  return out;
}

/**
 * Carry a game's line history forward and append this build's reading when it
 * differs. `prev` is the line object the game had last build (or undefined).
 * Moves are [iso time, home spread, total, home ML, away ML].
 */
export function trackLine(prev, fresh, now = new Date().toISOString()) {
  const moves = (prev?.moves || []).slice();
  const c = fresh.cur, last = moves[moves.length - 1];
  const reading = [now, c.sp, c.tot, c.mlH, c.mlA];
  if (!last || last[1] !== c.sp || last[2] !== c.tot || last[3] !== c.mlH || last[4] !== c.mlA) moves.push(reading);
  // the book's own open when ESPN has it; else the first line we saw
  const first = moves[0] ? { sp: moves[0][1], tot: moves[0][2], mlH: moves[0][3], mlA: moves[0][4] } : null;
  return { ...fresh, open: fresh.open?.sp != null || fresh.open?.tot != null ? fresh.open : prev?.open || first, moves: moves.slice(-60) };
}
