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
