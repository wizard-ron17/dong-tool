// home.js: the home page's card dressing, the same on every sport (11/17, Ron: other agents' mockups "pop more").
// chrome.js loads it. Each app still draws its own home cards (.hm-card > .hm-head > .hm-title); this adds:
//   - an icon chip on each card's title: the tool's own icon from the Tools menu (RonChrome.icons), in its group's colour
//     (g1-g4, the menu's categorical hues, never the good/bad ramp); Stats / Recap / Schedule take the main nav's icon
//   - elevation: an accent-tinted border, a soft drop shadow, a faint top sheen, and an accent glow on hover
//   - stat tiles with an accent wash; player photos on a team-colour disc, zoomed to the face (MLB: the matchup tool's spot)
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
  /* player faces (11/17, Ron: "like the MLB matchup tool"): a team-colour disc, zoomed in on the face, ringed in the
     team colour. The page's .hm-photo / .rc-photo is wrapped in .hm-face; --tc comes from window.ronTeamColor(team). */
  #home-content .hm-face { --tc: var(--accent); position: relative; width: 40px; height: 40px; flex: none; border-radius: 50%; overflow: hidden;
    background: radial-gradient(circle at 50% 30%, color-mix(in srgb, var(--tc) 72%, #fff 28%), var(--tc) 58%, color-mix(in srgb, var(--tc) 70%, #000 30%));
    box-shadow: 0 0 0 2px var(--surface0), 0 0 0 3.5px color-mix(in srgb, var(--tc) 75%, transparent), 0 0 12px -2px color-mix(in srgb, var(--tc) 55%, transparent); }
  #home-content .hm-face > img { position: absolute; inset: 0; width: 100%; height: 100%; margin: 0; border-radius: 0; border: 0; box-shadow: none;
    background: transparent; object-fit: cover; object-position: center top; transform: scale(1.32); transform-origin: 50% 8%; }
  #home-content .hm-face.spot > img { transform: none; }
  #home-content .hm-face.mug > img { transform: scale(1.62); transform-origin: 50% 14%; }   /* NHL mugs frame the whole chest */        /* MLB's spot is already a close-up on a team-colour disc */
  #home-content .hm-face > div { position: absolute; inset: 0; width: 100%; height: 100%; margin: 0; border: 0; border-radius: 0; background: transparent;
    display: flex; align-items: center; justify-content: center; color: #fff; font-weight: 700; font-size: 0.8rem; text-shadow: 0 1px 2px rgba(0,0,0,0.5); }
  #home-content .hm-face.lt > div { color: #10161f; text-shadow: none; }       /* initials on a light team colour */
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
  // the player's team: a data-team on the photo or row, the NHL mug's path (/mugs/nhl/<season>/<TEAM>/), else the first
  // word of the row's small print that names a team ("RB DAL vs TEN", "SJS vs CGY", "IND · 3 wks": own team comes first)
  function teamOf(img, row, col) {
    const d = img.dataset.team || row.dataset.team; if (d) return d;
    const m = (img.getAttribute('src') || '').match(/\/mugs\/nhl\/\d+\/([A-Z]{2,4})\//); if (m) return m[1];
    const sub = [...row.querySelectorAll('.hm-subtle')].map(x => x.textContent).join(' ');    // a leaderboard's rank is one too
    return sub.split(/[^A-Za-z]+/).find(w => w && w === w.toUpperCase() && col(w)) || null;
  }
  // ronTeamColor(team) gives a colour or [primary, alt]; a near-black primary (LA Kings, Nets) reads as no colour on a
  // dark card, so it takes the alt
  const dark = (h) => /^#[0-9a-f]{6}$/i.test(h) && Math.max(...[1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16))) < 0x38;
  const pick = (c) => { const [p, a] = Array.isArray(c) ? c : [c]; return p && dark(p) && a ? a : p; };
  const light = (h) => /^#[0-9a-f]{6}$/i.test(h) && [1, 3, 5].reduce((s, i, k) => s + [0.299, 0.587, 0.114][k] * parseInt(h.slice(i, i + 2), 16), 0) > 150;
  const MLB_HEAD = /img\.mlbstatic\.com\/.*\/people\/(\d+)\/headshot\//;
  function faces(root) {
    const col = window.ronTeamColor; if (typeof col !== 'function') return;
    for (const img of root.querySelectorAll('.hm-row > .hm-photo, .hm-row > .rc-photo')) {
      const row = img.parentElement, t = teamOf(img, row, col), c = t && pick(col(t));
      const w = document.createElement('span'); w.className = 'hm-face' + (c && light(c) ? ' lt' : ''); if (c) w.style.setProperty('--tc', c);
      if (/assets\.nhle\.com\/mugs\//.test(img.getAttribute('src') || '')) w.classList.add('mug');
      const mlb = img.tagName === 'IMG' && (img.getAttribute('src') || '').match(MLB_HEAD);
      if (mlb) {                                                   // the matchup tool's team-colour close-up, the headshot if none
        w.classList.add('spot'); const orig = img.src;
        img.onerror = () => { img.onerror = null; img.src = orig; w.classList.remove('spot'); };
        img.src = `https://midfield.mlbstatic.com/v1/people/${mlb[1]}/spots/240`;
      }
      row.insertBefore(w, img); w.appendChild(img);
    }
  }
  let map = null;
  function paint() {
    const root = document.getElementById('home-content'); if (!root) return;
    faces(root);
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
