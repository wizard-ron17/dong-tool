// Every 2025-26 regular-season game's line combinations (scripts/nhl-combos.js derive), cached for research/nhl_combo_sgp.py.
//   node research/nhl_combo_fetch.mjs          resumes where it left off
import fs from 'node:fs';
import { derive } from '../scripts/nhl-combos.js';
const OUT = new URL('./.cache/nhl_combos_2025.json', import.meta.url);
const done = fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT, 'utf8')) : {};
const ids = []; for (let n = 1; n <= 1312; n++) { const id = 2025020000 + n; if (!(id in done)) ids.push(id); }
let k = 0, ok = 0, none = 0;
async function worker() {
  while (k < ids.length) {
    const id = ids[k++];
    try { const d = await derive(id); if (d) { done[id] = { date: d.date, teams: d.teams, pos: d.pos }; ok++; } else { done[id] = null; none++; } }
    catch (e) { /* retried on the next run */ }
    if ((ok + none) % 100 === 0) fs.writeFileSync(OUT, JSON.stringify(done));
  }
}
await Promise.all(Array.from({ length: 6 }, worker));
fs.writeFileSync(OUT, JSON.stringify(done));
console.log(`games with lines ${Object.values(done).filter(Boolean).length}, no shifts ${Object.values(done).filter(x => x === null).length}, asked ${ids.length}`);
