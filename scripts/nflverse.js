// Shared nflverse fetch + CSV helpers, used by build-nfl.js and picks.js.
// Extracted from build-nfl.js when the Picks tool needed the same primitives.

export const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';
export const REL = 'https://github.com/nflverse/nflverse-data/releases/download';

export async function fetchText(url) {
  for (let a = 0; a < 4; a++) {
    try {
      const r = await fetch(url, { headers: { 'User-Agent': UA } });
      if (r.ok) return await r.text();
    } catch (e) {}
    await new Promise(r => setTimeout(r, 1500));
  }
  throw new Error('fetch failed: ' + url);
}

// In-season nflverse files exist but are empty stubs before the first games are
// played (snap_counts/injuries for an unstarted season come back ~9 bytes).
// Callers want "no rows yet", not a crash.
export async function fetchOptional(url) {
  try {
    const t = await fetchText(url);
    return t && t.trim().length > 20 ? t : null;
  } catch (e) {
    return null;
  }
}

// Quote-aware CSV -> {header:[], rows:[[...]]} with a name->index map.
export function parseCsv(text) {
  const lines = text.replace(/^﻿/, '').split('\n');
  const parseLine = (s) => {
    const out = []; let cur = '', q = false;
    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      if (c === '"') { if (q && s[i + 1] === '"') { cur += '"'; i++; } else q = !q; }
      else if (c === ',' && !q) { out.push(cur); cur = ''; }
      else cur += c;
    }
    out.push(cur); return out;
  };
  const header = parseLine(lines[0]);
  const idx = {}; header.forEach((h, i) => idx[h] = i);
  const rows = [];
  for (let i = 1; i < lines.length; i++) { if (lines[i].trim()) rows.push(parseLine(lines[i])); }
  return { idx, rows };
}

export const num = (v) => { const n = parseFloat(v); return isNaN(n) ? null : n; };
