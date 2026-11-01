// Rebuild through the pre-game window, one long run instead of hoping each cron fires.
//
//   node scripts/pregame-watch.mjs nba     (every 5 minutes from 90 before each tip, until the last tip)
//   node scripts/pregame-watch.mjs nfl     (every 15 minutes from 2 hours before each kickoff, until it's final)
//
// GitHub drops and delays scheduled runs (10/28: the 6:37 and 7:37 PM ET NBA builds never ran, so
// every graded line was priced off a 5 PM build with lineups only "expected"). Lineups, scratches and
// starting goalies land in the last hour before tip, so this stays up: it rebuilds and pushes every
// EVERY minutes while any game tips within LEAD minutes, sleeps until the next window otherwise,
// and exits after the last tip of the day (or at STOP, under the 6h job limit). Several crons start
// it; the concurrency group keeps one running, and a queued one finds nothing left and exits.
// NFL (11/1: GitHub started none of Sunday's hourly builds from 05:50 to 16:32 UTC, so the boards
// sat 10 hours old into the 1pm kickoffs) runs on a slower clock: inactives land 90 minutes before
// kickoff, and every build also grades the games that just went final, so it stays up through the
// last game's finish, not just its kickoff. A day of 1pm through Sunday night spans two runs.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';

const sport = process.argv[2];
// TAIL: how long after a start the game still needs builds (0: only up to the tip)
const { EVERY, LEAD, TAIL } = { nba: { EVERY: 5, LEAD: 90, TAIL: 0 }, nfl: { EVERY: 15, LEAD: 120, TAIL: 4 * 60 } }[sport];
const STOP = 5.5 * 3600e3, t0 = Date.now();
const log = (m) => console.log(`${new Date().toISOString().slice(11, 16)}Z ${m}`);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const run = (cmd, args) => { try { execFileSync(cmd, args, { stdio: 'inherit' }); return true; } catch { log(`${cmd} ${args.join(' ')} failed`); return false; } };

// NFL kickoffs are listed in ET (gameday + gametime): the UTC instant, EDT or EST as that date has it
function etInstant(d, t) {
  for (const off of [4, 5]) {
    const x = Date.parse(`${d}T${t}:00Z`) + off * 3600e3;
    if (new Date(x).toLocaleTimeString('en-GB', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit' }) === t) return x;
  }
  return NaN;
}
// starts still needing builds, from the build's own schedule: games to come, and (with TAIL) games not yet final
function tips() {
  try {
    const d = JSON.parse(fs.readFileSync(`${sport}/data.json`, 'utf8')), now = Date.now();
    const starts = sport === 'nfl'
      ? (d.schedule || []).filter(g => g.homeScore == null && g.gameday && g.gametime).map(g => etInstant(g.gameday, g.gametime))
      : (d.schedule || []).filter(g => g.state === 'pre' && g.start).map(g => Date.parse(g.start));
    return starts.filter(t => t + TAIL * 60e3 > now).sort((a, b) => a - b);
  } catch { return []; }
}

// NFL has no should-build gate: a day with nothing kicking off within LEAD + 3 hours, or still on, builds nothing
if (TAIL) {
  const T = tips(), now = Date.now();
  if (!T.length || T[0] - now > (LEAD + 180) * 60e3) { log(T.length ? `next kickoff ${new Date(T[0]).toISOString().slice(0, 16)}Z, not today's window` : 'no games to come'); process.exit(0); }
}

let fails = 0;
for (;;) {
  const ok = run('node', [`scripts/build-${sport}.js`]) && run('bash', ['scripts/commit-data.sh', sport]);
  fails = ok ? 0 : fails + 1;
  if (fails >= 3) { log('three failed builds in a row, stopping'); process.exit(1); }
  const T = tips(), now = Date.now();
  if (!T.length) { log(TAIL ? 'every game final' : 'no games left to tip today'); break; }
  const inWindow = T[0] - now <= LEAD * 60e3;           // the earliest start: due within LEAD, or kicked off (TAIL)
  const wake = inWindow ? now + EVERY * 60e3 : T[0] - LEAD * 60e3;
  if (wake - t0 > STOP) {
    // GitHub starts few of the crons (11/1: 3 of build-nfl's 18 in a day), so the next run isn't left to
    // them: the workflow dispatches itself when this prints more=true (a GITHUB_TOKEN dispatch does start a run)
    log(`next build at ${new Date(wake).toISOString().slice(11, 16)}Z is past this run's limit, handing on to the next run`);
    if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, 'more=true\n');
    break;
  }
  log(`${T.length} to tip, next ${new Date(T[0]).toISOString().slice(11, 16)}Z; ${inWindow ? 'in the window' : 'sleeping to the window'}, next build ${new Date(wake).toISOString().slice(11, 16)}Z`);
  await sleep(wake - now);
}
