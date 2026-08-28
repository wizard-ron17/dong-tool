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
    "drive",
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


def team_game_stats(pbp):
    """Per (game_id, posteam): pace and red-zone trip generation.

    Stage-2 environment features. Team RZ trips is Ron's "we want teams that get
    in the red zone" — note it is a TEAM property, unlike the player-level RZ
    touches in stage 1, so it has a real shot at being orthogonal to snap share.
    """
    plays = pbp[pbp["play_type"].isin(["pass", "run"])]
    pace = plays.groupby(["game_id", "posteam"], as_index=False).size()
    pace.columns = ["game_id", "team", "plays"]

    d = pbp[pbp["drive"].notna() & pbp["posteam"].notna()]
    drv = d.groupby(["game_id", "posteam", "drive"], as_index=False).agg(
        closest=("yardline_100", "min"), td=("touchdown", "max"))
    drv["rz"] = (drv["closest"] <= 20).astype(int)
    drv["rz_td"] = ((drv["rz"] == 1) & (drv["td"] == 1)).astype(int)
    rz = drv.groupby(["game_id", "posteam"], as_index=False).agg(
        rz_trips=("rz", "sum"), rz_tds=("rz_td", "sum"))
    rz.columns = ["game_id", "team", "rz_trips", "rz_tds"]
    return pace.merge(rz, on=["game_id", "team"], how="outer").fillna(0)


def add_entity_form(game_tbl, entity, value_cols, prefix, k=SHRINK_K):
    """Expanding pre-game mean per entity (team or defense), strictly backward.

    Computed on a one-row-per-(game, entity) table — never on the player-level
    frame, where one game appears once per player and would be counted many
    times over.
    """
    t = game_tbl.sort_values([entity, "season", "week"]).reset_index(drop=True)
    g = t.groupby(entity, sort=False)
    prior_n = g.cumcount().to_numpy()
    out = t[[entity, "game_id", "season", "week"]].copy()
    for c in value_cols:
        prior_s = (g[c].cumsum() - t[c]).to_numpy()
        # league mean over strictly earlier seasons as the shrink target
        per = (t.groupby("season")[c].agg(s="sum", n="size")
                .reset_index().sort_values("season"))
        ps = (per["s"].cumsum() - per["s"]).to_numpy()
        pn = (per["n"].cumsum() - per["n"]).to_numpy()
        own = (per["s"] / per["n"]).to_numpy()
        lg = np.where(pn > 0, ps / np.where(pn == 0, 1, pn), own)
        lgv = t["season"].map(dict(zip(per["season"], lg))).to_numpy(float)
        out[f"{prefix}{c}"] = (prior_s + k * lgv) / (prior_n + k)
    return out


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


def add_recency(df, value_col, n, out_col):
    """Mean of value_col over the player's last n games, strictly before this one.

    shift(1) before rolling is what makes it strictly-before; min_periods=1 means
    only a player's very first game is undefined. Stage 3 found this matters more
    than every other feature combined — a season-to-date average is a stale
    measure of a role that changes week to week.
    """
    df = df.sort_values(["pid", "season", "week"]).reset_index(drop=True)
    df[out_col] = (df.groupby("pid", sort=False)[value_col]
                     .transform(lambda s: s.shift(1).rolling(n, min_periods=1).mean()))
    return df


def position_prior(df, value_col):
    """Per (position, season): the mean over strictly earlier seasons.

    The earliest season has nothing before it and falls back to its own mean.
    That only ever touches 2016 rows, which are training-only — the walk-forward
    never scores 2016.
    """
    g = (df.groupby(["position", "season"])[value_col]
           .agg(s="sum", n="size").reset_index()
           .sort_values(["position", "season"]))
    grp = g.groupby("position", sort=False)
    prior_s = grp["s"].cumsum() - g["s"]
    prior_n = grp["n"].cumsum() - g["n"]
    own = g["s"] / g["n"]
    g["pos_prior"] = np.where(prior_n > 0, prior_s / prior_n.replace(0, np.nan),
                              own)
    return g[["position", "season", "pos_prior"]]


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

    # Rookie/no-history fallback: the position's mean over STRICTLY EARLIER
    # seasons. Using a whole-dataset position mean here would leak future
    # seasons into an early-season row — weak, since it is one constant per
    # position, but it is still a leak.
    df = df.merge(position_prior(df, value_col), on=["position", "season"],
                  how="left")
    prior_mean = df["season_mean"].fillna(df["pos_prior"])

    df[out_col] = ((prior_sum.values + SHRINK_K * prior_mean.values)
                   / (prior_n.values + SHRINK_K))
    return df.drop(columns=["season_mean", "pos_prior"])


def main():
    xwalk = load_xwalk()
    pools, events, games, teams = [], [], [], []
    for y in SEASONS:
        print(f"  season {y}", flush=True)
        pbp = load_pbp(y)
        games.append(game_level(pbp))
        ev = player_game_events(pbp)
        ev["season"] = y
        events.append(ev)
        pools.append(load_pool(y, xwalk))
        tg = team_game_stats(pbp)
        tg["season"] = y
        teams.append(tg)

    pool = pd.concat(pools, ignore_index=True)
    ev = pd.concat(events, ignore_index=True)
    gm = pd.concat(games, ignore_index=True)
    tg = pd.concat(teams, ignore_index=True)

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

    # ── stage 3: recency. Snap share is ~87% of the model's signal, so a better
    # estimate of it beats any new feature. Last-3 games alone is worth more
    # than implied total, RZ touches and all of stage 2 put together.
    df = add_recency(df, "snap_pct", 3, "snap_last3")
    df = add_recency(df, "snap_pct", 5, "snap_last5")
    # A player's first career game has no window; fall back to the shrunk prior,
    # which for a debut is the position's backward-looking mean.
    for c in ("snap_last3", "snap_last5"):
        df[c] = df[c].fillna(df["snap_share_prior"])
    df["snap_trend"] = df["snap_last3"] - df["snap_share_prior"]

    # bucket 2 ("player TD ability") — kept so the null result stays reproducible
    df = df.sort_values(["pid", "season", "week"]).reset_index(drop=True)
    gp = df.groupby("pid", sort=False)
    df["td_per_touch_prior"] = (
        gp["tds"].transform(lambda s: s.shift(1).cumsum())
        / gp["touches"].transform(lambda s: s.shift(1).cumsum()).replace(0, np.nan)
    )
    df["td_per_touch_prior"] = df["td_per_touch_prior"].fillna(
        df["td_per_touch_prior"].median())

    # ── stage 2: defense allowed, and team environment ────────────────────
    # TDs each defense allowed to each position, per game. Built off the player
    # frame so it is consistent with the target by construction.
    dpos = (df.groupby(["game_id", "defteam", "season", "week", "position"],
                       as_index=False)["scored"].sum()
              .pivot_table(index=["game_id", "defteam", "season", "week"],
                           columns="position", values="scored", fill_value=0)
              .reset_index())
    dpos.columns.name = None
    for p in POS:
        if p not in dpos:
            dpos[p] = 0
    dpos = dpos.rename(columns={p: f"td_{p}" for p in POS})

    # defensive pace + red zone allowed: the same team-game table, keyed as the
    # defense rather than the offense
    dgen = tg.merge(gm[["game_id", "posteam", "defteam"]],
                    left_on=["game_id", "team"], right_on=["game_id", "posteam"],
                    how="left")[["game_id", "defteam", "season",
                                 "plays", "rz_trips", "rz_tds"]]
    dgen = dgen.merge(dpos[["game_id", "defteam", "week"]],
                      on=["game_id", "defteam"], how="left")
    dgen = dgen.rename(columns={"plays": "plays_all", "rz_trips": "rz_trips_all",
                                "rz_tds": "rz_tds_all"})
    dtbl = dpos.merge(dgen, on=["game_id", "defteam", "season", "week"],
                      how="left").fillna(0)

    dfeat = add_entity_form(
        dtbl, "defteam",
        [f"td_{p}" for p in POS] + ["plays_all", "rz_trips_all", "rz_tds_all"],
        "d_")
    df = df.merge(dfeat.drop(columns=["season", "week"]),
                  on=["game_id", "defteam"], how="left")

    # the defense feature that matters is the one for THIS player's position
    df["d_td_vs_pos"] = np.select(
        [df["position"] == p for p in POS],
        [df[f"d_td_{p}"] for p in POS], default=np.nan)
    df["d_rz_td_rate"] = df["d_rz_tds_all"] / df["d_rz_trips_all"].replace(0, np.nan)

    tg2 = tg.merge(dpos[["game_id", "week"]].drop_duplicates(), on="game_id",
                   how="left")
    tfeat = add_entity_form(tg2, "team", ["plays", "rz_trips", "rz_tds"], "t_")
    df = df.merge(tfeat.drop(columns=["season", "week"]),
                  on=["game_id", "team"], how="left")

    keep = df["implied_total"].notna() & df["snap_share_prior"].notna()
    print(f"  dropping {(~keep).sum()} rows with no line or no prior")
    df = df[keep]

    cols = ["season", "week", "game_id", "pid", "player", "position", "team",
            "defteam", "scored", "tds", "snap_pct", "touches", "rz_touches",
            "snap_share_prior", "rz_touches_prior", "touches_prior",
            "implied_total", "total_line", "spread_line",
            "snap_last3", "snap_last5", "snap_trend", "td_per_touch_prior",
            "d_td_vs_pos", "d_rz_td_rate", "d_plays_all", "d_rz_trips_all",
            "t_plays", "t_rz_trips", "t_rz_tds"]
    df[cols].to_parquet(OUT, index=False)
    print(f"\nwrote {OUT}: {len(df)} player-games, "
          f"base rate {df['scored'].mean():.1%}")
    print(df.groupby("season")["scored"].agg(["size", "mean"]).to_string())


if __name__ == "__main__":
    main()
