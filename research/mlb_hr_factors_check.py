"""Follow-ups to mlb_hr_factors.py: the combined model (v2), Bueno's screen and
streaks priced against it, then everything against Kalshi's pre-game prices.

    python3 research/mlb_hr_factors_check.py          # v2 ladder, screen, streaks
    python3 research/mlb_hr_factors_check.py kalshi   # beyond the market (needs mlb_hr_kalshi.py's cache)
"""
import json, os, sys
import numpy as np
import pandas as pd

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
MODE = sys.argv[1] if len(sys.argv) > 1 else "v2"
sys.argv = sys.argv[:1]
import mlb_hr_factors as F
from mlb_hr_kalshi import norm


def v2():
    df = F.frame().reset_index(drop=True).dropna(subset=["bat_rate", "bat_brl", "bat_bls", "sp_bpf", "park"]).reset_index(drop=True)
    p0, ix = F.walk(df); y = df.y.to_numpy()[ix]
    print(f"v1 overall: said {p0.mean():.4f} hit {y.mean():.4f}")
    def auc(y, p):
        o = np.argsort(p); r = np.empty(len(p)); r[o] = np.arange(1, len(p) + 1); n1 = y.sum(); n0 = len(y) - n1
        return (r[y == 1].sum() - n1 * (n1 + 1) / 2) / (n1 * n0)
    sets = {
      "v1": (),
      "+ conditions (temp, wind out, day)": ("temp_x", "wind_out", "day"),
      "+ conditions + starter velo": ("temp_x", "wind_out", "day", "velo_td"),
      "+ ... + pulled air balls": ("temp_x", "wind_out", "day", "velo_td", "pull_air_rate"),
      "+ ... + pitching vuln level": ("temp_x", "wind_out", "day", "velo_td", "pull_air_rate", "vuln_level"),
      "+ ... + days since HR": ("temp_x", "wind_out", "day", "velo_td", "pull_air_rate", "vuln_level", "days_since_hr"),
      "+ ... + HR last 15": ("temp_x", "wind_out", "day", "velo_td", "pull_air_rate", "vuln_level", "days_since_hr", "hr_l15"),
      "+ ... + platoon (bplat)": ("temp_x", "wind_out", "day", "velo_td", "pull_air_rate", "vuln_level", "days_since_hr", "hr_l15", "bplat_ship"),
    }
    l0 = F.ll(y, p0); res = {}
    for name, ex in sets.items():
        p, _ = F.walk(df, extra=ex) if ex else (p0, ix)
        l = F.ll(y, p); d = l - l0; t = d.mean() / (d.std(ddof=1) / np.sqrt(len(d))) if ex else 0
        k = np.argsort(-p)[: len(p) // 20]
        res[name] = p
        print(f"{name:42s} logloss {l.mean():.5f} ({100*(l.mean()-l0.mean())/l0.mean():+.3f}%, t {t:+.1f})  AUC {auc(y,p):.4f}  top5% said {100*p[k].mean():.1f} hit {100*y[k].mean():.1f}")
    p2 = res["+ ... + days since HR"]
    w, se = F.fit(np.column_stack([F.R.design(df, F.R.V1)] + [F.col(df, f) for f in sets["+ ... + days since HR"]]), df.y.to_numpy())
    print("full-sample coefs:", {f: (round(b, 3), round(b / s, 1)) for f, b, s in zip(sets["+ ... + days since HR"], w[-7:], se[-7:])})
    t = df.iloc[ix].assign(p0=p0, p2=p2)
    for c in ("bplat_ship", "vuln_ship", "recent_ship"): t[c + "_pct"] = t.groupby("date")[c].rank(pct=True)
    green = (t.bplat_ship_pct >= 0.6) & (t.vuln_ship_pct >= 0.6) & (t.recent_ship_pct >= 0.6)
    for lab, m in (("all", green), ("longshots (v1<10%)", green & (t.p0 < 0.10)), ("NOT green, longshots", ~green & (t.p0 < 0.10))):
        g = t[m]
        for pc in ("p0", "p2"):
            se = np.sqrt((g[pc] * (1 - g[pc])).sum()) / len(g)
            print(f"  Bueno {lab:22s} vs {pc}: n {len(g):6,} said {100*g[pc].mean():.2f} hit {100*g.y.mean():.2f}  gap {100*(g.y.mean()-g[pc].mean()):+.2f}pp z {(g.y.mean()-g[pc].mean())/se:+.1f}")
    # each green piece alone among longshots, vs v2
    for c in ("bplat_ship", "vuln_ship", "recent_ship"):
        g = t[(t[c + "_pct"] >= 0.6) & (t.p0 < 0.10)]; se = np.sqrt((g.p2 * (1 - g.p2)).sum()) / len(g)
        print(f"  longshots with green {c:12s}: n {len(g):6,} v2 said {100*g.p2.mean():.2f} hit {100*g.y.mean():.2f} z {(g.y.mean()-g.p2.mean())/se:+.1f}")
    # streaks: homered in previous game? (hot hand) vs v2
    t["hr_prev"] = t.hr_l7 > 0
    for lab, m in (("homered in last 7 games", t.hr_l7 >= 1), ("2+ in last 7", t.hr_l7 >= 2), ("3+ in last 15", t.hr_l15 >= 3), ("cooling", t.cooling == 1), ("no HR in 30+ days", t.days_since_hr >= 30)):
        g = t[m]; se = np.sqrt((g.p2 * (1 - g.p2)).sum()) / len(g)
        print(f"  streak {lab:26s}: n {len(g):6,} v1 said {100*g.p0.mean():.2f} v2 said {100*g.p2.mean():.2f} hit {100*g.y.mean():.2f}  vs v2 z {(g.y.mean()-g.p2.mean())/se:+.1f}")



def kalshi():
    df = F.frame().reset_index(drop=True).dropna(subset=["bat_rate", "bat_brl", "bat_bls", "sp_bpf", "park"]).reset_index(drop=True)
    V2 = ("temp_x", "wind_out", "day", "velo_td", "pull_air_rate", "vuln_level", "days_since_hr")
    p0, ix = F.walk(df); p2, _ = F.walk(df, extra=V2)
    t = df.iloc[ix].assign(p0=p0, p2=p2).copy()
    P = json.load(open(os.path.join(HERE, '.cache/kalshi_hr/prices.json'))); I = json.load(open(os.path.join(HERE, '.cache/kalshi_hr/index.json')))
    k = pd.DataFrame([{**i, **P[i["ticker"]]} for i in I if (P.get(i["ticker"]) or {}).get("ask") is not None])
    k["mid"] = (k.ask + k.bid.fillna(k.ask)) / 2
    k = k[(k.mid > 0.005) & (k.mid < 0.8)]
    t["key"] = t.name.map(norm)
    m = t.merge(k[["date", "key", "mid", "ask"]], on=["date", "key"], how="inner").drop_duplicates(["date", "key"])
    y = m.y.to_numpy()
    lg = lambda p: np.log(np.clip(p, 1e-4, 1 - 1e-4) / (1 - np.clip(p, 1e-4, 1 - 1e-4)))
    def auc(y, p):
        o = np.argsort(p); r = np.empty(len(p)); r[o] = np.arange(1, len(p) + 1); n1 = y.sum(); n0 = len(y) - n1
        return (r[y == 1].sum() - n1 * (n1 + 1) / 2) / (n1 * n0)
    print(f"matched {len(m):,} starter-games with a Kalshi pre-game price ({m.date.min()}..{m.date.max()}), {int(y.sum())} homers")
    for nm, p in (("Kalshi mid", m.mid), ("v1", m.p0), ("v2", m.p2)):
        print(f"  {nm:10s} AUC {auc(y, p.to_numpy()):.4f}  logloss {F.ll(y, p.to_numpy()).mean():.5f}  mean {p.mean():.4f} (hit {y.mean():.4f})")
    # does anything predict the homer beyond Kalshi's price?  y ~ logit(mid) + x
    X0 = np.column_stack([np.ones(len(m)), lg(m.mid.to_numpy())])
    def beyond(x, lab):
        w, se = F.fit(np.column_stack([X0, x]), y)
        print(f"  beyond Kalshi: {lab:28s} coef {w[-1]:+.3f}  z {w[-1]/se[-1]:+5.1f}")
    beyond(lg(m.p0.to_numpy()), "logit(v1)")
    beyond(lg(m.p2.to_numpy()), "logit(v2)")
    for f in ("bplat_ship", "vuln_ship", "vuln_level", "svuln_ship", "recent_ship", "stuff_velo", "pull_air_rate", "temp_x", "wind_out", "wind_pull", "day", "days_since_hr", "hr_l15", "blast_surplus", "mf_ship"):
        beyond(F.col(m, f), f)
    # Bueno's screen vs Kalshi: green longshots, bought at the ask
    for c in ("bplat_ship", "vuln_ship", "recent_ship"): m[c + "_pct"] = m.groupby("date")[c].rank(pct=True)
    green = (m.bplat_ship_pct >= 0.6) & (m.vuln_ship_pct >= 0.6) & (m.recent_ship_pct >= 0.6)
    for lab, s in (("green, all", green), ("green longshots (mid<10%)", green & (m.mid < 0.10)), ("not green longshots", ~green & (m.mid < 0.10)),
                   ("green + our fair beats the ask (v1)", green & (m.p0 > m.ask)), ("green + v2 fair beats the ask", green & (m.p2 > m.ask))):
        g = m[s]
        if not len(g): continue
        roi = (g.y / g.ask).mean() - 1
        se = np.sqrt((g.y / g.ask).var(ddof=1) / len(g))
        print(f"  {lab:38s} n {len(g):5,}  ask {100*g.ask.mean():.1f}c  mid {100*g.mid.mean():.1f}  hit {100*g.y.mean():.1f}%  ROI at ask {100*roi:+.1f}% ± {100*se:.1f}")
    g = m; roi = (g.y / g.ask).mean() - 1; se = np.sqrt((g.y / g.ask).var(ddof=1) / len(g))
    print(f"  every bat at the ask                    n {len(g):5,}  ROI {100*roi:+.1f}% ± {100*se:.1f}")
    d = (m[green].y / m[green].ask).mean() - (m[~green].y / m[~green].ask).mean()
    sd = np.sqrt((m[green].y / m[green].ask).var(ddof=1) / green.sum() + (m[~green].y / m[~green].ask).var(ddof=1) / (~green).sum())
    print(f"  green minus not-green ROI: {100*d:+.1f} pts, z {d/sd:+.1f}")



if __name__ == "__main__":
    kalshi() if MODE == "kalshi" else v2()
