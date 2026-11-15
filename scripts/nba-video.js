// Ron's Hoop Tool: video for the Recap (11/15, Ron: "perhaps it's time to start using YouTube").
//
//   nba/videos.json   gid -> { yt, tries, seen, pd, p: { pid: { yt?, c?: [[mp4, headline, seconds, thumb]] } } }
//
// Where the video is (audited 11/15 over the season's 155 finals):
//  - The NBA's YouTube channel posts "AWAY at HOME | FULL GAME HIGHLIGHTS | November 14, 2026" for every game,
//    2-3 hours after it ends: found by the channel's own search for 155 of 155, all embeddable (oEmbed 200).
//    The reel runs in game order, so it opens near the first basket.
//  - A player's own video ("Tyrese Proctor DOMINATED with His FIRST CAREER TRIPLE-DOUBLE | November 14, 2026")
//    exists only for big nights: 4 of 45 double-doubles sampled (the triple-doubles and 29-and-12s).
//  - ESPN's summary carries ~10 single-play clips a game (public mp4s, no athlete tags: matched by name in the
//    headline): some clip of him for 34 of 62 double-doubles.
// So a double-double plays his own video, else his ESPN clips, else the game reel.
//
// YouTube has no keyless API for this (the channel's RSS feed 404s), so the build reads the channel's search page
// and takes only an exact title match. Every lookup is capped per build (BUDGET) and never fails the build.
import fs from 'node:fs';

const PATH = new URL('../nba/videos.json', import.meta.url);
const BUDGET = 60;                       // YouTube searches per build: a night is ~10 reels + ~10 players; the season backfills over a few builds
const REEL_TRIES = 12;                   // a reel not found in 12 builds (a day of ticks) is given up
const PLAYER_AFTER = 3 * 3600e3;         // a player's video posts hours after the game: look once it's 3h since we first saw the final
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const norm = (s) => (s || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toUpperCase();
const ytDate = (d) => { const [y, m, dd] = d.split('-').map(Number); return `${MONTHS[m - 1]} ${dd}, ${y}`; };
const cats10 = (b) => [b[4], b[5], b[6], b[7], b[8]].filter(v => v >= 10).length;

/** The channel's search results: [videoId, title]. */
async function ytSearch(q) {
  const r = await fetch(`https://www.youtube.com/@NBA/search?query=${encodeURIComponent(q)}`, { headers: { 'Accept-Language': 'en-US,en;q=0.9' } });
  if (!r.ok) throw new Error(`YouTube ${r.status}`);
  const h = await r.text(), out = [];
  for (const m of h.matchAll(/"videoId":"([\w-]{11})".{0,2500}?"title":\{"runs":\[\{"text":"((?:[^"\\]|\\.)+)"/g)) {
    let t = m[2]; try { t = JSON.parse(`"${t}"`); } catch (e) { /* keep raw */ }
    if (!out.some(x => x[0] === m[1])) out.push([m[1], t]);
  }
  return out;
}

export async function updateVideos(recapGames, teams, { get, now = Date.now() } = {}) {
  let V = { games: {} };
  try { V = JSON.parse(fs.readFileSync(PATH, 'utf8')); } catch (e) { /* first build */ }
  const G = Object.values(recapGames || {}).sort((a, b) => b.date.localeCompare(a.date) || a.gid.localeCompare(b.gid));
  for (const id of Object.keys(V.games)) if (!recapGames[id]) delete V.games[id];
  let budget = BUDGET, reels = 0, players = 0, clips = 0, errs = 0;
  const nick = (ab) => norm(teams?.[ab]?.name || ab);
  // last names per night: a title naming only "WILLIAMS" can't say which Williams when two played that night
  const lastN = {};
  for (const g of G) for (const b of Object.values(g.box || {})) { const l = norm(b[0]).split(' ').slice(-1)[0], k = g.date + '|' + l; lastN[k] = (lastN[k] || 0) + 1; }
  for (const g of G) {
    // a final from before yesterday (the season's backfill) has had its videos posted long ago: look for players now
    const old = g.date < new Date(now - 29 * 3600e3).toISOString().slice(0, 10);
    const v = (V.games[g.gid] ||= { yt: null, tries: 0, seen: old ? 0 : now, p: {} });
    // the game reel
    if (!v.yt && v.tries < REEL_TRIES && budget > 0) {
      budget--; v.tries++;
      try {
        const ds = norm(ytDate(g.date)), want = `${nick(g.away)} AT ${nick(g.home)}`;
        const hit = (await ytSearch(`${want} FULL GAME HIGHLIGHTS ${ytDate(g.date)}`))
          .find(([, t]) => { const T = norm(t); return T.includes(want) && T.includes('FULL GAME HIGHLIGHTS') && T.includes(ds) && !T.startsWith('EXTENDED'); });
        if (hit) { v.yt = hit[0]; reels++; }
      } catch (e) { errs++; }
    }
    // the double-doubles: his own video, else ESPN's clips of him (once, a few hours after the game)
    if (v.pd || now - v.seen < PLAYER_AFTER) continue;
    const dd = Object.entries(g.box || {}).filter(([, b]) => cats10(b) >= 2);
    if (budget < dd.length) continue;
    let espn = [];
    if (dd.length && get) { try { espn = (await get(`https://site.api.espn.com/apis/site/v2/sports/basketball/nba/summary?event=${g.gid}`)).videos || []; } catch (e) { errs++; } }
    for (const [pid, b] of dd) {
      const name = norm(b[0]), last = name.split(' ').slice(-1)[0], ds = norm(ytDate(g.date)), e = (v.p[pid] ||= {});
      budget--;
      try {
        const uniq = lastN[g.date + '|' + last] === 1;
        const hit = (await ytSearch(`${b[0]} ${ytDate(g.date)}`)).find(([, t]) => { const T = norm(t); return (T.includes(name) || (uniq && T.includes(last))) && T.includes(ds) && !T.includes('FULL GAME'); });
        if (hit) { e.yt = hit[0]; e.t = hit[1]; players++; }
      } catch (er) { errs++; }
      // a clip names him in full, or by last name when no one else in the game shares it
      const solo = Object.values(g.box).filter(x => norm(x[0]).split(' ').slice(-1)[0] === last).length === 1;
      const c = espn.filter(x => { const H = norm(x.headline); return H.includes(name) || (solo && H.includes(last)); })
        .map(x => [x.links?.source?.HD?.href || x.links?.source?.href, x.headline, x.duration || 0, x.thumbnail || '']).filter(x => x[0]).slice(0, 4);
      if (c.length) { e.c = c; clips++; }
      if (!e.yt && !e.c) delete v.p[pid];
    }
    v.pd = 1;
  }
  fs.writeFileSync(PATH, JSON.stringify(V));
  const n = Object.values(V.games), have = n.filter(x => x.yt).length;
  console.log(`Videos: ${reels} reels and ${players} player videos found, ${clips} with ESPN clips, ${errs} errors; ${have}/${n.length} games have a reel (${BUDGET - budget} searches)`);
}
