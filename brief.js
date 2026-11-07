// Ron's Tools: a board's small print, without the small print. chrome.js loads this on every page.
//
// Every board used to open with a line of tiny capitals and close on a paragraph, floating over the page's background.
// Nearly all of it was a fact worth one glance or a method worth reading once, so each now gets what suits it:
//   a fact (the day, a count, what's live)      a pill: `.u-p`, the first bold one the board's day (.day)
//   how it's made (a method, "no vig", a long   the board's one "How it works" sheet, which also takes every .t3-note
//     clause, what it's sorted by)              and long .pt-meta after it in the panel
//   a table's title (a meta with its own        a heading: .u-cap
//     margin-top, or one short line)
// No board calls this. It watches the page and sorts whatever a board wrote into .result-meta / .pt-meta / .t3-note / .pb-head,
// splitting on " · " and <br> (write a segment in <b> to keep it a fact). So write a meta line as before: keep each fact
// under 34 characters, one " · " apart, and it lands right. A line inside a modal or a card is left alone: it isn't loose.
(function () {
  const SEL = '.result-meta, .pt-meta, .t3-note, .pb-head', SKIP = '.pm-back, .pb-card, .rpc, .rc-tablewrap, .hm-tile';
  // said once in the sheet, not on every board
  const METHOD = /^\d{4}(-\d{2})?$|fair odds|no vig|negative-binomial|poisson prices|recalibrated|lines are draftkings|dk lines|projected box score|graded (once|against)|sorted by|ordered by|scores read|"g" =|if he plays|experimental/i;
  const FACT_MAX = 34, CAP_MAX = 80;
  const CSS = `
  .u-brief { display: flex; flex-wrap: wrap; align-items: center; gap: 0.35rem; margin: 0 0 0.6rem; font: 500 0.76rem var(--font-b); letter-spacing: 0; text-transform: none; color: var(--muted); }
  .result-meta.u-brief, .pt-meta.u-brief, .t3-note.u-brief { font: 500 0.76rem var(--font-b); letter-spacing: 0; text-transform: none; color: var(--muted); line-height: 1.2; }
  .u-p { display: inline-block; padding: 0.24rem 0.6rem; border-radius: 999px; background: var(--surface1); border: 1px solid var(--border); color: var(--muted); white-space: nowrap; }
  .u-p b { color: var(--text); font-weight: 700; }
  .u-p.day { color: var(--text-strong); font-weight: 700; }
  .u-p.day b { color: inherit; }
  .u-how { display: inline-flex; align-items: center; gap: 0.3rem; margin-left: auto; padding: 0.24rem 0.6rem 0.24rem 0.45rem; border-radius: 999px; background: var(--surface1); border: 1px solid var(--border); color: var(--muted); font: 600 0.74rem var(--font-b); cursor: pointer; white-space: nowrap; }
  .u-how:hover { color: var(--text); border-color: var(--border2); }
  .u-how[hidden] { display: none; }
  .u-how svg { width: 14px; height: 14px; }
  .result-meta.u-cap, .pt-meta.u-cap { font: 700 0.9rem var(--font-d); letter-spacing: 0.01em; text-transform: none; color: var(--text-strong); line-height: 1.3; margin-bottom: 0.45rem; }
  .u-cap b { font-weight: inherit; }
  .u-gone { display: none !important; }
  .u-sheet { padding: 1.3rem 1.25rem 1.2rem; }
  .u-sheet h3 { font: 700 1.05rem var(--font-d); color: var(--text-strong); margin: 0 1.6rem 0.75rem 0; }
  .u-sheet p { font-size: 0.86rem; line-height: 1.55; color: var(--text); margin: 0 0 0.7rem; }
  .u-sheet p:last-child { margin-bottom: 0; }
  .u-sheet b { color: var(--text-strong); }
  .u-sheet .u-fine { display: flex; flex-wrap: wrap; gap: 0.35rem; margin-bottom: 0.8rem; }
  `;
  if (!document.getElementById('u-brief-css')) document.head.insertAdjacentHTML('beforeend', `<style id="u-brief-css">${CSS}</style>`);

  const HOW = `<button class="u-how" hidden onclick="RonBrief.open(this)"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 7.6v.2"/></svg>How it works</button>`;
  /** A line's segments, cut on " · " and <br> in its top-level text, so a span or link stays whole. */
  function segments(html) {
    const t = document.createElement('template'); t.innerHTML = html;
    const out = []; let cur = '';
    const push = () => { if (cur.trim()) out.push(cur.trim()); cur = ''; };
    for (const n of t.content.childNodes) {
      if (n.nodeType === 3) { const parts = n.textContent.split('·'); parts.forEach((p, i) => { if (i) push(); cur += p.replace(/&/g, '&amp;').replace(/</g, '&lt;'); }); }
      else if (n.nodeName === 'BR') push();
      else cur += n.outerHTML;
    }
    push();
    return out;
  }
  const plain = (h) => { const t = document.createElement('template'); t.innerHTML = h; return t.content.textContent.trim(); };

  function sortLine(el) {
    const week = el.classList.contains('pb-head') ? el.querySelector('.pb-week') : null;
    const src = week ? `<b>${week.innerHTML}</b> · ${el.querySelector('.pb-meta')?.innerHTML || ''}` : el.innerHTML, note = el.classList.contains('t3-note');
    el.__how = []; el.classList.remove('u-brief', 'u-cap', 'u-gone');
    if (!plain(src)) return null;
    const segs = note ? [] : segments(src), one = segs.length <= 1, len = plain(src).length;
    if (note) { el.__how = [src]; el.classList.add('u-gone'); return 'note'; }
    if (week && one) { el.innerHTML = `<span class="u-p day">${week.innerHTML}</span>`; el.classList.add('u-brief'); return 'brief'; }
    if (el.classList.contains('result-meta') && el.style.marginTop && one) { el.classList.add('u-cap'); return 'cap'; }
    if (one && len <= CAP_MAX && !/<b>.*(,|\d{1,2})/i.test(src)) { el.classList.add('u-cap'); return 'cap'; }
    if (one && len > CAP_MAX) { el.__how = [src]; el.classList.add('u-gone'); return 'note'; }
    const facts = [], how = [];
    for (const s of segs) { const p = plain(s); if (!p) continue; if (!METHOD.test(p) && p.length <= FACT_MAX) facts.push(s); else how.push(s); }
    el.classList.add('u-brief');
    el.innerHTML = facts.map((s, i) => `<span class="u-p${i === 0 && /^<b>/.test(s) ? ' day' : ''}">${s}</span>`).join('') + HOW;
    el.__how = how;
    return 'brief';
  }
  function sweep() {
    const panels = new Map();
    for (const el of document.querySelectorAll(SEL)) {
      if (el.closest(SKIP)) continue;
      if (el.__out !== el.innerHTML) { el.__kind = sortLine(el); el.__out = el.innerHTML; }
      const p = el.closest('.panel') || document.body;
      (panels.get(p) || panels.set(p, []).get(p)).push(el);
    }
    // each note joins the brief before it in its panel; one with no brief to join keeps a button of its own, where it stood
    for (const els of panels.values()) {
      let last = null; const add = new Map();
      for (const el of els) {
        if (el.offsetParent === null && !el.classList.contains('u-gone')) continue;   // a hidden sub-view's line isn't this one's brief
        if (el.__kind === 'brief') { last = el; add.set(el, []); }
        else if (el.__kind === 'note') {
          if (last) add.get(last).push(...el.__how);
          else { el.classList.remove('u-gone'); el.classList.add('u-brief'); el.innerHTML = HOW; el.__kind = 'brief'; el.__out = el.innerHTML; last = el; add.set(el, el.__how.slice()); el.__how = []; }
        }
      }
      for (const [b, extra] of add) {
        b.__all = [...new Set([...b.__how, ...extra])];
        const btn = b.querySelector('.u-how'); if (btn && btn.hidden === !!b.__all.length) { btn.hidden = !b.__all.length; b.__out = b.innerHTML; }
      }
    }
  }
  /** A clause reads as a sentence on its own: a capital first, a full stop last. */
  const sentence = (h) => { const s = h.trim(); return s.replace(/^([a-z])/, c => c.toUpperCase()) + (/[.!?:)]$|<\/(b|a|span)>$/.test(s) ? '' : '.'); };
  function open(btn) {
    const b = btn.closest('.u-brief'), all = b?.__all || [], short = all.filter(x => plain(x).length < 60), long = all.filter(x => plain(x).length >= 60);
    const dlg = RonModal.open('u-how-sheet', { cls: 'pm ydm' });
    dlg.innerHTML = `<button class="pm-x" onclick="RonModal.close('u-how-sheet')" aria-label="Close">×</button><div class="u-sheet"><h3>How it works</h3>
      ${short.length ? `<div class="u-fine">${short.map(x => `<span class="u-p">${x.replace(/^([a-z])/, c => c.toUpperCase())}</span>`).join('')}</div>` : ''}${long.map(x => `<p>${sentence(x)}</p>`).join('')}</div>`;
  }
  window.RonBrief = { open, sweep };

  let q = false;
  const go = () => { q = false; sweep(); };
  new MutationObserver(() => { if (!q) { q = true; queueMicrotask(go); } }).observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] });
  sweep();
})();
