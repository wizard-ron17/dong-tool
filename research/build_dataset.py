"""Build the player-game table the Picks backtest trains on.

One row per (season, week, player, game) for RB/WR/TE/QB/FB who took >=1
offensive snap. Target is `scored` — did the player score >=1 offensive TD.

Quarterbacks are in because they score anytime touchdowns too, almost always
rushing. This needs no special-casing: play-by-play credits a passing TD to the
RECEIVER in `td_player_id`, never the passer, so a QB's passing touchdowns
cannot enter the target. Only his rushing scores do — which is exactly the
anytime-TD market. Passing-TD props are a separate tool.

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
import json
import os
import numpy as np
import pandas as pd

CACHE = os.environ.get(
    "PICKS_CACHE",
    "/private/tmp/claude-501/-Users-ron-Desktop-dong-tool/"
    "5857f821-b559-469c-a8ee-a9ffc542c6c6/scratchpad/nflcache",
)
OUT = os.path.join(os.path.dirname(__file__), "dataset.parquet")
# The shrinkage targets add_form() actually used, saved so export_model.py ships
# the same numbers rather than recomputing them on the filtered dataset.
PRIORS_OUT = os.path.join(os.path.dirname(__file__), "position_priors.json")
SEASONS = list(range(2016, 2026))
POS = ["RB", "WR", "TE", "QB", "FB"]
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


def load_injuries():
    """Same-position teammates ruled out, per (season, week, team, position).

    Bucket 6 is a null in aggregate, but this piece is not: in the FIRST week a
    same-position teammate is ruled out, the model under-predicts by ~1.9pp
    (16.1% predicted vs 18.1% actual; for backups 10.2% vs 12.1%). The cause is
    staleness — last-3 snap share has not yet caught up to the vacated role. The
    effect is real but narrow, hitting ~11% of rows, which is why it barely
    moves a pooled metric while mattering a lot for exactly the breakout-backup
    picks a picks tool exists to surface.
    """
    frames = []
    for y in SEASONS:
        d = pd.read_csv(f"{CACHE}/injuries_{y}.csv", low_memory=False)
        frames.append(d[d["gsis_id"].notna()])
    inj = pd.concat(frames, ignore_index=True)
    inj["out"] = inj["report_status"].isin(["Out", "Doubtful"]).astype(int)
    return (inj.groupby(["season", "week", "team", "position"], as_index=False)
               ["out"].sum().rename(columns={"out": "mates_out"}))


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
    # PFR labels some running backs "HB" in some seasons (39 rows in 2025, 41 in
    # 2020). Left unmapped it silently deletes whole seasons for real starters —
    # Chase Brown's entire 2025 vanished this way. Normalise before filtering.
    snaps["position"] = snaps["position"].replace({"HB": "RB"})
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


def add_form(df, value_col, out_col, window_seasons=None):
    """Prior mean of value_col over the player's earlier games, shrunk.

    window_seasons bounds how far back it reaches. `None` means the whole
    career, which is what the research build used. rz_touches is bounded to 2
    seasons so the Node build can reproduce it from 2 seasons of play-by-play
    (90MB each) instead of ten — snap-count features stay unbounded because
    snap_counts is only ~2.4MB a season and Node just loads them all.
    Sorting by (pid, season, week) then shifting guarantees the row's own game
    never enters its own feature.
    """
    df = df.sort_values(["pid", "season", "week"]).reset_index(drop=True)
    g = df.groupby("pid", sort=False)[value_col]
    prior_sum = g.cumsum() - df[value_col]          # sum of strictly-earlier
    prior_n = g.cumcount()                          # count of strictly-earlier

    if window_seasons is not None:
        # Subtract everything from before the window: for a row in season S with
        # a 2-season window, drop the player's totals through season S-2.
        #
        # This has to be an as-of lookup (latest season <= S-window), not an
        # equality join on S-window. A player who missed that exact season has
        # no row to join to, and an equality join would then subtract nothing
        # and silently hand back his whole career.
        per = (df.groupby(["pid", "season"])[value_col]
                 .agg(s="sum", n="size").reset_index()
                 .sort_values(["pid", "season"]))
        pg = per.groupby("pid", sort=False)
        per["cs"] = pg["s"].cumsum()
        per["cn"] = pg["n"].cumsum()
        cut = per[["pid", "season", "cs", "cn"]].sort_values("season")
        left = pd.DataFrame({"pid": df["pid"].values,
                             "key": df["season"].values - window_seasons,
                             "_i": np.arange(len(df))}).sort_values("key")
        asof = pd.merge_asof(left, cut, left_on="key", right_on="season",
                             by="pid", direction="backward").sort_values("_i")
        prior_sum = np.asarray(prior_sum, float) - asof["cs"].fillna(0).to_numpy()
        prior_n = np.asarray(prior_n, float) - asof["cn"].fillna(0).to_numpy()

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

    prior_sum = np.asarray(prior_sum, dtype=float)
    prior_n = np.asarray(prior_n, dtype=float)
    df[out_col] = ((prior_sum + SHRINK_K * prior_mean.values)
                   / (prior_n + SHRINK_K))
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
    df = add_form(df, "rz_touches", "rz_touches_prior", window_seasons=2)
    df = add_form(df, "touches", "touches_prior")

    # Snapshot the position priors as add_form saw them (pre-filter frame), so
    # the Node build reproduces the rookie fallback exactly.
    snap = {}
    for col, label in (("snap_pct", "snap_share"), ("rz_touches", "rz_touches")):
        t = position_prior(df, col)
        by = {}
        for _, r in t.iterrows():
            by.setdefault(str(int(r["season"])), {})[r["position"]] = float(r["pos_prior"])
        nxt = int(df["season"].max()) + 1
        overall = {p: float(df[df["position"] == p][col].mean()) for p in POS}
        by[str(nxt)] = overall
        by["default"] = overall
        snap[label] = by
    with open(PRIORS_OUT, "w") as fh:
        json.dump(snap, fh, indent=2)

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

    # bucket 6: same-position teammates ruled out, and whether that is NEW this
    # week — the case where last-3 snap share is stalest. See load_injuries().
    df = df.merge(load_injuries(), on=["season", "week", "team", "position"],
                  how="left")
    df["mates_out"] = df["mates_out"].fillna(0)
    df = df.sort_values(["pid", "season", "week"])
    prev = df.groupby(["pid", "season"], sort=False)["mates_out"].shift(1).fillna(0)
    df["new_absence"] = ((df["mates_out"] > prev) & (df["mates_out"] > 0)).astype(int)

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
            "mates_out", "new_absence",
            "d_td_vs_pos", "d_rz_td_rate", "d_plays_all", "d_rz_trips_all",
            "t_plays", "t_rz_trips", "t_rz_tds"]
    df[cols].to_parquet(OUT, index=False)
    print(f"\nwrote {OUT}: {len(df)} player-games, "
          f"base rate {df['scored'].mean():.1%}")
    print(df.groupby("season")["scored"].agg(["size", "mean"]).to_string())


if __name__ == "__main__":
    main()
