# NBA: data and markets scouting (2026-09-28)

Preseason opens 10/03 and the regular season 10/20. Checked live on 2026-09-28.

## Data

**Official (nba.com): closed to scripts.**
- `cdn.nba.com` (schedule, live box scores, play-by-play) returns Akamai "Access Denied" to curl, even with browser headers.
- `stats.nba.com` hangs (it is known to tarpit non-browser and cloud-IP clients).
- Both are deliberate blocks. Don't work around them. They would also be unreliable from a GitHub Actions build.

**ESPN: open, deep, and the same family as our NFL/NHL feeds.**
- Scoreboard: `https://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard?dates=YYYYMMDD`
- Game: `.../nba/summary?event={id}` returns:
  - box score: MIN, PTS, FG, 3PT, FT, REB, AST, TO, STL, BLK, OREB, DREB, PF, +/-, with starter / didNotPlay flags
  - every play, with shot coordinates and shot type
  - injuries, win probability, odds
- Odds: `https://sports.core.api.espn.com/v2/sports/basketball/leagues/nba/events/{id}/competitions/{id}/odds` gives the spread and total, so a team implied total (as on the NFL board).

| Season sampled | Box score | Shots with coordinates | Game spread/total |
|---|---|---|---|
| 2008 | yes | yes | no |
| 2015 | yes | yes | yes (5Dimes) |
| 2020 | yes | yes | yes (CG Technology) |
| 2025 | yes | yes | yes (ESPN BET) |

## Markets: Kalshi

Last season's per-game markets are archived at `/historical/markets`. Volume_fp over up to 10,000 of each series' markets (Feb–Jun 2026), against KXMLBHR on the same measure:

| Series | Market | Volume | Per market |
|---|---|---|---|
| KXNBAGAME | game winner | 11.7B | 4.0M |
| KXNBASPREAD | spread | 1.39B | 139k |
| KXNBATOTAL | total | 1.25B | 125k |
| KXNBAPTS | player points ladder | 83M | 8.3k |
| KXNBA3PT | player threes | 19M | 1.9k |
| KXNBAREB | player rebounds | 14M | 1.4k |
| KXNBAAST | player assists | 11M | 1.1k |
| KXNBA2D | double-double | 10M | 2.0k |
| KXNBA3D | triple-double | 8.3M | 7.1k |
| KXNBASTL | steals | 1.8M | — |
| KXMLBHR (reference) | MLB home run | 44M | 4.4k |

Also listed: points leader, PRA / PA / PR / RA combos, H2H points, blocks, stocks, free throws, and "race to" points.

## Shape of a model

This is our NHL/NFL count machinery, not a new kind of model:
- **Minutes × per-minute rate** is the core, as ice time is for NHL shots and snap share for NFL TDs. Minutes are the part that moves: rest, injuries around him, and blowouts (spread → garbage time).
- **Counts:** Poisson / negative binomial ladders, as for NHL shots, points and assists.
- **Game environment:** the implied team total and pace carry far more weight than in the NFL (every possession is a scoring chance). Test it with the player-vs-game-share measure (MLB 9%, NFL 4%, NHL 3%).
- **SGP:** usage is the textbook zero-sum. A teammate's points vs his points, and assists vs a teammate's made shots, is exactly the "one dude eating" question Ron asked, measurable with research/sgp_core.py.

## Open questions for the first research pass
1. Which is the "dong": the made three (threes ladder), or a points threshold? Test which one has the most model signal beyond the market.
2. How well do minutes project from the last few games, the depth chart and injuries? That is the NBA's snap share.
3. How much of the price spread is the game (team total, pace, opponent defense by position)?

## First results (2026-09-28): 10,276 games, 2018-19 → 2025-26

The cache comes from `nba_fetch.py`, at `research/.cache/nba/`. The reduced per-game JSON is gitignored.

**Poisson or NB** (`nba_dispersion.py`): dispersion index, where 1.0 = Poisson.
- Pre-game (minutes unknown) almost everything is over-dispersed: pts 3.19, FGM 1.29, 3PM 1.20, REB 1.35, AST 1.27, FTM 2.04.
- Given the minutes he played, most of it collapses: FGM 0.95, 3PM 1.06, REB 1.07, AST 1.09, STL/BLK/TO about 1.05.
  - So the variance is minutes (the role); the per-minute rate is close to Poisson. Model minutes first, then the rate. That's the NHL ice-time / NFL snap-share lesson again.
- Points stay at 2.27 even given minutes, because scoring comes in 1s, 2s and 3s. Price points from shots and free throws, not as a single count.
- FTM stays at 1.87: free throws come in trips and bunches. That, plus the two-sided skill (drawing vs committing fouls, with referee crews in the umpire's role), makes free throws **the walks of the NBA**.
- Made threes given attempts are pure binomial shooting luck (variance ratio 0.995).

**Ladders.** Starters record a double-double in 16.6% of games; triple-doubles happen in 0.48% of player-games (first season's rate).

**First basket** (`nba_firstbasket.py`, `nba_firstbasket2.py`, `nba_teamfirst.py`):
- The team that wins the tip scores first 64.8% of the time.
- 24% of first baskets are threes. In 7.8% of games a free throw comes before any field goal, so check whether a market settles on first basket or first points.
- A starter scored the first basket in every game.
- Centres score first 13.1% a start, forwards 9.8%, guards 9.0%. That is the opposite of shot volume, so "his share of the starters' shots" lost to the tip alone.
- A team "fast start" is not a trait: split-half r = 0.15, and it adds nothing beyond the tip. Scoring first is zero-sum, so a team's rate and its opponents' allowed rate are one number.
- **The line is real.** Home favoured by ~12: the tip model says 51.3%, actual 57.9%. That's about half a point of probability per point of spread, beyond the tip.

Walk-forward results over 7,200 games (2020-21 → 2025-26), each priced only from games before it:

| Model | Log loss |
|---|---|
| one in ten | 0.32499 |
| coin-flip team × position | 0.32410 |
| jumpers' tip records × position | 0.32353 |
| jumpers' tip records × his own first-basket record | 0.32256 |
| **tip records + the line × his own record** | **0.32229** |
| ceiling: tip winner known × his own record | 0.31891 |

- Calibration is good: priced 15.2% → 14.3% actual, priced 8.9% → 9.3%. The long end runs slightly under (6.0% priced → 7.4% actual).
- Each game's favourite is priced at 16.0% and scores first 15.8% (about +530 fair).
- **No market benchmark yet.** Kalshi lists KXNBAFIRSTBASKET but has never opened a market (nothing open, settled or archived). Snapshot it live once it lists.
