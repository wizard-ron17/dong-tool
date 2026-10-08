"""Frank's position angle, carried to blocked shots and goalie saves (2026-10-07).

    python3 research/nhl_bks_saves_angles.py

nhl_sog_angles.py found one live idea for shots: what the opponent allows to a POSITION.
Blocks and saves both live off the opponent's shooting, so the same idea, turned around:

  Blocks (shipped model already has the opponent's attempts a game, all skaters)
    opp_cf_D / opp_cf_F  the opponent's attempts by its defencemen / its forwards: point
                         shots are the blockable ones
    opp_blk_share        share of the opponent's attempts that get blocked (its style:
                         shooting through traffic, or not)
  Saves and goals allowed (shipped saves model has opponent shots-for, own shots against)
    opp_d_share          share of the opponent's shots on goal its defencemen take: point
                         shots score less, so more saves per shot, fewer goals
    opp_shpct            the opponent's goals per shot on goal

Every team prior uses games strictly before the row (last 40, shrunk 10 toward the league).
Scored walk-forward on each shipped model's own ladder log loss, per test season, with a
paired t for blocks (per player-game) so a gain can be told from noise.
"""
import os, sys
import numpy as np
import pandas as pd

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
WIN, K = 40, 10


def team_prior(df, key, val, out):
    df = df.sort_values("date").copy()
    g = df.groupby(key, sort=False)[val]
    s = g.transform(lambda x: x.shift(1).rolling(WIN, min_periods=1).sum()).fillna(0)
    n = g.transform(lambda x: x.shift(1).rolling(WIN, min_periods=1).count()).fillna(0)
    lg = df[val].mean()
    df[out] = (s + K * lg) / (n + K)
    return df, lg


def club_shooting():
    """Per club-game: attempts, unblocked attempts and shots on goal, by role; goals."""
    S = pd.read_parquet(os.path.join(HERE, "nhl_sog.parquet"))
    g = S.groupby(["date", "team", "role"]).agg(icf=("icf", "sum"), iff=("iff", "sum"), sog=("sog", "sum"), goals=("goals", "sum")).unstack("role")
    g.columns = [f"{a}_{b}" for a, b in g.columns]
    g = g.fillna(0).reset_index()
    for c in ("icf", "iff", "sog", "goals"): g[c] = g[f"{c}_F"] + g[f"{c}_D"]
    g["blk_share"] = (g.icf - g.iff) / g.icf.clip(lower=1)
    g["d_share"] = g.sog_D / g.sog.clip(lower=1)
    g["shpct"] = g.goals / g.sog.clip(lower=1)
    out, lg = g[["date", "team"]].copy(), {}
    for val, name in (("icf_D", "cfD"), ("icf_F", "cfF"), ("blk_share", "blk_share"), ("d_share", "d_share"), ("shpct", "shpct")):
        p, lg[name] = team_prior(g[["date", "team", val]], "team", val, name)
        out = out.merge(p[["date", "team", name]], on=["date", "team"])
    return out, lg


def tstat(base, new):
    d = base - new
    return d.mean() / (d.std() / np.sqrt(len(d)))


def blocks(C, lg):
    import nhl_phys as P
    D, LOG = P.build()
    D = D.merge(C.rename(columns={"team": "opp"}), on=["date", "opp"], how="left")
    for c in ("cfD", "cfF", "blk_share"):
        D["log_opp_" + c] = np.log(D[c].fillna(lg[c]) / lg[c])
    D["opp_cfD_x_D"] = D.log_opp_cfD * (D.role == "D")          # do the defencemen block the point shots?
    base = ["log_bks_prior", "log_bks_l5", "log_bks_l10", "log_toi_prior", "log_toi_l5", "log_shtoi_l5",
            "log_opp_cf_prior", "log_arena_bks", "underdog"]          # the shipped blocks model
    no_cf = [f for f in base if f != "log_opp_cf_prior"]
    tests = [("shipped blocks model", base),
             ("+ opponent's blocked-attempt share", base + ["log_opp_blk_share"]),
             ("opp attempts split F / D (replaces all)", no_cf + ["log_opp_cfF", "log_opp_cfD"]),
             ("  ... + D attempts x he's a defenceman", no_cf + ["log_opp_cfF", "log_opp_cfD", "opp_cfD_x_D"]),
             ("split + blocked share", no_cf + ["log_opp_cfF", "log_opp_cfD", "log_opp_blk_share"])]
    print(f"\nBLOCKED SHOTS  ({len(D):,} skater-games; NB ladder log loss over lines {P.LINES['bks']})")
    b0, _ = P.walk(D, "bks", base)
    for name, f in tests:
        l, Pp = P.walk(D, "bks", f)
        per = []
        for s in sorted(D.season.unique())[1:]:
            m = (D.loc[Pp.index, "season"] == s).to_numpy()
            per.append(f"{(l[m].mean() / b0[m].mean() - 1) * 100:+.2f}%")
        print(f"  {name:44s} {l.mean():.5f}  {(l.mean() / b0.mean() - 1) * 100:+.2f}%  t {tstat(b0, l):+5.2f}   {'  '.join(per)}")
    return D


def saves(C, lg):
    # nhl_saves' league-level offset reads the raw game cache (/tmp/nhl-cache), gone on this
    # machine; the parquet carries every start's saves, which is all that level needs. The
    # shipped model and each test share it, so the comparison is like for like.
    import nhl_saves_data
    nhl_saves_data.load_goalies = lambda: pd.read_parquet(os.path.join(HERE, "nhl_saves.parquet"))
    import nhl_saves as S
    D = S.D.merge(C.rename(columns={"team": "opp"}), on=["date", "opp"], how="left")
    D["rel_opp_d_share"] = np.log(D.d_share.fillna(lg["d_share"]) / lg["d_share"])
    D["rel_opp_shpct"] = np.log(D.shpct.fillna(lg["shpct"]) / lg["shpct"])
    S.D = D
    base_sv = list(S.SV_REL)
    print(f"\nGOALIE SAVES  ({len(D):,} starts; two-component NB ladder over lines {S.SV_LINES})")
    res = {}
    for name, f in [("shipped saves model", base_sv), ("+ opponent's D share of shots", base_sv + ["rel_opp_d_share"]),
                    ("+ opponent's shooting %", base_sv + ["rel_opp_shpct"]),
                    ("+ both", base_sv + ["rel_opp_d_share", "rel_opp_shpct"])]:
        S.SV_REL = f
        per = []
        for s in S.SEASONS[1:]:
            tr, te = D[D.season < s], D[D.season == s]
            m = S.sv_fit(tr); mu = m["mu_of"](te); y = te.sv.to_numpy(float)
            per.append(float(np.mean([S.ll(S.sv_sf(L, mu, m), (y > L).astype(float)) for L in S.SV_LINES])))
        res[name] = per
        b = res["shipped saves model"]
        n = [len(D[D.season == s]) for s in S.SEASONS[1:]]
        tot, btot = np.average(per, weights=n), np.average(b, weights=n)
        print(f"  {name:44s} {tot:.5f}  {(tot / btot - 1) * 100:+.2f}%   " + "  ".join(f"{(p / q - 1) * 100:+.2f}%" for p, q in zip(per, b)))
    S.SV_REL = base_sv
    print(f"\nGOALS ALLOWED  (binomial ladder over lines {S.GA_LINES})")
    gb = S.walk(S.GA_SHIPPED, "ga")["ll"]
    for name, f in [("shipped goals-allowed model", S.GA_SHIPPED), ("+ opponent's D share of shots", S.GA_SHIPPED + ["rel_opp_d_share"]),
                    ("+ opponent's shooting %", S.GA_SHIPPED + ["rel_opp_shpct"])]:
        r = S.walk(f, "ga")["ll"]
        print(f"  {name:44s} {r:.5f}  {(r / gb - 1) * 100:+.2f}%")


if __name__ == "__main__":
    C, lg = club_shooting()
    print("club priors (league):", {k: round(v, 3) for k, v in lg.items()})
    for c in ("cfD", "cfF", "blk_share", "d_share", "shpct"):
        v = C[c] / lg[c]
        print(f"  spread {c:10s}: 10th pct {v.quantile(0.1):.2f}x  90th {v.quantile(0.9):.2f}x")
    if "--saves" not in sys.argv: blocks(C, lg)
    if "--blocks" not in sys.argv: saves(C, lg)
