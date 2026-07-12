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
const venueGameDays   = {};  // venue name -> date -> gameCount
const venueHRsByDate  = {};  // venue name -> date -> total HRs (both teams), e.g. Sutter Health Park (A's
                              // current home), Las Vegas Ballpark / Estadio Alfredo Harp Helu (special series)
                              // — pulled straight from each game's actual venue, never a hardcoded team->park map,
                              // since the A's haven't played "at home" in Oakland since 2024

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
  const venueByGame = {};
  finalGames.forEach(g => { venueByGame[g.gamePk] = g.venue?.name || null; });
  ids.forEach(id => fetchedGameIds.add(id));
  if (!ids.length) return;
  dailyGames[date] = (dailyGames[date] || 0) + ids.length;

  await Promise.all(ids.map(async id => {
    try {
      const box = await fetch(`${MLB}/game/${id}/boxscore`).then(r => r.json());
      const venue = venueByGame[id];
      if (venue) {
        if (!venueGameDays[venue]) venueGameDays[venue] = {};
        venueGameDays[venue][date] = (venueGameDays[venue][date] || 0) + 1;
      }
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
          if (venue) {
            if (!venueHRsByDate[venue]) venueHRsByDate[venue] = {};
            venueHRsByDate[venue][date] = (venueHRsByDate[venue][date] || 0) + hrs;
          }
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

// Core due-row math shared by the live list and the as-of reconstruction below.
// The caller supplies the date-scoped inputs (season totals, last HR/game, HR
// dates, inactivity); this applies the gates and the z/dueScore formula.
function dueRowFor(pid, { hrs, abs, lastHR, lastGame, hrDates, inactiveDays, lastAgo }) {
  if (hrs < DUE_MIN_HRS || abs < DUE_MIN_ABS) return null;
  const seasonAbPerHR = abs / hrs;
  if (seasonAbPerHR > DUE_MAX_AB_PER_HR) return null;
  if (!lastHR) return null;
  if (!lastGame || inactiveDays > DUE_MAX_INACTIVE_DAYS) return null; // likely injured/benched/demoted
  const droughtABs = abs - cumAbsThrough(pid, lastHR);
  if (droughtABs < DUE_MIN_DROUGHT_ABS) return null;
  const intervals = [];
  for (let i = 1; i < hrDates.length; i++) {
    const gap = cumAbsThrough(pid, hrDates[i]) - cumAbsThrough(pid, hrDates[i-1]);
    if (gap > 0) intervals.push(gap);
  }
  // Longest gap of the season so far, for display only — kept out of avgGap/stdGap
  // (and thus z/dueScore) below so it doesn't change how "due" anyone is ranked,
  // it just adds context once they're already on the list. Includes the season-
  // opening gap (Opening Day through his first HR), since a slow start is a real
  // drought too even though it's not a "gap between two HRs."
  const leadGap = hrDates.length ? cumAbsThrough(pid, hrDates[0]) : 0;
  const longestPriorGap = Math.max(leadGap, ...intervals, 0);
  let avgGap, stdGap;
  if (intervals.length >= 2)       { avgGap = avg(intervals); stdGap = sampleStd(intervals); }
  else if (intervals.length === 1) { avgGap = (intervals[0] + seasonAbPerHR) / 2; stdGap = avgGap * 0.35; }
  else                              { avgGap = seasonAbPerHR; stdGap = seasonAbPerHR * 0.35; }
  if (!stdGap || stdGap < 1) stdGap = Math.max(avgGap * 0.35, 1);
  const z = (droughtABs - avgGap) / stdGap;
  if (z < DUE_MIN_Z) return null;

  // Raw z rewards mechanical consistency (low std dev) regardless of whether
  // the guy is an established power threat — a 3-HR part-timer with freakishly
  // even gaps can out-z a 25-HR slugger. dueScore weights z by HR volume (proven
  // bopper, sqrt-scaled so it doesn't run away) and by how many historical gaps
  // it's actually based on (2 gaps — the minimum possible here — is a guess, not
  // a pattern).
  const powerWeight      = Math.sqrt(hrs / DUE_MIN_HRS);
  const confidenceWeight = Math.min(1, intervals.length / 3);
  const dueScore = z * powerWeight * confidenceWeight;

  return { pid, name: playerNames[pid] || pid, team: playerTeams[pid] || '', hrs, seasonAbPerHR,
    avgGap, droughtABs, stdGap, z, dueScore, rawDueScore: dueScore, lastHR, lastAgo, lastGame,
    intervals, hrDates, longestPriorGap, isLongestEver: droughtABs >= longestPriorGap };
}

function computeDueRows() {
  const rows = [];
  for (const pid of Object.keys(hrTotals)) {
    const lastGame = playerLastGame[pid];
    const row = dueRowFor(pid, {
      hrs: hrTotals[pid],
      abs: playerABs[pid] || 0,
      lastHR: playerLastHR[pid],
      lastGame,
      hrDates: hrDatesFor(pid),
      inactiveDays: lastGame ? daysSince(lastGame) : Infinity,
      lastAgo: playerLastHR[pid] ? daysSince(playerLastHR[pid]) : null,
    });
    if (row) rows.push(row);
  }
  rows.sort((a,b) => b.dueScore - a.dueScore || b.z - a.z);
  return rows;
}

// Reconstruct the due list as it would have appeared ON a past date — built
// only from games strictly before `asOf`, mirroring how the live list lags a
// day behind (Final games only). Used to backfill dueHistory for days before
// tracking existed and to self-heal gaps if the cron misses a day. One known
// difference from the list users actually saw: scores here are raw (no ±15%
// contact-quality nudge), since that would need per-date Statcast pulls.
function computeDueRowsAsOf(asOf) {
  const hrsBy = {}, hrDatesBy = {}, lastHRBy = {};
  for (const date of Object.keys(dailyHRs).sort()) {
    if (date >= asOf) continue;
    for (const [pid, n] of Object.entries(dailyHRs[date])) {
      hrsBy[pid] = (hrsBy[pid] || 0) + n;
      (hrDatesBy[pid] ??= []).push(date);
      lastHRBy[pid] = date;
    }
  }
  const rows = [];
  for (const pid of Object.keys(hrsBy)) {
    const byDate = playerAbsByDate[pid] ?? {};
    let abs = 0, lastGame = null;
    for (const d of Object.keys(byDate)) {
      if (d >= asOf) continue;
      abs += byDate[d];
      if (!lastGame || d > lastGame) lastGame = d;
    }
    const dayMs = 86400000;
    const row = dueRowFor(pid, {
      hrs: hrsBy[pid],
      abs,
      lastHR: lastHRBy[pid],
      lastGame,
      hrDates: hrDatesBy[pid],
      inactiveDays: lastGame ? Math.round((new Date(asOf) - new Date(lastGame)) / dayMs) : Infinity,
      lastAgo: Math.round((new Date(asOf) - new Date(lastHRBy[pid])) / dayMs),
    });
    if (row) rows.push(row);
  }
  rows.sort((a,b) => b.dueScore - a.dueScore || b.z - a.z);
  return rows;
}

// Estimate the date a due row first crossed the list's entry gate — the earliest
// date after his last HR where his drought reached both DUE_MIN_DROUGHT_ABS and
// z >= DUE_MIN_Z (i.e. droughtABs >= avgGap + DUE_MIN_Z*stdGap). Uses his
// *current* avgGap/stdGap rather than replaying how they evolved day by day, so
// it's an approximation — but it's only used to seed "days on the list" for
// players who were already due before tracking existed, and to score a
// graduation that happens before a streak was recorded. Once seeded, real
// streaks are carried forward build to build and never re-estimated.
function estimateDueSince(row) {
  const byDate = playerAbsByDate[row.pid];
  if (!byDate || !row.lastHR) return null;
  const gate = Math.max(DUE_MIN_DROUGHT_ABS, (row.avgGap ?? 0) + DUE_MIN_Z * (row.stdGap ?? 0));
  let cum = 0;
  for (const date of Object.keys(byDate).sort()) {
    if (date <= row.lastHR) continue;
    cum += byDate[date];
    if (cum >= gate) return date;
  }
  return null;
}

// ── Contact quality: is a "due" guy's recent drought just bad luck, or has
// his actual contact gotten worse too? ──
// AB-gap math alone can't tell the difference between a guy still scalding
// the ball who just hasn't connected at the right angle, and a guy who's
// genuinely seeing/hitting it worse lately. Baseball Savant's Statcast Search
// (the same backend that powers its public CSV export — undocumented, but
// it's the only public source for exit velo/launch angle/barrels; MLB Stats
// API doesn't have these at all) gives us real batted-ball data we can split
// into "season" vs "since his last HR" ourselves.
// Baseball Savant sits behind Cloudflare and sometimes returns an HTML error
// page (with status 200) to requests that look like bots — which GitHub
// Actions very much does. Two mitigations:
//   1. Browser-like headers (User-Agent, Accept, Referer) so Cloudflare lets
//      the request through rather than serving a JS-challenge page.
//   2. Retry up to 3 times with brief backoff; a transient block or rate-limit
//      usually clears within a few seconds.
// If all retries fail the caller gets an empty array and the feature degrades
// gracefully (contact factor stays null) rather than crashing the build.
async function savantFetch(url, retries = 3) {
  const headers = {
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
    'Referer': 'https://baseballsavant.mlb.com/',
  };
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, { headers });
      const text = await res.text();
      // Cloudflare challenge / error pages start with '<!DOCTYPE' or '<html'
      if (text.trimStart().startsWith('<')) {
        console.warn(`  Savant returned HTML (attempt ${attempt}/${retries}) — retrying...`);
        if (attempt < retries) await new Promise(r => setTimeout(r, 2000 * attempt));
        continue;
      }
      return text;
    } catch (e) {
      console.warn(`  Savant fetch error (attempt ${attempt}/${retries}): ${e.message}`);
      if (attempt < retries) await new Promise(r => setTimeout(r, 2000 * attempt));
    }
  }
  console.warn('  Savant fetch failed after all retries — contact data will be empty for this batch.');
  return '';
}

function parseCsv(text) {
  const lines = text.replace(/^﻿/, '').split('\n').filter(Boolean);
  const parseLine = line => {
    const out = []; let cur = '', inQ = false;
    for (const c of line) {
      if (c === '"') { inQ = !inQ; continue; }
      if (c === ',' && !inQ) { out.push(cur); cur = ''; continue; }
      cur += c;
    }
    out.push(cur);
    return out;
  };
  const header = parseLine(lines[0]);
  return lines.slice(1).map(line => {
    const vals = parseLine(line), row = {};
    header.forEach((h, i) => { row[h] = vals[i]; });
    return row;
  });
}

// Savant's CSV search endpoint hard-caps every request at 25,000 rows and
// silently truncates the OLDEST data past that — a full 16-game candidate pool
// (~180 batters × ~140 pitch-detail rows) blows past it, so each batter's
// HR-pitch profile and contact stats were being built from only their most
// recent games (e.g. Wood showing 13 of 24 HRs, missing his March fastballs).
// Chunk small enough that even a heavy pool stays well under the cap, then
// concatenate — the callers already bucket rows by batter, so order is moot.
const BATTED_BALLS_BATCH = 60; // ~8k rows/request, comfortable margin under 25k
async function fetchBattedBallsChunk(pids) {
  const lookup = pids.map(pid => `&batters_lookup%5B%5D=${pid}`).join('');
  const url = `https://baseballsavant.mlb.com/statcast_search/csv?all=true&hfGT=R%7C&hfSea=${SEASON_YEAR}%7C` +
    `&player_type=batter&game_date_gt=${SEASON_START}&game_date_lt=${todayET()}&group_by=name&min_pitches=0` +
    `&min_results=0&type=details&hfBBT=ground_ball%7Cline_drive%7Cfly_ball%7Cpopup%7C${lookup}`;
  const text = await savantFetch(url);
  return text ? parseCsv(text) : [];
}
async function fetchBattedBalls(pids) {
  if (!pids.length) return [];
  const batches = chunk(pids, BATTED_BALLS_BATCH);
  const results = await Promise.all(batches.map(fetchBattedBallsChunk));
  return results.flat();
}

// Sweet Spot% = launch angle 8-32°, Statcast's standard window for the
// trajectory that actually has a shot at clearing the fence — exit velo
// and "hard-hit%" are both blind to launch angle, so a hitter could be
// scalding line drives or grounders and look "better" on those alone with
// zero home-run-shaped contact. Barrel%, Sweet Spot%, and avg EV are all
// kept here for the modal's display (people read those more easily than a
// 1-6 grade), but none of them drive the score directly anymore — see
// avgContactQ below and the comment in attachContactQuality.
function battedBallStats(rows) {
  const valid = rows.filter(r => !isNaN(parseFloat(r.launch_speed)));
  if (!valid.length) return null;
  const evs = valid.map(r => parseFloat(r.launch_speed));
  const las = valid.map(r => parseFloat(r.launch_angle)).filter(v => !isNaN(v));
  const lsas = valid.map(r => parseFloat(r.launch_speed_angle)).filter(v => !isNaN(v) && v >= 1 && v <= 6);
  const hardHit = evs.filter(v => v >= 95).length;
  const barrels = valid.filter(r => r.launch_speed_angle === '6').length;
  const sweetSpot = las.filter(v => v >= 8 && v <= 32).length;
  return {
    n: valid.length,
    barrels,
    avgEV: avg(evs),
    avgLA: las.length ? avg(las) : null,
    hardHitPct: 100 * hardHit / valid.length,
    barrelPct: 100 * barrels / valid.length,
    sweetSpotPct: las.length ? 100 * sweetSpot / las.length : null,
    // Statcast's own per-batted-ball contact-quality grade (1=Weak, 2=Topped,
    // 3=Under, 4=Flare/Burner, 5=Solid Contact, 6=Barrel) — already a joint
    // calibration of EV+LA against real outcomes, so averaging it gives one
    // composite score instead of re-measuring EV and LA a second and third
    // time via avgEV/sweetSpotPct (which is what the old formula did).
    avgContactQ: lsas.length ? avg(lsas) : null,
    contactQN: lsas.length,
  };
}

// Contact factor nudges dueScore rather than overriding it — the AB-gap z
// stays the primary signal, this just tempers it when recent contact quality
// has genuinely diverged from the season norm.
//
// Earlier version blended barrelPct + sweetSpotPct + avgEV as three weighted
// "votes," but barrel% is itself an AND-threshold on EV and launch angle, so
// that blend was really just EV and LA double- and triple-counted under
// different names — and barrel% specifically, being a strict all-or-nothing
// zone, qualifies so few batted balls per drought (commonly 0-3) that its
// rate is mostly noise: going from 1 to 2 barrels reads as "+100%" even
// though it's one swing of randomness. Using avgContactQ (Statcast's 1-6
// grade per batted ball, see battedBallStats) fixes both problems at once —
// one composite number instead of three correlated proxies, averaged across
// every batted ball instead of counting a rare event, so it moves gently
// instead of swinging on a single swing.
//
// Still shrink the drought average toward the baseline rate before taking
// the ratio: even an averaged 1-6 grade over ~15-30 batted balls has real
// sampling noise, and blending in CONTACT_SHRINK_K pseudo-batted-balls at
// the baseline rate keeps a thin drought sample from swinging the result as
// hard as the raw average would.
const CONTACT_MIN_DROUGHT_BBE = 8;
const CONTACT_SHRINK_K = 20;
async function attachContactQuality(dueRows) {
  const allBalls = await fetchBattedBalls(dueRows.map(r => r.pid));
  const byPid = {};
  for (const row of allBalls) { (byPid[row.batter] ??= []).push(row); }

  for (const r of dueRows) {
    const balls = byPid[r.pid] ?? [];
    // baseline = before the drought started, drought = since his last HR.
    // These must NOT overlap: a drought is a stretch with zero HRs, and
    // barrels are the batted-ball type most likely to produce one, so any
    // baseline that includes the drought itself will mechanically look
    // "better" than the drought no matter what — that's not a real signal,
    // just restating the premise that he hasn't homered lately.
    // Also exclude his own home-run swings from the baseline: a HR is
    // virtually always a "barrel," so a baseline that includes N home runs
    // out of ~150-200 batted balls has its barrel rate structurally
    // inflated by the very thing the drought mechanically can't have any
    // of — same bias as the date-overlap issue, just via outcome instead
    // of date. Excluding them compares like-for-like: non-HR contact quality
    // before the drought vs during it.
    const baselineBalls = balls.filter(b => b.game_date <= r.lastHR && b.events !== 'home_run');
    const droughtBalls = balls.filter(b => b.game_date > r.lastHR);
    const baseline = battedBallStats(baselineBalls);
    const drought = battedBallStats(droughtBalls);
    r.contact = { baseline, drought };
    // Most recent barrel, full season — a HR is itself a barrel, so this is
    // never older than lastHR; during a drought it answers "is he still
    // squaring anything up, and how recently?"
    r.lastBarrel = balls.reduce((m, b) => (b.launch_speed_angle === '6' && b.game_date > (m ?? '')) ? b.game_date : m, null);
    if (!baseline || !drought || drought.n < CONTACT_MIN_DROUGHT_BBE || !baseline.avgContactQ || !drought.avgContactQ) continue;

    const shrunkDroughtQ = (drought.avgContactQ * drought.contactQN + baseline.avgContactQ * CONTACT_SHRINK_K) / (drought.contactQN + CONTACT_SHRINK_K);
    const contactRatio = shrunkDroughtQ / baseline.avgContactQ;
    r.contactFactor = Math.max(0.85, Math.min(1.15, contactRatio));
    r.dueScore = r.rawDueScore * r.contactFactor;
  }
  dueRows.sort((a,b) => b.dueScore - a.dueScore || b.z - a.z);
  return dueRows;
}

// ── Picks: today's best HR matchups ───────────────────────────────────
// Distinct from Due on purpose — Due flags an overdue drought regardless of
// today's matchup; Picks ranks today's confirmed-lineup batters purely on
// how good *today's specific matchup* is: recent contact quality, platoon
// edge (both sides — is this a good matchup for the batter AND is this
// pitcher specifically vulnerable to this side), pitch-type overlap between
// what the batter homers off and what the pitcher actually throws, and park.
const PICKS_MIN_HR        = 3;   // server-side floor — client applies its own adjustable threshold on top
const PICKS_MIN_SCORE     = 7;   // ship anything reasonable; client defaults to 9+ but lets users loosen it
const PICKS_RATIO_MIN     = 0.7;
const PICKS_RATIO_MAX     = 1.4;
const BASE_POWER_SHRINK_AB = 100; // pseudo-ABs of league-average prior; half-regressed at 100 AB, lightly at 300+
// Platoon splits are HR-based rate stats, and HRs are rare enough that a
// hard "minimum PA/IP, then trust it fully" gate still let small samples
// swing wildly once they cleared the bar (1 HR vs 4 HR over ~50 PA each
// pinned 66% of batter ratios and 60% of pitcher ratios at the clamp ceiling
// in testing — the same failure mode as Due's barrel% bug). Shrinking each
// side's rate toward the player's own overall rate before taking the ratio
// fixes it the same way: a thin split sample gets pulled back toward "no
// real difference yet" instead of being taken at face value.
// These weights look large, but HR are rare enough (~3-4% of PA) that even
// a few hundred PA of "evidence" barely outweighs them — tested k=40 still
// left roughly half of all batter ratios pinned at the clamp, and didn't
// meaningfully improve until k reached the few-hundred range. At these
// weights only players with genuinely large platoon samples (a near-full
// season's worth vs both hands) can move far from the league-average
// platoon effect, which is the honest outcome when single-season HR-rate
// splits this thin don't support much more precision than that.
const PLATOON_SHRINK_PA = 400; // pseudo-PA weight, batter platoon splits
const PLATOON_SHRINK_IP = 100; // pseudo-IP weight, pitcher platoon splits
function shrunkRate(events, sample, priorRate, k) {
  return (events + priorRate * k) / (sample + k);
}

// Generic vs-L/vs-R platoon split fetch, batched in one request regardless
// of how many ids — confirmed this endpoint handles 300+ personIds fine
// (unlike the Statcast CSV export, which silently truncates past a row cap).
async function fetchPlatoonSplits(ids, group) {
  if (!ids.length) return {};
  try {
    const res = await fetch(`${MLB}/people?personIds=${ids.join(',')}&hydrate=stats(group=[${group}],type=[statSplits],sitCodes=[vl,vr])`).then(r => r.json());
    const out = {};
    for (const p of res.people ?? []) {
      const splits = p.stats?.[0]?.splits ?? [];
      const vl = splits.find(s => s.split?.code === 'vl')?.stat;
      const vr = splits.find(s => s.split?.code === 'vr')?.stat;
      out[String(p.id)] = {
        hand: group === 'pitching' ? (p.pitchHand?.code ?? null) : (p.batSide?.code ?? null),
        vsL: vl ? { hr: vl.homeRuns ?? 0, pa: (vl.atBats ?? 0) + (vl.baseOnBalls ?? 0), ip: parseFloat(vl.inningsPitched) || 0, hr9: parseFloat(vl.homeRunsPer9) || 0 } : null,
        vsR: vr ? { hr: vr.homeRuns ?? 0, pa: (vr.atBats ?? 0) + (vr.baseOnBalls ?? 0), ip: parseFloat(vr.inningsPitched) || 0, hr9: parseFloat(vr.homeRunsPer9) || 0 } : null,
      };
    }
    return out;
  } catch (e) { return {}; }
}

// "Recent form" reuses the same Statcast 1-6 contact-quality grade as Due's
// contact factor, but the window is time-based (last 15 game-dates) instead
// of drought-anchored — Picks isn't about droughts, it's about how he's
// hitting the ball right now, full stop.
const PICKS_RECENT_GAME_DATES = 15;
const PICKS_MIN_RECENT_BBE    = 8;
function computeRecentFormRatio(balls) {
  const dates = [...new Set(balls.map(b => b.game_date))].sort();
  if (dates.length < 5) return null;
  const recentSet = new Set(dates.slice(Math.max(0, dates.length - PICKS_RECENT_GAME_DATES)));
  const recentBalls   = balls.filter(b => recentSet.has(b.game_date));
  const baselineBalls = balls.filter(b => !recentSet.has(b.game_date));
  const recent   = battedBallStats(recentBalls);
  const baseline = battedBallStats(baselineBalls);
  if (!recent || !baseline || recent.contactQN < PICKS_MIN_RECENT_BBE || !baseline.avgContactQ || !recent.avgContactQ) return null;
  const shrunkRecentQ = (recent.avgContactQ * recent.contactQN + baseline.avgContactQ * CONTACT_SHRINK_K) / (recent.contactQN + CONTACT_SHRINK_K);
  return Math.max(0.85, Math.min(1.15, shrunkRecentQ / baseline.avgContactQ));
}

// What pitch types has this guy actually gone deep on this season? Top 3,
// by share of his home runs — the other half of the pitch-type matchup
// (the pitcher's mix) reuses fetchPitchMix, already built for bullpens.
function computeHRPitchProfile(balls) {
  const hrBalls = balls.filter(b => b.events === 'home_run' && b.pitch_name);
  if (!hrBalls.length) return [];
  const counts = {};
  for (const b of hrBalls) counts[b.pitch_name] = (counts[b.pitch_name] ?? 0) + 1;
  return Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([name, n]) => ({ name, pct: Math.round(100 * n / hrBalls.length), n }));
}

// A batter's HR-pitch profile is only as trustworthy as the number of HRs it's
// built from: 3-of-4 on fastballs is a coin flip that says almost nothing,
// while 30-of-40 is a real tendency the pitcher has to worry about. Both look
// identical as a percentage, so the raw synergy overlap treats them the same
// and both slam into the +1.40 clamp. This regresses a synergy ratio toward
// neutral (1.0 = no special pitch-matchup edge) by HR sample size — same
// shrink shape as the platoon splits — so a 4-HR hitter can't ride a fluky
// overlap to #1 the way a genuine slugger with the same overlap legitimately
// can. Confidence approaches 1 as a batter piles up real HRs.
const SYNERGY_HR_FULL = 10; // pseudo-HRs; ~this many before the profile is taken near full strength
function synergyConfidenceFor(hrs) { return hrs / (hrs + SYNERGY_HR_FULL); }
function regressSynergyRatio(ratio, hrs) { return 1 + (ratio - 1) * synergyConfidenceFor(hrs); }
// Overlap between "pitches he homers on" and "pitches this guy throws" —
// e.g. batter hits 50% of his HRs off sliders, today's pitcher throws 40%
// sliders, overlap credit = 0.5 * 0.4 * 100 = 20. Summed across shared types.
function pitchSynergyScore(hrProfile, pitcherMix) {
  if (!hrProfile.length || !pitcherMix?.length) return 0;
  const usage = {};
  for (const m of pitcherMix) usage[m.name] = m.pct;
  let score = 0;
  for (const b of hrProfile) score += (b.pct * (usage[b.name] ?? 0)) / 100;
  return score;
}

// How much of the pitcher-side signal comes from the starter vs the pen is
// driven by how deep THIS starter actually goes: his avg innings per start
// over the season (a workhorse averaging 6.5+ IP leaves the pen ~2 innings;
// a 4.5-IP guy hands nearly half the game to relievers). Clamped so neither
// side ever fully vanishes — even a 9-inning machine gets pulled sometimes,
// and even an opener's team uses SOME starter innings. STARTER_WEIGHT is the
// flat fallback when the starter has no starts on record yet.
const STARTER_WEIGHT = 0.55;
const STARTER_SHARE_MIN = 0.45;
const STARTER_SHARE_MAX = 0.85;
function ipToFloat(ip) { // "88.1" = 88 innings + 1 out, not 88.1
  const [whole, outs] = String(ip ?? '0').split('.');
  return (+whole || 0) + (+(outs || 0)) / 3;
}
function starterShareFor(stat) {
  if (!stat || stat.avgStartIP == null) return STARTER_WEIGHT;
  return Math.max(STARTER_SHARE_MIN, Math.min(STARTER_SHARE_MAX, stat.avgStartIP / 9));
}

async function computePicks(todaySchedule, bullpensMap, pitcherSeasonStats = {}, openerBulk = {}, weatherByVenue = {}) {
  try {
    // Identify a team's likely everyday starters when the official lineup
    // hasn't posted yet. Uses season-long data: guys who've appeared in at
    // least 15 games, average 1.5+ AB/game (filters pitchers out naturally
    // under universal DH), have some power this season, and showed up in a
    // game within the last 7 days (catches injuries/demotions without needing
    // the IL feed, which runs AFTER this function in main()).
    function projectedLineup(teamAbbr) {
      return Object.keys(playerTeams)
        .filter(pid =>
          playerTeams[pid] === teamAbbr &&
          (playerGames[pid] ?? 0) >= 15 &&
          (playerABs[pid] ?? 0) / Math.max(playerGames[pid] ?? 1, 1) >= 1.5 &&
          (hrTotals[pid] ?? 0) >= PICKS_MIN_HR &&
          daysSince(playerLastGame[pid] || '2000-01-01') <= 7
        )
        .sort((a, b) => (playerGames[b] ?? 0) - (playerGames[a] ?? 0))
        .slice(0, 9)
        .map(pid => ({ pid, name: playerNames[pid] || pid, position: '', order: 0 }));
    }

    const candidates = [];
    for (const g of todaySchedule) {
      for (const [me, opp] of [[g.home, g.away], [g.away, g.home]]) {
        if (!opp.probablePitcherId) continue; // need a pitcher to score the matchup
        const batters = me.lineup.length
          ? me.lineup.map(p => ({ ...p, projected: false }))
          : projectedLineup(me.teamAbbr).map(p => ({ ...p, projected: true }));
        for (const p of batters) {
          if (p.position === 'P') continue;
          if ((hrTotals[p.pid] ?? 0) < PICKS_MIN_HR) continue;
          if ((playerABs[p.pid] ?? 0) < 20) continue;
          candidates.push({ pid: p.pid, team: me.teamAbbr, oppTeam: opp.teamAbbr, oppPid: opp.probablePitcherId, oppName: opp.probablePitcher, venue: g.venue, projected: p.projected });
        }
      }
    }
    if (!candidates.length) return [];
    const seen = new Set();
    const uniq = candidates.filter(c => seen.has(c.pid) ? false : (seen.add(c.pid), true));

    const batterIds  = uniq.map(c => c.pid);
    // Likely bulk arms behind openers ride along in the pitcher fetches so
    // they get real platoon splits and a real pitch mix, same as starters.
    const bulkPids   = Object.values(openerBulk).map(o => o.bulk?.pid).filter(Boolean);
    const pitcherIds = [...new Set([...uniq.map(c => c.oppPid), ...bulkPids])];

    const [batterSplits, pitcherSplits, batterBalls, pitcherMixByPid] = await Promise.all([
      fetchPlatoonSplits(batterIds, 'hitting'),
      fetchPlatoonSplits(pitcherIds, 'pitching'),
      fetchBattedBalls(batterIds),
      fetchPitchMix(pitcherIds),
    ]);
    const ballsByPid = {};
    for (const row of batterBalls) (ballsByPid[row.batter] ??= []).push(row);

    // League-wide platoon baselines, pooled across this build's own candidate
    // pool (same self-calibration idea as the chalk meter's "regular player"
    // threshold) — used as the shrinkage prior instead of each player's own
    // overall rate, since a guy with 5 HRs this season doesn't have enough
    // volume in HIS split to anchor against.
    //
    // First attempt pooled raw vs-L/vs-R splits regardless of each batter's
    // own handedness, which washes the real platoon effect out almost
    // completely: lefty batters do better vs RHP and worse vs LHP, righties
    // the opposite, so pooled together they nearly cancel (tested: 0.0348 vs
    // 0.0365, basically nothing to shrink toward). The actual platoon effect
    // lives in "same-handed-as-the-batter" vs "opposite-handed," not in raw
    // vs-L/vs-R — so pool it that way instead, using each player's own
    // batSide/pitchHand to classify which of their two splits is which.
    // Switch hitters always swing opposite the pitcher's hand by design, so
    // both of their splits count as "opposite-handed," never "same."
    let totalHRsame = 0, totalPAsame = 0, totalHRopp = 0, totalPAopp = 0;
    for (const pid of batterIds) {
      const s = batterSplits[pid];
      if (!s) continue;
      if (s.hand === 'L') {
        if (s.vsL) { totalHRsame += s.vsL.hr; totalPAsame += s.vsL.pa; }
        if (s.vsR) { totalHRopp  += s.vsR.hr; totalPAopp  += s.vsR.pa; }
      } else if (s.hand === 'R') {
        if (s.vsR) { totalHRsame += s.vsR.hr; totalPAsame += s.vsR.pa; }
        if (s.vsL) { totalHRopp  += s.vsL.hr; totalPAopp  += s.vsL.pa; }
      } else { // switch hitter — every PA is "opposite-handed" by design
        if (s.vsL) { totalHRopp += s.vsL.hr; totalPAopp += s.vsL.pa; }
        if (s.vsR) { totalHRopp += s.vsR.hr; totalPAopp += s.vsR.pa; }
      }
    }
    const leagueBatterRateSame = totalPAsame ? totalHRsame / totalPAsame : 0;
    const leagueBatterRateOpp  = totalPAopp  ? totalHRopp  / totalPAopp  : 0;

    let totalPHRsame = 0, totalPIPsame = 0, totalPHRopp = 0, totalPIPopp = 0;
    for (const pid of pitcherIds) {
      const s = pitcherSplits[pid];
      if (!s) continue;
      if (s.hand === 'L') {
        if (s.vsL) { totalPHRsame += s.vsL.hr; totalPIPsame += s.vsL.ip; }
        if (s.vsR) { totalPHRopp  += s.vsR.hr; totalPIPopp  += s.vsR.ip; }
      } else if (s.hand === 'R') {
        if (s.vsR) { totalPHRsame += s.vsR.hr; totalPIPsame += s.vsR.ip; }
        if (s.vsL) { totalPHRopp  += s.vsL.hr; totalPIPopp  += s.vsL.ip; }
      }
    }
    const leaguePitcherRateSame = totalPIPsame ? totalPHRsame / totalPIPsame : 0;
    const leaguePitcherRateOpp  = totalPIPopp  ? totalPHRopp  / totalPIPopp  : 0;

    const totalGames = Object.values(dailyGames).reduce((a, b) => a + b, 0);
    const totalHRs   = Object.values(dailyHRs).reduce((sum, day) => sum + Object.values(day).reduce((a, b) => a + b, 0), 0);
    const leagueHRPerGame = totalGames ? totalHRs / totalGames : 0;

    // League-wide HR per AB — the prior that a batter's own HR rate is shrunk
    // toward when his AB sample is thin (see basePower below). Summed over
    // every tracked batter so it's the true population rate, not the
    // power-skewed pick pool.
    const leagueTotalAB = Object.values(playerABs).reduce((a, b) => a + b, 0);
    const leagueTotalHR = Object.values(hrTotals).reduce((a, b) => a + b, 0);
    const leagueHRPerAB = leagueTotalAB ? leagueTotalHR / leagueTotalAB : 0.034;

    // Shrunk same-vs-other platoon ratio for any pitcher's splits against a
    // given batter hand — used for today's starter and, on opener days, the
    // likely bulk arm.
    function pitcherPlatoonVs(pInfo, bHand) {
      const effectiveSide = bHand === 'S' ? (pInfo?.hand === 'L' ? 'R' : 'L') : bHand;
      if (!pInfo || !effectiveSide) return null;
      const vsLPrior = pInfo.hand === 'L' ? leaguePitcherRateSame : leaguePitcherRateOpp;
      const vsRPrior = pInfo.hand === 'R' ? leaguePitcherRateSame : leaguePitcherRateOpp;
      const shrunkVsL = pInfo.vsL ? shrunkRate(pInfo.vsL.hr, pInfo.vsL.ip, vsLPrior, PLATOON_SHRINK_IP) : null;
      const shrunkVsR = pInfo.vsR ? shrunkRate(pInfo.vsR.hr, pInfo.vsR.ip, vsRPrior, PLATOON_SHRINK_IP) : null;
      const sameSplit  = effectiveSide === 'L' ? shrunkVsL : shrunkVsR;
      const otherSplit = effectiveSide === 'L' ? shrunkVsR : shrunkVsL;
      if (sameSplit == null || otherSplit == null || !(otherSplit > 0)) return null;
      return Math.max(PICKS_RATIO_MIN, Math.min(PICKS_RATIO_MAX, sameSplit / otherSplit));
    }

    const rows = [];
    for (const c of uniq) {
      const abs = playerABs[c.pid] ?? 0, hrs = hrTotals[c.pid] ?? 0;
      // Raw HR/AB is the foundation of the pick score, but off a thin AB
      // sample it's as unreliable as the pitch profile — 4 HR in 51 AB reads
      // as an elite .078 rate that a full season rarely sustains. Shrink it
      // toward the league HR/AB prior weighted by AB, same Bayesian move as
      // the platoon splits: a 51-AB hitter gets pulled most of the way to
      // league average, a 300+-AB hitter barely moves. Keeps low-HR guys on
      // the board (per design) without letting a tiny hot streak top it.
      const rawBasePower = hrs / abs;
      const basePower = shrunkRate(hrs, abs, leagueHRPerAB, BASE_POWER_SHRINK_AB);
      const balls = ballsByPid[c.pid] ?? [];

      const recentFormRatio = computeRecentFormRatio(balls);
      const hrProfile = computeHRPitchProfile(balls);

      const pInfo = pitcherSplits[c.oppPid] ?? null;
      const pHand = pInfo?.hand ?? null;
      const bInfo = batterSplits[c.pid] ?? null;

      // Shrink each of the batter's two splits toward the prior that matches
      // *that split's own* same/opposite-handed classification (relative to
      // his own batSide) before comparing today's relevant split against the
      // other — not toward a flat vs-L/vs-R prior, which has no real platoon
      // signal once pooled across both lefty and righty batters.
      let batterPlatoonRatio = null;
      if (bInfo && pHand) {
        const vsLPrior = bInfo.hand === 'L' ? leagueBatterRateSame : leagueBatterRateOpp;
        const vsRPrior = bInfo.hand === 'R' ? leagueBatterRateSame : leagueBatterRateOpp;
        const shrunkVsL = bInfo.vsL ? shrunkRate(bInfo.vsL.hr, bInfo.vsL.pa, vsLPrior, PLATOON_SHRINK_PA) : null;
        const shrunkVsR = bInfo.vsR ? shrunkRate(bInfo.vsR.hr, bInfo.vsR.pa, vsRPrior, PLATOON_SHRINK_PA) : null;
        const todaySplit = pHand === 'L' ? shrunkVsL : shrunkVsR;
        const otherSplit = pHand === 'L' ? shrunkVsR : shrunkVsL;
        if (todaySplit != null && otherSplit != null && otherSplit > 0) {
          batterPlatoonRatio = Math.max(PICKS_RATIO_MIN, Math.min(PICKS_RATIO_MAX, todaySplit / otherSplit));
        }
      }

      const bHand = bInfo?.hand ?? null;
      const pitcherPlatoonRatio = pitcherPlatoonVs(pInfo, bHand);

      const venueGames = Object.values(venueGameDays[c.venue] ?? {}).reduce((a, b) => a + b, 0);
      const venueHRs   = Object.values(venueHRsByDate[c.venue] ?? {}).reduce((a, b) => a + b, 0);
      const parkHRG    = venueGames ? venueHRs / venueGames : leagueHRPerGame;
      const parkRatio  = leagueHRPerGame ? Math.max(PICKS_RATIO_MIN, Math.min(PICKS_RATIO_MAX, parkHRG / leagueHRPerGame)) : 1;

      const synergyScore = pitchSynergyScore(hrProfile, pitcherMixByPid[c.oppPid]);

      rows.push({
        pid: c.pid, team: c.team, oppTeam: c.oppTeam, hrs, abs,
        oppPid: c.oppPid, oppName: c.oppName, oppHand: pHand, venue: c.venue,
        projected: c.projected ?? false,
        bHand, basePower, rawBasePower, recentFormRatio, batterPlatoonRatio, pitcherPlatoonRatio, parkRatio,
        hrProfile, pitcherMix: pitcherMixByPid[c.oppPid] ?? [], synergyScore,
      });
    }

    // Pitch-type synergy is on its own raw 0-100ish scale, not a ratio, so
    // normalize it against the median synergy score across today's actual
    // candidate pool rather than a guessed constant — self-calibrating the
    // same way the chalk meter's "regular player" threshold is, instead of
    // assuming what a "typical" overlap looks like.
    const synergyScores = rows.map(r => r.synergyScore).filter(s => s > 0).sort((a, b) => a - b);
    const medianSynergy = synergyScores.length ? synergyScores[Math.floor(synergyScores.length / 2)] : 0;
    const avgPitcherRate = (leaguePitcherRateSame + leaguePitcherRateOpp) / 2 || 1;

    for (const r of rows) {
      // How much to trust this batter's pitch profile at all, given how many
      // HRs it's built from. Also shipped to the client so the modal can say
      // when a pick's pitch-matchup edge was dialed back for a thin sample.
      r.synergyConfidence = Math.round(synergyConfidenceFor(r.hrs) * 100) / 100;

      const rawSynergyRatio = medianSynergy > 0
        ? Math.max(PICKS_RATIO_MIN, Math.min(PICKS_RATIO_MAX, r.synergyScore > 0 ? r.synergyScore / medianSynergy : 0.9))
        : 1;
      r.synergyRatio = regressSynergyRatio(rawSynergyRatio, r.hrs);

      // Blend starter and bullpen for the two pitcher-side components.
      // Skip fatigued arms (worked yesterday with 25+ pitches — likely unavailable).
      const bullpenArms = (bullpensMap?.[r.oppTeam] ?? []).filter(rel => {
        if (!rel.lastOuting) return true;
        return !(daysSince(rel.lastOuting.date) <= 1 && (rel.lastOuting.pitches ?? 0) >= 25);
      });

      let bullpenPlatoonFactor = null, bullpenSynergyRaw = 0;
      if (bullpenArms.length) {
        let totalW = 0, platoonSum = 0, synergySum = 0;
        for (const rel of bullpenArms) {
          const w = rel.gamesPitched || 1;
          totalW += w;
          // League-prior platoon effect for this reliever vs this batter
          const effectiveSide = r.bHand === 'S' ? (rel.hand === 'L' ? 'R' : 'L') : r.bHand;
          const isSame = rel.hand === effectiveSide;
          platoonSum += ((isSame ? leaguePitcherRateSame : leaguePitcherRateOpp) / avgPitcherRate) * w;
          synergySum += pitchSynergyScore(r.hrProfile, rel.pitchMix) * w;
        }
        bullpenPlatoonFactor = Math.max(PICKS_RATIO_MIN, Math.min(PICKS_RATIO_MAX, platoonSum / totalW));
        bullpenSynergyRaw = synergySum / totalW;
      }
      r.bullpenPlatoonFactor = bullpenPlatoonFactor;
      const rawBullpenSynergyRatio = medianSynergy > 0 && bullpenSynergyRaw > 0
        ? Math.max(PICKS_RATIO_MIN, Math.min(PICKS_RATIO_MAX, bullpenSynergyRaw / medianSynergy))
        : (bullpenSynergyRaw === 0 ? 0.9 : 1);
      r.bullpenSynergyRatio = regressSynergyRatio(rawBullpenSynergyRatio, r.hrs);

      // Blended pitcher signal, weighted by how deep this starter usually
      // goes (avg IP per start) rather than a flat league split — Misiorowski
      // averaging 7 IP means his pen barely matters; a 4.5-IP starter's pen
      // is nearly half the matchup.
      const startStat = r.oppPid ? pitcherSeasonStats[r.oppPid] : null;
      const startAvgIP = startStat?.avgStartIP ?? null;
      r.starterAvgIP = startAvgIP != null ? Math.round(startAvgIP * 10) / 10 : null;

      // Opener day: the announced "starter" covers an inning or two, a likely
      // bulk arm covers the middle, and the pen closes it out — a confirmed
      // opener escapes the normal 45% starter-share floor, and the bulk arm
      // (invisible to both the starter matchup AND the bullpen scan) gets his
      // own slice of the platoon/synergy blend.
      const ob = openerBulk[r.oppTeam];
      const bulk = ob?.bulk ?? null;
      r.openerLikely = !!ob?.openerLikely;

      let sW = starterShareFor(startStat);
      if (r.openerLikely && startAvgIP != null) sW = Math.max(0.12, Math.min(0.35, startAvgIP / 9));
      let bulkW = 0, bulkPlatoon = null, bulkSynergyRatio = null;
      if (r.openerLikely && bulk) {
        bulkW = Math.min(bulk.ipPerApp / 9, (1 - sW) * 0.8);
        bulkPlatoon = pitcherPlatoonVs(pitcherSplits[bulk.pid], r.bHand);
        if (bulkPlatoon == null && bulk.hand && r.bHand) {
          // No real splits fetched — fall back to the league-prior hand
          // effect, same treatment as a pen arm.
          const effSide = r.bHand === 'S' ? (bulk.hand === 'L' ? 'R' : 'L') : r.bHand;
          bulkPlatoon = Math.max(PICKS_RATIO_MIN, Math.min(PICKS_RATIO_MAX,
            (bulk.hand === effSide ? leaguePitcherRateSame : leaguePitcherRateOpp) / avgPitcherRate));
        }
        const bulkSynergyRaw = pitchSynergyScore(r.hrProfile, pitcherMixByPid[bulk.pid]);
        const rawBulkSynergyRatio = medianSynergy > 0 && bulkSynergyRaw > 0
          ? Math.max(PICKS_RATIO_MIN, Math.min(PICKS_RATIO_MAX, bulkSynergyRaw / medianSynergy))
          : (bulkSynergyRaw === 0 ? 0.9 : 1);
        bulkSynergyRatio = regressSynergyRatio(rawBulkSynergyRatio, r.hrs);
        r.bulkPid = bulk.pid; r.bulkName = bulk.name; r.bulkHand = bulk.hand;
        r.bulkIPPerApp = bulk.ipPerApp; r.bulkRestDays = bulk.restDays;
        r.bulkMix = pitcherMixByPid[bulk.pid] ?? [];
      }
      const penW = 1 - sW - bulkW;
      r.starterShare = Math.round(sW * 100) / 100;
      r.bulkShare    = bulkW ? Math.round(bulkW * 100) / 100 : null;

      // Weighted average over whichever components actually have data,
      // renormalized so missing pieces don't drag the blend toward nothing.
      const wavg = parts => {
        const have = parts.filter(([, v]) => v != null);
        const tw = have.reduce((a, [w]) => a + w, 0);
        return tw > 0 ? have.reduce((a, [w, v]) => a + w * v, 0) / tw : null;
      };
      const effectivePitcherPlatoon = wavg([
        [sW, r.pitcherPlatoonRatio], [bulkW, bulkPlatoon], [penW, bullpenPlatoonFactor],
      ]);
      const effectiveSynergy = wavg([
        [sW, r.synergyRatio], [bulkW, bulkSynergyRatio],
        [penW, bullpenPlatoonFactor != null ? r.bullpenSynergyRatio : null],
      ]) ?? r.synergyRatio;

      // Game-time weather (air density + wind), a multiplier next to the park
      // factor. 1.0 for roofed parks and when no forecast is available.
      r.weatherRatio = weatherByVenue[r.venue] ?? 1;

      const factors = [r.recentFormRatio, r.batterPlatoonRatio, effectivePitcherPlatoon, r.parkRatio, effectiveSynergy, r.weatherRatio]
        .filter(f => f != null);
      const contactKnown = r.recentFormRatio != null;
      r.matchupFactor = factors.reduce((a, b) => a * b, contactKnown ? 1 : 0.95);
      r.pickScore = r.basePower * r.matchupFactor * 100;
    }
    rows.sort((a, b) => b.pickScore - a.pickScore);
    return rows.filter(r => r.pickScore >= PICKS_MIN_SCORE);
  } catch (e) { return []; }
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

async function fetchRecentRosterMoves(days, teamIdToAbbr) {
  const end = new Date(), start = new Date();
  start.setUTCDate(start.getUTCDate() - days);
  const fmt = d => d.toISOString().split('T')[0];
  try {
    const res = await fetch(`${MLB}/transactions?startDate=${fmt(start)}&endDate=${fmt(end)}`).then(r => r.json());
    const txns = res.transactions ?? [];
    const callUps = txns
      .filter(t => (t.typeDesc === 'Recalled' || t.typeDesc === 'Selected') && t.person?.id)
      // toTeam is always the MLB club, so resolve it to the same abbreviation
      // used everywhere else (and that team-logo lookups key off of) — but
      // fromTeam is usually a minor league affiliate, which won't be in
      // teamIdToAbbr (that's MLB-only), so leave it as the full name.
      .map(t => ({ pid: String(t.person.id), name: t.person.fullName, fromTeam: t.fromTeam?.name ?? '', toTeam: teamIdToAbbr[t.toTeam?.id] || t.toTeam?.name || '', date: t.date }));
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

async function fetchTeamAbbreviations() {
  try {
    const res = await fetch(`${MLB}/teams?sportId=1`).then(r => r.json());
    const idToAbbr = {}, abbrToId = {};
    for (const t of res.teams ?? []) { idToAbbr[t.id] = t.abbreviation; abbrToId[t.abbreviation] = t.id; }
    return { idToAbbr, abbrToId };
  } catch (e) { return { idToAbbr: {}, abbrToId: {} }; }
}

// The baseball "day" doesn't end at midnight ET — west-coast games routinely
// run past it. Rather than guess a cutoff time, resolve the active date from
// the actual slate: if yesterday's games are still live (ran past midnight),
// we're still on yesterday. Resolved once per build (see main) and cached so
// every synchronous todayET() consumer gets the same answer.
let _activeGameDate = null;
function calDateET() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
}
function shiftDateStr(str, delta) {
  const [y, m, d] = str.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + delta);
  return dt.toISOString().split('T')[0];
}
function todayET() { return _activeGameDate || calDateET(); }
async function resolveActiveGameDate() {
  const cal = calDateET();
  try {
    const prev = shiftDateStr(cal, -1);
    const sched = await fetch(`${MLB}/schedule?sportId=1&date=${prev}&gameType=R`).then(r => r.json());
    const games = sched.dates?.[0]?.games ?? [];
    // Any of yesterday's games still being played (past midnight)? Then the
    // slate isn't over and we're still on that day. Postponed/suspended games
    // aren't "Live", so they don't keep us stuck.
    if (games.some(g => g.status?.abstractGameState === 'Live')) return prev;
  } catch (e) { /* fall back to the calendar date */ }
  return cal;
}

// Powers both the new Schedule tab and the lineup-based call-up/bench
// detection below — one fetch, hydrated with lineups + probable pitchers, so
// the rest of the build never has to hit /schedule for "today" a second time.
// ── Weather → HR carry factor ───────────────────────────────────────────
// Two physical effects, one factor: (1) air density — hot / humid / low-
// pressure / high-altitude air is thinner, so the ball carries; (2) wind
// projected onto the home-plate→CF axis — blowing out helps, in hurts.
// Roofed parks (Retractable/Dome) are treated weather-neutral. Knobs are
// physically motivated, not fit to any one source; the 10m forecast wind is
// dampened to what a fly ball actually feels in the bowl.
const WX_CARRY_EXP    = 1.4;
const WX_WIND_DAMPEN  = 0.55;
const WX_WIND_PER_MPH = 0.010;
const WX_CLAMP        = [0.85, 1.20];
function airDensity(tempF, rh, hpa) {
  const Tc = (tempF - 32) * 5 / 9, T = Tc + 273.15, P = hpa * 100;
  const Psat = 6.1078 * Math.pow(10, (7.5 * Tc) / (Tc + 237.3)) * 100;
  const Pv = (rh / 100) * Psat;
  return (P - Pv) / (287.058 * T) + Pv / (461.495 * T);
}
const WX_RHO0 = airDensity(70, 50, 1013.25); // league-typical baseline density
function windAlongCF(spd, fromDeg, cf) { // + out to CF, - in from CF
  const to = (fromDeg + 180) % 360;
  return spd * Math.cos(((((cf - to + 540) % 360) - 180)) * Math.PI / 180);
}
function windLabelFor(fromDeg, cf) {
  const to = (fromDeg + 180) % 360;
  const d = Math.abs((((cf - to + 540) % 360) - 180));
  return d <= 45 ? 'out' : d >= 135 ? 'in' : 'across';
}
// Attaches g.weather to each game and returns { venueName -> ratio } for Picks.
async function fetchWeather(games) {
  const OM = 'https://api.open-meteo.com/v1/forecast';
  const byVenue = {};
  await Promise.all(games.map(async g => {
    if (g.roofType && g.roofType !== 'Open') { g.weather = { roofed: true, ratio: 1 }; byVenue[g.venue] = 1; return; }
    if (g.lat == null || g.cfAzimuth == null) { g.weather = null; return; }
    try {
      const q = `latitude=${g.lat}&longitude=${g.lon}&hourly=temperature_2m,relative_humidity_2m,surface_pressure,wind_speed_10m,wind_direction_10m&temperature_unit=fahrenheit&wind_speed_unit=mph&timezone=GMT`;
      const wx = await fetch(`${OM}?${q}`).then(r => r.json());
      const h = wx.hourly;
      const i0 = h?.time?.indexOf(g.gameDate.slice(0, 13) + ':00') ?? -1;
      if (i0 < 0) { g.weather = null; return; }
      const idx = [i0, i0 + 1, i0 + 2].filter(i => i < h.time.length);
      const avg = a => a.reduce((x, y) => x + y, 0) / a.length;
      const temp = avg(idx.map(i => h.temperature_2m[i]));
      const rh   = avg(idx.map(i => h.relative_humidity_2m[i]));
      const pres = avg(idx.map(i => h.surface_pressure[i]));
      const carry = Math.pow(WX_RHO0 / airDensity(temp, rh, pres), WX_CARRY_EXP);
      const out = WX_WIND_DAMPEN * avg(idx.map(i => windAlongCF(h.wind_speed_10m[i], h.wind_direction_10m[i], g.cfAzimuth)));
      const uTo = avg(idx.map(i => h.wind_speed_10m[i] * Math.sin(((h.wind_direction_10m[i] + 180) % 360) * Math.PI / 180)));
      const vTo = avg(idx.map(i => h.wind_speed_10m[i] * Math.cos(((h.wind_direction_10m[i] + 180) % 360) * Math.PI / 180)));
      const spd = Math.hypot(uTo, vTo);
      const wdir = (Math.atan2(uTo, vTo) * 180 / Math.PI + 180 + 360) % 360;
      const ratio = Math.max(WX_CLAMP[0], Math.min(WX_CLAMP[1], carry * (1 + WX_WIND_PER_MPH * out)));
      g.weather = {
        roofed: false, ratio: Math.round(ratio * 1000) / 1000,
        temp: Math.round(temp), rh: Math.round(rh),
        windMph: Math.round(spd), windDir: windLabelFor(wdir, g.cfAzimuth),
      };
      byVenue[g.venue] = g.weather.ratio;
    } catch (e) { g.weather = null; }
  }));
  return byVenue;
}

// Per-game Homer Score (0–99): a betting-confidence read on how homer-friendly
// the whole game is, blending what we already track — both lineups' power, both
// starters' HR-proneness, both pens, the park, and the weather. Not a forecast,
// a synthesis of today's inputs. Weighted geometric mean of neutral-centered
// factors so nothing dominates; 50 = league-average game.
const HOMER_W = { bat: 0.28, sp: 0.24, park: 0.20, pen: 0.16, weather: 0.12 };
function computeHomerScores(games, pitcherStats, bullpens) {
  const leagueTotalAB = Object.values(playerABs).reduce((a, b) => a + b, 0);
  const leagueTotalHR = Object.values(hrTotals).reduce((a, b) => a + b, 0);
  const leagueHRPerAB = leagueTotalAB ? leagueTotalHR / leagueTotalAB : 0.034;
  const totalGames = Object.values(dailyGames).reduce((a, b) => a + b, 0);
  const totalHRs = Object.values(dailyHRs).reduce((s, d) => s + Object.values(d).reduce((a, b) => a + b, 0), 0);
  const leagueHRPerGame = totalGames ? totalHRs / totalGames : 1;
  const spHR9 = games.flatMap(g => [g.home.probablePitcherId, g.away.probablePitcherId])
    .map(pid => parseFloat(pitcherStats[pid]?.hr9)).filter(x => x > 0);
  const leagueHR9 = spHR9.length ? spHR9.reduce((a, b) => a + b, 0) / spHR9.length : 1.2;
  const allPenEra = Object.values(bullpens || {}).flat().map(r => parseFloat(r.era)).filter(x => x > 0);
  const leaguePenERA = allPenEra.length ? allPenEra.reduce((a, b) => a + b, 0) / allPenEra.length : 4.1;
  const clampR = (x, lo, hi) => Math.max(lo, Math.min(hi, x));

  // Avg regressed HR/AB of a team's hitters — the set lineup when posted,
  // otherwise everyone on the roster with a real AB sample.
  const teamPower = (abbr, lineup) => {
    const pids = (lineup && lineup.length) ? lineup.map(p => p.pid)
      : Object.keys(playerTeams).filter(pid => playerTeams[pid] === abbr && (playerABs[pid] ?? 0) >= 50);
    const rates = pids.map(pid => {
      const a = playerABs[pid] ?? 0;
      return a >= 20 ? shrunkRate(hrTotals[pid] ?? 0, a, leagueHRPerAB, BASE_POWER_SHRINK_AB) : null;
    }).filter(x => x != null);
    return rates.length ? rates.reduce((a, b) => a + b, 0) / rates.length : leagueHRPerAB;
  };
  const penERA = abbr => {
    const arms = (bullpens?.[abbr] ?? []).map(r => parseFloat(r.era)).filter(x => x > 0);
    return arms.length ? arms.reduce((a, b) => a + b, 0) / arms.length : leaguePenERA;
  };

  for (const g of games) {
    const vG = Object.values(venueGameDays[g.venue] ?? {}).reduce((a, b) => a + b, 0);
    const vH = Object.values(venueHRsByDate[g.venue] ?? {}).reduce((a, b) => a + b, 0);
    const park = clampR((vG ? vH / vG : leagueHRPerGame) / leagueHRPerGame, 0.7, 1.4);
    const weather = g.weather?.ratio ?? 1;
    const bat = clampR(((teamPower(g.away.teamAbbr, g.away.lineup) + teamPower(g.home.teamAbbr, g.home.lineup)) / 2) / leagueHRPerAB, 0.7, 1.5);
    const spVals = [g.home.probablePitcherId, g.away.probablePitcherId]
      .map(pid => parseFloat(pitcherStats[pid]?.hr9)).filter(x => x > 0);
    const sp = clampR((spVals.length ? spVals.reduce((a, b) => a + b, 0) / spVals.length : leagueHR9) / leagueHR9, 0.6, 1.6);
    const pen = clampR(((penERA(g.away.teamAbbr) + penERA(g.home.teamAbbr)) / 2) / leaguePenERA, 0.85, 1.2);
    const rawMult = Math.pow(bat, HOMER_W.bat) * Math.pow(sp, HOMER_W.sp) * Math.pow(park, HOMER_W.park)
      * Math.pow(pen, HOMER_W.pen) * Math.pow(weather, HOMER_W.weather);
    g.homer = {
      score: Math.max(1, Math.min(99, Math.round(50 + (rawMult - 1) * 100))),
      bat: Math.round(bat * 100) / 100, sp: Math.round(sp * 100) / 100,
      park: Math.round(park * 100) / 100, pen: Math.round(pen * 100) / 100,
      weather: Math.round(weather * 100) / 100,
    };
  }
}

async function fetchTodaySchedule(teamIdToAbbr) {
  try {
    const sched = await fetch(`${MLB}/schedule?sportId=1&date=${todayET()}&gameType=R&hydrate=lineups,probablePitcher,venue(location,fieldInfo)`).then(r => r.json());
    const games = sched.dates?.[0]?.games ?? [];
    return games.map(g => {
      const side = s => {
        const team = g.teams?.[s]?.team ?? {};
        return {
          teamId: team.id ?? null, teamName: team.name ?? '', teamAbbr: teamIdToAbbr[team.id] ?? '',
          probablePitcher: g.teams?.[s]?.probablePitcher?.fullName ?? null,
          probablePitcherId: g.teams?.[s]?.probablePitcher?.id ? String(g.teams[s].probablePitcher.id) : null,
          score: g.teams?.[s]?.score ?? null,
          lineup: (g.lineups?.[`${s}Players`] ?? []).map((p, i) => ({
            pid: String(p.id), name: p.fullName,
            position: p.primaryPosition?.abbreviation ?? '', order: i + 1,
          })),
        };
      };
      // Venue geometry for the weather model — the MLB API carries it directly:
      // location.azimuthAngle is the home-plate→CF bearing, fieldInfo.roofType
      // is Open/Retractable/Dome, plus coords. Nothing hardcoded.
      const loc = g.venue?.location ?? {};
      return {
        gamePk: g.gamePk, gameDate: g.gameDate, status: g.status?.detailedState ?? '',
        started: (g.status?.abstractGameState ?? 'Preview') !== 'Preview', // Live or Final
        venue: g.venue?.name ?? '', home: side('home'), away: side('away'),
        venueId: g.venue?.id ?? null,
        lat: loc.defaultCoordinates?.latitude ?? null,
        lon: loc.defaultCoordinates?.longitude ?? null,
        cfAzimuth: loc.azimuthAngle ?? null,
        roofType: g.venue?.fieldInfo?.roofType ?? null,
      };
    });
  } catch (e) { return []; }
}

// Batting/throwing hand for everyone in a posted lineup and every probable
// starter, so the Schedule tab can show handedness. One batched /people call
// (batSide.code / pitchHand.code come back without any stats hydrate).
async function attachHands(games) {
  const ids = new Set();
  for (const g of games) for (const side of [g.home, g.away]) {
    if (side.probablePitcherId) ids.add(side.probablePitcherId);
    for (const p of side.lineup) ids.add(p.pid);
  }
  if (!ids.size) return;
  const hands = {}; // pid -> { bats, throws }
  for (const group of chunk([...ids], 100)) {
    try {
      const res = await fetch(`${MLB}/people?personIds=${group.join(',')}`).then(r => r.json());
      for (const p of res.people ?? []) hands[String(p.id)] = { bats: p.batSide?.code ?? null, throws: p.pitchHand?.code ?? null };
    } catch (e) { /* leave those unmarked */ }
  }
  for (const g of games) for (const side of [g.home, g.away]) {
    side.probablePitcherThrows = side.probablePitcherId ? (hands[side.probablePitcherId]?.throws ?? null) : null;
    for (const p of side.lineup) p.bats = hands[p.pid]?.bats ?? null;
  }
}

// HR-focused season line for each of today's probable pitchers — just enough
// to answer "is this guy a homer-prone matchup or not" at a glance.
async function fetchPitcherHRStats(pids) {
  const stats = {};
  const BATCH = 6;
  const unique = [...new Set(pids)];
  for (let i = 0; i < unique.length; i += BATCH) {
    const batch = unique.slice(i, i + BATCH);
    await Promise.all(batch.map(async pid => {
      try {
        const res = await fetch(`${MLB}/people/${pid}/stats?stats=season&group=pitching&sportId=1`).then(r => r.json());
        const stat = res.stats?.[0]?.splits?.find(s => s.season === SEASON_YEAR)?.stat;
        if (!stat) return;
        stats[pid] = {
          hr: stat.homeRuns ?? 0, hr9: stat.homeRunsPer9 ?? null,
          ip: stat.inningsPitched ?? '0.0', era: stat.era ?? null,
          gamesStarted: stat.gamesStarted ?? 0,
          gamesPlayed: stat.gamesPlayed ?? 0,
        };
      } catch (e) {}
    }));
  }
  // avgStartIP: how deep this guy goes when he STARTS. Swingmen and
  // reliever-openers bank most of their innings out of the pen, so season
  // IP / gamesStarted wildly overstates them (a 27-IP reliever with one
  // 2-inning start is not a 27-IP-per-start workhorse — it also hid them
  // from opener detection and handed them a max starter share). Anyone with
  // relief appearances on the season line gets his starts averaged from the
  // game log instead; pure starters keep the cheap division.
  await Promise.all(Object.entries(stats).map(async ([pid, st]) => {
    if (!(st.gamesStarted > 0)) { st.avgStartIP = null; return; }
    const naive = ipToFloat(st.ip) / st.gamesStarted;
    if (st.gamesPlayed <= st.gamesStarted) { st.avgStartIP = naive; return; }
    try {
      const res = await fetch(`${MLB}/people/${pid}/stats?stats=gameLog&group=pitching&season=${SEASON_YEAR}&sportId=1`).then(r => r.json());
      const starts = (res.stats?.[0]?.splits ?? []).filter(s => (s.stat?.gamesStarted ?? 0) > 0);
      st.avgStartIP = starts.length
        ? starts.reduce((a, s) => a + ipToFloat(s.stat.inningsPitched), 0) / starts.length
        : naive; // game log empty — better than nothing
    } catch (e) { st.avgStartIP = naive; }
  }));
  return stats;
}

// ── Opener / bulk-arm detection ─────────────────────────────────────────
// Some teams run "the opener": a reliever starts the 1st, then a rotation
// arm throws the bulk innings (WSH 7/4: Palmquist 1 IP, then Littell 6 IP).
// The announced probable is then nearly meaningless as the matchup — he
// covers an inning while an unannounced arm covers five or six, and that
// bulk arm is excluded from the bullpen scan by design (he's a rotation
// guy, BULLPEN_MAX_STARTS drops him). Without this, an opener day scores
// the wrong pitcher AND the wrong pen.
//
// Opener signal: today's probable has 2+ starts but averages ≤3 IP per
// start — AND his team has actually shown the piggyback pattern recently
// (a relief outing of 10+ outs in their last games). The second condition
// keeps a legit young starter with two short blowup starts from being
// mislabeled.
//
// Likely bulk arm: rotation-type pitchers (2+ GS, 3+ IP per appearance
// season-long) on the active roster who aren't a probable today or in the
// next few days, and are rested 4+ days — bulk guys run on rotation rest,
// so "whose turn is it" ≈ "who's been down the longest". Proven recent
// bulk outings rank first, then days of rest. Verified against WSH 7/4:
// picks Littell (6 days rest) over Mikolas/Cavalli, with Alvarez (proven
// bulk but only 3 days rest) correctly excluded.
const OPENER_MAX_AVG_IP  = 3.0;
const OPENER_MIN_STARTS  = 2;
const BULK_MIN_OUTS      = 10; // 3.1+ IP in relief = a bulk outing
const BULK_MIN_REST_DAYS = 4;
const BULK_SCAN_GAMES    = 10; // recent completed games to scan per team
async function detectOpenerBulk(todaySchedule, pitcherStats) {
  const out = {}; // teamAbbr -> { openerLikely: true, bulk: {...} | null }
  const todayProbables = new Set(
    todaySchedule.flatMap(g => [g.home.probablePitcherId, g.away.probablePitcherId]).filter(Boolean)
  );

  const openerSides = [];
  for (const g of todaySchedule) {
    for (const s of [g.home, g.away]) {
      const st = s.probablePitcherId ? pitcherStats[s.probablePitcherId] : null;
      if (!st || (st.gamesStarted ?? 0) < OPENER_MIN_STARTS || !s.teamId) continue;
      if ((st.avgStartIP ?? Infinity) <= OPENER_MAX_AVG_IP) openerSides.push(s);
    }
  }

  for (const side of openerSides) {
    try {
      const tid = side.teamId, today = todayET();
      const fmt = ms => new Date(ms).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
      // One schedule call covers both needs: recent finals (bulk-pattern scan,
      // last-outing dates) and upcoming probables (whose turn it ISN'T).
      const sched = await fetch(`${MLB}/schedule?sportId=1&teamId=${tid}&startDate=${fmt(Date.now() - 16 * 86400000)}&endDate=${fmt(Date.now() + 5 * 86400000)}&gameType=R&hydrate=probablePitcher`).then(r => r.json());
      const games = (sched.dates ?? []).flatMap(d => d.games);

      const upcomingProbables = new Set();
      for (const g of games) {
        if (g.officialDate <= today) continue;
        for (const s of ['home', 'away']) {
          if (g.teams?.[s]?.team?.id === tid && g.teams[s].probablePitcher?.id)
            upcomingProbables.add(String(g.teams[s].probablePitcher.id));
        }
      }

      const finals = games
        .filter(g => g.status?.detailedState === 'Final' && g.officialDate < today)
        .slice(-BULK_SCAN_GAMES);
      const lastOuting = {};  // pid -> most recent date pitched
      const bulkOutings = {}; // pid -> most recent 10+ out relief outing
      for (const g of finals) {
        try {
          const box = await fetch(`${MLB}/game/${g.gamePk}/boxscore`).then(r => r.json());
          const t = box.teams.home.team.id === tid ? box.teams.home : box.teams.away;
          for (const id of t.pitchers ?? []) {
            const st = t.players?.[`ID${id}`]?.stats?.pitching ?? {};
            const pid = String(id);
            if (!lastOuting[pid] || g.officialDate > lastOuting[pid]) lastOuting[pid] = g.officialDate;
            if (!(st.gamesStarted > 0) && (st.outs ?? 0) >= BULK_MIN_OUTS) {
              if (!bulkOutings[pid] || g.officialDate > bulkOutings[pid]) bulkOutings[pid] = g.officialDate;
            }
          }
        } catch { /* skip unreadable boxscore */ }
      }
      if (!Object.keys(bulkOutings).length) continue; // no piggyback history — don't flag

      const roster = await fetch(`${MLB}/teams/${tid}/roster?rosterType=active&hydrate=person(pitchHand)`).then(r => r.json());
      const arms = (roster.roster ?? []).filter(x => x.position?.code === '1');
      const armMeta = {};
      for (const x of arms) armMeta[String(x.person.id)] = { name: x.person.fullName, hand: x.person.pitchHand?.code ?? null };
      const armIds = Object.keys(armMeta);
      const seasonRes = armIds.length
        ? await fetch(`${MLB}/people?personIds=${armIds.join(',')}&hydrate=stats(group=[pitching],type=[season])`).then(r => r.json())
        : { people: [] };

      const candidates = [];
      for (const p of seasonRes.people ?? []) {
        const pid = String(p.id);
        const st = p.stats?.[0]?.splits?.find(s => s.season === SEASON_YEAR)?.stat;
        if (!st) continue;
        const gp = st.gamesPlayed ?? 0;
        const ipPerApp = gp ? ipToFloat(st.inningsPitched) / gp : 0;
        if ((st.gamesStarted ?? 0) < 2 || ipPerApp < 3) continue;       // not a rotation-type arm
        if (todayProbables.has(pid) || upcomingProbables.has(pid)) continue; // his turn is another day
        const restDays = lastOuting[pid] ? daysSince(lastOuting[pid]) : null; // null = no outing in scan window
        if (restDays != null && restDays < BULK_MIN_REST_DAYS) continue;
        candidates.push({
          pid, name: armMeta[pid]?.name ?? p.fullName, hand: armMeta[pid]?.hand ?? null,
          ipPerApp: Math.round(ipPerApp * 10) / 10, restDays,
          provenBulk: !!bulkOutings[pid],
        });
      }
      candidates.sort((a, b) => (b.provenBulk - a.provenBulk) || ((b.restDays ?? 99) - (a.restDays ?? 99)));
      out[side.teamAbbr] = { openerLikely: true, bulk: candidates[0] ?? null };
      console.log(`Opener flagged: ${side.teamAbbr} (${side.probablePitcher}) — likely bulk arm: ${candidates[0]?.name ?? 'unknown'}`);
    } catch { /* leave team unflagged on any failure */ }
  }
  return out;
}

// Pitch-type mix from Statcast, for relief-arm scouting on the Schedule tab.
// Chunked at 15 pitchers per request rather than one big batch — testing
// showed the CSV export silently truncates around ~25k rows when too many
// pitchers_lookup params are combined with a full-season date range (no
// error, just quietly missing data), so this keeps each request's row count
// comfortably under that ceiling instead of guessing it'll be fine.
const PITCH_MIX_BATCH = 15;
async function fetchPitchMix(pids) {
  const chunks = [];
  for (let i = 0; i < pids.length; i += PITCH_MIX_BATCH) chunks.push(pids.slice(i, i + PITCH_MIX_BATCH));
  const counts = {}; // pid -> { pitchName -> count }
  await Promise.all(chunks.map(async chunk => {
    const lookup = chunk.map(pid => `&pitchers_lookup%5B%5D=${pid}`).join('');
    const url = `https://baseballsavant.mlb.com/statcast_search/csv?all=true&hfGT=R%7C&hfSea=${SEASON_YEAR}%7C` +
      `&player_type=pitcher&game_date_gt=${SEASON_START}&game_date_lt=${todayET()}&group_by=name&min_pitches=0` +
      `&min_results=0&type=details${lookup}`;
    const text = await savantFetch(url);
    if (text) for (const row of parseCsv(text)) {
      const pid = row.pitcher, name = row.pitch_name;
      if (!pid || !name) continue;
      (counts[pid] ??= {})[name] = (counts[pid][name] ?? 0) + 1;
    }
  }));
  const mix = {};
  for (const pid of Object.keys(counts)) {
    const total = Object.values(counts[pid]).reduce((a, b) => a + b, 0);
    mix[pid] = Object.entries(counts[pid])
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([name, n]) => ({ name, pct: Math.round(100 * n / total) }));
  }
  return mix;
}

// Bullpen scouting for today's games: who a team typically brings in once the
// starter's pulled, their handedness, what they throw, and whether they're
// fresh or were just worked the day before.
//
// "Typical reliever" = active roster, a real sample of appearances (a 1-2 game
// guy is a recent call-up, not yet a typical pen arm), and — the important
// part — no more than a handful of starts. A flat "zero starts" excludes real
// relievers who took a spot start (Brad Lord: 1 GS, 25 relief apps, 6 holds is
// plainly bullpen), so instead we allow up to BULLPEN_MAX_STARTS. That keeps
// spot-starters while still dropping rotation regulars and openers — a team's
// opener (e.g. WSH's Poulin "starting for Littell" with 10 GS) is in the
// rotation cycle, not the available pen, and matches RotoWire's own list
// exactly for WSH (7/7). Today's probable starters are excluded outright as a
// safety net for a low-start swingman who happens to open today. Trimmed to the
// busiest arms per team (saves+holds, then games) to cap payload.
const BULLPEN_MIN_GAMES   = 3;
const BULLPEN_MAX_STARTS   = 3;
const BULLPEN_MAX_PER_TEAM = 8;
async function fetchBullpens(todaySchedule, teamIdToAbbr) {
  try {
    const teamIds = new Set();
    for (const g of todaySchedule) {
      if (g.home.teamId) teamIds.add(g.home.teamId);
      if (g.away.teamId) teamIds.add(g.away.teamId);
    }
    if (!teamIds.size) return {};

    // Today's probable starters — excluded from their own pen even if they'd
    // otherwise pass the start threshold (e.g. a low-start opener starting today).
    const probableStarterIds = new Set(
      todaySchedule.flatMap(g => [g.home.probablePitcherId, g.away.probablePitcherId])
        .filter(Boolean).map(String)
    );

    const rosters = await Promise.all([...teamIds].map(async tid => {
      try {
        const r = await fetch(`${MLB}/teams/${tid}/roster?rosterType=active&hydrate=person(pitchHand)`).then(r => r.json());
        return { tid, pitchers: (r.roster ?? []).filter(x => x.position?.code === '1') };
      } catch (e) { return { tid, pitchers: [] }; }
    }));
    const meta = {}; // pid -> { name, hand, teamId }
    for (const { tid, pitchers } of rosters) {
      for (const x of pitchers) meta[x.person.id] = { name: x.person.fullName, hand: x.person.pitchHand?.code ?? null, teamId: tid };
    }
    const allIds = Object.keys(meta);
    if (!allIds.length) return {};

    // One batched call for every pitcher on every active roster playing
    // today — this endpoint handles 300+ personIds in a single request fine
    // (confirmed by testing), unlike the Statcast CSV export above.
    const seasonRes = await fetch(`${MLB}/people?personIds=${allIds.join(',')}&hydrate=stats(group=[pitching],type=[season])`).then(r => r.json());
    const relievers = [];
    for (const p of seasonRes.people ?? []) {
      const stat = p.stats?.[0]?.splits?.find(s => s.season === SEASON_YEAR)?.stat;
      if (!stat || (stat.gamesStarted ?? 0) > BULLPEN_MAX_STARTS || (stat.gamesPlayed ?? 0) < BULLPEN_MIN_GAMES) continue;
      if (probableStarterIds.has(String(p.id))) continue; // starting today — not available in relief
      relievers.push({ pid: String(p.id), gamesPitched: stat.gamesPlayed, holds: stat.holds ?? 0, saves: stat.saves ?? 0, era: stat.era ?? null, inningsPitched: parseFloat(stat.inningsPitched) || 0 });
    }
    relievers.sort((a, b) => (b.saves + b.holds) - (a.saves + a.holds) || b.gamesPitched - a.gamesPitched);
    const byTeam = {};
    for (const r of relievers) (byTeam[meta[r.pid].teamId] ??= []).push(r);
    const trimmed = [];
    for (const tid of Object.keys(byTeam)) trimmed.push(...byTeam[tid].slice(0, BULLPEN_MAX_PER_TEAM));
    if (!trimmed.length) return {};
    const trimmedIds = trimmed.map(r => r.pid);

    // Last outing only — the gameLog hydrate returns every game of the
    // season per pitcher (multiple MB for 100+ arms), so pull the most
    // recent split and let the rest get garbage-collected immediately rather
    // than holding onto it or shipping it to the client.
    const gameLogRes = await fetch(`${MLB}/people?personIds=${trimmedIds.join(',')}&hydrate=stats(group=[pitching],type=[gameLog])`).then(r => r.json());
    const lastOuting = {};
    for (const p of gameLogRes.people ?? []) {
      const splits = p.stats?.[0]?.splits ?? [];
      const last = splits[splits.length - 1];
      if (last) lastOuting[String(p.id)] = { date: last.date, pitches: last.stat?.numberOfPitches ?? null };
    }

    const pitchMix = await fetchPitchMix(trimmedIds);

    const out = {};
    for (const r of trimmed) {
      const m = meta[r.pid];
      const abbr = teamIdToAbbr[m.teamId];
      if (!abbr) continue;
      (out[abbr] ??= []).push({
        pid: r.pid, name: m.name, hand: m.hand,
        era: r.era, saves: r.saves, holds: r.holds, gamesPitched: r.gamesPitched, inningsPitched: r.inningsPitched,
        lastOuting: lastOuting[r.pid] ?? null,
        pitchMix: pitchMix[r.pid] ?? [],
      });
    }
    for (const abbr of Object.keys(out)) assignBullpenRoles(out[abbr]);
    return out;
  } catch (e) { return {}; }
}

// Assign a realistic role to each arm, RELATIVE to its own team's pen. The old
// flat "saves >= 3 → Closer / holds >= 3 → Setup" tagged every spot-save arm,
// so teams showed 2-3 "closers" and nobody as middle/long relief. Now:
//   Closer — the team's lone save leader (with a closer-sized save count)
//   Setup  — the top holds arms behind him (8th-inning, high-leverage)
//   Long   — multi-inning arms (innings per appearance well above one)
//   Middle — everyone else: standard 5th-7th middle relief (the common case)
// Rank-based where it can be, so it stays sane at any point in the season.
function assignBullpenRoles(pen) {
  if (!pen.length) return;
  let leader = pen[0];
  for (const r of pen) if (r.saves > leader.saves) leader = r;
  const closerPid = leader.saves >= 4 ? leader.pid : null;
  const setupPids = new Set(
    pen.filter(r => r.pid !== closerPid && r.holds >= 4)
       .sort((a, b) => b.holds - a.holds)
       .slice(0, 2)
       .map(r => r.pid)
  );
  for (const r of pen) {
    const ipa = r.gamesPitched ? r.inningsPitched / r.gamesPitched : 0;
    r.role = r.pid === closerPid ? 'Closer'
           : setupPids.has(r.pid) ? 'Setup'
           : ipa >= 1.8           ? 'Long'
           : 'Middle';
  }
}

// MLB's transactions feed can lag the actual roster move by hours — a call-up
// reported by beat writers in the morning sometimes doesn't post there until
// the player physically arrives at the park. Today's official starting
// lineups are a faster, equally official signal: anyone batting today with
// zero box-score appearances all season is, almost by definition, a
// brand-new call-up, transaction or not.
function lineupNewcomersFrom(todaySchedule) {
  const newcomers = [], date = todayET();
  for (const g of todaySchedule) {
    for (const side of [g.home, g.away]) {
      for (const p of side.lineup) {
        if (p.position === 'P') continue; // pitchers can't homer
        if (playerNames[p.pid]) continue; // already has a box-score appearance this season — not a newcomer
        newcomers.push({ pid: p.pid, name: p.name, toTeam: side.teamAbbr || side.teamName, date });
      }
    }
  }
  return newcomers;
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

async function computeProspects(todaySchedule, teamIdToAbbr) {
  const seasonBatterIds = Object.keys(playerNames);
  const { callUps: selections, sentDownByPid } = await fetchRecentRosterMoves(PROSPECT_LOOKBACK_DAYS, teamIdToAbbr);
  const selectionByPid = {};
  for (const s of selections) selectionByPid[s.pid] = s; // later selections overwrite earlier ones

  // Fill in anyone starting today that the transactions feed hasn't caught up
  // to yet — only if there's no real transaction for them already, since the
  // actual transaction (when it exists) has more reliable fromTeam/date info.
  const lineupNewcomers = lineupNewcomersFrom(todaySchedule);
  for (const n of lineupNewcomers) if (!selectionByPid[n.pid]) selectionByPid[n.pid] = n;

  const allIds = new Set([...seasonBatterIds, ...Object.keys(selectionByPid)]);
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

// Day-to-day and other non-IL "out today" statuses never touch MLB's
// transactions feed, so a knock that doesn't trigger an IL move leaves a hitter
// looking like a plain healthy scratch. ESPN's injuries feed does separate
// Day-To-Day / Out / Questionable from the IL, so we layer it on to tell a real
// injury from a rest day. Matched to our players by normalized name (ESPN uses
// its own athlete IDs); ambiguous names are skipped, and IL always wins.
function normName(s) {
  return (s || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\b(jr|sr|ii|iii|iv|v)\b/g, '')
    .replace(/[^a-z ]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}
// One ESPN pass feeds two things: dtdStatus (the non-IL day-to-day layer) and
// the full injured-hitter list for the Returning Boppers tool. ESPN's
// details.returnDate is the only public estimated-return field around, so it
// rides along even when it's a rough guess. ok:false means the fetch failed —
// the caller keeps the previous build's data instead of emptying the tool.
//
// RETURNING_MIN_HR gates the pool: MLB's boxscore `batters` array lists
// pitchers who entered the game, so relievers end up in playerNames (with games
// but zero at-bats) and match ESPN's injury feed — a hurt reliever is not a
// returning bopper. Requiring at least one HR this season drops every pitcher
// and zero-power bench bat while keeping the Min-HR filter's low end meaningful.
const RETURNING_MIN_HR = 1;
async function fetchESPNInjuries() {
  let data;
  try {
    data = await fetch('https://site.api.espn.com/apis/site/v2/sports/baseball/mlb/injuries', {
      headers: { 'User-Agent': 'Mozilla/5.0' },
    }).then(r => r.json());
  } catch (e) {
    console.warn('  ESPN injuries fetch failed — no day-to-day or returning data this build.');
    return { dtdStatus: {}, returning: [], ok: false };
  }
  // normalized name -> [pids] for the batters we track
  const nameToPids = {};
  for (const [pid, name] of Object.entries(playerNames)) {
    const k = normName(name);
    if (k) (nameToPids[k] ??= []).push(pid);
  }
  const dtdStatus = {};
  const returning = [];
  const seen = new Set();
  for (const team of (data.injuries ?? [])) {
    for (const it of (team.injuries ?? [])) {
      const status = (it.status || '').trim();
      const isDTD = /^(day-to-day|out|questionable)$/i.test(status);
      const ilMatch = status.match(/^(\d+)-day[- ]il$/i);
      if (!isDTD && !ilMatch) continue; // suspension / bereavement — not an injury return
      const pids = nameToPids[normName(it.athlete?.displayName)];
      if (!pids || pids.length !== 1) continue; // unmatched or ambiguous name — skip
      const pid = pids[0];
      if (isDTD) dtdStatus[pid] ??= { status, type: it.details?.type || it.type || null }; // DTD layer keeps everyone (Due tool decides who's relevant)
      if ((hrTotals[pid] ?? 0) < RETURNING_MIN_HR) continue; // pitchers / zero-power bats aren't returning boppers
      if (seen.has(pid)) continue; // feed lists newest entry first — keep it
      seen.add(pid);
      returning.push({
        pid,
        status: ilMatch ? `${ilMatch[1]}-Day IL` : status,
        dtd: isDTD,
        type: it.details?.type ?? null,
        detail: it.details?.detail ?? null,
        side: it.details?.side ?? null,
        returnDate: it.details?.returnDate ?? null,
        comment: (it.shortComment || '').trim().slice(0, 260) || null,
        updated: (it.date || '').slice(0, 10) || null,
      });
    }
  }
  returning.sort((a, b) =>
    (a.returnDate ?? '9999').localeCompare(b.returnDate ?? '9999') ||
    (hrTotals[b.pid] ?? 0) - (hrTotals[a.pid] ?? 0));
  return { dtdStatus, returning, ok: true };
}

// Once a player's game starts, the day's own results shouldn't retroactively
// change what was a pre-game projection (a pick/due score for a game he's
// already homered in). So we freeze: rows whose team's game has started keep
// their previous-build (pre-game) value; only not-yet-started games get fresh
// scores. Applied to picks and the due list; homer scores freeze the same way
// per game. Carries forward only when the previous build was this same slate.
function startedTeams(schedule) {
  const m = {}; // teamAbbr -> its game has started (Live/Final)
  for (const g of schedule) for (const side of [g.home, g.away]) m[side.teamAbbr] = !!g.started;
  return m;
}
function freezeStartedRows(fresh, prev, sameSlate, started, cmp) {
  const frozen = sameSlate ? (prev ?? []).filter(r => started[r.team]) : [];
  const seen = new Set(frozen.map(r => r.pid));
  const live = fresh.filter(r => !started[r.team] && !seen.has(r.pid));
  return [...frozen, ...live].sort(cmp);
}
function freezeStartedHomer(schedule, prevSchedule, sameSlate) {
  if (!sameSlate) return;
  const prevHomer = {};
  for (const g of prevSchedule ?? []) if (g.homer) prevHomer[g.gamePk] = g.homer;
  for (const g of schedule) if (g.started && prevHomer[g.gamePk]) g.homer = prevHomer[g.gamePk];
}

async function main() {
  console.log(`Building data.json — season start ${SEASON_START}`);

  // Resolve the active game date before anything reads todayET() — holds on
  // yesterday while its late games are still live instead of jumping ahead.
  _activeGameDate = await resolveActiveGameDate();
  console.log(`Active game date: ${_activeGameDate}${_activeGameDate !== calDateET() ? ` (yesterday's slate still live; calendar is ${calDateET()})` : ''}`);

  // Read the existing data.json BEFORE we overwrite it, so we can carry forward
  // yesterday's picks and score them against actual HR results. This runs before
  // fetchAll() so we have the old data in hand; we cross-reference after fetchAll
  // once dailyHRs is fully populated for the previous date.
  let prevPicks = [], prevDate = null, picksHistory = [], prevSchedule = [];
  let prevDueRows = [], dueStreaks = null, dueHistory = [];
  let prevReturning = [], prevJustBack = [], prevReturningHistory = [];
  try {
    const fs = await import('node:fs');
    const raw = fs.readFileSync(new URL('../data.json', import.meta.url), 'utf8');
    const old = JSON.parse(raw);
    prevPicks    = old.picks       ?? [];
    prevDate     = old.todayDate   ?? null;
    picksHistory = old.picksHistory ?? [];
    prevSchedule = old.todaySchedule ?? [];  // for freezing started games' Homer Score
    prevDueRows  = old.dueRows     ?? [];
    dueStreaks   = old.dueStreaks  ?? null;  // null (not {}) = first run, triggers backfill seeding
    dueHistory   = old.dueHistory  ?? [];
    prevReturning = old.returningInjured ?? [];
    prevJustBack  = old.justBack ?? [];
    prevReturningHistory = old.returningHistory ?? [];
  } catch { /* first run or file missing — start fresh */ }

  await fetchAll();

  const groups = computeAllGroups(dailyHRs);
  let dueRows = computeDueRows();

  console.log("Fetching Statcast contact-quality data for Due candidates...");
  await attachContactQuality(dueRows);

  console.log("Fetching today's schedule and lineups...");
  const { idToAbbr: teamIdToAbbr, abbrToId: teamIds } = await fetchTeamAbbreviations();
  const todaySchedule = await fetchTodaySchedule(teamIdToAbbr);
  // Degraded-build guard #1: fetchTodaySchedule swallows fetch errors into [],
  // which once shipped a "0 games today" data.json on a 15-game day. If the
  // hydrated call came back empty, double-check against the bare schedule
  // endpoint — if MLB says games exist, abort so the previous build survives
  // (cron only commits on a zero exit).
  if (!todaySchedule.length) {
    const check = await fetch(`${MLB}/schedule?sportId=1&date=${todayET()}&gameType=R`).then(r => r.json()).catch(() => null);
    const expected = check?.totalGames ?? 0;
    if (expected > 0) throw new Error(`Degraded build: schedule hydrate returned 0 games but MLB lists ${expected} for ${todayET()} — refusing to write data.json`);
  }
  await attachHands(todaySchedule);

  // Freeze scores for games already underway (see freezeStartedRows): a due
  // hitter whose game has started keeps his pre-game score instead of dropping
  // off the moment he homers, so the day's due list stays put until the slate
  // is over. Picks and Homer Score freeze the same way below.
  const started = startedTeams(todaySchedule);
  const sameSlate = prevDate === todayET();
  dueRows = freezeStartedRows(dueRows, prevDueRows, sameSlate, started, (a, b) => b.dueScore - a.dueScore || b.z - a.z);

  console.log("Fetching today's probable pitchers' HR stats...");
  const probablePitcherIds = todaySchedule.flatMap(g => [g.home.probablePitcherId, g.away.probablePitcherId]).filter(Boolean);
  const pitcherStats = await fetchPitcherHRStats(probablePitcherIds);

  console.log('Checking for opener situations...');
  const openerBulk = await detectOpenerBulk(todaySchedule, pitcherStats);
  const bulkPids = Object.values(openerBulk).map(o => o.bulk?.pid).filter(Boolean);
  if (bulkPids.length) Object.assign(pitcherStats, await fetchPitcherHRStats(bulkPids)); // so the client can show the bulk arm's line

  console.log("Fetching game-time weather for outdoor parks...");
  const weatherByVenue = await fetchWeather(todaySchedule);

  console.log("Fetching bullpen data for today's games...");
  const bullpens = await fetchBullpens(todaySchedule, teamIdToAbbr);

  console.log("Computing today's HR picks (matchups, splits, pitch-type profiles)...");
  const freshPicks = await computePicks(todaySchedule, bullpens, pitcherStats, openerBulk, weatherByVenue);
  // Degraded-build guard #2: fetchPlatoonSplits swallows fetch errors into {},
  // which once collapsed a 28-pick slate to 1 pick (every pick null-handed,
  // platoon factors gone, scores under the floor). On a real build with games,
  // hands are always known for at least some picks — all-null means the splits
  // fetch failed, so abort rather than ship a gutted board.
  if (freshPicks.length && freshPicks.every(p => !p.bHand && !p.oppHand)) {
    throw new Error(`Degraded build: batter/pitcher handedness missing on all ${freshPicks.length} picks — platoon splits fetch failed; refusing to write data.json`);
  }

  // Freeze picks whose game has already started (pre-game score from the last
  // build); only not-yet-started games get fresh scores.
  const picks = freezeStartedRows(freshPicks, prevPicks, sameSlate, started, (a, b) => b.pickScore - a.pickScore);

  console.log('Scoring per-game Homer Scores...');
  computeHomerScores(todaySchedule, pitcherStats, bullpens);
  freezeStartedHomer(todaySchedule, prevSchedule, sameSlate); // keep started games' Homer Score pre-game

  console.log('Checking for rookie debuts and recent call-ups...');
  const prospects = await computeProspects(todaySchedule, teamIdToAbbr);

  console.log('Checking injured-list status...');
  const injuryStatus = await fetchInjuryStatus();

  console.log('Checking day-to-day + returning injured hitters via ESPN...');
  const espnInj = await fetchESPNInjuries();
  const dtdStatus = espnInj.dtdStatus;
  for (const pid of Object.keys(dtdStatus)) if (injuryStatus[pid]) delete dtdStatus[pid]; // IL wins
  // If ESPN was down this build, carry the previous list — an empty feed would
  // otherwise both blank the tool and mark every injured hitter "just back".
  const returningInjured = espnInj.ok ? espnInj.returning : prevReturning;
  let justBack = prevJustBack;
  if (espnInj.ok) {
    // A hitter who was on the injured feed last build and is gone now (and not
    // on the IL per MLB's own feed) has been activated — that's the "Trout
    // homers first game back" window. Flag him for 3 days, then age out.
    const injuredNow = new Set(returningInjured.map(r => r.pid));
    const isBopper = pid => (hrTotals[pid] ?? 0) >= RETURNING_MIN_HR; // same pool gate — drops pitchers carried from a pre-floor build
    const ageDays = d => Math.round((new Date(todayET()) - new Date(d)) / 86400000);
    justBack = prevJustBack.filter(e =>
      isBopper(e.pid) && !injuredNow.has(e.pid) && !injuryStatus[e.pid] && ageDays(e.backDate) <= 3);
    const carried = new Set(justBack.map(e => e.pid));
    for (const r of prevReturning) {
      if (injuredNow.has(r.pid) || injuryStatus[r.pid] || carried.has(r.pid) || !isBopper(r.pid)) continue;
      justBack.push({ pid: r.pid, backDate: todayET(), from: r.status, type: r.type });
    }
    justBack.sort((a, b) => (hrTotals[b.pid] ?? 0) - (hrTotals[a.pid] ?? 0));
  }

  // Return tracking: the tool's whole thesis is "he homers his first game(s)
  // back," so grade it. Every just-back guy gets a persistent history entry the
  // first build he's flagged; we then check whether he homered inside his flag
  // window (backDate .. backDate+RETURN_WINDOW_DAYS). Idempotent across the
  // ~48 same-day rebuilds: HRs only accrue in dailyHRs, so we lock a HIT the
  // first build that sees one, and a MISS only once the window has fully
  // elapsed with none. Keyed by pid@backDate so a later re-injury and second
  // return this season tracks as its own separate event.
  // Tracking is stricter than the display pool: the return-day-HR RATE should
  // reflect genuine boppers, not a 2-HR utility bat who returns and (predictably)
  // doesn't go deep. RETURN_TRACK_MIN_HR filters new entries and purges any that
  // slipped in under an earlier, looser rule.
  const RETURN_WINDOW_DAYS = 3;
  const RETURN_TRACK_MIN_HR = 5;
  let returningHistory = prevReturningHistory.filter(h => (hrTotals[h.pid] ?? 0) >= RETURN_TRACK_MIN_HR);
  if (espnInj.ok) {
    const keyOf = e => `${e.pid}@${e.backDate}`;
    const known = new Map(returningHistory.map(h => [keyOf(h), h]));
    for (const e of justBack) {
      if (known.has(keyOf(e)) || (hrTotals[e.pid] ?? 0) < RETURN_TRACK_MIN_HR) continue;
      const entry = { pid: e.pid, name: playerNames[e.pid] ?? e.pid, team: playerTeams[e.pid] ?? '',
                      backDate: e.backDate, from: e.from, type: e.type, hrDate: null, done: false };
      returningHistory.push(entry);
      known.set(keyOf(e), entry);
    }
    for (const h of returningHistory) {
      if (h.done) continue;
      const windowEnd = shiftDateStr(h.backDate, RETURN_WINDOW_DAYS);
      let hrDate = null;
      for (let i = 0; i <= RETURN_WINDOW_DAYS; i++) {
        const date = shiftDateStr(h.backDate, i);
        if ((dailyHRs[date]?.[h.pid] ?? 0) > 0) { hrDate = date; break; }
      }
      if (hrDate) { h.hrDate = hrDate; h.done = true; }       // homered in his window
      else if (todayET() > windowEnd) { h.done = true; }      // window elapsed, no HR
    }
    returningHistory = returningHistory.slice(-200); // keep data.json lean
  }
  const returnedHR = returningHistory.filter(h => h.hrDate).length;
  console.log(`  ${Object.keys(dtdStatus).length} day-to-day, ${returningInjured.length} injured hitters, ${justBack.length} just back, ${returningHistory.length} tracked returns (${returnedHR} homered).`);

  // A slate is scorable once every one of its games is Final — dailyHRs is then
  // complete for that date, so no pick can be wrongly locked at hit:false by the
  // dedup guard. That's automatically true for any past date, and ALSO true for
  // the active date the moment tonight's games all end — so results advance as
  // soon as the slate finishes instead of waiting for the calendar to roll.
  const slateComplete = todaySchedule.length > 0 && todaySchedule.every(g => g.status === 'Final');
  const scorable = date => !!date && (date < todayET() || (date === todayET() && slateComplete));

  // Score the previous build's picks against actual HR results now that dailyHRs
  // is fresh. Guard: only once per date (cron fires many times a day), and only
  // once that slate is complete (see scorable).
  if (prevPicks.length && scorable(prevDate) && !picksHistory.some(e => e.date === prevDate)) {
    const dayHRs = dailyHRs[prevDate] ?? {};
    const entry = {
      date: prevDate,
      picks: prevPicks.map(p => ({
        pid:   p.pid,
        name:  playerNames[p.pid] ?? p.pid,
        score: Math.round(p.pickScore * 10) / 10,
        hr:    hrTotals[p.pid] ?? 0,      // season HR total at time of scoring
        hit:   !!(dayHRs[p.pid]),          // did they go deep that day?
        projected: p.projected ?? false,
      })),
    };
    picksHistory = [...picksHistory, entry].slice(-90); // cap at 90 days
    const hits = entry.picks.filter(p => p.hit).length;
    console.log(`Picks history: scored ${prevDate} — ${hits}/${entry.picks.length} hit`);
  }

  // ── Due tracking ──────────────────────────────────────────────────────
  // Same shape as picks history: when a player who was on the Due list homers,
  // he "graduates" — record how long he sat on the list, his due score, and his
  // rank at his last appearance. Uses the previous build's dueRows (the list as
  // the day ended — Final-games-only lag keeps him listed all day even after he
  // homers), with the same guards as picks: only once per date, and only once
  // that slate is complete (scorable).
  const daysOnList = (since, until) =>
    since ? Math.max(1, Math.round((new Date(until) - new Date(since)) / 86400000) + 1) : null;

  if (prevDueRows.length && scorable(prevDate) && !dueHistory.some(e => e.date === prevDate)) {
    const dayHRs = dailyHRs[prevDate] ?? {};
    const grads = [];
    prevDueRows.forEach((row, i) => {
      if (!dayHRs[row.pid]) return;
      const streak = dueStreaks?.[row.pid];
      const since = streak?.since ?? estimateDueSince(row);
      grads.push({
        pid: row.pid,
        name: row.name,
        rank: i + 1,
        score: Math.round(row.dueScore * 10) / 10,
        maxScore: Math.round((streak?.maxScore ?? row.dueScore) * 10) / 10,
        daysOn: daysOnList(since, prevDate),
        droughtABs: row.droughtABs,
      });
    });
    // Append even when empty — the entry marks the date as processed (dedup).
    dueHistory = [...dueHistory, { date: prevDate, of: prevDueRows.length, grads }].slice(-90);
    console.log(`Due history: scored ${prevDate} — ${grads.length}/${prevDueRows.length} graduated`);
  }

  // Rebuild streaks from today's list: carry since/maxScore/bestRank for anyone
  // still on it, start new streaks at today for newcomers. First run ever
  // (dueStreaks === null) backfills since via estimateDueSince so "days on the
  // list" is meaningful immediately instead of everyone starting at day 1.
  // A player who leaves the list without homering (IL, benched, demoted) simply
  // drops out here — if he returns later, his streak restarts.
  const seeding = dueStreaks === null;
  const newStreaks = {};
  dueRows.forEach((row, i) => {
    const prev = dueStreaks?.[row.pid];
    newStreaks[row.pid] = {
      since: prev?.since ?? (seeding ? (estimateDueSince(row) ?? todayET()) : todayET()),
      maxScore: Math.round(Math.max(prev?.maxScore ?? 0, row.dueScore) * 10) / 10,
      bestRank: Math.min(prev?.bestRank ?? Infinity, i + 1),
    };
  });
  dueStreaks = newStreaks;

  // Backfill / self-heal: reconstruct any missing dueHistory date in the last
  // 7 days via computeDueRowsAsOf. Covers the week before tracking existed and
  // automatically fills holes if the cron ever misses a day. Backfilled scores
  // are raw (no contact nudge) and daysOn comes from estimateDueSince — both
  // approximations of what the live tracker records; entries are flagged.
  const DUE_BACKFILL_DAYS = 7;
  for (let i = DUE_BACKFILL_DAYS; i >= 1; i--) {
    const dt = new Date(todayET() + 'T12:00:00Z');
    dt.setUTCDate(dt.getUTCDate() - i);
    const D = dt.toISOString().split('T')[0];
    if (D < SEASON_START || !dailyGames[D]) continue;      // no games that day
    if (dueHistory.some(e => e.date === D)) continue;      // already scored live
    const rows = computeDueRowsAsOf(D);
    if (!rows.length) continue;
    const dayHRs = dailyHRs[D] ?? {};
    const grads = [];
    rows.forEach((row, idx) => {
      if (!dayHRs[row.pid]) return;
      grads.push({
        pid: row.pid, name: row.name, rank: idx + 1,
        score: Math.round(row.dueScore * 10) / 10,
        maxScore: Math.round(row.dueScore * 10) / 10,
        daysOn: daysOnList(estimateDueSince(row), D),
        droughtABs: row.droughtABs,
      });
    });
    dueHistory.push({ date: D, of: rows.length, grads, backfilled: true });
    console.log(`Due history: backfilled ${D} — ${grads.length}/${rows.length} graduated`);
  }
  dueHistory.sort((a, b) => (a.date < b.date ? -1 : 1));
  dueHistory = dueHistory.slice(-90);

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
    teamGameDays, venueGameDays, venueHRsByDate, groups, dueRows, prospects, injuryStatus, dtdStatus,
    todayDate: todayET(), todaySchedule, teamIds, pitcherStats, bullpens, picks, picksHistory,
    dueStreaks, dueHistory, returningInjured, justBack, returningHistory,
  };

  const fs = await import('node:fs');
  fs.writeFileSync(new URL('../data.json', import.meta.url), JSON.stringify(output));
  console.log(`Wrote data.json — ${allDates.length} game days, ${totalHRCount} HRs, ${dueRows.length} due rows, ${prospects.debutBombs.length} debut bombs, ${prospects.justCalledUp.length} just called up, ${todaySchedule.length} games today, ${picks.length} picks`);

  // Stamp the service worker with a short hash of index.html. sw.js only
  // changes when the app code changes (not on data-only rebuilds), which is
  // exactly what makes the browser detect a new PWA version. Idempotent: if
  // index.html is unchanged, the version line is unchanged and this is a no-op.
  const crypto = await import('node:crypto');
  const idxPath = new URL('../index.html', import.meta.url);
  const swPath = new URL('../sw.js', import.meta.url);
  const appVersion = crypto.createHash('sha1').update(fs.readFileSync(idxPath)).digest('hex').slice(0, 10);
  const sw = fs.readFileSync(swPath, 'utf8');
  const stamped = sw.replace(/const APP_VERSION = '[^']*';/, `const APP_VERSION = '${appVersion}';`);
  if (stamped !== sw) { fs.writeFileSync(swPath, stamped); console.log(`Stamped sw.js APP_VERSION = ${appVersion}`); }
}

main().catch(e => { console.error(e); process.exit(1); });
