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
      avgGap, droughtABs, stdGap, z, dueScore, rawDueScore: dueScore, lastHR, lastAgo: daysSince(lastHR), lastGame,
      intervals, hrDates: dates, longestPriorGap, isLongestEver: droughtABs >= longestPriorGap });
  }
  rows.sort((a,b) => b.dueScore - a.dueScore || b.z - a.z);
  return rows;
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

async function fetchBattedBalls(pids) {
  if (!pids.length) return [];
  const lookup = pids.map(pid => `&batters_lookup%5B%5D=${pid}`).join('');
  const url = `https://baseballsavant.mlb.com/statcast_search/csv?all=true&hfGT=R%7C&hfSea=${SEASON_YEAR}%7C` +
    `&player_type=batter&game_date_gt=${SEASON_START}&game_date_lt=${todayET()}&group_by=name&min_pitches=0` +
    `&min_results=0&type=details&hfBBT=ground_ball%7Cline_drive%7Cfly_ball%7Cpopup%7C${lookup}`;
  const text = await savantFetch(url);
  return text ? parseCsv(text) : [];
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
    .map(([name, n]) => ({ name, pct: Math.round(100 * n / hrBalls.length) }));
}
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

// Starters average ~5 innings in the modern game, bullpen ~4 — blending
// the matchup signals at those weights gives a full-game picture rather
// than just "how does the batter do vs the starter."
const STARTER_WEIGHT = 0.55;
const BULLPEN_WEIGHT = 0.45;

async function computePicks(todaySchedule, bullpensMap) {
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
    const pitcherIds = [...new Set(uniq.map(c => c.oppPid))];

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

    const rows = [];
    for (const c of uniq) {
      const abs = playerABs[c.pid] ?? 0, hrs = hrTotals[c.pid] ?? 0;
      const basePower = hrs / abs;
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
      const effectiveBatterSide = bHand === 'S' ? (pHand === 'L' ? 'R' : 'L') : bHand;
      let pitcherPlatoonRatio = null;
      if (pInfo && effectiveBatterSide) {
        const vsLPrior = pInfo.hand === 'L' ? leaguePitcherRateSame : leaguePitcherRateOpp;
        const vsRPrior = pInfo.hand === 'R' ? leaguePitcherRateSame : leaguePitcherRateOpp;
        const shrunkVsL = pInfo.vsL ? shrunkRate(pInfo.vsL.hr, pInfo.vsL.ip, vsLPrior, PLATOON_SHRINK_IP) : null;
        const shrunkVsR = pInfo.vsR ? shrunkRate(pInfo.vsR.hr, pInfo.vsR.ip, vsRPrior, PLATOON_SHRINK_IP) : null;
        const sameSplit  = effectiveBatterSide === 'L' ? shrunkVsL : shrunkVsR;
        const otherSplit = effectiveBatterSide === 'L' ? shrunkVsR : shrunkVsL;
        if (sameSplit != null && otherSplit != null && otherSplit > 0) {
          pitcherPlatoonRatio = Math.max(PICKS_RATIO_MIN, Math.min(PICKS_RATIO_MAX, sameSplit / otherSplit));
        }
      }

      const venueGames = Object.values(venueGameDays[c.venue] ?? {}).reduce((a, b) => a + b, 0);
      const venueHRs   = Object.values(venueHRsByDate[c.venue] ?? {}).reduce((a, b) => a + b, 0);
      const parkHRG    = venueGames ? venueHRs / venueGames : leagueHRPerGame;
      const parkRatio  = leagueHRPerGame ? Math.max(PICKS_RATIO_MIN, Math.min(PICKS_RATIO_MAX, parkHRG / leagueHRPerGame)) : 1;

      const synergyScore = pitchSynergyScore(hrProfile, pitcherMixByPid[c.oppPid]);

      rows.push({
        pid: c.pid, team: c.team, oppTeam: c.oppTeam, hrs, abs,
        oppPid: c.oppPid, oppName: c.oppName, oppHand: pHand, venue: c.venue,
        projected: c.projected ?? false,
        bHand, basePower, recentFormRatio, batterPlatoonRatio, pitcherPlatoonRatio, parkRatio,
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
      r.synergyRatio = medianSynergy > 0
        ? Math.max(PICKS_RATIO_MIN, Math.min(PICKS_RATIO_MAX, r.synergyScore > 0 ? r.synergyScore / medianSynergy : 0.9))
        : 1;

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
      r.bullpenSynergyRatio = medianSynergy > 0 && bullpenSynergyRaw > 0
        ? Math.max(PICKS_RATIO_MIN, Math.min(PICKS_RATIO_MAX, bullpenSynergyRaw / medianSynergy))
        : (bullpenSynergyRaw === 0 ? 0.9 : 1);

      // Blended pitcher signal: weighted by typical innings split (55/45)
      const effectivePitcherPlatoon = r.pitcherPlatoonRatio != null
        ? (bullpenPlatoonFactor != null
            ? STARTER_WEIGHT * r.pitcherPlatoonRatio + BULLPEN_WEIGHT * bullpenPlatoonFactor
            : r.pitcherPlatoonRatio)
        : bullpenPlatoonFactor;
      const effectiveSynergy = bullpenPlatoonFactor != null
        ? STARTER_WEIGHT * r.synergyRatio + BULLPEN_WEIGHT * r.bullpenSynergyRatio
        : r.synergyRatio;

      const factors = [r.recentFormRatio, r.batterPlatoonRatio, effectivePitcherPlatoon, r.parkRatio, effectiveSynergy]
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

function todayET() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
}

// Powers both the new Schedule tab and the lineup-based call-up/bench
// detection below — one fetch, hydrated with lineups + probable pitchers, so
// the rest of the build never has to hit /schedule for "today" a second time.
async function fetchTodaySchedule(teamIdToAbbr) {
  try {
    const sched = await fetch(`${MLB}/schedule?sportId=1&date=${todayET()}&gameType=R&hydrate=lineups,probablePitcher,venue`).then(r => r.json());
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
      return {
        gamePk: g.gamePk, gameDate: g.gameDate, status: g.status?.detailedState ?? '',
        venue: g.venue?.name ?? '', home: side('home'), away: side('away'),
      };
    });
  } catch (e) { return []; }
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
        };
      } catch (e) {}
    }));
  }
  return stats;
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
// fresh or were just worked the day before. "Typical reliever" = active
// roster, zero starts this season (cleanly excludes today's probable
// starters and the rest of the rotation), with a real sample of appearances
// — a guy with 1-2 games is a recent call-up, not yet a "typical" arm out of
// the pen. Trimmed to the busiest arms per team (by saves+holds, then games
// pitched) so a deep bullpen doesn't balloon the payload more than a thin one.
const BULLPEN_MIN_GAMES   = 3;
const BULLPEN_MAX_PER_TEAM = 8;
async function fetchBullpens(todaySchedule, teamIdToAbbr) {
  try {
    const teamIds = new Set();
    for (const g of todaySchedule) {
      if (g.home.teamId) teamIds.add(g.home.teamId);
      if (g.away.teamId) teamIds.add(g.away.teamId);
    }
    if (!teamIds.size) return {};

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
      if (!stat || stat.gamesStarted > 0 || (stat.gamesPlayed ?? 0) < BULLPEN_MIN_GAMES) continue;
      relievers.push({ pid: String(p.id), gamesPitched: stat.gamesPlayed, holds: stat.holds ?? 0, saves: stat.saves ?? 0, era: stat.era ?? null });
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
        era: r.era, saves: r.saves, holds: r.holds, gamesPitched: r.gamesPitched,
        lastOuting: lastOuting[r.pid] ?? null,
        pitchMix: pitchMix[r.pid] ?? [],
      });
    }
    return out;
  } catch (e) { return {}; }
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

async function main() {
  console.log(`Building data.json — season start ${SEASON_START}`);

  // Read the existing data.json BEFORE we overwrite it, so we can carry forward
  // yesterday's picks and score them against actual HR results. This runs before
  // fetchAll() so we have the old data in hand; we cross-reference after fetchAll
  // once dailyHRs is fully populated for the previous date.
  let prevPicks = [], prevDate = null, picksHistory = [];
  try {
    const fs = await import('node:fs');
    const raw = fs.readFileSync(new URL('../data.json', import.meta.url), 'utf8');
    const old = JSON.parse(raw);
    prevPicks    = old.picks       ?? [];
    prevDate     = old.todayDate   ?? null;
    picksHistory = old.picksHistory ?? [];
  } catch { /* first run or file missing — start fresh */ }

  await fetchAll();

  const groups = computeAllGroups(dailyHRs);
  const dueRows = computeDueRows();

  console.log("Fetching Statcast contact-quality data for Due candidates...");
  await attachContactQuality(dueRows);

  console.log("Fetching today's schedule and lineups...");
  const { idToAbbr: teamIdToAbbr, abbrToId: teamIds } = await fetchTeamAbbreviations();
  const todaySchedule = await fetchTodaySchedule(teamIdToAbbr);

  console.log("Fetching today's probable pitchers' HR stats...");
  const probablePitcherIds = todaySchedule.flatMap(g => [g.home.probablePitcherId, g.away.probablePitcherId]).filter(Boolean);
  const pitcherStats = await fetchPitcherHRStats(probablePitcherIds);

  console.log("Fetching bullpen data for today's games...");
  const bullpens = await fetchBullpens(todaySchedule, teamIdToAbbr);

  console.log("Computing today's HR picks (matchups, splits, pitch-type profiles)...");
  const picks = await computePicks(todaySchedule, bullpens);

  console.log('Checking for rookie debuts and recent call-ups...');
  const prospects = await computeProspects(todaySchedule, teamIdToAbbr);

  console.log('Checking injured-list status...');
  const injuryStatus = await fetchInjuryStatus();

  // Score yesterday's picks against actual HR results now that dailyHRs is fresh.
  // Only append an entry if we have picks for a date that isn't already in history
  // (guards against double-counting when the cron fires multiple times per day).
  if (prevPicks.length && prevDate && !picksHistory.some(e => e.date === prevDate)) {
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
    teamGameDays, venueGameDays, venueHRsByDate, groups, dueRows, prospects, injuryStatus,
    todayDate: todayET(), todaySchedule, teamIds, pitcherStats, bullpens, picks, picksHistory,
  };

  const fs = await import('node:fs');
  fs.writeFileSync(new URL('../data.json', import.meta.url), JSON.stringify(output));
  console.log(`Wrote data.json — ${allDates.length} game days, ${totalHRCount} HRs, ${dueRows.length} due rows, ${prospects.debutBombs.length} debut bombs, ${prospects.justCalledUp.length} just called up, ${todaySchedule.length} games today, ${picks.length} picks`);
}

main().catch(e => { console.error(e); process.exit(1); });
