// Night scenes: each sport's own sky behind the page, the look Halloween had all year round (a lit sky instead of flat
// black, the cards tinted to it, brighter borders, art in the empty margins), in the sport's own hue. The accent and the
// good/bad ramp stay the app's; only the sky, the surfaces and the borders change.
// PREVIEW ONLY for now: ?bg=night turns it on for this tab (it stays on as you move around), ?bg=off turns it off.
// A holiday stands aside while a scene is previewed, unless asked for by name (?holiday=halloween). chrome.js loads this file.
//
//   contour / curves / grid   the techy ones, any sport, drawn on a canvas in the app's own accent (follows the theme):
//         contour  topographic lines off a slowly shifting surface, a likelihood landscape drifting
//         curves   ghosted distributions along the bottom re-fitting themselves, a histogram behind, a line marker
//         grid     a quiet dot grid (a blank scatter plot): dots near the cursor brighten and lean in, data points pulse in
//   nfl   close up on the field from straight above: real turf under white paint, the yard lines across the screen, a
//         big number in each side margin, night-lit. (The stadium panorama before it is in git history, 11/02.)
(function () {
  if (window.RonScene) return;
  const q = new URLSearchParams(location.search).get('bg'), MODES = /^(night|contour|curves|grid)$/;
  try { if (MODES.test(q || '')) sessionStorage.setItem('ronScene', q); else if (q === 'off') sessionStorage.removeItem('ronScene'); } catch (e) {}
  let mode = MODES.test(q || '') ? q : null;
  try { mode = mode || sessionStorage.getItem('ronScene'); } catch (e) {}
  const sport = location.pathname.split('/').filter(Boolean)[0] || '';
  const SCENES = { nfl: nfl };
  window.RonScene = { on: null };
  const TECH = { contour: 1, curves: 1, grid: 1 };
  if (!mode || !(TECH[mode] ? ['mlb', 'nfl', 'nhl', 'nba', 'soccer', 'plays'].includes(sport) : SCENES[sport])) return;
  // a holiday asked for by name (?holiday=halloween) wins; otherwise holiday.js stands aside while a scene is previewed
  const go = () => {
    if (new URLSearchParams(location.search).get('holiday') && new URLSearchParams(location.search).get('holiday') !== 'off') return;
    window.RonScene.on = TECH[mode] ? mode : sport;
    document.documentElement.setAttribute('data-scene', TECH[mode] ? 'tech' : sport);
    if (TECH[mode]) tech(mode); else SCENES[sport]();
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
    // Close up on the field from straight above: real turf (scene/turf.jpg, ambientCG Grass005, CC0) under white paint that
    // lets the grass through. Midfield-ish, about 14 yards top to bottom on a laptop: the yard lines cross the screen, a
    // number in each side margin (tops toward the sideline, the line between the digits, an arrow to the nearer goal).
    // The field is drawn in yards across the screen's width; fit() keeps the viewBox to the screen's shape.
    const field = (W, Y, num, side, from, y0) => {     // from: a 5-yard line, drawn at y0 (placed clear of the header)
      const S = side, NX = S + Y * 1.2 + num * 0.5, H = Y * 60, lw = f1(Y * 0.12), L = 'var(--scn-paint)';
      let out = `<rect x="0" y="0" width="${S}" height="${H}" fill="var(--scn-oob)"/><rect x="${W - S}" y="0" width="${S}" height="${H}" fill="var(--scn-oob)"/>
        <rect x="${f1(S - Y * 0.65)}" y="0" width="${f1(Y * 0.65)}" height="${H}" fill="${L}"/><rect x="${W - S}" y="0" width="${f1(Y * 0.65)}" height="${H}" fill="${L}"/>`;
      const hash = [W * 0.44, W * 0.56];
      const digit = (t, x, anchor) => `<text x="${f1(x)}" y="0" text-anchor="${anchor}" dominant-baseline="central" font-family="'Chakra Petch', sans-serif" font-weight="700" font-size="${f1(num)}" fill="${L}">${t}</text>`;
      for (let i = -12; i <= 60; i++) {
        const yd = from + i, y = f1(y0 + i * Y);
        if (yd % 5 === 0) out += `<rect x="${S}" y="${f1(y - lw / 2)}" width="${W - 2 * S}" height="${lw}" fill="${L}"/>`;
        else out += `<path d="M${f1(S + Y * 0.3)} ${y}h${f1(Y * 0.67)}M${f1(W - S - Y * 0.97)} ${y}h${f1(Y * 0.67)}M${f1(hash[0] - Y * 0.33)} ${y}h${f1(Y * 0.67)}M${f1(hash[1] - Y * 0.33)} ${y}h${f1(Y * 0.67)}" stroke="${L}" stroke-width="${lw}"/>`;
        if (yd % 10 === 0) {
          const n = 50 - Math.abs(50 - yd), lbl = String(n), g = num * 0.1, a = num * 0.16, toward = yd < 50 ? -1 : 1;   // the nearer goal: up the screen when yd < 50
          const pair = digit(lbl[0], -g, 'end') + digit(lbl[1] ?? '0', g, 'start');
          const arrow = (dir) => n === 50 ? '' : `<path d="M${f1(dir * (g + num * 0.68))} ${f1(-a)}l${f1(dir * a * 1.6)} ${f1(a)}l${f1(-dir * a * 1.6)} ${f1(a)}z" fill="${L}"/>`;
          // left numbers read bottom to top (rotate -90: local +x is up), right ones top to bottom (local +x is down)
          out += `<g transform="translate(${f1(NX)} ${y}) rotate(-90)">${pair}${arrow(-toward)}</g><g transform="translate(${f1(W - NX)} ${y}) rotate(90)">${pair}${arrow(toward)}</g>`;
        }
      }
      return out;
    };
    const LAND = `<svg class="scn-land" data-w="1600" viewBox="0 0 1600 1000" preserveAspectRatio="xMidYMin slice">${field(1600, 70, 150, 24, 30, 280)}</svg>`;
    const PORT = `<svg class="scn-port" data-w="420" viewBox="0 0 420 900" preserveAspectRatio="xMidYMin slice">${field(420, 34, 70, 6, 30, 260)}</svg>`;
    const css = `
      ${DARK} { --bg: #040d08; --surface0: #07130d; --surface1: #0a1a12; --surface2: #10261a; --border: #1a3526; --border2: #264d37;
        --glow: rgba(51,208,124,0.08); --scn-paint: rgba(235,245,238,0.3); --scn-oob: rgba(0,0,0,0.25); --scn-night: rgba(2,10,5,0.84); --scn-vig: .75; --scn-top: rgba(2,8,4,0.85); }
      ${LIGHT} { --border: #cfe0d6; --border2: #b4ccbe; --scn-paint: rgba(255,255,255,0.86); --scn-oob: rgba(0,0,0,0.1); --scn-night: rgba(20,70,25,0.08); --scn-vig: .16; --scn-top: rgba(238,244,240,0.92); }
      /* the turf under everything, so overscroll past the page ends is grass, not white */
      ${DARK} { background: #0b2412; } ${LIGHT} { background: #5f9a3c; }
      ${S} body { background: transparent; } ${S} body::before { display: none; }
      ${S} .scn { background: url(/scene/turf.jpg) 0 0 / 420px repeat; }
      /* dark mode is a dark field: the grass nearly black, the paint dim, a quiet band under the header; light mode is the day game.
         night: the grass dimmed under the lights (paint on top, so it stays white), a pool of light on the content, dark at the edges */
      ${S} .scn::before { content: ''; position: absolute; inset: 0; background: var(--scn-night); }
      ${S} .scn::after { content: ''; position: absolute; inset: 0; background: linear-gradient(var(--scn-top), transparent 190px), radial-gradient(70% 60% at 50% 40%, rgba(220,255,230,.04), transparent 70%), radial-gradient(115% 95% at 50% 45%, transparent 50%, rgba(0,0,0,var(--scn-vig)) 100%); }
      ${LIGHT} .scn svg { opacity: 1; }
      ${FULL_CSS(S, LIGHT)}`;
    mount(css, LAND + PORT);
    const fit = () => document.querySelectorAll('.scn svg[data-w]').forEach(svg => { const w = +svg.dataset.w; svg.setAttribute('viewBox', `0 0 ${w} ${f1(w * innerHeight / innerWidth)}`); });
    fit(); addEventListener('resize', fit);
  }

  // ── the techy backgrounds: one canvas under everything, ~20 frames a second, still when the tab is hidden or motion is off ──
  function tech(kind) {
    const S = 'html[data-scene="tech"]';
    const style = document.createElement('style'); style.id = 'scene-css';
    style.textContent = `${S} { background: var(--bg); } ${S} body { background: transparent; } ${S} body::before { display: none; }
      ${S} .scn-cv { position: fixed; inset: 0; width: 100%; height: 100%; z-index: -1; pointer-events: none; display: block; }
      ${S} .site-foot { background: color-mix(in srgb, var(--bg) 78%, transparent); -webkit-backdrop-filter: blur(10px); backdrop-filter: blur(10px);
        border: 1px solid var(--border); border-radius: 14px; padding: 0.8rem 1rem; }`;
    document.head.appendChild(style);
    const cv = document.createElement('canvas'); cv.className = 'scn-cv'; cv.setAttribute('aria-hidden', 'true'); document.body.prepend(cv);
    const cx = cv.getContext('2d'), calm = matchMedia('(prefers-reduced-motion: reduce)').matches;
    let W = 0, H = 0, R = 1;
    const size = () => { R = Math.min(devicePixelRatio || 1, 1.5); W = innerWidth; H = innerHeight; cv.width = W * R; cv.height = H * R; cx.setTransform(R, 0, 0, R, 0, 0); };
    size(); addEventListener('resize', () => { size(); if (calm) frame(0); });
    // the app's colours, read again when the theme flips
    let C = {};
    const colours = () => { const st = getComputedStyle(document.documentElement); C = { acc: st.getPropertyValue('--accent').trim() || '#33d07c', text: st.getPropertyValue('--text').trim() || '#eaf2fc', light: document.documentElement.dataset.theme === 'light' }; };
    colours(); new MutationObserver(colours).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    const rgba = (hex, a) => { const h = hex.replace('#', ''), n = parseInt(h.length === 3 ? h.replace(/./g, '$&$&') : h, 16); return `rgba(${n >> 16 & 255},${n >> 8 & 255},${n & 255},${a})`; };
    // 3D gradient noise (Perlin's improved noise): a smooth surface that changes with time
    const P = new Uint8Array(512); { const p = [...Array(256).keys()]; let sd = 9; for (let i = 255; i > 0; i--) { sd = (sd * 16807) % 2147483647; const j = sd % (i + 1); [p[i], p[j]] = [p[j], p[i]]; } for (let i = 0; i < 512; i++) P[i] = p[i & 255]; }
    const fade = (t) => t * t * t * (t * (t * 6 - 15) + 10), lerp = (a, b, t) => a + (b - a) * t;
    const grad = (h, x, y, z) => { const u = (h & 15) < 8 ? x : y, v = (h & 15) < 4 ? y : (h & 15) === 12 || (h & 15) === 14 ? x : z; return ((h & 1) ? -u : u) + ((h & 2) ? -v : v); };
    const noise = (x, y, z) => {
      const X = Math.floor(x) & 255, Y = Math.floor(y) & 255, Z = Math.floor(z) & 255; x -= Math.floor(x); y -= Math.floor(y); z -= Math.floor(z);
      const u = fade(x), v = fade(y), w = fade(z), A = P[X] + Y, AA = P[A] + Z, AB = P[A + 1] + Z, B = P[X + 1] + Y, BA = P[B] + Z, BB = P[B + 1] + Z;
      return lerp(lerp(lerp(grad(P[AA], x, y, z), grad(P[BA], x - 1, y, z), u), lerp(grad(P[AB], x, y - 1, z), grad(P[BB], x - 1, y - 1, z), u), v),
        lerp(lerp(grad(P[AA + 1], x, y, z - 1), grad(P[BA + 1], x - 1, y, z - 1), u), lerp(grad(P[AB + 1], x, y - 1, z - 1), grad(P[BB + 1], x - 1, y - 1, z - 1), u), v), w);
    };

    // contour: iso-lines of the surface (marching squares on a coarse grid), one level in four a touch brighter
    const contour = (t) => {
      const cell = W < 700 ? 16 : 18, nx = Math.ceil(W / cell) + 1, ny = Math.ceil(H / cell) + 1, f = new Float32Array(nx * ny), sc = W < 700 ? 0.006 : 0.0034;
      for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) f[j * nx + i] = noise(i * cell * sc, j * cell * sc, t * 0.045) + 0.5 * noise(i * cell * sc * 2.1, j * cell * sc * 2.1, 10 + t * 0.06);
      const levels = 14;
      for (let k = 0; k < levels; k++) {
        const lv = -0.8 + k * 1.6 / levels;
        cx.beginPath();
        for (let j = 0; j < ny - 1; j++) for (let i = 0; i < nx - 1; i++) {
          const a = f[j * nx + i], b = f[j * nx + i + 1], c = f[(j + 1) * nx + i + 1], d = f[(j + 1) * nx + i];
          const idx = (a > lv) | (b > lv) << 1 | (c > lv) << 2 | (d > lv) << 3; if (idx === 0 || idx === 15) continue;
          const x = i * cell, y = j * cell, e = (p, q) => (lv - p) / (q - p);
          const T = [x + cell * e(a, b), y], Rt = [x + cell, y + cell * e(b, c)], B = [x + cell * e(d, c), y + cell], L = [x, y + cell * e(a, d)];
          const seg = { 1: [L, T], 2: [T, Rt], 3: [L, Rt], 4: [Rt, B], 5: [L, T, Rt, B], 6: [T, B], 7: [L, B], 8: [L, B], 9: [T, B], 10: [L, Rt, T, B], 11: [Rt, B], 12: [L, Rt], 13: [T, Rt], 14: [L, T] }[idx];
          for (let s2 = 0; s2 < seg.length; s2 += 2) { cx.moveTo(seg[s2][0], seg[s2][1]); cx.lineTo(seg[s2 + 1][0], seg[s2 + 1][1]); }
        }
        const major = k % 4 === 0;
        cx.strokeStyle = rgba(major ? C.acc : C.text, C.light ? (major ? 0.22 : 0.09) : (major ? 0.2 : 0.07)); cx.lineWidth = major ? 1.2 : 0.8; cx.stroke();
      }
    };

    // curves: distributions along the bottom re-fitting themselves (means and spreads drift), a Poisson histogram behind,
    // a dashed line marker sliding between them, a baseline with ticks
    const curves = (t) => {
      const base = H * 0.94, top = H * 0.5, amp = base - top;
      cx.lineWidth = 1; cx.strokeStyle = rgba(C.text, 0.1); cx.beginPath(); cx.moveTo(0, base); cx.lineTo(W, base); cx.stroke();
      for (let x = 0; x < W; x += 40) { cx.beginPath(); cx.moveTo(x, base); cx.lineTo(x, base + (x % 200 ? 4 : 8)); cx.stroke(); }
      // the histogram: Poisson bars, lambda wandering
      const lam = 6 + 2.2 * Math.sin(t * 0.11), bars = 22, bw = W / bars; let pk = Math.exp(-lam), mx = 0; const ps = [];
      for (let k = 0; k < bars; k++) { if (k) pk *= lam / k; ps.push(pk); mx = Math.max(mx, pk); }
      cx.fillStyle = rgba(C.text, C.light ? 0.05 : 0.04);
      ps.forEach((p, k) => { const h = p / mx * amp * 0.62; cx.fillRect(k * bw + 3, base - h, bw - 6, h); });
      const G = [[0.3, 0.07, 0.06, 0], [0.55, 0.12, 0.08, 2.1], [0.75, 0.06, 0.05, 4.2]];
      G.forEach(([m0, s0, dm, ph], g) => {
        const m = W * (m0 + dm * Math.sin(t * 0.07 + ph)), s = W * s0 * (1 + 0.25 * Math.sin(t * 0.09 + ph * 1.7)), hh = amp * (0.55 + 0.3 * Math.sin(t * 0.05 + ph));
        cx.beginPath(); cx.moveTo(0, base);
        for (let x = 0; x <= W; x += 6) cx.lineTo(x, base - hh * Math.exp(-((x - m) ** 2) / (2 * s * s)));
        cx.lineTo(W, base); cx.closePath();
        const gr = cx.createLinearGradient(0, base - hh, 0, base); gr.addColorStop(0, rgba(C.acc, g === 1 ? 0.12 : 0.06)); gr.addColorStop(1, rgba(C.acc, 0));
        cx.fillStyle = gr; cx.fill(); cx.strokeStyle = rgba(C.acc, g === 1 ? 0.32 : 0.16); cx.lineWidth = g === 1 ? 1.4 : 1; cx.stroke();
      });
      const lx = W * (0.5 + 0.18 * Math.sin(t * 0.05)); cx.setLineDash([4, 6]); cx.strokeStyle = rgba(C.text, 0.18); cx.beginPath(); cx.moveTo(lx, top - 20); cx.lineTo(lx, base); cx.stroke(); cx.setLineDash([]);
    };

    // grid: dots every 26px; near the cursor they brighten and lean in; now and then a point pulses in and fades
    let mxp = -999, myp = -999; addEventListener('pointermove', (e) => { mxp = e.clientX; myp = e.clientY; }, { passive: true });
    const pulses = [];
    const grid = (t) => {
      const g = 26, r0 = 1.1;
      if (!calm && Math.random() < 0.08) pulses.push({ x: Math.round(Math.random() * W / g) * g, y: Math.round(Math.random() * H / g) * g, t0: t });
      for (let y = g / 2; y < H; y += g) for (let x = g / 2; x < W; x += g) {
        const d = Math.hypot(x - mxp, y - myp), k = Math.max(0, 1 - d / 160), px = x + (mxp - x) * k * 0.12, py = y + (myp - y) * k * 0.12;
        cx.fillStyle = k > 0 ? rgba(C.acc, 0.14 + 0.5 * k) : rgba(C.text, C.light ? 0.16 : 0.11);
        cx.beginPath(); cx.arc(px, py, r0 + k * 1.2, 0, 6.283); cx.fill();
      }
      for (let i = pulses.length - 1; i >= 0; i--) {
        const p = pulses[i], a = (t - p.t0) / 2.4; if (a > 1) { pulses.splice(i, 1); continue; }
        cx.strokeStyle = rgba(C.acc, 0.45 * (1 - a)); cx.lineWidth = 1; cx.beginPath(); cx.arc(p.x + g / 2, p.y + g / 2, 3 + a * 18, 0, 6.283); cx.stroke();
        cx.fillStyle = rgba(C.acc, 0.7 * (1 - a)); cx.beginPath(); cx.arc(p.x + g / 2, p.y + g / 2, 2, 0, 6.283); cx.fill();
      }
    };

    const DRAW = { contour, curves, grid }[kind];
    function frame(ms) { cx.clearRect(0, 0, W, H); DRAW(ms / 1000); }
    if (calm) { frame(20000); return; }
    let last = 0;
    const loop = (ms) => { if (!document.hidden && ms - last > 48) { last = ms; frame(ms); } requestAnimationFrame(loop); };
    requestAnimationFrame(loop);
  }
})();
