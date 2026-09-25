"""P(HR) for a starting batter, from a replay of every 2025-26 starter-game.

    python3 research/mlb_hr_replay_fetch.py 2025 2026   # boxscores (cached)
    python3 research/mlb_hr_replay.py

Why: /mlb shows a pick score, not odds. The naive conversion
P = 1-(1-score/100)^AB comes out ~2x too high on logged board picks (34% vs
18%), and the board only covers the top of the range. This fits the level and
the power curve across EVERY starter, strictly out of sample, with the pieces
the live build can reproduce: season HR/AB to date shrunk toward last season
and the league, lineup slot, home, park, and the opposing starter's HR rate to
date (the crude pitcher-vulnerability test).

All features use games on EARLIER dates only. Fit: 2026 Apr-Jul. Test: 2026
Aug-Sep (2025 supplies the priors).
"""
import os
import sys

import numpy as np
import pandas as pd

RAW = os.path.join(os.path.dirname(__file__), "mlb_hr_replay_raw.parquet")
BBE_CACHE = os.path.join(os.path.dirname(__file__), ".cache", "savant_bbe")   # mlb_barrels_fetch.py


def load_contact():
    """Savant per-game lines (mlb_barrels_fetch.py): batters and pitchers."""
    import glob, json
    bats, pits = [], []
    for f in sorted(glob.glob(os.path.join(BBE_CACHE, "*.json"))):
        j = json.load(open(f))
        bats += j["batters"]; pits += j["pitchers"]
    return pd.DataFrame(bats), pd.DataFrame(pits)


def shrunk_to_date(df, key, num, den, out, k, k_prior, lg):
    """num/den to date this season (earlier dates only), shrunk toward last
    season's rate, itself shrunk toward the league. df has one row per
    (key, game) with season and date."""
    d = df.groupby([key, "season", "date"], as_index=False)[[num, den]].sum().sort_values([key, "season", "date"])
    g = d.groupby([key, "season"], sort=False)
    n, m = g[num].cumsum() - d[num], g[den].cumsum() - d[den]
    last = d.groupby([key, "season"])[[num, den]].sum().reset_index()
    last["season"] += 1
    d = d.merge(last.rename(columns={num: "_pn", den: "_pd"}), on=[key, "season"], how="left").fillna({"_pn": 0, "_pd": 0})
    prior = (d._pn + k_prior * lg) / (d._pd + k_prior)
    d[out] = (n.values + k * prior) / (m.values + k)
    return d[[key, "season", "date", out]]


def fit_logistic(X, y, ridge=1e-4, iters=60):
    w = np.zeros(X.shape[1])
    for _ in range(iters):
        p = 1 / (1 + np.exp(-X @ w))
        H = X.T @ (X * (p * (1 - p))[:, None]) + ridge * np.eye(X.shape[1])
        w += np.linalg.solve(H, X.T @ (y - p) - ridge * w)
    return w, np.sqrt(np.diag(np.linalg.inv(H)))


def log_loss(y, p):
    p = np.clip(p, 1e-9, 1 - 1e-9)
    return -np.mean(y * np.log(p) + (1 - y) * np.log(1 - p))


def to_date(df, key, num, den, out):
    """Per (key, season): cumulative num/den over strictly earlier DATES."""
    daily = df.groupby([key, "season", "date"], as_index=False)[[num, den]].sum().sort_values([key, "season", "date"])
    g = daily.groupby([key, "season"], sort=False)
    daily[out + "_n"] = g[num].cumsum() - daily[num]
    daily[out + "_d"] = g[den].cumsum() - daily[den]
    return df.merge(daily[[key, "season", "date", out + "_n", out + "_d"]], on=[key, "season", "date"], how="left")


def build(df, k_bat=400, k_prior=300, k_sp=800, k_park=2000):
    df = df.copy()
    df["y"] = (df.hr > 0).astype(float)
    lg_ab = df.hr.sum() / df.ab.sum()
    # batter: season to date, prior season total
    df = to_date(df, "pid", "hr", "ab", "bat")
    last = df.groupby(["pid", "season"])[["hr", "ab"]].sum().reset_index()
    last["season"] += 1
    df = df.merge(last.rename(columns={"hr": "prev_hr", "ab": "prev_ab"}), on=["pid", "season"], how="left").fillna({"prev_hr": 0, "prev_ab": 0})
    prior = (df.prev_hr + k_prior * lg_ab) / (df.prev_ab + k_prior)
    df["bat_rate"] = (df.bat_n + k_bat * prior) / (df.bat_d + k_bat)
    # opposing starter: HR per batter faced, to date + last season. Each game's
    # line is repeated on every opposing batter's row, so dedupe to one per game.
    sp = df.drop_duplicates(["game_pk", "opp_sp"])[["opp_sp", "season", "date", "sp_hr", "sp_bf"]]
    lg_bf = sp.sp_hr.sum() / sp.sp_bf.sum()
    spd = sp.groupby(["opp_sp", "season", "date"], as_index=False)[["sp_hr", "sp_bf"]].sum().sort_values(["opp_sp", "season", "date"])
    g = spd.groupby(["opp_sp", "season"], sort=False)
    spd["sp_n"] = g.sp_hr.cumsum() - spd.sp_hr
    spd["sp_d"] = g.sp_bf.cumsum() - spd.sp_bf
    splast = sp.groupby(["opp_sp", "season"])[["sp_hr", "sp_bf"]].sum().reset_index()
    splast["season"] += 1
    spd = spd.merge(splast.rename(columns={"sp_hr": "sp_prev_hr", "sp_bf": "sp_prev_bf"}), on=["opp_sp", "season"], how="left").fillna(0)
    sp_prior = (spd.sp_prev_hr + k_sp * lg_bf) / (spd.sp_prev_bf + k_sp)
    spd["sp_rate"] = (spd.sp_n + k_sp * sp_prior) / (spd.sp_d + k_sp)
    df = df.merge(spd[["opp_sp", "season", "date", "sp_rate"]], on=["opp_sp", "season", "date"], how="left")
    df["sp_rate"] = df.sp_rate.fillna(lg_bf)
    # park: last season's HR per AB there, relative to league
    pk = df.groupby(["venue", "season"])[["hr", "ab"]].sum().reset_index()
    pk["season"] += 1
    df = df.merge(pk.rename(columns={"hr": "pk_hr", "ab": "pk_ab"}), on=["venue", "season"], how="left").fillna({"pk_hr": 0, "pk_ab": 0})
    df["park"] = ((df.pk_hr + k_park * lg_ab) / (df.pk_ab + k_park)) / lg_ab
    df["lg_ab"], df["lg_bf"] = lg_ab, lg_bf
    return df


def add_contact(df, k_bat=150, k_sp=300):
    """Batter barrels and blasts per PA, and the opposing starter's
    barrel%-allowed (per batted ball), all to date and shrunk."""
    bats, pits = load_contact()
    if bats.empty:
        return df
    games = df[["game_pk", "season", "date"]].drop_duplicates()
    b = bats.rename(columns={"gpk": "game_pk"}).merge(games, on="game_pk")
    lg_brl = b.barrel.sum() / b.pa.sum(); lg_bls = b.blast.sum() / b.pa.sum()
    for num, out, lg in (("barrel", "bat_brl", lg_brl), ("blast", "bat_bls", lg_bls)):
        df = df.merge(shrunk_to_date(b, "pid", num, "pa", out, k_bat, 300, lg), on=["pid", "season", "date"], how="left")
        df[out] = df[out].fillna(lg)
    # starters' lines only: a reliever's barrels say little about the arm we price
    p = pits[pits.sp].rename(columns={"gpk": "game_pk", "pid": "opp_sp"}).merge(games, on="game_pk")
    lg_pb = p.barrel.sum() / p.bbe.sum()
    df = df.merge(shrunk_to_date(p, "opp_sp", "barrel", "bbe", "sp_brl", k_sp, 300, lg_pb), on=["opp_sp", "season", "date"], how="left")
    df["sp_brl"] = df.sp_brl.fillna(lg_pb)
    return df


def design(d, feats):
    cols = [np.ones(len(d))]
    for f in feats:
        if f == "slot":
            for s in range(2, 10):
                cols.append((d.slot == s).to_numpy(float))
        elif f == "home":
            cols.append(d.home.to_numpy(float))
        else:
            cols.append(np.log(d[f].to_numpy(float)))
    return np.column_stack(cols)


def main():
    df = build(pd.read_parquet(RAW))
    d = df[df.season == 2026].copy()
    tr, te = d[d.date < "2026-08-01"], d[d.date >= "2026-08-01"]
    y_tr, y_te = tr.y.to_numpy(), te.y.to_numpy()
    print(f"2026 starter-games: train {len(tr)} (HR {y_tr.mean():.3f}), test {len(te)} (HR {y_te.mean():.3f})")
    print(f"league HR/AB {df.lg_ab.iloc[0]:.4f}, starters average {d.ab.mean():.2f} AB\n")
    base = log_loss(y_te, np.full(len(y_te), y_tr.mean()))
    # the naive structural conversion, for reference
    naive = 1 - (1 - te.bat_rate) ** 3.6
    print(f"{'model':34s} {'test logloss':>12s} {'vs base':>8s}")
    print(f"{'base rate':34s} {base:12.5f}")
    print(f"{'naive 1-(1-rate)^3.6 (no fit)':34s} {log_loss(y_te, naive):12.5f} {100*(base-log_loss(y_te, naive))/base:7.2f}%")
    models = {
        "batter rate": ["bat_rate"],
        "+ slot": ["bat_rate", "slot"],
        "+ slot + park": ["bat_rate", "slot", "park"],
        "+ slot + park + home": ["bat_rate", "slot", "park", "home"],
        "+ opposing starter HR rate": ["bat_rate", "slot", "park", "home", "sp_rate"],
    }
    fits = {}
    for name, f in models.items():
        w, se = fit_logistic(design(tr, f), y_tr)
        p = 1 / (1 + np.exp(-design(te, f) @ w))
        fits[name] = (w, se, p, f)
        print(f"{name:34s} {log_loss(y_te, p):12.5f} {100*(base-log_loss(y_te, p))/base:7.2f}%")
    w, se, p, f = fits["+ opposing starter HR rate"]
    names = ["const"] + [x for ff in f for x in ([f"slot{s}" for s in range(2, 10)] if ff == "slot" else [ff])]
    print("\ncoefficients (full model, train):")
    for n, b, s in zip(names, w, se):
        print(f"  {n:10s} {b:7.3f}  z {b/s:6.1f}")
    print("\ncalibration on test, decile bins:")
    t = te.assign(p=p)
    t["bin"] = pd.qcut(t.p, 10, labels=False)
    print(t.groupby("bin").agg(n=("y", "size"), pred=("p", "mean"), actual=("y", "mean")).round(3).to_string())
    top = t[t.p >= t.p.quantile(0.98)]
    print(f"top 2%: pred {top.p.mean():.3f} actual {top.y.mean():.3f} (n {len(top)})")


if __name__ == "__main__" and len(sys.argv) == 1:
    main()


def contact_ladder():
    """python3 research/mlb_hr_replay.py contact — does Savant contact quality
    earn its place over HR/AB? Same split: fit 2026 Apr-Jul, test Aug-Sep."""
    df = add_contact(build(pd.read_parquet(RAW)))
    d = df[df.season == 2026]
    tr, te = d[d.date < "2026-08-01"], d[d.date >= "2026-08-01"]
    y_tr, y_te = tr.y.to_numpy(), te.y.to_numpy()
    base = log_loss(y_te, np.full(len(y_te), y_tr.mean()))
    core = ["slot", "park"]
    ladder = {
        "HR/AB + SP HR/BF (current)": ["bat_rate", "sp_rate"],
        "+ batter barrels/PA": ["bat_rate", "bat_brl", "sp_rate"],
        "+ batter blasts/PA": ["bat_rate", "bat_brl", "bat_bls", "sp_rate"],
        "+ SP barrel%-allowed": ["bat_rate", "bat_brl", "sp_rate", "sp_brl"],
        "SP barrel% instead of HR/BF": ["bat_rate", "bat_brl", "sp_brl"],
        "barrels only (no HR/AB)": ["bat_brl", "sp_brl"],
    }
    print(f"test {len(te)} starter-games; base-rate logloss {base:.5f}\n")
    for name, f in ladder.items():
        F = f + core
        w, se = fit_logistic(design(tr, F), y_tr)
        p = 1 / (1 + np.exp(-design(te, F) @ w))
        names = ["const"] + [x for ff in F for x in ([f"slot{s}" for s in range(2, 10)] if ff == "slot" else [ff])]
        keep = {n: (b, b / s) for n, b, s in zip(names, w, se) if n in f}
        t = te.assign(p=p); top = t[t.p >= t.p.quantile(0.98)]
        print(f"{name:32s} logloss {log_loss(y_te, p):.5f} ({100*(base-log_loss(y_te, p))/base:.2f}%)  top2% {top.p.mean():.3f}/{top.y.mean():.3f}  "
              + "  ".join(f"{n} {b:.2f} (z {z:.1f})" for n, (b, z) in keep.items()))


if __name__ == "__main__" and len(sys.argv) > 1 and sys.argv[1] == "contact":
    contact_ladder()


K = dict(bat=400, prior=300, contact=75, sp=400, park=2000)       # shrink strengths, chosen out of sample
V1 = ["bat_rate", "bat_brl", "bat_bls", "sp_bpf", "slot", "park"]
PLATT_B = 0.817     # log-odds slope fitted on a held-out month: 0.815 (2026), 0.819 (2025)


def v1_frame():
    """The replay with every v1 feature, as the build will compute them."""
    df = add_contact(build(pd.read_parquet(RAW), k_bat=K["bat"], k_prior=K["prior"]), k_bat=K["contact"])
    bats, pits = load_contact()
    games = df[["game_pk", "season", "date"]].drop_duplicates()
    p = pits[pits.sp].rename(columns={"gpk": "game_pk", "pid": "opp_sp"}).merge(games, on="game_pk")
    lgp = p.barrel.sum() / p.pa.sum()
    df = df.merge(shrunk_to_date(p, "opp_sp", "barrel", "pa", "sp_bpf", K["sp"], K["prior"], lgp), on=["opp_sp", "season", "date"], how="left")
    df["sp_bpf"] = df.sp_bpf.fillna(lgp)
    return df, bats, p, lgp


def export_model(season=2026):
    """python3 research/mlb_hr_replay.py export — writes research/mlb_hr_model.json,
    everything scripts/hr-odds.js needs: coefficients (fit on all of `season`),
    the log-odds slope, shrink strengths, league rates, the park table, and each
    player's `season - 1` totals (the priors a live build can't fetch cheaply,
    and which must match how the replay counted them)."""
    import json
    df, bats, p, lgp = v1_frame()
    d = df[df.season == season]
    w, _ = fit_logistic(design(d, V1), d.y.to_numpy())
    names = ["const"] + [x for ff in V1 for x in ([f"slot{s}" for s in range(2, 10)] if ff == "slot" else [ff])]
    c = dict(zip(names, map(float, w)))
    z = design(d, V1) @ w
    a = 0.0
    for _ in range(60):   # intercept so the slope-adjusted mean matches the season's rate
        pr = 1 / (1 + np.exp(-(a + PLATT_B * z)))
        a += (d.y.mean() - pr.mean()) / (pr * (1 - pr)).mean()
    raw = pd.read_parquet(RAW)
    games = raw[["game_pk", "season"]].drop_duplicates()
    b = bats.rename(columns={"gpk": "game_pk"}).merge(games, on="game_pk")
    lg = {"ab": float(raw.hr.sum() / raw.ab.sum()), "brl": float(b.barrel.sum() / b.pa.sum()),
          "bls": float(b.blast.sum() / b.pa.sum()), "pbf": float(lgp)}
    prev = season - 1
    hr = raw[raw.season == prev].groupby("pid")[["hr", "ab"]].sum()
    ct = b[b.season == prev].groupby("pid")[["barrel", "blast", "pa"]].sum()
    batters = {}
    for pid in hr.index.union(ct.index):
        h = hr.loc[pid] if pid in hr.index else None; x = ct.loc[pid] if pid in ct.index else None
        batters[str(int(pid))] = [int(h.hr) if h is not None else 0, int(h.ab) if h is not None else 0,
                                  int(x.barrel) if x is not None else 0, int(x.blast) if x is not None else 0, int(x.pa) if x is not None else 0]
    ps = p[p.season == prev].groupby("opp_sp")[["barrel", "pa"]].sum()
    pitchers = {str(int(pid)): [int(r.barrel), int(r.pa)] for pid, r in ps.iterrows()}
    pk = raw[raw.season == prev].groupby("venue")[["hr", "ab"]].sum()
    park = {v: round(float(((r.hr + K["park"] * lg["ab"]) / (r.ab + K["park"])) / lg["ab"]), 4) for v, r in pk.iterrows()}
    out = {
        "note": "MLB P(HR) v1 — research/mlb_hr_replay.py export. logit P = platt.a + platt.b * "
                "(const + bat_rate*ln(hr/ab) + bat_brl*ln(barrels/PA) + bat_bls*ln(blasts/PA) + sp_bpf*ln(SP barrels/BF) "
                "+ slot + park*ln(park)); every rate shrunk: this season toward last (prev_*), last toward league.",
        "trained": season, "prevSeason": prev, "coef": c, "platt": {"a": float(a), "b": PLATT_B}, "k": K, "lg": lg,
        "blast": "sq*100 + bat_speed >= 164, sq = min(1, launch_speed / (1.23*bat_speed + 0.23*release_speed)), batted balls only",
        "park": park, "prev_batters": batters, "prev_pitchers": pitchers,
    }
    path = os.path.join(os.path.dirname(__file__), "mlb_hr_model.json")
    json.dump(out, open(path, "w"), separators=(",", ":"))
    print(f"wrote {path}: {len(batters)} batters, {len(pitchers)} pitchers, {len(park)} parks; platt a {a:.3f}")
    print({k: round(v, 3) for k, v in c.items()})


if __name__ == "__main__" and len(sys.argv) > 1 and sys.argv[1] == "export":
    export_model()
