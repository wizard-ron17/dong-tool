// NBA player state — the models' memory (nba/players.json), shared by the build
// and research/nba_parity.mjs so both replay games through the same code.
//   players[pid]: season totals (regular season), his last 10 PLAYED games
//                 (across the season break), starts, first baskets, tip record
//   teams[ab]:    games and what the club ALLOWED (regular season): opponent inputs
//   done:         game ids already applied — each final counts once
export const BOX = ['min', 'pts', 'fgm', 'fga', 'tpm', 'tpa', 'ftm', 'fta', 'oreb', 'dreb', 'reb', 'ast', 'stl', 'blk', 'to'];
const num = (v) => { const x = parseFloat(v); return Number.isFinite(x) ? x : null; };
const made = (v) => { const m = /^(\d+)-(\d+)/.exec(v || ''); return m ? [+m[1], +m[2]] : [0, 0]; };

// ── A game, reduced the way research/nba_fetch.py reduces it ─────────────────
export function reduceSummary(s, ev) {
  const comp = s.header?.competitions?.[0]; if (!comp) return null;
  const side = Object.fromEntries(comp.competitors.map(c => [c.homeAway, c]));
  const tid = Object.fromEntries(comp.competitors.map(c => [c.team.id, c.team.abbreviation]));
  const g = { id: ev.id, date: ev.date, type: ev.type, home: side.home.team.abbreviation, away: side.away.team.abbreviation };
  const plays = s.plays || [];
  const jb = plays.slice(0, 5).find(p => /jump/i.test(p.type?.text || ''));
  if (jb) {
    g.jump = (jb.participants || []).map(a => a.athlete?.id).filter(Boolean).slice(0, 2);
    g.tip = tid[jb.team?.id] || null;
  }
  const fg = plays.find(p => p.scoringPlay && p.shootingPlay && (p.scoreValue || 0) >= 2 && !/free throw/i.test(p.type?.text || ''));
  if (fg) g.fb = { pid: fg.participants?.[0]?.athlete?.id || null, team: tid[fg.team?.id] || null, v: fg.scoreValue };
  const players = [];
  for (const t of s.boxscore?.players || []) {
    const st = t.statistics?.[0]; if (!st) continue;
    for (const a of st.athletes || []) {
      const id = a.athlete?.id; if (!id) continue;
      const v = Object.fromEntries((st.labels || []).map((l, i) => [l, a.stats?.[i]]));
      const [fgm, fga] = made(v.FG), [tpm, tpa] = made(v['3PT']), [ftm, fta] = made(v.FT);
      const min = num(v.MIN) || 0;
      players.push({ pid: id, name: a.athlete.displayName, team: t.team.abbreviation, pos: a.athlete.position?.abbreviation || null,
        st: a.starter ? 1 : 0, dnp: !!a.didNotPlay || !(min > 0), reason: a.reason || null,
        min, pts: num(v.PTS) || 0, fgm, fga, tpm, tpa, ftm, fta, oreb: num(v.OREB) || 0, dreb: num(v.DREB) || 0,
        reb: num(v.REB) || 0, ast: num(v.AST) || 0, stl: num(v.STL) || 0, blk: num(v.BLK) || 0, to: num(v.TO) || 0 });
    }
  }
  return { g, players };
}

// ── Player state: the models' memory, updated from new finals only ──────────
export function freshState(season, priors) {
  const players = {};
  for (const [pid, p] of Object.entries(priors?.players || {})) {
    players[pid] = { name: p.name, team: p.team, pos: p.pos, gp: 0, gs: 0, ...Object.fromEntries(BOX.map(k => [k, 0])),
      last10: p.last10 || [], fb: p.fb || 0, starts: p.starts || 0, tipn: p.tipn || 0, tipw: p.tipw || 0 };
  }
  return { season, priorsSeason: priors?.season || null, done: [], players, teams: {} };
}
export function applyGame(state, r) {
  const { g, players } = r;
  const starters = players.filter(p => p.st && !p.dnp);
  if (g.type === 2 && g.fb?.pid && starters.length === 10) {
    for (const p of starters) (state.players[p.pid] ||= newPlayer(p)).starts++;
    (state.players[g.fb.pid] ||= newPlayer({ name: '', team: g.fb.team })).fb++;
  }
  const jt = Object.fromEntries(starters.map(p => [p.pid, p.team]));
  if (g.tip) for (const j of g.jump || []) if (jt[j]) { const s = (state.players[j] ||= newPlayer({})); s.tipn++; if (jt[j] === g.tip) s.tipw++; }
  for (const p of players) {
    if (p.dnp) continue;
    const s = (state.players[p.pid] ||= newPlayer(p));
    Object.assign(s, { name: p.name, team: p.team, pos: p.pos || s.pos });
    if (g.type === 2) { s.gp++; s.gs += p.st; for (const k of BOX) s[k] += p[k]; }
    s.last10 = [...(s.last10 || []), { d: g.date, st: p.st, ...Object.fromEntries(BOX.map(k => [k, p[k]])) }].slice(-10);
  }
  // each club's last game (any kind): tonight's rest is days since it
  state.teams ||= {};
  for (const ab of [g.home, g.away]) {
    const t = (state.teams[ab] ||= { gp: 0, ...Object.fromEntries(BOX.map(k => [k + '_allowed', 0])) });
    t.last = g.date; t.dates = [...(t.dates || []), g.date].slice(-5);   // "played within the team's last 3 games"
  }
  // what each club allowed (the opponent's side of the box), regular season only
  if (g.type === 2) {
    state.teams ||= {};
    for (const [me, opp] of [[g.home, g.away], [g.away, g.home]]) {
      const t = (state.teams[me] ||= { gp: 0, ...Object.fromEntries(BOX.map(k => [k + '_allowed', 0])) });
      t.gp++;
      for (const p of players) if (p.team === opp && !p.dnp) for (const k of BOX) t[k + '_allowed'] += p[k];
    }
  }
  state.done.push(g.id);
}
const newPlayer = (p) => ({ name: p.name || '', team: p.team || null, pos: p.pos || null, gp: 0, gs: 0,
  ...Object.fromEntries(BOX.map(k => [k, 0])), last10: [], fb: 0, starts: 0, tipn: 0, tipw: 0 });

