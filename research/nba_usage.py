"""Points / PRA: the inputs the outside models lean on that ours doesn't have (research, Ron 11/13).

    python3 research/nba_usage.py

Ours prices points as projected minutes x his per-minute rate x the game (nba_stats.py). When a teammate sits, the
minutes model hands his minutes on (vacated, depth), but the RATE never moves. Every DFS / props shop says the edge is
the usage a missing scorer leaves behind (on/off usage splits), and that defense matters by position. So, walk-forward
on the same rows and ladders as nba_stats.py:
  vac_share   last-10 points of tonight's absent teammates / (that + the available rotation's), the team's lost scoring
  vac_his     vac_share x his share of the available rotation's last-10 points (the star absorbs more)
  vac_fam     the same, absentees in his position family only
  opp_fam     the opponent's allowance of this stat per minute to his position family so far, / league family rate
Absences two ways: KNOWN (out tonight and also missed the team's last game: what any injury report carries, the
minutes model's rule) and ALL (every rotation absence, hindsight: an upper bound, not shippable).
"""
import os, sys
import numpy as np, pandas as pd
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
argv, sys.argv = sys.argv, sys.argv[:1]
import nba_stats as S, nba_minutes as NM
sys.argv = argv
import json; SD = json.load(open(os.path.join(HERE, "nba_model.json")))["minutes"]["lineup"]["sd"]


def absences():
    P = NM.features(NM.load())
    P = P.sort_values(["pid", "date", "gid"])
    pl = P[~P.dnp]
    for st in ("pts", "reb", "ast"):
        P[f"{st}10"] = np.nan
        P.loc[~P.dnp, f"{st}10"] = pl.groupby("pid")[st].transform(lambda s: s.astype(float).shift(1).rolling(10, min_periods=1).mean())
        P[f"{st}10"] = P.groupby("pid")[f"{st}10"].transform(lambda s: s.ffill())
    P["pra10"] = P.pts10 + P.reb10 + P.ast10
    P = P.sort_values(["pid", "team", "tn"])
    new_out = P.dnp & (P.m10_any >= 10) & ((P.tn - P.last_played_tn) <= 3)
    prev_dnp = P.groupby(["pid", "team"]).dnp.shift(1).fillna(False).astype(bool)
    P["out_known"] = new_out & prev_dnp; P["out_all"] = new_out
    long_out = P.dnp & ~((P.tn - P.last_played_tn) <= 3)
    P["rot"] = (P.m10_any >= 10) & ~long_out
    return P


def vac_feats(P, kind, st):
    out = P[f"out_{kind}"]; v = P[f"{st}10"].fillna(0)
    lost = P[out].groupby(["gid", "team"])[f"{st}10"].sum().rename("lost")
    lostf = P[out].groupby(["gid", "team", "fam"])[f"{st}10"].sum().rename("lostf")
    avail = P[P.rot & ~out].groupby(["gid", "team"])[f"{st}10"].sum().rename("avail")
    F = P[~P.dnp][["gid", "pid", "team", "fam", f"{st}10"]].merge(lost, on=["gid", "team"], how="left").merge(avail, on=["gid", "team"], how="left") \
        .merge(lostf, on=["gid", "team", "fam"], how="left").fillna({"lost": 0, "lostf": 0})
    F["avail"] = F.avail.fillna(F[f"{st}10"]).clip(lower=1)
    F[f"vs_{kind}"] = F.lost / (F.lost + F.avail)
    F[f"vh_{kind}"] = F[f"vs_{kind}"] * (F[f"{st}10"].fillna(0) / F.avail).clip(0, 1)
    F[f"vf_{kind}"] = F.lostf / (F.lost + F.avail)
    return F[["gid", "pid", f"vs_{kind}", f"vh_{kind}", f"vf_{kind}"]]


def opp_fam(D, st):
    """Allowance to his family per minute this season so far (shrunk 300 minutes), / last season's family rate."""
    T = D.sort_values("date")[["gid", "date", "season", "opp", "fam", st, "min"]].copy()
    g = T.groupby(["season", "opp", "fam"])
    T["a_st"] = g[st].cumsum() - T[st]; T["a_min"] = g["min"].cumsum() - T["min"]
    # rows from the same game shouldn't see each other: take the cumulative state at the game's first row
    first = T.groupby(["gid", "opp", "fam"])[["a_st", "a_min"]].transform("min")
    fr = D[f"fr_{st}"]
    T["of"] = ((first.a_st + 300 * fr.loc[T.index]) / (first.a_min + 300)) / fr.loc[T.index]
    return T.of.clip(0.75, 1.3)


def main():
    D, league, _ = S.build()
    P = absences()
    ss = sorted(D.season.unique())
    for st in ("pts", "pra"):
        base_st = st
        F = D[["gid", "pid"]].copy()
        for kind in ("known", "all"):
            F = F.merge(vac_feats(P, kind, st), on=["gid", "pid"], how="left")
        X0 = D.merge(F, on=["gid", "pid"], how="left")
        X0.index = D.index
        for c in F.columns[2:]: X0[c] = X0[c].fillna(0)
        X0["lof"] = np.log(opp_fam(D, st))
        variants = {
            "ships": [],
            "+opp_fam": ["lof"],
            "+vac known": ["vs_known", "vh_known"],
            "+vac known +fam": ["vs_known", "vh_known", "vf_known"],
            "+vac known +opp_fam": ["vs_known", "vh_known", "lof"],
            "+vac ALL (hindsight)": ["vs_all", "vh_all"],
        }
        print(f"\n{st}: walk-forward {ss[2]}..{ss[-1]}, log loss summed over rungs {S.RUNGS[st]} (and Poisson deviance)")
        out = {k: [] for k in variants}
        for s in ss[2:]:
            tr, te = X0[X0.season < s], X0[X0.season == s]
            for name, extra in variants.items():
                Xtr = np.column_stack([S.X_of(tr, base_st)] + [tr[c].values for c in extra])
                Xte = np.column_stack([S.X_of(te, base_st)] + [te[c].values for c in extra])
                b = S.glm_poisson(Xtr, tr[st].values, tr.off.values)
                mu_tr = np.exp(Xtr @ b + tr.off.values) * (tr["min"].values / tr.mproj.values.clip(1))
                bins = pd.qcut(mu_tr, 20, labels=False, duplicates="drop")
                bv = pd.DataFrame({"m": mu_tr, "v": (tr[st].values - mu_tr) ** 2, "b": bins}).groupby("b").mean()
                pw, la = np.polyfit(np.log(bv.m.clip(0.02)), np.log(bv.v.clip(0.02)), 1)
                mu = np.exp(Xte @ b + te.off.values)
                L = S.ladder(mu, te.mproj.values, SD, float(np.exp(la)), float(pw), S.RUNGS[st])
                y = te[st].values
                lls = [S.ll(L[:, j], (y >= k).astype(float)) for j, k in enumerate(S.RUNGS[st])]
                dev = 2 * np.mean(np.where(y > 0, y * np.log(np.clip(y, 1e-9, None) / mu), 0) - (y - mu))
                out[name].append((s, len(te), np.mean(lls), dev, b[-len(extra):] if extra else []))
        for name, rows in out.items():
            n = sum(r[1] for r in rows); m = sum(r[1] * r[2] for r in rows) / n; dv = sum(r[1] * r[3] for r in rows) / n
            per = " ".join(f"{r[0][2:]}:{r[2]:.4f}" for r in rows)
            print(f"  {name:22s} pooled {m:.5f}  dev {dv:.4f}   {per}   b={np.round(rows[-1][4], 2).tolist()}")


if __name__ == "__main__":
    main()
