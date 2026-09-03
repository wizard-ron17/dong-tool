"""Stage 1 for a passing-TD market: what's in the data, and does any of it predict?

The anytime-TD model treats a QB as a rusher — his `scored` is a rushing TD — so
passing TDs sit outside it entirely. This builds a separate QB-game table and
vets the features Ron proposed (volume, red-zone efficiency, weapon quality,
base rate) before any of it goes near the picks board.

Same discipline as the TD backtest: every feature is strictly backward-looking,
split-half reliability decides whether a feature is a real trait or noise, the
backtest is walk-forward by season, and a shuffled-target control has to come
back dead.

  python3 research/passing_td.py
"""
import os
import numpy as np
import pandas as pd

HERE = os.path.dirname(__file__)
CACHE = os.environ.get(
    "PICKS_CACHE",
    "/private/tmp/claude-501/-Users-ron-Desktop-dong-tool/"
    "5857f821-b559-469c-a8ee-a9ffc542c6c6/scratchpad/nflcache",
)
SEASONS = list(range(2016, 2026))
MIN_ATT = 10          # a QB-game only counts as a start-like sample above this
SHRINK_K = 8          # games of league prior mixed into a per-QB rate
RZ_YARDLINE = 20      # yardline_100 <= 20 is the red zone
PRIOR_SEASONS = 2     # matches RZ_SEASONS in scripts/picks.js — the pbp the build loads

PBP_COLS = [
    "game_id", "season", "week", "posteam", "defteam", "home_team", "away_team",
    "play_type", "pass_touchdown", "passer_player_id", "receiver_player_id",
    "pass_attempt", "complete_pass", "yardline_100", "spread_line", "total_line",
    "air_yards", "sack",
]


def load_pbp(year):
    df = pd.read_parquet(f"{CACHE}/pbp_{year}.parquet", columns=PBP_COLS)
    return df[df["posteam"].notna()]


def qb_games(pbp):
    """One row per (game, passer): what he actually did throwing the ball."""
    p = pbp[(pbp["pass_attempt"] == 1) & pbp["passer_player_id"].notna()].copy()
    p["rz"] = (p["yardline_100"] <= RZ_YARDLINE).astype(int)
    g = p.groupby(["game_id", "passer_player_id"], as_index=False).agg(
        season=("season", "first"), week=("week", "first"),
        team=("posteam", "first"), defteam=("defteam", "first"),
        att=("pass_attempt", "sum"),
        cmp=("complete_pass", "sum"),
        ptd=("pass_touchdown", "sum"),
        rz_att=("rz", "sum"),
    )
    rz = (p[p["rz"] == 1].groupby(["game_id", "passer_player_id"], as_index=False)
          .agg(rz_ptd=("pass_touchdown", "sum")))
    g = g.merge(rz, on=["game_id", "passer_player_id"], how="left")
    g["rz_ptd"] = g["rz_ptd"].fillna(0)
    return g.rename(columns={"passer_player_id": "pid"})


def team_pass_context(pbp):
    """Per (game, team): the offense's own pass volume, and per (game, defense):
    what that defense allowed. Used for weapon quality and the defense check."""
    p = pbp[pbp["pass_attempt"] == 1].copy()
    off = p.groupby(["game_id", "posteam"], as_index=False).agg(
        t_att=("pass_attempt", "sum"), t_ptd=("pass_touchdown", "sum"))
    dfn = p.groupby(["game_id", "defteam"], as_index=False).agg(
        d_att=("pass_attempt", "sum"), d_ptd=("pass_touchdown", "sum"))
    return off.rename(columns={"posteam": "team"}), dfn.rename(columns={"defteam": "defteam"})


def receiver_quality(pbp):
    """Weapon quality: receiving TDs by the team's pass catchers, per game.

    Deliberately measured on the TEAM rather than the individual QB, so a
    backup inherits the starter's weapons instead of an empty history. That is
    the whole point of the feature — 'who is he throwing to' is a property of
    the offense, not of him.
    """
    p = pbp[(pbp["pass_attempt"] == 1) & pbp["receiver_player_id"].notna()]
    return (p.groupby(["game_id", "posteam"], as_index=False)
             .agg(rec_td=("pass_touchdown", "sum"), targets=("pass_attempt", "sum"))
             .rename(columns={"posteam": "team"}))


def game_lines(pbp):
    g = pbp.groupby(["game_id", "posteam"], as_index=False).agg(
        home_team=("home_team", "first"),
        spread_line=("spread_line", "first"), total_line=("total_line", "first"))
    is_home = g["posteam"] == g["home_team"]
    g["implied_total"] = np.where(is_home,
                                  g["total_line"] / 2 + g["spread_line"] / 2,
                                  g["total_line"] / 2 - g["spread_line"] / 2)
    # Positive = this team is the underdog. Trailing teams throw more, so game
    # script is a volume feature, not just a scoring one.
    g["dog_by"] = np.where(is_home, -g["spread_line"], g["spread_line"])
    return g.rename(columns={"posteam": "team"})[
        ["game_id", "team", "implied_total", "dog_by", "total_line"]]


def prior_rate(df, key, num, den, out, k=SHRINK_K, window_seasons=None):
    """Strictly-backward shrunk rate: everything the entity did BEFORE this row,
    mixed toward the league mean with k pseudo-games.

    window_seasons bounds how far back it looks. The features that ship are
    bounded to the same 2-season window scripts/picks.js loads play-by-play for,
    so the served feature is the trained feature rather than an approximation of
    it — measured at a cost of 0.002 AUC, which is a fair price for the two
    sides agreeing exactly.
    """
    df = df.sort_values(["season", "week", "game_id"]).copy()
    lg = df[num].sum() / max(df[den].sum(), 1)
    dmean = df[den].mean()
    vals, hist = [], {}
    for r in df.itertuples(index=False):
        ent = getattr(r, key)
        h = hist.setdefault(ent, [])
        use = h if window_seasons is None else [x for x in h if x[0] > r.season - window_seasons]
        n = sum(x[1] for x in use); d = sum(x[2] for x in use)
        vals.append((n + k * lg * dmean) / (d + k * dmean))
        h.append((r.season, getattr(r, num), getattr(r, den)))
    df[out] = vals
    return df


def split_half(df, key, col, min_games=8):
    """Is this a real per-entity trait, or noise? Correlate odd vs even games."""
    rows = []
    for ent, g in df.groupby(key):
        if len(g) < min_games:
            continue
        a, b = g.iloc[::2][col], g.iloc[1::2][col]
        if a.notna().sum() < 3 or b.notna().sum() < 3:
            continue
        rows.append((a.mean(), b.mean()))
    if len(rows) < 20:
        return np.nan, len(rows)
    A = np.array([r[0] for r in rows]); B = np.array([r[1] for r in rows])
    r = np.corrcoef(A, B)[0, 1]
    return 2 * r / (1 + r), len(rows)   # Spearman-Brown to full length


def fit_poisson(X, y, ridge=1e-3, iters=60):
    """Poisson GLM by IRLS with a small ridge. No statsmodels in this env, and a
    count model prices every line at once instead of needing one logistic per
    threshold."""
    X = np.asarray(X, float); y = np.asarray(y, float)
    w = np.zeros(X.shape[1]); pen = ridge * np.eye(X.shape[1]); pen[0, 0] = 0
    for _ in range(iters):
        mu = np.exp(np.clip(X @ w, -20, 20))
        W = mu
        z = X @ w + (y - mu) / np.maximum(mu, 1e-9)
        A = X.T @ (X * W[:, None]) + pen
        try:
            w_new = np.linalg.solve(A, X.T @ (W * z))
        except np.linalg.LinAlgError:
            break
        if np.max(np.abs(w_new - w)) < 1e-9:
            w = w_new; break
        w = w_new
    return w


def pois_at_least(mu, n):
    """P(X >= n) for Poisson(mu), vectorised over mu."""
    mu = np.asarray(mu, float)
    if n <= 0:
        return np.ones_like(mu)
    cdf = np.exp(-mu); term = np.exp(-mu)
    for i in range(1, n):
        term = term * mu / i
        cdf = cdf + term
    return np.clip(1 - cdf, 1e-9, 1 - 1e-9)


def ece(p, y, bins=10):
    idx = np.argsort(p); p, y = p[idx], y[idx]
    out, n = 0.0, len(p)
    for c in np.array_split(np.arange(n), bins):
        if len(c):
            out += len(c) / n * abs(p[c].mean() - y[c].mean())
    return out


def auc(p, y):
    order = np.argsort(p); r = np.empty(len(p)); r[order] = np.arange(1, len(p) + 1)
    n1 = y.sum(); n0 = len(y) - n1
    if n1 == 0 or n0 == 0:
        return np.nan
    return (r[y == 1].sum() - n1 * (n1 + 1) / 2) / (n1 * n0)


def main():
    frames, offs, dfns, recs, lines = [], [], [], [], []
    for yr in SEASONS:
        pbp = load_pbp(yr)
        frames.append(qb_games(pbp))
        o, d = team_pass_context(pbp)
        offs.append(o); dfns.append(d)
        recs.append(receiver_quality(pbp))
        lines.append(game_lines(pbp))
        print(f"  loaded {yr}", flush=True)
    df = pd.concat(frames, ignore_index=True)
    off = pd.concat(offs, ignore_index=True)
    dfn = pd.concat(dfns, ignore_index=True)
    rec = pd.concat(recs, ignore_index=True)
    lin = pd.concat(lines, ignore_index=True)

    print(f"\nraw QB-games: {len(df):,}")
    df = df[df["att"] >= MIN_ATT].copy()
    print(f"with {MIN_ATT}+ attempts: {len(df):,}  "
          f"({df.pid.nunique():,} QBs, {df.season.nunique()} seasons)")

    # ── base rates ────────────────────────────────────────────────────
    print("\n── passing TD base rates ──")
    print(f"  mean pass TD / start      {df.ptd.mean():.3f}")
    print(f"  variance                  {df.ptd.var():.3f}   "
          f"({'over' if df.ptd.var() > df.ptd.mean() else 'under'}dispersed vs Poisson)")
    for n in (1, 2, 3, 4):
        print(f"  {n}+ passing TDs           {(df.ptd >= n).mean():6.2%}")
    print("  distribution:", df.ptd.value_counts().sort_index().head(7).to_dict())

    df = df.merge(lin, on=["game_id", "team"], how="left")
    df = df.merge(rec, on=["game_id", "team"], how="left")

    # ── backward-looking features ─────────────────────────────────────
    df = df.sort_values(["season", "week", "game_id"]).reset_index(drop=True)
    df["one"] = 1.0
    # These two ship, so they're bounded to the window the Node build can see.
    df = prior_rate(df, "pid", "ptd", "one", "ptd_pg", window_seasons=PRIOR_SEASONS)
    df = prior_rate(df, "pid", "att", "one", "att_pg", window_seasons=PRIOR_SEASONS)
    df = prior_rate(df, "pid", "ptd", "att", "ptd_per_att")     # efficiency
    df = prior_rate(df, "pid", "rz_att", "one", "rzatt_pg")     # red-zone volume
    df = prior_rate(df, "pid", "rz_ptd", "rz_att", "rz_eff")    # red-zone efficiency
    df = prior_rate(df, "team", "rec_td", "one", "weapons")     # weapon quality (team)
    d2 = dfn.merge(df[["game_id", "season", "week"]].drop_duplicates(), on="game_id", how="inner")
    d2["one"] = 1.0
    d2 = prior_rate(d2, "defteam", "d_ptd", "one", "def_ptd_pg")
    df = df.merge(d2[["game_id", "defteam", "def_ptd_pg"]], on=["game_id", "defteam"], how="left")

    FEATS = ["implied_total", "ptd_pg", "att_pg", "ptd_per_att", "rzatt_pg",
             "rz_eff", "weapons", "def_ptd_pg", "dog_by"]
    df = df.dropna(subset=FEATS + ["ptd"]).reset_index(drop=True)
    print(f"\nmodelling rows: {len(df):,}")

    # Range-check every derived feature before trusting anything downstream. A
    # groupby/expanding chain that misaligns its index produces numbers that are
    # wrong but plausible-looking, and it has silently corrupted this pipeline
    # before — a team's red-zone trips once maxed out at 399 per game.
    print("\n── feature sanity (min / median / max) ──")
    SANE = {"implied_total": (5, 45), "ptd_pg": (0, 5), "att_pg": (5, 60),
            "ptd_per_att": (0, 0.25), "rzatt_pg": (0, 20), "rz_eff": (0, 1),
            "weapons": (0, 5), "def_ptd_pg": (0, 5), "dog_by": (-30, 30)}
    bad = []
    for f in FEATS:
        lo, hi = df[f].min(), df[f].max()
        ok = SANE[f][0] <= lo and hi <= SANE[f][1]
        print(f"  {f:<16} {lo:8.3f} {df[f].median():8.3f} {hi:8.3f}   {'' if ok else '<-- OUT OF RANGE'}")
        if not ok:
            bad.append(f)
    if bad:
        raise SystemExit(f"\nABORT: implausible feature ranges for {bad}. "
                         "Fix the derivation before reading any backtest number.")

    # ── is each feature a real trait? ─────────────────────────────────
    print("\n── split-half reliability (is it a trait or noise?) ──")
    wk = df[["game_id", "season", "week"]].drop_duplicates()
    sources = {"ptd": df, "att": df, "rz_att": df, "rz_ptd": df,
               "rec_td": rec.merge(wk, on="game_id", how="inner"),
               "d_ptd": dfn.merge(wk, on="game_id", how="inner")}
    for col, key in [("ptd", "pid"), ("att", "pid"), ("rz_att", "pid"),
                     ("rz_ptd", "pid"), ("rec_td", "team"), ("d_ptd", "defteam")]:
        r, n = split_half(sources[col].dropna(subset=[col]), key, col)
        verdict = "REAL trait" if r >= 0.4 else ("weak" if r >= 0.2 else "NOISE")
        print(f"  {col:<10} on {key:<8} r={r: .3f}  (n={n})   {verdict}")

    # ── correlation with the target ───────────────────────────────────
    print("\n── raw correlation with pass TDs ──")
    for f in FEATS:
        print(f"  {f:<16} {np.corrcoef(df[f], df.ptd)[0,1]: .4f}")

    # ── walk-forward backtest ─────────────────────────────────────────
    print("\n── walk-forward backtest (train on prior seasons, test on next) ──")
    mu = df[FEATS].mean(); sd = df[FEATS].std().replace(0, 1)
    ladder = {
        "M0 base rate only":      [],
        "M1 +implied total":      ["implied_total"],
        "M2 +volume":             ["implied_total", "att_pg"],
        "M3 +base rate":          ["implied_total", "att_pg", "ptd_pg"],
        "M4 +efficiency":         ["implied_total", "att_pg", "ptd_pg", "ptd_per_att"],
        "M5 +red zone":           ["implied_total", "att_pg", "ptd_pg", "ptd_per_att", "rzatt_pg", "rz_eff"],
        "M6 +weapons":            ["implied_total", "att_pg", "ptd_pg", "ptd_per_att", "rzatt_pg", "rz_eff", "weapons"],
        "M7 +defense":            ["implied_total", "att_pg", "ptd_pg", "ptd_per_att", "rzatt_pg", "rz_eff", "weapons", "def_ptd_pg"],
        "M8 +game script":        ["implied_total", "att_pg", "ptd_pg", "ptd_per_att", "rzatt_pg", "rz_eff", "weapons", "def_ptd_pg", "dog_by"],
    }
    test_seasons = [s for s in SEASONS if s >= 2018]
    results = {}
    for name, feats in ladder.items():
        preds, acts = [], []
        for ts in test_seasons:
            tr = df[df.season < ts]; te = df[df.season == ts]
            if len(tr) < 500 or not len(te):
                continue
            if feats:
                Xtr = np.column_stack([np.ones(len(tr))] + [((tr[f] - mu[f]) / sd[f]).values for f in feats])
                Xte = np.column_stack([np.ones(len(te))] + [((te[f] - mu[f]) / sd[f]).values for f in feats])
                w = fit_poisson(Xtr, tr.ptd.values)
                m = np.exp(np.clip(Xte @ w, -20, 20))
            else:
                m = np.full(len(te), tr.ptd.mean())
            preds.append(m); acts.append(te.ptd.values)
        m = np.concatenate(preds); a = np.concatenate(acts)
        # Poisson deviance-ish: mean negative log likelihood of the count
        nll = float(np.mean(m - a * np.log(np.maximum(m, 1e-9))))
        row = {"nll": nll, "mae": float(np.mean(np.abs(m - a)))}
        for line, need in [("O0.5", 1), ("O1.5", 2), ("O2.5", 3)]:
            p = pois_at_least(m, need); y = (a >= need).astype(float)
            row[line] = {"ll": float(-np.mean(y * np.log(p) + (1 - y) * np.log(1 - p))),
                         "auc": float(auc(p, y)), "ece": float(ece(p, y)),
                         "pred": float(p.mean()), "act": float(y.mean())}
        results[name] = row
        print(f"  {name:<22} nll {row['nll']:.4f}  MAE {row['mae']:.3f}   "
              + "  ".join(f"{k} ll {row[k]['ll']:.4f} auc {row[k]['auc']:.3f}"
                          for k in ("O0.5", "O1.5", "O2.5")))

    # ── negative control ──────────────────────────────────────────────
    rng = np.random.default_rng(17)
    sh = df.copy()
    sh["ptd"] = sh.groupby("season")["ptd"].transform(lambda s: rng.permutation(s.values))
    feats = ladder["M8 +game script"]
    preds, acts = [], []
    for ts in test_seasons:
        tr = sh[sh.season < ts]; te = sh[sh.season == ts]
        if len(tr) < 500 or not len(te):
            continue
        Xtr = np.column_stack([np.ones(len(tr))] + [((tr[f] - mu[f]) / sd[f]).values for f in feats])
        Xte = np.column_stack([np.ones(len(te))] + [((te[f] - mu[f]) / sd[f]).values for f in feats])
        w = fit_poisson(Xtr, tr.ptd.values)
        preds.append(np.exp(np.clip(Xte @ w, -20, 20))); acts.append(te.ptd.values)
    m = np.concatenate(preds); a = np.concatenate(acts)
    print(f"\n  negative control (target shuffled within season): "
          f"O1.5 auc {auc(pois_at_least(m, 2), (a >= 2).astype(float)):.3f}  (0.500 = dead)")

    best = ladder["M8 +game script"]
    print("\n── calibration of the best model, by line ──")
    for name in ("M6 +weapons", "M8 +game script"):
        r = results[name]
        print(f"  {name}")
        for k in ("O0.5", "O1.5", "O2.5"):
            print(f"    {k}: predicted {r[k]['pred']:.1%}  actual {r[k]['act']:.1%}  "
                  f"ECE {r[k]['ece']:.4f}")
    df.to_parquet(os.path.join(HERE, "passing_td.parquet"))
    print(f"\nwrote {os.path.join(HERE, 'passing_td.parquet')}")


if __name__ == "__main__":
    main()
