// /stats.json — how much the site is pricing right now, for the welcome's numbers.
// Counts every priced line on the four apps' current boards, rungs included (a
// ladder of o0.5 … o4.5 is five lines), and the players behind them, from the
// same data files the pages read (raw GitHub). Cached 30 min at the CDN.
const DATA_RAW = 'https://raw.githubusercontent.com/wizard-ron17/dong-tool/main';

/** Priced lines in a board value: a probability, a ladder object/array of them, or nested ladders (kickers). */
const lines = (v) => typeof v === 'number' ? (v > 0 && v < 1 ? 1 : 0)
  : Array.isArray(v) ? v.reduce((a, x) => a + lines(x), 0)
  : v && typeof v === 'object' ? Object.values(v).reduce((a, x) => a + lines(x), 0) : 0;

// per app: [rows, which fields of a row are prices]
const BOARDS = {
  nfl: (d) => [
    [d.picks?.picks, ['p', 'p2', 'pFirst', 'pLast', (r) => r.pass?.p]],
    [d.receptions, ['p']], [d.completions, ['p']], [d.interceptions, ['p']], [d.kickers, ['p']],
    [[...(d.yards?.pass || []), ...(d.yards?.rush || []), ...(d.yards?.rec || []), ...(d.yards?.rr || [])], [() => 1]],   // priced at any line; counted once
  ],
  nhl: (d) => [
    [d.picks?.picks, ['p', 'p2', 'p3', 'pP1', 'pFirst', 'pLast', 'pPP']],
    [d.points?.board, [(r) => Object.keys(r.mu || {}).length]],
    [d.shots?.board, ['p']], [d.saves?.board, ['p', 'pGa']], [d.hits?.board, ['p']], [d.blocks?.board, ['p']],
  ],
  nba: (d) => [
    [d.threes?.rows, ['p']],
    ...Object.values(d.stats?.boards || {}).map(b => [b.rows, ['p']]),
    [d.stats?.doubles, ['dd', 'td']],
    [(d.first?.games || []).flatMap(g => g.players), ['p']],
  ],
  mlb: (d) => [[[...(d.picks || []), ...(d.value || [])].filter((r, i, a) => a.findIndex(x => x.pid === r.pid) === i), ['pHR']]],
};

async function count(sport) {
  const r = await fetch(`${DATA_RAW}/${sport}/data.json`);
  if (!r.ok) return { lines: 0, players: 0 };
  const d = await r.json();
  let n = 0; const who = new Set();
  for (const [rows, fields] of BOARDS[sport](d)) for (const row of rows || []) {
    let k = 0;
    for (const f of fields) k += typeof f === 'function' ? (typeof f(row) === 'number' ? f(row) : lines(f(row))) : lines(row[f]);
    if (k) { n += k; who.add(String(row.pid)); }
  }
  return { lines: n, players: who.size };
}

export default async () => {
  const sports = ['mlb', 'nfl', 'nhl', 'nba'];
  const each = await Promise.all(sports.map(s => count(s).catch(() => ({ lines: 0, players: 0 }))));
  const by = Object.fromEntries(sports.map((s, i) => [s, each[i]]));
  const body = { lines: each.reduce((a, x) => a + x.lines, 0), players: each.reduce((a, x) => a + x.players, 0), by, generated: new Date().toISOString() };
  return new Response(JSON.stringify(body), { headers: {
    'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'public, max-age=600', 'Netlify-CDN-Cache-Control': 'public, max-age=1800, stale-while-revalidate=7200' } });
};

export const config = { path: '/stats.json' };
