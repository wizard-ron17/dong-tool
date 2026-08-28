"""Build the player-game table the Picks backtest trains on.

One row per (season, week, player, game) for RB/WR/TE/FB who took >=1 offensive
snap. Target is `scored` — did the player score >=1 offensive (rush or rec) TD.

LEAKAGE RULES, which the whole exercise depends on:
  * every feature is computed from games STRICTLY BEFORE the row's week. At pick
    time you know last week's snap share, not this week's.
  * form features shrink toward a prior so week 2 isn't a coin flip off one game:
        est = (sum_prior + k * prior_mean) / (n_prior + k)
    where prior_mean is the player's PREVIOUS-season rate, falling back to the
    position mean when there isn't one (rookies, role changes).
  * the previous-season fallback is the one place we read across a season
    boundary, and it only ever reads backwards.

Vegas lines (spread_line/total_line) come off pbp and are CLOSING lines, which
is a mild lookahead vs. picking on Thursday. Flagged, not fixed, in stage 1.
"""
import os
import numpy as np
import pandas as pd

CACHE = os.environ.get(
    "PICKS_CACHE",
    "/private/tmp/claude-501/-Users-ron-Desktop-dong-tool/"
    "5857f821-b559-469c-a8ee-a9ffc542c6c6/scratchpad/nflcache",
)
OUT = os.path.join(os.path.dirname(__file__), "dataset.parquet")
SEASONS = list(range(2016, 2026))
POS = ["RB", "WR", "TE", "FB"]
SHRINK_K = 2.0          # pseudo-games of prior mixed into each form estimate

PBP_COLS = [
    "game_id", "season", "week", "posteam", "defteam", "home_team", "away_team",
    "play_type", "touchdown", "pass_touchdown", "rush_touchdown",
    "td_player_id", "yardline_100", "rush_attempt", "pass_attempt",
    "rusher_player_id", "receiver_player_id", "spread_line", "total_line",
]


def load_pbp(year):
    df = pd.read_parquet(f"{CACHE}/pbp_{year}.parquet", columns=PBP_COLS)
    return df[df["posteam"].notna()]


def game_level(pbp):
    """Per (game_id, team): implied team total from the closing line."""
    g = pbp.groupby(["game_id", "posteam"], as_index=False).agg(
        week=("week", "first"), season=("season", "first"),
        defteam=("defteam", "first"), home_team=("home_team", "first"),
        spread_line=("spread_line", "first"), total_line=("total_line", "first"),
    )
    # nflverse spread_line is positive when the HOME team is favored.
    is_home = g["posteam"] == g["home_team"]
    half = g["total_line"] / 2.0
    edge = g["spread_line"] / 2.0
    g["implied_total"] = np.where(is_home, half + edge, half - edge)
    return g


def player_game_events(pbp):
    """Per (game_id, player): offensive TDs, red-zone touches, touches."""
    rush = pbp[(pbp["rush_attempt"] == 1) & pbp["rusher_player_id"].notna()][
        ["game_id", "posteam", "rusher_player_id", "yardline_100"]
    ].rename(columns={"rusher_player_id": "pid"})
    rec = pbp[(pbp["pass_attempt"] == 1) & pbp["receiver_player_id"].notna()][
        ["game_id", "posteam", "receiver_player_id", "yardline_100"]
    ].rename(columns={"receiver_player_id": "pid"})
    touch = pd.concat([rush, rec], ignore_index=True)
    touch["rz"] = (touch["yardline_100"] <= 20).astype(int)
    agg = touch.groupby(["game_id", "pid"], as_index=False).agg(
        touches=("rz", "size"), rz_touches=("rz", "sum")
    )

    td = pbp[((pbp["rush_touchdown"] == 1) | (pbp["pass_touchdown"] == 1))
             & pbp["td_player_id"].notna()]
    tds = td.groupby(["game_id", "td_player_id"], as_index=False).size()
    tds.columns = ["game_id", "pid", "tds"]
    return agg.merge(tds, on=["game_id", "pid"], how="outer").fillna(
        {"touches": 0, "rz_touches": 0, "tds": 0}
    )


def load_xwalk():
    """pfr_id -> gsis_id. See fetch_data.players() for why not weekly_rosters."""
    pl = pd.read_csv(f"{CACHE}/players.csv", usecols=["gsis_id", "pfr_id"],
                     low_memory=False)
    pl = pl[pl["gsis_id"].notna() & pl["pfr_id"].notna()]
    return pl.drop_duplicates("pfr_id")


def load_pool(year, xwalk):
    """RB/WR/TE/FB with an offensive snap, carrying a gsis id."""
    snaps = pd.read_csv(
        f"{CACHE}/snaps_{year}.csv",
        usecols=["game_id", "season", "week", "player", "pfr_player_id",
                 "position", "team", "offense_snaps", "offense_pct"],
        low_memory=False,
    )
    snaps = snaps[snaps["position"].isin(POS) & (snaps["offense_snaps"] > 0)]
    out = snaps.merge(xwalk, left_on="pfr_player_id", right_on="pfr_id",
                      how="left")
    out = out.rename(columns={"gsis_id": "pid"})
    out["season"] = year
    return out


def add_form(df, value_col, out_col):
    """Expanding pre-week mean of value_col, shrunk toward a backward prior.

    Sorting by (pid, season, week) then shifting guarantees the row's own game
    never enters its own feature.
    """
    df = df.sort_values(["pid", "season", "week"]).copy()
    g = df.groupby("pid", sort=False)[value_col]
    prior_sum = g.cumsum() - df[value_col]          # sum of strictly-earlier
    prior_n = g.cumcount()                          # count of strictly-earlier

    # previous-season mean for this player, as the week-1 prior
    season_mean = (df.groupby(["pid", "season"])[value_col].mean()
                     .rename("season_mean").reset_index())
    season_mean["season"] += 1                      # shift forward one season
    df = df.merge(season_mean, on=["pid", "season"], how="left")

    pos_mean = df.groupby("position")[value_col].transform("mean")
    prior_mean = df["season_mean"].fillna(pos_mean)

    df[out_col] = ((prior_sum.values + SHRINK_K * prior_mean.values)
                   / (prior_n.values + SHRINK_K))
    return df.drop(columns=["season_mean"])


def main():
    xwalk = load_xwalk()
    pools, events, games = [], [], []
    for y in SEASONS:
        print(f"  season {y}", flush=True)
        pbp = load_pbp(y)
        games.append(game_level(pbp))
        ev = player_game_events(pbp)
        ev["season"] = y
        events.append(ev)
        pools.append(load_pool(y, xwalk))

    pool = pd.concat(pools, ignore_index=True)
    ev = pd.concat(events, ignore_index=True)
    gm = pd.concat(games, ignore_index=True)

    unmatched = pool["pid"].isna().mean()
    print(f"  pool rows {len(pool)}  unmatched gsis id: {unmatched:.2%}")
    pool = pool[pool["pid"].notna()]

    df = pool.merge(ev.drop(columns=["season"]), on=["game_id", "pid"],
                    how="left")
    df[["touches", "rz_touches", "tds"]] = df[
        ["touches", "rz_touches", "tds"]].fillna(0)
    df = df.merge(
        gm[["game_id", "posteam", "implied_total", "total_line", "spread_line",
            "defteam"]],
        left_on=["game_id", "team"], right_on=["game_id", "posteam"],
        how="left",
    )

    df["scored"] = (df["tds"] > 0).astype(int)
    df["snap_pct"] = df["offense_pct"].astype(float)

    df = add_form(df, "snap_pct", "snap_share_prior")
    df = add_form(df, "rz_touches", "rz_touches_prior")
    df = add_form(df, "touches", "touches_prior")

    keep = df["implied_total"].notna() & df["snap_share_prior"].notna()
    print(f"  dropping {(~keep).sum()} rows with no line or no prior")
    df = df[keep]

    cols = ["season", "week", "game_id", "pid", "player", "position", "team",
            "defteam", "scored", "tds", "snap_pct", "touches", "rz_touches",
            "snap_share_prior", "rz_touches_prior", "touches_prior",
            "implied_total", "total_line", "spread_line"]
    df[cols].to_parquet(OUT, index=False)
    print(f"\nwrote {OUT}: {len(df)} player-games, "
          f"base rate {df['scored'].mean():.1%}")
    print(df.groupby("season")["scored"].agg(["size", "mean"]).to_string())


if __name__ == "__main__":
    main()
