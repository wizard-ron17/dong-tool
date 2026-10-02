// P(HR today) for a starting batter — the MLB odds model (v2, v1 as fallback).
//
// Fitted in research/mlb_hr_replay.py (v1) and research/mlb_hr_factors.py (v2)
// on every 2026 starter-game, strictly out of sample, and exported to
// research/mlb_hr_model.json. This file only applies it; change the model
// there, never here.
//
//   logit P = platt.a + platt.b * ( const
//             + bat_rate * ln(HR/AB)          his season, shrunk toward last
//             + bat_brl  * ln(barrels/PA)     season, shrunk toward the league
//             + bat_bls  * ln(blasts/PA)
//             + pull_air_rate * ln(pulled air balls per PA vs league)     v2
//             + days_since_hr * days since his last homer (cap 60)       v2
//             + sp_bpf   * ln(starter barrels per batter faced)
//             + velo_td  * starter's 4-seam + sinker velo                v2
//             + slot[order] + park * ln(park factor)
//             + temp_x * (temp - 72)/10 + wind_out * mph out + day )     v2, the game's part
//
// research/mlb_hr_factors.py tested every Pick Score factor here: at the
// score's weights they made the odds worse, and platoon, recent contact,
// streaks, "due" and blast surplus add nothing. Only what earned a weight is in.
//
// The pieces are separable, so each batter, each starter and each game ships
// its own part (batterZ, pitcherZ, gameZ) and the page adds slot and park.
import fs from 'node:fs';

const M = JSON.parse(fs.readFileSync(new URL('../research/mlb_hr_model.json', import.meta.url), 'utf8'));
const V2 = M.v2 || null;                          // v1's priors, shrinks and park table, v2's coefficients
const C = V2 ? V2.coef : M.coef, K = M.k, LG = M.lg;
const term = (k) => C[k] ?? 0;                    // a v2 term reads 0 under v1

/** A rate this season, shrunk toward last season's, itself shrunk toward the league. */
function shrunk(n, d, prevN, prevD, k, lg) {
  const prior = (prevN + K.prior * lg) / (prevD + K.prior);
  return (n + k * prior) / (d + k);
}

// The replay's blast (research/mlb_barrels_fetch.py): squared-up % plus bat
// speed >= 164 on a batted ball. NOT the board's isBlast() (squared-up >= 80%
// and 75+ mph) — the odds must use the definition they were fitted on.
export function isBlastV1(row) {
  const ev = parseFloat(row.launch_speed), bs = parseFloat(row.bat_speed), ps = parseFloat(row.release_speed);
  if (isNaN(ev) || isNaN(bs) || isNaN(ps) || bs <= 0) return false;
  const sq = Math.min(1, ev / (1.23 * bs + 0.23 * ps));
  return sq * 100 + bs >= 164;
}
/** Barrels and blasts over a batter's season batted balls (Savant rows). */
export function contactCounts(balls) {
  let barrels = 0, blasts = 0;
  for (const r of balls || []) {
    if (isNaN(parseFloat(r.launch_speed))) continue;
    if (r.launch_speed_angle === '6') barrels++;
    if (isBlastV1(r)) blasts++;
  }
  return { barrels, blasts };
}

/**
 * Pulled fly balls and line drives over a batter's season batted balls (Savant
 * rows): spray angle past 15 degrees to his pull side, as research computes it.
 */
export function pulledAir(balls) {
  let n = 0;
  for (const r of balls || []) {
    if (r.bb_type !== 'fly_ball' && r.bb_type !== 'line_drive') continue;
    const x = parseFloat(r.hc_x), y = parseFloat(r.hc_y);
    if (isNaN(x) || isNaN(y)) continue;
    const ang = Math.atan2(x - 125.42, 198.27 - y) * 180 / Math.PI;
    if ((r.stand === 'R' && ang < -15) || (r.stand === 'L' && ang > 15)) n++;
  }
  return n;
}

/** The batter's part of the log-odds: power, contact quality, pulled air balls and his drought. */
export function batterZ({ pid, hr = 0, ab = 0, pa = 0, barrels = 0, blasts = 0, pulled = 0, daysSinceHr = null }) {
  const [pHr, pAb, pBrl, pBls, pPa] = M.prev_batters[String(pid)] || [0, 0, 0, 0, 0];
  const rate = shrunk(hr, ab, pHr, pAb, K.bat, LG.ab);
  const brl = shrunk(barrels, pa, pBrl, pPa, K.contact, LG.brl);
  const bls = shrunk(blasts, pa, pBls, pPa, K.contact, LG.bls);
  let z = C.bat_rate * Math.log(rate) + C.bat_brl * Math.log(brl) + C.bat_bls * Math.log(bls);
  if (V2) {
    const pull = (pulled + V2.pull_k * V2.pull_lg) / (pa + V2.pull_k) / V2.pull_lg;
    const days = Math.min(V2.days_cap, daysSinceHr ?? V2.days_cap);
    z += term('pull_air_rate') * Math.log(pull) + term('days_since_hr') * days;
  }
  return z;
}
/** The starter's part: barrels he's allowed per batter faced, and (v2) his fastball velo. Unknown arm = league / median. */
export function pitcherZ({ pid, barrels = 0, bf = 0, velo = null } = {}) {
  const [pBrl, pBf] = (pid && M.prev_pitchers[String(pid)]) || [0, 0];
  let z = C.sp_bpf * Math.log(shrunk(barrels, bf, pBrl, pBf, K.sp, LG.pbf));
  if (V2) z += term('velo_td') * (velo ?? V2.velo_median);
  return z;
}
/**
 * The game's part (v2): temperature, wind blowing out or in, day or night.
 * Under a roof the weather is neutral. windTo / cfAzimuth are bearings; the
 * wind counts as out within wind_out_deg of center field, in within that of
 * home plate, and nothing across, as MLB's own "Out To LF" / "In From RF" reads do.
 */
export function gameZ({ roofed = false, temp = null, windMph = 0, windTo = null, cfAzimuth = null, day = false } = {}) {
  if (!V2) return 0;
  let z = term('day') * (day ? 1 : 0);
  if (roofed) return z;
  if (temp != null) z += term('temp_x') * (temp - V2.temp_ref) / 10;
  if (windMph && windTo != null && cfAzimuth != null) {
    const d = Math.abs(((windTo - cfAzimuth + 540) % 360) - 180);       // 0 = straight out to CF
    const out = d <= V2.wind_out_deg ? windMph : d >= 180 - V2.wind_out_deg ? -windMph : 0;
    z += term('wind_out') * out;
  }
  return z;
}
/** Park multiplier table keyed by venue name, and the constants the page needs. */
export function oddsConstants(normalizeVenue = (v) => v) {
  const park = {};
  for (const [v, f] of Object.entries(M.park)) park[normalizeVenue(v)] = f;
  return {
    v: V2 ? 2 : 1, trained: V2?.trained ?? M.trained, platt: V2 ? V2.platt : M.platt, const: C.const, park: C.park, parkTable: park,
    slot: [0, 0, ...[2, 3, 4, 5, 6, 7, 8, 9].map(s => C[`slot${s}`])],   // index = lineup slot (0/1 = top)
  };
}
/** P(HR) from the batter's, starter's and game's parts, his lineup slot and the park. */
export function hrProb(bz, pz, order, venue, K0, gz = 0) {
  const slot = K0.slot[order >= 1 && order <= 9 ? order : 5] ?? 0;   // unknown slot: middle of the order
  const pf = K0.parkTable[venue] ?? 1;
  const z = K0.const + bz + pz + gz + slot + K0.park * Math.log(pf);
  return 1 / (1 + Math.exp(-(K0.platt.a + K0.platt.b * z)));
}
