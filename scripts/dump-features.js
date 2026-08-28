// Dump the Node-computed feature rows for one historical (season, week) so
// research/validate_port.py can diff them against build_dataset.py.
//
//   node scripts/dump-features.js 2025 10 > /tmp/node_features.json
//
// The pool here is "players who took an offensive snap in that game", matching
// build_dataset.py — the live tool uses the roster instead, but the point of
// this script is to check the feature MATH, not the pool selection.

import { REL, fetchText, fetchOptional, parseCsv, num } from './nflverse.js';
import { loadCrosswalk, loadSnapLog, loadRzLog, loadInjuries, absenceFeatures,
         playerFeatures, score } from './picks.js';

const season = +process.argv[2];
const week = +process.argv[3];
if (!season || !week) { console.error('usage: dump-features.js <season> <week>'); process.exit(1); }

// The loaders in picks.js narrate to console.log, which is right for the build
// but would corrupt the JSON on stdout here. Send all of it to stderr.
const log = (...a) => console.error(...a);
console.log = log;

const xwalk = await loadCrosswalk();
// mirror picks.js: all snap seasons, but only a 2-season red-zone window
const snapSeasons = [];
for (let y = 2016; y <= season; y++) snapSeasons.push(y);
const snapLog = await loadSnapLog(snapSeasons, xwalk);
const rzLog = await loadRzLog([season - 1, season]);
const { byWeek } = await loadInjuries(season, week);

// implied total for each team in that week, from pbp's closing lines
const { idx: pi, rows: prows } = parseCsv(
  await fetchText(`${REL}/pbp/play_by_play_${season}.csv`));
const implied = new Map();
for (const r of prows) {
  if (+r[pi.week] !== week) continue;
  const t = r[pi.posteam]; if (!t || implied.has(t)) continue;
  const tot = num(r[pi.total_line]), sp = num(r[pi.spread_line]);
  if (tot == null || sp == null) continue;
  implied.set(t, r[pi.posteam] === r[pi.home_team] ? tot / 2 + sp / 2 : tot / 2 - sp / 2);
}

const out = [];
for (const [pid, games] of snapLog) {
  const g = games.find(s => s.season === season && s.week === week);
  if (!g) continue;                                  // did not play that week
  const imp = implied.get(g.team);
  if (imp == null) continue;
  const { matesOut, newAbsence } = absenceFeatures({
    byWeek, snapLog, pid, team: g.team, position: g.position, season, week });
  const row = playerFeatures({
    pid, position: g.position, season, week, snapLog, rzLog,
    impliedTotal: imp, matesOut, newAbsence,
  });
  if (!row) continue;
  out.push({ pid, team: g.team, ...row, p: score(row) });
}
log(`dumped ${out.length} rows for ${season} week ${week}`);
process.stdout.write(JSON.stringify(out));
