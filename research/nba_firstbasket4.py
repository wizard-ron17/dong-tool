"""First basket v4: who on the team scores it (research, Ron 11/13).

    python3 research/nba_firstbasket4.py

The closes study (11/13, 131 live games) split the gap: our team-first half ties the market (log loss .6830 vs
.6834), but within the team the market beats one-in-five by .019 and ours (own first baskets per start, shrunk to
position) only ties it. So: which starter on the team that scores first makes the basket. Walk-forward in date
order, each starter's inputs from earlier games only:
    own   first baskets per start, shrunk to position (what ships, K 40)
    fga   recent field-goal attempts per start (EWMA, half-life H starts, shrunk to the league starter mean)
    fgm   the same for makes
    pct   his FG% (makes / attempts, shrunk 50 attempts to .47)
    fs    first-shot share (took his team's first FGA), 2023-24 on only (.cache/nba_fs)
weight = exp(sum b_k log x_k), softmax over the team's five, b fit by max likelihood on earlier seasons, scored
on the next, given his team scored first.
"""
import glob, json, os, sys
from collections import defaultdict
import numpy as np, pandas as pd
from scipy.optimize import minimize
HERE = os.path.dirname(os.path.abspath(__file__))
POS = {"PG": "G", "SG": "G", "G": "G", "SF": "F", "PF": "F", "F": "F", "C": "C"}
K_FB, H = 40, 15
A = 0.5 ** (1 / H)


def load():
    games = []
    for f in glob.glob(os.path.join(HERE, ".cache", "nba", "*", "*.json")):
        d = json.load(open(f)); g = d["game"]
        if g["type"] != 2 or not g.get("first_fg"): continue
        st = [p for p in d["players"] if p["starter"]]
        if len(st) != 10: continue
        games.append((g["date"], g, st, [p for p in d["players"] if (p.get("min") or 0) > 0]))
    games.sort(key=lambda x: x[0])
    FS = {}
    for f in glob.glob(os.path.join(HERE, ".cache", "nba_fs", "*.json")):
        d = json.load(open(f)); FS[str(d["eid"])] = d["fga"]
    return games, FS


def build(games, FS):
    fbc, sc = defaultdict(float), defaultdict(float)
    posf, poss = defaultdict(float), defaultdict(float)
    ef, em, ew = defaultdict(float), defaultdict(float), defaultdict(float)   # EWMA sums of fga, fgm, weight
    cm, ca = defaultdict(float), defaultdict(float)                           # career makes / attempts
    fst, fsn = defaultdict(float), defaultdict(float)                          # first-shot took / starts with data
    sa, sm, sg = defaultdict(float), defaultdict(float), defaultdict(float)   # this season's fga, fgm, games (the build's inputs)
    lf, lfn = 0.0, 0.0                                                         # league starter fga per start
    rows = []
    for _, g, st, played in games:
        gid = str(g["id"]); win = g["first_fg"]["pid"]; wteam = g["first_fg"].get("team")
        pos = {p["pid"]: POS.get(p.get("pos") or "", "?") for p in st}
        lg = {k: (posf[k] + 1) / (poss[k] + 10) for k in ("G", "F", "C", "?")}
        lfa = 12.0                        # league starter FGA per game, fixed so the build can match it
        fsrows = FS.get(gid)
        if sc and wteam in (g["home"], g["away"]):
            for p in st:
                if p["team"] != wteam: continue
                pid = p["pid"]
                own = (fbc[pid] + K_FB * lg.get(pos[pid], 0.1)) / (sc[pid] + K_FB)
                fga = (ef[pid] + 5 * lfa) / (ew[pid] + 5)
                fgm = (em[pid] + 5 * lfa * 0.47) / (ew[pid] + 5)
                pct = (cm[pid] + 50 * 0.47) / (ca[pid] + 50)
                k = (g['season'], pid)
                fgaS = (sa[k] + 5 * lfa) / (sg[k] + 5)
                pctS = (sm[k] + 50 * 0.47) / (sa[k] + 50)
                fs = (fst[pid] + 10 * 0.2) / (fsn[pid] + 10)
                rows.append(dict(season=g["season"], gid=gid, pid=pid, pos=pos[pid], y=float(pid == win),
                                 own=own, fgaS=fgaS, pctS=pctS, fga=fga, fgm=fgm, pct=pct, fs=fs, hasfs=fsrows is not None and fsn[pid] >= 5))
        # update with this game
        first_by = {}
        if fsrows:
            tid_of = {}
            for t, team, pid, made in fsrows:
                if pid and team not in first_by: first_by[team] = str(pid)
        took = set(first_by.values())
        for p in st:
            pid = p["pid"]; sc[pid] += 1; poss[pos[pid]] += 1
            if pid == win: fbc[pid] += 1; posf[pos[pid]] += 1
            fa, fm = float(p.get("fga") or 0), float(p.get("fgm") or 0)
            ef[pid] = A * ef[pid] + fa; em[pid] = A * em[pid] + fm; ew[pid] = A * ew[pid] + 1
            ca[pid] += fa; cm[pid] += fm; lf += fa; lfn += 1
            if fsrows: fsn[pid] += 1; fst[pid] += float(str(pid) in took)
        for p in played:                  # this season's totals over every game he played, as the build keeps them
            k = (g['season'], p['pid']); sa[k] += float(p.get('fga') or 0); sm[k] += float(p.get('fgm') or 0); sg[k] += 1
    R = pd.DataFrame(rows)
    # keep teams with exactly five starters and the winner among them
    n = R.groupby(["gid"]).y.agg(["size", "sum"])
    keep = n[(n["size"] == 5) & (n["sum"] == 1)].index
    return R[R.gid.isin(keep)].reset_index(drop=True)


def fit(R, feats):
    X = np.log(R[feats].values); y = R.y.values; g = pd.factorize(R.gid)[0]
    def nll(b):
        s = X @ b; m = np.exp(s - s.max()); z = np.bincount(g, m)[g]
        return -np.sum(y * np.log(m / z))
    return minimize(nll, np.ones(len(feats)) * 0.5, method="BFGS").x


def score(R, feats, b):
    s = np.log(R[feats].values) @ b; m = np.exp(s); z = R.assign(m=m).groupby("gid").m.transform("sum").values
    p = m / z
    return float(-np.mean(np.log(p[R.y.values == 1]))), p


def main():
    games, FS = load()
    R = build(games, FS)
    seasons = sorted(R.season.unique())
    print(f"{R.gid.nunique():,} team-firsts, {seasons[0]}..{seasons[-1]}; uniform log(5) = {np.log(5):.4f}")
    sets = [["own"], ["fga"], ["fgm"], ["pct"], ["own", "fga"], ["own", "fgm"], ["own", "fga", "pct"], ["own", "fgaS", "pctS"], ["own", "fgaS"]]
    print("season   n    " + "  ".join(f"{'+'.join(s):>14s}" for s in sets))
    tot = defaultdict(list)
    for s in seasons[3:]:
        tr, te = R[R.season < s], R[R.season == s]
        out = []
        for fs_ in sets:
            b = fit(tr, fs_); l, _ = score(te, fs_, b); out.append(l); tot["+".join(fs_)].append((l, te.gid.nunique()))
        print(f"{s} {te.gid.nunique():5d} " + "  ".join(f"{v:14.4f}" for v in out))
    for k, v in tot.items():
        print(f"  pooled {k:14s} {sum(l*n for l,n in v)/sum(n for _,n in v):.4f}")
    for fs_ in (["own"], ["own", "fga", "pct"], ["own", "fgaS", "pctS"]): print("coefs", fs_, "all seasons:", fit(R, fs_).round(3))
    # first-shot share, where we have it
    F = R[R.hasfs]
    G5 = F.groupby("gid").size(); F = F[F.gid.isin(G5[G5 == 5].index)]
    print(f"\nwith first-shot share ({F.gid.nunique():,} team-firsts, {sorted(F.season.unique())}):")
    for s in sorted(F.season.unique())[1:]:
        tr, te = F[F.season < s], F[F.season == s]
        if te.gid.nunique() < 100: continue
        res = []
        for fs_ in (["own", "fga", "pct"], ["own", "fga", "pct", "fs"], ["fs"]):
            b = fit(tr, fs_); res.append(f"{'+'.join(fs_)} {score(te, fs_, b)[0]:.4f} b={np.round(b,2).tolist()}")
        print(f"  {s} n {te.gid.nunique()}: " + " | ".join(res))


def export(R):
    """Write the season-to-date fit into nba_model.json first.within (the build's fbWeight reads it)."""
    b = fit(R, ["own", "fgaS", "pctS"])
    p = os.path.join(HERE, "nba_model.json"); M = json.load(open(p))
    M["first"]["within"] = {"note": "research/nba_firstbasket4.py: weight = own^b_own x fga^b_fga x pct^b_pct over the team's five. own = the k_fb share; fga = (season FGA + fga_k x fga0) / (games + fga_k); pct = (season FGM + pct_k x pct0) / (season FGA + pct_k). Season totals over every game played.",
                            "b_own": round(float(b[0]), 3), "b_fga": round(float(b[1]), 3), "b_pct": round(float(b[2]), 3),
                            "fga_k": 5, "fga0": 12.0, "pct_k": 50, "pct0": 0.47}
    json.dump(M, open(p, "w"), indent=1); print("exported", M["first"]["within"])


if __name__ == "__main__":
    if "--export" in sys.argv:
        g, FS = load(); export(build(g, FS))
    else:
        main()
