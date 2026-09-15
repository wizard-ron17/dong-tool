"""Next Gen Stats: does any of it improve the shipped models?

nflverse publishes NGS as weekly player aggregates (not per-play tracking),
2016-2026, only for weeks a player qualified: receivers 5+ targets, rushers
10+ carries, passers 15+ attempts. Rushing has no weekly rows for 2023.

For every player-game in each market's training frame, each NGS stat becomes
an as-of prior: the volume-weighted average over his qualifying NGS weeks
strictly before the game, inside the same 2-season window every other prior
uses, shrunk toward the league average by a pseudo-volume. Players with no
qualifying weeks sit at the league average (an indicator is tested too).

Each market keeps its shipped features as the base and adds NGS terms one at a
time, walk-forward 2019-2025, paired per-row test against the base.

    python3 research/ngs.py
"""
import os, sys, warnings
warnings.filterwarnings("ignore")
import numpy as np
import pandas as pd

sys.path.insert(0, os.path.dirname(__file__))
import yards as Y           # noqa: E402
import interceptions as I   # noqa: E402

HERE = os.path.dirname(__file__)
SCR = os.environ.get("NGS_DIR", "/private/tmp/claude-501/-Users-ron-Desktop-dong-tool/5857f821-b559-469c-a8ee-a9ffc542c6c6/scratchpad")


def load_ngs(kind):
    d = pd.read_csv(os.path.join(SCR, f"ngs_{kind}.csv.gz"))
    d = d[(d.week > 0) & d.player_gsis_id.notna()].rename(columns={"player_gsis_id": "pid"})
    d["key"] = (d.season * 100 + d.week).astype("int64")
    return d


def asof_prior(frame, ngs, stats, weight, k, window=2):
    """Attach volume-weighted as-of priors of `stats` to frame (pid, season, week)."""
    n = ngs[["pid", "season", "key", weight] + stats].dropna(subset=[weight]).sort_values(["pid", "key"]).copy()
    for st in stats:
        n[st + "_w"] = n[st].fillna(n[st].mean()) * n[weight]
    g = n.groupby("pid")
    cum = n[["pid", "season", "key"]].copy()
    cum["cw"] = g[weight].cumsum()
    for st in stats:
        cum["c_" + st] = g[st + "_w"].cumsum()
    # cumulative totals through the end of each season, for the window cut
    season_end = cum.groupby(["pid", "season"]).tail(1)[["pid", "season"] + ["cw"] + ["c_" + st for st in stats]]
    f = frame[["pid", "season", "week"]].copy()
    f["key"] = (f.season * 100 + f.week).astype("int64")
    f["_i"] = np.arange(len(f))
    f = f.sort_values("key")
    # everything strictly before this game
    a = pd.merge_asof(f, cum.sort_values("key").drop(columns="season"), on="key", by="pid", direction="backward", allow_exact_matches=False)
    # minus everything through (season - window)
    f2 = a[["pid", "season"]].copy(); f2["cut"] = (f2.season - window).astype("int64"); f2["_j"] = np.arange(len(f2))
    se = season_end.rename(columns={"season": "cut"}); se["cut"] = se.cut.astype("int64"); se = se.sort_values("cut")
    b = pd.merge_asof(f2.sort_values("cut"), se, on="cut", by="pid", direction="backward").sort_values("_j")
    out = a.copy()
    lg = {st: float((n[st + "_w"]).sum() / n[weight].sum()) for st in stats}
    wv = (a.cw.fillna(0).to_numpy() - b.cw.fillna(0).to_numpy()).clip(min=0)
    for st in stats:
        sv = a["c_" + st].fillna(0).to_numpy() - b["c_" + st].fillna(0).to_numpy()
        out["ngs_" + st] = (sv + k * lg[st]) / (wv + k)
    out["ngs_vol"] = wv
    out = out.sort_values("_i")
    res = frame.copy()
    for st in stats:
        res["ngs_" + st] = out["ngs_" + st].to_numpy()
    res["ngs_has"] = (out.ngs_vol.to_numpy() > 0).astype(int)
    return res


def paired(ta, tb, y, line):
    m = ta[["game_id", "pid", y, line, "p"]].merge(tb[["game_id", "pid", "p"]], on=["game_id", "pid"], suffixes=("_a", "_b"))
    o = (m[y] > m[line]).to_numpy(float)
    f = lambda p: -(o * np.log(p) + (1 - o) * np.log(1 - p))
    d = f(m.p_b.to_numpy()) - f(m.p_a.to_numpy())
    return d.mean(), d.mean() / (d.std(ddof=1) / np.sqrt(len(d)))


def yards_market(label, q, y, base, adds):
    q = q.dropna(subset=base + [y]).copy()
    q["line"] = np.floor(q[y + "_prior"]) + 0.5
    mae0, ll0, t0 = Y.walk(q, base, y, "line")
    print(f"\n{label}  (n={len(t0):,} 2019-25)   base MAE {mae0:.2f} · line log loss {ll0:.5f}")
    for lab, extra in adds:
        mae, ll, t = Y.walk(q, base + extra, y, "line")
        dm, tt = paired(t0, t, y, "line")
        flag = "  <-- REAL" if tt < -2.5 else ""
        print(f"  + {lab:40s} MAE {mae:6.2f} ({mae - mae0:+.2f})  log loss {ll - ll0:+.5f}  t={tt:+.1f}{flag}")


def main():
    d = Y.load_pbp(port=True); ctx = Y.game_ctx(d)
    skill, _ = Y.skill_frame(d)
    rp = pd.read_parquet(os.path.join(HERE, "receptions.parquet"))[["game_id", "pid", "rec", "rec_l3", "catch_prior", "team_pass_prior"]]
    skill = skill.merge(rp, on=["game_id", "pid"], how="left")

    rec_ngs = load_ngs("receiving")
    rec_stats = ["avg_separation", "avg_cushion", "avg_intended_air_yards", "percent_share_of_intended_air_yards", "avg_yac_above_expectation", "catch_percentage"]
    skill = asof_prior(skill, rec_ngs, rec_stats, "targets", k=20)
    rush_ngs = load_ngs("rushing")
    rush_stats = ["rush_yards_over_expected_per_att", "efficiency", "percent_attempts_gte_eight_defenders", "avg_time_to_los"]
    sk2 = asof_prior(skill[["pid", "season", "week"]].copy(), rush_ngs, rush_stats, "rush_attempts", k=30)
    for st in rush_stats:
        skill["ngs_" + st] = sk2["ngs_" + st].to_numpy()
    skill["ngs_rush_has"] = sk2["ngs_has"].to_numpy()

    print("coverage: receiving NGS history for", f"{skill[skill.tgt_prior >= 2].ngs_has.mean():.0%}", "of pass-catchers ·",
          "rushing NGS for", f"{skill[(skill.position == 'RB') & (skill.car_prior >= 4)].ngs_rush_has.mean():.0%}", "of RBs")

    rec_pop = skill[skill.position.isin(["WR", "TE", "RB"]) & (skill.tgt_prior >= 2) & (skill.games_prior >= 3)].copy()
    rec_adds = [("separation", ["ngs_avg_separation"]), ("cushion", ["ngs_avg_cushion"]),
                ("intended air yards (depth)", ["ngs_avg_intended_air_yards"]), ("share of team air yards", ["ngs_percent_share_of_intended_air_yards"]),
                ("YAC over expected", ["ngs_avg_yac_above_expectation"]), ("NGS catch %", ["ngs_catch_percentage"]),
                ("all receiving NGS", ["ngs_" + s for s in rec_stats])]
    yards_market("RECEIVING YARDS", rec_pop, "ryds", Y.MARKETS["rec"][3], rec_adds)
    # receptions count with the receptions board's own base
    rec_pop["rec_prior"] = rec_pop.groupby("pid").rec.transform(lambda s: s.shift(1).expanding().mean()).fillna(rec_pop.rec.mean())
    yards_market("RECEPTIONS", rec_pop, "rec", ["rec_prior", "tgt_prior", "implied_total", "spread_own", "snap_l3", "share_l3", "rec_l3", "catch_prior", "team_pass_prior"],
                 [("separation", ["ngs_avg_separation"]), ("cushion", ["ngs_avg_cushion"]), ("NGS catch %", ["ngs_catch_percentage"]),
                  ("intended air yards", ["ngs_avg_intended_air_yards"]), ("all receiving NGS", ["ngs_" + s for s in rec_stats])])

    rush_pop = skill[(skill.position == "RB") & (skill.car_prior >= 4) & (skill.games_prior >= 3)].copy()
    yards_market("RUSHING YARDS (RB)", rush_pop, "rush", Y.MARKETS["rush"][3],
                 [("rush yards over expected / att", ["ngs_rush_yards_over_expected_per_att"]), ("efficiency", ["ngs_efficiency"]),
                  ("8+ defenders in box %", ["ngs_percent_attempts_gte_eight_defenders"]), ("time to line of scrimmage", ["ngs_avg_time_to_los"]),
                  ("all rushing NGS", ["ngs_" + s for s in rush_stats])])
    rr_pop = skill[skill.position.isin(["WR", "TE", "RB"]) & (skill.tgt_prior + skill.car_prior >= 5) & (skill.games_prior >= 3)].copy()
    yards_market("RUSH + REC YARDS", rr_pop, "rr", Y.MARKETS["rr"][3],
                 [("separation + RYOE", ["ngs_avg_separation", "ngs_rush_yards_over_expected_per_att"]),
                  ("YACOE + RYOE", ["ngs_avg_yac_above_expectation", "ngs_rush_yards_over_expected_per_att"])])

    # ── quarterbacks
    pas = load_ngs("passing")
    pas_stats = ["avg_time_to_throw", "aggressiveness", "avg_intended_air_yards", "avg_air_yards_to_sticks", "completion_percentage_above_expectation", "avg_air_distance"]
    qb = Y.qb_frame(d, ctx)
    qb = asof_prior(qb, pas, pas_stats, "attempts", k=150)
    qpop = qb[qb.games_prior >= 3].copy()
    padds = [("time to throw", ["ngs_avg_time_to_throw"]), ("aggressiveness", ["ngs_aggressiveness"]),
             ("intended air yards", ["ngs_avg_intended_air_yards"]), ("air yards to the sticks", ["ngs_avg_air_yards_to_sticks"]),
             ("NGS CPOE", ["ngs_completion_percentage_above_expectation"]), ("all passing NGS", ["ngs_" + s for s in pas_stats])]
    yards_market("PASSING YARDS", qpop, "pyds", Y.MARKETS["pass"][3], padds)
    yards_market("QB RUSHING YARDS", qpop, "rush", Y.MARKETS["qbrush"][3], [("time to throw", ["ngs_avg_time_to_throw"])])

    # interceptions: 1+ INT log loss on the shipped model
    iq = I.build(window=2, k_bad=I.K_BAD, k_def=I.K_DEF)
    iq = asof_prior(iq, pas, pas_stats, "attempts", k=150)
    iq = iq[iq.att_n >= 3].copy()
    _, _, tb = I.walk(iq, fs=I.FEATS)
    print(f"\nINTERCEPTIONS  (n={len(tb):,})  base 1+ INT log loss {I.ll(1 - np.exp(-tb.mu.to_numpy()), (tb.ints >= 1).to_numpy(float)):.5f}")
    for lab, extra in padds:
        _, _, t = I.walk(iq, fs=I.FEATS + extra)
        dm, se, n = I.paired(tb, t)
        print(f"  + {lab:40s} d={dm:+.5f} t={dm / se:+.1f}{'  <-- REAL' if dm / se < -2.5 else ''}")

    # completions: MAE + line log loss on the completions base, via the yards machinery
    cq = qpop.copy()
    cmp = d[d.pass_attempt == 1].groupby(["game_id", "passer_player_id"], as_index=False).complete_pass.sum().rename(columns={"passer_player_id": "pid", "complete_pass": "cmp"})
    cq = cq.merge(cmp, on=["game_id", "pid"], how="left")
    cq = Y.form(cq, "cmp", "cmp_prior")
    cq["rate_prior"] = cq.cmp_prior / cq.att_prior.clip(lower=1)
    yards_market("COMPLETIONS", cq, "cmp", ["cmp_prior", "att_prior", "rate_prior", "implied_total"],
                 [("time to throw", ["ngs_avg_time_to_throw"]), ("aggressiveness", ["ngs_aggressiveness"]),
                  ("NGS CPOE", ["ngs_completion_percentage_above_expectation"]), ("intended air yards", ["ngs_avg_intended_air_yards"]),
                  ("all passing NGS", ["ngs_" + s for s in pas_stats])])


if __name__ == "__main__" and "--td" not in sys.argv:
    main()


def td_model():
    """Anytime TD (the Picks model, M9): does receiving / rushing NGS add?"""
    import backtest as B
    df = pd.read_parquet(B.DATA).sort_values(["season", "week"])
    rec_stats = ["avg_separation", "avg_yac_above_expectation", "avg_intended_air_yards", "percent_share_of_intended_air_yards"]
    rush_stats = ["rush_yards_over_expected_per_att", "efficiency", "percent_attempts_gte_eight_defenders"]
    df = asof_prior(df, load_ngs("receiving"), rec_stats, "targets", k=20)
    r2 = asof_prior(df[["pid", "season", "week"]].copy(), load_ngs("rushing"), rush_stats, "rush_attempts", k=30)
    for st in rush_stats: df["ngs_" + st] = r2["ngs_" + st].to_numpy()
    base = list(B.MODELS[B.FINAL])
    adds = [("separation", ["ngs_avg_separation"]), ("YAC over expected", ["ngs_avg_yac_above_expectation"]),
            ("intended air yards", ["ngs_avg_intended_air_yards"]), ("air-yard share", ["ngs_percent_share_of_intended_air_yards"]),
            ("rush yards over expected", ["ngs_rush_yards_over_expected_per_att"]), ("8+ box %", ["ngs_percent_attempts_gte_eight_defenders"]),
            ("all", ["ngs_" + s for s in rec_stats + rush_stats])]
    def walk(feats):
        out = []
        for S in range(2019, 2026):
            tr, te = df[df.season < S], df[df.season == S]
            Xtr, mu, sd = B.design(tr, feats); Xte, _, _ = B.design(te, feats, mu, sd)
            p = B.predict(Xte, B.fit_logistic(Xtr, tr.scored.to_numpy(float)))
            out.append(pd.DataFrame({"y": te.scored.to_numpy(float), "p": np.clip(p, 1e-6, 1 - 1e-6)}))
        return pd.concat(out, ignore_index=True)
    b = walk(base)
    rowll = lambda t: -(t.y * np.log(t.p) + (1 - t.y) * np.log(1 - t.p))
    lb = rowll(b)
    print(f"\nANYTIME TD (M9, n={len(b):,} 2019-25)   base log loss {lb.mean():.5f} · AUC {B.auc(b.y.to_numpy(), b.p.to_numpy()):.4f}")
    for lab, extra in adds:
        t = walk(base + extra); dd = rowll(t) - lb
        tt = dd.mean() / (dd.std(ddof=1) / np.sqrt(len(dd)))
        print(f"  + {lab:28s} log loss {dd.mean():+.5f}  AUC {B.auc(t.y.to_numpy(), t.p.to_numpy()):.4f}  t={tt:+.1f}{'  <-- REAL' if tt < -2.5 else ''}")


if __name__ == "__main__" and "--td" in sys.argv:
    td_model()
