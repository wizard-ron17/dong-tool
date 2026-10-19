// Ron's Goal Tool — shots and shots on target: the price, from the same
// history and features as goals (scripts/soccer-goals.js goalFeatures and
// teamFeatures). Fitted in research/soccer_shots.py, read from
// soccer/shots-model.json; nothing here fits. research/soccer_shots_parity.mjs
// checks this file against the research on every row.
//
// A shot count is a mixture over his role: P(start), P(on off the bench), or
// he doesn't play (0). Given the role, a negative binomial on the minutes that
// role gets him, his shooting per 90 (shrunk to his position's), the
// opponent's shots allowed and home, its dispersion growing with the mean.
// Once lineups post, the role is known: XI starts, a named sub comes on at the
// league's rate for named subs (about 56%), anyone else is out.

const sig = (c, X) => 1 / (1 + Math.exp(-(c[0] + X.reduce((a, x, i) => a + c[i + 1] * x, 0))));

/**
 * P(start), P(comes on) before the lineups (research/soccer_role.py): his chance of
 * playing at all from the first two, then, given he plays, whether he starts from the
 * split model (his starts per appearance and his last game's minutes on top).
 */
export function roleProbs(f, R) {
  const lm = Math.log(Math.max(f.min5, 1) / 90), q = Math.log((f.sh + 3) / (f.min / 90 + 3));
  const b = [f.st5 / 5, f.lastSt, f.subs5 / 5, lm, f.st10 / 10, q];
  const X = [...b, b[0] * b[4], b[0] * b[5], b[4] * b[5]];
  const ps = sig(R.start, X), pb = (1 - ps) * sig(R.sub, X);
  if (!R.split) return { ps, pb };
  const split = sig(R.split, [...X, f.st10 / Math.max(Math.min(f.apps, 10), 1), f.lastMin / 90]), play = ps + pb;
  return { ps: play * split, pb: play * (1 - split) };
}

/** The mean count for one role (started 1/0). */
function muRole(f, tf, ctx, M, kind, started, meta) {
  const pr = M.priors[f.pos] || M.priors.MID, K = M.shrink, n90 = f.min / 90;
  const sh90 = (f.sh + K * pr.sh90) / (n90 + K), sot90 = (f.sot + K * pr.sot90) / (n90 + K);
  const em = started ? (f.stMin ?? meta.stMin) : (f.subMin ?? meta.subMin);
  const lrm = Math.log(Math.max(em, 1) / 90), lsh = Math.log(sh90);
  const lsot = Math.log(sot90);
  const x = { lrm, lrm2: lrm * lrm, lsh, lsh2: lsh * lsh, lsot, lsot2: lsot * lsot, lsh_st: lsh * started,
    losha: Math.log(tf.osha / M.league.tsh), home: ctx.home ? 1 : 0, st: started };
  let z = M.coef.b0; for (const [k, b] of Object.entries(M.coef)) if (k !== 'b0') z += b * x[k];
  return { mu: Math.exp(z), sh90, sot90, em };
}

/** P(X = 0..K) for a negative binomial with mean mu and dispersion a. */
function nbPmf(mu, a, K) {
  const r = 1 / a, out = [(r / (r + mu)) ** r];
  for (let x = 1; x <= K; x++) out.push(out[x - 1] * (x - 1 + r) / x * (mu / (r + mu)));
  return out;
}

/**
 * One player's shots (kind 'sh') or on target ('sot'): { mu, p: { line: P(over) }, ps, pb, muStart, muSub, ... }.
 * xi: null before the lineups, else 'XI' / 'bench'.
 */
export function shotLadder(f, tf, ctx, MM, kind, xi = null) {
  const M = MM[kind], meta = MM.meta, K = 10;
  const { ps, pb } = xi == null ? roleProbs(f, M.role) : { ps: xi === 'XI' ? 1 : 0, pb: xi === 'bench' ? M.role.benchOn : 0 };
  const S = muRole(f, tf, ctx, M, kind, 1, meta), B = muRole(f, tf, ctx, M, kind, 0, meta);
  const disp = (mu, role) => Math.exp(M.disp[role][0] + M.disp[role][1] * Math.log(mu));
  const a = nbPmf(S.mu, disp(S.mu, 'start'), K), b = nbPmf(B.mu, disp(B.mu, 'sub'), K);
  const P = a.map((v, i) => ps * v + pb * b[i]); P[0] += 1 - ps - pb;
  const p = {};
  for (const L of M.lines) p[L] = 1 - P.slice(0, Math.floor(L) + 1).reduce((x, y) => x + y, 0);
  return { mu: ps * S.mu + pb * B.mu, p, pmf: P, ps, pb, muStart: S.mu, muSub: B.mu, sh90: S.sh90, sot90: S.sot90, stMin: S.em, subMin: B.em };
}
