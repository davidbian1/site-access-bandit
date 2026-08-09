// Disjoint LinUCB contextual bandit (Li et al., 2010).
// Each arm keeps its own ridge-regression state: A (d x d), b (d x 1).
// UCB score for arm a given context x: theta_a^T x + alpha * sqrt(x^T A_a^-1 x)
// gamma (default 1 = off) discounts A/b before each update, letting recent
// observations outweigh old ones instead of every data point mattering
// equally forever — see DEFAULT_DISCOUNT_FACTOR in lib/config.js.

export const FEATURE_DIM = 7;

export function identity(n) {
  const m = [];
  for (let i = 0; i < n; i++) {
    m.push(new Array(n).fill(0));
    m[i][i] = 1;
  }
  return m;
}

function zeros(n) {
  return new Array(n).fill(0);
}

function matVec(A, x) {
  const n = A.length;
  const out = new Array(n).fill(0);
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (let j = 0; j < x.length; j++) s += A[i][j] * x[j];
    out[i] = s;
  }
  return out;
}

function dot(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

function outer(x, y) {
  const n = x.length, m = y.length;
  const out = [];
  for (let i = 0; i < n; i++) {
    const row = new Array(m);
    for (let j = 0; j < m; j++) row[j] = x[i] * y[j];
    out.push(row);
  }
  return out;
}

export function matAdd(A, B) {
  const n = A.length, m = A[0].length;
  const out = [];
  for (let i = 0; i < n; i++) {
    const row = new Array(m);
    for (let j = 0; j < m; j++) row[j] = A[i][j] + B[i][j];
    out.push(row);
  }
  return out;
}

export function vecAdd(a, b) {
  return a.map((v, i) => v + b[i]);
}

export function vecScale(a, k) {
  return a.map((v) => v * k);
}

export function matScale(A, k) {
  return A.map((row) => row.map((v) => v * k));
}

// Gauss-Jordan inversion with partial pivoting. A is always symmetric
// positive-definite here (identity + sum of outer products), so it is
// invertible in exact arithmetic; partial pivoting keeps it numerically sane.
function inverse(A) {
  const n = A.length;
  const M = A.map((row, i) => {
    const aug = row.slice();
    for (let j = 0; j < n; j++) aug.push(i === j ? 1 : 0);
    return aug;
  });

  for (let col = 0; col < n; col++) {
    let pivotRow = col;
    let best = Math.abs(M[col][col]);
    for (let r = col + 1; r < n; r++) {
      if (Math.abs(M[r][col]) > best) {
        best = Math.abs(M[r][col]);
        pivotRow = r;
      }
    }
    if (pivotRow !== col) {
      const tmp = M[col];
      M[col] = M[pivotRow];
      M[pivotRow] = tmp;
    }
    const pivot = M[col][col] || 1e-9;
    for (let j = 0; j < 2 * n; j++) M[col][j] /= pivot;
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const factor = M[r][col];
      if (factor === 0) continue;
      for (let j = 0; j < 2 * n; j++) M[r][j] -= factor * M[col][j];
    }
  }
  return M.map((row) => row.slice(n));
}

class LinUCBArm {
  constructor(d) {
    this.d = d;
    this.A = identity(d);
    this.b = zeros(d);
  }

  static fromJSON(o) {
    const arm = new LinUCBArm(o.b.length);
    arm.A = o.A;
    arm.b = o.b;
    return arm;
  }

  toJSON() {
    return { A: this.A, b: this.b };
  }

  score(x, alpha) {
    const Ainv = inverse(this.A);
    const theta = matVec(Ainv, this.b);
    const mean = dot(theta, x);
    const variance = Math.sqrt(Math.max(0, dot(x, matVec(Ainv, x))));
    return { ucb: mean + alpha * variance, mean, variance };
  }

  // gamma < 1 discounts existing A/b before folding in the new observation,
  // so old data gradually loses influence instead of weighing exactly as
  // much a year later as it did the day it happened — see DEFAULT_DISCOUNT_FACTOR
  // in lib/config.js for why that matters here. Re-adding (1-gamma)*I each
  // step keeps the ridge regularization from fading away along with the
  // discounted data: at steady state that term settles back to exactly I
  // instead of vanishing, so A can't drift toward singular no matter how
  // long the bandit runs.
  update(x, reward, gamma = 1) {
    const regularization = matScale(identity(this.d), 1 - gamma);
    this.A = matAdd(matAdd(matScale(this.A, gamma), regularization), outer(x, x));
    this.b = vecAdd(vecScale(this.b, gamma), vecScale(x, reward));
  }
}

export class LinUCB {
  constructor(nArms, d = FEATURE_DIM, alpha = 1.0, gamma = 1.0) {
    this.d = d;
    this.alpha = alpha;
    this.gamma = gamma;
    this.arms = new Array(nArms).fill(0).map(() => new LinUCBArm(d));
  }

  static fromJSON(o) {
    const bandit = new LinUCB(o.arms.length, o.d, o.alpha, o.gamma);
    bandit.arms = o.arms.map((a) => LinUCBArm.fromJSON(a));
    return bandit;
  }

  toJSON() {
    return { d: this.d, alpha: this.alpha, gamma: this.gamma, arms: this.arms.map((a) => a.toJSON()) };
  }

  // Returns { armIndex, scores } — picks the highest UCB score, breaking
  // ties randomly so untried arms with equal priors don't always tie to arm 0.
  selectArm(x) {
    const scores = this.arms.map((a) => a.score(x, this.alpha));
    let best = -Infinity;
    let candidates = [];
    scores.forEach((s, i) => {
      if (s.ucb > best + 1e-9) {
        best = s.ucb;
        candidates = [i];
      } else if (Math.abs(s.ucb - best) <= 1e-9) {
        candidates.push(i);
      }
    });
    const armIndex = candidates[Math.floor(Math.random() * candidates.length)];
    return { armIndex, scores };
  }

  update(armIndex, x, reward) {
    this.arms[armIndex].update(x, reward, this.gamma);
  }
}
