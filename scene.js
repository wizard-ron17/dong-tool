// Night scenes: each sport's own sky behind the page, the look Halloween had all year round (a lit sky instead of flat
// black, the cards tinted to it, brighter borders, art in the empty margins), in the sport's own hue. The accent and the
// good/bad ramp stay the app's; only the sky, the surfaces and the borders change.
// PREVIEW ONLY for now: ?bg=night turns it on for this tab (it stays on as you move around), ?bg=off turns it off.
// A holiday stands aside while a scene is previewed, unless asked for by name (?holiday=halloween). chrome.js loads this file.
//
//   nfl   close up on the field from straight above: real turf under white paint, the yard lines across the screen, a
//         big number in each side margin, night-lit. (The stadium panorama before it is in git history, 11/02.)
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
    const PORT = `<svg class="scn-port" data-w="420" viewBox="0 0 420 900" preserveAspectRatio="xMidYMin slice">${field(420, 34, 70, 6, 25, 190)}</svg>`;
    const css = `
      ${DARK} { --bg: #040d08; --surface0: #07130d; --surface1: #0a1a12; --surface2: #10261a; --border: #1a3526; --border2: #264d37;
        --glow: rgba(51,208,124,0.08); --scn-paint: rgba(250,252,248,0.72); --scn-oob: rgba(0,0,0,0.22); --scn-night: rgba(2,14,7,0.6); --scn-vig: .7; }
      ${LIGHT} { --border: #cfe0d6; --border2: #b4ccbe; --scn-paint: rgba(255,255,255,0.86); --scn-oob: rgba(0,0,0,0.1); --scn-night: rgba(255,255,255,0.1); --scn-vig: .2; }
      /* the turf under everything, so overscroll past the page ends is grass, not white */
      ${DARK} { background: #0b2412; } ${LIGHT} { background: #5f9a3c; }
      ${S} body { background: transparent; } ${S} body::before { display: none; }
      ${S} .scn { background: url(/scene/turf.jpg) 0 0 / 420px repeat; }
      /* night: the grass dimmed under the lights (paint on top, so it stays white), a pool of light on the content, dark at the edges */
      ${S} .scn::before { content: ''; position: absolute; inset: 0; background: var(--scn-night); }
      ${S} .scn::after { content: ''; position: absolute; inset: 0; background: radial-gradient(70% 60% at 50% 40%, rgba(220,255,230,.06), transparent 70%), radial-gradient(115% 95% at 50% 45%, transparent 50%, rgba(0,0,0,var(--scn-vig)) 100%); }
      ${LIGHT} .scn svg { opacity: 1; }
      ${FULL_CSS(S, LIGHT)}`;
    mount(css, LAND + PORT);
    const fit = () => document.querySelectorAll('.scn svg[data-w]').forEach(svg => { const w = +svg.dataset.w; svg.setAttribute('viewBox', `0 0 ${w} ${f1(w * innerHeight / innerWidth)}`); });
    fit(); addEventListener('resize', fit);
  }
})();
