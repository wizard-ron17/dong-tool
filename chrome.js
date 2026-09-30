// Ron's Tools chrome: the parts every app shares, drawn once. The main nav
// (Home / Stats / Recap / Schedule / Tools), the tools menu, the sport
// switcher, the light/dark toggle and the footer.
//
// Each app keeps empty placeholders with the same ids and classes it always
// had (so its own CSS and code still find them) and passes what differs:
//
//   <nav id="main-nav"></nav>
//   <div class="nav-tools-menu" id="nav-tools-menu"></div>
//   <footer class="site-foot"></footer>
//   <script>RonChrome.mount({ sport: 'nba', season: '2026-27', credit: 'A hoop tool', tools: [...] })</script>
//
// mount() fills whichever placeholders exist when it's called and remembers
// the config, so a page whose footer comes later just calls RonChrome.mount()
// again after it. The sport menu builds itself. Loaded in <head>, before the
// page's own scripts, which use the globals at the bottom (toggleTheme,
// closeNavTools, currentTheme, ...).
(function () {
  // One list for the switcher, in launch order. A new sport is one line here.
  const SPORTS = [
    ['mlb', '⚾', "Ron's Dong Tool", 'MLB'],
    ['nfl', '🏈', "Ron's Tud Tool", 'NFL'],
    ['nhl', '🏒', "Ron's Goal Tool", 'NHL'],
    ['nba', '🏀', "Ron's Hoop Tool", 'NBA'],
  ];
  const NAV = [
    ["home", "<svg viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><path d=\"M3 11.2 12 4l9 7.2M5.5 9.4V20h13V9.4\"/></svg>", "Home"],
    ["stats", "<svg viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\"><path d=\"M5 20v-7M12 20V5.5M19 20v-10\"/></svg>", "Stats"],
    ["recap", "<svg viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\"><circle cx=\"12\" cy=\"12\" r=\"8.5\"/><path d=\"M12 7.5V12l3.2 1.9\"/></svg>", "Recap"],
    ["schedule", "<svg viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\"><rect x=\"4\" y=\"5.5\" width=\"16\" height=\"14.5\" rx=\"2\"/><path d=\"M8 3.5v4M16 3.5v4M4 10.5h16\"/></svg>", "Schedule"],
    [null, "<svg viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linejoin=\"round\"><rect x=\"4\" y=\"4\" width=\"6.5\" height=\"6.5\" rx=\"1.5\"/><rect x=\"13.5\" y=\"4\" width=\"6.5\" height=\"6.5\" rx=\"1.5\"/><rect x=\"4\" y=\"13.5\" width=\"6.5\" height=\"6.5\" rx=\"1.5\"/><rect x=\"13.5\" y=\"13.5\" width=\"6.5\" height=\"6.5\" rx=\"1.5\"/></svg>", "Tools"],
  ];
  const SOCIAL = [
    ["YouTube", "<svg viewBox=\"0 0 24 24\" fill=\"currentColor\"><path d=\"M23.5 6.2s-.2-1.6-.9-2.3c-.8-.9-1.8-.9-2.2-1C17.6 2.6 12 2.6 12 2.6h0s-5.6 0-8.4.3c-.4.1-1.4.1-2.2 1-.7.7-.9 2.3-.9 2.3S0 8.1 0 10v1.9c0 1.9.2 3.8.2 3.8s.2 1.6.9 2.3c.8.9 1.9.8 2.4.9 1.7.2 7.5.3 7.5.3s5.6 0 8.4-.3c.4 0 1.4-.1 2.2-1 .7-.7.9-2.3.9-2.3s.2-1.9.2-3.8V10c0-1.9-.2-3.8-.2-3.8zM9.5 14.7V7.3l6.4 3.7-6.4 3.7z\"/></svg>", "https://www.youtube.com/@greenmeansgosports"],
    ["X", "<svg viewBox=\"0 0 24 24\" fill=\"currentColor\"><path d=\"M18.9 2H22l-7.6 8.7L23 22h-6.6l-5.2-6.8L5 22H2l8.1-9.3L1.5 2h6.8l4.7 6.2L18.9 2z\"/></svg>", "https://x.com/GMGoBetting"],
    ["Discord", "<svg viewBox=\"0 0 24 24\" fill=\"currentColor\"><path d=\"M20.3 4.4A19.5 19.5 0 0 0 15.6 3c-.2.4-.5.9-.7 1.3a18 18 0 0 0-5.8 0c-.2-.4-.4-.9-.7-1.3a19.6 19.6 0 0 0-4.7 1.4C1.7 8 1 11.5 1.3 15a19.8 19.8 0 0 0 5.6 2.8c.4-.6.8-1.2 1.1-1.9-.6-.2-1.2-.5-1.7-.9.1-.1.3-.2.4-.3a14 14 0 0 0 11.8 0c.1.1.3.2.4.3-.5.4-1.1.7-1.7.9.3.7.7 1.3 1.1 1.9A19.8 19.8 0 0 0 22.7 15c.4-4-.6-7.5-2.4-10.6zM8.5 12.8c-.8 0-1.4-.7-1.4-1.6 0-.9.6-1.6 1.4-1.6.8 0 1.5.7 1.4 1.6 0 .9-.6 1.6-1.4 1.6zm7 0c-.8 0-1.4-.7-1.4-1.6 0-.9.6-1.6 1.4-1.6.8 0 1.5.7 1.4 1.6 0 .9-.6 1.6-1.4 1.6z\"/></svg>", "https://gmgsports.buildr.bet/"],
  ];
  const SUN_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="4.2"/><path d="M12 2v2.4M12 19.6V22M4.2 4.2l1.7 1.7M18.1 18.1l1.7 1.7M2 12h2.4M19.6 12H22M4.2 19.8l1.7-1.7M18.1 5.9l1.7-1.7"/></svg>';
  const MOON_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.9A9 9 0 1 1 11.1 3a7 7 0 0 0 9.9 9.9z"/></svg>';

  let CFG = null;
  const themeHooks = [];

  // ── Markup ────────────────────────────────────────────────────────────────
  function navHtml(c) {
    const dis = c.navDisabled ? ' disabled' : '';
    return NAV.map(([nav, icon, label]) => nav
      ? `<button class="nav-btn${nav === 'home' ? ' active' : ''}" data-nav="${nav}" onclick="switchNav('${nav}')"${nav === 'home' ? '' : dis}>${icon}<span>${label}</span></button>`
      : `<button class="nav-btn" id="nav-tools-btn" onclick="toggleNavTools(event)"${dis}>${icon}<span>${label}</span><span class="nav-caret">▶</span></button>`).join('');
  }
  /**
   * tools: [{ group: 'Offense', g: 'g1' } | { nav, g, icon, name, desc, isNew?, soon? }]
   * g1-g4 pick the group's colour; `name` may carry a badge (<span class="nm-new">NEW</span>).
   * A `soon` item (or every item, with toolsDisabled, until the page enables them) is disabled.
   */
  function toolsHtml(c) {
    return (c.tools || []).map(t => t.group != null
      ? `<div class="nav-menu-group ${t.g}">${t.group}</div>`
      : `<button class="nav-menu-item${t.isNew ? ' nav-menu-new' : ''} ${t.g}"${t.nav ? ` data-nav="${t.nav}" onclick="switchNav('${t.nav}')"` : ''}${t.soon || c.toolsDisabled ? ' disabled' : ''}>
    <span class="nm-head"><span class="nm-chip">${t.icon}</span><span class="nm-name">${t.name}</span><span class="nm-go" aria-hidden="true">&rarr;</span></span>
    <span class="nm-desc">${t.desc}</span>
  </button>`).join('\n');
  }
  function sportMenuHtml(cur) {
    return SPORTS.map(([sp, ico, name, sub]) =>
      `<a class="sport-item${sp === cur ? ' current' : ''}" href="/${sp}/"><span class="sport-ico">${ico}</span><span class="sport-name">${name}</span><span class="sport-sub">${sub}</span></a>`).join('');
  }
  function footHtml(c) {
    const lbl = (SPORTS.find(s => s[0] === c.sport) || [])[3] || c.sport.toUpperCase();
    return `<span class="foot-data">${lbl} · <span id="eyebrow-season">${c.season}</span> · ${c.source ? c.source + ' · ' : ''}<span id="status-badge" class="status-badge fetching">Loading</span></span>
    <span class="foot-credit">${c.credit} inspired by Green Means Go · <a class="rw-about" href="javascript:void(0)" onclick="RonWelcome.open()" style="color:inherit;text-decoration:underline;text-underline-offset:2px">About</a>
      <span class="social-links">${SOCIAL.map(([label, svg, href]) => `<a href="${href}" target="_blank" rel="noopener" aria-label="${label}">${svg}</a>`).join('')}</span>
    </span>`;
  }

  /** Fill the placeholders that exist now; remember the config for the ones that come later. */
  function mount(cfg) {
    if (cfg) CFG = { ...CFG, ...cfg };
    const c = CFG; if (!c) return;
    const fill = (el, html) => { if (el && !el.dataset.rt) { el.innerHTML = html; el.dataset.rt = '1'; } };
    fill(document.getElementById('main-nav'), navHtml(c));
    if (c.tools) fill(document.getElementById('nav-tools-menu'), toolsHtml(c));
    fill(document.querySelector('footer.site-foot'), footHtml(c));
    if (!document.getElementById('sport-menu') && document.body) {
      document.body.insertAdjacentHTML('beforeend', `<div class="sport-menu" id="sport-menu">${sportMenuHtml(c.sport)}</div>`);
    }
    updateThemeToggleIcon();
  }

  // ── Theme ─────────────────────────────────────────────────────────────────
  // The pre-paint script in each page's <head> already set data-theme; this
  // wires the toggle, keeps its icon (what you'd switch TO) and tells the page.
  function currentTheme() { return document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark'; }
  function updateThemeToggleIcon() { const b = document.getElementById('theme-toggle'); if (b) b.innerHTML = currentTheme() === 'light' ? MOON_SVG : SUN_SVG; }
  function toggleTheme() {
    const n = currentTheme() === 'light' ? 'dark' : 'light';
    document.documentElement.setAttribute('data-theme', n);
    try { localStorage.setItem('theme', n); } catch (e) {}
    updateThemeToggleIcon();
    themeHooks.forEach(f => { try { f(n); } catch (e) { console.error(e); } });
  }
  /** Run on every flip: pages repaint their theme-matched team logos here. */
  const onTheme = (f) => { themeHooks.push(f); };

  // ── Sport switcher ────────────────────────────────────────────────────────
  // Jump straight to another app; the logo goes to the full landing page.
  function sportBackdrop(on) {
    let el = document.getElementById('sport-backdrop');
    if (!el) {
      el = document.createElement('div');
      el.id = 'sport-backdrop';
      el.className = 'sport-backdrop';
      el.addEventListener('click', closeSportMenu);
      document.body.appendChild(el);
    }
    el.classList.toggle('open', on);
    document.body.classList.toggle('sport-open', on);
  }
  /** Hang the menu under the arrow, right-aligned to it, clamped to the screen. */
  function placeSportMenu(menu, btn) {
    const r = btn.getBoundingClientRect(), w = menu.offsetWidth, pad = 12;
    menu.style.top = Math.round(r.bottom + 8) + 'px';
    menu.style.left = Math.round(Math.max(pad, Math.min(r.right - w, window.innerWidth - w - pad))) + 'px';
  }
  function toggleSportMenu(e) {
    e.stopPropagation();
    const menu = document.getElementById('sport-menu'), btn = document.getElementById('sport-switch-btn');
    if (!menu || !btn) return;
    const open = menu.classList.toggle('open');
    btn.classList.toggle('open', open);
    sportBackdrop(open);
    if (open) placeSportMenu(menu, btn);   // after .open, so offsetWidth is real
  }
  function closeSportMenu() {
    document.getElementById('sport-menu')?.classList.remove('open');
    document.getElementById('sport-switch-btn')?.classList.remove('open');
    if (document.getElementById('sport-backdrop')) sportBackdrop(false);
  }

  // ── Tools menu ────────────────────────────────────────────────────────────
  let navToolsOpen = false;
  const toolsEls = () => ['nav-tools-menu', 'nav-tools-backdrop', 'main-nav'].map(id => document.getElementById(id));
  function openNavTools() { navToolsOpen = true; const [m, b, n] = toolsEls(); m?.classList.add('open'); b?.classList.add('open'); n?.classList.add('tools-open'); }
  function closeNavTools() { navToolsOpen = false; const [m, b, n] = toolsEls(); m?.classList.remove('open'); b?.classList.remove('open'); n?.classList.remove('tools-open'); }
  function toggleNavTools(e) { e?.stopPropagation(); navToolsOpen ? closeNavTools() : openNavTools(); }

  // A tap outside either menu closes it (the sport menu lives at body level, not
  // inside .sport-switch, so both have to be named), and so does Escape.
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.sport-switch, .sport-menu')) closeSportMenu();
    if (navToolsOpen && !e.target.closest('#nav-tools-menu') && !e.target.closest('#nav-tools-btn')) closeNavTools();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (navToolsOpen) closeNavTools();
    closeSportMenu();
  });
  document.addEventListener('DOMContentLoaded', () => mount());

  // ── Showing a page ────────────────────────────────────────────────────────
  /**
   * The part of every app's switchNav that's the same everywhere: show the
   * panel, light its nav button (the Tools button on a tool's page, and the
   * tool in the menu), set the tab title, close the menu. The app keeps its
   * own state, rendering and URL.
   */
  function show(nav, { title } = {}) {
    document.querySelectorAll('.panel').forEach(p => p.classList.toggle('visible', p.id === 'panel-' + nav));
    document.querySelectorAll('.nav-btn[data-nav]').forEach(b => b.classList.toggle('active', b.dataset.nav === nav));
    document.getElementById('nav-tools-btn')?.classList.toggle('active', (CFG?.tools || []).some(t => t.nav === nav));
    document.querySelectorAll('.nav-menu-item[data-nav]').forEach(b => b.classList.toggle('active', b.dataset.nav === nav));
    // a page with no title of its own gets one from its tools-menu name
    const app = (SPORTS.find(x => x[0] === CFG?.sport) || [])[2] || document.title;
    const t = (CFG?.tools || []).find(x => x.nav === nav), btn = NAV.find(x => x[0] === nav);
    const plain = (html) => { const d = document.createElement('div'); d.innerHTML = html; d.querySelectorAll('.nm-new, .nm-soon').forEach(x => x.remove()); return d.textContent.trim(); };
    const name = t ? plain(t.name) : nav !== 'home' && btn ? btn[2] : '';
    document.title = title || (name ? `${name} · ${app}` : app);
    closeNavTools();
  }

  window.RonChrome = { mount, onTheme, show, SPORTS };
  Object.assign(window, { currentTheme, updateThemeToggleIcon, toggleTheme, sportBackdrop, placeSportMenu, toggleSportMenu, closeSportMenu, openNavTools, closeNavTools, toggleNavTools });
  Object.defineProperty(window, 'navToolsOpen', { get: () => navToolsOpen, configurable: true });
})();
