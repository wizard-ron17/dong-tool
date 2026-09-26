"""ROI backtests for the MLB HR boards against real Kalshi prices (research).

    python3 research/mlb_hr_roi.py boards     # Chalk + Value as posted
    python3 research/mlb_hr_roi.py model      # the v1 odds, walk-forward Aug-Sep

Each bet buys 1+ HR YES at Kalshi's last hourly ask before first pitch
(mlb_hr_kalshi.py), plus Kalshi's taker fee 0.07·p·(1-p). ROI = (payout - cost)
/ cost at a flat one contract per bet; the ± is a 95% interval from the
per-bet spread, because HR props at +400..+1000 swing hard on luck.
"""
import json, os, sys
import numpy as np
import mlb_hr_kalshi as K

FEE = lambda a: 0.07 * a * (1 - a)


def roi(rows):
    """rows: [(ask, hit)] -> (n, hits, cost, roi, ci)"""
    if not rows:
        return 0, 0, 0, None, None
    a = np.array([r[0] for r in rows]); y = np.array([1.0 if r[1] else 0.0 for r in rows])
    cost = a + FEE(a); pnl = y - cost
    r = pnl.sum() / cost.sum()
    se = pnl.std(ddof=1) / cost.mean() / np.sqrt(len(pnl)) if len(pnl) > 1 else float("nan")
    return len(rows), int(y.sum()), float(cost.sum()), float(r), float(1.96 * se)


def fmt(label, res):
    n, h, c, r, ci = res
    return f"{label:34s} n {n:5d}  hit {h:4d} ({(h / n if n else 0) * 100:4.1f}%)  ROI {r * 100:+6.1f}% ± {ci * 100:4.1f}" if n else f"{label:34s} n 0"


def match(date, name, idx):
    c = idx.get((date, K.norm(name)))
    return c[0] if c else None


def boards():
    j = json.load(open("/private/tmp/claude-501/-Users-ron-Desktop-dong-tool/e2a54a5c-6543-41f4-91b3-c80704d9b22b/scratchpad/mlb-data.json"))
    idx = {}
    for m in json.load(open(K.INDEX)):
        idx.setdefault((m["date"], m["key"]), []).append(m)
    for v in idx.values():
        v.sort(key=lambda m: m["start"])
    bets = {"chalk": [], "value": []}
    miss = {"chalk": 0, "value": 0}
    for board, hist in (("chalk", j["picksHistory"]), ("value", j.get("valueHistory", []))):
        for d in hist:
            for p in d.get("picks") or d.get("value") or []:
                if p.get("hit") is None:
                    continue
                m = match(d["date"], p.get("name") or j["playerNames"].get(str(p["pid"]), ""), idx)
                if not m:
                    miss[board] += 1; continue
                bets[board].append({"t": m["ticker"], "date": d["date"], "score": p.get("score"), "hit": p["hit"], "kal": m["result"] == "yes"})
    tick = sorted({b["t"] for v in bets.values() for b in v})
    P = K.prices(tick)
    for board in ("chalk", "value"):
        rows = [(P[b["t"]]["ask"], b["hit"], b) for b in bets[board] if P.get(b["t"]) and P[b["t"]].get("ask") and 0 < P[b["t"]]["ask"] < 1]
        agree = np.mean([b["hit"] == b["kal"] for _, _, b in rows]) if rows else 0
        dates = sorted({b["date"] for _, _, b in rows})
        print(f"\n=== {board.upper()} as posted: {len(bets[board])} matched to Kalshi ({miss[board]} not listed), {len(rows)} priced, {dates[0] if dates else ''}..{dates[-1] if dates else ''}; our grade = Kalshi's settlement on {agree*100:.1f}%")
        print(fmt("all", roi([(a, h) for a, h, _ in rows])))
        print(f"  avg ask {np.mean([a for a, _, _ in rows]) * 100:.1f}¢ (+{(1 / np.mean([a for a, _, _ in rows]) - 1) * 100:.0f})")
        if board == "chalk":
            for lo, hi in ((0, 10), (10, 12), (12, 14), (14, 99)):
                print(fmt(f"  score {lo}-{hi}", roi([(a, h) for a, h, b in rows if b["score"] is not None and lo <= b["score"] < hi])))
        for mo in sorted({b["date"][:7] for _, _, b in rows}):
            print(fmt(f"  {mo}", roi([(a, h) for a, h, b in rows if b["date"][:7] == mo])))


def auc(y, p):
    y = np.asarray(y, float); p = np.asarray(p, float)
    o = np.argsort(p); r = np.empty(len(p)); r[o] = np.arange(1, len(p) + 1)
    n1 = y.sum(); n0 = len(y) - n1
    return (r[y == 1].sum() - n1 * (n1 + 1) / 2) / (n1 * n0)


def model():
    """v1 walk-forward: fit on 2026 Apr-Jul only, price Aug-Sep, bet where our
    P beats Kalshi's pre-game ask + fee. Also Kalshi's own AUC and log loss on
    the very same bats, and whether our price adds anything beyond theirs."""
    import pandas as pd
    import mlb_hr_replay as R
    df, _, _, _ = R.v1_frame()
    d = df[df.season == 2026]
    tr, te = d[d.date < "2026-08-01"], d[d.date >= "2026-08-01"].copy()
    w, _ = R.fit_logistic(R.design(tr, R.V1), tr.y.to_numpy())
    ztr, zte = R.design(tr, R.V1) @ w, R.design(te, R.V1) @ w
    a = 0.0
    for _ in range(60):
        q = 1 / (1 + np.exp(-(a + R.PLATT_B * ztr))); a += (tr.y.mean() - q.mean()) / (q * (1 - q)).mean()
    te["p"] = 1 / (1 + np.exp(-(a + R.PLATT_B * zte)))
    idx = {}
    for m in json.load(open(K.INDEX)):
        idx.setdefault((m["date"], m["key"]), []).append(m)
    te["t"] = [(idx.get((dt, K.norm(n))) or [{}])[0].get("ticker") for dt, n in zip(te.date, te.name)]
    te = te[te.t.notna()]
    P = K.prices(sorted(set(te.t)))
    te["ask"] = [(P.get(t) or {}).get("ask") for t in te.t]
    te["bid"] = [(P.get(t) or {}).get("bid") for t in te.t]
    te = te[te.ask.notna() & (te.ask > 0) & (te.ask < 1)]
    y = te.y.to_numpy(); ours = te.p.to_numpy()
    two = te[te.bid.notna() & (te.bid > 0)]
    mid = ((two.ask + two.bid) / 2).to_numpy()
    ll = lambda yy, q: -np.mean(yy * np.log(np.clip(q, 1e-6, 1)) + (1 - yy) * np.log(np.clip(1 - q, 1e-6, 1)))
    print(f"Aug-Sep starter-games with a Kalshi 1+ market and a pre-game ask: {len(te)} (two-sided {len(two)})")
    print(f"AUC   ours {auc(y, ours):.4f}   Kalshi ask {auc(y, te.ask):.4f}   Kalshi mid {auc(two.y, mid):.4f} (ours on those {auc(two.y, two.p):.4f})")
    print(f"logloss on two-sided: ours {ll(two.y.to_numpy(), two.p.to_numpy()):.5f}  Kalshi mid {ll(two.y.to_numpy(), mid):.5f}")
    print(f"level: ours {ours.mean()*100:.1f}%  Kalshi ask {te.ask.mean()*100:.1f}%  mid {mid.mean()*100:.1f}%  actual {y.mean()*100:.1f}%")
    # does our price add anything beyond Kalshi's? logit(HR) ~ logit(mid) + logit(ours)
    lg = lambda q: np.log(np.clip(q, 1e-4, 1 - 1e-4) / (1 - np.clip(q, 1e-4, 1 - 1e-4)))
    X = np.column_stack([np.ones(len(two)), lg(mid), lg(two.p.to_numpy())])
    b, se = R.fit_logistic(X, two.y.to_numpy())
    print(f"HR ~ Kalshi mid + ours:  Kalshi β {b[1]:.2f} (z {b[1]/se[1]:.1f})   ours β {b[2]:.2f} (z {b[2]/se[2]:.1f})")
    print()
    for edge in (0.0, 0.01, 0.02, 0.03, 0.05):
        sel = te[te.p - te.ask - FEE(te.ask) > edge]
        print(fmt(f"bet when ours > ask+fee+{edge*100:.0f}pp", roi(list(zip(sel.ask, sel.y > 0)))))
    for lo in (0.10, 0.20):
        sel = te[(te.p / (te.ask + FEE(te.ask)) - 1) > lo]
        print(fmt(f"bet when EV > {lo*100:.0f}%", roi(list(zip(sel.ask, sel.y > 0)))))
    te.to_parquet(os.path.join(os.path.dirname(__file__), "mlb_hr_roi_model.parquet"), index=False)


if __name__ == "__main__":
    {"boards": boards, "model": model}.get(sys.argv[1] if len(sys.argv) > 1 else "boards")()
