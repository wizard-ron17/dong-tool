// Wind forecast for the upcoming slate.
//
// research/receptions.py measures wind as the one environment feature that
// survives for receptions — but only in the tail. Averaged over a season it is
// worth -0.0001 of log loss, because 89% of games never reach 15 mph. In the
// games that do it is large: out of sample, a model WITHOUT wind over-projects
// catches by 18.0% at 20+ mph and 7.9% at 15-20, against 2.3% in calm air.
// Teams throw less (37.0 attempts at 0-5 mph, 34.2 at 20+) and complete less of
// what they throw (66.3% to 63.0%).
//
// Without a forecast the feature is inert and every game prices calm. This
// supplies it: open-meteo, keyless, hourly wind at the venue, sampled at
// kickoff.
import fs from 'node:fs';

const COORDS = JSON.parse(
  fs.readFileSync(new URL('./venue-coords.json', import.meta.url), 'utf8')).venues;

/** Domes and closed roofs are wind 0 by construction and need no lookup. */
const OUTDOOR = (roof) => roof === 'outdoors' || roof === 'open';

/**
 * gameId -> wind mph at kickoff, for the games we can forecast.
 *
 * Unknown venue, missing roof, a game outside the forecast horizon or a failed
 * request all fall back to CALM rather than to a guess — the feature only ever
 * subtracts from a projection, so a silent wrong value would be worse than no
 * value. Every fallback is counted and reported.
 */
export async function loadWind(schedule, { threshold = 15 } = {}) {
  const out = new Map();
  const skip = { indoor: 0, noVenue: 0, noTime: 0, horizon: 0, failed: 0 };
  const byPoint = new Map();                  // `${lat},${lon}` -> [games]

  for (const g of schedule) {
    if (!OUTDOOR(g.roof)) { skip.indoor++; continue; }
    const v = COORDS[g.stadium];
    if (!v) { skip.noVenue++; continue; }
    if (!g.gameday || !g.gametime) { skip.noTime++; continue; }
    const k = `${v.lat},${v.lon}`;
    (byPoint.get(k) ?? byPoint.set(k, []).get(k)).push(g);
  }
  if (!byPoint.size) return { wind: out, skip, threshold };

  // One request per distinct venue covering the whole slate, not one per game.
  const days = [...new Set(schedule.map(g => g.gameday).filter(Boolean))].sort();
  const start = days[0], end = days[days.length - 1];

  await Promise.all([...byPoint.entries()].map(async ([k, games]) => {
    const [lat, lon] = k.split(',');
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}`
      + `&hourly=wind_speed_10m&wind_speed_unit=mph&timezone=UTC`
      + `&start_date=${start}&end_date=${end}`;
    let j;
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(20000) });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      j = await r.json();
    } catch (e) { skip.failed += games.length; return; }
    const times = j?.hourly?.time ?? [], speeds = j?.hourly?.wind_speed_10m ?? [];
    if (!times.length) { skip.failed += games.length; return; }
    const at = new Map(times.map((t, i) => [t.slice(0, 13), speeds[i]]));
    for (const g of games) {
      // gametime is venue-local wall clock; the forecast is requested in UTC.
      // Hour-of-day precision is all this needs — wind does not swing on a
      // 3-hour offset the way temperature does, and the model only reads a
      // 15 mph threshold.
      const hh = String(g.gametime).slice(0, 2).padStart(2, '0');
      const key = `${g.gameday}T${hh}`;
      const w = at.get(key) ?? at.get(`${g.gameday}T12`);
      if (w == null) { skip.horizon++; continue; }
      out.set(g.gameId, Math.round(w * 10) / 10);
    }
  }));
  return { wind: out, skip, threshold };
}

// No hinge helper any more: the model takes raw mph and applies a measured
// multiplier (windFactor in receptions.js). A max(wind - 15, 0) transform threw
// away the 89% of games below the threshold, which still carry 2-4% of effect.
