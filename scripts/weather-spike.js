// Weather spike — standalone, prints tonight's slate with computed carry/wind
// factors. Not wired into the build; run with `node scripts/weather-spike.js`.
//
// Pipeline: MLB schedule (venue coords + azimuth + roof, one hydrate) ->
// Open-Meteo hourly for each outdoor game's window -> air-density carry factor
// + wind-along-CF-axis factor -> a single weatherRatio. Roofed parks (roofType
// Retractable/Dome) short-circuit to neutral. Nothing hardcoded — orientation,
// roof, coords, and elevation all come straight off the MLB API.

const MLB = 'https://statsapi.mlb.com/api/v1';
const OM  = 'https://api.open-meteo.com/v1/forecast';

// Tunables — physically motivated, not fit to any one source.
const CARRY_EXP    = 1.4;   // HR rate is a bit more density-sensitive than raw distance
const WIND_DAMPEN  = 0.55;  // 10m forecast wind → effective wind a fly ball feels in the bowl
const WIND_PER_MPH = 0.010; // ~1% HR swing per mph of (dampened) wind out/in to CF
const CLAMP = [0.85, 1.20];

// No hardcoded park table — the MLB Stats API already carries everything on
// the venue: location.azimuthAngle is the home-plate→CF bearing (Wrigley 37°,
// Fenway 45°, Comerica 150° — all confirmed), fieldInfo.roofType is
// Open/Retractable/Dome, and location has coords + elevation. We hydrate
// venue(location,fieldInfo) on the schedule and read it straight off each game.
const isRoofed = roofType => roofType && roofType !== 'Open'; // Retractable/Dome → neutral

// Air density (kg/m³) from temp (°F), relative humidity (%), pressure (hPa).
// Humid air is LESS dense (water vapor is lighter than dry air), so this
// correctly makes muggy nights carry slightly better.
function airDensity(tempF, rh, pressureHpa) {
  const Tc = (tempF - 32) * 5 / 9;
  const T  = Tc + 273.15;
  const P  = pressureHpa * 100;                                   // Pa
  const Psat = 6.1078 * Math.pow(10, (7.5 * Tc) / (Tc + 237.3)) * 100; // Pa (Tetens)
  const Pv = (rh / 100) * Psat;
  const Pd = P - Pv;
  return Pd / (287.058 * T) + Pv / (461.495 * T);
}
const RHO0 = airDensity(70, 50, 1013.25); // league-typical baseline

// Signed wind component along the home->CF axis. + = blowing OUT to center
// (helps HR), - = blowing IN from center (suppresses). windFrom is the
// meteorological "direction it comes from"; the ball cares where it's going.
function windAlongCF(speedMph, windFromDeg, cfAzimuth) {
  const windTo = (windFromDeg + 180) % 360;
  const diff = (((cfAzimuth - windTo + 540) % 360) - 180) * Math.PI / 180;
  return speedMph * Math.cos(diff);
}
function windLabel(windFromDeg, cfAzimuth) {
  const windTo = (windFromDeg + 180) % 360;
  const d = Math.abs((((cfAzimuth - windTo + 540) % 360) - 180));
  return d <= 45 ? 'OUT to CF' : d >= 135 ? 'IN from CF' : 'across';
}
const clamp = (x, [lo, hi]) => Math.max(lo, Math.min(hi, x));

async function main() {
  const date = process.argv[2] || new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
  const sched = await fetch(`${MLB}/schedule?sportId=1&date=${date}&gameType=R&hydrate=venue(location,fieldInfo)`).then(r => r.json());
  const games = sched.dates?.[0]?.games ?? [];
  console.log(`\n=== Weather spike — ${date} — ${games.length} games ===`);
  console.log(`baseline air density ρ₀ = ${RHO0.toFixed(3)} kg/m³ (70°F, 50% RH, 1013 hPa)`);
  console.log(`tunables: CARRY_EXP=${CARRY_EXP}, WIND_PER_MPH=${WIND_PER_MPH}, clamp=${CLAMP.join('–')}\n`);

  for (const g of games) {
    const v = g.venue ?? {};
    const cf = v.location?.azimuthAngle;                 // home plate → CF bearing
    const label = `${v.name ?? '(unknown venue)'} [id ${v.id}]`;
    if (isRoofed(v.fieldInfo?.roofType)) { console.log(`🏟️  ${label} — ${v.fieldInfo.roofType} roof → neutral ×1.00\n`); continue; }
    if (cf == null || !v.location?.defaultCoordinates) { console.log(`⚠️  ${label} — no azimuth/coords from API\n`); continue; }

    const { latitude: lat, longitude: lon } = v.location.defaultCoordinates;
    const q = `latitude=${lat}&longitude=${lon}&hourly=temperature_2m,relative_humidity_2m,surface_pressure,wind_speed_10m,wind_direction_10m,wind_gusts_10m&temperature_unit=fahrenheit&wind_speed_unit=mph&timezone=GMT`;
    const wx = await fetch(`${OM}?${q}`).then(r => r.json());
    const h = wx.hourly;

    // Game window: 3 hours starting at first pitch (UTC-aligned to Open-Meteo GMT).
    const key = g.gameDate.slice(0, 13) + ':00';
    const i0 = h.time.indexOf(key);
    if (i0 < 0) { console.log(`⛅ ${label} — forecast not available for game hour\n`); continue; }
    const idx = [i0, i0 + 1, i0 + 2].filter(i => i < h.time.length);
    const avg = arr => arr.reduce((a, b) => a + b, 0) / arr.length;
    const temp = avg(idx.map(i => h.temperature_2m[i]));
    const rh   = avg(idx.map(i => h.relative_humidity_2m[i]));
    const pres = avg(idx.map(i => h.surface_pressure[i]));

    const rho = airDensity(temp, rh, pres);
    const densIndex = RHO0 / rho;                       // >1 = thinner air, more carry
    const carry = Math.pow(densIndex, CARRY_EXP);

    // Project each hour onto the CF axis, THEN average — averaging bearings
    // directly is meaningless when wind swings hour to hour. Same for the
    // display headline: use the vector-mean wind, not the scalar-mean bearing.
    const outRaw = avg(idx.map(i => windAlongCF(h.wind_speed_10m[i], h.wind_direction_10m[i], cf)));
    const out = WIND_DAMPEN * outRaw;                                   // effective field-level component
    const uTo = avg(idx.map(i => h.wind_speed_10m[i] * Math.sin(((h.wind_direction_10m[i] + 180) % 360) * Math.PI / 180)));
    const vTo = avg(idx.map(i => h.wind_speed_10m[i] * Math.cos(((h.wind_direction_10m[i] + 180) % 360) * Math.PI / 180)));
    const spd = Math.hypot(uTo, vTo);                                   // vector-mean speed (mph)
    const wdir = (Math.atan2(uTo, vTo) * 180 / Math.PI + 180 + 360) % 360; // back to "from" bearing
    const windFactor = 1 + WIND_PER_MPH * out;
    const weather = clamp(carry * windFactor, CLAMP);

    const localHrs = idx.map(i => {
      const off = wx.utc_offset_seconds ?? 0;
      return new Date(new Date(h.time[i] + 'Z').getTime() + off * 1000).getUTCHours();
    });
    console.log(`⚾ ${label} (CF ${cf}° per API)  ${g.teams.away.team.name} @ ${g.teams.home.team.name}`);
    console.log(`   hrs ${localHrs[0]}:00–${localHrs[localHrs.length-1]}:00 local | ${temp.toFixed(0)}°F, ${rh.toFixed(0)}% RH, ${pres.toFixed(0)} hPa`);
    console.log(`   wind ${spd.toFixed(1)} mph from ${wdir.toFixed(0)}° → ${windLabel(wdir, cf)} (${outRaw >= 0 ? '+' : ''}${outRaw.toFixed(1)} mph raw → ${out >= 0 ? '+' : ''}${out.toFixed(1)} eff)`);
    console.log(`   per-hr wind:`, idx.map(i => `${h.wind_speed_10m[i].toFixed(0)}@${h.wind_direction_10m[i].toFixed(0)}°`).join('  '));
    console.log(`   air ρ ${rho.toFixed(3)} (${((densIndex - 1) * 100 >= 0 ? '+' : '')}${((densIndex - 1) * 100).toFixed(1)}% vs base) → carry ×${carry.toFixed(3)} · wind ×${windFactor.toFixed(3)}`);
    console.log(`   ➜ WEATHER ×${weather.toFixed(3)}\n`);
  }
}
main().catch(e => { console.error(e); process.exit(1); });
