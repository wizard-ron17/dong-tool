// Site analytics (Umami Cloud, Hobby plan: 100K events/month, 1 website).
//
// Every call below is an "event" against that quota — page views included — so
// nothing is tracked automatically. Umami's auto-tracking would count every URL
// change, and these apps rewrite the URL constantly (MLB puts each recap date
// and results sub-view in the path), which would burn the quota on noise.
//
// What IS sent:
//   page view   once per tool you land on (/nfl/receptions, /mlb/picks/results).
//               Recap dates, pair sizes etc. fold into their tool. Repeats of
//               the same tool in a row are dropped.
//   player      opened a player card          (≤3 per tool per visit)
//   video       opened a home-run clip        (≤2 per visit)
//   search      typed in a board's search     (once per tool per visit)
//   view        switched table/cards/compact  (once per tool per visit)
//   filter      touched a filter chip         (once per tool per visit)
//   results     opened a Results tab (NFL)    (once per tool per visit)
//   outbound    clicked a link off the site   (once per site per visit)
//   not-found   landed on the 404 page
//
// Hard ceilings, whatever happens:
//   PER_VISIT  events in one page load
//   PER_DAY    events from one browser in a calendar day
//   SAMPLE     share of browsers tracked at all. If the Umami usage page ever
//              heads toward 100K, lower this (0.5 = half of visitors) and push.
//
// Leave yourself out: open any page with ?notrack (undo with ?track). It sticks
// per browser, so do it once on each device.
(function () {
  var WEBSITE_ID = '22698219-82f8-448b-9d69-7fab56ffbf2d';
  var HOST = 'dong-tool.netlify.app';
  var SAMPLE = 1;
  var PER_VISIT = 25;
  var PER_DAY = 60;

  function store(k, v) {
    try { if (v === undefined) return localStorage.getItem(k); if (v === null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch (e) {}
    return null;
  }

  // ── opt out / back in ─────────────────────────────────────────────────────
  var qs = location.search;
  if (/[?&]notrack\b/.test(qs) || /[?&]track\b/.test(qs)) {
    var off = /[?&]notrack\b/.test(qs);
    store('ron.notrack', off ? '1' : null);
    store('umami.disabled', off ? '1' : null);
    var toast = function () {
      var t = document.createElement('div');
      t.textContent = off ? 'Analytics off on this device' : 'Analytics back on for this device';
      t.style.cssText = 'position:fixed;left:50%;bottom:24px;transform:translateX(-50%);z-index:99999;background:#131c30;color:#e8edf5;border:1px solid #33d07c;border-radius:10px;padding:10px 16px;font:600 14px -apple-system,BlinkMacSystemFont,sans-serif;box-shadow:0 8px 24px rgba(0,0,0,.4)';
      document.body.appendChild(t); setTimeout(function () { t.remove(); }, 3500);
    };
    if (document.body) toast(); else document.addEventListener('DOMContentLoaded', toast);
  }

  // Only the real site counts: no localhost, deploy previews or test runs.
  if (location.hostname !== HOST || store('ron.notrack') === '1') return;

  // Sampling is decided once per browser, so a visitor is either in or out.
  var bucket = store('ron.bucket');
  if (bucket === null) { bucket = String(Math.random()); store('ron.bucket', bucket); }
  if (Number(bucket) >= SAMPLE) return;

  // ── budget ────────────────────────────────────────────────────────────────
  var sentThisVisit = 0;
  var dayKey = 'ron.ev.' + new Date().toISOString().slice(0, 10);
  function allow() {
    if (sentThisVisit >= PER_VISIT) return false;
    var today = Number(store(dayKey) || 0);
    if (today >= PER_DAY) return false;
    sentThisVisit++;
    store(dayKey, String(today + 1));
    return true;
  }
  // Old day counters would pile up in storage forever; drop them.
  try { Object.keys(localStorage).forEach(function (k) { if (k.indexOf('ron.ev.') === 0 && k !== dayKey) localStorage.removeItem(k); }); } catch (e) {}

  // ── Umami, loaded with auto-tracking off ─────────────────────────────────
  var queue = [];
  function send(fn) {
    if (!allow()) return;
    if (window.umami && typeof window.umami.track === 'function') fn(window.umami); else queue.push(fn);
  }
  var s = document.createElement('script');
  s.defer = true;
  s.src = 'https://cloud.umami.is/script.js';
  s.setAttribute('data-website-id', WEBSITE_ID);
  s.setAttribute('data-auto-track', 'false');
  s.setAttribute('data-domains', HOST);
  s.onload = function () { var q = queue; queue = []; q.forEach(function (fn) { try { fn(window.umami); } catch (e) {} }); };
  document.head.appendChild(s);

  // ── page views: one per tool ──────────────────────────────────────────────
  var SUBS = { results: 1, reached: 1 };
  function toolPath() {
    var seg = location.pathname.split('/').filter(Boolean);
    if (!seg.length) return '/';
    if (seg[0] !== 'nfl' && seg[0] !== 'mlb') return '/' + seg[0];
    if (seg.length === 1) return '/' + seg[0] + '/';
    return '/' + seg[0] + '/' + seg[1] + (SUBS[seg[2]] ? '/' + seg[2] : '');
  }
  function toolName() { var seg = location.pathname.split('/').filter(Boolean); return (seg[0] || 'home') + (seg[1] ? '/' + seg[1] : ''); }

  var lastPath = null;
  function pageview() {
    if (window.RT_PAGE === '404') return;
    var p = toolPath();
    if (p === lastPath) return;
    lastPath = p;
    send(function (u) { u.track(function (props) { return Object.assign({}, props, { url: p }); }); });
  }

  if (window.RT_PAGE === '404') {
    send(function (u) { u.track('not-found', { path: location.pathname.slice(0, 120) }); });
  }

  ['pushState', 'replaceState'].forEach(function (m) {
    var orig = history[m];
    history[m] = function () { var r = orig.apply(this, arguments); setTimeout(pageview, 0); return r; };
  });
  window.addEventListener('popstate', function () { setTimeout(pageview, 0); });
  // Let the app settle its own URL on load (it normalises bad routes) first.
  setTimeout(pageview, 0);

  // ── events ────────────────────────────────────────────────────────────────
  var counts = {};
  function once(key, max, name, data) {
    counts[key] = (counts[key] || 0) + 1;
    if (counts[key] > (max || 1)) return;
    send(function (u) { u.track(name, data); });
  }

  var PLAYER = /^(openPick|openRec|openCmp|openPickModal|openDueModal|openStealModal)\(/;
  document.addEventListener('click', function (e) {
    var t = e.target;
    if (!t || !t.closest) return;
    var tool = toolName();

    var op = t.closest('[onclick]');
    var call = op ? (op.getAttribute('onclick') || '').trim() : '';
    if (PLAYER.test(call)) once('player|' + tool, 3, 'player', { tool: tool });
    else if (/^openHRVideo\(/.test(call)) once('video', 2, 'video', { tool: tool });

    if (t.closest('.view-btn')) once('view|' + tool, 1, 'view', { tool: tool });
    if (t.closest('.pbf-chip, .due-filter-chip')) once('filter|' + tool, 1, 'filter', { tool: tool });

    var tab = t.closest('.sub-btn');
    if (tab && /results/i.test(tab.textContent || '')) once('results|' + tool, 1, 'results', { tool: tool });

    var a = t.closest('a[href]');
    if (a && /^https?:/i.test(a.href) && a.hostname !== location.hostname) {
      once('out|' + a.hostname, 1, 'outbound', { to: a.hostname });
    }
  }, true);

  document.addEventListener('input', function (e) {
    var el = e.target;
    if (el && el.id && /search/i.test(el.id)) { var tool = toolName(); once('search|' + tool, 1, 'search', { tool: tool }); }
  }, true);
})();
