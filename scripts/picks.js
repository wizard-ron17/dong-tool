// Ron's Tud Tool — anytime-TD picks.
//
// Scores every skill player on the upcoming slate with the model backtested in
// research/. Training stays in Python; this file only computes features and
// applies the exported coefficients (research/model.json), which is why there
// is no maths here beyond a logistic.
//
// The feature definitions MUST match research/build_dataset.py exactly or the
// coefficients are being applied to something they were not fitted on.
// research/validate_port.py checks that on real historical weeks.
//
// What the model is, and what it is not (see research/README.md):
//   * ~87% of the signal is snap share, and last-3-game snap share beats
//     season-to-date by more than every other feature combined.
//   * defence-allowed, red-zone defence, pace, weather, home/away and blowout
//     risk were all tested and are nulls — implied team total already prices
//     the environment. They are deliberately absent.
//   * teammates newly ruled out is in, because it corrects a stale-role bias
//     on the backups this tool most wants to surface.

import fs from 'node:fs';
import { REL, fetchText, fetchOptional, parseCsv, num } from './nflverse.js';

const POS = ['RB', 'WR', 'TE', 'QB', 'FB'];
// PFR labels some running backs "HB" in some seasons (39 rows in 2025, 41 in
// 2020). Unmapped it silently drops whole seasons for real starters, which is
// worse than it sounds: the player keeps his red-zone history from play-by-play
// while losing the snap games that denominate it. Normalise on the way in.
const POS_ALIAS = { HB: 'RB' };
// snap_counts starts in 2016 and is ~2.4MB a season, so the build loads every
// season: snap_share_prior and snap_last3 reach back as far as a player's
// career does, exactly as research/build_dataset.py does.
const SNAP_FROM = 2016;
// play-by-play is ~90MB a season, so rz_touches_prior is bounded to a 2-season
// window on BOTH sides (build_dataset.py passes window_seasons=2). Bounding it
// also happened to improve the model — recent red-zone usage beats career.
const RZ_SEASONS = 2;
// A passing line is quoted for one QB per team — the guy who actually throws —
// and only when he has enough starts for the shrunk rate to mean anything.
//
// Snap share can't make this call. Every team carries two QBs on the board, and
// snap_last3 doesn't separate them: a backup with thin history falls back to the
// position prior and lands at 0.82, indistinguishable from a starter. Passing
// attempts in the loaded window are the direct measure and can't be faked.
const PASS_MIN_STARTS = 3;
// A Questionable tag is real information the features can't see: snap history
// describes a healthy player. Across 2016-2025 the board's price for a
// Questionable player ran 12% above what he actually did (0.213 priced against
// 0.187 scored) while unlisted players came in at 0.997 — so the model is fine
// and the tag is the gap. Fitted on 2016-2021 at 0.889 and checked on
// 2022-2025, where applying it leaves 0.973 of the way to perfect.
// Out and Doubtful are dropped from the board entirely; this is the middle case.
const QUESTIONABLE_MULT = 0.88;
// Players kept per team, BY POSITION. A flat per-team cap looked reasonable and
// was not: it ranks purely on probability, so a team's fringe receivers can fill
// the board while its starting quarterback falls off the bottom — Lamar Jackson
// vanished from Baltimore behind six WRs priced at 16%. A quarterback is a real
// anytime-TD market whatever his number, so coverage is guaranteed per position
// rather than left to the ranking. Counts track how many of each a team actually
// gives offensive snaps to.
const PER_TEAM_POS = { RB: 4, WR: 6, TE: 3, QB: 2, FB: 1 };
const MODEL = JSON.parse(
  fs.readFileSync(new URL('../research/model.json', import.meta.url), 'utf8'));
// Monotone recalibration of the top end. The raw logistic extrapolates linearly
// in log-odds, but scoring saturates: out of sample it predicted 75% where 60%
// actually happened. Fit on walk-forward out-of-sample predictions in
// research/calibrate.py — see that file for why Platt scaling cannot do this.
const CALIB = JSON.parse(
  fs.readFileSync(new URL('../research/calibration.json', import.meta.url), 'utf8'));
// Per-player birthday scoring record, 2016-2025 — see research/birthday_history.py.
// Precomputed because it needs ten seasons of play-by-play to know who scored,
// which the daily build has no reason to carry.
const BDAY = JSON.parse(
  fs.readFileSync(new URL('../research/birthday_history.json', import.meta.url), 'utf8'));

// ── feature helpers, mirroring research/build_dataset.py ──────────────────

// add_form(): career prior mean shrunk toward the player's previous-season mean,
// falling back to the position prior. k = 2 pseudo-games.
function shrunkPrior(priorSum, priorN, prevSeasonMean, posPrior) {
  const k = MODEL.shrink_k;
  const target = prevSeasonMean != null ? prevSeasonMean : posPrior;
  return (priorSum + k * target) / (priorN + k);
}

// position_prior(): the position's mean over strictly EARLIER seasons, which
// varies by season. Only reached for players with no previous season at all.
function priorFor(kind, position, season) {
  const t = MODEL.position_priors[kind];
  return (t[String(season)] ?? t.default)[position];
}

// add_recency(): mean over the last n games strictly before this one. The window
// deliberately spans the season boundary — that is what carries week 1.
function lastN(values, n) {
  if (!values.length) return null;
  const w = values.slice(-n);
  return w.reduce((a, b) => a + b, 0) / w.length;
}

/**
 * The feature row for one player-game. Exported so research/validate_port.py
 * can check it against build_dataset.py on real historical weeks — the one
 * thing that proves the port applies the coefficients to the same quantities.
 */
export function playerFeatures({ pid, position, season, week, snapLog, rzLog,
                                 impliedTotal, matesOut = 0, newAbsence = 0 }) {
  const before = (s) => s.season < season || (s.season === season && s.week < week);
  const snaps = (snapLog.get(pid) ?? []).filter(before);
  const rz = (rzLog.get(pid) ?? []).filter(before);
  // No history at all (a rookie in week 1) is not a reason to skip a player —
  // build_dataset.py keeps those rows, shrinking them to the position prior,
  // so the model was trained on them and can score them. A rookie RB1 is
  // exactly the kind of pick this tool should be able to make.

  const mean = (a) => a.length ? a.reduce((x, y) => x + y, 0) / a.length : null;
  const prevSeason = season - 1;
  const snapVals = snaps.map(s => s.pct);
  // rz_touches_prior is bounded to RZ_SEASONS (build_dataset.py passes
  // window_seasons=2), so its DENOMINATOR has to be bounded the same way —
  // the count of games inside the window, not the whole career.
  const rzFrom = season - RZ_SEASONS + 1;
  const rzGames = snaps.filter(s => s.season >= rzFrom).length;
  // Numerator and denominator must describe the same games. If the snap log has
  // no games in the window, there is no rate to compute, and using the red-zone
  // sum anyway divides by the shrink constant alone — which is how a 26-per-game
  // red-zone rate and a 0.999 probability got produced. Guard it explicitly.
  const rzSum = rzGames
    ? rz.filter(s => s.season >= rzFrom).reduce((a, b) => a + b.rz, 0)
    : 0;
  const prevGames = snaps.filter(s => s.season === prevSeason).length;
  const prevRzSum = rz.filter(s => s.season === prevSeason)
                      .reduce((a, b) => a + b.rz, 0);

  return {
    position,
    snap_share_prior: shrunkPrior(
      snapVals.reduce((a, b) => a + b, 0), snapVals.length,
      mean(snaps.filter(s => s.season === prevSeason).map(s => s.pct)),
      priorFor('snap_share', position, season)),
    rz_touches_prior: shrunkPrior(
      rzSum, rzGames,
      // the previous-season mean is per GAME PLAYED, and the rz log has no row
      // for a game with zero red-zone touches — so the denominator has to come
      // from the snap log or players with quiet seasons get the wrong prior
      prevGames ? prevRzSum / prevGames : null,
      priorFor('rz_touches', position, season)),
    // a debut has no window; build_dataset.py fills it with the shrunk prior
    snap_last3: lastN(snapVals, 3) ?? shrunkPrior(
      0, 0, null, priorFor('snap_share', position, season)),
    implied_total: impliedTotal,
    mates_out: matesOut,
    new_absence: newAbsence,
  };
}

/** Linear interpolation along an isotonic step function. */
function interpMap(p, x, y) {
  if (p <= x[0]) return y[0];
  if (p >= x[x.length - 1]) return y[y.length - 1];
  let i = 1;
  while (i < x.length && x[i] < p) i++;
  const t = (p - x[i - 1]) / (x[i] - x[i - 1]);
  return y[i - 1] + t * (y[i] - y[i - 1]);
}
export const calibrate  = (p) => interpMap(p, CALIB.x, CALIB.y);
export const calibrate2 = (p) => interpMap(p, CALIB.x2, CALIB.y2);
export const calibrate3 = (p) => interpMap(p, CALIB.x3, CALIB.y3);
export const calibrate4 = (p) => interpMap(p, CALIB.x4, CALIB.y4);

/**
 * P(>=2 TD | >=1 TD). Modelled as a conditional so P(2+) = P(1+) * this can
 * never exceed P(1+). It is emphatically not a constant — it runs from 8% to
 * 28% across red-zone quintiles, and RB 22.7% vs TE 10.9%.
 */
export function scoreCond2(row) {
  const C = MODEL.cond2;
  let z = C.coef.intercept;
  if (row.position !== MODEL.reference_position) z += C.coef[`pos_${row.position}`] ?? 0;
  for (const f of MODEL.features) {
    const s = C.scale[f];
    z += C.coef[f] * ((row[f] - s.mean) / s.sd);
  }
  return 1 / (1 + Math.exp(-Math.max(-30, Math.min(30, z))));
}

export function score(row) {
  const c = MODEL.coef;
  let z = c.intercept;
  if (row.position !== MODEL.reference_position) z += c[`pos_${row.position}`] ?? 0;
  for (const f of MODEL.features) {
    const s = MODEL.scale[f];
    z += c[f] * ((row[f] - s.mean) / s.sd);
  }
  return 1 / (1 + Math.exp(-Math.max(-30, Math.min(30, z))));
}

// ── passing TDs ───────────────────────────────────────────────────────────
// A separate model, because the TD model treats a QB as a rusher — his `scored`
// there is a rushing TD, so passing TDs sit outside it entirely.
//
// Three features (research/passing_td.py vetted nine). Vegas's implied team
// total carries almost all of the signal; pass volume and the QB's own TD rate
// add a little; red-zone efficiency, weapon quality, defense and game script add
// NOTHING once the implied total is in. They are reliable traits — weapon
// quality split-halves at r=0.89 — which is exactly why the market has already
// priced them.
const PASS_MODEL = JSON.parse(
  fs.readFileSync(new URL('../research/passing_model.json', import.meta.url), 'utf8'));

/**
 * A QB's shrunk pass volume and pass-TD rate, from his own starts inside the
 * loaded window. Mirrors prior_rate() in research/passing_td.py: k games of
 * league prior mixed in, and the window bounded to what the build actually
 * loads so the served feature IS the trained feature.
 */
/**
 * One starting QB per team: whoever threw the most in the most recent season he
 * appears in, preferring the later season when two QBs split a room. Returns
 * team -> pid.
 */
export function passStarters(roster, passLog, season) {
  const best = new Map();       // team -> { pid, season, att }
  for (const [pid, info] of roster) {
    if (info.position !== 'QB') continue;
    const log = passLog.get(pid);
    if (!log?.length) continue;
    const last = log[log.length - 1].season;
    if (last < season - 1) continue;               // hasn't thrown recently
    const att = log.filter(g => g.season === last).reduce((a, g) => a + g.att, 0);
    const cur = best.get(info.team);
    if (!cur || last > cur.season || (last === cur.season && att > cur.att))
      best.set(info.team, { pid, season: last, att });
  }
  return new Map([...best].map(([t, v]) => [t, v.pid]));
}

export function passFeatures({ pid, season, week, passLog, impliedTotal }) {
  const P = PASS_MODEL.prior;
  // Strictly before the week being scored. Live this is moot — the pbp for a
  // future week doesn't exist — but updateHistory re-scores past weeks off a
  // fully-populated log, and without the week bound a graded week would be
  // priced with its own result already in the feature.
  const log = (passLog.get(pid) ?? []).filter(
    g => g.season < season || (g.season === season && g.week < week));
  // Only real starts inform the rate — a mop-up drive would drag it down.
  const starts = log.filter(g => g.att >= P.min_att && g.season > season - P.window);
  const n = starts.length;
  const att = starts.reduce((a, g) => a + g.att, 0);
  const ptd = starts.reduce((a, g) => a + g.ptd, 0);
  return {
    implied_total: impliedTotal,
    att_pg: (att + P.k * P.lg_att) / (n + P.k),
    ptd_pg: (ptd + P.k * P.lg_ptd) / (n + P.k),
    starts: n,
  };
}

/** Projected passing TDs — the Poisson mean. */
export function scorePass(row) {
  let z = PASS_MODEL.coef[0];
  PASS_MODEL.features.forEach((f, i) => {
    const s = PASS_MODEL.scale[f];
    z += PASS_MODEL.coef[i + 1] * ((row[f] - s.mean) / s.sd);
  });
  return Math.exp(Math.max(-20, Math.min(20, z)));
}

/** P(X >= need) for Poisson(mu). */
export function poissonAtLeast(mu, need) {
  if (!(mu > 0)) return need <= 0 ? 1 : 0;
  if (need <= 0) return 1;
  let term = Math.exp(-mu), cdf = term;
  for (let i = 1; i <= need - 1; i++) { term = term * mu / i; cdf += term; }
  return Math.min(1, Math.max(0, 1 - cdf));
}

/**
 * Calibrated P(X >= need). Passing TDs are underdispersed (variance 1.33 on a
 * mean 1.45), so raw Poisson puts too much weight in both tails — it
 * under-prices Over 1.5 and over-prices Over 2.5. Each line carries its own
 * isotonic map, which takes ECE on Over 1.5 from 0.028 to 0.013.
 */
export function passProb(mu, need) {
  const c = PASS_MODEL.cal[String(need)];
  const raw = poissonAtLeast(mu, need);
  return c ? interpMap(raw, c.x, c.y) : raw;
}
export const PASS_LINES = PASS_MODEL.lines;

// ── data loading ──────────────────────────────────────────────────────────

/**
 * One pass over players.csv for everything it holds: the pfr -> gsis crosswalk
 * and birth dates. weekly_rosters looks like it would do the crosswalk but its
 * pfr_id is null ~36% of the time, and the players it misses skew to low snap
 * share — exactly the low-probability rows, so dropping them silently inflates
 * the base rate.
 */
export async function loadPlayers() {
  const { idx, rows } = parseCsv(await fetchText(`${REL}/players/players.csv`));
  const xwalk = new Map(), birth = new Map();
  for (const r of rows) {
    const g = r[idx.gsis_id], p = r[idx.pfr_id];
    if (g && p && !xwalk.has(p)) xwalk.set(p, g);
    if (g && r[idx.birth_date]) birth.set(g, r[idx.birth_date]);
  }
  return { xwalk, birth };
}
export async function loadCrosswalk() { return (await loadPlayers()).xwalk; }

/** Per-player game log of offensive snap share, oldest first, across seasons. */
export async function loadSnapLog(seasons, xwalk) {
  const log = new Map();          // pid -> [{season, week, pct, team}]
  for (const y of seasons) {
    const txt = await fetchOptional(`${REL}/snap_counts/snap_counts_${y}.csv`);
    if (!txt) { console.log(`  snap_counts ${y}: not published yet`); continue; }
    const { idx, rows } = parseCsv(txt);
    let n = 0;
    for (const r of rows) {
      const pos = POS_ALIAS[r[idx.position]] ?? r[idx.position];
      if (!POS.includes(pos)) continue;
      if (!(num(r[idx.offense_snaps]) > 0)) continue;
      const pid = xwalk.get(r[idx.pfr_player_id]);
      if (!pid) continue;
      (log.get(pid) ?? log.set(pid, []).get(pid)).push({
        season: y, week: +r[idx.week], pct: num(r[idx.offense_pct]) || 0,
        team: r[idx.team], position: pos,
      });
      n++;
    }
    console.log(`  snap_counts ${y}: ${n} player-games`);
  }
  for (const v of log.values())
    v.sort((a, b) => a.season - b.season || a.week - b.week);
  return log;
}

/** Per-player red-zone touches per game, from play-by-play. */
/**
 * Both play-by-play-derived logs in ONE pass over each season's file:
 *   rzLog   pid -> [{season, week, rz}]    red-zone touches (rush + target)
 *   passLog pid -> [{season, week, att, ptd}]  a QB's own throwing line
 *
 * Combined deliberately: play_by_play_YYYY.csv is ~90 MB, and the passing-TD
 * market needs the same file the red-zone feature already downloads. Two
 * loaders would double the build's network cost for no reason.
 */
export async function loadPbpLogs(seasons) {
  const rzLog = new Map(), passLog = new Map();
  for (const y of seasons) {
    const txt = await fetchOptional(`${REL}/pbp/play_by_play_${y}.csv`);
    if (!txt) { console.log(`  pbp ${y}: not published yet`); continue; }
    const { idx, rows } = parseCsv(txt);
    const per = new Map();        // `${pid}|${week}` -> rz touches
    const qb  = new Map();        // `${pid}|${week}` -> { att, ptd }
    for (const r of rows) {
      const isPass = r[idx.pass_attempt] === '1';
      // Passing line: every attempt by the passer, and the TDs among them.
      // Sacks carry pass_attempt 0 in nflverse, so they correctly don't count
      // as attempts here — same as the Python that trained the model.
      if (isPass && r[idx.passer_player_id]) {
        const k = `${r[idx.passer_player_id]}|${r[idx.week]}`;
        const e = qb.get(k) ?? { att: 0, ptd: 0 };
        e.att += 1;
        if (r[idx.pass_touchdown] === '1') e.ptd += 1;
        qb.set(k, e);
      }
      const yl = num(r[idx.yardline_100]);
      if (yl == null || yl > 20) continue;
      const ids = [];
      if (r[idx.rush_attempt] === '1' && r[idx.rusher_player_id]) ids.push(r[idx.rusher_player_id]);
      if (isPass && r[idx.receiver_player_id]) ids.push(r[idx.receiver_player_id]);
      for (const pid of ids) {
        const k = `${pid}|${r[idx.week]}`;
        per.set(k, (per.get(k) ?? 0) + 1);
      }
    }
    for (const [k, rz] of per) {
      const [pid, wk] = k.split('|');
      (rzLog.get(pid) ?? rzLog.set(pid, []).get(pid)).push({ season: y, week: +wk, rz });
    }
    for (const [k, v] of qb) {
      const [pid, wk] = k.split('|');
      (passLog.get(pid) ?? passLog.set(pid, []).get(pid))
        .push({ season: y, week: +wk, att: v.att, ptd: v.ptd });
    }
  }
  const bySeasonWeek = (a, b) => a.season - b.season || a.week - b.week;
  for (const v of rzLog.values()) v.sort(bySeasonWeek);
  for (const v of passLog.values()) v.sort(bySeasonWeek);
  return { rzLog, passLog };
}

/** Back-compat wrapper — dump-features.js only wants the red-zone half. */
export async function loadRzLog(seasons) {
  return (await loadPbpLogs(seasons)).rzLog;
}

/** Current team + position for every rostered skill player. */
async function loadRoster(season) {
  const txt = await fetchOptional(`${REL}/weekly_rosters/roster_weekly_${season}.csv`);
  if (!txt) return new Map();
  const { idx, rows } = parseCsv(txt);
  const m = new Map();
  let maxWeek = 0;
  for (const r of rows) maxWeek = Math.max(maxWeek, +r[idx.week] || 0);
  for (const r of rows) {
    if (+r[idx.week] !== maxWeek) continue;          // latest published roster
    const rpos = POS_ALIAS[r[idx.position]] ?? r[idx.position];
    if (!POS.includes(rpos)) continue;
    const pid = r[idx.gsis_id];
    if (!pid) continue;
    m.set(pid, { team: r[idx.team], position: rpos, name: r[idx.full_name] });
  }
  return m;
}

/**
 * Same-position teammates ruled Out/Doubtful, keyed by team|position|week for
 * the whole season, plus who is ruled out in the target week.
 *
 * Keyed by week rather than just "this week and last" because new_absence
 * compares against the player's PREVIOUS APPEARANCE, which build_dataset.py
 * gets from a groupby-shift. A bye or a missed game makes that not week-1.
 */
export async function loadInjuries(season, week) {
  const byWeek = new Map();       // `${team}|${pos}|${week}` -> n
  const outIds = new Set();
  const txt = await fetchOptional(`${REL}/injuries/injuries_${season}.csv`);
  if (!txt) { console.log(`  injuries ${season}: not published yet`); return { byWeek, outIds }; }
  const { idx, rows } = parseCsv(txt);
  const questionable = new Set();
  for (const r of rows) {
    const st = r[idx.report_status];
    const wk = +r[idx.week];
    // Questionable players still play, so they stay on the board — but they
    // don't play the same. See QUESTIONABLE_MULT.
    if (st === 'Questionable') {
      if (wk === week && r[idx.gsis_id]) questionable.add(r[idx.gsis_id]);
      continue;
    }
    if (st !== 'Out' && st !== 'Doubtful') continue;
    const k = `${r[idx.team]}|${r[idx.position]}|${wk}`;
    byWeek.set(k, (byWeek.get(k) ?? 0) + 1);
    if (wk === week && r[idx.gsis_id]) outIds.add(r[idx.gsis_id]);
  }
  return { byWeek, outIds, questionable };
}

/**
 * mates_out for this week, and whether that is an increase on what it was at
 * the player's previous appearance this season (new_absence).
 */
export function absenceFeatures({ byWeek, snapLog, pid, team, position, season, week }) {
  const now = byWeek.get(`${team}|${position}|${week}`) ?? 0;
  const earlier = (snapLog.get(pid) ?? [])
    .filter(s => s.season === season && s.week < week);
  // First game of the season has nothing to compare against. build_dataset.py
  // gets NaN from its groupby-shift and fills it with 0, so any absence in
  // place that week counts as new — match that rather than suppressing it.
  const last = earlier[earlier.length - 1];
  const before = last
    ? (byWeek.get(`${last.team}|${last.position}|${last.week}`) ?? 0)
    : 0;
  return { matesOut: now, newAbsence: now > before && now > 0 ? 1 : 0 };
}

// ── main ──────────────────────────────────────────────────────────────────

/**
 * @param schedule  the parsed upcoming-season schedule (needs week/total/spread)
 * @param target    {season, week} to score; defaults to the next unplayed week
 */
export async function buildPicks({ schedule, historySeason, upcomingSeason, target }) {
  const snapSeasons = [];
  for (let y = SNAP_FROM; y <= upcomingSeason; y++) snapSeasons.push(y);
  const rzSeasons = [];
  for (let y = upcomingSeason - RZ_SEASONS + 1; y <= upcomingSeason; y++) rzSeasons.push(y);

  // Which week are we picking? The earliest week with games that have a line
  // and no final score. Books post lines ~1-2 weeks out, so anything further
  // has no implied total and cannot be scored.
  let week = target?.week;
  if (week == null) {
    const open = schedule
      .filter(g => g.homeScore == null && g.total != null)
      .sort((a, b) => a.week - b.week);
    if (!open.length) { console.log('  no upcoming games with lines — no picks'); return null; }
    week = open[0].week;
  }
  const season = target?.season ?? upcomingSeason;
  const games = schedule.filter(g => g.week === week && g.total != null);
  console.log(`Picks: scoring ${season} week ${week} (${games.length} games)…`);

  const { xwalk, birth } = await loadPlayers();
  const snapLog = await loadSnapLog(snapSeasons, xwalk);
  const { rzLog, passLog } = await loadPbpLogs(rzSeasons);
  const roster = await loadRoster(upcomingSeason);
  const { byWeek, outIds, questionable } = await loadInjuries(season, week);

  // Position priors for the shrinkage fallback come from the trained model, so
  // this build does not need all ten seasons loaded to reproduce add_form().
  const teamsInPlay = new Map();
  for (const g of games) {
    const half = g.total / 2, edge = (g.spread ?? 0) / 2;
    teamsInPlay.set(g.home, { opp: g.away, implied: half + edge, gameId: g.gameId, home: 1 });
    teamsInPlay.set(g.away, { opp: g.home, implied: half - edge, gameId: g.gameId, home: 0 });
  }

  const starterQb = passStarters(roster, passLog, season);
  console.log(`  passing market: ${starterQb.size} starting QBs identified`);

  const picks = [];
  for (const [pid, info] of roster) {
    const ctx = teamsInPlay.get(info.team);
    if (!ctx) continue;                                 // not playing this week
    if (outIds.has(pid)) continue;                      // ruled out himself
    const pos = info.position;
    const { matesOut, newAbsence } = absenceFeatures({
      byWeek, snapLog, pid, team: info.team, position: pos, season, week });
    const row = playerFeatures({
      pid, position: pos, season, week, snapLog, rzLog,
      impliedTotal: ctx.implied, matesOut, newAbsence,
    });
    if (!row) continue;                                 // no usage history at all

    // Passing market, one starter per team. Quoting a backup a passing line
    // would be inventing a bet nobody can place. `pass` stays undefined for
    // everyone else, which is how the board knows the market doesn't apply.
    let pass;
    if (pos === 'QB' && starterQb.get(info.team) === pid) {
      const pf = passFeatures({ pid, season, week, passLog, impliedTotal: ctx.implied });
      if (pf.starts >= PASS_MIN_STARTS) {
        const mu = scorePass(pf);
        pass = {
          proj: +mu.toFixed(4),
          starts: pf.starts,
          attPg: +pf.att_pg.toFixed(3),
          ptdPg: +pf.ptd_pg.toFixed(4),
          // One price per line the board quotes, calibrated.
          p: Object.fromEntries(PASS_LINES.map(n => [n, +passProb(mu, n).toFixed(6)])),
          pRaw: Object.fromEntries(PASS_LINES.map(n => [n, +poissonAtLeast(mu, n).toFixed(6)])),
        };
      }
    }

    const q = questionable.has(pid);
    picks.push({
      pid, name: info.name, team: info.team, opp: ctx.opp, pos,
      gameId: ctx.gameId, home: ctx.home,
      ...(pass ? { pass } : {}),
      // p is the price we show — model output passed through the calibration,
      // then shaded if he's Questionable. Shading HERE rather than afterwards
      // matters: the first/last-TD markets are shares of each game's scoring
      // threat and read p.p, so doing it later would leave those markets
      // pricing a healthy version of him.
      p: +(calibrate(score(row)) * (q ? QUESTIONABLE_MULT : 1)).toFixed(6),
      pRaw: +score(row).toFixed(6),
      // the 2+ market, coherent with the 1+ price by construction
      p2: +(calibrate2(calibrate(score(row)) * scoreCond2(row)) * (q ? QUESTIONABLE_MULT : 1)).toFixed(6),
      pCond2: +scoreCond2(row).toFixed(6),
      ...(q ? { q: 1 } : {}),
      // Factors, for the UI. Kept at enough precision that the modal's
      // log-odds waterfall reconstructs the shipped price exactly — it claims
      // the bars sum with nothing left over, so they have to.
      f: {
        snap3: +row.snap_last3.toFixed(6),
        snapPrior: +row.snap_share_prior.toFixed(6),
        rz: +row.rz_touches_prior.toFixed(6),
        implied: +row.implied_total.toFixed(4),
        matesOut: row.mates_out, newAbsence: row.new_absence,
      },
    });
  }

  // Cap the board per team. In preseason weekly_rosters is a 90-man roster, so
  // scoring everyone on it yields ~800 rows for a 16-game slate against the ~11
  // players a team actually gives offensive snaps to. The tail is all players
  // who will not dress; keeping it would bloat data.json and bury the board.
  const buckets = new Map();
  for (const p of picks) {
    const k = `${p.team}|${p.pos}`;
    (buckets.get(k) ?? buckets.set(k, []).get(k)).push(p);
  }
  const kept = [];
  for (const [k, arr] of buckets) {
    arr.sort((a, b) => b.p - a.p);
    kept.push(...arr.slice(0, PER_TEAM_POS[k.split('|')[1]] ?? 3));
  }
  picks.length = 0;
  picks.push(...kept);
  // ── first-TD market ───────────────────────────────────────────────────
  // Exactly one player scores the game's opening touchdown, so this is a
  // competition, not an independent event: a player's chance is his share of
  // the scoring threat in HIS game. Two backs with identical anytime prices can
  // sit 2x apart here purely because one of them is boxed in with three other
  // likely scorers. Computed AFTER the per-position cap so the denominator is
  // the board being shown, which is also closest in size to the pool the
  // calibration was fitted on.
  const gameSum = new Map();
  for (const p of picks) gameSum.set(p.gameId, (gameSum.get(p.gameId) ?? 0) + p.p);
  const raw = new Map(), rawL = new Map();
  for (const p of picks) {
    const share = p.p / (gameSum.get(p.gameId) || 1);
    raw.set(p, calibrate3(share * CALIB.first_share));
    rawL.set(p, calibrate4(share * CALIB.first_share));
    p.pFirstRaw = +(share * CALIB.first_share).toFixed(6);
  }
  // Re-normalise AFTER calibrating so each game's first-TD probabilities sum
  // back to first_share. Exactly one player scores first, so that sum is a real
  // constraint, not a nicety — and enforcing it makes the market robust to how
  // many players the board happens to carry. Without it the prices ride on pool
  // composition: this board holds ~30 players a game against the ~24 who
  // actually take a snap in the backtest, which alone would have made every
  // first-TD price roughly a quarter too long.
  const calSum = new Map(), calSumL = new Map();
  for (const p of picks) {
    calSum.set(p.gameId, (calSum.get(p.gameId) ?? 0) + raw.get(p));
    calSumL.set(p.gameId, (calSumL.get(p.gameId) ?? 0) + rawL.get(p));
  }
  for (const p of picks) {
    p.pFirst = +(raw.get(p) * (CALIB.first_share / (calSum.get(p.gameId) || 1))).toFixed(6);
    p.pLast = +(rawL.get(p) * (CALIB.last_share / (calSumL.get(p.gameId) || 1))).toFixed(6);
  }
  for (const [lab, key, want] of [['first', 'pFirst', CALIB.first_share], ['last', 'pLast', CALIB.last_share]]) {
    const chk = [...new Set(picks.map(p => p.gameId))]
      .map(g => picks.filter(p => p.gameId === g).reduce((a, b) => a + b[key], 0));
    console.log(`  ${lab}-TD per-game sums: ${Math.min(...chk).toFixed(3)}-${Math.max(...chk).toFixed(3)}`
              + ` (must equal ${want.toFixed(3)})`);
  }

  picks.sort((a, b) => b.p - a.p);
  console.log(`  scored ${picks.length} players; top ${picks[0]?.name} ${picks[0]?.p} (raw ${picks[0]?.pRaw})`);
  // ── birthdays ─────────────────────────────────────────────────────────
  // Who is playing on or near his birthday this week. Carries each player's
  // pick probability so the tool ties back to the board.
  const gameday = new Map(games.map(g => [g.gameId, g.gameday]));
  const bdays = [];
  for (const p of picks) {
    const b = birth.get(p.pid);
    const gd = gameday.get(p.gameId);
    if (!b || !gd) continue;
    const [by, bm, bd] = b.split('-').map(Number);
    const g = new Date(gd + 'T12:00:00Z');
    // distance in days between the birthday and kickoff, wrapping the year
    const thisYear = Date.UTC(g.getUTCFullYear(), bm - 1, bd, 12);
    const raw = Math.round((thisYear - g.getTime()) / 86400000);
    const off = Math.abs(raw) > 182 ? raw - Math.sign(raw) * 365 : raw;
    if (Math.abs(off) > 6) continue;
    const rec = BDAY.players[p.pid];
    bdays.push({
      pid: p.pid, name: p.name, team: p.team, opp: p.opp, pos: p.pos, home: p.home,
      gameday: gd, birth: b, turning: g.getUTCFullYear() - by, off, p: p.p,
      // [games, TDs] on his birthday and within a few days of it, since 2016
      on: rec?.on || null, near: rec?.near || null,
    });
  }
  bdays.sort((a, b) => Math.abs(a.off) - Math.abs(b.off) || b.p - a.p);
  console.log(`  birthdays within a week of kickoff: ${bdays.length}`
            + ` (${bdays.filter(x => x.off === 0).length} on the day)`);

  return {
    season, week, generatedAt: new Date().toISOString(),
    birthdays: bdays, birthdayStats: BDAY.league, birthdaySeasons: BDAY.seasons,
    birthdayBase: BDAY.base_rate,
    // Ship the fitted model with the board so the UI can decompose each price
    // into its parts. A logistic is additive in log-odds, so contribution =
    // coef * (x - mean) / sd — an exact attribution, not a heuristic.
    model: {
      trained_on: MODEL.trained_on, base_rate: MODEL.base_rate,
      features: MODEL.features, coef: MODEL.coef, scale: MODEL.scale,
      reference_position: MODEL.reference_position, calibrated: true,
      cond2: MODEL.cond2, markets: ['1+', '2+', '1st', 'last'],
    },
    picks,
  };
}

/**
 * Who actually scored an offensive TD, as `${pid}|${week}`, for grading past
 * picks. Returns null when the season's play-by-play is not published yet.
 */
export async function loadTdSet(season) {
  const txt = await fetchOptional(`${REL}/pbp/play_by_play_${season}.csv`);
  if (!txt) return null;
  const { idx, rows } = parseCsv(txt);
  const set = new Set();
  for (const r of rows) {
    if (r[idx.pass_touchdown] !== '1' && r[idx.rush_touchdown] !== '1') continue;
    const pid = r[idx.td_player_id];
    if (pid) set.add(`${pid}|${r[idx.week]}`);
  }
  return set;
}

/**
 * Carry the pick log forward and grade whatever can now be graded.
 *
 * Each week is FROZEN the first time it is written, at its pre-game state — the
 * whole point is to keep what the model said before kickoff, so a later rebuild
 * must never rewrite a week's probabilities. Only `scored`/`graded` get filled
 * in afterwards. Same freeze rule as the MLB tool's picksHistory.
 */
export function updateHistory(prevHistory, current, tdSet, keepWeeks = 25) {
  const hist = Array.isArray(prevHistory) ? prevHistory.map(w => ({ ...w })) : [];

  if (current && !hist.some(w => w.season === current.season && w.week === current.week)) {
    hist.push({
      season: current.season, week: current.week,
      generatedAt: current.generatedAt, graded: false,
      rows: current.picks.map(p => ({ pid: p.pid, name: p.name, team: p.team,
                                      pos: p.pos, p: p.p })),
    });
  }
  if (tdSet) {
    for (const w of hist) {
      if (w.graded) continue;
      let any = false;
      for (const r of w.rows) {
        const hit = tdSet.has(`${r.pid}|${w.week}`);
        if (hit) any = true;
        r.scored = hit ? 1 : 0;
      }
      // only mark graded once the week has actually been played, which we infer
      // from at least one of its players having scored
      if (any) w.graded = true;
    }
  }
  hist.sort((a, b) => a.season - b.season || a.week - b.week);
  return hist.slice(-keepWeeks);
}
