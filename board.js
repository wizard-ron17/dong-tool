// Ron's Tools board toolbar: the Filters card, its chips, the Board/Results
// tabs, the Table/Cards/Compact switch and the search box, as every board
// draws them. The styles live here (except .u-tabs: it resets each app's own
// .sub-tabs box, so it has to load after it, in the app); the helpers below write the markup and
// call the page's own setter (setFn(key, value)), so each board keeps its state.
//
//   uiFilters(setFn, open, [[label, chipsHtml], ...], changedCount)
//   uiChip(setFn, key, value, label, current, extraClass)
//   uiTabs(setFn, current, [[value, label], ...])     (defaults to Board / Results)
//   uiView(setFn, current, extra)                     (table / cards / compact; extra = more toolbar, e.g. parSideToggleHtml)
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
  const uiView = (setFn, cur, extra = '') => `
    <div class="lb-toolbar"><div class="view-switch">${[['table', 'Table'], ['cards', 'Cards'], ['compact', 'Compact']].map(([v, l]) =>
      `<button class="view-btn${cur === v ? ' active' : ''}" onclick="${setFn}('view','${v}')">${l}</button>`).join('')}</div>${extra}</div>`;
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
