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
- **Soccer (/soccer, MLS):** the skeleton is up (10/19). Next:
  - First CI build: `gh workflow run build-soccer.yml` (the page shows "couldn't load" until soccer/data.json exists on main).
  - Goals board: walk-forward anytime-goalscorer on ASA 2013–2026 xG × minutes × the line's implied goals (the NHL goals playbook), parity replay vs the build.
  - Shots / shots on target off the same minutes model; that's where Ron's EV scan shows the outliers (EPL, LaLiga, Serie A as much as MLS).
  - MLS regular season ends 11/07 (Decision Day), then playoffs; EPL on the same engine for the winter.
- Season-rollover tests: run each build against fixed dates (opening day, the day before, first playoff day).
- Fair-odds explainer: tap-to-explain wherever a fair price appears.
- For outside agents: llms.txt, documented JSON endpoints, a RONBET spec.
- Public track record per tool: calibration and results vs close, from the graded histories we already keep.

## Research queue
- Pick-factor regression (MLB HR): ran 9/25 on 474 rows, too small. Re-run with more data, or log every lineup batter instead of only the board.
- NFL receptions: our term z 3.0 beside the Kalshi mid in the week 3 grade, so blend it with the mid.
- HRR3 (MLB H+R+RBI 3+) model: 2.2x the HR hit rate and smoother, but priced fair on Kalshi.
