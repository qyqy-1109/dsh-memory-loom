/**
 * 「被改写」信号与约束同根因体检的回归测试。
 *
 * 这两件事都挂在写入路径上，容易越改越"顺手多改一点"，所以每个断言都盯着
 * **这件事发生了没有**，而不是"顺手还做了什么"：
 *
 * ① 被取代/被解除的条目要记 `revisedCount` —— 这是全插件唯一「旧条目不够用」的证据。
 *    它必须**数全库**：被改写的那条通常已经归档了，只数活跃集会把这整类漏掉
 *    （`usedCount` 就是栽在"口径把自己算死"上：锚词要求用户在下一句复述，永远命中不了）。
 * ② 查重命中**不算**改写 —— 同一件事又说了一遍是加强，没有推翻任何东西。
 * ③ 写约束时撞上同根因的旧约束，只**提示**整理，绝不自动合并：合并会改写语义，
 *    而语义该由人确认。
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { MemoryStore } from '../lib/store.js';
import { reviseSignal } from '../lib/growth.js';

const SCAR_A =
  '改 dsh-memory-loom 源码只用 read/write/edit 工具，不要在 PowerShell 里用 Get-Content 管道回写文件——本机默认按 GBK 解码，会把中文和换行打坏。';
const SCAR_B =
  '永远不要用 PowerShell 的 Get-Content/Set-Content 管道改插件源文件：2026-11-07 用它改 package.json 时引入 UTF-8 BOM，JSON.parse 直接报错。只能用 read/write/edit 工具。';
const UNRELATED = '写入测试必须把 storePath 指到临时目录；用 apply(ctx, {}) 默认路径会写进真实记忆库。';

/** 临时目录里开一个真库（不碰用户记忆库）。 */
async function openTempStore() {
  const dir = await mkdtemp(join(tmpdir(), 'loom-revise-'));
  const store = new MemoryStore({ storePath: join(dir, 'store.json'), compactAt: 0 });
  await store.open();
  return { dir, store };
}

test('被取代：旧条目记一次改写，并带上时间', async () => {
  const { dir, store } = await openTempStore();
  try {
    const old = await store.write({ kind: 'fact', text: '用户住在杭州，周末常去西湖边跑步。' });
    assert.equal(store.byId(old.id).revisedCount, 0, '刚写下的条目没被改写');

    await store.write({ kind: 'fact', text: '用户搬到上海了，周末改去徐汇滨江跑步。', supersedes: [old.id] });
    const row = store.byId(old.id);
    assert.equal(row.revisedCount, 1, '被取代要记一次改写');
    assert.equal(typeof row.lastRevisedAt, 'number', '改写时间不能是 null');
    assert.equal(row.status, 'archived');
    assert.equal(store.state.meta.relaxCount, 0, '普通条目走归档，不走解除');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('被解除的约束也算改写（它已不是禁令，但确实是"旧的不够用"）', async () => {
  const { dir, store } = await openTempStore();
  try {
    const old = await store.write({ kind: 'constraint', text: '不要再往面板里加新视图了。' });
    await store.write({ kind: 'constraint', text: '面板视图到这里为止，以后只修不加。', supersedes: [old.id] });
    const row = store.byId(old.id);
    assert.equal(row.revisedCount, 1);
    assert.equal(typeof row.lastRevisedAt, 'number');
    assert.equal(row.relaxedAt !== null, true, '约束走解除留档');
    assert.equal(row.status, 'active', '解除后仍留在活跃集里留档');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('查重命中不算改写：同一件事又说一遍是加强，不是推翻', async () => {
  const { dir, store } = await openTempStore();
  try {
    const text = '用户偏好不透明的深空星图面板，明确拒绝玻璃拟态。';
    const first = await store.write({ kind: 'fact', text });
    const again = await store.write({ kind: 'fact', text });
    assert.equal(again.status, 'deduped', '同句写入应走查重');
    assert.equal(store.byId(first.id).revisedCount, 0, '查重只累加 hits，不记改写');
    assert.equal(store.byId(first.id).hits, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('带变化口吻又撞上近似旧条目：记到旧条目头上，事件里能查到是谁', async () => {
  const { dir, store } = await openTempStore();
  try {
    const old = await store.write({
      kind: 'fact',
      text: '记忆面板的底色用深空蓝，标题字号 14，侧栏折叠后只剩图标。',
    });
    // 相似度 ~0.56：低于查重线（同一件事会说一样），高于改写线（同一件事的不同版本）
    const next = await store.write({ kind: 'fact', text: '记忆面板的底色改成纯黑，标题字号 14。' });
    assert.equal(next.status, 'created', '不该被并进旧条目');
    assert.equal(store.byId(old.id).revisedCount, 1, '旧条目要记一次被改写');
    assert.ok(
      next.notes.some((note) => note.includes('被改写')),
      'notes 要说清是哪条被改写了，而不是只丢一句泛泛的提示',
    );
    const event = store.state.events.filter((item) => item.kind === 'write.change-hint').at(-1);
    assert.equal(event.payload.targetId, old.id, '埋点要能追到被改写的那条');
    assert.ok(event.payload.score >= 0.34);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('极性翻转也算改写：最有力的证伪样本不能因为"不该合并"被丢掉', async () => {
  const { dir, store } = await openTempStore();
  try {
    // 这一对相似度 0.74 > 查重线，但否定极性不同 → 查重会**故意**放弃合并。
    // 那正好是最该记成"被改写"的情形，抓不到就等于把最强的证据漏掉。
    const old = await store.write({ kind: 'fact', text: '用户喜欢深色主题。' });
    await store.write({ kind: 'fact', text: '用户不喜欢深色主题了，改成浅色。' });
    assert.equal(store.byId(old.id).revisedCount, 1, '极性翻转必须记成改写');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('带变化口吻但附近没有近似条目：不冤枉任何人', async () => {
  const { dir, store } = await openTempStore();
  try {
    const old = await store.write({ kind: 'fact', text: '用户偏好不透明的深空星图面板。' });
    const next = await store.write({ kind: 'fact', text: '数据库连接池改成每台机器 20 条上限。' });
    assert.equal(store.byId(old.id).revisedCount, 0, '不相干的旧条目不能被记成被改写');
    const event = store.state.events.filter((item) => item.kind === 'write.change-hint').at(-1);
    assert.equal(event.payload.targetId, undefined, '没有目标就不该编一个出来');
    assert.ok(next.notes.some((note) => note.includes('supersedes')));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('老库没有 revisedCount 字段：补 0，不当成"被改写过"', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'loom-revise-legacy-'));
  const file = join(dir, 'store.json');
  try {
    await writeFile(
      file,
      JSON.stringify({
        version: 1,
        createdAt: 1,
        updatedAt: 1,
        memories: [
          {
            id: 'legacy-1',
            kind: 'fact',
            text: '一条老格式的记忆。',
            actor: 'user',
            status: 'active',
            hits: 3,
            createdAt: 1,
            updatedAt: 1,
          },
        ],
        slots: [],
        summaries: [],
        edges: [],
        cfgOverrides: {},
        events: [],
        recall: { last: null, count: 0 },
        meta: { writeCount: 1, dedupeCount: 0, archiveCount: 0, relaxCount: 0, forgetCount: 0 },
      }),
      'utf8',
    );
    const store = new MemoryStore({ storePath: file, compactAt: 0 });
    await store.open();
    const row = store.byId('legacy-1');
    assert.equal(row.revisedCount, 0);
    assert.equal(row.lastRevisedAt, null);
    assert.equal(store.counts().revisedTotal, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('计数与快照：改写数要数全库（归档的也算），快照要带字段给面板', async () => {
  const { dir, store } = await openTempStore();
  try {
    const old = await store.write({ kind: 'fact', text: '用户住在杭州，周末常去西湖边跑步。' });
    await store.write({ kind: 'fact', text: '用户搬到上海了，周末改去徐汇滨江跑步。', supersedes: [old.id] });

    assert.equal(store.counts().revisedTotal, 1, '被改写的那条已归档，仍然要计入');
    const snapshot = store.snapshot();
    const row = snapshot.memories.find((item) => item.id === old.id);
    assert.equal(row.revisedCount, 1, '快照漏了字段，面板就显示不出来');
    assert.equal(typeof row.lastRevisedAt, 'number');
    const slotShape = store.snapshot().memories.filter((item) => item.kind === 'slot');
    assert.ok(slotShape.every((item) => item.revisedCount === 0), '槽位形状要一致，不能被漏成 undefined');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('约束同根因体检：只提示，不自动合并', async () => {
  const { dir, store } = await openTempStore();
  try {
    await store.write({ kind: 'constraint', text: SCAR_A });
    const second = await store.write({ kind: 'constraint', text: SCAR_B });

    assert.ok(
      second.notes.some((note) => note.includes('同根因')),
      '第二条同根因约束必须当场提示，否则契约块只会越写越贵',
    );
    assert.equal(store.counts().constraintsActive, 2, '提示归提示，库里的条数不能自作主张变少');
    const event = store.state.events.filter((item) => item.kind === 'constraint.same-root').at(-1);
    assert.ok(event !== undefined, '要留埋点，事后才能对账');
    assert.equal(event.payload.targetId !== second.id, true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('约束同根因体检：不相干的约束不报警（宁可不提，也不狼来了）', async () => {
  const { dir, store } = await openTempStore();
  try {
    await store.write({ kind: 'constraint', text: SCAR_A });
    const second = await store.write({ kind: 'constraint', text: UNRELATED });
    assert.ok(!second.notes.some((note) => note.includes('同根因')));
    assert.equal(store.state.events.filter((item) => item.kind === 'constraint.same-root').length, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('约束同根因体检：已解除的约束不算同类（它已经不是禁令了）', async () => {
  const { dir, store } = await openTempStore();
  try {
    const old = await store.write({ kind: 'constraint', text: SCAR_A });
    const replacement = await store.write({ kind: 'constraint', text: SCAR_B, supersedes: [old.id] });
    assert.ok(
      !replacement.notes.some((note) => note.includes('同根因')),
      '旧的那条是在写入同一次里被解除的，不该再拿它报警',
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('落盘：改写记录必须真的写进文件，而不只在内存里', async () => {
  const { dir, store } = await openTempStore();
  try {
    const old = await store.write({ kind: 'fact', text: '用户住在杭州，周末常去西湖边跑步。' });
    await store.write({ kind: 'fact', text: '用户搬到上海了，周末改去徐汇滨江跑步。', supersedes: [old.id] });
    const onDisk = JSON.parse(await readFile(join(dir, 'store.json'), 'utf8'));
    const row = onDisk.memories.find((item) => item.id === old.id);
    assert.equal(row.revisedCount, 1, '只在内存里改不算数，重启就没了');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('补历史：字段是后加的，但日志里已经有改写，读数不该从 0 起算', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'loom-revise-backfill-'));
  const file = join(dir, 'store.json');
  try {
    await writeFile(
      file,
      JSON.stringify({
        version: 1,
        createdAt: 1,
        updatedAt: 1,
        memories: [
          {
            id: 'old-1',
            kind: 'fact',
            text: '用户住在杭州。',
            actor: 'user',
            status: 'archived',
            archivedAt: 300,
            archivedReason: 'superseded',
            hits: 1,
            createdAt: 1,
            updatedAt: 300,
          },
          { id: 'new-1', kind: 'fact', text: '用户搬到上海了。', actor: 'user', status: 'active', hits: 0, createdAt: 300, updatedAt: 300 },
        ],
        slots: [],
        summaries: [],
        edges: [],
        cfgOverrides: {},
        events: [
          { ts: 300, kind: 'write.create', payload: { id: 'new-1' } },
          { ts: 300, kind: 'memory.supersede', payload: { by: 'new-1', ids: ['old-1'] } },
          { ts: 310, kind: 'write.change-hint', payload: { id: 'new-1' } },
        ],
        recall: { last: null, count: 0 },
        meta: { writeCount: 2, dedupeCount: 0, archiveCount: 1, relaxCount: 0, forgetCount: 0 },
      }),
      'utf8',
    );

    const first = new MemoryStore({ storePath: file, compactAt: 0 });
    await first.open();
    const row = first.byId('old-1');
    assert.equal(row.revisedCount, 1, '日志里明明有一条改写记录，不能当没发生');
    assert.equal(row.lastRevisedAt, 300);
    assert.equal(first.state.meta.revisedBackfill, true, '补过就要打标记，否则每次启动都重来');

    // 再开一次：幂等，不能越补越多
    const second = new MemoryStore({ storePath: file, compactAt: 0 });
    await second.open();
    assert.equal(second.byId('old-1').revisedCount, 1, '重复启动不能累加出假历史');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('补历史：没有 targetId 的旧埋点不猜（宁缺毋滥）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'loom-revise-noguess-'));
  const file = join(dir, 'store.json');
  try {
    await writeFile(
      file,
      JSON.stringify({
        version: 1,
        createdAt: 1,
        updatedAt: 1,
        memories: [{ id: 'a', kind: 'fact', text: '一条记忆。', actor: 'user', status: 'active', hits: 0, createdAt: 1, updatedAt: 1 }],
        slots: [],
        summaries: [],
        edges: [],
        cfgOverrides: {},
        events: [{ ts: 5, kind: 'write.change-hint', payload: { id: 'a' } }],
        recall: { last: null, count: 0 },
        meta: { writeCount: 1, dedupeCount: 0, archiveCount: 0, relaxCount: 0, forgetCount: 0 },
      }),
      'utf8',
    );
    const store = new MemoryStore({ storePath: file, compactAt: 0 });
    await store.open();
    assert.equal(store.byId('a').revisedCount, 0, '不知道改的是哪条，就不该往任何人头上记');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('改写信号：数全库、给比例、指认最集中的那一类', () => {
  const state = {
    memories: [
      { id: 'a', kind: 'constraint', text: '甲', status: 'active', createdAt: 1, revisedCount: 2 },
      { id: 'b', kind: 'constraint', text: '乙', status: 'active', createdAt: 1, revisedCount: 1 },
      { id: 'c', kind: 'fact', text: '丙', status: 'archived', createdAt: 1, revisedCount: 1 },
      { id: 'd', kind: 'fact', text: '丁', status: 'active', createdAt: 1, revisedCount: 0 },
      { id: 'e', kind: 'fact', text: '戊', status: 'active', createdAt: 1 },
    ],
  };
  const signal = reviseSignal(state);
  assert.equal(signal.rows, 5);
  assert.equal(signal.revisedRows, 3, '归档的 c 也要算进来');
  assert.equal(signal.touched, 4, '一条可以被改多次');
  assert.equal(signal.byKind.constraint, 2);
  assert.equal(signal.heaviestKind, 'constraint');
  assert.equal(signal.rate, 3 / 5);
});

test('改写信号：一条都没被改写时如实说 0，不编数字', () => {
  const signal = reviseSignal({
    memories: [{ id: 'a', kind: 'fact', text: '甲', status: 'active', createdAt: 1 }],
  });
  assert.equal(signal.revisedRows, 0);
  assert.equal(signal.rate, 0);
  assert.equal(signal.heaviestKind, null);
});
