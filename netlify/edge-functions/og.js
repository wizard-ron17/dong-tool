// Live share cards: /og/<sport>/<tool>.png — a 1200x630 snippet of the board
// as it stands, for link previews (embed.js points og:image / twitter:image
// here per route). The data is the same file the pages read (raw GitHub, so a
// data-only commit shows up without a deploy); the image is cached ~15 min at
// the CDN and embed.js tags each day's URL (?d=) so a crawler re-fetches daily.
// A tool without a ranked board gets its name and one line on the app's card.
// Anything that fails falls back to the app's static card — a preview never breaks.
import React from 'https://esm.sh/react@18.2.0';
import { ImageResponse } from 'https://deno.land/x/og_edge@0.0.6/mod.ts';

const SITE = 'https://dong-tool.netlify.app';
const DATA_RAW = 'https://raw.githubusercontent.com/wizard-ron17/dong-tool/main';
const APP = {
  mlb: { name: ['Ron\'s', 'Dong', 'Tool'], logo: '/icons/icon-512.png', card: '/icons/og-mlb.png' },
  nfl: { name: ['Ron\'s', 'Tud', 'Tool'], logo: '/icons/nfl-icon-512.png', card: '/icons/og-nfl.png' },
  nhl: { name: ['Ron\'s', 'Goal', 'Tool'], logo: '/icons/nhl-icon-512.png', card: '/icons/og-nhl.png' },
  nba: { name: ['Ron\'s', 'Hoop', 'Tool'], logo: '/icons/nba-icon-512.png', card: '/icons/og-nba.png' },
};
const G = '#33d07c', BG = '#05080f', INK = '#e8edf5', MUTED = '#8a94a6';

// ── cached fetches (per edge instance) ───────────────────────────────────
const memo = new Map();
async function cached(key, ttl, fn) {
  const hit = memo.get(key);
  if (hit && Date.now() - hit.at < ttl) return hit.v;
  const v = await fn(); memo.set(key, { at: Date.now(), v }); return v;
}
const fontUrl = (fam, w) => `https://cdn.jsdelivr.net/fontsource/fonts/${fam}@latest/latin-${w}-normal.ttf`;
const fonts = () => cached('fonts', 864e5, async () => {
  const want = [['Chakra', 'chakra-petch', 700], ['Jakarta', 'plus-jakarta-sans', 700], ['Jakarta', 'plus-jakarta-sans', 500], ['Jakarta', 'plus-jakarta-sans', 600], ['Mono', 'jetbrains-mono', 600]];
  return Promise.all(want.map(async ([name, fam, weight]) => ({ name, weight, style: 'normal', data: await (await fetch(fontUrl(fam, weight))).arrayBuffer() })));
});
const data = (sport) => cached('data:' + sport, 5 * 60e3, async () => {
  const r = await fetch(`${DATA_RAW}/${sport}/data.json`); if (!r.ok) throw new Error('data ' + r.status); return r.json();
});
/** An image as a data URI (satori won't fetch remote WebP, and a dead headshot mustn't sink the card). */
async function img(url) {
  if (!url) return null;
  return cached('img:' + url, 864e5, async () => {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(2500) });
      const type = r.headers.get('content-type') || '';
      if (!r.ok || !/png|jpe?g/.test(type)) return null;
      const b = new Uint8Array(await r.arrayBuffer()); let s = '';
      for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
      return `data:${type.split(';')[0]};base64,${btoa(s)}`;
    } catch (e) { return null; }
  });
}

// ── numbers the way the boards print them ────────────────────────────────
const odds = (p) => !(p > 0.004 && p < 0.97) ? '—' : p >= 0.5 ? String(-Math.round(100 * p / (1 - p))) : '+' + Math.round(100 * (1 - p) / p);
const vs = (r) => `${r.team} ${r.home ? 'vs' : '@'} ${r.opp}`;
const bestLine = (p) => { if (!p) return null; const e = Object.entries(p).map(([k, v]) => [+k, v]).sort((a, b) => Math.abs(a[1] - 0.5) - Math.abs(b[1] - 0.5))[0]; return e ? `o${e[0]} ${odds(e[1])}` : null; };
const dayLbl = (ymd) => ymd ? new Date(ymd + 'T12:00:00Z').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' }) : '';
const top = (a, by, n = 5) => [...(a || [])].sort((x, y) => by(y) - by(x)).slice(0, n);

// ── one extractor per board: { title, sub, when, rows: [{ face, name, meta, val, unit, tag, color }] } ──
// nfl.com serves the 4 MB original unless asked for a size
const nflFace = (d, pid) => (d.headshots?.[pid] || '').replace('f_auto,q_auto', 'f_png,q_auto,w_160') || null;
const nflCol = (d, t) => d.teamColors?.[t]?.[0] || G;
const nhlFace = (r) => r.mug || null;
const nbaFace = (pid) => `https://a.espncdn.com/i/headshots/nba/players/full/${pid}.png`;
const mlbFace = (pid) => `https://img.mlbstatic.com/mlb-photos/image/upload/w_180,q_auto:best/v1/people/${pid}/headshot/67/current`;
const BOARDS = {
  nfl: {
    picks: (d) => ({ title: 'TD Picks', sub: 'Anytime touchdown · fair odds', when: `Week ${d.picks?.week}`,
      rows: top(d.picks?.picks, r => r.p).map(r => ({ face: nflFace(d, r.pid), name: r.name, meta: `${r.pos} · ${vs(r)}`, val: odds(r.p), unit: `${Math.round(r.p * 100)}% to score`, color: nflCol(d, r.team) })) }),
    receptions: (d) => ({ title: 'Receptions', sub: 'Projected catches · best line', when: `Week ${d.picks?.week}`,
      rows: top(d.receptions, r => r.mu).map(r => ({ face: nflFace(d, r.pid), name: r.name, meta: `${r.pos} · ${vs(r)}`, val: r.mu.toFixed(1), unit: bestLine(r.p) || 'proj', color: nflCol(d, r.team) })) }),
    yards: (d) => ({ title: 'Yards', sub: 'Projected rushing + receiving yards', when: `Week ${d.picks?.week}`,
      rows: top(d.yards?.rr, r => r.mu).map(r => ({ face: nflFace(d, r.pid), name: r.name, meta: `${r.pos} · ${vs(r)}`, val: String(Math.round(r.mu)), unit: `median ${Math.round(r.med)}`, color: nflCol(d, r.team) })) }),
    completions: (d) => ({ title: 'Completions', sub: 'Starting QBs · projected completions', when: `Week ${d.picks?.week}`,
      rows: top(d.completions, r => r.mu).map(r => ({ face: nflFace(d, r.pid), name: r.name, meta: `QB · ${vs(r)}`, val: r.mu.toFixed(1), unit: bestLine(r.p) || 'proj', color: nflCol(d, r.team) })) }),
    interceptions: (d) => ({ title: 'Interceptions', sub: 'Starting QBs · to throw a pick', when: `Week ${d.picks?.week}`,
      rows: top(d.interceptions, r => r.p?.['0.5'] ?? 0).map(r => ({ face: nflFace(d, r.pid), name: r.name, meta: `QB · ${vs(r)}`, val: odds(r.p['0.5']), unit: `${Math.round(r.p['0.5'] * 100)}% · 1+ INT`, color: nflCol(d, r.team) })) }),
    kickers: (d) => ({ title: 'Kickers', sub: 'Projected kicker points', when: `Week ${d.picks?.week}`,
      rows: top(d.kickers, r => r.mu?.pts ?? 0).map(r => ({ face: nflFace(d, r.pid), name: r.name, meta: `K · ${vs(r)}`, val: r.mu.pts.toFixed(1), unit: `${r.mu.fgm.toFixed(1)} FG · ${r.mu.patm.toFixed(1)} PAT`, color: nflCol(d, r.team) })) }),
    fantasy: (d) => ({ title: 'Fantasy', sub: 'Half-PPR points from our projections', when: `Week ${d.picks?.week}`,
      rows: nflFantasy(d).slice(0, 5).map(r => ({ face: nflFace(d, r.pid), name: r.name, meta: `${r.pos} · ${vs(r)}`, val: r.total.toFixed(1), unit: 'half-PPR pts', color: nflCol(d, r.team) })) }),
    stats: (d) => ({ title: 'TD Leaders', sub: 'Season touchdowns', when: String(d.upcomingSeason || ''),
      rows: top(d.tdLeaders, r => r.tds).map(r => ({ face: nflFace(d, r.pid), name: r.name, meta: `${r.pos} · ${r.team}`, val: String(r.tds), unit: `TDs in ${r.games} games`, color: nflCol(d, r.team) })) }),
    milestones: (d) => ({ title: 'TD Milestones', sub: 'Closing on a round number', when: `Week ${d.picks?.week}`,
      rows: [...(d.milestones || [])].sort((a, b) => a.away - b.away).slice(0, 5).map(r => ({ face: nflFace(d, r.pid), name: r.name, meta: `${r.pos} · ${r.team} · ${r.career} career TDs`, val: String(r.away), unit: `from ${r.next}`, color: nflCol(d, r.team) })) }),
  },
  nhl: {
    picks: (d) => ({ title: 'Goal Picks', sub: 'Anytime goal · fair odds', when: dayLbl(d.picks?.date),
      rows: top(d.picks?.picks, r => r.p).map(r => ({ face: nhlFace(r), name: r.name, meta: `${r.pos} · ${vs(r)}`, val: odds(r.p), unit: `${Math.round(r.p * 100)}% to score` })) }),
    points: (d) => ({ title: 'Points', sub: 'Projected points · fair odds for 1+', when: dayLbl(d.points?.date),
      rows: top(d.points?.board, r => r.mu?.pts ?? 0).map(r => ({ face: nhlFace(r), name: r.name, meta: `${r.pos} · ${vs(r)}`, val: odds(1 - Math.exp(-r.mu.pts)), unit: `${r.mu.pts.toFixed(2)} pts proj` })) }),
    shots: (d) => ({ title: 'Shots on Goal', sub: 'Projected shots · best line', when: dayLbl(d.shots?.date),
      rows: top(d.shots?.board, r => r.mu).map(r => ({ face: nhlFace(r), name: r.name, meta: `${r.pos} · ${vs(r)}`, val: r.mu.toFixed(1), unit: bestLine(r.p) || 'proj' })) }),
    saves: (d) => ({ title: 'Saves', sub: 'Projected starting goalies', when: dayLbl(d.saves?.date),
      rows: top(d.saves?.board, r => r.mu).map(r => ({ face: nhlFace(r), name: r.name, meta: `G · ${vs(r)}`, val: r.mu.toFixed(1), unit: bestLine(r.p) || 'saves' })) }),
    allowed: (d) => ({ title: 'Goals Allowed', sub: 'Projected goals against', when: dayLbl(d.saves?.date),
      rows: top(d.saves?.board, r => -(r.muGa ?? 9)).map(r => ({ face: nhlFace(r), name: r.name, meta: `G · ${vs(r)}`, val: r.muGa.toFixed(2), unit: 'GA proj · fewest first' })) }),
    hits: (d) => ({ title: 'Hits', sub: 'Projected hits · best line', when: dayLbl(d.hits?.date),
      rows: top(d.hits?.board, r => r.mu).map(r => ({ face: nhlFace(r), name: r.name, meta: `${r.pos} · ${vs(r)}`, val: r.mu.toFixed(1), unit: bestLine(r.p) || 'proj' })) }),
    blocks: (d) => ({ title: 'Blocked Shots', sub: 'Projected blocks · best line', when: dayLbl(d.blocks?.date),
      rows: top(d.blocks?.board, r => r.mu).map(r => ({ face: nhlFace(r), name: r.name, meta: `${r.pos} · ${vs(r)}`, val: r.mu.toFixed(1), unit: bestLine(r.p) || 'proj' })) }),
    milestones: (d) => ({ title: 'Milestone Watch', sub: 'Closing on a round number', when: dayLbl(d.picks?.date),
      rows: (d.fun?.milestones || []).slice(0, 5).map(r => ({ face: r.mug, name: r.name, meta: `${r.team} · ${r.career.toLocaleString()} career`, val: String(r.away), unit: `from ${r.next.toLocaleString()}` })) }),
  },
  nba: {
    threes: (d) => ({ title: 'Threes', sub: '2+ made threes · fair odds', when: dayLbl(d.threes?.date),
      rows: top(d.threes?.rows, r => r.p[1]).map(r => ({ face: nbaFace(r.pid), name: r.name, meta: `${r.pos} · ${vs(r)}`, val: odds(r.p[1]), unit: `${r.mu.toFixed(1)} proj · 2+` })) }),
    points: (d) => ({ title: 'Points', sub: 'Projected points', when: dayLbl(d.stats?.date),
      rows: top(d.stats?.boards?.pts?.rows, r => r.mu).map(r => ({ face: nbaFace(r.pid), name: r.name, meta: `${r.pos} · ${vs(r)}`, val: r.mu.toFixed(1), unit: `${r.min.toFixed(0)} min proj` })) }),
    stocks: (d) => ({ title: 'Steals & Blocks', sub: 'Projected stocks', when: dayLbl(d.stats?.date),
      rows: top(d.stats?.boards?.stk?.rows, r => r.mu).map(r => ({ face: nbaFace(r.pid), name: r.name, meta: `${r.pos} · ${vs(r)}`, val: r.mu.toFixed(1), unit: 'stl + blk' })) }),
    doubles: (d) => ({ title: 'Double-Doubles', sub: 'Two categories at 10+ · fair odds', when: dayLbl(d.stats?.date),
      rows: top(d.stats?.doubles, r => r.dd).map(r => ({ face: nbaFace(r.pid), name: r.name, meta: `${r.pos} · ${vs(r)}`, val: odds(r.dd), unit: `${r.pts}·${r.reb}·${r.ast} proj` })) }),
    first: (d) => ({ title: 'First Basket', sub: 'The game\'s first field goal · fair odds', when: dayLbl(d.first?.date),
      rows: top((d.first?.games || []).flatMap(g => g.players.map(x => ({ ...x, g }))), r => r.p).map(r => ({ face: nbaFace(r.pid), name: r.name,
        meta: `${r.pos} · ${r.team} ${r.team === r.g.home ? 'vs' : '@'} ${r.team === r.g.home ? r.g.away : r.g.home}${r.jumper ? ' · tip' : ''}`, val: odds(r.p), unit: `${(r.p * 100).toFixed(1)}%` })) }),
    milestones: (d) => ({ title: 'Milestone Watch', sub: 'Closing on a round number', when: dayLbl(d.today),
      rows: (d.fun?.milestones || []).slice(0, 5).map(r => ({ face: nbaFace(r.pid), name: r.name, meta: `${r.team} · ${r.career.toLocaleString()} career`, val: String(r.away), unit: `from ${r.next.toLocaleString()}` })) }),
  },
  mlb: {
    picks: (d) => mlbHr(d, d.picks, 'HR Picks', 'Home run · fair odds'),
    value: (d) => mlbHr(d, d.value, 'Value Bats', 'Longer shots in great spots · fair odds'),
    due: (d) => ({ title: 'Most Due', sub: 'Home run droughts against proven power', when: dayLbl(d.todayDate),
      rows: top(d.dueRows, r => r.dueScore).map(r => ({ face: mlbFace(r.pid), name: r.name, meta: `${r.team} · ${r.hrs} HR`, val: String(r.droughtABs), unit: 'AB since a HR' })) }),
  },
};
function mlbHr(d, list, title, sub) {
  return { title, sub, when: dayLbl(d.todayDate), rows: (list || []).slice(0, 5).map(r => ({ face: mlbFace(r.pid), name: d.playerNames?.[r.pid] || r.pid,
    meta: `${r.team} vs ${r.oppName} (${r.oppHand}HP)`, val: odds(r.pHR), unit: `${(r.pHR * 100).toFixed(1)}% · HR` })) };
}
/** nfl/index.html renderFantasy, the same sums: half-PPR from the boards' projections. */
function nflFantasy(d) {
  const by = (a) => new Map((a || []).map(r => [r.pid, r]));
  const rec = by(d.receptions), yr = by(d.yards?.rec), yu = by(d.yards?.rush), yp = by(d.yards?.pass), it = by(d.interceptions);
  const out = [];
  for (const r of d.picks?.picks || []) {
    if (!['QB', 'RB', 'WR', 'TE'].includes(r.pos)) continue;
    const R = rec.get(r.pid), YR = yr.get(r.pid), YU = yu.get(r.pid), YP = r.pos === 'QB' ? yp.get(r.pid) : null;
    if (r.pos === 'QB' ? !YP : !(YR || YU)) continue;
    const p1 = r.p || 0, p2 = Math.min(r.p2 || 0, p1 * 0.95), td = p1 > 0 ? p1 / (1 - p2 / p1) : 0;
    const total = (R?.mu || 0) * 0.5 + ((YR ? YR.mu : (R?.mu || 0) * 10.5) + (YU?.mu || 0)) * 0.1 + td * 6
      + (YP?.mu || 0) * 0.04 + (r.pass?.proj || 0) * 4 - (YP ? (it.get(r.pid)?.mu || 0) : 0) * 2;
    out.push({ ...r, total });
  }
  return out.sort((a, b) => b.total - a.total);
}

// ── the card ─────────────────────────────────────────────────────────────
const h = (type, style, ...kids) => React.createElement(type, { style: { display: 'flex', ...style } }, ...kids.flat().filter(k => k != null && k !== false));
const I = (src, style) => React.createElement('img', { src, width: style.width, height: style.height, style });
function card(app, B, path, logo, faces) {
  const [a, b, c] = app.name;
  const header = h('div', { alignItems: 'center', justifyContent: 'space-between' },
    h('div', { alignItems: 'center', gap: 16 },
      logo ? I(logo, { width: 44, height: 44, borderRadius: 10 }) : null,
      h('div', { fontFamily: 'Chakra', fontSize: 26, color: INK, letterSpacing: 1 }, `${a} `, h('span', { color: G, marginLeft: 8, marginRight: 8 }, b), ` ${c}`)),
    h('div', { fontFamily: 'Mono', fontSize: 22, color: MUTED }, B.when || ''));
  const title = h('div', { flexDirection: 'column', marginTop: 12 },
    h('div', { fontFamily: 'Chakra', fontSize: 58, color: '#fff', lineHeight: 1 }, B.title),
    B.sub ? h('div', { fontFamily: 'Jakarta', fontWeight: 500, fontSize: 22, color: MUTED, marginTop: 6 }, B.sub) : null);
  const rows = (B.rows || []).map((r, i) => h('div', { alignItems: 'center', height: 60, marginTop: i ? 6 : 0, padding: '0 18px', borderRadius: 14,
      background: i === 0 ? 'rgba(51,208,124,0.10)' : 'rgba(255,255,255,0.035)', borderLeft: `5px solid ${r.color || G}` },
    h('div', { width: 34, fontFamily: 'Mono', fontSize: 22, color: MUTED }, String(i + 1)),
    faces[i] ? I(faces[i], { width: 48, height: 48, borderRadius: 24, objectFit: 'cover', background: '#111a2b' })
             : h('div', { width: 48, height: 48, borderRadius: 24, background: '#111a2b' }),
    h('div', { flexDirection: 'column', marginLeft: 16, flexGrow: 1 },
      h('div', { fontFamily: 'Jakarta', fontWeight: 700, fontSize: 25, color: '#fff', lineHeight: 1.15 }, r.name),
      h('div', { fontFamily: 'Jakarta', fontWeight: 500, fontSize: 17, color: MUTED }, r.meta || '')),
    h('div', { flexDirection: 'column', alignItems: 'flex-end' },
      h('div', { fontFamily: 'Chakra', fontSize: 32, color: G, lineHeight: 1 }, r.val),
      h('div', { fontFamily: 'Mono', fontSize: 15, color: MUTED, marginTop: 3 }, r.unit || ''))));
  // no board: what the tool does, big, beside the app's mark
  const body = rows.length ? h('div', { flexDirection: 'column', marginTop: 18 }, rows)
    : h('div', { flexGrow: 1, alignItems: 'center', justifyContent: 'space-between' },
        h('div', { fontFamily: 'Jakarta', fontWeight: 600, fontSize: 36, lineHeight: 1.3, color: '#c9d2df', maxWidth: 740 }, B.desc || ''),
        logo ? I(logo, { width: 250, height: 250, borderRadius: 48, opacity: 0.9 }) : null);
  const foot = h('div', { justifyContent: 'space-between', alignItems: 'center', marginTop: 'auto', paddingTop: 10, fontFamily: 'Mono', fontSize: 18, color: MUTED },
    h('div', {}, h('span', { color: G }, 'dong-tool.netlify.app'), path),
    h('div', {}, 'Fair odds, no vig · Inspired by Green Means Go'));
  return h('div', { width: 1200, height: 630, flexDirection: 'column', padding: '32px 56px 26px', color: INK, fontFamily: 'Jakarta',
    backgroundColor: BG, backgroundImage: 'linear-gradient(135deg, rgba(51,208,124,0.16) 0%, rgba(5,8,15,0) 45%)' },
    header, title, body, foot);
}

export default async (request) => {
  const url = new URL(request.url);
  const m = url.pathname.match(/^\/og\/(mlb|nfl|nhl|nba)\/([a-z-]*)\.png$/);
  const app = m && APP[m[1]];
  if (!app) return new Response('not found', { status: 404 });
  const [, sport, tool] = m;
  const fallback = () => Response.redirect(SITE + app.card, 302);
  try {
    const d = await data(sport);
    const fn = BOARDS[sport]?.[tool];
    let B = fn ? fn(d) : null;
    if (!B || !B.rows?.length) {
      // no ranked board here (or nothing on it yet): the tool's name and what it does
      const title = url.searchParams.get('t'), desc = url.searchParams.get('s');
      if (!title) return fallback();
      B = { title, sub: '', desc, when: B?.when || '', rows: [] };
    }
    const [f, logo, faces] = await Promise.all([fonts(), img(SITE + app.logo), Promise.all((B.rows || []).map(r => img(r.face)))]);
    const res = new ImageResponse(card(app, B, `/${sport}${tool ? '/' + tool : ''}`, logo, faces), { width: 1200, height: 630, fonts: f });
    // render fully here: satori streams, and a failure mid-stream would escape to a 500
    const out = new Response(await res.arrayBuffer(), { headers: { 'Content-Type': 'image/png' } });
    out.headers.set('Cache-Control', 'public, max-age=600');
    out.headers.set('Netlify-CDN-Cache-Control', 'public, max-age=900, stale-while-revalidate=3600');
    return out;
  } catch (e) {
    return fallback();
  }
};

export const config = { path: '/og/*' };
