"""Minutes: the NBA's snap share / ice time (research).

    python3 research/nba_minutes.py

nba_dispersion.py showed that given his minutes, most box stats are close to
Poisson — the pre-game variance IS minutes. So every NBA ladder rests on a
minutes projection. Target: minutes in a game he plays (books void a prop
when a player sits). Everything below is knowable before tip:

  recent     minutes over his last 3 / 5 / 10 played games, season to date,
             last season (all strictly before this game)
  role       starting tonight (lineups post ~30 min before tip — shown both
             with and without it), share of his last 10 he started
  vacated    minutes his rotation teammates usually play (last-10 average,
             10+ min players) who are out tonight — the NFL "mates out"
  script     |spread| (blowouts sit starters) and its interaction with
             starting; team back-to-back; days since his last game
Least squares on his minutes, fit on earlier seasons, scored on the next.
Baselines: last-5 average and season average. Reports MAE / RMSE and the
residual spread, which the ladders need (a minutes distribution, not a point).
"""
import glob, json, os
import numpy as np
import pandas as pd

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "nba_minutes.parquet")


def load():
    rows = []
    for f in glob.glob(os.path.join(HERE, ".cache", "nba", "*", "*.json")):
        d = json.load(open(f)); g = d["game"]
        sp = g.get("spread")
        for p in d["players"]:
            home = p["team"] == g["home"]
            rows.append({"gid": g["id"], "date": g["date"], "season": g["season"], "type": g["type"], "team": p["team"],
                         "home": home, "spread": (sp if home else -sp) if sp is not None else np.nan,   # his team's line (negative = favoured)
                         "pid": p["pid"], "name": p["name"], "pos": p.get("pos"), "starter": p["starter"],
                         "dnp": p["dnp"] or not (p.get("min") or 0) > 0, "min": p.get("min") or 0.0,
                         "opp": g["away"] if home else g["home"], "total": g.get("total"),
                         **{k: p.get(k) for k in ("pts", "fgm", "fga", "tpm", "tpa", "ftm", "fta", "oreb", "dreb", "reb", "ast", "stl", "blk", "to")}})
    return pd.DataFrame(rows)


def features(P):
    P = P.sort_values(["pid", "date", "gid"]).reset_index(drop=True)
    P["dt"] = pd.to_datetime(P.date)
    played = P[~P.dnp].copy()
    g = played.groupby("pid")["min"]
    for n in (3, 5, 10):
        played[f"m{n}"] = g.transform(lambda s: s.shift(1).rolling(n, min_periods=1).mean())
    played["start10"] = played.groupby("pid").starter.transform(lambda s: s.astype(float).shift(1).rolling(10, min_periods=1).mean())
    played["n_prior"] = played.groupby(["pid", "season"]).cumcount()
    played["mseason"] = played.groupby(["pid", "season"])["min"].transform(lambda s: s.shift(1).expanding().mean())
    last = played.groupby(["pid", "season"])["min"].mean().rename("mprev").reset_index()
    seasons = sorted(P.season.unique()); nxt = {s: seasons[i + 1] for i, s in enumerate(seasons[:-1])}
    last["season"] = last.season.map(nxt); played = played.merge(last.dropna(), on=["pid", "season"], how="left")
    # carry each player's latest pre-game rolling minutes onto EVERY row (played or not), for vacated minutes
    P = P.merge(played[["gid", "pid", "m3", "m5", "m10", "start10", "n_prior", "mseason", "mprev"]], on=["gid", "pid"], how="left")
    P = P.sort_values(["pid", "date", "gid"])
    P["m10_any"] = P.groupby("pid").m10.transform(lambda s: s.ffill())
    # a DNP row carries his last-10 as it stood (the ffill from his last played game shifts by one game — close enough pre-game)
    # vacated = NEW absences only: rotation players (10+ min last-10) who played in one of the
    # team's last three games and are out tonight. A player out for months keeps his old
    # last-10, but his minutes were redistributed long ago — counting him hides the signal.
    tgo = P.drop_duplicates(["gid", "team"])[["team", "date", "gid"]].sort_values(["team", "date", "gid"])
    tgo["tn"] = tgo.groupby("team").cumcount()
    P = P.merge(tgo[["gid", "team", "tn"]], on=["gid", "team"], how="left")
    P = P.sort_values(["pid", "team", "tn"])
    P["played_tn"] = np.where(~P.dnp, P.tn, np.nan)
    P["last_played_tn"] = P.groupby(["pid", "team"]).played_tn.transform(lambda s: s.shift(1).ffill())
    new_out = P.dnp & (P.m10_any >= 10) & ((P.tn - P.last_played_tn) <= 3)
    vac = P[new_out].groupby(["gid", "team"]).m10_any.sum().rename("vacated")
    P = P.merge(vac, on=["gid", "team"], how="left"); P["vacated"] = P.vacated.fillna(0.0)
    # his share of it: same listed position as the absentee (G/F/C family)
    fam = lambda x: {"PG": "G", "SG": "G", "G": "G", "SF": "F", "PF": "F", "F": "F", "C": "C"}.get(x or "", "?")
    P["fam"] = P.pos.map(fam)
    vp = P[new_out].groupby(["gid", "team", "fam"]).m10_any.sum().rename("vac_pos")
    P = P.merge(vp, on=["gid", "team", "fam"], how="left"); P["vac_pos"] = P.vac_pos.fillna(0.0)
    # rest
    P["prev_dt"] = P.groupby("pid").dt.shift(1)
    P["rest"] = (P.dt - P.prev_dt).dt.days.clip(upper=7).fillna(7)
    tg = P.drop_duplicates(["gid", "team"])[["team", "dt", "gid"]].sort_values(["team", "dt"])
    tg["b2b"] = (tg.groupby("team").dt.diff().dt.days == 1).astype(float)
    P = P.merge(tg[["gid", "team", "b2b"]], on=["gid", "team"], how="left")
    return P


def main():
    P = features(load())
    D = P[(~P.dnp) & P.m5.notna() & (P.type == 2)].copy()
    D["mprev"] = D.mprev.fillna(D.m10); D["mseason"] = D.mseason.fillna(D.m10)
    D["abs_sp"] = D.spread.abs().fillna(D.spread.abs().median())
    D["st"] = D.starter.astype(float)
    D["st_x_sp"] = D.st * D.abs_sp
    D["vac_x_st"] = D.vacated * D.st
    base_cols = ["m3", "m5", "m10", "mseason", "mprev", "start10", "vacated", "vac_pos", "abs_sp", "b2b", "rest"]
    with_st = base_cols + ["st", "st_x_sp", "vac_x_st"]
    seasons = sorted(D.season.unique())
    res = {k: [] for k in ("last 5", "season avg", "model, no lineup", "model + starting tonight")}
    for s in seasons[2:]:
        tr, te = D[D.season < s], D[D.season == s]
        y = te["min"].values
        res["last 5"].append(te.m5.values - y); res["season avg"].append(te.mseason.values - y)
        for name, cols in (("model, no lineup", base_cols), ("model + starting tonight", with_st)):
            X = np.column_stack([np.ones(len(tr))] + [tr[c].values for c in cols])
            b = np.linalg.lstsq(X, tr["min"].values, rcond=None)[0]
            Xe = np.column_stack([np.ones(len(te))] + [te[c].values for c in cols])
            res[name].append(Xe @ b - y)
            if name.startswith("model +"): D.loc[te.index, "mproj"] = Xe @ b
            else: D.loc[te.index, "mproj_nolu"] = Xe @ b
            if s == seasons[-1] and name.startswith("model +"): coef = dict(zip(["const"] + cols, b))
    D.to_parquet(OUT)                       # every row's walk-forward minutes projection, for the ladders
    print(f"{len(D):,} played regular-season games scored walk-forward from {seasons[2]}\n")
    print(f"{'minutes projection':28s} {'MAE':>6s} {'RMSE':>6s}")
    for k, v in res.items():
        e = np.concatenate(v); print(f"{k:28s} {np.abs(e).mean():6.2f} {np.sqrt((e ** 2).mean()):6.2f}")
    print("\nlast fit (with the lineup):")
    for k, v in coef.items(): print(f"  {k:10s} {v:+.3f}")
    e = np.concatenate(res["model + starting tonight"]); te = D[D.season.isin(seasons[2:])]
    print(f"\nresidual SD by projected band (the minutes distribution the ladders need):")
    proj = te["min"].values + e
    for lo, hi in ((0, 15), (15, 25), (25, 32), (32, 48)):
        m = (proj >= lo) & (proj < hi); print(f"  projected {lo}-{hi}: SD {e[m].std():.2f}  (n {m.sum():,})")
    V = te.assign(err=e)
    print(f"\nnew absences: {(te.vacated > 0).mean():.1%} of rows have some; the last-5 average misses by {(te.m5 - te['min'])[te.vacated >= 20].mean():+.2f} min when 20+ are vacated, the model by {V[V.vacated >= 20].err.mean():+.2f}")
    print(f"vacated minutes: rows with 20+ vacated, mean error {V[V.vacated >= 20].err.mean():+.2f} (n {(V.vacated >= 20).sum():,}) vs {V[V.vacated == 0].err.mean():+.2f} with none")


if __name__ == "__main__":
    main()
