"""Every shot of four seasons, from each game's play-by-play — for shot quality
(an expected-goals model) and goalie quality (goals saved above expected).

Only unblocked and blocked attempts are kept, compactly, one file per game:
  $NHL_CACHE/{season}/pbp/{gameId}.json
  { home, away, homeId, awayId, homeDefending: [side per period],
    shots: [[period, sec, kind, x, y, shotType, shooter, goalie, teamId, situation, zone]] }
kind: g goal, s shot on goal, m missed, b blocked. situationCode is the feed's
4-digit away-goalie / away-skaters / home-skaters / home-goalie string, so an
empty net and the manpower are both in it.

    python3 research/nhl_pbp_fetch.py
"""
import glob, json, os, subprocess, time
from concurrent.futures import ThreadPoolExecutor

CACHE = os.environ.get("NHL_CACHE") or "/tmp/nhl-cache"
KIND = {"goal": "g", "shot-on-goal": "s", "missed-shot": "m", "blocked-shot": "b"}


def get(url, tries=4):
    for i in range(tries):
        r = subprocess.run(["curl", "-sL", "--max-time", "40", "-H", "User-Agent: dong-tool/1.0", url], capture_output=True, text=True)
        if r.returncode == 0 and r.stdout.strip().startswith("{"):
            try: return json.loads(r.stdout)
            except json.JSONDecodeError: pass
        time.sleep(0.8 * (i + 1))
    return None


def one(args):
    season, gid = args
    p = os.path.join(CACHE, str(season), "pbp", f"{gid}.json")
    if os.path.exists(p): return 0
    d = get(f"https://api-web.nhle.com/v1/gamecenter/{gid}/play-by-play")
    if not d: return -1
    side = {}
    shots = []
    for pl in d.get("plays", []):
        per = (pl.get("periodDescriptor") or {}).get("number")
        if pl.get("homeTeamDefendingSide") and per: side[per] = pl["homeTeamDefendingSide"]
        k = KIND.get(pl.get("typeDescKey"))
        if not k: continue
        dt = pl.get("details") or {}
        m, s = (pl.get("timeInPeriod") or "0:00").split(":")
        shots.append([per, int(m) * 60 + int(s), k, dt.get("xCoord"), dt.get("yCoord"), dt.get("shotType"),
                      dt.get("shootingPlayerId") or dt.get("scoringPlayerId"), dt.get("goalieInNetId"),
                      dt.get("eventOwnerTeamId"), pl.get("situationCode"), dt.get("zoneCode"),
                      (pl.get("periodDescriptor") or {}).get("periodType")])
    out = {"home": d["homeTeam"]["abbrev"], "away": d["awayTeam"]["abbrev"], "homeId": d["homeTeam"]["id"], "awayId": d["awayTeam"]["id"],
           "homeDefending": side, "shots": shots}
    os.makedirs(os.path.dirname(p), exist_ok=True)
    json.dump(out, open(p, "w"), separators=(",", ":"))
    return 1


if __name__ == "__main__":
    jobs = []
    for f in sorted(glob.glob(os.path.join(CACHE, "20*", "games.json"))):
        season = int(os.path.basename(os.path.dirname(f)))
        jobs += [(season, g["gid"]) for g in json.load(open(f))]
    print(f"{len(jobs)} games", flush=True)
    done = fail = 0
    with ThreadPoolExecutor(8) as ex:
        for i, r in enumerate(ex.map(one, jobs), 1):
            done += r == 1; fail += r == -1
            if i % 500 == 0: print(f"  {i}/{len(jobs)}  fetched {done}  failed {fail}", flush=True)
    print(f"done: fetched {done}, failed {fail}")
