"""How much of an NBA price is the game, not the player? (research)

    python3 research/nba_gameshare.py

The same measure as research memory "player vs game share" (MLB HR 9%, NFL TD
4%, NHL goals 3%): variance of log expected-count from GAME inputs (team
implied points, the opponent's allowance of that stat, home) against PLAYER
inputs (his per-minute rate and projected minutes), on the last season's
walk-forward rows, for points, threes, rebounds and assists.
"""
import os
import numpy as np
import pandas as pd
import nba_ddtd as DD

HERE = os.path.dirname(os.path.abspath(__file__))


def main():
    D = pd.read_parquet(os.path.join(HERE, "nba_minutes.parquet"))
    D = D.sort_values(["pid", "date", "gid"]).reset_index(drop=True)
    stats = ["pts", "tpm", "reb", "ast"]
    for c in stats + ["min"]: D[c] = D[c].astype(float).fillna(0)
    D["fam"] = D.fam.fillna("?")
    D["s_min"] = D.groupby(["pid", "season"])["min"].cumsum() - D["min"]
    for st in stats: D = DD.prep(D, st)
    D["implied"] = D.total / 2 - D.spread / 2
    D["limp"] = np.log((D.implied / D.groupby("season").implied.transform("mean")).fillna(1.0).clip(0.6, 1.4))
    D["home"] = D.home.astype(float)
    D = D[D.mproj.notna() & (D.mproj > 3)].copy(); D["off"] = np.log(D.mproj.clip(1))
    last = D.season.max(); tr, te = D[D.season < last], D[D.season == last]
    within = {}
    print(f"{'stat':5s} {'player SD':>10s} {'game SD':>8s} {'game share':>11s}   game terms (per-SD multipliers: implied, opp allowance, home)")
    for st in stats:
        f = lambda X: [np.log(X[f"rate_{st}"].clip(1e-3)), X.limp, np.log(X[f"opp_{st}"].fillna(1).clip(0.7, 1.3)), X.home]
        b = DD.glm_poisson(np.column_stack([np.ones(len(tr))] + f(tr)), tr[st].values, tr.off.values)
        c = f(te)
        player = b[1] * c[0] + te.off.values; game = b[2] * c[1] + b[3] * c[2] + b[4] * c[3]
        vp, vg = player.var(), game.var()
        # within one player's season: how much his price moves night to night from his minutes vs the game
        key = te.pid.astype(str) + te.season
        wp = (player - pd.Series(player, index=te.index).groupby(key).transform("mean")).var()
        wg = (game - pd.Series(game, index=te.index).groupby(key).transform("mean")).var()
        within[st] = (np.sqrt(wp), np.sqrt(wg), 100 * wg / (wp + wg))
        mult = [np.exp(b[i] * c[i - 1].std()) for i in (2, 3, 4)]
        print(f"{st:5s} {np.sqrt(vp):10.3f} {np.sqrt(vg):8.3f} {100 * vg / (vp + vg):10.1f}%   " + "  ".join(f"x{m:.3f}" for m in mult))
    print("\nwithin one player's season (night to night: his minutes vs the game):")
    for st, (a, g, sh) in within.items(): print(f"  {st:5s} minutes SD {a:.3f}  game SD {g:.3f}  game share {sh:.1f}%")


if __name__ == "__main__":
    main()
