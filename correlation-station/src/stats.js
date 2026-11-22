/* 统计核心：完整样本处理、MLE/Ledoit-Wolf/OAS 收缩、graphical lasso、
 * 按批次留出交叉验证、bootstrap/留批次稳定性、逐对删缺失合法性诊断。
 * 纯函数、无 DOM 依赖，可在 Node 下直接测试。 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.CS = root.CS || {}, root.CS.stats = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var LN2PI = Math.log(2 * Math.PI);

  function zeros(n, m) {
    var A = new Array(n);
    for (var i = 0; i < n; i++) { A[i] = new Array(m || n).fill(0); }
    return A;
  }
  function identity(p) { var A = zeros(p); for (var i = 0; i < p; i++) A[i][i] = 1; return A; }
  function clone(A) { return A.map(function (r) { return r.slice(); }); }
  function symmetrize(A) {
    var n = A.length;
    for (var i = 0; i < n; i++) for (var j = i + 1; j < n; j++) {
      var v = 0.5 * (A[i][j] + A[j][i]); A[i][j] = v; A[j][i] = v;
    }
    return A;
  }
  function matmul(A, B) {
    var n = A.length, m = B[0].length, k = B.length, C = zeros(n, m);
    for (var i = 0; i < n; i++)
      for (var t = 0; t < k; t++) {
        var a = A[i][t];
        for (var j = 0; j < m; j++) C[i][j] += a * B[t][j];
      }
    return C;
  }
  function trace(A) { var s = 0; for (var i = 0; i < A.length; i++) s += A[i][i]; return s; }
  function frob2(A) { var s = 0; A.forEach(function (r) { r.forEach(function (v) { s += v * v; }); }); return s; }
  function soft(x, t) { if (x > t) return x - t; if (x < -t) return t + x; return 0; }

  // Gauss–Jordan 求逆；奇异时返回 null
  function invert(A) {
    var n = A.length, M = zeros(n, 2 * n);
    for (var i = 0; i < n; i++) for (var j = 0; j < n; j++) M[i][j] = A[i][j];
    for (i = 0; i < n; i++) M[i][n + i] = 1;
    for (var col = 0; col < n; col++) {
      var piv = col, best = Math.abs(M[col][col]);
      for (var r = col + 1; r < n; r++) if (Math.abs(M[r][col]) > best) { best = Math.abs(M[r][col]); piv = r; }
      if (best < 1e-12) return null;
      if (piv !== col) { var tmp = M[col]; M[col] = M[piv]; M[piv] = tmp; }
      var d = M[col][col];
      for (var j = 0; j < 2 * n; j++) M[col][j] /= d;
      for (r = 0; r < n; r++) if (r !== col) {
        var f = M[r][col];
        if (f === 0) continue;
        for (j = 0; j < 2 * n; j++) M[r][j] -= f * M[col][j];
      }
    }
    var R = zeros(n);
    for (i = 0; i < n; i++) for (j = 0; j < n; j++) R[i][j] = M[i][j + n];
    return R;
  }

  // Cholesky（SPD），非正定返回 null
  function chol(A) {
    var n = A.length, L = zeros(n);
    for (var i = 0; i < n; i++) {
      for (var j = 0; j <= i; j++) {
        var s = 0;
        for (var k = 0; k < j; k++) s += L[i][k] * L[j][k];
        if (i === j) {
          var v = A[i][i] - s;
          if (v <= 1e-12) return null;
          L[i][j] = Math.sqrt(v);
        } else L[i][j] = (A[i][j] - s) / L[j][j];
      }
    }
    return L;
  }
  function logdetSPD(A) {
    var L = chol(A);
    if (!L) return null;
    var s = 0;
    for (var i = 0; i < L.length; i++) s += Math.log(L[i][i]);
    return 2 * s;
  }
  function isSPD(A) { return chol(A) !== null; }

  // 经典 Jacobi 对称矩阵特征分解（p 很小，足够用）
  function jacobiEigen(A0) {
    var A = clone(A0), n = A.length;
    for (var sweep = 0; sweep < 100; sweep++) {
      var off = 0;
      for (var p = 0; p < n; p++) for (var q = p + 1; q < n; q++) off += A[p][q] * A[p][q];
      if (off < 1e-18) break;
      for (p = 0; p < n; p++) for (q = p + 1; q < n; q++) {
        if (Math.abs(A[p][q]) < 1e-15) continue;
        var tau = (A[q][q] - A[p][p]) / (2 * A[p][q]);
        var t = (tau >= 0 ? 1 : -1) / (Math.abs(tau) + Math.sqrt(1 + tau * tau));
        var c = 1 / Math.sqrt(1 + t * t), s2 = t * c;
        var app = A[p][p], aqq = A[q][q], apq = A[p][q];
        A[p][p] = app - t * apq; A[q][q] = aqq + t * apq; A[p][q] = 0; A[q][p] = 0;
        for (var k = 0; k < n; k++) if (k !== p && k !== q) {
          var akp = A[k][p], akq = A[k][q];
          A[k][p] = c * akp - s2 * akq; A[p][k] = A[k][p];
          A[k][q] = s2 * akp + c * akq; A[q][k] = A[k][q];
        }
      }
    }
    var eig = [];
    for (var i = 0; i < n; i++) eig.push(A[i][i]);
    eig.sort(function (a, b) { return a - b; });
    return eig;
  }

  // -------- 数据预处理：同一套完整记录 --------
  function preprocess(rows, metricDefs) {
    var excluded = [], complete = [];
    rows.forEach(function (row) {
      var miss = metricDefs.filter(function (m) { return row[m.key] === null || row[m.key] === undefined; })
        .map(function (m) { return m.name; });
      if (miss.length) excluded.push({ shift_id: row.shift_id, batch: row.batch, date: row.date, reasons: ['缺失指标：' + miss.join('、')] });
      else complete.push(row);
    });

    var keys = metricDefs.map(function (m) { return m.key; });
    var droppedConstants = [], droppedDuplicates = [];

    // 恒定列
    keys = keys.filter(function (key) {
      var v0 = complete[0][key];
      var constFlag = complete.every(function (r) { return r[key] === v0; });
      if (constFlag) { droppedConstants.push({ key: key, value: v0 }); return false; }
      return true;
    });

    // 完全相同 / 仿射等价列（在完整记录上判定；用相关系数 |r|>1−1e-9 识别仿射重复）
    function colVals(colKey) { return complete.map(function (r) { return r[colKey]; }); }
    function pearson(x, y) {
      var n = x.length, mx = x.reduce(function (a, b) { return a + b; }, 0) / n;
      var my = y.reduce(function (a, b) { return a + b; }, 0) / n, sx = 0, sy = 0, sxy = 0;
      for (var i = 0; i < n; i++) { var dx = x[i] - mx, dy = y[i] - my; sx += dx * dx; sy += dy * dy; sxy += dx * dy; }
      return sxy / Math.sqrt(sx * sy);
    }
    var keepFlags = keys.map(function () { return true; });
    for (var a = 0; a < keys.length; a++) {
      if (!keepFlags[a]) continue;
      for (var b = a + 1; b < keys.length; b++) {
        if (!keepFlags[b]) continue;
        var exact = complete.every(function (r) { return r[keys[a]] === r[keys[b]]; });
        var r = pearson(colVals(keys[a]), colVals(keys[b]));
        if (exact || Math.abs(r) > 1 - 1e-5) {
          keepFlags[b] = false;
          droppedDuplicates.push({ key: keys[b], equals: keys[a], relation: exact ? '数值完全相同' : '仿射等价（|r|=' + r.toFixed(6) + '≈1）' });
        }
      }
    }
    keys = keys.filter(function (_, idx) { return keepFlags[idx]; });

    var n = complete.length, p = keys.length, i, j, d;
    var X = zeros(n, p), means = new Array(p).fill(0), sds = new Array(p).fill(0);
    for (j = 0; j < p; j++) {
      for (i = 0; i < n; i++) means[j] += complete[i][keys[j]];
      means[j] /= n;
      for (i = 0; i < n; i++) { d = complete[i][keys[j]] - means[j]; X[i][j] = d; sds[j] += d * d; }
      sds[j] = Math.sqrt(sds[j] / n);
    }
    var Z = zeros(n, p);
    for (i = 0; i < n; i++) for (j = 0; j < p; j++) Z[i][j] = X[i][j] / sds[j];

    return {
      completeRows: complete, excluded: excluded, keys: keys,
      droppedConstants: droppedConstants, droppedDuplicates: droppedDuplicates,
      n: n, p: p, nLessThanP: n < p, lowRatio: n < 3 * p,
      X: X, Z: Z, means: means, sds: sds
    };
  }

  // MLE 协方差（除以 n），输入为中心化矩阵
  function covMLE(X) {
    var n = X.length, p = X[0].length, S = zeros(p);
    for (var i = 0; i < n; i++) for (var a = 0; a < p; a++) {
      for (var b = a; b < p; b++) {
        var v = X[i][a] * X[i][b];
        if (a === b) S[a][a] += v; else { S[a][b] += v; S[b][a] += v; }
      }
    }
    for (a = 0; a < p; a++) for (b = 0; b < p; b++) S[a][b] /= n;
    return symmetrize(S);
  }
  function corrFromCov(S) {
    var p = S.length, R = zeros(p);
    for (var i = 0; i < p; i++) for (var j = 0; j < p; j++) {
      var d = Math.sqrt(Math.max(S[i][i], 1e-18) * Math.max(S[j][j], 1e-18));
      R[i][j] = S[i][j] / d;
    }
    return R;
  }

  // Ledoit–Wolf 2004：向 μI 收缩（μ = tr(S)/p）。
  // 传入中心化原始矩阵 X 时使用严格 π̂ = Σ_ab Var(x_a x_b)；否则退化为恒等式近似。
  function ledoitWolf(S, n, X) {
    var p = S.length, mu = trace(S) / p;
    var trS2 = frob2(S), tr2S = trace(S) * trace(S);
    var pi;
    if (X) {
      pi = 0;
      for (var a = 0; a < p; a++) for (var b = 0; b < p; b++) {
        var mean2 = 0, meanSq = 0;
        for (var i = 0; i < n; i++) {
          var z = X[i][a] * X[i][b];
          mean2 += z; meanSq += z * z;
        }
        mean2 /= n; meanSq /= n;
        pi += (n / (n - 1)) * (meanSq - mean2 * mean2);
      }
    } else {
      pi = (n / (n - 1)) * (trS2 - tr2S / n);
    }
    var gamma = trS2 - 2 * mu * trace(S) + p * mu * mu; // ||S−μI||²
    var kappa = (pi - gamma) / (n * gamma);
    var shrink = Math.min(1, Math.max(0, kappa));
    var Sigma = zeros(p);
    for (var i = 0; i < p; i++) for (var j = 0; j < p; j++) Sigma[i][j] = shrink * mu * (i === j ? 1 : 0) + (1 - shrink) * S[i][j];
    return { shrink: shrink, Sigma: symmetrize(Sigma), target: 'scaled-identity' };
  }

  // OAS（Chen 2010），同样向 μI
  function oas(S, n) {
    var p = S.length, mu = trace(S) / p;
    var trS2 = frob2(S), tr2S = trace(S) * trace(S);
    var num = (1 - 2 / p) * trS2 + tr2S;
    var den = (n + 1 - 2 / p) * (trS2 - tr2S / p);
    var shrink = Math.min(1, Math.max(0, num / den));
    var Sigma = zeros(p);
    for (var i = 0; i < p; i++) for (var j = 0; j < p; j++) Sigma[i][j] = shrink * mu * (i === j ? 1 : 0) + (1 - shrink) * S[i][j];
    return { shrink: shrink, Sigma: symmetrize(Sigma), target: 'scaled-identity' };
  }
  function shrinkCov(S, alpha) {
    var p = S.length, mu = trace(S) / p, Sigma = zeros(p);
    for (var i = 0; i < p; i++) for (var j = 0; j < p; j++) Sigma[i][j] = alpha * mu * (i === j ? 1 : 0) + (1 - alpha) * S[i][j];
    return symmetrize(Sigma);
  }

  /* Graphical lasso（Friedman, Hastie, Tibshirani 2008 坐标下降）。
   * 输入经验协方差 S（建议标准化后的相关阵尺度）与惩罚 λ。
   * 返回 {Theta, W, niter, gap}。 */
  function glasso(S, lambda, opts) {
    opts = opts || {};
    var tol = opts.tol || 1e-5, maxit = opts.maxit || 200;
    var p = S.length;
    var W = clone(S);
    for (var i = 0; i < p; i++) W[i][i] += lambda;
    var Theta = identity(p);
    var prev = clone(W);

    for (var it = 0; it < maxit; it++) {
      prev = clone(W);
      for (var col = 0; col < p; col++) {
        var idx = [];
        for (var k = 0; k < p; k++) if (k !== col) idx.push(k);
        var W11 = zeros(p - 1), s12 = new Array(p - 1);
        for (var a = 0; a < p - 1; a++) {
          s12[a] = S[idx[a]][col];
          for (var b = 0; b < p - 1; b++) W11[a][b] = W[idx[a]][idx[b]];
        }
        var beta = new Array(p - 1).fill(0);
        // 内部 lasso 坐标下降
        for (var inner = 0; inner < 5000; inner++) {
          var dmax = 0;
          for (var j = 0; j < p - 1; j++) {
            var r = s12[j];
            for (var l = 0; l < p - 1; l++) if (l !== j) r -= W11[j][l] * beta[l];
            var nb = soft(r, lambda) / W11[j][j];
            dmax = Math.max(dmax, Math.abs(nb - beta[j]));
            beta[j] = nb;
          }
          if (dmax < 1e-8) break;
        }
        for (a = 0; a < p - 1; a++) {
          var v = 0;
          for (b = 0; b < p - 1; b++) v += W11[a][b] * beta[b];
          W[idx[a]][col] = v; W[col][idx[a]] = v;
        }
        var w12b = 0;
        for (a = 0; a < p - 1; a++) w12b += W[col][idx[a]] * beta[a];
        var thii = 1 / (W[col][col] - w12b);
        Theta[col][col] = thii;
        for (a = 0; a < p - 1; a++) Theta[idx[a]][col] = -beta[a] * thii, Theta[col][idx[a]] = Theta[idx[a]][col];
      }
      var change = 0;
      for (i = 0; i < p; i++) for (j = 0; j < p; j++) change = Math.max(change, Math.abs(W[i][j] - prev[i][j]));
      if (change < tol) break;
    }
    symmetrize(Theta);
    return { Theta: Theta, W: W, niter: it + 1 };
  }

  // 精度矩阵 -> 偏相关矩阵
  function partialFromTheta(Theta) {
    var p = Theta.length, P = zeros(p);
    for (var i = 0; i < p; i++) for (var j = 0; j < p; j++) {
      if (i === j) P[i][j] = 1;
      else P[i][j] = -Theta[i][j] / Math.sqrt(Math.max(Theta[i][i] * Theta[j][j], 1e-18));
    }
    return P;
  }

  // 测试集负对数似然（每行均值），用训练均值中心化；失败返回 Infinity
  function nllTest(Ztest, trainMeans, Theta) {
    var p = Theta.length;
    var ld = logdetSPD(Theta);
    if (ld === null) return Infinity;
    var Stest = zeros(p);
    var m = Ztest.length;
    // Ztest 已按训练均值/训练尺度中心化时直接用；这里兼容原始中心化矩阵
    for (var i = 0; i < m; i++) for (var a = 0; a < p; a++) for (var b = a; b < p; b++) {
      var v = Ztest[i][a] * Ztest[i][b];
      if (a === b) Stest[a][a] += v; else { Stest[a][b] += v; Stest[b][a] += v; }
    }
    for (a = 0; a < p; a++) for (b = 0; b < p; b++) Stest[a][b] /= m;
    var tr = 0;
    for (a = 0; a < p; a++) for (b = 0; b < p; b++) tr += Stest[a][b] * Theta[a][b];
    return 0.5 * (p * LN2PI - ld + tr);
  }

  // 按批次构造 K 折（调试工况单批次时退化为留一班次）
  function makeFolds(rows, k) {
    var groups = {}, groupList = [];
    rows.forEach(function (r) {
      var g = r.batch;
      if (!groups[g]) { groups[g] = []; groupList.push(g); }
      groups[g].push(r);
    });
    if (groupList.length === 1) {
      return { scheme: '留一班次（LOO）', folds: rows.map(function (_, idx) {
        return { train: rows.map(function (_, i) { return i; }).filter(function (i) { return i !== idx; }),
          test: [idx] };
      }) };
    }
    groupList.sort();
    var K = Math.min(k, groupList.length);
    var folds = [];
    for (var f = 0; f < K; f++) folds.push({ testGroups: [], train: [], test: [] });
    groupList.forEach(function (g, gi) { folds[gi % K].testGroups.push(g); });
    rows.forEach(function (r, ri) {
      var foldIdx = groupList.indexOf(r.batch) % K;
      for (f = 0; f < K; f++) (f === foldIdx ? folds[f].test : folds[f].train).push(ri);
    });
    return { scheme: '按批次 ' + K + ' 折留出', folds: folds };
  }

  function centerSubset(Z, rowIdx) { return rowIdx.map(function (i) { return Z[i].slice(); }); }

  // 收缩强度的留出选择
  function cvShrink(Z, rows, grid) {
    var foldInfo = makeFolds(rows, 5), folds = foldInfo.folds;
    var results = grid.map(function (alpha) {
      var total = 0, ok = true;
      folds.forEach(function (fold) {
        var Ztr = centerSubset(Z, fold.train), Zte = centerSubset(Z, fold.test);
        var Str = covMLE(Ztr), Sig = shrinkCov(Str, alpha);
        var Theta = invert(Sig);
        if (!Theta || !isSPD(Theta)) { ok = false; return; }
        total += nllTest(Zte, null, Theta) * fold.test.length;
      });
      return { alpha: alpha, nll: ok ? total / Z.length : Infinity };
    });
    var best = results.reduce(function (a, b) { return b.nll < a.nll ? b : a; });
    return { results: results, best: best, folds: folds.length, foldScheme: foldInfo.scheme };
  }

  // graphical lasso λ 的留出选择（沿 λ 网格热启动）。
  // 同时返回 NLL 最优（best）与 1-SE 解（best1SE：在最优值 1 个标准误内取最大 λ，偏向稀疏与稳定）。
  function cvGlasso(Z, rows, lambdas) {
    var foldInfo = makeFolds(rows, 5), folds = foldInfo.folds;
    var perFold = lambdas.map(function () { return []; });
    var results = lambdas.map(function (lam, li) {
      var total = 0, ok = true;
      folds.forEach(function (fold) {
        var Ztr = centerSubset(Z, fold.train), Zte = centerSubset(Z, fold.test);
        var Str = covMLE(Ztr);
        var fit;
        try { fit = glasso(Str, lam, { tol: 1e-4, maxit: 100 }); } catch (e) { ok = false; return; }
        if (!isSPD(fit.Theta)) { ok = false; return; }
        var v = nllTest(Zte, null, fit.Theta);
        perFold[li].push(v);
        total += v * fold.test.length;
      });
      return { lambda: lam, nll: ok ? total / Z.length : Infinity };
    });
    var finite = results.filter(function (r) { return isFinite(r.nll); });
    var best = finite.reduce(function (a, b) { return b.nll < a.nll ? b : a; });
    // 最优 λ 处各折 NLL 的标准误
    var bestFoldVals = perFold[lambdas.indexOf(best.lambda)];
    var m = bestFoldVals.reduce(function (a, b) { return a + b; }, 0) / bestFoldVals.length;
    var variance = bestFoldVals.reduce(function (a, b) { return a + (b - m) * (b - m); }, 0) / Math.max(1, bestFoldVals.length - 1);
    var se = Math.sqrt(variance / bestFoldVals.length);
    // 1-SE：NLL ≤ best+SE 中的最大 λ（网格按 λ 降序，取第一个满足者）
    var best1SE = finite.filter(function (r) { return r.nll <= best.nll + se; })[0] || best;
    return { results: results, best: best, best1SE: best1SE, se: se,
      folds: folds.length, foldScheme: foldInfo.scheme };
  }

  // bootstrap 稳定性 + 留批次（jackknife）稳定性
  function stability(Z, rows, rng, estimator, B) {
    var n = Z.length, p = Z[0].length;
    var present = zeros(p), signAgree = zeros(p), vals = [];
    for (var a = 0; a < p; a++) for (var b = a + 1; b < p; b++) vals[a + '-' + b] = [];
    var basePartial = estimator.partial;
    var thr = 0.08;
    for (var rep = 0; rep < B; rep++) {
      var idx = [];
      for (var i = 0; i < n; i++) idx.push(Math.floor(rng() * n));
      var Zb = idx.map(function (k) { return Z[k].slice(); });
      var Sb = covMLE(Zb);
      var P;
      if (estimator.method === 'glasso') P = partialFromTheta(glasso(Sb, estimator.param).Theta);
      else P = partialFromTheta(invert(shrinkCov(Sb, estimator.param)));
      for (a = 0; a < p; a++) for (b = a + 1; b < p; b++) {
        if (Math.abs(P[a][b]) > thr) {
          present[a][b]++; present[b][a]++;
          if (Math.sign(P[a][b]) === Math.sign(basePartial[a][b])) { signAgree[a][b]++; signAgree[b][a]++; }
        }
        vals[a + '-' + b].push(P[a][b]);
      }
    }
    // 留批次
    var batches = [], jack = [];
    rows.forEach(function (r) { if (batches.indexOf(r.batch) < 0) batches.push(r.batch); });
    batches.forEach(function (g) {
      var keep = rows.map(function (r, i) { return r.batch !== g ? i : -1; }).filter(function (x) { return x >= 0; });
      if (keep.length <= p) return;
      var Zj = centerSubset(Z, keep), Sj = covMLE(Zj);
      var Pj = estimator.method === 'glasso'
        ? partialFromTheta(glasso(Sj, estimator.param).Theta)
        : partialFromTheta(invert(shrinkCov(Sj, estimator.param)));
      jack.push({ batch: g, partial: Pj });
    });
    function quantile(arr, q) {
      var a = arr.slice().sort(function (x, y) { return x - y; });
      var pos = Math.min(a.length - 1, Math.max(0, Math.round(q * (a.length - 1))));
      return a[pos];
    }
    var summary = zeros(p);
    for (a = 0; a < p; a++) for (b = a + 1; b < p; b++) {
      var jp = jack.map(function (j) { return j.partial[a][b]; });
      summary[a][b] = summary[b][a] = {
        bootProb: present[a][b] / B,
        signAgree: present[a][b] ? signAgree[a][b] / present[a][b] : null,
        median: quantile(vals[a + '-' + b], 0.5),
        q10: quantile(vals[a + '-' + b], 0.1),
        q90: quantile(vals[a + '-' + b], 0.9),
        jackMin: jp.length ? Math.min.apply(null, jp) : null,
        jackMax: jp.length ? Math.max.apply(null, jp) : null,
        jackMedian: jp.length ? quantile(jp, 0.5) : null,
        jackBatches: jp.length
      };
    }
    return { summary: summary, B: B, jackBatches: batches.length, threshold: thr };
  }

  // 逐对删缺失：演示“不合法协方差矩阵”如何产生
  function pairwiseDiagnostics(rows, keys) {
    var p = keys.length, C = zeros(p), nMat = zeros(p);
    for (var a = 0; a < p; a++) for (var b = a; b < p; b++) {
      var pair = rows.filter(function (r) {
        var va = r[keys[a]], vb = r[keys[b]];
        return va !== null && va !== undefined && vb !== null && vb !== undefined;
      });
      nMat[a][b] = nMat[b][a] = pair.length;
      if (a === b) { C[a][b] = 1; continue; }
      var ma = pair.reduce(function (s, r) { return s + r[keys[a]]; }, 0) / pair.length;
      var mb = pair.reduce(function (s, r) { return s + r[keys[b]]; }, 0) / pair.length;
      var sa = Math.sqrt(pair.reduce(function (s, r) { return s + Math.pow(r[keys[a]] - ma, 2); }, 0) / pair.length);
      var sb = Math.sqrt(pair.reduce(function (s, r) { return s + Math.pow(r[keys[b]] - mb, 2); }, 0) / pair.length);
      var cov = pair.reduce(function (s, r) { return s + (r[keys[a]] - ma) * (r[keys[b]] - mb); }, 0) / pair.length;
      var r = cov / (sa * sb);
      C[a][b] = r; C[b][a] = r;
    }
    var eig = jacobiEigen(C);
    return {
      matrix: C, sampleCounts: nMat,
      minEigen: eig[0], maxEigen: eig[eig.length - 1],
      condition: eig[eig.length - 1] / Math.max(Math.abs(eig[0]), 1e-18),
      psd: eig[0] >= -1e-10
    };
  }

  return {
    zeros: zeros, identity: identity, clone: clone, symmetrize: symmetrize, matmul: matmul,
    invert: invert, chol: chol, logdetSPD: logdetSPD, isSPD: isSPD, jacobiEigen: jacobiEigen,
    preprocess: preprocess, covMLE: covMLE, corrFromCov: corrFromCov,
    ledoitWolf: ledoitWolf, oas: oas, shrinkCov: shrinkCov,
    glasso: glasso, partialFromTheta: partialFromTheta, nllTest: nllTest,
    makeFolds: makeFolds, cvShrink: cvShrink, cvGlasso: cvGlasso,
    stability: stability, pairwiseDiagnostics: pairwiseDiagnostics
  };
});
