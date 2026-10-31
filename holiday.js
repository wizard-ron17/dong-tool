// Holiday touches, a few days a year. Each holiday is on for three days, the day before, the day itself and the day
// after (US Eastern), then it's gone with no deploy. Loaded on every page (chrome.js loads it in the apps; the picker has its own tag).
// ?holiday=halloween turns one on any day, to preview it; ?holiday=off turns them all off.
//
//   halloween  a night scene behind the page (the sides and the gaps between cards): moon and a witch, bats, a haunted
//              house, a graveyard with a black cat, bare trees, pumpkins, a potion, cobwebs and a spider; a purple night
//              sky; the accent goes pumpkin orange and borders purple; a jack-o'-lantern for each tool's logo; and a
//              few bats flutter across the top once per visit (none for reduced motion, never in the way of a click)
(function () {
  if (window.RonHoliday) return;
  const HOLIDAYS = [
    { key: 'halloween', date: '10-31' },
  ];
  const q = new URLSearchParams(location.search).get('holiday');
  // today in US Eastern, and whether a holiday's month-day is within a day of it (across a month or year end)
  const et = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  const today = Date.UTC(+et.slice(0, 4), +et.slice(5, 7) - 1, +et.slice(8, 10));
  const near = (h) => [-1, 0, 1].some(dy => { const d = Date.UTC(+et.slice(0, 4) + dy, +h.date.slice(0, 2) - 1, +h.date.slice(3, 5)); return Math.abs(d - today) <= 864e5; });
  const on = q === 'off' ? null : HOLIDAYS.find(h => h.key === q) || (q ? null : HOLIDAYS.find(near));
  window.RonHoliday = { on: on?.key || null };
  if (!on) return;
  const root = document.documentElement;
  root.setAttribute('data-holiday', on.key);

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
})();
