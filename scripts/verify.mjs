/**
 * 交付前的一次性门禁（不随包分发）：用**本机真实安装**的 DSH 运行时校验两件事。
 *
 *  1) 工具 schema 真的落在 `@deepseek-ai/dsh-tools` 支持的 JSON Schema 子集里
 *     —— 这条不通过，插件装上会在注册期就抛错，而不是等用户点开面板。
 *  2) client bundle 能在 `window.__ModuleLoader__` 契约下被加载，并且真的注册到
 *     `conversation.session.header.actions` 槽位。
 *
 * 用法：
 *   node scripts/verify.mjs
 * 运行环境：
 *   需要本机装着 DSH 桌面版（校验的对象就是它的 dsh-tools 与 client loader）。
 *   默认会去 `$DSH_HOME/profiles/node_modules` 和 `%LOCALAPPDATA%\Programs\*\resources\dsh\node_modules`
 *   里找；装在别处就显式指：
 *   DSH_NODE_MODULES=<DSH 安装目录>/resources/dsh/node_modules
 */

import { existsSync, readdirSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * 定位 DSH 运行时的 node_modules。
 *
 * 这里原来写死了一个 `C:\Users\<用户名>\...` 路径 —— 换台机器就废，发到 GitHub 上更是没法用。
 * 现在按「环境变量 → profile 的 node_modules（里面 @deepseek-ai/* 是 junction）→ 各安装目录」找，
 * 一个都找不到就明确报错，而不是拿死路径去 import。
 *
 * @returns {string}
 */
function findDshNodeModules() {
  const explicit = process.env.DSH_NODE_MODULES?.trim();
  if (explicit !== undefined && explicit.length > 0) return explicit;

  const home = process.env.DSH_HOME?.trim() ?? join(homedir(), '.dsh');
  const candidates = [join(home, 'profiles', 'node_modules')];
  for (const root of [process.env.LOCALAPPDATA, process.env.APPDATA]) {
    if (typeof root !== 'string' || root.length === 0) continue;
    const programs = join(root, 'Programs');
    if (!existsSync(programs)) continue;
    for (const name of readdirSync(programs)) {
      candidates.push(join(programs, name, 'resources', 'dsh', 'node_modules'));
    }
  }

  for (const candidate of candidates) {
    if (existsSync(join(candidate, '@deepseek-ai', 'dsh-tools'))) return candidate;
  }
  console.error('找不到 DSH 运行时的 node_modules。请设置环境变量：');
  console.error('  DSH_NODE_MODULES=<DSH 安装目录>/resources/dsh/node_modules');
  process.exit(1);
}

const NODE_MODULES = findDshNodeModules();

const failures = [];
const checks = [];

function check(name, run) {
  return Promise.resolve()
    .then(run)
    .then(() => checks.push(`PASS  ${name}`))
    .catch((error) => {
      failures.push(`FAIL  ${name}: ${error instanceof Error ? error.message : String(error)}`);
    });
}

// ── ① 真实 dsh-tools 校验工具 schema ──
const toolsModuleUrl = pathToFileURL(join(NODE_MODULES, '@deepseek-ai', 'dsh-tools', 'lib', 'index.js')).href;
const { assertSupportedJsonSchema } = await import(toolsModuleUrl);

const captured = { tools: [], sections: [], routes: [], listeners: [] };
const stubCtx = {
  tools: {
    register(definition) {
      captured.tools.push(definition);
      return () => {};
    },
  },
  systemPrompt: {
    section(section) {
      captured.sections.push(section);
      return () => {};
    },
  },
  effect(factory) {
    factory();
    return () => {};
  },
  get() {
    return { register(route) {
      captured.routes.push(route);
      return () => {};
    } };
  },
  inject() {},
  on(event, handler) {
    captured.listeners.push({ event, handler });
  },
  logger: { info() {}, warn() {} },
};

const host = await import(pathToFileURL(join(process.cwd(), 'lib', 'index.js')).href);
host.apply(stubCtx, {});

await check('host: 没有 default 导出（否则 loader 会丢掉 inject 声明）', () => {
  if (host.default !== undefined) throw new Error('module.default exists — loader takes `module.default || module` and drops `inject`');
  if (!Array.isArray(host.inject) || host.inject.length === 0) throw new Error('missing inject export');
  if (typeof host.apply !== 'function') throw new Error('missing apply export');
});

await check('host: 注册了 5 个工具', () => {
  if (captured.tools.length !== 5) throw new Error(`expected 5 tools, got ${captured.tools.length}`);
});

for (const tool of captured.tools) {
  await check(`schema: ${tool.name}.parameters 属于受支持子集`, () => {
    assertSupportedJsonSchema(tool.parameters);
  });
  await check(`schema: ${tool.name}.output.schema 属于受支持子集`, () => {
    assertSupportedJsonSchema(tool.output.schema);
  });
}

await check('host: prompt 段落 order 是有限数', () => {
  const section = captured.sections[0];
  if (section === undefined || !Number.isFinite(section.order)) throw new Error('missing prompt section order');
});

await check('host: 注册了 /memory-loom 前缀路由', () => {
  if (captured.routes[0]?.path !== '/memory-loom') throw new Error('missing prefix route');
});

await check('host: 注册了 agent/pre-step 监听', () => {
  if (!captured.listeners.some((entry) => entry.event === 'agent/pre-step')) throw new Error('missing pre-step listener');
});

await check('host: 导出/导入路由都在（面板的两个管理动作）', async () => {
  // 面板只发请求，路由漏挂就是「按钮点了没反应」，所以静态盯一眼
  const indexSource = await readFile(join(process.cwd(), 'lib', 'index.js'), 'utf8');
  for (const branch of ["route === 'api/export'", "route === 'api/import'", "route === 'api/tidy'"]) {
    if (!indexSource.includes(branch)) throw new Error(`缺少路由分支 ${branch}`);
  }
});

// ── ② client bundle 在模块加载器契约下真的注册了插槽 ──
const source = await readFile(join(process.cwd(), 'lib', 'client.js'), 'utf8');

await check('client: 页脚版本与 package.json 一致', async () => {
  // 页脚上那个版本号是给人核对「页面到底跑哪一版」的，漂了就等于没有
  const pkg = JSON.parse(await readFile(join(process.cwd(), 'package.json'), 'utf8'));
  if (!source.includes(`CLIENT_VERSION = '${pkg.version}'`)) {
    throw new Error(`页脚版本与包版本不一致：package.json 是 ${pkg.version}`);
  }
});

await check('client: 星图点选走 focusFromStar，且点击判定不依赖残留标记', () => {
  // 这两个都是踩过的坑：点星被上一次拖动的残留标记吞掉；点了星却因为筛选看不到那一行
  if (!source.includes('onSelect: focusFromStar')) throw new Error('星图点选没有接到 focusFromStar');
  if (!source.includes('isClickGesture(')) throw new Error('点击判定应当用 isClickGesture（位移+时长现算）');
  if (/if \(model\.dragMoved\) \{/.test(source)) throw new Error('还在用 dragMoved 做点击判定：拖动后第一次点击会被吞');
});

await check('client: 列表滚下去后有「回到顶端」', () => {
  if (!source.includes('ml-top')) throw new Error('缺少回到顶端按钮的样式/类名');
  if (!source.includes('shouldShowTop(')) throw new Error('按钮显隐应当走 shouldShowTop');
  if (!source.includes("scrollTo({ top: 0")) throw new Error('按钮没有真正滚回顶端');
});

await check('client: 面板有导出/导入入口（导入要二次确认）', () => {
  if (!source.includes('/memory-loom/api/export')) throw new Error('面板没有导出入口');
  if (!source.includes("postAction('import'")) throw new Error('面板没有导入入口');
  if (!source.includes('pendingImport')) throw new Error('导入缺少「选完文件再确认」的中间态');
});

await check('client: bundle 以 window.__ModuleLoader__.load 包装', () => {
  if (!source.includes('__ModuleLoader__.load')) throw new Error('bundle is not wrapped for the module loader');
});

const registrations = [];
const fakeReact = {
  createElement: (...args) => ({ type: 'element', args }),
  Fragment: Symbol('Fragment'),
  useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
  useEffect: () => {},
  useRef: () => ({ current: null }),
  useCallback: (fn) => fn,
  useMemo: (fn) => fn(),
};
const fakeRequire = (id) => {
  if (id === 'react') return fakeReact;
  if (id === 'react-dom') return { createPortal: (node) => node };
  if (id === 'react/jsx-runtime') return {};
  throw new Error(`client bundle required an unexpected module: ${id}`);
};

let clientExports;
const fakeDocument = {
  querySelector: () => null,
  createElement: () => ({ dataset: {}, textContent: '' }),
  head: { appendChild: () => {} },
  body: {},
  addEventListener: () => {},
  removeEventListener: () => {},
};
globalThis.document = fakeDocument;
globalThis.window = {
  __ModuleLoader__: {
    load({ id, factory }) {
      if (id !== 'dsh-memory-loom') throw new Error(`unexpected bundle id ${id}`);
      clientExports = factory(fakeRequire);
    },
  },
};
// 在 Node 里执行浏览器 bundle：只依赖 window/document 两个假壳。
new Function(source)();
void registrations;

await check('client: factory 返回 apply/inject', () => {
  if (typeof clientExports?.apply !== 'function') throw new Error('apply missing');
  if (!Array.isArray(clientExports?.inject) || !clientExports.inject.includes('slots')) throw new Error('inject missing slots');
});

// 图层顺序与透明通道：这两条出过真事故（星云盖住画布 → 只剩背景没有星）
await check('client: 星云在画布之下（canvas z-index 必须高于 nebula）', () => {
  const canvasRule = /\.ml-canvas\{([^}]*)\}/.exec(source);
  const nebulaRule = /\.ml-nebula\{([^}]*)\}/.exec(source);
  if (canvasRule === null || nebulaRule === null) throw new Error('缺少 .ml-canvas 或 .ml-nebula 规则');
  const zIndexOf = (body) => {
    const match = /z-index:\s*(-?\d+)/.exec(body);
    return match === null ? null : Number(match[1]);
  };
  const canvasZ = zIndexOf(canvasRule[1]);
  const nebulaZ = zIndexOf(nebulaRule[1]);
  if (canvasZ === null || nebulaZ === null) throw new Error('两个图层都必须显式声明 z-index');
  if (canvasZ <= nebulaZ) throw new Error(`canvas z-index(${canvasZ}) 必须大于 nebula(${nebulaZ})，否则星星会被盖住`);
});

await check('client: 视图按钮在画布之上（否则点击会被 canvas 吃掉）', () => {
  const canvasRule = /\.ml-canvas\{([^}]*)\}/.exec(source);
  const toolsRule = /\.ml-viewtools\{([^}]*)\}/.exec(source);
  if (canvasRule === null || toolsRule === null) throw new Error('缺少 .ml-canvas 或 .ml-viewtools 规则');
  const zIndexOf = (body) => {
    const match = /z-index:\s*(-?\d+)/.exec(body);
    return match === null ? null : Number(match[1]);
  };
  const canvasZ = zIndexOf(canvasRule[1]);
  const toolsZ = zIndexOf(toolsRule[1]);
  if (toolsZ === null) throw new Error('.ml-viewtools 必须显式声明 z-index');
  if (toolsZ <= canvasZ) throw new Error(`viewtools z-index(${toolsZ}) 必须大于 canvas(${canvasZ})，否则按钮点不动`);
});

await check('client: 面板是 main 槽里的一页（不用 fixed / top layer / 右侧栏）', () => {
  if (/\bshowModal\s*\(/.test(source)) throw new Error('面板不得使用 dialog.showModal()');
  const pageRule = /\.ml-page\{([^}]*)\}/.exec(source);
  if (pageRule === null) throw new Error('缺少 .ml-page 规则');
  if (/position:\s*fixed/.test(pageRule[1])) throw new Error('.ml-page 不能是 fixed 覆盖层');
  if (!/width:100%/.test(pageRule[1]) || !/height:100%/.test(pageRule[1])) {
    throw new Error('.ml-page 应当铺满宿主给的面板区域');
  }
  if (/\.ml-dock\{/.test(source)) throw new Error('不应再有右侧栏容器');
});

await check('client: 星云导出为 PNG（JPEG 会丢透明通道把画布压黑）', () => {
  if (source.includes("toDataURL('image/jpeg'")) throw new Error('星云底不能用 JPEG 导出：没有 alpha 会整块不透明');
  if (!source.includes("toDataURL('image/png')")) throw new Error('星云底应导出为 PNG');
});

await check('client: 注册 main 页面 + 侧栏导航入口', () => {
  const seen = [];
  const clientCtx = {
    slots: {
      inject(key, callback) {
        seen.push(`inject:${key}`);
        callback();
      },
      register(options, component) {
        seen.push(`register:${options.name}:${options.key ?? options.id}`);
        if (typeof component !== 'function') throw new Error('slot component is not a component');
        if (options.name === 'main' && options.key === undefined) throw new Error('main 是 keyed 槽，必须带 key');
        return () => {};
      },
    },
  };
  clientExports.apply(clientCtx);
  for (const expected of [
    'inject:main',
    'register:main:memory-loom',
    'inject:sidebar.panellist',
    'register:sidebar.panellist:memory-loom',
  ]) {
    if (!seen.includes(expected)) throw new Error(`缺少 ${expected}，saw ${seen.join(',')}`);
  }
});

// ── 报告 ──
for (const line of checks) console.log(line);
if (failures.length > 0) {
  for (const line of failures) console.error(line);
  console.error(`\n${failures.length} 项未通过`);
  process.exit(1);
}
console.log(`\n${checks.length} 项全部通过`);
