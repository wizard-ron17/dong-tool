"""First basket v2: tip, then position and his own first-basket record (research).

    python3 research/nba_firstbasket2.py

v1 (nba_firstbasket.py) found the tip decides the team (the tip winner scores
first ~65%) and that centres score first most (14% a start vs 8% for guards)
— the opposite of shot volume, so "his share of the starters' shots" lost to
the tip alone. v2 is an online walk-forward in date order: every game is
priced from the games before it, as a live board would be.

  P(team first) = P(win tip) * e + (1 - P(win tip)) * (1 - e)
      P(win tip): the two jumpers' tip records so far, log5, each shrunk
                  toward .500 (k = 20 jumps)
      e:          the rate the tip winner scores first, so far
  P(him | team first) = w_i / sum(w over his team's five starters)
      w_i: his first baskets per start as a starter, shrunk toward his
           position's rate (k = 40 starts) — the NFL first-TD shape

Pre-game the jumpers are nearly always the two starting centres, so the
actual jumpers stand in for the projected ones here. The walk-forward is
scored from season two on (season one only warms the records up).
"""
import glob, json, os
from collections import defaultdict
import numpy as np
import pandas as pd

HERE = os.path.dirname(os.path.abspath(__file__))
K_TIP, K_FB = 20, 40
POS = {"PG": "G", "SG": "G", "G": "G", "SF": "F", "PF": "F", "F": "F", "C": "C", "GF": "F", "FC": "C"}


def ll(p, y):
    p = np.clip(np.asarray(p, float), 1e-6, 1 - 1e-6); y = np.asarray(y, float)
    return float(-(y * np.log(p) + (1 - y) * np.log(1 - p)).mean())


def main(export=True):
    games = []
    for f in glob.glob(os.path.join(HERE, ".cache", "nba", "*", "*.json")):
        d = json.load(open(f)); g = d["game"]
        if g["type"] != 2 or not g.get("first_fg") or not g.get("tip_team"): continue
        st = [p for p in d["players"] if p["starter"]]
        if len(st) != 10: continue
        games.append((g["date"], g, st))
    games.sort(key=lambda x: x[0])
    first_season = games[0][1]["season"]
    tipw, tipn = defaultdict(float), defaultdict(float)        # jumper -> tips won / taken
    fbc, sc = defaultdict(float), defaultdict(float)           # player -> first baskets / starts
    posf, poss = defaultdict(float), defaultdict(float)        # position -> first baskets / starts
    e_w, e_n = 0.0, 0.0
    rows = []
    for _, g, st in games:
        pos = {p["pid"]: POS.get(p.get("pos") or "", "?") for p in st}   # ESPN mixes G/F/C with PG/SG/SF/PF
        jump = g.get("jump") or []
        by_team = {t: [p for p in st if p["team"] == t] for t in (g["home"], g["away"])}
        # which team each jumper belongs to
        jt = {p["pid"]: p["team"] for p in st}
        if g["season"] != first_season and len(jump) == 2 and all(j in jt for j in jump) and jt[jump[0]] != jt[jump[1]]:
            a, b = jump
            ra = (tipw[a] + K_TIP * 0.5) / (tipn[a] + K_TIP); rb = (tipw[b] + K_TIP * 0.5) / (tipn[b] + K_TIP)
            pa = ra * (1 - rb) / (ra * (1 - rb) + rb * (1 - ra))                     # log5
            e = (e_w + 20 * 0.62) / (e_n + 20)
            pwin = {jt[a]: pa, jt[b]: 1 - pa}
            for team, mates in by_team.items():
                pt_tip = pwin[team] * e + (1 - pwin[team]) * (1 - e)                 # jumper records
                pt_coin = 0.5                                                          # nothing known
                pt_known = e if team == g["tip_team"] else 1 - e                      # the tip as if known
                lg = {k: (posf[k] + 1) / (poss[k] + 10) for k in ("G", "F", "C", "?")}
                w = np.array([(fbc[p["pid"]] + K_FB * lg.get(pos[p["pid"]], 0.1)) / (sc[p["pid"]] + K_FB) for p in mates])
                wp = np.array([lg.get(pos[p["pid"]], 0.1) for p in mates])
                sp = g.get("spread")
                line = (-sp if team == g["home"] else sp) if sp is not None else np.nan   # his team's implied margin
                for i, p in enumerate(mates):
                    rows.append({"season": g["season"], "gid": g["id"], "team": team, "pt_tip": pt_tip, "line": line,
                                 "share": w[i] / w.sum(), "pid": p["pid"], "pos": pos[p["pid"]],
                                 "y": float(p["pid"] == g["first_fg"]["pid"]), "date": g["date"],
                                 "flat": 0.1, "coin_pos": pt_coin * wp[i] / wp.sum(),
                                 "tip_pos": pt_tip * wp[i] / wp.sum(), "tip_own": pt_tip * w[i] / w.sum(),
                                 "known_own": pt_known * w[i] / w.sum()})
        # update the records with this game
        if len(jump) == 2 and all(j in jt for j in jump):
            for j in jump:
                tipn[j] += 1; tipw[j] += float(jt[j] == g["tip_team"])
        e_n += 1; e_w += float(g["tip_team"] == g["first_fg"]["team"])
        for p in st:
            sc[p["pid"]] += 1; poss[pos[p["pid"]]] += 1
            if p["pid"] == g["first_fg"]["pid"]:
                fbc[p["pid"]] += 1; posf[pos[p["pid"]]] += 1
    R = pd.DataFrame(rows)
    # v3: the team side as a logistic on the tip model and the line, fit on earlier seasons only
    Tm = R.drop_duplicates(["gid", "team"]).copy()
    Tm["yt"] = R.groupby(["gid", "team"]).y.sum().reindex(pd.MultiIndex.from_frame(Tm[["gid", "team"]])).values
    Tm["line"] = Tm.line.fillna(0.0)
    lgt = lambda p: np.log(p / (1 - p))
    R["tip_line_own"] = np.nan
    for s in sorted(Tm.season.unique())[1:]:
        tr, te = Tm[Tm.season < s], Tm[Tm.season == s]
        X = np.column_stack([np.ones(len(tr)), lgt(tr.pt_tip), tr.line]); b = np.zeros(3); yv = tr.yt.values
        for _ in range(40):
            pp = 1 / (1 + np.exp(-X @ b)); W = pp * (1 - pp)
            b += np.linalg.solve(X.T @ (X * W[:, None]) + 1e-6 * np.eye(3), X.T @ (yv - pp))
        pt = 1 / (1 + np.exp(-(b[0] + b[1] * lgt(te.pt_tip) + b[2] * te.line)))
        m = dict(zip(zip(te.gid, te.team), pt))
        sel = R.season == s
        R.loc[sel, "tip_line_own"] = [m[(g, t)] * sh for g, t, sh in zip(R.gid[sel], R.team[sel], R.share[sel])]
    R = R.dropna(subset=["tip_line_own"])
    print(f"{R.gid.nunique():,} games priced walk-forward ({R.season.min()}..{R.season.max()}), {len(R):,} starter-games\n")
    print(f"{'model':46s} {'log loss':>9s}")
    for k, lab in (("flat", "one in ten"), ("coin_pos", "coin-flip team x position"),
                   ("tip_pos", "jumpers' tip records x position"), ("tip_own", "jumpers' tip records x his own record"),
                   ("tip_line_own", "tip records + the line x his own record"),
                   ("known_own", "tip winner known x his own record (ceiling)")):
        print(f"{lab:46s} {ll(R[k], R.y):9.5f}")
    best = "tip_line_own"
    R["q"] = pd.qcut(R[best], 6, labels=False, duplicates="drop")
    print(f"\ncalibration, tip records + the line x his own record:")
    for q, r in R.groupby("q"): print(f"  priced {r[best].mean():.3f}  actual {r.y.mean():.3f}  (n {len(r):,})  ≈ {100 / r[best].mean() - 100:+.0f} fair")
    top = R.sort_values(best, ascending=False).groupby("gid").head(1)
    print(f"\neach game's top-priced player: priced {top[best].mean():.3f}, scored first {top.y.mean():.3f} ({len(top):,} games)")
    print(f"by position, priced vs actual: " + ", ".join(f"{k} {r[best].mean():.3f}/{r.y.mean():.3f}" for k, r in R.groupby("pos") if len(r) > 1000))

    if not export: return R                                  # research/nba_due.py reuses the walk-forward prices
    # ── export for the build: the same pieces, fit on every season ──────────
    X = np.column_stack([np.ones(len(Tm)), lgt(Tm.pt_tip), Tm.line]); bb = np.zeros(3); yv = Tm.yt.values
    for _ in range(40):
        pp = 1 / (1 + np.exp(-X @ bb)); W = pp * (1 - pp)
        bb += np.linalg.solve(X.T @ (X * W[:, None]) + 1e-6 * np.eye(3), X.T @ (yv - pp))
    first = {
        "note": "research/nba_firstbasket2.py — first made field goal. P(team first) = logistic(const + tip * logit(pt_tip) + line * his team's implied margin), pt_tip = P(win tip) * e + (1 - P(win tip)) * (1 - e), P(win tip) = log5 of the jumpers' tip records shrunk k_tip jumps to .500. P(him | team first) = w / sum(w over his team's 5 starters), w = (first baskets + k_fb * position rate) / (starts + k_fb). Starters only: a starter scored the first basket in every game.",
        "k_tip": K_TIP, "k_fb": K_FB, "e_prior": [0.62, 20], "e": float((e_w + 20 * 0.62) / (e_n + 20)),
        "team": {"const": float(bb[0]), "tip": float(bb[1]), "line": float(bb[2])},
        "pos_rate": {k: float((posf[k] + 1) / (poss[k] + 10)) for k in ("G", "F", "C")},
        "positions": POS,
    }
    MP = os.path.join(HERE, "nba_model.json")
    M = json.load(open(MP)); M["first"] = first; json.dump(M, open(MP, "w"), indent=1)
    print(f"\nexported to nba_model.json: e {first['e']:.3f}, team {first['team']}, pos {first['pos_rate']}")


if __name__ == "__main__":
    main()
