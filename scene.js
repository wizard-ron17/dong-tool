// Night scenes: each sport's own sky behind the page, the look Halloween had all year round (a lit sky instead of flat
// black, the cards tinted to it, brighter borders, art in the empty margins), in the sport's own hue. The accent and the
// good/bad ramp stay the app's; only the sky, the surfaces and the borders change.
// PREVIEW ONLY for now: ?bg=night turns it on for this tab (it stays on as you move around), ?bg=off turns it off.
// A holiday stands aside while a scene is previewed, unless asked for by name (?holiday=halloween). chrome.js loads this file.
//
//   nfl   stadium night: a green-navy sky; a bank of stadium lights (top left), a football in a spiral under the lights
//         (top right), the goalposts with an end-zone pylon (bottom left), a lit scoreboard over the crowd (bottom right)
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
  const CORNER_CSS = (S, LIGHT) => `
      ${S} .scn { position: fixed; inset: 0; z-index: 0; pointer-events: none; overflow: hidden; }
      ${S} .scn-c { position: absolute; display: block; height: auto; }
      ${S} .scn-tl { top: 0; left: 0; width: clamp(150px, 23vw, 360px); }
      ${S} .scn-tr { top: 0; right: 0; width: clamp(150px, 23vw, 360px); }
      ${S} .scn-bl { bottom: 0; left: 0; width: clamp(160px, 24vw, 380px); }
      ${S} .scn-br { bottom: 0; right: 0; width: clamp(170px, 26vw, 400px); }
      ${LIGHT} .scn-c { opacity: .38; }
      /* phones: no margins, so the pieces sit behind the page, bigger and stronger than Halloween's (.4) */
      @media (max-width: 760px) { ${S} .scn-tl, ${S} .scn-tr { width: 46vw; } ${S} .scn-bl, ${S} .scn-br { width: 50vw; }
        ${S} .scn-c { opacity: .62; } ${LIGHT} .scn-c { opacity: .32; } }
      ${S} .wrap { position: relative; z-index: 1; }`;

  function nfl() {
    const S = 'html[data-scene="nfl"]', DARK = `${S}:not([data-theme="light"])`, LIGHT = `${S}[data-theme="light"]`;
    const SIL = 'var(--scn-sil)';
    // top left: a bank of stadium lights on a plain mast, its glow, a soft cone of light falling toward the field
    const lamps = [];
    for (let r = 0; r < 4; r++) for (let c = 0; c < 7; c++) lamps.push(`<circle cx="${62 + c * 22}" cy="${54 + r * 20}" r="7"/>`);
    const TL = `<svg class="scn-c scn-tl" viewBox="0 0 400 330">
      <defs><radialGradient id="scn-l1"><stop offset="0" stop-color="var(--scn-light)" stop-opacity=".55"/><stop offset=".5" stop-color="var(--scn-light)" stop-opacity=".14"/><stop offset="1" stop-color="var(--scn-light)" stop-opacity="0"/></radialGradient>
        <linearGradient id="scn-l2" x1="0" y1="0" x2=".6" y2="1"><stop offset="0" stop-color="var(--scn-light)" stop-opacity=".22"/><stop offset="1" stop-color="var(--scn-light)" stop-opacity="0"/></linearGradient></defs>
      <path d="M90 140L400 330H170Z" fill="url(#scn-l2)"/>
      <circle cx="128" cy="84" r="150" fill="url(#scn-l1)"/>
      <path d="M118 140H138L146 330H110Z" fill="${SIL}"/>
      <rect x="44" y="36" width="170" height="104" rx="6" fill="${SIL}"/>
      <rect x="44" y="36" width="170" height="104" rx="6" fill="none" stroke="var(--scn-rim)" stroke-width="2"/>
      <g fill="var(--scn-lamp)">${lamps.join('')}</g>
      <rect x="40" y="26" width="178" height="8" rx="3" fill="${SIL}"/></svg>`;
    // top right: a football in a tight spiral, motion lines behind it, under a big soft glow
    const TR = `<svg class="scn-c scn-tr" viewBox="0 0 400 330">
      <defs><radialGradient id="scn-g1"><stop offset="0" stop-color="var(--scn-light)" stop-opacity=".30"/><stop offset="1" stop-color="var(--scn-light)" stop-opacity="0"/></radialGradient>
        <linearGradient id="scn-ball" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#a0623a"/><stop offset="1" stop-color="#5c3219"/></linearGradient></defs>
      <circle cx="270" cy="120" r="170" fill="url(#scn-g1)"/>
      <g stroke="var(--scn-trail)" stroke-linecap="round" fill="none"><path d="M196 166L84 222" stroke-width="5" opacity=".7"/><path d="M206 184L120 230" stroke-width="3.5" opacity=".5"/><path d="M188 148L110 186" stroke-width="3" opacity=".4"/></g>
      <g transform="translate(262 128) rotate(-28)">
        <ellipse rx="66" ry="38" fill="url(#scn-ball)"/>
        <path d="M-66 0Q-48 -26 -22 -34M66 0Q48 -26 22 -34M-66 0Q-48 26 -22 34M66 0Q48 26 22 34" stroke="rgba(0,0,0,.35)" stroke-width="2" fill="none"/>
        <path d="M-22 -20H22" stroke="#f5efe4" stroke-width="4" stroke-linecap="round"/>
        <path d="M-14 -27V-13M-5 -27V-13M4 -27V-13M13 -27V-13" stroke="#f5efe4" stroke-width="3" stroke-linecap="round"/></g></svg>`;
    // bottom left: the goalposts, wind flags on the uprights, an end-zone pylon, the turf
    const BL = `<svg class="scn-c scn-bl" viewBox="0 0 400 520">
      <defs><linearGradient id="scn-turf" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="var(--scn-turf)"/><stop offset="1" stop-color="${SIL}"/></linearGradient></defs>
      <path d="M0 520V452Q200 436 400 456V520Z" fill="url(#scn-turf)"/>
      <path d="M0 476Q200 462 400 480" stroke="var(--scn-yard)" stroke-width="3" fill="none"/>
      <g fill="none" stroke="var(--scn-post)" stroke-linecap="round" stroke-linejoin="round">
        <path d="M172 470V380Q172 352 200 352" stroke-width="12"/>
        <path d="M80 352H320" stroke-width="10"/>
        <path d="M80 352V40M320 352V40" stroke-width="8"/></g>
      <rect x="160" y="400" width="24" height="70" rx="6" fill="${SIL}"/>
      <path d="M80 44L54 52L80 62Z" fill="var(--scn-flag)"/><path d="M320 44L294 52L320 62Z" fill="var(--scn-flag)"/>
      <path d="M30 472L36 432H54L60 472Z" fill="var(--scn-flag)"/><rect x="32" y="446" width="26" height="5" fill="#fff" opacity=".8"/></svg>`;
    // bottom right: the stands with the crowd in them, a lit scoreboard over them on two legs, flashes in the seats
    const heads = [];
    for (let r = 0; r < 5; r++) for (let c = 0; c < 13; c++) { const x = 130 + c * 21 + (r % 2) * 10 - r * 26; if (x > 10) heads.push(`<circle cx="${x}" cy="${430 - r * 30}" r="7.5"/>`); }
    const flashes = [[160, 404], [252, 374], [118, 344], [330, 404], [210, 314]].map(([x, y]) => `<circle cx="${x}" cy="${y}" r="2.6"/>`).join('');
    const BR = `<svg class="scn-c scn-br" viewBox="0 0 400 520">
      <defs><linearGradient id="scn-turf2" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="var(--scn-turf)"/><stop offset="1" stop-color="${SIL}"/></linearGradient></defs>
      <path d="M400 520V300L20 448V520Z" fill="${SIL}"/>
      <g fill="var(--scn-crowd)">${heads.join('')}</g>
      <g fill="var(--scn-lamp)">${flashes}</g>
      <path d="M0 520V470Q200 456 400 466V520Z" fill="url(#scn-turf2)"/>
      <rect x="196" y="190" width="10" height="160" fill="${SIL}"/><rect x="334" y="190" width="10" height="150" fill="${SIL}"/>
      <rect x="160" y="70" width="222" height="126" rx="8" fill="${SIL}" stroke="var(--scn-rim)" stroke-width="2"/>
      <g font-family="'JetBrains Mono', ui-monospace, monospace" font-weight="700" text-anchor="middle">
        <text x="216" y="102" font-size="15" fill="var(--scn-board-dim)">HOME</text><text x="326" y="102" font-size="15" fill="var(--scn-board-dim)">AWAY</text>
        <text x="216" y="146" font-size="40" fill="var(--scn-board)">24</text><text x="326" y="146" font-size="40" fill="var(--scn-board)">21</text>
        <text x="271" y="180" font-size="16" fill="var(--scn-board-dim)">4TH · 0:42</text></g></svg>`;
    const css = `
      ${DARK} { --bg: #040b0c; --surface0: #081416; --surface1: #0c1b1e; --surface2: #122729; --border: #1b3638; --border2: #285055;
        --glow: rgba(51,208,124,0.10); --scn-sil: #020607; --scn-lamp: #f4f9ff; --scn-light: #d6ebff; --scn-rim: rgba(150,190,200,0.22);
        --scn-post: #e3c13d; --scn-flag: #ff7a1a; --scn-turf: #11432a; --scn-yard: rgba(220,255,235,0.22); --scn-crowd: #0b1a1c;
        --scn-trail: rgba(214,235,255,0.55); --scn-board: #ffcf5a; --scn-board-dim: rgba(255,207,90,0.6); }
      ${LIGHT} { --border: #cfe0dc; --border2: #b4ccc6; --scn-sil: #5c7a74; --scn-lamp: #ffffff; --scn-light: #ffffff; --scn-rim: rgba(255,255,255,0.4);
        --scn-post: #c9a21a; --scn-flag: #e8650c; --scn-turf: #6fb88a; --scn-yard: rgba(255,255,255,0.7); --scn-crowd: #48655f;
        --scn-trail: rgba(60,90,85,0.5); --scn-board: #ffd56a; --scn-board-dim: rgba(255,213,106,0.7); }
      ${DARK} body { background: radial-gradient(900px 520px at 6% 4%, rgba(190,225,255,0.13), transparent 62%),
          radial-gradient(900px 520px at 94% 0%, rgba(190,225,255,0.10), transparent 62%),
          radial-gradient(1200px 700px at 50% 108%, rgba(51,208,124,0.14), transparent 60%), linear-gradient(#071315, #030809) fixed; }
      ${LIGHT} body { background: linear-gradient(#e6f2ee, #eef1f6) fixed; }
      ${DARK} .scn { background-image: radial-gradient(1px 1px at 18% 9%, #fff 50%, transparent 51%), radial-gradient(1.2px 1.2px at 37% 4%, #fff 50%, transparent 51%),
          radial-gradient(1px 1px at 58% 13%, #fff 50%, transparent 51%), radial-gradient(1px 1px at 71% 6%, #fff 50%, transparent 51%), radial-gradient(1.2px 1.2px at 46% 19%, #fff 50%, transparent 51%); }
      ${CORNER_CSS(S, LIGHT)}`;
    mount(css, TL + TR + BL + BR);
  }
})();
