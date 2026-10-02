// Ron's Tools share cards: any board's top 10 as an image, drawn once here.
//
// The Compact view was the screenshot view; this replaces it. A board says
// what its card holds each time it renders, keyed by its toolbar's setter, and
// the toolbar's Share button (board.js uiView) opens it:
//
//   RonShare.set('setRc', () => ({
//     title: 'Receptions', sub: 'Week 4 · best line, fair odds',
//     rows: rows.map(r => ({ name, img, logo, line: 'CIN vs JAX · 6.3 proj', p: r.p, tag: 'o5.5' })),
//   }));
//   RonShare.open('setRc')        // what the Share button does
//
// rows: name, line (the small second line), p (the price, printed through
// Odds.am), tag (the line, e.g. "o5.5" or "Yes"), img (headshot URL), logo
// (team logo URL). A board without prices (Fantasy) passes big / small text
// instead of p. spec.text, if given, is the board's own "Copy as text". Only the first ten draw; text() lists the same ten.
// Pictures load cross-origin; one that won't (or would taint the canvas) is
// skipped rather than breaking the image.
(function () {
  const CSS = `
  .rsc-btn { display: inline-flex; align-items: center; gap: 0.32rem; background: var(--surface1); border: 1px solid var(--border2); color: var(--text); font-family: var(--font-b); font-size: 0.717rem; font-weight: 700; letter-spacing: 0.04em; text-transform: uppercase; padding: 0.34rem 0.66rem; border-radius: 7px; cursor: pointer; }
  .rsc-btn:hover { border-color: var(--accent); color: var(--accent); }
  .rsc-modal { max-width: 640px; padding: 1.1rem 1.1rem 1rem; }
  .rsc-img { display: block; width: 100%; border-radius: 10px; background: #070b14; min-height: 120px; }
  .rsc-acts { display: flex; flex-wrap: wrap; gap: 0.45rem; margin-top: 0.8rem; justify-content: center; }
  .rsc-act { background: var(--accent); color: #04170f; border: 1px solid var(--accent); border-radius: 8px; padding: 0.45rem 0.8rem; font: 700 0.78rem var(--font-b); cursor: pointer; }
  .rsc-act.alt { background: none; color: var(--text); border-color: var(--border2); }
  .rsc-note { margin-top: 0.6rem; text-align: center; color: var(--muted); font-size: 0.76rem; }
`;
  if (!document.getElementById('rsc-css')) document.head.insertAdjacentHTML('beforeend', `<style id="rsc-css">${CSS}</style>`);

  const C = { bg: '#070b14', card: '#0e1626', line: '#1c2740', text: '#eef3fb', muted: '#8d9bb2', dim: '#5d6b84' };
  const APP = (location.pathname.split('/')[1] || '').toLowerCase();
  const BRAND = { mlb: "Ron's Dong Tool", nfl: "Ron's Tud Tool", nhl: "Ron's Goal Tool", nba: "Ron's Hoop Tool" }[APP] || "Ron's Tools";
  const specs = {};
  let blob = null, cur = null;

  const accent = () => (getComputedStyle(document.documentElement).getPropertyValue('--accent') || '#35c96e').trim() || '#35c96e';
  const amOf = (p) => window.Odds ? Odds.am(p) : (p >= 0.5 ? '-' + Math.round(100 * p / (1 - p)) : '+' + Math.round(100 * (1 - p) / p));
  const pctOf = (p) => (p * 100).toFixed(p < 0.1 ? 1 : 0) + '%';
  function loadImg(src) {
    return new Promise(res => {
      if (!src) return res(null);
      const im = new Image(); im.crossOrigin = 'anonymous';
      const t = setTimeout(() => res(null), 5000);
      // a picture whose server doesn't allow cross-origin use would taint the canvas and
      // block the export: test it on a scrap canvas and leave just that one out
      im.onload = () => { clearTimeout(t);
        try { const c = document.createElement('canvas'); c.width = c.height = 1; const g = c.getContext('2d'); g.drawImage(im, 0, 0, 1, 1); g.getImageData(0, 0, 1, 1); res(im); }
        catch (e) { res(null); } };
      im.onerror = () => { clearTimeout(t); res(null); };
      im.src = src;
    });
  }
  const get = (key) => { const s = specs[key]; try { return typeof s === 'function' ? s() : s; } catch (e) { console.error(e); return null; } };

  async function draw(spec, withImages) {
    const rows = (spec.rows || []).filter(r => r && (r.p > 0 || r.big)).slice(0, 10);
    const W = 900, PAD = 32, ROW = 64, HEAD = 118, FOOT = 64;
    const H = HEAD + Math.max(rows.length, 1) * ROW + FOOT;
    const cv = document.createElement('canvas'); cv.width = W * 2; cv.height = H * 2;
    const x = cv.getContext('2d'); x.scale(2, 2);
    await document.fonts?.ready;
    const F = (w, px, d) => `${w} ${px}px ${d ? "'Chakra Petch'" : "'Plus Jakarta Sans'"}, sans-serif`;
    const acc = accent();
    x.fillStyle = C.bg; x.fillRect(0, 0, W, H);
    x.textBaseline = 'alphabetic';
    x.fillStyle = C.text; x.font = F(700, 34, true); x.fillText(spec.title || 'Board', PAD, 58);
    x.fillStyle = C.muted; x.font = F(600, 17); x.fillText(spec.sub || '', PAD, 88);
    x.textAlign = 'right'; x.fillStyle = acc; x.font = F(700, 22, true); x.fillText(BRAND, W - PAD, 58);
    x.fillStyle = C.dim; x.font = F(500, 14); x.fillText('fair odds · no vig', W - PAD, 86); x.textAlign = 'left';
    const imgs = new Map();
    if (withImages) await Promise.all(rows.flatMap((r, i) => [loadImg(r.img).then(im => imgs.set('p' + i, im)), loadImg(r.logo).then(im => imgs.set('t' + i, im))]));
    rows.forEach((r, i) => {
      const y = HEAD + i * ROW;
      x.fillStyle = C.card; x.beginPath(); x.roundRect(PAD, y, W - PAD * 2, ROW - 8, 10); x.fill();
      x.fillStyle = i < 3 ? C.text : C.dim; x.font = F(700, 19, true); x.textAlign = 'center'; x.fillText(String(i + 1), PAD + 22, y + 35); x.textAlign = 'left';
      const ph = imgs.get('p' + i), px0 = PAD + 44, py0 = y + 6, ps = 44;
      x.save(); x.beginPath(); x.arc(px0 + ps / 2, py0 + ps / 2, ps / 2, 0, Math.PI * 2); x.fillStyle = C.line; x.fill(); x.clip();
      if (ph) { const w = ph.naturalWidth, h = ph.naturalHeight, side = Math.min(w, h); x.drawImage(ph, (w - side) / 2, Math.min(h - side, h * 0.06), side, side, px0, py0, ps, ps); }
      x.restore();
      const nx = px0 + ps + 14, maxName = W - PAD - nx - 190;
      x.fillStyle = C.text; x.font = F(700, 19);
      let nm = r.name || ''; while (x.measureText(nm).width > maxName && nm.length > 4) nm = nm.slice(0, -2);
      x.fillText(nm === r.name ? nm : nm.trimEnd() + '…', nx, y + 27);
      const lg = imgs.get('t' + i);
      if (lg) x.drawImage(lg, nx, y + 34, 15, 15);
      x.fillStyle = C.muted; x.font = F(500, 13.5);
      x.fillText(r.line || '', nx + (lg ? 20 : 0), y + 46);
      x.textAlign = 'right';
      x.fillStyle = r.p >= 0.5 ? acc : C.text; x.font = F(700, 24, true); x.fillText(r.big ?? amOf(r.p), W - PAD - 16, y + 31);
      x.fillStyle = C.dim; x.font = F(600, 12); x.fillText(r.small ?? `${r.tag ? r.tag + ' · ' : ''}${pctOf(r.p)}`, W - PAD - 16, y + 48);
      x.textAlign = 'left';
    });
    if (!rows.length) { x.fillStyle = C.muted; x.font = F(500, 18); x.fillText('Nothing on this board right now.', PAD, HEAD + 34); }
    x.fillStyle = C.line; x.fillRect(PAD, H - 48, W - PAD * 2, 1);
    x.fillStyle = C.dim; x.font = F(500, 13); x.fillText(spec.foot || 'Fair odds from our own backtested models. A book always prices worse.', PAD, H - 22);
    x.textAlign = 'right'; x.fillStyle = C.muted; x.font = F(700, 14, true); x.fillText(`dong-tool.netlify.app/${APP}`, W - PAD, H - 22); x.textAlign = 'left';
    return new Promise((res, rej) => { try { cv.toBlob(b => b ? res(b) : rej(new Error('empty')), 'image/png'); } catch (e) { rej(e); } });
  }

  function text(spec) {
    const rows = (spec.rows || []).filter(r => r && (r.p > 0 || r.big)).slice(0, 10);
    return [`${BRAND} — ${spec.title}${spec.sub ? ' · ' + spec.sub : ''}`, '',
      ...rows.map((r, i) => `${i + 1}. ${r.name}${r.tag ? ' ' + r.tag : ''} — ${r.p > 0 ? 'fair ' + (window.Odds ? Odds.both(r.p) : amOf(r.p)) : `${r.big}${r.small ? ' ' + r.small : ''}`}${r.line ? ' · ' + r.line : ''}`),
      '', `dong-tool.netlify.app/${APP}`].join('\n');
  }
  const fileName = (spec) => `${APP}-${String(spec.title || 'board').toLowerCase().replace(/[^a-z0-9]+/g, '-')}.png`;
  const say = (t) => { const n = document.getElementById('rsc-note'); if (n) n.textContent = t; };

  async function open(key) {
    const spec = get(key) || { title: 'Board', rows: [] };
    cur = spec; blob = null;
    const dlg = window.RonModal ? RonModal.open('rsc-back', { cls: 'pm rsc-modal', label: 'Share card' }) : null;
    if (!dlg) return;
    dlg.innerHTML = `<button class="pm-x" onclick="RonModal.close('rsc-back')" aria-label="Close">×</button>
      <img class="rsc-img" id="rsc-img" alt="${(spec.title || 'Board').replace(/"/g, '&quot;')}, top 10">
      <div class="rsc-acts">
        <button class="rsc-act" onclick="RonShare.copy()">Copy image</button>
        <button class="rsc-act alt" onclick="RonShare.save()">Save PNG</button>
        ${navigator.canShare ? '<button class="rsc-act alt" onclick="RonShare.share()">Share…</button>' : ''}
        <button class="rsc-act alt" onclick="RonShare.copyText()">Copy as text</button>
      </div>
      <div class="rsc-note" id="rsc-note">Drawing…</div>`;
    try { blob = await draw(spec, true); } catch (e) { blob = await draw(spec, false).catch(() => null); }   // a picture that won't export: draw without them
    const img = document.getElementById('rsc-img');
    if (!img) return;
    if (!blob) { say("Couldn't draw the image."); return; }
    img.src = URL.createObjectURL(blob);
    say('Copy it and paste straight into Discord, or long-press the image on a phone.');
  }
  async function copy() {
    if (!blob) return;
    try { await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]); say('Copied. Paste it anywhere.'); }
    catch (e) { say('This browser won’t copy images: use Save PNG (or long-press the image).'); }
  }
  function save() {
    if (!blob) return;
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = fileName(cur); a.click();
  }
  async function share() {
    if (!blob) return;
    const f = new File([blob], fileName(cur), { type: 'image/png' });
    try { if (navigator.canShare?.({ files: [f] })) await navigator.share({ files: [f], title: cur.title }); else save(); } catch (e) { /* cancelled */ }
  }
  async function copyText() {
    if (typeof cur.text === 'function') return cur.text();   // a board with its own text share
    try { await navigator.clipboard.writeText(text(cur)); say('Copied as text.'); } catch (e) { window.prompt('Copy this:', text(cur)); }
  }
  /** The toolbar button. */
  const button = (key) => `<button class="rsc-btn" onclick="RonShare.open('${key}')" title="The board's top 10 as an image to share">↗ Share</button>`;

  window.RonShare = { set: (key, spec) => { specs[key] = spec; }, open, button, copy, save, share, copyText, draw, text };
})();
