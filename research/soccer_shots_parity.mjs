// Parity: the build's shots pricing (scripts/soccer-shots.js) against
// research/soccer_shots.py on every research row, same exported model
// (soccer/shots-model.json), pre-lineup. Any gap is a port bug in the formula.
//   python3 research/soccer_shots.py && node research/soccer_shots_parity.mjs
import fs from 'node:fs';
import { shotLadder } from '../scripts/soccer-shots.js';

const MM = JSON.parse(fs.readFileSync(new URL('../soccer/shots-model.json', import.meta.url), 'utf8'));
const csv = (f) => { const [h, ...L] = fs.readFileSync(new URL(`./.cache/soccer/${f}`, import.meta.url), 'utf8').trim().split('\n'); const H = h.split(',');
  return L.map(l => { const v = l.match(/("[^"]*"|[^,]*)(,|$)/g).map(x => x.replace(/,$/, '')); return Object.fromEntries(H.map((k, i) => [k, v[i]])); }); };
const py = new Map(csv('shot_preds.csv').map(r => [`${r.gid}|${r.pid}|${r.team}`, r]));
const num = (v) => v === '' || v == null ? null : +v;
let n = 0, worst = 0, at = null;
for (const r of csv('goal_rows.csv')) {
  const q = py.get(`${r.gid}|${r.pid}|${r.team}`); if (!q) continue;
  const f = { pos: r.pos, min5: +r.min5, st5: +r.st5, lastSt: +r.lastSt, subs5: +r.subs5, st10: +r.st10, stMin: num(r.stMin), subMin: num(r.subMin), min: +r.min, sh: +r.sh, sot: +r.sot };
  for (const kind of ['sh', 'sot']) {
    const S = shotLadder(f, { osha: +r.osha }, { home: r.home === '1' }, MM, kind);
    const gaps = [Math.abs(S.mu - +q[`mu_${kind}`]), ...MM[kind].lines.map(L => Math.abs(S.p[L] - +q[`${kind}_${L}`]))];
    const e = Math.max(...gaps); n++;
    if (e > worst) { worst = e; at = { gid: r.gid, pid: r.pid, kind, js: S.mu, py: q[`mu_${kind}`] }; }
  }
}
console.log(`${n} row-markets: worst |build - research| = ${worst.toExponential(2)}`);
if (worst > 1e-6) { console.log('MISMATCH', at); process.exit(1); }
