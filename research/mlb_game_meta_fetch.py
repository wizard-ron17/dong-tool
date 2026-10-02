"""Game conditions for the HR factor scan: day/night and the weather MLB
recorded at first pitch (condition, temperature, wind speed and direction
relative to the field: "12 mph, Out To LF"), one schedule call per month.

    python3 research/mlb_game_meta_fetch.py      # 2024-2026 -> .cache/mlb_game_meta.parquet
"""
import json, os, re, subprocess
import pandas as pd

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, ".cache", "mlb_game_meta.parquet")


def month(y, m):
    a = f"{y}-{m:02d}-01"; b = f"{y}-{m:02d}-{31 if m in (3, 5, 7, 8, 10) else 30}"
    url = f"https://statsapi.mlb.com/api/v1/schedule?sportId=1&startDate={a}&endDate={b}&gameType=R&hydrate=weather,venue"
    j = json.loads(subprocess.run(["curl", "-s", "--max-time", "60", url], capture_output=True).stdout or b"{}")
    rows = []
    for d in j.get("dates", []):
        for g in d["games"]:
            w = g.get("weather") or {}
            m_ = re.match(r"(\d+) mph,?\s*(.*)", w.get("wind") or "")
            rows.append({"game_pk": g["gamePk"], "date": d["date"], "day": g.get("dayNight") == "day", "venue": g["venue"]["name"],
                         "cond": w.get("condition"), "temp": float(w["temp"]) if w.get("temp") else None,
                         "wind_mph": float(m_.group(1)) if m_ else None, "wind_dir": (m_.group(2).strip() if m_ else None)})
    return rows


if __name__ == "__main__":
    rows = [r for y in (2024, 2025, 2026) for m in range(3, 11) for r in month(y, m)]
    df = pd.DataFrame(rows).drop_duplicates("game_pk")
    df.to_parquet(OUT)
    print(len(df), "games;", df.wind_dir.value_counts().head(12).to_dict(), "| roof/dome:", df.cond.isin(["Dome", "Roof Closed"]).sum())
