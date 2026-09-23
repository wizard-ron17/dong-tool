// Goalie saves and goals allowed — the board behind /nhl/saves.
//
// Model and methodology in research/nhl_saves.py; training stays in Python and
// this file applies the exported coefficients, the same split as nhl-sog.js.
//
//  * SAVES: mean = league level x relative terms. League saves per start fell
//    every season (27.3 -> 24.1), so the level is an OFFSET — the league's
//    saves per start over the last 30 days — and every other rate is relative
//    to tonight's slate. Priced as a MIX: a full-game negative binomial plus a
//    ~5.5% pulled-goalie component at ~46% of the saves, because pulls give
//    saves a LEFT tail no single NB can draw. Out of sample: quoted-line
//    calibration within 0.35pp, every line 20.5-32.5 within 0.4pp.
//  * GOALS ALLOWED: a lean team-level mean, shrunk toward the league average
//    (its raw spread ran twice too wide out of sample), priced through a
//    BINOMIAL matched to the measured under-dispersion (0.82): a goalie who
//    leaks gets pulled, which cuts the tail a Poisson assumes.
//  * Rates enter on a log scale (the shots calibration lesson).
//
// Starters: the feed publishes no confirmed starter, so each club's PROJECTED
// starter is the roster goalie with the most of its recent starts. The board
// says so, and grading voids a start he didn't make, the way Shots voids a
// scratch.
import fs from 'node:fs';
import { web, restPaged } from './nhl-api.js';
import { TEAM_ABBREV } from './nhl-shots.js';

export const SV_MODEL = JSON.parse(
  fs.readFileSync(new URL('../research/nhl_saves_model.json', import.meta.url), 'utf8'));
const LG = SV_MODEL.league;
const OFF = SV_MODEL.log_offset ?? 0.1;
const SH = SV_MODEL.shrink;
const RECENT_DATES = 22;

const lg = (x) => Math.log(Math.max(0, x) + OFF);
function linear(m, f) {
  let eta = m.coef.intercept;
  for (const k of m.features) eta += m.coef[k] * ((f[k] - m.scale[k].mean) / m.scale[k].sd);
  return Math.exp(Math.max(-6, Math.min(6, eta)));
}
const REL = ['sv_prior', 'sv_l5', 'sv_l10', 'team_sa_prior', 'team_sa_l10', 'opp_sf_prior', 'opp_sf_l10'];
/**
 * Feature rows for a whole slate, the same transforms as research/nhl_saves.py:
 * each REL rate as log(x / the slate's mean of x), save % as log odds of a goal,
 * and the goals-allowed rates on a log scale.
 */
export function savesFeatures(xs) {
  const mean = Object.fromEntries(REL.map(k => [k, xs.reduce((a, x) => a + x[k], 0) / xs.length]));
  return xs.map(x => {
    const f = { ...x };
    for (const k of REL) f['rel_' + k] = Math.log(x[k] / mean[k]);
    for (const k of ['team_ga_prior', 'opp_gf_prior']) f['log_' + k] = lg(x[k]);
    f.lgt_miss = Math.log((1 - x.svp_prior) / x.svp_prior);
    return f;
  });
}
/** Expected saves: the league level (f.lg_sv) times the relative terms. */
export function projectSaves(f) { return f.lg_sv * linear(SV_MODEL.saves, f); }
export function projectGa(f) {
  const m = SV_MODEL.ga, raw = linear(m, f);
  return m.shrink_to + m.shrink_k * (raw - m.shrink_to);
}

// ── Distributions ────────────────────────────────────────────────────────
/** P(X = k), k = 0..K, negative binomial NB2. */
export function nbPmf(mu, alpha, K = 90) {
  const r = 1 / alpha, p = r / (r + mu), out = [Math.pow(p, r)];
  for (let k = 1; k <= K; k++) out.push(out[k - 1] * (r + k - 1) / k * (1 - p));
  return out;
}
/** The saves price: (1 - pi) x NB(full game) + pi x NB(pulled). */
export function savesPmf(mu, mix = SV_MODEL.saves.mix) {
  const a = nbPmf(mix.cf * mu, mix.af), b = nbPmf(mix.cp * mu, mix.ap);
  return a.map((v, k) => (1 - mix.pi) * v + mix.pi * b[k]);
}
/** Binomial matched to Var/Mean = d: n = mu/(1-d), per research ga_sf(). */
export function gaPmf(mu, d = SV_MODEL.ga.disp, line = 0) {
  const q = 1 - d;
  const n = Math.max(Math.round(mu / q), Math.ceil(line) + 1), p = mu / n;
  const out = [Math.pow(1 - p, n)];
  for (let k = 1; k <= n; k++) out.push(out[k - 1] * (n - k + 1) / k * p / (1 - p));
  return out;
}
const over = (pmf, L) => pmf.reduce((a, v, k) => a + (k > L ? v : 0), 0);
/** { line, p } for the half line whose price sits closest to even. */
function evenAt(pmf, lo, hi) {
  let best = lo;
  for (let L = lo; L <= hi; L++) if (Math.abs(over(pmf, L) - 0.5) < Math.abs(over(pmf, best) - 0.5)) best = L;
  return { line: best, p: +over(pmf, best).toFixed(4) };
}

/**
 * @param o.season, o.prevSeason   season ids
 * @param o.games       tonight's games { gameId, date, away, home, start }
 * @param o.playedDates regular-season dates already played, oldest first
 * @param o.schedule    the whole season's schedule (back-to-backs)
 * @param o.recapGames  finished games with team shots (team last-10 form)
 */
export async function buildSavesBoard({ season, prevSeason, games, playedDates, schedule, recapGames }) {
  if (!games.length) return { board: [], model: meta() };
  const agg = async (s) => Object.fromEntries((await restPaged(
    `/goalie/summary?cayenneExp=seasonId=${s} and gameTypeId=2`, Infinity, [{ property: 'playerId', direction: 'ASC' }]))
    .map(r => [r.playerId, r]));
  const recentDates = playedDates.slice(-RECENT_DATES);
  const [cur, prev, teamCur, teamPrev, recent] = await Promise.all([
    agg(season), agg(prevSeason),
    restPaged(`/team/summary?cayenneExp=seasonId=${season} and gameTypeId=2`, Infinity, [{ property: 'teamId', direction: 'ASC' }]),
    restPaged(`/team/summary?cayenneExp=seasonId=${prevSeason} and gameTypeId=2`, Infinity, [{ property: 'teamId', direction: 'ASC' }]),
    (async () => {
      const out = [];
      for (const d of recentDates) {
        const rows = await restPaged(`/goalie/summary?cayenneExp=gameDate>="${d}" and gameDate<="${d}" and gameTypeId=2`,
          Infinity, [{ property: 'playerId', direction: 'ASC' }]);
        for (const r of rows) out.push({ date: d, pid: r.playerId, teams: String(r.teamAbbrevs || '').split(','),
          start: +(r.gamesStarted || 0), sv: r.saves || 0, sa: r.shotsAgainst || 0, ga: r.goalsAgainst || 0 });
      }
      return out;
    })(),
  ]);

  // Team rates, this season weighted over last — the shots board's recipe.
  const rates = {};
  const absorb = (rows, w) => {
    for (const r of rows) {
      const ab = TEAM_ABBREV[r.teamFullName]; if (!ab) continue;
      const gp = r.gamesPlayed || 0; if (!gp) continue;
      const t = (rates[ab] ||= { sf: 0, sa: 0, gf: 0, ga: 0, w: 0 });
      t.sf += (r.shotsForPerGame || 0) * gp * w; t.sa += (r.shotsAgainstPerGame || 0) * gp * w;
      t.gf += (r.goalsForPerGame || 0) * gp * w; t.ga += (r.goalsAgainstPerGame || 0) * gp * w; t.w += gp * w;
    }
  };
  absorb(teamPrev, 0.35); absorb(teamCur, 1.0);
  const rate = (ab, k, dflt) => rates[ab]?.w ? rates[ab][k] / rates[ab].w : dflt;

  // Team last-10 shots for/against, off the recap's finished games.
  const tgames = {};
  for (const g of Object.values(recapGames || {})) {
    if (g.type !== 2 || g.awaySog == null) continue;
    (tgames[g.away] ??= []).push({ date: g.date, sf: g.awaySog, sa: g.homeSog });
    (tgames[g.home] ??= []).push({ date: g.date, sf: g.homeSog, sa: g.awaySog });
  }
  const l10 = (ab, k, dflt) => {
    const xs = (tgames[ab] || []).sort((a, b) => a.date.localeCompare(b.date)).slice(-10);
    return xs.length >= 3 ? xs.reduce((a, x) => a + x[k], 0) / xs.length : dflt;
  };

  // League level: saves per start over the 30 days before tonight, starts only,
  // once there are enough of them; last season's (off its aggregate) until then.
  const LV = SV_MODEL.saves.level;
  const lvlFrom = (date) => {
    const lo = new Date(Date.parse(date + 'T12:00:00Z') - LV.days * 864e5).toISOString().slice(0, 10);
    const w = recent.filter(r => r.start && r.date >= lo && r.date < date);
    if (w.length >= LV.min_starts) return w.reduce((a, r) => a + r.sv, 0) / w.length;
    const P = Object.values(prev), gsP = P.reduce((a, r) => a + (r.gamesStarted || 0), 0);
    return gsP ? P.reduce((a, r) => a + (r.saves || 0), 0) / gsP * LV.agg_to_start : LG.sv;
  };

  const playedOn = new Set(schedule.filter(g => g.type === 2).flatMap(g => [`${g.date}|${g.away}`, `${g.date}|${g.home}`]));
  const yesterday = (d) => new Date(Date.parse(d + 'T12:00:00Z') - 864e5).toISOString().slice(0, 10);

  const rows = [];
  for (const g of games) {
    for (const [team, opp, isHome] of [[g.away, g.home, 0], [g.home, g.away, 1]]) {
      let roster;
      try { roster = await web(`/roster/${team}/current`); } catch (e) { continue; }
      const gl = (roster.goalies || []).map(x => ({ pid: x.id, mug: x.headshot || null,
        name: [x.firstName?.default, x.lastName?.default].filter(Boolean).join(' ') }));
      if (!gl.length) continue;
      // Projected starter: most of this club's recent starts, then most starts
      // this season, then last season — opening night has no recent starts.
      const mine = recent.filter(r => r.start && r.teams.includes(team));
      const teamStarts = new Set(mine.map(r => r.date));
      const last10 = [...teamStarts].sort().slice(-10);
      const share = (pid) => mine.filter(r => r.pid === pid && last10.includes(r.date)).length;
      gl.sort((a, b) => share(b.pid) - share(a.pid)
        || (cur[b.pid]?.gamesStarted || 0) - (cur[a.pid]?.gamesStarted || 0)
        || (prev[b.pid]?.gamesStarted || 0) - (prev[a.pid]?.gamesStarted || 0));
      const G = gl[0], a = cur[G.pid], b = prev[G.pid];
      const gs = (a?.gamesStarted || 0) + (b?.gamesStarted || 0);
      const gp = (a?.gamesPlayed || 0) + (b?.gamesPlayed || 0);
      if (gs < 3) continue;                           // the research needs three prior starts too
      const sv = (a?.saves || 0) + (b?.saves || 0), sa = (a?.shotsAgainst || 0) + (b?.shotsAgainst || 0);
      // Relief appearances carry about a third of a game's shots; count them so.
      const units = gs + 0.35 * (gp - gs);
      const starts = recent.filter(r => r.pid === G.pid && r.start).sort((x, y) => x.date.localeCompare(y.date));
      const svPrior = (sv + SH.rate_starts * LG.sv) / (units + SH.rate_starts);
      const lastN = (n) => starts.length >= 2 ? starts.slice(-n).reduce((s, r) => s + r.sv, 0) / Math.min(n, starts.length) : svPrior;
      const x = {
        sv_prior: svPrior, sv_l5: lastN(5), sv_l10: lastN(10),
        svp_prior: (sv + SH.sv_pct_shots * LG.svp_prior) / (sa + SH.sv_pct_shots),
        team_sa_prior: rate(team, 'sa', LG.team_sa_prior), team_sa_l10: l10(team, 'sa', rate(team, 'sa', LG.team_sa_prior)),
        opp_sf_prior: rate(opp, 'sf', LG.opp_sf_prior), opp_sf_l10: l10(opp, 'sf', rate(opp, 'sf', LG.opp_sf_prior)),
        team_ga_prior: rate(team, 'ga', LG.team_ga_prior), opp_gf_prior: rate(opp, 'gf', LG.opp_gf_prior),
        is_home: isHome,
        team_b2b: playedOn.has(`${yesterday(g.date)}|${team}`) ? 1 : 0,
        opp_b2b: playedOn.has(`${yesterday(g.date)}|${opp}`) ? 1 : 0,
      };
      x.lg_sv = lvlFrom(g.date);
      rows.push({ x, G, g, team, opp, isHome, gs, gp, starts, n10: last10.length, s10: share(G.pid), alt: gl[1] || null });
    }
  }
  // Relative features need the whole slate, so score after collecting it.
  const feats = savesFeatures(rows.map(r => r.x));
  const board = rows.map(({ x, G, g, team, opp, isHome, gs, gp, starts, n10, s10, alt }, i) => {
      const f = feats[i];
      const mu = projectSaves(f), muGa = projectGa(f);
      const pmfS = savesPmf(mu), pmfG = gaPmf(muGa);
      return {
        pid: G.pid, name: G.name, pos: 'G', team, opp, home: !!isHome, mug: G.mug,
        gameId: g.gameId, date: g.date, start: g.start,
        starter: { starts: s10, of: n10, alt: alt ? { pid: alt.pid, name: alt.name } : null },
        mu: +mu.toFixed(3), muGa: +muGa.toFixed(3), gs, gp,
        svPrior: +x.sv_prior.toFixed(2), svL5: +x.sv_l5.toFixed(2), svL10: +x.sv_l10.toFixed(2),
        svPct: +x.svp_prior.toFixed(4), teamSa: +x.team_sa_prior.toFixed(2), teamSaL10: +x.team_sa_l10.toFixed(2),
        oppSf: +x.opp_sf_prior.toFixed(2), oppSfL10: +x.opp_sf_l10.toFixed(2),
        teamGa: +x.team_ga_prior.toFixed(2), oppGf: +x.opp_gf_prior.toFixed(2),
        b2b: x.team_b2b, oppB2b: x.opp_b2b,
        recent: starts.slice(-10).map(r => r.sv), recentGa: starts.slice(-10).map(r => r.ga),
        p: Object.fromEntries(SV_MODEL.saves.lines.map(L => [L, +over(pmfS, L).toFixed(4)])),
        pGa: Object.fromEntries(SV_MODEL.ga.lines.map(L => [L, +over(pmfG, L).toFixed(4)])),
        lgSv: +x.lg_sv.toFixed(2),
        // the line the board quotes: the half line closest to even, off the full distribution
        q: evenAt(pmfS, 12.5, 40.5), qGa: evenAt(pmfG, 0.5, 6.5),
      };
  });
  board.sort((x, y) => y.mu - x.mu);
  return { board, model: meta() };
}

function meta() {
  const M = SV_MODEL;
  return { alpha: M.saves.alpha, mix: M.saves.mix, lines: M.saves.lines, gaLines: M.ga.lines, gaDisp: M.ga.disp,
           rows: M.rows, seasons: M.seasons, backtest: M.backtest || null };
}
