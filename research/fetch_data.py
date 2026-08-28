"""Download + cache the nflverse feeds the Picks backtest needs.

Research-only: this lives outside scripts/ because it is not part of the CI
build. If a model graduates, its feature computation gets ported into
scripts/build-nfl.js (Node) to run in the daily workflow.

Everything is cached under CACHE so re-runs are free. pbp is pulled as parquet
(~20MB/season) rather than CSV (~90MB/season) and read column-selectively.
"""
import os, ssl, sys, urllib.request

# The python.org build ships no CA bundle, so TLS to GitHub fails out of the
# box. certifi is present; point the default context at it.
try:
    import certifi
    _SSL = ssl.create_default_context(cafile=certifi.where())
except ImportError:
    _SSL = ssl.create_default_context()

CACHE = os.environ.get(
    "PICKS_CACHE",
    "/private/tmp/claude-501/-Users-ron-Desktop-dong-tool/"
    "5857f821-b559-469c-a8ee-a9ffc542c6c6/scratchpad/nflcache",
)
SEASONS = list(range(2016, 2026))          # participation + snap_counts start 2016
UA = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36")
REL = "https://github.com/nflverse/nflverse-data/releases/download"


def fetch(url, dest):
    if os.path.exists(dest) and os.path.getsize(dest) > 1024:
        return dest
    os.makedirs(os.path.dirname(dest), exist_ok=True)
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    tmp = dest + ".part"
    with urllib.request.urlopen(req, timeout=180, context=_SSL) as r, \
            open(tmp, "wb") as f:
        while True:
            chunk = r.read(1 << 20)
            if not chunk:
                break
            f.write(chunk)
    os.replace(tmp, dest)
    print(f"  fetched {os.path.basename(dest)} "
          f"({os.path.getsize(dest)/1048576:.1f} MB)", flush=True)
    return dest


def pbp(year):
    return fetch(f"{REL}/pbp/play_by_play_{year}.parquet",
                 f"{CACHE}/pbp_{year}.parquet")


def snaps(year):
    return fetch(f"{REL}/snap_counts/snap_counts_{year}.csv",
                 f"{CACHE}/snaps_{year}.csv")


def rosters(year):
    return fetch(f"{REL}/weekly_rosters/roster_weekly_{year}.csv",
                 f"{CACHE}/roster_{year}.csv")


def injuries(year):
    """Weekly injury report. Keys on gsis_id directly — no crosswalk needed —
    and is published Wed-Fri, so it is genuinely available before kickoff."""
    return fetch(f"{REL}/injuries/injuries_{year}.csv",
                 f"{CACHE}/injuries_{year}.csv")


def players():
    """Season-agnostic id crosswalk. weekly_rosters looks like it would do this
    job but its pfr_id is null ~36% of the time, and the players it misses skew
    heavily to low-snap-share guys — i.e. exactly the low-TD-probability rows,
    so dropping them silently inflates the base rate. This file misses ~0.2%."""
    return fetch(f"{REL}/players/players.csv", f"{CACHE}/players.csv")


def main():
    players()
    for y in SEASONS:
        print(f"season {y}", flush=True)
        pbp(y); snaps(y); rosters(y); injuries(y)
    print("cache ready:", CACHE)


if __name__ == "__main__":
    main()
