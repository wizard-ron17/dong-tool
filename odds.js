// One way to print a price, site-wide: American odds with the chance beside it.
// They're the same number — the % is what our models produce and what Kalshi and
// the exchanges trade in (cents), the odds are what a US book shows — so every
// app prints both, the same way. Loaded in <head> (not deferred) so each page's
// own scripts can use it at once.
//
//   Odds.am(p)      "-112" / "+464"             the odds alone (charts, data)
//   Odds.pct(p)     "53%" / "6.7%" / "<0.1%"    the chance alone
//   Odds.inline(p)  -112 <small>53%</small>     HTML: cards, tables, compact rows, chips
//   Odds.both(p)    "-112 · 53%"                plain text: slip headers, shared text
(function () {
  const ok = (p) => p > 0 && p < 1;
  const am = (p) => !ok(p) ? '—' : p >= 0.5 ? '-' + Math.round(100 * p / (1 - p)) : '+' + Math.round(100 * (1 - p) / p);
  // whole percent from 10% up; a decimal below, where 7% vs 6.7% is a real gap on a longshot
  const pct = (p) => !ok(p) ? '—' : p >= 0.095 ? Math.round(p * 100) + '%' : p >= 0.001 ? (p * 100).toFixed(1) + '%' : '<0.1%';
  const inline = (p) => !ok(p) ? '—' : `${am(p)}<small class="oz-p">${pct(p)}</small>`;
  const both = (p) => !ok(p) ? '—' : `${am(p)} · ${pct(p)}`;
  window.Odds = { am, pct, inline, both };
  // the % beside odds: smaller, lighter, never wrapping away from its price
  const css = '.oz-p{font-size:0.72em;font-weight:500;opacity:0.72;margin-left:0.3em;letter-spacing:0;white-space:nowrap;font-family:inherit}';
  const add = () => document.head.insertAdjacentHTML('beforeend', `<style id="oz-css">${css}</style>`);
  if (document.head) add(); else document.addEventListener('DOMContentLoaded', add);
})();
