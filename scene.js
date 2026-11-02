// Night scenes: each sport's own sky behind the page, the look Halloween had all year round (a lit sky instead of flat
// black, the cards tinted to it, brighter borders, art in the empty margins), in the sport's own hue. The accent and the
// good/bad ramp stay the app's; only the sky, the surfaces and the borders change.
// PREVIEW ONLY for now: ?bg=night turns it on for this tab (it stays on as you move around), ?bg=off turns it off.
// A holiday stands aside while a scene is previewed, unless asked for by name (?holiday=halloween). chrome.js loads this file.
//
//   nfl   a night game in the rain: a light bank from below with its bloom, flare and a cone of rain (top left), the
//         blimp with its side lit and a far light bank (top right), rim-lit goalposts before the end-zone crowd (bottom
//         left), the jumbotron calling TOUCHDOWN over the stands (bottom right)
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
  // the corners: four art pieces, each its own drawing so it stays a whole picture at any width (the Halloween layout:
  // a piece per corner, the sky between). Cards and tables are solid, so the art shows only around them.
  function CORNER_CSS(S, LIGHT) { return `
      /* under everything (z-index -1, above only the page background): no header, footer or panel can ever be covered */
      ${S} .scn { position: fixed; inset: 0; z-index: -1; pointer-events: none; overflow: hidden; }
      ${S} .scn-c { position: absolute; display: block; height: auto; }
      /* sized off the margin beside the content column (1180 wide): fills it on a big screen, tucks in on a small one */
      ${S} .scn-tl, ${S} .scn-tr { top: 0; width: clamp(150px, calc(50vw - 480px), 480px); }
      ${S} .scn-bl, ${S} .scn-br { bottom: 0; width: clamp(160px, calc(50vw - 450px), 520px); }
      ${S} .scn-tl, ${S} .scn-bl { left: 0; } ${S} .scn-tr, ${S} .scn-br { right: 0; }
      ${LIGHT} .scn-c { opacity: .38; }
      /* phones: no margins, so the pieces sit behind the page, stronger than Halloween's (.4) at the bottom; the top two
         ride up and dim so the header reads over them */
      /* phones: no margins, so the art lives where a phone shows it: the top corners, cropped off the edges, light the
         header (the cores stay small so the title reads), and the bottom pieces sit behind the frosted nav bar */
      @media (max-width: 760px) { ${S} .scn-tl { width: 66vw; top: -21vw; left: -27vw; opacity: .85; }
        ${S} .scn-tr { width: 60vw; top: -8vw; right: -12vw; opacity: .7; }
        ${S} .scn-bl, ${S} .scn-br { width: 58vw; opacity: .9; }
        ${LIGHT} .scn-c { opacity: .32; } }
      /* the footer gets its own frosted panel: the art reaches the page end, and its text must read over it */
      ${S} .site-foot { background: color-mix(in srgb, var(--bg) 72%, transparent); -webkit-backdrop-filter: blur(10px); backdrop-filter: blur(10px);
        border: 1px solid var(--border); border-radius: 14px; padding: 0.8rem 1rem; }`; }

  function nfl() {
    const S = 'html[data-scene="nfl"]', DARK = `${S}:not([data-theme="light"])`, LIGHT = `${S}[data-theme="light"]`;
    const SIL = 'var(--scn-sil)', RIM = 'var(--scn-rim)', calm = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const lerp = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
    // a bank of lamps on a quad seen from below: a halo and a hot core per lamp
    const bank = (P00, P10, P01, P11, cols, rows, id) => {
      const out = [];
      for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
        const u = 0.09 + c * 0.82 / (cols - 1), v = 0.16 + r * 0.68 / (rows - 1);
        const [x, y] = lerp(lerp(P00, P10, u), lerp(P01, P11, u), v);
        out.push(`<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="13" fill="url(#${id}-halo)"/><circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="4.4" fill="var(--scn-lamp)"/>`);
      }
      return `<path d="M${P00}L${P10}L${P11}L${P01}Z" fill="${SIL}" stroke="${RIM}" stroke-width="2" stroke-linejoin="round"/>${out.join('')}`;
    };
    const halo = (id) => `<radialGradient id="${id}-halo"><stop offset="0" stop-color="var(--scn-light)" stop-opacity=".9"/><stop offset=".35" stop-color="var(--scn-light)" stop-opacity=".35"/><stop offset="1" stop-color="var(--scn-light)" stop-opacity="0"/></radialGradient>`;
    // rain, falling only where the light catches it
    const rain = (id) => `<pattern id="${id}" width="20" height="60" patternUnits="userSpaceOnUse"><path d="M14 4l-4 12M6 34l-3 9" stroke="var(--scn-rain)" stroke-width="1.2" stroke-linecap="round"/>${calm ? '' : '<animateTransform attributeName="patternTransform" type="translate" from="0 0" to="-20 60" dur="0.75s" repeatCount="indefinite"/>'}</pattern>`;
    // a crowd along a curve: heads, a few phone flashes that twinkle
    const crowd = (f, n, flashes) => {
      let h = '', fl = '';
      for (let i = 0; i < n; i++) { const t = i / (n - 1), [x, y] = f(t), j = (i * 7919 % 5) - 2; h += `<circle cx="${x.toFixed(1)}" cy="${(y - 3 + j * 0.6).toFixed(1)}" r="${3.2 + (i % 3) * 0.5}"/>`; }
      flashes.forEach((t, k) => { const [x, y] = f(t); fl += `<circle class="scn-tw" style="animation-delay:${(k * 1.37) % 4}s" cx="${x.toFixed(1)}" cy="${(y + 9 + (k % 3) * 7).toFixed(1)}" r="1.8"/>`; });
      return `<g fill="var(--scn-crowd)">${h}</g><g fill="var(--scn-flash)">${fl}</g>`;
    };
    const qb = (p0, c, p1) => (t) => [(1 - t) ** 2 * p0[0] + 2 * (1 - t) * t * c[0] + t * t * p1[0], (1 - t) ** 2 * p0[1] + 2 * (1 - t) * t * c[1] + t * t * p1[1]];
    const turf = (id) => `<linearGradient id="${id}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="var(--scn-turf)"/><stop offset="1" stop-color="var(--scn-turf2)"/></linearGradient>`;

    // top left, the moon of the piece: a light bank from below, its bloom and flare, a cone of light with rain in it
    const TL = `<svg class="scn-c scn-tl" viewBox="0 0 480 420">
      <defs>${halo('tl')}<radialGradient id="tl-bloom"><stop offset="0" stop-color="var(--scn-light)" stop-opacity=".5"/><stop offset=".3" stop-color="var(--scn-light)" stop-opacity=".16"/><stop offset="1" stop-color="var(--scn-light)" stop-opacity="0"/></radialGradient>
        <linearGradient id="tl-flare" x1="0" x2="1"><stop offset="0" stop-color="var(--scn-flare)" stop-opacity="0"/><stop offset=".5" stop-color="var(--scn-flare)" stop-opacity=".55"/><stop offset="1" stop-color="var(--scn-flare)" stop-opacity="0"/></linearGradient>
        <linearGradient id="tl-cone" x1="0" y1="0" x2=".4" y2="1"><stop offset="0" stop-color="var(--scn-light)" stop-opacity=".2"/><stop offset="1" stop-color="var(--scn-light)" stop-opacity="0"/></linearGradient>
        ${rain('tl-rain')}<clipPath id="tl-clip"><path d="M70 170L308 140L480 330V420H230Z"/></clipPath></defs>
      <path d="M70 170L308 140L480 330V420H230Z" fill="url(#tl-cone)"/>
      <rect x="0" y="0" width="480" height="420" fill="url(#tl-rain)" clip-path="url(#tl-clip)" opacity=".8"/>
      <path d="M172 156L188 154L202 420H156Z" fill="${SIL}"/><path d="M188 154L202 420" stroke="${RIM}" stroke-width="1.5"/>
      <path d="M64 182L312 150" stroke="${SIL}" stroke-width="5"/><path d="M64 182L312 150" stroke="${RIM}" stroke-width="1"/>
      <circle cx="186" cy="100" r="250" fill="url(#tl-bloom)"/>
      ${bank([62, 58], [300, 26], [72, 168], [308, 138], 8, 4, 'tl')}
      <ellipse cx="186" cy="100" rx="260" ry="5" fill="url(#tl-flare)"/></svg>`;

    // top right: the blimp over the stadium, its side panel lit, a far light bank across the field
    const TR = `<svg class="scn-c scn-tr" viewBox="0 0 480 420">
      <defs>${halo('tr')}<radialGradient id="tr-glow"><stop offset="0" stop-color="var(--scn-light)" stop-opacity=".22"/><stop offset="1" stop-color="var(--scn-light)" stop-opacity="0"/></radialGradient>
        <linearGradient id="tr-led" x1="0" x2="1"><stop offset="0" stop-color="var(--scn-led)" stop-opacity=".25"/><stop offset=".5" stop-color="var(--scn-led)" stop-opacity=".95"/><stop offset="1" stop-color="var(--scn-led)" stop-opacity=".25"/></linearGradient>
        <linearGradient id="tr-body" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="var(--scn-sil2)"/><stop offset="1" stop-color="${SIL}"/></linearGradient></defs>
      <circle cx="96" cy="300" r="120" fill="url(#tr-glow)"/>
      ${bank([58, 288], [134, 278], [60, 316], [136, 306], 5, 2, 'tr')}
      <path d="M94 312L100 420" stroke="${SIL}" stroke-width="5"/>
      <g class="scn-drift">
        <circle cx="300" cy="140" r="210" fill="url(#tr-glow)"/>
        <path d="M168 128L132 92L176 112ZM168 152L130 186L178 162Z" fill="${SIL}" stroke="${RIM}" stroke-width="1.5" stroke-linejoin="round"/>
        <ellipse cx="300" cy="140" rx="150" ry="46" fill="url(#tr-body)"/>
        <path d="M168 132Q300 80 446 128" stroke="${RIM}" stroke-width="2" fill="none" stroke-linecap="round"/>
        <rect x="222" y="122" width="150" height="30" rx="7" fill="url(#tr-led)" opacity=".9"/>
        <text x="297" y="143" text-anchor="middle" font-family="'Chakra Petch', 'JetBrains Mono', sans-serif" font-weight="700" font-size="16" letter-spacing="3" fill="var(--scn-led-text)">RON'S TOOLS</text>
        <rect x="286" y="182" width="56" height="16" rx="6" fill="${SIL}" stroke="${RIM}" stroke-width="1"/>
        <g fill="var(--scn-window)"><rect x="292" y="187" width="7" height="5" rx="1"/><rect x="304" y="187" width="7" height="5" rx="1"/><rect x="316" y="187" width="7" height="5" rx="1"/><rect x="328" y="187" width="7" height="5" rx="1"/></g>
        <circle class="scn-tw" cx="450" cy="140" r="2.4" fill="#ff4d4d"/></g></svg>`;

    // bottom left: the goalposts, rim-lit gold, ribbons in the wind, the end-zone stands and their crowd behind
    const rimL = qb([0, 268], [210, 300], [480, 384]);
    const BL = `<svg class="scn-c scn-bl" viewBox="0 0 480 520">
      <defs>${turf('bl-turf')}<linearGradient id="bl-post" x1="0" x2="1"><stop offset="0" stop-color="var(--scn-post-hi)"/><stop offset=".35" stop-color="var(--scn-post)"/><stop offset="1" stop-color="var(--scn-post-lo)"/></linearGradient></defs>
      <path d="M0 214Q190 236 480 330V520H0Z" fill="var(--scn-sil2)"/>
      <path d="M0 268Q210 300 480 384V520H0Z" fill="${SIL}"/>
      <path d="M0 268Q210 300 480 384" stroke="${RIM}" stroke-width="1.5" fill="none"/>
      ${crowd(rimL, 54, [0.08, 0.27, 0.44, 0.61, 0.83])}
      <path d="M0 470Q240 452 480 466V520H0Z" fill="url(#bl-turf)"/>
      <path d="M0 482Q240 466 480 478" stroke="var(--scn-line)" stroke-width="3" fill="none"/>
      <g stroke-linecap="round" stroke-linejoin="round" fill="none">
        <path d="M190 476V392Q190 360 222 358" stroke="url(#bl-post)" stroke-width="11"/>
        <path d="M108 358H336" stroke="url(#bl-post)" stroke-width="10"/>
        <path d="M108 358L116 34M336 358L328 34" stroke="url(#bl-post)" stroke-width="8"/>
        <path d="M105 352L113 40M333 352L325 40M108 354H336" stroke="var(--scn-post-hi)" stroke-width="1.6" opacity=".8"/></g>
      <rect x="177" y="408" width="26" height="70" rx="8" fill="${SIL}" stroke="${RIM}" stroke-width="1"/>
      <g class="scn-sway" style="transform-origin:116px 36px"><path d="M116 36C100 40 92 50 78 50C90 56 100 52 116 54Z" fill="var(--scn-flag)"/></g>
      <g class="scn-sway" style="transform-origin:328px 36px;animation-delay:-1.3s"><path d="M328 36C312 40 304 50 290 50C302 56 312 52 328 54Z" fill="var(--scn-flag)"/></g>
      <path d="M36 486L42 446H62L68 486Z" fill="var(--scn-flag)"/><rect x="39" y="460" width="26" height="5" fill="#fff" opacity=".85"/></svg>`;

    // bottom right: the jumbotron calls it, the ribbon board has the score, the stands and their crowd
    const rimR = qb([0, 392], [270, 312], [480, 272]);
    const BR = `<svg class="scn-c scn-br" viewBox="0 0 480 520">
      <defs>${turf('br-turf')}<radialGradient id="br-glow"><stop offset="0" stop-color="var(--scn-led)" stop-opacity=".34"/><stop offset="1" stop-color="var(--scn-led)" stop-opacity="0"/></radialGradient>
        <linearGradient id="br-screen" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="var(--scn-screen-hi)"/><stop offset="1" stop-color="var(--scn-screen)"/></linearGradient></defs>
      <path d="M0 330Q260 250 480 222V520H0Z" fill="var(--scn-sil2)"/>
      <circle cx="342" cy="150" r="200" fill="url(#br-glow)"/>
      <path d="M268 230V320M420 230V300" stroke="${SIL}" stroke-width="12"/>
      <path d="M438 66V18" stroke="${SIL}" stroke-width="3"/>
      <g class="scn-sway" style="transform-origin:438px 20px;animation-delay:-.6s"><path d="M438 20C426 22 418 30 404 30C414 36 426 32 438 36Z" fill="var(--scn-flag2)"/></g>
      <rect x="216" y="66" width="250" height="168" rx="10" fill="${SIL}" stroke="${RIM}" stroke-width="2"/>
      <rect x="228" y="78" width="226" height="112" rx="5" fill="url(#br-screen)"/>
      <text x="341" y="146" text-anchor="middle" font-family="'Chakra Petch', 'JetBrains Mono', sans-serif" font-weight="700" font-size="33" letter-spacing="1" fill="var(--scn-led)" class="scn-pulse">TOUCHDOWN</text>
      <rect x="228" y="200" width="226" height="22" rx="4" fill="var(--scn-ribbon-bg)"/>
      <text x="341" y="216" text-anchor="middle" font-family="'JetBrains Mono', ui-monospace, monospace" font-weight="700" font-size="12" letter-spacing="1" fill="var(--scn-ribbon)">HOME 24 · AWAY 21 · 4TH</text>
      <path d="M0 392Q270 312 480 272V520H0Z" fill="${SIL}"/>
      <path d="M0 392Q270 312 480 272" stroke="${RIM}" stroke-width="1.5" fill="none"/>
      ${crowd(rimR, 56, [0.12, 0.31, 0.5, 0.66, 0.9])}
      <path d="M0 474Q240 456 480 470V520H0Z" fill="url(#br-turf)"/>
      <path d="M0 486Q240 470 480 482" stroke="var(--scn-line)" stroke-width="3" fill="none"/></svg>`;

    const css = `
      ${DARK} { --bg: #040b0c; --surface0: #081416; --surface1: #0c1b1e; --surface2: #122729; --border: #1b3638; --border2: #285055;
        --glow: rgba(51,208,124,0.10); --scn-sil: #02080a; --scn-sil2: #071417; --scn-rim: rgba(170,215,235,0.28); --scn-lamp: #ffffff; --scn-light: #dceeff;
        --scn-flare: #8fc7ff; --scn-rain: rgba(225,240,255,0.5); --scn-crowd: #1b3a3a; --scn-flash: #ffffff;
        --scn-post: #e2bd3c; --scn-post-hi: #ffe58c; --scn-post-lo: #8a6c16; --scn-flag: #ff7a1a; --scn-flag2: #33d07c;
        --scn-turf: #12482c; --scn-turf2: #04140c; --scn-line: rgba(235,255,240,0.32);
        --scn-led: #33d07c; --scn-led-text: #04140c; --scn-window: #ffd98a; --scn-screen: #021309; --scn-screen-hi: #07301b;
        --scn-ribbon: #ffc94d; --scn-ribbon-bg: #0b0802; }
      ${LIGHT} { --border: #cfe0dc; --border2: #b4ccc6; --scn-sil: #5f7d77; --scn-sil2: #86a29c; --scn-rim: rgba(255,255,255,0.55); --scn-lamp: #ffffff; --scn-light: #ffffff;
        --scn-flare: #ffffff; --scn-rain: rgba(255,255,255,0.7); --scn-crowd: #4e6c66; --scn-flash: #ffffff;
        --scn-post: #c9a21a; --scn-post-hi: #f0d36a; --scn-post-lo: #8a6c16; --scn-flag: #e8650c; --scn-flag2: #10a758;
        --scn-turf: #78c493; --scn-turf2: #5f7d77; --scn-line: rgba(255,255,255,0.8);
        --scn-led: #10a758; --scn-led-text: #ffffff; --scn-window: #fff3cf; --scn-screen: #13321f; --scn-screen-hi: #1f4a30;
        --scn-ribbon: #ffd56a; --scn-ribbon-bg: #1c1a12; }
      /* the sky is the root's: a solid colour under it so overscroll (rubber-banding past the top or bottom) isn't white,
         and the body clear, since the art layer sits under the body's background */
      ${DARK} { background: radial-gradient(760px 520px at 8% 6%, rgba(205,232,255,0.16), transparent 64%),
          radial-gradient(700px 480px at 92% 10%, rgba(205,232,255,0.08), transparent 62%),
          radial-gradient(1300px 600px at 50% 112%, rgba(51,208,124,0.16), transparent 62%), linear-gradient(#081618, #030909) fixed #030909; }
      ${LIGHT} { background: linear-gradient(#e2f0eb, #eef1f6) fixed #eef1f6; }
      ${S} body { background: transparent; }
      ${DARK} .scn { background-image: radial-gradient(1px 1px at 22% 7%, #fff 50%, transparent 51%), radial-gradient(1.2px 1.2px at 39% 3%, #fff 50%, transparent 51%),
          radial-gradient(1px 1px at 56% 11%, #fff 50%, transparent 51%), radial-gradient(1px 1px at 68% 5%, #fff 50%, transparent 51%), radial-gradient(1.2px 1.2px at 47% 17%, #fff 50%, transparent 51%),
          radial-gradient(1px 1px at 80% 22%, #fff 50%, transparent 51%); }
      ${S} .scn-tw { animation: scn-tw 4s ease-in-out infinite; }
      @keyframes scn-tw { 0%, 100% { opacity: .1; } 12% { opacity: 1; } 30% { opacity: .25; } }
      ${S} .scn-sway { animation: scn-sway 2.6s ease-in-out infinite alternate; }
      @keyframes scn-sway { from { transform: rotate(-6deg) scaleX(.92); } to { transform: rotate(5deg) scaleX(1.04); } }
      ${S} .scn-drift { animation: scn-drift 14s ease-in-out infinite alternate; }
      @keyframes scn-drift { to { transform: translate(-14px, 4px); } }
      ${S} .scn-pulse { animation: scn-pulse 3.2s ease-in-out infinite; }
      @keyframes scn-pulse { 0%, 100% { opacity: 1; } 50% { opacity: .55; } }
      @media (prefers-reduced-motion: reduce) { ${S} .scn-tw, ${S} .scn-sway, ${S} .scn-drift, ${S} .scn-pulse { animation: none; } }
      ${CORNER_CSS(S, LIGHT)}`;
    mount(css, TL + TR + BL + BR);
  }
})();
