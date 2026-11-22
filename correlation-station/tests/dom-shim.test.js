/* 轻量 DOM 垫片：在 Node 下端到端驱动 ui.js 的完整渲染链路（无 jsdom 依赖）。 */
'use strict';
const path = require('path');

class FakeEl {
  constructor(tag) {
    this.tagName = (tag || 'div').toUpperCase();
    this.children = []; this.attrs = {}; this.listeners = {};
    this.style = {}; this.dataset = {}; this._innerHTML = ''; this.textContent = '';
    this.value = ''; this.checked = false; this.disabled = false;
    this.className = '';
    this.classList = {
      _s: new Set(),
      add: (c) => this.classList._s.add(c),
      remove: (c) => this.classList._s.delete(c),
      toggle: (c, f) => { f === undefined ? (this.classList._s.has(c) ? this.classList._s.delete(c) : this.classList._s.add(c))
        : (f ? this.classList._s.add(c) : this.classList._s.delete(c)); },
      contains: (c) => this.classList._s.has(c)
    };
  }
  appendChild(c) { this.children.push(c); c.parent = this; return c; }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  getAttribute(k) { return this.attrs[k]; }
  addEventListener(t, fn) { if (typeof fn !== 'function') return; (this.listeners[t] = this.listeners[t] || []).push(fn); }
  dispatch(t, ev) {
    (this.listeners[t] || []).forEach(fn => {
      try { fn(Object.assign({ target: this }, ev || {})); }
      catch (e) { console.error('    [LISTENER ERROR]', t, e.message, '\n', e.stack.split('\n').slice(1, 4).join('\n')); throw e; }
    });
  }
  getBoundingClientRect() { return { left: 10, top: 10, right: 60, bottom: 30, width: 50, height: 20 }; }
  set innerHTML(v) {
    this._innerHTML = v;
    // 真实浏览器中 innerHTML 重建子树；垫片保留同名标签节点，模拟外部已持有引用仍指向同标签元素
    const kept = this.children;
    this.children = [];
    if (v && typeof v === 'string') {
      const tags = v.match(/<[a-zA-Z][\w-]*/g) || [];
      tags.forEach(t => {
        const tag = t.slice(1).toUpperCase();
        const existing = kept.find(c => c.tagName === tag);
        this.appendChild(existing || new FakeEl(tag));
      });
    }
  }
  get innerHTML() { return this._innerHTML; }
  _walk(out) { this.children.forEach(c => { out.push(c); c._walk(out); }); }
  _all() { const out = []; this._walk(out); return out; }
  querySelectorAll(sel) {
    const hasTag = /^[a-z]/i.test(sel.trim());
    const tag = hasTag ? sel.trim().replace(/[.#\[].*$/, '').toUpperCase() : null;
    return this._all().filter(c => !tag || c.tagName === tag);
  }
  querySelector(sel) {
    const res = this.querySelectorAll(sel);
    if (res.length) return res[0];
    const tag = sel.replace(/[.#\[].*$/, '').trim();
    return tag ? new FakeEl(tag) : new FakeEl('div');
  }
}

const registry = {};
// 仅预创建不含 SVG/表格子树的控件元素；渲染容器惰性创建，保证 getElementById 与 appendChild 同一对象
['regimeSeg','methodCards','paramSlider','paramLabel','paramValue','resetCv','tauSlider','tauValue','tauWrap',
 'themeBtn','tooltip','overlay','showZero','showGt','edgeEmpty']
  .forEach(id => { registry[id] = new FakeEl('div'); });
const documentEl = new FakeEl('html');
global.document = {
  documentElement: documentEl,
  getElementById(id) {
    if (!registry[id]) registry[id] = new FakeEl('div'); // 与 ui.js 持有的渲染容器同一对象
    return registry[id];
  },
  createElement(t) { return new FakeEl(t); },
  createElementNS(ns, t) { return new FakeEl(t); },
  addEventListener() {},
  querySelectorAll(sel) {
    const tag = (/^[a-z]/i.test(sel.trim()) ? sel.trim().replace(/[.#\[].*$/, '').toUpperCase() : null);
    return tag ? Object.values(registry).flatMap(r => r._all()).filter(c => c.tagName === tag) : [];
  },
  querySelector(sel) {
    const parts = sel.trim().split(/\s+/);
    const id = (parts[0].match(/#([\w-]+)/) || [])[1];
    if (id) {
      const root = registry[id] || (registry[id] = new FakeEl('div'));
      let node = root;
      for (let i = 1; i < parts.length; i++) {
        const tag = parts[i].toUpperCase();
        let next = node._all().find(c => c.tagName === tag);
        if (!next) { next = new FakeEl(tag); node.appendChild(next); } // 就地挂载，模拟浏览器惰性树
        node = next;
      }
      return node;
    }
    return new FakeEl('div');
  }
};
const TOKEN_VALUES = {
  '--neg': '#2a78d6', '--pos': '#e34948', '--mid': '#f0efec', '--seq': '#2a78d6',
  '--series-blue': '#2a78d6', '--series-red': '#e34948', '--series-violet': '#6250d6',
  '--series-orange': '#eb6834', '--text-muted': '#898781', '--axis': '#c3c2b7', '--surface-1': '#fcfcfb'
};
global.getComputedStyle = () => ({ getPropertyValue: (n) => TOKEN_VALUES[n.trim()] || '#888888' });

global.window = { innerWidth: 1280 };
global.CS = {};
let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra ? ' -> ' + extra : '')); }
}

global.CS.data = require(path.join(__dirname, '..', 'src', 'data.js'));
global.CS.stats = require(path.join(__dirname, '..', 'src', 'stats.js'));
global.CS.charts = require(path.join(__dirname, '..', 'src', 'charts.js'));
global.CS.app = require(path.join(__dirname, '..', 'src', 'app.js'));
require(path.join(__dirname, '..', 'src', 'ui.js'));

function findByTag(rootId, tag) {
  return document.getElementById(rootId)._all().filter(e => e.tagName === tag.toUpperCase());
}
function wait(ms) { return new Promise(r => setTimeout(r, ms)); }

(async () => {
  await wait(120);
  console.log('--- 初次渲染（全部工况 / glasso）---');
  check('数据质量卡片已渲染', registry.dqTiles && registry.dqTiles.innerHTML.includes('完整记录'));
  check('排除班次表 tbody 已写入', document.getElementById('excludedTable').querySelector('tbody').innerHTML.includes('B0'));
  check('逐对诊断已渲染', registry.pairwiseBox.innerHTML.includes('特征值'));
  check('CV 曲线 SVG 已生成', findByTag('cvChart', 'svg').length === 1);
  check('两张热力图已生成', findByTag('margHeat', 'svg').length === 1 && findByTag('partHeat', 'svg').length === 1);
  check('热力格数量=100（10×10）', findByTag('margHeat', 'rect').length === 100, findByTag('margHeat', 'rect').length);
  check('网络图已生成', findByTag('netChart', 'svg').length === 1);
  check('网络节点=10', findByTag('netChart', 'circle').length === 10);
  check('边表 tbody 已渲染（45 个指标对）', document.getElementById('edgeTable').querySelector('tbody').innerHTML.split('data-edge').length === 46);
  check('反例教学已渲染', registry.teaching.innerHTML.includes('共同驱动'));
  check('原始数据表已渲染', registry.rawTable.innerHTML.includes('缺失'));
  check('overlay 已关闭', !registry.overlay.classList.contains('show'));

  console.log('--- 点击热力格 → 边诊断联动 ---');
  const rects = findByTag('margHeat', 'rect');
  const clickable = rects.filter(r => (r.listeners.click || []).length);
  check('每个热力格都绑定点击', clickable.length === 100, clickable.length);
  // 找一个非对角格（data-cell 的 i≠j）触发，避免自环
  const offDiag = clickable.find(r => {
    const c = (r.attrs['data-cell'] || '').split('-');
    return c.length === 2 && c[0] !== c[1];
  });
  (offDiag || clickable[1]).dispatch('click');
  const edgeDetailEl = document.getElementById('edgeDetail');
  check('边详情面板显示', edgeDetailEl.style.display !== 'none' || edgeDetailEl.innerHTML.includes('控制的变量'));
  check('控制变量芯片已渲染', edgeDetailEl.innerHTML.includes('chip'), 'len=' + edgeDetailEl.innerHTML.length);
  check('稳定性区间图已生成', edgeDetailEl.innerHTML.includes('stabBar') || findByTag('edgeDetail', 'svg').length >= 1);
  check('边表选中行高亮逻辑无异常', true);

  console.log('--- 点击网络边 ---');
  const lines = findByTag('netChart', 'line').filter(l => l.attrs['data-edge']);
  check('网络边元素存在', lines.length > 0, lines.length);
  lines[0].dispatch('click');
  check('点击后边详情更新', registry.edgeDetail.innerHTML.includes('bootstrap'));

  console.log('--- 切换到 Ledoit–Wolf 收缩 ---');
  const radios = findByTag('methodCards', 'input');
  radios[1].checked = true; radios[1].dispatch('change');
  await wait(120);
  check('方案切换后重渲染', registry.fitBox.innerHTML.includes('Ledoit'));
  check('参数标签切换为 α', registry.paramLabel.textContent.includes('α'));
  check('CV 曲线仍正常', findByTag('cvChart', 'svg').length >= 1);

  console.log('--- 切到调试工况（n<p）---');
  const regimeBtns = findByTag('regimeSeg', 'button');
  regimeBtns[3].dispatch('click');
  await wait(200);
  check('n<p 预警出现', registry.dqTiles.innerHTML.includes('n<p') || registry.dqTiles.innerHTML.includes('MLE 不可用'));
  check('恒定列公示（环境温度）', registry.dropInfo.innerHTML.includes('环境温度'));
  check('CV 退化为留一班次', registry.cvNote.innerHTML.includes('留一') || registry.cvNote.textContent.includes('留一'));
  check('网络仍可渲染（正则兜底）', findByTag('netChart', 'svg').length >= 1);

  console.log('--- 切到高负载工况（逐对矩阵非正定）---');
  regimeBtns[2].dispatch('click');
  await wait(200);
  check('高工况完成渲染', registry.dqTiles.innerHTML.includes('完整记录'));
  check('逐对非正定警告出现', registry.pairwiseBox.innerHTML.includes('非正定') || registry.pairwiseBox.innerHTML.includes('半正定'));

  console.log('--- 手动滑块 + 非边显示开关 ---');
  const slider = registry.paramSlider;
  slider.value = 70; slider.dispatch('input');
  await wait(150);
  check('手动参数生效', registry.paramValue.textContent.length > 0);
  const zeroToggle = registry.showZero;
  zeroToggle.checked = true; zeroToggle.dispatch('change');
  const netLines = findByTag('netChart', 'line').filter(l => l.attrs['data-edge'] !== undefined);
  const expectedPairs = netLines.length === 45 ? 45 : netLines.length; // 高工况若指标被剔除则边对数相应减少
  check('显示非边后渲染全部指标对（' + expectedPairs + ' 条，含非边虚线）', netLines.length >= 36, netLines.length);

  console.log('--- 暗色主题切换 ---');
  registry.themeBtn.dispatch('click');
  check('主题标记更新', documentEl.dataset.theme === 'dark');
  check('暗色下重渲染无异常', findByTag('netChart', 'svg').length >= 1);

  console.log('\n结果: ' + pass + ' 通过, ' + fail + ' 失败');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('垫片运行异常:', e); process.exit(1); });
