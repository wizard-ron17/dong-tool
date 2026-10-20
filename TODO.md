# TODO

Dated and open work. Newest decisions at the top of each section. Remove items when done.

## Scheduled
- **Fri 2026-10-02:** snapshot NFL week 4 (the M12 board plus Kalshi) into `exchange-odds/data/edges/nfl-2026-wk4/`.
  - Resnap Sunday, and **Monday before MNF** (the week 3 Monday resnap was missed).
  - Grade after MNF using week 3's `grade.py`.
- **MLB postseason, nightly (optional, Ron declined automation):**
  - Before first pitch: `python3 data/edges/mlb-snap.py` (from exchange-odds).
  - Next morning: grade with `data/edges/mlb-2026-09-25/grade.py`.
- **MLB playoff pitching:** update `mlb/pitching-overrides.json` per game day (openers and bullpen games).
- **NBA opener (~2026-10-20):**
  - Schedule picks appear around 10/10.
  - Verified 10/20: build healthy, boards priced and frozen at tip; live recap + player hub built; check grading after the first finals.

## Next up
- **Soccer (/soccer, MLS):** Goals and Shots / On target live 10/19, all three on the role mixture (start / bench / sits) and lineup-aware: goals AUC .830 before lineups, .869 after (research/soccer_goals.py); each team's next game. Next:
  - **Grade vs the closes after the 10/24-25 round** (first live-logged prices: Wed 10/21): `python3 ~/smartstake-data/study/mls_props_v2.py` (recorder closes vs our prices vs results; aggregates only). First run 10/19 on 45 games: ours beat the sharp books on every line and the books price subs like starters. Next: grade the LIVE log (soccer/goals-history.json, if-he-plays prices) the same way, and how far books move once lineups post.
  - Star gap: priced if he plays, the top decile at shots o1.5 still runs ~.66 vs ~.69 though the mean and start split are calibrated; dispersion curves, rate quadratics and recency didn't close it (10/19). Leave unless the live grade shows it.
  - Parlay slip: measured soccer correlations in parlay.js (a player's shots + his SOT + his goal, teammates) before legs go on it.
  - MLS regular season ends 11/07 (Decision Day), then playoffs; EPL on the same engine for the winter (Ron's EV scan flags EPL / LaLiga / Serie A shots).
- Season-rollover tests: run each build against fixed dates (opening day, the day before, first playoff day).
- Fair-odds explainer: tap-to-explain wherever a fair price appears.
- For outside agents: llms.txt, documented JSON endpoints, a RONBET spec.
- Public track record per tool: calibration and results vs close, from the graded histories we already keep.

## Research queue
- Pick-factor regression (MLB HR): ran 9/25 on 474 rows, too small. Re-run with more data, or log every lineup batter instead of only the board.
- NFL receptions: our term z 3.0 beside the Kalshi mid in the week 3 grade, so blend it with the mid.
- HRR3 (MLB H+R+RBI 3+) model: 2.2x the HR hit rate and smoother, but priced fair on Kalshi.
