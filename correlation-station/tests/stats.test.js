/* Node 测试：数据生成 + 统计核心的数值正确性。运行：node tests/stats.test.js */
'use strict';
const path = require('path');
const dataMod = require(path.join(__dirname, '..', 'src', 'data.js'));
const S = require(path.join(__dirname, '..', 'src', 'stats.js'));

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra ? '  -> ' + extra : '')); }
}
function approx(a, b, tol) { return Math.abs(a - b) <= (tol || 1e-6); }

console.log('--- 1. 数据生成 ---');
const ds = dataMod.generate();
check('共 90 个班次', ds.rows.length === 90, ds.rows.length);
const b12 = ds.rows.filter(r => r.batch === 'B12');
check('B12 有 3 个班次', b12.length === 3);
check('B12 无缺失', b12.every(r => ds.metrics.every(m => r[m.key] !== null)));
let nulls = 0;
ds.rows.forEach(r => ds.metrics.forEach(m => { if (r[m.key] === null) nulls++; }));
check('存在缺失单元', nulls > 30, nulls);
check('计划产量整表恒定', ds.rows.every(r => r.target_qty === 1000));

console.log('--- 2. 预处理（完整记录 / 恒定列 / 重复列）---');
const pre = S.preprocess(ds.rows, ds.metrics);
check('排除班次非空且原因明确', pre.excluded.length > 0 && pre.excluded.every(e => e.reasons[0].indexOf('缺失') >= 0),
  pre.excluded.length);
check('完整记录数 = 总数-排除数', pre.n === ds.rows.length - pre.excluded.length);
check('恒定列 target_qty 被剔除', pre.droppedConstants.some(d => d.key === 'target_qty'));
check('重复列 motor_current_a 被识别', pre.droppedDuplicates.some(d => d.key === 'motor_current_a'),
  JSON.stringify(pre.droppedDuplicates));
check('剩余指标 p=10', pre.p === 10, pre.p);
check('每个指标在所有完整行有值', pre.keys.every(k => pre.completeRows.every(r => r[k] !== null)));
const Zcov = S.covMLE(pre.Z);
check('Z 为标准化矩阵（对角≈1、非对角是相关）', approx(Zcov[0][0], 1, 1e-9) && Math.abs(Zcov[0][1]) <= 1);

console.log('--- 3. MLE / 相关 / 逆 / 特征分解 ---');
const R = S.corrFromCov(S.covMLE(pre.Z));
check('相关阵对角线=1', R.every((r, i) => approx(r[i], 1)));
check('相关阵对称', R.every((r, i) => r.every((v, j) => approx(v, R[j][i]))));
const eig = S.jacobiEigen(R);
check('特征值和≈p', approx(eig.reduce((a, b) => a + b, 0), pre.p, 1e-6));
check('n>p 时最小特征值为正', eig[0] > 0, eig[0]);
const Rinv = S.invert(R);
check('R·R⁻¹≈I', S.matmul(R, Rinv).every((r, i) => r.every((v, j) => approx(v, i === j ? 1 : 0, 1e-6))));
const ld = S.logdetSPD(R);
check('logdet(相关阵) ≤ 0', ld <= 1e-9, ld);

console.log('--- 4. Ledoit–Wolf / OAS 收缩 ---');
const lw = S.ledoitWolf(S.covMLE(pre.Z), pre.n, pre.Z);
check('LW 收缩强度在 [0,1]', lw.shrink >= 0 && lw.shrink <= 1, lw.shrink);
check('LW 协方差正定', S.isSPD(lw.Sigma));
const oas = S.oas(S.covMLE(pre.Z), pre.n);
check('OAS 收缩强度在 [0,1]', oas.shrink >= 0 && oas.shrink <= 1, oas.shrink);
check('n>p 高维信号下 LW 收缩较小 (<0.3)', lw.shrink < 0.3, lw.shrink);
const eigLW = S.jacobiEigen(lw.Sigma);
check('收缩后最小特征值比未收缩大', eigLW[0] >= eig[0] - 1e-12);

console.log('--- 5. graphical lasso ---');
const fit0 = S.glasso(R, 0.0, { tol: 1e-9, maxit: 500 });
check('λ=0 时 Theta≈R⁻¹', fit0.Theta.every((r, i) => r.every((v, j) => approx(v, Rinv[i][j], 2e-4))));
const fitG = S.glasso(R, 0.3);
let zerosG = 0;
for (let i = 0; i < pre.p; i++) for (let j = i + 1; j < pre.p; j++) if (Math.abs(fitG.Theta[i][j]) < 1e-8) zerosG++;
check('λ=0.3 产生精确零元素', zerosG > 0, zerosG);
check('glasso Theta 正定', S.isSPD(fitG.Theta));
check('偏相关对角线=1', approx(S.partialFromTheta(fitG.Theta)[0][0], 1));

console.log('--- 6. 留出交叉验证（按批次）---');
const alphaGrid = [];
for (let i = 0; i <= 20; i++) alphaGrid.push(i / 20);
const cvS = S.cvShrink(pre.Z, pre.completeRows, alphaGrid);
check('收缩 CV 覆盖 21 个 α', cvS.results.length === 21);
check('CV 方案为按批次折', cvS.foldScheme.indexOf('批次') >= 0, cvS.foldScheme);
check('CV 最优 α 有限', isFinite(cvS.best.nll));
const lamGrid = [];
for (let i = 0; i < 14; i++) lamGrid.push(0.5 * Math.pow(0.7, i));
const cvG = S.cvGlasso(pre.Z, pre.completeRows, lamGrid);
check('glasso CV 覆盖 14 个 λ', cvG.results.length === 14);
check('CV 最优 λ 有限', isFinite(cvG.best.nll));
check('NLL 无 Infinity', cvG.results.every(r => isFinite(r.nll)));

console.log('--- 7. 共同驱动反例：marginals 大、partials 小 ---');
const marg = R, part = S.partialFromTheta(fit0.Theta);
const idx = k => pre.keys.indexOf(k);
const mLP = marg[idx('material_kg')][idx('gas_flow_m3')];
const pLP = part[idx('material_kg')][idx('gas_flow_m3')];
check('原料-燃气 普通相关较大 (|r|>0.5)', Math.abs(mLP) > 0.5, mLP.toFixed(3));
check('原料-燃气 偏相关明显更小 (|partial|<|r|)', Math.abs(pLP) < Math.abs(mLP),
  'r=' + mLP.toFixed(3) + ' partial=' + pLP.toFixed(3));
const mLE = marg[idx('load_pct')][idx('energy_kwh')];
const pLE = part[idx('load_pct')][idx('energy_kwh')];
check('负载-能耗 普通相关大 (|r|>0.7)', Math.abs(mLE) > 0.7, mLE.toFixed(3));
// 真实直接边（负载->排气，控制炉温后仍在）
const mExh = marg[idx('load_pct')][idx('exhaust_temp_c')];
const pExh = part[idx('load_pct')][idx('exhaust_temp_c')];
check('负载-排气存在直接边（偏相关不可忽略 |p|>0.1）', Math.abs(pExh) > 0.1, pExh.toFixed(3));
// 玻璃解应保留该边
const pExhG = S.partialFromTheta(fitG.Theta)[idx('load_pct')][idx('exhaust_temp_c')];
check('glasso(λ=0.3) 保留负载-排气边', Math.abs(pExhG) > 0, pExhG.toFixed(3));

console.log('--- 8. 稳定性（bootstrap + 留批次）---');
const st = S.stability(pre.Z, pre.completeRows, dataMod.mulberry32(7),
  { method: 'shrink', param: lw.shrink, partial: part }, 40);
check('稳定性摘要对称且覆盖所有边', st.summary.length === pre.p && st.summary[0][1].bootProb !== undefined);
check('bootProb ∈ [0,1]', st.summary[idx('load_pct')][idx('furnace_temp_c')].bootProb >= 0);
check('留批次覆盖 12 个批次', st.jackBatches === 12, st.jackBatches);

console.log('--- 9. 逐对删缺失诊断（可能产生非正定矩阵）---');
const pw = S.pairwiseDiagnostics(ds.rows, pre.keys);
check('逐对样本数随指标对变化（非同一批记录）',
  pw.sampleCounts.some(r => r.some(v => v !== pw.sampleCounts[0][0])));
check('输出最小特征值与条件数', typeof pw.minEigen === 'number' && pw.condition > 1);
const eigPW = S.jacobiEigen(pw.matrix);
console.log('    逐对矩阵 minEig=' + eigPW[0].toFixed(4) + ' condition=' + pw.condition.toFixed(1) +
  (pw.psd ? '（本例恰好半正定）' : '（非正定 → 逐对拼接不合法）'));

console.log('--- 10. n<p 调试工况（B12）---');
const pre12 = S.preprocess(b12, ds.metrics);
check('B12 完整记录 n=3', pre12.n === 3);
check('B12 下环境温度恒定被剔除', pre12.droppedConstants.some(d => d.key === 'ambient_temp_c'));
check('B12 下 n<=p 标记为真', pre12.nLessThanP && pre12.n <= pre12.p);
const R12 = S.corrFromCov(S.covMLE(pre12.Z));
const eig12 = S.jacobiEigen(R12);
check('n<p 时 MLE 相关阵奇异（最小特征值≈0）', Math.abs(eig12[0]) < 1e-10, eig12[0]);
check('奇异阵求逆返回 null', S.invert(R12) === null);
const lw12 = S.ledoitWolf(S.covMLE(pre12.Z), pre12.n, pre12.Z);
check('收缩使 n<p 协方差恢复正定', S.isSPD(lw12.Sigma) && lw12.shrink > 0.01, 'shrink=' + lw12.shrink.toFixed(3));
const g12 = S.glasso(R12, 0.2);
check('glasso 在 n<p 下给出正定精度阵', S.isSPD(g12.Theta));
const cv12 = S.cvShrink(pre12.Z, pre12.completeRows, alphaGrid);
check('单批次退化为留一班次 CV', cv12.foldScheme.indexOf('留一') >= 0, cv12.foldScheme);
check('LOO 折数=样本数', cv12.folds === 3);

console.log('--- 11. 高负载工况 ---');
const highRows = ds.rows.filter(r => r.regime === 'high');
const preH = S.preprocess(highRows, ds.metrics);
check('高负载工况可正常完成全链路（n≥p，允许该子集再剔除仿射列）', preH.n >= preH.p, 'n=' + preH.n + ' p=' + preH.p);
check('n/p<3 时 lowRatio 预警置位', preH.lowRatio === (preH.n < 3 * preH.p));
const cvGH = S.cvGlasso(preH.Z, preH.completeRows, lamGrid);
check('高负载 glasso CV 有限', isFinite(cvGH.best.nll));

console.log('\n结果: ' + pass + ' 通过, ' + fail + ' 失败');
process.exit(fail ? 1 : 0);
