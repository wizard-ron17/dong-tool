// Ron's Tools board toolbar: the Filters card, its chips, the Board/Results
// tabs, the Table/Cards/Compact switch and the search box, as every board
// draws them. The styles live here (except .u-tabs: it resets each app's own
// .sub-tabs box, so it has to load after it, in the app); the helpers below write the markup and
// call the page's own setter (setFn(key, value)), so each board keeps its state.
//
//   uiFilters(setFn, open, [[label, chipsHtml], ...], changedCount)
//   uiChip(setFn, key, value, label, current, extraClass)
//   uiTabs(setFn, current, [[value, label], ...])     (defaults to Board / Results)
//   uiView(setFn, current, extra)                     (table / cards, the data's age, Share; extra = more toolbar, e.g. parSideToggleHtml)
//   uiSearch(inputId, setFn, query, placeholder)      (setFn('q', text, true) as you type)
//   matchQ(row, query)                                name, team, opponent or position
(function () {
  const CSS = `
  .pb-search { position: relative; margin-bottom: 0.55rem; }
  .pb-search input { width: 100%; box-sizing: border-box; background: var(--surface1); border: 1px solid var(--border); border-radius: 8px; color: var(--text); font-family: var(--font-b); font-size: 0.791rem; font-weight: 500; padding: 0.55rem 2.1rem 0.55rem 2.2rem; outline: none; transition: border-color 0.15s, background 0.15s; }
  .pb-search input:hover { border-color: var(--border2); }
  .pb-search input:focus { border-color: var(--accent); background: var(--surface2); }
  .pb-search input::placeholder { color: var(--dim); font-weight: 400; }
  .pb-search input::-webkit-search-cancel-button { display: none; }
  .pb-search-ico { position: absolute; left: 0.75rem; top: 50%; transform: translateY(-50%); width: 13px; height: 13px; color: var(--muted); pointer-events: none; transition: color 0.15s; }
  .pb-search:focus-within .pb-search-ico { color: var(--accent); }
  .pb-search-x { position: absolute; right: 0.45rem; top: 50%; transform: translateY(-50%); display: none; background: none; border: none; color: var(--muted); cursor: pointer; font-size: 1rem; line-height: 1; padding: 0.2rem 0.35rem; border-radius: 5px; }
  .pb-search-x:hover { color: var(--text); background: var(--surface2); }
  .pb-search.on .pb-search-x { display: block; }
  .due-explainer-title { font-size: 0.692rem; font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase; color: var(--accent); }
  .due-explainer-chevron { display: inline-block; font-size: 0.82rem; font-weight: 900; line-height: 1; color: var(--muted); transition: transform 0.18s ease, color 0.15s; }
  .due-explainer-chevron.open { transform: rotate(90deg); color: var(--accent); }
  .due-explainer:hover .due-explainer-chevron, .due-filters-toggle:hover .due-explainer-chevron { color: var(--accent); }
  .due-filters-card { background: var(--surface1); border: 1px solid var(--border); border-radius: 8px; padding: 0.5rem 0.9rem; margin-bottom: 0.6rem; }
  .due-filters-toggle { display: flex; align-items: center; justify-content: space-between; width: 100%; background: transparent; border: none; padding: 0.1rem 0; cursor: pointer; text-align: left; }
  .due-filters-toggle:hover .due-explainer-title { color: #4ad888; }
  .due-filters-badge { display: inline-flex; align-items: center; justify-content: center; min-width: 1.1rem; height: 1.1rem; padding: 0 0.3rem; margin-left: 0.4rem; background: var(--accent); color: #fff; font-size: 0.673rem; font-weight: 700; border-radius: 10px; vertical-align: middle; }
  .due-filters-card .due-filter-row { margin-top: 0.55rem; padding-top: 0.55rem; border-top: 1px solid var(--border); margin-bottom: 0; }
  .due-filter-row { display: flex; align-items: center; gap: 0.7rem; flex-wrap: wrap; }
  .pb-search-hint { font-size: 0.692rem; color: var(--muted); margin: 0.35rem 0 0 0.15rem; letter-spacing: 0.02em; }
  .pb-search-hint b { color: var(--text); font-weight: 600; }
  .pb-search-hint a { color: var(--accent); text-decoration: none; }
  .pb-search-hint a:hover { text-decoration: underline; }
  .pbf-sel { background: var(--surface1); border: 1px solid var(--border2); color: var(--silver); font-family: var(--font-b); font-size: 0.729rem; font-weight: 700; padding: 0.26rem 0.5rem; border-radius: 7px; cursor: pointer; }
  .pbf-hint { font-size: 0.680rem; color: var(--dim); margin-left: 0.15rem; align-self: center; }
  .pbf-foot { display: flex; justify-content: flex-end; padding-top: 0.55rem; margin-top: 0.1rem; border-top: 1px solid var(--border); }
  .pbf-reset { background: transparent; border: 1px solid var(--border2); color: var(--muted); font-family: var(--font-b); font-size: 0.704rem; font-weight: 700; padding: 0.22rem 0.7rem; border-radius: 7px; cursor: pointer; }
  .pbf-reset:hover { color: var(--bad); border-color: var(--bad); }
  .lb-toolbar { display: flex; align-items: center; justify-content: space-between; gap: 0.5rem; margin-bottom: 0.6rem; flex-wrap: wrap; }
  .view-switch { display: inline-flex; background: var(--surface1); border: 1px solid var(--border2); border-radius: 7px; overflow: hidden; }
  .view-btn { background: transparent; border: none; color: var(--dim); font-family: var(--font-b); font-size: 0.717rem; font-weight: 700; letter-spacing: 0.04em; text-transform: uppercase; padding: 0.34rem 0.62rem; cursor: pointer; transition: background 0.15s, color 0.15s; }
  .view-btn:hover:not(.active) { color: var(--text); }
  .view-btn.active { background: var(--accent); color: #04170f; }
  .view-btn + .view-btn { border-left: 1px solid var(--border2); }
  .pbf-body { display: block; }
  .pbf-row { display: grid; grid-template-columns: 5.6rem 1fr; align-items: start; gap: 0.75rem; padding: 0.55rem 0; border-top: 1px solid var(--border); }
  .pbf-row:first-child { border-top: none; padding-top: 0.1rem; }
  .pbf-lbl { font-family: var(--font-d); font-size: 0.8rem; font-weight: 700; letter-spacing: 0.07em; text-transform: uppercase; color: var(--muted); text-align: right; padding-top: 0.22rem; }
  .pbf-chips { display: flex; gap: 0.32rem; flex-wrap: wrap; align-items: center; }
  .pbf-chip { background: var(--surface1); border: 1px solid var(--border2); color: var(--silver); font-family: var(--font-b); font-size: 0.729rem; font-weight: 700; padding: 0.26rem 0.66rem; border-radius: 7px; cursor: pointer; line-height: 1.25; transition: background 0.14s, color 0.14s, border-color 0.14s; }
  .pbf-chip:hover { background: var(--surface2); color: var(--text-strong); }
  .pbf-chip.on { background: var(--accent); border-color: var(--accent); color: #04120a; }
  .pbf-chip.pos { color: var(--pc); border-color: color-mix(in srgb, var(--pc) 38%, transparent); background: color-mix(in srgb, var(--pc) 8%, var(--surface1)); }
  .pbf-chip.pos:hover { background: color-mix(in srgb, var(--pc) 18%, var(--surface1)); }
  .pbf-chip.pos.on { background: var(--pc); border-color: var(--pc); color: #08101a; }
  @media (max-width: 560px) {
    .pbf-row { grid-template-columns: 1fr; gap: 0.3rem; }
    .pbf-lbl { text-align: left; font-size: 0.754rem; padding-top: 0; }
  }
`;
  // Injected at load (from <head>), so a page's own <style> still comes after it and wins.
  if (!document.getElementById('board-css')) document.head.insertAdjacentHTML('beforeend', `<style id="board-css">${CSS}</style>`);

  const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const uiArg = (v) => typeof v === 'number' ? v : `'${v}'`;
  const uiChip = (setFn, k, v, lab, cur, extra = '') =>
    `<button class="pbf-chip${extra ? ' ' + extra : ''}${String(cur) === String(v) ? ' on' : ''}" onclick="${setFn}('${k}',${uiArg(v)})">${lab}</button>`;
  // rows: [[label, chipsHtml]]; changed: how many filters are off their default
  const uiFilters = (setFn, open, rows, changed) => `
    <div class="due-filters-card">
      <button class="due-filters-toggle" onclick="${setFn}('open',${!open})" aria-expanded="${open}">
        <span class="due-explainer-title">Filters${changed ? `<span class="due-filters-badge">${changed}</span>` : ''}</span>
        <span class="due-explainer-chevron${open ? ' open' : ''}">▶</span>
      </button>
      ${open ? `<div class="due-filter-row pbf-body">${rows.map(([l, c]) =>
        `<div class="pbf-row"><span class="pbf-lbl">${l}</span><div class="pbf-chips">${c}</div></div>`).join('')}</div>` : ''}
    </div>`;
  const uiTabs = (setFn, cur, tabs = [['board', 'Board'], ['results', 'Results']]) => `
    <div class="sub-tabs u-tabs">${tabs.map(([v, l]) =>
      `<button class="sub-btn${cur === v ? ' active' : ''}" onclick="${setFn}('tab','${v}')">${l}</button>`).join('')}</div>`;
  // Table (the price beside what drives it) and Cards. Compact, the old
  // screenshot view, is a share card now (share.js): the button opens this
  // board's top 10 as an image, from what the board registered under setFn.
  const uiView = (setFn, cur, extra = '') => `
    <div class="lb-toolbar"><div class="view-switch">${[['table', 'Table'], ['cards', 'Cards']].map(([v, l]) =>
      `<button class="view-btn${(cur === 'compact' ? 'cards' : cur) === v ? ' active' : ''}" onclick="${setFn}('view','${v}')">${l}</button>`).join('')}</div>${window.RonChrome?.freshHtml ? RonChrome.freshHtml() : ''}${extra}${window.RonShare ? RonShare.button(setFn) : ''}</div>`;
  const uiSearch = (id, setFn, q, ph) => `
      <div class="pb-search${q ? ' on' : ''}">
        <svg class="pb-search-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round">
          <circle cx="11" cy="11" r="7"></circle><path d="M20 20l-3.5-3.5"></path></svg>
        <input type="text" id="${id}" placeholder="${ph}" value="${esc(q)}" oninput="${setFn}('q',this.value,true)" autocomplete="off" spellcheck="false">
        <button class="pb-search-x" onclick="${setFn}('q','')" aria-label="Clear">×</button>
      </div>`;
  const matchQ = (r, q) => { const t = q.trim().toLowerCase(); return !t || r.name.toLowerCase().includes(t) || r.team.toLowerCase() === t || r.opp.toLowerCase() === t || (r.pos || '').toLowerCase() === t; };

  Object.assign(window, { uiArg, uiChip, uiFilters, uiTabs, uiView, uiSearch, matchQ });
})();

// ── Factor filters: the MLB Matchups table's card, for every factor table (NHL goals, NFL TDs, NBA threes) ──
// A collapsible Filters card: "No red" (no factor under 1.00x), and per factor a "+" (green only: over 1.00x) and a
// typed floor, with where tonight's top 10% starts as the placeholder; Fair >= / <= in American odds; and a ceiling
// on the base factor (Talent / Role / Shooter <=) for the longshot hunt. State is remembered per table.
//   RonFx.html(key, cfg, allRows)   the card       cfg: { factors: [[k, label]], singles: [k...], base: [k, label],
//   RonFx.pass(key, cfg, row)        filter a row        val: (row, k) => multiplier, p: row => chance, rerender: 'js();' }
//   RonFx.count(key) / RonFx.set(key, what, v, rerender) / RonFx.reset(key, rerender) / RonFx.state(key)
(function () {
  const CSS = `
  .rfx-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(140px, 1fr)); gap: 0.4rem; flex-basis: 100%; }
  .rfx-in { display: flex; align-items: center; justify-content: space-between; gap: 0.3rem; background: var(--surface0); border: 1px solid var(--border); border-radius: 7px; padding: 0.25rem 0.4rem; font-size: 0.72rem; color: var(--muted); }
  .rfx-in.on { border-color: var(--accent); color: var(--text); }
  .rfx-in > span { margin-right: auto; white-space: nowrap; }
  .rfx-in input { width: 3.4rem; background: transparent; border: none; color: var(--text); font-family: var(--font-d); font-size: 0.8rem; text-align: right; outline: none; }
  .rfx-pos { flex: none; width: 1.3rem; height: 1.3rem; border-radius: 5px; border: 1px solid var(--border2); background: transparent; color: var(--muted); font: 700 0.8rem/1 var(--font-d); cursor: pointer; padding: 0; }
  .rfx-pos.on { background: var(--good); border-color: var(--good); color: var(--bg); }
  .rfx-tog { background: var(--surface1); border: 1px solid var(--border2); color: var(--dim); font-family: var(--font-b); font-size: 0.704rem; font-weight: 700; padding: 0.22rem 0.65rem; border-radius: 20px; cursor: pointer; }
  .rfx-tog.on { background: color-mix(in srgb, var(--accent) 14%, transparent); border-color: var(--accent); color: var(--accent); }
  .rfx-clear { background: transparent; border: none; color: var(--muted); font-family: var(--font-b); font-size: 0.704rem; font-weight: 700; cursor: pointer; text-decoration: underline; padding: 0.2rem 0.3rem; }
  .rfx-hint { font-size: 0.68rem; color: var(--dim); flex-basis: 100%; }
  .rfx-sorts { display: flex; align-items: center; gap: 0.35rem; flex-wrap: wrap; margin: 0 0 0.55rem; }
  `;
  if (!document.getElementById('rfx-css')) document.head.insertAdjacentHTML('beforeend', `<style id="rfx-css">${CSS}</style>`);
  const S = {};
  const blank = () => ({ open: false, noRed: false, pos: {}, min: {}, lo: null, hi: null, baseMax: null });
  function state(key) {
    if (!S[key]) { let s = null; try { s = JSON.parse(localStorage.getItem('rfx_' + key)); } catch (e) {} S[key] = { ...blank(), ...(s || {}) }; S[key].pos ||= {}; S[key].min ||= {}; }
    return S[key];
  }
  const save = (key) => { try { localStorage.setItem('rfx_' + key, JSON.stringify(S[key])); } catch (e) {} };
  const run = (re) => { try { (typeof re === 'function' ? re : new Function(re))(); } catch (e) { console.warn('RonFx rerender', e); } };
  const amP = (v) => { const a = +String(v ?? '').replace(/[+\s]/g, ''); return !a || isNaN(a) || Math.abs(a) < 100 ? null : a > 0 ? 100 / (a + 100) : -a / (-a + 100); };
  const r2 = (v) => Math.round(v * 100) / 100;
  function count(key) {
    const s = state(key);
    return (s.noRed ? 1 : 0) + (s.lo != null ? 1 : 0) + (s.hi != null ? 1 : 0) + (s.baseMax != null ? 1 : 0)
      + Object.values(s.min).filter(v => v != null).length + Object.values(s.pos).filter(Boolean).length;
  }
  function set(key, what, v, re) {
    const s = state(key);
    if (what === 'open' || what === 'noRed') s[what] = !s[what];
    else if (what === 'pos') s.pos[v] = !s.pos[v];
    else if (what === 'lo' || what === 'hi') s[what] = amP(v) == null ? null : String(v).trim().replace(/^(\d)/, '+$1');
    else if (what === 'baseMax') s.baseMax = v === '' || isNaN(+v) ? null : +v;
    else if (what === 'min') { const [k, x] = v; s.min[k] = x === '' || isNaN(+x) ? null : +x; }
    save(key); run(re);
  }
  function reset(key, re) { const open = state(key).open; S[key] = { ...blank(), open }; save(key); run(re); }
  /** Presets: replace the filters wholesale (e.g. Value = fair +300 or longer, nothing else). */
  function apply(key, patch) { const open = state(key).open; S[key] = { ...blank(), open, ...patch }; save(key); }
  function pass(key, cfg, r) {
    const s = state(key);
    for (const [k, lo] of Object.entries(s.min)) if (lo != null) { const v = cfg.val(r, k); if (!(v != null && v >= lo)) return false; }
    for (const [k, on] of Object.entries(s.pos)) if (on) { const v = cfg.val(r, k); if (!(v != null && r2(v) > 1)) return false; }
    const lo = amP(s.lo), hi = amP(s.hi), p = cfg.p(r);
    if (lo != null && !(p != null && p <= lo + 1e-9)) return false;          // "Fair >= +300": at least that long a price
    if (hi != null && !(p != null && p >= hi - 1e-9)) return false;
    if (s.baseMax != null && cfg.base) { const v = cfg.val(r, cfg.base[0]); if (!(v != null && v <= s.baseMax)) return false; }
    if (s.noRed && (cfg.singles || cfg.factors.map(f => f[0])).some(k => { const v = cfg.val(r, k); return v != null && r2(v) < 1; })) return false;
    return true;
  }
  function html(key, cfg, all) {
    const s = state(key), n = count(key), K = JSON.stringify(key).replace(/"/g, "'"), RE = JSON.stringify(cfg.rerender || '').replace(/"/g, '&quot;');
    const q = (k, t) => { const a = all.map(r => cfg.val(r, k)).filter(v => v != null && isFinite(v)).sort((x, y) => x - y); return a.length ? a[Math.floor(t * (a.length - 1))] : null; };
    const fin = ([k, lbl]) => { const p90 = q(k, 0.9), lo = q(k, 0), hi = q(k, 1), pos = !!s.pos[k];
      return `<label class="rfx-in${s.min[k] != null || pos ? ' on' : ''}" title="${lbl} tonight: ${lo?.toFixed(2)}–${hi?.toFixed(2)}× · top 10% from ${p90?.toFixed(2)}×"><button type="button" class="rfx-pos${pos ? ' on' : ''}" onclick="event.preventDefault();RonFx.set(${K},'pos','${k}',${RE})" title="${pos ? 'Clear' : 'Only'} ${lbl} over 1.00× (green)" aria-pressed="${pos}">+</button><span>${lbl} ≥</span><input type="number" step="0.01" min="0" placeholder="${p90 != null ? p90.toFixed(2) : '—'}" value="${s.min[k] ?? ''}" onchange="RonFx.set(${K},'min',['${k}',this.value],${RE})"></label>`; };
    const odds = (w, lab, ph, tip) => `<label class="rfx-in${s[w] != null ? ' on' : ''}" title="${tip}"><span>${lab}</span><input type="text" inputmode="numeric" placeholder="${ph}" value="${s[w] ?? ''}" onchange="RonFx.set(${K},'${w}',this.value,${RE})"></label>`;
    return `<div class="due-filters-card">
      <button class="due-filters-toggle" onclick="RonFx.set(${K},'open',null,${RE})" aria-expanded="${s.open}">
        <span class="due-explainer-title">Factor filters${n ? `<span class="due-filters-badge">${n}</span>` : ''}</span>
        <span class="due-explainer-chevron${s.open ? ' open' : ''}">▶</span>
      </button>
      ${s.open ? `<div class="due-filter-row">
        <button class="rfx-tog${s.noRed ? ' on' : ''}" onclick="RonFx.set(${K},'noRed',null,${RE})" title="Nothing working against him: every factor 1.00× or better">🟢 No red</button>
        ${n ? `<button class="rfx-clear" onclick="RonFx.reset(${K},${RE})">Reset ×</button>` : ''}
        <div class="rfx-grid">
          ${cfg.factors.map(fin).join('')}
          ${odds('lo', 'Fair ≥', '+300', 'Fair odds at least this long, e.g. +300 for longshots only')}
          ${odds('hi', 'Fair ≤', '+150', 'Fair odds no longer than this, e.g. +150 for the likeliest')}
          ${cfg.base ? `<label class="rfx-in${s.baseMax != null ? ' on' : ''}" title="${cfg.base[1]} ceiling: hunt players who aren't stars in great spots"><span>${cfg.base[1]} ≤</span><input type="number" step="0.05" min="0" placeholder="1.00" value="${s.baseMax ?? ''}" onchange="RonFx.set(${K},'baseMax',this.value,${RE})"></label>` : ''}
        </div>
        <div class="rfx-hint">Tap <b>+</b> for only green (over 1.00×), or type a floor (1.20× = 20% better than neutral). The grey number is where tonight's top 10% starts: factors run on different scales.</div>
      </div>` : ''}
    </div>`;
  }
  /** The Sort chip row under the card (what's first); headers still sort too. fn is the page's setter, called with the key. */
  const sorts = (list, cur, dir, fn) => `<div class="rfx-sorts"><span class="due-filter-label">Sort</span>${list.map(([k, l]) =>
    `<button class="due-filter-chip${cur === k ? ' active' : ''}" onclick="${fn}('${k}')">${l}${cur === k ? (dir === 'asc' ? ' ▲' : ' ▼') : ''}</button>`).join('')}</div>`;
  window.RonFx = { state, set, reset, apply, pass, html, count, sorts };
})();
