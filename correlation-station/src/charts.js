/* 可视化渲染：SVG 热力图、力导向网络图、CV 曲线、稳定性区间图。无外部依赖。 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.CS = root.CS || {}, root.CS.charts = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var SVGNS = 'http://www.w3.org/2000/svg';
  function el(tag, attrs, parent) {
    var node = document.createElementNS(SVGNS, tag);
    for (var k in attrs) {
      if (k === 'text') node.textContent = attrs[k];
      else node.setAttribute(k, attrs[k]);
    }
    if (parent) parent.appendChild(node);
    return node;
  }
  function hexToRgb(h) {
    h = h.replace('#', '');
    return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
  }
  function rgbToHex(c) {
    return '#' + c.map(function (v) {
      return Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0');
    }).join('');
  }
  // 发散插值：蓝 → 中性 → 红，t∈[-1,1]
  function diverging(t, tokens) {
    var neg = hexToRgb(tokens.neg), mid = hexToRgb(tokens.mid), pos = hexToRgb(tokens.pos);
    var a = t < 0 ? neg : pos, k = Math.min(1, Math.abs(t));
    return rgbToHex(mid.map(function (m, i) { return m + (a[i] - m) * k; }));
  }
  function fmt(x, d) {
    if (x === null || x === undefined || !isFinite(x)) return '—';
    var a = Math.abs(x);
    if (a !== 0 && (a < 0.005 || a >= 10000)) return x.toExponential(2);
    return x.toFixed(d == null ? 2 : d);
  }

  /* ---------- 热力图（相关阵 / 偏相关阵 / 逐对样本数）---------- */
  function heatmap(container, opts) {
    var labels = opts.labels, M = opts.matrix, p = labels.length;
    var tokens = opts.tokens, cell = opts.cell || 46, labelW = opts.labelW || 96, top = 34;
    var W = labelW + cell * p + 8, H = top + cell * p + 8;
    container.innerHTML = '';
    var svg = el('svg', { viewBox: '0 0 ' + W + ' ' + H, role: 'img', 'aria-label': opts.title }, container);
    // 列标签（旋转）
    labels.forEach(function (lab, j) {
      var x = labelW + j * cell + cell / 2;
      var t = el('text', { x: x, y: top - 6, 'text-anchor': 'start', class: 'hm-col',
        transform: 'rotate(-38 ' + x + ' ' + (top - 6) + ')' }, svg);
      t.textContent = lab;
    });
    labels.forEach(function (lab, i) {
      el('text', { x: labelW - 6, y: top + i * cell + cell / 2 + 4, 'text-anchor': 'end', class: 'hm-row' }, svg)
        .textContent = lab;
    });
    var minV = opts.min != null ? opts.min : -1, maxV = opts.max != null ? opts.max : 1;
    for (var i = 0; i < p; i++) for (var j = 0; j < p; j++) {
      var v = M[i][j], x = labelW + j * cell, y = top + i * cell;
      var fill;
      if (opts.countMode) {
        var kk = opts.countMax ? (v / opts.countMax) : v;
        fill = diverging(0.15 + 0.85 * kk, { neg: tokens.mid, mid: tokens.mid, pos: tokens.seq });
      } else {
        fill = diverging((v - minV) / (maxV - minV) * 2 - 1, tokens);
      }
      var r = el('rect', { x: x + 1, y: y + 1, width: cell - 2, height: cell - 2, rx: 3,
        fill: fill, class: 'hm-cell', tabindex: 0, 'data-cell': i + '-' + j }, svg);
      var txt = el('text', { x: x + cell / 2, y: y + cell / 2 + 4, 'text-anchor': 'middle',
        class: 'hm-val' }, svg);
      txt.textContent = opts.countMode ? v : fmt(v, 2);
      (function (ii, jj, vv, rr) {
        var tip = function () {
          opts.tooltip && opts.tooltip(labels[ii], labels[jj], vv, rr);
        };
        rr.addEventListener('mouseenter', tip);
        rr.addEventListener('focus', tip);
        rr.addEventListener('click', opts.onCell ? function () { opts.onCell(ii, jj); } : null);
      })(i, j, v, r);
    }
  }

  /* ---------- 力导向布局（确定性：固定环形初值，无随机项）---------- */
  function forceLayout(keys, edges, W, H) {
    var n = keys.length, pos = [], i, j;
    for (i = 0; i < n; i++) {
      var ang = 2 * Math.PI * i / n - Math.PI / 2;
      pos.push({ x: W / 2 + Math.cos(ang) * W * 0.34, y: H / 2 + Math.sin(ang) * H * 0.34, vx: 0, vy: 0 });
    }
    var strength = {};
    edges.forEach(function (e) { strength[e.i + '-' + e.j] = Math.abs(e.partial); });
    for (var tick = 0; tick < 420; tick++) {
      for (i = 0; i < n; i++) for (j = i + 1; j < n; j++) {
        var dx = pos[i].x - pos[j].x, dy = pos[i].y - pos[j].y;
        var d2 = dx * dx + dy * dy + 4, d = Math.sqrt(d2);
        var f = 5200 / d2;
        pos[i].vx += f * dx / d; pos[i].vy += f * dy / d;
        pos[j].vx -= f * dx / d; pos[j].vy -= f * dy / d;
      }
      edges.forEach(function (e) {
        var a = pos[e.i], b = pos[e.j], dx = b.x - a.x, dy = b.y - a.y, d = Math.sqrt(dx * dx + dy * dy) + 0.01;
        var target = 90 + 130 * (1 - strength[e.i + '-' + e.j]);
        var f = (d - target) * 0.02 * (0.4 + strength[e.i + '-' + e.j]);
        a.vx += f * dx / d; a.vy += f * dy / d;
        b.vx -= f * dx / d; b.vy -= f * dy / d;
      });
      for (i = 0; i < n; i++) {
        pos[i].vx += (W / 2 - pos[i].x) * 0.015;
        pos[i].vy += (H / 2 - pos[i].y) * 0.015;
        pos[i].vx *= 0.82; pos[i].vy *= 0.82;
        pos[i].x += pos[i].vx; pos[i].y += pos[i].vy;
        pos[i].x = Math.max(40, Math.min(W - 40, pos[i].x));
        pos[i].y = Math.max(30, Math.min(H - 24, pos[i].y));
      }
    }
    return pos;
  }

  function network(container, opts) {
    var keys = opts.keys, names = opts.names, edges = opts.edges, tokens = opts.tokens;
    var W = opts.width || 760, H = opts.height || 520;
    container.innerHTML = '';
    var svg = el('svg', { viewBox: '0 0 ' + W + ' ' + H, role: 'img', 'aria-label': '条件关联网络图' }, container);
    var pos = forceLayout(keys, edges.filter(function (e) { return e.isEdge; }), W, H);

    var gEdges = el('g', {}, svg), gNodes = el('g', {}, svg);
    function edgeColor(v) { return diverging(v, tokens); }

    edges.forEach(function (e) {
      var a = pos[e.i], b = pos[e.j];
      var w = 1 + 4.5 * Math.min(1, Math.abs(e.partial) / 0.6);
      var attrs = { x1: a.x, y1: a.y, x2: b.x, y2: b.y,
        stroke: edgeColor(e.partial), 'stroke-width': w, class: 'net-edge', tabindex: 0,
        'data-edge': e.i + '-' + e.j };
      if (!e.isEdge) {
        attrs['stroke-dasharray'] = '3 5'; attrs['stroke-opacity'] = '0.28';
        attrs['stroke-width'] = 1;
      }
      if (e.groundTruth) attrs['data-gt'] = '1';
      var line = el('line', attrs, gEdges);
      line.addEventListener('click', function () { opts.onEdge(e); });
      line.addEventListener('mouseenter', function () { opts.onEdgeHover(e, line); });
      line.addEventListener('focus', function () { opts.onEdge(e); });
      line.addEventListener('keydown', function (ev) { if (ev.key === 'Enter') opts.onEdge(e); });
    });

    keys.forEach(function (key, i) {
      var g = el('g', { transform: 'translate(' + pos[i].x + ',' + pos[i].y + ')', class: 'net-node',
        tabindex: 0, 'data-node': i }, gNodes);
      el('circle', { r: 15, fill: opts.roleColor(opts.roleOf(key)), stroke: tokens.nodeStroke, 'stroke-width': 1.5 }, g);
      var t = el('text', { y: 30, 'text-anchor': 'middle', class: 'net-label' }, g);
      t.textContent = names[key];
      g.addEventListener('click', function () { opts.onNode(i); });
      g.addEventListener('keydown', function (ev) { if (ev.key === 'Enter') opts.onNode(i); });
    });
    return { svg: svg, positions: pos };
  }

  /* ---------- CV 曲线 ---------- */
  function cvCurve(container, opts) {
    var pts = opts.points, xKey = opts.xKey, logX = opts.logX;
    var W = 460, H = 240, mL = 52, mR = 14, mT = 16, mB = 40;
    container.innerHTML = '';
    var svg = el('svg', { viewBox: '0 0 ' + W + ' ' + H, role: 'img', 'aria-label': '留出交叉验证曲线' }, container);
    var xs = pts.map(function (d) { return logX ? Math.log(d[xKey]) : d[xKey]; });
    var ys = pts.map(function (d) { return d.nll; }).filter(isFinite);
    var xmin = Math.min.apply(null, xs), xmax = Math.max.apply(null, xs);
    var ymin = Math.min.apply(null, ys), ymax = Math.max.apply(null, ys);
    var padY = (ymax - ymin) * 0.12 || 0.1;
    ymin -= padY; ymax += padY;
    function X(d) { return mL + (xs.length === 1 ? 0.5 : (d - xmin) / (xmax - xmin)) * (W - mL - mR); }
    function Y(v) { return mT + (1 - (v - ymin) / (ymax - ymin)) * (H - mT - mB); }
    // 网格 + 轴
    for (var g = 0; g <= 4; g++) {
      var gy = mT + g * (H - mT - mB) / 4;
      el('line', { x1: mL, y1: gy, x2: W - mR, y2: gy, class: 'grid-line' }, svg);
      el('text', { x: mL - 6, y: gy + 4, 'text-anchor': 'end', class: 'axis-txt' }, svg)
        .textContent = fmt(ymax - g * (ymax - ymin) / 4, 2);
    }
    el('line', { x1: mL, y1: H - mB, x2: W - mR, y2: H - mB, class: 'axis-line' }, svg);
    el('line', { x1: mL, y1: mT, x2: mL, y2: H - mB, class: 'axis-line' }, svg);
    var path = '';
    pts.forEach(function (d, i) {
      if (!isFinite(d.nll)) return;
      path += (path ? 'L' : 'M') + X(logX ? Math.log(d[xKey]) : d[xKey]) + ' ' + Y(d.nll);
    });
    el('path', { d: path, fill: 'none', stroke: opts.tokens.line, 'stroke-width': 2 }, svg);
    pts.forEach(function (d) {
      if (!isFinite(d.nll)) return;
      var c = el('circle', { cx: X(logX ? Math.log(d[xKey]) : d[xKey]), cy: Y(d.nll), r: 4,
        fill: opts.tokens.line, class: 'cv-dot', tabindex: 0 }, svg);
      c.addEventListener('mouseenter', function () { opts.tooltip(d, c); });
      c.addEventListener('focus', function () { opts.tooltip(d, c); });
    });
    if (opts.best) {
      var bx = X(logX ? Math.log(opts.best[xKey]) : opts.best[xKey]);
      el('line', { x1: bx, y1: mT, x2: bx, y2: H - mB, stroke: opts.tokens.mark, 'stroke-width': 1.5,
        'stroke-dasharray': '5 4', class: 'cv-best-line' }, svg);
      el('text', { x: bx, y: H - mB + 16, 'text-anchor': 'middle', class: 'axis-txt' }, svg)
        .textContent = (opts.bestLabel || '选中') + ' ' + fmt(opts.best[xKey], 3);
    }
    if (opts.altMark) {
      var ax = X(logX ? Math.log(opts.altMark[xKey]) : opts.altMark[xKey]);
      el('line', { x1: ax, y1: mT, x2: ax, y2: H - mB, stroke: opts.tokens.marginal, 'stroke-width': 1.2,
        'stroke-dasharray': '2 3', class: 'cv-alt-line' }, svg);
      el('text', { x: ax, y: mT + 10, 'text-anchor': 'middle', class: 'axis-txt' }, svg)
        .textContent = 'NLL最优 ' + fmt(opts.altMark[xKey], 3);
    }
    el('text', { x: (W + mL) / 2, y: H - 6, 'text-anchor': 'middle', class: 'axis-title' }, svg)
      .textContent = opts.xLabel;
    el('text', { x: 14, y: (mT + H - mB) / 2, 'text-anchor': 'middle',
      transform: 'rotate(-90 14 ' + (mT + H - mB) / 2 + ')', class: 'axis-title' }, svg)
      .textContent = '测试集平均负对数似然';
  }

  /* ---------- 稳定性区间条（bootstrap 分位 + 留批次范围）---------- */
  function stabilityBar(container, opts) {
    var W = 440, H = 118, mL = 56, mR = 14, y0 = 62;
    var lo = -1, hi = 1;
    container.innerHTML = '';
    var svg = el('svg', { viewBox: '0 0 ' + W + ' ' + H, role: 'img', 'aria-label': '稳定性区间' }, container);
    function X(v) { return mL + (v - lo) / (hi - lo) * (W - mL - mR); }
    el('line', { x1: mL, y1: y0, x2: W - mR, y2: y0, class: 'axis-line' }, svg);
    el('line', { x1: X(0), y1: y0 - 14, x2: X(0), y2: y0 + 14, stroke: opts.tokens.zero, 'stroke-width': 1.4 }, svg);
    [-1, -0.5, 0, 0.5, 1].forEach(function (t) {
      el('line', { x1: X(t), y1: y0, x2: X(t), y2: y0 + 5, class: 'axis-line' }, svg);
      el('text', { x: X(t), y: y0 + 18, 'text-anchor': 'middle', class: 'axis-txt' }, svg).textContent = t;
    });
    var s = opts.stats;
    // 留批次范围（须线）
    if (s.jackMin != null) {
      el('line', { x1: X(s.jackMin), y1: y0, x2: X(s.jackMax), y2: y0,
        stroke: opts.tokens.jack, 'stroke-width': 1.5, 'stroke-dasharray': '4 3' }, svg);
      el('line', { x1: X(s.jackMin), y1: y0 - 7, x2: X(s.jackMin), y2: y0 + 7, stroke: opts.tokens.jack, 'stroke-width': 1.5 }, svg);
      el('line', { x1: X(s.jackMax), y1: y0 - 7, x2: X(s.jackMax), y2: y0 + 7, stroke: opts.tokens.jack, 'stroke-width': 1.5 }, svg);
    }
    // bootstrap [10%,90%] 粗条
    el('rect', { x: X(s.q10), y: y0 - 8, width: Math.max(2, X(s.q90) - X(s.q10)), height: 16, rx: 4,
      fill: opts.tokens.boot, 'fill-opacity': 0.55 }, svg);
    el('line', { x1: X(s.median), y1: y0 - 10, x2: X(s.median), y2: y0 + 10,
      stroke: opts.tokens.bootMedian, 'stroke-width': 2.4 }, svg);
    // 当前全量偏相关（菱形）
    el('path', { d: 'M' + X(opts.partial) + ' ' + (y0 - 13) + ' L' + (X(opts.partial) + 6) + ' ' + y0 +
      ' L' + X(opts.partial) + ' ' + (y0 + 13) + ' L' + (X(opts.partial) - 6) + ' ' + y0 + ' Z',
      fill: opts.tokens.mark }, svg);
    // 普通相关（三角）
    el('path', { d: 'M' + X(opts.marginal) + ' ' + (y0 - 30) + ' L' + (X(opts.marginal) + 6) + ' ' + (y0 - 20) +
      ' L' + (X(opts.marginal) - 6) + ' ' + (y0 - 20) + ' Z', fill: opts.tokens.marginal }, svg);
    el('text', { x: X(opts.marginal), y: y0 - 36, 'text-anchor': 'middle', class: 'axis-txt' }, svg)
      .textContent = '普通 r=' + fmt(opts.marginal, 2);
  }

  return { el: el, fmt: fmt, diverging: diverging, heatmap: heatmap, network: network,
    forceLayout: forceLayout, cvCurve: cvCurve, stabilityBar: stabilityBar };
});
