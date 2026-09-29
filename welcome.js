// Ron's Tools — the site-wide welcome. One file for every app and the landing
// page (same origin, so it shows once across the whole site, first visit
// only). Its footer "About" link reopens it: RonWelcome.open().
//
// Styled off each page's own tokens (the apps' --surface0 / --accent, the
// landing page's --card / --green), so it follows light and dark mode. Mounted
// on <body>, never inside .wrap — .wrap's z-index traps overlays under the blur.
(function () {
  const KEY = 'rons-tools-welcome-v1';
  const CSS = `
  .rw-back { position: fixed; inset: 0; z-index: 600; display: flex; align-items: center; justify-content: center; padding: 1rem;
    background: rgba(2,5,10,0.72); backdrop-filter: blur(4px); -webkit-backdrop-filter: blur(4px); animation: rwIn 0.18s ease; overflow-y: auto; }
  @keyframes rwIn { from { opacity: 0; } to { opacity: 1; } }
  .rw { position: relative; width: 100%; max-width: 540px; margin: auto; border-radius: 18px; padding: 1.6rem 1.4rem 1.3rem; text-align: left;
    background: var(--surface0, var(--card, #0e1524)); color: var(--text, #e8edf5);
    border: 1px solid var(--border2, var(--border, #233149)); box-shadow: 0 24px 70px rgba(0,0,0,0.55);
    font-family: var(--font-b, 'Plus Jakarta Sans', system-ui, sans-serif); }
  .rw::before { content: ''; position: absolute; inset: 0; border-radius: inherit; pointer-events: none;
    background: radial-gradient(420px 220px at 0% 0%, color-mix(in srgb, var(--accent, var(--green, #33d07c)) 16%, transparent), transparent 70%); }
  .rw > * { position: relative; }
  .rw:focus { outline: none; }
  .rw-x { position: absolute; top: 0.7rem; right: 0.8rem; width: 2rem; height: 2rem; border: 0; border-radius: 50%; cursor: pointer;
    background: transparent; color: var(--muted, #8a94a6); font-size: 1.4rem; line-height: 1; }
  .rw-x:hover { background: color-mix(in srgb, var(--text, #e8edf5) 8%, transparent); color: var(--text, #e8edf5); }
  .rw-marks { display: flex; gap: 0.45rem; }
  .rw-marks img { width: 34px; height: 34px; border-radius: 9px; object-fit: contain; }
  .rw-title { font-family: var(--font-d, 'Chakra Petch', sans-serif); font-weight: 700; font-size: 1.7rem; line-height: 1.1; margin-top: 0.8rem; color: var(--text-strong, #fff); }
  .rw-title em { font-style: normal; color: var(--accent, var(--green, #33d07c)); }
  .rw-sub { color: var(--muted, #8a94a6); font-size: 0.9rem; margin-top: 0.35rem; line-height: 1.45; }
  .rw-pts { display: grid; gap: 0.7rem; margin: 1.1rem 0 0; }
  .rw-pt { display: flex; gap: 0.7rem; align-items: flex-start; }
  .rw-ic { flex-shrink: 0; width: 30px; height: 30px; border-radius: 9px; display: flex; align-items: center; justify-content: center;
    color: var(--accent, var(--green, #33d07c)); background: color-mix(in srgb, var(--accent, var(--green, #33d07c)) 13%, transparent); }
  .rw-ic svg { width: 17px; height: 17px; }
  .rw-pt > div > b { display: block; font-size: 0.9rem; color: var(--text-strong, #fff); }
  .rw-pt > div > span { display: block; font-size: 0.82rem; line-height: 1.5; color: var(--text, #e8edf5); opacity: 0.88; }
  .rw-story { margin-top: 1rem; padding: 0.8rem 0.95rem; border-radius: 12px; font-size: 0.83rem; line-height: 1.55;
    background: color-mix(in srgb, var(--text, #e8edf5) 5%, transparent); border-left: 3px solid var(--accent, var(--green, #33d07c)); }
  .rw-story i { display: block; margin-top: 0.35rem; font-style: normal; font-size: 0.74rem; color: var(--muted, #8a94a6); }
  .rw-story a, .rw-fine a { color: var(--accent, var(--green, #33d07c)); text-decoration: none; font-weight: 600; }
  .rw-go { display: block; width: 100%; margin-top: 1.1rem; padding: 0.75rem; border: 0; border-radius: 11px; cursor: pointer;
    font: 700 0.95rem var(--font-d, 'Chakra Petch', sans-serif); letter-spacing: 0.02em; color: #04170f; background: var(--accent, var(--green, #33d07c)); }
  .rw-go:hover { filter: brightness(1.08); }
  .rw-go:focus { outline: none; }
  .rw-go:focus-visible { outline: 2px solid var(--text, #e8edf5); outline-offset: 2px; }
  .rw-fine { margin-top: 0.8rem; font-size: 0.7rem; line-height: 1.5; color: var(--muted, #8a94a6); text-align: center; }
  @media (max-width: 480px) { .rw { padding: 1.3rem 1.05rem 1.1rem; } .rw-title { font-size: 1.45rem; } }`;
  const ic = (d) => `<span class="rw-ic"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${d}</svg></span>`;
  const HTML = `
    <div class="rw" role="dialog" aria-modal="true" aria-labelledby="rw-title" tabindex="-1">
      <button class="rw-x" onclick="RonWelcome.close()" aria-label="Close">×</button>
      <div class="rw-marks"><img src="/icons/icon-512.png" alt="MLB"><img src="/icons/nfl-icon-512.png" alt="NFL"><img src="/icons/nhl-icon-512.png" alt="NHL"><img src="/icons/nba-icon-512.png" alt="NBA"></div>
      <div class="rw-title" id="rw-title">Welcome to Ron's <em>Tools</em></div>
      <div class="rw-sub">Free player-prop prices for MLB, NFL, NHL and NBA — built from the ground up, not copied from a sportsbook.</div>
      <div class="rw-pts">
        <div class="rw-pt">${ic('<path d="M12 3v18M5 8h14M7 8l-3 6a3 3 0 0 0 6 0zM17 8l-3 6a3 3 0 0 0 6 0z"/>')}<div><b>Fair odds, not the market's</b>
          <span>Every price here comes from our own models, with no vig. When your book offers longer odds than ours, that's a +EV bet — take it.</span></div></div>
        <div class="rw-pt">${ic('<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>')}<div><b>Backed by backtests, graded in public</b>
          <span>Every model is tested on past seasons before it ships, and scored against real results — often against the betting market itself. The Results tabs show the record.</span></div></div>
        <div class="rw-pt">${ic('<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3.2 1.9"/>')}<div><b>Bottom-up betting</b>
          <span>Build the price from the player, the matchup and the game, then bet only where the book disagrees. Tap any player for his full ladder; parlay mode prices same-game legs with measured correlations.</span></div></div>
      </div>
      <div class="rw-story">I took the usual road — arbitrage, then positive-EV betting off the sharp books — until my accounts got limited. Bottom-up betting is what came next, and Ron's Tools is how I do it.
        <i>— Ron · inspired by <a href="https://www.youtube.com/@greenmeansgosports" target="_blank" rel="noopener">Green Means Go</a> and his home run research</i></div>
      <button class="rw-go" onclick="RonWelcome.close()">Let's go</button>
      <div class="rw-fine">Free, for research and entertainment — not betting advice, and no price wins every time. 21+. Bet what you can afford to lose. Gambling problem? Call 1-800-GAMBLER.</div>
    </div>`;
  function open() {
    if (document.getElementById('rw-back')) return;
    if (!document.getElementById('rw-css')) document.head.insertAdjacentHTML('beforeend', `<style id="rw-css">${CSS}</style>`);
    document.body.insertAdjacentHTML('beforeend', `<div class="rw-back" id="rw-back" onclick="if(event.target===this)RonWelcome.close()">${HTML}</div>`);
    document.addEventListener('keydown', onKey);
    document.querySelector('#rw-back .rw')?.focus({ preventScroll: true });   // the dialog, not the button: no focus ring on open
  }
  function close() { document.getElementById('rw-back')?.remove(); document.removeEventListener('keydown', onKey); }
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  const seen = () => { try { return !!localStorage.getItem(KEY); } catch (e) { return false; } };
  function first() {
    if (seen()) return;
    try { localStorage.setItem(KEY, new Date().toISOString().slice(0, 10)); } catch (e) { /* private mode: at most once a load */ }
    setTimeout(open, 450);
  }
  window.RonWelcome = { open, close, seen };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', first); else first();
})();
