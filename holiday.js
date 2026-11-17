// Holiday touches, a few days a year. Each holiday is on for three days, the day before, the day itself and the day
// after (US Eastern), then it's gone with no deploy. Loaded on every page (chrome.js loads it in the apps; the picker has its own tag).
// ?holiday=halloween turns one on any day, to preview it; ?holiday=off turns them all off.
//
//   halloween  a night scene behind the page (the sides and the gaps between cards): moon and a witch, bats, a haunted
//              house, a graveyard with a black cat, bare trees, pumpkins, a potion, cobwebs and a spider; a purple night
//              sky; the accent goes pumpkin orange and borders purple; a jack-o'-lantern for each tool's logo; and a
//              few bats flutter across the top once per visit (none for reduced motion, never in the way of a click)
//   neon       11/19/2026, a big crime-sandbox game's release day (Ron 11/17): a neon beach city at sunset behind the page,
//              a striped retro sun over the water, palms, a sports car with its underglow, a lit skyline and a police
//              helicopter with its searchlight; hot pink accent, neon borders; a palm for each tool's logo; the helicopter
//              crosses the top once per visit. Its own art, no game logos or names. A one-off (year: 2026).
(function () {
  if (window.RonHoliday) return;
  const HOLIDAYS = [
    { key: 'halloween', date: '10-31' },
    { key: 'neon', date: '11-19', year: 2026 },
  ];
  let q = new URLSearchParams(location.search).get('holiday');
  try { q = q || sessionStorage.getItem('ronHoliday'); } catch (e) {}       // a preview kept by chrome.js for the tab
  // today in US Eastern, and whether a holiday's month-day is within a day of it (across a month or year end)
  const et = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  const today = Date.UTC(+et.slice(0, 4), +et.slice(5, 7) - 1, +et.slice(8, 10));
  const near = (h) => [-1, 0, 1].some(dy => { const y = +et.slice(0, 4) + dy; if (h.year && y !== h.year) return false; const d = Date.UTC(y, +h.date.slice(0, 2) - 1, +h.date.slice(3, 5)); return Math.abs(d - today) <= 864e5; });
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
        <linearGradient id="neo-fl"><stop offset=".6" stop-color="#fff"/><stop offset="1" stop-color="#000"/></linearGradient><mask id="neo-ml"><rect width="420" height="905" fill="url(#neo-fl)"/></mask></defs>
      <circle cx="150" cy="600" r="230" fill="url(#neo-halo)"/>
      <circle cx="150" cy="600" r="118" fill="url(#neo-sun)" mask="url(#neo-stripes)"/>
      <g mask="url(#neo-ml)"><rect y="686" width="420" height="120" fill="url(#neo-sea)"/>
      <g stroke="#ff7ab8" stroke-linecap="round" opacity=".75"><path d="M70 700h160M96 714h108M50 728h70M150 728h120M110 744h80M60 762h50M180 760h90" stroke-width="2.5"/></g>
      <g stroke="#2ee6f0" stroke-linecap="round" opacity=".35"><path d="M250 708h60M300 736h70M20 750h30" stroke-width="2"/></g>
      ${palm(70, 830, 330, -40, 1.05)}${palm(205, 840, 230, 30, .8)}${palm(18, 850, 200, -20, .7)}
      <path fill="${SIL}" d="M0 905V806Q120 794 260 806T420 812V905Z"/>
      <path d="M0 846H420" stroke="#ff2e88" stroke-width="1.5" opacity=".5"/></g>
      <ellipse cx="250" cy="866" rx="130" ry="14" fill="url(#neo-glow)"/>
      <g transform="translate(130 812)"><path fill="#0a0612" stroke="#ff7ab8" stroke-width="1.4" stroke-linejoin="round" d="M2 40L8 30Q30 26 56 14Q74 6 102 6L142 8Q162 12 186 26L224 30Q238 33 238 42V50H2Z"/>
        <path fill="#2ee6f0" opacity=".55" d="M66 16Q80 10 100 10L120 11L126 24H58Z"/>
        <circle cx="52" cy="50" r="13" fill="#0a0612" stroke="#2ee6f0" stroke-width="1.5"/><circle cx="192" cy="50" r="13" fill="#0a0612" stroke="#2ee6f0" stroke-width="1.5"/>
        <rect x="0" y="32" width="12" height="5" rx="2" fill="#ff2a4a"/><rect x="230" y="34" width="9" height="4" rx="2" fill="#fff4c2"/>
        <path d="M2 40H238" stroke="#ff2e88" stroke-width="1.5"/></g>
    </svg>`;
    // the right edge: a lit skyline over the water, one tower in neon, a police helicopter and its searchlight, a palm in front
    const tower = (x, w, top, win) => { let r = `<rect x="${x}" y="${top}" width="${w}" height="${905 - top}" fill="${SIL}"/>`;
      for (let yy = top + 14; yy < 790; yy += 16) for (let xx = x + 6; xx < x + w - 6; xx += 11) { const k = (xx * 7 + yy * 3) % 11; if (k < 4) r += `<rect x="${xx}" y="${yy}" width="5" height="7" fill="${win[k % win.length]}"/>`; }
      return r; };
    const WIN = ['#ffd166', '#ff7ab8', '#2ee6f0', '#ffe9a8'];
    const RIGHT = `<svg class="hol-side hol-right" viewBox="0 0 420 900" preserveAspectRatio="xMaxYMax meet" aria-hidden="true">
      <defs><linearGradient id="neo-beam" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fff" stop-opacity=".38"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></linearGradient>
        <linearGradient id="neo-fr"><stop offset="0" stop-color="#000"/><stop offset=".45" stop-color="#fff"/></linearGradient><mask id="neo-mr"><rect width="420" height="905" fill="url(#neo-fr)"/></mask></defs>
      <path d="M262 132L170 520L250 520Z" fill="url(#neo-beam)"/>
      <g fill="${SIL}" transform="translate(240 104)"><ellipse cx="26" cy="22" rx="28" ry="14"/><path d="M48 18L118 14L120 20L50 28Z"/><path d="M112 6L122 4L124 22L116 22Z"/>
        <path d="M-38 2H92" stroke="${SIL}" stroke-width="3" stroke-linecap="round"/><path d="M26 8V2" stroke="${SIL}" stroke-width="4"/>
        <path d="M2 40H56M10 34V40M44 34V40" stroke="${SIL}" stroke-width="3" fill="none"/><path fill="#2ee6f0" opacity=".6" d="M2 20Q4 12 16 10L18 22Z"/>
        <circle cx="54" cy="12" r="2.5" fill="#ff2a4a"/><circle cx="18" cy="34" r="2.5" fill="#3d7bff"/></g>
      ${tower(170, 46, 470, WIN)}${tower(222, 58, 330, WIN)}${tower(290, 40, 420, WIN)}${tower(336, 52, 270, WIN)}${tower(394, 30, 500, WIN)}
      <path d="M336 270L362 238L388 270" fill="${SIL}"/><path d="M362 238V200" stroke="${SIL}" stroke-width="3"/><circle cx="362" cy="198" r="3.5" fill="#ff2a4a"/>
      <rect x="222.5" y="330.5" width="57" height="575" fill="none" stroke="#ff2e88" stroke-width="1.6" opacity=".9"/>
      <rect x="336.5" y="270.5" width="51" height="635" fill="none" stroke="#2ee6f0" stroke-width="1.6" opacity=".8"/>
      <g mask="url(#neo-mr)"><rect y="760" width="420" height="145" fill="#14082a"/></g>
      <g stroke-linecap="round" opacity=".6"><path d="M180 776h30M232 784h40M300 778h24M344 790h36M240 806h20M360 812h30" stroke="#ff7ab8" stroke-width="2"/><path d="M200 798h24M296 800h30M392 776h20" stroke="#2ee6f0" stroke-width="2"/></g>
      ${palm(372, 880, 260, 40, .9)}${palm(410, 890, 180, -10, .65)}
      <path fill="${SIL}" mask="url(#neo-mr)" d="M0 905V850Q300 836 420 846V905Z"/>
    </svg>`;
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
      if (document.body && !document.querySelector('.hol-scene')) document.body.insertAdjacentHTML('afterbegin', `<div class="hol-scene" aria-hidden="true">${LEFT}${RIGHT}</div>`);
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
})();
