"""Fit the NBA board models on every cached season and export them for the build.

    python3 research/nba_model_export.py        # -> research/nba_model.json

The build (scripts/build-nba.js, scripts/nba-models.js) applies these
coefficients; it never fits. Every input is defined here the way the build
computes it from nba/players.json — the NHL saves lesson: a research prior the
build can't reproduce prices wrong. research/nba_parity.mjs checks that match.

  minutes   least squares, two versions: before lineups post (no "starting
            tonight") and after. Inputs: his last 3/5/10 played games' minutes,
            season to date (else last 10), last season (else last 10), share of
            his last 10 he started, minutes NEWLY vacated by rotation teammates
            (10+ min last 10, played within the team's last 3 games, out
            tonight) in total and at his position family, |spread|, team
            back-to-back, days since his last game
  threes    Poisson GLM on made threes, log(projected minutes) as the offset:
            log(his 3PM per minute: season to date + 0.5 x last season, shrunk
            300 minutes to his position family's rate), log(team implied points
            / league), log(opponent 3PM allowed per game, shrunk 10 games, /
            league), home. Ladder: NB (alpha 0.1) mixed over minutes N(proj, 5.2)
"""
import json, os
import numpy as np
import pandas as pd
import nba_minutes as MN
import nba_threes as TH

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "nba_model.json")


def main():
    # minutes, fit on every season (research scores walk-forward; the export fits on all)
    P = MN.features(MN.load())
    D = P[(~P.dnp) & P.m5.notna() & (P.type == 2)].copy()
    D["mprev"] = D.mprev.fillna(D.m10); D["mseason"] = D.mseason.fillna(D.m10)
    D["abs_sp"] = D.spread.abs().fillna(D.spread.abs().median())
    D["st"] = D.starter.astype(float); D["st_x_sp"] = D.st * D.abs_sp; D["vac_x_st"] = D.vacated * D.st
    base = ["m3", "m5", "m10", "mseason", "mprev", "start10", "vacated", "vac_pos", "abs_sp", "b2b", "rest"]
    lineup = base + ["st", "st_x_sp", "vac_x_st"]
    mins = {}
    for name, cols in (("pre", base), ("lineup", lineup)):
        X = np.column_stack([np.ones(len(D))] + [D[c].values for c in cols])
        b = np.linalg.lstsq(X, D["min"].values, rcond=None)[0]
        resid = D["min"].values - X @ b
        mins[name] = {"cols": cols, "coef": dict(zip(["const"] + cols, [float(x) for x in b])), "sd": float(resid.std())}
    abs_sp_med = float(D.spread.abs().median())

    # threes: rebuild the research features on every season, fit once
    T = pd.read_parquet(os.path.join(HERE, "nba_minutes.parquet"))
    T = T.sort_values(["pid", "date", "gid"]).reset_index(drop=True)
    for c in ("tpm", "tpa", "min"): T[c] = T[c].astype(float).fillna(0)
    T["fam"] = T.fam.fillna("?")
    g = T.groupby(["pid", "season"])
    T["s_tpm"] = g.tpm.cumsum() - T.tpm; T["s_min"] = g["min"].cumsum() - T["min"]
    tot = T.groupby(["pid", "season"])[["tpm", "min"]].sum().reset_index()
    seasons = sorted(T.season.unique()); nxt = {s: seasons[i + 1] for i, s in enumerate(seasons[:-1])}
    tot["season"] = tot.season.map(nxt); tot = tot.dropna().rename(columns={"tpm": "p_tpm", "min": "p_min"})
    T = T.merge(tot, on=["pid", "season"], how="left").fillna({"p_tpm": 0, "p_min": 0})
    # league constants from LAST season (the first season uses its own): no look-ahead, and all
    # the live build can know — research/nba_parity.mjs checks it
    fr = T.groupby(["season", "fam"]).apply(lambda d: d.tpm.sum() / d["min"].sum(), include_groups=False).rename("fam_rate").reset_index()
    fr_prev = fr.assign(season=fr.season.map(nxt)).dropna()
    fr = pd.concat([fr_prev, fr[fr.season == min(fr.season)]]).drop_duplicates(["season", "fam"])
    T = T.merge(fr, on=["season", "fam"], how="left")
    T["rate"] = (T.s_tpm + 0.5 * T.p_tpm + 300 * T.fam_rate) / (T.s_min + 0.5 * T.p_min + 300)
    T["implied"] = T.total / 2 - T.spread / 2
    imp_s = T.groupby("season").implied.mean(); imp_prev = imp_s.shift(1).fillna(imp_s)
    lg_imp = T.season.map(imp_prev)
    T["imp_r"] = (T.implied / lg_imp).fillna(1.0)
    tg = T.groupby(["gid", "team", "opp", "date", "season"]).tpm.sum().reset_index().sort_values("date")
    n = tg.groupby(["season", "opp"]).cumcount()
    allowed = tg.groupby(["season", "opp"]).tpm.transform(lambda s: s.shift(1).expanding().mean())
    al_s = tg.groupby("season").tpm.mean(); al_prev = al_s.shift(1).fillna(al_s)
    lg_allow = tg.season.map(al_prev)
    tg["opp_r"] = ((allowed.fillna(lg_allow) * n + 10 * lg_allow) / (n + 10)) / lg_allow
    T = T.merge(tg[["gid", "team", "opp_r"]], on=["gid", "team"], how="left"); T["opp_r"] = T.opp_r.fillna(1.0)
    T = T[T.mproj.notna() & (T.mproj > 3)].copy()
    cols = ["lrate", "limp", "lopp", "home"]
    T["lrate"] = np.log(T.rate.clip(1e-4)); T["limp"] = np.log(T.imp_r.clip(0.5, 1.5)); T["lopp"] = np.log(T.opp_r.clip(0.5, 1.5))
    T["home"] = T.home.astype(float); T["off"] = np.log(T.mproj.clip(1))
    X = np.column_stack([np.ones(len(T))] + [T[c] for c in cols])
    b = TH.glm_poisson(X, T.tpm.values, T.off.values)
    last = seasons[-1]
    L = T[T.season == last]
    league = {
        "season": last,
        "fam_rate_3pm": {k: float(v) for k, v in T[T.season == last].groupby("fam").apply(lambda d: d.tpm.sum() / d["min"].sum(), include_groups=False).items()},
        "implied": float(L.implied.mean()),                                  # team implied points
        "tpm_allowed": float(tg[tg.season == last].tpm.mean()),              # 3PM a team allows per game
    }
    model = {
        "note": "NBA board models — research/nba_model_export.py. The build applies, never fits.",
        "trained": [str(s) for s in seasons], "rows_minutes": int(len(D)), "rows_threes": int(len(T)),
        "minutes": {**mins, "abs_sp_median": abs_sp_med, "rotation_min": 10, "new_absence_games": 3},
        "threes": {"cols": ["const"] + cols, "coef": dict(zip(["const"] + cols, [float(x) for x in b])),
                   "shrink_min": 300, "prev_weight": 0.5, "opp_shrink_games": 10, "alpha": 0.1, "sd_min": 5.2,
                   "clip": {"imp": [0.5, 1.5], "opp": [0.5, 1.5]}, "rungs": [1, 2, 3, 4, 5]},
        "league": league,
        "positions": {"PG": "G", "SG": "G", "G": "G", "SF": "F", "PF": "F", "F": "F", "C": "C", "GF": "F", "FC": "C"},
    }
    # keep the sections other scripts export into the same file (first basket: nba_firstbasket2.py)
    try:
        old = json.load(open(OUT))
        for k, v in old.items():
            if k not in model: model[k] = v
    except FileNotFoundError:
        pass
    json.dump(model, open(OUT, "w"), indent=1)
    print(f"wrote {OUT}")
    print("minutes (pre-lineup) sd %.2f · (lineup) sd %.2f" % (mins["pre"]["sd"], mins["lineup"]["sd"]))
    print("threes coef", {k: round(v, 3) for k, v in model["threes"]["coef"].items()})
    print("league", {k: (round(v, 4) if isinstance(v, float) else v) for k, v in league.items() if k != "fam_rate_3pm"}, {k: round(v, 4) for k, v in league["fam_rate_3pm"].items()})


if __name__ == "__main__":
    main()
