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

import { existsSync, readdirSync, readFileSync } from 'node:fs';
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

await check('host: 注册了 8 个工具', () => {
  if (captured.tools.length !== 8) throw new Error(`expected 8 tools, got ${captured.tools.length}`);
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

await check('client: 金线可以整类关掉（库里只有一两条时不至于扎眼）', () => {
  if (!source.includes('showGold')) throw new Error('缺少金线开关（showGold）');
  if (!source.includes("t('金线')")) throw new Error('缺少金线按钮');
});

await check('client: 拖拽按增量推进（不在 clamp 上"还债"）', () => {
  if (!source.includes('stepOrbit(')) throw new Error('拖拽没有走 stepOrbit');
  if (/model\.dragging\.pitch - dy \* 0\.006/.test(source)) {
    throw new Error('俯仰还在按"离按下点的总位移"算：冲过上限后回拖会先还债，手感就是卡');
  }
});

await check('client: 样式表按版本注入（否则改了 CSS 页面上看不到变化）', () => {
  // 只按固定 id 判断"注入过没有"时，client 热重载会拿到新 JS + 旧 CSS：
  // 表现就是"CSS 明明改了，界面还是老样子"
  if (!source.includes('panel.css@${CLIENT_VERSION}')) throw new Error('样式表 id 必须带版本号');
  if (!source.includes('node?.remove')) throw new Error('换版本时要把旧样式表摘掉');
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

await check('client: 成长页签在，且读数走宿主的同一份函数', () => {
  if (!source.includes("['growth'")) throw new Error('面板没有成长页签');
  if (!source.includes('/memory-loom/api/growth')) throw new Error('面板没有去拉成长读数');
  if (!source.includes('function GrowthPane')) throw new Error('缺少成长页签的组件');
});

await check('client: 人格页的内核编辑器必须带理由输入（不许绕过"理由必填"）', () => {
  if (!source.includes("postAction('self'")) throw new Error('面板没有走人格的 API');
  if (!source.includes('这次改了什么')) throw new Error('缺少理由输入框：成长记录就成了没有注释的文本');
  if (source.includes("action: 'rewrite'")) throw new Error('整段重写的入口必须已经下线（只允许 add / merge / retire）');
  if (!source.includes('「人格」页')) throw new Error('成长页签要指向人格页，否则人找不到编辑口');
});

await check('client: 成长记录里有按流水回退的入口（且回退理由必填）', () => {
  if (!source.includes('回到这一步之前')) throw new Error('缺少回退按钮');
  if (!source.includes('回退理由（必填）')) throw new Error('回退也要写理由：不然历史又变成没有注释的文本');
  if (!source.includes("action: 'restore'")) throw new Error('面板没有调回退的 API');
});

await check('host: bundle patch 里的 name 必须等于 package.json 的 name', () => {
  // 加载器按这个名字去 profile 的 node_modules 里找模块。两者不一致 = 插件整块装不上，
  // 而且症状很误导：服务端和客户端的侧栏入口一起消失，看起来像"面板坏了"。
  const pkg = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8'));
  const patch = readFileSync(join(process.cwd(), 'cordis.patch.yml'), 'utf8');
  const matched = /name:\s*"?([^"\s]+)"?/.exec(patch);
  if (matched === null) throw new Error('cordis.patch.yml 里找不到 name');
  if (matched[1] !== pkg.name) {
    throw new Error(`包名不一致：package.json 是 ${pkg.name}，cordis.patch.yml 是 ${matched[1]} —— 改名要一起改`);
  }
});

await check('client: 人格页必须自己轮询（写库的常常不是这一页）', () => {
  const start = source.indexOf('function PersonaPage');
  const body = start < 0 ? '' : source.slice(start, source.indexOf('function MemorySeaPage'));
  if (!body.includes('setInterval(() => load(), 5000)')) {
    throw new Error('人格页只在挂载时读一次：模型用 memory_self 写完，页面不会自己更新');
  }
  if (!body.includes('signatureRef')) throw new Error('轮询没有内容签名：每 5 秒会白掉一帧');
});

await check('host: 还没说完的线索有硬上限，注入与读数用同一份产出', () => {
  const storeSource = readFileSync(join(process.cwd(), 'lib', 'store.js'), 'utf8');
  const growthSource = readFileSync(join(process.cwd(), 'lib', 'growth.js'), 'utf8');
  const hostSource = readFileSync(join(process.cwd(), 'lib', 'index.js'), 'utf8');
  if (!storeSource.includes('export function loopsBlockOf')) throw new Error('缺少统一的线索块产出函数');
  if (!growthSource.includes('loopsBlockOf')) throw new Error('成长读数没算这一块：曲线又会替自己的开销打掩护');
  if (!hostSource.includes("name: 'memory_loop'")) throw new Error('缺少记线索的工具');
  if (!source.includes('还没说完')) throw new Error('面板上没有这一块');
});

await check('host: 压缩按冗余触发，且原文不许被修剪掉', () => {
  const storeSource = readFileSync(join(process.cwd(), 'lib', 'store.js'), 'utf8');
  if (!storeSource.includes('compactCooldownMs')) throw new Error('压缩又回到"库存到 1200 才跑"了');
  if (!storeSource.includes('summarizedBy == null')) throw new Error('归档修剪没跳过被摘要盖住的原文：摘要会指着空气');
  if (!storeSource.includes("export const EVICTABLE = new Set(['fact', 'self', 'episode'])")) {
    throw new Error('EVICTABLE 变了：summary 不许进可压缩集合（两代封顶）');
  }
});

await check('host: 模型路由有诊断口（拿不到路由时不许只能靠猜）', () => {
  const hostSource = readFileSync(join(process.cwd(), 'lib', 'index.js'), 'utf8');
  if (!hostSource.includes("route === 'api/llm'")) throw new Error('缺少 GET /api/llm 诊断口');
  for (const field of ['hasService', 'providers', 'route', 'describe']) {
    if (!hostSource.includes(field)) throw new Error(`诊断报告缺字段 ${field}`);
  }
});

await check('host: 旧摘要能用模型重写（抽取式的要补得上）', () => {
  const hostSource = readFileSync(join(process.cwd(), 'lib', 'index.js'), 'utf8');
  const storeSource = readFileSync(join(process.cwd(), 'lib', 'store.js'), 'utf8');
  if (!hostSource.includes("route === 'api/summaries/rewrite'")) throw new Error('缺少摘要重写路由');
  if (!storeSource.includes('summaryPayload(')) throw new Error('缺少重写材料来源');
  if (!storeSource.includes("row.generator = 'llm'")) throw new Error('重写后要标成 llm，否则看不出哪条还是抽取式的');
});

await check('client: 出处面板在纸色页不许用深色卡片的控件', () => {
  if (!source.includes("buttonClass: 'ml-ybtn', noteClass: 'ml-quiet'")) {
    throw new Error('人格页没给 TracePanel 传纸色类名：收起按钮会变成一个小黑框');
  }
});

await check('client: showTrace 每页各有一份，出处面板只有一处实现', () => {
  const defs = source.split('const showTrace = React.useCallback').length - 1;
  if (defs < 2) throw new Error(`showTrace 只定义了 ${defs} 份：另一页引用它会 ReferenceError（0.61 就是这么白屏的）`);
  if (!source.includes('function TracePanel')) throw new Error('出处面板没有统一实现');
  if (!source.includes("h(TracePanel, { trace, onClose: () => setTrace(null) })")) throw new Error('人格页没用统一面板');
  const seaStart = source.indexOf('function MemorySeaPage');
  const seaBody = seaStart < 0 ? '' : source.slice(seaStart, seaStart + 60_000);
  if (!seaBody.includes('h(TracePanel')) throw new Error('记忆海这边没挂出处面板');
});

await check('client: 两页都包在错误边界里（白屏不许再发生）', () => {
  if (!source.includes('class PaneBoundary extends React.Component')) throw new Error('没有错误边界');
  if (!source.includes("withBoundary(MemorySeaPage, '记忆海')")) throw new Error('记忆海没包边界');
  if (!source.includes("withBoundary(PersonaPage, '人格')")) throw new Error('人格页没包边界');
  if (!source.includes("kind: 'render-error'")) throw new Error('渲染错误没有写进 diag，排查只能靠猜');
});

await check('client: 时间轴可以收起，选择记在本地', () => {
  if (!source.includes('memory-loom:timeline')) throw new Error('时间轴没有记住用户的收起/展开选择');
  if (!source.includes("timelineOpen ? '收起' : '展开'")) throw new Error('缺少收起/展开按钮');
});

await check('host: 引用链与时间轴两个只读路由都在', () => {
  const hostSource = readFileSync(join(process.cwd(), 'lib', 'index.js'), 'utf8');
  for (const route of ['api/trace', 'api/timeline']) {
    if (!hostSource.includes(route)) throw new Error(`缺少只读路由 ${route}`);
  }
  if (!source.includes('api/trace?kind=')) throw new Error('面板没有去拉引用链');
  if (!source.includes('api/timeline?days=')) throw new Error('面板没有去拉时间轴');
});

await check('host: 召回快照必须带出每块的 ids（否则「这一轮想起了哪几条」根本没传出去）', () => {
  const storeSource = readFileSync(join(process.cwd(), 'lib', 'store.js'), 'utf8');
  if (!/blocks: blocks\.map\(\(block\) => \(\{[\s\S]{0,500}?ids:/.test(storeSource)) {
    throw new Error('buildRecall 返回的 blocks 没带 ids：消融会永远判成"没召回"，引用链也说不清想起了哪几条');
  }
});

await check('host: 出处（sources）写得进、落得下、反查得到', () => {
  const storeSource = readFileSync(join(process.cwd(), 'lib', 'store.js'), 'utf8');
  const hostSource = readFileSync(join(process.cwd(), 'lib', 'index.js'), 'utf8');
  if (!hostSource.includes('sources: {')) throw new Error('memory_write 的 schema 里没有 sources');
  if (!storeSource.includes('row.sources.push(sourceId)')) throw new Error('写入时没有把出处落到条目上');
  if (!storeSource.includes("edge: 'derived'")) throw new Error('引用链没把「被拿去用了」这条边标出来');
  if (!storeSource.includes('derivedBy')) throw new Error('面板快照没有 derivedBy：看不出哪条被用上了');
});

await check('host: 消融是单条实验，不做排行', () => {
  const hostSource = readFileSync(join(process.cwd(), 'lib', 'index.js'), 'utf8');
  if (!hostSource.includes('api/ablate')) throw new Error('缺少消融路由');
  if (!existsSync(join(process.cwd(), 'lib', 'ablate.js'))) throw new Error('缺少 ablate.js');
  if (!source.includes('消融一次')) throw new Error('面板上没有消融入口');
  if (!source.includes('不等于那一轮真被用上了')) {
    throw new Error('消融的边界说明被删了：抽样一旦被当统计读，就是 used 那个坑换了个坑口');
  }
  if (!source.includes("'用上了'")) throw new Error('引用链里没把「用上了」和「被引用」分开标');
});

await check('host: 私人记录与记忆库在结构上不相通', () => {
  const storeSource = readFileSync(join(process.cwd(), 'lib', 'store.js'), 'utf8');
  const hostSource = readFileSync(join(process.cwd(), 'lib', 'index.js'), 'utf8');
  // 只看真正的 import，不看注释里提到这个名字
  if (/from\s+['"][^'"]*private\.js['"]/.test(storeSource)) {
    throw new Error('store.js import 了 private.js：私人记录会漏进检索与注入，那块地方就废了');
  }
  if (!hostSource.includes("name: 'memory_private'")) throw new Error('缺少 private 记录的写入口');
  if (!existsSync(join(process.cwd(), 'lib', 'private.js'))) throw new Error('缺少 private.js');
});

await check('host: 取舍账本 kind=choice 三键齐且不注入', () => {
  const storeSource = readFileSync(join(process.cwd(), 'lib', 'store.js'), 'utf8');
  const hostSource = readFileSync(join(process.cwd(), 'lib', 'index.js'), 'utf8');
  if (!storeSource.includes("choice: '取舍'")) throw new Error('store 里没有 choice 这个 kind');
  if (!hostSource.includes('choicePicked')) throw new Error('工具 schema 缺 choicePicked：只写选了什么，读不出偏好');
  if (!storeSource.includes('skipDedupe')) throw new Error('取舍不许查重：去重会把频次吃掉');
  if (!source.includes("'choice'")) throw new Error('面板的 kind 表里没有 choice');
});

await check('client: 迁移读数在面板里，且写明它的边界', () => {
  if (!source.includes('transfer.tracked')) throw new Error('面板没显示迁移读数');
  if (!source.includes('不说明它在那件事上改变了判断')) {
    throw new Error('迁移的边界说明被删了：「想起」不等于「改变了判断」，不写这句就会被当结论读');
  }
});

await check('client: bundle 以 window.__ModuleLoader__.load 包装', () => {
  if (!source.includes('__ModuleLoader__.load')) throw new Error('bundle is not wrapped for the module loader');
});

const registrations = [];
const fakeReact = {
  createElement: (...args) => ({ type: 'element', args }),
  Fragment: Symbol('Fragment'),
  /** 错误边界是 class 组件，桩里也必须有 React.Component。 */
  Component: class Component {
    constructor(props) {
      this.props = props;
      this.state = {};
    }
    setState() {}
  },
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
  if (!/width:100%/.test(pageRule[1]) || !/height:(100%|var\(--ml-page-h)/.test(pageRule[1])) {
    throw new Error('.ml-page 应当铺满宿主给的面板区域（height:100% 或 var(--ml-page-h)）');
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
