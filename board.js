// Ron's Tools board toolbar: the Filters card, its chips, the Board/Results
// tabs, the Table/Cards/Compact switch and the search box, as every board
// draws them. The styles live here (except .u-tabs: it resets each app's own
// .sub-tabs box, so it has to load after it, in the app); the helpers below write the markup and
// call the page's own setter (setFn(key, value)), so each board keeps its state.
//
//   uiFilters(setFn, open, [[label, chipsHtml], ...], changedCount)   a Filters button; its rows open in one modal (the filter sheet)
//   uiSort(setFn, cur, defs) / uiSorted(rows, cur, defs)   a Cards view's Sort row (cards have no headers to click):
//                                                       defs { key: [label, row => value, 'asc'?] }, the table's columns;
//                                                       tap the lit one again to reverse ('-key'); rows re-ranked to match.
//                                                       A Table view leaves Sort out of the sheet: its headers sort.
//   RonUf.node(el, { onClose })                        a board with its own filter markup: el moves into the same sheet
//   uiChip(setFn, key, value, label, current, extraClass)
//   uiTabs(setFn, current, [[value, label], ...])     (defaults to Board / Results)
//   uiView(setFn, current, extra)                     (table / cards, the data's age, Share; extra = more toolbar, e.g. parSideToggleHtml)
//   uiSearch(inputId, setFn, query, placeholder)      (setFn('q', text, true) as you type)
//   matchQ(row, query)                                name, team, opponent or position
//
// Board tables (Ron's table, from the NFL TD Factors view): add class u-tbl to the <table>, then
//   uiCols(groups) + <thead>uiBand(groups)<tr>...       groups: [[label, columns, kind]], kind one of price / sit /
//                                                       prod / game / plain, always in that order: Player, Price,
//                                                       Situational, Production, Game. Categorical tints, never the
//                                                       good-bad ramp. uiCols draws each group's divider down the table.
//   uiFair(p, sub)                                      the price cell: odds over "sub · chance", the lit column
// Every u-tbl whose headers don't sort themselves (no th[onclick]) sorts by clicking a header, here: see below.
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
  .uf-bar { display: flex; gap: 0.5rem; align-items: center; margin-bottom: 0.55rem; }
  .uf-btn { display: inline-flex; align-items: center; gap: 0.45rem; background: var(--surface1); border: 1px solid var(--border); border-radius: 8px; color: var(--text); font-family: var(--font-b); font-size: 0.8rem; font-weight: 700; padding: 0.5rem 0.85rem; cursor: pointer; transition: border-color 0.15s, background 0.15s; }
  .uf-btn:hover { border-color: var(--border2); background: var(--surface2); }
  .uf-btn svg { width: 16px; height: 16px; color: var(--accent); }
  .uf-n { min-width: 1.15rem; height: 1.15rem; border-radius: 999px; background: var(--accent); color: var(--bg); font-size: 0.66rem; font-weight: 800; display: inline-grid; place-items: center; padding: 0 0.3rem; box-sizing: border-box; }
  .uf-n[hidden] { display: none; }
  .pm.uf-sheet { max-width: 620px; padding: 1rem 1.15rem 0.9rem; }
  .uf-title { font-family: var(--font-d); font-size: 1.15rem; font-weight: 700; color: var(--text-strong); margin-bottom: 0.6rem; }
  .uf-sheet .pbf-row { padding: 0.5rem 0; border-top: 1px solid var(--border); }
  .uf-sheet .uf-base > .pbf-row:first-child, .uf-sheet .due-filter-row > .pbf-row:first-child { border-top: none; }
  .uf-sheet .due-filter-row { display: block; padding: 0; border: none; margin: 0; }
  .uf-sec { font-size: 0.692rem; font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase; color: var(--accent); margin: 0.8rem 0 0.45rem; padding-top: 0.7rem; border-top: 1px solid var(--border2); display: flex; align-items: center; gap: 0.4rem; }
  .uf-fx:empty { display: none; }
  .rfx-body { display: flex; flex-wrap: wrap; gap: 0.4rem; align-items: center; }
  .uf-foot { display: flex; justify-content: flex-end; margin-top: 0.9rem; }
  .uf-done { background: var(--accent); border: none; color: var(--bg); font-family: var(--font-b); font-weight: 800; font-size: 0.85rem; padding: 0.55rem 1.4rem; border-radius: 9px; cursor: pointer; }
  @media (max-width: 600px) {
    #uf-back { align-items: flex-end; padding: 0; }
    .pm.uf-sheet { max-width: none; width: 100%; margin: auto 0 0; border-radius: 16px 16px 0 0; max-height: 86vh; overflow-y: auto; }
  }
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
  table.u-tbl.u-tbl th { font-family: var(--font-d); font-size: 0.7rem; font-weight: 700; letter-spacing: 0.05em; text-transform: uppercase; color: var(--muted); background: var(--surface2); padding: 0.45rem 0.6rem; white-space: nowrap; }
  table.u-tbl.u-tbl td { font-family: var(--font-b); font-size: 0.8rem; font-variant-numeric: tabular-nums; padding: 0.42rem 0.6rem; }
  table.u-tbl.u-tbl td.num, table.u-tbl.u-tbl td.num b { font-family: var(--font-b); }
  table.u-tbl.u-tbl td b { font-weight: 700; color: var(--text-strong); }
  table.u-tbl.u-tbl th.on { color: var(--accent); background-color: color-mix(in srgb, var(--accent) 9%, var(--surface2)); }
  table.u-tbl.u-tbl th[onclick] { cursor: pointer; } table.u-tbl.u-tbl th[onclick]:hover { color: var(--text); }
  table.u-sortable thead tr:last-child th { cursor: pointer; user-select: none; }
  table.u-sortable.u-sortable thead tr:last-child th:hover { color: var(--text); }
  table.u-sortable thead th .ar { font-size: 0.62rem; margin-left: 0.2rem; }
  table.u-tbl.u-tbl .u-pin { position: sticky; z-index: 1; }
  table.u-tbl.u-tbl td.u-pin { background-color: var(--u-pin-bg); }
  table.u-tbl.u-tbl th.u-pin { z-index: 3; }
  table.u-tbl.u-tbl .u-pin-wrap { white-space: normal; max-width: 8.5rem; }
  table.u-tbl.u-tbl .u-pin-edge { box-shadow: 1px 0 0 var(--border2), 7px 0 8px -7px rgba(0, 0, 0, 0.45); }
  .u-zoom-btn { display: none; align-items: center; gap: 0.25rem; background: var(--surface1); border: 1px solid var(--border2); border-radius: 7px; color: var(--silver);
    font: 700 0.68rem var(--font-b); letter-spacing: 0.03em; padding: 0.3rem 0.5rem; cursor: pointer; }
  .u-zoom-btn svg { width: 13px; height: 13px; }
  @media (max-width: 700px) {
    .u-zoom-btn { display: inline-flex; }
    html.u-zoom-80 table.u-tbl { zoom: 0.8; }
    html.u-zoom-60 table.u-tbl { zoom: 0.6; }
  }
  table.u-tbl col.u-g { border-left: 1px solid var(--border2); }
  table.u-tbl col.u-g:first-child { border-left: none; }
  table.u-tbl.u-tbl tr.u-band th { font: 700 0.66rem var(--font-b); letter-spacing: 0.09em; text-transform: uppercase; text-align: left; padding: 0.45rem 0.6rem; border-bottom: 1px solid var(--border); cursor: default; position: static; }
  table.u-tbl.u-tbl tr.u-band th + th { border-left: 1px solid var(--border2); }
  table.u-tbl.u-tbl tr.u-band .u-b-price { color: var(--accent); background: color-mix(in srgb, var(--accent) 12%, var(--surface2)); }
  table.u-tbl.u-tbl tr.u-band .u-b-sit { color: #6ea8ff; background: color-mix(in srgb, #6ea8ff 10%, var(--surface2)); }
  table.u-tbl.u-tbl tr.u-band .u-b-prod { color: #b48cff; background: color-mix(in srgb, #b48cff 10%, var(--surface2)); }
  table.u-tbl.u-tbl tr.u-band .u-b-game, table.u-tbl.u-tbl tr.u-band .u-b-plain { color: var(--dim); }
  table.u-tbl.u-tbl td.u-fair { text-align: right; font-weight: 700; color: var(--gold); background-color: color-mix(in srgb, var(--accent) 8%, transparent); line-height: 1.15; }
  table.u-tbl.u-tbl td.u-fair.dog { color: var(--good); }
  table.u-tbl.u-tbl td.u-fair small { display: block; font-size: 0.68rem; font-weight: 500; color: var(--muted); white-space: nowrap; }
  .u-sd { display: inline-block; font-family: var(--font-m, monospace); font-size: 0.66rem; font-weight: 800; padding: 0.02rem 0.3rem; border-radius: 4px; }
  .u-sd.o, .rc-cline.u-sd-o { color: #b48cff; background: rgba(180,140,255,0.14); }
  .u-sd.u, .rc-cline.u-sd-u { color: #6aa9ff; background: rgba(106,169,255,0.14); }
  .rc-cline.u-sd-o, .rc-cline.u-sd-u { font-weight: 800; padding: 0.02rem 0.3rem; border-radius: 4px; text-transform: uppercase; }
  :root[data-theme="light"] .u-sd.o, :root[data-theme="light"] .rc-cline.u-sd-o { color: #7446d6; background: rgba(116,70,214,0.1); }
  :root[data-theme="light"] .u-sd.u, :root[data-theme="light"] .rc-cline.u-sd-u { color: #1f6fd1; background: rgba(31,111,209,0.1); }
  table.u-tbl.u-tbl th.u-fair { color: var(--accent); background-color: color-mix(in srgb, var(--accent) 9%, var(--surface2)); }
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
  // ── The filter sheet ──────────────────────────────────────────────────────
  // Every board's filters behind one button, in one modal: the board's own rows, then (on a Factors view) its
  // factor filters (RonFx below), so there's one place to look, not a drawer per kind. Changes apply live behind
  // it. A board's `open` only opens the sheet after a tap here (arm), so a saved state never pops it on load.
  // rows: [[label, chipsHtml]]; changed: how many filters are off their default
  let armed = false, owner = null, home = null;
  const SHEET = 'uf-back';
  const panelId = () => document.querySelector('.panel.visible')?.id || 'page';
  const sheetDlg = () => document.querySelector(`#${SHEET} [role="dialog"]`);
  function sheetOpen(who, onClose) {
    if (sheetDlg() && owner === who) return sheetDlg();
    if (sheetDlg()) RonModal.close(SHEET);
    owner = who;
    const dlg = RonModal.open(SHEET, { cls: 'pm uf-sheet', label: 'Filters', onClose: () => { const o = owner; owner = null; armed = false; putBack(); onClose?.(o); } });
    dlg.innerHTML = `<button class="pm-x" onclick="RonModal.close('${SHEET}')" aria-label="Close">×</button><div class="uf-title">Filters</div>
      <div class="uf-base"></div><div class="uf-fx"></div><div class="uf-foot"><button class="uf-done" onclick="RonModal.close('${SHEET}')">Done</button></div>`;
    return dlg;
  }
  // a board's own filter markup (a node it keeps filling by id) borrowed into the sheet, and returned on close
  function putBack() { if (!home) return; const { el, parent, next, display } = home; home = null; el.style.display = display; parent.insertBefore(el, next); }
  function node(el, { onClose } = {}) {
    if (!el) return;
    home = { el, parent: el.parentNode, next: el.nextSibling, display: el.style.display };
    const dlg = sheetOpen('node:' + (el.id || ''), () => onClose?.());
    el.style.display = ''; dlg.querySelector('.uf-base').appendChild(el); fxPaint();
  }
  const FILTER_ICO = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="M4 6h10M20 6h0M4 12h4M14 12h6M4 18h12"/><circle cx="17" cy="6" r="2.2"/><circle cx="11" cy="12" r="2.2"/><circle cx="19" cy="18" r="2.2"/></svg>';
  const uiFilters = (setFn, open, rows, changed) => {
    const body = rows.map(([l, c]) => `<div class="pbf-row"><span class="pbf-lbl">${l}</span><div class="pbf-chips">${c}</div></div>`).join('');
    queueMicrotask(() => {
      if (open && armed) {
        const dlg = sheetOpen(setFn, (o) => { try { new Function(`${o}('open',false)`)(); } catch (e) {} });
        const b = dlg.querySelector('.uf-base'); if (b.innerHTML !== body) b.innerHTML = body;
        fxPaint();
      } else if (!open && owner === setFn && sheetDlg()) { owner = null; RonModal.close(SHEET); }
      badges();
    });
    return `<div class="uf-bar"><button class="uf-btn" data-n="${changed || 0}" onclick="RonUf.arm();${setFn}('open',true)" aria-haspopup="dialog">${FILTER_ICO}<span>Filters</span><span class="uf-n"${changed ? '' : ' hidden'}>${changed || ''}</span></button></div>`;
  };
  // the factor section of the board on screen, if it's on a Factors view (RonFx.html leaves a marker there)
  const FX = {};
  const fxOn = () => { const f = FX[panelId()]; return f && document.getElementById('rfx-mark-' + f.key) ? f : null; };
  function fxPaint() {
    const box = sheetDlg()?.querySelector('.uf-fx'); if (!box) return;
    const f = fxOn(), html = f ? `<div class="uf-sec">Factors${f.n ? `<span class="due-filters-badge">${f.n}</span>` : ''}</div>${f.html}` : '';
    if (box.innerHTML !== html) box.innerHTML = html;
  }
  // a button's count: its board's filters plus its factor filters
  function badges() {
    const f = fxOn();
    document.querySelectorAll('.panel.visible .uf-btn').forEach(b => {
      const n = (+b.dataset.n || 0) + (f?.n || 0), el = b.querySelector('.uf-n');
      if (el) { el.textContent = n || ''; el.hidden = !n; }
    });
  }
  window.RonUf = { arm: () => { armed = true; }, node, fx: (panel, f) => { FX[panel] = f; queueMicrotask(() => { fxPaint(); badges(); }); }, panelId, badges, close: () => sheetDlg() && RonModal.close(SHEET) };
  const uiTabs = (setFn, cur, tabs = [['board', 'Board'], ['results', 'Results']]) => `
    <div class="sub-tabs u-tabs">${tabs.map(([v, l]) =>
      `<button class="sub-btn${cur === v ? ' active' : ''}" onclick="${setFn}('tab','${v}')">${l}</button>`).join('')}</div>`;
  // Table (the price beside what drives it) and Cards. Compact, the old
  // screenshot view, is a share card now (share.js): the button opens this
  // board's top 10 as an image, from what the board registered under setFn.
  const uiView = (setFn, cur, extra = '') => `
    <div class="lb-toolbar"><div class="view-switch">${[['table', 'Table'], ['cards', 'Cards']].map(([v, l]) =>
      `<button class="view-btn${(cur === 'compact' ? 'cards' : cur) === v ? ' active' : ''}" onclick="${setFn}('view','${v}')">${l}</button>`).join('')}</div>${cur === 'table' ? uiZoomBtn() : ''}${window.RonChrome?.freshHtml ? RonChrome.freshHtml() : ''}${extra}${window.RonShare ? RonShare.button(setFn) : ''}</div>`;
  // A phone's table zoom (11/03): 100% → 80% → 60% of the type, so more columns fit; one setting for every board, kept
  // on the device. The button shows only at phone width, and only in a Table view.
  const ZOOMS = [100, 80, 60];
  const zoomNow = () => { try { const z = +localStorage.getItem('ron-tbl-zoom'); return ZOOMS.includes(z) ? z : 100; } catch (e) { return 100; } };
  const zoomApply = (z) => { const h = document.documentElement; ZOOMS.forEach(x => h.classList.toggle('u-zoom-' + x, x === z && x !== 100)); };
  zoomApply(zoomNow());
  const uiZoomBtn = () => `<button class="u-zoom-btn" onclick="uiZoom()" title="Shrink the table to fit more columns (phones)" aria-label="Table zoom ${zoomNow()}%"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5M8 11h6"/></svg>${zoomNow()}%</button>`;
  function uiZoom() {
    const z = ZOOMS[(ZOOMS.indexOf(zoomNow()) + 1) % ZOOMS.length];
    try { localStorage.setItem('ron-tbl-zoom', z); } catch (e) {}
    zoomApply(z);
    document.querySelectorAll('.u-zoom-btn').forEach(b => { b.lastChild.textContent = z + '%'; b.setAttribute('aria-label', `Table zoom ${z}%`); });
    window.uiPin?.();
  }
  const uiSearch = (id, setFn, q, ph) => `
      <div class="pb-search${q ? ' on' : ''}">
        <svg class="pb-search-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round">
          <circle cx="11" cy="11" r="7"></circle><path d="M20 20l-3.5-3.5"></path></svg>
        <input type="text" id="${id}" placeholder="${ph}" value="${esc(q)}" oninput="${setFn}('q',this.value,true)" autocomplete="off" spellcheck="false">
        <button class="pb-search-x" onclick="${setFn}('q','')" aria-label="Clear">×</button>
      </div>`;
  const uiBand = (groups) => `<tr class="u-band">${groups.map(([l, n, k = 'plain']) => `<th colspan="${n}" class="u-b-${k}">${l}</th>`).join('')}</tr>`;
  // a <col span> repeats its border on every column it spans, so each group is its first column (the divider) plus the rest
  const uiCols = (groups) => `<colgroup>${groups.map(([, n, k = 'plain']) =>
    `<col class="u-g u-g-${k}">${n > 1 ? `<col span="${n - 1}" class="u-g-${k}">` : ''}`).join('')}</colgroup>`;
  // a side line ("o3.5", "u1.5") prints as a side tag, Over violet and Under blue (Ron's Plays' colours), so a board
  // showing both sides of every player (parlay.js Both) reads at a glance
  const uiSd = (sub) => { const m = /^([ou])(\d+(?:\.\d+)?)$/.exec(String(sub)); return m ? `<b class="u-sd ${m[1]}">${m[1].toUpperCase()} ${m[2]}</b>` : sub; };
  const uiFair = (p, sub = '', cls = '') => `<td data-sv="${p}" class="u-fair${p < 0.5 ? ' dog' : ''}${cls ? ' ' + cls : ''}">${Odds.am(p)}<small>${sub ? uiSd(sub) + ' · ' : ''}${Odds.pct(p)}</small></td>`;
  const uiSort = (setFn, cur, defs, key = 'sort') => Object.entries(defs).map(([k, [lab]]) => {
    const on = cur === k || cur === '-' + k, rev = String(cur)[0] === '-';
    return `<button class="pbf-chip${on ? ' on' : ''}" onclick="${setFn}('${key}','${on && !rev ? '-' + k : k}')" title="${on ? 'Tap again to reverse' : 'Sort the cards by this'}">${lab}${on ? (rev ? ' ↑' : ' ↓') : ''}</button>`;
  }).join('');
  function uiSorted(rows, cur, defs) {
    const k = String(cur || '').replace(/^-/, ''), d = defs[k]; if (!d?.[1]) return rows;          // no value: the board's own order
    const dir = (d[2] === 'asc' ? 1 : -1) * (String(cur)[0] === '-' ? -1 : 1);
    const out = rows.map((r, i) => [r, d[1](r), i]).sort((a, b) => {
      const x = a[1], y = b[1];
      if (x == null || Number.isNaN(x)) return y == null || Number.isNaN(y) ? a[2] - b[2] : 1;      // blanks last, either way
      if (y == null || Number.isNaN(y)) return -1;
      return (x < y ? -1 : x > y ? 1 : 0) * dir || a[2] - b[2];
    }).map(x => x[0]);
    out.forEach((r, i) => { if (r && typeof r === 'object' && 'rank' in r) r.rank = i + 1; });
    return out;
  }
  const matchQ = (r, q) => { const t = q.trim().toLowerCase(); return !t || r.name.toLowerCase().includes(t) || r.team.toLowerCase() === t || r.opp.toLowerCase() === t || (r.pos || '').toLowerCase() === t; };

  Object.assign(window, { uiArg, uiChip, uiSort, uiSorted, uiFilters, uiTabs, uiView, uiZoom, uiZoomBtn, uiSearch, matchQ, uiBand, uiCols, uiFair, uiSd });
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
    // the factor filters live in the board's filter sheet (RonUf): register them there, and mark the board
    RonUf.fx(RonUf.panelId(), { key, n, html: `<div class="rfx-body">
        <button class="rfx-tog${s.noRed ? ' on' : ''}" onclick="RonFx.set(${K},'noRed',null,${RE})" title="Nothing working against him: every factor 1.00× or better">🟢 No red</button>
        ${n ? `<button class="rfx-clear" onclick="RonFx.reset(${K},${RE})">Reset ×</button>` : ''}
        <div class="rfx-grid">
          ${cfg.factors.map(fin).join('')}
          ${odds('lo', 'Fair ≥', '+300', 'Fair odds at least this long, e.g. +300 for longshots only')}
          ${odds('hi', 'Fair ≤', '+150', 'Fair odds no longer than this, e.g. +150 for the likeliest')}
          ${cfg.base ? `<label class="rfx-in${s.baseMax != null ? ' on' : ''}" title="${cfg.base[1]} ceiling: hunt players who aren't stars in great spots"><span>${cfg.base[1]} ≤</span><input type="number" step="0.05" min="0" placeholder="1.00" value="${s.baseMax ?? ''}" onchange="RonFx.set(${K},'baseMax',this.value,${RE})"></label>` : ''}
        </div>
        <div class="rfx-hint">Tap <b>+</b> for only green (over 1.00×), or type a floor (1.20× = 20% better than neutral). The grey number is where tonight's top 10% starts: factors run on different scales.</div>
      </div>` });
    return `<i hidden id="rfx-mark-${key}"></i>`;
  }
  window.RonFx = { state, set, reset, apply, pass, html, count };
})();

// ── Click-to-sort for the board tables (u-tbl) that don't sort themselves ──
// Any header sorts its column on the cell's real value: data-sv when the cell has one (uiFair's chance), American
// odds as their chance (Market, Best), else the first number (×1.02, 92', 4/5, +11.2%), else the text. Numbers
// start high-first, text A-Z; a second click reverses. Blanks (—) always sink. # is renumbered in the new order
// (sorting # itself restores the board's own). The sort is kept per board for the session and re-applied whenever
// the board redraws (a filter, a live odds poll), so a page needs nothing beyond class u-tbl.
(function () {
  const S = (() => { try { return JSON.parse(sessionStorage.getItem('uiSort') || '{}'); } catch { return {}; } })();
  const save = () => { try { sessionStorage.setItem('uiSort', JSON.stringify(S)); } catch {} };
  const head = (t) => t.tHead?.rows[t.tHead.rows.length - 1];
  const lab = (th) => th.dataset.lab ?? (th.dataset.lab = th.textContent.trim());
  // a rank column: headed # or blank, and its cells really are numbers (a blank header over names isn't one:
  // Ron's Plays' Record tables had their Lane / Sport / Market names renumbered 1, 2, 3)
  const rankCol = (h, body) => ['', '#'].includes(lab(h.cells[0])) && [...(body?.rows || [])].every(tr => /^\d*$/.test((tr.cells[0]?.dataset.sv ?? tr.cells[0]?.textContent ?? '').trim()));
  const amP = (o) => o > 0 ? 100 / (o + 100) : -o / (100 - o);
  function val(td) {
    if (!td) return null;
    if (td.dataset.sv != null) return +td.dataset.sv;
    const t = td.textContent.replace(/\u2212/g, '-').trim();
    if (!t || /^[—–-]$/.test(t)) return null;
    const am = t.match(/^([+-]\d{3,5})(?![\d.])/); if (am) return amP(+am[1]);
    const n = t.match(/^[×x]?\s*([+-]?\d*\.?\d+)/); if (n) return +n[1];
    return t.toLowerCase();
  }
  function apply(t) {
    const h = head(t), st = S[t.dataset.uk];
    [...h.cells].forEach((c, i) => {
      const on = st && st.i === i; c.classList.toggle('on', !!on);
      c.querySelector('.ar')?.remove(); if (on) c.insertAdjacentHTML('beforeend', `<span class="ar">${st.d > 0 ? '▲' : '▼'}</span>`);
    });
    const body = t.tBodies[0]; if (!body) return;
    // a row with fewer cells (Fantasy's open breakdown) travels with the row above it
    const groups = [];
    for (const tr of [...body.rows]) (tr.cells.length < h.cells.length && groups.length ? groups[groups.length - 1] : groups[groups.push([]) - 1]).push(tr);
    const rk = rankCol(h, body);
    if (rk) for (const [tr] of groups) if (tr.cells[0].dataset.sv == null) tr.cells[0].dataset.sv = tr.cells[0].textContent.trim() || 0;
    if (!st) return;
    groups.sort((a, b) => {
      const x = val(a[0].cells[st.i]), y = val(b[0].cells[st.i]);
      if (x == null || y == null) return x == null ? (y == null ? 0 : 1) : -1;
      if (typeof x !== typeof y) return typeof x === 'number' ? -1 : 1;
      return (x < y ? -1 : x > y ? 1 : 0) * st.d;
    });
    body.append(...groups.flat());
    if (rk) groups.forEach(([tr], i) => { tr.cells[0].textContent = i + 1; });
  }
  let q = 0;
  function scan() {
    q = 0;
    for (const t of document.querySelectorAll('table.u-tbl:not([data-us])')) {
      const h = head(t); if (!h || t.querySelector('thead th[onclick]')) continue;
      t.dataset.us = 1; t.classList.add('u-sortable');
      t.dataset.uk = (t.closest('.panel')?.id || location.pathname) + '|' + [...h.cells].map(lab).join(',');
      apply(t);
    }
  }
  new MutationObserver(() => { if (!q) q = requestAnimationFrame(scan); }).observe(document.documentElement, { childList: true, subtree: true });
  document.addEventListener('click', (e) => {
    const th = e.target.closest('table.u-sortable thead tr:last-child th'); if (!th) return;
    const t = th.closest('table'), i = th.cellIndex, cur = S[t.dataset.uk];
    const first = [...t.tBodies[0].rows].map(r => val(r.cells[i])).find(v => v != null);
    const d0 = i === 0 && rankCol(head(t), t.tBodies[0]) || typeof first === 'string' ? 1 : -1;     // # and text start at the top
    S[t.dataset.uk] = cur && cur.i === i ? { i, d: -cur.d } : { i, d: d0 };
    save(); apply(t);
  });
})();

// A table wider than a phone keeps its player column pinned while the rest scrolls under it (11/03: on a phone the
// boards showed 31-94% of their width, and the name scrolled away with the numbers). The pinned columns are the first
// one through the one headed Player / Skater / Name (a # before it stays too); its cells take the table's own backdrop.
(function () {
  if (window.uiPin) return;
  const PHONE = matchMedia('(max-width: 700px)'), NAME = /^(player|skater|name|batter|pitcher|goalie|team|kicker|qb)\b/i;
  const bgOf = (el) => { for (let e = el; e && e !== document.documentElement; e = e.parentElement) { const c = getComputedStyle(e).backgroundColor; if (c && !/rgba\(0, 0, 0, 0\)|transparent/.test(c)) return c; } return getComputedStyle(document.body).backgroundColor; };
  function pin(t) {
    const w = t.parentElement, wide = PHONE.matches && w && t.scrollWidth > w.clientWidth + 4;
    t.querySelectorAll('.u-pin, .u-pin-wrap').forEach(c => { c.classList.remove('u-pin', 'u-pin-edge', 'u-pin-wrap'); c.style.left = ''; });
    if (!wide) return;
    const h = t.tHead?.rows[t.tHead.rows.length - 1]; if (!h) return;
    let k = [...h.cells].findIndex(c => NAME.test(c.textContent.trim()));
    if (k < 0 || k > 2) k = 0;
    // the # / photo columns through the name; if that block takes over 60% of the screen (zoom counted), the name alone
    // on a phone the pinned name wraps to two lines (as NHL Goals' does) before anything is measured
    for (const r of t.rows) if (!r.classList.contains('u-band') && r.cells.length >= h.cells.length) r.cells[k].classList.add('u-pin-wrap');
    const vis = (j) => h.cells[j].getBoundingClientRect().width, room = w.clientWidth * 0.6;
    let from = 0, span = 0; for (let j = 0; j <= k; j++) span += vis(j);
    if (span > room) { from = k; if (vis(k) > room) return; }
    const lefts = {}; let x = 0;
    for (let j = from; j <= k; j++) { lefts[j] = x; x += h.cells[j].offsetWidth; }
    t.style.setProperty('--u-pin-bg', bgOf(w));
    for (const r of t.rows) {
      if (r.classList.contains('u-band') || r.cells.length < h.cells.length) continue;   // band rows and detail rows scroll
      for (let j = from; j <= k; j++) { const c = r.cells[j]; c.classList.add('u-pin'); c.style.left = lefts[j] + 'px'; if (j === k) c.classList.add('u-pin-edge'); }
    }
  }
  let q = 0;
  // a board with its own Table / Cards switch (NHL Goals) gets the zoom button beside it, as uiView boards do
  const zoomBeside = (t) => {
    for (let e = t.parentElement; e && e !== document.body; e = e.parentElement) {
      const vs = [...e.querySelectorAll('.view-switch')].find(v => /table/i.test(v.textContent) && v.offsetParent);
      if (!vs) continue;
      if (!vs.parentElement.querySelector('.u-zoom-btn')) vs.insertAdjacentHTML('afterend', uiZoomBtn());
      return;
    }
  };
  const scan = () => { q = 0; document.querySelectorAll('table.u-tbl').forEach(t => { if (!t.offsetParent) return; pin(t); if (PHONE.matches && t.scrollWidth > t.parentElement.clientWidth + 4) zoomBeside(t); }); };
  window.uiPin = () => { if (!q) q = requestAnimationFrame(scan); };
  new MutationObserver((ms) => { if (ms.some(m => [...m.addedNodes].some(n => n.nodeType === 1 && (n.matches?.('table.u-tbl, tr') || n.querySelector?.('table.u-tbl'))))) uiPin(); })
    .observe(document.documentElement, { childList: true, subtree: true });
  addEventListener('resize', uiPin); PHONE.addEventListener?.('change', uiPin); window.RonChrome?.onTheme?.(uiPin);
})();
