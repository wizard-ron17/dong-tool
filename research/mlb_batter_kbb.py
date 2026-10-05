"""Batter strikeouts and walks: a walk-forward replay, 2025 tuned, 2026 tested.

    python3 research/mlb_batter_kbb.py            # replay + report
    python3 research/mlb_batter_kbb.py --grid     # also re-tune the shrink constants on 2025

Every batter-game from the Savant PA cache (research/.cache/savant_pa, every PA
2024-2026 with its pitcher and whether he started), priced with only what was
known the day before:

  per-PA rate vs the starter = log5(batter, starter, league)
  per-PA rate vs the pen     = log5(batter, opposing bullpen, league)
  rates shrunk toward league: batter K0b PA, pitcher K0p BF, pen K0pen PA

  plate appearances: the empirical count distribution for his lineup slot.
  The k-th PA of slot j is the (9(k-1)+j)-th batter the pitching side faces,
  so it comes against the starter while that number is within the starter's
  usual batters faced (his average per start, shrunk to the league's).

  P(K >= m) = the starter PAs and pen PAs, each Bernoulli at their rate,
  mixed over the PA count distribution.

Counts: K = strikeout + strikeout_double_play; BB = walk + intent_walk (how
books settle batter walks). Starters only (slots 1-9, from the HR replay table).
"""
import glob, json, math, os, sys
import numpy as np
import pandas as pd

HERE = os.path.dirname(os.path.abspath(__file__))
K_EV, BB_EV = {"strikeout", "strikeout_double_play"}, {"walk", "intent_walk"}


def load():
    fs = sorted(f for f in glob.glob(os.path.join(HERE, ".cache/savant_pa/*.parquet")) if not f.endswith("_pit.parquet"))
    cols = ["game_pk", "date", "batter", "pitcher", "sp", "events", "top", "home_team", "away_team", "stand", "p_throws"]
    parts = [pd.read_parquet(f) for f in fs]
    d = pd.concat([x[cols] for x in parts if "game_pk" in x.columns and len(x)], ignore_index=True)   # off days are empty files
    d = d[d["events"].notna()]
    d["k"] = d["events"].isin(K_EV).astype(int)
    d["bb"] = d["events"].isin(BB_EV).astype(int)
    d["date"] = pd.to_datetime(d["date"]).dt.date.astype(str)
    d["season"] = d["date"].str[:4].astype(int)
    d["bat_team"] = np.where(d["top"], d["away_team"], d["home_team"])
    d["pit_team"] = np.where(d["top"], d["home_team"], d["away_team"])
    return d


def cum_prior(df, keys, cols, date_col="date"):
    """Per (keys, date): the sums of cols over all EARLIER dates in the same season, and the previous season's total."""
    g = df.groupby(keys + ["season", date_col])[cols].sum().reset_index().sort_values(keys + ["season", date_col])
    cs = g.groupby(keys + ["season"])[cols].cumsum() - g[cols]           # strictly before this date
    out = g[keys + ["season", date_col]].copy()
    for c in cols: out["cur_" + c] = cs[c].values
    tot = df.groupby(keys + ["season"])[cols].sum().reset_index()
    tot["season"] += 1
    out = out.merge(tot.rename(columns={c: "prv_" + c for c in cols}), on=keys + ["season"], how="left").fillna(0)
    return out


def build(d):
    # batter-game outcomes
    bg = d.groupby(["game_pk", "date", "season", "batter", "bat_team", "pit_team"]).agg(pa=("k", "size"), k=("k", "sum"), bb=("bb", "sum"),
          stand=("stand", "first")).reset_index()
    # opposing starter per game & side
    st = d[d["sp"]].groupby(["game_pk", "pit_team"])["pitcher"].first().rename("opp_sp").reset_index()
    bg = bg.merge(st, on=["game_pk", "pit_team"], how="left")
    # lineup slot from the HR replay (starters only)
    raw = pd.read_parquet(os.path.join(HERE, "mlb_hr_replay_raw.parquet"), columns=["game_pk", "pid", "slot"])
    raw["pid"] = raw["pid"].astype(int)
    bg = bg.merge(raw.rename(columns={"pid": "batter"}), on=["game_pk", "batter"], how="inner")
    bg = bg[bg["slot"].between(1, 9)]

    # priors, as of the day before
    d["pa1"] = 1
    bat = cum_prior(d, ["batter"], ["pa1", "k", "bb"])
    sp_rows = d[d["sp"]].copy()
    sp_rows["start"] = 0
    first = sp_rows.groupby(["game_pk", "pitcher"]).cumcount() == 0
    sp_rows.loc[first, "start"] = 1
    sp = cum_prior(sp_rows, ["pitcher"], ["pa1", "k", "bb", "start"])
    pen_rows = d[~d["sp"]]
    pen = cum_prior(pen_rows, ["pit_team"], ["pa1", "k", "bb"])
    lg = d.groupby(["season", "date"])[["pa1", "k", "bb"]].sum().reset_index().sort_values("date")
    lgc = lg.groupby("season")[["pa1", "k", "bb"]].cumsum() - lg[["pa1", "k", "bb"]]
    lg = lg[["season", "date"]].assign(lg_pa=lgc["pa1"].values, lg_k=lgc["k"].values, lg_bb=lgc["bb"].values)
    lgprev = d.groupby("season")[["pa1", "k", "bb"]].sum().reset_index(); lgprev["season"] += 1
    lg = lg.merge(lgprev.rename(columns={"pa1": "lp_pa", "k": "lp_k", "bb": "lp_bb"}), on="season", how="left").fillna(0)

    bg = bg.merge(bat.rename(columns={c: "b_" + c for c in bat.columns if c.startswith(("cur_", "prv_"))}), on=["batter", "season", "date"], how="left")
    bg = bg.merge(sp.rename(columns={"pitcher": "opp_sp", **{c: "s_" + c for c in sp.columns if c.startswith(("cur_", "prv_"))}}), on=["opp_sp", "season", "date"], how="left")
    bg = bg.merge(pen.rename(columns={**{c: "p_" + c for c in pen.columns if c.startswith(("cur_", "prv_"))}}), on=["pit_team", "season", "date"], how="left")
    bg = bg.merge(lg, on=["season", "date"], how="left")
    return bg.fillna(0)


def rates(bg, which, K0b, K0p, K0pen, prev_w):
    """Shrunk per-PA rates for 'k' or 'bb': batter, starter, pen, league (prior season blended at prev_w)."""
    lgN = bg["lg_pa"] + prev_w * bg["lp_pa"]
    lg = (bg[f"lg_{which}"] + prev_w * bg[f"lp_{which}"]) / lgN.where(lgN > 0, 1)
    def shr(cur_n, cur_c, prv_n, prv_c, K0):
        n = cur_n + prev_w * prv_n; c = cur_c + prev_w * prv_c
        return (c + K0 * lg) / (n + K0)
    b = shr(bg["b_cur_pa1"], bg[f"b_cur_{which}"], bg["b_prv_pa1"], bg[f"b_prv_{which}"], K0b)
    s = shr(bg["s_cur_pa1"], bg[f"s_cur_{which}"], bg["s_prv_pa1"], bg[f"s_prv_{which}"], K0p)
    p = shr(bg["p_cur_pa1"], bg[f"p_cur_{which}"], bg["p_prv_pa1"], bg[f"p_prv_{which}"], K0pen)
    return b, s, p, lg


def log5(b, p, l):
    num = b * p / l
    return num / (num + (1 - b) * (1 - p) / (1 - l))


def sp_bf(bg, prev_w, K0starts=5):
    """The starter's usual batters faced per start, shrunk toward ~22."""
    n = bg["s_cur_start"] + prev_w * bg["s_prv_start"]
    bf = bg["s_cur_pa1"] + prev_w * bg["s_prv_pa1"]
    return (bf + K0starts * 22.0) / (n + K0starts)


def pa_dist(train):
    """P(PA = n | slot), n = 1..7, from the training games."""
    out = {}
    for s, g in train.groupby("slot"):
        c = g["pa"].clip(1, 7).value_counts().reindex(range(1, 8), fill_value=0)
        out[int(s)] = (c / c.sum()).values
    return out


def p_atleast(p_sp, p_pen, slot, bf, dist, m):
    """P(count >= m) mixed over PA count; PAs vs the starter by batting-order position."""
    out = np.zeros(len(p_sp))
    for n in range(1, 8):
        w = np.array([dist[s][n - 1] for s in slot])
        k = np.arange(1, n + 1)
        idx = 9 * (k[None, :] - 1) + slot[:, None]                    # team batter number of each PA
        n_sp = (idx <= bf[:, None]).sum(1)
        n_pen = n - n_sp
        # distribution of the sum of two binomials, up to m-1, then 1 - cdf
        below = np.zeros(len(p_sp))
        for a in range(m):
            for c in range(m - a):
                below += binom(n_sp, a, p_sp) * binom(n_pen, c, p_pen)
        out += w * (1 - below)
    return out


def binom(n, k, p):
    from scipy.special import comb
    return np.where(k <= n, comb(n, k) * p ** k * (1 - p) ** (n - k), 0.0)


def ll(y, p):
    p = np.clip(p, 1e-4, 1 - 1e-4)
    return float(-(y * np.log(p) + (1 - y) * np.log(1 - p)).mean())


def evaluate(bg, which, prm, dist, label):
    K0b, K0p, K0pen, prev_w = prm
    b, s, pn, lg = rates(bg, which, K0b, K0p, K0pen, prev_w)
    p_sp, p_pen = log5(b, s, lg).values, log5(b, pn, lg).values
    bf, slot = sp_bf(bg, prev_w).values, bg["slot"].astype(int).values
    res = {}
    for m in ([1, 2] if which == "k" else [1]):
        y = (bg[which] >= m).astype(int).values
        p = p_atleast(p_sp, p_pen, slot, bf, dist, m)
        # baselines: league rate x slot PAs; batter's own (shrunk) rate x slot PAs (no matchup)
        pl = p_atleast(lg.values, lg.values, slot, bf, dist, m)
        pb = p_atleast(b.values, b.values, slot, bf, dist, m)
        res[f"{which}{m}+"] = dict(n=len(y), base=round(y.mean(), 4), ll=round(ll(y, p), 5), ll_league=round(ll(y, pl), 5), ll_batter_only=round(ll(y, pb), 5),
                                   mean_p=round(float(p.mean()), 4), p=p, y=y)
    return res


def calib(p, y, bins=8):
    q = pd.qcut(p, bins, labels=False, duplicates="drop")
    t = pd.DataFrame({"q": q, "p": p, "y": y}).groupby("q").agg(n=("y", "size"), pred=("p", "mean"), act=("y", "mean"))
    return t.round(3)


def main():
    d = load()
    bg = build(d)
    print(f"batter-games: {len(bg):,} ({bg.groupby('season').size().to_dict()})")
    # only games with some batter history, and a known starter
    bg = bg[(bg["b_cur_pa1"] + bg["b_prv_pa1"] >= 30) & (bg["opp_sp"] > 0)]
    tune, test = bg[bg["season"] == 2025], bg[bg["season"] == 2026]
    # PA counts by slot, from 2025 (slots exist from 2025; how many PAs a slot gets barely moves year to year)
    dist = pa_dist(bg[bg["season"] == 2025])
    grid = {"k": [(60, 70, 300, 0.5)], "bb": [(120, 120, 600, 0.5)]}
    if "--grid" in sys.argv:
        for which in ("k", "bb"):
            best = None
            for K0b in (30, 60, 100, 160, 250):
                for K0p in (40, 70, 120, 200):
                    for K0pen in (150, 300, 600):
                        for pw in (0.3, 0.5, 0.8):
                            r = evaluate(tune, which, (K0b, K0p, K0pen, pw), dist, "")
                            score = r[f"{which}1+"]["ll"]
                            if best is None or score < best[0]: best = (score, (K0b, K0p, K0pen, pw))
            print(f"{which}: best on 2025 {best}")
            grid[which] = [best[1]]
    out = {}
    for which in ("k", "bb"):
        prm = grid[which][0]
        for name, part in (("2025 (tuned)", tune), ("2026 (test)", test)):
            r = evaluate(part, which, prm, dist, name)
            for key, v in r.items():
                print(f"{name:13} {key:4} n={v['n']:6,} base {v['base']:.3f} mean_p {v['mean_p']:.3f} | logloss model {v['ll']:.5f}  "
                      f"batter-only {v['ll_batter_only']:.5f}  league {v['ll_league']:.5f}")
                if name.startswith("2026"):
                    print(calib(v["p"], v["y"]).to_string())
                    out[key] = {k: v[k] for k in ("n", "base", "ll", "ll_league", "ll_batter_only", "mean_p")}
        out[which + "_params"] = dict(zip(("K0b", "K0p", "K0pen", "prev_w"), prm))
    out["pa_dist"] = {str(k): [round(x, 4) for x in v] for k, v in dist.items()}
    json.dump(out, open(os.path.join(HERE, "mlb_batter_kbb.json"), "w"), indent=1)
    print("wrote research/mlb_batter_kbb.json")


if __name__ == "__main__":
    main()
