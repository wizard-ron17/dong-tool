// News for the boards: ESPN's injury report and transaction wire, matched to
// our own player ids, written to <sport>/news.json each build.
//
// ESPN's injuries feed is the complete, structured list — every hurt player's
// status (Out, Questionable, 10-Day IL, Day-To-Day…), the injury, an expected
// return date and RotoWire's blurb — and needs no key. Transactions are the
// league wire: signings, call-ups, IL moves. Both are CORS-open too, but the
// boards want them joined to OUR ids, so the build does the matching once.
//
// ESPN numbers players its own way. The NFL build passes nflverse's
// espn_id -> gsis map; MLB and NHL match ESPN's team rosters to ours by name
// and club (accents, punctuation and Jr./II folded away), falling back to the
// name alone when it's unique.
//
// Display and badges only — no model reads this.

const LEAGUE = { mlb: 'baseball/mlb', nfl: 'football/nfl', nhl: 'hockey/nhl' };
const SITE = (s) => `https://site.api.espn.com/apis/site/v2/sports/${LEAGUE[s]}`;
// ESPN abbreviation -> ours (as scripts/espn-lines.js)
const TEAM_FIX = {
  mlb: { ARI: 'AZ', CHW: 'CWS' },
  nfl: { LAR: 'LA', WSH: 'WAS' },
  nhl: { LA: 'LAK', NJ: 'NJD', SJ: 'SJS', TB: 'TBL', UTAH: 'UTA', MON: 'MTL' },
};

export const normName = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
  .replace(/[.'’`-]/g, ' ').replace(/\b(jr|sr|ii|iii|iv|v)\b/g, ' ').replace(/\s+/g, ' ').trim();

async function getJson(url) {
  for (let i = 1; i <= 3; i++) {
    try { const r = await fetch(url, { headers: { 'User-Agent': 'dong-tool/1.0' } }); if (r.ok) return await r.json(); } catch (e) { /* retry */ }
    await new Promise(res => setTimeout(res, 400 * i));
  }
  return null;
}
async function pool(items, n, fn) {
  const out = []; let i = 0;
  await Promise.all(Array.from({ length: n }, async () => { while (i < items.length) { const k = i++; out[k] = await fn(items[k]); } }));
  return out;
}
/** "Out" -> O, "Questionable" -> Q, "10-Day-IL" -> IL10, "Injured Reserve" -> IR … */
function statusCode(st) {
  const s = String(st || '');
  const il = s.match(/(\d+)-Day-IL/i); if (il) return 'IL' + il[1];
  const m = { out: 'O', questionable: 'Q', doubtful: 'D', 'day-to-day': 'DTD', probable: 'P', 'injured reserve': 'IR', suspension: 'SUSP', 'physically unable to perform': 'PUP', 'non-football injury': 'NFI' };
  return m[s.toLowerCase()] || s.slice(0, 4).toUpperCase();
}
const espnIdOf = (a) => { const h = (a?.links || []).map(l => l.href || '').find(x => /\/id\/\d+/.test(x)); return h ? h.match(/\/id\/(\d+)/)[1] : (a?.id ? String(a.id) : null); };

/**
 * @param sport       'mlb' | 'nfl' | 'nhl'
 * @param players     [{ pid, name, team }] — our players, our team abbreviations
 * @param espnToOurs  optional Map(espnId -> our pid) (the NFL has one from nflverse)
 * @returns { generated, injuries: { pid: {s, st, t, r, d, c} }, espn: { pid: espnId }, tx: [{d, team, text}], matched, total }
 */
export async function buildNews(sport, { players = [], espnToOurs = null } = {}) {
  let prev = null;
  try { prev = JSON.parse((await import('node:fs')).readFileSync(new URL(`../${sport}/news.json`, import.meta.url), 'utf8')); } catch (e) { /* first build */ }
  const fix = TEAM_FIX[sport] || {};
  const ours = (ab) => fix[ab] || ab;
  const byNameTeam = new Map(), byName = new Map();
  for (const p of players) {
    const k = normName(p.name);
    if (!k) continue;
    byNameTeam.set(`${k}|${p.team}`, String(p.pid));
    byName.set(k, byName.has(k) ? null : String(p.pid));     // null = ambiguous
  }
  const inList = new Set(players.map(p => String(p.pid)));
  const matchName = (name, team) => byNameTeam.get(`${normName(name)}|${team}`) ?? byName.get(normName(name)) ?? null;

  // clubs: ESPN id -> our abbreviation
  const T = await getJson(`${SITE(sport)}/teams`);
  const clubs = (T?.sports?.[0]?.leagues?.[0]?.teams || []).map(x => ({ id: String(x.team.id), ab: ours(x.team.abbreviation) }));
  const clubOf = new Map(clubs.map(c => [c.id, c.ab]));

  // ESPN id -> our id: nflverse's map, else every roster matched by name + club
  const e2o = new Map(espnToOurs ? [...espnToOurs].map(([e, o]) => [String(e), String(o)]) : []);
  if (!espnToOurs) {
    await pool(clubs, 8, async (c) => {
      const R = await getJson(`${SITE(sport)}/teams/${c.id}/roster`);
      for (const grp of R?.athletes || []) for (const a of (grp.items || [grp])) {
        const pid = matchName(a.fullName || a.displayName, c.ab);
        if (pid && a.id) e2o.set(String(a.id), pid);
      }
    });
  }
  const espn = {};
  for (const [e, o] of e2o) if (inList.has(o)) espn[o] = +e;

  // the injury report
  const injuries = {};
  let total = 0, matched = 0;
  const I = await getJson(`${SITE(sport)}/injuries`);
  for (const grp of I?.injuries || []) {
    const team = clubOf.get(String(grp.id)) || null;
    for (const x of grp.injuries || []) {
      // the NFL's report also carries healthy players ("Active") with a note — not an injury
      if (/^active$/i.test(x.status || '')) continue;
      total++;
      const a = x.athlete || {}, eid = espnIdOf(a);
      const pid = (eid && e2o.get(eid)) || matchName(a.displayName, team);
      if (!pid) continue;
      matched++;
      injuries[pid] = {
        s: statusCode(x.status), st: x.status || null,
        t: x.details?.type || null, r: x.details?.returnDate || null,
        d: x.date || null, c: x.shortComment || null,
      };
      if (eid && !espn[pid]) espn[pid] = +eid;
    }
  }

  // the transaction wire, last 10 days
  const tx = [];
  const X = await getJson(`${SITE(sport)}/transactions`);
  const since = Date.now() - 10 * 86400000;
  for (const t of X?.transactions || []) {
    if (Date.parse(t.date) < since) continue;
    tx.push({ d: t.date, team: t.team ? ours(t.team.abbreviation) : null, text: t.description || '' });
  }
  tx.sort((a, b) => b.d.localeCompare(a.d));

  // RotoWire's player-news feed holds only its newest five, so each build
  // keeps what it has seen (carried in the previous news.json, 48 hours, 60
  // items): the ticker opens on a backlog, not just the last hour.
  const RW = { mlb: 'MLB', nfl: 'NFL', nhl: 'NHL' }[sport];
  const rw = (prev?.rw || []).filter(x => Date.now() - Date.parse(x.t) < 48 * 3600e3);
  try {
    const r = await fetch(`https://www.rotowire.com/rss/news.php?sport=${RW}`, { headers: { 'User-Agent': 'Mozilla/5.0 (dong-tool)' } });
    const xml = r.ok ? await r.text() : '';
    const tag = (it, k) => (it.match(new RegExp(`<${k}>([\\s\\S]*?)</${k}>`)) || [])[1] || '';
    const clean = (t) => t.replace(/<!\[CDATA\[|\]\]>/g, '').replace(/<[^>]+>/g, ' ').replace(/&lt;[\s\S]*?&gt;/g, ' ').replace(/Visit RotoWire[\s\S]*$/, '')
      .replace(/&amp;/g, '&').replace(/&#0?39;|&apos;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, ' ').trim();
    for (const it of xml.match(/<item>[\s\S]*?<\/item>/g) || []) {
      const title = clean(tag(it, 'title')), id = clean(tag(it, 'guid')) || clean(tag(it, 'link')) || title;
      if (!title || rw.some(x => x.id === id)) continue;
      const [name, ...rest] = title.split(':');
      rw.push({ id, name: name.trim(), head: rest.join(':').trim(), blurb: clean(tag(it, 'description')), t: new Date(clean(tag(it, 'pubDate')) || Date.now()).toISOString(), link: clean(tag(it, 'link')) });
    }
  } catch (e) { /* keep what we had */ }
  rw.sort((a, b) => b.t.localeCompare(a.t));

  // name -> our id, for the page to tie a RotoWire headline ("Zay Flowers: …") to a card
  const names = {};
  for (const [k, pid] of byName) if (pid) names[k] = +pid || pid;
  return { generated: new Date().toISOString(), injuries, espn, names, tx: tx.slice(0, 60), rw: rw.slice(0, 60), matched, total };
}
