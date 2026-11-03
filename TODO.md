# TODO

Dated and open work. Newest decisions at the top of each section. Remove items when done.

## Scheduled
- **Weekly closes re-grade, next ~11/10:** `~/smartstake-data/study/cv/grade_all.sh --since 2026-11-03` (pull fresh closes first: `cd ~/smartstake-data && python3 closes.py recent`). 11/03 (since 10/28): NBA close still sharper on every market (points/PRA widest; double-doubles too, .3825 vs .3759, so the 10/28 fix did NOT make DD beat it); our NBA overs no longer run low (points priced .475, hit .443); NHL goals/PPP/first/last ours ahead; NFL TDs ours ahead, receptions/yards still behind. Ron's books: NBA PRA unders +6.2% ±4.8, NBA overs −7..−23% everywhere, NHL SOG unders −11.9% ±5.6. Rewrite the Models page rows after, and update `vsmarket.js` (AS_OF, GAMES, each tool's markets): it drives the Tools-menu chips.
- **Blend-only shadow lane, read ~11/17:** Ron's Plays logs lines that clear the blend but not the market's fair (odds branch, from 11/03; Record → Straights → Blend only), never shown as picks. The 11/03 closes check said −8.7% ± 10 at Ron's books' closing prices (both-clear +2.6%, model-only −3.9%); see if the live prices agree before ever showing them. Same day: the parlay index on the board log (Record → Parlays), first exact slates from 11/03.
- **Grade Ron's Plays on the odds build, ~11/04:** the picks log's rows with `"src":"odds"` (from 11/01) vs the old main-line picks: record, CLV and beat-close by lane. The odds build reads every line (ladders) from every book, gated by 3+ shown two-sided books; tighten it if the ladder rungs grade worse.
- **First-scorer grades at ~100 games:** NBA first basket (market slightly better at 44 games), NHL first goal (ours better at 30).
- **NBA overs:** Results (10/20-30) show points and rebounds going over 2-3pp more than priced (minutes, as the close grade said); watch it shrink at the re-grade.
- **MLB offseason:** `MLB_OFF` in mlb/index.html is hand-set each year (opening 2027-03-25); builds resume ~03/18 via should-build.
- **MLS Decision Day 11/07, playoffs from 11/11:** check the soccer build and boards on the first playoff day (slug `playoffs`?), and that the home tile switches to Post.

## Next up
- **Soccer (/soccer, MLS):** Goals and Shots / On target live 10/19, all three on the role mixture (start / bench / sits) and lineup-aware: goals AUC .830 before lineups, .869 after (research/soccer_goals.py); each team's next game. Next:
  - **Grade vs the closes:** SmartStake's closing-odds endpoint (history to Aug 7, opening price included) is stored locally; `python3 ~/smartstake-data/study/mls_closes.py` grades the whole MLS season to date. 10/23: ours beat the median close on every line, and books barely reprice open to close (2–6% of the gap), so grade on results, not CLV. 10/26 live log (15 games, if-he-plays, played rows): goal AUC .81 (priced .102, hit .084), shots o1.5 AUC .83 (.233 / .226), SOT o0.5 .75 (.246 / .224); every line beats the base rate. Goal and SOT run ~2pp rich: re-grade after ~40 games before shading. MLB done 10/23 (below); NFL wks 1–7 and NHL next.
  - Star gap: priced if he plays, the top decile at shots o1.5 still runs ~.66 vs ~.69 though the mean and start split are calibrated; dispersion curves, rate quadratics and recency didn't close it (10/19). Leave unless the live grade shows it.
  - Parlay slip: measured soccer correlations in parlay.js (a player's shots + his SOT + his goal, teammates) before legs go on it.
  - MLS regular season ends 11/07 (Decision Day), then playoffs; EPL on the same engine for the winter (Ron's EV scan flags EPL / LaLiga / Serie A shots).
- Season-rollover tests: run each build against fixed dates (opening day, the day before, first playoff day).
- Fair-odds explainer: tap-to-explain wherever a fair price appears.
- For outside agents: llms.txt, documented JSON endpoints, a RONBET spec.
- Public track record per tool: calibration and results vs close, from the graded histories we already keep.

## Research queue
- **MLB pitcher Ks and outs lose to the close (10/23, re-tested 10/27 in `research/mlb_outs.py`):** a real leash model (batters faced RMSE 3.92 vs the build's 4.50) still doesn't beat the market on Ks (log loss .715 vs close .681, ours β −0.17) or outs (β −0.06). The hole is the K RATE, not the leash: our batters-faced disagreement with the market carries nothing. Only lead left: pitch-level Statcast (whiff/CSW) for the rate, low odds. Don't bet Ks off the odds-viewer fair. Walks tie the close and add in a blend: keep.
- **MLB HR vs the close (10/23):** v1 adds nothing over the all-book close (power devig understates HR overs ~2.4pp; recalibrate before comparing). Same verdict as Kalshi.
- Pick-factor regression (MLB HR): ran 9/25 on 474 rows, too small. Re-run with more data, or log every lineup batter instead of only the board.
- NFL receptions: our term z 3.0 beside the Kalshi mid in the week 3 grade, so blend it with the mid.
- HRR3 (MLB H+R+RBI 3+) model: 2.2x the HR hit rate and smoother, but priced fair on Kalshi.
