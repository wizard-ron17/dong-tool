// Rebuild through the pre-game window, one long run instead of hoping each cron fires.
//
//   node scripts/pregame-watch.mjs nba
//
// GitHub drops and delays scheduled runs (10/28: the 6:37 and 7:37 PM ET NBA builds never ran, so
// every graded line was priced off a 5 PM build with lineups only "expected"). Lineups, scratches and
// starting goalies land in the last hour before tip, so this stays up: it rebuilds and pushes every
// EVERY minutes while any game tips within LEAD minutes, sleeps until the next window otherwise,
// and exits after the last tip of the day (or at STOP, under the 6h job limit). Several crons start
// it; the concurrency group keeps one running, and a queued one finds nothing left and exits.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';

const sport = process.argv[2];
const EVERY = 5, LEAD = 90, STOP = 5.5 * 3600e3, t0 = Date.now();
const log = (m) => console.log(`${new Date().toISOString().slice(11, 16)}Z ${m}`);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const run = (cmd, args) => { try { execFileSync(cmd, args, { stdio: 'inherit' }); return true; } catch { log(`${cmd} ${args.join(' ')} failed`); return false; } };

// tips still to come, from the build's own schedule
function tips() {
  try {
    const d = JSON.parse(fs.readFileSync(`${sport}/data.json`, 'utf8'));
    return (d.schedule || []).filter(g => g.state === 'pre' && g.start).map(g => Date.parse(g.start)).filter(t => t > Date.now()).sort((a, b) => a - b);
  } catch { return []; }
}

let fails = 0;
for (;;) {
  const ok = run('node', [`scripts/build-${sport}.js`]) && run('bash', ['scripts/commit-data.sh', sport]);
  fails = ok ? 0 : fails + 1;
  if (fails >= 3) { log('three failed builds in a row, stopping'); process.exit(1); }
  const T = tips(), now = Date.now();
  if (!T.length) { log('no games left to tip today'); break; }
  const inWindow = T[0] - now <= LEAD * 60e3;
  const wake = inWindow ? now + EVERY * 60e3 : T[0] - LEAD * 60e3;
  if (wake - t0 > STOP) { log(`next build at ${new Date(wake).toISOString().slice(11, 16)}Z is past this run's limit, leaving it to the next`); break; }
  log(`${T.length} to tip, next ${new Date(T[0]).toISOString().slice(11, 16)}Z; ${inWindow ? 'in the window' : 'sleeping to the window'}, next build ${new Date(wake).toISOString().slice(11, 16)}Z`);
  await sleep(wake - now);
}
