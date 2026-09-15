// Per-route social embeds. This is a static single-page app — Netlify serves the
// same index.html for every route — so a shared /picks link would otherwise
// preview identically to /due. Social crawlers (Discord, iMessage, Twitter,
// Slack) don't run JavaScript, so the ONLY place a route-specific preview can be
// produced is here, at the edge, by rewriting the <head> before it's served.
//
// Defensive by design: anything unexpected falls through to the unmodified page,
// so a bug here can never break page serving.
const SITE = 'https://dong-tool.netlify.app';
const BASE_DESC = 'Daily MLB home run picks, value bats, due hitters, and any batter-vs-pitcher matchup breakdown. Inspired by Green Means Go.';

// Keyed by the first path segment (the client-side route).
const ROUTES = {
  '':        { title: "Ron's Dong Tool", desc: BASE_DESC },
  picks:     { title: "Today's HR Picks · Ron's Dong Tool", desc: "Today's home run picks — Chalk & Value boards, scored by power, platoons, arm stuff, and park." },
  due:       { title: "Most Due for a Bomb · Ron's Dong Tool", desc: "Hitters overdue for a home run, ranked by drought length and proven power." },
  schedule:  { title: "Today's Schedule · Ron's Dong Tool", desc: "Today's MLB slate with per-game Homer Scores, weather, park factors, and probable pitchers." },
  matchups:  { title: "Matchup Lab · Ron's Dong Tool", desc: "Break down any batter vs any pitcher — power, platoons, arm stuff, and park, scored like our Picks board." },
  stats:     { title: "Stats · Ron's Dong Tool", desc: "League home-run trends and leaderboards with stock-style technical-analysis overlays." },
  recap:     { title: "Recap · Ron's Dong Tool", desc: "Every home run from the last slate — distances, pitchers, and matchups." },
  pairs:     { title: "Top Pairings · Ron's Dong Tool", desc: "Which hitters go deep together — the correlated home-run parlay lens." },
  prospects: { title: "Prospects · Ron's Dong Tool", desc: "Fresh call-ups and debut bombers to watch, ranked by minor-league power." },
  daylate:   { title: "Day Late · Ron's Dong Tool", desc: "Yesterday's picks that didn't go yard — bounce-back candidates for today." },
  returning: { title: "Returning Boppers · Ron's Dong Tool", desc: "Injured sluggers on their way back and the first-games-back home-run window." },
  birthdays: { title: "Birthdays · Ron's Dong Tool", desc: "Which boppers are celebrating a birthday today 🎂." },
  milestones: { title: "Milestone Watch · Ron's Dong Tool", desc: "Hitters closing in on a career home-run milestone — 100, 200, 300 and up — plus who just crossed one 🏆." },
  steals:     { title: "Steal Board · Ron's Dong Tool", desc: "Today's base-stealers ranked against the battery they'll face — runner speed & tendency vs pitcher hand and catcher arm 🏃." },
  pitchtypes: { title: "Pitch Types · Ron's Dong Tool", desc: "How every MLB team and hitter performs against each pitch type this season — BA, SLG, barrel%, and more, by pitch." },
  pitchervuln: { title: "Pitcher Vuln · Ron's Dong Tool", desc: "Tonight's starters ranked by how homer-prone they are — arm stuff (velo + barrel%-allowed) × park — plus the bats that punish each one ⚾." },
  pitcherks:  { title: "Strikeouts · Ron's Dong Tool", desc: "Today's best strikeout matchups — by pitcher or by batter: high-K arms vs whiff-prone lineups, and the hitters likeliest to strike out." },
  pitcherwalks: { title: "Walks · Ron's Dong Tool", desc: "Today's best walk matchups — by pitcher or by batter: wild arms vs patient lineups, and the hitters likeliest to draw a walk." },
};

const esc = (s) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// The multi-sport landing + Tud Tool live outside the MLB (/mlb) route tree.
const LANDING = { title: "Ron's Tools", desc: "Ron's sports tools — MLB home run picks (Dong Tool), football touchdowns (Tud Tool), and more. Inspired by Green Means Go." };
const NFL_ROUTES = {
  '':      { title: "Ron's Tud Tool", desc: "NFL touchdown prices, receptions and completions projections, TD leaders, schedule, and the correlated-parlay Pairs tool." },
  picks:   { title: "TD Picks · Ron's Tud Tool", desc: "Every skill player on the slate, priced to score a touchdown — and every starting QB, priced to throw one." },
  receptions: { title: "Receptions · Ron's Tud Tool", desc: "Projected catches for every pass-catcher on the slate, priced against the standard lines." },
  completions: { title: "Completions · Ron's Tud Tool", desc: "Projected completions for every starting quarterback, priced against the standard lines." },
  yards:   { title: "Yards · Ron's Tud Tool", desc: "Passing, rushing, receiving and rush + receiving yards for the slate — median projections and fair odds at any line." },
  interceptions: { title: "Interceptions · Ron's Tud Tool", desc: "Every starting quarterback, priced to throw an interception — game script, bad balls and the defense across the field." },
  returners: { title: "Returners · Ron's Tud Tool", desc: "Who takes the punts and kickoffs, and what that adds to his anytime touchdown price." },
  due:     { title: "Due for a TD · Ron's Tud Tool", desc: "Heavy red-zone workload, no touchdown to show for it — the guys whose usage has outrun their scoring." },
  milestones: { title: "TD Milestones · Ron's Tud Tool", desc: "Who is closing in on a career touchdown milestone — 50, 100, 150, 200." },
  birthdays: { title: "Birthdays · Ron's Tud Tool", desc: "Who is playing on or near his birthday — and whether birthday boys actually find the end zone." },
  pairs:   { title: "TD Pairs · Ron's Tud Tool", desc: "Which players score touchdowns in the same week — the correlated lens for building weekly TD parlays." },
  recap:   { title: "TD Recap · Ron's Tud Tool", desc: "Every touchdown of the season by week — rushing, receiving, and defensive/ST scores with distances." },
  stats:   { title: "TD Leaders · Ron's Tud Tool", desc: "Season touchdown leaders — total, rushing, receiving, defensive, special-teams, and first-TD counts." },
  schedule:{ title: "Schedule · Ron's Tud Tool", desc: "The full NFL slate by week with spreads and over/unders." },
};

function metaFor(pathname) {
  const segs = (pathname || '/').split('/').filter(Boolean);
  if (segs[0] === 'mlb') return ROUTES[segs[1] || ''] || ROUTES['']; // /mlb, /mlb/picks, /mlb/due/results
  if (segs[0] === 'nfl') return NFL_ROUTES[segs[1] || ''] || NFL_ROUTES['']; // /nfl, /nfl/pairs …
  return LANDING; // "/" and anything else -> the sport picker
}

// A shared replay (/nfl/recap/<gameId>-<playId>) previews as that touchdown.
// plays.json is small and on the same deploy; cached per edge instance.
const TD_KIND = { rec: 'receiving', rush: 'rushing', pick6: 'pick-six', fumble: 'fumble-return', kick: 'kick-return', punt: 'punt-return', blk: 'blocked-kick' };
let playsCache = { at: 0, data: null };
async function replayMeta(pathname, requestUrl) {
  const m = pathname.match(/^\/nfl\/recap\/(\d{4}_(\d{2})_[A-Z]{2,3}_[A-Z]{2,3})-(\d+)\/?$/);
  if (!m) return null;
  if (!playsCache.data || Date.now() - playsCache.at > 10 * 60 * 1000) {
    const r = await fetch(new URL('/nfl/plays.json', requestUrl));
    if (!r.ok) return null;
    playsCache = { at: Date.now(), data: await r.json() };
  }
  const d = playsCache.data[`${m[1]}|${m[3]}`];
  if (!d) return null;
  const desc = (d.desc || '')
    .replace(/^\(\d+:\d+\)\s*/, '')
    .replace(/(?:\d+-[A-Z][\w.'-]+(?:,\s*|\s+and\s+)?)+\s*reported in as eligible\.\s*/g, '')   // "73-J.Ezeudu and 77-J.Moore reported in as eligible."
    .replace(/\([^)]*\)\s*/g, '')                    // (Shotgun), tacklers
    .replace(/\[[^\]]*\]\s*/g, '')
    .replace(/\b(?:[A-Z]{2,3}-)?\d{1,2}-(?=[A-Z])/g, '')  // jersey numbers
    .replace(/\s+([.,])/g, '$1').trim();
  const yd = d.yd ?? +((d.desc || '').match(/for (-?\d+) yards?, TOUCHDOWN/)?.[1] ?? NaN);
  const week = +m[2];
  const title = d.nm
    ? `${d.nm} ${Number.isFinite(yd) ? yd + '-yd ' : ''}${TD_KIND[d.ty] || ''} TD${d.tm ? ` · ${d.tm} vs ${d.op}` : ''} · Ron's Tud Tool`.replace(/\s+/g, ' ')
    : "Touchdown replay · Ron's Tud Tool";
  return { title, desc: `▶ Watch the replay — Week ${week}. ${desc}`.slice(0, 300) };
}

function inject(html, title, desc, url) {
  const t = esc(title), d = esc(desc), u = esc(url);
  return html
    .replace(/<title>[\s\S]*?<\/title>/, `<title>${t}</title>`)
    .replace(/(<meta name="description" content=")[\s\S]*?("\s*\/?>)/, `$1${d}$2`)
    .replace(/(<meta property="og:title" content=")[\s\S]*?("\s*\/?>)/, `$1${t}$2`)
    .replace(/(<meta property="og:description" content=")[\s\S]*?("\s*\/?>)/, `$1${d}$2`)
    .replace(/(<meta property="og:url" content=")[\s\S]*?("\s*\/?>)/, `$1${u}$2`)
    .replace(/(<meta name="twitter:title" content=")[\s\S]*?("\s*\/?>)/, `$1${t}$2`)
    .replace(/(<meta name="twitter:description" content=")[\s\S]*?("\s*\/?>)/, `$1${d}$2`);
}

export default async (request, context) => {
  const res = await context.next();
  try {
    const ct = res.headers.get('content-type') || '';
    if (!ct.includes('text/html')) return res; // only touch HTML documents
    if (res.status === 404) return res;         // keep the 404 page's own title
    const url = new URL(request.url);
    const m = (await replayMeta(url.pathname, request.url).catch(() => null)) || metaFor(url.pathname);
    const html = await res.text();
    const out = inject(html, m.title, m.desc, SITE + url.pathname);
    const headers = new Headers(res.headers);
    headers.delete('content-length');   // body length changed
    headers.delete('content-encoding'); // we return plain text; let the CDN re-encode
    return new Response(out, { status: res.status, headers });
  } catch (_e) {
    return res; // any failure → serve the page untouched
  }
};

export const config = {
  path: '/*',
  // Skip assets/data so the function only runs on HTML navigations.
  excludedPath: ['/data.json', '/matchup-cards.json', '/sw.js', '/manifest.webmanifest', '/icons/*', '/*.json', '/*.js', '/*.css', '/*.png', '/*.svg', '/*.ico', '/*.webmanifest'],
};
