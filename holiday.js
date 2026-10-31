// Holiday touches, a few days a year, small and subtle. A holiday is on between its dates (US Eastern),
// then it's gone with no deploy. Loaded on every page (chrome.js loads it in the apps; the picker has its own tag).
// ?holiday=halloween turns one on any day, to preview it; ?holiday=off turns them all off.
//
//   halloween  the coloured word in a tool's name goes pumpkin orange with a small pumpkin beside it, and a few
//              bats flutter across the top once per visit (none for reduced motion, never in the way of a click)
(function () {
  if (window.RonHoliday) return;
  const HOLIDAYS = [
    { key: 'halloween', from: '10-29', to: '11-01' },
  ];
  const q = new URLSearchParams(location.search).get('holiday');
  const md = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', month: '2-digit', day: '2-digit' }).format(new Date());
  const on = q === 'off' ? null : HOLIDAYS.find(h => h.key === q) || (q ? null : HOLIDAYS.find(h => md >= h.from && md <= h.to));
  window.RonHoliday = { on: on?.key || null };
  if (!on) return;
  const root = document.documentElement;
  root.setAttribute('data-holiday', on.key);

  if (on.key === 'halloween') {
    const PUMPKIN = '<svg class="hol-pumpkin" viewBox="0 0 24 24" aria-hidden="true"><path d="M12.6 6.2c.3-1.6 1.2-2.6 2.6-3" fill="none" stroke="#5e8f2b" stroke-width="1.6" stroke-linecap="round"/>'
      + '<ellipse cx="7.6" cy="14" rx="5.2" ry="6.6" fill="#e2701c"/><ellipse cx="16.4" cy="14" rx="5.2" ry="6.6" fill="#e2701c"/>'
      + '<ellipse cx="12" cy="14" rx="4.4" ry="7.2" fill="#f28a2e"/></svg>';
    const css = `
      html[data-holiday="halloween"] .tb-brand h1 em { color: #f28a2e; }
      .hol-pumpkin { width: 0.72em; height: 0.72em; margin: 0 0.12em 0 0.18em; vertical-align: -0.04em; display: inline-block; }
      .hol-bats { position: fixed; inset: 0 0 auto 0; height: 45vh; pointer-events: none; z-index: 2147483000; overflow: hidden; }
      .hol-bat { position: absolute; left: 0; top: 0; width: 46px; height: 23px; color: #d9cdf5; opacity: 0.88; }
      html[data-theme="light"] .hol-bat { color: #2a2140; }
      .hol-bat svg { width: 100%; height: 100%; display: block; animation: hol-flap 0.16s ease-in-out infinite alternate; transform-origin: 50% 60%; }
      @keyframes hol-flap { to { transform: scaleY(0.62); } }`;
    const style = document.createElement('style'); style.id = 'holiday-css'; style.textContent = css; document.head.appendChild(style);

    // the pumpkin beside each tool's name (the picker's title too), once the header is there
    const deco = () => {
      // after the whole name, before the sport switcher where it sits inside the title
      for (const h1 of document.querySelectorAll('.tb-brand h1')) if (h1.querySelector('em') && !h1.querySelector('.hol-pumpkin')) {
        const sw = h1.querySelector('.sport-switch');
        sw ? sw.insertAdjacentHTML('beforebegin', PUMPKIN) : h1.insertAdjacentHTML('beforeend', PUMPKIN);
      }
      const brand = document.querySelector('body > .wrap > .brand');
      if (brand && !brand.querySelector('.hol-pumpkin')) brand.insertAdjacentHTML('beforeend', PUMPKIN);
    };

    // a handful of bats across the top, once a visit
    const BAT = '<svg viewBox="0 0 64 32" aria-hidden="true"><path fill="currentColor" d="M32 13c-1.6-1.8-2.6-1.6-3.2-.2-.3-1.6-.9-2.2-1.6-2.4.5 1.2.4 2.4 0 3.4C24 9 15 4.6 3 7.4c5 1.6 7.8 4.6 8.4 9 3-1.8 6.4-1.6 8.6.4 2.2-2 5.6-1.6 7.6 1.4 1.4-.6 3-.4 4.4.6 1.4-1 3-1.2 4.4-.6 2-3 5.4-3.4 7.6-1.4 2.2-2 5.6-2.2 8.6-.4.6-4.4 3.4-7.4 8.4-9C49 4.6 40 9 36.8 13.8c-.4-1-.5-2.2 0-3.4-.7.2-1.3.8-1.6 2.4-.6-1.4-1.6-1.6-3.2.2z"/></svg>';
    const bats = () => {
      if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
      try { if (!q && sessionStorage.getItem('holBats') === on.key) return; sessionStorage.setItem('holBats', on.key); } catch (e) {}
      const box = document.createElement('div'); box.className = 'hol-bats'; box.setAttribute('aria-hidden', 'true');
      document.body.appendChild(box);
      const W = window.innerWidth, H = box.clientHeight, n = W < 600 ? 3 : 5;
      let last = 0;
      for (let i = 0; i < n; i++) {
        const b = document.createElement('div'); b.className = 'hol-bat'; b.innerHTML = BAT;
        const s = 0.75 + Math.random() * 0.6, y0 = H * (0.12 + Math.random() * 0.6), amp = 18 + Math.random() * 36;
        const dur = 2600 + Math.random() * 1800, delay = i * 260 + Math.random() * 300, rtl = Math.random() < 0.35;
        const frames = [0, 0.25, 0.5, 0.75, 1].map((t, k) => {
          const x = rtl ? W + 40 - t * (W + 120) : -80 + t * (W + 120), y = y0 + Math.sin(t * Math.PI * 2.2 + i) * amp - t * H * 0.18;
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
