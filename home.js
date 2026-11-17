// home.js: the home page's card dressing, the same on every sport (11/17, Ron: other agents' mockups "pop more").
// chrome.js loads it. Each app still draws its own home cards (.hm-card > .hm-head > .hm-title); this adds:
//   - an icon chip on each card's title: the tool's own icon from the Tools menu (RonChrome.icons), in its group's colour
//     (g1-g4, the menu's categorical hues, never the good/bad ramp); Stats / Recap / Schedule take the main nav's icon
//   - elevation: an accent-tinted border, a soft drop shadow, a faint top sheen, and an accent glow on hover
//   - stat tiles with an accent wash; ringed player photos
// Every colour is a token (--accent, --border, --surface*), so a holiday's palette carries through.
// Rules are scoped to #home-content so they win over the page's own .hm-* rules (module CSS loads first).
(function () {
  if (window.RonHome) return;
  const css = `
  #home-content { --hm-gc: var(--accent); }
  #home-content .hm-card { border-color: color-mix(in srgb, var(--accent) 22%, var(--border)); border-radius: 12px;
    background: linear-gradient(180deg, color-mix(in srgb, var(--accent) 5%, var(--surface0)), var(--surface0) 46px);
    box-shadow: 0 1px 0 rgba(255,255,255,0.035) inset, 0 10px 24px -14px rgba(0,0,0,0.55);
    transition: border-color 0.15s, box-shadow 0.15s, background 0.15s; }
  #home-content .hm-card:hover { border-color: color-mix(in srgb, var(--accent) 60%, var(--border));
    box-shadow: 0 1px 0 rgba(255,255,255,0.05) inset, 0 0 0 1px color-mix(in srgb, var(--accent) 22%, transparent), 0 10px 28px -12px color-mix(in srgb, var(--accent) 45%, transparent); }
  :root[data-theme="light"] #home-content .hm-card { box-shadow: 0 1px 2px rgba(16,40,28,0.06), 0 8px 20px -14px rgba(16,40,28,0.28); }
  :root[data-theme="light"] #home-content .hm-card:hover { box-shadow: 0 0 0 1px color-mix(in srgb, var(--accent) 25%, transparent), 0 10px 24px -12px color-mix(in srgb, var(--accent) 40%, transparent); }
  #home-content .hm-head { align-items: center; margin-bottom: 0.6rem; }
  #home-content .hm-title { display: inline-flex; align-items: center; gap: 0.5rem; font-size: 1.06rem; min-width: 0; }
  .hm-ico { --c: var(--hm-gc); width: 28px; height: 28px; flex: none; border-radius: 8px; display: inline-flex; align-items: center; justify-content: center;
    color: var(--c); background: color-mix(in srgb, var(--c) 16%, transparent); border: 1px solid color-mix(in srgb, var(--c) 34%, transparent);
    box-shadow: 0 0 14px -4px color-mix(in srgb, var(--c) 55%, transparent); }
  .hm-ico svg { width: 16px; height: 16px; }
  .hm-ico.g1 { --c: #2a9fb5; } .hm-ico.g2 { --c: #7a7ae8; } .hm-ico.g3 { --c: #d24e8e; } .hm-ico.g4 { --c: #c79a46; }
  :root[data-theme="light"] .hm-ico.g1 { --c: #0097b3; } :root[data-theme="light"] .hm-ico.g2 { --c: #6060d8; }
  :root[data-theme="light"] .hm-ico.g3 { --c: #c73c80; } :root[data-theme="light"] .hm-ico.g4 { --c: #a87a22; }
  #home-content .hm-link { font-size: 0.74rem; }
  #home-content .hm-tile { border-radius: 10px; border-color: color-mix(in srgb, var(--accent) 26%, var(--border));
    background: linear-gradient(160deg, color-mix(in srgb, var(--accent) 13%, var(--surface1)), var(--surface1) 70%); }
  #home-content .hm-photo { box-shadow: 0 0 0 2px var(--surface0), 0 0 0 3.5px color-mix(in srgb, var(--accent) 38%, transparent); }
  `;
  const st = document.createElement('style'); st.id = 'ron-home-css'; st.textContent = css;
  document.head.prepend(st);

  // which tool a card opens: switchNav('x'), or MLB's recap card (openRecapFor)
  const navOf = (card) => {
    if (card.dataset.hmIco) return card.dataset.hmIco;            // a card with no tool behind it names its icon
    const a = card.getAttribute('onclick') || '';
    const m = a.match(/switchNav\('([\w-]+)'/); if (m) return m[1];
    return /openRecapFor/.test(a) ? 'recap' : null;
  };
  let map = null;
  function paint() {
    const root = document.getElementById('home-content'); if (!root) return;
    const cards = root.querySelectorAll('.hm-card:not([data-ico])'); if (!cards.length) return;
    map ||= window.RonChrome?.icons?.();
    if (!map) return;
    for (const c of cards) {
      c.dataset.ico = '1';
      const t = c.querySelector('.hm-title'), i = map[navOf(c)];
      if (!t || !i) continue;
      t.insertAdjacentHTML('afterbegin', `<span class="hm-ico ${i.g || ''}" aria-hidden="true">${i.svg}</span>`);
    }
  }
  let q = false;
  const go = () => { if (!q) { q = true; requestAnimationFrame(() => { q = false; paint(); }); } };
  if (document.body) { new MutationObserver(go).observe(document.body, { childList: true, subtree: true }); go(); }
  else document.addEventListener('DOMContentLoaded', () => { new MutationObserver(go).observe(document.body, { childList: true, subtree: true }); go(); });
  window.RonHome = { paint };
})();
