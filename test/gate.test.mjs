import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { MemoryStore } from '../lib/store.js';
import { buildCorpus, contentTokens } from '../lib/rank.js';
import { tokenize } from '../lib/text.js';

/**
 * 读闸门：这条查询到底有没有「可检索的内容」。
 *
 * 为什么不是「相关不相关」：实测过，判不出来。
 * 覆盖率的分母只有查询词，所以短查询撞上一个二元组就是 1.0 ——
 * 真实库上「继续」「现在几点了」的峰值覆盖率都是 1.000，比一半的真相关查询还高。
 * 换成「命中的内容词个数」才分得开：12 条无关查询里 9 条内容词不足 2 个。
 */

async function makeStore(overrides = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'loom-gate-'));
  const store = new MemoryStore({ file: join(dir, 'store.json'), ...overrides });
  await store.open();
  return { store, dir, cleanup: () => rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 60 }) };
}

/** 一个真实的库：12 条，够触发「饱和词」判定。 */
async function seed(store) {
  await store.write({ kind: 'constraint', text: '不要用 Get-Content 管道改源码，会写 BOM' });
  await store.write({ kind: 'world', text: '记忆面板是三维星图，走 Canvas 2D 真实透视' });
  await store.write({ kind: 'world', text: '渲染帧率靠自适应降档与面板内 FPS 读数保障' });
  await store.write({ kind: 'fact', text: '检索用 IDF 加权的查询覆盖度打分' });
  await store.write({ kind: 'world', text: '摘要归纳用 deepseek-flash 重写成通顺的一段话' });
  await store.write({ kind: 'episode', text: '一起把面板换了五种承载', scene: '在 Desktop 上写插件' });
  await store.write({ kind: 'fact', text: '测试必须把 storePath 指到临时目录' });
  await store.write({ kind: 'world', text: '侧栏新增了历史页签，回放滑杆就在那里' });
  await store.write({ kind: 'fact', text: '导出导入都是整体替换，导入要二次确认' });
  await store.write({ kind: 'world', text: '共激活边只观测，不参与注入决策' });
  await store.write({ kind: 'fact', text: '破坏性修剪前留三份备份' });
  await store.write({ kind: 'world', text: '星图连线带世界坐标控制点，转相机时弯跟着转' });
  await store.write({ kind: 'fact', text: '用户喜欢喝手冲咖啡' });
  await store.write({ kind: 'slot', text: '0.42.0', entity: 'dsh-memory-loom', attr: '版本' });
}

test('内容词：问句填词、时间词、语料里没有的词、饱和词都不算内容', () => {
  const rows = [
    { id: 'a', text: '记忆面板是三维星图' },
    { id: 'b', text: '渲染帧率靠自适应降档' },
    { id: 'c', text: '摘要归纳用模型重写' },
    // 「继续」确实在库里（真实库就有），所以它会撞上一个词拿满分 —— 正是要拦的那种
    { id: 'd', text: '继续按上面的方案改' },
  ];
  const corpus = buildCorpus(rows);
  const tokens = (query) => contentTokens(tokenize(query), corpus);
  // 纯问句填词：一个内容词都没有
  assert.deepEqual(tokens('现在几点了'), []);
  assert.deepEqual(tokens('你好'), []);
  // 应答词不算内容：库里**确实**有一条含「继续」的记忆，但它仍然不该算数 ——
  // 这正是「继续」能拿到 1.0 分假高分的来源
  assert.deepEqual(tokens('继续'), []);
  // 语料里根本没有的词（正则/中文不是库里的东西）不算内容词
  assert.deepEqual(tokens('帮我写个正则'), []);
  // 真内容
  assert.ok(tokens('渲染帧率怎么保障').length >= 2, '渲染 / 帧率 都该算内容词');
});

test('内容词：语料太小时不判饱和词，否则小库里每个词都"饱和"', () => {
  // 只有 3 条，所有词的 df 都是 100% —— 这时排除饱和词会把内容词清空
  const rows = [
    { id: 'a', text: '记忆面板是三维星图' },
    { id: 'b', text: '记忆面板可以旋转' },
    { id: 'c', text: '记忆面板有标签' },
  ];
  const tokens = contentTokens(tokenize('记忆面板怎么旋转'), buildCorpus(rows));
  assert.ok(tokens.length >= 2, `小库不该被清空，实际 ${tokens.join('/')}`);
});

test('闸门：内容词不足两条的查询，不注入任何检索块', async () => {
  const { store, cleanup } = await makeStore();
  try {
    await seed(store);
    for (const query of ['继续', '你好', '现在几点了', '谢谢']) {
      const snapshot = store.buildRecall(query);
      assert.equal(snapshot.gate.open, false, `「${query}」该被闸门拦住`);
      const names = snapshot.blocks.map((block) => block.name);
      assert.equal(names.includes('world'), false, `「${query}」不该注入世界块`);
      assert.equal(names.includes('facts'), false, `「${query}」不该注入事实块`);
      assert.equal(names.includes('summary'), false, `「${query}」不该注入摘要块`);
    }
  } finally {
    await cleanup();
  }
});

test('闸门：内容词够的查询照旧注入，一条不少', async () => {
  const { store, cleanup } = await makeStore();
  try {
    await seed(store);
    const snapshot = store.buildRecall('渲染帧率靠什么保障');
    assert.equal(snapshot.gate.open, true);
    const names = snapshot.blocks.map((block) => block.name);
    assert.ok(names.includes('world'), '相关的世界条目应该注入');
    assert.ok(snapshot.hits.length > 0);
  } finally {
    await cleanup();
  }
});

test('闸门：常驻块永远不受影响（约束 / 槽位 / 共同经历每轮都要在）', async () => {
  const { store, cleanup } = await makeStore();
  try {
    await seed(store);
    const snapshot = store.buildRecall('继续');
    const names = snapshot.blocks.map((block) => block.name);
    // 闸门只管检索块；这三块是"每轮无条件注入"的契约，被闸门掐掉就等于没了保护
    assert.deepEqual(names, ['constraints', 'slots', 'episodes']);
  } finally {
    await cleanup();
  }
});

test('闸门：可关闭，关掉后行为回到原来（低内容查询也照样检索）', async () => {
  const { store, cleanup } = await makeStore({ recallMinContentTokens: 0 });
  try {
    await seed(store);
    const snapshot = store.buildRecall('继续');
    assert.equal(snapshot.gate.open, true, '阈值设 0 表示不设闸门');
  } finally {
    await cleanup();
  }
});

test('闸门：单个稀有词要放行 —— 用户说「咖啡」，不能想不起他爱喝手冲', async () => {
  const { store, cleanup } = await makeStore();
  try {
    await seed(store);
    // 「咖啡」在库里 df=1：这种词几乎只指向一条具体记忆，检索最准。
    // 只按"内容词 ≥ 2"一刀切，就会把这类查询整片掐掉 —— 六层健康灯那盏 ok
    // 会直接从 ok 掉成 empty，这是被测试打红之后才发现的。
    const snapshot = store.buildRecall('咖啡');
    assert.equal(snapshot.gate.open, true, '稀有单词必须放行');
    assert.ok(snapshot.blocks.some((block) => block.name === 'facts'), '应当想起「用户喜欢喝手冲咖啡」');
  } finally {
    await cleanup();
  }
});

test('闸门：结果可观测（面板要能说出"这轮为什么没注入"）', async () => {
  const { store, cleanup } = await makeStore();
  try {
    await seed(store);
    // 「面板」在库里出现三次：撞得上、也不算稀有，但一个词撑不起一次检索
    const blocked = store.buildRecall('面板');
    assert.equal(blocked.gate.open, false);
    assert.equal(blocked.gate.tokens, 1, '只有一个内容词，且它不稀有');
    assert.equal(blocked.gate.need, 2);

    const passed = store.buildRecall('渲染帧率靠什么保障');
    assert.equal(passed.gate.open, true);
    assert.ok(passed.gate.tokens >= 2);
  } finally {
    await cleanup();
  }
});
