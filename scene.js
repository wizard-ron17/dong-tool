// Night scenes: each sport's own sky behind the page, the look Halloween had all year round (a lit sky instead of flat
// black, the cards tinted to it, brighter borders, art in the empty margins), in the sport's own hue. The accent and the
// good/bad ramp stay the app's; only the sky, the surfaces and the borders change.
// PREVIEW ONLY for now: ?bg=night turns it on for this tab (it stays on as you move around), ?bg=off turns it off.
// A holiday stands aside while a scene is previewed, unless asked for by name (?holiday=halloween). chrome.js loads this file.
//
//   nba   the court from above on maple (scene/wood.jpg, ambientCG WoodFloor062, CC0): a navy apron and key, the half-court line and centre circle, the arc and the painted key; dark-stained floor in dark mode
//   nhl   the rink from above: rink ice (scene/ice.jpg, ambientCG Snow006, CC0) with skate marks drawn on, soft under-ice paint (the red line, a blue line, the end-zone circles
//         and hashes in the margins), the boards at both edges with the yellow kick plate; dark slate ice in dark mode
//   soccer  one end of the pitch from above on the same turf: mowing stripes, the goal line at the top with the goal behind it,
//         the six-yard box, the penalty box, spot and D, the corner arcs at the touchlines; phones reach the halfway line and centre circle
//   nfl   close up on the field from straight above: real turf under white paint, the yard lines across the screen, a
//         big number in each side margin, night-lit. (The stadium panorama before it is in git history, 11/02.)
(function () {
  if (window.RonScene) return;
  const q = new URLSearchParams(location.search).get('bg'), MODES = /^night$/;
  try { if (MODES.test(q || '')) sessionStorage.setItem('ronScene', q); else if (q === 'off') sessionStorage.removeItem('ronScene'); } catch (e) {}
  let mode = MODES.test(q || '') ? q : null;
  try { mode = mode || sessionStorage.getItem('ronScene'); } catch (e) {}
  const sport = location.pathname.split('/').filter(Boolean)[0] || '';
  const SCENES = { nfl: nfl, nhl: nhl, nba: nba, soccer: soccer };
  window.RonScene = { on: null };
  if (!mode || !SCENES[sport]) return;
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
    if (!document.querySelector('.scn')) document.body.insertAdjacentHTML('afterbegin', `<div class="scn" aria-hidden="true">${art}<div class="scn-col"></div></div>`);
  }
  // One drawing that fills the screen (sliced to cover it, so it never shows an edge): a landscape composition for desktops
  // and tablets, a portrait one for phones. The content column covers the middle, so the pieces that carry the scene sit
  // where the margins are; the continuous things (the bowl, the field, the sky's light) tie it together.
  // the surfaces are laid out across the screen's width: keep each viewBox to the screen's shape so the edges stay at the edges
  function fitW() {
    const fit = () => document.querySelectorAll('.scn svg[data-w]').forEach(svg => { const w = +svg.dataset.w; svg.setAttribute('viewBox', `0 0 ${w} ${+(w * innerHeight / innerWidth).toFixed(1)}`); });
    fit(); addEventListener('resize', fit);
  }
  function FULL_CSS(S, LIGHT) { return `
      /* under everything (z-index -1, above only the page background): no header, footer or panel can ever be covered */
      ${S} .scn { position: fixed; inset: 0; z-index: -1; pointer-events: none; overflow: hidden; }
      ${S} .scn svg { position: absolute; inset: 0; width: 100%; height: 100%; display: block; }
      ${S} .scn-port { display: none !important; }
      @media (max-width: 760px) { ${S} .scn-land { display: none !important; } ${S} .scn-port { display: block !important; } }
      ${LIGHT} .scn svg { opacity: .34; }
      /* a soft panel of the page's colour behind the content column: the surface shows full in the margins, faint behind
         what sits on the page (labels, pagers, section titles), so text always reads; phones are all column */
      ${S} .scn-col { position: absolute; inset: 0; background: linear-gradient(to right, transparent calc(50% - 650px), var(--scn-col) calc(50% - 596px), var(--scn-col) calc(50% + 596px), transparent calc(50% + 650px)); }
      ${S}:not([data-theme="light"]) { --scn-col: color-mix(in srgb, var(--bg) 66%, transparent); }
      ${S}[data-theme="light"] { --scn-col: color-mix(in srgb, var(--bg) 22%, transparent); }
      /* light mode: a soft light band under the header, so the nav reads over paint and logos */
      ${S}[data-theme="light"] .scn-col::before { content: ''; position: absolute; inset: 0 0 auto 0; height: 170px; background: linear-gradient(color-mix(in srgb, var(--bg) 82%, transparent) 55%, transparent); }
      @media (max-width: 760px) { ${S} .scn-col { background: color-mix(in srgb, var(--bg) 35%, transparent); } ${S}[data-theme="light"] .scn-col { background: color-mix(in srgb, var(--bg) 12%, transparent); } }
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
      ${DARK} { --scn-paint: rgba(235,245,238,0.3); --scn-oob: rgba(0,0,0,0.25); --scn-night: rgba(2,10,5,0.84); --scn-vig: .75; --scn-top: rgba(2,8,4,0.85); }
      ${LIGHT} { --scn-paint: rgba(255,255,255,0.86); --scn-oob: rgba(0,0,0,0.1); --scn-night: rgba(20,70,25,0.08); --scn-vig: .16; --scn-top: rgba(238,244,240,0.92); }
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
    mount(css, LAND + PORT); fitW();
  }


  function soccer() {
    const S = 'html[data-scene="soccer"]', DARK = `${S}:not([data-theme="light"])`, LIGHT = `${S}[data-theme="light"]`;
    const f1 = (n) => +n.toFixed(1);
    // The pitch from straight above, drawn in metres (105 by 68, FIFA markings) and laid onto the screen by a transform: on
    // phones one end with the goal at the top (the boxes down the middle, the halfway line and centre circle below); on
    // desktops turned sideways, a goal at each screen edge so both penalty boxes sit in the margins. Natural grass mown in
    // two directions, a checkerboard (5.5 m bands along the pitch, 6.8 m across), is what makes it a pitch and not a gridiron.
    //   u: across the pitch (−34 … 34), v: along it (0 at one goal line, 105 at the other)
    const pitch = (tf, px) => {        // px: screen pixels per metre, to keep the paint's width sensible
      const L = 'var(--scn-paint)', lw = +Math.max(0.13, 1.6 / px).toFixed(3), c = 52.5, r9 = 9.15;
      let o = '';
      for (let i = 0; i * 5.5 < 105; i++) if (i % 2 === 0) o += `<rect x="-34" y="${f1(i * 5.5)}" width="68" height="${f1(Math.min(5.5, 105 - i * 5.5))}" fill="var(--scn-stripe)"/>`;
      for (let j = 0; j < 10; j++) if (j % 2 === 0) o += `<rect x="${f1(-34 + j * 6.8)}" y="0" width="6.8" height="105" fill="var(--scn-cross)"/>`;
      // beyond the lines: a little darker
      o += `<path d="M-400 -400H400V505H-400ZM-34 0V105H34V0Z" fill="var(--scn-oob)" fill-rule="evenodd"/>`;
      // each end's markings, the far one mirrored
      const dy = 16.5 - 11, dx = Math.sqrt(r9 * r9 - dy * dy), g = 7.32 / 2, nd = 2;
      const end = `<path d="M-20.16 0V16.5H20.16V0M-9.16 0V5.5H9.16V0M${f1(-dx)} 16.5A${r9} ${r9} 0 0 0 ${f1(dx)} 16.5M-33 0A1 1 0 0 0 -34 1M33 0A1 1 0 0 1 34 1"/>`;
      const spot = `<circle cx="0" cy="11" r="0.22" fill="${L}" stroke="none"/>`;
      const goal = `<rect x="${-g}" y="${-nd}" width="7.32" height="${nd}" fill="url(#scn-net)" stroke="var(--scn-net)" stroke-width="${f1(lw * 0.6 * 100) / 100}"/><path d="M${-g} 0H${g}" stroke="var(--scn-post)" stroke-width="${f1(lw * 1.5 * 100) / 100}" stroke-linecap="round"/>`;
      o += `<g fill="none" stroke="${L}" stroke-width="${lw}">
        <rect x="-34" y="0" width="68" height="105"/><path d="M-34 ${c}H34"/><circle cx="0" cy="${c}" r="${r9}"/>
        ${end}${spot}<g transform="matrix(1 0 0 -1 0 105)">${end}${spot}</g></g>
        <circle cx="0" cy="${c}" r="0.27" fill="${L}"/>${goal}<g transform="matrix(1 0 0 -1 0 105)">${goal}</g>`;
      return `<defs><pattern id="scn-net" width=".32" height=".32" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><path d="M0 0H.32M0 0V.32" stroke="var(--scn-net)" stroke-width=".035" fill="none"/></pattern></defs><g transform="${tf}">${o}</g>`;
    };
    // desktop: 105 m across 1600 with a little room past each goal; the top touchline just under the header's line
    const m = 14.6, x0 = (1600 - 105 * m) / 2, yc = 70 + 34 * m;
    const LAND = `<svg class="scn-land" data-w="1600" viewBox="0 0 1600 1000" preserveAspectRatio="xMidYMin slice">${pitch(`matrix(0 ${m} ${m} 0 ${f1(x0)} ${f1(yc)})`, m)}</svg>`;
    const PORT = `<svg class="scn-port" data-w="420" viewBox="0 0 420 900" preserveAspectRatio="xMidYMin slice">${pitch('matrix(9.4 0 0 9.4 210 40)', 9.4)}</svg>`;
    const css = `
      ${DARK} { --scn-paint: rgba(235,245,238,0.34); --scn-stripe: rgba(255,255,255,0.05); --scn-cross: rgba(0,0,0,0.12); --scn-oob: rgba(0,0,0,0.3); --scn-net: rgba(235,245,238,0.2); --scn-post: rgba(245,248,246,0.6);
        --scn-night: rgba(3,16,9,0.74); --scn-vig: .75; --scn-top: rgba(2,8,5,0.85); }
      ${LIGHT} { --scn-paint: rgba(255,255,255,0.86); --scn-stripe: rgba(255,255,255,0.17); --scn-cross: rgba(0,40,0,0.09); --scn-oob: rgba(0,0,0,0.1); --scn-net: rgba(255,255,255,0.55); --scn-post: #fff;
        --scn-night: rgba(60,170,40,0.12); --scn-vig: .16; --scn-top: rgba(238,244,240,0.92); }
      /* the turf under everything, so overscroll past the page ends is grass, not white */
      ${DARK} { background: #0c2a14; } ${LIGHT} { background: #5aa83c; }
      ${S} body { background: transparent; } ${S} body::before { display: none; }
      /* natural grass: the same turf, richer and a touch brighter than the gridiron's */
      ${S} .scn { background: url(/scene/turf.jpg) 0 0 / 420px repeat; }
      ${S} .scn::before { content: ''; position: absolute; inset: 0; background: var(--scn-night); }
      ${S} .scn::after { content: ''; position: absolute; inset: 0; background: linear-gradient(var(--scn-top), transparent 190px), radial-gradient(70% 60% at 50% 40%, rgba(220,255,230,.04), transparent 70%), radial-gradient(115% 95% at 50% 45%, transparent 50%, rgba(0,0,0,var(--scn-vig)) 100%); }
      ${LIGHT} .scn svg { opacity: 1; }
      ${FULL_CSS(S, LIGHT)}`;
    mount(css, LAND + PORT); fitW();
  }

  function nhl() {
    const S = 'html[data-scene="nhl"]', DARK = `${S}:not([data-theme="light"])`, LIGHT = `${S}[data-theme="light"]`;
    const f1 = (n) => +n.toFixed(1);
    let seed = 41; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    // the ice: long skate strides carved into it (sweeping arcs), a few hockey stops (short fans of scrapes), snow specks
    // the ice's marks, the way skating leaves them: hundreds of hairline cuts every which way, long gentle curves and short
    // straight ones, often in pairs (both edges of a blade), wobbling a little; a few tight crossover loops; frost dust in them
    const scratches = (() => {
      let o = '';
      const cut = (x, y, a, l, curve, w, op) => {
        let d = `M${f1(x)} ${f1(y)}`, n = Math.max(2, Math.round(l / 18));
        for (let k = 1; k <= n; k++) { a += curve / n + (rnd() - 0.5) * 0.05; x += Math.cos(a) * l / n; y += Math.sin(a) * l / n; d += `L${f1(x)} ${f1(y)}`; }
        return `<path d="${d}" stroke-width="${f1(w)}" opacity="${f1(op)}"/>`;
      };
      for (let i = 0; i < 650; i++) {
        const x = rnd() * 900, y = rnd() * 900, a = rnd() * 6.283, long = rnd() < 0.35, l = long ? 160 + rnd() * 420 : 20 + rnd() * 110;
        const curve = (rnd() - 0.5) * (long ? 1.1 : 0.4), w = 0.25 + rnd() ** 2 * 0.9, op = 0.25 + rnd() * 0.75;
        o += cut(x, y, a, l, curve, w, op);
        if (rnd() < 0.4) { const off = 1.2 + rnd() * 2.2; o += cut(x - Math.sin(a) * off, y + Math.cos(a) * off, a, l * (0.8 + rnd() * 0.2), curve, w * 0.8, op * 0.7); }
      }
      for (let i = 0; i < 14; i++) o += cut(rnd() * 900, rnd() * 900, rnd() * 6.283, 140 + rnd() * 160, (rnd() < 0.5 ? -1 : 1) * (3 + rnd() * 2.5), 0.5, 0.5);
      return o;
    })();
    let specks = ''; for (let i = 0; i < 260; i++) specks += `<circle cx="${f1(rnd() * 900)}" cy="${f1(rnd() * 900)}" r="${f1(0.3 + rnd() ** 3 * 1.6)}" opacity="${f1(0.3 + rnd() * 0.7)}"/>`;
    // frost: soft snowy smudges where the blades piled shavings
    let frost = ''; for (let i = 0; i < 16; i++) frost += `<ellipse cx="${f1(rnd() * 900)}" cy="${f1(rnd() * 900)}" rx="${f1(20 + rnd() * 60)}" ry="${f1(6 + rnd() * 18)}" transform="rotate(${f1(rnd() * 180)})" opacity="${f1(0.3 + rnd() * 0.6)}"/>`;
    // the rink from above, down the screen: boards at both edges, the red line, a blue line, the end-zone circles (their outer
    // arcs and hashes in the margins). Not to scale where the page needs it. Lines are painted under the ice: soft-edged.
    const rink = (W, ft, side, y0, id) => {
      const S = side, X = (f) => W / 2 + f * ft, lw = f1(ft * 1), red = 'var(--scn-red)', blue = 'var(--scn-blue)', H = 4000;
      const yRed = y0, yBlue = y0 + 25 * ft, yDots = yBlue + 5 * ft, yEz = yBlue + 31 * ft, yGoal = yEz + 20 * ft;
      const cxL = S + 15.5 * ft, cxR = W - S - 15.5 * ft, r = 15 * ft;
      const circle = (cx, cy) => {
        // the circle, its centre spot, the hash marks off both sides, the L-marks round the spot
        let o = `<circle cx="${f1(cx)}" cy="${f1(cy)}" r="${f1(r)}" fill="none" stroke="${red}" stroke-width="${f1(ft * 0.17)}"/><circle cx="${f1(cx)}" cy="${f1(cy)}" r="${f1(ft)}" fill="${red}"/>`;
        for (const sx of [-1, 1]) for (const sy of [-1, 1]) {
          o += `<path d="M${f1(cx + sx * r)} ${f1(cy + sy * 3 * ft)}h${f1(sx * 2 * ft)}" stroke="${red}" stroke-width="${f1(ft * 0.17)}"/>`;
          o += `<path d="M${f1(cx + sx * 2 * ft)} ${f1(cy + sy * 0.75 * ft)}h${f1(sx * 4 * ft)}M${f1(cx + sx * 2 * ft)} ${f1(cy + sy * 0.75 * ft)}v${f1(sy * 3 * ft)}" stroke="${red}" stroke-width="${f1(ft * 0.17)}" fill="none"/>`;
        }
        return o;
      };
      let o = `<defs><pattern id="${id}scr" width="900" height="900" patternUnits="userSpaceOnUse"><g fill="var(--scn-speck)" filter="url(#${id}frostblur)">${frost}</g><g fill="none" stroke="var(--scn-scratch)" stroke-linecap="round" stroke-linejoin="round">${scratches}</g><g fill="var(--scn-speck)">${specks}</g></pattern>
        <filter id="${id}frostblur"><feGaussianBlur stdDeviation="8"/></filter>
        <filter id="${id}under" x="-5%" y="-5%" width="110%" height="110%"><feGaussianBlur stdDeviation="${f1(Math.max(0.5, ft * 0.06))}"/></filter>
        <radialGradient id="${id}cloud"><stop offset="0" stop-color="var(--scn-cloud)" stop-opacity=".5"/><stop offset="1" stop-color="var(--scn-cloud)" stop-opacity="0"/></radialGradient></defs>
        <rect x="0" y="-200" width="${W}" height="${H}" fill="var(--scn-ice)" opacity="var(--scn-tint)"/>`;
      seed = 77; for (let i = 0; i < 9; i++) o += `<ellipse cx="${f1(rnd() * W)}" cy="${f1(rnd() * 1800)}" rx="${f1(W * (0.12 + rnd() * 0.2))}" ry="${f1(W * (0.08 + rnd() * 0.14))}" fill="url(#${id}cloud)"/>`;
      o += `<g filter="url(#${id}under)" opacity="var(--scn-paintop)">
        <rect x="${S}" y="${f1(yRed - lw / 2)}" width="${W - 2 * S}" height="${lw}" fill="${red}"/>
        <circle cx="${W / 2}" cy="${yRed}" r="${f1(r)}" fill="none" stroke="${blue}" stroke-width="${f1(ft * 0.17)}"/><circle cx="${W / 2}" cy="${yRed}" r="${f1(0.5 * ft)}" fill="${blue}"/>
        <rect x="${S}" y="${f1(yBlue - lw / 2)}" width="${W - 2 * S}" height="${lw}" fill="${blue}"/>
        <circle cx="${f1(cxL + 1 * ft)}" cy="${f1(yDots)}" r="${f1(ft)}" fill="${red}"/><circle cx="${f1(cxR - 1 * ft)}" cy="${f1(yDots)}" r="${f1(ft)}" fill="${red}"/>
        ${circle(cxL, yEz)}${circle(cxR, yEz)}
        <rect x="${S}" y="${f1(yGoal - ft * 0.1)}" width="${W - 2 * S}" height="${f1(ft * 0.17)}" fill="${red}"/>
        <path d="M${W / 2 - 4 * ft} ${yGoal}v${f1(4.5 * ft)}a${4 * ft} ${2 * ft} 0 0 0 ${8 * ft} 0v${f1(-4.5 * ft)}z" fill="var(--scn-crease)" stroke="${red}" stroke-width="${f1(ft * 0.17)}"/></g>
        <rect x="0" y="-200" width="${W}" height="${H}" fill="url(#${id}scr)"/>
        <rect x="0" y="-200" width="${S}" height="${H}" fill="var(--scn-board)"/><rect x="${W - S}" y="-200" width="${S}" height="${H}" fill="var(--scn-board)"/>
        <rect x="${f1(S - ft * 0.35)}" y="-200" width="${f1(ft * 0.35)}" height="${H}" fill="var(--scn-kick)"/><rect x="${W - S}" y="-200" width="${f1(ft * 0.35)}" height="${H}" fill="var(--scn-kick)"/>`;
      return o;
    };
    const LAND = `<svg class="scn-land" data-w="1600" viewBox="0 0 1600 1000" preserveAspectRatio="xMidYMin slice">${rink(1600, 16, 22, 150, 'L')}</svg>`;
    const PORT = `<svg class="scn-port" data-w="420" viewBox="0 0 420 900" preserveAspectRatio="xMidYMin slice">${rink(420, 5.2, 6, 205, 'P')}</svg>`;
    const css = `
      ${DARK} { --scn-ice: #101a2a; --scn-tint: .86; --scn-cloud: #24395a; --scn-scratch: rgba(205,225,255,0.24); --scn-speck: rgba(220,235,255,0.16); --scn-paintop: .72;
        --scn-red: #c8323f; --scn-blue: #2f6bd0; --scn-crease: rgba(47,107,208,0.25); --scn-board: #05080e; --scn-kick: #c9a227; --scn-vig: .6; }
      ${LIGHT} { --scn-ice: #e8f1f8; --scn-tint: .45; --scn-cloud: #ffffff; --scn-scratch: rgba(105,135,170,0.34); --scn-speck: rgba(255,255,255,0.85); --scn-paintop: .8;
        --scn-red: #c8102e; --scn-blue: #0b4f9c; --scn-crease: rgba(90,160,230,0.35); --scn-board: #f9fbfd; --scn-kick: #e2b400; --scn-vig: .1; }
      /* the ice under everything, so overscroll past the page ends is ice, not white */
      ${DARK} { background: #0a111c; } ${LIGHT} { background: #eef4f9; }
      ${S} body { background: transparent; } ${S} body::before { display: none; }
      /* resurfaced rink ice: scene/ice.jpg (ambientCG Snow006, CC0) for the milky cloud, tinted to the theme; skate marks drawn over it */
      ${S} .scn { background: url(/scene/ice.jpg) 0 0 / 520px repeat; }
      ${S} .scn::after { content: ''; position: absolute; inset: 0; background: radial-gradient(115% 95% at 50% 45%, transparent 50%, rgba(0,0,0,var(--scn-vig)) 100%); }
      ${LIGHT} .scn svg { opacity: 1; }
      ${FULL_CSS(S, LIGHT)}`;
    mount(css, LAND + PORT); fitW();
  }

  function nba() {
    const S = 'html[data-scene="nba"]', DARK = `${S}:not([data-theme="light"])`, LIGHT = `${S}[data-theme="light"]`;
    const f1 = (n) => +n.toFixed(1);
    // The court from above, down the screen, on maple (scene/wood.jpg, ambientCG WoodFloor062, CC0, turned so the strips run
    // the length of the floor): the painted apron down both sides with RON'S HOOP TOOL on it (it falls in the margins), the
    // half-court line and centre circle at the top, the three-point arc sweeping round the painted key below. NBA dimensions
    // across (50 ft between the sidelines); fitW keeps the width to the screen.
    const court = (W, ft, apron, y0, words, T) => {     // T: drawn mirrored, y -> T - y (the baseline at the top, the arc coming down)
      const S = apron, L = 'var(--scn-paint)', lw = f1(Math.max(1.5, ft * 0.17)), mid = W / 2, H = 4000;
      const base = y0 + 47 * ft, hoopY = base - 5.25 * ft, r3 = 23.75 * ft, cx3 = 22 * ft, yBreak = hoopY - Math.sqrt(r3 * r3 - cx3 * cx3);
      const key = 8 * ft, ft15 = base - 19 * ft;
      let o = `<rect x="0" y="-200" width="${S}" height="${H}" fill="var(--scn-apron)"/><rect x="${W - S}" y="-200" width="${S}" height="${H}" fill="var(--scn-apron)"/>
        <rect x="0" y="${f1(base)}" width="${W}" height="${f1(Math.max(4, ft * 0.6))}" fill="var(--scn-apron)"/>`;     // a thin strip past the baseline, wood beyond
      // the apron's words, running down each side (left reads bottom to top, right top to bottom), faint
      const fs = f1(S * 0.42);
      if (S > 60) for (const [x, rot] of [[S / 2, -90], [W - S / 2, 90]]) for (let y = 200; y < H; y += 1100)
        o += `<text transform="translate(${f1(x)} ${y}) rotate(${rot})" text-anchor="middle" dominant-baseline="central" font-family="'Chakra Petch', sans-serif" font-weight="700" font-size="${fs}" letter-spacing="${f1(fs * 0.3)}" fill="var(--scn-apron-text)">${words}</text>`;
      // the sidelines, the half-court line, the centre circle (painted inside), the substitution hashes
      o += `<rect x="${f1(S - lw)}" y="-200" width="${lw}" height="${H}" fill="${L}"/><rect x="${W - S}" y="-200" width="${lw}" height="${H}" fill="${L}"/>
        <rect x="${S}" y="${f1(y0 - lw / 2)}" width="${W - 2 * S}" height="${lw}" fill="${L}"/>
        <circle cx="${mid}" cy="${y0}" r="${f1(6 * ft)}" fill="var(--scn-key)" stroke="${L}" stroke-width="${lw}"/><circle cx="${mid}" cy="${y0}" r="${f1(2 * ft)}" fill="none" stroke="${L}" stroke-width="${lw}"/>
        <path d="M${S} ${f1(y0 + 28 * ft)}h${f1(3 * ft)}M${W - S} ${f1(y0 + 28 * ft)}h${f1(-3 * ft)}" stroke="${L}" stroke-width="${lw}"/>`;
      // the three-point line: straight down from the break in the corners, the arc round the hoop
      o += `<path d="M${f1(mid - cx3)} ${f1(base)}V${f1(yBreak)}A${f1(r3)} ${f1(r3)} 0 0 1 ${f1(mid + cx3)} ${f1(yBreak)}V${f1(base)}" fill="none" stroke="${L}" stroke-width="${lw}"/>`;
      // the key, painted; the free-throw circle; the lane hashes; the restricted arc; the backboard and rim
      o += `<rect x="${f1(mid - key)}" y="${f1(ft15)}" width="${f1(2 * key)}" height="${f1(19 * ft)}" fill="var(--scn-key)" stroke="${L}" stroke-width="${lw}"/>
        <circle cx="${mid}" cy="${f1(ft15)}" r="${f1(6 * ft)}" fill="none" stroke="${L}" stroke-width="${lw}"/>
        ${[7, 11, 14].map(d => `<path d="M${f1(mid - key)} ${f1(base - d * ft)}h${f1(-ft * 0.5)}M${f1(mid + key)} ${f1(base - d * ft)}h${f1(ft * 0.5)}" stroke="${L}" stroke-width="${lw}"/>`).join('')}
        <rect x="${f1(mid - key - ft * 0.5)}" y="${f1(base - 8 * ft)}" width="${f1(ft * 0.5)}" height="${f1(ft)}" fill="${L}"/><rect x="${f1(mid + key)}" y="${f1(base - 8 * ft)}" width="${f1(ft * 0.5)}" height="${f1(ft)}" fill="${L}"/>
        <path d="M${f1(mid - 6 * ft)} ${f1(ft15)}A${f1(6 * ft)} ${f1(6 * ft)} 0 0 0 ${f1(mid + 6 * ft)} ${f1(ft15)}" fill="none" stroke="${L}" stroke-width="${lw}" stroke-dasharray="${f1(ft * 1.2)} ${f1(ft * 0.9)}"/>
        ${[28, 3 + 28].map(d => `<path d="M${S} ${f1(base - d * ft)}h${f1(3 * ft)}M${W - S} ${f1(base - d * ft)}h${f1(-3 * ft)}" stroke="${L}" stroke-width="${lw}"/>`).join('')}
        <path d="M${S} ${f1(base - 14 * ft)}h${f1(ft * 3)}M${W - S} ${f1(base - 14 * ft)}h${f1(-ft * 3)}" stroke="${L}" stroke-width="${lw}"/>
        <path d="M${f1(mid - 4 * ft)} ${f1(hoopY)}A${f1(4 * ft)} ${f1(4 * ft)} 0 0 1 ${f1(mid + 4 * ft)} ${f1(hoopY)}" fill="none" stroke="${L}" stroke-width="${lw}"/>
        <rect x="${f1(mid - 3 * ft)}" y="${f1(base - 4 * ft)}" width="${f1(6 * ft)}" height="${lw}" fill="${L}"/><circle cx="${mid}" cy="${f1(hoopY)}" r="${f1(0.75 * ft)}" fill="none" stroke="var(--scn-rim)" stroke-width="${lw}"/>
        <rect x="${S}" y="${f1(base - lw / 2)}" width="${W - 2 * S}" height="${lw}" fill="${L}"/>`;
      // paint, not tint: lines and painted areas opaque, a hair ragged at the edge, the wood's grain faintly through them
      return `<defs><filter id="paint${W}" x="-2%" y="-2%" width="104%" height="104%" color-interpolation-filters="sRGB">
          <feTurbulence type="fractalNoise" baseFrequency="0.8" numOctaves="2" seed="3" result="n"/><feDisplacementMap in="SourceGraphic" in2="n" scale="${f1(Math.max(1, ft * 0.06))}" xChannelSelector="R" yChannelSelector="G" result="d"/>
          <feTurbulence type="fractalNoise" baseFrequency="0.3 0.015" numOctaves="2" seed="8" result="g"/><feColorMatrix in="g" type="matrix" values="0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 -0.8 1.22" result="ga"/>
          <feComposite in="d" in2="ga" operator="in"/></filter></defs>
        <g filter="url(#paint${W})" transform="matrix(1 0 0 -1 0 ${T})">${o}</g>`;
    };
    const LAND = `<svg class="scn-land" data-w="1600" viewBox="0 0 1600 1000" preserveAspectRatio="xMidYMin slice">${court(1600, 30.4, 24, -450, "RON'S HOOP TOOL", 1000)}</svg>`;
    const PORT = `<svg class="scn-port" data-w="420" viewBox="0 0 420 900" preserveAspectRatio="xMidYMin slice">${court(420, 8.16, 5, 420, 'HOOP TOOL', 1020)}</svg>`;
    const css = `
      ${DARK} { --scn-stain: rgba(10,6,2,0.74); --scn-paint: rgba(226,214,192,0.8); --scn-apron: #1a1438; --scn-apron-text: rgba(245,240,230,0.18);
        --scn-key: #221a4a; --scn-rim: rgba(255,120,40,0.6); --scn-vig: .65; }
      ${LIGHT} { --scn-stain: rgba(255,248,236,0.06); --scn-paint: #fbfaf6; --scn-apron: #3a2a7a;
        --scn-apron-text: rgba(255,255,255,0.55); --scn-key: #4a36a0; --scn-rim: #ff6a00; --scn-vig: .12; }
      /* the floor under everything, so overscroll past the page ends is wood, not white */
      ${DARK} { background: #120c07; } ${LIGHT} { background: #c99a62; }
      ${S} body { background: transparent; } ${S} body::before { display: none; }
      ${S} .scn { background: url(/scene/wood.jpg) 0 0 / 300px repeat; }
      ${S} .scn::before { content: ''; position: absolute; inset: 0; background: var(--scn-stain); }
      ${S} .scn::after { content: ''; position: absolute; inset: 0; background: radial-gradient(115% 95% at 50% 45%, transparent 50%, rgba(0,0,0,var(--scn-vig)) 100%); }
      ${LIGHT} .scn svg { opacity: 1; }
      ${FULL_CSS(S, LIGHT)}`;
    mount(css, LAND + PORT); fitW();
  }
})();
