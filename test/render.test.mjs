import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

/**
 * 渲染冒烟：用一个最小 hooks 运行时真正执行组件与 effect。
 * 纯函数单测照不到「按钮整个消失」这类问题 —— 组件里一个 ReferenceError，
 * 或者 effect 里抛错，槽位就什么都不渲染。
 */

function elementStub(extra = {}) {
  const style = {
    setProperty(name, value) {
      style[name] = String(value);
    },
    removeProperty(name) {
      delete style[name];
    },
    getPropertyValue(name) {
      return style[name] ?? '';
    },
  };
  return {
    width: 0,
    height: 0,
    style,
    dataset: {},
    className: '',
    textContent: '',
    open: false,
    isConnected: true,
    getContext: () => canvasContext(),
    toDataURL: () => 'data:image/png;base64,xx',
    addEventListener() {},
    removeEventListener() {},
    appendChild() {},
    removeChild() {},
    remove() {},
    showModal() {
      this.open = true;
    },
    close() {
      this.open = false;
    },
    getBoundingClientRect: () => ({ width: 900, height: 600, top: 0, left: 140, right: 1040, bottom: 600 }),
    scrollIntoView() {},
    focus() {},
    contains: () => false,
    setAttribute() {},
    getAttribute: () => null,
    querySelector: () => null,
    ...extra,
  };
}

function canvasContext() {
  const handler = {
    get(_, key) {
      if (key === 'measureText') return (text) => ({ width: String(text ?? '').length * 6 });
      if (key === 'createRadialGradient' || key === 'createLinearGradient') return () => ({ addColorStop() {} });
      if (key === 'getImageData') return () => ({ data: new Uint8ClampedArray(4) });
      if (key === 'canvas') return elementStub();
      return () => undefined;
    },
    set: () => true,
  };
  return new Proxy({}, handler);
}

function installDom({ windowsTitlebar = false } = {}) {
  const root = elementStub({
    hasAttribute: (name) => name === 'data-windows-titlebar' && windowsTitlebar,
  });
  const body = elementStub();
  globalThis.document = {
    documentElement: root,
    body,
    head: elementStub(),
    createElement: () => elementStub(),
    querySelector: () => null,
    addEventListener() {},
    removeEventListener() {},
    hidden: false,
    visibilityState: 'visible',
  };
  const storage = new Map();
  globalThis.window = {
    devicePixelRatio: 2,
    innerWidth: 1280,
    innerHeight: 800,
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
    localStorage: {
      getItem: (key) => storage.get(key) ?? null,
      setItem: (key, value) => storage.set(key, String(value)),
      removeItem: (key) => storage.delete(key),
    },
    addEventListener() {},
    removeEventListener() {},
  };
  globalThis.localStorage = window.localStorage;
  globalThis.getComputedStyle = () => ({ getPropertyValue: () => '40px' });
  globalThis.requestAnimationFrame = (fn) => {
    fn(16);
    return 1;
  };
  globalThis.cancelAnimationFrame = () => {};
  globalThis.setTimeout = (fn) => {
    fn();
    return 1;
  };
  globalThis.clearTimeout = () => {};
  globalThis.setInterval = () => 1;
  globalThis.clearInterval = () => {};
  globalThis.performance = { now: () => 1000 };
  globalThis.AbortController = class {
    signal = {};
    abort() {}
  };
  globalThis.ResizeObserver = class {
    observe() {}
    disconnect() {}
  };
  globalThis.MutationObserver = class {
    observe() {}
    disconnect() {}
  };
  return { body, root };
}

function createHooks() {
  const state = [];
  const refs = [];
  const effects = [];
  let cursor = 0;
  const createElement = (type, props, ...children) => ({
    type,
    props: { ...(props ?? {}), children: children.flat(9) },
  });
  const api = {
    createElement,
    Fragment: 'fragment',
    useState(initial) {
      const index = cursor;
      cursor += 1;
      if (!(index in state)) state[index] = typeof initial === 'function' ? initial() : initial;
      return [
        state[index],
        (next) => {
          state[index] = typeof next === 'function' ? next(state[index]) : next;
        },
      ];
    },
    useRef(initial) {
      const index = cursor;
      cursor += 1;
      if (!(index in refs)) refs[index] = { current: initial };
      return refs[index];
    },
    useEffect(fn) {
      const index = cursor;
      cursor += 1;
      // 每次渲染都要换成最新的闭包，否则永远跑第一次渲染时的那份（open 永远是 false）
      effects[index] = fn;
      return undefined;
    },
    useReducer(reducer, initial) {
      const index = cursor;
      cursor += 1;
      if (!(index in state)) state[index] = initial;
      return [
        state[index],
        (action) => {
          state[index] = reducer(state[index], action);
        },
      ];
    },
    useCallback(fn) {
      cursor += 1;
      return fn;
    },
    useMemo(fn) {
      cursor += 1;
      return fn();
    },
  };
  return {
    api,
    createElement,
    effectList: () => effects.filter(Boolean),
    reset: () => {
      cursor = 0;
    },
  };
}

async function loadPlugin() {
  const source = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8');
  const hooks = createHooks();
  let entry = null;
  globalThis.window.__ModuleLoader__ = {
    load: (value) => {
      entry = value;
    },
  };
  const modules = {
    react: hooks.api,
    'react-dom': { createPortal: (node) => node },
    'react/jsx-runtime': { jsx: hooks.createElement, jsxs: hooks.createElement, Fragment: hooks.api.Fragment },
    '@deepseek-ai/cordis': { Service: class {} },
    'dsh-client-store': { defineStore: () => ({ getState: () => ({}) }) },
    'dsh-client-ui-dockkit': { Dock: () => null },
    'dsh-client-ui-primitives': { Button: 'button', IconButton: 'button' },
    'dsh-client-ui-slots': {},
  };
  new Function('window', 'document', source)(globalThis.window, globalThis.document);
  assert.ok(entry !== null, 'bundle 必须调用 __ModuleLoader__.load');
  const loaded = entry.factory((id) => modules[id]);
  assert.equal(typeof loaded.apply, 'function', 'factory 必须返回 apply');
  return { loaded, hooks };
}

function renderRoot(component, hooks) {
  hooks.reset();
  const errors = [];
  let tree = null;
  try {
    tree = component();
  } catch (failure) {
    errors.push(failure);
  }
  attachRefs(tree);
  for (const effect of hooks.effectList()) {
    try {
      effect();
    } catch (failure) {
      errors.push(failure);
    }
  }
  return { tree, errors };
}

/** 模拟 React 挂 ref：否则 effect 里读 ref.current 永远是 null。 */
function attachRefs(node) {
  if (node === null || node === undefined || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const child of node) attachRefs(child);
    return;
  }
  const ref = node.props?.ref;
  if (ref !== null && ref !== undefined) {
    const target = elementStub({
      hasAttribute: () => false,
    });
    if (typeof ref === 'function') ref(target);
    else if (typeof ref === 'object') ref.current = target;
  }
  for (const child of node.props?.children ?? []) attachRefs(child);
}

function findAll(node, predicate, out = []) {
  if (node === null || node === undefined || typeof node !== 'object') return out;
  if (Array.isArray(node)) {
    for (const child of node) findAll(child, predicate, out);
    return out;
  }
  if (predicate(node)) out.push(node);
  for (const child of node.props?.children ?? []) findAll(child, predicate, out);
  return out;
}

function captureComponent(loaded, slotName) {
  const registered = new Map();
  const ctx = {
    slots: {
      inject(name, callback) {
        callback();
      },
      register(definition, target) {
        // 宿主的 main 是 **keyed** 槽、侧栏是 **id** 列：两者都能挂多项
        // （记忆海 / 人格），所以按「槽名 + 它自己的键」登记，
        // 否则后注册的那页会把前一页顶掉。
        const slotKey = definition.key ?? definition.id ?? '';
        registered.set(`${definition.name}::${slotKey}`, target);
        return () => {};
      },
    },
    effect: (fn) => () => {},
    on: () => () => {},
    get: () => null,
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    tools: { register: () => () => {} },
    systemPrompt: { section: () => () => {} },
    inject: (deps, fn) => {
      fn();
    },
  };
  loaded.apply(ctx, {});
  const component = registered.get(slotName);
  assert.notEqual(component, undefined, `必须注册 ${slotName} 的组件`);
  return component;
}

/** 星图组件的引用：按函数名找（它是页面里的子组件，我们的运行时不会执行它） */
const isMemorySea = (node) => typeof node.type === 'function' && node.type.name === 'MemorySea';

test('页面：记忆海铺满内容区，页头/侧栏/页脚与星图都在', async () => {
  installDom();
  const { loaded, hooks } = await loadPlugin();
  const page = captureComponent(loaded, 'main::memory-loom');
  const { tree, errors } = renderRoot(page, hooks);
  assert.deepEqual(errors.map((e) => e.message), [], '渲染与 effect 都不能抛错');
  const byClass = (name) => findAll(tree, (node) => String(node.props?.className ?? '').split(' ').includes(name));
  for (const name of ['ml-page', 'ml-head', 'ml-rail', 'ml-foot']) {
    assert.equal(byClass(name).length, 1, `缺少 ${name}`);
  }
  assert.equal(
    findAll(tree, (node) => typeof node.type === 'function' && node.type.name === 'MemorySea').length,
    1,
    '页面里应有星图组件',
  );
  // 页面根不能是 fixed / 不能自带宽高上限（那是浮层时代的写法）
  const pageProps = byClass('ml-page')[0].props;
  assert.equal(pageProps.style?.position, undefined);
  // 不该再有「返回」按钮
  const texts = findAll(tree, (node) => node.type === 'button').map((node) => JSON.stringify(node.props.children).includes('返回'));
  assert.deepEqual(texts.filter(Boolean), [], '页面上不应再有返回按钮');
});

test('历史页签：滑杆与那一刻的记忆列表都在（时间轴已从画面底部搬走）', async () => {
  installDom();
  // 星图主循环用 rAF 自驱动；默认桩会同步回调 → 递归爆栈，这里改成只登记不执行
  globalThis.requestAnimationFrame = () => 1;
  globalThis.cancelAnimationFrame = () => {};
  const { loaded, hooks } = await loadPlugin();
  const page = captureComponent(loaded, 'main::memory-loom');
  const { tree } = renderRoot(page, hooks);
  const sea = findAll(tree, isMemorySea)[0];
  assert.notEqual(sea, undefined, '页面里应有星图组件');

  // ① 画面底部不再有时间轴：那条在宿主 main 槽里反复被挤掉，已整体搬进侧栏页签
  const memories = [
    { id: 'm1', kind: 'fact', text: '第一条', createdAt: 1000, status: 'active', hits: 0, supersedes: [] },
    { id: 'm2', kind: 'fact', text: '第二条', createdAt: 2000, status: 'active', hits: 0, supersedes: [] },
  ];
  const { tree: seaTree, errors } = renderRoot(
    () => sea.type({ memories, dataKey: 'k', selectedId: null, onSelect: () => {}, stressToken: 0, onStressReport: () => {}, animate: true, scrubAt: null, onScrub: () => {}, focusIds: new Set() }),
    hooks,
  );
  assert.deepEqual(errors.map((failure) => failure.message), [], '星图渲染与 effect 都不能抛错');
  const inStage = (node, name) => findAll(node, (item) => String(item.props?.className ?? '').split(' ').includes(name));
  assert.equal(inStage(seaTree, 'ml-scrub').length, 0, '舞台底部不该再挂着时间轴');

  // ② 侧栏「历史」页签里必须有滑杆，并且能列出"那一刻已有的记忆"
  const pane = loaded.__internals.HistoryPane;
  assert.equal(typeof pane, 'function', '必须导出 HistoryPane 以便离线验证');
  const { tree: paneTree } = renderRoot(
    () => pane({ memories, scrubAt: 1500, onScrub: () => {}, onPick: () => {} }),
    hooks,
  );
  const ranges = findAll(paneTree, (node) => node.type === 'input' && node.props?.type === 'range');
  assert.equal(ranges.length, 1, '历史页签里必须有回放滑杆');
  assert.ok(ranges[0].props.max > ranges[0].props.min, '回放区间必须有跨度');
  const rows = inStage(paneTree, 'ml-row');
  assert.equal(rows.length, 1, '停在 1500 时应只列出那一刻已有的 1 条');
  const nowButton = findAll(paneTree, (node) => node.type === 'button' && String(node.props?.children ?? '') === '回到现在')[0];
  assert.notEqual(nowButton, undefined, '有偏移时必须能一键回到现在');
  assert.equal(nowButton.props.disabled, false);
});

test('侧栏入口：是宿主导航栏里的一项，图标随尺寸与选中态变化', async () => {
  installDom();
  const { loaded, hooks } = await loadPlugin();
  const icon = captureComponent(loaded, 'sidebar.panellist::memory-loom');
  const { tree, errors } = renderRoot(() => icon({ size: 18, active: true }), hooks);
  assert.deepEqual(errors.map((e) => e.message), []);
  assert.equal(tree.type, 'svg', '入口应该是内联 SVG');
  assert.equal(tree.props.width, 18);
  assert.equal(tree.props.height, 18);
  assert.equal(findAll(tree, (node) => node.type === 'circle').length, 3, '三个星点');
  const dimmed = findAll(tree, (node) => node.type === 'circle' && node.props.opacity === 1);
  assert.ok(dimmed.length >= 1, '选中态下星点应更亮');
});

test('侧栏入口：记忆海与人格是并列的两项，不是一个页面里的两个页签', async () => {
  installDom();
  const { loaded, hooks } = await loadPlugin();
  const seaIcon = captureComponent(loaded, 'sidebar.panellist::memory-loom');
  const personaIcon = captureComponent(loaded, 'sidebar.panellist::memory-loom-persona');
  assert.notEqual(personaIcon, undefined, '人格要有自己的导航入口');
  const sea = renderRoot(() => seaIcon({ size: 16 }), hooks).tree;
  const persona = renderRoot(() => personaIcon({ size: 16 }), hooks).tree;
  assert.notDeepEqual(persona, sea, '两项不该是同一个图标：一个是星网，一个是内核');
});

test('人格页：单开一页（不是浮层），读不到数据时也不抛错、仍然是一整页', async () => {
  installDom();
  const { loaded, hooks } = await loadPlugin();
  const page = captureComponent(loaded, 'main::memory-loom-persona');
  const { tree, errors } = renderRoot(page, hooks);
  assert.deepEqual(errors.map((e) => e.message), [], '渲染与 effect 都不能抛错');
  const pageNode = findAll(tree, (node) => String(node.props?.className ?? '').split(' ').includes('ml-page'))[0];
  assert.notEqual(pageNode, undefined, '人格必须占一整页');
  assert.equal(pageNode.props.style?.position, undefined, '不许再用 fixed 浮层');
  assert.equal(pageNode.props['aria-label'], '人格');
  const backs = findAll(tree, (node) => node.type === 'button' && JSON.stringify(node.props.children).includes('返回'));
  assert.deepEqual(backs, [], '页面上不应有返回按钮');
});

test('人格页：太极为阳 —— 亮/暖/近/实/一，且不许借用深色卡片的控件', async () => {
  // 这条守两件事：
  // ① 用户看到的那个 bug：`.ml-btn` / `.ml-input` 是深色卡片里的写法
  //    （background:#080e1a + 深色文字），放到浅底上就是"两个黑黑的方块"。
  // ② 人格页相对记忆海是**对立**的：星空是阴（深/冷/远/虚/多），这一页是阳。
  const source = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8');
  const start = source.indexOf('function PersonaPage');
  assert.ok(start > 0, '必须有 PersonaPage');
  const body = source.slice(start, source.indexOf('function MemorySeaPage'));
  for (const forbidden of ['ml-btn', 'ml-input', '.ml-block', 'ml-self-block', 'ml-persona-body']) {
    assert.equal(body.includes(forbidden), false, `人格页不许再用 ${forbidden}（深色卡片的写法，浅底上会变成黑块）`);
  }
  // 阳这套样式必须真的存在
  assert.ok(source.includes('.ml-page.ml-yang{'), '缺少阳的页面样式');
  assert.ok(/radial-gradient\(122% 84% at 18% -14%/.test(source), '日晕不见了：阳的"明"要有一个来向');
  // 「灰」与「生机」是两条**不同的**轴，不能用一个旋钮调：
  //   · 彩度：太烫是在喊，太灰是死 —— 只许落在中间那一带；
  //   · 明暗：底色要亮、墨要黑、主块要亮得像被光打到 —— 对比才是活气。
  //   （0.51.4 就是只压了彩度、没补对比，画面才发死。）
  const hexOf = (name) => {
    const found = new RegExp(`--${name}:#([0-9a-f]{6})`).exec(source);
    assert.notEqual(found, null, `缺少 --${name}`);
    return [0, 2, 4].map((offset) => parseInt(found[1].slice(offset, offset + 2), 16));
  };
  const satOf = (rgb) => (Math.max(...rgb) - Math.min(...rgb)) / Math.max(...rgb);
  const lumOf = (rgb) => (0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2]) / 255;
  const zhu = hexOf('zhu');
  const sun = hexOf('sun');
  const bg = hexOf('yang-1');
  const ink = hexOf('ink');
  const sat = satOf(zhu);
  assert.ok(sat >= 0.4 && sat <= 0.62, `主色彩度 ${sat.toFixed(2)} 出界：<0.4 会灰死，>0.62 会发烫`);
  assert.ok(lumOf(bg) - lumOf(zhu) >= 0.45, '底色与主色明度差太小：没有对比就没有光，画面会发死');
  assert.ok(lumOf(ink) <= 0.18, '墨不够黑：对比全靠它撑，字一灰整页就塌');
  assert.ok(lumOf(sun) - lumOf(zhu) >= 0.15, '金砂与赭红要拉开明度：单色自己加深只会更闷');
  assert.ok(source.includes('.ml-yang .ml-core-text'), '内核要有一档自己的大字');
  // 五组对立里最关键的一组：一 vs 多 —— 主体与注脚必须在结构上分得开
  assert.ok(body.includes("'data-main': 'true'"), '内核必须是这一页唯一的主体');
  assert.equal((body.match(/'data-aside': 'true'/g) ?? []).length, 6, '时间轴 + 五块注脚');
  // 阳是实：用量是 3px 实心条；成长记录是实心点，不是记忆海那张网
  assert.ok(/\.ml-yang \.ml-hair\{position:relative;height:3px/.test(source), '用量条要实心、加粗');
  assert.ok(source.includes('.ml-yang .ml-tl::before'), '成长记录要有自己的点');
  assert.equal(source.includes('border-left:1px solid var(--rule)}'), false, '阳不靠细竖线分割');
});
