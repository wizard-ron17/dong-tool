// Builds the shots-on-goal board for the upcoming slate.
//
// The research harness reads a 313 MB per-date crawl; a build running every
// hour cannot. It gets the same features from three cheaper reads:
//
//   season aggregates (this season + last)  ~20 requests -> career priors
//   the last RECENT_DATES dates, per game   ~60 requests -> last-5 / last-10
//   team summary                             ~2 requests -> shots for / against
//
// Career priors cross the season line on purpose: a shooter is a shooter, and
// on opening night this season's aggregate is empty, so last season is all
// there is.
import { web, rest, restPaged } from './nhl-api.js';
import { sogFeatures, projectSog, ladder, SOG_MODEL } from './nhl-sog.js';

const RECENT_DATES = 22;          // enough to cover a last-10 for everyone

const secs = (v) => (typeof v === 'number' ? v : 0);

/** Season aggregates, keyed by playerId. */
async function aggregates(season) {
  const [sum, toi] = await Promise.all([
    restPaged(`/skater/summary?cayenneExp=seasonId=${season} and gameTypeId=2`, Infinity,
      [{ property: 'playerId', direction: 'ASC' }]),
    restPaged(`/skater/timeonice?cayenneExp=seasonId=${season} and gameTypeId=2`, Infinity,
      [{ property: 'playerId', direction: 'ASC' }]),
  ]);
  const t = Object.fromEntries(toi.map(r => [r.playerId, r]));
  const out = {};
  for (const r of sum) {
    const x = t[r.playerId] || {};
    out[r.playerId] = {
      pid: r.playerId, name: r.skaterFullName, pos: r.positionCode,
      team: (r.teamAbbrevs || '').split(',').pop().trim(),
      gp: r.gamesPlayed || 0, sog: r.shots || 0,
      toi: secs(r.timeOnIcePerGame) * (r.gamesPlayed || 0),
      pptoi: secs(x.ppTimeOnIcePerGame) * (r.gamesPlayed || 0),
    };
  }
  return out;
}

/** Per-game rows for the last N dates that had games, oldest first. */
async function recentGames(dates) {
  const log = new Map();
  for (const d of dates) {
    const exp = `gameDate>="${d}" and gameDate<="${d}" and gameTypeId=2`;
    const [sum, toi] = await Promise.all([
      restPaged(`/skater/summary?cayenneExp=${exp}`, Infinity, [{ property: 'playerId', direction: 'ASC' }]),
      restPaged(`/skater/timeonice?cayenneExp=${exp}`, Infinity, [{ property: 'playerId', direction: 'ASC' }]),
    ]);
    const t = Object.fromEntries(toi.map(r => [r.playerId, r]));
    for (const r of sum) {
      const x = t[r.playerId] || {};
      if (!log.has(r.playerId)) log.set(r.playerId, []);
      log.get(r.playerId).push({
        date: d, sog: r.shots || 0,
        toi: secs(r.timeOnIcePerGame), pptoi: secs(x.ppTimeOnIcePerGame),
      });
    }
  }
  return log;
}

/**
 * @param {object} o
 * @param {number} o.season      the season being priced
 * @param {number} o.prevSeason  the one before it, for career priors
 * @param {Array}  o.games       today's games: { gameId, date, away, home, start }
 * @param {string[]} o.playedDates  dates already played this season, newest last
 */
export async function buildShotsBoard({ season, prevSeason, games, playedDates }) {
  if (!games.length) return { board: [], teams: {}, model: meta() };

  const recentDates = playedDates.slice(-RECENT_DATES);
  const [cur, prev, log, teamCur, teamPrev] = await Promise.all([
    aggregates(season),
    aggregates(prevSeason),
    recentGames(recentDates),
    restPaged(`/team/summary?cayenneExp=seasonId=${season} and gameTypeId=2`, Infinity,
      [{ property: 'teamId', direction: 'ASC' }]),
    restPaged(`/team/summary?cayenneExp=seasonId=${prevSeason} and gameTypeId=2`, Infinity,
      [{ property: 'teamId', direction: 'ASC' }]),
  ]);

  // Team shots for / against. Before a club has played, last season stands in —
  // it is a far better guess than the league mean.
  const teamRates = {};
  const absorb = (rows, weight) => {
    for (const r of rows) {
      const ab = TEAM_ABBREV[r.teamFullName];
      if (!ab) continue;
      const t = (teamRates[ab] ||= { sf: 0, sa: 0, w: 0 });
      const gp = r.gamesPlayed || 0;
      if (!gp) continue;
      t.sf += (r.shotsForPerGame || 0) * gp * weight;
      t.sa += (r.shotsAgainstPerGame || 0) * gp * weight;
      t.w += gp * weight;
    }
  };
  absorb(teamPrev, 0.35);      // last season is context, not evidence
  absorb(teamCur, 1.0);
  const L = SOG_MODEL.league;
  const teamSf = (ab) => (teamRates[ab]?.w ? teamRates[ab].sf / teamRates[ab].w : L.team_sf);
  const teamSa = (ab) => (teamRates[ab]?.w ? teamRates[ab].sa / teamRates[ab].w : L.opp_sa);

  const opp = {}, home = {}, gameOf = {};
  for (const g of games) {
    opp[g.away] = g.home; opp[g.home] = g.away;
    home[g.home] = true; home[g.away] = false;
    gameOf[g.away] = g; gameOf[g.home] = g;
  }

  const board = [];
  for (const pid of new Set([...Object.keys(cur), ...Object.keys(prev)])) {
    const a = cur[pid], b = prev[pid];
    const who = a || b;
    const team = who.team;
    if (!(team in opp)) continue;                     // not on tonight's slate

    // Career-to-date, this season plus last, as one shrunk history.
    const gp = (a?.gp || 0) + (b?.gp || 0);
    if (gp < 10) continue;                            // too thin to price honestly
    const hist = {
      sog: (a?.sog || 0) + (b?.sog || 0),
      toi: (a?.toi || 0) + (b?.toi || 0),
      pptoi: (a?.pptoi || 0) + (b?.pptoi || 0),
    };
    // sogFeatures() wants a per-game log; hand it the career as `gp` synthetic
    // average games plus the real recent ones, so the shrinkage and the rolling
    // windows both see what the research version saw.
    const recent = (log.get(+pid) || []).slice(-10);
    const avg = { sog: hist.sog / gp, toi: hist.toi / gp, pptoi: hist.pptoi / gp };
    const synth = Array.from({ length: Math.max(gp - recent.length, 0) }, () => avg);
    const f = sogFeatures({
      log: [...synth, ...recent],
      role: who.pos === 'D' ? 'D' : 'F',
      oppSa: teamSa(opp[team]), teamSf: teamSf(team), isHome: home[team],
    });
    if (!f) continue;
    const mu = projectSog(f);
    if (!(mu > 0)) continue;
    const g = gameOf[team];
    board.push({
      pid: +pid, name: who.name, pos: who.pos, team,
      opp: opp[team], home: !!home[team], gameId: g.gameId, date: g.date, start: g.start,
      mu: +mu.toFixed(3), gp,
      toi: +(avg.toi).toFixed(0), pptoi: +(avg.pptoi).toFixed(0),
      sogPrior: +f.sog_prior.toFixed(3), sogL5: +(f.sog_l5 ?? 0).toFixed(2), sogL10: +(f.sog_l10 ?? 0).toFixed(2),
      oppSa: +f.opp_sa_prior.toFixed(2), teamSf: +f.team_sf_prior.toFixed(2),
      recent: recent.map(r => r.sog),
      p: Object.fromEntries(ladder(mu).map(x => [x.line, +x.over.toFixed(4)])),
    });
  }
  board.sort((x, y) => y.mu - x.mu);
  return { board, model: meta() };
}

function meta() {
  return { alpha: SOG_MODEL.alpha, lines: SOG_MODEL.lines, note: SOG_MODEL.note,
           rows: SOG_MODEL.rows, seasons: SOG_MODEL.seasons };
}

// teamFullName -> abbrev. The team report keys on the full name and nothing
// else in the feed does.
export const TEAM_ABBREV = {
  'Anaheim Ducks': 'ANA', 'Boston Bruins': 'BOS', 'Buffalo Sabres': 'BUF',
  'Calgary Flames': 'CGY', 'Carolina Hurricanes': 'CAR', 'Chicago Blackhawks': 'CHI',
  'Colorado Avalanche': 'COL', 'Columbus Blue Jackets': 'CBJ', 'Dallas Stars': 'DAL',
  'Detroit Red Wings': 'DET', 'Edmonton Oilers': 'EDM', 'Florida Panthers': 'FLA',
  'Los Angeles Kings': 'LAK', 'Minnesota Wild': 'MIN', 'Montréal Canadiens': 'MTL',
  'Montreal Canadiens': 'MTL', 'Nashville Predators': 'NSH', 'New Jersey Devils': 'NJD',
  'New York Islanders': 'NYI', 'New York Rangers': 'NYR', 'Ottawa Senators': 'OTT',
  'Philadelphia Flyers': 'PHI', 'Pittsburgh Penguins': 'PIT', 'San Jose Sharks': 'SJS',
  'Seattle Kraken': 'SEA', 'St. Louis Blues': 'STL', 'Tampa Bay Lightning': 'TBL',
  'Toronto Maple Leafs': 'TOR', 'Utah Mammoth': 'UTA', 'Utah Hockey Club': 'UTA',
  'Vancouver Canucks': 'VAN', 'Vegas Golden Knights': 'VGK', 'Washington Capitals': 'WSH',
  'Winnipeg Jets': 'WPG', 'Arizona Coyotes': 'ARI',
};
