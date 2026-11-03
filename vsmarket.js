// Ours vs the market, per tool: each market a tool prices, scored against the median of every book's closing price
// (log loss, each player's main line; ~/smartstake-data/study/cv grade_all.sh, re-graded weekly). One table, read by
// the Tools menu and each board's freshness line (chrome.js, loaded on first use) and the Models page's "By tool" grid.
// Update AS_OF / GAMES / TOOLS with each re-grade. verdict: us (ours sharper) | even (within a hair) | mkt (the close
// sharper) | none (not graded against closes yet). A tool's chip sums its markets.
(function () {
  if (window.RonVs) return;
  const AS_OF = 'Nov 3', SINCE = 'Oct 28';
  const GAMES = { nhl: 47, nfl: 13, nba: 51 };
  // sport -> tool (the nav key in RonChrome.mount's tools) -> [[market, verdict, ours vs the close]]
  const TOOLS = {
    nhl: {
      picks: [['Anytime goal', 'us', '.4034 vs .4052'], ['First and last goal', 'even', 'ours ahead by a hair']],
      points: [['Power-play points', 'us', '.4704 vs .4737'], ['Points', 'even', '.6411 vs .6387'], ['Assists', 'mkt', '.5770 vs .5707']],
      shots: [['Shots on goal', 'mkt', '.6879 vs .6815, our overs run low']],
      blocks: [['Blocked shots', 'mkt', '.6827 vs .6781']],
      saves: [['Saves', 'none', 'too few closing lines yet']],
      allowed: [['Goals allowed', 'none', 'too few closing lines yet']],
      hits: [['Hits', 'none', 'no closing lines in the feed']],
    },
    nfl: {
      picks: [['Anytime TD', 'us', '.5285 vs .5467'], ['First TD', 'us', '.1692 vs .1720'], ['Last TD', 'even', '.1721 vs .1718']],
      yards: [['Receiving yards', 'mkt', '.7140 vs .6939'], ['Rushing yards', 'mkt', '.7312 vs .6902'], ['Rush + rec yards', 'mkt', '.7185 vs .6932']],
      receptions: [['Receptions', 'mkt', '.6948 vs .6782, our overs run low']],
      kickers: [['Field goals and PATs', 'none', 'too few closing lines yet']],
      completions: [['Completions', 'none', 'too few closing lines yet']],
      interceptions: [['Interceptions', 'none', 'too few closing lines yet']],
    },
    nba: {
      threes: [['Made threes', 'mkt', '.6808 vs .6731 (ours beat Kalshi\'s mid last season)']],
      points: [['Points', 'mkt', '.7134 vs .6883'], ['Rebounds', 'mkt', '.7001 vs .6823'], ['Assists', 'mkt', '.6868 vs .6764'], ['PRA', 'mkt', '.7256 vs .6930']],
      first: [['First basket', 'mkt', '.3279 vs .3230']],
      stocks: [['Steals', 'mkt', '.6617 vs .6530'], ['Blocks', 'mkt', '.5789 vs .5750'], ['Steals + blocks', 'mkt', '.7039 vs .6913']],
      doubles: [['Double-double', 'mkt', '.3825 vs .3759'], ['Triple-double', 'mkt', '.1616 vs .1364']],
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
  .vs-us { color: var(--green, #33d07c); background: color-mix(in srgb, var(--green, #33d07c) 14%, transparent); border-color: color-mix(in srgb, var(--green, #33d07c) 35%, transparent); }
  .vs-mix, .vs-even { color: var(--gold, #e8b64c); background: color-mix(in srgb, var(--gold, #e8b64c) 14%, transparent); border-color: color-mix(in srgb, var(--gold, #e8b64c) 35%, transparent); }
  .vs-mkt { color: var(--bad, var(--red, #ff6b6b)); background: color-mix(in srgb, var(--bad, var(--red, #ff6b6b)) 12%, transparent); border-color: color-mix(in srgb, var(--bad, var(--red, #ff6b6b)) 32%, transparent); }
  .vs-none { color: var(--muted, #8a94a6); background: color-mix(in srgb, var(--muted, #8a94a6) 10%, transparent); border-color: color-mix(in srgb, var(--muted, #8a94a6) 25%, transparent); }`;
  if (!document.getElementById('vs-css')) { const s = document.createElement('style'); s.id = 'vs-css'; s.textContent = CSS; document.head.appendChild(s); }

  window.RonVs = { AS_OF, SINCE, GAMES, TOOLS, NAMES, WORD, summary, chip };
})();
