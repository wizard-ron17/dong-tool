// Holiday touches, a few days a year. Each holiday is on for three days, the day before, the day itself and the day
// after (US Eastern), then it's gone with no deploy. Loaded on every page (chrome.js loads it in the apps; the picker has its own tag).
// ?holiday=halloween turns one on any day, to preview it; ?holiday=off turns them all off.
//
//   halloween  a night scene behind the page (the sides and the gaps between cards): moon and a witch, bats, a haunted
//              house, a graveyard with a black cat, bare trees, pumpkins, a potion, cobwebs and a spider; a purple night
//              sky; the accent goes pumpkin orange and borders purple; a jack-o'-lantern for each tool's logo; and a
//              few bats flutter across the top once per visit (none for reduced motion, never in the way of a click)
//   neon       11/19/2026, a big crime-sandbox game's release day (Ron 11/17): a Miami-style neon beach city at sunset behind
//              the page, a striped retro sun over the water, palms, an 80s wedge supercar with side strakes and underglow,
//              art-deco towers trimmed in pink and blue neon (a neon flamingo on one), a police helicopter with its searchlight,
//              and across the middle a distant skyline, a lit causeway and the bay's neon reflections; hot pink accent, neon borders; a palm for each tool's logo; the helicopter
//              crosses the top once per visit. Its own art, no game logos or names. A one-off (year: 2026).
//   thanksgiving  the fourth Thursday of November: an autumn dusk behind the page, a maple in full colour with a hay bale,
//              a corn shock and pumpkins on the left; a turkey in a pilgrim hat by a split-rail fence on the right; rolling
//              hills and a fence line across the middle; amber accent on plum-brown cards; a turkey for each tool's logo;
//              a flurry of leaves drifts down once per visit
(function () {
  if (window.RonHoliday) return;
  const HOLIDAYS = [
    { key: 'halloween', date: '10-31' },
    { key: 'neon', date: '11-19', year: 2026 },
    // the fourth Thursday of November
    { key: 'thanksgiving', date: (y) => { const dow = new Date(Date.UTC(y, 10, 1)).getUTCDay(); return `11-${1 + (4 - dow + 7) % 7 + 21}`; } },
  ];
  let q = new URLSearchParams(location.search).get('holiday');
  try { q = q || sessionStorage.getItem('ronHoliday'); } catch (e) {}       // a preview kept by chrome.js for the tab
  // today in US Eastern, and whether a holiday's month-day is within a day of it (across a month or year end)
  const et = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  const today = Date.UTC(+et.slice(0, 4), +et.slice(5, 7) - 1, +et.slice(8, 10));
  const near = (h) => [-1, 0, 1].some(dy => { const y = +et.slice(0, 4) + dy; if (h.year && y !== h.year) return false; const md = typeof h.date === 'function' ? h.date(y) : h.date; const d = Date.UTC(y, +md.slice(0, 2) - 1, +md.slice(3, 5)); return Math.abs(d - today) <= 864e5; });
  // the sport backgrounds (scene.js) are on by default and a holiday takes over from them on its dates; ?bg=night in the
  // address is a choice someone made (kept for the tab by chrome.js), so the date's holiday steps aside for it
  let scene = /[?&]bg=night\b/.test(location.search);
  try { scene = scene || sessionStorage.getItem('ronScene') === 'night'; } catch (e) {}
  const on = q === 'off' ? null : HOLIDAYS.find(h => h.key === q) || (q || scene ? null : HOLIDAYS.find(near));
  window.RonHoliday = { on: on?.key || null };
  if (!on) return;
  const root = document.documentElement;
  root.setAttribute('data-holiday', on.key);
  // a background already up (scene.js ran first) comes down: the holiday has the page
  if (root.hasAttribute('data-scene')) { root.removeAttribute('data-scene'); document.getElementById('scene-css')?.remove(); document.querySelector('.scn')?.remove(); if (window.RonScene) window.RonScene.on = null; }

  if (on.key === 'halloween') {
    const H = 'html[data-holiday="halloween"]', DARK = `${H}:not([data-theme="light"])`, LIGHT = `${H}[data-theme="light"]`;
    // a lit jack-o'-lantern, the tools' logo for the holiday
    const JACK = '<svg viewBox="0 0 64 64" aria-hidden="true"><path d="M33 15c0-5 2-8 6-10" fill="none" stroke="#5e8f2b" stroke-width="4" stroke-linecap="round"/>'
      + '<ellipse cx="20" cy="38" rx="15" ry="20" fill="#d9621a"/><ellipse cx="44" cy="38" rx="15" ry="20" fill="#d9621a"/><ellipse cx="32" cy="38" rx="13" ry="22" fill="#f28a2e"/>'
      + '<path fill="#ffd25e" d="M16 31l8-7 4 9zM48 31l-8-7-4 9zM29 38h6l-3 5zM14 44q18 14 36 0l-4 1-2 4-4-3-3 4-3-4-3 4-3-4-4 3-2-4z"/></svg>';
    const SIL = 'var(--hol-sil)';
    // the left edge: a bare tree, a graveyard with a black cat on a stone, pumpkins, a cobweb and a spider
    const LEFT = `<svg class="hol-side hol-left" viewBox="0 0 420 900" preserveAspectRatio="xMinYMax meet" aria-hidden="true">
      <g fill="none" stroke="var(--hol-web)" stroke-width="1.3">
        <path d="M0 0L230 0M0 0L215 95M0 0L160 175M0 0L85 225M0 0L0 240"/>
        <path d="M55 0Q50 22 51 23Q38 40 39 41Q19 52 20 53Q0 56 0 58"/><path d="M110 0Q100 44 103 47Q76 80 79 83Q38 104 41 107Q0 114 0 116"/>
        <path d="M170 0Q155 66 159 71Q115 121 119 125Q58 157 62 160Q0 172 0 175"/><path d="M225 0Q206 88 211 94Q152 162 157 168Q78 210 83 214Q0 232 0 236"/></g>
      <path d="M182 0V150" stroke="var(--hol-web)" stroke-width="1"/>
      <g class="hol-spider" fill="${SIL}"><circle cx="182" cy="156" r="6"/><ellipse cx="182" cy="170" rx="8" ry="10"/>
        <path d="M176 160l-12-6-4 6M176 165l-14 0-3 8M176 170l-12 6-2 8M178 175l-8 10M188 160l12-6 4 6M188 165l14 0 3 8M188 170l12 6 2 8M186 175l8 10" stroke="${SIL}" stroke-width="2" fill="none"/></g>
      <path fill="${SIL}" d="M0 905V815Q90 780 210 800T420 815V905Z"/>
      <path fill="${SIL}" d="M58 905L72 640Q62 560 36 498L50 494Q74 550 82 600Q94 538 132 466L144 472Q106 548 98 640L118 905Z"/>
      <g fill="none" stroke="${SIL}" stroke-width="6" stroke-linecap="round"><path d="M78 612Q42 566 8 552"/><path d="M96 566Q150 526 190 474"/><path d="M58 524Q30 480 22 436"/><path d="M120 506Q152 470 182 466"/><path d="M40 552Q20 540 6 520"/><path d="M160 496Q178 468 176 446"/></g>
      <path fill="${SIL}" d="M100 826V788Q100 764 124 764Q148 764 148 788V826ZM160 834V806Q160 788 178 788Q196 788 196 806V834ZM212 834V772H204V758H212V740H224V758H232V772H224V834Z"/>
      <g fill="${SIL}"><ellipse cx="124" cy="744" rx="12" ry="17"/><circle cx="124" cy="722" r="9"/><path d="M115 718l2-12 6 8zM133 718l-2-12-6 8z"/>
        <path d="M135 756q20-2 14-26" stroke="${SIL}" stroke-width="4.5" fill="none" stroke-linecap="round"/></g>
      <circle cx="120" cy="721" r="1.6" fill="#ffd25e"/><circle cx="128" cy="721" r="1.6" fill="#ffd25e"/>
      <g transform="translate(14 836)"><path d="M14 4q1-7 6-9" stroke="#5e8f2b" stroke-width="3" fill="none"/><ellipse cx="7" cy="20" rx="12" ry="15" fill="#c95a17"/><ellipse cx="23" cy="20" rx="12" ry="15" fill="#c95a17"/><ellipse cx="15" cy="20" rx="10" ry="16" fill="#e8792a"/><path fill="#ffd25e" d="M6 16l5-4 2 6zM24 16l-5-4-2 6zM5 24q10 9 20 0l-3 1-2 3-3-2-2 3-2-3-3 2-2-3z"/></g>
      <g transform="translate(58 860) scale(.62)"><path d="M14 4q1-7 6-9" stroke="#5e8f2b" stroke-width="3" fill="none"/><ellipse cx="7" cy="20" rx="12" ry="15" fill="#c95a17"/><ellipse cx="23" cy="20" rx="12" ry="15" fill="#c95a17"/><ellipse cx="15" cy="20" rx="10" ry="16" fill="#e8792a"/></g>
    </svg>`;
    // the right edge: the moon with a witch across it, bats, a haunted house with lit windows, a potion, a cobweb
    const RIGHT = `<svg class="hol-side hol-right" viewBox="0 0 420 900" preserveAspectRatio="xMaxYMax meet" aria-hidden="true">
      <defs><radialGradient id="hol-moon" cx="40%" cy="38%"><stop offset="0" stop-color="#ffe2a3"/><stop offset=".7" stop-color="#f5a04a"/><stop offset="1" stop-color="#e07a2a"/></radialGradient>
        <radialGradient id="hol-halo"><stop offset=".45" stop-color="#ff9a3c" stop-opacity=".28"/><stop offset="1" stop-color="#ff9a3c" stop-opacity="0"/></radialGradient></defs>
      <circle cx="330" cy="128" r="150" fill="url(#hol-halo)"/><circle cx="330" cy="128" r="74" fill="url(#hol-moon)"/>
      <g fill="#b8642a" opacity=".35"><circle cx="306" cy="104" r="11"/><circle cx="352" cy="152" r="14"/><circle cx="348" cy="98" r="6"/><circle cx="300" cy="160" r="7"/></g>
      <g fill="${SIL}" transform="translate(318 132) rotate(-10) scale(.92)">
        <path d="M-96 16L70 -2" stroke="${SIL}" stroke-width="5" stroke-linecap="round"/>
        <path d="M-92 16l-34 -16 8 14-14 4 14 6-10 14z"/>
        <path d="M-2 4q-30 0-58 18l18-24q-14 2-26 0 30-14 52-22z"/>
        <path d="M-8 6q-2-20 6-36l16 6q-2 18-4 30z"/>
        <circle cx="10" cy="-36" r="8"/><path d="M17 -36l8 4-8 1z"/>
        <path d="M-6 -42l30 2q-6-4-12-4l-2-32q-6 2-8 8l6-2q-2 12-4 24q-6 0-10 4z"/>
        <path d="M8 -24q12 6 22 22l-4 3q-10-12-20-16z"/>
        <path d="M2 6l14 14 8-2 2 4-12 2-16-14z"/></g>
      <g fill="${SIL}"><path transform="translate(226 196) scale(.7)" d="M32 13c-1.6-1.8-2.6-1.6-3.2-.2C24 9 15 4.6 3 7.4c5 1.6 7.8 4.6 8.4 9 3-1.8 6.4-1.6 8.6.4 2.2-2 5.6-1.6 7.6 1.4 1.4-.6 3-.4 4.4.6 1.4-1 3-1.2 4.4-.6 2-3 5.4-3.4 7.6-1.4 2.2-2 5.6-2.2 8.6-.4.6-4.4 3.4-7.4 8.4-9C49 4.6 40 9 36.8 13.8z"/>
        <path transform="translate(352 210) scale(.55)" d="M32 13c-1.6-1.8-2.6-1.6-3.2-.2C24 9 15 4.6 3 7.4c5 1.6 7.8 4.6 8.4 9 3-1.8 6.4-1.6 8.6.4 2.2-2 5.6-1.6 7.6 1.4 1.4-.6 3-.4 4.4.6 1.4-1 3-1.2 4.4-.6 2-3 5.4-3.4 7.6-1.4 2.2-2 5.6-2.2 8.6-.4.6-4.4 3.4-7.4 8.4-9C49 4.6 40 9 36.8 13.8z"/>
        <path transform="translate(230 40) scale(.5)" d="M32 13c-1.6-1.8-2.6-1.6-3.2-.2C24 9 15 4.6 3 7.4c5 1.6 7.8 4.6 8.4 9 3-1.8 6.4-1.6 8.6.4 2.2-2 5.6-1.6 7.6 1.4 1.4-.6 3-.4 4.4.6 1.4-1 3-1.2 4.4-.6 2-3 5.4-3.4 7.6-1.4 2.2-2 5.6-2.2 8.6-.4.6-4.4 3.4-7.4 8.4-9C49 4.6 40 9 36.8 13.8z"/></g>
      <path fill="${SIL}" d="M0 905V846Q160 820 420 830V905Z"/>
      <path fill="${SIL}" d="M276 905V656H262L340 584L418 656H404V905ZM244 905V610H238L268 520L298 610H292V905ZM384 905V628H378L402 556L426 628H420V905Z"/>
      <g fill="#ffbe55" opacity=".9"><path d="M260 652v-18q8-10 16 0v18zM300 708v-22q10-12 20 0v22zM354 708v-22q10-12 20 0v22zM300 788v-22q10-12 20 0v22zM396 676v-16q6-9 12 0v16z"/></g>
      <path fill="#0d0816" d="M332 905v-42q12-16 24 0v42z" opacity=".8"/>
      <g transform="translate(212 822)"><path d="M-8 -34h16v8h-16z" fill="#8a5a3c"/><path d="M-6 -26h12v14h-12z" fill="var(--hol-glass)"/><circle cy="10" r="26" fill="var(--hol-glass)"/>
        <path d="M-24 14a26 26 0 0 0 48 0q-12-8-24 0t-24 0z" fill="#9b6bff"/><circle cx="-6" cy="4" r="3" fill="#cdb6ff"/><circle cx="6" cy="-8" r="2" fill="#cdb6ff"/><circle cx="-10" cy="-2" r="5" fill="#ffffff" opacity=".18"/></g>
      <g fill="none" stroke="var(--hol-web)" stroke-width="1.3">
        <path d="M420 900L190 900M420 900L205 805M420 900L260 725M420 900L335 675M420 900L420 660"/>
        <path d="M365 900Q370 878 369 877Q382 860 381 859Q401 848 400 847Q420 844 420 842"/><path d="M310 900Q320 856 317 853Q344 820 341 817Q382 796 379 793Q420 786 420 784"/>
        <path d="M250 900Q265 834 261 829Q305 779 301 775Q362 743 358 740Q420 728 420 725"/></g>
    </svg>`;
    const css = `
      ${DARK} { --accent: #ff8a1f; --glow: rgba(255,138,31,0.08); --bg: #0b0716; --surface0: #100b1e; --surface1: #151029; --surface2: #1d1638;
        --border: #2d2148; --border2: #3d2e62; --card: #120c22; --card2: #181030; --hol-sil: #05030a; --hol-web: rgba(205,190,240,0.30); --hol-glass: rgba(200,220,255,0.16); }
      ${LIGHT} { --accent: #d9620b; --glow: rgba(217,98,11,0.07); --border: #ddd0ee; --border2: #cbb8e4; --hol-sil: #3b2d55; --hol-web: rgba(80,60,120,0.30); --hol-glass: rgba(80,60,120,0.12); }
      ${DARK} body { background: radial-gradient(1100px 700px at 92% 0%, rgba(140,70,210,0.30), transparent 62%),
          radial-gradient(900px 600px at 0% 100%, rgba(242,138,46,0.12), transparent 60%), linear-gradient(#120a24, #0a0614) fixed; }
      ${LIGHT} body { background: linear-gradient(#efe4ff, #ffe8d4) fixed; }
      ${DARK} { background-color: #0a0614; } ${LIGHT} { background-color: #ffe8d4; }   /* overscroll past the page ends: the sky's colour, not white */
      ${H} .hol-scene { position: fixed; inset: 0; z-index: 0; pointer-events: none; overflow: hidden; }
      ${DARK} .hol-scene { background-image: radial-gradient(1.2px 1.2px at 8% 12%, #fff 50%, transparent 51%), radial-gradient(1px 1px at 22% 30%, #fff 50%, transparent 51%),
          radial-gradient(1.4px 1.4px at 41% 8%, #fff 50%, transparent 51%), radial-gradient(1px 1px at 63% 22%, #fff 50%, transparent 51%), radial-gradient(1.2px 1.2px at 78% 38%, #fff 50%, transparent 51%),
          radial-gradient(1px 1px at 93% 52%, #fff 50%, transparent 51%), radial-gradient(1.3px 1.3px at 5% 60%, #fff 50%, transparent 51%), radial-gradient(1px 1px at 52% 46%, #fff 50%, transparent 51%); opacity: .9; }
      ${H} .hol-side { position: absolute; bottom: 0; height: 100vh; width: auto; max-width: 48vw; }
      ${H} .hol-left { left: 0; } ${H} .hol-right { right: 0; }
      ${LIGHT} .hol-side { opacity: .55; }
      @media (max-width: 760px) { ${H} .hol-side { opacity: .4; } }
      ${H} .wrap { position: relative; z-index: 1; }
      ${H} .tb-brand h1 em { color: #ff8a1f; } ${LIGHT} .tb-brand h1 em { color: #d9620b; }
      ${H} .brand-home > :not(.hol-jack) { display: none !important; }
      .hol-jack { display: inline-flex; width: 34px; height: 34px; } .hol-jack svg { width: 100%; height: 100%; }
      .hol-jack-title { width: 0.85em; height: 0.85em; margin-left: 0.2em; vertical-align: -0.08em; display: inline-block; }
      .hol-spider { animation: hol-dangle 5s ease-in-out infinite alternate; }
      @keyframes hol-dangle { to { transform: translateY(26px); } }
      @media (prefers-reduced-motion: reduce) { .hol-spider { animation: none; } }
      .hol-bats { position: fixed; inset: 0 0 auto 0; height: 45vh; pointer-events: none; z-index: 2147483000; overflow: hidden; }
      .hol-bat { position: absolute; left: 0; top: 0; width: 46px; height: 23px; color: #d9cdf5; opacity: 0.88; }
      ${LIGHT} .hol-bat { color: #2a2140; }
      .hol-bat svg { width: 100%; height: 100%; display: block; animation: hol-flap 0.16s ease-in-out infinite alternate; transform-origin: 50% 60%; }
      @keyframes hol-flap { to { transform: scaleY(0.62); } }`;
    const style = document.createElement('style'); style.id = 'holiday-css'; style.textContent = css; document.head.appendChild(style);

    // the scene behind the page, a jack-o'-lantern for each tool's logo (the picker's title gets one beside it)
    const deco = () => {
      if (document.body && !document.querySelector('.hol-scene')) document.body.insertAdjacentHTML('afterbegin', `<div class="hol-scene" aria-hidden="true">${LEFT}${RIGHT}</div>`);
      for (const a of document.querySelectorAll('.brand-home')) if (!a.querySelector('.hol-jack')) a.insertAdjacentHTML('afterbegin', `<span class="hol-jack">${JACK}</span>`);
      const brand = document.querySelector('body > .wrap > .brand');
      if (brand && !brand.querySelector('.hol-jack-title')) brand.insertAdjacentHTML('beforeend', JACK.replace('<svg ', '<svg class="hol-jack-title" '));
    };

    // a handful of bats across the top, once a visit
    const BAT = '<svg viewBox="0 0 64 32" aria-hidden="true"><path fill="currentColor" d="M32 13c-1.6-1.8-2.6-1.6-3.2-.2-.3-1.6-.9-2.2-1.6-2.4.5 1.2.4 2.4 0 3.4C24 9 15 4.6 3 7.4c5 1.6 7.8 4.6 8.4 9 3-1.8 6.4-1.6 8.6.4 2.2-2 5.6-1.6 7.6 1.4 1.4-.6 3-.4 4.4.6 1.4-1 3-1.2 4.4-.6 2-3 5.4-3.4 7.6-1.4 2.2-2 5.6-2.2 8.6-.4.6-4.4 3.4-7.4 8.4-9C49 4.6 40 9 36.8 13.8c-.4-1-.5-2.2 0-3.4-.7.2-1.3.8-1.6 2.4-.6-1.4-1.6-1.6-3.2.2z"/></svg>';
    const bats = () => {
      if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
      try { if (!q && sessionStorage.getItem('holBats') === on.key) return; sessionStorage.setItem('holBats', on.key); } catch (e) {}
      const box = document.createElement('div'); box.className = 'hol-bats'; box.setAttribute('aria-hidden', 'true');
      document.body.appendChild(box);
      const W = window.innerWidth, Hh = box.clientHeight, n = W < 600 ? 3 : 5;
      let last = 0;
      for (let i = 0; i < n; i++) {
        const b = document.createElement('div'); b.className = 'hol-bat'; b.innerHTML = BAT;
        const s = 0.75 + Math.random() * 0.6, y0 = Hh * (0.12 + Math.random() * 0.6), amp = 18 + Math.random() * 36;
        const dur = 2600 + Math.random() * 1800, delay = i * 260 + Math.random() * 300, rtl = Math.random() < 0.35;
        const frames = [0, 0.25, 0.5, 0.75, 1].map((t, k) => {
          const x = rtl ? W + 40 - t * (W + 120) : -80 + t * (W + 120), y = y0 + Math.sin(t * Math.PI * 2.2 + i) * amp - t * Hh * 0.18;
          return { transform: `translate(${x}px, ${y}px) scale(${rtl ? -s : s}, ${s})`, opacity: k === 0 || k === 4 ? 0 : 1 };
        });
        box.appendChild(b);
        b.animate(frames, { duration: dur, delay, easing: 'linear', fill: 'both' });
        last = Math.max(last, dur + delay);
      }
      setTimeout(() => box.remove(), last + 200);
    };

    const go = () => { deco(); setTimeout(bats, 500); };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', go); else go();
    // the apps draw their header late on some routes: a second look once everything has loaded
    window.addEventListener('load', deco);
  }
  if (on.key === 'neon') {
    const H = 'html[data-holiday="neon"]', DARK = `${H}:not([data-theme="light"])`, LIGHT = `${H}[data-theme="light"]`;
    const SIL = 'var(--neo-sil)';
    // a palm: a curved trunk and drooping fronds, its crown at (x - lean, y - h)
    const palm = (x, y, h, lean, s = 1) => {
      const tx = x - lean, ty = y - h, fr = [[-118, 34], [-84, 58], [-40, 70], [10, 66], [56, 52], [96, 30], [-70, -14], [64, -18]];
      return `<g fill="${SIL}"><path d="M${x - 7 * s} ${y}Q${x - lean * 0.35} ${y - h * 0.55} ${tx - 3 * s} ${ty}L${tx + 3 * s} ${ty}Q${x - lean * 0.35 + 9 * s} ${y - h * 0.55} ${x + 7 * s} ${y}Z"/>`
        + fr.map(([dx, dy]) => { const ex = tx + dx * s, ey = ty + dy * s, mx = tx + dx * 0.5 * s, my = ty + Math.min(dy, 0) * s - 26 * s;
          return `<path d="M${tx} ${ty}Q${mx} ${my - 8 * s} ${ex} ${ey}Q${mx} ${my + 10 * s} ${tx} ${ty + 4 * s}Z"/>`; }).join('')
        + `<circle cx="${tx - 3 * s}" cy="${ty + 6 * s}" r="${4 * s}"/><circle cx="${tx + 4 * s}" cy="${ty + 7 * s}" r="${4 * s}"/></g>`;
    };
    // a palm in the tools' logo: cyan over a pink sun
    const PALM = '<svg viewBox="0 0 64 64" aria-hidden="true"><defs><linearGradient id="neo-lg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ffd166"/><stop offset="1" stop-color="#ff3d9a"/></linearGradient></defs>'
      + '<circle cx="34" cy="38" r="20" fill="url(#neo-lg)"/><g fill="#0b0618"><rect x="12" y="44" width="44" height="3"/><rect x="12" y="50" width="44" height="4"/></g>'
      + '<g fill="#2ee6f0"><path d="M28 62Q31 44 26 24L30 24Q36 44 33 62Z"/><path d="M28 23Q16 14 4 20Q16 18 27 26Z"/><path d="M28 23Q22 8 10 6Q22 12 26 25Z"/><path d="M29 23Q34 8 46 6Q36 14 31 25Z"/><path d="M29 23Q42 14 56 20Q42 19 31 26Z"/><path d="M28 24Q20 26 14 36Q22 30 29 26Z"/><path d="M30 24Q38 26 44 36Q36 30 30 26Z"/></g></svg>';
    // the left edge: the striped sun setting into the water, palms, the beach road with a sports car and its underglow
    const LEFT = `<svg class="hol-side hol-left" viewBox="0 0 420 900" preserveAspectRatio="xMinYMax meet" aria-hidden="true">
      <defs><linearGradient id="neo-sun" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ffe066"/><stop offset=".55" stop-color="#ff7a59"/><stop offset="1" stop-color="#ff2e88"/></linearGradient>
        <radialGradient id="neo-halo"><stop offset=".35" stop-color="#ff4f9a" stop-opacity=".45"/><stop offset="1" stop-color="#ff4f9a" stop-opacity="0"/></radialGradient>
        <mask id="neo-stripes"><rect width="420" height="900" fill="#fff"/><g fill="#000"><rect y="600" width="420" height="5"/><rect y="618" width="420" height="7"/><rect y="638" width="420" height="9"/><rect y="660" width="420" height="11"/></g></mask>
        <linearGradient id="neo-sea" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#3a1260"/><stop offset="1" stop-color="#14082a"/></linearGradient>
        <radialGradient id="neo-glow"><stop offset="0" stop-color="#ff2e88" stop-opacity=".85"/><stop offset="1" stop-color="#ff2e88" stop-opacity="0"/></radialGradient>
        <filter id="neo-neon" x="-20%" y="-50%" width="140%" height="200%"><feGaussianBlur stdDeviation="2.2" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter><linearGradient id="neo-fl"><stop offset=".6" stop-color="#fff"/><stop offset="1" stop-color="#000"/></linearGradient><mask id="neo-ml"><rect width="420" height="905" fill="url(#neo-fl)"/></mask></defs>
      <circle cx="150" cy="600" r="230" fill="url(#neo-halo)"/>
      <circle cx="150" cy="600" r="118" fill="url(#neo-sun)" mask="url(#neo-stripes)"/>
      <g mask="url(#neo-ml)"><rect y="686" width="420" height="120" fill="url(#neo-sea)"/>
      <g stroke="#ff7ab8" stroke-linecap="round" opacity=".75"><path d="M70 700h160M96 714h108M50 728h70M150 728h120M110 744h80M60 762h50M180 760h90" stroke-width="2.5"/></g>
      <g stroke="#2ee6f0" stroke-linecap="round" opacity=".35"><path d="M250 708h60M300 736h70M20 750h30" stroke-width="2"/></g>
      ${palm(70, 830, 330, -40, 1.05)}${palm(205, 840, 230, 30, .8)}${palm(18, 850, 200, -20, .7)}
      <path fill="${SIL}" d="M0 905V806Q120 794 260 806T420 812V905Z"/>
      <path d="M0 846H420" stroke="#ff2e88" stroke-width="1.5" opacity=".5"/></g>
      <ellipse cx="250" cy="866" rx="130" ry="14" fill="url(#neo-glow)"/>
      <g transform="translate(96 788) scale(1.18)">
        <path fill="#0a0612" stroke="#ff4fa3" stroke-width="1.6" stroke-linejoin="round" filter="url(#neo-neon)" d="M0 40L3 31L36 27L86 12Q94 9 106 9L160 10Q170 11 178 16L204 24L250 27Q262 29 263 37L263 49H0Z"/>
        <path fill="#0a0612" d="M0 40L3 31L36 27L86 12Q94 9 106 9L160 10Q170 11 178 16L204 24L250 27Q262 29 263 37L263 49H0Z"/>
        <path fill="#2ee6f0" opacity=".55" d="M92 14Q98 11 108 11L156 12L172 24H96Z"/><path d="M128 12V24" stroke="#0a0612" stroke-width="3"/>
        <g stroke="#ff4fa3" stroke-width="1.2" opacity=".85"><path d="M150 30H214M152 34H216M154 38H218M156 42H220M158 46H222"/></g>
        <path d="M36 28H250" stroke="#2ee6f0" stroke-width="1" opacity=".6"/>
        <rect x="0" y="33" width="34" height="5" fill="#ff2a4a"/><g stroke="#0a0612" stroke-width="1.4"><path d="M6 33V38M12 33V38M18 33V38M24 33V38M30 33V38"/></g>
        <rect x="254" y="32" width="9" height="3" rx="1" fill="#fff4c2"/>
        <g fill="#0a0612" stroke="#2ee6f0" stroke-width="1.6"><circle cx="54" cy="49" r="14"/><circle cx="214" cy="49" r="14"/></g>
        <g stroke="#2ee6f0" stroke-width="1.2" opacity=".8"><path d="M54 41V57M46 49H62M48 43L60 55M60 43L48 55"/><path d="M214 41V57M206 49H222M208 43L220 55M220 43L208 55"/></g>
        <path d="M0 50H263" stroke="#ff4fa3" stroke-width="2" filter="url(#neo-neon)"/></g>
    </svg>`;
    // the right edge: a lit skyline over the water, one tower in neon, a police helicopter and its searchlight, a palm in front
    // an art-deco tower: a stepped or rounded crown, a lit window grid, neon trim (pink or cyan) on its edges and bands
    const WIN = ['#ffd166', '#ff7ab8', '#2ee6f0', '#ffe9a8'];
    const tower = (x, w, top, o = {}) => {
      const neon = o.neon || '#2ee6f0', c = x + w / 2;
      let r = `<rect x="${x}" y="${top}" width="${w}" height="${905 - top}" fill="${SIL}"/>`;
      if (o.crown === 'step') r += `<rect x="${x + w * 0.15}" y="${top - 18}" width="${w * 0.7}" height="19" fill="${SIL}"/><rect x="${x + w * 0.32}" y="${top - 34}" width="${w * 0.36}" height="17" fill="${SIL}"/>`
        + `<path d="M${x} ${top}H${x + w * 0.15}V${top - 18}H${x + w * 0.32}V${top - 34}H${x + w * 0.68}V${top - 18}H${x + w * 0.85}V${top}H${x + w}" fill="none" stroke="${neon}" stroke-width="1.6" filter="url(#neo-neon)"/>`;
      if (o.crown === 'dome') r += `<path d="M${x} ${top}A${w / 2} ${w * 0.42} 0 0 1 ${x + w} ${top}Z" fill="${SIL}"/><path d="M${x} ${top}A${w / 2} ${w * 0.42} 0 0 1 ${x + w} ${top}" fill="none" stroke="${neon}" stroke-width="1.6" filter="url(#neo-neon)"/>`
        + `<path d="M${c} ${top - w * 0.42}V${top - w * 0.42 - 34}" stroke="${SIL}" stroke-width="3"/><circle cx="${c}" cy="${top - w * 0.42 - 36}" r="3" fill="#ff2a4a"/>`;
      if (o.crown === 'spire') r += `<path d="M${x + 4} ${top}L${c} ${top - 40}L${x + w - 4} ${top}Z" fill="${SIL}"/><path d="M${c} ${top - 40}V${top - 78}" stroke="${SIL}" stroke-width="3"/><circle cx="${c}" cy="${top - 80}" r="3.5" fill="#ff2a4a"/>`
        + `<path d="M${x + 4} ${top}L${c} ${top - 40}L${x + w - 4} ${top}" fill="none" stroke="${neon}" stroke-width="1.6" filter="url(#neo-neon)"/>`;
      for (let yy = top + 12; yy < 800; yy += 14) for (let xx = x + 5; xx < x + w - 6; xx += 9) { const k = (xx * 7 + yy * 3) % 13; if (k < 5) r += `<rect x="${xx}" y="${yy}" width="4" height="6" fill="${WIN[k % WIN.length]}" opacity="${k < 2 ? 1 : 0.7}"/>`; }
      if (o.bands) for (let yy = top + 60; yy < 760; yy += o.bands) r += `<path d="M${x} ${yy}H${x + w}" stroke="${neon}" stroke-width="1.3" opacity=".8" filter="url(#neo-neon)"/>`;
      if (o.fin) r += `<path d="M${c} ${top + 8}V780" stroke="${o.fin}" stroke-width="2.2" filter="url(#neo-neon)"/>`;
      if (o.edge) r += `<path d="M${x + 0.5} 790V${top}M${x + w - 0.5} ${top}V790" stroke="${neon}" stroke-width="1.4" opacity=".9" filter="url(#neo-neon)"/>`;
      if (o.balc) for (let yy = top + 30; yy < 780; yy += 22) r += `<path d="M${x - 3} ${yy}H${x + w + 3}" stroke="${SIL}" stroke-width="3"/>`;
      return r;
    };
    // a neon flamingo on a rooftop, pink tubing
    const FLAMINGO = (x, y) => `<g transform="translate(${x} ${y})" fill="none" stroke="#ff4fa3" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" filter="url(#neo-neon)">
        <path d="M0 0Q-6 -10 2 -14Q10 -16 8 -6Q6 4 12 12"/><path d="M-2 -13L-9 -10L-3 -9"/><ellipse cx="22" cy="18" rx="14" ry="8"/><path d="M34 16L42 12"/><path d="M20 26V48M24 26L28 36L22 40"/></g>`;
    const RIGHT = `<svg class="hol-side hol-right" viewBox="0 0 420 900" preserveAspectRatio="xMaxYMax meet" aria-hidden="true">
      <defs><linearGradient id="neo-beam" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fff" stop-opacity=".38"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></linearGradient>
        <linearGradient id="neo-fr"><stop offset="0" stop-color="#000"/><stop offset=".45" stop-color="#fff"/></linearGradient><mask id="neo-mr"><rect width="420" height="905" fill="url(#neo-fr)"/></mask></defs>
      <path d="M262 132L150 540L240 540Z" fill="url(#neo-beam)"/>
      <g fill="${SIL}" transform="translate(240 104)"><ellipse cx="26" cy="22" rx="28" ry="14"/><path d="M48 18L118 14L120 20L50 28Z"/><path d="M112 6L122 4L124 22L116 22Z"/>
        <path d="M-38 2H92" stroke="${SIL}" stroke-width="3" stroke-linecap="round"/><path d="M26 8V2" stroke="${SIL}" stroke-width="4"/>
        <path d="M2 40H56M10 34V40M44 34V40" stroke="${SIL}" stroke-width="3" fill="none"/><path fill="#2ee6f0" opacity=".6" d="M2 20Q4 12 16 10L18 22Z"/>
        <circle cx="54" cy="12" r="2.5" fill="#ff2a4a"/><circle cx="18" cy="34" r="2.5" fill="#3d7bff"/></g>
      ${tower(150, 44, 520, { crown: 'step', neon: '#ff4fa3', balc: 1 })}${tower(200, 62, 340, { crown: 'dome', neon: '#2ee6f0', fin: '#ff4fa3', bands: 90 })}
      ${tower(268, 42, 450, { crown: 'step', neon: '#2ee6f0', edge: 1 })}${tower(316, 58, 250, { crown: 'spire', neon: '#ff4fa3', bands: 70, edge: 1 })}${tower(380, 44, 410, { crown: 'step', neon: '#2ee6f0', balc: 1 })}
      ${FLAMINGO(280, 380)}
      <g transform="translate(206 300)"><rect width="50" height="14" rx="3" fill="${SIL}" stroke="#2ee6f0" stroke-width="1.4" filter="url(#neo-neon)"/><path d="M8 7H42" stroke="#ff4fa3" stroke-width="2.4" stroke-linecap="round" stroke-dasharray="5 3" filter="url(#neo-neon)"/></g>
      <g mask="url(#neo-mr)"><rect y="790" width="420" height="115" fill="#14082a"/></g>
      <g stroke-linecap="round" opacity=".7"><path d="M210 800V880M226 806V870M232 800V890" stroke="#ff4fa3" stroke-width="2" stroke-dasharray="6 5"/><path d="M344 802V890M352 808V880" stroke="#2ee6f0" stroke-width="2" stroke-dasharray="6 5"/><path d="M180 812h30M300 818h24M390 806h20" stroke="#ffd166" stroke-width="2"/></g>
      ${palm(372, 890, 260, 40, .9)}${palm(412, 900, 180, -10, .65)}
      <path fill="${SIL}" mask="url(#neo-mr)" d="M0 905V860Q300 846 420 856V905Z"/>
      <path d="M150 872Q300 858 420 866" stroke="#2ee6f0" stroke-width="1.5" fill="none" opacity=".6" mask="url(#neo-mr)"/>
    </svg>`;
    // the middle, full width behind the sides: sunset cloud streaks, a distant skyline on the horizon, the lit causeway
    // across the bay, and the water with neon reflections, so the space between the cards is a view, not a blank sky
    const MID = (() => {
      let city = '', lights = '';
      for (let x = 0, k = 0; x < 1600; k++) { const w = 18 + (k * 37) % 30, h = 22 + (k * 53) % 70; city += `<rect x="${x}" y="${120 - h}" width="${w}" height="${h + 2}"/>`;
        for (let j = 0; j < 3; j++) if ((k + j) % 3) lights += `<rect x="${x + 4 + (j * 11) % Math.max(6, w - 8)}" y="${120 - h + 6 + ((k * 7 + j * 13) % Math.max(6, h - 12))}" width="2.5" height="3"/>`; x += w + 2; }
      let pier = ''; for (let x = 20; x < 1600; x += 34) pier += `<circle cx="${x}" cy="150" r="1.8"/>`;
      let arch = ''; for (let x = 0; x < 1600; x += 68) arch += `<path d="M${x} 158Q${x + 34} 138 ${x + 68} 158"/>`;
      return `<svg class="neo-mid" viewBox="0 0 1600 300" preserveAspectRatio="xMidYMax slice" aria-hidden="true">
        <defs><linearGradient id="neo-bay" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#3d1466"/><stop offset="1" stop-color="#10061f"/></linearGradient></defs>
        <g fill="var(--neo-far)">${city}</g><g fill="#ffd9a0" opacity=".55">${lights}</g>
        <path d="M0 120H1600" stroke="#ff4fa3" stroke-width="1.5" opacity=".7" filter="url(#neo-neon)"/>
        <rect y="120" width="1600" height="180" fill="url(#neo-bay)"/>
        <path d="M0 150H1600" stroke="var(--neo-far)" stroke-width="5"/><g fill="none" stroke="var(--neo-far)" stroke-width="3">${arch}</g><g fill="#ffd166">${pier}</g>
        <g stroke-linecap="round" opacity=".55"><path d="M120 190h90M420 214h140M760 200h110M1040 222h160M1320 196h120M260 250h70M600 262h150M980 258h90M1400 246h80" stroke="#ff4fa3" stroke-width="2.5"/>
          <path d="M60 230h60M500 236h80M880 236h60M1180 240h90M700 284h120M1240 280h70" stroke="#2ee6f0" stroke-width="2"/></g>
      </svg>`;
    })();
    const CLOUDS = `<svg class="neo-sky" viewBox="0 0 1600 400" preserveAspectRatio="xMidYMax slice" aria-hidden="true"><g fill="none" stroke-linecap="round">
        <path d="M80 300h420M560 280h300M980 310h460M300 340h260M760 350h380M1180 260h260" stroke="#ff7ab8" stroke-width="7" opacity=".18"/>
        <path d="M200 240h260M700 230h220M1100 220h300M40 360h200M1300 370h220" stroke="#b28cff" stroke-width="5" opacity=".16"/></g></svg>`;
    const css = `
      ${DARK} { --accent: #ff3d9a; --glow: rgba(255,61,154,0.10); --bg: #11061f; --surface0: #150926; --surface1: #1a0c31; --surface2: #241242;
        --border: #4a1d63; --border2: #6b2a86; --card: #140928; --card2: #1b0e36; --neo-sil: #07030d; }
      ${LIGHT} { --accent: #d4157a; --glow: rgba(212,21,122,0.07); --border: #f0c6e2; --border2: #e2a6d0; --neo-sil: #4a2366; }
      ${DARK} body { background: radial-gradient(1000px 640px at 10% 100%, rgba(255,90,120,0.28), transparent 62%),
          radial-gradient(900px 600px at 95% 0%, rgba(120,60,220,0.30), transparent 62%), linear-gradient(#1a0833, #3a0f4f 55%, #5a1650) fixed; }
      ${LIGHT} body { background: linear-gradient(#ffe6f4, #ffd6c2) fixed; }
      ${DARK} { background-color: #5a1650; } ${LIGHT} { background-color: #ffd6c2; }
      ${H} .hol-scene { position: fixed; inset: 0; z-index: 0; pointer-events: none; overflow: hidden; }
      ${DARK} .hol-scene { background-image: radial-gradient(1.2px 1.2px at 12% 10%, #fff 50%, transparent 51%), radial-gradient(1px 1px at 30% 22%, #fff 50%, transparent 51%),
          radial-gradient(1.3px 1.3px at 47% 6%, #fff 50%, transparent 51%), radial-gradient(1px 1px at 70% 16%, #fff 50%, transparent 51%), radial-gradient(1.1px 1.1px at 88% 30%, #fff 50%, transparent 51%); opacity: .7; }
      ${H} .hol-side { position: absolute; bottom: 0; height: 100vh; width: auto; max-width: 48vw; }
      ${H} .neo-mid { position: absolute; left: 0; bottom: 0; width: 100%; height: 40vh; }
      ${H} .neo-sky { position: absolute; left: 0; bottom: 34vh; width: 100%; height: 40vh; }
      ${DARK} { --neo-far: #2a1046; } ${LIGHT} { --neo-far: #c9a3d9; }
      ${LIGHT} .neo-mid, ${LIGHT} .neo-sky { opacity: .5; }
      ${H} .hol-left { left: 0; } ${H} .hol-right { right: 0; }
      ${LIGHT} .hol-side { opacity: .55; }
      @media (max-width: 760px) { ${H} .hol-side { opacity: .4; } }
      ${H} .wrap { position: relative; z-index: 1; }
      ${H} .tb-brand h1 em { color: #ff3d9a; } ${LIGHT} .tb-brand h1 em { color: #d4157a; }
      ${DARK} .tb-brand h1 em { text-shadow: 0 0 14px rgba(255,61,154,.55); }
      ${H} .brand-home > :not(.hol-jack) { display: none !important; }
      .hol-jack { display: inline-flex; width: 34px; height: 34px; } .hol-jack svg { width: 100%; height: 100%; }
      .hol-jack-title { width: 0.85em; height: 0.85em; margin-left: 0.2em; vertical-align: -0.08em; display: inline-block; }
      .neo-heli { position: fixed; left: 0; top: 0; width: 120px; height: 46px; pointer-events: none; z-index: 2147483000; color: #e9d8ff; opacity: .9; }
      ${LIGHT} .neo-heli { color: #3a1f55; }
      .neo-heli svg { width: 100%; height: 100%; display: block; }
      .neo-rotor { animation: neo-spin .09s linear infinite alternate; transform-origin: 50% 50%; transform-box: fill-box; }
      @keyframes neo-spin { to { transform: scaleX(0.25); } }`;
    const style = document.createElement('style'); style.id = 'holiday-css'; style.textContent = css; document.head.appendChild(style);

    const deco = () => {
      if (document.body && !document.querySelector('.hol-scene')) document.body.insertAdjacentHTML('afterbegin', `<div class="hol-scene" aria-hidden="true">${CLOUDS}${MID}${LEFT}${RIGHT}</div>`);
      for (const a of document.querySelectorAll('.brand-home')) if (!a.querySelector('.hol-jack')) a.insertAdjacentHTML('afterbegin', `<span class="hol-jack">${PALM}</span>`);
      const brand = document.querySelector('body > .wrap > .brand');
      if (brand && !brand.querySelector('.hol-jack-title')) brand.insertAdjacentHTML('beforeend', PALM.replace('<svg ', '<svg class="hol-jack-title" '));
    };
    // the police helicopter crosses the top once a visit, its lights blinking
    const HELI = '<svg viewBox="0 0 120 46" aria-hidden="true"><path class="neo-rotor" d="M6 6H96" stroke="currentColor" stroke-width="3" stroke-linecap="round"/><path d="M51 6V11" stroke="currentColor" stroke-width="4"/>'
      + '<g fill="currentColor"><ellipse cx="50" cy="22" rx="24" ry="11"/><path d="M70 18L110 15L111 20L72 26Z"/><path d="M106 8L114 7L115 21L108 21Z"/></g>'
      + '<path d="M30 38H68M36 33V38M62 33V38" stroke="currentColor" stroke-width="2.5" fill="none"/><path fill="#2ee6f0" opacity=".7" d="M28 21Q30 14 40 13L41 22Z"/>'
      + '<circle cx="74" cy="13" r="2.4" fill="#ff2a4a"><animate attributeName="opacity" values="1;0;1" dur=".8s" repeatCount="indefinite"/></circle>'
      + '<circle cx="44" cy="33" r="2.4" fill="#3d7bff"><animate attributeName="opacity" values="0;1;0" dur=".8s" repeatCount="indefinite"/></circle></svg>';
    const heli = () => {
      if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
      try { if (!q && sessionStorage.getItem('holBats') === on.key) return; sessionStorage.setItem('holBats', on.key); } catch (e) {}
      const h = document.createElement('div'); h.className = 'neo-heli'; h.innerHTML = HELI; h.setAttribute('aria-hidden', 'true');
      document.body.appendChild(h);
      const W = window.innerWidth, y = Math.min(140, window.innerHeight * 0.14), s = W < 600 ? 0.6 : 0.85;
      const a = h.animate([0, 0.5, 1].map((t, k) => ({ transform: `translate(${W + 40 - t * (W + 200)}px, ${y + Math.sin(t * Math.PI) * 22}px) scale(${s}) rotate(${k === 1 ? -4 : -6}deg)`, opacity: k === 1 ? 0.9 : 0 })),
        { duration: 7000, delay: 600, easing: 'linear', fill: 'both' });
      a.onfinish = () => h.remove();
    };
    const go = () => { deco(); heli(); };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', go); else go();
    window.addEventListener('load', deco);
  }
  if (on.key === 'thanksgiving') {
    const H = 'html[data-holiday="thanksgiving"]', DARK = `${H}:not([data-theme="light"])`, LIGHT = `${H}[data-theme="light"]`;
    const SIL = 'var(--tg-sil)';
    const LEAFC = ['#c8381f', '#e8742a', '#f2b33d', '#a8401c', '#d9561c'];
    // a maple leaf, 40 x 40, its stem at the bottom
    const LEAF_D = 'M20 0L23 9L28 6L27 15L35 11L32 19L40 20L32 25L34 30L24 28L21 34L21 40L19 40L19 34L16 28L6 30L8 25L0 20L8 19L5 11L13 15L12 6L17 9Z';
    const leaf = (x, y, s, r, c) => `<path d="${LEAF_D}" fill="${c}" transform="translate(${x} ${y}) rotate(${r} ${20 * s} ${20 * s}) scale(${s})"/>`;
    // a pumpkin (no face), x/y its top-left, s its scale
    const pumpkin = (x, y, s) => `<g transform="translate(${x} ${y}) scale(${s})"><path d="M30 8q1-7 6-9" stroke="#5e7f2b" stroke-width="4" fill="none" stroke-linecap="round"/>`
      + `<ellipse cx="18" cy="30" rx="16" ry="20" fill="#c95a17"/><ellipse cx="42" cy="30" rx="16" ry="20" fill="#c95a17"/><ellipse cx="30" cy="30" rx="14" ry="22" fill="#e8792a"/>`
      + `<path d="M30 9v42" stroke="#b44f12" stroke-width="1.5" opacity=".6"/></g>`;
    // a turkey in a pilgrim hat: fan tail, round body, the tools' logo is the same bird small
    const fan = (cx, cy, layers, n, spread, w) => layers.map(([L, c, tip]) => Array.from({ length: n }, (_, i) => { const a = -spread + (2 * spread * i) / (n - 1);
      return `<g transform="rotate(${a} ${cx} ${cy})"><ellipse cx="${cx}" cy="${cy - L / 2}" rx="${w}" ry="${L / 2}" fill="${c}"/>${tip ? `<ellipse cx="${cx}" cy="${cy - L + w * 0.9}" rx="${w * 0.45}" ry="${w * 0.6}" fill="${tip}"/>` : ''}</g>`; }).join('')).join('');
    const TURKEY = `<svg viewBox="0 0 64 64" aria-hidden="true">${fan(32, 40, [[34, '#b8321f', '#f2b33d'], [27, '#e8742a'], [20, '#f2b33d']], 7, 72, 6)}
      <ellipse cx="32" cy="44" rx="13" ry="14" fill="#7a4626"/><ellipse cx="29" cy="47" rx="8" ry="9" fill="#9a6036"/>
      <circle cx="26" cy="29" r="7.5" fill="#9a6036"/><circle cx="24" cy="28" r="2.4" fill="#fff"/><circle cx="23.6" cy="28.2" r="1.2" fill="#111"/>
      <path d="M19 30l-5 2 5 1.6z" fill="#f2b33d"/><path d="M19.5 32.5q-1.5 5 1 7q1.5-3.5 0.5-7z" fill="#d8262a"/>
      <path d="M36 57v5M30 57v5" stroke="#e0902a" stroke-width="2.2" stroke-linecap="round"/></svg>`;
    const BIG_TURKEY = `<g>${fan(320, 700, [[160, '#9e2a1c', '#3a1a10'], [132, '#d4561f'], [104, '#f0a030'], [76, '#b8321f']], 9, 78, 24)}
      <path d="M302 802l-4 40M338 802l4 40" stroke="#e0902a" stroke-width="6" stroke-linecap="round"/>
      <path d="M298 842l-14 4M298 842l-4 8M298 842l8 4M342 842l-8 4M342 842l4 8M342 842l14 4" stroke="#e0902a" stroke-width="4" stroke-linecap="round"/>
      <ellipse cx="320" cy="748" rx="62" ry="66" fill="#6b3d22"/><ellipse cx="304" cy="760" rx="38" ry="46" fill="#8a5530"/>
      <path d="M300 732q6 10 0 20M310 758q6 10 0 20M294 778q6 10 0 20" stroke="#6b3d22" stroke-width="3" fill="none" stroke-linecap="round" opacity=".7"/>
      <ellipse cx="352" cy="752" rx="26" ry="42" fill="#55301a" transform="rotate(-14 352 752)"/>
      <path d="M342 730q14 14 10 44M354 726q12 16 8 46" stroke="#3f2213" stroke-width="2.5" fill="none" opacity=".8"/>
      <path d="M296 700q-10 -20 -8 -40l22 2q0 20 14 34z" fill="#8a5530"/>
      <circle cx="292" cy="648" r="27" fill="#8a5530"/>
      <circle cx="281" cy="642" r="8" fill="#fff"/><circle cx="300" cy="642" r="8" fill="#fff"/><circle cx="279" cy="643" r="4" fill="#111"/><circle cx="298" cy="643" r="4" fill="#111"/>
      <circle cx="277.5" cy="641.5" r="1.4" fill="#fff"/><circle cx="296.5" cy="641.5" r="1.4" fill="#fff"/>
      <path d="M282 654l-20 6 20 6z" fill="#f2b33d"/><path d="M276 664q-8 12 -2 26q8 -4 6 -24z" fill="#d8262a"/>
      <ellipse cx="292" cy="624" rx="36" ry="7" fill="#1c1418"/><path d="M272 622l5 -40h32l5 40z" fill="#1c1418"/>
      <rect x="273" y="608" width="40" height="9" fill="#5a3a26"/><rect x="286" y="606" width="13" height="13" rx="1.5" fill="none" stroke="#f2c14e" stroke-width="3"/></g>`;
    // the left edge: a maple in full colour, a hay bale, a corn shock, pumpkins, leaves on the ground
    // the maple's crown: ~90 overlapping blobs inside an oval, lit from the upper left (deep red at the back and bottom right,
    // gold at the front top left), its edge broken up with loose leaves. A seeded random, so it draws the same every load
    const CROWN = (() => {
      let seed = 7; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
      const SH = ['#7a2414', '#9c2e18', '#c0401c', '#d9581e', '#e8762a', '#f29a34', '#f5bd48'];
      const cx = 150, cy = 330, rx = 150, ry = 140, B = [];
      for (let i = 0; i < 95; i++) { const a = rnd() * Math.PI * 2, d = Math.sqrt(rnd()); const x = cx + Math.cos(a) * d * rx, y = cy + Math.sin(a) * d * ry;
        const lit = (-(x - cx) / rx * 0.45 - (y - cy) / ry * 0.75 + 1) / 2;       // 0 shadow .. 1 lit
        B.push([x, y, 20 + rnd() * 18, Math.max(0, Math.min(SH.length - 1, Math.round(lit * (SH.length - 1) + (rnd() - 0.5) * 2)))]); }
      B.sort((a, b) => a[3] - b[3]);                                              // shadow first, lit on top
      let out = B.map(([x, y, r, k]) => `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${r.toFixed(1)}" fill="${SH[k]}"/>`).join('');
      for (let i = 0; i < 34; i++) { const a = rnd() * Math.PI * 2, x = cx + Math.cos(a) * rx * (0.9 + rnd() * 0.2) - 12, y = cy + Math.sin(a) * ry * (0.9 + rnd() * 0.2) - 12;
        out += leaf(x.toFixed(1), y.toFixed(1), (0.45 + rnd() * 0.35).toFixed(2), Math.round(rnd() * 360), SH[2 + Math.floor(rnd() * 5)]); }
      return out;
    })();
    const LEFT = `<svg class="hol-side hol-left" viewBox="0 0 420 900" preserveAspectRatio="xMinYMax meet" aria-hidden="true">
      <path fill="${SIL}" d="M112 905L120 640Q112 560 70 500L84 492Q118 540 130 580Q148 520 196 470L208 480Q160 540 150 640L162 905Z"/>
      <g fill="none" stroke="${SIL}" stroke-width="7" stroke-linecap="round"><path d="M124 600Q80 540 40 520"/><path d="M140 560Q200 500 250 460"/><path d="M128 500Q110 430 120 380"/></g>
      <g>${CROWN}</g>
      <g opacity=".9">${[[330, 560, .7, 40, 1], [20, 560, .6, -10, 3], [260, 640, .55, 60, 2], [340, 700, .5, 10, 0]].map(([x, y, s, r, c]) => leaf(x, y, s, r, LEAFC[c])).join('')}</g>
      <path fill="var(--tg-near)" d="M0 905V812Q110 784 230 798T420 818V905Z"/>
      <g transform="translate(228 744)"><path d="M0 76L30 0L42 0L72 76Z" fill="#b8913f"/><path d="M8 76L33 4M20 76L36 2M36 76L37 0M52 76L40 2M64 76L42 4" stroke="#8a6a2a" stroke-width="2"/>
        <path d="M14 40H58" stroke="#6b4a1e" stroke-width="5"/><path d="M30 0q-12 -16 -20 -18M38 0q4 -18 14 -22M34 0q0 -20 -4 -26" stroke="#b8913f" stroke-width="3" fill="none" stroke-linecap="round"/></g>
      <g transform="translate(150 786)"><rect width="96" height="46" rx="8" fill="#d2a74a"/><path d="M6 12H90M4 24H92M6 36H90" stroke="#a8802e" stroke-width="2"/><path d="M30 0V46M66 0V46" stroke="#7a5a22" stroke-width="3"/></g>
      ${pumpkin(18, 790, 1.15)}${pumpkin(86, 820, .8)}${pumpkin(250, 830, .6)}
      ${[[10, 860, .6, 30, 1], [70, 872, .5, -40, 0], [200, 868, .55, 70, 2], [320, 864, .6, 10, 3], [370, 876, .45, -60, 1]].map(([x, y, s, r, c]) => leaf(x, y, s, r, LEAFC[c])).join('')}
    </svg>`;
    // the right edge: a big harvest sun low behind, a split-rail fence, the turkey, pumpkins at his feet
    const RIGHT = `<svg class="hol-side hol-right" viewBox="0 0 420 900" preserveAspectRatio="xMaxYMax meet" aria-hidden="true">
      <path fill="var(--tg-near)" d="M0 905V830Q180 808 420 820V905Z"/>
      <g fill="var(--tg-wood)"><rect x="160" y="740" width="12" height="100" rx="2"/><rect x="404" y="736" width="12" height="104" rx="2"/>
        <path d="M120 758L420 750V762L120 770ZM120 792L420 786V798L120 804Z"/></g>
      ${BIG_TURKEY}
      ${pumpkin(206, 806, .75)}${pumpkin(380, 818, .55)}
      ${[[180, 870, .5, 20, 0], [250, 878, .45, -30, 2], [370, 874, .5, 50, 4], [120, 300, .7, -20, 1], [380, 220, .6, 35, 0], [220, 420, .55, 70, 2]].map(([x, y, s, r, c]) => leaf(x, y, s, r, LEAFC[c])).join('')}
    </svg>`;
    // the middle, full width behind the sides: far hills with a tree line, a near hill with a fence along it
    const MID = (() => {
      let trees = ''; for (let x = 6, k = 0; x < 1600; x += 12 + (k * 17) % 14, k++) { const r = 12 + (k * 7) % 8; trees += `<circle cx="${x}" cy="${118 - r * 0.4 - (k * 11) % 10}" r="${r}"/>`; }
      let posts = ''; for (let x = 30; x < 1600; x += 90) posts += `<rect x="${x}" y="${196 + Math.sin(x / 260) * 8}" width="6" height="40"/>`;
      return `<svg class="tg-mid" viewBox="0 0 1600 300" preserveAspectRatio="xMidYMax slice" aria-hidden="true">
        <g fill="var(--tg-far)">${trees}<path d="M0 300V120Q200 90 420 112T860 104T1280 116T1600 100V300Z"/></g>
        <path fill="var(--tg-near)" d="M0 300V200Q260 176 540 196T1080 190T1600 196V300Z"/>
        <g fill="var(--tg-wood)">${posts}</g>
        <g stroke="var(--tg-wood)" stroke-width="4" fill="none"><path d="M0 206Q260 190 540 208T1080 202T1600 208"/><path d="M0 222Q260 206 540 224T1080 218T1600 224"/></g>
      </svg>`;
    })();
    const css = `
      ${DARK} { --accent: #ff9a2e; --glow: rgba(255,154,46,0.09); --bg: #170b13; --surface0: #1c0f18; --surface1: #23121d; --surface2: #2e1826;
        --border: #4d2a22; --border2: #74401f; --card: #1d0f19; --card2: #261420; --tg-sil: #12070d; --tg-wood: #3a2014; --tg-far: #3b1a26; --tg-near: #24101a; }
      ${LIGHT} { --accent: #c95a0b; --glow: rgba(201,90,11,0.07); --border: #ecd2b8; --border2: #ddb48c; --tg-sil: #6b3f2a; --tg-wood: #8a5a3a; --tg-far: #e8c0a0; --tg-near: #d9a47e; }
      ${DARK} body { background: radial-gradient(1200px 520px at 50% 100%, rgba(255,140,40,0.32), transparent 65%),
          radial-gradient(900px 600px at 95% 0%, rgba(120,50,140,0.28), transparent 62%), linear-gradient(#1f0c22, #3a1428 50%, #6a2a1e) fixed; }
      ${LIGHT} body { background: linear-gradient(#fff1de, #ffd9b8) fixed; }
      ${DARK} { background-color: #6a2a1e; } ${LIGHT} { background-color: #ffd9b8; }
      ${H} .hol-scene { position: fixed; inset: 0; z-index: 0; pointer-events: none; overflow: hidden; }
      ${H} .hol-side { position: absolute; bottom: 0; height: 100vh; width: auto; max-width: 48vw; }
      ${H} .tg-mid { position: absolute; left: 0; bottom: 0; width: 100%; height: 34vh; }
      ${LIGHT} .tg-mid { opacity: .6; }
      ${H} .hol-left { left: 0; } ${H} .hol-right { right: 0; }
      ${LIGHT} .hol-side { opacity: .6; }
      @media (max-width: 760px) { ${H} .hol-side { opacity: .4; } }
      ${H} .wrap { position: relative; z-index: 1; }
      ${H} .tb-brand h1 em { color: #ff9a2e; } ${LIGHT} .tb-brand h1 em { color: #c95a0b; }
      ${H} .brand-home > :not(.hol-jack) { display: none !important; }
      .hol-jack { display: inline-flex; width: 36px; height: 36px; } .hol-jack svg { width: 100%; height: 100%; }
      .hol-jack-title { width: 0.9em; height: 0.9em; margin-left: 0.2em; vertical-align: -0.1em; display: inline-block; }
      .tg-leaves { position: fixed; inset: 0; pointer-events: none; z-index: 2147483000; overflow: hidden; }
      .tg-leaf { position: absolute; left: 0; top: 0; width: 26px; height: 26px; }
      .tg-leaf svg { width: 100%; height: 100%; display: block; }`;
    const style = document.createElement('style'); style.id = 'holiday-css'; style.textContent = css; document.head.appendChild(style);

    const deco = () => {
      if (document.body && !document.querySelector('.hol-scene')) document.body.insertAdjacentHTML('afterbegin', `<div class="hol-scene" aria-hidden="true">${MID}${LEFT}${RIGHT}</div>`);
      for (const a of document.querySelectorAll('.brand-home')) if (!a.querySelector('.hol-jack')) a.insertAdjacentHTML('afterbegin', `<span class="hol-jack">${TURKEY}</span>`);
      const brand = document.querySelector('body > .wrap > .brand');
      if (brand && !brand.querySelector('.hol-jack-title')) brand.insertAdjacentHTML('beforeend', TURKEY.replace('<svg ', '<svg class="hol-jack-title" '));
    };
    // a flurry of leaves drifts down once a visit, swaying and turning, gone in a few seconds
    const leaves = () => {
      if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
      try { if (!q && sessionStorage.getItem('holBats') === on.key) return; sessionStorage.setItem('holBats', on.key); } catch (e) {}
      const box = document.createElement('div'); box.className = 'tg-leaves'; box.setAttribute('aria-hidden', 'true');
      document.body.appendChild(box);
      const W = window.innerWidth, Hh = window.innerHeight, n = W < 600 ? 6 : 12;
      let last = 0;
      for (let i = 0; i < n; i++) {
        const b = document.createElement('div'); b.className = 'tg-leaf';
        b.innerHTML = `<svg viewBox="0 0 40 40"><path d="${LEAF_D}" fill="${LEAFC[i % LEAFC.length]}"/></svg>`;
        const s = 0.7 + Math.random() * 0.7, x0 = Math.random() * W, sway = 40 + Math.random() * 70, spin = (Math.random() < 0.5 ? -1 : 1) * (200 + Math.random() * 300);
        const dur = 4200 + Math.random() * 2600, delay = i * 220 + Math.random() * 400, drop = Hh * (0.55 + Math.random() * 0.35);
        const frames = [0, 0.25, 0.5, 0.75, 1].map((t, k) => ({ transform: `translate(${x0 + Math.sin(t * Math.PI * 2 + i) * sway}px, ${-40 + t * drop}px) rotate(${t * spin}deg) scale(${s})`,
          opacity: k === 0 ? 0 : k === 4 ? 0 : 0.95 }));
        box.appendChild(b);
        b.animate(frames, { duration: dur, delay, easing: 'ease-in-out', fill: 'both' });
        last = Math.max(last, dur + delay);
      }
      setTimeout(() => box.remove(), last + 200);
    };
    const go = () => { deco(); setTimeout(leaves, 500); };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', go); else go();
    window.addEventListener('load', deco);
  }
})();
