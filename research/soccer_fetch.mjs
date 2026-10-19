// Soccer research crawl: every MLS final from 2022 on, reduced by the build's
// own reducer (scripts/soccer-state.js) so research and build read a game the
// same way, plus the game's pre-game line (scripts/soccer-lines.js summaryLine).
// ESPN summaries carry a full 1X2 + total from 2022 (Bet365, Caesars, ESPN BET;
// DraftKings in 2026). One file per season in research/.cache/soccer/
// (gitignored, rebuildable); a season already cached is only topped up.
//
//   node research/soccer_fetch.mjs            # 2022 .. this season
//   node research/soccer_fetch.mjs 2025       # one season
import fs from 'node:fs';
import { get, pool, SITE, etDate, compact } from '../scripts/soccer-api.js';
import { reduceSummary } from '../scripts/soccer-state.js';
import { summaryLine } from '../scripts/soccer-lines.js';

const DIR = new URL('./.cache/soccer/', import.meta.url);
fs.mkdirSync(DIR, { recursive: true });
const today = etDate(), thisYear = +today.slice(0, 4);
const seasons = process.argv[2] ? [+process.argv[2]] : Array.from({ length: thisYear - 2021 }, (_, i) => 2022 + i);

for (const yr of seasons) {
  const file = new URL(`games-${yr}.json`, DIR);
  const have = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : { season: yr, games: {} };
  const sb = await get(`${SITE}/scoreboard?dates=${yr}0510`);
  const cal = [...new Set((sb.leagues?.[0]?.calendar || []).map(d => (typeof d === 'string' ? d : d.startDate || '').slice(0, 10)))]
    .filter(d => d && d.startsWith(String(yr)) && d < today).sort();
  const evs = (await pool(cal, 6, async (d) => { try { return (await get(`${SITE}/scoreboard?dates=${compact(d)}`)).events || []; } catch (e) { return []; } })).flat();
  const finals = [...new Map(evs.filter(e => e.competitions?.[0]?.status?.type?.state === 'post')
    .map(e => [e.id, { id: e.id, date: etDate(new Date(e.date)), start: e.date, slug: e.season?.slug || null }])).values()];
  const todo = finals.filter(f => !have.games[f.id]);
  let n = 0;
  await pool(todo, 6, async (f) => {
    try {
      const s = await get(`${SITE}/summary?event=${f.id}`);
      const r = reduceSummary(s, f);
      have.games[f.id] = { ...r, start: f.start, line: summaryLine(s) };
      if (++n % 100 === 0) console.log(`  ${yr}: ${n}/${todo.length}`);
    } catch (e) { console.warn(`  ${f.id}: ${e.message}`); }
  });
  fs.writeFileSync(file, JSON.stringify(have));
  const G = Object.values(have.games);
  console.log(`${yr}: ${G.length} finals (${todo.length} new), ${G.filter(g => g.line).length} with a full line, ${cal.length} match days`);
}
