"""Build the player-game table the Receptions model trains on.

One row per (season, week, player, game) for RB/WR/TE/FB who took >=1 offensive
snap. Target is `rec` — completions caught. Same population discipline as
build_dataset.py: the pool comes from snap counts, NOT from who happened to be
targeted, because conditioning on a target would delete every zero-reception
game and make the model unable to price the thing it is asked to price.

LEAKAGE RULES are the same as the TD build: every feature comes from games
strictly before this one, form features shrink toward a prior, and the only
backward-looking cross-season read is the previous-season fallback.

Receptions are OVER-DISPERSED — variance/mean runs 1.1 to 1.3 for real
receivers against the 1.0 a Poisson assumes. That is measured in
research/receptions.py and is why the model there is negative binomial. This
file only assembles features.
"""
import os
import numpy as np
import pandas as pd

CACHE = os.environ.get("PICKS_CACHE",
    "/private/tmp/claude-501/-Users-ron-Desktop-dong-tool/"
    "5857f821-b559-469c-a8ee-a9ffc542c6c6/scratchpad/nflcache")
OUT = os.path.join(os.path.dirname(__file__), "receptions.parquet")
SEASONS = list(range(2016, 2026))
POS = ["RB", "WR", "TE", "FB"]
SHRINK_K = 3.0

PBP = ["game_id","season","week","posteam","defteam","home_team","away_team",
       "pass_attempt","complete_pass","receiver_player_id","air_yards",
       "spread_line","total_line","wind","temp","roof","play_type"]


def load_pool(year, xwalk):
    s = pd.read_csv(f"{CACHE}/snaps_{year}.csv",
                    usecols=["game_id","season","week","player","pfr_player_id",
                             "position","team","offense_snaps","offense_pct"],
                    low_memory=False)
    s["position"] = s["position"].replace({"HB": "RB"})
    s = s[s["position"].isin(POS) & (s["offense_snaps"] > 0)]
    s = s.merge(xwalk, left_on="pfr_player_id", right_on="pfr_id", how="left")
    return s.rename(columns={"gsis_id": "pid"}).drop(columns=["pfr_id"])


def main():
    pl = pd.read_csv(f"{CACHE}/players.csv", usecols=["gsis_id","pfr_id"], low_memory=False)
    xwalk = pl[pl.gsis_id.notna() & pl.pfr_id.notna()].drop_duplicates("pfr_id")

    pools, evs, games = [], [], []
    for y in SEASONS:
        print(f"  season {y}", flush=True)
        p = pd.read_parquet(f"{CACHE}/pbp_{y}.parquet", columns=PBP)
        p = p[p.posteam.notna()]
        tg = p[(p.pass_attempt == 1) & p.receiver_player_id.notna()]
        ev = tg.groupby(["game_id","receiver_player_id"], as_index=False).agg(
            tgt=("pass_attempt","size"), rec=("complete_pass","sum"),
            air=("air_yards","mean"))
        ev = ev.rename(columns={"receiver_player_id": "pid"})
        evs.append(ev)
        # team pass volume and the game environment, one row per (game, team)
        t = p.groupby(["game_id","posteam"], as_index=False).agg(
            team_pass=("pass_attempt","sum"), plays=("play_type","size"),
            defteam=("defteam","first"), home_team=("home_team","first"),
            spread_line=("spread_line","first"), total_line=("total_line","first"),
            wind=("wind","first"), temp=("temp","first"), roof=("roof","first"),
            season=("season","first"), week=("week","first"))
        games.append(t)
        pools.append(load_pool(y, xwalk))

    pool = pd.concat(pools, ignore_index=True)
    pool = pool[pool.pid.notna()]
    ev = pd.concat(evs, ignore_index=True)
    gm = pd.concat(games, ignore_index=True).rename(columns={"posteam": "team"})

    df = pool.merge(ev, on=["game_id","pid"], how="left")
    df[["tgt","rec"]] = df[["tgt","rec"]].fillna(0)
    df = df.merge(gm.drop(columns=["season","week"]), on=["game_id","team"], how="left")

    is_home = df.team == df.home_team
    half = df.total_line / 2.0
    edge = df.spread_line / 2.0
    df["implied_total"] = np.where(is_home, half + edge, half - edge)
    # A negative spread_line for this team means they are the underdog, which is
    # the game-script channel: trailing teams throw. Signed from THIS team's view.
    df["spread_own"] = np.where(is_home, df.spread_line, -df.spread_line)
    df["indoor"] = df.roof.isin(["dome","closed"]).astype(int)
    df["wind"] = np.where(df.indoor == 1, 0.0, df.wind)
    df["snap_pct"] = df.offense_pct.astype(float)

    df = df.sort_values(["pid","season","week"]).reset_index(drop=True)

    def form(col, out, k=SHRINK_K):
        g = df.groupby("pid", sort=False)[col]
        s = (g.cumsum() - df[col]).to_numpy(float)
        n = g.cumcount().to_numpy(float)
        pos_mean = df.groupby("position")[col].transform("mean").to_numpy(float)
        df[out] = (s + k * pos_mean) / (n + k)

    for c, o in (("rec","rec_prior"), ("tgt","tgt_prior"),
                 ("snap_pct","snap_prior"), ("air","air_prior")):
        form(c, o)
    df["games_prior"] = df.groupby("pid").cumcount()

    # share of his team's targets, which separates role from team volume
    df["team_tgt"] = df.groupby(["game_id","team"]).tgt.transform("sum")
    df["tgt_share"] = df.tgt / df.team_tgt.clip(lower=1)
    form("tgt_share", "tgt_share_prior")
    form("team_pass", "team_pass_prior")

    # Last-3 recency. In the TD model this single feature beat season-to-date by
    # more than everything else combined, and it is the difference here too:
    # without it the fit loses to a naive prior (MAE 1.4133 vs 1.3677), with it
    # it wins (1.3040). A career prior carries a role the player may not hold.
    def last3(col, out):
        df[out] = df.groupby("pid")[col].transform(
            lambda s: s.shift(1).rolling(3, min_periods=1).mean())
        df[out] = df[out].fillna(df.groupby("position")[out].transform("mean"))
        df[out] = df[out].fillna(df[out].mean())

    for c, o in (("rec", "rec_l3"), ("tgt_share", "share_l3"), ("snap_pct", "snap_l3")):
        last3(c, o)
    # catch rate separates hands/route depth from volume; tgt_prior on its own is
    # collinear with rec_prior (receptions are ~65% of targets) and the pair fit
    # a meaningless difference, giving tgt_prior a negative coefficient.
    df["catch_prior"] = (df.rec_prior / df.tgt_prior.clip(lower=0.1)).clip(0, 1)

    df = df.dropna(subset=["implied_total","spread_own"])
    keep = ["season","week","game_id","pid","player","position","team","defteam",
            "rec","tgt","air","snap_pct","team_pass","team_tgt",
            "rec_prior","tgt_prior","snap_prior","air_prior","tgt_share",
            "tgt_share_prior","team_pass_prior","implied_total","spread_own",
            "rec_l3","share_l3","snap_l3","catch_prior",
            "total_line","wind","temp","indoor","games_prior"]
    df = df[keep]
    df.to_parquet(OUT)
    print(f"\nwrote {OUT}: {len(df):,} player-games, mean receptions {df.rec.mean():.2f}")
    print(df.groupby("position").agg(n=("rec","size"), rec=("rec","mean")).round(2))


if __name__ == "__main__":
    main()
