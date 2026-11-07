import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { MemoryStore } from '../lib/store.js';
import { buildCorpus, contentTokens } from '../lib/rank.js';
import { tokenize } from '../lib/text.js';

/**
 * 读闸门 = 注入预算，不是开关。
 *
 * 为什么不做成二值开关：这条查询「有没有内容」不是非黑即白。
 * 一个内容词（"咖啡"、"面板"）往往就是一条具体记忆的指路牌 ——
 * 掐掉等于"用户说咖啡，想不起他爱喝手冲"；全量注入又是在灌噪声。
 * 所以闸门回答的是"注入几条"，不是"要不要"。
 *
 * 为什么不用「相关度」当判据（试过，失败）：覆盖率的分母只有查询词，
 * 短查询撞上一个二元组就是 1.0 —— 实测「继续」「现在几点了」「今天先做什么」
 * 的峰值覆盖率都是 1.000，比一半真相关查询还高。
 * 换成「命中的内容词个数」才分得开：12 条无关查询里 9 条不足两个。
 */

async function makeStore(overrides = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'loom-gate-'));
  const store = new MemoryStore({ file: join(dir, 'store.json'), ...overrides });
  await store.open();
  return { store, dir, cleanup: () => rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 60 }) };
}

/** 一个真实的库：14 条，够触发「饱和词」判定。 */
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

test('内容词：问句填词、时间词、寒暄词、库里没有的词、饱和词都不算内容', () => {
  const rows = [
    { id: 'a', text: '记忆面板是三维星图' },
    { id: 'b', text: '渲染帧率靠自适应降档' },
    { id: 'c', text: '摘要归纳用模型重写' },
    // 「继续」确实在库里（真实库就有），所以它会撞上一个词拿满分 —— 正是要拦的那种
    { id: 'd', text: '继续按上面的方案改' },
  ];
  const corpus = buildCorpus(rows);
  const tokens = (query) => contentTokens(tokenize(query), corpus);
  assert.deepEqual(tokens('现在几点了'), []);
  assert.deepEqual(tokens('你好'), []);
  // 应答词不算内容：库里**确实**有含「继续」的记忆，但它仍然不该算数
  assert.deepEqual(tokens('继续'), []);
  assert.deepEqual(tokens('帮我写个正则'), []);
  assert.ok(tokens('渲染帧率怎么保障').length >= 2, '渲染 / 帧率 都该算内容词');
});

test('内容词：语料太小时不判饱和词，否则小库里每个词都"饱和"', () => {
  const rows = [
    { id: 'a', text: '记忆面板是三维星图' },
    { id: 'b', text: '记忆面板可以旋转' },
    { id: 'c', text: '记忆面板有标签' },
  ];
  const tokens = contentTokens(tokenize('记忆面板怎么旋转'), buildCorpus(rows));
  assert.ok(tokens.length >= 2, `小库不该被清空，实际 ${tokens.join('/')}`);
});

test('预算：零个内容词 → 一条检索块都不注入，常驻块照旧', async () => {
  const { store, cleanup } = await makeStore();
  try {
    await seed(store);
    for (const query of ['继续', '你好', '现在几点了', '谢谢']) {
      const snapshot = store.buildRecall(query);
      assert.equal(snapshot.gate.budget, 0, `「${query}」不该有检索预算`);
      assert.deepEqual(
        snapshot.blocks.map((block) => block.name),
        ['constraints', 'slots', 'episodes'],
        `「${query}」只该有常驻块`,
      );
    }
  } finally {
    await cleanup();
  }
});

test('预算：一个内容词 → 最多注入一条（单词查询是"指路牌"，不是"没内容"）', async () => {
  const { store, cleanup } = await makeStore();
  try {
    await seed(store);
    const snapshot = store.buildRecall('咖啡');
    assert.equal(snapshot.gate.budget, 1);
    const recalled = snapshot.hits.filter((hit) => typeof hit.score === 'number');
    assert.equal(recalled.length, 1, `单词查询只该想起一条，实际 ${recalled.length} 条`);
    assert.ok(recalled[0].text.includes('手冲'), '而且想起的应该是那条咖啡记忆');
  } finally {
    await cleanup();
  }
});

test('预算：一个内容词时不该灌满 topK —— 注入量必须跟着预算收缩', async () => {
  const { store, cleanup } = await makeStore();
  try {
    await seed(store);
    // 「面板」在库里出现多次，足够的候选能撑满 topK
    const one = store.buildRecall('面板');
    const many = store.buildRecall('面板 星图');
    assert.equal(one.gate.budget, 1);
    assert.ok(many.gate.budget >= 2, '多个内容词才给足预算');
    const countOf = (snapshot) => snapshot.hits.filter((hit) => typeof hit.score === 'number').length;
    assert.equal(countOf(one), 1, '一个内容词只给一条');
    assert.ok(countOf(many) > countOf(one), '多个内容词应当想起更多');
  } finally {
    await cleanup();
  }
});

test('预算：内容词够的查询照旧注入，一条不少', async () => {
  const { store, cleanup } = await makeStore();
  try {
    await seed(store);
    const snapshot = store.buildRecall('渲染帧率靠什么保障');
    assert.ok(snapshot.gate.budget >= 2);
    assert.ok(snapshot.blocks.some((block) => block.name === 'world'), '相关的世界条目应该注入');
  } finally {
    await cleanup();
  }
});

test('预算：可关闭，关掉后行为回到原来（零内容词也照样检索）', async () => {
  const { store, cleanup } = await makeStore({ recallMinContentTokens: 0 });
  try {
    await seed(store);
    const snapshot = store.buildRecall('继续');
    assert.ok(snapshot.gate.budget > 0, '阈值设 0 表示不设闸门');
    assert.equal(snapshot.gate.tokens, 0);
  } finally {
    await cleanup();
  }
});

test('预算：结果可观测（面板要能说出"这轮为什么只想起一条"）', async () => {
  const { store, cleanup } = await makeStore();
  try {
    await seed(store);
    const none = store.buildRecall('继续');
    assert.equal(none.gate.budget, 0);
    assert.equal(none.gate.tokens, 0);
    assert.equal(none.gate.need, 2);

    const some = store.buildRecall('渲染帧率靠什么保障');
    assert.ok(some.gate.tokens >= 2);
    assert.ok(some.gate.budget >= 2);
  } finally {
    await cleanup();
  }
});

test('预算：约束与槽位永远注入，不受闸门影响', async () => {
  const { store, cleanup } = await makeStore();
  try {
    await seed(store);
    const blocked = store.buildRecall('继续');
    const passed = store.buildRecall('渲染帧率靠什么保障');
    assert.ok(blocked.blocks.some((block) => block.name === 'constraints'));
    assert.ok(blocked.blocks.some((block) => block.name === 'slots'));
    assert.ok(passed.blocks.some((block) => block.name === 'constraints'));
    assert.ok(passed.blocks.some((block) => block.name === 'slots'));
  } finally {
    await cleanup();
  }
});
