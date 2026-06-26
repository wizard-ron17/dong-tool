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

// ── Combinatorics: groups of players who all homered on the same day, 2 through 5 ──
// Built bottom-up (Apriori-style): any group of size N that repeats must have every
// (N-1)-subset of it also repeat, so each size is built by extending the *previous*
// size's groups by one more player instead of brute-forcing every C(n,size) combo
// from scratch each day. That's what made a 5-man tier feasible at all — brute force
// on it alone ran for minutes without finishing; this chain does 2 through 5 in ~3s.
//
// minDays(size) = how many total HR days (anywhere, not necessarily with this group)
// each individual member must have this season — same per-size floor the old
// brute-force version used, preserved exactly so 2/3/4-man results don't change.
// minCount(size) = how many times the group itself must have repeated to be shown.
function computeAllGroups(dHRs) {
  const minDaysFor  = size => size >= 4 ? 3 : size >= 3 ? 2 : 1;
  const minCountFor = size => size === 2 ? 3 : size === 5 ? 3 : 2;

  const pdc = {}; // pid -> total HR days this season (any group, or none)
  for (const day of Object.values(dHRs)) for (const pid of Object.keys(day)) pdc[pid] = (pdc[pid] || 0) + 1;

  function buildPairs() {
    const counts = {};
    for (const [date, day] of Object.entries(dHRs)) {
      const pids = Object.keys(day);
      for (let i = 0; i < pids.length; i++) for (let j = i + 1; j < pids.length; j++) {
        const key = [pids[i], pids[j]].sort().join(',');
        (counts[key] ??= new Set()).add(date);
      }
    }
    return Object.entries(counts).map(([key, dates]) => ({ pids: key.split(','), dates: [...dates], count: dates.size }));
  }
  function extend(baseGroups, minDays) {
    const counts = {};
    for (const g of baseGroups) {
      for (const date of g.dates) {
        for (const extra of Object.keys(dHRs[date])) {
          if (g.pids.includes(extra) || pdc[extra] < minDays) continue;
          const key = [...g.pids, extra].sort().join(',');
          (counts[key] ??= new Set()).add(date);
        }
      }
    }
    return Object.entries(counts).map(([key, dates]) => ({ pids: key.split(','), dates: [...dates], count: dates.size }));
  }
  const finalize = groups => groups
    .map(g => ({ ...g, dates: g.dates.sort() }))
    .sort((a,b) => b.count - a.count || b.dates[b.dates.length-1].localeCompare(a.dates[a.dates.length-1]));

  const pairsRaw = buildPairs();
  const out = { 2: finalize(pairsRaw.filter(g => g.count >= minCountFor(2))) };

  let prevOut = pairsRaw.filter(g => g.count >= 2); // loosest valid chaining seed, not the display-filtered list
  for (const size of [3, 4, 5]) {
    const minDays = minDaysFor(size);
    const base = prevOut.filter(g => g.pids.every(p => pdc[p] >= minDays));
    const raw = extend(base, minDays);
    out[size] = finalize(raw.filter(g => g.count >= minCountFor(size)));
    prevOut = raw.filter(g => g.count >= 2);
  }
  return out;
}

// ── "Due" sluggers: ABs-since-last-HR vs their usual gap, as a z-score ──
// Excludes anyone who hasn't appeared in a boxscore recently — the AB-drought
// math has no idea about injuries/benching/demotions, so a guy on the IL just
// freezes at whatever z-score he had instead of falling off the list. Teams
// play almost daily (only real gap is the ~4-day All-Star break), so a multi-
// day absence from boxscores is a strong signal he isn't actually playing.
const DUE_MIN_HRS = 5, DUE_MIN_ABS = 40, DUE_MAX_AB_PER_HR = 30, DUE_MIN_Z = 1.0, DUE_MIN_DROUGHT_ABS = 10;
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
    // Longest gap of the season so far, for display only — kept out of avgGap/stdGap
    // (and thus z/dueScore) below so it doesn't change how "due" anyone is ranked,
    // it just adds context once they're already on the list. Includes the season-
    // opening gap (Opening Day through his first HR), since a slow start is a real
    // drought too even though it's not a "gap between two HRs."
    const leadGap = dates.length ? cumAbsThrough(pid, dates[0]) : 0;
    const longestPriorGap = Math.max(leadGap, ...intervals, 0);
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
      avgGap, droughtABs, stdGap, z, dueScore, lastHR, lastAgo: daysSince(lastHR), lastGame,
      intervals, hrDates: dates, longestPriorGap, isLongestEver: droughtABs >= longestPriorGap });
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
const SEASON_YEAR = SEASON_START.slice(0, 4);

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

async function fetchRecentRosterMoves(days) {
  const end = new Date(), start = new Date();
  start.setUTCDate(start.getUTCDate() - days);
  const fmt = d => d.toISOString().split('T')[0];
  try {
    const res = await fetch(`${MLB}/transactions?startDate=${fmt(start)}&endDate=${fmt(end)}`).then(r => r.json());
    const txns = res.transactions ?? [];
    const callUps = txns
      .filter(t => (t.typeDesc === 'Recalled' || t.typeDesc === 'Selected') && t.person?.id)
      .map(t => ({ pid: String(t.person.id), name: t.person.fullName, fromTeam: t.fromTeam?.name ?? '', toTeam: t.toTeam?.name ?? '', date: t.date }));
    // Sent back down since being called up (e.g. optioned to AAA after a brief
    // look) — track the latest such date per player so we can drop them from
    // "Just Called Up" instead of still watching a guy who isn't even on the
    // active roster anymore.
    const sentDownByPid = {};
    for (const t of txns) {
      if (t.typeDesc !== 'Optioned' || !t.person?.id) continue;
      const pid = String(t.person.id);
      if (!sentDownByPid[pid] || t.date > sentDownByPid[pid]) sentDownByPid[pid] = t.date;
    }
    return { callUps, sentDownByPid };
  } catch (e) { return { callUps: [], sentDownByPid: {} }; }
}

async function fetchMinorLeaguePedigree(pid) {
  const pedigree = {};
  for (const [key, sportId] of Object.entries(MINOR_SPORT_IDS)) {
    try {
      const res = await fetch(`${MLB}/people/${pid}/stats?stats=yearByYear&group=hitting&sportId=${sportId}`).then(r => r.json());
      const splits = res.stats?.[0]?.splits ?? [];
      const thisSeason = splits.find(s => s.season === SEASON_YEAR);
      if (!thisSeason) continue; // no current-season record at this level — stale prior-year stats aren't useful context
      pedigree[key] = {
        season: thisSeason.season, team: thisSeason.team?.name ?? '',
        games: thisSeason.stat.gamesPlayed, abs: thisSeason.stat.atBats, hrs: thisSeason.stat.homeRuns,
        avg: thisSeason.stat.avg, ops: thisSeason.stat.ops,
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
  const { callUps: selections, sentDownByPid } = await fetchRecentRosterMoves(PROSPECT_LOOKBACK_DAYS);
  const selectionByPid = {};
  for (const s of selections) selectionByPid[s.pid] = s; // later selections overwrite earlier ones

  const allIds = new Set([...seasonBatterIds, ...selections.map(s => s.pid)]);
  const peopleInfo = await fetchPeopleInfo([...allIds]);

  // Debut Bombs: rookies who've already gone deep — bounded to the same
  // lookback window as "just called up" so this stays about *new* call-ups,
  // not anyone who debuted months ago and has quietly racked up 20 HRs since
  // (at that point he's just a good rookie, not a surprise debut story).
  const debutBombs = [];
  for (const pid of seasonBatterIds) {
    const info = peopleInfo[pid];
    if (!info?.debutDate || daysSince(info.debutDate) > PROSPECT_LOOKBACK_DAYS) continue;
    if (!hrTotals[pid]) continue;
    const gameDates = Object.keys(playerAbsByDate[pid] ?? {}).sort();
    const hrGames = [];
    gameDates.forEach((d, i) => { if (dailyHRs[d]?.[pid]) hrGames.push(i + 1); });
    debutBombs.push({
      pid, name: playerNames[pid], team: playerTeams[pid] || '',
      debutDate: info.debutDate, gamesPlayed: gameDates.length, abs: playerABs[pid] || 0,
      hrs: hrTotals[pid], hrGames,
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
    if (sentDownByPid[pid] && sentDownByPid[pid] > sel.date) continue; // optioned back down since this call-up
    justCalledUp.push({
      pid, name: playerNames[pid] || info?.fullName || sel.name,
      team: playerTeams[pid] || sel.toTeam, fromTeam: sel.fromTeam,
      selectedDate: sel.date, debutDate: info?.debutDate ?? null,
      status: info?.debutDate ? 'debuted' : 'selected',
      gamesPlayed: playerGames[pid] || 0, abs: playerABs[pid] || 0, hrs: hrTotals[pid] || 0,
    });
  }

  await attachPedigree(debutBombs);
  await attachPedigree(justCalledUp);

  // No current-season minor league record at all means there's nothing to
  // judge the callup by — drop it rather than show an empty pedigree.
  const justCalledUpRanked = justCalledUp.filter(r => r.milb.aaa || r.milb.aa);

  // Rank by minors AB/HR (lower = more explosive power), independent of how many
  // MLB at-bats he's had so far — this list is about catching a hot prospect
  // *before* he's had a chance to prove it, so a fresh callup with elite pedigree
  // and 4 MLB AB should still rank above a mediocre bat who's just had a longer
  // look. (breakoutScore, below, is linear in MLB ABs — sorting by it instead
  // would reward "has had more empty at-bats" over actual power, the opposite
  // of the point.)
  const abPerHR = level => (level && level.hrs) ? level.abs / level.hrs : null;
  for (const r of justCalledUpRanked) {
    const level = r.milb.aaa ?? r.milb.aa;
    r.milbAbPerHR = abPerHR(level);
    // Secondary context stat only: "how many HRs his minors pace would predict
    // off the MLB at-bats he's already had" — informative, not the sort key.
    r.breakoutScore = r.milbAbPerHR ? r.abs / r.milbAbPerHR : 0;
  }
  justCalledUpRanked.sort((a,b) => (a.milbAbPerHR ?? Infinity) - (b.milbAbPerHR ?? Infinity));

  // Debut Bombs gets the same minors-vs-MLB AB/HR comparison for context (not
  // for ranking — "Game 1" vs "Game 6" first-HR order still matters more there).
  for (const r of debutBombs) {
    const level = r.milb.aaa ?? r.milb.aa;
    r.milbAbPerHR = abPerHR(level);
    r.mlbAbPerHR = r.hrs ? r.abs / r.hrs : null;
  }

  return { justCalledUp: justCalledUpRanked, debutBombs };
}

// Real injured-list status (not a guess from "hasn't played in N days") — MLB's
// transactions feed logs every IL placement/activation with the stint length and
// often the injury itself, e.g. "...placed SS Elly De La Cruz on the 10-day
// injured list. Right hamstring strain." We take each tracked batter's most
// recent IL-related transaction this season: if it's an activation, he's off
// the list and gets no badge; if it's a placement/transfer, he's presumed still
// out — UNLESS he's actually played an MLB game since that placement date, which
// happens when a guy comes off a long minors IL stint via a roster move (e.g.
// "Selected") rather than a logged "activated from the injured list" transaction.
// Real game appearances are ground truth; the transaction feed's wording isn't.
async function fetchInjuryStatus() {
  const today = new Date().toISOString().split('T')[0];
  let txns = [];
  try {
    const res = await fetch(`${MLB}/transactions?startDate=${SEASON_START}&endDate=${today}`).then(r => r.json());
    txns = res.transactions ?? [];
  } catch (e) { return {}; }

  const byPid = {};
  for (const t of txns) {
    if (t.typeDesc !== 'Status Change' || !t.person?.id || !/injured list/i.test(t.description || '')) continue;
    const pid = String(t.person.id);
    (byPid[pid] ??= []).push(t);
  }

  const status = {};
  for (const [pid, list] of Object.entries(byPid)) {
    if (!playerNames[pid]) continue; // not a batter we're otherwise tracking
    list.sort((a, b) => a.date.localeCompare(b.date));
    const last = list[list.length - 1];
    const desc = last.description || '';
    if (/\bactivated\b/i.test(desc)) continue; // back off the IL — no badge
    if (playerLastGame[pid] && playerLastGame[pid] > last.date) continue; // played since — clearly active
    const dayMatch = desc.match(/to the (\d+)-day injured list/i) || desc.match(/on the (\d+)-day injured list/i);
    const reasonMatch = desc.match(/injured list\.\s*(.+)$/i);
    status[pid] = {
      date: last.date,
      ilDays: dayMatch ? Number(dayMatch[1]) : null,
      reason: reasonMatch ? reasonMatch[1].trim().replace(/\.$/, '') : null,
    };
  }
  return status;
}

async function main() {
  console.log(`Building data.json — season start ${SEASON_START}`);
  await fetchAll();

  const groups = computeAllGroups(dailyHRs);
  const dueRows = computeDueRows();

  console.log('Checking for rookie debuts and recent call-ups...');
  const prospects = await computeProspects();

  console.log('Checking injured-list status...');
  const injuryStatus = await fetchInjuryStatus();

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
    teamGameDays, groups, dueRows, prospects, injuryStatus,
  };

  const fs = await import('node:fs');
  fs.writeFileSync(new URL('../data.json', import.meta.url), JSON.stringify(output));
  console.log(`Wrote data.json — ${allDates.length} game days, ${totalHRCount} HRs, ${dueRows.length} due rows, ${prospects.debutBombs.length} debut bombs, ${prospects.justCalledUp.length} just called up`);
}

main().catch(e => { console.error(e); process.exit(1); });
