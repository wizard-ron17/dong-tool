// Fetches the season's box scores from the MLB Stats API, computes everything
// the client used to compute in-browser, and writes the result to data.json.
// Run on a schedule (see .github/workflows/build-data.yml) so phones never
// have to do this work themselves.

const MLB          = 'https://statsapi.mlb.com/api/v1';
const SEASON_START = '2026-03-26';

const dailyHRs        = {};  // date -> { pid -> hrCount }
const dailyGames      = {};  // date -> gameCount
const hrTotals        = {};  // pid -> total HRs
const playerNames     = {};  // pid -> fullName
const playerTeams     = {};  // pid -> teamAbbr
const playerABs       = {};  // pid -> atBats
const playerGames     = {};  // pid -> gamesPlayed
const playerLastHR    = {};  // pid -> latest date string
const playerAbsByDate = {};  // pid -> { date -> abs that day } (dropped from output, only used to compute "Due")
const fetchedGameIds  = new Set();
const teamGameDays    = {};

function dateRange(start, end) {
  const dates = [], cur = new Date(start + 'T12:00:00Z'), last = new Date(end + 'T12:00:00Z');
  while (cur <= last) { dates.push(cur.toISOString().split('T')[0]); cur.setUTCDate(cur.getUTCDate() + 1); }
  return dates;
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function daysSince(d) {
  const [y,m,day] = d.split('-').map(Number);
  return Math.round((new Date() - new Date(y,m-1,day)) / 86400000);
}

async function fetchDay(date) {
  const sched = await fetch(`${MLB}/schedule?sportId=1&date=${date}&gameType=R`).then(r => r.json());
  const games = sched.dates?.[0]?.games ?? [];
  const finalGames = games.filter(g => g.status?.abstractGameState === 'Final' && !fetchedGameIds.has(g.gamePk));
  const ids = finalGames.map(g => g.gamePk);
  ids.forEach(id => fetchedGameIds.add(id));
  if (!ids.length) return;
  dailyGames[date] = (dailyGames[date] || 0) + ids.length;

  await Promise.all(ids.map(async id => {
    try {
      const box = await fetch(`${MLB}/game/${id}/boxscore`).then(r => r.json());
      for (const side of ['home','away']) {
        const t = box.teams?.[side] ?? {};
        const teamAbbr = t.team?.abbreviation ?? '';
        const batters  = t.batters ?? [];
        const players  = t.players ?? {};
        if (teamAbbr) {
          if (!teamGameDays[teamAbbr]) teamGameDays[teamAbbr] = {};
          teamGameDays[teamAbbr][date] = (teamGameDays[teamAbbr][date] || 0) + 1;
        }
        for (const pid of batters) {
          const p = players[`ID${pid}`];
          if (!p) continue;
          const hrs    = p?.stats?.batting?.homeRuns ?? 0;
          const abs    = p?.stats?.batting?.atBats   ?? 0;
          const name   = p.person?.fullName ?? `ID${pid}`;
          const pidStr = String(pid);
          playerABs[pidStr]   = (playerABs[pidStr]   || 0) + abs;
          playerGames[pidStr] = (playerGames[pidStr]  || 0) + 1;
          playerNames[pidStr] = name;
          if (teamAbbr) playerTeams[pidStr] = teamAbbr;
          if (!playerAbsByDate[pidStr]) playerAbsByDate[pidStr] = {};
          playerAbsByDate[pidStr][date] = (playerAbsByDate[pidStr][date] || 0) + abs;
          if (hrs < 1) continue;
          if (!dailyHRs[date]) dailyHRs[date] = {};
          dailyHRs[date][pidStr] = (dailyHRs[date][pidStr] || 0) + hrs;
          hrTotals[pidStr] = (hrTotals[pidStr] || 0) + hrs;
          if (!playerLastHR[pidStr] || date > playerLastHR[pidStr]) playerLastHR[pidStr] = date;
        }
      }
    } catch (e) {}
  }));
}

async function fetchAll() {
  const to    = new Date().toISOString().split('T')[0];
  const dates = dateRange(SEASON_START, to);
  const BATCH = 8, PAUSE = 40;

  for (let i = 0; i < dates.length; i += BATCH) {
    const batch = dates.slice(i, i + BATCH);
    console.log(`Fetching ${batch[0]}..${batch[batch.length - 1]} (${i + batch.length}/${dates.length})`);
    await Promise.all(batch.map(d => fetchDay(d).catch(() => {})));
    if (i + BATCH < dates.length) await sleep(PAUSE);
  }
}

// ── Combinatorics: groups of `size` players who all homered on the same day ──
function computeGroups(dHRs, size) {
  const allPids = new Set();
  for (const day of Object.values(dHRs)) for (const pid of Object.keys(day)) allPids.add(pid);
  const pidList = [...allPids], pidToIdx = {};
  pidList.forEach((p, i) => pidToIdx[p] = i);
  const pdc = {};
  for (const day of Object.values(dHRs)) for (const pid of Object.keys(day)) pdc[pid] = (pdc[pid] || 0) + 1;
  const minDays = size >= 4 ? 3 : size >= 3 ? 2 : 1, counts = {};
  for (const [date, day] of Object.entries(dHRs)) {
    const ids = Object.keys(day).filter(p => pdc[p] >= minDays).map(p => pidToIdx[p]).sort((a,b) => a-b);
    if (ids.length < size) continue;
    const n = ids.length, idx = Array.from({length: size}, (_, i) => i);
    while (true) {
      const key = idx.map(i => pidList[ids[i]]).join(',');
      if (!counts[key]) counts[key] = [];
      counts[key].push(date);
      let i = size - 1; while (i >= 0 && idx[i] === i + n - size) i--; if (i < 0) break;
      idx[i]++; for (let j = i + 1; j < size; j++) idx[j] = idx[j-1] + 1;
    }
  }
  const minCount = size === 2 ? 3 : 2; // drop one-off coincidences; they aren't meaningful signal and balloon file size
  return Object.entries(counts)
    .map(([key, dates]) => ({ pids: key.split(','), count: dates.length, dates: dates.sort() }))
    .filter(item => item.count >= minCount)
    .sort((a,b) => b.count - a.count || b.dates[b.dates.length-1].localeCompare(a.dates[a.dates.length-1]));
}

// ── "Due" sluggers: ABs-since-last-HR vs their usual gap, as a z-score ──
const DUE_MIN_HRS = 3, DUE_MIN_ABS = 40, DUE_MAX_AB_PER_HR = 30, DUE_MIN_Z = 1.0, DUE_MIN_DROUGHT_ABS = 10;

function cumAbsThrough(pid, date) {
  const byDate = playerAbsByDate[pid];
  if (!byDate) return 0;
  let sum = 0;
  for (const d of Object.keys(byDate)) { if (d <= date) sum += byDate[d]; }
  return sum;
}
function hrDatesFor(pid) {
  const dates = [];
  for (const [date, day] of Object.entries(dailyHRs)) { if (day[pid]) dates.push(date); }
  return dates.sort();
}
function avg(arr) { return arr.reduce((a,b) => a+b, 0) / arr.length; }
function sampleStd(arr) {
  if (arr.length < 2) return null;
  const m = avg(arr); return Math.sqrt(arr.reduce((s,x) => s+(x-m)**2, 0) / (arr.length - 1));
}

function computeDueRows() {
  const rows = [];
  for (const pid of Object.keys(hrTotals)) {
    const hrs = hrTotals[pid], abs = playerABs[pid] || 0;
    if (hrs < DUE_MIN_HRS || abs < DUE_MIN_ABS) continue;
    const seasonAbPerHR = abs / hrs;
    if (seasonAbPerHR > DUE_MAX_AB_PER_HR) continue;
    const lastHR = playerLastHR[pid]; if (!lastHR) continue;
    const droughtABs = abs - cumAbsThrough(pid, lastHR);
    if (droughtABs < DUE_MIN_DROUGHT_ABS) continue;
    const dates = hrDatesFor(pid), intervals = [];
    for (let i = 1; i < dates.length; i++) {
      const gap = cumAbsThrough(pid, dates[i]) - cumAbsThrough(pid, dates[i-1]);
      if (gap > 0) intervals.push(gap);
    }
    let avgGap, stdGap;
    if (intervals.length >= 2)       { avgGap = avg(intervals); stdGap = sampleStd(intervals); }
    else if (intervals.length === 1) { avgGap = (intervals[0] + seasonAbPerHR) / 2; stdGap = avgGap * 0.35; }
    else                              { avgGap = seasonAbPerHR; stdGap = seasonAbPerHR * 0.35; }
    if (!stdGap || stdGap < 1) stdGap = Math.max(avgGap * 0.35, 1);
    const z = (droughtABs - avgGap) / stdGap;
    if (z < DUE_MIN_Z) continue;
    rows.push({ pid, name: playerNames[pid] || pid, team: playerTeams[pid] || '', hrs, seasonAbPerHR,
      avgGap, droughtABs, stdGap, z, lastHR, lastAgo: daysSince(lastHR) });
  }
  rows.sort((a,b) => b.z - a.z || b.droughtABs - a.droughtABs);
  return rows;
}

async function main() {
  console.log(`Building data.json — season start ${SEASON_START}`);
  await fetchAll();

  const groups = { 2: computeGroups(dailyHRs, 2), 3: computeGroups(dailyHRs, 3), 4: computeGroups(dailyHRs, 4) };
  const dueRows = computeDueRows();

  const allDates = Object.keys(dailyHRs).sort();
  const totalHRCount = Object.values(hrTotals).reduce((a,b) => a+b, 0);

  const output = {
    generatedAt: new Date().toISOString(),
    seasonStart: SEASON_START,
    dateRangeStart: allDates[0] ?? null,
    dateRangeEnd: allDates[allDates.length - 1] ?? null,
    daysWithData: allDates.length,
    totalHRCount,
    dailyHRs, dailyGames, hrTotals, playerNames, playerTeams, playerABs, playerGames, playerLastHR,
    teamGameDays, groups, dueRows,
  };

  const fs = await import('node:fs');
  fs.writeFileSync(new URL('../data.json', import.meta.url), JSON.stringify(output));
  console.log(`Wrote data.json — ${allDates.length} game days, ${totalHRCount} HRs, ${dueRows.length} due rows`);
}

main().catch(e => { console.error(e); process.exit(1); });
