import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { MemoryStore } from '../lib/store.js';
import { buildCorpus } from '../lib/rank.js';
import { anchorsOf, matchAnchors, isUsed } from '../lib/usage.js';

/**
 * 使用信号：这条记忆到底有没有被**用上**。
 *
 * 现状的 `hits` 记的是"被注入"，而被注入几乎每轮都会发生 —— 它度量的是曝光，
 * 不是有用。后果是回声室：被召回的更重、更容易再被召回，与"重要"无关。
 *
 * 判据：给每条记忆取几个**锚词**（它自己最有区分度的词），下一轮你说话时
 * 如果出现了锚词，才算用上了。锚词是这条记忆的指纹，不是它的全文。
 */

async function makeStore(overrides = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'loom-usage-'));
  const store = new MemoryStore({ file: join(dir, 'store.json'), ...overrides });
  await store.open();
  return { store, dir, cleanup: () => rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 60 }) };
}

test('锚词：取的是这条记忆里的连续片段，不是它的全文', () => {
  const rows = [
    { id: 'a', text: '用户喜欢喝手冲咖啡，不加糖' },
    { id: 'b', text: '记忆面板是三维星图' },
    { id: 'c', text: '记忆面板可以旋转' },
    { id: 'd', text: '记忆面板有标签' },
  ];
  const corpus = buildCorpus(rows);
  const text = '用户喜欢喝手冲咖啡，不加糖';
  const anchors = anchorsOf(text, corpus);
  assert.ok(anchors.length >= 2, `锚词太少：${anchors.join('/')}`);
  // 锚词必须是原文里真实出现的连续片段。不要求它是"语言学意义上的词"——
  // 中文二元组会切出「冲咖」这种跨词碎片，那属于**安全的失败方向**：
  // 碎片当锚词只会让它更难被命中（漏判），不会把无关的话算成"用上了"（误判）。
  for (const anchor of anchors) assert.ok(text.includes(anchor), `「${anchor}」不在原文里`);
  // 一个词能取的数量有上限（面板上要显示，不能是一串）
  assert.ok(anchors.length <= 3, `锚词不该超过 3 个，实际 ${anchors.length}`);
});

test('锚词：全库都有的词当不了指纹', () => {
  const rows = [];
  for (let index = 0; index < 30; index += 1) {
    rows.push({ id: `m${index}`, text: `记忆面板的第 ${index} 个毛病：面板太挤，面板太暗` });
  }
  rows.push({ id: 'x', text: '用户喜欢喝手冲咖啡' });
  const corpus = buildCorpus(rows);
  const anchors = anchorsOf('记忆面板的第 3 个毛病：面板太挤，面板太暗', corpus);
  assert.equal(anchors.includes('面板'), false, `饱和词不该当锚词，实际 ${anchors.join('/')}`);
  // 反过来，稀有记忆的锚词就该是它独有的词
  assert.ok(anchorsOf('用户喜欢喝手冲咖啡', corpus).includes('咖啡'));
});

test('判定：锚词本身就是稀有词，命中一个就算（要求两个只会大面积漏判）', () => {
  const anchors = ['咖啡', '手冲', '不加糖'];
  assert.equal(isUsed(anchors, '我想喝咖啡'), true, '命中一个稀有词就够');
  assert.equal(isUsed(anchors, '今天天气不错'), false);
  // 实测教训：一开始要求"命中 ≥ 2 个"，真实库上 7 条相关消息只有 1 条判上 ——
  // 锚词取的是区分度最高的词，用户复述同一件事时未必会把两个都说到。
  // 反过来"撞一个泛词就算"的担心也不成立：能当锚词的本来就是 df 极小的词。
  assert.equal(isUsed(['保障', 'fps', '内实'], '面板的帧率保障还要不要加自适应降档'), true);
});

test('判定：锚词很少时降低门槛，否则这条记忆永远记不上用', () => {
  // 一条很短、没有区分词的记忆只能取到一个锚词 —— 门槛必须跟着降
  assert.equal(isUsed(['咖啡'], '想喝咖啡'), true);
  assert.equal(isUsed([], '想喝咖啡'), false, '没有锚词就永远不算');
  assert.equal(matchAnchors(['咖啡', '手冲'], '手冲一杯'), 1);
});

test('落库：markUsed 累加使用次数，与 hits 分开记', async () => {
  const { store, dir, cleanup } = await makeStore();
  try {
    const row = await store.write({ kind: 'fact', text: '用户喜欢喝手冲咖啡' });
    const { used } = await store.markUsed([row.id]);
    assert.equal(used, 1);
    const after = store.byId(row.id);
    assert.equal(after.usedCount, 1);
    assert.ok(Number.isFinite(after.lastUsedAt));
    // hits 是"被注入"，used 是"被用上"：两把不同的尺子，不能互相污染
    assert.equal(after.hits, 0, 'markUsed 不该顺手加 hits');

    await store.markUsed([row.id]);
    assert.equal(store.byId(row.id).usedCount, 2);

    const onDisk = JSON.parse(await readFile(join(dir, 'store.json'), 'utf8'));
    assert.equal(onDisk.memories.find((item) => item.id === row.id).usedCount, 2);
  } finally {
    await cleanup();
  }
});

test('落库：老库没有 usedCount 字段时补 0，不报错', async () => {
  const { store, cleanup } = await makeStore();
  try {
    const row = await store.write({ kind: 'fact', text: '用户喜欢喝手冲咖啡' });
    // 模拟老库：字段根本不存在
    delete store.byId(row.id).usedCount;
    delete store.byId(row.id).lastUsedAt;
    const anchors = store.anchorsFor([row.id]);
    assert.equal(anchors.get(row.id).length > 0, true);
    const snapshot = store.snapshot();
    const item = snapshot.memories.find((memory) => memory.id === row.id);
    assert.equal(item.usedCount, 0, '快照也要给出 0，而不是 undefined');
  } finally {
    await cleanup();
  }
});

test('锚词给上层：anchorsFor 按 id 批量取，供"下一轮再判定"用', async () => {
  const { store, cleanup } = await makeStore();
  try {
    const a = await store.write({ kind: 'fact', text: '用户喜欢喝手冲咖啡，不加糖' });
    const b = await store.write({ kind: 'world', text: '记忆面板是三维星图' });
    const map = store.anchorsFor([a.id, b.id, 'no-such-id']);
    assert.equal(map.size, 2, '不存在的 id 直接跳过');
    assert.ok(map.get(a.id).length > 0);
    assert.ok(map.get(b.id).length > 0);
    for (const anchor of map.get(a.id)) assert.ok('用户喜欢喝手冲咖啡，不加糖'.includes(anchor));
  } finally {
    await cleanup();
  }
});
