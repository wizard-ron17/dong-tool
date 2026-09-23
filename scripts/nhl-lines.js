// Pre-game betting lines for the schedule, off ESPN's public scoreboard: the
// DraftKings moneyline, puck line and total, each with its price. One request
// per night; ESPN posts a regular-season night's lines well ahead (opening
// week is up days early) and drops them from the scoreboard once a game is
// final, so only upcoming nights are worth asking about. Preseason has none.
//
// Lines are shown, not modelled — research/nhl_odds*.py tested them against
// saves, goals allowed and anytime goals and they added <=0.12% to each.
const SB = 'https://site.api.espn.com/apis/site/v2/sports/hockey/nhl/scoreboard?dates=';
const ESPN2NHL = { LA: 'LAK', NJ: 'NJD', SJ: 'SJS', TB: 'TBL', UTAH: 'UTA', MON: 'MTL' };
const ab = (x) => ESPN2NHL[x] || x;
const num = (x) => { const v = parseFloat(String(x ?? '').replace(/^[ou]/, '')); return Number.isFinite(v) ? v : null; };

async function scoreboard(date) {
  for (let i = 1; i <= 3; i++) {
    try {
      const r = await fetch(SB + date.replace(/-/g, ''), { headers: { 'User-Agent': 'dong-tool/1.0' } });
      if (r.ok) return await r.json();
    } catch (e) { /* retry */ }
    await new Promise(res => setTimeout(res, 500 * i));
  }
  return null;
}

/**
 * @param dates  upcoming dates to look up (YYYY-MM-DD)
 * @returns Map "date|away|home" -> { book, ml:{a,h}, pl:{a:{line,odds},h:{line,odds}}, tot:{line,o,u} }
 */
export async function fetchLines(dates) {
  const out = new Map();
  for (const d of dates) {
    const sb = await scoreboard(d);
    for (const ev of sb?.events || []) {
      const c = ev.competitions?.[0], o = c?.odds?.[0];
      if (!o) continue;
      const side = Object.fromEntries((c.competitors || []).map(x => [x.homeAway, ab(x.team?.abbreviation)]));
      const close = (x) => x?.close || x?.open || {};
      const ml = o.moneyline || {}, ps = o.pointSpread || {}, tt = o.total || {};
      const line = {
        book: o.provider?.name || null,
        ml: { a: num(close(ml.away).odds), h: num(close(ml.home).odds) },
        pl: { a: { line: num(close(ps.away).line), odds: num(close(ps.away).odds) },
              h: { line: num(close(ps.home).line), odds: num(close(ps.home).odds) } },
        tot: { line: num(close(tt.over).line) ?? o.overUnder ?? null, o: num(close(tt.over).odds), u: num(close(tt.under).odds) },
      };
      // the headline numbers when the market block is missing
      if (line.tot.line == null && o.overUnder != null) line.tot.line = o.overUnder;
      if (line.pl.h.line == null && o.spread != null) {
        const homeFav = !!o.homeTeamOdds?.favorite;
        line.pl.h.line = homeFav ? -Math.abs(o.spread) : Math.abs(o.spread);
        line.pl.a.line = -line.pl.h.line;
      }
      out.set(`${d}|${side.away}|${side.home}`, line);
    }
  }
  return out;
}
