/**
 * 人格（自我）的回归测试。
 *
 * 这个文件守的是规格 `docs/specs/self-growth-v0.md` 里那几条纪律 ——
 * 它们全是"少写一行代码就悄悄失效"的那种：
 *
 * ① 迁移必须**一字不差**：老叙事拆成原理再合回来，如果多一个项目符号，
 *    迁移本身就成了"静默改字节"（这条踩过三次）。
 * ② 内核只有人能写：模型侧没有入口，store 还要再拒一次非面板来源。
 * ③ 预算超了拒绝写入，不许自动截断 —— 截断等于静默丢人格片段。
 * ④ 加原理必须挂证据，退原理必须先被推翻过：只加不减不是成长，是僵化。
 * ⑤ 合并后不许变长：合并不是换个地方继续膨胀。
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { MemoryStore } from '../lib/store.js';
import { narrativeSignal } from '../lib/growth.js';

/** 临时目录里开一个真库（绝不碰用户记忆库）。 */
async function openTempStore(options = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'loom-self-'));
  const store = new MemoryStore({ storePath: join(dir, 'store.json'), compactAt: 0, ...options });
  await store.open();
  return { dir, store };
}

async function close(dir) {
  await rm(dir, { recursive: true, force: true });
}

/** 老库里那段 127 字的自我叙事（换成 3 行，便于验证逐字还原）。 */
const LEGACY_LINES = ['我的成长靠压缩，不靠积累', '定指标先问物理条件成不成立', '做取舍先算代价'];
const LEGACY_TEXT = LEGACY_LINES.join('\n');

/** 造一个"0.50 及以前"的库：只有 selfNarrative，没有 self。 */
async function openLegacyStore() {
  const dir = await mkdtemp(join(tmpdir(), 'loom-self-legacy-'));
  const file = join(dir, 'store.json');
  await writeFile(
    file,
    JSON.stringify({
      version: 1,
      memories: [],
      summaries: [],
      slots: [],
      edges: [],
      events: [],
      selfNarrative: {
        current: {
          id: 'legacy-1',
          text: LEGACY_TEXT,
          at: 1_700_000_000_000,
          reason: '第一版自我叙事',
          source: 'tool',
          sessionId: null,
          chars: [...LEGACY_TEXT].length,
        },
        versions: [],
      },
    }),
    'utf8',
  );
  const store = new MemoryStore({ storePath: file, compactAt: 0 });
  await store.open();
  return { dir, file, store };
}

test('空库：内核与原理都空，合成文本为空，不是坏数据', async () => {
  const { dir, store } = await openTempStore();
  try {
    assert.equal(store.selfCore(), null);
    assert.deepEqual(store.livePrinciples(), []);
    assert.equal(store.selfNarrative(), null);
    const view = store.selfView();
    assert.equal(view.composed.chars, 0);
    assert.equal(view.budget.totalMax, 600);
    assert.equal(view.budget.coreMax, 120);
    assert.equal(view.budget.principleLimit, 9);
  } finally {
    await close(dir);
  }
});

test('迁移：老叙事按行拆成原理，合回来必须一字不差', async () => {
  const { dir, store } = await openLegacyStore();
  try {
    const principles = store.livePrinciples();
    assert.equal(principles.length, 3, '三行拆成三条原理');
    assert.deepEqual(principles.map((row) => row.text), LEGACY_LINES);
    assert.equal(store.selfCore(), null, '内核不猜：迁移不替用户写三观');
    assert.equal(store.selfNarrative().text, LEGACY_TEXT, '迁移不许改一个字节');
    assert.equal(store.selfNarrative().chars, [...LEGACY_TEXT].length);
    // 迁移要能被回看：流水里留一条，说明它从哪来
    const oplog = store.selfOplog();
    assert.equal(oplog.length, 1);
    assert.equal(oplog[0].op, 'restore');
    assert.match(oplog[0].reason, /迁移/);
  } finally {
    await close(dir);
  }
});

test('迁移是幂等的：再开一次不会长出第二批原理', async () => {
  const { dir, store } = await openLegacyStore();
  try {
    assert.equal(store.livePrinciples().length, 3);
    store.state = undefined;
    await store.open();
    assert.equal(store.livePrinciples().length, 3, '重启后仍然只有三条');
    assert.equal(store.selfOplog().length, 1, '流水也不会重复记迁移');
    const onDisk = JSON.parse(await readFile(store.file, 'utf8'));
    assert.equal(onDisk.self.principles.length, 3);
  } finally {
    await close(dir);
  }
});

test('内核：只有人能写 —— 非面板来源一律拒绝', async () => {
  const { dir, store } = await openTempStore();
  try {
    await assert.rejects(
      () => store.setCore({ text: '我先量，再下结论。', reason: '想写', source: 'tool' }),
      /只能由人经面板写入/,
    );
    assert.equal(store.selfCore(), null, '被拒之后一个字都不能留下');
    const ok = await store.setCore({ text: '我先量，再下结论。', reason: '第一次写内核', source: 'panel' });
    assert.equal(ok.chars, 9);
    assert.equal(store.selfCore().text, '我先量，再下结论。');
    assert.equal(store.selfCore().by, 'user');
  } finally {
    await close(dir);
  }
});

test('内核：超字数与没理由都拒绝', async () => {
  const { dir, store } = await openTempStore();
  try {
    await assert.rejects(() => store.setCore({ text: '字'.repeat(121), reason: '超了', source: 'panel' }), /超过上限 120/);
    await assert.rejects(() => store.setCore({ text: '够短', reason: '   ', source: 'panel' }), /理由/);
    assert.equal(store.selfCore(), null);
  } finally {
    await close(dir);
  }
});

test('原理：必须挂证据，且单条有字数上限', async () => {
  const { dir, store } = await openTempStore();
  try {
    const { id } = await store.write({ kind: 'episode', text: '压缩前后注入对比跑了一遍', scene: '实测' });
    await assert.rejects(
      () => store.addPrinciple({ text: '先量再改', reason: '想加', evidence: [] }),
      /必须挂证据/,
    );
    await assert.rejects(
      () => store.addPrinciple({ text: '先量再改', reason: '想加', evidence: ['not-exist'] }),
      /找不到证据记忆/,
    );
    await assert.rejects(
      () => store.addPrinciple({ text: '字'.repeat(41), reason: '想加', evidence: [id] }),
      /单条上限 40/,
    );
    const result = await store.addPrinciple({ text: '先量再改', reason: '实测过一次', evidence: [id] });
    assert.equal(result.live, 1);
    const [row] = store.livePrinciples();
    assert.equal(row.evidence.proven, 1);
    assert.deepEqual(row.bornFrom, [id]);
  } finally {
    await close(dir);
  }
});

test('原理：到上限就拒绝新增（不做自动截断）', async () => {
  const { dir, store } = await openTempStore({ principleLimit: 2 });
  try {
    const { id } = await store.write({ kind: 'fact', text: '一条证据' });
    await store.addPrinciple({ text: '第一条', reason: '一', evidence: [id] });
    await store.addPrinciple({ text: '第二条', reason: '二', evidence: [id] });
    await assert.rejects(
      () => store.addPrinciple({ text: '第三条', reason: '三', evidence: [id] }),
      /请先合并或退役/,
    );
    assert.equal(store.livePrinciples().length, 2);
  } finally {
    await close(dir);
  }
});

test('契约预算：超了就拒绝写入，绝不悄悄截断', async () => {
  const { dir, store } = await openTempStore({ selfContractBudget: 30 });
  try {
    const { id } = await store.write({ kind: 'fact', text: '一条证据' });
    await store.addPrinciple({ text: '字'.repeat(20), reason: '一', evidence: [id] });
    await assert.rejects(
      () => store.addPrinciple({ text: '字'.repeat(20), reason: '二', evidence: [id] }),
      /超过契约预算 30/,
    );
    assert.equal(store.livePrinciples().length, 1, '被拒之后原来那条还在');
  } finally {
    await close(dir);
  }
});

test('退役：没被推翻过不许退；记过 broken 之后才能退', async () => {
  const { dir, store } = await openTempStore();
  try {
    const { id: memoryId } = await store.write({ kind: 'fact', text: '一条证据' });
    const { id } = await store.addPrinciple({ text: '先量再下结论', reason: '实测', evidence: [memoryId] });
    await assert.rejects(
      () => store.retirePrinciple({ id, reason: '不想了' }),
      /还没有被推翻过/,
    );
    await assert.rejects(
      () => store.recordPrincipleEvidence({ id, result: 'broken', note: '' }),
      /必须写一句 note/,
    );
    const evidence = await store.recordPrincipleEvidence({ id, result: 'broken', note: '这次没量就下了结论', memoryId });
    assert.equal(evidence.evidence.broken, 1);
    await store.retirePrinciple({ id, reason: '被现实推翻了一次' });
    assert.equal(store.livePrinciples().length, 0);
    const retired = store.selfPrinciples().find((row) => row.id === id);
    assert.equal(retired.status, 'retired');
    assert.match(retired.retiredReason, /被现实推翻/);
  } finally {
    await close(dir);
  }
});

test('退役（被取代）：显式 superseded 可以绕过 broken 门槛', async () => {
  const { dir, store } = await openTempStore();
  try {
    const { id: memoryId } = await store.write({ kind: 'fact', text: '一条证据' });
    const { id } = await store.addPrinciple({ text: '旧的判断', reason: '一', evidence: [memoryId] });
    await store.retirePrinciple({ id, reason: '被更好的那条取代了', superseded: true });
    assert.equal(store.livePrinciples().length, 0);
  } finally {
    await close(dir);
  }
});

test('合并：两条合成一条、字数不增；合完比原来长就拒绝', async () => {
  const { dir, store } = await openTempStore();
  try {
    const { id: memoryId } = await store.write({ kind: 'fact', text: '一条证据' });
    const first = await store.addPrinciple({ text: '先量再下结论', reason: '一', evidence: [memoryId] });
    const second = await store.addPrinciple({ text: '量完敢换口径', reason: '二', evidence: [memoryId] });
    await assert.rejects(
      () => store.mergePrinciples({ ids: [first.id, second.id], text: '先量再下结论而且量完敢换口径这句话明显更长了', reason: '合' }),
      /还长/,
    );
    const merged = await store.mergePrinciples({ ids: [first.id, second.id], text: '先量，量完敢换口径', reason: '两条其实是一件事' });
    assert.equal(merged.merged, 2);
    assert.equal(store.livePrinciples().length, 1);
    assert.equal(store.selfPrinciples().filter((row) => row.status === 'retired').length, 2);
    const oplog = store.selfOplog();
    assert.equal(oplog[0].op, 'merge');
    assert.match(oplog[0].before, /先量再下结论/);
  } finally {
    await close(dir);
  }
});

test('操作流水：每一次改动都留 op 与理由，退役记录不会被裁掉', async () => {
  const { dir, store } = await openTempStore({ selfOplogLimit: 3 });
  try {
    const { id: memoryId } = await store.write({ kind: 'fact', text: '一条证据' });
    const { id } = await store.addPrinciple({ text: '先量', reason: '一', evidence: [memoryId] });
    await store.recordPrincipleEvidence({ id, result: 'broken', note: '没量就下了结论' });
    await store.retirePrinciple({ id, reason: '被推翻' });
    for (let index = 0; index < 5; index += 1) {
      await store.addPrinciple({ text: `第${index}条`, reason: `第${index}次加`, evidence: [memoryId] });
    }
    const ops = store.selfOplog(50).map((row) => row.op);
    assert.ok(ops.includes('retire'), '退役的决策不可回放，不能被裁掉');
    assert.ok(ops.length <= 6, `流水受上限约束（现在是 ${ops.length}）`);
    const every = store.selfOplog(50);
    assert.ok(every.every((row) => String(row.reason).trim().length > 0), '每条都必须有理由');
  } finally {
    await close(dir);
  }
});

test('注入：合成文本原样进【我是谁】块，退役的不进', async () => {
  const { dir, store } = await openTempStore();
  try {
    const { id: memoryId } = await store.write({ kind: 'fact', text: '一条证据' });
    await store.setCore({ text: '我先量，再下结论。', reason: '写内核', source: 'panel' });
    const { id } = await store.addPrinciple({ text: '成长靠压缩不靠累积', reason: '一', evidence: [memoryId] });
    const block = () => store.buildRecall('随便聊两句').blocks.find((row) => row.name === 'narrative');
    assert.equal(block().text, `我先量，再下结论。\n成长靠压缩不靠累积`);
    await store.recordPrincipleEvidence({ id, result: 'broken', note: '这次囤积了' });
    await store.retirePrinciple({ id, reason: '被推翻' });
    assert.equal(block().text, '我先量，再下结论。', '退役之后注入里只剩内核');
  } finally {
    await close(dir);
  }
});

test('合成视图：变了的旧文本才进历史，漂移读数还读得到', async () => {
  const { dir, store } = await openTempStore();
  try {
    const { id: memoryId } = await store.write({ kind: 'fact', text: '一条证据' });
    await store.setCore({ text: '第一版内核', reason: '一', source: 'panel' });
    await store.setCore({ text: '第二版内核：换了个说法', reason: '二', source: 'panel' });
    const history = store.selfNarrativeHistory();
    assert.equal(history.length, 1, '一字未改的不该凭空多一版');
    assert.equal(history[0].text, '第一版内核');
    const signal = narrativeSignal(store.state);
    assert.equal(signal.has, true);
    assert.equal(signal.versions, 1);
    assert.ok(signal.drift > 0, '换过说法，漂移度必须大于 0');
    assert.equal(signal.chars, [...'第二版内核：换了个说法'].length);
    void memoryId;
  } finally {
    await close(dir);
  }
});

test('硬约束：人格可以影响"写"，不能影响"读"', async () => {
  // 规格 D0-D：人格一旦能筛记忆，就只会捞回证实自己的那些 —— 那是偏执，不是灵魂。
  // 这里用行为守住它：写人格前后，同一句查询的检索结果必须一模一样。
  const { dir, store } = await openTempStore();
  try {
    const a = await store.write({ kind: 'fact', text: '她喜欢手冲咖啡，不加糖' });
    const b = await store.write({ kind: 'fact', text: '她讨厌会议纪要式的回答' });
    const query = '咖啡';
    const before = store.search(query, { limit: 5 }).map((row) => row.id);
    assert.ok(before.includes(a.id), '前提：查询本来就能命中那条记忆');

    await store.setCore({ text: '我先量，再下结论。', reason: '写内核', source: 'panel' });
    await store.addPrinciple({ text: '咖啡那件事不重要', reason: '想试试能不能影响召回', evidence: [b.id] });
    const after = store.search(query, { limit: 5 }).map((row) => row.id);
    assert.deepEqual(after, before, '人格不许改变"哪些记忆能被检索到"');

    // 另一个方向：人格确实进得了注入（影响"写/读到的自我"，不是"筛记忆"）
    const blocks = store.buildRecall(query).blocks;
    assert.ok(blocks.some((row) => row.name === 'narrative'), '人格仍然每轮在场');
  } finally {
    await close(dir);
  }
});

test('落盘：内核、原理、流水都要真的写进文件', async () => {
  const { dir, store } = await openTempStore();
  try {
    const { id: memoryId } = await store.write({ kind: 'fact', text: '一条证据' });
    await store.setCore({ text: '我先量，再下结论。', reason: '写内核', source: 'panel' });
    await store.addPrinciple({ text: '成长靠压缩不靠累积', reason: '一', evidence: [memoryId] });
    const onDisk = JSON.parse(await readFile(store.file, 'utf8'));
    assert.equal(onDisk.self.core.text, '我先量，再下结论。');
    assert.equal(onDisk.self.principles.length, 1);
    assert.equal(onDisk.self.principles[0].bornFrom[0], memoryId);
    assert.equal(onDisk.self.oplog.length, 2);
    assert.equal(onDisk.selfNarrative.current.text, '我先量，再下结论。\n成长靠压缩不靠累积');
  } finally {
    await close(dir);
  }
});
