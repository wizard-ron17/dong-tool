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
  picks:     { title: "Today's HR Picks · Ron's Dong Tool", desc: "Today's home run picks — Chalk & Value boards, scored by power, platoons, arm stuff, pitch synergy, and park." },
  due:       { title: "Most Due for a Bomb · Ron's Dong Tool", desc: "Hitters overdue for a home run, ranked by drought length and proven power." },
  schedule:  { title: "Today's Schedule · Ron's Dong Tool", desc: "Today's MLB slate with per-game Homer Scores, weather, park factors, and probable pitchers." },
  matchups:  { title: "Matchup Lab · Ron's Dong Tool", desc: "Break down any batter vs any pitcher — power, platoons, arm stuff, pitch-type synergy, and park, scored like our Picks board." },
  stats:     { title: "Stats · Ron's Dong Tool", desc: "League home-run trends and leaderboards with stock-style technical-analysis overlays." },
  recap:     { title: "Recap · Ron's Dong Tool", desc: "Every home run from the last slate — distances, pitchers, and matchups." },
  pairs:     { title: "Top Pairings · Ron's Dong Tool", desc: "Which hitters go deep together — the correlated home-run parlay lens." },
  prospects: { title: "Prospects · Ron's Dong Tool", desc: "Fresh call-ups and debut bombers to watch, ranked by minor-league power." },
  daylate:   { title: "Day Late · Ron's Dong Tool", desc: "Yesterday's picks that didn't go yard — bounce-back candidates for today." },
  returning: { title: "Returning Boppers · Ron's Dong Tool", desc: "Injured sluggers on their way back and the first-games-back home-run window." },
  birthdays: { title: "Birthdays · Ron's Dong Tool", desc: "Which boppers are celebrating a birthday today 🎂." },
};

const esc = (s) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function metaFor(pathname) {
  const seg = (pathname || '/').split('/').filter(Boolean)[0] || '';
  return ROUTES[seg] || ROUTES[''];
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
    const url = new URL(request.url);
    const m = metaFor(url.pathname);
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
