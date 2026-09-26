"""MLB same-game correlations, measured (research).

    python3 research/sgp_mlb.py          # prints the table, writes sgp_mlb.json

Every pair of legs the MLB slip can hold, over every 2026 start, fit as a
copula ρ (sgp_core.py) with each leg's own model probability as its margin:

  HR legs     the v1 odds (mlb_hr_replay.py), every starter-game
  K / BB legs the pitcher board's projection (mlb_kbb_replay.py), each start
              at its near-even rung — the line the board quotes

ρ > 0 legs rise together; ρ < 0 one works against the other. The CI comes from
resampling whole games.
"""
import json, os, sys
import numpy as np, pandas as pd
from scipy.stats import poisson
sys.path.insert(0, os.path.dirname(__file__))
import mlb_hr_replay as R
from sgp_core import fit_rho

HERE = os.path.dirname(os.path.abspath(__file__))


def hr_frame():
    df, _, _, _ = R.v1_frame()
    d = df[df.season == 2026].copy()
    w, _ = R.fit_logistic(R.design(d, R.V1), d.y.to_numpy())
    z = R.design(d, R.V1) @ w
    a = 0.0
    for _ in range(60):
        q = 1 / (1 + np.exp(-(a + R.PLATT_B * z))); a += (d.y.mean() - q.mean()) / (q * (1 - q)).mean()
    d["p"] = 1 / (1 + np.exp(-(a + R.PLATT_B * z)))
    d["hr1"] = d.y > 0
    return d[["date", "game_pk", "team", "pid", "slot", "opp_sp", "p", "hr1"]]


def even_rung(mu):
    """The half-line whose over is closest to a coin flip — what the board quotes."""
    Ls = np.arange(0.5, 15, 1.0)
    pr = 1 - poisson.cdf(np.floor(Ls)[:, None], mu[None, :])
    i = np.abs(pr - 0.5).argmin(axis=0)
    return Ls[i], pr[i, np.arange(len(mu))]


def kbb_frame(hr):
    k = pd.read_parquet(os.path.join(HERE, "mlb_kbb_replay.parquet"))
    k["pid"] = k.pid.astype(int)
    k["kL"], k["pK"] = even_rung(k.k_proj.to_numpy())
    k["bL"], k["pB"] = even_rung(k.bb_proj.to_numpy())
    k["yK"] = k.k > k.kL; k["yB"] = k.bb > k.bL
    # the game: the start is the opp_sp on the batter rows facing him that day
    g = hr[["date", "opp_sp", "game_pk"]].drop_duplicates(["date", "opp_sp"]).rename(columns={"opp_sp": "pid"})
    return k.merge(g, on=["date", "pid"], how="inner")


def main():
    hr = hr_frame(); ks = kbb_frame(hr)
    print(f"batter-games {len(hr)}, starts {len(ks)} (joined to a game)")
    out = {}

    def rec(key, lab, res):
        out[key] = {**res, "label": lab}
        ci = f"[{res['lo']:+.3f}, {res['hi']:+.3f}]" if res["lo"] is not None else ""
        print(f"{lab:52s} ρ {res['rho']:+.3f} {ci:18s} n {res['n']:7d}  both {res['obs_both']*100:6.3f}% vs indep {res['indep_both']*100:6.3f}%  lift {res['lift_at_avg']:.3f}")

    # HR + HR
    g = hr.merge(hr, on="game_pk", suffixes=("_a", "_b"))
    g = g[g.pid_a < g.pid_b]
    same = g[g.team_a == g.team_b]; opp = g[g.team_a != g.team_b]
    adj = same[(same.slot_a - same.slot_b).abs() == 1]; nonadj = same[(same.slot_a - same.slot_b).abs() > 1]
    for key, lab, d in (("hr_hr_team", "HR + HR · teammates", same), ("hr_hr_team_adj", "HR + HR · teammates, back-to-back in the order", adj),
                        ("hr_hr_team_nonadj", "HR + HR · teammates, not adjacent", nonadj), ("hr_hr_opp", "HR + HR · opponents", opp)):
        rec(key, lab, fit_rho(d.p_a, d.p_b, d.hr1_a, d.hr1_b, groups=d.game_pk))

    # same pitcher: Ks and walks
    rec("k_bb_same", "K over + BB over · same pitcher", fit_rho(ks.pK, ks.pB, ks.yK, ks.yB, groups=ks.game_pk))
    # pitcher vs the batters facing him
    vs = hr.merge(ks.rename(columns={"pid": "opp_sp"})[["opp_sp", "date", "game_pk", "pK", "yK", "pB", "yB"]], on=["opp_sp", "date", "game_pk"])
    rec("k_hr_opp", "SP K over + an opposing batter's HR", fit_rho(vs.pK, vs.p, vs.yK, vs.hr1, groups=vs.game_pk))
    rec("bb_hr_opp", "SP BB over + an opposing batter's HR", fit_rho(vs.pB, vs.p, vs.yB, vs.hr1, groups=vs.game_pk))
    # pitcher and his own lineup
    ks2 = ks.rename(columns={"pid": "sp"})
    own = hr.merge(ks2[["team", "date", "game_pk", "pK", "yK"]], on=["team", "date", "game_pk"])
    rec("k_hr_own", "SP K over + his own teammate's HR", fit_rho(own.pK, own.p, own.yK, own.hr1, groups=own.game_pk))
    # the two starters
    two = ks.merge(ks, on="game_pk", suffixes=("_a", "_b")); two = two[two.pid_a < two.pid_b]
    rec("k_k_opp", "K over + K over · the two starters", fit_rho(two.pK_a, two.pK_b, two.yK_a, two.yK_b, groups=two.game_pk))
    rec("bb_bb_opp", "BB over + BB over · the two starters", fit_rho(two.pB_a, two.pB_b, two.yB_a, two.yB_b, groups=two.game_pk))
    rec("k_bb_opp", "K over + the other starter's BB over", fit_rho(np.r_[two.pK_a, two.pK_b], np.r_[two.pB_b, two.pB_a], np.r_[two.yK_a, two.yK_b], np.r_[two.yB_b, two.yB_a], groups=np.r_[two.game_pk, two.game_pk]))
    json.dump(out, open(os.path.join(HERE, "sgp_mlb.json"), "w"), indent=1)
    print("wrote research/sgp_mlb.json")


if __name__ == "__main__":
    main()
