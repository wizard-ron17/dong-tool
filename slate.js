// Ron's Tools slate: "what do we have today", game by game.
//
// Desktop: the day's games in a rail on the left, the selected game on the
// right: its header, and tabs led by a box score. The box score is the game
// before it's played (our projection for every priced player, one row each,
// one column per market), filling in with what actually happened as the game
// goes, graded against our line once it's final. Phone: the list, and a tap
// opens the same game in the pop-up.
//
// A page hands over what's its own and keeps its own data:
//   RonSlate.render(el, { top, list, rail, panel, pick, key })
//     top    html above everything (the date nav and meta line)
//     list   the games' full rows (html), the phone's list; each carries data-gid="<id>"
//     rail   the desktop rail: [{ label, sub, games: [railItem data] }] (see railItem)
//     panel  (gid) => the game's html: header, tabs, body; '' if it's gone
//     pick   the game to show first (the first one still to play)
//   RonSlate.box(spec)  the box score's html (see box() below)
//   RonSlate.select(gid) / RonSlate.active() / RonSlate.refresh()
// A page's openGame(gid) starts with `if (RonSlate.select(gid)) return;` so
// a tap on a row (or a link anywhere) shows the game in the panel when the
// split view is up, and the pop-up when it isn't.
(function () {
  const CSS = `
  .sl { display: block; }
  .sl-panel, .sl-rail { display: none; }
  .sl-grp { display: flex; align-items: baseline; gap: 0.5rem; margin: 0.7rem 0.1rem 0.35rem; font-size: 0.72rem; color: var(--dim); }
  .sl-grp:first-child { margin-top: 0; }
  .sl-grp b { font-family: var(--font-d); font-size: 0.86rem; color: var(--text-strong); }
  .sl-g { background: var(--surface0); border: 1px solid var(--border); border-radius: 12px; padding: 0.5rem 0.7rem 0.45rem; margin-bottom: 0.45rem; }
  .sl-g:hover { border-color: var(--border2); }
  .sl-when { display: flex; justify-content: space-between; gap: 0.5rem; font-size: 0.66rem; font-weight: 700; letter-spacing: 0.05em; text-transform: uppercase; color: var(--dim); margin-bottom: 0.25rem; }
  .sl-g.live .sl-when span:first-child { color: var(--bad); }
  .sl-t { display: flex; align-items: center; gap: 0.45rem; height: 1.7rem; }
  .sl-t img { width: 20px; height: 20px; object-fit: contain; flex: 0 0 20px; }
  .sl-t b { font-family: var(--font-d); font-size: 0.92rem; color: var(--text-strong); min-width: 2.6rem; }
  .sl-t small { font-family: var(--font-m); font-size: 0.64rem; color: var(--dim); }
  .sl-r { margin-left: auto; font-family: var(--font-m); font-size: 0.78rem; text-align: right; }
  .sl-r { display: flex; gap: 0.55rem; align-items: baseline; }
  .sl-ln { font-weight: 700; color: var(--text-strong); font-size: 0.8rem; }
  .sl-ml { min-width: 2.7rem; color: var(--muted); font-size: 0.72rem; }
  .sl-ml.mv { color: var(--mvc, var(--accent)); font-weight: 700; }
  .sl-t .sl-sc { font-family: var(--font-d); font-size: 1.05rem; font-weight: 700; color: var(--text-strong); }
  .sl-t.lost b, .sl-t.lost .sl-sc { opacity: 0.45; }
  .sl-pick { display: flex; align-items: center; gap: 0.35rem; border-top: 1px solid var(--border); margin-top: 0.35rem; padding-top: 0.35rem; font-size: 0.72rem; color: var(--dim); }
  .sl-pick b { color: var(--text); font-weight: 700; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .sl-pick .sl-od { margin-left: auto; font-family: var(--font-d); font-weight: 700; color: var(--ok); }
  .sl-pick .sl-od.fav { color: var(--good); }
  .sl-pick .hit { color: var(--good); font-weight: 700; } .sl-pick .miss { color: var(--bad); font-weight: 700; }
  @media (min-width: 1000px) {
    .sl { display: grid; grid-template-columns: minmax(290px, 330px) minmax(0, 1fr); gap: 1rem; align-items: start; }
    .sl-list { display: none; }
    .sl-rail { display: block; position: sticky; top: 0.75rem; max-height: calc(100vh - 1.5rem); overflow-y: auto; padding: 2px 4px 2px 2px; scrollbar-width: thin; }
    .sl-rail [data-gid] { cursor: pointer; transition: box-shadow 0.12s, border-color 0.12s; }
    .sl-rail [data-gid].sl-on { border-color: var(--accent); box-shadow: 0 0 0 1.5px var(--accent), 0 8px 24px rgba(0,0,0,0.18); }
    .sl-panel { display: block; min-width: 0; background: var(--surface0); border: 1px solid var(--border); border-radius: 18px; padding: 1rem 1.1rem 1.2rem; }
    .sl-panel .gm-hero { margin-top: 0; }
  }
  /* ── box score ── */
  .bx-sum { display: flex; flex-wrap: wrap; gap: 0.4rem 1.1rem; font-size: 0.74rem; color: var(--dim); margin: 0.2rem 0 0.7rem; }
  .bx-sum b { color: var(--text-strong); font-family: var(--font-d); font-size: 0.9rem; }
  .bx-team { display: flex; align-items: center; gap: 0.5rem; margin: 1rem 0 0.35rem; font-family: var(--font-d); font-weight: 700; font-size: 0.92rem; color: var(--text-strong); }
  .bx-team:first-child { margin-top: 0.2rem; }
  .bx-team img { width: 22px; height: 22px; object-fit: contain; }
  .bx-team small { font-family: var(--font-b); font-weight: 500; font-size: 0.72rem; color: var(--dim); }
  .bx-wrap { overflow-x: auto; border: 1px solid var(--border); border-radius: 12px; background: var(--surface1); scrollbar-width: thin; }
  .bx { width: 100%; border-collapse: separate; border-spacing: 0; font-size: 0.78rem; }
  .bx th { position: sticky; top: 0; background: var(--surface1); color: var(--dim); font: 700 0.62rem var(--font-b); letter-spacing: 0.08em; text-transform: uppercase;
    text-align: right; padding: 0.5rem 0.6rem 0.4rem; border-bottom: 1px solid var(--border); white-space: nowrap; cursor: pointer; user-select: none; }
  .bx th:first-child { text-align: left; cursor: default; }
  .bx th.on { color: var(--accent); }
  .bx th.on::after { content: ' ↓'; }
  .bx td { padding: 0.34rem 0.6rem; border-bottom: 1px solid var(--border); text-align: right; white-space: nowrap; vertical-align: middle; }
  .bx tr:last-child td { border-bottom: none; }
  .bx tbody tr:hover td { background: color-mix(in srgb, var(--accent) 5%, transparent); }
  .bx td:first-child { position: sticky; left: 0; z-index: 1; background: var(--surface1); text-align: left; min-width: 10.5rem; max-width: 13rem; }
  .bx tbody tr:hover td:first-child { background: color-mix(in srgb, var(--accent) 5%, var(--surface1)); }
  .bx-p { display: flex; align-items: center; gap: 0.45rem; cursor: pointer; }
  .bx-p .pk-face, .bx-p img { width: 26px !important; height: 26px !important; flex: 0 0 26px; border-radius: 50%; }
  .bx-p b { font-weight: 700; color: var(--text); overflow: hidden; text-overflow: ellipsis; }
  .bx-p small { display: block; color: var(--dim); font-size: 0.66rem; }
  .bx-nm { min-width: 0; line-height: 1.2; }
  .bx-c { cursor: pointer; }
  .bx-c b { display: block; font-family: var(--font-d); font-size: 0.9rem; font-weight: 700; color: var(--text-strong); line-height: 1.15; }
  .bx-c small { display: block; font-family: var(--font-m); font-size: 0.62rem; color: var(--dim); margin-top: 1px; }
  .bx-c small i { font-style: normal; font-weight: 700; }
  .bx-c small i.odfav { color: var(--good); }
  .bx-c small i.oddog { color: var(--ok); }
  .bx-c.hit b { color: var(--good); }
  .bx-c.miss b { color: var(--muted); font-weight: 600; }   /* most prices are meant to miss: quiet, so the hits stand out */
  .bx-c.hit { background: color-mix(in srgb, var(--good) 9%, transparent); }
  .bx-c.none b { color: var(--dim); font-weight: 500; }
  .bx tr.void td { opacity: 0.45; }
  .bx td.par-pick, .bx-c.par-pick { box-shadow: inset 0 0 0 1.5px var(--accent); }
  body.par-mode .bx td[data-leg] { padding-left: 0.6rem; }
  body.par-mode .bx td[data-leg]::after { display: none; }
  .bx-note { font-size: 0.7rem; color: var(--dim); margin-top: 0.7rem; line-height: 1.5; }
  @media (max-width: 600px) {
    .bx { font-size: 0.74rem; }
    .bx td, .bx th { padding-left: 0.45rem; padding-right: 0.45rem; }
    .bx-p .pk-face, .bx-p img { display: none; }
    .bx td:first-child { min-width: 7.2rem; max-width: 8rem; }
  }
`;
  if (!document.getElementById('slate-css')) document.head.insertAdjacentHTML('beforeend', `<style id="slate-css">${CSS}</style>`);

  const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
  const wide = () => window.matchMedia('(min-width: 1000px)').matches;
  let S = null;           // { el, opts, gid }

  function render(el, opts) {
    if (!el) return;
    const keep = S && S.opts.key === opts.key ? S.gid : null;
    S = { el, opts, gid: keep };
    const rail = (opts.rail || []).map(gr => `${gr.label ? `<div class="sl-grp"><b>${gr.label}</b><span>${gr.sub || ''}</span></div>` : ''}${gr.games.map(railItem).join('')}`).join('');
    el.innerHTML = `${opts.top || ''}<div class="sl"><div class="sl-rail">${rail || opts.list || ''}</div><div class="sl-panel" id="sl-panel"></div><div class="sl-list">${opts.list || ''}</div></div>`;
    const ids = [...el.querySelectorAll('.sl-rail [data-gid]')].map(x => x.dataset.gid);
    if (!ids.length) ids.push(...[...el.querySelectorAll('.sl-list [data-gid]')].map(x => x.dataset.gid));
    if (!ids.includes(String(S.gid))) S.gid = ids.includes(String(opts.pick)) ? String(opts.pick) : ids[0] || null;
    paint();
  }
  /**
   * A rail row, stacked like a scoreboard: the when line, the two teams (logo,
   * name, record, and their line + price before the game or their score after),
   * the top pick. g: { id, when, note, teams: [{ abbr, logo, rec, line, odds, moved, score, lost }], pick, live }
   */
  function railItem(g) {
    return `<div class="sl-g${g.live ? ' live' : ''}" data-gid="${g.id}" onclick="openGame(${JSON.stringify(g.id).replace(/"/g, "'")})" role="button" tabindex="0">
      <div class="sl-when"><span>${g.when || ''}</span><span>${g.note || ''}</span></div>
      ${g.teams.map(t => `<div class="sl-t${t.lost ? ' lost' : ''}">${t.logo || ''}<b>${esc(t.abbr)}</b><small>${t.rec || ''}</small><span class="sl-r">${
        t.score != null ? `<span class="sl-sc">${t.score}</span>` : `<span class="sl-ln">${t.line ?? ''}</span><span class="sl-ml${t.moved ? ' mv' : ''}">${t.odds ?? ''}</span>`}</span></div>`).join('')}
      ${g.pick ? `<div class="sl-pick">${g.pick}</div>` : ''}
    </div>`;
  }
  /** The split view is on screen: the Schedule panel is showing and the window is wide. */
  const active = () => !!(S && S.el.isConnected && S.el.closest('.panel.visible') && wide());
  function paint() {
    if (!S) return;
    S.el.querySelectorAll('.sl-rail [data-gid]').forEach(r => r.classList.toggle('sl-on', r.dataset.gid === String(S.gid)));
    const p = S.el.querySelector('#sl-panel'); if (!p || !wide()) return;   // hidden on a phone: the pop-up shows the game
    p.innerHTML = S.gid != null ? (S.opts.panel(S.gid) || '') : '<div class="empty">No games on this date.</div>';
  }
  /** Show a game in the panel. False when the split view isn't up (the page opens its pop-up). */
  function select(gid) {
    if (!active()) return false;
    S.gid = String(gid); paint();
    const row = S.el.querySelector(`.sl-rail [data-gid="${S.gid}"]`);
    row?.scrollIntoView({ block: 'nearest' });
    return true;
  }
  /** Re-draw the panel in place (a tab change, fresh live data). */
  const refresh = () => { if (active()) paint(); };
  const current = () => (active() ? S.gid : null);
  window.addEventListener('resize', () => { if (S && S.el.isConnected && wide()) paint(); });

  // ── Box score ─────────────────────────────────────────────────────────────
  // spec: { state: 'pre'|'live'|'post', teams: [{ abbr, logo, sub, groups: [{ cols, rows }] }], note }
  //   cols:  [{ k, lab, title?, yes? }]         yes: a yes/no market (goal, TD) — shows the price, not a count
  //   rows:  [{ name, pos, face, sub, open, void, cells: { [k]: { proj, dp, line, p, got, leg, open } } }]
  //     got: what he did (null until final; a yes market's got is the count, 0 = no)
  // A column header sorts every table by that market (tap again for the page's own order).
  let sortKey = null;
  const sortHooks = [];
  const onSort = (f) => sortHooks.push(f);        // the page re-draws its pop-up here
  const sortBy = (k) => { sortKey = sortKey === k ? null : k; refresh(); sortHooks.forEach(f => f()); };
  function cellHtml(c, col, state) {
    if (!c) return '<td class="bx-c none"><b>—</b></td>';
    const fin = c.got != null && c.got >= 0 && state !== 'pre';
    const hit = fin && (col.yes ? c.got >= 1 : c.got > c.line);
    const tone = c.p >= 0.5 ? 'odfav' : 'oddog';
    const attr = `${c.leg && state === 'pre' && window.parAttr ? parAttr(c.leg) : ''}${c.open ? ` onclick="${esc(c.open)}"` : ''}`;
    const title = col.yes ? `${col.title || col.lab}: fair ${Odds.am(c.p)} (${Odds.pct(c.p)})` : `${col.title || col.lab}: projected ${(+c.proj).toFixed(c.dp ?? 1)}, over ${c.line} fair ${Odds.am(c.p)} (${Odds.pct(c.p)})`;
    if (col.yes) {
      const big = fin ? (c.got >= 1 ? (c.got > 1 ? `✓ ${c.got}` : '✓') : '✗') : Odds.am(c.p);
      const small = fin ? `was ${Odds.am(c.p)}` : Odds.pct(c.p);
      return `<td class="bx-c${fin ? (hit ? ' hit' : ' miss') : ''}" title="${esc(title)}"${attr}><b>${big}</b><small>${small}</small></td>`;
    }
    const big = fin ? c.got : (+c.proj).toFixed(c.dp ?? 1);
    const small = fin ? `${(+c.proj).toFixed(c.dp ?? 1)} · o${c.line}` : `o${c.line} <i class="${tone}">${Odds.am(c.p)}</i>`;
    return `<td class="bx-c${fin ? (hit ? ' hit' : ' miss') : ''}" title="${esc(title)}"${attr}><b>${big}</b><small>${small}</small></td>`;
  }
  const sortVal = (r, col) => { const c = r.cells[col.k]; return !c ? -1 : col.yes ? c.p : +c.proj; };
  function box(spec) {
    const state = spec.state || 'pre';
    // the night graded: every call with a result, and how many we expected
    let sum = '';
    if (state !== 'pre') {
      const calls = [];
      for (const t of spec.teams) for (const g of t.groups) for (const r of g.rows) for (const col of g.cols) {
        const c = r.cells[col.k]; if (!c || c.got == null || c.got < 0) continue;
        calls.push({ p: c.p, hit: col.yes ? c.got >= 1 : c.got > c.line });
      }
      if (calls.length) sum = `<div class="bx-sum"><span><b>${calls.filter(x => x.hit).length}/${calls.length}</b> calls landed</span><span><b>${calls.reduce((a, x) => a + x.p, 0).toFixed(1)}</b> expected at our prices</span>${spec.extra || ''}</div>`;
    }
    const table = (g) => {
      const cols = g.cols.filter(col => g.rows.some(r => r.cells[col.k]));
      if (!cols.length || !g.rows.length) return '';
      const sc = cols.find(c => c.k === sortKey);
      const rows = sc ? g.rows.slice().sort((a, b) => sortVal(b, sc) - sortVal(a, sc)) : g.rows;
      return `<div class="bx-wrap"><table class="bx"><thead><tr><th>${esc(g.name || 'Player')}</th>${cols.map(c =>
        `<th class="${c.k === sortKey ? 'on' : ''}" title="${esc(c.title || c.lab)} — tap to sort" onclick="RonSlate.sortBy('${c.k}')">${esc(c.lab)}</th>`).join('')}</tr></thead>
        <tbody>${rows.map(r => `<tr class="${r.void ? 'void' : ''}">
          <td><div class="bx-p"${r.open ? ` onclick="${esc(r.open)}"` : ''}>${r.face || ''}<span class="bx-nm"><b>${esc(r.name)}</b><small>${r.pos ? esc(r.pos) : ''}${r.sub ? ` · ${r.sub}` : ''}</small></span></div></td>
          ${cols.map(c => r.void ? '<td class="bx-c none"><b>—</b></td>' : cellHtml(r.cells[c.k], c, state)).join('')}</tr>`).join('')}</tbody></table></div>`;
    };
    const teams = spec.teams.map(t => {
      const body = t.groups.map(table).join('');
      return body ? `<div class="bx-team">${t.logo || ''}${esc(t.abbr)}${t.sub ? `<small>${t.sub}</small>` : ''}</div>${body}` : '';
    }).join('');
    if (!teams) return `<div class="empty" style="padding:2rem 0">${spec.empty || 'Nothing priced for this game yet.'}</div>`;
    return sum + teams + (spec.note ? `<p class="bx-note">${spec.note}</p>` : '');
  }

  window.RonSlate = { render, select, active, refresh, current, box, sortBy, onSort, railItem };
})();
