/**
 * 压缩循环 v2 的回归测试（规格见 docs/specs/compaction-v2.md）。
 *
 * 这一版把触发判据从"库存到 1200"改成"同主题冗余够多"，所以守的东西是：
 * ① 小库也能压出来（旧代码在 220 条的库上永远不动，那是这次要修的因）；
 * ② 被摘要盖住的原条**永不被物理修剪**——它是摘要的唯一可信度来源；
 * ③ 摘要不会再被压成摘要（两代封顶，写成测试而不是靠"现在刚好这样"）；
 * ④ 跟簇主题对不上的例外留在活跃；
 * ⑤ 冷却与兜底上限都在。
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { MemoryStore, EVICTABLE } from '../lib/store.js';

async function openTempStore(options = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'loom-compact-'));
  const store = new MemoryStore({
    storePath: join(dir, 'store.json'),
    // 这一版的关键：不再需要把 compactAt 调到 0 才能触发
    compactCooldownMs: 0,
    compactDelta: 1,
    ...options,
  });
  await store.open();
  return { dir, store };
}

async function close(dir) {
  await rm(dir, { recursive: true, force: true });
}

const TOPIC = [
  '写源码只用 read/write/edit 工具，别用 PowerShell 回写，会写出 BOM',
  '改源码不要走 PowerShell 管道回写，会把多行压成一行还带 BOM',
  '源码改动一律用 read/write/edit，PowerShell 回写会静默改字节',
  'PowerShell 的 Set-Content 写 UTF-8 会带 BOM，源码只用编辑工具改',
  '别用 PowerShell 改源码文件，BOM 和换行都会被它偷偷改掉',
  '源码编辑只用 read/write/edit，PowerShell 会静默改字节',
  '写文件不要用 PowerShell 兜一圈，编码会坏，只用 read/write/edit',
];

test('小库也能压：不再等库存到 1200', async () => {
  const { dir, store } = await openTempStore({ summaryMinMembers: 4 });
  try {
    for (const text of TOPIC) await store.write({ kind: 'fact', text });
    assert.ok(store.state.summaries.length > 0, '同主题七条应该被压成摘要，而不是等库存到 1200');
    const summary = store.state.summaries[0];
    assert.ok(summary.memberCount >= 4, '至少四条成员');
    assert.ok(summary.memberIds.length >= 4);
    // 成员必须是归档，不是删除
    for (const id of summary.memberIds.slice(0, 3)) {
      const row = store.byId(id);
      assert.equal(row.status, 'archived', '成员归档，不是消失');
      assert.equal(row.summarizedBy, summary.id, '成员要指回摘要');
    }
  } finally {
    await close(dir);
  }
});

test('闸一：被摘要盖住的原文，永不被归档修剪物理删除', async () => {
  const { dir, store } = await openTempStore({ summaryMinMembers: 4, maxArchive: 1 });
  try {
    for (const text of TOPIC) await store.write({ kind: 'fact', text });
    const summary = store.state.summaries[0];
    assert.ok(summary !== undefined);
    const members = summary.memberIds.slice();
    // 塞一堆别的归档把归档池顶爆，逼它修剪
    for (let index = 0; index < 8; index += 1) {
      const row = await store.write({ kind: 'fact', text: `无关的临时记录 ${index} 号，用来顶满归档池` });
      await store.forget(row.id, { reason: 'test' });
    }
    const alive = members.filter((id) => store.byId(id) !== undefined);
    assert.equal(alive.length, members.length, '摘要的原文一条都不许被物理删掉——删了摘要就指着空气');
  } finally {
    await close(dir);
  }
});

test('闸二：摘要不会被压成摘要（两代封顶）', async () => {
  const { dir, store } = await openTempStore({ summaryMinMembers: 3 });
  try {
    for (const text of TOPIC) await store.write({ kind: 'fact', text });
    const first = store.state.summaries.length;
    assert.ok(first > 0);
    // 再写一批同主题的，看会不会把上一轮的摘要也吸进去
    for (let index = 0; index < 5; index += 1) {
      await store.write({ kind: 'fact', text: `又一条讲 BOM 的：PowerShell 回写会把源码的字节偷偷改掉 ${index}` });
    }
    for (const summary of store.state.summaries) {
      assert.equal(summary.kind, undefined, '摘要不该被当成一条记忆再参与压缩');
      assert.equal(String(summary.id).length > 0, true);
    }
    // 结构保证：可淘汰集合里没有 summary 这个种类
    assert.equal(EVICTABLE.has('summary'), false, 'summary 不许进可淘汰/可压缩集合');
  } finally {
    await close(dir);
  }
});

test('闸三：跟簇主题对不上的例外留在活跃', async () => {
  const { dir, store } = await openTempStore({ summaryMinMembers: 4 });
  try {
    for (const text of TOPIC) await store.write({ kind: 'fact', text });
    // 一条离群的：字面上也提 BOM，但讲的是完全另一件事
    const outlier = await store.write({
      kind: 'fact',
      text: '豆豆是只猫，三岁，怕吹风机，剪指甲要两个人按着',
    });
    const inAnySummary = store.state.summaries.some((summary) => summary.memberIds.includes(outlier.id));
    assert.equal(inAnySummary, false, '离群的那条不该被吸进摘要——那是最容易被压掉的例外');
    assert.equal(store.byId(outlier.id).status, 'active', '例外要留在活跃');
  } finally {
    await close(dir);
  }
});

test('离群判据是相对的：低相似度的簇不许被整组判死', async () => {
  const { dir, store } = await openTempStore({ summaryMinMembers: 3, summaryOutlierFloor: 0.18 });
  try {
    /**
     * 真库实测：同一个簇里两两相似度只有 0.08–0.26（IDF 覆盖率本来就压得低）。
     * 绝对地板 0.18 会把 22 条的簇筛成 4 条、7 条的簇筛成 1-2 条 —— 一条摘要都压不出来。
     * 这里用一批"共享词但措辞各异"的条目复现那个形状。
     */
    const loose = [
      '压缩触发线定在 1200 条，小库永远到不了，摘要层三个月没动',
      '摘要的原文要是被归档修剪删掉，指针就断了，撤销也回不去',
      '两代封顶这一条得靠测试锁住，不然摘要会被再压成摘要',
      '例外条目最值钱，压缩时把它留在活跃里，别一起吸走',
      '撤销率高说明聚类判据有问题，该回头改判据',
      '压不出来就空跑一次，几毫秒而已，比永远不跑强',
    ];
    for (const text of loose) await store.write({ kind: 'fact', text });
    const produced = store.state.summaries.length;
    const skipped = (store.state.events ?? []).filter((event) => event.kind === 'summary.skip-outliers').length;
    assert.ok(produced > 0, `松散簇也该压得出来（现在 0 组，跳过了 ${skipped} 次）`);
  } finally {
    await close(dir);
  }
});

test('快照把摘要全给出去：看得见的才撤得回', async () => {
  const { dir, store } = await openTempStore();
  try {
    // 直接摆 8 条：这条测的是快照的裁剪口径，不是聚类
    store.state.summaries = Array.from({ length: 8 }, (_, index) => ({
      id: `s-${index}`,
      topic: `t-${index}`,
      memberIds: [],
      memberCount: 0,
      createdAt: index,
    }));
    const snapshot = store.snapshot();
    assert.equal(snapshot.summaries.length, 8, '不许只给最近 5 条——老的看不见也就撤不了');
    assert.equal(snapshot.summaries[0].id, 's-7', '按时间倒序，最近的在前');
  } finally {
    await close(dir);
  }
});

test('重写材料取的是成员原文，不是摘要自己的文字', async () => {
  const { dir, store } = await openTempStore({ summaryMinMembers: 4 });
  try {
    for (const text of TOPIC) await store.write({ kind: 'fact', text });
    const summary = store.state.summaries[0];
    assert.ok(summary !== undefined, '前提：先压出一组');
    const payload = store.summaryPayload(summary.id);
    assert.notEqual(payload, null);
    assert.equal(payload.id, summary.id);
    assert.ok(payload.points.length >= 4, '要有原文可喂给模型');
    assert.ok(
      payload.points.some((point) => point.includes('read/write/edit')),
      '材料必须是成员原文，不能是摘要自己的拼接文本（那会变成传话游戏的第一环）',
    );
    assert.equal(store.summaryPayload('不存在'), null);
  } finally {
    await close(dir);
  }
});

test('冷却与兜底上限：冷却没到就空跑，超过 compactAt 就无视冷却', async () => {
  const { dir, store } = await openTempStore({ compactCooldownMs: 3_600_000, compactDelta: 999, compactAt: 0 });
  try {
    const first = await store.write({ kind: 'fact', text: TOPIC[0] });
    assert.ok(first.id.length > 0);
    for (const text of TOPIC.slice(1)) await store.write({ kind: 'fact', text });
    assert.equal(store.state.summaries.length, 0, '冷却没到、增量不够，不许压');
  } finally {
    await close(dir);
  }

  const second = await openTempStore({ compactCooldownMs: 3_600_000, compactDelta: 999, compactAt: 3 });
  try {
    for (const text of TOPIC) await second.store.write({ kind: 'fact', text });
    assert.ok(second.store.state.summaries.length > 0, '活跃超过 compactAt 应当无视冷却直接跑');
  } finally {
    await close(second.dir);
  }
});
