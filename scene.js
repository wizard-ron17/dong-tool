// Night scenes: each sport's own sky behind the page, the look Halloween had all year round (a lit sky instead of flat
// black, the cards tinted to it, brighter borders, art in the empty margins), in the sport's own hue. The accent and the
// good/bad ramp stay the app's; only the sky, the surfaces and the borders change.
// PREVIEW ONLY for now: ?bg=night turns it on for this tab (it stays on as you move around), ?bg=off turns it off.
// A holiday (/holiday.js) takes the page over on its days. chrome.js loads this file.
//
//   nfl   stadium night: a green-navy sky, two light towers throwing beams across the top, the stands, goalposts
//         and a sliver of lit field along the bottom
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
  // a holiday wins on its days (holiday.js sets data-holiday before the page draws; it may load after us, so look again)
  const go = () => {
    if (document.documentElement.getAttribute('data-holiday')) return;
    window.RonScene.on = sport;
    document.documentElement.setAttribute('data-scene', sport);
    SCENES[sport]();
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', go); else go();

  function mount(css, left, right) {
    const style = document.createElement('style'); style.id = 'scene-css'; style.textContent = css; document.head.appendChild(style);
    if (!document.querySelector('.scn')) document.body.insertAdjacentHTML('afterbegin', `<div class="scn" aria-hidden="true">${left}${right}</div>`);
  }

  function nfl() {
    const S = 'html[data-scene="nfl"]', DARK = `${S}:not([data-theme="light"])`, LIGHT = `${S}[data-theme="light"]`;
    const SIL = 'var(--scn-sil)';
    // a light tower: a lattice mast, a bank of lamps, and its beam (drawn under the mast)
    const tower = (x, top, dir) => {
      const bx = x - 34, lamps = [];
      for (let r = 0; r < 3; r++) for (let c = 0; c < 6; c++) lamps.push(`<circle cx="${bx + 7 + c * 12}" cy="${top + 7 + r * 11}" r="3.6"/>`);
      return `<path d="M${x} ${top + 30}L${x + dir * 760} ${top + 520}L${x + dir * 360} ${top + 620}Z" fill="url(#scn-beam)"/>
        <circle cx="${x}" cy="${top + 16}" r="90" fill="url(#scn-flare)"/>
        <rect x="${bx}" y="${top}" width="68" height="34" rx="3" fill="${SIL}"/>
        <g fill="var(--scn-lamp)">${lamps.join('')}</g>
        <path d="M${x - 6} ${top + 34}L${x - 16} 900H${x + 16}L${x + 6} ${top + 34}Z" fill="${SIL}"/>
        <path d="${Array.from({ length: 14 }, (_, i) => { const y = top + 50 + i * 50; return `M${x - 8 - i * 0.6} ${y}L${x + 8 + i * 0.6} ${y + 50}M${x + 8 + i * 0.6} ${y}L${x - 8 - i * 0.6} ${y + 50}`; }).join('')}" stroke="var(--scn-lattice)" stroke-width="1.4" fill="none"/>`;
    };
    // the stands: rows of seats stepping up to the edge, a rim of lit windows at the top
    const stands = (side) => {
      const steps = [];
      for (let i = 0; i < 9; i++) steps.push(side === 'l' ? `H${i * 26}V${640 + i * 14}` : `H${420 - i * 26}V${640 + i * 14}`);
      const d = side === 'l' ? `M0 900V640${steps.join('')}H260V900Z` : `M420 900V640${steps.join('')}H160V900Z`;
      const win = Array.from({ length: 9 }, (_, i) => `<rect x="${side === 'l' ? 14 + i * 24 : 406 - 14 - i * 24 - 8}" y="652" width="8" height="3" rx="1"/>`).join('');
      return `<path d="${d}" fill="${SIL}"/><g fill="var(--scn-lamp)" opacity=".55">${win}</g>`;
    };
    const goal = (x) => `<g fill="none" stroke="var(--scn-post)" stroke-width="5" stroke-linecap="round">
        <path d="M${x} 900V780M${x - 46} 780H${x + 46}M${x - 46} 780V660M${x + 46} 780V660"/></g>`;
    // a sliver of field: the turf glowing under the lights, yard lines running off into the distance
    const field = (side) => {
      const lines = Array.from({ length: 6 }, (_, i) => side === 'l' ? `M${40 + i * 70} 900L${120 + i * 56} 838` : `M${380 - i * 70} 900L${300 - i * 56} 838`).join('');
      return `<path d="M0 900V836Q210 826 420 836V900Z" fill="url(#scn-turf)"/><path d="${lines}" stroke="var(--scn-yard)" stroke-width="2"/>`;
    };
    const defs = `<defs>
      <linearGradient id="scn-beam" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="var(--scn-beam)" stop-opacity=".32"/><stop offset="1" stop-color="var(--scn-beam)" stop-opacity="0"/></linearGradient>
      <radialGradient id="scn-flare"><stop offset="0" stop-color="var(--scn-beam)" stop-opacity=".45"/><stop offset="1" stop-color="var(--scn-beam)" stop-opacity="0"/></radialGradient>
      <linearGradient id="scn-turf" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="var(--scn-turf)"/><stop offset="1" stop-color="var(--scn-sil)"/></linearGradient></defs>`;
    const LEFT = `<svg class="scn-side scn-left" viewBox="0 0 420 900" preserveAspectRatio="xMinYMax meet">${defs}${tower(92, 120, 1)}${stands('l')}${field('l')}${goal(300)}</svg>`;
    const RIGHT = `<svg class="scn-side scn-right" viewBox="0 0 420 900" preserveAspectRatio="xMaxYMax meet">${defs.replace(/id="scn-/g, 'id="scn-r-')}${tower(328, 90, -1).replace(/url\(#scn-/g, 'url(#scn-r-')}${stands('r')}${field('r').replace(/url\(#scn-/g, 'url(#scn-r-')}</svg>`;
    const css = `
      ${DARK} { --bg: #040b0c; --surface0: #081416; --surface1: #0c1b1e; --surface2: #122729; --border: #1b3638; --border2: #285055;
        --glow: rgba(51,208,124,0.10); --scn-sil: #020607; --scn-lamp: #f4f9ff; --scn-beam: #cfe7ff; --scn-lattice: rgba(160,200,210,0.16);
        --scn-post: rgba(230,214,120,0.55); --scn-turf: #0f3a24; --scn-yard: rgba(220,255,235,0.16); }
      ${LIGHT} { --border: #cfe0dc; --border2: #b4ccc6; --scn-sil: #6f8f89; --scn-lamp: #ffffff; --scn-beam: #ffffff; --scn-lattice: rgba(40,80,76,0.25);
        --scn-post: rgba(150,130,40,0.6); --scn-turf: #7cbf95; --scn-yard: rgba(255,255,255,0.6); }
      ${DARK} body { background: radial-gradient(900px 520px at 6% 4%, rgba(190,225,255,0.13), transparent 62%),
          radial-gradient(900px 520px at 94% 0%, rgba(190,225,255,0.13), transparent 62%),
          radial-gradient(1200px 700px at 50% 108%, rgba(51,208,124,0.14), transparent 60%), linear-gradient(#071315, #030809) fixed; }
      ${LIGHT} body { background: linear-gradient(#e6f2ee, #eef1f6) fixed; }
      ${S} .scn { position: fixed; inset: 0; z-index: 0; pointer-events: none; overflow: hidden; }
      ${DARK} .scn { background-image: radial-gradient(1px 1px at 18% 9%, #fff 50%, transparent 51%), radial-gradient(1.2px 1.2px at 37% 4%, #fff 50%, transparent 51%),
          radial-gradient(1px 1px at 58% 13%, #fff 50%, transparent 51%), radial-gradient(1px 1px at 71% 6%, #fff 50%, transparent 51%), radial-gradient(1.2px 1.2px at 46% 19%, #fff 50%, transparent 51%); opacity: .7; }
      ${S} .scn-side { position: absolute; bottom: 0; height: 100vh; width: auto; max-width: 48vw; }
      /* the art lives in the side margins only: masked off where the content column (.wrap, 1180 max) sits, so it never
         shows between cards or behind a table */
      ${S} .scn-side { -webkit-mask-image: var(--scn-mask); mask-image: var(--scn-mask); }
      ${S} .scn-left { --scn-mask: linear-gradient(to right, #000 calc(50vw - 640px), transparent calc(50vw - 596px)); }
      ${S} .scn-right { --scn-mask: linear-gradient(to left, #000 calc(50vw - 640px), transparent calc(50vw - 596px)); }
      ${S} .scn-left { left: 0; } ${S} .scn-right { right: 0; }
      ${LIGHT} .scn-side { opacity: .3; }
      @media (max-width: 760px) { ${S} .scn-side { opacity: .35; } }
      ${S} .wrap { position: relative; z-index: 1; }`;
    mount(css, LEFT, RIGHT);
  }
})();
