# Picks research harness

Backtesting ground for the NFL **Picks** tool (anytime-TD model). This is
research, not production — but the model it produced now ships: `export_model.py`
writes `model.json`, which `scripts/picks.js` reads inside the daily
`build-nfl.js` run. See **Shipping it** below.

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
offensive (rush or rec) TD. 58,938 player-games, 17.3% base rate.

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
| M4 + RZ touches | 0.4117 | −10.54% | 0.730 |
| M5 + defense/team env | 0.4117 | −10.54% | 0.730 |
| M6 + last-3 snap share | 0.4055 | −11.88% | 0.743 |
| **M7 + injury (teammates out)** | **0.4053** | **−11.92%** | **0.744** |

M7 calibration ECE 0.0067; top decile scores 44.3% against a 17.3% base
(2.57x), bottom decile 3.0% (0.17x). Negative control returns AUC 0.498.

### Four findings that should drive scope

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

**Weather shifts the TD mix but still does not predict individual scoring.**
Worth spelling out, because the first test of this was too blunt — a single
weather main effect pooled across positions, which would cancel any RB-up /
WR-down effect by construction. Tested properly, on outdoor games 2016–2025:

| condition | games | rush rate | rush TD share | TDs/game |
|---|---|---|---|---|
| clear/mild | 1,547 | 42.1% | 37.1% | 4.82 |
| rain or snow | 158 | 45.3% | 43.0% | 4.22 |
| snow only | 25 | 47.5% | 56.4% | 4.80 |

The mix shift is real and large — snow nearly flips the run/pass TD split. It
still does not help, for two compounding reasons. Total TDs *fall* in bad
weather, so a running back gets a bigger slice of a smaller pie and his TD rate
drops anyway (25.2% clear → 22.9% wet); receivers just drop more (17.7% →
14.6%). The surviving RB-vs-WR differential is ~0.8pp on 5.7% of rows. And the
volume half is already priced: closing totals are 1.63 points lower in rain or
snow, 1.30 in cold, 1.07 in wind. Explicit position × weather interactions all
land within 0.04% of M7, most of them worse.

Caveat with teeth: this is the null for an **anytime-TD** target. If the tool
ever prices *rushing*-TD props specifically, or compares an RB against a WR
within the same game, the mix shift is real and this conclusion does not carry.

**The rest of bucket 6 is a null, with one real exception.** Home/away,
blowout risk and game total each move log loss by
under 0.01% — they are already priced into implied team total. But same-position
teammates being ruled out is different: in the FIRST week an absence appears, M6
under-predicted by +1.94% (+1.92% for backups), because last-3 snap share has not
yet caught up to the vacated role. Adding it removes that bias (+1.94% → −0.13%).
It barely moves a pooled metric because it touches only ~11% of rows, and it does
not improve ranking (top decile 44.6% → 44.2%) — it improves *pricing*, on exactly
the breakout-backup picks the tool exists to surface.

The rule this implies: judge a candidate feature by its **orthogonality to snap
share** and its **own split-half reliability**, not by standalone strength — and
check subset calibration, not just the pooled metric, before calling something a
null.

## Shipping it

`scripts/picks.js` scores the upcoming slate inside the normal `build-nfl.js`
run. Training stays here: `export_model.py` writes `model.json` (coefficients,
feature scaling, and the position priors `build_dataset.py` actually used), and
Node only computes features and applies a logistic.

The contract is checked, not assumed:

```sh
node scripts/dump-features.js 2025 10 > /tmp/nf.json
python3 research/validate_port.py /tmp/nf.json
```

That diffs every Node feature against `build_dataset.py` on a real week and
fails if the predicted probability drifts by more than 1e-4. Both 2025 week 1
and week 10 currently match to ~2e-16. Re-run it after touching either side.

## Passing TDs

The anytime model scores a quarterback as a **rusher** — his `scored` is a
rushing touchdown — so passing TDs sat outside it entirely and needed their own
model. `passing_td.py` builds the QB-game table and vets features;
`passing_export.py` fits, calibrates and writes `passing_model.json`, which
`scripts/picks.js` reads the same way it reads `model.json`.

```sh
python3 research/passing_td.py       # base rates, reliability, the ladder
python3 research/passing_export.py   # -> passing_model.json
```

**5,734 QB starts, 2016-2025.** Mean 1.445 passing TDs a start; 1+ 76.9%,
**2+ 43.9%**, 3+ 17.4%. Over 1.5 is the line books hang and is close to a coin
flip, unlike the four longshot markets.

The result worth remembering is what *didn't* work. Every feature Ron proposed
is a genuinely stable trait — team receiving production split-halves at
**r=0.89**, the QB's own TD rate at 0.74, even pass defence at 0.53 — and once
the Vegas implied total is in the model, red-zone efficiency, weapon quality,
defence and game script add **nothing**:

```
base rate only   AUC 0.500
+ implied total        0.644   <- the entire jump
+ pass volume          0.649
+ his own TD rate      0.652
+ everything else      0.647-0.650   (flat or worse)
```

Being a reliable trait is exactly why the market has already priced it. Same
shape as the anytime model's defence null. Shipped model is three features.

Two details that matter:

* **Underdispersed counts.** Variance 1.33 against a mean 1.45, so raw Poisson
  puts too much weight in both tails — it under-prices Over 1.5 and over-prices
  Over 2.5. Each line carries its own isotonic map; ECE on Over 1.5 goes 0.028
  -> 0.013.
* **The priors are windowed to 2 seasons**, matching the play-by-play
  `picks.js` actually loads, so the served feature *is* the trained feature.
  Costs 0.002 AUC and removes a whole class of train/serve drift.

Starters are chosen by who actually threw the most recently, not by snap share:
every team carries two QBs on the board and a backup with thin history falls
back to the position prior at 0.82, indistinguishable from a starter.

## Two traps worth remembering

**The id crosswalk.** `snap_counts` keys on `pfr_player_id`, pbp on GSIS ids.
The obvious bridge, `weekly_rosters`, has a null `pfr_id` 36% of the time, and
the players it misses skew hard to low snap share — exactly the low-TD-probability
rows. Using it silently dropped 13% of the pool and inflated the base rate from
17.3% to 18.7%. Use `players.csv` (~0.2% miss).

**Closing lines.** `spread_line` / `total_line` off pbp are closing numbers. A
Thursday pick wouldn't have Sunday's close, so `implied_total` carries a mild
lookahead. Not fixed — and it matters more now that implied total is the
second-strongest feature in the shipped model.

**Position labels drift.** PFR labels some running backs `HB` rather than `RB`
in some seasons (39 rows in 2025, 41 in 2020). Unmapped, that silently deleted
Chase Brown's entire 2025 season from the training data — and in the live build
it was worse than a missing player: he kept his red-zone history from
play-by-play while losing the snap games that denominate it, so his red-zone
rate came out at 26 per game and the model gave him a 0.9992 chance to score.
Both sides now normalise `HB` to `RB`, and `playerFeatures` refuses to divide a
red-zone sum by a window with no games in it. The general lesson: when a rate is
built from two different feeds, guard the case where they disagree about which
games exist.
