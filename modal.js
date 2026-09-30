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
