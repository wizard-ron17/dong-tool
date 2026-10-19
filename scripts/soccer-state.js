// Ron's Goal Tool: one final's ESPN summary, reduced to what the app keeps:
// each player who got on the pitch (minutes, goals, assists, shots, shots on
// target, cards), every goal in order, and the two teams' box. The player
// state (soccer/players.json) is the season's running totals, rolled forward
// from these reductions only, never re-fetched.

export const STATE_VERSION = 1;
const num = (v) => { const x = parseFloat(v); return Number.isFinite(x) ? x : 0; };

/** "45'+2'" -> { base: 45, add: 2 }: the stoppage minute stays attached to its half. */
export function clockMin(display, seconds) {
  const m = String(display || '').match(/(\d+)'?(?:\s*\+\s*(\d+))?/);
  if (m) return { base: +m[1], add: +(m[2] || 0) };
  const s = Math.round((seconds || 0) / 60);
  return { base: s, add: 0 };
}

// ESPN's game positions (CD-L, CM-R, AM, CF-L, LWB…) and roster positions (G/D/M/F) -> four families.
// Families are categories, not ratings: the page gives each its own hue, none from the good/bad ramp.
export function posFam(p) {
  const x = String(p || '').toUpperCase().replace(/-[LR]$/, '');
  if (!x || x === 'SUB') return null;
  if (x === 'G' || x === 'GK') return 'GK';
  if (x === 'D' || /^(CD|CB|LB|RB|LWB|RWB|SW|DEF)$/.test(x)) return 'DEF';
  if (x === 'F' || /^(CF|ST|LW|RW|LF|RF|FW)$/.test(x)) return 'FWD';
  return 'MID';                                  // M, CM, DM, AM, LM, RM
}

/** One final's summary -> { id, date, slug, len, home, away, players[], goals[], box{} } */
export function reduceSummary(s, f) {
  const comp = s.header?.competitions?.[0] || {};
  const side = Object.fromEntries((comp.competitors || []).map(c => [c.homeAway, c]));
  const abOf = Object.fromEntries((comp.competitors || []).map(c => [c.team?.id, c.team?.abbreviation]));
  const period = comp.status?.period || 2;
  const len = period > 2 ? 120 : 90;              // extra time in the playoffs
  const KE = s.keyEvents || [];
  const isShootout = (k) => k.shootout || (k.period?.number ?? 0) >= 5;

  // substitutions [in, out] and red cards set each player's time on the pitch
  const subIn = {}, subOut = {}, sentOff = {};
  for (const k of KE) {
    const t = String(k.type?.type || k.type?.text || '').toLowerCase();
    const { base } = clockMin(k.clock?.displayValue, k.clock?.value);
    const ids = (k.participants || []).map(p => p.athlete?.id).filter(Boolean);
    if (t.startsWith('substitution') && ids.length >= 2) { subIn[ids[0]] = Math.min(base, len); subOut[ids[1]] = Math.min(base, len); }
    else if (/red-card|red card/.test(t) && ids[0] && !isShootout(k)) sentOff[ids[0]] = Math.min(base, len);
  }

  // goals in order: the benefiting team (an own goal is credited to the other side), scorer, the assist
  const goals = []; let h = 0, a = 0;
  const pens = {}, pka = {};
  // every penalty taken in play (scored, saved, missed): who takes them is the penalty term's input
  for (const k of KE) {
    if (isShootout(k) || !/penalty/i.test(String(k.type?.text || '')) || /awarded|conceded|won/i.test(String(k.type?.text || ''))) continue;
    const pid = k.participants?.[0]?.athlete?.id; if (pid) pka[pid] = (pka[pid] || 0) + 1;
  }
  for (const k of KE) {
    if (!k.scoringPlay || isShootout(k)) continue;
    const team = abOf[k.team?.id]; if (!team) continue;
    const txt = String(k.type?.text || 'Goal');
    const og = /own goal/i.test(txt), pen = /penalty/i.test(txt);
    const P = (k.participants || []).map(p => ({ pid: p.athlete?.id || null, name: p.athlete?.displayName || '' }));
    if (team === side.home?.team?.abbreviation) h++; else a++;
    const { base, add } = clockMin(k.clock?.displayValue, k.clock?.value);
    if (pen && P[0]?.pid) pens[P[0].pid] = (pens[P[0].pid] || 0) + 1;
    goals.push({ m: base, add, team, pid: P[0]?.pid || null, name: P[0]?.name || '',
      ast: !og && !pen && P[1]?.pid ? { pid: P[1].pid, name: P[1].name } : null,
      kind: og ? 'Own goal' : pen ? 'Penalty' : txt.replace(/^Goal\s*-?\s*/i, '').trim(), h, a });
  }

  const players = [], bench = {};
  for (const r of s.rosters || []) {
    const ab = r.team?.abbreviation;
    for (const x of r.roster || []) {
      const pid = x.athlete?.id; if (!pid) continue;
      if (!x.starter && !x.subbedIn) { (bench[ab] ||= []).push(pid); continue; }   // an unused sub: in the squad, didn't play
      const st = Object.fromEntries((x.stats || []).map(v => [v.name, v.value]));
      const on = x.starter ? 0 : (subIn[pid] ?? len);
      const off = Math.min(subOut[pid] ?? len, sentOff[pid] ?? len);
      players.push({ pid, name: x.athlete.displayName, hs: x.athlete.headshot ? 1 : 0, team: ab, gpos: x.position?.abbreviation || '', starter: !!x.starter,
        min: Math.max(1, off - on), g: num(st.totalGoals), a: num(st.goalAssists), sh: num(st.totalShots), sot: num(st.shotsOnTarget),
        yc: num(st.yellowCards), rc: num(st.redCards), og: num(st.ownGoals), pk: pens[pid] || 0, pka: pka[pid] || 0 });
    }
  }

  const box = {};
  for (const t of s.boxscore?.teams || []) {
    const v = Object.fromEntries((t.statistics || []).map(x => [x.name, x.displayValue]));
    box[t.team?.abbreviation] = { sh: num(v.totalShots), sot: num(v.shotsOnTarget), poss: num(v.possessionPct), cor: num(v.wonCorners),
      fouls: num(v.foulsCommitted), yc: num(v.yellowCards), rc: num(v.redCards), saves: num(v.saves) };
  }
  return { id: f.id, date: f.date, slug: f.slug, len,
    home: { ab: side.home?.team?.abbreviation, score: num(side.home?.score) },
    away: { ab: side.away?.team?.abbreviation, score: num(side.away?.score) },
    players, bench, goals, box };
}

export function freshState(season, prev) {
  return { version: STATE_VERSION, season, done: [], players: {},
    // last season's totals, kept for the Stats page until this season has its own
    prev: prev && prev.season !== season && Object.keys(prev.players || {}).length ? { season: prev.season, players: prev.players } : (prev?.prev || null) };
}

/** Roll one reduced final into the season totals. */
export function applyGame(state, r) {
  if (state.done.includes(r.id)) return;
  state.done.push(r.id);
  for (const x of r.players) {
    const p = (state.players[x.pid] ||= { name: x.name, team: x.team, gp: 0, gs: 0, min: 0, g: 0, a: 0, sh: 0, sot: 0, pk: 0, yc: 0, rc: 0, fam: {} });
    p.name = x.name; p.team = x.team; p.last = r.date; if (x.hs) p.hs = 1;
    p.gp++; if (x.starter) p.gs++;
    for (const k of ['min', 'g', 'a', 'sh', 'sot', 'pk', 'yc', 'rc']) p[k] += x[k] || 0;
    const f = posFam(x.gpos); if (f) p.fam[f] = (p.fam[f] || 0) + 1;
  }
}
