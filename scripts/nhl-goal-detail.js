// Per-goal detail for the recap and the reels: how far out, what kind of shot,
// which goalie it beat, and how hard the puck was moving.
//
//   api-web /gamecenter/{id}/play-by-play -> every goal's rink coordinates
//     (feet, centre ice 0, nets at x = ±89), shot type, goalie in net, and a
//     link to its tracking replay
//   wsr.nhle.com sprites                   -> that replay: every skater and the
//     puck, ten frames a second, in INCHES (a 200 x 85 ft sheet is 2400 x 1020)
//
// The sprites answer 403 to a bare request and 200 to one that looks like the
// nhl.com page that embeds them, so the headers below are the whole trick. They
// are also the part most likely to break — every caller treats a missing speed
// as "no speed", never as a failed build.
import { web } from './nhl-api.js';

const NET_X = 89;          // goal line, feet from centre ice
const SPRITE_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15',
  Referer: 'https://www.nhl.com/', Origin: 'https://www.nhl.com',
};
const IN_PER_S_TO_MPH = 3600 / (12 * 5280);

/**
 * Peak puck speed on the shot, in mph, from the tracking replay.
 *
 * The replay runs a few seconds either side of the goal: the play before it,
 * the shot, and the puck rattling around the net after. Two anchors pick the
 * shot out of that:
 *   1. the frame the puck crosses the goal line inside the posts, and
 *   2. the last frame before that where it was still as far from the net as
 *      the play-by-play says he shot from — the release.
 * The fastest 0.1 s step between them is the shot. A cross-ice pass before
 * the release and the puck dribbling round the net after never enter it, and
 * a deflection reads as the shot that was deflected, which is the number
 * anyone quoting "shot speed" means anyway.
 *
 * At ten frames a second each step averages 0.1 s, and the one the puck hits
 * the net in is cut short by the twine — so this reads a little low, never high.
 */
const LINE_IN = 11 * 12, RINK_IN = 200 * 12, MID_Y = 510;
export function puckSpeed(frames, distFt) {
  const pts = [];
  for (const f of frames || []) {
    const p = f.onIce?.['1'];
    if (p && Number.isFinite(p.x) && Number.isFinite(p.y)) pts.push({ t: f.timeStamp / 10, x: p.x, y: p.y });
  }
  if (pts.length < 5) return null;
  // The cage is 6 ft wide and ~40 in deep. A puck behind it in the corner is
  // past the goal line too, so it has to arrive from the ice side of the line.
  const inNet = (q) => Math.abs(q.y - MID_Y) <= 42 &&
    ((q.x <= LINE_IN + 2 && q.x >= LINE_IN - 46) || (q.x >= RINK_IN - LINE_IN - 2 && q.x <= RINK_IN - LINE_IN + 46));
  const front = (q) => q.x > LINE_IN && q.x < RINK_IN - LINE_IN;
  const c = pts.findIndex((q, i) => i > 0 && inNet(q) && front(pts[i - 1]));
  if (c <= 0) return null;
  const net = { x: pts[c].x < RINK_IN / 2 ? LINE_IN : RINK_IN - LINE_IN, y: MID_Y };
  const ft = (q) => Math.hypot(q.x - net.x, q.y - net.y) / 12;
  let r = c - 1;
  if (distFt != null) {
    const want = Math.max(3, distFt - 4);
    while (r > 0 && ft(pts[r]) < want && c - r < 25) r--;
  } else r = Math.max(0, c - 6);
  let peak = 0;
  for (let i = r + 1; i <= c; i++) {
    const dt = pts[i].t - pts[i - 1].t;
    if (dt > 0 && dt <= 0.35) peak = Math.max(peak, Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y) / dt);
  }
  const mph = peak * IN_PER_S_TO_MPH;
  // Nobody scores on a shot under 10 or over 110; either is tracking losing the puck.
  return mph >= 10 && mph <= 110 ? Math.round(mph * 10) / 10 : null;
}

async function sprite(url) {
  try {
    const r = await fetch(url, { headers: SPRITE_HEADERS });
    if (!r.ok) return null;
    return await r.json();
  } catch (e) { return null; }
}

/**
 * Every goal in one game, keyed `${period}|${time}|${scorer}` so the score
 * feed's goals can find theirs (the two feeds list the same goals but don't
 * share an id — the clip id is often missing on the freshest goals).
 */
export async function gameGoalDetail(gameId, { speeds = true } = {}) {
  const pbp = await web(`/gamecenter/${gameId}/play-by-play`);
  const homeId = pbp.homeTeam?.id;
  const names = {};
  for (const r of pbp.rosterSpots || [])
    names[r.playerId] = [r.firstName?.default, r.lastName?.default].filter(Boolean).join(' ');
  const out = {};
  for (const p of pbp.plays || []) {
    if (p.typeDescKey !== 'goal') continue;
    const d = p.details || {};
    const per = p.periodDescriptor?.number;
    if (p.periodDescriptor?.periodType === 'SO') continue;   // shootout "goals" aren't goals
    // Which net he was shooting at: the one the OTHER team defends. Needed for
    // an empty-netter from his own end, where |x| alone reads 150 ft as 30.
    let dist = null;
    if (Number.isFinite(d.xCoord) && Number.isFinite(d.yCoord)) {
      const home = d.eventOwnerTeamId === homeId;
      const homeDefLeft = p.homeTeamDefendingSide === 'left';
      const netX = p.homeTeamDefendingSide
        ? ((home ? homeDefLeft : !homeDefLeft) ? NET_X : -NET_X)   // attacks the far end
        : (d.xCoord >= 0 ? NET_X : -NET_X);
      dist = Math.round(Math.hypot(netX - d.xCoord, d.yCoord));
    }
    const row = {
      dist, shot: d.shotType || null,
      gid: d.goalieInNetId || null, goalie: d.goalieInNetId ? (names[d.goalieInNetId] || null) : null,
      spd: null,
    };
    if (speeds && p.pptReplayUrl) row.spd = puckSpeed(await sprite(p.pptReplayUrl), dist);
    out[`${per}|${p.timeInPeriod}|${d.scoringPlayerId}`] = row;
  }
  return out;
}
