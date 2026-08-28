# Picks research harness

Backtesting ground for the NFL **Picks** tool (anytime-TD model). This is
research, not production: nothing here runs in CI, and `nfl/data.json` is not
touched. If a model graduates, its feature computation gets ported into
`scripts/build-nfl.js` so it can run in the daily workflow.

Python (pandas + numpy) rather than the repo's Node, because iteration speed on
a backtest matters more than language consistency, and most of what gets tried
here will be thrown away.

## Run

```sh
python3 research/fetch_data.py      # ~360MB cached to the scratchpad, once
python3 research/build_dataset.py   # -> research/dataset.parquet
python3 research/backtest.py        # walk-forward model ladder
```

## What it does

`build_dataset.py` makes one row per (season, week, player, game) for RB/WR/TE/FB
with at least one offensive snap, 2016–2025. Target `scored` = at least one
offensive (rush or rec) TD. 58,858 player-games, 17.3% base rate.

Every feature uses games **strictly before** the row's week, shrunk toward a
backward-looking prior so early weeks aren't noise. The negative control in
`backtest.py` (shuffle the target within season) must return AUC ≈ 0.50.

`backtest.py` fits on all prior seasons and predicts each season cold, as a
ladder — each feature has to beat the simpler model to justify itself.

## Two traps worth remembering

**The id crosswalk.** `snap_counts` keys on `pfr_player_id`, pbp on GSIS ids.
The obvious bridge, `weekly_rosters`, has a null `pfr_id` 36% of the time, and
the players it misses skew hard to low snap share — exactly the low-TD-probability
rows. Using it silently dropped 13% of the pool and inflated the base rate from
17.3% to 18.7%. Use `players.csv` (~0.2% miss).

**Closing lines.** `spread_line` / `total_line` off pbp are closing numbers. A
Thursday pick wouldn't have Sunday's close, so `implied_total` carries a mild
lookahead. Not fixed in stage 1.
