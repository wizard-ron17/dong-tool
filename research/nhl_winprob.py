"""In-game win probability for the /nhl schedule's game flow chart.

No free NHL win-probability feed exists (nflverse's is what draws /nfl's chart),
so this is ours, and it has to earn its place on held-out games:

  pregame   the closing moneyline and total, de-vigged, give each team a
            scoring rate (research/nhl_odds.py: lam_home, lam_away per 60)
  in-game   the rest of regulation is two Poissons at those rates, scaled to
            the time left; a lead survives or it doesn't; a tie goes to
            overtime, which the home side wins at p_ot
  late      the last few minutes are not ordinary hockey — the trailing side
            pulls its goalie. Goals by the leader and by the trailer in that
            window are measured from the data and priced as their own segment.

Graded on every game with a closing line (2022-23 on) at fixed checkpoints —
puck drop, each intermission, 50:00, 55:00, 57:00, 59:00 — by Brier score and
calibration, against the same model without the late-game segment.

SHIPPED: v1 (this model). Held-out 2025-26: Brier 0.1409, ECE 2.06pp; the
late segment helps only inside the last five minutes, where it belongs.
v2 below (score effects all game, backward induction) was tested and REJECTED:
it narrows the comeback gap at the bottom (2.6% priced, 3.7% won vs v1's 2.8%
/ 4.6%) but loses overall — Brier 0.1413, ECE 2.44pp.

    python3 research/nhl_winprob.py      # v1: prints; writes nhl_winprob_model.json
    python3 research/nhl_winprob.py --v2 # the rejected v2 comparison (5 min; doesn't write)
"""
import glob, json, os, sys
import numpy as np
import pandas as pd
from scipy.stats import poisson

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from nhl_odds import load as load_odds
CACHE = os.environ.get("NHL_CACHE") or "/tmp/nhl-cache"
REG = 3600
CHECK = [0, 1200, 2400, 3000, 3300, 3420, 3540]
K = 12


def games():
    odds = {(r.date, r.home, r.away): (r.imp_home, r.imp_away) for r in load_odds().itertuples()}
    out = []
    for f in glob.glob(os.path.join(CACHE, "20*", "*", "goals.json")):
        season = int(f.split(os.sep)[-3]); d = f.split(os.sep)[-2]
        for g in json.load(open(f)):
            lam = odds.get((d, g["home"], g["away"]))
            if not lam or g.get("hs") is None: continue
            ev = []
            for x in g["goals"]:
                if x.get("ptype") != "REG" or not x.get("t"): continue
                m, s = x["t"].split(":")
                ev.append(((x["per"] - 1) * 1200 + int(m) * 60 + int(s), 1 if x["team"] == g["home"] else -1, x.get("mod") == "empty-net"))
            out.append(dict(season=season, date=d, home=g["home"], away=g["away"], lh=lam[0], la=lam[1],
                            win=1.0 if g["hs"] > g["as"] else 0.0, ev=sorted(ev),
                            ot=any(x.get("ptype") in ("OT", "SO") for x in g["goals"]) or g["hs"] == g["as"]))
    return pd.DataFrame(out)


def pmf(l):
    return poisson.pmf(np.arange(K), max(l, 1e-9))


def wp(lh, la, t, lead, P):
    """P(home wins) with `lead` (home minus away) at t seconds of regulation."""
    p_ot = P["ot_shrink"] * 0.5 + (1 - P["ot_shrink"]) * lh / (lh + la)
    late = P["late"]
    t_late = REG - late if late else REG
    def settle(diff_dist):             # diff offset -> prob, at end of regulation
        return sum(p * (1.0 if d > 0 else p_ot if d == 0 else 0.0) for d, p in diff_dist.items())
    # normal hockey until the late window
    dist = {lead: 1.0}
    if t < t_late:
        f = (t_late - t) / 3600
        ph, pa = pmf(lh * f), pmf(la * f)
        nd = {}
        for d0, p0 in dist.items():
            for i in range(K):
                for j in range(K):
                    nd[d0 + i - j] = nd.get(d0 + i - j, 0) + p0 * ph[i] * pa[j]
        dist = nd
    if not late:
        return settle(dist)
    # the late window: when a side trails by 1-2 its rates change (goalie pulled)
    f = (REG - max(t, t_late)) / 3600
    nd = {}
    for d0, p0 in dist.items():
        if 1 <= abs(d0) <= 2:
            lead_l = lh if d0 > 0 else la; trail_l = la if d0 > 0 else lh
            pl, pt = pmf(lead_l * P["m_lead"] * f), pmf(trail_l * P["m_trail"] * f)
            for i in range(K):
                for j in range(K):
                    dd = d0 + (i - j if d0 > 0 else j - i)
                    nd[dd] = nd.get(dd, 0) + p0 * pl[i] * pt[j]
        else:
            ph, pa = pmf(lh * f), pmf(la * f)
            for i in range(K):
                for j in range(K):
                    nd[d0 + i - j] = nd.get(d0 + i - j, 0) + p0 * ph[i] * pa[j]
    return settle(nd)


def late_rates(G, late):
    """Goals per 60 by the leader and the trailer in the last `late` seconds with a 1-2 goal lead, vs their pregame rates."""
    gl = gt = el = et = 0.0
    for r in G.itertuples():
        lead = 0; t_prev = 0
        evs = r.ev
        # walk the window, tracking exposure by state
        state_t = REG - late
        lead_at = sum(s for t, s, _ in evs if t < state_t)
        t0 = state_t
        cur = lead_at
        for t, s, _ in [e for e in evs if e[0] >= state_t] + [(REG, 0, False)]:
            dur = (t - t0) / 3600
            if 1 <= abs(cur) <= 2:
                ll, lt = (r.lh, r.la) if cur > 0 else (r.la, r.lh)
                el += ll * dur; et += lt * dur
                if s != 0:
                    if (s > 0) == (cur > 0): gl += 1
                    else: gt += 1
            cur += s; t0 = t
    return gl / el, gt / et


def evaluate(G, P):
    rows = []
    for r in G.itertuples():
        for t in CHECK:
            lead = sum(s for tt, s, _ in r.ev if tt < t)
            rows.append((t, wp(r.lh, r.la, t, lead, P), r.win))
    E = pd.DataFrame(rows, columns=["t", "p", "y"])
    E["brier"] = (E.p - E.y) ** 2
    E["ll"] = -(E.y * np.log(E.p.clip(1e-4, 1 - 1e-4)) + (1 - E.y) * np.log((1 - E.p).clip(1e-4, 1 - 1e-4)))
    return E


def ece(E):
    E = E.assign(b=pd.cut(E.p, np.linspace(0, 1, 11), include_lowest=True))
    g = E.groupby("b", observed=True).agg(p=("p", "mean"), y=("y", "mean"), n=("p", "size"))
    return float((abs(g.p - g.y) * g.n).sum() / g.n.sum()), g


if __name__ == "__main__" and "--v2" not in sys.argv:
    G = games()
    print(f"{len(G):,} games with a closing line and goal times\n")
    fit, chk = G[G.season < 20252026], G[G.season == 20252026]
    base = {"ot_shrink": 0.5, "late": 0, "m_lead": 1, "m_trail": 1}
    for late in (120, 180, 240):
        ml, mt = late_rates(fit, late)
        print(f"  last {late}s with a 1-2 goal lead: leader scores at {ml:.2f}x his rate, trailer at {mt:.2f}x")
    ml, mt = late_rates(fit, 180)
    P = {"ot_shrink": 0.5, "late": 180, "m_lead": round(ml, 3), "m_trail": round(mt, 3)}
    # the OT split: how often the home side wins games that reach overtime, vs its lam share
    ot = fit[fit.ot]
    share = (ot.lh / (ot.lh + ot.la)).mean()
    print(f"\n  overtime: home wins {ot.win.mean():.3f} of {len(ot)} OT/SO games; mean scoring share {share:.3f}")
    print("\nheld-out 2025-26, by checkpoint (Brier; lower is better)")
    Eb, Ep = evaluate(chk, base), evaluate(chk, P)
    for t in CHECK:
        a, b = Eb[Eb.t == t], Ep[Ep.t == t]
        print(f"  {t // 60:>2}:{t % 60:02d}  plain {a.brier.mean():.4f}   + late segment {b.brier.mean():.4f}   (n {len(b)})")
    for lab, E in (("plain", Eb), ("with late segment", Ep)):
        e, g = ece(E)
        print(f"\n{lab}: Brier {E.brier.mean():.4f}, log loss {E.ll.mean():.4f}, ECE {e * 100:.2f}pp")
    e, g = ece(Ep); print(g.to_string(float_format=lambda x: f"{x:.3f}"))
    late_only = Ep[Ep.t >= 3300]; e2, g2 = ece(late_only)
    print(f"\nlast 5 minutes only: ECE {e2 * 100:.2f}pp\n" + g2.to_string(float_format=lambda x: f"{x:.3f}"))
    ml, mt = late_rates(G, 180)
    json.dump({"note": "In-game win probability (research/nhl_winprob.py): Poisson on the closing-line scoring rates for the time left; "
                       "a 1-2 goal lead in the last late seconds prices the leader and trailer at their own measured rates; ties go to OT.",
               "late": 180, "m_lead": round(ml, 3), "m_trail": round(mt, 3), "ot_shrink": 0.5},
              open(os.path.join(HERE, "nhl_winprob_model.json"), "w"), indent=1)


# ── v2: score effects all game, by backward induction ──────────────────────
# The first model under-called comebacks (a side it gave <10% came back 4.7%
# of the time, priced at 2.7%): trailing teams push all game, not just when the
# goalie comes out. v2 measures each side's scoring rate by lead size (1, 2,
# 3+) and phase (before / inside the last three minutes), and steps the game
# in 10-second slices from the horn backwards, so every (time, lead) state has
# its own number — one table per game, which is what the page draws from.
STEP, LATE, DMAX = 10, 180, 9


def state_rates(G):
    """Scoring-rate multipliers vs the pregame rate, by (phase, lead bucket), for the leader and the trailer; and for a tie."""
    goals, expo = {}, {}
    def add(key, n, e):
        goals[key] = goals.get(key, 0) + n; expo[key] = expo.get(key, 0) + e
    for r in G.itertuples():
        cur, t0 = 0, 0
        for t, s, _ in list(r.ev) + [(REG, 0, False)]:
            # split the interval at the late boundary so each piece has one phase
            for a, b in ((t0, min(t, REG - LATE)), (max(t0, REG - LATE), t)):
                if b <= a: continue
                ph = "late" if a >= REG - LATE else "norm"; dur = (b - a) / 3600
                if cur == 0:
                    add((ph, 0, "h"), 0, r.lh * dur); add((ph, 0, "a"), 0, r.la * dur)
                else:
                    bk = min(abs(cur), 3); ll, lt = (r.lh, r.la) if cur > 0 else (r.la, r.lh)
                    add((ph, bk, "lead"), 0, ll * dur); add((ph, bk, "trail"), 0, lt * dur)
            if s:
                ph = "late" if t >= REG - LATE else "norm"
                if cur == 0: add((ph, 0, "h" if s > 0 else "a"), 1, 0)
                else: add((ph, min(abs(cur), 3), "lead" if (s > 0) == (cur > 0) else "trail"), 1, 0)
            cur += s; t0 = t
    return {f"{k[0]}|{k[1]}|{k[2]}": round(goals[k] / expo[k], 3) for k in goals if expo.get(k)}


def table(lh, la, M, p_ot):
    """V[i][d + DMAX] = P(home wins) with home lead d at t = i * STEP."""
    n = REG // STEP
    V = np.zeros((n + 1, 2 * DMAX + 1))
    d = np.arange(-DMAX, DMAX + 1)
    V[n] = np.where(d > 0, 1.0, np.where(d == 0, p_ot, 0.0))
    ks = np.arange(3)
    for i in range(n - 1, -1, -1):
        ph = "late" if i * STEP >= REG - LATE else "norm"
        for j, dd in enumerate(d):
            if dd == 0: rh, ra = lh * M.get(f"{ph}|0|h", 1), la * M.get(f"{ph}|0|a", 1)
            else:
                bk = min(abs(dd), 3); ml, mt = M.get(f"{ph}|{bk}|lead", 1), M.get(f"{ph}|{bk}|trail", 1)
                rh, ra = (lh * ml, la * mt) if dd > 0 else (lh * mt, la * ml)
            ph_ = poisson.pmf(ks, rh * STEP / 3600); pa_ = poisson.pmf(ks, ra * STEP / 3600)
            v = 0.0
            for a in ks:
                for b in ks:
                    v += ph_[a] * pa_[b] * V[i + 1][min(max(dd + a - b, -DMAX), DMAX) + DMAX]
            V[i][j] = v
    return V


def evaluate2(G, M, p_ot_bonus):
    rows = []
    for r in G.itertuples():
        p_ot = min(0.95, r.lh / (r.lh + r.la) + p_ot_bonus)
        V = table(r.lh, r.la, M, p_ot)
        for t in CHECK:
            lead = sum(s for tt, s, _ in r.ev if tt < t)
            rows.append((t, V[t // STEP][min(max(lead, -DMAX), DMAX) + DMAX], r.win))
    E = pd.DataFrame(rows, columns=["t", "p", "y"])
    E["brier"] = (E.p - E.y) ** 2
    E["ll"] = -(E.y * np.log(E.p.clip(1e-4, 1 - 1e-4)) + (1 - E.y) * np.log((1 - E.p).clip(1e-4, 1 - 1e-4)))
    return E


def main2():
    G = games()
    fit, chk = G[G.season < 20252026], G[G.season == 20252026]
    M = state_rates(fit)
    print("state multipliers (fit):", json.dumps(M))
    ot = fit[fit.ot]
    bonus = float(ot.win.mean() - (ot.lh / (ot.lh + ot.la)).mean())
    print(f"overtime home bonus over scoring share: {bonus:+.3f}")
    base = {"ot_shrink": 0.5, "late": 180, **dict(zip(("m_lead", "m_trail"), late_rates(fit, 180)))}
    E1, E2 = evaluate(chk, base), evaluate2(chk, M, bonus)
    print("\nheld-out 2025-26 (Brier)")
    for t in CHECK:
        print(f"  {t // 60:>2}:{t % 60:02d}  v1 {E1[E1.t == t].brier.mean():.4f}   v2 {E2[E2.t == t].brier.mean():.4f}")
    for lab, E in (("v1", E1), ("v2", E2)):
        e, g = ece(E)
        print(f"\n{lab}: Brier {E.brier.mean():.4f}, log loss {E.ll.mean():.4f}, ECE {e * 100:.2f}pp")
        print(g.to_string(float_format=lambda x: f"{x:.3f}"))
    return  # rejected — see the module docstring; kept for the record
    json.dump({"note": "In-game win probability v2 (research/nhl_winprob.py): closing-line scoring rates scaled by measured "
                       "score-state multipliers (leader/trailer by lead 1/2/3+, before and inside the last 3 minutes), stepped "
                       "backwards in 10 s slices; ties go to OT at the home scoring share plus a measured home bonus. Pooled 2022-26.",
               "step": STEP, "late": LATE, "dmax": DMAX, "mult": Mall, "ot_bonus": round(bonus_all, 3)},
              open(os.path.join(HERE, "nhl_winprob_model.json"), "w"), indent=1)


if __name__ == "__main__" and "--v2" in sys.argv:
    main2()
