// Ron's Tools data loading, shared by every app.
//
// Data files come straight from the repo (raw.githubusercontent.com: CORS-open,
// gzipped, CDN-cached 5 min), so the builds' hourly data commits don't have to
// redeploy the site: netlify.toml skips any commit that only touches data.
// Falls back to the deployed copy if GitHub is unreachable. Local dev reads the
// local file first (so a local build is what you see), and the repo's when
// there's no local copy.
//
//   dataFetch('data.json')   // /<sport>/data.json for whichever app this is
(function () {
  const APP = '/' + (location.pathname.split('/')[1] || '');
  const RAW = 'https://raw.githubusercontent.com/wizard-ron17/dong-tool/main';
  const local = /^(localhost|127\.0\.0\.1)$/.test(location.hostname);
  const ok = (r) => r.ok ? r : Promise.reject(r);
  function dataFetch(f, opts) {
    const p = `${APP}/${f}`;
    return local
      ? fetch(p, opts).then(ok).catch(() => fetch(RAW + p, opts))
      : fetch(RAW + p, opts).then(ok).catch(() => fetch(p, opts));
  }
  window.dataFetch = dataFetch;
  window.RonData = { fetch: dataFetch, RAW };
})();

// Typing focus. Boards redraw on every keystroke (the search box is part of
// the markup they rebuild), which threw you out of the box after one letter on
// most tools; a few re-focused it by hand, most didn't. This keeps it for every
// box at once: after an input event, if the box you were typing in was
// replaced, focus moves to its replacement (same id) with the cursor where it
// was. Checked again on the next frames for boards that redraw a beat later.
(function () {
  let last = null;
  function restore() {
    if (!last) return;
    const { el, id, s, e } = last;
    if (el.isConnected && document.activeElement === el) return;            // still there, nothing to do
    const a = document.activeElement;
    if (a && a !== document.body && a !== el && a.isConnected) return;       // you moved on to something else
    const nx = document.getElementById(id);
    if (!nx || nx === el || !('value' in nx)) return;
    nx.focus({ preventScroll: true });
    try { if (s != null) nx.setSelectionRange(s, e); } catch (err) { /* number inputs have no caret */ }
    last = { el: nx, id, s, e };
  }
  document.addEventListener('input', (ev) => {
    const t = ev.target;
    if (!t || !t.id || !/^(INPUT|TEXTAREA)$/.test(t.tagName)) return;
    let s = null, e = null; try { s = t.selectionStart; e = t.selectionEnd; } catch (err) {}
    last = { el: t, id: t.id, s, e };
    restore();                                        // redraw inside the handler (this runs after it)
    requestAnimationFrame(() => { restore(); setTimeout(restore, 60); setTimeout(restore, 400); });   // debounced redraws
  });
  // a tap or click anywhere but the box means you're done typing: never pull focus back
  document.addEventListener('pointerdown', (ev) => { if (!last || ev.target.id !== last.id) last = null; }, true);
})();
