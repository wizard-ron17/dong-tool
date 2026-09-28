// Parity: does the BUILD compute the model's inputs the way RESEARCH did?
//
//   node research/nba_parity.mjs          # -> research/nba_parity.csv, then
//   python3 research/nba_parity_check.py  # compares against research's own numbers
//
// The NHL saves lesson: a research prior the build can't reproduce prices wrong
// in production while every backtest looks fine. This replays every cached game
// in date order through scripts/nba-state.js (the build's own state) and, before
// each regular-season game, records every player's inputs as scripts/nba-models.js
// computes them. At each season break the finished season becomes "prev", as
// nba/priors.json does for the live build.
import fs from 'node:fs';
import path from 'node:path';
import { freshState, applyGame } from '../scripts/nba-state.js';
import { minutesInputs, threesRate, oppThreesRatio, fam, statRate, statForm, statOpp, MODEL } from '../scripts/nba-models.js';

const CACHE = new URL('./.cache/nba/', import.meta.url).pathname;
const files = fs.readdirSync(CACHE).flatMap(y => fs.readdirSync(path.join(CACHE, y)).map(f => path.join(CACHE, y, f)));
const games = files.map(f => JSON.parse(fs.readFileSync(f, 'utf8'))).sort((a, b) => a.game.date.localeCompare(b.game.date) || a.game.id.localeCompare(b.game.id));

// research cache -> the build's reduced shape
const toReduced = ({ game: g, players }) => ({
  g: { id: g.id, date: g.date, type: g.type, home: g.home, away: g.away, jump: g.jump, tip: g.tip_team,
       fb: g.first_fg ? { pid: g.first_fg.pid, team: g.first_fg.team } : null },
  players: players.map(p => ({ ...p, st: p.starter ? 1 : 0, dnp: p.dnp || !((p.min || 0) > 0),
    ...Object.fromEntries(['min', 'pts', 'fgm', 'fga', 'tpm', 'tpa', 'ftm', 'fta', 'oreb', 'dreb', 'reb', 'ast', 'stl', 'blk', 'to'].map(k => [k, p[k] || 0])) })),
});

let state = null, prev = {}, season = null, famRates = null, lgAllowed = null, statFam = null, statLg = null;
const out = ['gid,pid,season,m3,m5,m10,mseason,mprev,start10,rest,rate3,opp3,rate_pts,form_pts,opp_pts,rate_reb,form_reb,opp_reb,l40dd'];
const S0 = MODEL.stats.league;
for (const d of games) {
  const g = d.game;
  if (g.season !== season) {
    // the season break: this season's totals become "prev"; recent games carry over
    if (state) {
      prev = Object.fromEntries(Object.entries(state.players).filter(([, p]) => p.gp > 0).map(([pid, p]) => [pid, { ...p }]));
      // last season's league constants, as nba_model.json carries them for the live build
      const f = {};
      for (const p of Object.values(prev)) { const k = fam(p.pos); (f[k] ||= [0, 0]); f[k][0] += p.tpm; f[k][1] += p.min; }
      famRates = Object.fromEntries(Object.entries(f).map(([k, [t, m]]) => [k, t / m]));
      const T = Object.values(state.teams || {}).filter(t => t.gp);
      lgAllowed = T.reduce((a, t) => a + t.tpm_allowed, 0) / T.reduce((a, t) => a + t.gp, 0);
      // the stats engine's league constants from last season, swapped into the model the way nba_model.json carries them
      statFam = {}; statLg = {};
      for (const st of ['pts', 'reb']) {
        const f = {};
        for (const p of Object.values(prev)) { const k = fam(p.pos); (f[k] ||= [0, 0]); f[k][0] += p[st]; f[k][1] += p.min; }
        statFam[st] = Object.fromEntries(Object.entries(f).map(([k, [t, m]]) => [k, t / m]));
        statLg[st] = T.reduce((a, t) => a + t[st + '_allowed'], 0) / T.reduce((a, t) => a + t.gp, 0);
      }
    }
    const carried = state ? state.players : {};
    state = freshState(g.season, null);
    for (const [pid, p] of Object.entries(carried)) state.players[pid] = { ...p, gp: 0, gs: 0, min: 0, pts: 0, fgm: 0, fga: 0, tpm: 0, tpa: 0, ftm: 0, fta: 0, oreb: 0, dreb: 0, reb: 0, ast: 0, stl: 0, blk: 0, to: 0 };
    season = g.season;
  }
  const r = toReduced(d);
  if (g.type === 2) {
    for (const p of r.players) {
      if (p.dnp) continue;
      const s = state.players[p.pid]; if (!s || !(s.last10 || []).length) continue;
      const inp = minutesInputs(s, prev[p.pid]);
      const opp = p.team === g.home ? g.away : g.home;
      const lastD = state.teams?.[p.team]?.last, rest = lastD ? Math.min(7, Math.max(0, Math.round((Date.parse(g.date + 'T12:00:00Z') - Date.parse(lastD + 'T12:00:00Z')) / 864e5))) : 7;
      out.push([g.id, p.pid, g.season, inp.m3, inp.m5, inp.m10, inp.mseason, inp.mprev, inp.start10, rest,
        threesRate(s, prev[p.pid], p.pos ?? s.pos, famRates || undefined), oppThreesRatio(state.teams?.[opp], lgAllowed || undefined),
        ...['pts', 'reb'].flatMap(st => {
          if (statFam) { S0.fam_rate[st] = statFam[st]; S0.allowed[st] = statLg[st]; }
          const r = statRate(st, s, prev[p.pid], p.pos ?? s.pos);
          return [r, statForm(st, s, r), statOpp(st, state.teams?.[opp])];
        }),
        (() => { const h = (s.cats40 || '').slice(-40), n = h.length, hit = [...h].filter(c => +c >= 2).length;
                 return n ? hit / n : ''; })()].map(v => typeof v === 'number' ? +v.toFixed(5) : v).join(','));
    }
  }
  applyGame(state, r);
}
fs.writeFileSync(new URL('./nba_parity.csv', import.meta.url), out.join('\n'));
console.log(`replayed ${games.length} games · ${out.length - 1} player-game rows`);
