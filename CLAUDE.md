# Ron's Tools (dong-tool)

A free sports-betting data site at dong-tool.netlify.app: fair odds from our own
backtested models, next to the market. "Not picks, not a capper." Four apps plus a
landing page, all static HTML deployed by Netlify from `main`:

| Path | App | Page |
|---|---|---|
| `/` | sport picker | `index.html` |
| `/mlb` | Dong Tool | `mlb/index.html` (~12.6k lines) |
| `/nfl` | Tud Tool | `nfl/index.html` (~9.5k) |
| `/nhl` | Goal Tool | `nhl/index.html` (~6.5k) |
| `/nba` | Hoop Tool | `nba/index.html` (~2.5k) |

Shared by every app:
- `odds.js`: `Odds.am/pct/inline/both` (the only way to print a price) and `RonTracker` (the parlay slip's Copy for tracker).
- `sgp.js`: the same-game parlay copula.
- `parlay.js`: the parlay slip (state, pricing, markup, styles). Every sport's measured correlation rules live here, so a slip prices the same on every page. A page only tags rows with `parAttr({...})` and hands over its data with `RonParlay.provide(sport, {...})`. Every parlay board has an Over/Under (Yes/No for binary props) toggle, `parSideToggleHtml(tool, binary, rerender)`: rows go through `parSideRow`, legs through `parSideTag` / `parSideLeg`, and an under leg is keyed `|u`, which flips its correlations.
- `app.js`: `dataFetch(file)`, which reads `/<sport>/<file>` from raw GitHub, falls back to the deployed copy, and on localhost reads the local file first. It also keeps typing focus: when a board redraws its own search box mid-keystroke, focus and the cursor move to the new box (same id), so give every typed input an id and don't hand-roll a refocus.
- `chrome.js`: the shared chrome. It draws the main nav, tools menu, sport switcher, theme toggle and footer. Each app keeps empty placeholders (`#main-nav`, `#nav-tools-menu`, `footer.site-foot`) and calls `RonChrome.mount({ sport, season, credit, tools: [...] })`. The Tools menu is data in that call. A new sport is one line in `SPORTS`. Page extras on a theme flip go in `RonChrome.onTheme(fn)`. Its styles live there too (rules that were identical in all four apps; page-specific overrides stay in the page). An app's `switchNav` calls `RonChrome.show(nav)` for the panel, active states and tab title (derived from the tools menu when the app has none). Data age: each app calls `RonChrome.fresh(builtAt, { starts })` once its data loads; boards print `RonChrome.freshHtml()` (uiView does it for you), and a stale-data banner appears around game time when a build is over 4.5h old.
- `modal.js`: the modal stack manager. Every card and sheet is a body-level backdrop that closes on its own click. This file owns the scroll lock (held while any modal is open) and the keys: Escape closes only the top modal, and ← → step only the top one through its ‹ › buttons. New modals use `RonModal.open(id, { cls, nav, onClose })` / `RonModal.close(id)` (NBA's ladder card is the example). Never add another per-modal keydown or `body.style.overflow` toggle. The modal frame's styles (backdrop, ‹ ›, close) live there too.
- `ladder.js`: the ladder card (distribution chart, over/under bars, ladder of lines) for NFL counts and Yards, NHL and NBA: its styles, plus `RonLadder.chart / side / center / over`. Each app keeps its pmf, metrics and lines, and passes its drift as options (`trimTail`, `plus`, `even`).
- `board.js`: the board toolbar (Filters card and chips, Board/Results tabs, Table/Cards/Compact switch, search box): its styles, plus `uiFilters / uiChip / uiTabs / uiView / uiSearch / matchQ`. New boards build their toolbar from these. `.u-tabs` stays in each app's CSS, because it resets the app's own `.sub-tabs` box and must load after it.
- `slate.js`: the Schedule on every sport. Desktop is a split view: a rail of the day's games, and the picked game on the right. Phone is the list plus a pop-up. The game card leads with a box score, one row per priced player and a column per market, showing projection, even-money line and fair odds. Each cell is a parlay leg, and final games grade themselves. Each page supplies `*Rail(games)`, a panel `(gid) => html` and a box spec. `openGame` starts with `RonSlate.select(gid)`. It also holds the shared game-header styles (`.gm-hero`).
- `share.js`: share cards. A board registers its top rows with `RonShare.set(setFn, () => spec)` each render, and the toolbar's Share button (`uiView`, or `RonShare.button(key)`) draws the top 10 as an image with Copy / Save / Share / Copy as text. Views are Table (the price beside what drives it) and Cards; Compact is retired.
- `trend.js`: the League trend chart on NHL / NFL / NBA Stats tabs (`RonTrend.render(el, spec)`): a per-game rate with rolling averages, σ bands, MACD, zoom. Each page hands it a `series(team)`: NHL goals/game by day (from the schedule's scores), NFL TDs/game by week (tdRecap), NBA threes/game by day (`nba/league-days.json`, a row per regular-season final, written by build-nba). MLB's Stats chart is its own older copy and has not been moved onto this module.
- `welcome.js`: the About modal.

Builds live in `scripts/build-*.js` (GitHub Actions crons in `.github/workflows/`). Link previews live in `netlify/edge-functions/` (`embed.js` meta per route, `og.js` live board cards, `stats.js`). Research lives in `research/` (Python + a few `.mjs` parity replays).

## Rules

**Pushing.**
- A code push is a Netlify deploy and costs build minutes. Commit as work lands.
- Push when Ron says so, or on your own once there are **5+ unpushed commits** (`git log origin/main..main`).
- Below that, don't ask; just report "committed, N unpushed".
- Data-only commits (`{mlb,nfl,nhl,nba}/*.json`, `scripts/`, `research/`, `.github/`) don't deploy (netlify.toml `ignore`).

**Data files.**
- Never commit a locally built data file. Local builds time out or quietly produce worse data.
- Rebuild in CI (`gh workflow run build-<sport>.yml`, after asking), and `git checkout` any local data you built.
- Never blindly take `--theirs` on a data.json conflict.
- Pages read data through `dataFetch` from raw.githubusercontent.com. A new data file must be `<sport>/*.json` and go through `dataFetch`, or it goes stale, because deploys skip data commits.

**Verify before you say done.**
- `npm run check` (setup once: `npm install --prefix tools`). It runs static checks, then every app and key routes in Chromium at desktop and phone width: page errors, CSS rules the browser dropped, sideways scroll, empty renders.
- Flags: `--static` (1s), `--only nhl`, `--webkit` (iPhone crashes are WebKit memory kills; headless Chrome won't show them).
- Screenshots land in `tools/shots/`.

**Moving CSS into a module.** Remove a rule from an app only if the browser parses it identically. Never move a rule whose selector still has an override left in any app, or one that a later top-level rule overrides: module CSS loads before the page's `<style>`. Prove it with a computed-style diff against a worktree of HEAD (the recipe is in Claude's memory).

**Editing the big pages.**
- **Grep the stylesheet, not just the markup, before choosing a class or function prefix.** nfl/index.html carries MLB's dead-but-live `.pk-*` CSS, and NBA's birthdays had to be `bday*` because `bd*` was taken.
- **Shared chrome is a module, not a copy.** The nav, tools menu, sport switcher, theme toggle, footer (`chrome.js`) and parlay slip (`parlay.js`) are drawn once. Change them there, never per app. What's still copied per app (the header's brand block, the schedule row, the chrome's CSS) is copied verbatim from an existing app, never redrawn: the nav icons were redrawn wrong twice.
- `.wrap` is `z-index: 1`. An overlay inside it paints under a body-level backdrop, so re-parent it to `<body>`.
- Colour: a position, type or tag never gets a hue from the good/bad ramp (green/amber/red). That ramp means quality.
- Prices print through `Odds.*` only: American odds with the % beside it, no user setting.
- The Schedule is one design across sports (`slate.js`): a split view with a box score, and a graded top pick on every game.

**Porting a tool or sport.**
- A research-vs-build parity replay.
- Price off current rosters.
- Hit-test overlays.
- Grep prefixes.
- CSS rule count equals what the browser parsed, with no empty values (`npm run check`).
- CI builds only.
- Link previews: `embed.js` ROUTES and metaFor, `og.js` board, `scripts/make-<sport>-icons.sh`, manifest.

**Late news no feed carries** is hand-entered, and `npm run check` validates the shape:
- `nfl/qb-overrides.json`: the starting QB per team-week.
- `mlb/pitching-overrides.json`: openers, bulk arms and bullpen games per date.

**Network traps.**
- ESPN returns 403 to a custom User-Agent. Send none.
- Kalshi from Python needs an unverified SSL context plus a UA.
- nba.com blocks us, so NBA uses ESPN only.
- The NHL stats API caps pages at 100 rows / 10k, and sorts points-DESC by default.
- Season rollovers break builds on opening day (NHL `HIST` 9/29). Test a date change before it happens.

**Research.**
- Walk-forward only.
- Priors in research must match what the build computes.
- A feature that's a stable trait (split-half reliable) is the one most likely to add nothing over the market's implied total.
- Many things have been tested and found null. The list is in Claude's memory; check it before rebuilding an idea.

## Never
- Read secrets: `/Users/ron/exchange-odds/.env`, `keys/*.pem`, `~/Desktop/odds-viewer/keys.json` or `circa.key`. Trading keys never go in this public repo.
- `pkill` by app name (it killed Ron's real Chrome once). Kill only PIDs you started, and use an isolated `--user-data-dir`.
- Bypass bot walls (Cloudflare challenges, ufcstats).

## Related local repos
- `~/Desktop/odds-viewer`: Ron's Odds API screener and bet tracker (local only, no remote). It reads our fair prices from raw GitHub and imports slips via `RONBET:` lines. Keep API calls light.
- `/Users/ron/exchange-odds`: the exchange indexer and edge snapshots/grades (`data/edges/`).

Open work and dates are in `TODO.md`.
