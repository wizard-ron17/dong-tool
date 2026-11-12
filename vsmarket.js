// Ours vs the market, per tool: each market a tool prices, scored against the median of every book's closing price
// (log loss, each player's main line; ~/smartstake-data/study/cv grade_all.sh). FINAL for now: SmartStake's closes ended
// 11/09, so this is 10/28-11/09. One table, read by
// the Tools menu and each board's freshness line (chrome.js, loaded on first use) and the Models page's "By tool" grid.
// Update AS_OF / GAMES / TOOLS with each re-grade. verdict: us (ours sharper) | even (within a hair) | mkt (the close
// sharper) | none (not graded against closes yet). A tool's chip sums its markets.
(function () {
  if (window.RonVs) return;
  const AS_OF = 'Nov 9', SINCE = 'Oct 28';
  const GAMES = { nhl: 104, nfl: 29, nba: 122 };
  // sport -> tool (the nav key in RonChrome.mount's tools) -> [[market, verdict, ours vs the close]]
  // even = within .001 of each other
  const TOOLS = {
    nhl: {
      picks: [['Anytime goal', 'even', '.4022 vs .4021, and the two blended beat both'], ['First goal', 'even', '.1231 vs .1231'], ['Last goal', 'us', '.1191 vs .1197']],
      points: [['Power-play points', 'mkt', '.4795 vs .4679, our overs run low'], ['Points', 'mkt', '.6483 vs .6441'], ['Assists', 'mkt', '.5924 vs .5867']],
      shots: [['Shots on goal', 'mkt', '.6841 vs .6808, our overs run low']],
      blocks: [['Blocked shots', 'mkt', '.6870 vs .6844']],
      saves: [['Saves', 'mkt', '.6915 vs .6888, 70 lines: a small sample']],
      allowed: [['Goals allowed', 'even', '.6843 vs .6834, 75 lines: a small sample']],
      hits: [['Hits', 'none', 'no closing lines in the feed']],
    },
    nfl: {
      picks: [['Anytime TD', 'mkt', '.4605 vs .4550'], ['First TD', 'mkt', '.1721 vs .1699'], ['Last TD', 'even', '.1737 vs .1739']],
      yards: [['Receiving yards', 'mkt', '.7002 vs .6937'], ['Rushing yards', 'mkt', '.7358 vs .6961'], ['Rush + rec yards', 'mkt', '.7250 vs .6926']],
      receptions: [['Receptions', 'mkt', '.6891 vs .6827, our overs run low']],
      kickers: [['Field goals', 'us', '.6929 vs .6974, 57 lines'], ['Kicking points', 'even', '.7041 vs .7040, 57 lines'], ['PATs', 'mkt', '.7110 vs .6954, 57 lines']],
      completions: [['Completions', 'mkt', '.7029 vs .6938, 57 lines']],
      interceptions: [['Interceptions', 'us', '.6819 vs .6881, 57 lines']],
    },
    nba: {
      threes: [['Made threes', 'mkt', '.6769 vs .6712 (ours beat Kalshi\'s mid last season)']],
      points: [['Points', 'mkt', '.7075 vs .6901'], ['Rebounds', 'mkt', '.6956 vs .6827'], ['Assists', 'mkt', '.6872 vs .6833'], ['PRA', 'mkt', '.7181 vs .6934']],
      first: [['First basket', 'mkt', '.3232 vs .3192']],
      stocks: [['Steals', 'mkt', '.6621 vs .6590'], ['Blocks', 'mkt', '.5958 vs .5930'], ['Steals + blocks', 'mkt', '.6915 vs .6879']],
      doubles: [['Double-double', 'mkt', '.3607 vs .3484'], ['Triple-double', 'mkt', '.1486 vs .1395']],
    },
  };
  // the tools' names as their menus show them (for the Models page)
  const NAMES = { nhl: { picks: 'Goals', points: 'Points', shots: 'Shots', blocks: 'Blocked Shots', saves: 'Saves', allowed: 'Goals Allowed', hits: 'Hits' },
    nfl: { picks: 'Tuds', yards: 'Yards', receptions: 'Receptions', kickers: 'Kickers', completions: 'Completions', interceptions: 'Interceptions' },
    nba: { threes: 'Threes', points: 'Points', first: 'First Basket', stocks: 'Steals & Blocks', doubles: 'Double & Triple-Doubles' } };
  const WORD = { us: 'Ours sharper', even: 'Even', mkt: 'Close sharper', none: 'Not graded' };
  const SUM = { us: ['us', 'Beats the close'], mix: ['mix', 'Mixed'], even: ['even', 'Even'], mkt: ['mkt', 'Close sharper'], none: ['none', 'Not graded'] };

  function summary(sport, nav) {
    const M = TOOLS[sport]?.[nav]; if (!M) return null;
    const v = new Set(M.map(m => m[1]));
    const k = v.has('us') && v.has('mkt') ? 'mix' : v.has('us') ? 'us' : v.has('mkt') ? 'mkt' : v.has('even') ? 'even' : 'none';
    const n = GAMES[sport];
    const tip = `${SUM[k][1]} ${k === 'mix' ? '(some markets ahead, some behind) ' : ''}vs the close, ${n ? `${n} games since ${SINCE}` : `as of ${AS_OF}`} (log loss, lower is better):\n` + M.map(([m, x, s]) => `${m}: ${WORD[x]} (${s})`).join('\n');
    return { k: SUM[k][0], label: SUM[k][1], tip, markets: M, games: n };
  }
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
  /** The chip: `menu` inside a Tools-menu item (no link, a button can't hold one), else a link to the Models page. */
  function chip(sport, nav, { menu = false } = {}) {
    const s = summary(sport, nav); if (!s) return '';
    return menu ? `<span class="nm-vs vs-${s.k}" title="${esc(s.tip)}">${s.label}</span>`
      : `<a class="ron-vs vs-${s.k}" href="/models/#bytool" title="${esc(s.tip)}">${s.label}</a>`;
  }

  const CSS = `
  .nm-vs, .ron-vs { display: inline-block; vertical-align: middle; font: 800 0.58rem/1 var(--font-b, system-ui, sans-serif); letter-spacing: 0.05em; text-transform: uppercase;
    padding: 0.2rem 0.38rem; border-radius: 5px; white-space: nowrap; text-decoration: none; border: 1px solid transparent; }
  .nm-vs { margin-left: 0.4rem; position: relative; top: -0.08rem; }
  .ron-vs { margin-left: 0.45rem; }
  @media (max-width: 700px) { .nav-menu-item .nm-vs { display: table; margin: 0.25rem 0 0; top: 0; white-space: normal; line-height: 1.15; } }
  .ron-vs:hover { text-decoration: none; filter: brightness(1.1); }
  .vs-us { color: var(--green, #33d07c); background: color-mix(in srgb, var(--green, #33d07c) 14%, var(--surface1, #18181a)); border-color: color-mix(in srgb, var(--green, #33d07c) 35%, transparent); }
  .vs-mix, .vs-even { color: var(--gold, #e8b64c); background: color-mix(in srgb, var(--gold, #e8b64c) 14%, var(--surface1, #18181a)); border-color: color-mix(in srgb, var(--gold, #e8b64c) 35%, transparent); }
  .vs-mkt { color: var(--bad, var(--red, #ff6b6b)); background: color-mix(in srgb, var(--bad, var(--red, #ff6b6b)) 12%, var(--surface1, #18181a)); border-color: color-mix(in srgb, var(--bad, var(--red, #ff6b6b)) 32%, transparent); }
  .vs-none { color: var(--muted, #8a94a6); background: color-mix(in srgb, var(--muted, #8a94a6) 10%, var(--surface1, #18181a)); border-color: color-mix(in srgb, var(--muted, #8a94a6) 25%, transparent); }`;
  if (!document.getElementById('vs-css')) { const s = document.createElement('style'); s.id = 'vs-css'; s.textContent = CSS; document.head.appendChild(s); }

  window.RonVs = { AS_OF, SINCE, GAMES, TOOLS, NAMES, WORD, summary, chip };
})();
