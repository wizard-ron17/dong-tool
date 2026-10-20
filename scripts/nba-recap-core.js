// Ron's Hoop Tool: one game's recap detail (every three with where it was taken,
// the first basket, each player's line) from ESPN's summary. Pure, so the build
// (scripts/nba-recap.js) and the page's live recap (nba/index.html, a game still
// being played, off ESPN's live summary) reduce a game with the same code.
export const clockSec = (s) => { const m = /^(\d+):(\d+)/.exec(s || ''); return m ? +m[1] * 60 + +m[2] : 0; };
export const onFloor = (c) => c && c.x > -100 && c.y > -100;
// the shot's kind, short: "Step Back Jump Shot" -> "step-back jumper"
export const kind = (t) => (t || '').toLowerCase().replace(/ shot$/, '').replace(/jump$/, 'jumper').replace(/step back/, 'step-back')
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
