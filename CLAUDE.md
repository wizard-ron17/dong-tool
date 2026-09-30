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

Shared by every app, loaded in `<head>`:
- `odds.js`: `Odds.am/pct/inline/both` (the only way to print a price) and `RonTracker` (the parlay slip's Copy for tracker).
- `sgp.js`: the same-game parlay copula.
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

**Editing the big pages.**
- **Grep the stylesheet, not just the markup, before choosing a class or function prefix.** nfl/index.html carries MLB's dead-but-live `.pk-*` CSS, and NBA's birthdays had to be `bday*` because `bd*` was taken.
- **Copy shared chrome verbatim from an existing app.** That means nav icons, the topbar, the parlay slip and the schedule row. Never redraw them; this was done wrong twice.
- `.wrap` is `z-index: 1`. An overlay inside it paints under a body-level backdrop, so re-parent it to `<body>`.
- Colour: a position, type or tag never gets a hue from the good/bad ramp (green/amber/red). That ramp means quality.
- Prices print through `Odds.*` only: American odds with the % beside it, no user setting.
- Schedule rows follow one design across sports: graded top pick, 2 columns on desktop, pop-up game card with Picks/Matchup/Lines/Game.

**Porting a tool or sport.**
- A research-vs-build parity replay.
- Price off current rosters.
- Hit-test overlays.
- Grep prefixes.
- CSS rule count equals what the browser parsed (`npm run check`).
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
