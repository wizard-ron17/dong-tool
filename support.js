// Support Ron: the footer's "Support Ron" link opens this. Ko-fi's own checkout, embedded (a tip by card or PayPal without
// leaving the page, money straight to Ron's Ko-fi), and the 4Cx referral beside it. Loaded on first use by chrome.js
// (RonChrome.support()) and the picker's footer; opens on a RonModal (modal.js, loaded here if the page lacks it).
// Ko-fi frames ko-fi.com/<page>/?hidefeed=true&widget=true&embed=true (what their own floating widget frames); if it can't
// load, the link under it opens the page in a new tab. Neutral pitch: support for a free site, never tied to winning.
(function () {
  if (window.RonSupport) return;
  const KOFI = 'tipron', REF = 'https://4cx.io/sign-up/ron17';
  const CSS = `
  #sup-back { position: fixed; inset: 0; z-index: 600; display: flex; align-items: flex-start; justify-content: center; padding: 1.5rem 0.9rem; overflow-y: auto;
    background: rgba(2,5,10,0.72); -webkit-backdrop-filter: blur(4px); backdrop-filter: blur(4px); }
  .sup { position: relative; width: 100%; max-width: 480px; margin: auto; border-radius: 16px; padding: 1.25rem 1.2rem 1.1rem;
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
  .sup-h { margin: 1rem 0 0.45rem; font: 700 0.7rem var(--font-d, 'Chakra Petch', sans-serif); letter-spacing: 0.12em; text-transform: uppercase; color: var(--dim, #5b6577); }
  .sup-kofi { position: relative; height: 560px; border-radius: 12px; overflow: hidden; background: #f9f9f9; }
  .sup-kofi iframe { position: absolute; inset: 0; width: 100%; height: 100%; border: 0; }
  .sup-wait { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; color: #6b7280; font-size: 0.82rem; }
  .sup-alt { margin-top: 0.4rem; font-size: 0.74rem; color: var(--muted, #8a94a6); text-align: center; }
  .sup a { color: var(--accent, var(--green, #33d07c)); text-decoration: none; font-weight: 600; }
  .sup a:hover { text-decoration: underline; text-underline-offset: 2px; }
  .sup-ref { display: flex; gap: 0.7rem; align-items: flex-start; padding: 0.75rem 0.9rem; border-radius: 12px; font-size: 0.82rem; line-height: 1.5;
    border: 1px solid color-mix(in srgb, var(--text, #e8edf5) 10%, transparent); }
  .sup-ref svg { flex: none; width: 18px; height: 18px; margin-top: 0.1rem; color: var(--accent, var(--green, #33d07c)); }
  .sup-ref b { display: block; font-size: 0.9rem; color: var(--text-strong, #fff); }
  .sup-ref i { display: block; margin-top: 0.25rem; font-style: normal; font-size: 0.72rem; color: var(--muted, #8a94a6); }
  @media (max-width: 480px) { #sup-back { padding: 0.8rem 0.5rem; } .sup { padding: 1.1rem 0.9rem 0.95rem; } .sup-kofi { height: 520px; } }`;

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
        <div class="sup-s">Ron's Tools is free: no ads, no paywall. The data and the builds behind it cost money, and tips keep it running. Thank you.</div>
        <div class="sup-h">Leave a tip</div>
        <div class="sup-kofi"><div class="sup-wait">Loading Ko-fi…</div>
          <iframe src="${page}/?hidefeed=true&widget=true&embed=true" title="Tip Ron on Ko-fi" loading="lazy" allow="payment"
            onload="this.previousElementSibling.remove()"></iframe></div>
        <div class="sup-alt">Card or PayPal, through Ko-fi. Not loading? <a href="${page}" target="_blank" rel="noopener">Open Ko-fi in a new tab</a></div>
        <div class="sup-h">Where I bet</div>
        <div class="sup-ref"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M7 7h11l-3-3M17 17H6l3 3"/></svg>
          <div><b><a href="${REF}" target="_blank" rel="sponsored noopener">Sign up for 4Cx</a>: we both get $25</b>
          It's Novig and ProphetX before their prediction-market switch: an exchange with zero fees that still shows American odds. A sweepstakes book, so check it's open in your state.
          <i>Referral link: use code <b>ron17</b> and we both get $25 when you buy a $25+ package. The boards don't favour any book.</i></div></div>`;
      dlg.querySelector('.sup-x').focus();
    });
  }
  window.RonSupport = { open };
})();
