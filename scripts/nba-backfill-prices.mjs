// One-off (2026-10-31): the NBA stat boards' Results (points, rebounds, assists, PRA, steals, blocks, stocks)
// grade from nba/prices-history.json `st`, which the build only started saving on Oct 31. Every earlier night's
// last pre-tip board is still in git history (each build commits nba/data.json), so this re-derives each one's
// line nearest even money with the spread that board was priced with, and fills in the nights that lack it.
// Runs in CI (.github/workflows/backfill-nba-prices.yml, full history checkout), never locally: CLAUDE.md, data files.
//   node scripts/nba-backfill-prices.mjs
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { statNearEven } from './nba-models.js';

const HIST = 'nba/prices-history.json';
const H = JSON.parse(fs.readFileSync(HIST, 'utf8'));
const need = new Set(Object.keys(H.days).filter(d => !H.days[d].st));
if (!need.size) { console.log('every logged night already has its stat boards'); process.exit(0); }
const oldest = [...need].sort()[0];
console.log(`nights without stat boards: ${[...need].sort().join(', ')}`);

const git = (...a) => execFileSync('git', a, { encoding: 'utf8', maxBuffer: 64 << 20 });
// newest first: the newest commit whose board is a night's date is that night's last pre-tip board
// (rows freeze at tip, so it holds every game of the night as priced before its own tip)
const commits = git('log', '--format=%H %cI', '--', 'nba/data.json').trim().split('\n').map(l => l.split(' '));
const found = {};
for (const [sha, at] of commits) {
  if (at.slice(0, 10) < oldest) break;                  // the board for a date is committed on that date or later
  let st;
  try { st = JSON.parse(git('show', `${sha}:nba/data.json`)).stats; } catch (e) { continue; }
  if (st?.date && need.has(st.date) && !found[st.date] && st.boards) found[st.date] = { sha, st };
  if (Object.keys(found).length === need.size) break;
}
for (const [d, { sha, st }] of Object.entries(found).sort()) {
  H.days[d].st = Object.fromEntries(Object.entries(st.boards).map(([k, b]) =>
    [k, Object.fromEntries((b.rows || []).map(r => [r.pid, statNearEven(k, r, st.spread?.[k])]))]));
  console.log(`${d}: from ${sha.slice(0, 7)}, ${Object.entries(H.days[d].st).map(([k, v]) => `${k} ${Object.keys(v).length}`).join(', ')}`);
}
const missing = [...need].filter(d => !found[d]);
if (missing.length) console.log(`no board in history for: ${missing.join(', ')}`);
fs.writeFileSync(HIST, JSON.stringify(H));
