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
