// Shared NHL API helper. Two hosts, both free and unauthenticated:
//   api-web.nhle.com  — schedule, scores, standings (the "web" feed the site uses)
//   api.nhle.com/stats/rest — the stats warehouse (skater/goalie summaries)
// api-web answers 307 to the same path, so every fetch has to follow redirects
// (Node's fetch does by default; curl needs -L and python's urllib needs a UA).
const WEB = 'https://api-web.nhle.com/v1';
const REST = 'https://api.nhle.com/stats/rest/en';

async function getJson(url, tries = 3) {
  for (let i = 1; i <= tries; i++) {
    try {
      const r = await fetch(url, { headers: { 'User-Agent': 'dong-tool/1.0' } });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return await r.json();
    } catch (e) {
      if (i === tries) throw new Error(`${url} failed after ${tries}: ${e.message}`);
      await new Promise(res => setTimeout(res, 400 * i));
    }
  }
}

export const web  = (path) => getJson(WEB + path);
// cayenneExp is a query language, not an identifier — its spaces, quotes and
// >= operators have to be percent-encoded or the warehouse answers 400.
export const rest = (path) => getJson(REST + path.replace(/ /g, '%20'));

// The stats warehouse caps `limit` at 100 rows no matter what you ask for, and
// refuses start >= 10000. Leader boards only ever want the top few hundred, so
// page until we have `want` rows or the well runs dry. Pass want=Infinity for
// the whole table (a season of skaters is ~940 rows, ten requests).
//
// `sort` must name fields the REPORT actually carries: /skater/timeonice has no
// `points` column and answers 400 rather than ignoring it.
export async function restPaged(path, want, sort) {
  const out = [];
  const sortQ = sort ? `&sort=${encodeURIComponent(JSON.stringify(sort))}` : '';
  for (let start = 0; start < want && start < 10000; start += 100) {
    const j = await rest(`${path}&limit=100&start=${start}${sortQ}`);
    const rows = j?.data || [];
    out.push(...rows);
    if (rows.length < 100) break;
  }
  return out.slice(0, want);
}

// yyyy-mm-dd in a fixed zone. The NHL's day boundary is US Eastern: a 10pm PT
// game belongs to the Eastern date its puck dropped on, which is how every
// endpoint keys its dates.
export function etDate(d = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}
export function shiftDate(ymd, days) {
  const d = new Date(ymd + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
