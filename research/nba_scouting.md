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

## Round two (2026-09-28): minutes, ladders, DD/TD, game share, Kalshi

**Minutes** (`nba_minutes.py`, walk-forward 2020-21+):

| Projection | MAE | RMSE |
|---|---|---|
| last-5 average | 5.20 | 6.88 |
| model, before lineups post | 4.99 | 6.48 |
| **model + starting tonight** | **4.70** | **6.08** |

- The biggest levers are starting tonight (+8.6 min) against the share of his last 10 he started (−5.6), and NEW absences only (rotation players out who played within 3 team games). Long absences were absorbed long ago.
- Starters lose 0.13 min per point of spread (blowouts). The residual SD is about 5.2 min at every level.

**Threes** (`nba_threes.py`):
- Model: Poisson on minutes × rate, mixed over minutes N(proj, 5.2), plus an NB layer with alpha 0.1, the same every season. It beats his last-20 hit rate on every rung (3+: 0.357 vs 0.375).
- The opponent's threes allowed carries weight 0.79. The team's implied total adds nothing.

**Points** (`nba_points.py`):
- The same mean model. The NB (alpha 0.1) and normal (variance 3.2 × mean) shapes tie.
- Vacated usage adds nothing once minutes carry it.
- It beats his last-20 hit rate at every threshold, but its level is low for stars (see Kalshi below).

**Double/triple-double** (`nba_ddtd.py`):
- Given minutes, pts/reb/ast are nearly independent: residual correlations pts-reb +.07, pts-ast +.01, reb-ast +.07. Their raw correlations (.33/.40/.16) are almost all minutes.
- Pricing: each stat as an NB at the 10 line (alpha chosen on that line), exact combination, mixed over minutes, plus a shared "night" factor, Gamma variance 0.02–0.04 (pace, OT).
- Log loss: DD 0.1900 vs 0.2027 for his last-40; TD 0.01945 vs 0.02134.
- The top runs light: the 2,000 likeliest DDs were priced at 63% and hit 71%, because elite rebounders are steadier than modelled. Next: a calibration layer.

**Game share** (`nba_gameshare.py`):
- Across players the game is 0.2–0.4% of the price spread; night to night for one player it is 2–3%, while minutes are about 7× that.
- The NBA is the LEAST environmental sport measured (MLB 9%, NFL 4%, NHL 3%).
- The opponent's allowance of a stat moves a price about 4–5% per SD. The team total adds nothing because the spread already works through minutes.

**vs Kalshi, 2025-26 regular season** (`nba_threes_kalshi.py`; pre-game hourly candle mid, two-sided books):

| | Threes (6,666 markets) | Points (5,255 markets) |
|---|---|---|
| log loss, ours / Kalshi mid | **0.5108** / 0.5168 | 0.5310 / **0.5206** |
| outcome ~ logit(Kalshi) + logit(ours) | Kalshi 0.37 (z 5.3), **ours 0.70 (z 9.8)** | **Kalshi 0.72 (z 10.8)**, ours 0.32 (z 4.8) |
| average spread | 8.4¢ | 5.5¢ |
| take the ask, edge > 0 | −5.7% ± 2.7 | −4.0% ± 2.6 |
| **rest at the mid** (maker fee, assumes a fill), edge > 5% | **+9.5% ± 3.2** | +4.2% ± 3.2 |
| rest at the mid, rungs 1–4 only, edge > 5% | **+11.5% ± 3.1** | — |

- **Threes: we are sharper than Kalshi**, mostly at 1+ (0.464 vs 0.485). At 5+ we run high (16.2% priced, 12.6% hit, Kalshi 13.9%).
  - The edge does not survive crossing the spread. It shows up only as a maker.
  - The mid rows assume every resting order fills. Real fills are adversely selected (late scratches, minutes news), so the true number is lower. Measure it live, small.
- **Points: Kalshi is sharper.** Our level is low for the players Kalshi lists: 38.5% priced vs 40.6% hit, worst at 15+ (45.7% vs 51.5%). The shrinkage toward a position rate costs stars. Fix: less shrinkage for high-usage players, or a per-player level term.
