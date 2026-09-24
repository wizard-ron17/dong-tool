// Should this scheduled build run? Prints `run=true|false` for $GITHUB_OUTPUT.
//
//   node scripts/should-build.mjs <mlb|nhl> [event_name]
//
// The crons fire on a fixed clock; the season doesn't. On a game day every
// scheduled run goes ahead. On a day without games only the morning run does
// (it settles yesterday's grading and today's slate). With no games for a week
// either way — the offseason, the All-Star break — only Monday's morning run.
// A manual run (workflow_dispatch) always builds. If the schedule can't be
// read, build: a wasted run is cheaper than a stale site.
const [sport, event] = process.argv.slice(2);
const out = (run, why) => { console.log(`run=${run}`); console.error(`${sport}: ${run ? 'build' : 'skip'} — ${why}`); process.exit(0); };
if (event === 'workflow_dispatch') out(true, 'manual run');

const MORNING_UTC = 11;                       // the daily baseline run in every workflow
const now = new Date(), hour = now.getUTCHours(), monday = now.getUTCDay() === 1;
const et = (d) => d.toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
const shift = (n) => et(new Date(now.getTime() + n * 86400000));
const today = shift(0), yday = shift(-1);

async function games(from, to) {
  if (sport === 'mlb') {
    const j = await (await fetch(`https://statsapi.mlb.com/api/v1/schedule?sportId=1&gameType=R,F,D,L,W&startDate=${from}&endDate=${to}`)).json();
    return (j.dates || []).flatMap(d => d.games.map(g => ({ date: d.date, done: g.status?.abstractGameState === 'Final' })));
  }
  if (sport === 'nhl') {
    const out = [];
    for (let d = from; d <= to; ) {           // /schedule/{date} returns that date's week
      const j = await (await fetch(`https://api-web.nhle.com/v1/schedule/${d}`)).json();
      for (const day of j.gameWeek || []) for (const g of day.games || [])
        if (day.date >= from && day.date <= to) out.push({ date: day.date, done: ['OFF', 'FINAL'].includes(g.gameState) });
      const last = (j.gameWeek || []).at(-1)?.date;
      if (!last || last < d) break;
      d = new Date(Date.parse(last + 'T12:00:00Z') + 86400000).toISOString().slice(0, 10);
    }
    return out;
  }
  throw new Error('unknown sport');
}

try {
  const g = await games(shift(-7), shift(7));
  if (g.some(x => x.date === today)) out(true, 'games today');
  if (g.some(x => x.date === yday && !x.done)) out(true, "last night's games still going");
  if (!g.length) out(monday && hour === MORNING_UTC, 'offseason — Monday mornings only');
  out(hour === MORNING_UTC, 'no games today — morning run only');
} catch (e) {
  out(true, `couldn't read the schedule (${e.message})`);
}
