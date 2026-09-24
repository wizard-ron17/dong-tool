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
import { goalFeatures, priceGoal, GOAL_MODEL, ppFeatures, pricePp, goalMarkets, MARKET_CUTS } from './nhl-goals.js';
import { pointsFeatures, projectPoints, PT_MODEL } from './nhl-points.js';
import { physFeatures, projectPhys, physOver, physMeta } from './nhl-phys.js';
import { homeWin } from './nhl-lines.js';
import fs from 'node:fs';

const RECENT_DATES = 22;          // enough to cover a last-10 for everyone

const secs = (v) => (typeof v === 'number' ? v : 0);

/** Season aggregates, keyed by playerId. */
async function aggregates(season) {
  const [sum, toi, rt] = await Promise.all([
    restPaged(`/skater/summary?cayenneExp=seasonId=${season} and gameTypeId=2`, Infinity,
      [{ property: 'playerId', direction: 'ASC' }]),
    restPaged(`/skater/timeonice?cayenneExp=seasonId=${season} and gameTypeId=2`, Infinity,
      [{ property: 'playerId', direction: 'ASC' }]),
    // realtime: hits, blocked shots and shot attempts, for /nhl/hits and /nhl/blocks
    restPaged(`/skater/realtime?cayenneExp=seasonId=${season} and gameTypeId=2`, Infinity,
      [{ property: 'playerId', direction: 'ASC' }]),
  ]);
  const t = Object.fromEntries(toi.map(r => [r.playerId, r]));
  const re = Object.fromEntries(rt.map(r => [r.playerId, r]));
  const out = {};
  for (const r of sum) {
    const x = t[r.playerId] || {}, y = re[r.playerId] || {};
    out[r.playerId] = {
      pid: r.playerId, name: r.skaterFullName, pos: r.positionCode,
      team: (r.teamAbbrevs || '').split(',').pop().trim(),
      gp: r.gamesPlayed || 0, sog: r.shots || 0, goals: r.goals || 0, ppg: r.ppGoals || 0,
      a: r.assists || 0, pts: r.points || 0, ppp: r.ppPoints || 0,
      toi: secs(r.timeOnIcePerGame) * (r.gamesPlayed || 0),
      pptoi: secs(x.ppTimeOnIcePerGame) * (r.gamesPlayed || 0),
      shtoi: secs(x.shTimeOnIcePerGame) * (r.gamesPlayed || 0),
      hits: y.hits || 0, bks: y.blockedShots || 0, icf: y.totalShotAttempts || 0,
    };
  }
  return out;
}

/** Per-game rows for the last N dates that had games, oldest first. */
async function recentGames(dates) {
  const log = new Map();
  for (const d of dates) {
    const exp = `gameDate>="${d}" and gameDate<="${d}" and gameTypeId=2`;
    const [sum, toi, rt] = await Promise.all([
      restPaged(`/skater/summary?cayenneExp=${exp}`, Infinity, [{ property: 'playerId', direction: 'ASC' }]),
      restPaged(`/skater/timeonice?cayenneExp=${exp}`, Infinity, [{ property: 'playerId', direction: 'ASC' }]),
      restPaged(`/skater/realtime?cayenneExp=${exp}`, Infinity, [{ property: 'playerId', direction: 'ASC' }]),
    ]);
    const t = Object.fromEntries(toi.map(r => [r.playerId, r]));
    const re = Object.fromEntries(rt.map(r => [r.playerId, r]));
    for (const r of sum) {
      const x = t[r.playerId] || {}, y = re[r.playerId] || {};
      if (!log.has(r.playerId)) log.set(r.playerId, []);
      log.get(r.playerId).push({
        date: d, sog: r.shots || 0, a: r.assists || 0, pts: r.points || 0, ppp: r.ppPoints || 0,
        toi: secs(r.timeOnIcePerGame), pptoi: secs(x.ppTimeOnIcePerGame), shtoi: secs(x.shTimeOnIcePerGame),
        hits: y.hits || 0, bks: y.blockedShots || 0,
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
      const t = (teamRates[ab] ||= { sf: 0, sa: 0, gf: 0, ga: 0, pk: 0, w: 0 });
      const gp = r.gamesPlayed || 0;
      if (!gp) continue;
      t.sf += (r.shotsForPerGame || 0) * gp * weight;
      t.sa += (r.shotsAgainstPerGame || 0) * gp * weight;
      t.gf += (r.goalsForPerGame || 0) * gp * weight;
      t.ga += (r.goalsAgainstPerGame || 0) * gp * weight;
      t.pk += (r.penaltyKillPct ?? 0.8) * gp * weight;
      t.w += gp * weight;
    }
  };
  absorb(teamPrev, 0.35);      // last season is context, not evidence
  absorb(teamCur, 1.0);
  const L = SOG_MODEL.league;
  const teamSf = (ab) => (teamRates[ab]?.w ? teamRates[ab].sf / teamRates[ab].w : L.team_sf);
  const teamSa = (ab) => (teamRates[ab]?.w ? teamRates[ab].sa / teamRates[ab].w : L.opp_sa);
  const GL = GOAL_MODEL.league;
  const teamGf = (ab) => (teamRates[ab]?.w ? teamRates[ab].gf / teamRates[ab].w : GL.team_gf);
  const teamPk = (ab) => (teamRates[ab]?.w ? teamRates[ab].pk / teamRates[ab].w : null);

  // Shot attempts a club takes per game (its skaters' attempts over its games),
  // this season and last at the same 1 : 0.35 weights — the hits and blocks
  // boards' opponent term.
  const cfRates = {};
  for (const [agg, rows, w] of [[prev, teamPrev, 0.35], [cur, teamCur, 1.0]]) {
    const gp = Object.fromEntries(rows.map(r => [TEAM_ABBREV[r.teamFullName], r.gamesPlayed || 0]));
    const tot = {};
    for (const x of Object.values(agg)) if (x.team) tot[x.team] = (tot[x.team] || 0) + (x.icf || 0);
    for (const [ab, n] of Object.entries(tot)) {
      if (!gp[ab]) continue;
      const e = (cfRates[ab] ||= { cf: 0, w: 0 });
      e.cf += n * w; e.w += gp[ab] * w;
    }
  }
  const teamCf = (ab) => (cfRates[ab]?.w ? cfRates[ab].cf / cfRates[ab].w : null);

  // Each rink's hits and blocks per game this season, both clubs, off the season
  // archive (players.json) — scorekeepers differ by arena and change between
  // seasons, so it is this season only and neutral until the rink has games.
  const arenaTot = {};
  try {
    const PL = JSON.parse(fs.readFileSync(new URL('../nhl/players.json', import.meta.url), 'utf8'));
    const ci = Object.fromEntries((PL.cols?.sk || []).map((c, i) => [c, i]));
    if (PL.season === season && ci.hit != null) {
      const games = {};
      for (const e of Object.values(PL.p || {})) {
        if (e.pos === 'G') continue;
        for (const r of e.g) {
          if (r[ci.hit] == null) continue;
          const rink = r[ci.home] ? e.tm : r[ci.opp];
          const g = (games[`${r[ci.day]}|${rink}`] ||= { rink, hits: 0, bks: 0 });
          g.hits += r[ci.hit]; g.bks += r[ci.bk] || 0;
        }
      }
      for (const g of Object.values(games)) {
        const a = (arenaTot[g.rink] ||= { n: 0, hits: 0, bks: 0 });
        a.n++; a.hits += g.hits; a.bks += g.bks;
      }
    }
  } catch (e) { /* no archive yet: every rink neutral */ }
  const teamGa = (ab) => (teamRates[ab]?.w ? teamRates[ab].ga / teamRates[ab].w : GL.opp_ga);
  const picks = [];

  const opp = {}, home = {}, gameOf = {};
  for (const g of games) {
    opp[g.away] = g.home; opp[g.home] = g.away;
    home[g.home] = true; home[g.away] = false;
    gameOf[g.away] = g; gameOf[g.home] = g;
  }

  // Price off each club's CURRENT roster, not off whoever last season's stats
  // say played for it. The stats feed files a skater under the club he
  // finished the season with, so anyone who moved in the offseason would be
  // priced for his old team, and the pool carried every departed player — on
  // opening night that summed to 7.7 expected goals a game against a real ~6.
  // /nfl learned the same lesson from its roster feed.
  const roster = new Map();
  await Promise.all(Object.keys(opp).map(async (ab) => {
    try {
      const r = await web(`/roster/${ab}/current`);
      for (const grp of ['forwards', 'defensemen'])
        for (const x of r[grp] || []) roster.set(String(x.id), { team: ab, pos: x.positionCode, mug: x.headshot });
    } catch (e) { /* a missing roster leaves that club off the board, not wrong on it */ }
  }));

  const board = [], points = [], phys = { hits: [], bks: [] };
  for (const [pid, rs] of roster) {
    const a = cur[pid], b = prev[pid];
    const who = a || b;
    if (!who) continue;                               // no NHL history at all
    const team = rs.team;
    if (!(team in opp)) continue;

    // Career-to-date, this season plus last, as one shrunk history.
    const gp = (a?.gp || 0) + (b?.gp || 0);
    if (gp < 10) continue;                            // too thin to price honestly
    const hist = {
      goals: (a?.goals || 0) + (b?.goals || 0),
      sog: (a?.sog || 0) + (b?.sog || 0),
      toi: (a?.toi || 0) + (b?.toi || 0),
      pptoi: (a?.pptoi || 0) + (b?.pptoi || 0),
      ppg: (a?.ppg || 0) + (b?.ppg || 0),
      a: (a?.a || 0) + (b?.a || 0), pts: (a?.pts || 0) + (b?.pts || 0), ppp: (a?.ppp || 0) + (b?.ppp || 0),
    };
    // sogFeatures() wants a per-game log; hand it the career as `gp` synthetic
    // average games plus the real recent ones, so the shrinkage and the rolling
    // windows both see what the research version saw.
    const recent = (log.get(+pid) || []).slice(-10);
    const avg = { sog: hist.sog / gp, toi: hist.toi / gp, pptoi: hist.pptoi / gp };
    const synth = Array.from({ length: Math.max(gp - recent.length, 0) }, () => avg);
    const f = sogFeatures({
      log: [...synth, ...recent],
      role: (rs.pos || who.pos) === 'D' ? 'D' : 'F',
      oppSa: teamSa(opp[team]), teamSf: teamSf(team), isHome: home[team],
    });
    if (!f) continue;
    const mu = projectSog(f);
    if (!(mu > 0)) continue;
    const g = gameOf[team];
    // Anytime goal, off the same career history and recent windows.
    const role = (rs.pos || who.pos) === 'D' ? 'D' : 'F';
    const gf = goalFeatures({
      role, gp, goals: hist.goals, sog: hist.sog, toi: hist.toi,
      toiL5: f.toi_l5, pptoiL5: f.pptoi_l5, sogL10: f.sog_l10,
      oppGa: teamGa(opp[team]), teamGf: teamGf(team), isHome: home[team],
    });
    if (gf) {
      const pr = priceGoal(gf);
      const rec = (log.get(+pid) || []);
      const ppMean = (n) => { const w = rec.slice(-n); return w.length ? w.reduce((a, x) => a + x.pptoi, 0) / w.length : hist.pptoi / gp; };
      const pPP = pricePp(ppFeatures({
        role, gp, ppg: hist.ppg, sogPrior: gf.sog_prior, shpct: gf.shpct_prior,
        pptoiL5: ppMean(5), pptoiL10: ppMean(10), oppPk: teamPk(opp[team]), teamGf: teamGf(team), isHome: home[team],
      }));
      picks.push({
        pid: +pid, name: who.name, pos: rs.pos || who.pos, team, opp: opp[team], home: !!home[team],
        gameId: g.gameId, date: g.date, start: g.start, mug: rs.mug || null,
        p: +pr.p.toFixed(4), pRaw: +pr.pRaw.toFixed(4), mu: +pr.mu.toFixed(4), gp, pPP: +pPP.toFixed(5),
        _lastDate: rec.length ? rec[rec.length - 1].date : null, _toi: avg.toi,
        f: {
          goalsPg: +(hist.goals / gp).toFixed(3), sogPg: +(hist.sog / gp).toFixed(2),
          shpct: +gf.shpct_prior.toFixed(4), toi: +(gf.toi_l5).toFixed(0), pptoi: +(gf.pptoi_l5).toFixed(0),
          sogL10: +gf.sog_l10.toFixed(2), oppGa: +gf.opp_ga_prior.toFixed(2), teamGf: +gf.team_gf_prior.toFixed(2),
          goals: hist.goals, sog: hist.sog,
        },
        // log-multipliers on expected goals, one per model term — the modal's bars
        c: Object.fromEntries(Object.entries(pr.parts).map(([k, v]) => [k, +v.toFixed(4)])),
        base: +pr.base.toFixed(4),
      });
    }
    // Points, assists, PP points — off the same career history and recent games
    {
      const rec = (log.get(+pid) || []);
      const pf = pointsFeatures({ role: (rs.pos || who.pos) === 'D' ? 'D' : 'F', h: { gp, ...hist },
        recent: rec, teamGf: teamGf(team), oppGa: teamGa(opp[team]), oppPk: teamPk(opp[team]), isHome: home[team] });
      const m = projectPoints(pf);
      points.push({
        pid: +pid, name: who.name, pos: rs.pos || who.pos, team, mug: rs.mug || null,
        opp: opp[team], home: !!home[team], gameId: g.gameId, date: g.date, start: g.start, gp,
        mu: { pts: +m.pts.toFixed(4), a: +m.a.toFixed(4), ppp: +m.ppp.toFixed(4) },
        f: { ptsPg: +pf.pts_prior.toFixed(3), aPg: +pf.a_prior.toFixed(3), pppPg: +pf.ppp_prior.toFixed(3),
             ptsL10: +pf.pts_l10.toFixed(2), aL10: +pf.a_l10.toFixed(2), pppL10: +pf.ppp_l10.toFixed(2),
             toi: +pf.toi_l5.toFixed(0), pptoi: +pf.pptoi_l5.toFixed(0),
             teamGf: +pf.team_gf_prior.toFixed(2), oppGa: +pf.opp_ga_prior.toFixed(2), oppPk: +pf.opp_pk_prior.toFixed(3) },
        recent: { pts: rec.slice(-10).map(x => x.pts), a: rec.slice(-10).map(x => x.a), ppp: rec.slice(-10).map(x => x.ppp) },
      });
    }
    // Hits and blocked shots, off the same career history and recent games
    {
      const rec = (log.get(+pid) || []);
      const sumk = (k) => (a?.[k] || 0) + (b?.[k] || 0);
      const role = (rs.pos || who.pos) === 'D' ? 'D' : 'F';
      const pf = physFeatures({ role, h: { gp, hits: sumk('hits'), bks: sumk('bks'), toi: hist.toi, shtoi: sumk('shtoi') },
        recent: rec.slice(-10), oppCf: teamCf(opp[team]), isHome: home[team], arena: arenaTot[g.home],
        winP: g.lam ? (home[team] ? homeWin(g.lam.h, g.lam.a) : 1 - homeWin(g.lam.h, g.lam.a)) : null });
      if (pf) for (const kind of ['hits', 'bks']) {
        const m = projectPhys(kind, pf), M = physMeta(kind);
        phys[kind].push({
          pid: +pid, name: who.name, pos: rs.pos || who.pos, team, mug: rs.mug || null,
          opp: opp[team], home: !!home[team], gameId: g.gameId, date: g.date, start: g.start, gp,
          mu: +m.toFixed(3),
          f: { prior: +pf[kind + '_prior'].toFixed(3), l5: +pf[kind + '_l5'].toFixed(2), l10: +pf[kind + '_l10'].toFixed(2),
               toi: +pf.toi_l5.toFixed(0), shtoi: +pf.shtoi_l5.toFixed(0), oppCf: +pf.opp_cf_prior.toFixed(1),
               arena: +pf['arena_' + kind].toFixed(3), rink: g.home, rinkGames: arenaTot[g.home]?.n || 0,
               winP: +(0.5 - pf.underdog).toFixed(3) },
          recent: rec.slice(-10).map(r => r[kind] || 0),
          p: Object.fromEntries(M.lines.map(L => [L, +physOver(kind, L, m).toFixed(4)])),
        });
      }
    }
    board.push({
      pid: +pid, name: who.name, pos: rs.pos || who.pos, team, mug: rs.mug || null,
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
  // Projected lineups for the first/last-goal race: whoever dressed in his
  // club's most recent game; before a club has played, its top 12 forwards and
  // 6 defencemen by ice time.
  const lastGame = {}, lineup = new Set();
  for (const p of picks) if (p._lastDate && (!lastGame[p.team] || p._lastDate > lastGame[p.team])) lastGame[p.team] = p._lastDate;
  for (const team of new Set(picks.map(p => p.team))) {
    const mine = picks.filter(p => p.team === team);
    if (lastGame[team]) mine.filter(p => p._lastDate === lastGame[team]).forEach(p => lineup.add(p));
    else for (const [role, n] of [['F', 12], ['D', 6]])
      mine.filter(p => (p.pos === 'D' ? 'D' : 'F') === role).sort((a, b) => b._toi - a._toi).slice(0, n).forEach(p => lineup.add(p));
  }
  goalMarkets(picks, (p) => lineup.has(p));
  for (const p of picks) { p.lineup = lineup.has(p); delete p._lastDate; delete p._toi; }
  picks.sort((x, y) => y.p - x.p);
  points.sort((x, y) => y.mu.pts - x.mu.pts);
  for (const k of ['hits', 'bks']) phys[k].sort((x, y) => y.mu - x.mu);
  return { board, model: meta(), picks, picksModel: picksMeta(), points,
           pointsModel: { lines: PT_MODEL.lines, rows: PT_MODEL.rows, seasons: PT_MODEL.seasons, backtest: PT_MODEL.backtest },
           phys, physModel: { hits: physMeta('hits'), bks: physMeta('bks') } };
}

function picksMeta() {
  const M = GOAL_MODEL;
  return { base: M.base, cuts: M.cuts, rows: M.rows, seasons: M.seasons, note: M.note, markets: MARKET_CUTS };
}

function meta() {
  return { alpha: SOG_MODEL.alpha, lines: SOG_MODEL.lines, note: SOG_MODEL.note,
           rows: SOG_MODEL.rows, seasons: SOG_MODEL.seasons, backtest: SOG_MODEL.backtest || null };
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
