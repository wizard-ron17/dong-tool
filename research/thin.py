"""Receptions and yards baselines for players with no usable history (rookies,
fewer than 3 prior games) — the players the main models exclude.

The only pre-game fact about a rookie is his role, and scripts/picks.js
already turns the depth chart into a snap share for him. So the baseline is
empirical: across every 2017-2025 player-game where the player had fewer than
3 prior games and played a real role (25%+ of snaps), what did players at his
position and snap tier actually catch and gain? Prices come straight from that
distribution — no fitted curve — within position x snap tier:

    tiers: 25-45%, 45-65%, 65%+ of snaps     positions: WR, TE, RB

Caveat, measured below: the tiers are built from snaps actually played, while
the board assigns a tier from the depth-chart estimate. Checked out of sample
(cells built on 2017-2022, priced on 2023-2025).

    python3 research/thin.py            # validation
    python3 research/thin.py --export   # -> thin_model.json
"""
import json, os, sys, warnings
warnings.filterwarnings("ignore")
import numpy as np
import pandas as pd

sys.path.insert(0, os.path.dirname(__file__))
import yards as Y   # noqa: E402

HERE = os.path.dirname(__file__)
TIERS = [0.25, 0.45, 0.65, 1.01]
QN = 41
TARGETS = {"rec": "receptions", "ryds": "receiving yards", "rush": "rushing yards", "rr": "rush + rec yards"}


def frame():
    d = Y.load_pbp(port=True)
    sk, _ = Y.skill_frame(d)
    rp = pd.read_parquet(os.path.join(HERE, "receptions.parquet"))[["game_id", "pid", "rec"]]
    q = sk.merge(rp, on=["game_id", "pid"], how="left")
    # 2016 is the first season on file, so every veteran's first games that year
    # look like "fewer than 3 prior games" (747 rows vs ~120 a season after) —
    # it filled the cells with veterans and over-priced rookies by ~5 points.
    q = q[(q.season >= 2017) & (q.games_prior < 3) & q.position.isin(["WR", "TE", "RB"]) & (q.snap_pct >= TIERS[0])].copy()
    q["tier"] = pd.cut(q.snap_pct, TIERS, labels=False, right=False)
    q["rec"] = q.rec.fillna(0)
    return q


def cells(q, y):
    out = {}
    for (pos, t), g in q.groupby(["position", "tier"]):
        out[f"{pos}|{int(t)}"] = [round(float(v), 2) for v in np.quantile(g[y], np.linspace(0, 1, QN))]
    return out


def p_over(qs, line):
    """P(Y > line) from stored quantiles; ties in counts handled by the
    empirical step (share of quantiles strictly above the line)."""
    qs = np.asarray(qs)
    above = (qs > line).mean()
    return float(np.clip(above, 0.005, 0.995))


def main():
    q = frame()
    tr, te = q[q.season <= 2022], q[q.season >= 2023]
    print(f"rookie/newcomer player-games with a real role: {len(q):,} (train 2017-22 {len(tr):,}, test 2023-25 {len(te):,})")
    print("  cell sizes:", q.groupby(["position", "tier"]).size().to_dict())
    for y, lab in TARGETS.items():
        c = cells(tr, y)
        said, hit, rows = [], [], 0
        for _, r in te.iterrows():
            qs = c.get(f"{r.position}|{int(r.tier)}")
            if qs is None: continue
            med = np.median(qs)
            for L in (np.floor(med) - 0.5 if y == "rec" else np.floor(med * 0.75) + 0.5, np.floor(med) + 0.5, np.floor(med * 1.3) + 0.5):
                if L <= 0: continue
                said.append(p_over(qs, L)); hit.append(r[y] > L)
            rows += 1
        print(f"  {lab:18s} n={rows:,}  said {np.mean(said):.3f} hit {np.mean(hit):.3f}  "
              f"· medians WR/TE/RB by tier: " + " | ".join(
                  f"{p} " + "/".join(f"{np.median(c.get(f'{p}|{t}', [0])):.0f}" for t in range(3)) for p in ("WR", "TE", "RB")))


def export():
    q = frame()
    out = {"note": ("Empirical baselines for players with fewer than 3 prior games: quantiles of catches "
                    "and yards by position x snap tier, 2017-2025 rookie/newcomer games with 25%+ snaps."),
           "tiers": TIERS, "markets": {y: cells(q, y) for y in TARGETS},
           "n": {f"{p}|{int(t)}": int(n) for (p, t), n in q.groupby(["position", "tier"]).size().items()}}
    json.dump(out, open(os.path.join(HERE, "thin_model.json"), "w"), indent=1)
    print("wrote thin_model.json", out["n"])


if __name__ == "__main__":
    export() if "--export" in sys.argv else main()
