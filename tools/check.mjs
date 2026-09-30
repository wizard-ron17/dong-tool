// One command that says whether the site still works: `npm run check` (from the
// repo root) or `node tools/check.mjs`. Local only; nothing here deploys.
//
//   static   every app/shared script parses; every sport-folder JSON parses; the
//            late-news override files have the fields the builds read; every
//            <style> block's braces balance (an unclosed brace silently eats
//            every rule after it)
//   browser  each app + a few deep routes, desktop and phone width: no page
//            errors, the browser parsed exactly as many CSS rules as the file
//            has (a rule it drops is a typo it forgave), no sideways scroll
//            at phone width, something actually rendered
//
//   node tools/check.mjs            everything, Chromium
//   node tools/check.mjs --static   no browser (fast)
//   node tools/check.mjs --webkit   also WebKit (iPhone crashes: see memory)
//   node tools/check.mjs --only nhl just one app's routes
//
// Screenshots land in tools/shots/ (gitignored) for a look. Exit code 1 on any
// failure; warnings (console errors from outside feeds, etc.) don't fail.
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const ONLY = args.includes('--only') ? args[args.indexOf('--only') + 1] : null;
const fails = [], warns = [];
const fail = (where, msg) => fails.push(`${where}: ${msg}`);
const warn = (where, msg) => warns.push(`${where}: ${msg}`);
const rel = (p) => path.relative(ROOT, p);

// ── static ────────────────────────────────────────────────────────────────
function staticChecks() {
  // scripts parse (node --check is syntax only: no imports run, no network)
  const js = [
    ...['odds.js', 'sgp.js', 'welcome.js', 'analytics.js'].map(f => path.join(ROOT, f)),
    ...fs.readdirSync(path.join(ROOT, 'scripts')).filter(f => /\.(m?js)$/.test(f)).map(f => path.join(ROOT, 'scripts', f)),
    ...fs.readdirSync(path.join(ROOT, 'netlify/edge-functions')).filter(f => f.endsWith('.js')).map(f => path.join(ROOT, 'netlify/edge-functions', f)),
  ].filter(f => fs.existsSync(f));
  for (const f of js) {
    const r = spawnSync(process.execPath, ['--check', f], { encoding: 'utf8' });
    if (r.status) fail(rel(f), (r.stderr || '').split('\n').filter(Boolean).slice(0, 4).join(' | '));
  }
  // sport-folder JSON parses (a half-written data file breaks the page)
  for (const sp of ['mlb', 'nfl', 'nhl', 'nba']) {
    for (const f of fs.readdirSync(path.join(ROOT, sp)).filter(f => f.endsWith('.json') || f.endsWith('.webmanifest'))) {
      try { JSON.parse(fs.readFileSync(path.join(ROOT, sp, f), 'utf8')); } catch (e) { fail(`${sp}/${f}`, 'invalid JSON: ' + e.message); }
    }
  }
  // override files: hand-typed on game nights, so check the fields the builds read
  const qb = path.join(ROOT, 'nfl/qb-overrides.json');
  if (fs.existsSync(qb)) JSON.parse(fs.readFileSync(qb, 'utf8')).forEach((o, i) => {
    if (!Number.isInteger(o.season) || !Number.isInteger(o.week)) fail(`nfl/qb-overrides.json[${i}]`, 'season and week must be integers');
    if (!/^[A-Z]{2,3}$/.test(o.team || '')) fail(`nfl/qb-overrides.json[${i}]`, `team "${o.team}" is not an abbreviation like CHI`);
    if (!/^00-\d{7}$/.test(o.pid || '')) fail(`nfl/qb-overrides.json[${i}]`, `pid "${o.pid}" is not a gsis id like 00-0028986`);
  });
  const po = path.join(ROOT, 'mlb/pitching-overrides.json');
  if (fs.existsSync(po)) JSON.parse(fs.readFileSync(po, 'utf8')).forEach((o, i) => {
    const w = `mlb/pitching-overrides.json[${i}]`;
    if (!/^\d{4}-\d\d-\d\d$/.test(o.date || '')) fail(w, `date "${o.date}" is not YYYY-MM-DD`);
    if (!/^[A-Z]{2,3}$/.test(o.team || '')) fail(w, `team "${o.team}" is not an abbreviation like PHI`);
    if (!(o.openerIP > 0 && o.openerIP < 9)) fail(w, `openerIP ${o.openerIP} is not an inning count`);
    if (o.bulk != null && !/^\d{5,7}$/.test(String(o.bulk))) fail(w, `bulk "${o.bulk}" is not an MLBAM id`);
    if (o.bulk != null && !(o.bulkIP > 0)) fail(w, 'a bulk arm needs bulkIP');
  });
  // <style> braces balance in every page
  for (const f of ['index.html', '404.html', 'mlb/index.html', 'nfl/index.html', 'nhl/index.html', 'nba/index.html']) {
    const p = path.join(ROOT, f); if (!fs.existsSync(p)) continue;
    const html = fs.readFileSync(p, 'utf8');
    [...html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].forEach((m, k) => {
      // an empty value ("border-top-color: ;") is a declaration the browser drops
      // without a word: what a copy of the browser's serialized CSS leaves behind
      for (const e of m[1].matchAll(/[;{]\s*([a-z-]+)\s*:\s*;/g)) fail(`${f} <style> #${k + 1}`, `empty value for ${e[1]}`);
      const d = braceDepth(m[1]);
      if (d.min < 0 || d.end !== 0) fail(`${f} <style> #${k + 1}`, `braces unbalanced (ends at depth ${d.end}${d.min < 0 ? ', closes one it never opened' : ''})`);
    });
  }
}

// Strip comments and strings, then walk braces. Returns the top-level rule
// count too (what the browser's sheet.cssRules.length should equal).
function braceDepth(css) {
  const s = css.replace(/\/\*[\s\S]*?\*\//g, '').replace(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/g, '""');
  let d = 0, min = 0, top = 0, stmt = false;
  for (const ch of s) {
    if (ch === '{') { if (d === 0) top++; d++; stmt = false; }
    else if (ch === '}') { d--; min = Math.min(min, d); }
    else if (ch === ';' && d === 0 && stmt) { top++; stmt = false; }   // @import / @charset statements
    else if (ch === '@' && d === 0) stmt = true;
  }
  return { end: d, min, top };
}

// ── browser ───────────────────────────────────────────────────────────────
const ROUTES = [
  ['root', '/'], ['root', '/models/'],
  ['mlb', '/mlb/'], ['mlb', '/mlb/picks'], ['mlb', '/mlb/due'],
  ['nfl', '/nfl/'], ['nfl', '/nfl/picks'], ['nfl', '/nfl/fantasy'], ['nfl', '/nfl/yards/pass'],
  ['nhl', '/nhl/'], ['nhl', '/nhl/picks'], ['nhl', '/nhl/points'],
  ['nba', '/nba/'], ['nba', '/nba/threes'], ['nba', '/nba/points'],
];
const VIEWPORTS = [['desktop', { width: 1280, height: 900 }], ['phone', { width: 390, height: 844 }]];

async function browserChecks() {
  let pw;
  try { pw = await import(path.join(ROOT, 'tools/node_modules/playwright/index.mjs')); }
  catch { fail('browser', 'Playwright missing: run `npm install --prefix tools` once'); return; }
  const port = 5600 + Math.floor(Math.random() * 300);
  const srv = spawn(process.execPath, [path.join(ROOT, 'scripts/dev-server.js'), String(port)], { stdio: 'ignore' });
  await new Promise(r => setTimeout(r, 400));
  const shots = path.join(ROOT, 'tools/shots'); fs.mkdirSync(shots, { recursive: true });
  const engines = [['chromium', pw.chromium], ...(args.includes('--webkit') ? [['webkit', pw.webkit]] : [])];
  try {
    for (const [ename, engine] of engines) {
      const browser = await engine.launch();
      for (const [vname, viewport] of VIEWPORTS) {
        const ctx = await browser.newContext({ viewport });
        // skip the first-visit welcome modal so it doesn't cover the page
        await ctx.addInitScript(() => { try { localStorage.setItem('rons-tools-welcome-v2', '1'); } catch (e) {} });
        for (const [app, route] of ROUTES.filter(([a]) => !ONLY || a === ONLY || a === 'root' && ONLY === 'root')) {
          const where = `${ename} ${vname} ${route}`;
          const page = await ctx.newPage();
          const errs = [];
          page.on('pageerror', e => errs.push(e.message));
          page.on('console', m => { if (m.type() === 'error' && !/^Failed to load resource/.test(m.text())) warn(where, 'console: ' + m.text().slice(0, 160)); });
          page.on('response', r => { if (r.status() >= 400) warn(where, `${r.status()} ${r.url().replace(`http://localhost:${port}`, '').slice(0, 140)}`); });
          try {
            await page.goto(`http://localhost:${port}${route}`, { waitUntil: 'load', timeout: 45000 });
            await page.waitForTimeout(1500);           // data fetch + first render
          } catch (e) { fail(where, 'did not load: ' + e.message.split('\n')[0]); await page.close(); continue; }
          errs.forEach(e => fail(where, 'page error: ' + e.slice(0, 200)));
          const r = await page.evaluate(() => {
            // inline <style> sheets only (fonts etc. are cross-origin and unreadable)
            const css = [...document.styleSheets].filter(s => s.ownerNode && s.ownerNode.tagName === 'STYLE')
              .map(s => ({ id: s.ownerNode.id || '', text: s.ownerNode.textContent, parsed: s.cssRules.length }));
            return { css, text: document.body.innerText.trim().length,
                     overflow: document.documentElement.scrollWidth - window.innerWidth };
          });
          for (const s of r.css) {
            const want = braceDepth(s.text).top;
            if (want !== s.parsed) fail(where, `<style${s.id ? ' #' + s.id : ''}> has ${want} rules in the file, the browser kept ${s.parsed} (a malformed rule it dropped)`);
          }
          if (r.text < 150) fail(where, `almost nothing rendered (${r.text} characters of text)`);
          if (vname === 'phone' && r.overflow > 1) fail(where, `scrolls sideways by ${r.overflow}px at phone width`);
          await page.screenshot({ path: path.join(shots, `${ename}-${vname}-${route.replace(/\W+/g, '_') || 'root'}.png`) }).catch(() => {});
          await page.close();
        }
        await ctx.close();
      }
      await browser.close();
    }
  } finally { srv.kill(); }
}

staticChecks();
if (!args.includes('--static')) await browserChecks();
const dedupe = (a) => [...new Set(a)];
if (warns.length) console.log(`\nwarnings (${dedupe(warns).length}):\n  ` + dedupe(warns).slice(0, 40).join('\n  ') + (dedupe(warns).length > 40 ? `\n  … ${dedupe(warns).length - 40} more` : ''));
if (fails.length) { console.log(`\nFAILED (${dedupe(fails).length}):\n  ` + dedupe(fails).join('\n  ')); process.exit(1); }
console.log(`\nall checks passed${args.includes('--static') ? ' (static only)' : ''}`);
