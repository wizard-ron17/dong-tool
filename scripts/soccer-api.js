// ESPN endpoints for Ron's Goal Tool (soccer). The same open site API as the
// NBA and NFL builds; no key. research/soccer_scouting.md has the full survey.
//
// ESPN answers 403 to a custom User-Agent, so none is set: the runtime's default
// goes through. The soccer scoreboard takes one day at a time (a dates=a-b range
// returns no events), but every response carries the season's calendar of match
// days, so a window is fetched only on the days that have games.

export const LEAGUE = 'usa.1';                // MLS. Europe's leagues share the shape (eng.1, esp.1, …)
export const SITE = `https://site.api.espn.com/apis/site/v2/sports/soccer/${LEAGUE}`;
export const SITE2 = `https://site.api.espn.com/apis/v2/sports/soccer/${LEAGUE}`;

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

export async function get(url, tries = 4) {
  let last;
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url);
      if (r.ok) return await r.json();
      last = new Error(`${r.status} ${url}`);
      if (r.status === 404) break;
    } catch (e) { last = e; }
    await sleep(800 * (i + 1));
  }
  throw last;
}

/** Map over items `limit` at a time. */
export async function pool(items, limit, fn) {
  const out = new Array(items.length); let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) { const k = i++; out[k] = await fn(items[k], k); }
  }));
  return out;
}

/** Today's date in US Eastern, YYYY-MM-DD. */
export const etDate = (d = new Date()) => d.toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
export function shiftDate(ymd, days) {
  const [y, m, d] = ymd.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d)); t.setUTCDate(t.getUTCDate() + days);
  return t.toISOString().slice(0, 10);
}
export const compact = (ymd) => ymd.replace(/-/g, '');
