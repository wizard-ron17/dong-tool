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
  - Verify the first real build: early-season term, rosters, recap, and grading of the new Due/Milestones.

## Next up
- **Soccer (/soccer, MLS):** Goals and Shots / On target live 10/19, all three on the role mixture (start / bench / sits) and lineup-aware: goals AUC .830 before lineups, .869 after (research/soccer_goals.py); each team's next game. Next:
  - Pre-lineup, the top decile runs ~3pp short on shots (stars start, and shoot, a little more than the role model says). On target runs ~5% under in 2025-26 as the league's on-target rate rose: try a recent-seasons weight.
  - Grade the live log (soccer/goals-history.json) against books' closes once a few rounds are in (the SmartStake recorder has MLS shots props?).
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
