import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { MemoryStore } from '../lib/store.js';

/**
 * 注入的「看得见」。
 *
 * 为什么先做观测而不是先做淘汰：`used` 上线一天后 usedTotal 还是 0，
 * 但翻遍 store.json 也说不清"到底是没命中，还是根本没注入过有内容的东西" ——
 * 既没有每轮的注入记录，也没有"未命中"的痕迹。
 * 没有这两样，"used 有没有用"这个问题永远无法回答，后面所有淘汰策略都是猜。
 */

async function makeStore(overrides = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'loom-obs-'));
  const store = new MemoryStore({ file: join(dir, 'store.json'), ...overrides });
  await store.open();
  return { store, dir, cleanup: () => rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 60 }) };
}

async function seed(store) {
  await store.write({ kind: 'constraint', text: '不要用 Get-Content 管道改源码，会写 BOM' });
  await store.write({ kind: 'world', text: '记忆面板是三维星图，走 Canvas 2D 真实透视' });
  await store.write({ kind: 'world', text: '渲染帧率靠自适应降档与面板内 FPS 读数保障' });
  await store.write({ kind: 'fact', text: '用户喜欢喝手冲咖啡，不加糖' });
  await store.write({ kind: 'slot', text: '0.44.0', entity: 'dsh-memory-loom', attr: '版本' });
}

test('注入体积：快照带 size（字符数 / 块数 / 命中条数）', async () => {
  const { store, cleanup } = await makeStore();
  try {
    await seed(store);
    const snapshot = store.buildRecall('渲染帧率靠什么保障');
    assert.ok(snapshot.size.chars > 0);
    assert.equal(snapshot.size.blocks, snapshot.blocks.length);
    const scored = snapshot.hits.filter((hit) => typeof hit.score === 'number');
    assert.equal(snapshot.size.entries, scored.length, 'entries 只算真正被检索到的，不算常驻块');
  } finally {
    await cleanup();
  }
});

test('注入体积：预算为 0 时只剩常驻块，字符数也跟着降下来', async () => {
  const { store, cleanup } = await makeStore();
  try {
    await seed(store);
    const blocked = store.buildRecall('继续');
    const passed = store.buildRecall('渲染帧率靠什么保障');
    assert.equal(blocked.size.entries, 0);
    assert.equal(blocked.gate.budget, 0);
    assert.ok(blocked.size.chars < passed.size.chars, '常驻块之外的东西一条都不该有');
    // 常驻块本身仍然要在（约束/槽位是每轮固定成本，不归闸门管）
    assert.ok(blocked.blocks.some((block) => block.name === 'constraints'));
  } finally {
    await cleanup();
  }
});

test('观测：每轮召回都留一条 recall 埋点，能算"注入了多少次"', async () => {
  const { store, cleanup } = await makeStore();
  try {
    await seed(store);
    await store.recordRecall(store.buildRecall('渲染帧率靠什么保障'));
    await store.recordRecall(store.buildRecall('继续'));
    const events = store.state.events.filter((event) => event.kind === 'recall');
    assert.equal(events.length, 2, '每次 recordRecall 一条');
    assert.equal(events[0].payload.budget >= 2, true);
    assert.equal(events[1].payload.budget, 0);
    // 只记结构，不记正文：埋点里塞全文的话，几天就把 events 撑满
    assert.equal(typeof events[0].payload.query, 'string');
    assert.ok(events[0].payload.query.length <= 60);
    assert.equal(events[0].payload.text, undefined, '不该把注入正文写进埋点');
  } finally {
    await cleanup();
  }
});

test('观测：召回埋点带着注入体积，面板与统计都能直接用', async () => {
  const { store, cleanup } = await makeStore();
  try {
    await seed(store);
    const snapshot = store.buildRecall('渲染帧率靠什么保障');
    await store.recordRecall(snapshot);
    const [event] = store.state.events.filter((item) => item.kind === 'recall');
    assert.equal(event.payload.chars, snapshot.size.chars);
    assert.equal(event.payload.blocks, snapshot.size.blocks);
    assert.equal(event.payload.entries, snapshot.size.entries);
  } finally {
    await cleanup();
  }
});
