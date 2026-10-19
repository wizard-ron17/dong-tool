// Parity: the build's pricing code (scripts/soccer-goals.js goalPrice) against
// research/soccer_goals.py on every research row, with the same exported model
// (soccer/goals-model.json). Both read the same raw features (the rows were made
// by soccer-goals.js itself), so any gap is a port bug in the formula.
//   python3 research/soccer_goals.py && node research/soccer_goals_parity.mjs
import fs from 'node:fs';
import { goalPrice } from '../scripts/soccer-goals.js';

const M = JSON.parse(fs.readFileSync(new URL('../soccer/goals-model.json', import.meta.url), 'utf8'));
const csv = (f) => { const [h, ...L] = fs.readFileSync(new URL(`./.cache/soccer/${f}`, import.meta.url), 'utf8').trim().split('\n'); const H = h.split(',');
  return L.map(l => { const v = l.match(/("[^"]*"|[^,]*)(,|$)/g).map(x => x.replace(/,$/, '')); return Object.fromEntries(H.map((k, i) => [k, v[i]])); }); };
const py = new Map(csv('goal_preds.csv').map(r => [`${r.gid}|${r.pid}|${r.team}`, r]));
let n = 0, worst = 0, at = null;
for (const r of csv('goal_rows.csv')) {
  if (r.imp === '') continue;
  const q = py.get(`${r.gid}|${r.pid}|${r.team}`); if (!q) continue;
  const num = (v) => v === '' || v == null ? null : +v;
  const f = { pos: r.pos, min5: +r.min5, st5: +r.st5, lastSt: +r.lastSt, subs5: +r.subs5, st10: +r.st10, apps: +r.apps, lastMin: +r.lastMin, stMin: num(r.stMin), subMin: num(r.subMin),
    min: +r.min, np: +r.np, sh: +r.sh, sot: +r.sot, pkShare: +r.pkShare, pkN: +r.pkN };
  const ctx = { imp: +r.imp, home: r.home === '1' };
  // before the lineups, and with them (a player outside the matchday squad prices at zero either side)
  const xi = q.started === '1' ? 'XI' : q.squad === '1' ? 'bench' : 'out';
  for (const [js, p] of [[goalPrice(f, ctx, M).p, +q.p], [goalPrice(f, ctx, M, xi).p, +q.pk]]) {
    n++; const e = Math.abs(js - p); if (e > worst) { worst = e; at = { gid: r.gid, pid: r.pid, xi, js, py: p }; }
  }
}
console.log(`${n} prices (every row before the lineups and with them): worst |build - research| = ${worst.toExponential(2)}`);
if (worst > 1e-6) { console.log('MISMATCH', at); process.exit(1); }
