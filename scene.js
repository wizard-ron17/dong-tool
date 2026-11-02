// Night scenes: each sport's own sky behind the page, the look Halloween had all year round (a lit sky instead of flat
// black, the cards tinted to it, brighter borders, art in the empty margins), in the sport's own hue. The accent and the
// good/bad ramp stay the app's; only the sky, the surfaces and the borders change.
// PREVIEW ONLY for now: ?bg=night turns it on for this tab (it stays on as you move around), ?bg=off turns it off.
// A holiday stands aside while a scene is previewed, unless asked for by name (?holiday=halloween). chrome.js loads this file.
//
//   nfl   the playing surface from straight above: night-lit turf with mowing stripes, white yard lines, hashes and
//         numbers (in the side margins), an end zone painted TUD TOOL across the top. (The stadium panorama it replaced
//         is in git history, 11/02.)
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
    const f1 = (n) => +n.toFixed(1);
    // The field from straight above, running down the screen: the sidelines and the numbers fall in the side margins, the
    // yard lines cross the whole width, the end zone (painted TUD TOOL) across the top. Not to scale where it matters to
    // the page (the numbers sit closer to the sidelines than the NFL's 12 yards, so the margins carry them).
    const field = (W, Y, num, side, id) => {
      const GL = Y * 7.4, END = GL - Y * 10, H = GL + Y * 130, S = side, NX = S + num * 1.05;
      let out = `<defs>
        <pattern id="${id}grain" width="7" height="9" patternUnits="userSpaceOnUse"><path d="M1 1v3M4.5 5v3M6 0.5v2M2.5 6v2.4" stroke="var(--scn-blade)" stroke-width=".8" stroke-linecap="round"/></pattern>
        <radialGradient id="${id}light" cx="50%" cy="38%" r="75%"><stop offset="0" stop-color="var(--scn-pool)" stop-opacity=".2"/><stop offset=".6" stop-color="var(--scn-pool)" stop-opacity="0"/></radialGradient>
        <radialGradient id="${id}vig" cx="50%" cy="45%" r="78%"><stop offset=".55" stop-color="#000" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity="var(--scn-vig)"/></radialGradient></defs>
        <rect x="0" y="${END - 400}" width="${W}" height="${H - END + 800}" fill="var(--scn-turf)"/>`;
      // mowing stripes, five yards each
      for (let y = GL, k = 0; y < H; y += Y * 5, k++) if (k % 2) out += `<rect x="0" y="${y}" width="${W}" height="${Y * 5}" fill="var(--scn-stripe)"/>`;
      out += `<rect x="0" y="${END - 400}" width="${W}" height="${H - END + 800}" fill="url(#${id}grain)"/>`;
      // out of bounds beyond the sidelines, a shade darker
      out += `<rect x="0" y="${END - 400}" width="${S}" height="${H - END + 800}" fill="var(--scn-oob)"/><rect x="${W - S}" y="${END - 400}" width="${S}" height="${H - END + 800}" fill="var(--scn-oob)"/>`;
      // the end zone: painted, TUD TOOL across it reading from the field
      out += `<rect x="${S}" y="${END}" width="${W - 2 * S}" height="${GL - END}" fill="var(--scn-ez-paint)"/>
        <text x="${W / 2}" y="${f1(END + (GL - END) * 0.56)}" text-anchor="middle" dominant-baseline="central" textLength="${f1((W - 2 * S) * 0.62)}" lengthAdjust="spacingAndGlyphs"
          font-family="'Chakra Petch', sans-serif" font-weight="700" font-size="${f1(Y * 6)}" letter-spacing="${f1(Y * 0.4)}" fill="var(--scn-ez-text)" stroke="var(--scn-ez-edge)" stroke-width="${f1(Y * 0.32)}" paint-order="stroke" stroke-linejoin="round">TUD TOOL</text>`;
      const L = 'var(--scn-line)', lw = Math.max(2, Y * 0.13);
      // the sidelines (six feet of white), the end line, the goal line (twice as wide as a yard line)
      out += `<rect x="${S - Y * 2}" y="${END - Y * 2}" width="${Y * 2}" height="${H}" fill="${L}"/><rect x="${W - S}" y="${END - Y * 2}" width="${Y * 2}" height="${H}" fill="${L}"/>
        <rect x="${S}" y="${END - Y * 2}" width="${W - 2 * S}" height="${Y * 2}" fill="${L}"/>
        <rect x="${S}" y="${f1(GL - lw)}" width="${W - 2 * S}" height="${f1(lw * 2)}" fill="${L}"/>
        <rect x="${f1(W / 2 - Y * 0.5)}" y="${GL + Y * 2}" width="${Y}" height="${f1(lw)}" fill="${L}"/>`;
      const hash = [W * 0.455, W * 0.545];
      for (let yd = 1; yd < 130; yd++) {
        const y = f1(GL + yd * Y);
        if (yd % 5 === 0) { out += `<rect x="${S}" y="${f1(y - lw / 2)}" width="${W - 2 * S}" height="${f1(lw)}" fill="${L}"/>`; continue; }
        // a tick every yard along both sidelines and at both hash marks
        out += `<path d="M${S + Y * 0.6} ${y}h${f1(Y * 0.7)}M${W - S - Y * 1.3} ${y}h${f1(Y * 0.7)}M${f1(hash[0] - Y * 0.35)} ${y}h${f1(Y * 0.7)}M${f1(hash[1] - Y * 0.35)} ${y}h${f1(Y * 0.7)}" stroke="${L}" stroke-width="${f1(lw)}"/>`;
      }
      // the numbers, every ten, on both sides, their tops toward the nearer sideline, the line between the digits, an arrow to the nearer goal
      const digit = (t, x, anchor) => `<text x="${f1(x)}" y="0" text-anchor="${anchor}" dominant-baseline="central" font-family="'Chakra Petch', sans-serif" font-weight="700" font-size="${f1(num)}" fill="var(--scn-num)">${t}</text>`;
      for (let yd = 10; yd < 130; yd += 10) {
        const n = 50 - Math.abs(50 - (yd % 100 || 100)), lbl = String(n), y = GL + yd * Y, g = num * 0.12, a = num * 0.17;
        if (n <= 0) continue;
        const pair = digit(lbl[0], -g, 'end') + digit(lbl[1] ?? '0', g, 'start');
        const arrow = (dir) => n === 50 ? '' : `<path d="M${f1(dir * (g + num * 0.72))} ${f1(-a)}l${f1(dir * a * 1.6)} ${f1(a)}l${f1(-dir * a * 1.6)} ${f1(a)}z" fill="var(--scn-num)"/>`;
        out += `<g transform="translate(${f1(NX)} ${f1(y)}) rotate(-90)">${pair}${arrow(1)}</g>`;
        out += `<g transform="translate(${f1(W - NX)} ${f1(y)}) rotate(90)">${pair}${arrow(-1)}</g>`;
      }
      // the light: a soft pool where the content sits, darker toward the edges
      return out + `<rect x="0" y="${END - 400}" width="${W}" height="${H - END + 800}" fill="url(#${id}light)"/>`;
    };
    // the vignette is the screen's, not the field's: a fixed overlay
    const LAND = `<svg class="scn-land" data-w="1600" viewBox="0 0 1600 1000" preserveAspectRatio="xMidYMin slice">${field(1600, 32, 132, 22, 'L')}</svg>`;
    const PORT = `<svg class="scn-port" data-w="420" viewBox="0 0 420 900" preserveAspectRatio="xMidYMin slice">${field(420, 13, 50, 6, 'P')}</svg>`;
    const css = `
      ${DARK} { --bg: #040d08; --surface0: #07130d; --surface1: #0a1a12; --surface2: #10261a; --border: #1a3526; --border2: #264d37;
        --glow: rgba(51,208,124,0.08); --scn-turf: #0d3a22; --scn-stripe: rgba(255,255,255,0.03); --scn-blade: rgba(0,0,0,0.16); --scn-oob: rgba(0,0,0,0.22);
        --scn-line: rgba(245,250,246,0.5); --scn-num: rgba(245,250,246,0.48); --scn-ez-paint: #0a2c1a; --scn-ez-text: rgba(251,248,238,0.16); --scn-ez-edge: rgba(51,208,124,0.22);
        --scn-pool: #c8ffe0; --scn-vig: .78; }
      ${LIGHT} { --border: #cfe0d6; --border2: #b4ccbe; --scn-turf: #4e9a63; --scn-stripe: rgba(255,255,255,0.06); --scn-blade: rgba(0,0,0,0.07); --scn-oob: rgba(0,0,0,0.08);
        --scn-line: rgba(255,255,255,0.9); --scn-num: rgba(255,255,255,0.88); --scn-ez-paint: #2f7a4b; --scn-ez-text: rgba(255,255,255,0.35); --scn-ez-edge: rgba(29,92,55,0.4);
        --scn-pool: #ffffff; --scn-vig: .18; }
      /* the turf's colour under everything, so overscroll past the page ends isn't white */
      ${DARK} { background: #071a10; } ${LIGHT} { background: #4e9a63; }
      ${S} body { background: transparent; } ${S} body::before { display: none; }
      ${S} .scn::after { content: ''; position: absolute; inset: 0; background: radial-gradient(110% 90% at 50% 45%, transparent 45%, rgba(0,0,0,var(--scn-vig)) 100%); }
      ${LIGHT} .scn svg { opacity: 1; }
      ${FULL_CSS(S, LIGHT)}`;
    mount(css, LAND + PORT);
    // the field is laid out in yards across the width: keep the viewBox to the screen's shape so the sidelines stay at the edges
    const fit = () => document.querySelectorAll('.scn svg[data-w]').forEach(svg => { const w = +svg.dataset.w; svg.setAttribute('viewBox', `0 0 ${w} ${f1(w * innerHeight / innerWidth)}`); });
    fit(); addEventListener('resize', fit);
  }
})();
