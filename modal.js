// Ron's Tools modals: one stack manager for every card and sheet on the site.
//
// Every modal here follows one convention: a full-screen backdrop added to
// <body> (never inside .wrap, whose z-index traps it under the blur), whose own
// click closes it, with optional ‹ › buttons (.pk-side-prev / .pk-side-next).
// Each one used to lock scrolling and listen for keys on its own, which broke
// as soon as two were open at once (a player card over a game card):
//   - closing the top card set body overflow back, so the page behind the
//     card still open scrolled;
//   - Escape reached every card's listener and closed the whole stack.
// This file owns both, for every modal at once:
//   - scroll: locked while any modal is in the page, released when the last goes;
//   - Escape closes only the top modal (by clicking its backdrop, which is
//     exactly what the page's own close does); ← → step only the top one (its
//     ‹ › buttons), so a card underneath stays put.
// Pages keep their own open/close code; nothing has to register.
//
// New modals can use the helper instead of writing it again:
//   const dlg = RonModal.open('xx-back', { cls: 'pm ydm', onClose: () => {...}, nav: { prev: 'xxStep(-1)', next: 'xxStep(1)' } });
//   dlg.innerHTML = ...;            // RonModal.close('xx-back') to close
(function () {
  // Styles for the modal frame: backdrop, ‹ › side buttons, close: the rules that were identical in all four apps.
  // Injected from <head>, so each page's own <style> (loaded after) still wins.
  // A rule with a page-specific override of the same selector stays in the page.
  const CSS = `
  .pk-side-nav:hover:not(:disabled) { background: var(--accent); border-color: var(--accent); color: #fff; }
  .pk-side-nav:disabled { opacity: 0.22; cursor: default; }
  .pk-side-prev { left: 0.5rem; }
  .pk-side-next { right: 0.5rem; }
  .pm-back .pk-side-nav { z-index: 320; }
  .pm-back .pk-side-prev { left: max(0.35rem, calc(50% - 322px)); }
  .pm-back .pk-side-next { right: max(0.35rem, calc(50% - 322px)); }
  .pm-x { position: absolute; top: 0.55rem; right: 0.7rem; background: none; border: none; color: var(--dim); font-size: 1.45rem; line-height: 1; cursor: pointer; z-index: 2; }
  .pm-x:hover { color: var(--text); }
  .model-help-btn { display: inline-flex; align-items: center; justify-content: center; width: 1.05rem; height: 1.05rem; margin-left: 0.4rem; padding: 0; vertical-align: -0.1rem; border: 1px solid var(--border2); border-radius: 50%; background: none; color: var(--dim); font: 700 0.66rem/1 var(--font-b); cursor: pointer; transition: color 0.14s, border-color 0.14s; }
  .model-help-btn:hover { color: var(--accent); border-color: var(--accent); }
  .model-help-dialog { max-width: 620px; padding: 1rem 1.3rem 1.3rem; }
  .model-help-title { margin: 0 1.3rem 0.75rem; color: var(--text-strong); font: 700 0.88rem var(--font-d); letter-spacing: 0.08em; text-align: center; text-transform: uppercase; }
  .model-help-intro, .model-help-note { margin: 0 0 0.75rem; color: var(--muted); font-size: 0.8rem; line-height: 1.5; }
  .model-help-eq { display: flex; align-items: flex-end; justify-content: center; gap: 0.55rem; flex-wrap: wrap; margin: 0.2rem 0 0.8rem; padding: 0.6rem; border: 1px solid var(--border); border-radius: 10px; background: var(--surface0); }
  .model-help-eq span { display: flex; flex-direction: column; align-items: center; }
  .model-help-eq b { color: var(--text-strong); font: 700 1rem var(--font-d); }
  .model-help-eq small { margin-top: 0.1rem; color: var(--dim); font-size: 0.6rem; text-align: center; text-transform: uppercase; }
  .model-help-eq i { padding-bottom: 0.8rem; color: var(--dim); font: normal 0.9rem var(--font-d); }
  .model-help-row { padding: 0.6rem 0 0.1rem; border-top: 1px solid var(--border); color: var(--muted); font-size: 0.8rem; line-height: 1.5; }
  .model-help-row-hd { display: flex; align-items: baseline; justify-content: space-between; gap: 0.5rem; }
  .model-help-row-hd strong { color: var(--accent); font: 700 0.8rem var(--font-d); white-space: nowrap; }
  .model-help-row p { margin: 0.22rem 0; }
  .model-help-row .model-help-def { color: var(--dim); }
  .model-help-row b, .model-help-intro b, .model-help-note b { color: var(--text); }
  .model-help-note { padding-top: 0.65rem; border-top: 1px solid var(--border); margin: 0; }
  @media (min-width: 620px) {
    .pk-side-prev { left: calc(50% - 296px); }
    .pk-side-next { right: calc(50% - 296px); }
  }
  @media (max-width: 619px) {
    .pm-back .pk-side-nav { width: 28px; height: 48px; font-size: 1.35rem; }
    .pm-back .pk-side-prev { left: 0.3rem; }
    .pm-back .pk-side-next { right: 0.3rem; }
  }
`;
  if (!document.getElementById('modal-css')) document.head.insertAdjacentHTML('beforeend', `<style id="modal-css">${CSS}</style>`);

  const SEL = '.pm-back, .rw-back, .ps-back, .due-modal-backdrop, .sb-modal-backdrop, .dd-backdrop, .st-backdrop';
  const zOf = (el) => parseInt(getComputedStyle(el).zIndex, 10) || 0;
  /** Open modals, bottom to top: by z-index, then by order in the page. */
  function stack() {
    const all = [...document.querySelectorAll(SEL)];
    return all.map((el, i) => ({ el, z: zOf(el), i })).sort((a, b) => a.z - b.z || a.i - b.i).map(x => x.el);
  }
  const top = () => { const s = stack(); return s[s.length - 1] || null; };

  // ── Scroll lock ───────────────────────────────────────────────────────────
  // Re-derived from what's in the page after every change, so a page's own
  // `body.style.overflow = ''` on closing an inner card is put right at once.
  // Only a lock this file applied is released here: a page that locked for its
  // own reasons (full-screen reels) keeps its lock.
  let queued = false, ours = false;
  function sync() {
    queued = false;
    const open = stack().length > 0;
    if (open && document.body.style.overflow !== 'hidden') { document.body.style.overflow = 'hidden'; ours = true; }
    else if (!open && ours) { if (document.body.style.overflow === 'hidden') document.body.style.overflow = ''; ours = false; }
  }
  const queue = () => { if (!queued) { queued = true; queueMicrotask(sync); } };

  // ── Keys ──────────────────────────────────────────────────────────────────
  // Capture phase on window: runs before any page's own listener.
  window.addEventListener('keydown', (e) => {
    const s = stack(); if (!s.length) return;
    const t = s[s.length - 1];
    if (e.key === 'Escape') {
      // only when clicking the backdrop closes it (every modal here does); else leave it to the page
      if (!t.onclick && !t.getAttribute('onclick')) return;
      e.stopImmediatePropagation(); e.preventDefault();
      t.click();
      return;
    }
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      if (e.target.closest?.('input, textarea, select, [contenteditable]')) return;   // moving a cursor, not a card
      const b = t.querySelector(e.key === 'ArrowLeft' ? '.pk-side-prev' : '.pk-side-next');
      if (!b) return;                                  // the top card steps its own way
      e.stopImmediatePropagation(); e.preventDefault();
      if (!b.disabled) b.click();
    }
  }, true);

  // ── Helper for new modals ─────────────────────────────────────────────────
  const onClose = {};
  /**
   * Open (or reuse) a body-level modal with this backdrop id; returns its
   * dialog element to fill. `nav` adds the ‹ › buttons (onclick strings).
   */
  function open(id, { cls = 'pm', onClose: done, nav, label } = {}) {
    let back = document.getElementById(id);
    if (!back) {
      document.body.insertAdjacentHTML('beforeend', `
        <div class="pm-back" id="${id}" onclick="if(event.target===this)RonModal.close('${id}')">
          ${nav ? `<button class="pk-side-nav pk-side-prev" onclick="${nav.prev}" aria-label="Previous">‹</button>
          <button class="pk-side-nav pk-side-next" onclick="${nav.next}" aria-label="Next">›</button>` : ''}
          <div class="${cls}" role="dialog" aria-modal="true"${label ? ` aria-label="${label}"` : ''}></div>
        </div>`);
      back = document.getElementById(id);
    }
    if (done) onClose[id] = done;
    queue();
    return back.querySelector('[role="dialog"]');
  }
  function close(id) {
    const back = document.getElementById(id); if (!back) return;
    back.remove();
    const f = onClose[id]; delete onClose[id];
    queue();
    if (f) f();
  }
  /** Enable/disable the ‹ › buttons for where you are in the deck. */
  function navState(id, at, n) {
    const back = document.getElementById(id); if (!back) return;
    const p = back.querySelector('.pk-side-prev'), x = back.querySelector('.pk-side-next');
    if (p) p.disabled = at <= 0;
    if (x) x.disabled = at < 0 || at >= n - 1;
  }

  const start = () => {
    new MutationObserver(queue).observe(document.body, { childList: true, attributes: true, attributeFilter: ['style'] });
    sync();
  };
  if (document.body) start(); else document.addEventListener('DOMContentLoaded', start);
  window.RonModal = { open, close, navState, top, stack };
})();
