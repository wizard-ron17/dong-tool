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

## Results so far

Pooled out-of-sample, 2017–2025:

| model | log loss | vs base | AUC |
|---|---|---|---|
| M0 base rate | 0.4601 | — | 0.494 |
| M1 position | 0.4492 | −2.37% | 0.599 |
| M2 + snap share | 0.4176 | −9.23% | 0.716 |
| M3 + implied total | 0.4141 | −9.99% | 0.723 |
| M4 + RZ touches | 0.4130 | −10.24% | 0.726 |
| M5 + defense/team env | 0.4130 | −10.23% | 0.726 |
| **M6 + last-3 snap share** | **0.4057** | **−11.82%** | **0.743** |

M6 calibration ECE 0.0062; top decile scores 43.8% against a 17.3% base
(2.54x), bottom decile 3.1% (0.18x). Negative control returns AUC 0.498.

### Three findings that should drive scope

**Snap share is ~87% of the signal.** Everything else in M4 combined is worth
about one percentage point of log loss.

**Stage 2 (defense + team environment) is a clean null.** Defense-allowed-by-
position, red-zone defense, defensive pace and team red-zone trips all land
within 0.03% of M4. The reason is reliability, not redundancy: split-half
correlation within a season for TDs allowed is +0.15 (RB), −0.06 (WR), −0.03
(TE), against +0.83 for player snap share. There is no stable quantity there
to predict with. And even a *reliable* orthogonal defensive metric — EPA/play
allowed, split-half +0.37, r = −0.007 with snap share — adds nothing, because
implied team total already prices the environment. Swapping Vegas out for
offensive and defensive EPA makes the model *worse*.

**Stage 3 won by measuring the dominant feature better, not by adding
features.** Last-3-game snap share is worth −1.8%, more than implied total,
red-zone touches and all of stage 2 put together, and it improves every single
season. In the fitted coefficients it displaces the season-to-date version
(+0.57 vs +0.15) — a season average is a stale measure of a role that changes
week to week.

The rule this implies: judge a candidate feature by its **orthogonality to snap
share** and its **own split-half reliability**, not by standalone strength.

## Two traps worth remembering

**The id crosswalk.** `snap_counts` keys on `pfr_player_id`, pbp on GSIS ids.
The obvious bridge, `weekly_rosters`, has a null `pfr_id` 36% of the time, and
the players it misses skew hard to low snap share — exactly the low-TD-probability
rows. Using it silently dropped 13% of the pool and inflated the base rate from
17.3% to 18.7%. Use `players.csv` (~0.2% miss).

**Closing lines.** `spread_line` / `total_line` off pbp are closing numbers. A
Thursday pick wouldn't have Sunday's close, so `implied_total` carries a mild
lookahead. Not fixed in stage 1.
