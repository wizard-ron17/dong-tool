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
- NBA parlay slip (the only app without one, so it has no Copy for tracker either). Copy the slip verbatim from NHL.
- Public track record per tool: calibration and results vs close, from the graded histories we already keep.
- Freshness: "updated N min ago" on boards, a stale-build banner, and a "QB confirmed / projected" marker when an override applies.
- Cron failure alerts (a notification when a build workflow fails).
- Run `npm run check` in CI before deploys. It's local only for now.

## Research queue
- Pick-factor regression (MLB HR): ran 9/25 on 474 rows, too small. Re-run with more data, or log every lineup batter instead of only the board.
- NFL receptions: our term z 3.0 beside the Kalshi mid in the week 3 grade, so blend it with the mid.
- HRR3 (MLB H+R+RBI 3+) model: 2.2x the HR hit rate and smoother, but priced fair on Kalshi.

## Waiting on Ron
- odds-viewer first commit. Git is set up, and `circa.key` and `keys.json` are gitignored. Claude's commit was blocked by a safety check, so run it yourself:
  `cd ~/Desktop/odds-viewer && git add -A && git commit -m "first commit"`
