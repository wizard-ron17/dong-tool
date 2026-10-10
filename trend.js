// Ron's Tools league trend chart: one number per game across the season, read like a
// stock chart. MLB's Stats tab drew HR/game this way (its own copy of this code); the
// other sports get it here, each fed a series by its page: NHL goals/game by day, NFL
// touchdowns/game by week, NBA threes/game by day. Rolling averages, a Bollinger band,
// MACD, zoom presets and drag-to-zoom. Needs Chart.js, which it loads itself.
//
//   RonTrend.render(el, {
//     key: 'nhl',                       // state is kept per key, so a redraw keeps the toggles
//     noun: 'Goals', unit: 'goals/game',
//     grain: 'day' | 'week',            // day: ~14-day band, MACD; week: short windows only
//     series: (team) => [{ label, n, tot }],  // team is 'ALL' or a team code; one point per game day/week
//     teams: [{ v, name }],             // optional team filter (the team's own count per its game)
//     rolls: [{ n, color, on }], note: 'what the number counts'
//   })
//
// The technicals are momentum read-outs. MLB's "Lean Heavy / Go Light" stance came from a
// backtest of MLB's own season, and nothing here has been tested like that, so no stance.
(function () {
  const CSS = `
  .tnd-chips { display: flex; gap: 0.5rem; flex-wrap: wrap; margin-bottom: 0.7rem; }
  .tnd-chip { box-sizing: border-box; background: var(--surface1); border: 1px solid var(--border2); border-radius: 6px; padding: 0.45rem 0.7rem; display: flex; flex-direction: column; gap: 0.2rem; min-width: 80px; flex: 1; }
  .tnd-chip b { font-family: var(--font-d); font-size: 1.4rem; font-weight: 700; line-height: 1; color: var(--accent); }
  .tnd-chip span { font-size: 0.667rem; color: var(--muted); letter-spacing: 0.12em; text-transform: uppercase; }
  .tnd-row { display: flex; align-items: center; gap: 0.35rem; flex-wrap: wrap; margin: 0.1rem 0 0.5rem; }
  .tnd-lbl { font-size: 0.692rem; font-weight: 800; letter-spacing: 0.06em; text-transform: uppercase; color: var(--muted); margin-right: 0.1rem; }
  .tnd-reset { background: transparent; border: 1px solid var(--border); color: var(--muted); font-family: var(--font-b); font-weight: 700; font-size: 0.704rem; padding: 0.15rem 0.5rem; border-radius: 999px; cursor: pointer; }
  .tnd-reset:hover { border-color: var(--accent); color: var(--accent); }
  .tnd-hint { font-size: 0.680rem; color: var(--dim); margin-left: 0.15rem; }
  @media (max-width: 600px) { .tnd-hint { display: none; } .tnd-chip { min-width: calc(50% - 0.5rem); } }
  .tnd-wrap { background: var(--surface0); border: 1px solid var(--border); border-radius: 8px; padding: 0.8rem; position: relative; width: 100%; height: 300px; box-sizing: border-box; }
  @media (max-width: 600px) { .tnd-wrap { height: 340px; padding: 0.5rem 0.3rem 0.5rem 0.5rem; } }
  .tnd-wrap canvas { touch-action: pan-y; }
  .tnd-sel { position: absolute; top: 0.8rem; bottom: 2.1rem; background: color-mix(in srgb, var(--accent) 16%, transparent); border-left: 1px solid var(--accent); border-right: 1px solid var(--accent); pointer-events: none; z-index: 3; }
  .tnd-macd { height: 200px; margin-top: 0.4rem; }
  @media (max-width: 600px) { .tnd-macd { height: 175px; } }
  .tnd-macd-t { position: absolute; top: 0.4rem; left: 0.7rem; font-family: var(--font-b); font-size: 0.667rem; letter-spacing: 0.08em; color: var(--dim); text-transform: uppercase; z-index: 1; }
  .tnd-legend { margin-top: 0.5rem; font-size: 0.680rem; color: var(--muted); letter-spacing: 0.08em; display: flex; align-items: center; gap: 0.4rem; flex-wrap: wrap; text-transform: uppercase; }
  .tnd-tog { background: var(--surface1); border: 1px solid var(--border2); color: var(--dim); font-family: var(--font-b); font-size: 0.692rem; font-weight: 700; letter-spacing: 0.04em; padding: 0.15rem 0.55rem; border-radius: 20px; cursor: pointer; }
  .tnd-tog:hover { color: var(--text); }
  .tnd-tog.active { background: var(--surface2); border-color: var(--c); color: var(--c); }
  .tnd-tog.off { opacity: 0.4; cursor: default; }
  .tnd-note { flex-basis: 100%; font-size: 0.680rem; line-height: 1.45; color: var(--dim); letter-spacing: 0.02em; text-transform: none; }
  .tnd-note b { color: var(--muted); font-weight: 600; }
  .tnd-empty { padding: 1.4rem 0.4rem; color: var(--muted); font-size: 0.9rem; line-height: 1.5; }
  `;
  if (!document.getElementById('tnd-css')) document.head.insertAdjacentHTML('beforeend', `<style id="tnd-css">${CSS}</style>`);

  const INST = {};
  const DEF_ROLLS = [{ n: 7, color: '#3bc9e0', on: true }, { n: 14, color: '#7c8cf0', on: true }, { n: 30, color: '#b070e8', on: false }];
  let chartP = null;
  const loadChart = () => chartP ||= window.Chart ? Promise.resolve() : new Promise((ok, no) => {
    const s = document.createElement('script');
    s.src = 'https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.1/chart.umd.js';
    s.onload = ok; s.onerror = () => { chartP = null; no(new Error('Chart.js')); };
    document.head.appendChild(s);
  });
  const css = (v) => getComputedStyle(document.body).getPropertyValue(v).trim();
  const mob = () => window.innerWidth <= 600;
  const r2 = (v) => Math.round(v * 100) / 100;
  const ema = (a, w) => { const k = 2 / (w + 1); let e = a[0]; return a.map((v, i) => i ? (e = v * k + e * (1 - k)) : e); };
  const sd = (a) => { if (a.length < 2) return 0; const m = a.reduce((x, y) => x + y, 0) / a.length; return Math.sqrt(a.reduce((x, y) => x + (y - m) ** 2, 0) / (a.length - 1)); };
  const avg = (s) => s.reduce((a, b) => a + b, 0) / s.length;
  const trail = (data, w) => data.map((_, i) => data.slice(Math.max(0, i - w + 1), i + 1));

  function state(spec) {
    return INST[spec.key] ||= { team: 'ALL', rolls: new Set((spec.rolls || DEF_ROLLS).filter(r => r.on).map(r => r.n)), bands: true, macd: false, zoom: null, preset: 0, chart: null, macdChart: null };
  }

  function render(el, spec) {
    if (!el) return;
    const st = state(spec);
    st.spec = spec; st.el = el;
    const pts = spec.series(st.team) || [];
    const opts = (spec.teams || []).map(t => `<option value="${t.v}"${t.v === st.team ? ' selected' : ''}>${t.name}</option>`).join('');
    const teamRow = opts ? `<div class="tnd-row"><span class="tnd-lbl">Team</span><select class="fl-sel" onchange="RonTrend.act('${spec.key}','team',this.value)">${opts}</select></div>` : '';
    if (!pts.length) {   // keep the team picker, so a team with no games yet is not a dead end
      el.innerHTML = (st.team !== 'ALL' ? teamRow : '') + `<div class="tnd-empty">${st.team !== 'ALL' ? 'No finished games for this team yet.' : spec.empty || 'No finished games yet. The chart starts with the first full day of games.'}</div>`;
      return;
    }
    const day = spec.grain !== 'week', dec = spec.dec ?? 2;
    const rate = pts.map(p => r2(p.tot / p.n));
    const games = pts.reduce((a, p) => a + p.n, 0), total = pts.reduce((a, p) => a + p.tot, 0);
    let pk = 0; rate.forEach((v, i) => { if (v > rate[pk]) pk = i; });
    const bandWin = spec.bandWin || 14, rolls = (spec.rolls || DEF_ROLLS).filter(r => r.n < pts.length || r.n <= 7);
    const bandsOk = day && pts.length >= 10, macdOk = day && pts.length >= 26;
    const bandsOn = st.bands && bandsOk, macdOn = st.macd && macdOk;

    // technicals run on the full series; zoom only narrows the window
    const tr = trail(rate, bandWin), bMean = tr.map(s => r2(avg(s))), bSd = tr.map(sd);
    const upper = bMean.map((m, i) => r2(m + 2 * bSd[i])), lower = bMean.map((m, i) => r2(Math.max(0, m - 2 * bSd[i])));
    const fast = ema(rate, 12), slow = ema(rate, 26);
    const macdLine = rate.map((_, i) => Math.round((fast[i] - slow[i]) * 1000) / 1000);
    const sig = ema(macdLine, 9).map(v => Math.round(v * 1000) / 1000);
    const hist = macdLine.map((v, i) => Math.round((v - sig[i]) * 1000) / 1000);
    const hNow = hist[hist.length - 1] ?? 0, sigNow = bSd[bSd.length - 1] || 0;

    const togs = rolls.map(r => `<button class="tnd-tog${st.rolls.has(r.n) ? ' active' : ''}" style="--c:${r.color}" onclick="RonTrend.act('${spec.key}','roll',${r.n})">${r.n}${day ? 'd' : 'w'}</button>`).join('');
    const presets = (day ? [[0, 'Season'], [30, '1M'], [14, '2W'], [7, '1W']] : [[0, 'Season'], [8, '8W'], [4, '4W']]).filter(([n]) => !n || n < pts.length);
    const noteBits = [];
    if (spec.note) noteBits.push(spec.note);
    if (bandsOn) noteBits.push(`<b>σ Bands</b>: the ${bandWin}-day mean ±2σ. Band width is how choppy the scoring has been; the line outside it is a move beyond normal day-to-day noise.`);
    if (macdOn) noteBits.push(`<b>MACD</b> (panel below): the histogram above zero means the rate is climbing against its own trend, below zero means it is rolling over. A read of momentum, not a forecast.`);
    el.innerHTML = `
      <div class="tnd-chips">
        <div class="tnd-chip"><b>${total.toLocaleString()}</b><span>${spec.noun}</span></div>
        <div class="tnd-chip"><b>${games.toLocaleString()}</b><span>Games</span></div>
        <div class="tnd-chip"><b>${(total / games).toFixed(dec)}</b><span>${spec.unit}</span></div>
        <div class="tnd-chip"><b>${rate[pk].toFixed(dec)}</b><span>Peak · ${pts[pk].label}</span></div>
        ${bandsOk ? `<div class="tnd-chip"><b>±${sigNow.toFixed(dec)}</b><span>Volatility ${bandWin}${day ? 'd' : 'w'}</span></div>` : ''}
        ${macdOk ? `<div class="tnd-chip"><b>${hNow >= 0 ? '+' : ''}${hNow.toFixed(3)}</b><span>Momentum</span></div>` : ''}
      </div>
      ${teamRow}
      <div class="tnd-row"><span class="tnd-lbl">Zoom</span>
        ${presets.map(([n, l]) => `<button class="due-filter-chip${st.preset === n ? ' active' : ''}" onclick="RonTrend.act('${spec.key}','zoom',${n})">${l}</button>`).join('')}
        ${st.zoom ? `<button class="tnd-reset" onclick="RonTrend.act('${spec.key}','zoom',0)">✕ Reset</button>` : ''}
        <span class="tnd-hint">or drag across the chart to highlight a range</span></div>
      <div class="tnd-wrap"><canvas id="tnd-c-${spec.key}" role="img" aria-label="${spec.unit} by ${day ? 'day' : 'week'}"></canvas></div>
      ${macdOn ? `<div class="tnd-wrap tnd-macd"><div class="tnd-macd-t">MACD (12/26/9) · momentum</div><canvas id="tnd-m-${spec.key}" role="img" aria-label="MACD momentum histogram"></canvas></div>` : ''}
      <div class="tnd-legend"><span>${spec.unit} per ${day ? 'day' : 'week'} · hover for game count · rolling avg:</span>${togs}</div>
      <div class="tnd-legend"><span>Technicals:</span>
        <button class="tnd-tog${bandsOn ? ' active' : ''}${bandsOk ? '' : ' off'}" style="--c:#8794ab" ${bandsOk ? `onclick="RonTrend.act('${spec.key}','bands')"` : 'title="Needs 10 game days"'}>σ Bands</button>
        ${day ? `<button class="tnd-tog${macdOn ? ' active' : ''}${macdOk ? '' : ' off'}" style="--c:#3bc9e0" ${macdOk ? `onclick="RonTrend.act('${spec.key}','macd')"` : 'title="Needs 26 game days"'}>MACD</button>` : ''}
        ${noteBits.map(n => `<span class="tnd-note">${n}</span>`).join('')}
      </div>`;

    loadChart().then(() => {
      if (INST[spec.key] !== st || st.spec !== spec || !el.isConnected) return;
      const cv = document.getElementById(`tnd-c-${spec.key}`); if (!cv) return;
      st.chart?.destroy(); st.macdChart?.destroy();
      const m = mob(), accent = css('--accent') || '#33d07c', grid = css('--border') || '#16243a', tick = css('--dim') || '#6c8299';
      const tip = { backgroundColor: css('--surface1') || '#0c1424', borderColor: css('--border2') || '#1e3050', borderWidth: 1, titleColor: css('--text') || '#c8d8ec', bodyColor: css('--muted') || '#8aaac0' };
      const n = pts.length, z = st.zoom && st.zoom.max - st.zoom.min >= 1 ? st.zoom : null;
      const step = Math.max(1, Math.ceil(n / (m ? 4 : 14))), labels = pts.map((p, i) => i % step === 0 ? p.label : '');
      const font = { family: "'JetBrains Mono',monospace", size: m ? 8 : 10 };
      const xs = { min: z?.min, max: z?.max, grid: { color: grid, lineWidth: 0.5 }, ticks: { color: tick, font, maxRotation: m ? 55 : 45, autoSkip: false } };
      const ds = [{ label: spec.unit, data: rate, borderColor: m ? accent + '66' : accent, backgroundColor: m ? 'transparent' : accent + '12', borderWidth: m ? 0.8 : 1.5, pointRadius: n < 25 ? 3 : 0, tension: 0.35, fill: !m, order: 99 }];
      rolls.filter(r => st.rolls.has(r.n)).forEach((r, i, a) => ds.push({ label: `${r.n}${day ? 'd' : 'w'}`, data: trail(rate, r.n).map(s => r2(avg(s))), borderColor: r.color, backgroundColor: 'transparent', borderWidth: 2, pointRadius: 0, tension: 0.4, order: a.length - i }));
      if (bandsOn) {
        const bl = m ? 'rgba(135,148,171,0.26)' : 'rgba(135,148,171,0.4)';
        ds.push({ label: '+2σ', data: upper, borderColor: bl, borderWidth: 1, borderDash: [3, 3], pointRadius: 0, tension: 0.3, fill: '+1', backgroundColor: 'rgba(135,148,171,0.11)', order: 120 },
          { label: '−2σ', data: lower, borderColor: bl, borderWidth: 1, borderDash: [3, 3], pointRadius: 0, tension: 0.3, fill: false, order: 120 },
          { label: `${bandWin}d mean`, data: bMean, borderColor: 'rgba(190,200,215,0.5)', borderWidth: 1, borderDash: [6, 4], pointRadius: 0, tension: 0.3, fill: false, order: 120 });
      }
      st.chart = new Chart(cv.getContext('2d'), { type: 'line', data: { labels, datasets: ds }, options: {
        responsive: true, maintainAspectRatio: false, interaction: { mode: 'index', intersect: false },
        plugins: { legend: { display: false }, tooltip: { ...tip, titleFont: font, bodyFont: font,
          filter: (it) => m ? it.datasetIndex === 0 : !/σ|mean/.test(it.dataset.label || ''),
          callbacks: { title: (it) => `${pts[it[0].dataIndex].label}  ·  ${pts[it[0].dataIndex].n}G`, label: (it) => ` ${it.raw.toFixed(dec)} ${it.datasetIndex ? it.dataset.label : spec.unit}` } } },
        scales: { x: xs, y: { min: 0, grid: { color: grid, lineWidth: 0.5 }, ticks: { color: tick, font, callback: (v) => v.toFixed(1), maxTicksLimit: m ? 5 : 8 } } } } });
      bindDrag(cv, st, n);
      const mc = document.getElementById(`tnd-m-${spec.key}`);
      if (mc) st.macdChart = new Chart(mc.getContext('2d'), { type: 'bar', data: { labels, datasets: [
        { type: 'bar', label: 'Hist', data: hist, order: 10, backgroundColor: hist.map(v => v >= 0 ? accent + '8c' : 'rgba(135,148,171,0.5)'), borderWidth: 0, barPercentage: 1, categoryPercentage: 1 },
        { type: 'line', label: 'MACD', data: macdLine, borderColor: '#3bc9e0', borderWidth: m ? 1.8 : 2.4, pointRadius: 0, tension: 0.25, order: 1 },
        { type: 'line', label: 'Signal', data: sig, borderColor: '#b070e8', borderWidth: m ? 1.8 : 2.4, pointRadius: 0, tension: 0.25, order: 1 }] },
        options: { responsive: true, maintainAspectRatio: false, interaction: { mode: 'index', intersect: false },
          plugins: { legend: { display: false }, tooltip: { ...tip, titleFont: font, bodyFont: font, filter: m ? (it) => it.dataset.label === 'Hist' : () => true,
            callbacks: { title: (it) => pts[it[0].dataIndex].label, label: (it) => ` ${it.raw >= 0 ? '+' : ''}${(it.raw ?? 0).toFixed(3)} ${it.dataset.label}` } } },
          scales: { x: xs, y: { grid: { color: (c) => c.tick.value === 0 ? css('--border2') : grid, lineWidth: 0.5 }, ticks: { color: tick, font, maxTicksLimit: m ? 4 : 6 } } } } });
    }).catch(() => { el.insertAdjacentHTML('beforeend', '<div class="tnd-empty">The chart library did not load. Check the connection and reopen this tab.</div>'); });
  }

  // Drag across the chart to highlight a range, then zoom to it. A plain click is left to the tooltip.
  function bindDrag(cv, st, n) {
    const wrap = cv.closest('.tnd-wrap'); let x0 = null, sel = null;
    const idx = (x) => { const v = st.chart?.scales?.x?.getValueForPixel(x - cv.getBoundingClientRect().left); return v == null ? null : Math.max(0, Math.min(n - 1, Math.round(v))); };
    cv.onpointerdown = (e) => {
      if (e.button != null && e.button !== 0) return;
      x0 = e.clientX; const r = wrap.getBoundingClientRect();
      sel = document.createElement('div'); sel.className = 'tnd-sel'; sel.style.left = (e.clientX - r.left) + 'px'; sel.style.width = '0px'; wrap.appendChild(sel);
      try { cv.setPointerCapture(e.pointerId); } catch (_) {}
    };
    cv.onpointermove = (e) => { if (x0 == null || !sel) return; const r = wrap.getBoundingClientRect(); sel.style.left = Math.min(x0, e.clientX) - r.left + 'px'; sel.style.width = Math.abs(e.clientX - x0) + 'px'; };
    const end = (e) => {
      if (x0 == null) return;
      const a = idx(x0), b = e ? idx(e.clientX) : null; sel?.remove(); sel = null; x0 = null;
      if (a != null && b != null && Math.abs(a - b) >= 2) { st.zoom = { min: Math.min(a, b), max: Math.max(a, b) }; st.preset = -1; render(st.el, st.spec); }
    };
    cv.onpointerup = end; cv.onpointercancel = () => { sel?.remove(); sel = null; x0 = null; };
  }

  function act(key, what, v) {
    const st = INST[key]; if (!st) return;
    if (what === 'roll') st.rolls.has(v) ? st.rolls.delete(v) : st.rolls.add(v);
    else if (what === 'team') { st.team = v; st.zoom = null; st.preset = 0; }
    else if (what === 'bands') st.bands = !st.bands;
    else if (what === 'macd') st.macd = !st.macd;
    else if (what === 'zoom') {
      const n = st.spec.series(st.team).length;
      st.preset = v; st.zoom = v && n - v >= 1 ? { min: n - v, max: n - 1 } : null;
    }
    render(st.el, st.spec);
  }

  // a theme flip changes every colour the canvas read
  const redraw = () => Object.values(INST).forEach(s => s.el?.isConnected && s.spec && render(s.el, s.spec));
  if (window.RonChrome?.onTheme) RonChrome.onTheme(redraw);
  window.RonTrend = { render, act };
})();
