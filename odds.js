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

  // ── Copy for tracker: the parlay slip -> Ron's odds-viewer bet tracker ──────
  // A readable block for you, ending in one RONBET: line of JSON the tracker's
  // "Import from Ron's Tools" reads into its Add Bet form (you still enter the
  // book, the price you got and the stake — only you know those).
  const amNum = (p) => { const s = am(p); return s === '—' ? null : parseInt(s, 10); };
  const bookAm = (s) => { const m = String(s || '').trim().match(/^([+-]?\d{3,5})$/); return m ? parseInt(m[1], 10) : null; };
  function trackerText(legs, p, { corr = false, book = '' } = {}) {
    const sports = [...new Set(legs.map(l => String(l.sp || '').toUpperCase()).filter(Boolean))];
    const games = [...new Set(legs.map(l => String(l.g || '').replace('@', ' @ ')).filter(Boolean))];
    const one = legs.length === 1;
    const sgp = new Set(legs.map(l => l.g)).size < legs.length;   // two legs from one game
    const legName = (l) => `${l.n}${l.s ? ' ' + l.s : ''}`;
    const bet = {
      v: 1, league: sports.join(' / '), event: games.join(', '),
      market: one ? (legs[0].s || 'Player prop') : `${sgp ? 'SGP' : 'Parlay'} · ${legs.length} legs`,
      betname: legs.map(legName).join(' + '),
      odds: bookAm(book), fair: amNum(p),
      note: `Ron's Tools fair ${am(p)} (${pct(p)})${corr === true || corr === 'sgp' ? ', correlation-priced' : ''}`,
    };
    const lines = [`Ron's Tools · ${one ? 'Single' : `${bet.market}`} · fair ${both(p)}`,
      ...legs.map(l => `  ${legName(l)}${l.g ? ' · ' + String(l.g).replace('@', ' @ ') : ''} · ${both(l.p)}`),
      `RONBET:${JSON.stringify(bet)}`];
    return lines.join('\n');
  }
  async function trackerCopy(legs, p, opts, btn) {
    const text = trackerText(legs, p, opts);
    let ok = false;
    try { await navigator.clipboard.writeText(text); ok = true; } catch (e) {
      // older browsers / no permission: a hidden textarea and execCommand
      const ta = document.createElement('textarea'); ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.select(); try { ok = document.execCommand('copy'); } catch (e2) {} ta.remove();
    }
    if (btn) { const t = btn.textContent; btn.textContent = ok ? 'Copied ✓' : 'Copy failed'; setTimeout(() => { btn.textContent = t; }, 1600); }
    return ok;
  }
  window.RonTracker = { text: trackerText, copy: trackerCopy };
  // the % beside odds: smaller, lighter, never wrapping away from its price
  const css = '.oz-p{font-size:0.72em;font-weight:500;opacity:0.72;margin-left:0.3em;letter-spacing:0;white-space:nowrap;font-family:inherit}';
  const add = () => document.head.insertAdjacentHTML('beforeend', `<style id="oz-css">${css}</style>`);
  if (document.head) add(); else document.addEventListener('DOMContentLoaded', add);
})();
