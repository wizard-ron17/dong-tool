"""Small numpy stand-ins shared by the soccer research (no sklearn/statsmodels on this machine's Python)."""
import math
import numpy as np, pandas as pd

def poisson_glm(X, y, iters=50, w=None):
    """Unpenalised Poisson regression with a log link, by IRLS (w: optional row weights). Returns (intercept, coefs)."""
    A = np.column_stack([np.ones(len(X)), X]); b = np.zeros(A.shape[1]); b[0] = math.log(max(y.mean(), 1e-6))
    w = np.ones(len(y)) if w is None else np.asarray(w, float)
    for _ in range(iters):
        mu = np.exp(A @ b); z = A @ b + (y - mu) / mu
        step = np.linalg.solve(A.T @ (A * (w * mu)[:, None]), A.T @ (w * mu * z))
        if np.max(np.abs(step - b)) < 1e-9: b = step; break
        b = step
    return b[0], b[1:]

def log_loss(y, p): y = np.asarray(y); p = np.asarray(p); return float(-np.mean(y * np.log(p) + (1 - y) * np.log(1 - p)))
def roc_auc_score(y, p):
    y = np.asarray(y); r = pd.Series(np.asarray(p)).rank().values; n1 = y.sum(); n0 = len(y) - n1
    return float((r[y == 1].sum() - n1 * (n1 + 1) / 2) / (n1 * n0))

def logistic_glm(X, y, iters=60, ridge=1e-6):
    """Logistic regression by IRLS (a whisker of ridge for separable corners). Returns (intercept, coefs)."""
    A = np.column_stack([np.ones(len(X)), X]); b = np.zeros(A.shape[1])
    for _ in range(iters):
        p = 1 / (1 + np.exp(-(A @ b))); W = np.maximum(p * (1 - p), 1e-9)
        H = A.T @ (A * W[:, None]) + ridge * np.eye(A.shape[1])
        step = np.linalg.solve(H, A.T @ (y - p))
        b = b + step
        if np.max(np.abs(step)) < 1e-9: break
    return b[0], b[1:]
