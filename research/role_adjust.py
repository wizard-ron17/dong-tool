"""Does the Picks board's depth/injury role adjustment help the other boards?

Picks resolves each team's snap shares before pricing (scripts/picks.js
normaliseTeamSnaps): players ruled out are gone, each position room is ordered
by depth, every player's last-3 snap share is blended 50/50 toward what his
depth rank historically plays, and the skill group is scaled to a 4.99 snap
budget. Validated for touchdowns on weeks 1-3 (log loss 0.41213 -> 0.41081).

Receptions and Yards use raw last-3 role features, so a backup promoted by an
injury keeps his backup numbers. The candidate fix: scale each player's
last-3 ROLE features (snap share, target share, carries, catches, yards) by
the same ratio the snap share moved, x = adjusted / raw.

Historical test, as close to the live board as the data allows:
  * "ruled out" = not in that game's snap pool (injuries and inactives are
    known before kickoff; players who played are the ones available)
  * depth order = last-3 snap share within team and position (the live board
    uses the published depth chart, which is better for exactly the case that
    matters — this test is therefore conservative)
  * identical blend, rotation sizes, budget and clamps to the port

    python3 research/role_adjust.py
"""
import os, sys, warnings
warnings.filterwarnings("ignore")
import numpy as np
import pandas as pd

sys.path.insert(0, os.path.dirname(__file__))
import yards as Y   # noqa: E402

DEPTH_PRIOR = {"RB": [0.589, 0.306, 0.105, 0.009], "WR": [0.818, 0.722, 0.552, 0.301, 0.132, 0.018],
               "TE": [0.701, 0.404, 0.176, 0.018], "FB": [0.093]}
DEPTH_W = 0.5
PER_TEAM_POS = {"RB": 4, "WR": 6, "TE": 3, "FB": 1}
BUDGET = 4.99
CLAMP = (0.5, 2.5)          # the ratio applied to role features


def adjust(q):
    q = q.copy()
    q["raw"] = q.snap_l3
    q = q.sort_values(["game_id", "team", "position", "snap_l3"], ascending=[True, True, True, False])
    q["rank"] = q.groupby(["game_id", "team", "position"]).cumcount()
    def prior(r):
        p = DEPTH_PRIOR.get(r.position, [])
        if not p: return r.snap_l3
        return p[r["rank"]] if r["rank"] < len(p) else p[-1] * 0.6 ** (r["rank"] - len(p) + 1)
    pr = np.array([prior(r) for _, r in q[["position", "rank", "snap_l3"]].iterrows()])
    q["blend"] = (1 - DEPTH_W) * q.snap_l3 + DEPTH_W * pr
    keep = q["rank"] < q.position.map(PER_TEAM_POS).fillna(3)
    tot = q[keep].groupby(["game_id", "team"]).blend.sum().rename("tot")
    q = q.merge(tot, on=["game_id", "team"], how="left")
    f = np.where(q.tot > 0.5, BUDGET / q.tot, 1.0)
    q["adj"] = q.blend * np.clip(f, 0.4, 2.0)
    q["x"] = np.clip(q.adj / q.raw.clip(lower=0.05), *CLAMP)
    return q


def main():
    d = Y.load_pbp(port=True)
    skill, _ = Y.skill_frame(d)
    rp = pd.read_parquet(os.path.join(Y.HERE, "receptions.parquet"))[["game_id", "pid", "rec", "rec_l3"]]
    skill = skill.merge(rp, on=["game_id", "pid"], how="left")
    skill = adjust(skill)
    role = ["snap_l3", "share_l3", "car_l3", "ryds_l3", "rush_l3", "rr_l3", "rec_l3"]
    adj = skill.copy()
    for c in role: adj[c] = adj[c] * adj.x
    print(f"role ratio x: median {skill.x.median():.2f}, 10th {skill.x.quantile(.1):.2f}, 90th {skill.x.quantile(.9):.2f}; "
          f"{(skill.x > 1.25).mean():.1%} of player-games scaled up 25%+")

    tests = {
        "receptions": ("rec", lambda q: q.position.isin(["WR", "TE", "RB"]) & (q.tgt_prior >= 2),
                       ["tgt_prior", "implied_total", "spread_own", "snap_l3", "share_l3", "rec_l3"]),
        "receiving yards": ("ryds", Y.MARKETS["rec"][2], Y.MARKETS["rec"][3]),
        "rushing yards (RB)": ("rush", Y.MARKETS["rush"][2], Y.MARKETS["rush"][3]),
        "rush + rec yards": ("rr", Y.MARKETS["rr"][2], Y.MARKETS["rr"][3]),
    }
    for lab, (y, pop, fs) in tests.items():
        for weeks, wlab in ((None, "all weeks"), ((1, 3), "weeks 1-3"), ("promoted", "backups promoted (x > 1.25)")):
            res = []
            for frame in (skill, adj):
                q = frame[pop(frame) & (frame.games_prior >= 3)].dropna(subset=fs + [y]).copy()
                if y + "_prior" not in q: q[y + "_prior"] = q["tgt_prior"] * 0.65
                q["line"] = np.floor(q[y + "_prior"]) + 0.5
                _, _, t = Y.walk(q, fs, y, "line")
                if weeks == "promoted":
                    ids = set(skill[skill.x > 1.25].set_index(["game_id", "pid"]).index)
                    t = t[[k in ids for k in zip(t.game_id, t.pid)]]
                elif weeks:
                    t = t[t.week.between(*weeks)]
                res.append(t)
            a, b = res
            m = a[["game_id", "pid", y, "mu"]].merge(b[["game_id", "pid", "mu"]], on=["game_id", "pid"], suffixes=("_raw", "_adj"))
            e_raw, e_adj = np.abs(m[y] - m.mu_raw), np.abs(m[y] - m.mu_adj)
            dd = e_adj - e_raw
            bias_raw, bias_adj = (m[y] - m.mu_raw).mean(), (m[y] - m.mu_adj).mean()
            print(f"  {lab:20s} {wlab:30s} n={len(m):6,}  MAE raw {e_raw.mean():6.2f} -> adjusted {e_adj.mean():6.2f} "
                  f"(t={dd.mean() / (dd.std(ddof=1) / np.sqrt(len(dd))):+5.1f})  bias {bias_raw:+.2f} -> {bias_adj:+.2f}")


if __name__ == "__main__":
    main()
