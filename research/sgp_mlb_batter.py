"""MLB same-game correlations for the batter Ks / walks legs (research, 2026-10-09).

    python3 research/sgp_mlb_batter.py      # prints the table, writes sgp_mlb_batter.json

The batter Ks / BB board (mlb_batter_kbb.py, priced in the build) put new legs on the
slip. Before they can sit in a parlay with the pitcher K / BB legs and the HR legs,
every pair needs a measured ρ, the same way sgp_mlb.py measured the others: a Gaussian
copula fit over every 2026 batter-game, each leg's own walk-forward model probability
as its margin (so ρ is only what is left after the prices), CI from resampling games.

Batter legs are scored at 1+ (the rung nearest even money for most bats is 0.5 or 1.5;
K 2+ is checked too, to see the ρ holds on the higher rung).
"""
import json, os, sys
import numpy as np, pandas as pd
sys.path.insert(0, os.path.dirname(__file__))
import mlb_batter_kbb as B
import sgp_mlb as S
from sgp_core import fit_rho

HERE = os.path.dirname(os.path.abspath(__file__))


def batter_frame():
    d = B.load(); bg = B.build(d)
    bg = bg[(bg.b_cur_pa1 + bg.b_prv_pa1 >= 30) & (bg.opp_sp > 0)]
    dist = B.pa_dist(bg[bg.season == 2025])
    params = json.load(open(os.path.join(HERE, "mlb_batter_kbb.json")))
    te = bg[bg.season == 2026].copy()
    for which in ("k", "bb"):
        prm = tuple(params[which + "_params"][k] for k in ("K0b", "K0p", "K0pen", "prev_w"))
        r = B.evaluate(te, which, prm, dist, "")
        for key, v in r.items():
            m = key[len(which):-1]
            te[f"p{which}{m}"], te[f"y{which}{m}"] = v["p"], v["y"].astype(bool)
    te = te.rename(columns={"batter": "pid", "bat_team": "team"})
    te["pid"] = te.pid.astype(int); te["opp_sp"] = te.opp_sp.astype(int)
    return te


def main():
    bt = batter_frame()
    hr = S.hr_frame(); ks = S.kbb_frame(hr)
    print(f"batter-games {len(bt):,}; HR rows {len(hr):,}; starts {len(ks):,}")
    out = {}

    def rec(key, lab, a, b, ya, yb, g):
        res = fit_rho(a, b, ya, yb, groups=g)
        out[key] = {**res, "label": lab}
        ci = f"[{res['lo']:+.3f}, {res['hi']:+.3f}]" if res["lo"] is not None else ""
        print(f"{lab:56s} ρ {res['rho']:+.3f} {ci:18s} n {res['n']:7d}  lift {res['lift_at_avg']:.3f}")

    # the batter against the starter he faces
    vs = bt.merge(ks.rename(columns={"pid": "opp_sp"})[["opp_sp", "game_pk", "pK", "yK", "pB", "yB"]], on=["opp_sp", "game_pk"])
    rec("bk_spk", "batter K 1+ + the starter he faces K over", vs.pk1, vs.pK, vs.yk1, vs.yK, vs.game_pk)
    rec("bk2_spk", "batter K 2+ + the starter he faces K over", vs.pk2, vs.pK, vs.yk2, vs.yK, vs.game_pk)
    rec("bbb_spbb", "batter BB 1+ + the starter he faces BB over", vs.pbb1, vs.pB, vs.ybb1, vs.yB, vs.game_pk)
    rec("bk_spbb", "batter K 1+ + the starter he faces BB over", vs.pk1, vs.pB, vs.yk1, vs.yB, vs.game_pk)
    rec("bbb_spk", "batter BB 1+ + the starter he faces K over", vs.pbb1, vs.pK, vs.ybb1, vs.yK, vs.game_pk)

    # one batter: his Ks, walks and homer
    one = bt.merge(hr[["game_pk", "pid", "p", "hr1"]], on=["game_pk", "pid"])
    rec("bk_bbb_same", "batter K 1+ + his own BB 1+", bt.pk1, bt.pbb1, bt.yk1, bt.ybb1, bt.game_pk)
    rec("bk_hr_same", "batter K 1+ + his own HR", one.pk1, one.p, one.yk1, one.hr1, one.game_pk)
    rec("bbb_hr_same", "batter BB 1+ + his own HR", one.pbb1, one.p, one.ybb1, one.hr1, one.game_pk)

    # teammates (same pitcher, same night)
    tm = bt.merge(bt, on=["game_pk", "team"], suffixes=("_a", "_b")); tm = tm[tm.pid_a < tm.pid_b]
    rec("bk_bk_team", "batter K 1+ + teammate K 1+", tm.pk1_a, tm.pk1_b, tm.yk1_a, tm.yk1_b, tm.game_pk)
    rec("bbb_bbb_team", "batter BB 1+ + teammate BB 1+", tm.pbb1_a, tm.pbb1_b, tm.ybb1_a, tm.ybb1_b, tm.game_pk)
    th = bt.merge(hr[["game_pk", "team", "pid", "p", "hr1"]].rename(columns={"pid": "hpid"}), on=["game_pk", "team"])
    th = th[th.pid != th.hpid]
    rec("bk_hr_team", "batter K 1+ + a teammate's HR", th.pk1, th.p, th.yk1, th.hr1, th.game_pk)
    rec("bbb_hr_team", "batter BB 1+ + a teammate's HR", th.pbb1, th.p, th.ybb1, th.hr1, th.game_pk)

    # opponents (two lineups, two pitchers)
    op = bt.merge(bt, on="game_pk", suffixes=("_a", "_b")); op = op[op.team_a < op.team_b]
    rec("bk_bk_opp", "batter K 1+ + an opposing batter's K 1+", op.pk1_a, op.pk1_b, op.yk1_a, op.yk1_b, op.game_pk)
    # his own starter (pitching for his team)
    ks2 = ks.rename(columns={"pid": "sp"})[["team", "game_pk", "pK", "yK"]]
    own = bt.merge(ks2, on=["team", "game_pk"])
    rec("bk_ownspk", "batter K 1+ + his own starter's K over", own.pk1, own.pK, own.yk1, own.yK, own.game_pk)

    json.dump(out, open(os.path.join(HERE, "sgp_mlb_batter.json"), "w"), indent=1)
    print("wrote research/sgp_mlb_batter.json")


if __name__ == "__main__":
    main()
