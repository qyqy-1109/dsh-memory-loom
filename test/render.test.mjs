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
        registered.set(definition.name, target);
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
  const page = captureComponent(loaded, 'main');
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

test('历史回顾页签：滑杆与那一刻的记忆列表都在（时间轴已从画面底部搬走）', async () => {
  installDom();
  // 星图主循环用 rAF 自驱动；默认桩会同步回调 → 递归爆栈，这里改成只登记不执行
  globalThis.requestAnimationFrame = () => 1;
  globalThis.cancelAnimationFrame = () => {};
  const { loaded, hooks } = await loadPlugin();
  const page = captureComponent(loaded, 'main');
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

  // ② 侧栏「历史回顾」页签里必须有滑杆，并且能列出"那一刻已有的记忆"
  const pane = loaded.__internals.HistoryPane;
  assert.equal(typeof pane, 'function', '必须导出 HistoryPane 以便离线验证');
  const { tree: paneTree } = renderRoot(
    () => pane({ memories, scrubAt: 1500, onScrub: () => {}, onPick: () => {} }),
    hooks,
  );
  const ranges = findAll(paneTree, (node) => node.type === 'input' && node.props?.type === 'range');
  assert.equal(ranges.length, 1, '历史回顾里必须有回放滑杆');
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
  const icon = captureComponent(loaded, 'sidebar.panellist');
  const { tree, errors } = renderRoot(() => icon({ size: 18, active: true }), hooks);
  assert.deepEqual(errors.map((e) => e.message), []);
  assert.equal(tree.type, 'svg', '入口应该是内联 SVG');
  assert.equal(tree.props.width, 18);
  assert.equal(tree.props.height, 18);
  assert.equal(findAll(tree, (node) => node.type === 'circle').length, 3, '三个星点');
  const dimmed = findAll(tree, (node) => node.type === 'circle' && node.props.opacity === 1);
  assert.ok(dimmed.length >= 1, '选中态下星点应更亮');
});
