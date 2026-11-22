/* UI 状态与渲染：工况/方案切换 → 整条链路重算 → 所有视图联动刷新。 */
(function () {
  'use strict';
  var dataMod = CS.data, S = CS.stats, A = CS.app, C = CS.charts;
  var DATA = dataMod.generate();

  var state = {
    regime: 'all', method: 'glasso',
    manualParam: null, tau: 0.1, sparsePick: true,
    showZero: false, showGt: true,
    selected: null, theme: 'light'
  };
  var result = null;
  var rng = dataMod.mulberry32(20261122);

  var ROLE_COLORS = {
    load: 'var(--series-blue)', thermal: 'var(--series-orange)',
    energy: 'var(--series-green)', consumable: 'var(--series-violet)',
    equipment: 'var(--series-magenta)', quality: 'var(--series-aqua)',
    auxiliary: 'var(--series-yellow)', ambient: 'var(--series-red)'
  };
  var ROLE_NAMES = {
    load: '负载', thermal: '温度', energy: '能耗', consumable: '耗材',
    equipment: '设备', quality: '质量', auxiliary: '辅助', ambient: '环境'
  };
  var metricByKey = {};
  DATA.metrics.forEach(function (m) { metricByKey[m.key] = m; });
  function nameOf(key) { return metricByKey[key] ? metricByKey[key].name : key; }
  function roleOf(key) { return metricByKey[key] ? metricByKey[key].role : 'auxiliary'; }
  function tokens() {
    var cs = getComputedStyle(document.documentElement);
    function v(name) { return cs.getPropertyValue(name).trim(); }
    return {
      neg: v('--neg'), pos: v('--pos'), mid: v('--mid'), seq: v('--seq'),
      line: v('--series-blue'), mark: v('--series-red'), jack: v('--text-muted'),
      boot: v('--series-blue'), bootMedian: v('--series-violet'),
      marginal: v('--series-orange'), zero: v('--axis'), nodeStroke: v('--surface-1')
    };
  }

  /* ---------- tooltip ---------- */
  var tip = document.getElementById('tooltip');
  function showTip(html, ev) {
    tip.innerHTML = html; tip.style.display = 'block'; moveTip(ev);
  }
  function moveTip(ev) {
    if (!ev) return;
    var x = ev.clientX + 14, y = ev.clientY + 14;
    if (x + 290 > window.innerWidth) x = ev.clientX - 296;
    tip.style.left = x + 'px'; tip.style.top = y + 'px';
  }
  function hideTip() { tip.style.display = 'none'; }
  document.addEventListener('mousemove', moveTip);

  /* ---------- 控件 ---------- */
  function buildControls() {
    var seg = document.getElementById('regimeSeg');
    DATA.regimes.forEach(function (r) {
      var b = document.createElement('button');
      b.type = 'button'; b.textContent = r.name; b.dataset.regime = r.id;
      if (r.id === state.regime) b.classList.add('on');
      b.addEventListener('click', function () {
        if (state.regime === r.id) return;
        state.regime = r.id; state.manualParam = null; state.selected = null;
        seg.querySelectorAll('button').forEach(function (x) { x.classList.toggle('on', x.dataset.regime === r.id); });
        runPipeline(true);
      });
      seg.appendChild(b);
    });

    var methods = [
      { id: 'glasso', label: '稀疏精度矩阵（graphical lasso）' },
      { id: 'lw', label: 'Ledoit–Wolf 收缩' },
      { id: 'oas', label: 'OAS 收缩' },
      { id: 'shrink-manual', label: '手动收缩 α' }
    ];
    var box = document.getElementById('methodCards');
    methods.forEach(function (m) {
      var lab = document.createElement('label');
      lab.innerHTML = '<input type="radio" name="method" value="' + m.id + '"> ' + m.label;
      if (m.id === state.method) { lab.classList.add('on'); lab.querySelector('input').checked = true; }
      lab.querySelector('input').addEventListener('change', function () {
        state.method = m.id; state.manualParam = null; state.selected = null;
        box.querySelectorAll('label').forEach(function (x) { x.classList.toggle('on', x.querySelector('input').checked); });
        runPipeline(true);
      });
      box.appendChild(lab);
    });

    document.getElementById('paramSlider').addEventListener('input', function (ev) {
      state.manualParam = sliderToParam(+ev.target.value);
      runPipeline(false);
    });
    document.getElementById('tauSlider').addEventListener('input', function (ev) {
      state.tau = +ev.target.value / 100;
      document.getElementById('tauValue').textContent = state.tau.toFixed(2);
      runPipeline(false);
    });
    document.getElementById('resetCv').addEventListener('click', function () {
      state.manualParam = null; runPipeline(false);
    });
    document.getElementById('sparsePick').addEventListener('change', function (ev) {
      state.sparsePick = ev.target.checked; state.manualParam = null; runPipeline(false);
    });
    document.getElementById('showZero').addEventListener('change', function (ev) {
      state.showZero = ev.target.checked; renderNetwork();
    });
    document.getElementById('showGt').addEventListener('change', function (ev) {
      state.showGt = ev.target.checked; renderNetwork();
    });
    document.getElementById('themeBtn').addEventListener('click', function () {
      state.theme = state.theme === 'light' ? 'dark' : 'light';
      document.documentElement.dataset.theme = state.theme;
      document.getElementById('themeBtn').textContent = state.theme === 'light' ? '切换暗色' : '切换亮色';
      renderAll();
    });
    document.querySelectorAll('.tab-btns button').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var which = btn.dataset.hm, view = btn.dataset.view;
        btn.parentElement.querySelectorAll('button').forEach(function (b) { b.classList.toggle('on', b === btn); });
        var heat = document.getElementById(which === 'marg' ? 'margHeat' : 'partHeat');
        var tbl = document.getElementById(which === 'marg' ? 'margTable' : 'partTable');
        heat.style.display = view === 'heat' ? 'block' : 'none';
        tbl.style.display = view === 'table' ? 'block' : 'none';
      });
    });
  }

  function paramToSlider(p) {
    if (state.method === 'glasso') {
      var t = (Math.log(p) - Math.log(0.003)) / (Math.log(0.5) - Math.log(0.003));
      return Math.round(Math.max(0, Math.min(1, t)) * 100);
    }
    return Math.round(p * 100);
  }
  function sliderToParam(v) {
    if (state.method === 'glasso') {
      var t = v / 100;
      return Math.exp(Math.log(0.003) + t * (Math.log(0.5) - Math.log(0.003)));
    }
    return v / 100;
  }

  /* ---------- 主流程 ---------- */
  function currentRows() {
    if (state.regime === 'all') return DATA.rows;
    return DATA.rows.filter(function (r) { return r.regime === state.regime; });
  }

  function runPipeline(full) {
    var overlay = document.getElementById('overlay');
    overlay.classList.add('show');
    setTimeout(function () {
      try {
        var opts = { method: state.method, edgeTau: state.tau, bootB: 40, rng: rng,
          sparsePick: state.sparsePick };
        if (state.manualParam != null) opts.manualParam = state.manualParam;
        result = A.analyze(currentRows(), DATA.metrics, opts);
        syncControls();
        renderAll(full);
      } catch (e) {
        console.error(e);
        overlay.innerHTML = '链路出错：' + e.message;
        return;
      }
      overlay.classList.remove('show');
      overlay.textContent = '工况/方案切换中，正在重算整条链路…';
    }, 30);
  }

  function syncControls() {
    var isGlasso = state.method === 'glasso';
    document.getElementById('paramLabel').textContent = isGlasso ? '正则力度 λ' : '收缩强度 α';
    document.getElementById('paramValue').textContent = C.fmt(result.param, 4);
    document.getElementById('paramSlider').value = paramToSlider(result.param);
    document.getElementById('tauWrap').style.opacity = isGlasso ? 0.45 : 1;
    document.getElementById('tauSlider').disabled = isGlasso;
    document.getElementById('sparsePickWrap').style.display = isGlasso ? 'block' : 'none';
  }

  /* ---------- ① 数据质量 ---------- */
  function renderDataQuality() {
    var pre = result.pre, totalRows = currentRows().length;
    var tiles = [
      { k: '当前工况班次总数', v: totalRows, hint: DATA.regimes.find(function (r) { return r.id === state.regime; }).name },
      { k: '完整记录 n（所有指标共用）', v: pre.n, hint: '排除 ' + pre.excluded.length + ' 个班次' },
      { k: '保留指标 p', v: pre.p, hint: '原始 ' + DATA.metrics.length + ' 个，剔除 ' +
          (pre.droppedConstants.length + pre.droppedDuplicates.length) + ' 个' },
      { k: 'n / p 比例', v: (pre.n / pre.p).toFixed(2),
        hint: pre.nLessThanP ? 'n<p：MLE 不可用，必须正则' : (pre.lowRatio ? '低于 3，MLE 病态，正则仍必要' : '相对充足'),
        badge: pre.nLessThanP ? 'bad' : (pre.lowRatio ? 'warn' : 'ok') },
      { k: 'MLE 相关阵最小特征值', v: C.fmt(result.eigMLE.min, 4),
        hint: result.eigMLE.mleInvertible ? '可求逆但仍可能病态' : '接近 0 → 精度矩阵不存在',
        badge: result.eigMLE.mleInvertible ? 'warn' : 'bad' }
    ];
    document.getElementById('dqTiles').innerHTML = tiles.map(function (t) {
      return '<div class="tile"><div class="k">' + t.k + '</div><div class="v">' + t.v + '</div>' +
        (t.badge ? '<span class="badge ' + t.badge + '">' + t.hint + '</span>' : '<div class="hint">' + t.hint + '</div>') + '</div>';
    }).join('');

    var tb = document.querySelector('#excludedTable tbody');
    tb.innerHTML = result.pre.excluded.map(function (e) {
      return '<tr><td>' + e.shift_id + '</td><td>' + e.batch + '</td><td>' + e.date + '</td><td>' + e.reasons.join('；') + '</tr>';
    }).join('') || '<tr><td colspan="4" class="small">当前工况下无班次被排除。</td></tr>';

    var drop = [];
    pre.droppedConstants.forEach(function (d) {
      drop.push('<div style="margin-bottom:6px"><span class="badge warn">恒定列</span> <b>' + nameOf(d.key) + '</b>' +
        '（' + d.key + '）在 ' + pre.n + ' 条完整记录上恒为 <span class="mono">' + d.value + '</span>，方差为 0、相关无定义，估计前剔除。</div>');
    });
    pre.droppedDuplicates.forEach(function (d) {
      drop.push('<div style="margin-bottom:6px"><span class="badge bad">重复/仿射列</span> <b>' + nameOf(d.key) + '</b>' +
        '（' + d.key + '）与 <b>' + nameOf(d.equals) + '</b> ' + d.relation +
        '，同时保留会令协方差奇异，保留前者、剔除后者。</div>');
    });
    document.getElementById('dropInfo').innerHTML = drop.join('') || '<div class="small">无恒定或重复列。</div>';

    var pw = result.pairwise;
    document.getElementById('pairwiseBox').innerHTML =
      '<div class="kv">' +
      '<span class="k">逐对样本数范围</span><span class="mono">' +
        Math.min.apply(null, pw.sampleCounts.flat()) + ' – ' + Math.max.apply(null, pw.sampleCounts.flat()) +
        '（不同边来自不同样本子集）</span>' +
      '<span class="k">矩阵最小特征值</span><span class="mono ' + (pw.psd ? '' : 'null-pill') + '">' + C.fmt(pw.minEigen, 5) +
        (pw.psd ? '' : '（负值 → 非正定）') + '</span>' +
      '<span class="k">条件数</span><span class="mono">' + C.fmt(pw.condition, 1) + '</span>' +
      '<span class="k">合法性结论</span><span>' + (pw.psd
        ? '本例恰好半正定，但样本数不一致本身已使它不是任何一组数据的协方差，仍不可用于求逆。'
        : '矩阵非正定，无法作为协方差/精度矩阵使用——逐对删缺失拼接不合法。') + '</span></div>' +
      '<div class="callout warn">本应用坚持 listwise：先整行排除不完整班次，再在同一批 n 条记录上计算<b>同一个</b>矩阵。</div>';
  }

  /* ---------- ② 估计 ---------- */
  function renderEstimation() {
    var methodName = { glasso: 'graphical lasso 稀疏精度矩阵', lw: 'Ledoit–Wolf 收缩',
      oas: 'OAS 收缩', 'shrink-manual': '手动强度收缩' }[state.method];
    document.getElementById('mleBox').innerHTML =
      '<div class="kv">' +
      '<span class="k">MLE 最小特征值</span><span class="mono">' + C.fmt(result.eigMLE.min, 5) + '</span>' +
      '<span class="k">MLE 最大特征值</span><span class="mono">' + C.fmt(result.eigMLE.max, 3) + '</span>' +
      '<span class="k">MLE 精度矩阵</span><span>' + (result.eigMLE.mleInvertible
        ? '可求逆（但 n/p=' + (result.pre.n / result.pre.p).toFixed(2) + '，估计噪声大）'
        : '<span class="null-pill">不存在（奇异，求逆返回 null）</span>') + '</span></div>';

    var cv = result.cv;
    var edgeCount = result.edges.filter(function (e) { return e.isEdge; }).length;
    var zeroCount = result.edges.length - edgeCount;
    document.getElementById('fitBox').innerHTML =
      '<div class="kv">' +
      '<span class="k">方案</span><span>' + methodName + '</span>' +
      '<span class="k">当前正则力度</span><span class="mono">' + C.fmt(result.param, 4) +
        '（' + result.paramSource + '）</span>' +
      (state.method === 'glasso' ? '<span class="k">CV 最优 / 1-SE</span><span class="mono">λ*=' +
        C.fmt(cv.best.lambda, 4) + '（' + cv.best.nll.toFixed(3) + '）　λ_1SE=' +
        C.fmt(cv.best1SE.lambda, 4) + '（SE=' + C.fmt(cv.se, 4) + '）</span>' : '') +
      '<span class="k">LW 参考 α</span><span class="mono">' + C.fmt(result.lw.shrink, 4) + '</span>' +
      '<span class="k">OAS 参考 α</span><span class="mono">' + C.fmt(result.oas.shrink, 4) + '</span>' +
      '<span class="k">求解</span><span>' + result.fitNote + '</span>' +
      '<span class="k">成边 / 总指标对</span><span class="mono">' + edgeCount + ' / ' + result.edges.length +
        (state.method === 'glasso' ? '（精确零元素 ' + zeroCount + ' 个）' : '（阈值 |偏相关|>' + state.tau.toFixed(2) + '）') + '</span>' +
      '<span class="k">用时</span><span class="mono">' + result.ms + ' ms（含 ' + result.stability.B + ' 次 bootstrap）</span></div>';

    var isGlasso = state.method === 'glasso';
    C.cvCurve(document.getElementById('cvChart'), {
      points: cv.results,
      xKey: isGlasso ? 'lambda' : 'alpha',
      logX: isGlasso,
      xLabel: isGlasso ? 'λ（对数刻度）' : '收缩强度 α',
      best: isGlasso ? { lambda: result.param } : cv.best,
      bestLabel: isGlasso ? '当前 λ' : '选中',
      altMark: isGlasso ? cv.best : null,
      tokens: tokens(),
      tooltip: function (d, node) {
        var ev = { clientX: node.getBoundingClientRect().left, clientY: node.getBoundingClientRect().top };
        showTip('<div class="tt-title">' + (isGlasso ? 'λ' : 'α') + ' = ' + C.fmt(isGlasso ? d.lambda : d.alpha, 4) + '</div>' +
          '<div class="tt-row">测试 NLL = ' + (isFinite(d.nll) ? C.fmt(d.nll, 4) : '不可用') + '</div>', ev);
      }
    });
    document.getElementById('cvNote').textContent =
      '方案：' + result.cvScheme + '，共 ' + cv.folds + ' 折；每折训练集独立预处理/拟合，在留出的整批生产班次上评估。' +
      (result.pre.nLessThanP ? ' 当前 n<p，折内训练集更小，CV 结果仅供教学参考。' : '');
  }

  /* ---------- ③ 热力图 ---------- */
  function heatTip(labA, labB, v, rect) {
    var ev = { clientX: rect.getBoundingClientRect().left, clientY: rect.getBoundingClientRect().top };
    showTip('<div class="tt-title">' + labA + ' × ' + labB + '</div><div class="tt-row">值 = ' + C.fmt(v, 4) + '</div>', ev);
  }
  function renderHeatmaps() {
    var labels = result.pre.keys.map(nameOf);
    var common = { labels: labels, tokens: tokens(), cell: 44, labelW: 92,
      tooltip: heatTip, onCell: function (i, j) { selectEdgeByIndex(i, j); } };
    C.heatmap(document.getElementById('margHeat'), Object.assign({}, common, { matrix: result.R, title: '普通相关矩阵' }));
    C.heatmap(document.getElementById('partHeat'), Object.assign({}, common, { matrix: result.partial, title: '偏相关矩阵' }));
    document.getElementById('margTable').innerHTML = matrixTable(result.R, labels);
    document.getElementById('partTable').innerHTML = matrixTable(result.partial, labels);
  }
  function matrixTable(M, labels) {
    var html = '<table><thead><tr><th></th>' + labels.map(function (l) { return '<th class="num">' + l + '</th>'; }).join('') + '</tr></thead><tbody>';
    M.forEach(function (row, i) {
      html += '<tr><th>' + labels[i] + '</th>' + row.map(function (v) {
        return '<td class="num">' + C.fmt(v, 3) + '</td>';
      }).join('') + '</tr>';
    });
    return html + '</tbody></table>';
  }

  /* ---------- ④ 网络 ---------- */
  function renderNetwork() {
    var visible = state.showZero ? result.edges : result.edges.filter(function (e) { return e.isEdge; });
    C.network(document.getElementById('netChart'), {
      keys: result.pre.keys,
      names: result.nameMap,
      edges: visible,
      tokens: tokens(),
      roleOf: roleOf,
      roleColor: function (r) { return ROLE_COLORS[r] || 'var(--text-muted)'; },
      onEdge: function (e) { selectEdge(e); },
      onEdgeHover: function (e, line) {
        var r = line.getBoundingClientRect();
        showTip('<div class="tt-title">' + nameOf(e.keyA) + ' × ' + nameOf(e.keyB) + '</div>' +
          '<div class="tt-row">普通 r=' + C.fmt(e.r, 3) + '　偏相关=' + C.fmt(e.partial, 3) + '</div>' +
          '<div class="tt-row">' + (e.isEdge ? '成边' : '非边（条件独立/未过阈值）') + '</div>',
          { clientX: r.left, clientY: r.top });
      },
      onNode: function (i) { selectNodeEdges(i); }
    });
    var usedRoles = {};
    result.pre.keys.forEach(function (k) { usedRoles[roleOf(k)] = true; });
    document.getElementById('netLegend').innerHTML = Object.keys(ROLE_NAMES).filter(function (r) { return usedRoles[r]; })
      .map(function (r) {
        return '<span class="item"><span class="swatch" style="background:' + ROLE_COLORS[r] + '"></span>' + ROLE_NAMES[r] + '类指标</span>';
      }).join('') +
      '<span class="item"><svg width="26" height="8"><line x1="0" y1="4" x2="26" y2="4" stroke="var(--series-red)" stroke-width="3"/></svg>正条件关联</span>' +
      '<span class="item"><svg width="26" height="8"><line x1="0" y1="4" x2="26" y2="4" stroke="var(--series-blue)" stroke-width="3"/></svg>负条件关联</span>' +
      (state.showGt ? '<span class="item"><svg width="26" height="12"><line x1="0" y1="6" x2="26" y2="6" stroke="var(--text-muted)" stroke-width="2"/></svg>真实生成模型直接边（教学对照，非因果判定依据）</span>' : '');
    if (state.selected) renderEdgeDetail();
  }

  function findEdge(i, j) {
    return result.edges.find(function (e) {
      return (e.i === i && e.j === j) || (e.i === j && e.j === i);
    });
  }
  function selectEdgeByIndex(i, j) {
    var e = findEdge(i, j);
    if (e) selectEdge(e);
  }
  function selectNodeEdges(i) {
    // 节点点击：选中与该节点相连的最强边
    var cand = result.edges.filter(function (e) { return e.i === i || e.j === i; })
      .sort(function (a, b) { return Math.abs(b.partial) - Math.abs(a.partial); })[0];
    if (cand) selectEdge(cand);
  }
  function selectEdge(e) {
    state.selected = e.i + '-' + e.j;
    renderEdgeDetail();
    highlightEdgeRows();
  }

  function renderEdgeDetail() {
    var parts = state.selected.split('-').map(Number);
    var e = findEdge(parts[0], parts[1]);
    if (!e) return;
    var st = result.stability.summary[e.i][e.j];
    var controls = result.pre.keys.filter(function (_, k) { return k !== e.i && k !== e.j; })
      .map(nameOf);
    var delta = e.partial - e.r;
    var decay = e.r !== 0 ? Math.round((1 - Math.abs(e.partial) / Math.abs(e.r)) * 100) : null;
    var verdict = Math.abs(e.r) > 0.4 && Math.abs(e.partial) < 0.12
      ? '典型“都跟负载走”：边际相关强，控制其余变量后几乎消失。'
      : (Math.abs(e.partial) >= 0.12 ? '控制其余指标后仍有不可忽略的额外线性联系（≠因果证据）。'
        : '控制后联系很弱，更接近条件独立。');
    var stabBadge = st.bootProb >= 0.8 ? ['ok', '稳定'] : st.bootProb >= 0.5 ? ['warn', '中等'] : ['bad', '不稳定'];
    var edgeStatus;
    if (e.isEdge) {
      edgeStatus = '成边';
    } else {
      edgeStatus = '非边（' + (state.method === 'glasso' ? '精度矩阵元素被精确置零' : '低于阈值 ' + state.tau.toFixed(2)) + '）';
    }
    var gtText = e.groundTruth
      ? '该边在虚构数据的生成方程里确有直接项（真实分析中无法知道这件事）'
      : '生成方程中无直接项，若成边多为共同驱动造成的边际信号';

    document.getElementById('edgeEmpty').style.display = 'none';
    var d = document.getElementById('edgeDetail');
    d.style.display = 'block';
    d.innerHTML =
      '<div style="font-weight:650;font-size:14px;margin-bottom:8px">' + nameOf(e.keyA) + ' × ' + nameOf(e.keyB) + '</div>' +
      '<div class="kv">' +
      '<span class="k">控制的变量（' + controls.length + ' 个）</span><span class="ctrl-chips">' +
        controls.map(function (c) { return '<span class="chip">' + c + '</span>'; }).join('') + '</span>' +
      '<span class="k">普通相关 r</span><span class="mono">' + C.fmt(e.r, 4) + '</span>' +
      '<span class="k">条件关联（偏相关）</span><span class="mono"><b>' + C.fmt(e.partial, 4) + '</b></span>' +
      '<span class="k">差值（偏 − 普通）</span><span class="mono ' + (Math.abs(delta) > 0.2 ? 'null-pill' : '') + '">' + C.fmt(delta, 4) + '</span>' +
      '<span class="k">强度衰减</span><span>' + (decay == null ? '—' : decay + '%（控制后相对普通相关）') + '</span>' +
      '<span class="k">当前方案下</span><span>' + edgeStatus + '</span>' +
      '<span class="k">换样本稳定性</span><span><span class="badge ' + stabBadge[0] + '">' + stabBadge[1] + '</span> ' +
        'bootstrap 出现率 ' + C.fmt(st.bootProb, 2) + '，符号一致率 ' + (st.signAgree == null ? '—' : C.fmt(st.signAgree, 2)) + '</span>' +
      '<span class="k">留批次区间</span><span class="mono">[' + C.fmt(st.jackMin, 3) + ', ' + C.fmt(st.jackMax, 3) +
        ']（' + st.jackBatches + ' 个批次逐一留出）</span>' +
      '<span class="k">生成模型对照</span><span>' + gtText + '</span></div>' +
      '<div class="svg-box" id="stabBar" style="margin-top:10px"></div>' +
      '<div class="small" style="margin-top:2px">粗条：bootstrap 10–90% 分位，须线：留批次范围，菱形：全量偏相关，三角：普通相关。</div>' +
      '<div class="callout">' + verdict + '</div>';
    C.stabilityBar(document.getElementById('stabBar'), {
      stats: st, partial: e.partial, marginal: e.r, tokens: tokens()
    });
  }

  /* ---------- ⑤ 边表 ---------- */
  function renderEdgeTable() {
    var tb = document.querySelector('#edgeTable tbody');
    tb.innerHTML = result.edges.map(function (e) {
      var st = result.stability.summary[e.i][e.j];
      var decay = e.r !== 0 ? Math.round((1 - Math.abs(e.partial) / Math.abs(e.r)) * 100) + '%' : '—';
      var bpClass = st.bootProb >= 0.8 ? '' : (st.bootProb >= 0.5 ? ' class="dim"' : ' class="null-pill"');
      return '<tr class="clickable" data-edge="' + e.i + '-' + e.j + '">' +
        '<td>' + nameOf(e.keyA) + '</td><td>' + nameOf(e.keyB) + '</td>' +
        '<td class="num">' + C.fmt(e.r, 3) + '</td>' +
        '<td class="num"><b>' + C.fmt(e.partial, 3) + '</b></td>' +
        '<td class="num">' + C.fmt(e.partial - e.r, 3) + '</td>' +
        '<td class="num">' + decay + '</td>' +
        '<td>' + (e.isEdge ? '<span class="badge ok">是</span>' : '<span class="badge info">否</span>') + '</td>' +
        '<td class="num"' + bpClass + '>' + C.fmt(st.bootProb, 2) + '</td>' +
        '<td class="num">' + (st.signAgree == null ? '—' : C.fmt(st.signAgree, 2)) + '</td>' +
        '<td>' + (e.groundTruth ? '✓' : '—') + '</td></tr>';
    }).join('');
    tb.querySelectorAll('tr').forEach(function (tr) {
      tr.addEventListener('click', function () {
        var p = tr.dataset.edge.split('-').map(Number);
        selectEdgeByIndex(p[0], p[1]);
      });
    });
    highlightEdgeRows();
  }
  function highlightEdgeRows() {
    document.querySelectorAll('#edgeTable tbody tr').forEach(function (tr) {
      tr.classList.toggle('selected', tr.dataset.edge === state.selected);
    });
  }

  /* ---------- ⑥ 反例联动教学 ---------- */
  function renderTeaching() {
    var idx = {};
    result.pre.keys.forEach(function (k, i) { idx[k] = i; });
    function edgeOf(a, b) {
      if (idx[a] == null || idx[b] == null) return null;
      return findEdge(idx[a], idx[b]);
    }
    var cases = [
      { a: 'material_kg', b: 'gas_flow_m3',
        text: '原料用量 与 燃气流量：二者都由负载驱动，生成方程中互不相连。' },
      { a: 'material_kg', b: 'energy_kwh',
        text: '原料用量 与 能耗：共享负载与燃气路径，无直接生成项。' },
      { a: 'furnace_temp_c', b: 'gas_flow_m3',
        text: '主炉温度 与 燃气流量：同为负载的下游，彼此没有箭头。' },
      { a: 'load_pct', b: 'exhaust_temp_c',
        text: '对照组——负载 与 排气温度：生成方程里在炉温之外还有直接项，控制后应仍保留。' }
    ];
    var html = '<p class="small" style="margin-top:0">下表把“数据质量（共同样本）→ 估计（正则后的精度矩阵）→ 边诊断（稳定性）”串在同一批指标对上：' +
      '前三个反例应呈现普通相关高、条件关联塌缩；对照组应保留显著偏相关。</p>';
    html += '<div class="table-scroll"><table><thead><tr><th>指标对</th><th class="num">普通 r</th><th class="num">偏相关</th>' +
      '<th class="num">衰减</th><th class="num">bootstrap 出现率</th><th>成边</th><th>生成模型直接项</th><th>解读</th></tr></thead><tbody>';
    cases.forEach(function (c) {
      var e = edgeOf(c.a, c.b);
      if (!e) { html += '<tr><td>' + nameOf(c.a) + ' × ' + nameOf(c.b) + '</td><td colspan="7" class="small">当前工况下指标被剔除，无此指标对。</td></tr>'; return; }
      var st = result.stability.summary[e.i][e.j];
      var decay = e.r !== 0 ? Math.round((1 - Math.abs(e.partial) / Math.abs(e.r)) * 100) + '%' : '—';
      html += '<tr class="clickable" data-edge="' + e.i + '-' + e.j + '">' +
        '<td>' + nameOf(c.a) + ' × ' + nameOf(c.b) + '</td>' +
        '<td class="num">' + C.fmt(e.r, 3) + '</td><td class="num"><b>' + C.fmt(e.partial, 3) + '</b></td>' +
        '<td class="num">' + decay + '</td><td class="num">' + C.fmt(st.bootProb, 2) + '</td>' +
        '<td>' + (e.isEdge ? '✓' : '×') + '</td><td>' + (e.groundTruth ? '✓ 有' : '无（共同驱动）') + '</td>' +
        '<td style="white-space:normal">' + c.text + '</td></tr>';
    });
    html += '</tbody></table></div>';
    var pw = result.pairwise;
    html += '<div class="callout ' + (pw.psd ? '' : 'warn') + '">数据质量联动：同样这批班次若逐对删缺失，拼出的矩阵最小特征值为 <span class="mono">' +
      C.fmt(pw.minEigen, 4) + '</span>' + (pw.psd ? '（半正定但样本数不一致）。' : '，已经非正定——后续估计和边诊断都无从谈起。') +
      ' 切换上方工况/方案，本表格与所有诊断会基于新的完整记录重新计算。</div>';
    document.getElementById('teaching').innerHTML = html;
    document.querySelectorAll('#teaching tr[data-edge]').forEach(function (tr) {
      tr.addEventListener('click', function () {
        var p = tr.dataset.edge.split('-').map(Number);
        selectEdgeByIndex(p[0], p[1]);
        document.getElementById('edgePanel').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      });
    });
  }

  /* ---------- 原始数据表 ---------- */
  function renderRaw() {
    var keys = DATA.metrics.map(function (m) { return m.key; });
    var html = '<table><thead><tr><th>班次</th><th>批次</th><th>工况</th><th>日期</th>' +
      keys.map(function (k) { return '<th class="num">' + nameOf(k) + '</th>'; }).join('') + '</tr></thead><tbody>';
    DATA.rows.forEach(function (r) {
      html += '<tr><td>' + r.shift_id + '</td><td>' + r.batch + '</td><td>' + r.regime + '</td><td>' + r.date + '</td>' +
        keys.map(function (k) {
          var v = r[k];
          return '<td class="num">' + (v === null ? '<span class="null-pill">缺失</span>' : v) + '</td>';
        }).join('') + '</tr>';
    });
    document.getElementById('rawTable').innerHTML = html + '</tbody></table>';
  }

  function renderAll() {
    if (!result) return;
    hideTip();
    renderDataQuality();
    renderEstimation();
    renderHeatmaps();
    renderNetwork();
    renderEdgeTable();
    renderTeaching();
    if (state.selected) {
      var parts = state.selected.split('-').map(Number);
      if (!findEdge(parts[0], parts[1])) {
        state.selected = null;
        document.getElementById('edgeEmpty').style.display = 'block';
        document.getElementById('edgeDetail').style.display = 'none';
      }
    }
  }

  buildControls();
  renderRaw();
  runPipeline(true);
})();
