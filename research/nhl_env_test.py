"""Does the GAME matter more than the goals model lets it? (research, 2026-09-27)

Ron: "is hockey more environmental?" The shipped goals model's game inputs
(opp GA, team GF, home) carry ~3% of the price spread. Two game effects it has
never seen:
  1. power-play chances — does the opponent take penalties? (its SH time per
     game, to date; opp PK% was tested and is a null, but that is conversion,
     not volume). Also the interaction: it should matter for PP players only.
  2. the other net — a backup starting against him (share of his team's starts
     to date < 40%), and back-to-backs.
    python3 research/nhl_env_test.py
"""
import numpy as np, pandas as pd
import nhl_goals as NG

D = NG.D.copy()
G = pd.read_parquet("nhl_saves.parquet")

# team PP / SH time per game ~ the most any of its skaters played in that state
tg = D.groupby(["season", "date", "team"]).agg(pp=("pptoi", "max"), sh=("shtoi", "max")).reset_index().sort_values("date")
def prior(col, k=10):
    """Season-to-date mean before this game, shrunk toward the league (k games)."""
    g = tg.groupby(["season", "team"])[col]
    s, n = g.cumsum() - tg[col], g.cumcount()
    lg = tg.groupby("season")[col].transform("mean")
    return (s + k * lg) / (n + k)
tg["pp_prior"], tg["sh_prior"] = prior("pp"), prior("sh")
D = D.merge(tg[["season", "date", "team", "pp_prior"]].rename(columns={"pp_prior": "team_pp_prior"}), on=["season", "date", "team"], how="left")
D = D.merge(tg[["season", "date", "team", "sh_prior"]].rename(columns={"team": "opp", "sh_prior": "opp_sh_prior"}), on=["season", "date", "opp"], how="left")
D["log_opp_sh"] = np.log(D.opp_sh_prior / D.opp_sh_prior.mean())
D["log_team_pp"] = np.log(D.team_pp_prior / D.team_pp_prior.mean())
# his share of his team's PP (recent) x the opponent's penalty rate
D["pp_share"] = (D.pptoi_l5 / D.team_pp_prior).clip(0, 1.2)
D["pp_x_oppsh"] = D.pp_share * D.log_opp_sh

# the other net: backup starter (share of his team's starts to date), rest
S = G[G.start == 1].sort_values("date").copy()
S["tgp"] = S.groupby(["season", "team"]).cumcount()
S["gst"] = S.groupby(["season", "team", "pid"]).cumcount()
S["share"] = np.where(S.tgp >= 5, S.gst / S.tgp.clip(lower=1), np.nan)
S["backup"] = (S.share < 0.4).astype(float)
S.loc[S.share.isna(), "backup"] = 0.0
opp_net = S[["season", "date", "team", "backup", "team_b2b"]].rename(columns={"team": "opp", "backup": "opp_backup", "team_b2b": "opp_b2b"})
opp_net = opp_net.drop_duplicates(["season", "date", "opp"])
D = D.merge(opp_net, on=["season", "date", "opp"], how="left")
own = S[["season", "date", "team", "team_b2b"]].drop_duplicates(["season", "date", "team"])
D = D.merge(own, on=["season", "date", "team"], how="left")
for c in ("opp_backup", "opp_b2b", "team_b2b"): D[c] = D[c].fillna(0).astype(float)
D = D.dropna(subset=["log_opp_sh", "log_team_pp"])
NG.D = D

print(f"{len(D):,} skater-games; opp backup {D.opp_backup.mean():.1%} of games, opp b2b {D.opp_b2b.mean():.1%}, own b2b {D.team_b2b.mean():.1%}")
print(f"opp SH min/game: 5th-95th pct {D.opp_sh_prior.quantile(.05):.0f}-{D.opp_sh_prior.quantile(.95):.0f} s")
# raw looks: goal rate by the new game states
for c in ("opp_backup", "opp_b2b", "team_b2b"):
    print(f"  goal rate {c}=1: {D[D[c]==1].scored.mean():.4f}  vs 0: {D[D[c]==0].scored.mean():.4f}")
B = NG.SHIPPED
base = NG.walk(B)
print(f"\n{'model':44s} {'logloss':>9s} {'Δ vs shipped':>13s} {'AUC':>7s}")
print(f"{'shipped':44s} {base['ll']:9.5f} {'':>13s} {base['auc']:7.4f}")
for lab, extra in [("+ opp penalties taken (SH time)", ["log_opp_sh"]),
                   ("+ own team PP drawn", ["log_team_pp"]),
                   ("+ PP share x opp penalties", ["pp_share", "pp_x_oppsh"]),
                   ("+ opp penalties + PP share x", ["log_opp_sh", "pp_share", "pp_x_oppsh"]),
                   ("+ backup in the other net", ["opp_backup"]),
                   ("+ opp back-to-back", ["opp_b2b"]),
                   ("+ own back-to-back", ["team_b2b"]),
                   ("+ all of it", ["log_opp_sh", "log_team_pp", "pp_share", "pp_x_oppsh", "opp_backup", "opp_b2b", "team_b2b"])]:
    m = NG.walk(B + extra)
    print(f"{lab:44s} {m['ll']:9.5f} {m['ll'] - base['ll']:+13.5f} {m['auc']:7.4f}")
# coefficients (full fit) as multipliers per unit / per SD
feats = B + ["log_opp_sh", "log_team_pp", "pp_share", "pp_x_oppsh", "opp_backup", "opp_b2b", "team_b2b"]
_, b, ref = NG.fit_mu(D, D.head(5), feats)
names = ["intercept"] + feats + ["is_D"]
print("\nfull-fit multipliers on goals (per SD; binaries per SD of a 0/1):")
for n, v in zip(names, b):
    if n in feats[len(B):]: print(f"  {n:14s} x{np.exp(v):.3f} per SD (SD {ref[n][1]:.3f})")
