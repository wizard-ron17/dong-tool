# Soccer: data and markets scouting (2026-10-06)

Ron asked whether soccer could become a tool, MLS first since the site already
covers the other four US leagues. Everything below was checked live against the
endpoints on 2026-10-06. Nothing is built yet.

**Status: pinned until the MLS offseason.** The 2026 regular season runs to about
Nov 7 (it was pushed back by the World Cup break), then the playoffs. The plan
is to run the backtest December to February and launch `/mls` for the 2027
opener (late February). `soccer_probe.py` re-runs the checks below.

## Sources

**ESPN site API** (free, no key; the same family as our NBA/NFL feeds)

- Scoreboard: `https://site.api.espn.com/apis/site/v2/sports/soccer/{league}/scoreboard?dates=YYYYMMDD`
  - League codes: `usa.1` (MLS), `eng.1`, `esp.1`, `ger.1`, `ita.1`, `fra.1`, `mex.1`.
  - Send `--compressed`. A date RANGE returned no events; single days work.
- Game: `.../summary?event={id}` carries:
  - `rosters`: each player's starter flag, subbedIn/subbedOut, formationPlace, and stats (shots, shots on target, goals, assists, fouls, cards, saves, goals conceded). Present for MLS back to at least 2016.
  - `keyEvents`: goals, cards and subs with the minute, which lets us rebuild minutes played.
  - The team box: possession, passes, crosses, long balls, corners, tackles.
  - `odds`: moneyline home/away, the draw, and the total. DraftKings now; Bet365/Betfair/Caesars around 2022; empty in 2016.
- Top-5 Europe and Liga MX have the same player stats (14 per player).

**American Soccer Analysis** (free MLS API, back to 2013): the best input we have for pricing.

- Player-games: `https://app.americansocceranalysis.com/api/v1/mls/players/xgoals?season_name=YYYY&split_by_games=true`
  - Each row: minutes, general position, shots, shots on target, goals, xG, xplace, key passes, primary assists, xA, points added.
  - The cap is 10,000 rows per call, so page it. The `game_id=` filter returned a 500.
- Games: `.../mls/games?season_name=YYYY` (540 in 2025).
- ASA ids are not ESPN ids, so match players by name and team.

**football-data.co.uk** (free CSVs; follow the 302 to the bare domain)

- `https://football-data.co.uk/new/USA.csv`: MLS 2012–2026, 6,220 games.
  - Pinnacle CLOSING 1X2 on 5,800 of them, plus the market max and average, Betfair Exchange and Bet365.
  - No totals.
- Europe, e.g. `https://football-data.co.uk/mmz4281/2526/E0.csv` (132 columns): Pinnacle and Betfair closing 1X2, over/under 2.5, Asian handicap, and team shots, shots on target and corners.

**Understat** (Europe only): `https://understat.com/getLeagueData/EPL/2025`

- Send `X-Requested-With: XMLHttpRequest`.
- Returns the top-5 leagues and the Russian league, with players' xG, xA, npxG, shots and minutes.

**Unusable**

- FBref sits behind a Cloudflare challenge (403). Don't bypass it.
- The MLS official stats API and FotMob's API both returned 404.

## Base rates (ASA 2025, player-games with 60+ minutes)

| Group | n | Anytime goal | 1+ SOT | 2+ shots | Assist | Mean xG |
|---|---|---|---|---|---|---|
| All | 6,849 | .102 | .249 | .254 | .074 | .126 |
| Attackers (ST, W, AM) | 2,109 | .240 | .526 | .552 | .124 | .299 |
| Strikers | 829 | .310 | .595 | .631 | .106 | .420 |

For comparison, NHL anytime goal is .149 and NFL anytime TD .165.

Attackers' xG per 90 (600+ minutes in the sample): bottom 10% .12, median .27, top 10% .52. The player drives the price far more than the game, as in hockey, which is where our models have done best.

## Markets

Kalshi volume is summed over each series' latest 1,000 or fewer markets, for August to October 2026.

**Game lines carry the money:**

| Series | Volume |
|---|---|
| LaLiga game | 281M |
| EPL game | 200M |
| MLS game | 193M |
| UCL game | 100M |
| EPL total | 47M |
| MLS total | 39M |
| MLS spread | 12M |
| EPL both teams to score | 7M |
| MLS both teams to score | 5.7M |

**Player props are thin:**

- LaLiga goalscorer 2.6M, EPL goalscorer 2.0M, UCL goalscorer 1.4M, EPL first goalscorer 0.6M, each over about 3 weeks.
- MLB HR, by comparison, is 22.6M over 2 weeks.
- `KXMLSGOAL` and `KXMLSFIRSTGOAL` exist but had no markets listed.

The sportsbooks carry MLS and EPL anytime goalscorer, shots, shots on target and assists.

## Plan

1. **Anytime goalscorer, walk-forward on ASA 2013–2026.** Price each player as a Poisson on his xG per 90 × expected minutes × his team's goals implied by the Pinnacle 1X2 close (the NHL goals playbook), then isotonic calibration.
2. **Then shots on target, shots and assists**, off the same minutes model.
3. **Risks:**
   - Lineups come out about an hour before kickoff, and rotation and subs decide minutes.
   - Penalty takers need a flag.
   - Matching ASA ids to ESPN ids.
   - A sharp market, especially in the EPL.

## Compared with UFC and golf (see `ufc_golf_scouting.md`)

Soccer is the only one of the three with:

- free per-game xG,
- a free sharp closing line to test against (Pinnacle since 2012),
- and a board shape that matches our tools: many players per match day, priced props, and the parlay slip.

UFC and golf have bigger Kalshi outright markets, but they would each be a new model from scratch.
