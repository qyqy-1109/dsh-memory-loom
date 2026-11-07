import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { MemoryStore } from '../lib/store.js';
import { coActivate, pruneEdges, visibleEdges, graphStats, strengthOf, orderPair } from '../lib/graph.js';

/** 造一个临时库（绝不碰真实记忆库）。 */
async function makeStore(overrides = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'loom-edge-'));
  const store = new MemoryStore({ file: join(dir, 'store.json'), ...overrides });
  await store.open();
  return { store, dir, cleanup: () => rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 60 }) };
}

const DAY = 86_400_000;

test('共激活：一轮里一起被召回的两条各连一条边，端点顺序统一', () => {
  const edges = [];
  const stat = coActivate(edges, ['b', 'a'], { now: 1_000_000, halfLifeDays: 30 });
  assert.equal(stat.pairs, 1);
  assert.equal(stat.created, 1);
  assert.equal(edges.length, 1);
  // 端点按字典序存放：同一对记忆不可能出现两条反向边
  assert.deepEqual(orderPair('b', 'a'), ['a', 'b']);
  assert.equal(edges[0].a, 'a');
  assert.equal(edges[0].b, 'b');
  assert.equal(edges[0].w, 1);
});

test('共激活：同一对再出现一次是累加，不是新增', () => {
  const edges = [];
  coActivate(edges, ['a', 'b'], { now: 1_000_000, halfLifeDays: 30 });
  const stat = coActivate(edges, ['b', 'a'], { now: 1_000_000 + DAY, halfLifeDays: 30 });
  assert.equal(stat.created, 0);
  assert.equal(stat.updated, 1);
  assert.equal(edges.length, 1);
  // 一天后先衰减再 +1：不是 2，而是 1×0.5^(1/30)+1
  assert.ok(edges[0].w > 1.9 && edges[0].w < 2);
});

test('共激活：少于两条不建边；同一条 id 重复不和自己连', () => {
  const edges = [];
  assert.equal(coActivate(edges, ['a'], { now: 1_000_000 }).pairs, 0);
  assert.equal(coActivate(edges, ['a', 'a', 'a'], { now: 1_000_000 }).pairs, 0);
  assert.equal(edges.length, 0);
});

test('共激活：fanout 只让相关度最高的前几条参与配对，防噪声灌图', () => {
  const edges = [];
  const ids = ['a', 'b', 'c', 'd', 'e', 'f'];
  const stat = coActivate(edges, ids, { now: 1_000_000, fanout: 3 });
  // 3 条 → 3 对
  assert.equal(stat.pairs, 3);
  assert.equal(edges.length, 3);
  // 越界的 id 不进图
  assert.equal(edges.some((edge) => edge.a === 'd' || edge.b === 'd'), false);
});

test('关系会衰减：半衰期到了强度减半，久不共现的死边被剪掉', () => {
  const now = 10 * DAY;
  const edge = { a: 'a', b: 'b', w: 4, at: now - 30 * DAY };
  assert.ok(Math.abs(strengthOf(edge, now, 30) - 2) < 1e-9);
  assert.ok(Math.abs(strengthOf(edge, now, 60) - 2.828) < 0.01);

  const dead = pruneEdges([{ a: 'a', b: 'b', w: 0.3, at: now - 300 * DAY }], {
    now,
    halfLifeDays: 30,
    minWeight: 0.25,
  });
  assert.equal(dead.edges.length, 0);
  assert.equal(dead.byReason.dead, 1);
});

test('修剪：端点已不存在的幽灵边被丢掉', () => {
  const now = 1_000_000;
  const edges = [{ a: 'gone', b: 'b', w: 5, at: now }];
  const stat = pruneEdges(edges, { now, alive: (id) => id !== 'gone' });
  assert.equal(stat.edges.length, 0);
  assert.equal(stat.byReason.ghost, 1);
});

test('修剪：度数上限按强度留最强的，不设上限就等于没有结构', () => {
  const now = 1_000_000;
  const edges = [];
  // 中心点 hub 连了 6 条，权重从高到低
  for (let i = 0; i < 6; i += 1) edges.push({ a: 'hub', b: `n${i}`, w: 10 - i, at: now });
  const stat = pruneEdges(edges, { now, maxDegree: 3 });
  assert.equal(stat.edges.length, 3);
  assert.equal(stat.byReason.degree, 3);
  // 留下的是最重的三条：hub-n0 / hub-n1 / hub-n2
  assert.deepEqual(stat.edges.map((edge) => edge.b).sort(), ['n0', 'n1', 'n2']);
});

test('修剪：全局条数上限砍最弱的，并报告砍了多少', () => {
  const now = 1_000_000;
  const edges = [];
  for (let i = 0; i < 10; i += 1) edges.push({ a: `a${i}`, b: `b${i}`, w: i + 1, at: now });
  const stat = pruneEdges(edges, { now, maxDegree: 12, maxEdges: 4 });
  assert.equal(stat.edges.length, 4);
  assert.equal(stat.byReason.global, 6);
  // 留下的是权重最高的四条（w=7..10）
  assert.deepEqual(stat.edges.map((edge) => edge.w).sort((l, r) => l - r), [7, 8, 9, 10]);
});

test('统计：稠密度与平均度数如实反映图有多挤', () => {
  const now = 1_000_000;
  const edges = [
    { a: 'a', b: 'b', w: 2, at: now },
    { a: 'b', b: 'c', w: 2, at: now },
  ];
  const stat = graphStats(edges, { now });
  assert.equal(stat.edges, 2);
  assert.equal(stat.nodes, 3);
  assert.equal(stat.maxDegree, 2);
  assert.equal(stat.meanDegree, Number((4 / 3).toFixed(2)));
  // 3 点 2 边对 3 条完全图 → 0.6667
  assert.equal(stat.density, Number((4 / 6).toFixed(4)));
});

test('展示：弱边不画出来，但数据还在库里', () => {
  const now = 1_000_000;
  const edges = [
    { a: 'a', b: 'b', w: 5, at: now },
    { a: 'c', b: 'd', w: 0.2, at: now },
  ];
  const shown = visibleEdges(edges, { now, minWeight: 0.25 });
  assert.equal(shown.length, 1);
  assert.equal(shown[0].a, 'a');
  assert.equal(graphStats(edges, { now, minWeight: 0.25 }).edges, 1);
});

test('落库：一次 coRecall 同时累加命中与边，并持久化到磁盘', async () => {
  const { store, dir, cleanup } = await makeStore();
  try {
    const one = await store.write({ kind: 'fact', text: '用户喜欢深色主题' });
    const two = await store.write({ kind: 'fact', text: '用户用 Windows 11' });
    await store.write({ kind: 'world', text: '项目叫 dsh-memory-loom' });

    const stat = await store.coRecall([one.id, two.id]);
    assert.equal(stat.created, 1);
    assert.equal(store.state.edges.length, 1);
    // 命中照旧累加
    assert.equal(store.byId(one.id).hits, 1);
    assert.equal(store.byId(two.id).hits, 1);
    // 不参与的那条没有命中
    assert.equal(store.active()[2].hits, 0);

    const onDisk = JSON.parse(await readFile(join(dir, 'store.json'), 'utf8'));
    assert.equal(onDisk.edges.length, 1);
    assert.equal(onDisk.edges[0].w, 1);
  } finally {
    await cleanup();
  }
});

test('落库：单条命中只累加命中，不产生自环边', async () => {
  const { store, cleanup } = await makeStore();
  try {
    const one = await store.write({ kind: 'fact', text: '用户喜欢猫' });
    const stat = await store.coRecall([one.id]);
    assert.equal(stat.pairs, 0);
    assert.equal(store.state.edges.length, 0);
    assert.equal(store.byId(one.id).hits, 1);
  } finally {
    await cleanup();
  }
});

test('开关：关掉共激活后只累加命中，库里不新增任何边', async () => {
  const { store, cleanup } = await makeStore({ coActivate: false });
  try {
    const one = await store.write({ kind: 'fact', text: '用户喜欢深色主题' });
    const two = await store.write({ kind: 'fact', text: '用户用 Windows 11' });
    await store.coRecall([one.id, two.id]);
    assert.equal(store.state.edges.length, 0);
    assert.equal(store.byId(one.id).hits, 1);
  } finally {
    await cleanup();
  }
});

test('快照：面板能拿到边与图统计，且归档条目之间的边不丢', async () => {
  const { store, cleanup } = await makeStore();
  try {
    const one = await store.write({ kind: 'fact', text: '用户喜欢深色主题' });
    const two = await store.write({ kind: 'fact', text: '用户用 Windows 11' });
    await store.coRecall([one.id, two.id]);

    const snapshot = store.snapshot();
    assert.equal(snapshot.edges.length, 1);
    assert.equal(snapshot.graph.nodes, 2);
    assert.equal(snapshot.graph.edges, 1);
    assert.equal(snapshot.counts.edges, 1);

    // 归档（软删）不等于物理删除：边指向的条目还在库里，关系保留
    await store.forget(two.id, { reason: '测试归档' });
    await store.coRecall([one.id, two.id]);
    const after = store.snapshot();
    assert.equal(after.edges.length, 1);
  } finally {
    await cleanup();
  }
});

test('剪枝：物理删除的记忆会把它的边一起带走', async () => {
  const { store, cleanup } = await makeStore();
  try {
    const one = await store.write({ kind: 'fact', text: '用户喜欢深色主题' });
    const two = await store.write({ kind: 'fact', text: '用户用 Windows 11' });
    const three = await store.write({ kind: 'fact', text: '用户在北京' });
    await store.coRecall([one.id, two.id]);
    await store.coRecall([two.id, three.id]);
    assert.equal(store.state.edges.length, 2);

    // 物理删掉中间那个节点：它的两条边都无处可连
    store.state.memories = store.state.memories.filter((row) => row.id !== two.id);
    await store.coRecall([one.id, three.id]);
    assert.equal(store.state.edges.some((edge) => edge.a === two.id || edge.b === two.id), false);
  } finally {
    await cleanup();
  }
});
