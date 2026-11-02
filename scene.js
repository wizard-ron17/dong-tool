// Night scenes: each sport's own sky behind the page, the look Halloween had all year round (a lit sky instead of flat
// black, the cards tinted to it, brighter borders, art in the empty margins), in the sport's own hue. The accent and the
// good/bad ramp stay the app's; only the sky, the surfaces and the borders change.
// PREVIEW ONLY for now: ?bg=night turns it on for this tab (it stays on as you move around), ?bg=off turns it off.
// A holiday stands aside while a scene is previewed, unless asked for by name (?holiday=halloween). chrome.js loads this file.
//
//   nfl   a clear night game, one panorama from the 50: the lit field in perspective (mowing stripes, yard lines, end
//         zones painted TUD TOOL), goalposts on both end lines, the bowl of stands wrapping round (two decks, a crowd in
//         jersey colours, suites, phone flashes), light towers standing on its rim, the jumbotron calling TOUCHDOWN, the
//         blimp. Phones get an end-zone view of the same night.
(function () {
  if (window.RonScene) return;
  const q = new URLSearchParams(location.search).get('bg');
  try { if (q === 'night') sessionStorage.setItem('ronScene', 'night'); else if (q === 'off') sessionStorage.removeItem('ronScene'); } catch (e) {}
  let want = q === 'night';
  try { want = want || sessionStorage.getItem('ronScene') === 'night'; } catch (e) {}
  const sport = location.pathname.split('/').filter(Boolean)[0] || '';
  const SCENES = { nfl: nfl };
  window.RonScene = { on: null };
  if (!want || !SCENES[sport]) return;
  // a holiday asked for by name (?holiday=halloween) wins; otherwise holiday.js stands aside while a scene is previewed
  const go = () => {
    if (new URLSearchParams(location.search).get('holiday') && new URLSearchParams(location.search).get('holiday') !== 'off') return;
    window.RonScene.on = sport;
    document.documentElement.setAttribute('data-scene', sport);
    SCENES[sport]();
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', go); else go();

  function mount(css, art) {
    const style = document.createElement('style'); style.id = 'scene-css'; style.textContent = css; document.head.appendChild(style);
    if (!document.querySelector('.scn')) document.body.insertAdjacentHTML('afterbegin', `<div class="scn" aria-hidden="true">${art}</div>`);
  }
  // One drawing that fills the screen (sliced to cover it, so it never shows an edge): a landscape composition for desktops
  // and tablets, a portrait one for phones. The content column covers the middle, so the pieces that carry the scene sit
  // where the margins are; the continuous things (the bowl, the field, the sky's light) tie it together.
  function FULL_CSS(S, LIGHT) { return `
      /* under everything (z-index -1, above only the page background): no header, footer or panel can ever be covered */
      ${S} .scn { position: fixed; inset: 0; z-index: -1; pointer-events: none; overflow: hidden; }
      ${S} .scn svg { position: absolute; inset: 0; width: 100%; height: 100%; display: block; }
      ${S} .scn-port { display: none !important; }
      @media (max-width: 760px) { ${S} .scn-land { display: none !important; } ${S} .scn-port { display: block !important; } }
      ${LIGHT} .scn svg { opacity: .34; }
      /* the footer gets its own frosted panel: the art reaches the page end, and its text must read over it */
      ${S} .site-foot { background: color-mix(in srgb, var(--bg) 72%, transparent); -webkit-backdrop-filter: blur(10px); backdrop-filter: blur(10px);
        border: 1px solid var(--border); border-radius: 14px; padding: 0.8rem 1rem; }`; }

  function nfl() {
    const S = 'html[data-scene="nfl"]', DARK = `${S}:not([data-theme="light"])`, LIGHT = `${S}[data-theme="light"]`;
    const calm = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const f1 = (n) => +n.toFixed(1), L = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
    let seed = 7; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    // a crowd at night is a mass of colours in rows, not dots: heads in jersey colours, a seat-row shadow under each row
    const CROWD_TILE = (() => {
      const C = ['var(--scn-c1)', 'var(--scn-c2)', 'var(--scn-c3)', 'var(--scn-c4)', 'var(--scn-c5)', 'var(--scn-c6)', 'var(--scn-c1)', 'var(--scn-c6)'];
      let out = '';
      for (let row = 0; row < 2; row++) {
        const y = 2.2 + row * 6;
        out += `<rect x="0" y="${f1(y + 2.6)}" width="96" height="1.1" fill="var(--scn-seatline)"/>`;
        for (let x = 0.8 + row * 1.3; x < 95; x += 2.3 + rnd() * 1.4)
          if (rnd() > 0.07) out += `<rect x="${f1(x)}" y="${f1(y - 0.6 + rnd() * 0.9)}" width="${f1(1.5 + rnd() * 0.6)}" height="${f1(2 + rnd() * 0.6)}" rx=".7" fill="${C[Math.floor(rnd() * C.length)]}" opacity="${f1(0.55 + rnd() * 0.4)}"/>`;
      }
      return out;
    })();

    // shared paint: gradients and patterns, prefixed per drawing so the two never share an id
    const defs = (p) => `<defs>
      <radialGradient id="${p}halo"><stop offset="0" stop-color="var(--scn-light)" stop-opacity=".95"/><stop offset=".3" stop-color="var(--scn-light)" stop-opacity=".35"/><stop offset="1" stop-color="var(--scn-light)" stop-opacity="0"/></radialGradient>
      <radialGradient id="${p}bloom"><stop offset="0" stop-color="var(--scn-light)" stop-opacity=".42"/><stop offset=".25" stop-color="var(--scn-light)" stop-opacity=".14"/><stop offset=".6" stop-color="var(--scn-light)" stop-opacity=".04"/><stop offset="1" stop-color="var(--scn-light)" stop-opacity="0"/></radialGradient>
      <radialGradient id="${p}fieldglow"><stop offset="0" stop-color="var(--scn-fieldglow)" stop-opacity=".5"/><stop offset="1" stop-color="var(--scn-fieldglow)" stop-opacity="0"/></radialGradient>
      <linearGradient id="${p}flare" x1="0" x2="1"><stop offset="0" stop-color="var(--scn-flare)" stop-opacity="0"/><stop offset=".5" stop-color="var(--scn-flare)" stop-opacity=".5"/><stop offset="1" stop-color="var(--scn-flare)" stop-opacity="0"/></linearGradient>
      <linearGradient id="${p}beam" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="var(--scn-light)" stop-opacity=".16"/><stop offset="1" stop-color="var(--scn-light)" stop-opacity=".02"/></linearGradient>
      <linearGradient id="${p}mast" x1="0" x2="1"><stop offset="0" stop-color="var(--scn-sil)"/><stop offset=".7" stop-color="var(--scn-sil)"/><stop offset="1" stop-color="var(--scn-mast-hi)"/></linearGradient>
      <linearGradient id="${p}post" x1="0" x2="1"><stop offset="0" stop-color="var(--scn-post-hi)"/><stop offset=".4" stop-color="var(--scn-post)"/><stop offset="1" stop-color="var(--scn-post-lo)"/></linearGradient>
      <linearGradient id="${p}turf" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="var(--scn-turf-far)"/><stop offset="1" stop-color="var(--scn-turf-near)"/></linearGradient>
      <pattern id="${p}crowd" width="96" height="12" patternUnits="userSpaceOnUse"><rect width="96" height="12" fill="var(--scn-stand)"/>${CROWD_TILE}</pattern>
      <linearGradient id="${p}shade" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="var(--scn-sil)" stop-opacity=".72"/><stop offset=".4" stop-color="var(--scn-sil)" stop-opacity=".3"/><stop offset="1" stop-color="var(--scn-sil)" stop-opacity="0"/></linearGradient>
      <filter id="${p}soft" x="-20%" y="-20%" width="140%" height="140%"><feGaussianBlur stdDeviation="10"/></filter>
      <filter id="${p}glow" x="-20%" y="-60%" width="140%" height="220%"><feGaussianBlur stdDeviation="3"/></filter>
      
      <pattern id="${p}ez" width="24" height="24" patternUnits="userSpaceOnUse" patternTransform="rotate(35)"><rect width="24" height="24" fill="var(--scn-ez)"/><rect width="9" height="24" fill="var(--scn-ez2)"/></pattern>
      <linearGradient id="${p}screen" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="var(--scn-screen-hi)"/><stop offset="1" stop-color="var(--scn-screen)"/></linearGradient>
      <radialGradient id="${p}screenglow"><stop offset="0" stop-color="var(--scn-led)" stop-opacity=".32"/><stop offset="1" stop-color="var(--scn-led)" stop-opacity="0"/></radialGradient>
      <linearGradient id="${p}led" x1="0" x2="1"><stop offset="0" stop-color="var(--scn-led)" stop-opacity=".2"/><stop offset=".5" stop-color="var(--scn-led)" stop-opacity=".95"/><stop offset="1" stop-color="var(--scn-led)" stop-opacity=".2"/></linearGradient>
      <linearGradient id="${p}blimp" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="var(--scn-stand)"/><stop offset="1" stop-color="var(--scn-sil)"/></linearGradient>
      <linearGradient id="${p}lit" x1="0" y1="0" x2="0" y2="1"><stop offset=".35" stop-color="var(--scn-standlit)" stop-opacity="0"/><stop offset="1" stop-color="var(--scn-standlit)" stop-opacity=".2"/></linearGradient></defs>`;

    // a light bank on a mast. The mast runs down past the rim; the stands, drawn after, cover its foot (grounded)
    const tower = (p, x, top, w, h, foot, tilt) => {
      const P00 = [x - w / 2, top + tilt], P10 = [x + w / 2, top - tilt], P01 = [x - w / 2 + 4, top + h + tilt], P11 = [x + w / 2 - 4, top + h - tilt];
      const cols = Math.max(4, Math.round(w / 21)), rows = Math.max(2, Math.round(h / 21)), r = Math.max(2.6, w / 44);
      let lamps = '';
      for (let i = 0; i < rows; i++) for (let j = 0; j < cols; j++) {
        const [lx, ly] = L(L(P00, P10, 0.08 + j * 0.84 / (cols - 1)), L(P01, P11, 0.08 + j * 0.84 / (cols - 1)), 0.18 + i * 0.64 / (rows - 1));
        lamps += `<circle cx="${f1(lx)}" cy="${f1(ly)}" r="${f1(r * 2.9)}" fill="url(#${p}halo)"/><circle cx="${f1(lx)}" cy="${f1(ly)}" r="${f1(r)}" fill="var(--scn-lamp)"/>`;
      }
      const mw = Math.max(5, w / 16);
      return `<circle cx="${x}" cy="${top + h / 2}" r="${w * 2.1}" fill="url(#${p}bloom)"/>
        <path d="M${x - mw * 0.55} ${top + h}L${x - mw} ${foot}H${x + mw}L${x + mw * 0.55} ${top + h}Z" fill="url(#${p}mast)"/>
        <path d="M${P01}L${P11}" stroke="var(--scn-sil)" stroke-width="${f1(w / 30)}"/>
        <path d="M${P00}L${P10}L${P11}L${P01}Z" fill="var(--scn-sil)" stroke="var(--scn-rim)" stroke-width="${f1(Math.max(1, w / 90))}" stroke-linejoin="round"/>${lamps}
        <ellipse cx="${x}" cy="${top + h / 2}" rx="${w * 1.9}" ry="${f1(Math.max(2.5, w / 40))}" fill="url(#${p}flare)"/>`;
    };
    // a beam from a bank to a spot on the field
    const beam = (x, top, w, h, a, b) => `M${x - w / 2 + 4} ${top + h}L${x + w / 2 - 4} ${top + h}L${b[0]} ${b[1]}L${a[0]} ${a[1]}Z`;
    // a crowd's phone flashes, twinkling at their own pace
    const flashes = (pts) => pts.map(([x, y], k) => `<circle class="scn-tw" style="animation-delay:${f1((k * 1.37) % 5)}s;animation-duration:${f1(3.5 + (k % 4) * 0.8)}s" cx="${f1(x)}" cy="${f1(y)}" r="1.9"/>`).join('');
    // goalposts in perspective: base on the end line, the crossbar along it (dx, dy per side), uprights up from its ends.
    // The stem and crossbar are solid: a gradient on a straight horizontal or vertical line (a zero-size box) paints nothing
    const goal = (p, bx, by, ex, ey, rise, up, sw, flip) => {
      const cy = by - rise, a = [bx - ex, cy - ey], b = [bx + ex, cy + ey], k = flip ? -1 : 1;
      const flag = ([x, y], d) => `<g class="scn-sway" style="transform-origin:${f1(x)}px ${f1(y)}px;animation-delay:${d}s"><path d="M${f1(x)} ${f1(y)}c${-10 * k} 3 ${-15 * k} 9 ${-26 * k} 9c${9 * k} 5 ${17 * k} 1 ${26 * k} 4z" fill="var(--scn-flag)"/></g>`;
      return `<ellipse cx="${bx}" cy="${by + 2}" rx="${sw * 6}" ry="${sw * 1.4}" fill="var(--scn-sil)" opacity=".55"/>
        <g fill="none" stroke-linecap="round" stroke-linejoin="round">
          <path d="M${bx} ${by}V${cy}" stroke="var(--scn-post)" stroke-width="${sw * 1.35}"/>
          <path d="M${f1(a[0])} ${f1(a[1])}L${f1(b[0])} ${f1(b[1])}" stroke="var(--scn-post)" stroke-width="${sw * 1.15}"/>
          <path d="M${f1(a[0])} ${f1(a[1] - sw * 0.35)}L${f1(b[0])} ${f1(b[1] - sw * 0.35)}" stroke="var(--scn-post-hi)" stroke-width="${f1(sw * 0.25)}" opacity=".8"/>
          <path d="M${f1(a[0])} ${f1(a[1])}V${f1(a[1] - up)}M${f1(b[0])} ${f1(b[1])}V${f1(b[1] - up)}" stroke="url(#${p}post)" stroke-width="${sw}"/>
          <path d="M${f1(a[0] - sw * 0.3)} ${f1(a[1])}V${f1(a[1] - up)}M${f1(b[0] - sw * 0.3)} ${f1(b[1])}V${f1(b[1] - up)}" stroke="var(--scn-post-hi)" stroke-width="${f1(sw * 0.22)}" opacity=".85"/></g>
        <rect x="${bx - sw * 1.2}" y="${by - rise * 0.42}" width="${sw * 2.4}" height="${rise * 0.42}" rx="${sw * 0.7}" fill="var(--scn-pad)"/>
        ${flag([a[0], a[1] - up], 0)}${flag([b[0], b[1] - up], -1.1)}`;
    };
    const ezText = (endF, goalF, endN, goalN, size, flip) => {
      const mid = (a, b) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2], Mf = mid(endF, goalF), Mn = mid(endN, goalN);
      const A = L(Mn, Mf, 0.07), B = L(Mn, Mf, 0.7), h = L([endN[0] - goalN[0], endN[1] - goalN[1]], [endF[0] - goalF[0], endF[1] - goalF[1]], 0.4);
      const hl = Math.hypot(...h), up = [h[0] / hl, h[1] / hl], k = hl * size / 70;
      let xv = [(B[0] - A[0]) / 520, (B[1] - A[1]) / 520], o = mid(A, B), yv = [-up[0] * k, -up[1] * k];
      if (xv[0] * yv[1] - xv[1] * yv[0] < 0) xv = [-xv[0], -xv[1]];                       // never mirrored
      if (flip) { xv = [-xv[0], -xv[1]]; yv = [-yv[0], -yv[1]]; }                           // turned half round: both ends read from the same side
      return `<text transform="matrix(${[...xv, ...yv, ...o].map(n => +n.toFixed(4)).join(' ')})" x="0" y="0" text-anchor="middle" dominant-baseline="central" textLength="520" lengthAdjust="spacingAndGlyphs"
        font-family="'Chakra Petch', sans-serif" font-weight="700" font-size="100" letter-spacing="6" fill="var(--scn-ez-text)" stroke="var(--scn-ez-edge)" stroke-width="7" paint-order="stroke" stroke-linejoin="round">TUD TOOL</text>`;
    };
    const jumbotron = (p, x, y, w, h, foot) => `<circle cx="${x + w / 2}" cy="${y + h / 2}" r="${w * 1.3}" fill="url(#${p}screenglow)"/><circle cx="${x + w / 2}" cy="${y + h / 2}" r="${w * 0.7}" fill="url(#${p}screenglow)"/>
      <path d="M${x + w * 0.22} ${y + h}V${foot}M${x + w * 0.78} ${y + h}V${foot}" stroke="var(--scn-sil)" stroke-width="${w * 0.05}"/>
      <rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${w * 0.04}" fill="var(--scn-sil)" stroke="var(--scn-rim)" stroke-width="2"/>
      <rect x="${x + w * 0.05}" y="${y + h * 0.08}" width="${w * 0.9}" height="${h * 0.62}" rx="4" fill="url(#${p}screen)"/>
      <text x="${x + w / 2}" y="${y + h * 0.5}" text-anchor="middle" font-family="'Chakra Petch', 'JetBrains Mono', sans-serif" font-weight="700" font-size="${f1(w * 0.135)}" fill="var(--scn-led)" filter="url(#${p}glow)" class="scn-pulse">TOUCHDOWN</text>
      <text x="${x + w / 2}" y="${y + h * 0.5}" text-anchor="middle" font-family="'Chakra Petch', 'JetBrains Mono', sans-serif" font-weight="700" font-size="${f1(w * 0.135)}" fill="var(--scn-led-hi)" class="scn-pulse">TOUCHDOWN</text>
      <rect x="${x + w * 0.05}" y="${y + h * 0.76}" width="${w * 0.9}" height="${h * 0.15}" rx="3" fill="var(--scn-ribbon-bg)"/>
      <text x="${x + w / 2}" y="${y + h * 0.875}" text-anchor="middle" font-family="'JetBrains Mono', ui-monospace, monospace" font-weight="700" font-size="${f1(w * 0.058)}" letter-spacing="1" fill="var(--scn-ribbon)">HOME 24 · AWAY 21 · 4TH</text>`;
    const blimp = (p, x, y, s) => `<g class="scn-drift"><g transform="translate(${x} ${y}) scale(${s})"><circle r="230" fill="url(#${p}screenglow)" opacity=".7"/>
      <path d="M-132 -12L-160 -42L-118 -20ZM-132 12L-162 40L-116 20Z" fill="var(--scn-sil)" stroke="var(--scn-rim)" stroke-width="1.5" stroke-linejoin="round"/>
      <ellipse rx="140" ry="42" fill="url(#${p}blimp)" stroke="var(--scn-rim)" stroke-width="1.5"/><path d="M-128 -12Q0 -60 132 -10" stroke="var(--scn-rim)" stroke-width="2.5" fill="none"/>
      <rect x="-70" y="-15" width="140" height="28" rx="7" fill="url(#${p}led)"/>
      <text x="0" y="5" text-anchor="middle" font-family="'Chakra Petch', 'JetBrains Mono', sans-serif" font-weight="700" font-size="15" letter-spacing="3" fill="var(--scn-led-text)">RON'S TOOLS</text>
      <rect x="-22" y="40" width="48" height="14" rx="5" fill="var(--scn-sil)" stroke="var(--scn-rim)" stroke-width="1"/>
      <g fill="var(--scn-window)"><rect x="-16" y="44" width="6" height="5" rx="1"/><rect x="-5" y="44" width="6" height="5" rx="1"/><rect x="6" y="44" width="6" height="5" rx="1"/><rect x="17" y="44" width="5" height="5" rx="1"/></g>
      <circle class="scn-tw" cx="138" cy="0" r="2.6" fill="#ff4d4d"/></g></g>`;

    // ── landscape: the view from the 50, a little above the field ─────────────────────────────────────────────
    const W = 1600, H = 900, FAR = 668;
    const rimL = (x) => x < 420 ? 548 - 178 * (1 - x / 420) ** 1.55 : x > 1180 ? 548 - 178 * (1 - (W - x) / 420) ** 1.55 : 548 + 4 * Math.sin(x / 90);
    const F0 = [338, FAR], F1 = [1262, FAR], N0 = [-140, H - 6], N1 = [1740, H - 6];          // far and near sidelines, end to end
    const at = (t) => [L(F0, F1, t), L(N0, N1, t)];                                            // a line across the field at t (0..1, end line to end line)
    let rimPath = 'M0 ' + f1(rimL(0));
    for (let x = 20; x <= W; x += 20) rimPath += ' L' + x + ' ' + f1(rimL(x));
    const bowl = `${rimPath} L${W} ${H} L0 ${H}Z`;
    let fasciaL = 'M0 ' + f1(rimL(0) + 58);
    for (let x = 20; x <= W; x += 20) fasciaL += ' L' + x + ' ' + f1(rimL(x) + 58);
    // the field: mowing stripes every 5 yards, the end zones, yard lines (heavier every 10), the sidelines
    let field = `<path d="M${F0}L${F1}L${N1}L${N0}Z" fill="url(#Lturf)"/>`;
    for (let y = 10; y < 110; y += 5) if ((y / 5) % 2) { const [a, b] = at(y / 120), [c, d] = at((y + 5) / 120); field += `<path d="M${a}L${c}L${d}L${b}Z" fill="var(--scn-stripe)"/>`; }
    for (const [t0, t1, flip] of [[0, 10 / 120, false], [1, 110 / 120, true]]) {
      const [a, b] = at(t0), [c, d] = at(t1);
      field += `<path d="M${a}L${c}L${d}L${b}Z" fill="var(--scn-ez-paint)"/>` + ezText(a, c, b, d, 0.44, flip);
    }
    for (let y = 10; y <= 110; y += 5) { const [a, b] = at(y / 120); field += `<path d="M${a.map(f1)}L${b.map(f1)}" stroke="var(--scn-line)" stroke-width="${y % 10 ? 1.4 : 2.6}"/>`; }
    field += `<path d="M${F0}L${F1}M${F0}L${N0}M${F1}L${N1}" stroke="var(--scn-line)" stroke-width="3"/>`;
    // the wall that keeps the crowd off the field: along the far side and behind both end zones, set back past an
    // out-of-bounds apron (the goalposts stand in front of it), LED boards along its face, a padded cap
    const [WF0, WN0] = at(-0.075), [WF1, WN1] = at(1.075);
    field = `<path d="M${WF0}L${WF1}L${WN1}L${WN0}Z" fill="var(--scn-apron)"/>` + field;
    const strip = (p, q, hp, hq, n, off) => {
      let out = `<path d="M${p}L${q}L${q[0]} ${q[1] - hq}L${p[0]} ${p[1] - hp}Z" fill="var(--scn-wall)"/><path d="M${p[0]} ${p[1] - hp}L${q[0]} ${q[1] - hq}" stroke="var(--scn-wallcap)" stroke-width="2.5"/>`;
      for (let i = 0; i < n; i++) {
        const u0 = (i + 0.08) / n, u1 = (i + 0.92) / n, A = L(p, q, u0), B = L(p, q, u1), ha = hp + (hq - hp) * u0, hb = hp + (hq - hp) * u1;
        out += `<path d="M${A[0]} ${A[1] - ha * 0.22}L${B[0]} ${B[1] - hb * 0.22}L${B[0]} ${B[1] - hb * 0.72}L${A[0]} ${A[1] - ha * 0.72}Z" fill="url(#Lled)" opacity="${(i + off) % 3 ? .45 : .95}"/>`;
      }
      return out;
    };
    let wall = strip([WF0[0], FAR], [WF1[0], FAR], 20, 20, 14, 0) + strip(WN0, WF0, 34, 20, 4, 1) + strip(WF1, WN1, 20, 34, 4, 2);
    // suites: a row of warm windows across the far stands
    let suites = '';
    for (let x = 430; x < 1170; x += 13) suites += `<rect x="${x}" y="603" width="8" height="5" rx="1" fill="var(--scn-window)" opacity="${f1(0.35 + rnd() * 0.55)}"/>`;
    const edgeY = (x) => x < F0[0] ? L(F0, N0, (F0[0] - x) / (F0[0] - N0[0]))[1] : x > F1[0] ? L(F1, N1, (x - F1[0]) / (N1[0] - F1[0]))[1] : FAR - 20;
    let aisles = '';
    for (let x = 60; x < W; x += 132) { const y0 = rimL(x) + 4, x1 = x + (x - 800) * 0.07, y1 = edgeY(x1); if (y1 > y0 + 20) aisles += `M${f1(x)} ${f1(y0)}L${f1(x1)} ${f1(y1)}`; }
    const lFlash = []; seed = 11;
    while (lFlash.length < 46) { const x = rnd() * W, top = rimL(x) + 10, bot = x < F0[0] ? L(F0, N0, (F0[0] - x) / (F0[0] - N0[0]))[1] - 12 : x > F1[0] ? L(F1, N1, (x - F1[0]) / (N1[0] - F1[0]))[1] - 12 : FAR - 30; if (bot > top + 6) lFlash.push([x, top + rnd() * (bot - top)]); }
    const towersL = [[120, 92, 176, 86, 560, 4], [1484, 70, 176, 86, 540, -4], [560, 352, 86, 40, 590, 2], [1040, 352, 86, 40, 590, -2]];
    const beamsL = [beam(120, 92, 176, 86, [430, 760], [760, 860]), beam(1484, 70, 176, 86, [1180, 860], [880, 760]), beam(560, 352, 86, 40, [620, 760], [800, 760]), beam(1040, 352, 86, 40, [800, 760], [980, 760])];
    const LAND = `<svg class="scn-land" viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMax slice">${defs('L')}
      <ellipse cx="800" cy="${FAR + 30}" rx="900" ry="220" fill="url(#Lfieldglow)" opacity=".7"/>
      ${towersL.slice(2).map(t => tower('L', ...t)).join('')}${towersL.slice(0, 2).map(t => tower('L', ...t)).join('')}
      ${blimp('L', 150, 318, 0.56)}
      ${jumbotron('L', 1430, 236, 160, 98, 440)}
      <path d="${bowl}" fill="url(#Lcrowd)"/><path d="${bowl}" fill="url(#Lshade)"/><path d="${bowl}" fill="url(#Llit)"/>
      <path d="${aisles}" stroke="var(--scn-aisle)" stroke-width="5" fill="none"/>
      <path d="${fasciaL}" stroke="var(--scn-fascia)" stroke-width="7" fill="none"/><path d="${fasciaL}" stroke="var(--scn-rim)" stroke-width="1" fill="none" transform="translate(0 -3.5)"/>
      <path d="${rimPath}" stroke="var(--scn-rim)" stroke-width="1.6" fill="none"/>
      ${suites}<g fill="var(--scn-flash)">${flashes(lFlash)}</g>
      ${field}${wall}
      ${goal('L', 99, 781, 22, -10, 52, 206, 7, false)}${goal('L', 1501, 781, -22, -10, 52, 206, 7, true)}
      <path d="${beamsL.join('')}" fill="url(#Lbeam)" filter="url(#Lsoft)"/></svg>`;

    // ── portrait (phones): the end-zone view, the goalposts straight ahead, a light bank in each top corner ─────
    const PW = 900, PH = 1600, PF = 1040;
    const rimP = (x) => 790 - 230 * (Math.abs(x - 450) / 450) ** 1.7;
    let rimPP = 'M0 ' + f1(rimP(0));
    for (let x = 15; x <= PW; x += 15) rimPP += ' L' + x + ' ' + f1(rimP(x));
    const bowlP = `${rimPP} L${PW} ${PH} L0 ${PH}Z`;
    let fasciaP = 'M0 ' + f1(rimP(0) + 96);
    for (let x = 15; x <= PW; x += 15) fasciaP += ' L' + x + ' ' + f1(rimP(x) + 96);
    const Pl = (d) => { const t = (d / 42) ** 1.35, y = PF + (PH + 60 - PF) * t; return [[f1(260 - 420 * t), f1(y)], [f1(640 + 420 * t), f1(y)]]; };   // a line across at d yards from the end line
    let fieldP = `<path d="M260 ${PF}L640 ${PF}L1060 ${PH + 60}L-160 ${PH + 60}Z" fill="url(#Pturf)"/>`;
    for (let d = 10; d < 42; d += 5) if ((d / 5) % 2) { const [a, b] = Pl(d), [c, e] = Pl(Math.min(42, d + 5)); fieldP += `<path d="M${a}L${b}L${e}L${c}Z" fill="var(--scn-stripe)"/>`; }
    { const [a, b] = Pl(0), [c, e] = Pl(10); fieldP += `<path d="M${a}L${b}L${e}L${c}Z" fill="var(--scn-ez-paint)"/>`;
      // seen end-on the letters run left to right across it: the same map, end line and goal line swapped for sideline and sideline
      const M = (u, v) => [(u[0] + v[0]) / 2, (u[1] + v[1]) / 2], A = L(M(a, c), M(b, e), 0.1), B = L(M(a, c), M(b, e), 0.9), up = [0, -1], k = ((c[1] + e[1]) / 2 - (a[1] + b[1]) / 2) * 0.55 / 70;
      fieldP += `<text transform="matrix(${[(B[0] - A[0]) / 520, (B[1] - A[1]) / 520, 0, k, (A[0] + B[0]) / 2, (A[1] + B[1]) / 2].map(n => +n.toFixed(4)).join(' ')})" x="0" y="0" text-anchor="middle" dominant-baseline="central" textLength="520" lengthAdjust="spacingAndGlyphs"
        font-family="'Chakra Petch', sans-serif" font-weight="700" font-size="100" letter-spacing="6" fill="var(--scn-ez-text)" stroke="var(--scn-ez-edge)" stroke-width="7" paint-order="stroke" stroke-linejoin="round">TUD TOOL</text>`; }
    for (let d = 10; d <= 40; d += 5) { const [a, b] = Pl(d); fieldP += `<path d="M${a}L${b}" stroke="var(--scn-line)" stroke-width="${d % 10 ? 1.6 : 3}"/>`; }
    fieldP += `<path d="M260 ${PF}L640 ${PF}M260 ${PF}L-160 ${PH + 60}M640 ${PF}L1060 ${PH + 60}" stroke="var(--scn-line)" stroke-width="3"/>`;
    let aislesP = '';
    for (let x = 30; x < PW; x += 110) { const y0 = rimP(x) + 4, x1 = x + (x - 450) * 0.12; aislesP += `M${f1(x)} ${f1(y0)}L${f1(x1)} ${PF - 4}`; }
    const pFlash = []; seed = 23;
    while (pFlash.length < 30) { const x = rnd() * PW, top = rimP(x) + 10, bot = PF - 16; if (bot > top + 6) pFlash.push([x, top + rnd() * (bot - top)]); }
    let suitesP = '';
    for (let x = 250; x < 650; x += 12) suitesP += `<rect x="${x}" y="${f1(rimP(x) + 46)}" width="7" height="5" rx="1" fill="var(--scn-window)" opacity="${f1(0.35 + rnd() * 0.55)}"/>`;
    const towersP = [[120, -150, 230, 108, -42, 5], [780, -160, 230, 108, -52, -5]];
    const beamsP = [beam(120, -150, 230, 108, [300, 1180], [520, 1260]), beam(780, -160, 230, 108, [400, 1260], [610, 1180])];
    const PORT = `<svg class="scn-port" viewBox="0 0 ${PW} ${PH}" preserveAspectRatio="xMidYMin slice">${defs('P')}
      <ellipse cx="450" cy="${PF + 60}" rx="700" ry="320" fill="url(#Pfieldglow)"/>
      ${towersP.map(t => tower('P', ...t)).join('')}
      ${jumbotron('P', 330, 560, 240, 140, 760)}
      <path d="${bowlP}" fill="url(#Pcrowd)"/><path d="${bowlP}" fill="url(#Pshade)"/><path d="${bowlP}" fill="url(#Plit)"/>
      <path d="${aislesP}" stroke="var(--scn-aisle)" stroke-width="6" fill="none"/>
      <path d="${fasciaP}" stroke="var(--scn-fascia)" stroke-width="8" fill="none"/><path d="${fasciaP}" stroke="var(--scn-rim)" stroke-width="1" fill="none" transform="translate(0 -4)"/>
      <path d="${rimPP}" stroke="var(--scn-rim)" stroke-width="1.6" fill="none"/>
      ${suitesP}<g fill="var(--scn-flash)">${flashes(pFlash)}</g>
      ${fieldP}
      <path d="M236 ${PF - 6}L664 ${PF - 6}L664 ${PF - 30}L236 ${PF - 30}Z" fill="var(--scn-wall)"/><path d="M236 ${PF - 30}H664" stroke="var(--scn-wallcap)" stroke-width="3"/>
      ${[0, 1, 2, 3, 4].map(i => `<rect x="${246 + i * 84}" y="${PF - 25}" width="74" height="12" rx="2" fill="url(#Pled)" opacity="${i % 2 ? .45 : .95}"/>`).join('')}
      <path d="M236 ${PF - 6}L-220 ${PH + 60}L-220 ${PH}L236 ${PF - 30}Z" fill="var(--scn-wall)"/><path d="M664 ${PF - 6}L1120 ${PH + 60}L1120 ${PH}L664 ${PF - 30}Z" fill="var(--scn-wall)"/>
      <path d="M236 ${PF - 30}L-220 ${PH}M664 ${PF - 30}L1120 ${PH}" stroke="var(--scn-wallcap)" stroke-width="3"/>
      ${goal('P', 450, PF - 2, 92, 0, 80, 300, 10, false)}
      <path d="${beamsP.join('')}" fill="url(#Pbeam)" filter="url(#Psoft)"/></svg>`;

    const css = `
      ${DARK} { --bg: #040b0c; --surface0: #081416; --surface1: #0c1b1e; --surface2: #122729; --border: #1b3638; --border2: #285055;
        --glow: rgba(51,208,124,0.10); --scn-sil: #03060c; --scn-stand: #070b13; --scn-seatline: #030509; --scn-fascia: #0f1828; --scn-aisle: #0b111c;
        --scn-c1: #8c94a3; --scn-c2: #8e3f3f; --scn-c3: #34558f; --scn-c4: #a8862f; --scn-c5: #3d7d58; --scn-c6: #535a68; --scn-rim: rgba(170,215,235,0.26);
        --scn-mast-hi: #2c4c55; --scn-lamp: #ffffff; --scn-light: #e8f3ff; --scn-flare: #9fd0ff; --scn-flash: #ffffff;
        --scn-fieldglow: #49de92; --scn-turf-far: #1f7a45; --scn-turf-near: #0b3a21; --scn-stripe: rgba(255,255,255,0.045); --scn-line: rgba(245,255,248,0.55);
        --scn-ez-paint: #0b4a2b; --scn-ez-text: #fbf8ee; --scn-ez-edge: #33d07c; --scn-standlit: #ffe6bf;
        --scn-apron: #0a3420; --scn-wall: #0c1628; --scn-wallcap: #2a3f63; --scn-led-hi: #c9ffe0; --scn-post: #e2bd3c; --scn-post-hi: #ffe896; --scn-post-lo: #8a6c16; --scn-pad: #0b1e3a; --scn-flag: #ff7a1a;
        --scn-led: #33d07c; --scn-led-text: #04140c; --scn-window: #ffd98a; --scn-screen: #021309; --scn-screen-hi: #07301b; --scn-ribbon: #ffc94d; --scn-ribbon-bg: #0b0802; }
      ${LIGHT} { --border: #cfe0dc; --border2: #b4ccc6; --scn-sil: #4f6d67; --scn-stand: #6f8e88; --scn-seatline: #5c7a74; --scn-fascia: #8aa6a0; --scn-aisle: #87a39d;
        --scn-c1: #f2f4f7; --scn-c2: #d77a7a; --scn-c3: #7b9ad3; --scn-c4: #e2c46e; --scn-c5: #7fbf96; --scn-c6: #a3abb8; --scn-rim: rgba(255,255,255,0.6);
        --scn-mast-hi: #9fb9b3; --scn-lamp: #ffffff; --scn-light: #ffffff; --scn-flare: #ffffff; --scn-flash: #ffffff;
        --scn-fieldglow: #8fe0b2; --scn-turf-far: #6fbf8c; --scn-turf-near: #4f9d6c; --scn-stripe: rgba(255,255,255,0.08); --scn-line: rgba(255,255,255,0.85);
        --scn-ez-paint: #2f7a4f; --scn-ez-text: #ffffff; --scn-ez-edge: #10a758; --scn-standlit: #ffffff;
        --scn-apron: #4f9d6c; --scn-wall: #3c5a7d; --scn-wallcap: #9fb6d3; --scn-led-hi: #ffffff; --scn-post: #d4ad2a; --scn-post-hi: #f5dd7c; --scn-post-lo: #9a7a1c; --scn-pad: #2b4466; --scn-flag: #e8650c;
        --scn-led: #10a758; --scn-led-text: #ffffff; --scn-window: #fff3cf; --scn-screen: #13321f; --scn-screen-hi: #1f4a30; --scn-ribbon: #ffd56a; --scn-ribbon-bg: #1c1a12; }
      /* the sky is the root's: a solid colour under it so overscroll (rubber-banding past the top or bottom) isn't white,
         and the body clear, since the art layer sits under the body's background */
      ${DARK} { background: radial-gradient(1500px 520px at 50% 64%, rgba(255,232,196,0.13), transparent 62%), radial-gradient(1400px 700px at 50% 100%, rgba(73,222,146,0.12), transparent 64%),
          linear-gradient(#0b1a33 0%, #071226 42%, #050a14 100%) fixed #050a14; }
      ${LIGHT} { background: linear-gradient(#e2f0eb, #eef1f6) fixed #eef1f6; }
      ${S} body { background: transparent; }
      ${S} body::before { display: none; }
      ${DARK} .scn { background-image: radial-gradient(1px 1px at 22% 7%, #fff 50%, transparent 51%), radial-gradient(1.2px 1.2px at 39% 3%, #fff 50%, transparent 51%),
          radial-gradient(1px 1px at 56% 11%, #fff 50%, transparent 51%), radial-gradient(1px 1px at 68% 5%, #fff 50%, transparent 51%), radial-gradient(1.2px 1.2px at 47% 17%, #fff 50%, transparent 51%),
          radial-gradient(1px 1px at 80% 22%, #fff 50%, transparent 51%), radial-gradient(1px 1px at 12% 26%, #fff 50%, transparent 51%); }
      ${S} .scn-tw { animation: scn-tw 4s ease-in-out infinite; }
      @keyframes scn-tw { 0%, 100% { opacity: .08; } 10% { opacity: 1; } 24% { opacity: .2; } }
      ${S} .scn-sway { animation: scn-sway 2.6s ease-in-out infinite alternate; }
      @keyframes scn-sway { from { transform: rotate(-7deg) scaleX(.9); } to { transform: rotate(6deg) scaleX(1.05); } }
      ${S} .scn-drift { animation: scn-drift 16s ease-in-out infinite alternate; }
      @keyframes scn-drift { to { transform: translate(18px, -6px); } }
      ${S} .scn-pulse { animation: scn-pulse 3.2s ease-in-out infinite; }
      @keyframes scn-pulse { 0%, 100% { opacity: 1; } 50% { opacity: .6; } }
      @media (prefers-reduced-motion: reduce) { ${S} .scn-tw, ${S} .scn-sway, ${S} .scn-drift, ${S} .scn-pulse { animation: none; } }
      ${FULL_CSS(S, LIGHT)}`;
    mount(css, LAND + PORT);
  }
})();
