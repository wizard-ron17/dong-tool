"""Return-game constants for the Returners board.

Ron's thesis, tested and confirmed in direction: punt-return volume is driven by
the OPPONENT punting (r=+0.80 against their actual punts), kick-return volume by
the opponent SCORING (r=+0.38 against their actual points). Both mechanisms are
real.

The finding that shapes the tool is what happens when you put them together:
they cancel. Across opponent-implied-total terciles a returner sees 6.23 / 6.41
/ 6.33 returns — flat. A matchup moves the MIX, not the volume. That matters
only because the two return types don't score at the same rate: a punt return
houses it roughly 1.7x as often as a kick return, so a punt specialist facing a
stalling offense is the one real angle in here.

2025 ONLY for kickoffs. The dynamic-kickoff change took the return rate from
33% in 2024 to 74.5% in 2025, so earlier seasons describe a game that no longer
exists. Punt rates are stable across the whole span and use more of it.

  python3 research/returners.py   ->  research/returners_model.json
"""
import json
import os

import numpy as np
import pandas as pd

HERE = os.path.dirname(__file__)
OUT = os.path.join(HERE, "returners_model.json")
CACHE = os.environ.get(
    "PICKS_CACHE",
    "/private/tmp/claude-501/-Users-ron-Desktop-dong-tool/"
    "5857f821-b559-469c-a8ee-a9ffc542c6c6/scratchpad/nflcache",
)
KICK_SEASONS = [2025]                       # post dynamic-kickoff only
PUNT_SEASONS = [2021, 2022, 2023, 2024, 2025]
COLS = ["game_id", "season", "posteam", "home_team", "away_team",
        "punt_attempt", "kickoff_attempt", "return_touchdown", "return_team",
        "punt_returner_player_id", "kickoff_returner_player_id",
        "spread_line", "total_line"]


def load(seasons):
    return pd.concat([pd.read_parquet(f"{CACHE}/pbp_{y}.parquet", columns=COLS)
                      for y in seasons], ignore_index=True)


def team_games(d):
    """Per (game, team): returns taken, and the implied totals from the line.

    return_team is authoritative for both types and posteam is NOT — on a punt
    posteam is the punting side, on a kickoff nflverse assigns it to the
    RECEIVING side. Reading volume off posteam flips the punt correlation from
    +0.80 to -0.63, which is how this got caught.
    """
    pr = d[(d.punt_attempt == 1) & d.punt_returner_player_id.notna()] \
        .groupby(["game_id", "return_team"]).size().rename("pret")
    kr = d[(d.kickoff_attempt == 1) & d.kickoff_returner_player_id.notna()] \
        .groupby(["game_id", "return_team"]).size().rename("kret")
    g = d.groupby("game_id").agg(ht=("home_team", "first"), at=("away_team", "first"),
                                 sp=("spread_line", "first"), tot=("total_line", "first"),
                                 season=("season", "first")).reset_index()
    rows = []
    for r in g.itertuples(index=False):
        if pd.isna(r.tot) or pd.isna(r.sp):
            continue
        for me, opp_imp in ((r.ht, r.tot / 2 - r.sp / 2), (r.at, r.tot / 2 + r.sp / 2)):
            rows.append({"season": r.season, "team": me, "opp_imp": opp_imp, "total": r.tot,
                         "pret": pr.get((r.game_id, me), 0), "kret": kr.get((r.game_id, me), 0)})
    return pd.DataFrame(rows)


def fit(x, y):
    """Least squares slope/intercept, kept deliberately linear — the effect is
    modest and a curve fitted to one season would be shape-fitting noise."""
    b, a = np.polyfit(x, y, 1)
    return round(float(a), 5), round(float(b), 5)


def main():
    # ── TD rates per return, by type ──────────────────────────────────
    dk = load(KICK_SEASONS)
    dp = load(PUNT_SEASONS)
    kr = dk[(dk.kickoff_attempt == 1) & dk.kickoff_returner_player_id.notna()]
    pr = dp[(dp.punt_attempt == 1) & dp.punt_returner_player_id.notna()]
    kick_td = float(kr.return_touchdown.fillna(0).sum()) / len(kr)
    punt_td = float(pr.return_touchdown.fillna(0).sum()) / len(pr)
    print(f"kick returns {len(kr):,}  TD rate {kick_td:.4%}   (seasons {KICK_SEASONS})")
    print(f"punt returns {len(pr):,}  TD rate {punt_td:.4%}   (seasons {PUNT_SEASONS})")
    print(f"a punt return houses it {punt_td / kick_td:.2f}x as often as a kick return")

    # ── volume against the opponent's implied total ───────────────────
    Tk = team_games(dk)
    Tp = team_games(dp)
    kick_fit = fit(Tk.opp_imp.values, Tk.kret.values)
    punt_fit = fit(Tp.opp_imp.values, Tp.pret.values)
    print(f"\nkick returns = {kick_fit[0]:+.3f} {kick_fit[1]:+.3f} x opp implied   "
          f"(r={np.corrcoef(Tk.opp_imp, Tk.kret)[0,1]:+.3f}, n={len(Tk)})")
    print(f"punt returns = {punt_fit[0]:+.3f} {punt_fit[1]:+.3f} x opp implied   "
          f"(r={np.corrcoef(Tp.opp_imp, Tp.pret)[0,1]:+.3f}, n={len(Tp)})")

    # the point of the whole thing: what the two do together
    print("\n  opp implied   kick   punt   total   E[return TD]")
    for lo, hi in ((14, 19), (19, 22), (22, 25), (25, 31)):
        k = kick_fit[0] + kick_fit[1] * ((lo + hi) / 2)
        p = punt_fit[0] + punt_fit[1] * ((lo + hi) / 2)
        print(f"  {lo}-{hi}        {k:5.2f}  {p:5.2f}  {k+p:5.2f}   {100*(k*kick_td + p*punt_td):.2f}%")

    out = {
        "note": ("Return-game constants. Volume is driven by the opponent: they punt "
                 "when they stall (punt returns) and kick off when they score (kick "
                 "returns). The two cancel, so a matchup moves the MIX not the total "
                 "— which matters only because a punt return scores far more often. "
                 "Kick numbers are 2025-only: the dynamic-kickoff change took the "
                 "return rate from 33% to 74.5%, so earlier seasons describe a "
                 "different game."),
        "kick_td_rate": round(kick_td, 6),
        "punt_td_rate": round(punt_td, 6),
        "kick_fit": {"a": kick_fit[0], "b": kick_fit[1]},
        "punt_fit": {"a": punt_fit[0], "b": punt_fit[1]},
        "kick_seasons": KICK_SEASONS,
        "punt_seasons": PUNT_SEASONS,
        "kick_per_game": round(float(Tk.kret.mean()), 3),
        "punt_per_game": round(float(Tp.pret.mean()), 3),
    }
    with open(OUT, "w") as f:
        json.dump(out, f, indent=1)
    print(f"\nwrote {OUT}")


if __name__ == "__main__":
    main()
