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

// ── Implied scoring rates ──────────────────────────────────────────────────
// What the closing line says each side scores, for the schedule's in-game win
// probability (research/nhl_winprob.py; research/nhl_odds.py is the same maths).
// The total's de-vigged over price fixes the game's expected goals, the
// moneyline's de-vigged home price splits it.
const imp = (a) => a > 0 ? 100 / (a + 100) : -a / (-a + 100);
const fair = (a, b) => imp(a) / (imp(a) + imp(b));
function poisPmf(l, K = 16) { const p = [Math.exp(-l)]; for (let k = 1; k < K; k++) p.push(p[k - 1] * l / k); return p; }
const poisSf = (L, l) => 1 - poisPmf(l, Math.floor(L) + 1).reduce((a, b) => a + b, 0);
function bisect(f, lo, hi) {
  let flo = f(lo);
  if (flo * f(hi) > 0) return null;
  for (let i = 0; i < 60; i++) { const m = (lo + hi) / 2, fm = f(m); if (fm * flo > 0) { lo = m; flo = fm; } else hi = m; }
  return (lo + hi) / 2;
}
export function homeWin(lh, la) {           // home ahead after regulation, plus half the ties
  const ph = poisPmf(lh), pa = poisPmf(la);
  let w = 0, t = 0;
  for (let i = 0; i < ph.length; i++) for (let j = 0; j < pa.length; j++) { if (i > j) w += ph[i] * pa[j]; else if (i === j) t += ph[i] * pa[j]; }
  return w + t / 2;
}
/** { h, a } expected goals per 60 for each side, or null when the line is incomplete. */
export function impliedRates(L) {
  if (L?.tot?.line == null || L.tot.o == null || L.tot.u == null || L.ml?.h == null || L.ml?.a == null) return null;
  const lam = bisect(x => poisSf(L.tot.line, x) - fair(L.tot.o, L.tot.u), 1, 14);
  if (!lam) return null;
  const s = bisect(x => homeWin(lam * x, lam * (1 - x)) - fair(L.ml.h, L.ml.a), 0.2, 0.8) ?? 0.5;
  return { h: +(lam * s).toFixed(3), a: +(lam * (1 - s)).toFixed(3) };
}
