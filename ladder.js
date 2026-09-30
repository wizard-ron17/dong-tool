// Ron's Tools ladder card: the player card with a stat's distribution chart,
// its over/under chances and the ladder of lines (NFL Receptions and friends,
// NHL Shots/Saves/Points, NBA every board). The styles live here; the drawing
// functions follow. Each app keeps what's its own: the distribution (pmf),
// the metrics row and which lines it offers.
(function () {
  const CSS = `
  .pm.ydm { box-sizing: border-box; max-width: 1020px; padding: 1.3rem 1.4rem 1.1rem; border-radius: 18px; background: linear-gradient(180deg, color-mix(in srgb, var(--surface1) 60%, var(--surface0)), var(--surface0)); }
  .ydm-hero { display: grid; grid-template-columns: auto 1fr auto; align-items: center; gap: 1.1rem; padding: 0.2rem 2rem 1rem 0.2rem; border-bottom: 1px solid var(--border); margin-bottom: 1rem; }
  .ydm-hero .rc-photo { width: 96px; height: 96px; border-radius: 50%; object-fit: cover; margin: 0; }
  .ydm-hero .rc-noface { display: flex; align-items: center; justify-content: center; font-size: 2rem; }
  .ydm-id h2 { margin: 0; font-family: var(--font-d); font-weight: 700; font-size: clamp(1.5rem, 3.4vw, 2.3rem); color: var(--text-strong); line-height: 1.05; }
  .ydm-meta { display: flex; align-items: center; gap: 0.5rem; flex-wrap: wrap; margin-top: 0.35rem; color: var(--silver); font-family: var(--font-d); font-size: 1.05rem; }
  .ydm-meta b { color: var(--silver); }
  .ydm-meta span { color: var(--dim); }
  .ydm-meta img { width: 28px; height: 28px; object-fit: contain; margin-left: 0.3rem; }
  .ydm-meta .ydm-count { margin-left: 0.4rem; font-size: 0.78rem; color: var(--dim); }
  .ydm-big { display: flex; align-items: center; gap: 1.2rem; padding-left: 1.3rem; border-left: 1px solid var(--border); }
  .ydm-big div { display: flex; flex-direction: column; gap: 0.35rem; font-family: var(--font-d); font-size: 0.82rem; letter-spacing: 0.1em; text-transform: uppercase; color: var(--muted); }
  .ydm-big div b { color: var(--text); font-size: 1rem; margin-left: 0.3rem; }
  .ydm-big strong { font-family: var(--font-d); font-size: clamp(2.6rem, 6vw, 3.8rem); line-height: 1; color: var(--good); }
  .ydm-grid { display: grid; grid-template-columns: minmax(0, 1fr) 300px; gap: 1rem; align-items: start; min-width: 0; }
  .ydm-main { display: grid; gap: 1rem; min-width: 0; }
  .ydm-panel { background: color-mix(in srgb, var(--surface1) 55%, transparent); border: 1px solid var(--border); border-radius: 12px; padding: 1rem 1.1rem; }
  .ydm-panel h3 { margin: 0; font-family: var(--font-d); font-size: 1.15rem; letter-spacing: 0.06em; text-transform: uppercase; color: var(--text-strong); }
  .ydm-panel h4 { margin: 0 0 0.6rem; font-family: var(--font-d); font-size: 0.85rem; letter-spacing: 0.14em; text-transform: uppercase; color: var(--silver); }
  .ydm-panel h4.accent { color: var(--good); }
  .ydm-chart-head p { margin: 0.2rem 0 0; font-size: 0.85rem; color: var(--muted); }
  .ydm-chart-row { display: grid; grid-template-columns: minmax(0, 1fr) 190px; gap: 0.9rem; align-items: start; margin-top: 0.4rem; }
  .ydc-wrap { position: relative; }
  .ydc { width: 100%; height: auto; display: block; }
  .ydc-grid { stroke: var(--border); stroke-width: 1; }
  .ydc-grid.v { stroke-dasharray: 2 4; opacity: 0.7; }
  .ydc-ax { fill: var(--muted); font-size: 15px; font-family: var(--font-b); }
  .ydc-line { stroke: var(--gold); stroke-width: 1.6; }
  .ydc-linelbl { fill: var(--gold); font-size: 15px; font-weight: 700; font-family: var(--font-d); }
  .ydc-tag { position: absolute; transform: translate(-50%, -100%); background: var(--surface0); border: 1px solid var(--border2); border-radius: 8px; padding: 0.2rem 0.6rem; text-align: center; line-height: 1.1; pointer-events: none; }
  .ydc-tag span { display: block; font-size: 0.7rem; color: var(--silver); }
  .ydc-tag b { font-family: var(--font-d); font-size: 1.2rem; color: var(--good); }
  .ydm-probs { border: 1px solid var(--border); border-radius: 10px; overflow: hidden; }
  .ydp { padding: 0.8rem 0.9rem; display: flex; flex-direction: column; gap: 0.35rem; }
  .ydp + .ydp { border-top: 1px solid var(--border); }
  .ydp span { font-size: 0.72rem; letter-spacing: 0.06em; text-transform: uppercase; color: var(--silver); }
  .ydp b { font-family: var(--font-d); font-size: 1.75rem; color: var(--text-strong); line-height: 1; }
  .ydp i { display: block; height: 7px; border-radius: 4px; background: var(--surface2); overflow: hidden; }
  .ydp i em { display: block; height: 100%; background: var(--good); border-radius: 4px; }
  .ydp.under i em { background: var(--silver); opacity: 0.6; }
  .ydk-row { display: grid; grid-template-columns: repeat(auto-fit, minmax(76px, 1fr)); gap: 0.5rem; }
  .ydk { border: 1px solid var(--border); border-radius: 10px; padding: 0.65rem 0.4rem; text-align: center; display: flex; flex-direction: column; align-items: center; gap: 0.25rem; background: var(--surface0); }
  .ydk-ic svg { width: 22px; height: 22px; color: var(--silver); }
  .ydk b { font-family: var(--font-d); font-size: 1.4rem; color: var(--text-strong); line-height: 1.1; }
  .ydk > span:last-child { font-size: 0.66rem; letter-spacing: 0.07em; text-transform: uppercase; color: var(--silver); line-height: 1.2; }
  .ydm-grid { align-items: stretch; }
  .ydm-side { position: relative; padding: 0; min-height: 420px; }
  .ydm-side-in { position: absolute; inset: 0; padding: 1rem 1.1rem; display: flex; flex-direction: column; }
  .ydm-side-in .ydl { flex: 1; min-height: 0; grid-auto-rows: 1fr; }
  .ydm-side-in .ydl-row { padding-top: 0.2rem; padding-bottom: 0.2rem; }
  .ydl-help { margin: -0.3rem 0 0.8rem; font-size: 0.82rem; color: var(--muted); }
  .ydl-head, .ydl-row { display: grid; grid-template-columns: 1.25fr 0.9fr 1fr 1fr; align-items: center; }
  .ydl-head { padding: 0 0.8rem 0.35rem; font-size: 0.66rem; letter-spacing: 0.1em; text-transform: uppercase; color: var(--muted); }
  .ydl-head span:nth-child(n+2) { text-align: right; }
  .ydl-head span:nth-child(2) { text-align: center; }
  .ydl { display: grid; gap: 0.38rem; }
  .ydl-row { background: var(--surface0); border: 1px solid var(--border); border-radius: 8px; padding: 0.62rem 0.8rem; color: var(--text); font-family: var(--font-d); font-size: 1.02rem; cursor: pointer; position: relative; text-align: left; transition: border-color 0.12s, background 0.12s; }
  .ydl-ln small { margin-left: 0.4rem; font-size: 0.62rem; letter-spacing: 0.06em; text-transform: uppercase; color: var(--muted); font-weight: 600; }
  .ydl-un { text-align: right; color: var(--silver); font-size: 0.92rem; }
  .ydl-row:hover { border-color: var(--border2); }
  .ydl-row.on { border-color: var(--good); box-shadow: 0 0 0 1px var(--good) inset; background: color-mix(in srgb, var(--good) 8%, var(--surface0)); }
  .ydl-row.on::before { content: ''; position: absolute; left: -9px; top: 50%; transform: translateY(-50%); border: 7px solid transparent; border-left-color: var(--good); border-right: 0; }
  .ydl-ln { font-weight: 700; }
  .ydl-row.on .ydl-ln { color: var(--good); }
  .ydl-pc { color: var(--silver); text-align: center; }
  .ydl-od { text-align: right; font-weight: 700; }
  .ydm-tip { display: flex; align-items: center; gap: 0.7rem; margin-top: 1rem; padding: 0.7rem 1rem; border: 1px solid var(--border); border-radius: 10px; color: var(--silver); font-size: 0.92rem; }
  .ydm-tip svg { width: 22px; height: 22px; color: var(--gold); flex: none; }
  .ydl-mob-wrap { display: none; }
  .ydm-big strong small { font-size: 0.4em; margin-left: 0.15rem; color: var(--muted); }
  .ydm-panel.iv { display: grid; gap: 1.2rem; }
  .lcb { fill: var(--silver); opacity: 0.35; }
  .lcb.over { fill: var(--good); opacity: 0.85; }
  .pl-tiles .ydk b { font-size: 1.35rem; }
  .pl-tiles .ydk .pl-lbl { font-size: 0.66rem; letter-spacing: 0.07em; text-transform: uppercase; color: var(--silver); line-height: 1.2; }
  @media (max-width: 860px) {
    .ydm-grid { grid-template-columns: minmax(0, 1fr); }
    .ydm-side { display: none; }
    .ydl-mob-wrap { display: block; margin: 0.7rem -0.8rem -0.2rem; }
    .ydl.ydl-mob { display: flex; gap: 0.4rem; overflow-x: auto; scroll-snap-type: x proximity; padding: 0.1rem 0.8rem 0.35rem; -webkit-overflow-scrolling: touch; scrollbar-width: none; }
    .ydl.ydl-mob::-webkit-scrollbar { display: none; }
    .ydl-mob .ydl-row { flex: 0 0 4.3rem; display: grid; grid-template-columns: 1fr; justify-items: center; gap: 0; padding: 0.32rem 0.2rem 0.3rem; border-radius: 8px; text-align: center; scroll-snap-align: center; font-size: 0.9rem; }
    .ydl-mob .ydl-row.on::before { display: none; }
    .ydl-mob .ydl-ln { font-size: 0.98rem; line-height: 1.15; }
    .ydl-mob .ydl-ln small { display: none; }
    .ydl-mob .ydl-row.on .ydl-ln::after { content: ''; }
    .ydl-mob .ydl-pc { display: none; }
    .ydl-mob .ydl-od { font-size: 0.82rem; line-height: 1.2; text-align: center; }
    .ydl-mob .ydl-un { font-size: 0.7rem; line-height: 1.15; text-align: center; }
    .ydl-mob .ydl-od::before { content: 'o '; color: var(--muted); font-weight: 400; }
    .ydl-mob .ydl-un::before { content: 'u '; color: var(--muted); }
  }
  @media (max-width: 620px) {
    .pm.ydm { padding: 1rem 0.8rem 0.9rem; }
    .ydm-hero { grid-template-columns: auto minmax(0, 1fr); padding-right: 1.6rem; gap: 0.8rem; }
    .ydm-hero .rc-photo { width: 64px; height: 64px; }
    .ydm-big { grid-column: 1 / -1; border-left: none; padding-left: 0; justify-content: space-between; }
    .ydm-chart-row { grid-template-columns: minmax(0, 1fr); }
    .ydm-probs { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); }
    .ydp { padding: 0.65rem 0.7rem; }
    .ydp b { font-size: 1.45rem; }
    .ydp span { font-size: 0.64rem; }
    .ydp + .ydp { border-top: none; border-left: 1px solid var(--border); }
    .ydk-row { grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 0.4rem; }
    .ydk { padding: 0.55rem 0.2rem; min-width: 0; }
    .ydk b { font-size: 1.15rem; }
    .ydk > span:last-child { font-size: 0.58rem; }
    .ydm-panel { padding: 0.85rem 0.8rem; min-width: 0; }
    .ydm-id h2 { font-size: 1.35rem; }
    .ydm-meta { font-size: 0.9rem; }
    .ydm-big strong { font-size: 2.4rem; }
    .ydl-row { padding: 0.5rem 0.65rem; font-size: 0.95rem; }
    .ydm-tip { font-size: 0.85rem; padding: 0.6rem 0.75rem; }
    .pm.plm .ydm-hero { grid-template-columns: auto minmax(0, 1fr) auto; gap: 0.6rem; padding: 0 1.5rem 0.5rem 0; margin-bottom: 0.55rem; }
    .pm.plm .ydm-hero .rc-photo { width: 50px; height: 50px; }
    .pm.plm .ydm-id h2 { font-size: 1.15rem; }
    .pm.plm .ydm-meta { font-size: 0.78rem; gap: 0.3rem; }
    .pm.plm .ydm-meta img { width: 16px; height: 16px; margin-left: 0; }
    .pm.plm .ydm-big { grid-column: auto; padding: 0; border: none; }
    .pm.plm .ydm-big div { display: none; }
    .pm.plm .ydm-big strong { font-size: 1.7rem; }
  }
`;
  // Injected at load (from <head>), so each page's own <style> still comes after
  // it and a page-specific tweak wins.
  if (!document.getElementById('lad-css')) document.head.insertAdjacentHTML('beforeend', `<style id="lad-css">${CSS}</style>`);

  /** P(count > L) from a pmf (index = count), kept off the 0/1 walls. */
  const over = (pmf, L) => Math.min(0.995, Math.max(0.005, pmf.reduce((a, v, k) => a + (k > L ? v : 0), 0)));

  /**
   * The distribution chart: a bar per count, the line marked, a median tag.
   *   unit      for the chart's label ("Distribution of shots")
   *   trimTail  drop a near-empty right tail (< 0.2% in total) instead of drawing it
   *   plus      the pmf's last bucket holds the whole tail: label it "N+"
   */
  function chart(pmf, line, { unit = '', trimTail = false, plus = true } = {}) {
    const W = 560, H = 270, Lm = 46, Rr = 14, T = 40, B = 34;
    // A saves curve has nothing below ~10; start the axis where the mass does.
    let k0 = 0;
    for (let c = 0; k0 < pmf.length - 1 && c + pmf[k0] < 0.002; k0++) c += pmf[k0];
    let kEnd = pmf.length - 1;
    if (trimTail) for (let c = 0; kEnd > k0 && c + pmf[kEnd] < 0.002; kEnd--) c += pmf[kEnd];
    const K = kEnd - k0, pct = pmf.slice(k0, kEnd + 1).map(v => v * 100);
    const tail = (k) => plus && k === K && kEnd === pmf.length - 1;
    const ymaxRaw = Math.max(...pct) * 1.15;
    const ystep = ymaxRaw > 40 ? 20 : ymaxRaw > 20 ? 10 : ymaxRaw > 8 ? 5 : 2;
    const ymax = Math.ceil(ymaxRaw / ystep) * ystep;
    const bw = (W - Lm - Rr) / (K + 1);
    const X = (k) => Lm + k * bw, Y = (y) => T + (1 - y / ymax) * (H - T - B);
    let cdf = pmf.slice(0, k0).reduce((a, v) => a + v, 0), med = 0;
    for (let k = 0; k <= K; k++) { cdf += pct[k] / 100; if (cdf >= 0.5) { med = k; break; } }
    let grid = '';
    for (let y = 0; y <= ymax + 1e-9; y += ystep)
      grid += `<line x1="${Lm}" x2="${W - Rr}" y1="${Y(y)}" y2="${Y(y)}" class="ydc-grid"/><text x="${Lm - 6}" y="${Y(y) + 4}" class="ydc-ax" text-anchor="end">${y}%</text>`;
    const every = K > 24 ? 5 : K > 12 ? 2 : 1;
    const bars = pct.map((v, k) => {
      const n = k + k0, x = X(k) + bw * 0.12, w = bw * 0.76;
      return `<rect x="${x.toFixed(1)}" y="${Y(v).toFixed(1)}" width="${w.toFixed(1)}" height="${(Y(0) - Y(v)).toFixed(1)}" rx="3" class="lcb${n > line ? ' over' : ''}"><title>${n}${tail(k) ? '+' : ''}: ${v.toFixed(1)}%</title></rect>`
        + (n % every === 0 ? `<text x="${(X(k) + bw / 2).toFixed(1)}" y="${H - 10}" class="ydc-ax" text-anchor="middle">${n}${tail(k) && K > 3 ? '+' : ''}</text>` : '');
    }).join('');
    const mx = X(med) + bw / 2, my = Y(pct[med]);
    // label at the foot of the line, on the side away from the median tag
    const lx = X(Math.floor(line) + 1 - k0), away = lx <= mx ? -1 : 1;
    const lineMark = `<line x1="${lx}" x2="${lx}" y1="${T}" y2="${H - B}" class="ydc-line"/><text x="${lx + away * 6}" y="${H - B - 8}" class="ydc-linelbl" text-anchor="${away < 0 ? 'end' : 'start'}">o${line}</text>`;
    return `<svg viewBox="0 0 ${W} ${H}" class="ydc" role="img" aria-label="Distribution of ${unit}">${grid}${bars}${lineMark}</svg>
    <div class="ydc-tag" style="left:${(mx / W * 100).toFixed(2)}%;top:${Math.max(0, (my / H * 100) - 3).toFixed(2)}%"><span>Median</span><b>${med + k0}</b></div>`;
  }

  /**
   * The over/under bars and the ladder of lines around his even-money line.
   *   line   the selected line;  pick  his closest-to-even line (tagged "even")
   *   range  [lowest, highest] line offered;  set  the page's line setter's name
   *   even   false on a market with fixed lines, where "even" means nothing
   */
  function side(pmf, { line: L, pick, range: [lo, hi], set = 'lcSetLine', even = true }) {
    const p = over(pmf, L);
    let first = Math.max(lo, pick - 3);
    const last = Math.min(hi, first + 7);
    first = Math.max(lo, last - 7);
    let rungs = []; for (let x = first; x <= last; x++) rungs.push(x);
    // counts are lumpy, so the window's edges can land on -700 / +5000 lines
    // nobody bets; drop anything past 97/3 unless it leaves under four
    const sane = rungs.filter(x => { const px = over(pmf, x); return (px > 0.03 && px < 0.97) || Math.abs(x - L) < 0.01; });
    if (sane.length >= 4) rungs = sane;
    const ladder = rungs.map(x => {
      const px = over(pmf, x), on = Math.abs(x - L) < 0.01;
      return `<button class="ydl-row${on ? ' on' : ''}" onclick="${set}(${x})" aria-pressed="${on}">
      <span class="ydl-ln">${x}${even && Math.abs(x - pick) < 0.01 ? '<small>even</small>' : ''}</span>
      <span class="ydl-pc">${Math.round(px * 100)}%</span>
      <span class="ydl-od ${px >= 0.5 ? 'odfav' : 'oddog'}">${Odds.am(px)}</span>
      <span class="ydl-un">${Odds.am(1 - px)}</span></button>`;
    }).join('');
    return {
      probs: `<div class="ydp"><span>Probability of going over ${L}</span><b>${Math.round(p * 100)}%</b><i><em style="width:${(p * 100).toFixed(1)}%"></em></i></div>
            <div class="ydp under"><span>Probability of going under ${L}</span><b>${Math.round((1 - p) * 100)}%</b><i><em style="width:${((1 - p) * 100).toFixed(1)}%"></em></i></div>`,
      ladder,
    };
  }

  /** Scroll the phone's sideways ladder so the selected line sits in the middle. */
  function center(id = 'lc-ladder-m') {
    const box = document.getElementById(id), on = box?.querySelector('.ydl-row.on');
    if (!box || !on || box.scrollWidth <= box.clientWidth) return;
    box.scrollLeft = on.offsetLeft - box.offsetLeft - (box.clientWidth - on.offsetWidth) / 2;
  }

  window.RonLadder = { over, chart, side, center };
})();
