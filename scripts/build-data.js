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
const playerLastGame  = {};  // pid -> latest date they appeared in a boxscore at all (HR or not)
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
          if (!playerLastGame[pidStr] || date > playerLastGame[pidStr]) playerLastGame[pidStr] = date;
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
// Excludes anyone who hasn't appeared in a boxscore recently — the AB-drought
// math has no idea about injuries/benching/demotions, so a guy on the IL just
// freezes at whatever z-score he had instead of falling off the list. Teams
// play almost daily (only real gap is the ~4-day All-Star break), so a multi-
// day absence from boxscores is a strong signal he isn't actually playing.
const DUE_MIN_HRS = 3, DUE_MIN_ABS = 40, DUE_MAX_AB_PER_HR = 30, DUE_MIN_Z = 1.0, DUE_MIN_DROUGHT_ABS = 10;
const DUE_MAX_INACTIVE_DAYS = 5;

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
    const lastGame = playerLastGame[pid];
    if (!lastGame || daysSince(lastGame) > DUE_MAX_INACTIVE_DAYS) continue; // likely injured/benched/demoted
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

    // Raw z rewards mechanical consistency (low std dev) regardless of whether
    // the guy is an established power threat — a 3-HR part-timer with freakishly
    // even gaps can out-z a 25-HR slugger. dueScore weights z by HR volume (proven
    // bopper, sqrt-scaled so it doesn't run away) and by how many historical gaps
    // it's actually based on (2 gaps — the minimum possible here — is a guess, not
    // a pattern).
    const powerWeight      = Math.sqrt(hrs / DUE_MIN_HRS);
    const confidenceWeight = Math.min(1, intervals.length / 3);
    const dueScore = z * powerWeight * confidenceWeight;

    rows.push({ pid, name: playerNames[pid] || pid, team: playerTeams[pid] || '', hrs, seasonAbPerHR,
      avgGap, droughtABs, stdGap, z, dueScore, lastHR, lastAgo: daysSince(lastHR), lastGame });
  }
  rows.sort((a,b) => b.dueScore - a.dueScore || b.z - a.z);
  return rows;
}

// ── Prospects: fresh debuts who've gone deep, plus a "just called up" watchlist ──
// "Debut Bombs" = rookies (debuted this season) who've already homered, with
// which exact game the HR came in (their AB log this season *is* their whole
// MLB career so far). "Just Called Up" = recent AAA/AA selections who haven't
// debuted yet or have 0 HR so far — catches a hot prospect's callup before
// he's already all over ESPN for going deep in his first game.
const PROSPECT_LOOKBACK_DAYS = 14;
const MINOR_SPORT_IDS = { aaa: 11, aa: 12 };

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

async function fetchPeopleInfo(ids) {
  const info = {};
  for (const group of chunk([...new Set(ids)], 100)) {
    if (!group.length) continue;
    try {
      const res = await fetch(`${MLB}/people?personIds=${group.join(',')}`).then(r => r.json());
      for (const p of res.people ?? []) {
        info[String(p.id)] = {
          fullName: p.fullName,
          debutDate: p.mlbDebutDate ?? null,
          positionCode: p.primaryPosition?.code ?? '',
        };
      }
    } catch (e) {}
  }
  return info;
}

async function fetchRecentSelections(days) {
  const end = new Date(), start = new Date();
  start.setUTCDate(start.getUTCDate() - days);
  const fmt = d => d.toISOString().split('T')[0];
  try {
    const res = await fetch(`${MLB}/transactions?startDate=${fmt(start)}&endDate=${fmt(end)}`).then(r => r.json());
    return (res.transactions ?? [])
      .filter(t => t.typeDesc === 'Selected' && t.person?.id)
      .map(t => ({ pid: String(t.person.id), name: t.person.fullName, fromTeam: t.fromTeam?.name ?? '', toTeam: t.toTeam?.name ?? '', date: t.date }));
  } catch (e) { return []; }
}

async function fetchMinorLeaguePedigree(pid) {
  const pedigree = {};
  for (const [key, sportId] of Object.entries(MINOR_SPORT_IDS)) {
    try {
      const res = await fetch(`${MLB}/people/${pid}/stats?stats=yearByYear&group=hitting&sportId=${sportId}`).then(r => r.json());
      const splits = res.stats?.[0]?.splits ?? [];
      if (!splits.length) continue;
      const latest = splits.slice().sort((a,b) => b.season.localeCompare(a.season))[0];
      pedigree[key] = {
        season: latest.season, team: latest.team?.name ?? '',
        games: latest.stat.gamesPlayed, hrs: latest.stat.homeRuns,
        avg: latest.stat.avg, ops: latest.stat.ops,
      };
    } catch (e) {}
  }
  return pedigree;
}

async function attachPedigree(rows) {
  const BATCH = 6;
  for (let i = 0; i < rows.length; i += BATCH) {
    const batch = rows.slice(i, i + BATCH);
    await Promise.all(batch.map(async row => { row.milb = await fetchMinorLeaguePedigree(row.pid); }));
  }
}

async function computeProspects() {
  const seasonBatterIds = Object.keys(playerNames);
  const selections = await fetchRecentSelections(PROSPECT_LOOKBACK_DAYS);
  const selectionByPid = {};
  for (const s of selections) selectionByPid[s.pid] = s; // later selections overwrite earlier ones

  const allIds = new Set([...seasonBatterIds, ...selections.map(s => s.pid)]);
  const peopleInfo = await fetchPeopleInfo([...allIds]);

  // Debut Bombs: rookies who've already gone deep, with which game it came in
  const debutBombs = [];
  for (const pid of seasonBatterIds) {
    const info = peopleInfo[pid];
    if (!info?.debutDate || info.debutDate < SEASON_START) continue; // not a rookie this season
    if (!hrTotals[pid]) continue;
    const gameDates = Object.keys(playerAbsByDate[pid] ?? {}).sort();
    const hrGames = [];
    gameDates.forEach((d, i) => { if (dailyHRs[d]?.[pid]) hrGames.push(i + 1); });
    debutBombs.push({
      pid, name: playerNames[pid], team: playerTeams[pid] || '',
      debutDate: info.debutDate, gamesPlayed: gameDates.length, hrs: hrTotals[pid], hrGames,
    });
  }
  debutBombs.sort((a,b) => (a.hrGames[0] ?? 99) - (b.hrGames[0] ?? 99) || b.hrs - a.hrs);

  // Just Called Up: recent AAA/AA selections, rookie-eligible, no HR yet —
  // excludes pitchers (can't homer) and established players just being recalled.
  const justCalledUp = [];
  for (const [pid, sel] of Object.entries(selectionByPid)) {
    const info = peopleInfo[pid];
    if (info?.positionCode === '1') continue;
    const isRookie = !info?.debutDate || info.debutDate >= SEASON_START;
    if (!isRookie) continue;
    if (hrTotals[pid]) continue; // already homered — belongs in debutBombs instead
    justCalledUp.push({
      pid, name: playerNames[pid] || info?.fullName || sel.name,
      team: playerTeams[pid] || sel.toTeam, fromTeam: sel.fromTeam,
      selectedDate: sel.date, debutDate: info?.debutDate ?? null,
      status: info?.debutDate ? 'debuted' : 'selected',
      gamesPlayed: playerGames[pid] || 0,
    });
  }

  await attachPedigree(debutBombs);
  await attachPedigree(justCalledUp);

  justCalledUp.sort((a,b) => {
    const opsOf = r => parseFloat(r.milb.aaa?.ops ?? r.milb.aa?.ops ?? 0) || 0;
    return opsOf(b) - opsOf(a);
  });

  return { justCalledUp, debutBombs };
}

async function main() {
  console.log(`Building data.json — season start ${SEASON_START}`);
  await fetchAll();

  const groups = { 2: computeGroups(dailyHRs, 2), 3: computeGroups(dailyHRs, 3), 4: computeGroups(dailyHRs, 4) };
  const dueRows = computeDueRows();

  console.log('Checking for rookie debuts and recent call-ups...');
  const prospects = await computeProspects();

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
    teamGameDays, groups, dueRows, prospects,
  };

  const fs = await import('node:fs');
  fs.writeFileSync(new URL('../data.json', import.meta.url), JSON.stringify(output));
  console.log(`Wrote data.json — ${allDates.length} game days, ${totalHRCount} HRs, ${dueRows.length} due rows, ${prospects.debutBombs.length} debut bombs, ${prospects.justCalledUp.length} just called up`);
}

main().catch(e => { console.error(e); process.exit(1); });
