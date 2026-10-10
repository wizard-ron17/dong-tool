// Ron's Tools parlay slip — one module for every app (/mlb /nfl /nhl /nba).
//
// Every priced row on the site tags itself with parAttr({...}), a small JSON
// payload naming the bet. Parlay mode works by interception: one capture-phase
// listener swallows the click before the row's own onclick can open a card,
// and adds the leg instead. No board knows the slip exists.
//
// One slip for the whole site: a real parlay can mix sports, so every app
// shares one storage key and stamps each leg with its sport ('nfl:' + key), so
// ids from two sports never collide.
//
// The price is honest: legs multiply unless we have MEASURED how they move
// together. Each sport's measured rules live here, so a slip prices the same
// on every page. A sport prices its own legs; different sports are independent
// and multiply.
//   MLB  copula over research/sgp_mlb.py's ρs
//   NFL  anytime-TD groups (data.json parlay: research/pair_correlation.py),
//        else the copula over research/sgp_nfl_all.py's table
//   NHL  anytime-goal groups and scorer + assist stacks (data.json parlay),
//        else the copula over research/sgp_nhl.py's ρs
//   NBA  nothing measured yet: multiplies, and says so for same-game legs
//
// Data some rules need (the NFL/NHL multipliers in each sport's data.json) is
// handed over by that sport's page with RonParlay.provide(sport, {...}) and
// cached in localStorage, so the NHL multipliers still apply on the NFL page.
//
// Loaded as a classic script after /odds.js and /sgp.js; the page's own code
// uses the globals below (PARLAY, parAttr, parLeg, parGame, parMode, ...).
(function () {
  const APP = (location.pathname.split('/')[1] || '').toLowerCase();
  const PAR_SPORT = ['mlb', 'nfl', 'nhl', 'nba'].includes(APP) ? APP : 'mlb';
  const PAR_KEY = 'dtParlay', CTX_KEY = 'dtParlayCtx', SIDE_KEY = 'dtParSides';
  const PAR_SPORT_LBL = { mlb: 'MLB', nfl: 'NFL', nhl: 'NHL', nba: 'NBA' };
  const PAR_BOOSTS = [0, 0.25, 0.5, 1];
  const PARLAY = { on: false, open: false, legs: [], boost: 0, book: '' };
  let PAR_SIDES = {};
  try { PAR_SIDES = JSON.parse(localStorage.getItem(SIDE_KEY) || '{}') || {}; } catch (e) {}
  const am = (p) => window.Odds ? Odds.am(p) : String(p);

  const parEsc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
  /** Stamp a leg with its sport. Idempotent — a payload read back off a row already carries it. */
  const parLeg = (leg) => leg.sp ? leg : { ...leg, sp: PAR_SPORT, k: PAR_SPORT + ':' + leg.k };
  /** Attribute for a priced row. Keys are short because this ships on every row. */
  const parAttr = (leg) => leg && leg.p > 0 ? ` data-leg="${parEsc(JSON.stringify(parLeg(leg)))}"` : '';
  // ── Sides ─────────────────────────────────────────────────────────────────
  // Every board prices the over (or the Yes); a toggle at the top of each tool
  // flips the whole board to the under (or the No). The side is kept per tool,
  // per sport, and an under leg is keyed `|u`, which flips its correlations.
  //   const side = parSideGet('rec');                          // 'over' | 'under'
  //   parSideToggleHtml('rec', false, 'renderRec()')           // the toggle; re-renders on click
  //   parAttr(parSideLeg(leg, side))  ·  Odds.both(parSidePrice(p, side))
  //   rows.map(r => parSideRow(r, 'rec'))   then   parAttr(parSideTag(leg, r.side)) and parSideLine(r)
  const parUnder = (side) => side === 'under' || side === 'no';
  /** Re-key and re-label a leg for this side, keeping its p (for rows already priced on that side). */
  function parSideTag(leg, side, binary) {
    if (!leg) return leg;
    const rawKey = String(leg.k || ''), hasSide = /\|[ou]$/.test(rawKey), baseKey = rawKey.replace(/\|[ou]$/, '');
    const under = parUnder(side), label = String(leg.s || '').replace(/^(?:over|under|yes|no)\s+/i, '');
    if (binary == null) binary = !/\d/.test(label);
    return { ...leg, k: under ? baseKey + '|u' : hasSide ? baseKey + '|o' : baseKey,
      s: binary ? (under ? `No ${label}` : label) : `${under ? 'Under' : 'Over'} ${label}` };
  }
  /** The leg for this side from its over / Yes leg: 1 - p, a `|u` key, an Under / No label. */
  function parSideLeg(leg, side, binary) {
    if (!leg || !(leg.p > 0)) return leg;
    const overP = /\|u$/.test(String(leg.k || '')) ? 1 - leg.p : leg.p;
    return { ...parSideTag(leg, side, binary), p: parUnder(side) ? 1 - overP : overP };
  }
  const parSideId = (market) => PAR_SPORT + '|' + market;
  const parSideGet = (market) => PAR_SIDES[parSideId(market)] === 'under' ? 'under' : 'over';
  function parSideSet(market, side) {
    PAR_SIDES[parSideId(market)] = parUnder(side) ? 'under' : 'over';
    try { localStorage.setItem(SIDE_KEY, JSON.stringify(PAR_SIDES)); } catch (e) {}
  }
  const parSidePrice = (overP, side) => overP == null || !parUnder(side) ? overP : 1 - overP;
  /** Over / Under (or Yes / No) for one tool. `rerender` is the page call that redraws the board. */
  function parSideToggleHtml(market, binary = false, rerender = '') {
    const u = parSideGet(market) === 'under', go = (sd) => `setParSide('${market}','${sd}');${rerender}`;
    return `<div class="view-switch par-side-toggle" role="group" aria-label="${binary ? 'Yes or No' : 'Over or Under'}" title="Which side the board prices, and adds to a parlay">
    <button class="view-btn${u ? '' : ' active'}" onclick="${go('over')}">${binary ? 'Yes' : 'Over'}</button>
    <button class="view-btn${u ? ' active' : ''}" onclick="${go('under')}">${binary ? 'No' : 'Under'}</button>
  </div>`;
  }
  const setParSide = (market, side) => parSideSet(market, side);
  /** A board row on its tool's side: `side`, the over price kept as `pO`, and `key` (default p) flipped for an under. */
  const parSideRow = (r, market, key = 'p') => { const side = parSideGet(market); return { ...r, side, pO: r[key], [key]: parSidePrice(r[key], side) }; };
  /** "o4.5" / "u4.5" for a row from parSideRow. */
  const parSideLine = (r, L = r.L) => (parUnder(r.side) ? 'u' : 'o') + L;
  /** Canonical away@home key, so two legs in the same game always collide. */
  const parGame = (r) => r.home ? `${r.opp}@${r.team}` : `${r.team}@${r.opp}`;
  const parDecAm = (d) => !(d > 1) ? '—' : d >= 2 ? '+' + Math.round((d - 1) * 100) : '-' + Math.round(100 / (d - 1));
  /** "+1400", "1400" and "-110" all parse; anything else is null. */
  function parAmDec(s) {
    const v = parseFloat(String(s).replace(/[^0-9.+-]/g, ''));
    if (!isFinite(v) || Math.abs(v) < 100) return null;
    return v > 0 ? 1 + v / 100 : 1 + 100 / -v;
  }
  function parSave() {
    try { localStorage.setItem(PAR_KEY, JSON.stringify({ on: PARLAY.on, open: PARLAY.open, legs: PARLAY.legs, boost: PARLAY.boost })); } catch (e) {}
  }
  function parLoad() {
    try {
      const s = JSON.parse(localStorage.getItem(PAR_KEY) || '{}');
      if (Array.isArray(s.legs)) PARLAY.legs = s.legs.filter(l => l && l.k && l.p > 0);
      PARLAY.on = !!s.on; PARLAY.open = !!s.open; PARLAY.boost = +s.boost || 0;
    } catch (e) {}
  }

  // ── What each sport's page hands over ─────────────────────────────────────
  // provide(sport, { ctx, pos, links, onAdd, decorate }):
  //   ctx       its data.json `parlay` block, or a function returning it (read
  //             lazily, so it can be called before the data loads); cached
  //   pos       NFL: pid -> position, to split a TD into WR/TE, RB or QB
  //   links     NHL: (scorer, assister) -> games this season B assisted A, or null
  //   onAdd     called with a leg of that sport when it's added
  //   decorate  (leg) -> leg, before it's stored (stamp what other pages need)
  parLoad();   // now, not at DOMContentLoaded: pages call provide() (and read PARLAY) while they load
  let CTX = {};
  try { CTX = JSON.parse(localStorage.getItem(CTX_KEY) || '{}') || {}; } catch (e) {}
  const HOST = {};
  function ctx(sp) {
    const f = HOST[sp]?.ctx, v = typeof f === 'function' ? f() : f;
    if (v && JSON.stringify(v) !== JSON.stringify(CTX[sp])) {
      CTX[sp] = v; try { localStorage.setItem(CTX_KEY, JSON.stringify(CTX)); } catch (e) {}
    }
    return v || CTX[sp] || null;
  }
  function provide(sp, hooks) {
    HOST[sp] = { ...HOST[sp], ...hooks };
    const live = () => { try { return typeof hooks.ctx === 'function' ? hooks.ctx() : hooks.ctx; } catch (e) { return null; } };
    const had = !!live();
    ctx(sp);
    // a slip restored from storage counts as added on this page (the NHL stack
    // loads its assist history this way)
    if (hooks.onAdd) PARLAY.legs.filter(l => l.sp === sp).forEach(l => { try { hooks.onAdd(l); } catch (e) {} });
    if (document.getElementById('par-body')) parRender();
    // The slip renders before the page's data arrives, so a restored slip would
    // show the fallback price until the next tap. Watch for the data (it's a
    // lazy getter) and re-price once when it lands.
    if (!had && typeof hooks.ctx === 'function') {
      let n = 0;
      const t = setInterval(() => {
        const v = live();
        if (v || ++n > 60) { clearInterval(t); if (v) { ctx(sp); parRender(); } }
      }, 500);
    }
  }

  const side = (l) => /\|u$/.test(l.k) ? -1 : 1;   // an under (or a No) is the other side of the same latent: flips the sign.
  // The measured group multipliers (TD groups, goal groups, scorer + assist stacks) are for Yes legs only.
  const pairs = (legs, f) => { for (let x = 0; x < legs.length; x++) for (let y = x + 1; y < legs.length; y++) f(legs[x], legs[y]); };
  const moreLess = (p, naive) => p > naive ? ((p / naive - 1) * 100).toFixed(0) + '% more' : ((1 - p / naive) * 100).toFixed(0) + '% less';

  // ── MLB ───────────────────────────────────────────────────────────────────
  // Same-game correlations, measured: research/sgp_mlb.py over every 2026 start,
  // each leg's own model probability as its margin (so ρ is only what's left
  // after the prices). Only pairs whose 95% interval excludes zero are here;
  // everything else prices as independent. Positive = they rise together.
  const SGP_MLB = {
    hrTeam:   0.039,   // two teammates' homers [+.026, +.052] — same pitcher, park, night (1.115x at typical prices)
    kBBSame: -0.152,   // one pitcher's K over and his BB over [-.199, -.111] — walks and Ks work against each other
    kHrOpp:  -0.072,   // a starter's K over and a homer off him [-.098, -.047] — the duel
    bbBBOpp: -0.065,   // the two starters' BB overs [-.133, -.003] — borderline, kept because it clears zero
    // batter Ks / walks legs: research/sgp_mlb_batter.py, every 2026 batter-game
    bkSpK:    0.266,   // a batter's K and the K over of the starter he faces [+.250, +.278]
    bbbSpBB:  0.328,   // a batter's walk and the BB over of the starter he faces [+.309, +.341]
    bkSpBB:  -0.022,   // a batter's K and that starter's BB over [-.036, -.008]
    bbbSpK:  -0.098,   // a batter's walk and that starter's K over [-.119, -.083]
    bkBBSame:-0.172,   // one batter's K and his own walk [-.190, -.160] — the PAs are a pie
    bkHrSame:-0.109,   // one batter's K and his own homer [-.132, -.088]
    bbbHrSame:-0.022,  // one batter's walk and his own homer [-.045, -.006]
    bkTeam:   0.013,   // two teammates' Ks [+.006, +.020] — same starter
    bbbTeam:  0.041,   // two teammates' walks [+.032, +.056]
    bbbHrTeam:0.025,   // a batter's walk and a teammate's homer [+.018, +.034] — men on, a starter in trouble
  };
  /** Which measured pair two MLB legs in one game are: { key into SGP_MLB, sign }, or null (independent). */
  function sgpPairMLB(a, b) {
    if (a.sp !== 'mlb' || b.sp !== 'mlb' || !a.g || a.g !== b.g) return null;
    const kind = (l) => l.m === 'hr' ? 'hr' : l.m === 'pK' ? 'k' : l.m === 'pBB' ? 'bb' : l.m === 'bK' ? 'bk' : l.m === 'bBB' ? 'bbb' : null;
    const ka = kind(a), kb = kind(b); if (!ka || !kb) return null;
    const sg = side(a) * side(b), R = (key) => key ? { key, sg } : null;
    const is = (x, y) => (ka === x && kb === y) || (ka === y && kb === x);
    // t is the batter's club and the pitcher's own club: in one game a different t
    // is the starter he faces (and, for two pitchers, the other starter)
    const same = a.i === b.i, mates = a.t === b.t && !same, opp = a.t !== b.t;
    if (is('hr', 'hr')) return R(mates && 'hrTeam');
    if (is('k', 'bb')) return R(same && 'kBBSame');
    if (is('k', 'hr')) return R(opp && 'kHrOpp');
    if (is('bb', 'bb')) return R(!same && 'bbBBOpp');
    if (is('bk', 'k')) return R(opp && 'bkSpK');
    if (is('bbb', 'bb')) return R(opp && 'bbbSpBB');
    if (is('bk', 'bb')) return R(opp && 'bkSpBB');
    if (is('bbb', 'k')) return R(opp && 'bbbSpK');
    if (is('bk', 'bbb')) return R(same && 'bkBBSame');
    if (is('bk', 'hr')) return R(same && 'bkHrSame');
    if (is('bbb', 'hr')) return R(same ? 'bbbHrSame' : mates && 'bbbHrTeam');
    if (is('bk', 'bk')) return R(mates && 'bkTeam');
    if (is('bbb', 'bbb')) return R(mates && 'bbbTeam');
    return null;
  }
  /** ρ between two MLB legs in one game (0 = independent). */
  function sgpRhoMLB(a, b) { const q = sgpPairMLB(a, b); return q ? q.sg * SGP_MLB[q.key] : 0; }
  const SGP_WHY = { hrTeam: 'teammates homer together', kBBSame: 'a pitcher\'s Ks and walks work against each other', kHrOpp: 'a strikeout night takes homers away', bbBBOpp: 'the two starters rarely both walk a lot',
    bkSpK: 'a strikeout night for the starter is one for the bats he faces', bbbSpBB: 'a wild starter walks the bats he faces',
    bkSpBB: 'a wild starter strikes out fewer', bbbSpK: 'a strikeout night means fewer walks', bkBBSame: 'his Ks and walks split the same plate appearances',
    bkHrSame: 'a strikeout is a turn that didn\'t homer', bbbHrSame: 'a walk is a turn that didn\'t homer', bkTeam: 'teammates face the same arm',
    bbbTeam: 'teammates face the same arm', bbbHrTeam: 'walks put men on for a homer' };
  function priceMLB(legs, naive) {
    const res = window.SGP ? SGP.price(legs, sgpRhoMLB) : { p: naive, pairs: [] };
    if (!res.pairs.length) return { p: naive, corr: null };
    const why = [...new Set(res.pairs.map(q => { const m = sgpPairMLB(legs[q.a], legs[q.b]);
      return m ? (m.sg * SGP_MLB[m.key] > 0 ? '▲ ' : '▼ ') + SGP_WHY[m.key] : null; }).filter(Boolean))];
    return { p: res.p, corr: 'sgp', why, notes: [sgpNote(why, res.p, naive)] };
  }

  // ── NFL ───────────────────────────────────────────────────────────────────
  // Same-game correlations, measured: research/sgp_nfl_all.py — EVERY pair of
  // market kinds the slip can hold (same player / teammates / opponents), each
  // leg's own walk-forward probability as its margin, 2019-2025. A ρ is kept
  // where its 95% interval excludes zero; 0 means MEASURED independent (so
  // multiplying is the fair price). A pair missing from the table was never
  // measured (too few games, or can't happen) — only those still multiply blind.
  // The anytime TD splits by position: a WR/TE's TD is his QB's passing TD, an RB's isn't.
  const SGP_NFL = { 'opp|cmp|cmp': -0.08, 'opp|cmp|int': -0.134, 'opp|cmp|ptd': 0.192, 'opp|cmp|rec': -0.037, 'opp|cmp|td_qb': 0, 'opp|cmp|td_rb': 0.046, 'opp|cmp|td_wr': 0.084, 'opp|cmp|ypass': 0, 'opp|cmp|yrec': 0, 'opp|cmp|yrush': 0, 'opp|int|int': -0.102, 'opp|int|ptd': 0, 'opp|int|rec': -0.047, 'opp|int|td_qb': 0, 'opp|int|td_rb': 0.064, 'opp|int|td_wr': 0, 'opp|int|ypass': -0.102, 'opp|int|yrec': -0.031, 'opp|int|yrush': 0.042, 'opp|ptd|ptd': 0.145, 'opp|ptd|rec': 0.074, 'opp|ptd|td_qb': 0, 'opp|ptd|td_rb': 0.083, 'opp|ptd|td_wr': 0.065, 'opp|ptd|ypass': 0.19, 'opp|ptd|yrec': 0.074, 'opp|ptd|yrush': 0, 'opp|rec|rec': 0, 'opp|rec|td_qb': 0, 'opp|rec|td_rb': 0.025, 'opp|rec|td_wr': 0.041, 'opp|rec|ypass': 0, 'opp|rec|yrec': 0, 'opp|rec|yrush': 0, 'opp|td_qb|td_qb': 0, 'opp|td_qb|td_rb': 0, 'opp|td_qb|td_wr': 0, 'opp|td_qb|ypass': 0, 'opp|td_qb|yrec': 0, 'opp|td_qb|yrush': 0, 'opp|td_rb|td_rb': 0, 'opp|td_rb|td_wr': 0.022, 'opp|td_rb|ypass': 0.063, 'opp|td_rb|yrec': 0.027, 'opp|td_rb|yrush': -0.052, 'opp|td_wr|td_wr': 0.025, 'opp|td_wr|ypass': 0.083, 'opp|td_wr|yrec': 0.05, 'opp|td_wr|yrush': -0.01, 'opp|ypass|ypass': 0.139, 'opp|ypass|yrec': 0.045, 'opp|ypass|yrush': 0, 'opp|yrec|yrec': 0.022, 'opp|yrec|yrush': 0, 'opp|yrush|yrush': -0.113, 'same|cmp|int': 0.117, 'same|cmp|ptd': 0.29, 'same|cmp|td_qb': 0, 'same|cmp|ypass': 0.792, 'same|int|ptd': -0.159, 'same|int|td_qb': 0, 'same|int|ypass': 0, 'same|ptd|td_qb': -0.148, 'same|ptd|ypass': 0.455, 'same|rec|td_rb': 0.142, 'same|rec|td_wr': 0.388, 'same|rec|yrec': 0.842, 'same|rec|yrush': 0.083, 'same|td_qb|ypass': 0, 'same|td_rb|yrec': 0.16, 'same|td_rb|yrush': 0.431, 'same|td_wr|yrec': 0.405, 'same|yrec|yrush': 0, 'team|cmp|rec': 0.336, 'team|cmp|td_rb': 0, 'team|cmp|td_wr': 0.097, 'team|cmp|yrec': 0.242, 'team|cmp|yrush': -0.141, 'team|int|rec': 0.024, 'team|int|td_rb': -0.09, 'team|int|td_wr': -0.06, 'team|int|yrec': 0.02, 'team|int|yrush': 0, 'team|ptd|rec': 0.103, 'team|ptd|td_rb': 0.024, 'team|ptd|td_wr': 0.455, 'team|ptd|yrec': 0.15, 'team|ptd|yrush': 0, 'team|rec|rec': 0.023, 'team|rec|td_qb': 0, 'team|rec|td_rb': -0.026, 'team|rec|td_wr': 0, 'team|rec|ypass': 0.275, 'team|rec|yrec': 0, 'team|rec|yrush': -0.053, 'team|td_qb|td_rb': -0.05, 'team|td_qb|td_wr': -0.071, 'team|td_qb|yrec': 0, 'team|td_qb|yrush': 0.051, 'team|td_rb|td_rb': -0.047, 'team|td_rb|td_wr': -0.062, 'team|td_rb|ypass': 0.05, 'team|td_rb|yrec': 0, 'team|td_rb|yrush': 0, 'team|td_wr|td_wr': -0.052, 'team|td_wr|ypass': 0.167, 'team|td_wr|yrec': 0.014, 'team|td_wr|yrush': 0, 'team|ypass|yrec': 0.32, 'team|ypass|yrush': -0.091, 'team|yrec|yrec': 0, 'team|yrec|yrush': -0.032, 'team|yrush|yrush': 0 };
  const SGP_NFL_SEASONS = '2019-2025 games';
  const SGP_KIND = { td1: 'td', ptd: 'ptd', rec: 'rec', cmp: 'cmp', int: 'int', yrec: 'yrec', yrush: 'yrush', ypass: 'ypass' };
  const SGP_LBL = { rec: 'receptions', yrec: 'receiving yards', yrush: 'rushing yards', cmp: 'completions', ypass: 'passing yards', int: 'an interception', ptd: '2+ pass TDs', td_wr: 'a receiver\'s TD', td_rb: 'a back\'s TD', td_qb: 'a QB\'s TD' };
  // the pairs worth a sentence of why; the rest get a generic line
  const SGP_NFL_WHY = {
    'same|rec|yrec': 'his catches carry his yards', 'same|rec|td_wr': 'a busy day means a TD shot', 'same|td_wr|yrec': 'yards and a TD go together',
    'same|td_rb|yrush': 'a big rushing day means a TD shot', 'same|cmp|ypass': 'completions carry passing yards', 'same|ptd|ypass': 'passing TDs come with passing yards',
    'same|cmp|int': 'more throws, more of both', 'same|int|ptd': 'picks and passing TDs work against each other', 'same|cmp|ptd': 'completions come with passing TDs',
    'team|rec|rec': 'a pass-heavy game lifts both', 'team|td_wr|td_wr': 'teammates share a fixed pool of TDs', 'team|td_rb|td_wr': 'teammates share a fixed pool of TDs',
    'team|cmp|rec': 'his completions are the receiver\'s catches', 'team|yrec|ypass': 'his yards are the receiver\'s yards', 'team|cmp|yrec': 'his completions are the receiver\'s yards',
    'team|ptd|td_wr': 'a receiving TD is his passing TD', 'team|int|td_wr': 'a pick costs his team a scoring drive', 'team|int|td_rb': 'a pick costs his team a scoring drive',
    'team|cmp|td_wr': 'more completions, more chances in the end zone', 'team|cmp|yrush': 'a passing day means fewer carries',
    'opp|td_wr|td_wr': 'a shootout lifts both sides', 'opp|ypass|ypass': 'shootouts lift both QBs', 'opp|int|int': 'rarely both throw picks',
    'opp|cmp|int': 'a QB piling up completions is usually winning, so the other side isn\'t forced into picks', 'opp|yrush|yrush': 'one team running away with it means the other stops running',
  };
  const nflPos = (l) => l.pos || HOST.nfl?.pos?.(l.i) || null;
  /** The table key for two NFL legs in one game ('rel|kindA|kindB'), or null if they aren't a same-game pair. */
  function sgpRuleNFL(a, b) {
    if (a.sp !== 'nfl' || b.sp !== 'nfl' || !a.g || a.g !== b.g) return null;
    const kind = (l) => { const k = SGP_KIND[l.m]; if (k !== 'td') return k;
      const p = nflPos(l); return p === 'RB' || p === 'FB' ? 'td_rb' : p === 'QB' ? 'td_qb' : 'td_wr'; };
    const ka = kind(a), kb = kind(b); if (!ka || !kb) return null;
    const rel = a.i === b.i ? 'same' : a.t && a.t === b.t ? 'team' : a.t && b.t ? 'opp' : null; if (!rel) return null;
    return `${rel}|${[ka, kb].sort().join('|')}`;
  }
  const sgpRhoNFL = (a, b) => { const k = sgpRuleNFL(a, b); if (!k || !(k in SGP_NFL)) return 0; return side(a) * side(b) * SGP_NFL[k]; };
  function sgpWhyNFL(k, rho) {
    if (SGP_NFL_WHY[k]) return SGP_NFL_WHY[k];
    const [rel, x, y] = k.split('|');
    return `${SGP_LBL[x]} and ${SGP_LBL[y]}${rel === 'same' ? ' (same player)' : rel === 'team' ? ' (teammates)' : ' (opponents)'} ${rho > 0 ? 'tend to land together' : 'tend to pull apart'}`;
  }
  /** Anytime-TD group: the measured multipliers from the NFL data.json `parlay` block. */
  function tdGroupNFL(legs) {
    const P = ctx('nfl'); if (!P) return null;
    const naive = legs.reduce((a, l) => a * l.p, 1);
    const byTeam = {};
    for (const l of legs) (byTeam[l.t ?? '?'] ??= []).push(l);
    const sizes = Object.values(byTeam).map(v => v.length);
    let mult;
    if (sizes.length === 1) {
      // Pure same-team: the multiplier measured for this exact size (the pairwise
      // rule under-corrects as groups grow: cannibalisation compounds).
      mult = P.same_by_size?.[String(legs.length)] ?? Math.pow(P.rho_same, legs.length * (legs.length - 1) / 2);
    } else {
      let samePairs = 0;
      for (const n of sizes) samePairs += n * (n - 1) / 2;
      const totalPairs = legs.length * (legs.length - 1) / 2;
      mult = Math.pow(P.rho_same, samePairs) * Math.pow(P.rho_cross, totalPairs - samePairs);
    }
    return Math.min(0.999, Math.max(1e-6, naive * mult));
  }
  function priceNFL(legs, naive) {
    const teams = {};
    for (const l of legs) if (l.t) teams[l.t] = (teams[l.t] || 0) + 1;
    const mates = Object.values(teams).some(n => n > 1);
    if (legs.length > 1 && legs.every(l => l.m === 'td1' && l.i && side(l) > 0)) {
      const p = tdGroupNFL(legs);
      if (p != null) return { p, corr: true, notes: [`Priced with the measured touchdown correlation rather than by multiplying${mates ? ' — teammates compete for the same end-zone trips' : ''}. Straight multiplication says <b>${am(naive)}</b>.`] };
    }
    // everything else in one game: the copula over the measured ρs.
    // `unmeasured`: same-game pairs research never measured; `indep`: measured, and independent
    let unmeasured = 0, sameGamePairs = 0;
    pairs(legs, (a, b) => { if (!a.g || a.g !== b.g) return; sameGamePairs++; const k = sgpRuleNFL(a, b); if (!k || !(k in SGP_NFL)) unmeasured++; });
    let p = naive, corr = null, why = [];
    if (legs.length > 1 && window.SGP) {
      const res = SGP.price(legs, sgpRhoNFL);
      if (res.pairs.length) {
        p = res.p; corr = 'sgp';
        why = [...new Set(res.pairs.map(q => { const k = sgpRuleNFL(legs[q.a], legs[q.b]); return k ? (q.rho > 0 ? '▲ ' : '▼ ') + sgpWhyNFL(k, SGP_NFL[k]) : null; }).filter(Boolean))];
      } else if (sameGamePairs && !unmeasured) corr = 'indep';
    }
    if ((corr === 'sgp' || corr === 'indep') && unmeasured) why.push(`${unmeasured} pair${unmeasured === 1 ? '' : 's'} not measured, multiplied`);
    const notes = corr === 'sgp' ? [sgpNote(why, p, naive)]
      : corr === 'indep' ? [`Same-game legs, but measured independent — these markets don't move together (${SGP_NFL_SEASONS}), so multiplying them is the fair same-game price.`] : [];
    return { p, corr, why, notes };
  }

  // ── NHL ───────────────────────────────────────────────────────────────────
  //   anytime-goal legs   research/nhl_pairs.py — teammates are nearly
  //                       independent as a pair (0.98) but compete as the group
  //                       grows (trio 0.89, four 0.69); opponents 0.97
  //   goal + assist       research/nhl_stacks.py — A scores and his teammate B
  //                       picks up an assist runs 19% above the product, 47%
  //                       once B has set A up 5+ times this season
  /**
   * Multiplier for a group of anytime-goal legs ({t, g}), or null when it's
   * outside what was measured (five or more from one club). Groups split by
   * game — legs in different games are independent — then by club within a game.
   */
  function goalGroupMult(members) {
    const P = ctx('nhl'); if (!P) return null;
    const games = {};
    for (const m of members) ((games[m.g] ??= {})[m.t] ??= []).push(m);
    let mult = 1;
    for (const teams of Object.values(games)) {
      const sizes = Object.values(teams).map(v => v.length);
      for (const n of sizes) {
        if (n < 2) continue;
        const f = P.same_by_size?.[String(n)]; if (f == null) return null;
        mult *= f;
      }
      if (sizes.length === 2) mult *= Math.pow(P.rho_cross, sizes[0] * sizes[1]);
    }
    return mult;
  }
  /** Scorer + assist stack multiplier, by how often B has set A up this season. */
  // The link counts come from the NHL page's goal archive; each one it works
  // out is cached so the same stack prices the same on the other pages.
  function stackMult(a, b) {
    const bins = ctx('nhl')?.stack || [];
    const key = `${a}|${b}`, cache = CTX.nhlLinks ||= {};
    let known = HOST.nhl?.links ? HOST.nhl.links(a, b) : null;
    if (known != null && cache[key] !== known) { cache[key] = known; try { localStorage.setItem(CTX_KEY, JSON.stringify(CTX)); } catch (e) {} }
    if (known == null && key in cache) known = cache[key];
    const n = known ?? 0;
    const bin = bins.find(x => n >= x.lo && n <= x.hi) || bins[0];
    return bin ? { mult: bin.mult, links: n, known: known != null } : null;
  }
  // Same-game correlations, measured: research/sgp_nhl.py (+ sgp_nhl_extra.py),
  // walk-forward, each leg's own model probability as its margin (so ρ is only
  // what's left beyond the prices). Only pairs whose 95% interval excludes
  // zero; the rest price as independent. Positive = rise together.
  const SGP_NHL = {
    // same player
    sG: 0.489,     // his shots over + his goal [.481, .495]
    sA: 0.038,     // his shots over + his assist [.028, .048]
    hB: 0.012,     // his hits over + his blocks over [.005, .018]
    hP: -0.016,    // his hits over + his point [-.025, -.005] — grinders don't score
    svGa: -0.143,  // a goalie's saves over + his GA over [-.174, -.116] — a goal is a save that didn't happen
    // teammates
    gA: 0.142,     // goal + a teammate's assist [.135, .151] — the same play
    aA: 0.080,     // two teammates' assists [.073, .087]
    pP: 0.142,     // two teammates' points [.135, .149]
    gP: 0.105,     // goal + a teammate's point [.097, .112]
    aP: 0.134,     // assist + a teammate's point [.127, .141]
    sS: 0.014,     // two teammates' shots overs [.007, .018]
    sGmate: -0.013,// shots over + a teammate's goal [-.021, -.003] — one shooter's volume is another's
    hH: 0.039,     // two teammates' hits overs [.030, .047]
    bB: 0.022,     // two teammates' blocks overs [.014, .027]
    svGown: 0.038, // goalie saves over + his own skater's goal [.027, .046]
    // opponents
    gGopp: -0.021, // goals on opposite sides [-.032, -.010]
    pPopp: -0.015, // points on opposite sides [-.022, -.004]
    sSopp: -0.013, // shots overs on opposite sides [-.017, -.006] — one team's possession
    hHopp: 0.026,  // hits overs on opposite sides [.017, .032] — a physical game
    bSopp: 0.012,  // blocks over + an opponent's shots over [.005, .018]
    svS: 0.223,    // goalie saves over + an opposing skater's shots over [.215, .230]
    svG: -0.073,   // goalie saves over + an opposing skater's goal [-.082, -.064]
    svA: -0.077,   // … + an opposing skater's assist [-.086, -.068]
    svP: -0.090,   // … + an opposing skater's point [-.104, -.080]
    gaG: 0.347,    // goalie GA over 2.5 + an opposing skater's goal [.339, .356]
    gaA: 0.382,    // … + an opposing skater's assist [.373, .390]
    gaP: 0.430,    // … + an opposing skater's point [.422, .439]
    svSv: -0.097,  // both goalies' saves overs [-.149, -.057] — one team is carrying the play
  };
  const SGP_NHL_WHY = { sG: 'his shots are his goal chances', sA: 'a busy night is a busy night', hB: 'a big-minutes grinder', hP: 'grinders rarely score',
    svGa: 'a goal is a save that didn\'t happen', gA: 'a goal comes with its assists', aA: 'assists come in pairs', pP: 'a scoring line lifts together', gP: 'a goal comes with its points',
    aP: 'a goal comes with its points', sS: 'possession lifts both', sGmate: 'one shooter\'s volume is another\'s', hH: 'a physical night', bB: 'a night under siege',
    svGown: 'a busy goalie, a tilted game', gGopp: 'opposite sides of one scoreboard', pPopp: 'opposite sides of one scoreboard', sSopp: 'one team has the puck',
    hHopp: 'a physical game', bSopp: 'their shots are his blocks', svS: 'their shots are his saves', svG: 'a goal is a save that didn\'t happen',
    svA: 'a goal is a save that didn\'t happen', svP: 'a goal is a save that didn\'t happen', gaG: 'their goals are his goals allowed', gaA: 'their goals are his goals allowed',
    gaP: 'their goals are his goals allowed', svSv: 'one team is carrying the play' };
  const NHL_KIND = { g1: 'g', g2: 'g', g3: 'g', gp1: 'g', gpp: 'g', ast: 'a', pts: 'p', ppp: 'p', sog: 's', hit: 'h', blk: 'b', sv: 'sv', ga: 'ga' };
  /** The measured rule for two NHL legs in one game (null = independent). */
  function sgpRuleNHL(a, b) {
    if (a.sp !== 'nhl' || b.sp !== 'nhl' || !a.g || a.g !== b.g) return null;
    const ka = NHL_KIND[a.m], kb = NHL_KIND[b.m]; if (!ka || !kb) return null;
    const is = (x, y) => (ka === x && kb === y) || (ka === y && kb === x);
    const goalie = (k) => k === 'sv' || k === 'ga';
    const same = a.i === b.i, mate = !same && a.t === b.t, opp = a.t !== b.t;
    if (same) {
      if (is('s', 'g')) return 'sG'; if (is('s', 'a')) return 'sA'; if (is('h', 'b')) return 'hB'; if (is('h', 'p')) return 'hP'; if (is('sv', 'ga')) return 'svGa';
      return null;
    }
    if (mate) {
      if (goalie(ka) || goalie(kb)) return is('sv', 'g') ? 'svGown' : null;
      if (is('g', 'a')) return 'gA'; if (is('a', 'a')) return 'aA'; if (is('p', 'p')) return 'pP'; if (is('g', 'p')) return 'gP'; if (is('a', 'p')) return 'aP';
      if (is('s', 's')) return 'sS'; if (is('s', 'g')) return 'sGmate'; if (is('h', 'h')) return 'hH'; if (is('b', 'b')) return 'bB';
      return null;
    }
    if (opp) {
      if (is('sv', 'sv')) return 'svSv';
      if (is('sv', 's')) return 'svS'; if (is('sv', 'g')) return 'svG'; if (is('sv', 'a')) return 'svA'; if (is('sv', 'p')) return 'svP';
      if (is('ga', 'g')) return 'gaG'; if (is('ga', 'a')) return 'gaA'; if (is('ga', 'p')) return 'gaP';
      if (is('g', 'g')) return 'gGopp'; if (is('p', 'p')) return 'pPopp'; if (is('s', 's')) return 'sSopp'; if (is('h', 'h')) return 'hHopp'; if (is('b', 's')) return 'bSopp';
    }
    return null;
  }
  const sgpRhoNHL = (a, b) => { const k = sgpRuleNHL(a, b); return k ? side(a) * side(b) * SGP_NHL[k] : 0; };
  /** A player's goal or assist (1+) already IS a point: over 0.5 points on the same player adds nothing. */
  const impliedNHL = (legs) => legs.filter(l => !(side(l) > 0 && l.m === 'pts' && l.L === 0.5 &&
    legs.some(o => o !== l && side(o) > 0 && o.i === l.i && ['g1', 'ast'].includes(o.m))));
  function priceNHL(legs, naive) {
    if (legs.length > 1 && legs.every(l => l.m === 'g1' && side(l) > 0)) {
      const f = goalGroupMult(legs);
      if (f != null) {
        const p = naive * f, gap = Math.round((p / naive - 1) * 100);
        return { p, corr: 'goals', notes: gap ? [`Priced with the measured goal-scorer correlation — ${gap < 0 ? 'teammates share a fixed number of goals, so a big same-club group lands below' : 'these legs land above'} straight multiplication, which says <b>${am(naive)}</b> (${gap > 0 ? '+' : ''}${gap}%).`] : [] };
      }
    } else if (legs.length === 2) {
      const A = legs.find(l => l.m === 'g1' && side(l) > 0), B = legs.find(l => l.m === 'ast' && l.L === 0.5 && side(l) > 0);
      if (A && B && A.t === B.t && A.i !== B.i && A.g === B.g) {
        const st = stackMult(A.i, B.i);
        if (st) {
          const p = naive * st.mult, gap = Math.round((p / naive - 1) * 100);
          return { p, corr: 'stack', notes: [`A scorer + assist stack: when ${parEsc(A.n)} scores, someone gets the assist — ${parEsc(B.n)} ${st.known ? (st.links ? `has set him up in <b>${st.links}</b> game${st.links === 1 ? '' : 's'} this season` : `hasn't set him up yet this season`) : (PAR_SPORT === 'nhl' ? '(this season\'s assists are loading)' : '(open the NHL page once for this season\'s assists)')}, so this runs <b>+${gap}%</b> over multiplying (${am(naive)}).`] };
        }
      }
    }
    // everything else in one game: the copula over the measured ρs, with a
    // same-player point that a goal/assist already guarantees dropped
    if (legs.length > 1 && window.SGP) {
      const core = impliedNHL(legs);
      const res = SGP.price(core, sgpRhoNHL);
      if (res.pairs.length || core.length < legs.length) {
        const why = [...new Set(res.pairs.map(q => { const k = sgpRuleNHL(core[q.a], core[q.b]); return k ? (q.rho > 0 ? '▲ ' : '▼ ') + SGP_NHL_WHY[k] : null; }).filter(Boolean))];
        if (core.length < legs.length) why.push('a goal or assist already counts as his point');
        return { p: res.p, corr: 'sgp', why, notes: [sgpNote(why, res.p, naive)] };
      }
    }
    return { p: naive, corr: null };
  }

  const sgpNote = (why, p, naive) => `Priced as a same-game parlay with measured correlations, not by multiplying: ${why.join('; ')}. Straight multiplication says <b>${am(naive)}</b> — this slip hits <b>${moreLess(p, naive)}</b> often than that.`;
  const RULES = { mlb: priceMLB, nfl: priceNFL, nhl: priceNHL };

  /**
   * The slip's fair price. Each sport prices its own legs with its measured
   * rules; sports multiply. Returns the overall p and naive product, `corr`
   * ('sgp' when anything was correlation-priced, 'indep' when same-game legs
   * were measured independent, else null), the notes to print, and the
   * same-game groups / same-player markets that were multiplied blind.
   */
  function parPrice() {
    const legs = PARLAY.legs;
    const naive = legs.reduce((a, l) => a * l.p, 1);
    const bySport = {};
    for (const l of legs) (bySport[l.sp] ??= []).push(l);
    const mixed = Object.keys(bySport).length > 1;
    let p = 1, corr = null;
    const notes = [], shared = [], samePlayer = [], why = [];
    for (const [sp, sl] of Object.entries(bySport)) {
      const sn = sl.reduce((a, l) => a * l.p, 1);
      const r = (sl.length > 1 && RULES[sp]) ? RULES[sp](sl, sn) : { p: sn, corr: null };
      p *= r.p;
      if (r.corr && r.corr !== 'indep') corr = 'sgp'; else if (r.corr === 'indep' && !corr) corr = 'indep';
      why.push(...(r.why || []));
      for (const n of r.notes || []) notes.push(mixed ? `<b>${PAR_SPORT_LBL[sp] || sp.toUpperCase()}:</b> ${n}` : n);
      if (!r.corr) {
        // multiplied blind: say so for same-game legs and for two markets on one player
        const games = {}, who = {};
        for (const l of sl) { if (l.g) (games[l.g] ??= []).push(l); if (l.i) (who[l.i] ??= []).push(l); }
        shared.push(...Object.values(games).filter(v => v.length > 1));
        samePlayer.push(...Object.values(who).filter(v => v.length > 1).map(v => v[0].n));
      }
    }
    return { p: Math.min(0.999, legs.length ? p : 0), naive, corr, why, notes, shared, samePlayer };
  }

  // ── The slip ──────────────────────────────────────────────────────────────
  function parMode(on) {
    PARLAY.on = on;
    if (!on) PARLAY.open = false;
    document.body.classList.toggle('par-mode', on);
    parRender(); parPaint(); parSave();
  }
  function parToggleOpen(e) {
    if (e && e.target.closest('.par-x, .par-mode-btn')) return;
    PARLAY.open = !PARLAY.open;
    document.getElementById('par-slip').classList.toggle('open', PARLAY.open);
    parRender(); parSave();
  }
  function parToggleLeg(leg) {
    leg = parLeg(leg);
    const i = PARLAY.legs.findIndex(l => l.k === leg.k);
    if (i >= 0) PARLAY.legs.splice(i, 1);
    else {
      if (HOST[leg.sp]?.decorate) leg = HOST[leg.sp].decorate(leg) || leg;
      // Two lines in one player's market are not a parlay: over 7.5 and under
      // 7.5 can never both land, and over 7.5 with over 8.5 is one bet priced
      // twice. A new selection replaces the old one, like any bet slip.
      const clash = PARLAY.legs.findIndex(l => l.i && l.sp === leg.sp && l.i === leg.i && l.m === leg.m);
      if (clash >= 0) PARLAY.legs.splice(clash, 1);
      PARLAY.legs.push(leg);
      HOST[leg.sp]?.onAdd?.(leg);
    }
    // Opening the slip on the first leg shows the boost controls exist, but on
    // a phone the expanded sheet covers the board you are picking from — so
    // there it stays collapsed and the header carries the price.
    if (PARLAY.legs.length === 1 && i < 0 && window.innerWidth > 600) PARLAY.open = true;
    document.getElementById('par-slip').classList.toggle('open', PARLAY.open);
    parRender(); parPaint(); parSave();
  }
  function parRemove(k) { PARLAY.legs = PARLAY.legs.filter(l => l.k !== k); parRender(); parPaint(); parSave(); }
  function parClear() { PARLAY.legs = []; parRender(); parPaint(); parSave(); }
  function parSetBoost(v) { PARLAY.boost = +v || 0; parRender(); parSave(); }
  function parCustomBoost(el) { PARLAY.boost = Math.max(0, Math.min(10, (parseFloat(el.value) || 0) / 100)); parRender(); parSave(); }
  function parBook(el) { PARLAY.book = el.value; parRenderEv(); }

  /** Mark selected rows, and show the button only where there is something to pick. */
  function parPaint() {
    const keys = new Set(PARLAY.legs.map(l => l.k));
    for (const el of document.querySelectorAll('[data-leg]')) {
      let k = el._plk;
      if (k === undefined) { try { k = JSON.parse(el.dataset.leg).k; } catch (e) { k = null; } el._plk = k; }
      el.classList.toggle('par-pick', keys.has(k));
    }
    // Panels are hidden, not destroyed, so "anything to pick here" has to mean
    // the visible one — otherwise the button follows you onto boards that price nothing.
    document.body.classList.toggle('par-has', !!document.querySelector('.panel.visible [data-leg]'));
  }
  function parRenderEv() {
    const out = document.getElementById('par-ev-out'); if (!out) return;
    const { p, corr } = parPrice(), d = parAmDec(PARLAY.book);
    if (!d || !(p > 0) || !PARLAY.legs.length) { out.textContent = ''; out.className = 'par-ev-out'; return; }
    const boosted = 1 + (d - 1) * (1 + PARLAY.boost);
    const ev = p * boosted - 1;
    const tax = ev < 0 ? ` — the book's ${PARLAY.legs.length > 1 && corr ? 'SGP ' : ''}tax is ${Math.abs(ev * 100).toFixed(0)}% of your stake` : ' — you have the best of it';
    out.textContent = `${parDecAm(boosted)} after the boost · ${ev >= 0 ? '+' : '−'}${Math.abs(ev * 100).toFixed(1)}% EV${tax}`;
    out.className = 'par-ev-out ' + (ev >= 0 ? 'good' : 'bad');
  }
  // the slip as text for Ron's odds-viewer bet tracker (its "Import from Ron's Tools")
  function parCopyTracker(btn) {
    const { p, corr } = parPrice();
    if (PARLAY.legs.length && window.RonTracker) RonTracker.copy(PARLAY.legs, p, { corr, book: PARLAY.book }, btn);
  }

  // Gambly line-shops a slip, SGPs included, from a chat prompt; its site takes the
  // prompt in the URL (gambly.com/chat?q= pre-fills the chat box). A link, not an API:
  // it opens in your browser and you press Enter there.
  function parGamblyURL() {
    const legs = PARLAY.legs, games = [...new Set(legs.map(l => String(l.g || '').replace('@', ' @ ')).filter(Boolean))];
    const sport = [...new Set(legs.map(l => String(l.sp || '').toUpperCase()).filter(Boolean))].join('/');
    const sgp = new Set(legs.map(l => l.g)).size < legs.length;
    const leg = (l) => `${l.n}${l.s ? ' ' + l.s : ''}${l.t ? ` (${l.t})` : ''}`;
    const q = legs.length === 1
      ? `Find me the best price for ${leg(legs[0])}${games.length ? ` — ${sport ? sport + ' ' : ''}${games[0]}` : ''}`
      : `Build me a betslip${sgp ? ' (same game parlay)' : ''} and find the best price: ${legs.map(leg).join(' + ')}${games.length ? ` — ${sport ? sport + ' ' : ''}${games.join(', ')}` : ''}`;
    return 'https://gambly.com/chat?q=' + encodeURIComponent(q);
  }

  function parRender() {
    const slip = document.getElementById('par-slip'); if (!slip) return;
    slip.classList.toggle('open', PARLAY.open);
    document.body.classList.toggle('par-legs', PARLAY.legs.length > 0);
    document.getElementById('par-mode-btn')?.classList.toggle('on', PARLAY.on);
    const legs = PARLAY.legs, { p, naive, notes, shared, samePlayer } = parPrice();
    const hn = document.getElementById('par-head-n'), ho = document.getElementById('par-head-od');
    hn.innerHTML = legs.length
      ? `${legs.length} leg${legs.length === 1 ? '' : 's'} <span>· ${PARLAY.on ? 'fair' : 'selection off'}</span>`
      : 'Parlay mode <span>· tap picks to add</span>';
    ho.className = 'par-head-od' + (legs.length ? '' : ' par-none');
    ho.textContent = legs.length ? Odds.both(p) : '0 legs';
    const body = document.getElementById('par-body');
    if (!legs.length) {
      body.innerHTML = `<div class="par-empty">Tap any priced row to add it.<br>One slip for the whole site: legs from every tool — and every sport — combine here.</div>`;
      return;
    }
    const mixed = new Set(legs.map(l => l.sp)).size > 1;
    const boostPct = Math.round(PARLAY.boost * 100);
    const custom = !PAR_BOOSTS.includes(PARLAY.boost);
    // With a boost, the worst book price that still beats fair: boosts lift
    // profit, not stake, so 1 + (d-1)(1+b) >= 1/p solves to this.
    const need = 1 + (1 / p - 1) / (1 + PARLAY.boost);
    body.innerHTML =
      `<div class="par-legs-hd"><span class="par-lbl2">${legs.length} leg${legs.length === 1 ? '' : 's'}</span><button class="par-clear" onclick="parClear()" title="Remove every leg"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg> Clear all</button></div>`
      + legs.map(l => `<div class="par-leg">
        <span class="par-leg-nm">${mixed ? `<span class="par-sp">${PAR_SPORT_LBL[l.sp] || ''}</span>` : ''}${parEsc(l.n)}</span>
        <span class="par-leg-sel">${parEsc(l.s)}${l.t ? ` · ${parEsc(l.t)}` : ''}</span>
        <span class="par-leg-od">${Odds.inline(l.p)}</span>
        <button class="par-leg-x" onclick="parRemove('${l.k.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/"/g, '&quot;')}')" aria-label="Remove">×</button>
      </div>`).join('')
      + `<div class="par-lbl2">Profit boost</div>
      <div class="par-chips">
        ${PAR_BOOSTS.map(b => `<button class="par-chip${!custom && PARLAY.boost === b ? ' on' : ''}" onclick="parSetBoost(${b})">${b ? Math.round(b * 100) + '%' : 'None'}</button>`).join('')}
        <span class="par-chip${custom ? ' on' : ''}"><input type="number" min="0" max="500" step="5" placeholder="custom" value="${custom ? boostPct : ''}" oninput="parCustomBoost(this)">%</span>
      </div>
      <div class="par-nums">
        <div class="par-num acc"><b>${am(p)}</b><span>Fair odds</span></div>
        <div class="par-num"><b>${(p * 100).toFixed(p < 0.1 ? 2 : 1)}%</b><span>True chance</span></div>
      </div>
      <p class="par-note">${PARLAY.boost
        ? `With a <b>${boostPct}%</b> profit boost, take it at <b>${parDecAm(need)}</b> or better and you have the best of it.`
        : `Anything longer than <b>${am(p)}</b> at your book beats fair.`}</p>
      ${notes.map(n => `<p class="par-note">${n}</p>`).join('')}
      ${samePlayer.length ? `<p class="par-note par-warn">Two markets on ${samePlayer.map(parEsc).join(' and ')} — one player's lines move together, so multiplying them overstates the price.</p>` : ''}
      ${shared.length ? `<p class="par-note par-warn">${shared.map(v => `${v.length} legs in ${parEsc(v[0].g)}`).join(', ')} — we haven't measured how these same-game legs move together, so this is a multiplied estimate, not a fair same-game price.</p>` : ''}
      <div class="par-ev">
        <label for="par-book">Your book's price</label>
        <input type="text" id="par-book" inputmode="text" placeholder="+1400" value="${parEsc(PARLAY.book)}" oninput="parBook(this)">
        <span class="par-ev-out" id="par-ev-out"></span>
      </div>
      <div class="par-outs">
        <a class="par-copy par-gambly" href="${parEsc(parGamblyURL())}" target="_blank" rel="noopener" title="Opens Gambly with this slip typed in: press Enter there and it finds the best price, SGPs included"><img src="https://www.google.com/s2/favicons?domain=gambly.com&amp;sz=64" alt="" width="14" height="14" onerror="this.remove()">Shop on Gambly ↗</a>
        <button class="par-copy" onclick="parCopyTracker(this)" title="Copies this slip as text for the odds-viewer tracker's Import">Copy for tracker</button>
      </div>`;
    parRenderEv();
  }

  // ── Markup + styles, injected once ────────────────────────────────────────
  const BOLT = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M13 2L4.5 13.5H11l-1 8.5 8.5-11.5H12l1-8.5z"/></svg>';
  const MARKUP = `<button class="par-fab" id="par-fab" onclick="parMode(true)" aria-label="Build a parlay">${BOLT} Parlay</button>
<div class="par-slip" id="par-slip">
  <div class="par-head" onclick="parToggleOpen(event)">
    <button class="par-mode-btn" id="par-mode-btn" onclick="parMode(!PARLAY.on)" aria-label="Select picks" title="Tap rows on the board to add them">${BOLT}</button>
    <span class="par-head-n" id="par-head-n">Parlay mode <span>· tap picks to add</span></span>
    <span class="par-head-od par-none" id="par-head-od">0 legs</span>
    <svg class="par-caret" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M6 15l6-6 6 6"/></svg>
    <button class="par-x" onclick="parMode(false)" aria-label="Exit parlay mode">×</button>
  </div>
  <div class="par-body" id="par-body"></div>
</div>`;
  // Every app defines the same theme tokens (--accent, --surface0/1/2,
  // --border/2, --dim, --muted, --text, --text-strong, --good, --bad, --ok,
  // --font-b/d/m, --nav-bottom/-h/-side), so one stylesheet fits all four.
  const CSS = `
  .par-fab { position: fixed; right: 1rem; bottom: 1.15rem; z-index: 225; display: none; align-items: center; gap: 0.4rem; font-family: var(--font-d); font-size: 0.82rem; font-weight: 700; letter-spacing: 0.03em; color: #04210f; background: var(--accent); border: none; border-radius: 999px; padding: 0.6rem 1rem 0.6rem 0.85rem; cursor: pointer; box-shadow: 0 8px 26px rgba(0,0,0,0.45); transition: transform 0.12s ease, filter 0.15s; }
  .par-fab:hover { transform: translateY(-1px); filter: brightness(1.06); }
  .par-fab svg { width: 16px; height: 16px; }
  body.par-has .par-fab { display: inline-flex; }
  body.par-mode .par-fab, body.par-legs .par-fab { display: none; }
  .lb-toolbar .par-side-toggle { margin-left: auto; }
  body.par-mode [data-leg] { position: relative; cursor: pointer; }
  body.par-mode div[data-leg], body.par-mode a[data-leg] { padding-left: 2.15rem; }
  body.par-mode tr[data-leg] td:first-child { position: relative; padding-left: 1.9rem; }
  body.par-mode [data-leg]::after,
  body.par-mode tr[data-leg] td:first-child::after { content: ''; position: absolute; left: 0.62rem; top: 50%; transform: translateY(-50%); width: 17px; height: 17px; border-radius: 6px; border: 1.5px solid var(--border2); background: var(--surface0); box-sizing: border-box; pointer-events: none; transition: background 0.12s, border-color 0.12s; }
  body.par-mode tr[data-leg]::after { content: none; }
  body.par-mode [data-leg].par-pick::after,
  body.par-mode tr[data-leg].par-pick td:first-child::after { border-color: var(--accent); background: var(--accent) url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%2304210f' stroke-width='3.4' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M4 12.5l5.5 5.5L20 6.5'/%3E%3C/svg%3E") center / 11px no-repeat; }
  body.par-mode div[data-leg].par-pick { border-color: var(--accent); box-shadow: inset 0 0 0 1px var(--accent); }
  body.par-mode tr[data-leg].par-pick td { background: rgba(51,208,124,0.09); }
  .par-slip { position: fixed; left: 50%; transform: translateX(-50%); bottom: 1rem; z-index: 232; width: min(440px, calc(100vw - 1.5rem)); background: var(--surface1); border: 1px solid var(--border2); border-radius: 18px; box-shadow: 0 14px 44px rgba(0,0,0,0.55); display: none; overflow: hidden; }
  body.par-mode .par-slip, body.par-legs .par-slip { display: block; }
  .par-head { display: flex; align-items: center; gap: 0.6rem; padding: 0.62rem 0.7rem 0.62rem 0.85rem; cursor: pointer; }
  .par-mode-btn { flex-shrink: 0; display: inline-flex; align-items: center; justify-content: center; width: 26px; height: 26px; border-radius: 999px; border: 1px solid var(--border2); background: var(--surface0); color: var(--dim); cursor: pointer; padding: 0; transition: background 0.14s, color 0.14s, border-color 0.14s; }
  .par-mode-btn svg { width: 14px; height: 14px; }
  .par-mode-btn.on { background: var(--accent); border-color: var(--accent); color: #04210f; }
  body.par-legs:not(.par-mode) .par-mode-btn { color: var(--accent); border-color: color-mix(in srgb, var(--accent) 55%, transparent); }
  .par-head-n { font-family: var(--font-d); font-size: 0.83rem; font-weight: 700; color: var(--text-strong); }
  .par-head-n span { color: var(--dim); font-weight: 600; }
  .par-head-od { margin-left: auto; font-family: var(--font-d); font-size: 1.12rem; font-weight: 700; color: var(--accent); }
  .par-head-od.par-none { color: var(--dim); font-size: 0.78rem; font-weight: 600; font-family: var(--font-b); }
  .par-x { background: none; border: none; color: var(--dim); font-size: 1.25rem; line-height: 1; padding: 0 0.15rem; cursor: pointer; }
  .par-x:hover { color: var(--text); }
  .par-caret { color: var(--dim); transition: transform 0.18s ease; width: 14px; height: 14px; }
  .par-slip.open .par-caret { transform: rotate(180deg); }
  .par-body { display: none; border-top: 1px solid var(--border); padding: 0.6rem 0.85rem 0.8rem; max-height: min(58vh, 460px); overflow-y: auto; -webkit-overflow-scrolling: touch; }
  .par-slip.open .par-body { display: block; }
  .par-leg { display: flex; align-items: center; gap: 0.5rem; padding: 0.36rem 0; border-bottom: 1px solid var(--border); font-size: 0.766rem; }
  .par-leg:last-of-type { border-bottom: none; }
  .par-leg-nm { font-weight: 700; color: var(--text); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .par-sp { font-family: var(--font-m); font-size: 0.6rem; font-weight: 700; letter-spacing: 0.06em; color: var(--dim); background: var(--surface0); border: 1px solid var(--border2); border-radius: 4px; padding: 0.05rem 0.26rem; margin-right: 0.35rem; }
  .par-leg-sel { color: var(--dim); font-size: 0.692rem; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; flex: 1 1 0; min-width: 0; }
  .par-leg-od { font-family: var(--font-d); font-weight: 700; color: var(--muted); margin-left: auto; }
  .par-leg-x { background: none; border: none; color: var(--dim); cursor: pointer; font-size: 1rem; line-height: 1; padding: 0 0.1rem; }
  .par-leg-x:hover { color: var(--bad); }
  .par-empty { color: var(--dim); font-size: 0.766rem; text-align: center; padding: 0.8rem 0.4rem; line-height: 1.5; }
  .par-lbl2 { font-family: var(--font-d); font-size: 0.642rem; font-weight: 700; letter-spacing: 0.12em; text-transform: uppercase; color: var(--dim); margin: 0.75rem 0 0.35rem; }
  .par-chips { display: flex; flex-wrap: wrap; gap: 0.32rem; }
  .par-chip { background: var(--surface0); border: 1px solid var(--border2); color: var(--muted); font-family: var(--font-b); font-size: 0.723rem; font-weight: 700; padding: 0.26rem 0.6rem; border-radius: 999px; cursor: pointer; transition: background 0.12s, color 0.12s, border-color 0.12s; }
  .par-chip:hover { color: var(--text); border-color: var(--dim); }
  .par-chip.on { background: rgba(51,208,124,0.14); border-color: var(--accent); color: var(--accent); }
  .par-chip input { width: 2.6rem; background: none; border: none; color: inherit; font: inherit; text-align: right; outline: none; padding: 0; -moz-appearance: textfield; }
  .par-chip input::-webkit-outer-spin-button, .par-chip input::-webkit-inner-spin-button { -webkit-appearance: none; margin: 0; }
  .par-nums { display: grid; grid-template-columns: 1fr 1fr; gap: 0.4rem; margin-top: 0.7rem; }
  .par-num { background: var(--surface0); border: 1px solid var(--border); border-radius: 10px; padding: 0.5rem 0.55rem; }
  .par-num b { display: block; font-family: var(--font-d); font-size: 1.22rem; font-weight: 700; color: var(--text-strong); line-height: 1.1; }
  .par-num.acc b { color: var(--accent); }
  .par-num span { display: block; font-size: 0.642rem; color: var(--dim); letter-spacing: 0.05em; text-transform: uppercase; margin-top: 0.2rem; }
  .par-note { font-size: 0.692rem; color: var(--dim); line-height: 1.5; margin-top: 0.55rem; }
  .par-note b { color: var(--muted); }
  .par-warn { color: var(--ok); }
  .par-ev { display: flex; align-items: center; gap: 0.45rem; margin-top: 0.6rem; font-size: 0.723rem; color: var(--dim); flex-wrap: wrap; }
  .par-ev input { width: 5.2rem; background: var(--surface0); border: 1px solid var(--border2); border-radius: 8px; color: var(--text); font-family: var(--font-d); font-size: 0.8rem; font-weight: 700; padding: 0.3rem 0.45rem; outline: none; }
  .par-ev input:focus { border-color: var(--accent); }
  .par-ev-out { font-family: var(--font-d); font-weight: 700; }
  .par-ev-out.good { color: var(--good); }
  .par-ev-out.bad { color: var(--bad); }
  .par-legs-hd { display: flex; align-items: center; justify-content: space-between; gap: 0.5rem; margin-bottom: 0.1rem; }
  .par-legs-hd .par-lbl2 { margin: 0; }
  .par-clear { display: inline-flex; align-items: center; gap: 0.25rem; background: none; border: 1px solid transparent; border-radius: 999px; color: var(--bad); font-family: var(--font-b); font-size: 0.667rem; font-weight: 700; letter-spacing: 0.04em; text-transform: uppercase; cursor: pointer; padding: 0.14rem 0.45rem; transition: background 0.14s, border-color 0.14s; }
  .par-clear:hover { background: color-mix(in srgb, var(--bad) 13%, transparent); border-color: color-mix(in srgb, var(--bad) 45%, transparent); }
  .par-clear svg { width: 11px; height: 11px; }
  .par-add { display: inline-flex; align-items: center; gap: 0.4rem; background: var(--surface1); border: 1px solid var(--border2); color: var(--muted); font-family: var(--font-b); font-size: 0.754rem; font-weight: 700; padding: 0.38rem 0.8rem; border-radius: 999px; cursor: pointer; transition: background 0.12s, color 0.12s, border-color 0.12s; }
  .par-add:hover { color: var(--text); border-color: var(--dim); }
  .par-add.on { background: rgba(51,208,124,0.14); border-color: var(--accent); color: var(--accent); }
  @media (max-width: 600px) {
    body.par-mode div[data-leg] { padding-left: 1.75rem; }
    body.par-mode [data-leg]::after { left: 0.4rem; width: 15px; height: 15px; }
    .par-slip { bottom: calc(var(--nav-bottom) + var(--nav-h) + 0.5rem); left: var(--nav-side); right: var(--nav-side); transform: none; width: auto; }
    .par-fab { bottom: calc(var(--nav-bottom) + var(--nav-h) + 0.6rem); right: var(--nav-side); }
    .par-body { max-height: 46vh; }
    .par-nums { grid-template-columns: 1fr 1fr; }
  }
  .par-copy { display: block; width: 100%; margin: 0.55rem 0 0.2rem; padding: 0.42rem; border-radius: 8px; cursor: pointer; font: 600 0.74rem inherit; background: transparent; color: var(--muted); border: 1px dashed var(--border2); }
  .par-copy:hover { color: var(--accent); border-color: var(--accent); }
  .par-outs { display: flex; gap: 0.4rem; }
  .par-outs .par-copy { flex: 1; text-align: center; text-decoration: none; }
  .par-gambly { display: inline-flex !important; align-items: center; justify-content: center; gap: 0.35rem; }
  .par-gambly img { border-radius: 3px; }
`;
  if (!document.getElementById('par-css')) document.head.insertAdjacentHTML('beforeend', `<style id="par-css">${CSS}</style>`);

  function parInit() {
    if (!document.getElementById('par-slip')) document.body.insertAdjacentHTML('beforeend', MARKUP);
    parLoad();
    document.body.classList.toggle('par-mode', PARLAY.on);
    // Capture phase: the click has to die before it reaches the row's own
    // onclick, which would open a card on top of the board.
    document.addEventListener('click', (e) => {
      if (!PARLAY.on) return;
      const el = e.target.closest?.('[data-leg]');
      if (!el) return;
      e.preventDefault(); e.stopPropagation();
      let leg; try { leg = JSON.parse(el.dataset.leg); } catch (err) { return; }
      if (leg && leg.k && leg.p > 0) parToggleLeg(leg);
    }, true);
    // Boards re-render on every filter, search and tab change, so rather than
    // teach each one to repaint, watch the tree they all write into.
    let raf = 0;
    new MutationObserver(() => {
      if (raf) return;
      raf = requestAnimationFrame(() => { raf = 0; parPaint(); });
    }).observe(document.querySelector('.wrap') || document.body, { childList: true, subtree: true });
    // another tab changed the slip: follow it
    window.addEventListener('storage', (e) => { if (e.key === PAR_KEY) { parLoad(); parRender(); parPaint(); } });
    parRender(); parPaint();
  }

  window.RonParlay = { provide, price: parPrice, rho: { mlb: sgpRhoMLB, nfl: sgpRhoNFL, nhl: sgpRhoNHL }, goalGroupMult, stackMult };
  Object.assign(window, {
    PARLAY, PAR_SPORT, parLeg, parAttr, parGame, parSideGet, parSideSet, parSideLeg, parSideTag, parSideRow, parSideLine, parSidePrice, parSideToggleHtml, setParSide, parEsc, parDecAm, parAmDec, parSave, parPrice,
    parMode, parToggleOpen, parToggleLeg, parRemove, parClear, parSetBoost, parCustomBoost, parBook,
    parPaint, parRender, parRenderEv, parCopyTracker,
    // older names the apps' own tools still call
    sgpRhoMLB, goalGroupMult, stackMult,
  });
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', parInit);
  else parInit();
})();
