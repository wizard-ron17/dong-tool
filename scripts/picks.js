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

const POS = ['RB', 'WR', 'TE', 'FB'];
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
// Players kept per team. Teams give offensive snaps to ~11 skill players a game
// (median 11, p90 12 across 2016-2025), so 14 keeps the real rotation plus room
// for a surprise without carrying the inactive tail.
const PER_TEAM = 14;
const MODEL = JSON.parse(
  fs.readFileSync(new URL('../research/model.json', import.meta.url), 'utf8'));

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

// ── data loading ──────────────────────────────────────────────────────────

export async function loadCrosswalk() {
  const { idx, rows } = parseCsv(await fetchText(`${REL}/players/players.csv`));
  // weekly_rosters looks like it would do this job but its pfr_id is null ~36%
  // of the time, and the players it misses skew to low snap share — exactly the
  // low-probability rows. Dropping them silently inflates the base rate.
  const m = new Map();
  for (const r of rows) {
    const g = r[idx.gsis_id], p = r[idx.pfr_id];
    if (g && p && !m.has(p)) m.set(p, g);
  }
  return m;
}

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
export async function loadRzLog(seasons) {
  const log = new Map();          // pid -> [{season, week, rz}]
  for (const y of seasons) {
    const txt = await fetchOptional(`${REL}/pbp/play_by_play_${y}.csv`);
    if (!txt) { console.log(`  pbp ${y}: not published yet`); continue; }
    const { idx, rows } = parseCsv(txt);
    const per = new Map();        // `${pid}|${week}` -> rz touches
    for (const r of rows) {
      const yl = num(r[idx.yardline_100]);
      if (yl == null || yl > 20) continue;
      const ids = [];
      if (r[idx.rush_attempt] === '1' && r[idx.rusher_player_id]) ids.push(r[idx.rusher_player_id]);
      if (r[idx.pass_attempt] === '1' && r[idx.receiver_player_id]) ids.push(r[idx.receiver_player_id]);
      for (const pid of ids) {
        const k = `${pid}|${r[idx.week]}`;
        per.set(k, (per.get(k) ?? 0) + 1);
      }
    }
    for (const [k, rz] of per) {
      const [pid, wk] = k.split('|');
      (log.get(pid) ?? log.set(pid, []).get(pid)).push({ season: y, week: +wk, rz });
    }
  }
  for (const v of log.values())
    v.sort((a, b) => a.season - b.season || a.week - b.week);
  return log;
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
  for (const r of rows) {
    const st = r[idx.report_status];
    if (st !== 'Out' && st !== 'Doubtful') continue;
    const wk = +r[idx.week];
    const k = `${r[idx.team]}|${r[idx.position]}|${wk}`;
    byWeek.set(k, (byWeek.get(k) ?? 0) + 1);
    if (wk === week && r[idx.gsis_id]) outIds.add(r[idx.gsis_id]);
  }
  return { byWeek, outIds };
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

  const xwalk = await loadCrosswalk();
  const snapLog = await loadSnapLog(snapSeasons, xwalk);
  const rzLog = await loadRzLog(rzSeasons);
  const roster = await loadRoster(upcomingSeason);
  const { byWeek, outIds } = await loadInjuries(season, week);

  // Position priors for the shrinkage fallback come from the trained model, so
  // this build does not need all ten seasons loaded to reproduce add_form().
  const teamsInPlay = new Map();
  for (const g of games) {
    const half = g.total / 2, edge = (g.spread ?? 0) / 2;
    teamsInPlay.set(g.home, { opp: g.away, implied: half + edge, gameId: g.gameId, home: 1 });
    teamsInPlay.set(g.away, { opp: g.home, implied: half - edge, gameId: g.gameId, home: 0 });
  }

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

    picks.push({
      pid, name: info.name, team: info.team, opp: ctx.opp, pos,
      gameId: ctx.gameId, home: ctx.home,
      p: +score(row).toFixed(4),
      f: {                                              // factors, for the UI
        snap3: +row.snap_last3.toFixed(3),
        snapPrior: +row.snap_share_prior.toFixed(3),
        rz: +row.rz_touches_prior.toFixed(2),
        implied: +row.implied_total.toFixed(1),
        matesOut: row.mates_out, newAbsence: row.new_absence,
      },
    });
  }

  // Cap the board per team. In preseason weekly_rosters is a 90-man roster, so
  // scoring everyone on it yields ~800 rows for a 16-game slate against the ~11
  // players a team actually gives offensive snaps to. The tail is all players
  // who will not dress; keeping it would bloat data.json and bury the board.
  const perTeam = new Map();
  for (const p of picks) {
    const arr = perTeam.get(p.team) ?? perTeam.set(p.team, []).get(p.team);
    arr.push(p);
  }
  const kept = [];
  for (const arr of perTeam.values()) {
    arr.sort((a, b) => b.p - a.p);
    kept.push(...arr.slice(0, PER_TEAM));
  }
  picks.length = 0;
  picks.push(...kept);
  picks.sort((a, b) => b.p - a.p);
  console.log(`  scored ${picks.length} players; top ${picks[0]?.name} ${picks[0]?.p}`);
  return {
    season, week, generatedAt: new Date().toISOString(),
    model: { trained_on: MODEL.trained_on, base_rate: MODEL.base_rate },
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
