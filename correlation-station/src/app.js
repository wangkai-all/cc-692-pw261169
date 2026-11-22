/* 分析编排：对给定工况与方案跑完整链路，输出 UI 可直接渲染的状态对象。 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./stats.js'));
  else root.CS = root.CS || {}, root.CS.app = factory(root.CS.stats);
})(typeof self !== 'undefined' ? self : this, function (S) {
  'use strict';

  // 数据生成模型的真实直接边（仅用于教学对照——真实生产中这个对象不存在）
  var GROUND_TRUTH = [
    ['load_pct', 'furnace_temp_c'], ['load_pct', 'exhaust_temp_c'],
    ['furnace_temp_c', 'exhaust_temp_c'],
    ['load_pct', 'gas_flow_m3'], ['load_pct', 'vibration_mms'],
    ['load_pct', 'material_kg'], ['load_pct', 'cooling_bar'],
    ['load_pct', 'defect_rate'], ['vibration_mms', 'defect_rate'],
    ['load_pct', 'energy_kwh'], ['gas_flow_m3', 'energy_kwh'],
    ['vibration_mms', 'energy_kwh']
  ];
  function gtKey(a, b) { return a < b ? a + '|' + b : b + '|' + a; }
  var GT_SET = {};
  GROUND_TRUTH.forEach(function (e) { GT_SET[gtKey(e[0], e[1])] = true; });
  function isGroundTruth(a, b) { return !!GT_SET[gtKey(a, b)]; }

  function makeGrid(method) {
    if (method === 'glasso') {
      var g = [];
      for (var i = 0; i < 16; i++) g.push(0.5 * Math.pow(0.72, i)); // 0.5 → ~0.0058
      return g;
    }
    var a = [];
    for (var k = 0; k <= 20; k++) a.push(k / 20); // 0 → 1
    return a;
  }

  function analyze(rows, metricDefs, opts) {
    opts = opts || {};
    var method = opts.method || 'glasso';           // 'glasso' | 'lw' | 'oas' | 'shrink-manual'
    var edgeTau = opts.edgeTau || 0.1;
    var manualParam = opts.manualParam;             // 手动正则力度（覆盖 CV 选择）
    var sparsePick = opts.sparsePick !== false;     // glasso：true=1-SE 稀疏解（默认），false=NLL 最优
    var bootB = opts.bootB || 40;
    var rng = opts.rng;

    var t0 = Date.now();
    var pre = S.preprocess(rows, metricDefs);
    var nameMap = {};
    metricDefs.forEach(function (m) { nameMap[m.key] = m; });

    var Scov = S.covMLE(pre.Z);
    var R = S.corrFromCov(Scov);
    var eigMLE = S.jacobiEigen(R);
    var mleInvertible = S.invert(R) !== null;

    var lw = S.ledoitWolf(Scov, pre.n, pre.Z);
    var oas = S.oas(Scov, pre.n);

    var grid = makeGrid(method === 'glasso' ? 'glasso' : 'shrink');
    var cv, param, cvScheme, paramSource;
    if (method === 'glasso') {
      cv = S.cvGlasso(pre.Z, pre.completeRows, grid);
      cvScheme = cv.foldScheme;
      if (manualParam != null) { param = manualParam; paramSource = '手动'; }
      else {
        param = sparsePick ? cv.best1SE.lambda : cv.best.lambda;
        paramSource = sparsePick ? 'CV 1-SE 稀疏解' : 'CV 最优 NLL';
      }
    } else {
      cv = S.cvShrink(pre.Z, pre.completeRows, grid);
      cvScheme = cv.foldScheme;
      if (method === 'lw') { param = lw.shrink; paramSource = 'Ledoit–Wolf 闭式'; }
      else if (method === 'oas') { param = oas.shrink; paramSource = 'OAS 闭式'; }
      else {
        param = manualParam != null ? manualParam : cv.best.alpha;
        paramSource = manualParam != null ? '手动' : 'CV 选择';
      }
    }

    // 全量拟合
    var Theta, fitNote = '';
    if (method === 'glasso') {
      var fit = S.glasso(R, param);
      Theta = fit.Theta; fitNote = '迭代 ' + fit.niter + ' 轮收敛';
    } else {
      var Sigma = S.shrinkCov(R, param);
      Theta = S.invert(Sigma);
      fitNote = '收缩协方差求逆（闭式）';
    }
    var partial = S.partialFromTheta(Theta);

    // 边表
    var p = pre.p, edges = [];
    for (var i = 0; i < p; i++) for (var j = i + 1; j < p; j++) {
      var exactZero = Math.abs(Theta[i][j]) < 1e-8;
      var isEdge = method === 'glasso' ? !exactZero : Math.abs(partial[i][j]) > edgeTau;
      edges.push({
        i: i, j: j, keyA: pre.keys[i], keyB: pre.keys[j],
        r: R[i][j], partial: partial[i][j], theta: Theta[i][j],
        exactZero: exactZero, isEdge: isEdge,
        groundTruth: isGroundTruth(pre.keys[i], pre.keys[j])
      });
    }
    edges.sort(function (a, b) { return Math.abs(b.partial) - Math.abs(a.partial); });

    // 稳定性（同一估计器、同一参数）
    var estimator = {
      method: method === 'glasso' ? 'glasso' : 'shrink',
      param: param, partial: partial
    };
    var stab = S.stability(pre.Z, pre.completeRows, rng, estimator, bootB);

    // 逐对删缺失诊断（对照：展示为什么本应用坚持 listwise）
    var pairwise = S.pairwiseDiagnostics(rows, pre.keys);

    return {
      method: method, param: param, paramSource: paramSource, edgeTau: edgeTau,
      cv: cv, cvScheme: cvScheme, fitNote: fitNote,
      pre: pre, nameMap: nameMap,
      R: R, Theta: Theta, partial: partial, edges: edges,
      eigMLE: { min: eigMLE[0], max: eigMLE[eigMLE.length - 1], mleInvertible: mleInvertible },
      lw: lw, oas: oas,
      stability: stab,
      pairwise: pairwise,
      ms: Date.now() - t0
    };
  }

  return { analyze: analyze, GROUND_TRUTH: GROUND_TRUTH, isGroundTruth: isGroundTruth };
});
