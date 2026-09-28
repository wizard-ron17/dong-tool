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
    D["early"] = np.exp(-D.n_prior.fillna(0) / 3)                       # his season games so far: 1 in the first, ~0 by the tenth
    base = ["m3", "m5", "m10", "mseason", "mprev", "start10", "vacated", "vac_pos", "abs_sp", "b2b", "rest", "early"]
    lineup = base + ["st", "st_x_sp", "vac_x_st"]
    mins = {}
    for name, cols in (("pre", base), ("lineup", lineup)):
        X = np.column_stack([np.ones(len(D))] + [D[c].values for c in cols])
        b = np.linalg.lstsq(X, D["min"].values, rcond=None)[0]
        resid = D["min"].values - X @ b
        mins[name] = {"cols": cols, "coef": dict(zip(["const"] + cols, [float(x) for x in b])), "sd": float(resid.std())}
    abs_sp_med = float(D.spread.abs().median())

    # threes: research/nba_threes_form2.py's model (recent form + drought), fit on every season
    import nba_threes_form2 as T2
    threes = T2.export_threes()
    T = pd.read_parquet(os.path.join(HERE, "nba_minutes.parquet"))
    for c in ("tpm", "min"): T[c] = T[c].astype(float).fillna(0)
    T["fam"] = T.fam.fillna("?")
    T["implied"] = T.total / 2 - T.spread / 2
    seasons = sorted(T.season.unique())
    tg = pd.read_parquet(os.path.join(HERE, "nba_team_games.parquet"))[["gid", "team", "opp", "date", "season", "tpm"]]
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
        "trained": [str(s) for s in seasons], "rows_minutes": int(len(D)), "rows_threes": threes["rows"],
        "minutes": {**mins, "abs_sp_median": abs_sp_med, "rotation_min": 10, "new_absence_games": 3},
        "threes": threes,
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
