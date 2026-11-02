// Support Ron: the footer's "Support Ron" link opens this small card: a link to Ron's Ko-fi (PayPal, in a new tab) and the
// 4Cx referral. Loaded on first use by chrome.js (RonChrome.support()) and the picker's footer; opens on a RonModal
// (modal.js, loaded here if the page lacks it). Neutral pitch: support for a free site, never tied to winning.
// (11/02: Ko-fi's checkout embedded in the card was too much; a plain link.)
(function () {
  if (window.RonSupport) return;
  const KOFI = 'tipron', REF = 'https://4cx.io/sign-up/ron17';
  const CSS = `
  #sup-back { position: fixed; inset: 0; z-index: 600; display: flex; align-items: center; justify-content: center; padding: 1.5rem 0.9rem; overflow-y: auto;
    background: rgba(2,5,10,0.72); -webkit-backdrop-filter: blur(4px); backdrop-filter: blur(4px); }
  .sup { position: relative; width: 100%; max-width: 420px; margin: auto; border-radius: 16px; padding: 1.25rem 1.2rem 1.1rem;
    background: var(--surface0, var(--card, #0e1524)); color: var(--text, #e8edf5); border: 1px solid var(--border2, var(--border, #233149));
    box-shadow: 0 24px 70px rgba(0,0,0,0.55); font-family: var(--font-b, 'Plus Jakarta Sans', system-ui, sans-serif); }
  .sup::before { content: ''; position: absolute; inset: 0; border-radius: inherit; pointer-events: none;
    background: radial-gradient(380px 200px at 0% 0%, color-mix(in srgb, var(--accent, var(--green, #33d07c)) 14%, transparent), transparent 70%); }
  .sup > * { position: relative; }
  .sup-x { position: absolute; top: 0.6rem; right: 0.7rem; width: 2rem; height: 2rem; border: 0; border-radius: 50%; cursor: pointer; z-index: 2;
    background: transparent; color: var(--muted, #8a94a6); font-size: 1.4rem; line-height: 1; }
  .sup-x:hover { background: color-mix(in srgb, var(--text, #e8edf5) 8%, transparent); color: var(--text, #e8edf5); }
  .sup-t { font: 700 1.35rem/1.15 var(--font-d, 'Chakra Petch', sans-serif); color: var(--text-strong, #fff); padding-right: 2rem; }
  .sup-t em { font-style: normal; color: var(--accent, var(--green, #33d07c)); }
  .sup-s { margin-top: 0.35rem; font-size: 0.84rem; line-height: 1.5; color: var(--muted, #8a94a6); }
  .sup-row { display: flex; gap: 0.75rem; align-items: flex-start; margin-top: 0.75rem; padding: 0.75rem 0.9rem; border-radius: 12px; font-size: 0.82rem; line-height: 1.5;
    border: 1px solid color-mix(in srgb, var(--text, #e8edf5) 10%, transparent); color: var(--text, #e8edf5); text-decoration: none; }
  a.sup-row:hover { border-color: var(--accent, var(--green, #33d07c)); background: color-mix(in srgb, var(--accent, var(--green, #33d07c)) 6%, transparent); }
  .sup-row svg { flex: none; width: 20px; height: 20px; margin-top: 0.1rem; color: var(--accent, var(--green, #33d07c)); }
  .sup-row b { display: block; font-size: 0.92rem; color: var(--text-strong, #fff); }
  .sup-row span { display: block; color: var(--muted, #8a94a6); }
  .sup-row i b { display: inline; font-size: inherit; color: var(--text, #e8edf5); }
  .sup-row i { display: block; margin-top: 0.25rem; font-style: normal; font-size: 0.72rem; color: var(--muted, #8a94a6); }
  .sup a { color: var(--accent, var(--green, #33d07c)); text-decoration: none; font-weight: 600; }
  .sup a:hover { text-decoration: underline; text-underline-offset: 2px; }
  @media (max-width: 480px) { .sup { padding: 1.1rem 0.9rem 0.95rem; } }`;

  function ready() {
    if (!document.getElementById('sup-css')) { const s = document.createElement('style'); s.id = 'sup-css'; s.textContent = CSS; document.head.appendChild(s); }
    if (window.RonModal) return Promise.resolve();
    return new Promise((ok, no) => { const s = document.createElement('script'); s.src = '/modal.js'; s.onload = ok; s.onerror = no; document.head.appendChild(s); });
  }
  function open() {
    return ready().then(() => {
      const dlg = RonModal.open('sup-back', { cls: 'sup', label: 'Support Ron' });
      const page = `https://ko-fi.com/${KOFI}`;
      dlg.innerHTML = `<button class="sup-x" onclick="RonModal.close('sup-back')" aria-label="Close">&times;</button>
        <div class="sup-t">Support <em>Ron</em></div>
        <div class="sup-s">Ron's Tools is free, with no ads and no paywall. Tips help cover the data and the builds. Thank you.</div>
        <a class="sup-row" href="${page}" target="_blank" rel="noopener"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 8h13v5a6 6 0 0 1-6 6H10a6 6 0 0 1-6-6z"/><path d="M17 10h1.5a2.5 2.5 0 0 1 0 5H17"/><path d="M8 2.5v2M12 2.5v2"/></svg><div><b>Leave a tip on Ko-fi</b><span>ko-fi.com/${KOFI} · PayPal</span></div></a>
        <div class="sup-row"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M7 7h11l-3-3M17 17H6l3 3"/></svg><div><b><a href="${REF}" target="_blank" rel="sponsored noopener">Sign up for 4Cx</a>: we both get $25</b>
          The exchange I bet on: zero fees, American odds. A sweepstakes book, so check it's open in your state.
          <i>Referral link: use code <b>ron17</b> and we both get $25 when you buy a $25+ package. The boards don't favour any book.</i></div></div>`;
      dlg.querySelector('.sup-x').focus();
    });
  }
  window.RonSupport = { open };
})();
