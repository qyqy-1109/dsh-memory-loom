import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { MemoryStore } from '../lib/store.js';

/**
 * 「从未被想起」的清理。
 *
 * 真实库体检：84 条活跃里有 42% 从未被召回（hits = 0）。它们占着活跃名额、
 * 稀释召回，却从来没帮上忙 —— 但**不能自动删**：`hits` 是曝光信号不是价值信号，
 * 判错的代价是丢掉一条本来有用的结论。
 *
 * 所以做成"候选 + 人工确认 + 只归档可恢复"，和「整理过程记录」同一套口径。
 */

const DAY = 86_400_000;

async function makeStore(overrides = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'loom-tidy-'));
  const store = new MemoryStore({ file: join(dir, 'store.json'), ...overrides });
  await store.open();
  return { store, dir, cleanup: () => rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 60 }) };
}

/** 把某条记忆的创建时间往前推，模拟"写了很久"。 */
function age(store, id, days) {
  const row = store.byId(id);
  row.createdAt = Date.now() - days * DAY;
  row.updatedAt = row.createdAt;
  row.lastHitAt = null;
}

test('候选：只挑「可淘汰种类 + 从未被召回 + 够老」的条目', async () => {
  const { store, cleanup } = await makeStore();
  try {
    const oldFact = await store.write({ kind: 'fact', text: '用户提过想养一只边牧' });
    const freshFact = await store.write({ kind: 'fact', text: '用户今天提到想喝奶茶' });
    const usedFact = await store.write({ kind: 'fact', text: '用户喜欢喝手冲咖啡' });
    age(store, oldFact.id, 10);
    age(store, usedFact.id, 10);
    await store.touch([usedFact.id]); // 被召回过的不能算"从未想起"

    const candidates = store.unusedCandidates({ olderThanDays: 7 });
    const ids = candidates.map((row) => row.id);
    assert.deepEqual(ids, [oldFact.id], '只有"够老 + 从没被召回"的那条');
    assert.equal(ids.includes(freshFact.id), false, '刚写的不能动');
    assert.equal(ids.includes(usedFact.id), false, '被召回过的不能动');
  } finally {
    await cleanup();
  }
});

test('候选：约束 / 槽位 / 共同经历永不入选；world 要等更久（30 天）', async () => {
  const { store, cleanup } = await makeStore();
  try {
    const constraint = await store.write({ kind: 'constraint', text: '不要用单向管道改源码' });
    const world = await store.write({ kind: 'world', text: '面板是三维星图' });
    const episode = await store.write({ kind: 'episode', text: '一起看了海', scene: '海边' });
    await store.write({ kind: 'slot', text: '0.45.0', entity: '项目', attr: '版本' });
    for (const id of [constraint.id, world.id, episode.id]) age(store, id, 40);

    // 这三类要么每轮无条件注入、要么是不可再生的事实 —— "没被召回"对它们说明不了什么
    const byKind = (list, kind) => list.filter((row) => row.kind === kind);
    const list = store.unusedCandidates({});
    assert.equal(byKind(list, 'constraint').length, 0, '约束永不入选');
    assert.equal(byKind(list, 'episode').length, 0, '共同经历永不入选');
    // 但 world 要入选 —— 真实库里 hits=0 的 38 条里 fact 一条都没有、world 占 27 条，
    // 把 world 一刀切排除之后，这个功能在真实库上什么也挑不出来。
    assert.equal(byKind(list, 'world').length, 1, '满 40 天的 world 应该进候选');
  } finally {
    await cleanup();
  }
});

test('候选：分档门槛 —— fact 满 7 天，world 要满 30 天', async () => {
  const { store, cleanup } = await makeStore();
  try {
    const world = await store.write({ kind: 'world', text: '渲染帧率的经验值' });
    age(store, world.id, 10);
    assert.deepEqual(store.unusedCandidates({}), [], 'world 才 10 天，不该动');
    age(store, world.id, 31);
    assert.equal(store.unusedCandidates({}).length, 1, '满 30 天才是候选');

    // 显式传天数时覆盖分档（面板手动清理、测试都用这条路）
    assert.equal(store.unusedCandidates({ olderThanDays: 5 }).length, 1);
  } finally {
    await cleanup();
  }
});

test('候选：用户亲口说的（explicit）一条都不碰', async () => {
  const { store, cleanup } = await makeStore();
  try {
    const explicit = await store.write({ kind: 'fact', text: '记住：我对花生过敏', explicit: true });
    age(store, explicit.id, 30);
    assert.deepEqual(store.unusedCandidates({ olderThanDays: 7 }), [], '亲口说过的永远不算死重');
  } finally {
    await cleanup();
  }
});

test('整理：预览不改数据，apply 才归档，而且只归档不删除', async () => {
  const { store, cleanup } = await makeStore();
  try {
    const stale = await store.write({ kind: 'fact', text: '用户提过想养一只边牧' });
    age(store, stale.id, 10);

    const preview = await store.tidyUnused({ olderThanDays: 7 });
    assert.equal(preview.dryRun, true);
    assert.equal(preview.count, 1);
    assert.equal(store.byId(stale.id).status, 'active', '预览不能改库');

    const applied = await store.tidyUnused({ olderThanDays: 7, apply: true });
    assert.equal(applied.archived, 1);
    const row = store.byId(stale.id);
    assert.equal(row.status, 'archived');
    assert.equal(row.archivedReason, 'unused');

    // 归档不是删除：随时能回来，且回来之后不会立刻又被挑中一次
    await store.restore(stale.id);
    assert.equal(store.byId(stale.id).status, 'active');
    assert.ok(store.byId(stale.id).hits >= 1, '恢复时要推一下命中，否则下次整理又把它挑走');
  } finally {
    await cleanup();
  }
});

test('整理：空候选时返回零，不报错也不写盘，但要说清"为什么是零"', async () => {
  const { store, cleanup } = await makeStore();
  try {
    const fresh = await store.write({ kind: 'fact', text: '刚写的一条' });
    void fresh;
    const result = await store.tidyUnused({ apply: true });
    assert.equal(result.count, 0);
    assert.equal(result.archived ?? 0, 0);
    // 面板要能回答"为什么点了没反应"：有几条从没被想起、最早几天后到期
    assert.equal(result.stats.never, 1, '刚写的那条就是"从没被想起"的');
    assert.equal(result.stats.ready, 0, '但还没到期');
    assert.equal(result.stats.soonestInDays, 7, 'fact 满 7 天');
  } finally {
    await cleanup();
  }
});

test('整理：归档事件留痕，面板能说清"清掉了多少条死重"', async () => {
  const { store, cleanup } = await makeStore();
  try {
    const a = await store.write({ kind: 'fact', text: '用户提过想养一只边牧' });
    const b = await store.write({ kind: 'self', text: '我上次说过要少绕弯子' });
    age(store, a.id, 20);
    age(store, b.id, 20);
    await store.tidyUnused({ olderThanDays: 7, apply: true });
    const [event] = store.state.events.filter((item) => item.kind === 'memory.tidy-unused');
    assert.equal(event.payload.archived, 2);
  } finally {
    await cleanup();
  }
});
