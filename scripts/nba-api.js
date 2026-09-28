// ESPN endpoints for Ron's Hoop Tool (NBA). nba.com's own feeds (cdn.nba.com,
// stats.nba.com) refuse scripted clients, so ESPN is the source — the same family
// as the NFL build. No key. research/nba_scouting.md has the full survey.
//
// ESPN answers 403 to a custom User-Agent, so none is set: the runtime's default
// goes through.

export const SITE = 'https://site.api.espn.com/apis/site/v2/sports/basketball/nba';
export const SITE2 = 'https://site.api.espn.com/apis/v2/sports/basketball/nba';
export const CORE = 'https://sports.core.api.espn.com/v2/sports/basketball/leagues/nba';

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
