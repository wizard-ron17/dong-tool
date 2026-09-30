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
  // Styles for the header, main nav, tools menu, sport switcher and footer: the rules that were identical in all four apps.
  // Injected from <head>, so each page's own <style> (loaded after) still wins.
  // A rule with a page-specific override of the same selector stays in the page.
  const CSS = `
  .tb-brand { display: flex; align-items: center; gap: 0.4rem; flex-shrink: 0; }
  .tb-right { display: flex; align-items: center; gap: 0.5rem; margin-left: auto; }
  .site-foot { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 0.5rem 1rem; margin: 2.2rem 0 0; padding: 0.9rem 0 0.4rem; border-top: 1px solid var(--border); font-size: 0.75rem; color: var(--muted); }
  .social-links { display: inline-flex; align-items: center; gap: 0.55rem; margin-left: 0.5rem; vertical-align: middle; }
  .social-links a { color: var(--muted); display: inline-flex; transition: color 0.15s; }
  .social-links a:hover { color: var(--accent); }
  .social-links svg { width: 15px; height: 15px; display: block; }
  .foot-data { font-size: 0.7rem; letter-spacing: 0.18em; text-transform: uppercase; display: flex; align-items: center; gap: 0.5rem; }
  .nav-shell { position: relative; z-index: 210; }
  .nav-btn { position: relative; display: flex; align-items: center; justify-content: center; gap: 0.35rem; background: transparent; border: none; border-radius: 8px; color: var(--muted); font-family: var(--font-d); font-size: 1.02rem; font-weight: 700; letter-spacing: 0.03em; padding: 0.45rem 0.7rem; cursor: pointer; transition: color 0.15s; white-space: nowrap; }
  .nav-btn.active::after { content: ''; position: absolute; left: 0.7rem; right: 0.7rem; bottom: -0.1rem; height: 2px; border-radius: 2px; background: var(--accent); }
  .nav-btn:disabled { opacity: 0.32; cursor: not-allowed; }
  .nav-btn svg { display: none; width: 20px; height: 20px; }
  .theme-toggle:hover { color: var(--accent); border-color: var(--accent); background: var(--surface2); }
  .theme-toggle svg { width: 18px; height: 18px; display: block; }
  :root[data-theme="light"] .status-badge.fetching { background: rgba(176,125,10,0.14); border-color: rgba(176,125,10,0.4); }
  .sport-switch { position: relative; display: inline-flex; vertical-align: middle; }
  .sport-switch-btn { margin-left: 0.5rem; width: 1.55rem; height: 1.55rem; display: inline-flex; align-items: center; justify-content: center; padding: 0; background: var(--surface1); border: 1px solid var(--border); border-radius: 8px; color: var(--muted); cursor: pointer; font-size: 0.766rem; line-height: 1; transition: color 0.12s, border-color 0.12s, background 0.12s; }
  .sport-switch-btn:hover { color: var(--text); border-color: var(--border2); background: var(--surface2); }
  .sport-switch-btn.open { color: var(--accent); border-color: var(--accent); }
  .sport-menu { position: fixed; top: 0; left: 0; z-index: 260; min-width: 230px; width: max-content; max-width: calc(100vw - 1.5rem); background: var(--surface0); border: 1px solid var(--border2); border-radius: 14px; padding: 0.4rem; box-shadow: 0 18px 48px rgba(0,0,0,0.55); display: none; }
  .sport-menu.open { display: block; animation: sportMenuIn 0.14s ease; }
  .sport-backdrop { position: fixed; inset: 0; z-index: 255; background: rgba(4,8,16,0.55); backdrop-filter: blur(3px); -webkit-backdrop-filter: blur(3px); opacity: 0; pointer-events: none; transition: opacity 0.18s; }
  .sport-backdrop.open { opacity: 1; pointer-events: auto; }
  body.sport-open { overflow: hidden; }
  .sport-item { display: flex; align-items: center; gap: 0.65rem; padding: 0.55rem 0.6rem; border-radius: 10px; text-decoration: none; color: var(--text); min-width: 0; }
  .sport-item .sport-name { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  a.sport-item:hover { background: var(--surface2); }
  .sport-item.current { background: rgba(51,208,124,0.12); }
  .sport-ico { font-size: 1.25rem; line-height: 1; width: 1.5rem; text-align: center; }
  .sport-name { font-family: var(--font-d); font-weight: 700; font-size: 0.92rem; }
  .sport-sub { margin-left: auto; font-size: 0.692rem; font-weight: 800; letter-spacing: 0.06em; text-transform: uppercase; color: var(--muted); }
  .sport-item.current .sport-sub { color: var(--accent); }
  #nav-tools-btn.active::after { display: none; }
  .nav-caret { display: inline-block; font-size: 0.766rem; font-weight: 900; line-height: 1; transition: transform 0.18s ease; }
  nav.tools-open .nav-caret { transform: rotate(90deg); }
  .nav-tools-backdrop { position: fixed; inset: 0; backdrop-filter: blur(3px); z-index: 235; background: rgba(4,8,16,0.55); opacity: 0; pointer-events: none; transition: opacity 0.2s; }
  .nav-tools-backdrop.open { opacity: 1; pointer-events: auto; }
  #nav-tools-btn { position: relative; color: var(--accent); background: color-mix(in srgb, var(--accent) 11%, transparent); box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--accent) 45%, transparent); }
  #nav-tools-btn:hover:not(.active):not(:disabled) { color: var(--accent); background: color-mix(in srgb, var(--accent) 19%, transparent); }
  #nav-tools-btn.active { color: #04170f; background: var(--accent); }
  .nav-menu-item { --gc: var(--accent); }
  .nav-menu-item.g1 { --gc: var(--g1); }
  .nav-menu-item.g2 { --gc: var(--g2); }
  .nav-menu-item.g3 { --gc: var(--g3); }
  .nav-menu-group::after { content: ''; flex: 1; height: 1px; background: var(--border); }
  .nav-menu-group.g1 { color: var(--g1); }
  .nav-menu-group.g2 { color: var(--g2); }
  .nav-menu-group.g3 { color: var(--g3); }
  .nav-menu-group:first-child { padding-top: 0.15rem; }
  .nav-menu-item { display: flex; flex-direction: column; align-items: center; text-align: center; gap: 0.3rem; width: 100%; background: var(--surface0); border: none; border-radius: 11px; padding: 0.6rem 0.4rem; cursor: pointer; transition: background 0.15s, border-color 0.15s, transform 0.15s; }
  .nav-menu-item:hover:not(:disabled) { background: var(--surface2); }
  .nav-menu-item:disabled { opacity: 0.32; cursor: not-allowed; }
  .nav-menu-item svg { width: 21px; height: 21px; flex-shrink: 0; color: var(--muted); }
  .nm-chip { width: 34px; height: 34px; border-radius: 50%; flex-shrink: 0; display: inline-flex; align-items: center; justify-content: center; background: color-mix(in srgb, var(--gc) 18%, transparent); color: var(--gc); }
  .nav-menu-item .nm-chip svg { width: 18px; height: 18px; color: inherit; }
  .nav-menu-item .nm-name { font-family: var(--font-d); font-size: 1.06rem; font-weight: 700; color: var(--text); display: block; line-height: 1.2; letter-spacing: 0.005em; }
  .nav-menu-item .nm-desc { display: block; font-size: 0.735rem; line-height: 1.35; color: var(--dim); }
  .nm-go { margin-left: auto; align-self: center; flex-shrink: 0; color: var(--dim); font-size: 0.9rem; line-height: 1; transition: color 0.14s, transform 0.14s; }
  .nav-menu-item.active .nm-name { color: var(--gc); }
  @media (max-width: 600px) {
    .tb-brand { gap: 0.25rem; min-width: 0; }
    .nav-btn { flex: 1 1 0; min-width: 0; flex-direction: column; gap: 0.18rem; font-size: 0.692rem; font-weight: 700; letter-spacing: 0.02em; padding: 0.42rem 0.1rem 0.3rem; border-radius: 10px; }
    .nav-btn svg { display: block; }
    .sport-menu { min-width: 0; width: min(260px, calc(100vw - 1.5rem)); }
    .nav-caret { display: none; }
    .nav-tools-backdrop { background: rgba(0,0,0,0.45); bottom: calc(var(--nav-bottom) + var(--nav-h)); }
    #nav-tools-btn { border-radius: 14px; }
    .nav-menu-group:first-child { padding-top: 0.1rem; }
    .nav-menu-item { flex-direction: column; align-items: flex-start; text-align: left; gap: 0.3rem; padding: 0.6rem 0.55rem 0.62rem 0.7rem; border-radius: 12px; background: linear-gradient(140deg, color-mix(in srgb, var(--gc) 13%, var(--surface0)), var(--surface0) 70%); border: 1px solid color-mix(in srgb, var(--gc) 20%, var(--border)); border-left: 3px solid var(--gc); }
    .nav-menu-item:hover:not(:disabled), .nav-menu-item.active { border-color: var(--gc); border-left-color: var(--gc); }
    .nav-menu-item .nm-name { font-size: 0.95rem; line-height: 1.2; }
    .nav-menu-item .nm-desc { display: block; font-size: 0.7rem; line-height: 1.32; }
    .nav-menu-item svg { width: 23px; height: 23px; }
    .nm-chip { width: 26px; height: 26px; }
    .nav-menu-item .nm-chip svg { width: 15px; height: 15px; }
    .nm-head { display: flex; align-items: center; gap: 0.4rem; width: 100%; }
    .nm-head .nm-go { font-size: 0.8rem; }
  }
  @media (min-width: 601px) {
    .nav-tools-menu .nav-menu-item { display: grid; grid-template-columns: auto minmax(0,1fr) auto; grid-template-areas: "chip name go" "chip desc go"; align-items: center; column-gap: 0.62rem; row-gap: 0.1rem; text-align: left; padding: 0.8rem 0.85rem; border-radius: 14px; background: linear-gradient(140deg, color-mix(in srgb, var(--gc) 11%, var(--surface0)), var(--surface0) 72%); border: 1px solid color-mix(in srgb, var(--gc) 22%, var(--border)); }
    .nav-tools-menu .nm-head { display: contents; }
    .nav-tools-menu .nm-chip { grid-area: chip; width: 38px; height: 38px; }
    .nav-tools-menu .nav-menu-item .nm-chip svg { width: 20px; height: 20px; }
    .nav-tools-menu .nm-name { grid-area: name; }
    .nav-tools-menu .nm-desc { grid-area: desc; }
    .nav-tools-menu .nm-go { grid-area: go; margin-left: 0; }
    .nav-tools-menu .nav-menu-item:hover:not(:disabled) { border-color: var(--gc); background: linear-gradient(140deg, color-mix(in srgb, var(--gc) 18%, var(--surface0)), var(--surface0) 66%); transform: translateY(-1px); }
    .nav-tools-menu .nav-menu-item:hover:not(:disabled) .nm-go { color: var(--gc); transform: translateX(2px); }
  }
`;
  if (!document.getElementById('chrome-css')) document.head.insertAdjacentHTML('beforeend', `<style id="chrome-css">${CSS}</style>`);

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
