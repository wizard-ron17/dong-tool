// Ron's Tools status: one read-only health view for the whole site, on every page.
//
// Open it with ?status in any app's URL, by tapping a board's "Updated ... ago", or RonStatus.open().
// chrome.js loads this file on first use. Everything comes from public sources (no keys,
// no actions), straight from GitHub, so it tells the truth even when the page's own data is stale:
//   - each sport's data: when the site's <sport>/data.json was built (its first bytes, from raw GitHub);
//   - each build workflow: its last runs, and how many of its scheduled runs in the last 24h
//     GitHub actually started (it drops and delays crons: 11/1 skipped every NFL run from
//     05:50 to 16:32 UTC). The crons are read from the workflow file itself, so this never drifts;
//   - this page: what its own data says (age, games left), plus anything the page adds by
//     defining window.ronStatusPage = () => html (built with RonStatus.row / RonStatus.sec).
// GitHub allows 60 unauthenticated API calls an hour per IP; one look costs 7, cached 3 minutes.
(function () {
  const REPO = 'wizard-ron17/dong-tool', API = `https://api.github.com/repos/${REPO}`;
  const RAW = `https://raw.githubusercontent.com/${REPO}/main`;
  // [sport, workflow file, label]: every workflow that writes a sport's data
  const WF = [
    ['mlb', 'build-data.yml', 'MLB build'],
    ['nfl', 'build-nfl.yml', 'NFL build'], ['nfl', 'watch-nfl.yml', 'NFL game-day watch'],
    ['nhl', 'build-nhl.yml', 'NHL build'],
    ['nba', 'build-nba.yml', 'NBA build'], ['nba', 'watch-nba.yml', 'NBA lineup watch'],
    ['soccer', 'build-soccer.yml', 'MLS build'],
  ];
  const SPORT = { mlb: 'MLB', nfl: 'NFL', nhl: 'NHL', nba: 'NBA', soccer: 'MLS' };
  const CACHE = 'ron-status-v1', TTL = 3 * 60e3;

  const CSS = `
  .sys.pm { max-width: 560px; padding: 1.1rem 1.2rem 1.2rem; }
  .sys-title { margin: 0 1.6rem 0.2rem 0; color: var(--text-strong); font: 700 0.95rem var(--font-d); letter-spacing: 0.06em; text-transform: uppercase; }
  .sys-sub { color: var(--dim); font-size: 0.72rem; margin-bottom: 0.4rem; }
  .sys-sec { margin: 0.9rem 0 0.25rem; padding-bottom: 0.2rem; border-bottom: 1px solid var(--border); color: var(--dim); font: 700 0.64rem var(--font-d); letter-spacing: 0.1em; text-transform: uppercase; }
  .sys-row { display: flex; align-items: center; gap: 0.5rem; padding: 0.22rem 0; flex-wrap: wrap; font-size: 0.8rem; }
  .sys-dot { width: 8px; height: 8px; border-radius: 50%; flex: none; background: var(--border2); }
  .sys-ok { background: var(--green); } .sys-warn { background: var(--gold); } .sys-bad { background: var(--bad); }
  .sys-label { color: var(--muted); }
  .sys-label a { color: inherit; text-decoration: none; border-bottom: 1px dotted var(--border2); }
  .sys-label a:hover { color: var(--accent); }
  .sys-val { margin-left: auto; color: var(--text-strong); font-weight: 700; font-variant-numeric: tabular-nums; text-align: right; }
  .sys-note { flex-basis: 100%; padding-left: calc(8px + 0.5rem); color: var(--dim); font-size: 0.7rem; line-height: 1.45; }
  .sys-note b { color: var(--text); font-weight: 700; }
  .sys-miss { color: var(--gold); }
  .sys-foot { margin-top: 0.9rem; display: flex; gap: 0.5rem; flex-wrap: wrap; align-items: center; }
  .sys-btn { padding: 0.35rem 0.75rem; border: 1px solid var(--border2); border-radius: 8px; background: var(--surface2); color: var(--text); font: 600 0.74rem var(--font-b); cursor: pointer; text-decoration: none; }
  .sys-btn:hover { border-color: var(--accent); color: var(--accent); }
  .sys-foot small { margin-left: auto; color: var(--dim); font-size: 0.66rem; }
  .sys-wait { color: var(--dim); font-size: 0.78rem; padding: 0.5rem 0; }
  `;
  const st = document.createElement('style'); st.textContent = CSS; document.head.appendChild(st);

  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  function ago(t) {
    if (!t) return '—';
    const m = Math.floor((Date.now() - t) / 60000);
    if (m < 1) return 'just now';
    if (m < 60) return m + 'm ago';
    if (m < 48 * 60) return Math.floor(m / 60) + 'h' + (m < 6 * 60 && m % 60 ? ' ' + (m % 60) + 'm' : '') + ' ago';
    return Math.floor(m / 1440) + 'd ago';
  }
  const clock = (t) => new Date(t).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' });
  const row = (label, val, state = '', note = '') =>
    `<div class="sys-row"><span class="sys-dot${state ? ' sys-' + state : ''}"></span><span class="sys-label">${label}</span><span class="sys-val">${val}</span>${note ? `<div class="sys-note">${note}</div>` : ''}</div>`;
  const sec = (t) => `<div class="sys-sec">${t}</div>`;

  // ── Cron: which minutes a schedule fires on (UTC, GitHub's clock) ──
  function field(s, lo, hi) {
    const out = new Set();
    for (const part of s.split(',')) {
      const [r, step = '1'] = part.split('/');
      let [a, b] = r === '*' ? [lo, hi] : r.split('-').map(Number);
      if (b == null) b = part.includes('/') ? hi : a;
      for (let x = a; x <= b; x += +step) out.add(x);
    }
    return out;
  }
  function cron(expr) {
    const [m, h, dom, mon, dow] = expr.trim().split(/\s+/);
    const M = field(m, 0, 59), H = field(h, 0, 23), D = field(dom, 1, 31), MO = field(mon, 1, 12);
    const W = new Set([...field(dow, 0, 7)].map(x => x % 7));
    const anyD = dom === '*', anyW = dow === '*';
    return (d) => M.has(d.getUTCMinutes()) && H.has(d.getUTCHours()) && MO.has(d.getUTCMonth() + 1) &&
      (anyD || anyW ? (D.has(d.getUTCDate()) && W.has(d.getUTCDay())) : (D.has(d.getUTCDate()) || W.has(d.getUTCDay())));
  }
  // scheduled fire times in [from, to), every cron line in the file
  function fires(yaml, from, to) {
    const tests = [...yaml.matchAll(/^\s*-\s*cron:\s*['"]([^'"]+)['"]/gm)].map(x => cron(x[1]));
    const out = [];
    for (let t = Math.ceil(from / 60e3) * 60e3; t < to; t += 60e3) { const d = new Date(t); if (tests.some(f => f(d))) out.push(t); }
    return out;
  }
  // GitHub starts a cron late (often 5-60 minutes) or never. A slot counts as started if a
  // scheduled run was created within 90 minutes after it, each run claiming one slot.
  function matchFires(slots, runs) {
    const starts = runs.filter(r => r.event === 'schedule').map(r => Date.parse(r.created_at)).sort((a, b) => a - b);
    const used = new Set(), missed = [];
    for (const s of slots) {
      const i = starts.findIndex((t, k) => !used.has(k) && t >= s - 2 * 60e3 && t < s + 90 * 60e3);
      if (i < 0) missed.push(s); else used.add(i);
    }
    return missed;
  }

  // ── Fetch (cached a few minutes: the API limit is per IP) ──
  async function getJson(u) {
    const r = await fetch(u, { cache: 'no-store' });
    if (r.status === 403 || r.status === 429) throw new Error('GitHub rate limit (60 an hour); try again shortly');
    if (r.status === 404) return null;
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.json();
  }
  // a data file's build time: its first key, from the first bytes only (Range where honoured, and the
  // stream is cancelled either way, so a 2MB file never downloads). Raw files don't count against the API limit.
  async function builtAt(sp) {
    try {
      const r = await fetch(`${RAW}/${sp}/data.json`, { cache: 'no-store', headers: { Range: 'bytes=0-299' } });
      if (!r.ok || !r.body) return null;
      const rd = r.body.getReader(), { value } = await rd.read(); rd.cancel().catch(() => {});
      const m = new TextDecoder().decode(value || new Uint8Array()).match(/"(?:generatedAt|generated)"\s*:\s*"([^"]+)"/);
      return m ? m[1] : null;
    } catch { return null; }
  }
  async function load(force) {
    if (!force) {
      try { const c = JSON.parse(localStorage.getItem(CACHE) || 'null'); if (c && Date.now() - c.at < TTL) return c; } catch {}
    }
    const since = new Date(Date.now() - 26 * 3600e3).toISOString();
    const [built, flows] = await Promise.all([
      Promise.all(Object.keys(SPORT).map(sp => builtAt(sp).then(t => [sp, t]))),
      Promise.all(WF.map(([sp, file]) => Promise.all([
        getJson(`${API}/actions/workflows/${file}/runs?per_page=60&created=>=${since}`),
        fetch(`${RAW}/.github/workflows/${file}`, { cache: 'no-store' }).then(r => r.ok ? r.text() : ''),
      ]).then(([j, yaml]) => ({ file, runs: (j?.workflow_runs || []).map(r => ({ event: r.event, status: r.status, conclusion: r.conclusion,
        created_at: r.created_at })), yaml, gone: !j })))),
    ]);
    const c = { at: Date.now(), data: Object.fromEntries(built), flows: Object.fromEntries(flows.map(f => [f.file, f])) };
    try { localStorage.setItem(CACHE, JSON.stringify(c)); } catch {}
    return c;
  }

  // ── Render ──
  function pageHtml() {
    const sp = RonChrome.cfg?.()?.sport, F = RonChrome.freshInfo?.();
    let h = '';
    if (F) {
      const now = Date.now(), ageM = (now - F.t) / 60000;
      const live = F.starts.filter(s => s <= now && s > now - 4 * 3600e3).length, pre = F.starts.filter(s => s > now).sort((a, b) => a - b);
      const around = live || (pre[0] && pre[0] - now < 6 * 3600e3);
      const state = !around ? (ageM > 26 * 60 ? 'warn' : 'ok') : ageM > 270 ? 'bad' : ageM > 90 ? 'warn' : 'ok';
      h += row('Data this page loaded', ago(F.t), state, `built ${clock(F.t)}${state !== 'ok' && around ? ' · games are on, so it should be fresher: see the build rows below' : ''}`);
      const day = pre.filter(s => s - now < 24 * 3600e3).length;
      h += row('Games', `${live} live · ${day} in the next 24h`, live || day ? 'ok' : '', pre[0] ? `next ${clock(pre[0])}` : '');
    } else h += row('Data this page loaded', 'not loaded yet', 'warn');
    if (typeof window.ronStatusPage === 'function') { try { h += window.ronStatusPage(); } catch (e) { h += row('Page checks', 'error', 'bad', esc(e.message)); } }
    return sec(`This page${sp ? ' · ' + (SPORT[sp] || sp.toUpperCase()) : ''}`) + h;
  }
  function siteHtml(c) {
    const now = Date.now(), here = RonChrome.cfg?.()?.sport;
    const order = Object.keys(SPORT).sort((a, b) => (b === here) - (a === here));
    let h = '';
    for (const sp of order) {
      const dt = c.data[sp] ? Date.parse(c.data[sp]) : null;
      h += sec(SPORT[sp]);
      // green inside the stale banner's 4.5h; older is normal overnight, off days and offseason, so only amber
      h += row('Data on the site', ago(dt), !dt || now - dt > 270 * 60e3 ? 'warn' : 'ok', dt ? `built ${clock(dt)}` : "couldn't read its build time");
      for (const [s, file, label] of WF) {
        if (s !== sp) continue;
        const f = c.flows[file]; if (!f || f.gone) continue;
        const runs = f.runs, last = runs[0], lastOk = runs.find(r => r.conclusion === 'success');
        const slots = fires(f.yaml, now - 24 * 3600e3, now - 90 * 60e3);
        const missed = matchFires(slots, runs);
        const running = runs.find(r => r.status === 'in_progress' || r.status === 'queued');
        const failed = last && last.conclusion === 'failure';
        const missFrac = slots.length ? missed.length / slots.length : 0;
        const state = failed ? 'bad' : missFrac >= 0.5 ? 'warn' : runs.length || !slots.length ? 'ok' : 'warn';
        const val = running ? 'running now' : last ? `${last.event === 'schedule' ? 'cron' : last.event === 'workflow_dispatch' ? 'manual' : last.event} ${ago(Date.parse(last.created_at))}` : 'no runs in 24h';
        const bits = [];
        if (failed) bits.push(`<b>last run failed</b>`);
        if (lastOk && lastOk !== last) bits.push(`last success ${ago(Date.parse(lastOk.created_at))}`);
        if (slots.length) bits.push(`scheduled runs started (24h): <b>${slots.length - missed.length} of ${slots.length}</b>`);
        else bits.push('no scheduled runs due in the last 24h');
        if (missed.length) {
          const last3 = missed.slice(-3).map(t => new Date(t).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }));
          bits.push(`<span class="sys-miss">GitHub skipped ${missed.length}${missed.length > 3 ? `, latest ${last3.join(', ')}` : `: ${last3.join(', ')}`}</span>`);
        }
        const link = `https://github.com/${REPO}/actions/workflows/${file}`;
        h += row(`<a href="${link}" target="_blank" rel="noopener">${label} ↗</a>`, val, state, bits.join(' · '));
      }
    }
    return h;
  }
  async function paint(force) {
    const dlg = document.querySelector('#sys-back .sys'); if (!dlg) return;
    const body = dlg.querySelector('.sys-body');
    body.innerHTML = pageHtml() + sec('Site') + '<div class="sys-wait">Asking GitHub…</div>';
    try {
      const c = await load(force);
      if (!document.getElementById('sys-back')) return;
      body.innerHTML = pageHtml() + siteHtml(c);
      dlg.querySelector('.sys-sub').textContent = `Checked ${ago(c.at)} · times in your timezone · GitHub's crons run on UTC`;
    } catch (e) {
      body.innerHTML = pageHtml() + sec('Site') + row('GitHub', 'unavailable', 'warn', esc(e.message));
      dlg.querySelector('.sys-sub').textContent = 'Times in your timezone';
    }
  }
  function open() {
    const dlg = RonModal.open('sys-back', { cls: 'pm sys', label: 'Site status' });
    dlg.innerHTML = `<button class="pm-x" onclick="RonModal.close('sys-back')" aria-label="Close">&times;</button>
      <div class="sys-title">Status</div>
      <div class="sys-sub">Checking…</div>
      <div class="sys-body"></div>
      <div class="sys-foot">
        <button class="sys-btn" onclick="RonStatus.refresh()">↻ Check again</button>
        <a class="sys-btn" href="https://github.com/${REPO}/actions" target="_blank" rel="noopener">All builds ↗</a>
        <small>read-only · <code>?status</code></small>
      </div>`;
    paint(false);
  }
  window.RonStatus = { open, refresh: () => paint(true), row, sec, ago, _fires: fires, _match: matchFires };
})();
