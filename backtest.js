// Ron's Tools backtest drawer for pages whose backtest lives in <sport>/backtests.json (NBA and MLB):
// research/backtests_export.py scores the walk-forward predictions and writes the two tables every drawer
// shows, pre-formatted. A page appends RonBacktest.html('key') to its board or Results; the drawer fills in
// when the file arrives. (NHL and NFL draw theirs from data.json and keep their own.)
(function () {
  const CSS = `
  .rbt { margin-top: 1.4rem; border-top: 1px solid var(--border); padding-top: 0.7rem; }
  .rbt > summary { cursor: pointer; font-family: var(--font-d); font-weight: 700; color: var(--muted); letter-spacing: 0.04em; }
  .rbt[open] > summary { margin-bottom: 0.7rem; }
  .rbt-h { margin: 0.9rem 0 0.4rem; font-size: 0.78rem; color: var(--muted); }
  .rbt-wrap { overflow-x: auto; border: 1px solid var(--border); border-radius: 10px; background: var(--surface0); }
  .rbt-t { width: 100%; border-collapse: collapse; font-size: 0.82rem; }
  .rbt-t th { background: var(--surface1); color: var(--muted); font-size: 0.7rem; letter-spacing: 0.06em; text-transform: uppercase; text-align: right; padding: 0.5rem 0.7rem; white-space: nowrap; }
  .rbt-t td { padding: 0.45rem 0.7rem; text-align: right; border-top: 1px solid var(--border); font-variant-numeric: tabular-nums; }
  .rbt-t th:first-child, .rbt-t td:first-child { text-align: left; }
  .rbt-t b { color: var(--text); }
  .rbt-note { margin-top: 0.7rem; font-size: 0.74rem; line-height: 1.5; color: var(--dim); }
  `;
  if (!document.getElementById('rbt-css')) document.head.insertAdjacentHTML('beforeend', `<style id="rbt-css">${CSS}</style>`);
  let DATA = null, STATE = 'idle'; const OPEN = {};
  const load = () => {
    if (STATE !== 'idle') return; STATE = 'loading';
    dataFetch('backtests.json').then(r => r.ok ? r.json() : Promise.reject()).then(j => { DATA = j; STATE = 'ready'; fill(); }).catch(() => { STATE = 'error'; });
  };
  const drawer = (key) => {
    const t = DATA?.tools?.[key]; if (!t) return '';
    const tbl = (s) => `<div class="rbt-h">${s.h}</div><div class="rbt-wrap"><table class="rbt-t"><thead><tr>${s.head.map(h => `<th>${h}</th>`).join('')}</tr></thead><tbody>${
      s.rows.map(r => `<tr>${r.map(c => `<td>${c}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
    return `<details class="rbt"${OPEN[key] ? ' open' : ''} ontoggle="RonBacktest.open('${key}', this.open)"><summary>${t.title}</summary>${t.sections.map(tbl).join('')}<div class="rbt-note">${t.note || ''}</div></details>`;
  };
  const fill = () => document.querySelectorAll('.rbt-slot').forEach(el => { el.innerHTML = drawer(el.dataset.key); });
  window.RonBacktest = {
    html(key) { load(); return `<div class="rbt-slot" data-key="${key}">${drawer(key)}</div>`; },
    open(key, v) { OPEN[key] = v; },
    fill,
  };
})();
