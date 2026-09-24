"""Each club's playoff status going into every game from August on: clinched,
eliminated (out of the division AND the wild card), or still in the race —
read off MLB's standings as of the night before. For the motivation tests
(research/mlb_motivation.py). Cached to research/.cache/standings.json.

    python3 research/mlb_standings_fetch.py
"""
import json, os, subprocess
from datetime import date, timedelta

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, ".cache", "standings.json")
AB = {"Arizona Diamondbacks": "AZ", "Atlanta Braves": "ATL", "Baltimore Orioles": "BAL", "Boston Red Sox": "BOS",
      "Chicago Cubs": "CHC", "Chicago White Sox": "CWS", "Cincinnati Reds": "CIN", "Cleveland Guardians": "CLE",
      "Colorado Rockies": "COL", "Detroit Tigers": "DET", "Houston Astros": "HOU", "Kansas City Royals": "KC",
      "Los Angeles Angels": "LAA", "Los Angeles Dodgers": "LAD", "Miami Marlins": "MIA", "Milwaukee Brewers": "MIL",
      "Minnesota Twins": "MIN", "New York Mets": "NYM", "New York Yankees": "NYY", "Athletics": "ATH",
      "Philadelphia Phillies": "PHI", "Pittsburgh Pirates": "PIT", "San Diego Padres": "SD", "San Francisco Giants": "SF",
      "Seattle Mariners": "SEA", "St. Louis Cardinals": "STL", "Tampa Bay Rays": "TB", "Texas Rangers": "TEX",
      "Toronto Blue Jays": "TOR", "Washington Nationals": "WSH"}

if __name__ == "__main__":
    out = json.load(open(OUT)) if os.path.exists(OUT) else {}
    spans = [(date(y, 8, 1), date(y, 10, 1)) for y in (2023, 2024, 2025)] + [(date(2026, 8, 1), date.today())]
    days = [a + timedelta(days=i) for a, b in spans for i in range((b - a).days)]
    for d in days:
        game_day = d.isoformat(); night_before = (d - timedelta(days=1)).strftime("%m/%d/%Y")
        if game_day not in out:
            r = subprocess.run(["curl", "-s", f"https://statsapi.mlb.com/api/v1/standings?leagueId=103,104&season={d.year}&date={night_before}&standingsTypes=regularSeason&hydrate=team"],
                               capture_output=True, text=True)
            st = {}
            for rec in json.loads(r.stdout).get("records", []):
                for t in rec["teamRecords"]:
                    ab = t["team"].get("abbreviation") or AB.get(t["team"]["name"])
                    elim = t.get("eliminationNumber") == "E" and t.get("wildCardEliminationNumber") in ("E", None)
                    st[ab] = "clinched" if t.get("clinched") else "eliminated" if elim else "race"
            out[game_day] = st
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    json.dump(out, open(OUT, "w"))
    for k in sorted(out)[-1:] + [k for k in sorted(out) if k.endswith("-01")]:
        v = out[k]; print(k, {s: sum(1 for x in v.values() if x == s) for s in ("clinched", "race", "eliminated")})
