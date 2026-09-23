"""Can anything beat the Walks tool's projection? Ron's list, tested walk-forward.

The shipped projection is (shrunk pitcher BB% log5 the opponent's team BB%) x
(his batters faced per start). Candidates, all as-of the day before:

  workload   pitches per batter, pitches per start, outs per start, his last
             three starts' batters faced and pitches, days of rest
  hook risk  hits, earned runs and homers allowed per batter faced — "the dude
             might get pulled before he has a chance to walk"
  dominance  his strikeout rate — "he's just mowing them down"
  lineup     the walk rates of the nine batters who actually started against
             him, weighted by lineup spot, instead of the team's season rate
  platoon    share of the lineup batting from the opposite side to his hand

Each enters a Poisson GLM on walks next to log(shipped projection), refit every
month on the months before it; graded on the rungs books hang and on Over 1.5
for the board's top 8 (sorted by projection, Ron's order).

    python3 research/mlb_kbb_replay.py         # fills the v2 boxscore cache
    python3 research/mlb_walks_features.py
"""
import json, os, glob, sys, ssl, urllib.request
import numpy as np
import pandas as pd
from scipy.stats import poisson

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
CACHE = os.environ.get("MLB_CACHE", "/tmp/mlb-cache")
from nhl_sog import poisson_irls
K0, MIN_BF, MIN_TM_PA, WARMUP_PA = 120, 40, 200, 3000
BAT_K = 60            # pseudo-PA of league walk rate in a batter's own rate
SPOT_PA = [4.65, 4.55, 4.45, 4.35, 4.25, 4.15, 4.05, 3.95, 3.85]    # PA a game by lineup spot


def hands(ids):
    """batSide / pitchHand for every player, one batched lookup (cached)."""
    p = os.path.join(CACHE, "v2", "hands.json")
    have = json.load(open(p)) if os.path.exists(p) else {}
    need = [i for i in ids if i not in have]
    try:
        import certifi; ctx = ssl.create_default_context(cafile=certifi.where())
    except ImportError:
        ctx = ssl.create_default_context()
    for i in range(0, len(need), 150):
        url = "https://statsapi.mlb.com/api/v1/people?personIds=" + ",".join(need[i:i + 150])
        with urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": "dong-tool/1.0"}), timeout=60, context=ctx) as r:
            for x in json.load(r).get("people", []):
                have[str(x["id"])] = {"bat": (x.get("batSide") or {}).get("code"), "throw": (x.get("pitchHand") or {}).get("code")}
    json.dump(have, open(p, "w"))
    return have


def log5(p, t, l):
    num = p * t / l
    return num / (num + (1 - p) * (1 - t) / (1 - l))


def build():
    days = {os.path.basename(f)[:-5]: json.load(open(f)) for f in glob.glob(os.path.join(CACHE, "v2", "20*.json"))}
    ids = {s["pid"] for d in days.values() for s in d["starts"]} | {b["pid"] for d in days.values() for b in d.get("batters", [])}
    H = hands(sorted(ids))
    pit, tm, bat = {}, {}, {}
    lg = {"k": 0, "bb": 0, "pa": 0}
    rows = []
    for d in sorted(days):
        day = days[d]
        lineups = {}
        for b in day.get("batters", []):
            if b["order"] and b["order"] % 100 == 0:               # the nine who started
                lineups.setdefault((b["gpk"], b["team"]), []).append((b["order"] // 100, b["pid"]))
        if lg["pa"] >= WARMUP_PA:
            L = lg["bb"] / lg["pa"]; Lk = lg["k"] / lg["pa"]
            for s in day["starts"]:
                ps, to = pit.get(s["pid"]), tm.get(s["opp"])
                if not ps or ps["bf"] < MIN_BF or not to or to["pa"] < MIN_TM_PA: continue
                pr = (ps["bb"] + K0 * L) / (ps["bf"] + K0)
                exp = log5(pr, to["bb"] / to["pa"], L)
                pbf = ps["bf"] / ps["gs"]
                # the lineup that actually started against him, each batter's as-of walk rate
                lu = sorted(lineups.get((s["gpk"], s["opp"]), []))
                if len(lu) >= 8:
                    w = np.array([SPOT_PA[min(o, 9) - 1] for o, _ in lu])
                    r = np.array([(bat.get(pid, {}).get("bb", 0) + BAT_K * L) / (bat.get(pid, {}).get("pa", 0) + BAT_K) for _, pid in lu])
                    lu_bb = float((w * r).sum() / w.sum())
                    th = H.get(s["pid"], {}).get("throw")
                    sides = [H.get(pid, {}).get("bat") for _, pid in lu]
                    opp_hand = np.mean([1.0 if (b == "S" or (b and th and b != th)) else 0.0 for b in sides]) if th else np.nan
                else:
                    lu_bb, opp_hand = np.nan, np.nan
                last = ps["log"][-3:]
                rows.append(dict(
                    date=d, pid=s["pid"], name=s["name"], team=s["team"], opp=s["opp"], bb=s["bb"], bf_act=s["bf"],
                    proj=exp * pbf, exp=exp, pbf=pbf, lg=L, tm_bb=to["bb"] / to["pa"],
                    k_rate=(ps["k"] + 70 * Lk) / (ps["bf"] + 70),
                    pitch_bf=ps["pitches"] / max(ps["bf"], 1), pitch_gs=ps["pitches"] / ps["gs"], outs_gs=ps["outs"] / ps["gs"],
                    l3_bf=np.mean([x["bf"] for x in last]), l3_pitch=np.mean([x["pitches"] for x in last]),
                    last_pitch=last[-1]["pitches"], rest=(pd.Timestamp(d) - pd.Timestamp(last[-1]["date"])).days,
                    h_bf=(ps["h"] + 30 * 0.22) / (ps["bf"] + 30), er_bf=(ps["er"] + 30 * 0.11) / (ps["bf"] + 30),
                    hr_bf=(ps["hr"] + 60 * 0.03) / (ps["bf"] + 60),
                    lineup_bb=lu_bb, opp_hand=opp_hand, gs=ps["gs"]))
        for s in day["starts"]:
            e = pit.setdefault(s["pid"], {"k": 0, "bb": 0, "bf": 0, "gs": 0, "pitches": 0, "outs": 0, "h": 0, "er": 0, "hr": 0, "log": []})
            for k in ("k", "bb", "bf", "pitches", "outs", "h", "er", "hr"): e[k] += s.get(k, 0)
            e["gs"] += 1; e["log"].append({"date": d, "bf": s["bf"], "pitches": s.get("pitches", 0)})
        for ab, v in day["bat"].items():
            e = tm.setdefault(ab, {"k": 0, "bb": 0, "pa": 0})
            for k in ("k", "bb", "pa"): e[k] += v[k]; lg[k] += v[k]
        for b in day.get("batters", []):
            e = bat.setdefault(b["pid"], {"bb": 0, "pa": 0}); e["bb"] += b["bb"]; e["pa"] += b["pa"]
    return pd.DataFrame(rows)


def design(df, fs, ref):
    return np.column_stack([np.ones(len(df))] + [(df[f].to_numpy(float) - ref[f][0]) / ref[f][1] for f in fs])


def evaluate(D, fs, label, months):
    parts = []
    for m in months:
        tr, te = D[D.date < m + "-01"], D[D.date.str[:7] == m]
        if len(tr) < 400 or not len(te): continue
        ref = {f: (tr[f].mean(), tr[f].std() or 1.0) for f in fs}
        b = poisson_irls(design(tr, fs, ref), tr.bb.to_numpy(float))
        parts.append(te.assign(mu=np.exp(np.clip(design(te, fs, ref) @ b, -6, 3))))
    T = pd.concat(parts)
    lls = []
    for L in (0.5, 1.5, 2.5, 3.5):
        p = np.clip(poisson.sf(np.floor(L), T.mu), 1e-6, 1 - 1e-6); y = (T.bb > L).astype(float)
        lls.append(-(y * np.log(p) + (1 - y) * np.log(1 - p)).mean())
    T["rk"] = T.groupby("date").mu.rank(ascending=False, method="first")
    top = T[T.rk <= 8]; t3 = T[T.rk <= 3]
    p15 = poisson.sf(1, top.mu)
    am = lambda p: (f"{-100 * p / (1 - p):+.0f}" if p >= 0.5 else f"+{100 * (1 - p) / p:.0f}")
    print(f"  {label:44s} log loss {np.mean(lls):.5f}   top-8 o1.5 priced {am(p15.mean())} hit {am((top.bb >= 2).mean())}"
          f" ({(top.bb >= 2).mean() * 100:.1f}%)   top-3 hit {(t3.bb >= 2).mean() * 100:.1f}%")
    return np.mean(lls)


if __name__ == "__main__":
    D = build()
    D["proj_cap"] = np.minimum(D.proj, 2.4)
    for c in ("proj", "proj_cap", "pbf", "exp", "tm_bb", "lineup_bb", "k_rate", "pitch_bf", "pitch_gs", "l3_bf", "l3_pitch", "last_pitch", "h_bf", "er_bf", "hr_bf", "outs_gs"):
        D["log_" + c] = np.log(D[c].clip(lower=1e-3))
    D = D.dropna(subset=["log_lineup_bb", "opp_hand"]).copy()
    D["rest_c"] = D.rest.clip(3, 10)
    D["short_last"] = (D.last_pitch < 70).astype(float)
    D.to_parquet(os.path.join(HERE, "mlb_walks_features.parquet"))
    months = sorted(D.date.str[:7].unique())
    print(f"{len(D):,} starts with a known lineup · {D.date.min()} to {D.date.max()}\n")
    base = evaluate(D, ["log_proj"], "shipped projection (refit as one term)", months)
    evaluate(D, ["log_proj_cap"], "capped at 2.4", months)
    RUNGS = [
        ("+ his strikeout rate", ["log_proj", "log_k_rate"]),
        ("+ pitches per batter", ["log_proj", "log_pitch_bf"]),
        ("+ pitches / outs per start", ["log_proj", "log_pitch_gs", "log_outs_gs"]),
        ("+ last 3 starts: batters, pitches", ["log_proj", "log_l3_bf", "log_l3_pitch"]),
        ("+ short last start (<70 pitches), rest", ["log_proj", "short_last", "rest_c"]),
        ("+ hook risk: hits, ER, HR per batter", ["log_proj", "log_h_bf", "log_er_bf", "log_hr_bf"]),
        ("+ lineup walk rate (vs team rate)", ["log_proj", "log_lineup_bb", "log_tm_bb"]),
        ("+ platoon: opposite-hand share", ["log_proj", "opp_hand"]),
        ("split: rate x workload, own terms", ["log_exp", "log_pbf"]),
        ("split + lineup + pitches/batter + K", ["log_exp", "log_pbf", "log_lineup_bb", "log_tm_bb", "log_pitch_bf", "log_k_rate"]),
    ]
    print()
    for lab, fs in RUNGS:
        evaluate(D, fs, lab, months)
