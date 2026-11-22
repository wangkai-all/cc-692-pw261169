/* 班次级虚构生产数据生成器（纯本地、确定性随机）。
 * 结构上是一个共同原因（负载）驱动的网络，另含少量直接边，
 * 用于演示“普通相关”与“条件关联（偏相关/精度矩阵）”的差别。 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.CS = root.CS || {}, root.CS.data = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  // Box–Muller 标准正态
  function gaussian(rng) {
    let u = 0, v = 0;
    while (u === 0) u = rng();
    while (v === 0) v = rng();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }
  function clamp(x, lo, hi) { return Math.min(hi, Math.max(lo, x)); }
  function r2(x) { return Math.round(x * 100) / 100; }

  // 指标元数据。unit 为展示单位；role 用于网络图分类着色。
  var METRICS = [
    { key: 'load_pct',        name: '负载率',       unit: '%',    role: 'load', desc: '班次平均生产负载（共同驱动源）' },
    { key: 'furnace_temp_c',  name: '主炉温度',     unit: '℃',    role: 'thermal', desc: '主加热炉炉温' },
    { key: 'exhaust_temp_c',  name: '排气温度',     unit: '℃',    role: 'thermal', desc: '排烟温度，受炉温与负载共同影响' },
    { key: 'motor_current_a', name: '电机电流',     unit: 'A',    role: 'electrical', desc: '主电机电流（由负载率复制而来，演示完全重复列）' },
    { key: 'energy_kwh',      name: '能耗',         unit: 'kWh',  role: 'energy', desc: '班次总能耗' },
    { key: 'gas_flow_m3',     name: '燃气流量',     unit: 'm³',   role: 'consumable', desc: '班次燃气消耗量（耗材）' },
    { key: 'material_kg',     name: '原料用量',     unit: 'kg',   role: 'consumable', desc: '班次投入原料重量（耗材）' },
    { key: 'cooling_bar',     name: '冷却压力',     unit: 'bar',  role: 'auxiliary', desc: '冷却水回路压力' },
    { key: 'vibration_mms',   name: '振动',         unit: 'mm/s', role: 'equipment', desc: '主轴承振动速度' },
    { key: 'defect_rate',     name: '缺陷率',       unit: '%',    role: 'quality', desc: '班次产品缺陷率' },
    { key: 'ambient_temp_c',  name: '环境温度',     unit: '℃',    role: 'ambient', desc: '车间环境温度（在“调试批次”工况下恒定）' },
    { key: 'target_qty',      name: '计划产量',     unit: '件',   role: 'constant', desc: '计划产量目标（整表恒定列）' }
  ];

  var REGIMES = [
    { id: 'all',     name: '全部工况' },
    { id: 'std',     name: '标准生产（B01–B08）' },
    { id: 'high',    name: '高负载工况（B09–B11）' },
    { id: 'debug',   name: '调试批次（B12，n<p）' }
  ];

  // 12 个批次：批次是留出交叉验证的分组单位。
  var BATCHES = [
    { id: 'B01', regime: 'std', shifts: 8 },
    { id: 'B02', regime: 'std', shifts: 8 },
    { id: 'B03', regime: 'std', shifts: 8 },
    { id: 'B04', regime: 'std', shifts: 8 },
    { id: 'B05', regime: 'std', shifts: 8 },
    { id: 'B06', regime: 'std', shifts: 7 },
    { id: 'B07', regime: 'std', shifts: 8 },
    { id: 'B08', regime: 'std', shifts: 8 },
    { id: 'B09', regime: 'high', shifts: 8 },
    { id: 'B10', regime: 'high', shifts: 8 },
    { id: 'B11', regime: 'high', shifts: 8 },
    { id: 'B12', regime: 'debug', shifts: 3 }
  ];

  function regimeOf(batchId) {
    for (var i = 0; i < BATCHES.length; i++) if (BATCHES[i].id === batchId) return BATCHES[i].regime;
    return 'std';
  }

  var EPOCH = Date.UTC(2026, 7, 3); // 2026-08-03
  function dateStr(idx) {
    var d = new Date(EPOCH + idx * 86400000);
    return d.toISOString().slice(0, 10);
  }

  function generate(seed) {
    var rng = mulberry32(seed || 20261122);
    var missRng = mulberry32((seed || 20261122) + 991);
    var rows = [];
    var shiftIdx = 0;
    BATCHES.forEach(function (b) {
      for (var s = 0; s < b.shifts; s++) {
        shiftIdx++;
        var isHigh = b.regime === 'high', isDebug = b.regime === 'debug';
        var meanLoad = isHigh ? 82 : (isDebug ? 55 : 62);
        var sdLoad = isHigh ? 6 : 11;
        var L = clamp(meanLoad + sdLoad * gaussian(rng), 4, 99);

        // —— 主炉温度：直接依赖负载，另含独立扰动 ——
        var furnace = 520 + 2.6 * L + 9 * gaussian(rng);
        // —— 排气温度：同时依赖负载与炉温（在炉温之外仍有负载直接边）——
        var exhaust = 180 + 0.35 * furnace + 0.7 * L + 7 * gaussian(rng);
        // —— 电机电流：负载率的仿射复制 + 极小噪声后四舍五入，构造“完全相同列” ——
        var current = r2(4 + 1.15 * L + 0.02 * gaussian(rng));
        // —— 能耗：负载 + 燃气 + 振动的直接组合 ——
        var gas = 40 + 1.9 * L + 14 * gaussian(rng);
        var vibration = clamp(1.2 + 0.028 * L + 0.55 * gaussian(rng), 0.2, 9);
        var energy = 120 + 5.2 * L + 3.1 * gas + 26 * vibration + 30 * gaussian(rng);
        // —— 原料：基本跟随负载，独立噪声较大 ——
        var material = 300 + 7.5 * L + 35 * gaussian(rng);
        // —— 冷却压力：与负载弱直接联系，主要靠独立调节 ——
        var cooling = 3.4 + 0.006 * L + 0.22 * gaussian(rng);
        // —— 缺陷率：负载 + 振动的直接影响 ——
        var defect = clamp(0.4 + 0.018 * L + 0.22 * vibration + 0.35 * gaussian(rng), 0.05, 8);
        // —— 环境温度：标准/高负载下缓慢漂移；调试批次恒定（演示恒定列）——
        var ambient = isDebug ? 24.5 : 22 + 4 * Math.sin(shiftIdx / 9) + 0.8 * gaussian(rng);

        var row = {
          shift_id: b.id + '-S' + String(s + 1).padStart(2, '0'),
          batch: b.id,
          regime: b.regime,
          date: dateStr(shiftIdx - 1),
          load_pct: r2(L),
          furnace_temp_c: r2(furnace),
          exhaust_temp_c: r2(exhaust),
          motor_current_a: current,
          energy_kwh: r2(energy),
          gas_flow_m3: r2(gas),
          material_kg: r2(material),
          cooling_bar: r2(cooling),
          vibration_mms: r2(vibration),
          defect_rate: r2(defect),
          ambient_temp_c: isDebug ? 24.5 : r2(ambient),
          target_qty: 1000
        };
        rows.push(row);
      }
    });

    // —— 注入缺失（MCAR，约 3.5% 的指标单元）——
    // B12（调试批次）保持完整，以便该工况下 n=3 且有恒定列可演示。
    var missCount = 0;
    rows.forEach(function (row, ri) {
      if (row.batch === 'B12') return;
      METRICS.forEach(function (m) {
        if (m.key === 'target_qty') return; // 恒定列不制造缺失
        if (missRng() < 0.035) { row[m.key] = null; missCount++; }
      });
    });
    // 再人为让 3 个班次在多列上缺失，展示“整行被排除”的原因
    ['B03-S03', 'B07-S05', 'B10-S02'].forEach(function (sid) {
      var row = rows.find(function (r) { return r.shift_id === sid; });
      if (!row) return;
      ['furnace_temp_c', 'exhaust_temp_c', 'energy_kwh'].forEach(function (k) {
        if (row[k] !== null) { row[k] = null; missCount++; }
      });
    });

    return {
      rows: rows,
      metrics: METRICS,
      regimes: REGIMES,
      batches: BATCHES,
      missingCells: missCount,
      generator: { rng: 'mulberry32 + Box-Muller', seed: seed || 20261122, missingRate: 0.035 }
    };
  }

  return {
    generate: generate,
    mulberry32: mulberry32,
    gaussian: gaussian,
    METRICS: METRICS,
    REGIMES: REGIMES,
    BATCHES: BATCHES,
    regimeOf: regimeOf
  };
});
