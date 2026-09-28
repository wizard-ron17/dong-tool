// Dev only: fill nba/recap.json with real past nights so the Recap page can be
// built and checked before the season's first final. Runs the build's own code
// (scripts/nba-recap.js). Delete nba/recap.json afterwards — CI writes the real one.
//
//   node research/nba_recap_sample.mjs 2026-03-09 2026-03-10 2026-06-10
import { get, pool, SITE, etDate, compact } from '../scripts/nba-api.js';
import { reduceSummary } from '../scripts/nba-state.js';
import { recapDetail, saveRecap } from '../scripts/nba-recap.js';

const dates = process.argv.slice(2);
const evs = (await Promise.all(dates.map(async d => (await get(`${SITE}/scoreboard?dates=${compact(d)}`)).events || []))).flat();
const out = await pool(evs, 6, async (e) => {
  const f = { id: e.id, date: etDate(new Date(e.date)), type: e.season.type };
  const s = await get(`${SITE}/summary?event=${e.id}`);
  return recapDetail(s, f, reduceSummary(s, f));
});
const n = saveRecap(out, '2099-01-01', 99999, (d) => '0000-00-00');
console.log(`wrote nba/recap.json: ${n} games (${dates.join(', ')})`);
