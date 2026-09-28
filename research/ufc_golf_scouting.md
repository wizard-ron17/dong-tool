# UFC + golf: data and markets scouting (2026-09-27)

Ron asked whether UFC or PGA could become a tool. Everything below was checked
live against the endpoints on 2026-09-27. Nothing is built yet. Golf is the
first pick once the full PGA season is back (only the Fall Series is live now).
UFC runs every weekend.

## UFC

**Source: ESPN core API** (free, no key; the same family as our NFL/NHL feeds)

- Events by year: `https://sports.core.api.espn.com/v2/sports/mma/leagues/ufc/events?dates=YYYY&limit=200`
  - The event's `competitions` holds one competition per fight.
- Fight stats: `.../competitions/{id}/competitors/{athleteId}/statistics`, which carries:
  - knockdowns, total strikes and significant strikes (attempted and landed)
  - significant strikes by target (head/body/leg) and by position (distance/clinch/ground)
  - takedowns attempted/landed/slams, submission attempts, advances and reversals
- Result: `.../competitions/{id}/status`, with the method (KO/TKO, SUB, DEC), the round and the clock.
- Odds: `.../competitions/{id}/odds`. DraftKings moneyline and total rounds, with opening lines.
- Fighter: `https://sports.core.api.espn.com/v2/sports/mma/athletes/{id}`, with height, reach, weight, weight class, stance and DOB.

| Year | Events | Fight stats | Odds |
|---|---|---|---|
| 2008 | 20 | yes | no |
| 2012 | 31 | yes | no |
| 2016 | 41 | yes | no |
| 2021 | 57 | yes | yes |
| 2025 | 52 | yes | yes |

- **ufcstats.com** (the usual source) is now behind a JavaScript proof-of-work bot wall ("Checking your browser…"). Don't circumvent it. ESPN carries the same stats.

**Kalshi** (volume_fp summed over each series' latest ~1000 markets, open + settled; KXMLBHR = 4.5M on the same measure)

| Series | Market | Volume |
|---|---|---|
| KXUFCFIGHT | fight winner | 353M |
| KXUFCMOV | method of victory | 92M |
| KXUFCDISTANCE | goes the distance | 21M |
| KXUFCVICROUND | round of victory | 10M |
| KXUFCROUNDS | total rounds | 6M |
| KXUFCMOF | method of finish | 5.7M |

**Shape of a model**
- Winner lines are among the sharpest anywhere. The opening is the finish markets.
- Finish rate depends on weight class and scheduled rounds (3 vs 5), knockout power, durability (knocked down or finished before), and submission threat vs takedown defence.
- Sample: about 600 fights a year, 2021+ with closing lines.

## Golf (PGA Tour)

**Source: ESPN core API**
- Events by year: `https://sports.core.api.espn.com/v2/sports/golf/leagues/pga/events?dates=YYYY&limit=100`
- Per player: `.../competitors/{id}/linescores`, with each round's score and then all 18 holes (score, par, score type).
  - Each round also carries teeTime, startTee and groupNumber. Tee times appear from 2016, which gives the morning/afternoon wave for weather.
- Per player: `.../competitors/{id}/statistics`, with the event's drive distance, drive accuracy, GIR, putts per GIR, sand saves, eagles/birdies/pars/bogeys and earnings.
- Depth: about 49 events a year with fields of about 156, hole by hole from at least 2012.
- **No strokes-gained categories.** The PGA Tour's own GraphQL (orchestrator.pgatour.com) returns 503 without its key, and DataGolf is paid. **SG:Total we can build**: player round score vs that round's field average, adjusted for field strength. That is the backbone of most golf models.
- No odds on the ESPN event.

**Kalshi** (same measure)

| Series | Market | Volume |
|---|---|---|
| KXPGATOUR | tournament winner | 786M |
| KXPGAR1LEAD | round 1 leader | 75M |
| KXPGAR2LEAD | round 2 leader | 24M |
| KXPGAR3LEAD | round 3 leader | 14M |
| KXPGATOP20 | top 20 | 11.6M |
| KXPGAH2H | head-to-head | 10M |
| KXPGAROUNDSCORE | round score | 9M |
| KXPGATOP10 | top 10 | 7.7M |
| KXPGATOP5 | top 5 | 6.6M |
| KXPGAMAKECUT | make the cut | 2.5M |
| KXPGA3BALL | 3-ball | 2M |

**Shape of a model**
- Player skill = recency-weighted SG:Total, shrunk.
- Simulate the event: round scores with each player's variance, then the cut. Every market above falls out of one simulation.
- Environment: tee-time waves in wind, and course fit (length vs distance).

## Not covered yet
Ron's exchange-odds indexer covers neither sport. (The adapter search hit
`fourcx.ts` only because "propGames" contains "pga".)
