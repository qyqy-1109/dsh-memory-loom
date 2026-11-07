import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

import { apply, extractUserText, renderInjection, resolveStorePath, shouldNudge, SOURCE_KIND } from '../lib/index.js';

/** 最小 ctx 桩：只提供插件真正用到的表面，任何多余依赖都会在这里暴露。 */
function makeCtx() {
  const tools = [];
  const sections = [];
  const routes = [];
  const listeners = [];
  const webServer = {
    register(route) {
      routes.push(route);
      return () => {};
    },
  };
  const ctx = {
    tools: {
      register(definition) {
        tools.push(definition);
        return () => {};
      },
    },
    systemPrompt: {
      section(section) {
        sections.push(section);
        return () => {};
      },
    },
    effect(factory) {
      const disposer = factory();
      return typeof disposer === 'function' ? disposer : () => {};
    },
    get(name) {
      return name === 'webServer' ? webServer : undefined;
    },
    /** 模拟 ctx.inject(deps, cb)：deps 里有 llm 且测试塞了 llm 时，就把子上下文给回调 */
    inject(deps, callback) {
      if (Array.isArray(deps) && deps.includes('llm') && ctx.llm !== undefined) {
        callback({ llm: ctx.llm });
        return;
      }
      if (typeof callback === 'function') callback({});
    },
    on(event, handler) {
      listeners.push({ event, handler });
    },
    logger: { info() {}, warn() {} },
  };
  return { ctx, tools, sections, routes, listeners };
}

/** 造一个 fake res，把 handler 的输出收下来。 */
function makeRes() {
  return {
    headersSent: false,
    statusCode: 0,
    headers: null,
    body: '',
    writeHead(status, headers) {
      this.statusCode = status;
      this.headers = headers;
    },
    end(body) {
      this.body = body ?? '';
    },
  };
}

/** GET 用的 fake req（无可读体）。 */
function makeReq(method, url, body) {
  const req = {
    method,
    url,
    async *[Symbol.asyncIterator]() {
      if (body === undefined) return;
      yield Buffer.from(JSON.stringify(body), 'utf8');
    },
  };
  return req;
}

async function bootstrap(config = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'loom-host-'));
  const previous = process.env.DSH_HOME;
  process.env.DSH_HOME = dir;
  const stub = makeCtx();
  apply(stub.ctx, config);
  return {
    ...stub,
    dir,
    async cleanup() {
      if (previous === undefined) delete process.env.DSH_HOME;
      else process.env.DSH_HOME = previous;
      await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 60 });
    },
  };
}

test('store 路径：默认落在 $DSH_HOME/memory-loom/store.json', () => {
  const previous = process.env.DSH_HOME;
  try {
    process.env.DSH_HOME = join(tmpdir(), 'dsh-home');
    assert.equal(resolveStorePath({}), join(process.env.DSH_HOME, 'memory-loom', 'store.json'));
  } finally {
    // 没有 DSH_HOME 时回落 ~/.dsh（旧断言拿 '' 当兜底，只在本机恰好设了 DSH_HOME 时才过）。
    delete process.env.DSH_HOME;
    assert.equal(resolveStorePath({}), join(homedir(), '.dsh', 'memory-loom', 'store.json'));
    if (previous !== undefined) process.env.DSH_HOME = previous;
  }
  assert.equal(resolveStorePath({ storePath: 'D:\\tmp\\x.json' }), 'D:\\tmp\\x.json');
});

test('apply：注册 5 个工具、1 段 prompt、1 条 HTTP 前缀路由和 pre-step 监听', async () => {
  const env = await bootstrap();
  try {
    const names = env.tools.map((tool) => tool.name).sort();
    assert.deepEqual(names, ['memory_forget', 'memory_restore', 'memory_search', 'memory_stats', 'memory_write']);
    for (const tool of env.tools) {
      assert.equal(typeof tool.description, 'string');
      assert.ok(tool.description.length > 20, `${tool.name} 缺可用的 description`);
      assert.equal(typeof tool.output.render, 'function');
      assert.equal(tool.output.schema.type, 'object');
      assert.ok(tool.parameters.type === 'object' || Array.isArray(tool.parameters.oneOf), '参数 schema 应是 object 或 oneOf');
    }
    assert.equal(env.sections.length, 1);
    assert.equal(env.sections[0].name, 'memory-loom:policy');
    assert.ok(Number.isFinite(env.sections[0].order));
    assert.equal(env.routes.length, 1);
    assert.equal(env.routes[0].kind, 'prefix');
    assert.equal(env.routes[0].path, '/memory-loom');
    assert.equal(env.listeners.filter((entry) => entry.event === 'agent/pre-step').length, 1);
  } finally {
    await env.cleanup();
  }
});

test('工具闭环：写进去的记忆能被检索到，并在下一轮被注入', async () => {
  const env = await bootstrap();
  try {
    const write = env.tools.find((tool) => tool.name === 'memory_write');
    const search = env.tools.find((tool) => tool.name === 'memory_search');
    const session = { id: 'session-test-1' };

    const written = await write.execute({ kind: 'fact', text: '用户对花生过敏' }, { agent: { session } });
    assert.equal(written.status, 'created');
    assert.ok(written.id.length > 0);
    await write.execute({ kind: 'constraint', text: '不要建议任何含花生的食谱' }, { agent: { session } });

    const found = await search.execute({ query: '花生过敏', kinds: ['fact'] }, { agent: { session } });
    assert.equal(found.results.length, 1);
    assert.ok(found.results[0].score > 0);

    const preStep = env.listeners.find((entry) => entry.event === 'agent/pre-step').handler;
    const decision = {
      kind: 'enter',
      messages: [{ role: 'user', content: [{ type: 'text', text: '花生过敏能吃花生酱吗' }] }],
    };
    const next = async () => decision;
    const out = await preStep({ agent: { session }, step: 1, turn: 1, signal: { aborted: false } }, next);
    assert.equal(out.kind, 'enter');
    assert.equal(out.messages.length, 2);
    const injected = out.messages[1];
    // 会话格式 v4 要求「生产者自有」的 source kind：`plugin:<包名>`，
    // 不能是 V3 的 `kind:'plugin'` 包装（会抛 format v4 message requires a producer-owned source kind）。
    assert.equal(injected.source.kind, SOURCE_KIND);
    assert.ok(injected.source.kind.startsWith('plugin:'));
    assert.notEqual(injected.source.kind, 'plugin');
    assert.equal(injected.source.plugin, undefined);
    assert.ok(injected.content[0].text.includes('花生'));
    assert.ok(injected.content[0].text.includes('<memory-loom>'));
    // 原始 decision 不被就地改写。
    assert.equal(decision.messages.length, 1);

    // 非第一步不再重复注入。
    const second = await preStep({ agent: { session }, step: 2, turn: 1, signal: { aborted: false } }, next);
    assert.equal(second.messages.length, 1);
  } finally {
    await env.cleanup();
  }
});

test('显式触发：用户说「记住…」时原话直接落库，不等模型决定', async () => {
  const env = await bootstrap();
  try {
    const preStep = env.listeners.find((entry) => entry.event === 'agent/pre-step').handler;
    const next = async () => ({
      kind: 'enter',
      messages: [{ role: 'user', content: [{ type: 'text', text: '记住：我家猫叫年糕，三岁了' }] }],
    });
    await preStep({ agent: { session: { id: 's-2' } }, step: 1, turn: 1, signal: { aborted: false } }, next);
    const stats = env.tools.find((tool) => tool.name === 'memory_stats');
    const counts = await stats.execute({}, {});
    assert.equal(counts.explicit, 1);
    assert.equal(counts.active, 1);
  } finally {
    await env.cleanup();
  }
});

test('HTTP：GET /memory-loom/api/state 返回快照与六层健康，且 no-store', async () => {
  const env = await bootstrap();
  try {
    const [route] = env.routes;
    const res = makeRes();
    await route.handler(makeReq('GET', '/memory-loom/api/state'), res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.headers['cache-control'], 'no-store');
    const payload = JSON.parse(res.body);
    assert.equal(payload.health.layers.length, 6);
    assert.equal(payload.counts.active, 0);
    assert.ok(typeof payload.file === 'string' && payload.file.includes('memory-loom'));
    const fileStat = await stat(payload.file).catch(() => null);
    assert.notEqual(fileStat, null, '读取状态后应已建库文件');
  } finally {
    await env.cleanup();
  }
});

test('HTTP：POST 搜索与未知路由的失败语义', async () => {
  const env = await bootstrap();
  try {
    const [route] = env.routes;
    const write = env.tools.find((tool) => tool.name === 'memory_write');
    await write.execute({ kind: 'world', text: '他们的世界设定是夏天很长' }, {});

    const ok = makeRes();
    await route.handler(makeReq('POST', '/memory-loom/api/search', { query: '夏天', limit: 5 }), ok);
    assert.equal(ok.statusCode, 200);
    const payload = JSON.parse(ok.body);
    assert.equal(payload.results.length, 1);

    const missing = makeRes();
    await route.handler(makeReq('GET', '/memory-loom/api/nope'), missing);
    assert.equal(missing.statusCode, 404);
    assert.ok(JSON.parse(missing.body).error.includes('未知路由'));

    const bad = makeRes();
    const rawRequest = (method, url, text) => ({
      method,
      url,
      async *[Symbol.asyncIterator]() {
        yield Buffer.from(text, 'utf8');
      },
    });
    await route.handler(rawRequest('POST', '/memory-loom/api/search', '{坏的 JSON'), bad);
    assert.equal(bad.statusCode, 500);
  } finally {
    await env.cleanup();
  }
});

test('注入文本与用户原话抽取：跳过插件自己注入的消息', () => {
  const messages = [
    { role: 'user', content: [{ type: 'text', text: '第一句' }] },
    {
      role: 'user',
      content: [{ type: 'text', text: '这是插件注入的' }],
      source: { kind: SOURCE_KIND, form: 'snapshot', sections: [] },
    },
    {
      role: 'user',
      content: [{ type: 'text', text: '这是历史残留的旧形状注入' }],
      source: { kind: 'plugin', plugin: 'dsh-memory-loom' },
    },
    { role: 'assistant', content: [{ type: 'text', text: '回答' }] },
  ];
  assert.equal(extractUserText(messages), '第一句');
  const text = renderInjection({
    blocks: [{ name: 'facts', title: '【想起来的事】', text: '- 用户对花生过敏' }],
  });
  assert.ok(text.includes('<memory-loom>'));
  assert.ok(text.includes('【想起来的事】'));
  assert.ok(text.includes('不要向用户汇报'));
});

test('写入提醒：连续多轮没写入时才提醒，提醒后间隔拉长', () => {
  // 前 5 轮不打扰
  for (const turns of [0, 1, 2, 3, 4, 5]) assert.equal(shouldNudge(turns), false, `第 ${turns} 轮不该提醒`);
  // 第 6 轮开始提醒，之后每 4 轮一次
  assert.equal(shouldNudge(6), true);
  for (const turns of [7, 8, 9]) assert.equal(shouldNudge(turns), false);
  assert.equal(shouldNudge(10), true);
  assert.equal(shouldNudge(14), true);
  assert.equal(shouldNudge(18), true);
  // 一直没写也不会每轮都念
  const nudges = Array.from({ length: 40 }, (_, index) => index).filter(shouldNudge);
  assert.ok(nudges.length <= 10, `40 轮里最多提醒 10 次，实际 ${nudges.length}`);
});

test('批量写入：一次调用写多条，各自独立去重', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'loom-batch-'));
  const { ctx, tools } = makeCtx();
  // 关键：必须指向临时库，否则测试会写进用户的真实记忆库（这次就误写过两条）
  apply(ctx, { storePath: join(dir, 'store.json'), injectRecall: false });
  const write = tools.find((tool) => tool.name === 'memory_write');
  const statsTool = tools.find((tool) => tool.name === 'memory_stats');
  const out = await write.execute(
    {
      entries: [
        { kind: 'fact', text: '面板最终形态是 main 一页加侧栏入口' },
        { kind: 'constraint', text: '不要用 PowerShell 回写源码文件' },
        { kind: 'fact', text: '面板最终形态是 main 一页加侧栏入口' },
      ],
    },
    {},
  );
  assert.equal(out.entries.length, 3, '三条都应返回结果');
  assert.equal(out.entries.filter((entry) => entry.status === 'created').length, 2, '重复的那条应被去重');
  assert.equal(out.entries.filter((entry) => entry.status === 'deduped').length, 1);
  const stats = await statsTool.execute({}, {});
  // memory_stats 返回的是扁平计数（不是 counts 包一层）
  assert.ok(Number(stats.active ?? stats.counts?.active ?? 0) >= 2, `两条不同内容应落库，实际 ${JSON.stringify(stats).slice(0, 120)}`);
  await rm(dir, { recursive: true, force: true });
});

test('memory_search 支持只传 since 按日期取时间线（不必走宿主会话检索）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'loom-timeline-'));
  const { ctx, tools } = makeCtx();
  apply(ctx, { storePath: join(dir, 'store.json'), injectRecall: false });
  const write = tools.find((tool) => tool.name === 'memory_write');
  const search = tools.find((tool) => tool.name === 'memory_search');

  await write.execute({ kind: 'episode', text: '下午把面板换成侧栏入口', scene: '桌面', eventDate: '2026-11-06' }, {});
  await write.execute({ kind: 'fact', text: '第二天的结论', eventDate: '2026-11-07' }, {});

  // 只给 since 表示"这天往后"，要精确到某一天就 since+until 传同一天
  const fromDay = await search.execute({ since: '2026-11-07' }, {});
  assert.equal(fromDay.results.length, 1, 'since 之后的条目都应命中');

  const today = await search.execute({ since: '2026-11-06', until: '2026-11-06' }, {});
  assert.equal(today.results.length, 1, 'until 应视为当天 23:59:59');
  assert.match(today.results[0].text, /侧栏入口/);

  const older = await search.execute({ since: '2026-11-01', until: '2026-11-05' }, {});
  assert.equal(older.results.length, 0, '范围外应为空');
  await rm(dir, { recursive: true, force: true });
});

test('pre-step：关掉 injectRecall 仍然会写入（写入与注入解耦）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'loom-decouple-'));
  const { ctx, tools, listeners } = makeCtx();
  apply(ctx, { storePath: join(dir, 'store.json'), injectRecall: false });

  const handler = listeners.find((item) => item.event === 'agent/pre-step')?.handler;
  assert.ok(typeof handler === 'function', '必须注册 agent/pre-step');

  const decision = { kind: 'continue', messages: [{ role: 'user', content: [{ type: 'text', text: '记住：我不吃香菜' }] }] };
  const out = await handler({ step: 1, agent: { session: { id: 'session-other' } } }, async () => decision);
  await new Promise((resolve) => setTimeout(resolve, 20));

  const search = tools.find((tool) => tool.name === 'memory_search');
  const found = await search.execute({ query: '香菜' }, {});
  assert.ok(found.results.length >= 1, '关掉注入时也必须把「记住…」写进去');
  assert.match(found.results[0].text, /香菜/);
  // 注入关闭 → 不该往 messages 里追加召回块
  assert.equal(out.messages.length, decision.messages.length, 'injectRecall=false 不应追加注入消息');
  await rm(dir, { recursive: true, force: true });
});

test('pre-step：另一个会话的定稿口吻也会写入（跨会话写入通道）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'loom-cross-'));
  const { ctx, tools, listeners } = makeCtx();
  apply(ctx, { storePath: join(dir, 'store.json') });

  const handler = listeners.find((item) => item.event === 'agent/pre-step')?.handler;
  const decision = { kind: 'continue', messages: [{ role: 'user', content: [{ type: 'text', text: '改成左侧导航入口' }] }] };
  await handler({ step: 1, agent: { session: { id: 'session-other' } } }, async () => decision);
  await new Promise((resolve) => setTimeout(resolve, 20));

  const search = tools.find((tool) => tool.name === 'memory_search');
  const found = await search.execute({ query: '左侧导航入口' }, {});
  assert.ok(found.results.length >= 1, '定稿口吻应被写入');
  await rm(dir, { recursive: true, force: true });
});

test('memory_restore 工具：单条恢复与整组撤销归纳', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'loom-res-tool-'));
  const { ctx, tools } = makeCtx();
  apply(ctx, { storePath: join(dir, 'store.json'), injectRecall: false });
  const write = tools.find((tool) => tool.name === 'memory_write');
  const forget = tools.find((tool) => tool.name === 'memory_forget');
  const restore = tools.find((tool) => tool.name === 'memory_restore');
  const search = tools.find((tool) => tool.name === 'memory_search');
  assert.ok(restore !== undefined, '必须注册 memory_restore');

  const created = await write.execute({ kind: 'fact', text: '面板用侧栏入口' }, {});
  await forget.execute({ id: created.id }, {});
  // 归档后默认仍可检索（archived=true），但显式关掉就必须搜不到
  const stillFound = await search.execute({ query: '侧栏入口' }, {});
  assert.ok(stillFound.results.some((row) => row.archived === true), '归档条目默认应可检索且带 archived 标记');
  assert.equal(
    (await search.execute({ query: '侧栏入口', includeArchived: false }, {})).results.length,
    0,
    'includeArchived=false 时不该出现归档条目',
  );

  const back = await restore.execute({ id: created.id }, {});
  assert.equal(back.ok, true);
  assert.equal(back.restored, 1);
  assert.ok((await search.execute({ query: '侧栏入口' }, {})).results.length >= 1, '恢复后应能被检索到');

  const again = await restore.execute({ id: created.id }, {});
  assert.equal(again.ok, false);
  assert.equal(again.reason, 'already-active');
  await rm(dir, { recursive: true, force: true });
});

test('模型归纳接入：有 llm 时摘要被重写，没有时保持抽取式且写入不被拖住', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'loom-llm-'));
  const factory = () => {
    const state = { release: null };
    const service = {
      calls: [],
      async listProviders() {
        return ['test-provider'];
      },
      async listModels() {
        return ['test-model'];
      },
      async prepareCall(config) {
        service.calls.push(config);
        return { config };
      },
      async *stream() {
        // 卡住，直到测试显式放行 —— 用来证明写入没有被模型拖住
        await new Promise((resolve) => {
          state.release = resolve;
        });
        yield { type: 'text-delta', index: 0, text: '模型写出来的摘要。' };
        yield { type: 'finish', reason: 'stop' };
      },
    };
    return { service, state };
  };

  const { service, state } = factory();
  const { ctx, tools } = makeCtx();
  ctx.llm = service;
  apply(ctx, {
    storePath: join(dir, 'store.json'),
    injectRecall: false,
    compactAt: 12,
    summaryMinMembers: 6,
    maxActiveMemories: 300,
  });

  const write = tools.find((tool) => tool.name === 'memory_write');
  for (let i = 0; i < 18; i += 1) {
    await write.execute({ kind: 'fact', text: `渲染帧率在第 ${i} 种场景下需要自适应降档以保持流畅` }, {});
  }

  // 写入路径没有被模型卡住：摘要已经生成，且此时文本仍是抽取式
  const stats = tools.find((tool) => tool.name === 'memory_stats');
  const before = await stats.execute({}, {});
  assert.ok(before.summaries >= 1, '压缩应当已经产出摘要');
  let summaries = JSON.parse((await readFile(join(dir, 'store.json'), 'utf8'))).summaries;
  assert.equal(summaries[0].generator, 'extractive', '模型还没回，摘要必须是能用的抽取式');

  // 放行模型
  if (state.release !== null) state.release();
  await new Promise((resolve) => setTimeout(resolve, 60));

  summaries = JSON.parse((await readFile(join(dir, 'store.json'), 'utf8'))).summaries;
  assert.equal(summaries[0].generator, 'llm', '模型返回后应标记为 llm');
  assert.equal(summaries[0].text, '模型写出来的摘要。');
  assert.ok(service.calls.length >= 1, '应当真的走了一次 prepareCall');
  await rm(dir, { recursive: true, force: true });
});

test('模型归纳失败：摘要保持抽取式，错误只留痕不抛给写入', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'loom-llmf-'));
  const { ctx, tools } = makeCtx();
  ctx.llm = {
    async listProviders() {
      return ['broken'];
    },
    async listModels() {
      return ['m'];
    },
    async prepareCall(config) {
      return { config };
    },
    async *stream() {
      throw new Error('模型挂了');
    },
  };
  apply(ctx, {
    storePath: join(dir, 'store.json'),
    injectRecall: false,
    compactAt: 12,
    summaryMinMembers: 6,
    maxActiveMemories: 300,
  });
  const write = tools.find((tool) => tool.name === 'memory_write');
  for (let i = 0; i < 18; i += 1) {
    await write.execute({ kind: 'fact', text: `宿主侧栏宽度可以拖拽调整 第 ${i} 次验证有效` }, {});
  }
  await new Promise((resolve) => setTimeout(resolve, 60));
  const summaries = JSON.parse((await readFile(join(dir, 'store.json'), 'utf8'))).summaries;
  assert.ok(summaries.length >= 1);
  assert.equal(summaries[0].generator, 'extractive', '失败必须保留抽取式');
  assert.match(String(summaries[0].llmError ?? ''), /模型挂了/);
  await rm(dir, { recursive: true, force: true });
});
