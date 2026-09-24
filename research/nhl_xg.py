"""Shot quality and goalie quality: an expected-goals model, and the as-of
features it makes possible, for the shots / goals / points models to test.

  xG model   logistic on every unblocked attempt (goals, shots on goal, misses)
             with a goalie in net: distance and angle to the net being attacked,
             shot type, rebound (the team's previous attempt within 3 s), and
             manpower (power play / shorthanded). Walk-forward: each season's
             shots are scored by a model fit on the seasons before it (the
             first season on itself — it only ever feeds priors).
  skater     ixg     his expected goals per game, career-to-date, shrunk
             ixg_l10 his last ten games
             finish  (goals + k) / (ixG + k) — finishing above expected, shrunk hard
  goalie     the opposing starter (the goalie in net for the first shot he
             faced): goals saved above expected per 100 unblocked shots,
             career-to-date and shrunk; and whether he is his club's usual
             starter or a backup (share of the club's last 20 starts)
  team       opponent's expected goals against per game (defensive shot quality
             allowed), vs the goals-against rate the models use now

Everything is as-of: a game's features come only from games before it.

    python3 research/nhl_xg.py      # -> research/nhl_xg_features.parquet (+ prints the xG model's fit)
"""
import glob, json, math, os, sys
import numpy as np
import pandas as pd

HERE = os.path.dirname(os.path.abspath(__file__))
CACHE = os.environ.get("NHL_CACHE") or "/tmp/nhl-cache"
OUT = os.path.join(HERE, "nhl_xg_features.parquet")
TYPES = ["wrist", "snap", "slap", "backhand", "tip-in", "deflected", "wrap-around"]


def shots():
    rows = []
    for f in glob.glob(os.path.join(CACHE, "20*", "pbp", "*.json")):
        season = int(f.split(os.sep)[-3]); gid = int(os.path.basename(f)[:-5])
        g = json.load(open(f))
        side = {int(k): v for k, v in (g.get("homeDefending") or {}).items()}
        last = {}
        for per, sec, kind, x, y, st, shooter, goalie, tid, sit, zone, ptype in g["shots"]:
            if ptype == "SO" or per is None: continue
            home = tid == g["homeId"]
            t = (per - 1) * 1200 + sec
            prev = last.get(tid); last[tid] = (per, sec)
            rebound = prev is not None and prev[0] == per and 0 <= sec - prev[1] <= 3
            if kind == "b" or x is None or y is None: continue
            # the net this team attacks this period: opposite the one home defends
            d = side.get(per)
            if d in ("left", "right"):
                home_net = -89 if d == "left" else 89           # the net home defends
                net = -home_net if home else home_net
            else:
                net = 89 if x >= 0 else -89
            dx, dy = abs(net - x), abs(y)
            dist = math.hypot(dx, dy)
            ang = math.degrees(math.atan2(dy, dx if abs(x) <= 89 else -dx)) if dist else 0.0
            s = str(sit or "1551").zfill(4)
            ag, ask, hsk, hg = int(s[0]), int(s[1]), int(s[2]), int(s[3])
            own, opp, opp_goalie = (hsk, ask, ag) if home else (ask, hsk, hg)
            rows.append((season, gid, t, per, home, tid, shooter, goalie, kind == "g", dist, ang, st or "wrist",
                         rebound, own > opp, own < opp, opp_goalie == 0 or goalie is None))
    S = pd.DataFrame(rows, columns=["season", "gid", "t", "per", "home", "tid", "shooter", "goalie", "goal", "dist", "ang",
                                    "stype", "rebound", "pp", "sh", "en"])
    return S.sort_values(["season", "gid", "t"]).reset_index(drop=True)


def design(S):
    d = S.dist.clip(1, 100).to_numpy(float)
    a = S.ang.clip(0, 180).to_numpy(float) / 90
    X = [np.ones(len(S)), np.log(d), d / 30, a, a * a, S.rebound.to_numpy(float),
         S.pp.to_numpy(float), S.sh.to_numpy(float), S.rebound.to_numpy(float) * a]
    for t in TYPES[1:]:
        X.append((S.stype == t).to_numpy(float))
    return np.column_stack(X)


def logit_irls(X, y, ridge=1.0, it=50):
    b = np.zeros(X.shape[1]); b[0] = math.log(y.mean() / (1 - y.mean()))
    for _ in range(it):
        p = 1 / (1 + np.exp(-np.clip(X @ b, -30, 30)))
        W = np.maximum(p * (1 - p), 1e-9)
        z = X @ b + (y - p) / W
        A = X.T @ (X * W[:, None]) + ridge * np.eye(X.shape[1]); A[0, 0] -= ridge
        nb = np.linalg.solve(A, X.T @ (W * z))
        if np.max(np.abs(nb - b)) < 1e-8: b = nb; break
        b = nb
    return b


def auc(p, y):
    o = np.argsort(p); r = np.empty(len(p)); r[o] = np.arange(1, len(p) + 1)
    n1 = y.sum(); n0 = len(y) - n1
    return float((r[y == 1].sum() - n1 * (n1 + 1) / 2) / (n1 * n0))


def fit_xg(S):
    """xG for every non-empty-net unblocked attempt, walk-forward by season."""
    S = S.copy(); S["xg"] = np.nan
    live = ~S.en
    seasons = sorted(S.season.unique())
    print("xG model, held out by season:")
    for s in seasons:
        tr = S[live & (S.season < s)] if s != seasons[0] else S[live & (S.season == s)]
        te = S[live & (S.season == s)]
        b = logit_irls(design(tr), tr.goal.to_numpy(float))
        p = 1 / (1 + np.exp(-(design(te) @ b)))
        S.loc[te.index, "xg"] = p
        y = te.goal.to_numpy(float)
        bd = logit_irls(np.column_stack([np.ones(len(tr)), np.log(tr.dist.clip(1, 100))]), tr.goal.to_numpy(float))
        pd_ = 1 / (1 + np.exp(-(np.column_stack([np.ones(len(te)), np.log(te.dist.clip(1, 100))]) @ bd)))
        ll = lambda q: float(-(y * np.log(q) + (1 - y) * np.log(1 - q)).mean())
        print(f"  {s}{' (in-sample)' if s == seasons[0] else ''}: {len(te):,} attempts, {y.mean():.3f} goal rate, "
              f"xG sum {p.sum():.0f} vs {y.sum():.0f} goals · AUC {auc(p, y):.3f} (distance alone {auc(pd_, y):.3f}) · log loss {ll(p):.4f} vs {ll(pd_):.4f}")
    return S


def asof(df, key, num, den, k, prior):
    """(cumulative num before this row + k*prior) / (cumulative den before + k), by key in row order."""
    cn = df.groupby(key, sort=False)[num].cumsum() - df[num]
    cd = df.groupby(key, sort=False)[den].cumsum() - df[den]
    return (cn + k * prior) / (cd + k)


def build():
    S = fit_xg(shots())
    games = {}
    for f in glob.glob(os.path.join(CACHE, "20*", "games.json")):
        for g in json.load(open(f)): games[g["gid"]] = g
    S["date"] = S.gid.map(lambda x: games.get(x, {}).get("date"))
    S = S[S.date.notna()]
    xs = S[~S.en]

    # ── skaters: xG per game from his unblocked, goalie-in-net attempts ──
    per = xs.groupby(["shooter", "gid", "date", "season"]).agg(ixg=("xg", "sum")).reset_index()
    per = per.rename(columns={"shooter": "pid"})
    gid_of = {(g["date"], g["home"]): gid for gid, g in games.items()} | {(g["date"], g["away"]): gid for gid, g in games.items()}
    # is club tid the home side of game gid? -> the club it shoots at is the other one
    is_home = S.groupby(["gid", "tid"]).home.first().to_dict()
    def_team = lambda gid, tid: games[gid]["away"] if is_home.get((gid, tid)) else games[gid]["home"]
    # every game he played (from the dataset), with 0 xG where he took no attempt
    full = pd.read_parquet(os.path.join(HERE, "nhl_sog.parquet"), columns=["season", "date", "pid", "team", "role", "goals"])
    full = full.merge(per[["pid", "date", "ixg"]], on=["pid", "date"], how="left").fillna({"ixg": 0.0})
    full = full.sort_values(["pid", "date"]).reset_index(drop=True); full["one"] = 1.0
    role_mean = full.groupby("role").ixg.mean().to_dict()
    full["ixg_prior"] = asof(full, "pid", "ixg", "one", 16.0, full.role.map(role_mean))
    full["ixg_l10"] = full.groupby("pid", sort=False).ixg.transform(lambda s: s.shift(1).rolling(10, min_periods=2).mean()).fillna(full.ixg_prior)
    # finishing: goals per expected goal, career-to-date, shrunk toward 1 with 8 xG of weight
    cg = full.groupby("pid", sort=False).goals.cumsum() - full.goals
    cx = full.groupby("pid", sort=False).ixg.cumsum() - full.ixg
    full["finish"] = (cg + 8.0) / (cx + 8.0)

    # ── goalies: the starter each club faced, and his as-of GSAx ──
    first = S.sort_values(["gid", "t"]).dropna(subset=["goalie"]).groupby(["gid", "tid"]).goalie.first().reset_index()   # shooting club -> goalie it faced first
    gsh = xs.dropna(subset=["goalie"]).groupby(["goalie", "gid", "date", "season"]).agg(xga=("xg", "sum"), ga=("goal", "sum"), sa=("xg", "size")).reset_index()
    gsh = gsh.sort_values(["goalie", "date"]).reset_index(drop=True)
    gsh["gsax100"] = 100 * asof(gsh.assign(gsax=gsh.xga - gsh.ga), "goalie", "gsax", "sa", 1500.0, 0.0)
    gsh["svx_n"] = gsh.groupby("goalie", sort=False).sa.cumsum() - gsh.sa
    gk = gsh.set_index(["goalie", "gid"])[["gsax100", "svx_n"]].to_dict("index")
    # starter share: of the defending club's previous 20 games, how many this goalie started
    first["def_team"] = [def_team(g, t) for g, t in zip(first.gid, first.tid)]
    first["date"] = first.gid.map(lambda x: games[x]["date"])
    first = first.sort_values(["def_team", "date"]).reset_index(drop=True)
    shares = []
    hist = {}
    for r in first.itertuples():
        h = hist.setdefault(r.def_team, [])
        last = h[-20:]
        shares.append(sum(1 for x in last if x == r.goalie) / len(last) if last else np.nan)
        h.append(r.goalie)
    first["starter_share"] = shares
    first["opp_gsax100"] = [gk.get((g, gid), {}).get("gsax100", 0.0) for g, gid in zip(first.goalie, first.gid)]

    # ── team defence: expected goals against per game, as-of ──
    tx = S[~S.en].groupby(["gid", "tid"]).xg.sum().reset_index()
    tx["def_team"] = [def_team(g, t) for g, t in zip(tx.gid, tx.tid)]
    tx["date"] = tx.gid.map(lambda x: games[x]["date"])
    tx = tx.sort_values(["def_team", "date"]).reset_index(drop=True); tx["one"] = 1.0
    tx["xga_prior"] = asof(tx, "def_team", "xg", "one", 10.0, tx.xg.mean())

    # attach to the player-game rows: his shooting club tid faces def_team = his opponent
    tid_of = S.groupby(["gid", "home"]).tid.first().to_dict()
    full["gid"] = [gid_of.get((d, t)) for d, t in zip(full.date, full.team)]
    full["tid"] = [tid_of.get((g, games[g]["home"] == t)) if g in games else None for g, t in zip(full.gid, full.team)]
    gmap = first.set_index(["gid", "tid"])[["goalie", "opp_gsax100", "starter_share"]].to_dict("index")
    xmap = tx.set_index(["gid", "tid"])["xga_prior"].to_dict()
    full["opp_goalie"] = [gmap.get((g, t), {}).get("goalie") for g, t in zip(full.gid, full.tid)]
    full["opp_gsax100"] = [gmap.get((g, t), {}).get("opp_gsax100", np.nan) for g, t in zip(full.gid, full.tid)]
    full["opp_starter_share"] = [gmap.get((g, t), {}).get("starter_share", np.nan) for g, t in zip(full.gid, full.tid)]
    full["opp_xga_prior"] = [xmap.get((g, t), np.nan) for g, t in zip(full.gid, full.tid)]
    keep = ["season", "date", "pid", "ixg", "ixg_prior", "ixg_l10", "finish", "opp_goalie", "opp_gsax100", "opp_starter_share", "opp_xga_prior"]
    full[keep].to_parquet(OUT)
    print(f"\nfeatures for {len(full):,} skater-games · opposing starter known for {full.opp_goalie.notna().mean():.1%}, "
          f"opponent xGA for {full.opp_xga_prior.notna().mean():.1%}")
    return full


if __name__ == "__main__":
    build()
