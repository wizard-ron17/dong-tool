// P(HR today) for a starting batter — the MLB odds model (v1).
//
// Fitted in research/mlb_hr_replay.py on every 2025-26 starter-game (87,822),
// strictly out of sample, and exported to research/mlb_hr_model.json. This file
// only applies it; change the model there, never here.
//
//   logit P = platt.a + platt.b * ( const
//             + bat_rate * ln(HR/AB)          his season, shrunk toward last
//             + bat_brl  * ln(barrels/PA)     season, shrunk toward the league
//             + bat_bls  * ln(blasts/PA)
//             + sp_bpf   * ln(starter barrels per batter faced)
//             + slot[order] + park * ln(park factor) )
//
// The score and every matchup factor are untouched: this is a separate,
// calibrated layer. Only what the replay measured goes in — the board's own
// matchup factors earn a weight once the full-slate log can measure them.
//
// The pieces are separable, so each batter and each starter ships his own
// part (batterZ, pitcherZ) and the page adds slot and park for any pairing.
import fs from 'node:fs';

const M = JSON.parse(fs.readFileSync(new URL('../research/mlb_hr_model.json', import.meta.url), 'utf8'));
const C = M.coef, K = M.k, LG = M.lg;

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

/** The batter's part of the log-odds: power and contact quality. */
export function batterZ({ pid, hr = 0, ab = 0, pa = 0, barrels = 0, blasts = 0 }) {
  const [pHr, pAb, pBrl, pBls, pPa] = M.prev_batters[String(pid)] || [0, 0, 0, 0, 0];
  const rate = shrunk(hr, ab, pHr, pAb, K.bat, LG.ab);
  const brl = shrunk(barrels, pa, pBrl, pPa, K.contact, LG.brl);
  const bls = shrunk(blasts, pa, pBls, pPa, K.contact, LG.bls);
  return C.bat_rate * Math.log(rate) + C.bat_brl * Math.log(brl) + C.bat_bls * Math.log(bls);
}
/** The starter's part: barrels he's allowed per batter faced. Unknown arm = league. */
export function pitcherZ({ pid, barrels = 0, bf = 0 } = {}) {
  const [pBrl, pBf] = (pid && M.prev_pitchers[String(pid)]) || [0, 0];
  return C.sp_bpf * Math.log(shrunk(barrels, bf, pBrl, pBf, K.sp, LG.pbf));
}
/** Park multiplier table keyed by venue name, and the constants the page needs. */
export function oddsConstants(normalizeVenue = (v) => v) {
  const park = {};
  for (const [v, f] of Object.entries(M.park)) park[normalizeVenue(v)] = f;
  return {
    v: 1, trained: M.trained, platt: M.platt, const: C.const, park: C.park, parkTable: park,
    slot: [0, 0, ...[2, 3, 4, 5, 6, 7, 8, 9].map(s => C[`slot${s}`])],   // index = lineup slot (0/1 = top)
  };
}
/** P(HR) from the two parts, his lineup slot and the park. */
export function hrProb(bz, pz, order, venue, K0) {
  const slot = K0.slot[order >= 1 && order <= 9 ? order : 5] ?? 0;   // unknown slot: middle of the order
  const pf = K0.parkTable[venue] ?? 1;
  const z = K0.const + bz + pz + slot + K0.park * Math.log(pf);
  return 1 / (1 + Math.exp(-(K0.platt.a + K0.platt.b * z)));
}
