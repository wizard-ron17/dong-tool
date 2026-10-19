// Soccer anytime-goal research rows: replay every cached MLS final in order
// through the build's own history and features (scripts/soccer-goals.js), and
// before each game write one row per player in either side's rotation: his
// features as the build would see them, the line's expected goals for his team,
// and what happened. Rows go to research/.cache/soccer/goal_rows.csv for
// research/soccer_goals.py. Needs research/soccer_fetch.mjs first.
import fs from 'node:fs';
import { freshGoalState, applyGoalGame, goalFeatures } from '../scripts/soccer-goals.js';
import { lineGoals } from '../scripts/soccer-lines.js';

const DIR = new URL('./.cache/soccer/', import.meta.url);
const games = fs.readdirSync(DIR).filter(f => /^games-\d{4}\.json$/.test(f))
  .flatMap(f => Object.values(JSON.parse(fs.readFileSync(new URL(f, DIR), 'utf8')).games))
  .filter(g => g.slug !== 'all-star-game')
  .sort((a, b) => (a.start || a.date).localeCompare(b.start || b.date) || a.id.localeCompare(b.id));

const GS = freshGoalState();
const COLS = ['gid', 'date', 'season', 'slug', 'team', 'opp', 'home', 'imp', 'oppImp', 'pid', 'name', 'pos', 'min5', 'st5', 'lastMin', 'apps', 'min', 'np', 'sh', 'sot', 'pkShare', 'pkN', 'teamGames',
  'played', 'started', 'mins', 'npg', 'pkg', 'goals', 'shots', 'sots'];
const out = [COLS.join(',')];
let n = 0;
for (const g of games) {
  const L = lineGoals(g.line);
  for (const [ab, opp, home] of [[g.home.ab, g.away.ab, 1], [g.away.ab, g.home.ab, 0]]) {
    const did = new Map(g.players.filter(p => p.team === ab).map(p => [p.pid, p]));
    for (const [pid, P] of Object.entries(GS.players)) {
      if (P.team !== ab) continue;
      const f = goalFeatures(GS, pid, ab); if (!f) continue;
      const p = did.get(pid);
      const row = { gid: g.id, date: g.date, season: g.date.slice(0, 4), slug: g.slug, team: ab, opp, home,
        imp: L ? (home ? L.impHome : L.impAway) : '', oppImp: L ? (home ? L.impAway : L.impHome) : '', pid, name: JSON.stringify(P.name || ''), ...f,
        played: p ? 1 : 0, started: p?.starter ? 1 : 0, mins: p?.min || 0, npg: p ? p.g - (p.pk || 0) : 0, pkg: p?.pk || 0, goals: p?.g || 0, shots: p?.sh || 0, sots: p?.sot || 0 };
      out.push(COLS.map(c => row[c] ?? '').join(',')); n++;
    }
  }
  applyGoalGame(GS, g);
}
fs.writeFileSync(new URL('goal_rows.csv', DIR), out.join('\n'));
console.log(`${games.length} games replayed, ${n} player rows -> research/.cache/soccer/goal_rows.csv`);
