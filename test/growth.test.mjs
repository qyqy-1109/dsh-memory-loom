/**
 * 成长读数的回归测试。
 *
 * 这个文件守四件事，每一件都是「读数一旦歪了，人就会照着错的数做决定」：
 *
 * ① `contractCost` 必须和 `buildRecall` 吐出来的三块**逐字对齐** ——
 *    它度量的是注入开销，口径一漂，历史曲线就不再可比（还会偏低，让人以为库很轻）。
 * ② 同根因聚类不能靠一把随意挑的门槛：真实库实测同根因那对 0.28、其余 ≤0.09，
 *    门槛落在空隙里；`stable` 字段负责说出「这组可能是巧合」。
 * ③ 回测要给出**缺哪些词**，而不只是覆盖率数字 —— 数字不能执行，词能。
 * ④ 成长曲线量密度不量条数：条数涨而密度跌是「变胖」的典型形状，必须能被读出来。
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { MemoryStore } from '../lib/store.js';
import {
  analyzeGrowth,
  backtest,
  collapseTokens,
  contractCost,
  contentOf,
  growthCurve,
  rootCauseGroups,
  usedSignal,
} from '../lib/growth.js';

const DAY = 86_400_000;

/** 真实库里的两条约束：讲的是同一件事（静默改字节），但说法差很远。 */
const SCAR_A =
  '改 dsh-memory-loom 源码只用 read/write/edit 工具，不要在 PowerShell 里用 Get-Content 管道回写文件——本机默认按 GBK 解码，会把中文和换行打坏。';
const SCAR_B =
  '永远不要用 PowerShell 的 Get-Content/Set-Content 管道改插件源文件：2026-11-07 用它改 package.json 时引入 UTF-8 BOM，JSON.parse 直接报错。只能用 read/write/edit 工具。';
/** 同层的另一条约束，和上面两条无关。 */
const UNRELATED = '写入测试必须把 storePath 指到临时目录；用 apply(ctx, {}) 默认路径会写进真实记忆库。';

/** 临时目录里开一个真库（不碰用户记忆库）。 */
async function openTempStore() {
  const dir = await mkdtemp(join(tmpdir(), 'loom-growth-'));
  const store = new MemoryStore({ storePath: join(dir, 'store.json'), compactAt: 0 });
  await store.open();
  return { dir, store };
}

/** 造一条最小可用的记忆行。 */
function row(id, extra = {}) {
  return { id, kind: 'fact', text: `条目 ${id}`, status: 'active', createdAt: 0, hits: 0, usedCount: 0, ...extra };
}

test('契约块开销：三块的文本与 buildRecall 逐字一致（口径漂移会让曲线不可比）', async () => {
  const { dir, store } = await openTempStore();
  try {
    await store.write({ kind: 'constraint', text: SCAR_A });
    await store.write({ kind: 'constraint', text: UNRELATED });
    await store.write({ kind: 'slot', entity: '记忆海', attr: '形态', text: '宿主 main 槽的一整页' });
    await store.write({ kind: 'episode', text: '一起把记忆面板换了五种承载', scene: '在 Desktop 上', significance: 4 });

    const cost = contractCost(store.state, store.cfg);
    const recall = store.buildRecall('');

    for (const name of ['constraints', 'slots', 'episodes']) {
      const fromStore = (recall.blocks ?? []).find((block) => block.name === name);
      const fromGrowth = cost.blocks.find((block) => block.name === name);
      assert.ok(fromStore !== undefined, `${name} 块在 buildRecall 里必须存在`);
      assert.ok(fromGrowth !== undefined, `${name} 块在 contractCost 里必须存在`);
      assert.equal(fromGrowth.text, fromStore.text, `${name} 块的拼法必须逐字一致`);
      assert.equal(fromGrowth.chars, [...fromStore.text].length);
    }
    assert.equal(
      cost.chars,
      cost.blocks.reduce((sum, block) => sum + block.chars, 0),
      '总字数必须等于各块之和',
    );
    assert.ok(cost.chars > 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('契约块开销：被解除的约束不再算进开销（它已不是禁令）', async () => {
  const { dir, store } = await openTempStore();
  try {
    const written = await store.write({ kind: 'constraint', text: SCAR_A });
    const before = contractCost(store.state, store.cfg);
    assert.equal(before.total, 1, '解除前算一条');
    store.byId(written.id).relaxedAt = Date.now();
    const after = contractCost(store.state, store.cfg);
    assert.equal(after.total, 0, '解除后不该再计入每轮注入');
    assert.equal(after.chars, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('同根因疤痕：真实库里那两条聚成一组，无关的不会被拉进来', () => {
  const groups = rootCauseGroups([
    { id: 'a', text: SCAR_A },
    { id: 'b', text: SCAR_B },
    { id: 'c', text: UNRELATED },
  ]);
  assert.equal(groups.length, 1, '只该有一组');
  assert.deepEqual(groups[0].ids.sort(), ['a', 'b']);
  assert.equal(groups[0].size, 2);
  assert.ok(groups[0].minIn > groups[0].maxOut, '组内最弱要明显强于组外最强，否则是巧合');
  assert.equal(groups[0].stable, true);
  assert.ok(groups[0].sharedTokens.length > 0, '共同根因词不能是空的');
  assert.ok(['a', 'b'].includes(groups[0].skeletonId));
  assert.ok(groups[0].save.saved > 0, '两条合并总该省点字');
});

test('同根因疤痕：门槛高到没有同类时返回空，而不是硬凑一组', () => {
  const groups = rootCauseGroups(
    [
      { id: 'a', text: SCAR_A },
      { id: 'b', text: SCAR_B },
    ],
    { threshold: 0.9 },
  );
  assert.deepEqual(groups, []);
});

test('同根因疤痕：组内相似度和组外差距不足时，stable 必须为 false', () => {
  // 三条都在讲「编码/文件」这件事，但两两相似度都很低 —— 贪心聚类会并成一组，
  // 而这一组其实只是"话题像"，`stable` 要把这件事说出来，不能让它冒充根因。
  const groups = rootCauseGroups(
    [
      { id: 'a', text: '阅读文件时先确认编码，不要盲猜' },
      { id: 'b', text: '写文件前先备份，出问题能回滚' },
      { id: 'c', text: '提交前跑一遍测试，别交给别人验' },
    ],
    { threshold: 0.16 },
  );
  const merged = groups.find((group) => group.size >= 2);
  if (merged !== undefined) assert.equal(merged.stable, false, '勉强聚起来的组不能标成稳定');
});

test('回测：骨架盖住自己，缺词的条目要把缺的词报出来', () => {
  const [group] = rootCauseGroups([
    { id: 'a', text: SCAR_A },
    { id: 'b', text: SCAR_B },
  ]);
  const result = backtest(group);
  const skeleton = result.rows.find((item) => item.isSkeleton);
  assert.equal(skeleton.ratio, 1, '骨架自己当然 100% 覆盖');
  const other = result.rows.find((item) => !item.isSkeleton);
  assert.ok(other.ratio < 1, '另一条不可能被骨架完全盖住');
  assert.ok(other.missing.length > 0, '缺的词是给人看的定位线索，不能空');
  assert.equal(result.pass, false, '最低 10% 那一档不该判通过');
  assert.ok(result.minimum <= result.average);
});

test('回测：门槛放到 0 时一律通过（门槛是判据，不是装饰）', () => {
  const [group] = rootCauseGroups([
    { id: 'a', text: SCAR_A },
    { id: 'b', text: SCAR_B },
  ]);
  assert.equal(backtest(group, { threshold: 0 }).pass, true);
});

test('成长曲线：按桶统计新增与累计，桶宽随库龄自适应', () => {
  const now = 10 * DAY;
  const state = {
    memories: [
      row('a', { createdAt: 1 * DAY, text: 'alpha bravo charlie delta' }),
      row('b', { createdAt: 1 * DAY, text: 'alpha bravo charlie echo' }),
      row('c', { createdAt: 8 * DAY, text: 'foxtrot golf hotel india' }),
    ],
    slots: [],
  };
  const curve = growthCurve(state, { now, buckets: 6, bucketDays: 7 });
  assert.equal(curve.bucketDays, 2, '10 天跨度 / 6 桶 → 收窄到 2 天，别给一个点冒充趋势');
  assert.equal(curve.buckets.reduce((sum, bucket) => sum + bucket.added, 0), 3);
  assert.equal(curve.buckets.at(-1).active, 3, '最后一桶累计到全部条目');
  assert.equal(curve.buckets[0].active, 2, '第一桶只有最早的两条');
  assert.ok(curve.buckets.every((bucket) => bucket.density >= 0));
});

test('成长曲线：条数涨而密度跌时判为变胖', () => {
  const now = 42 * DAY;
  const filler = (id, day) =>
    row(id, { createdAt: day * DAY, text: `alpha bravo ${'很长的填充内容'.repeat(30)}` });
  const state = {
    memories: [
      ...Array.from({ length: 6 }, (_, index) => filler(`early-${index}`, 1)),
      ...Array.from({ length: 6 }, (_, index) => filler(`late-${index}`, 40)),
    ],
    slots: [],
  };
  const curve = growthCurve(state, { now, buckets: 6, bucketDays: 7 });
  assert.equal(curve.direction, 'down', '重复填充会把密度拉下去');
  assert.ok(curve.buckets.at(-1).active > curve.buckets[0].active, '条数是在涨的');
  assert.ok(curve.to < curve.from);
});

test('成长曲线：空库不装样子，返回空桶', () => {
  const curve = growthCurve({ memories: [], slots: [] }, { now: DAY });
  assert.deepEqual(curve.buckets, []);
  assert.equal(curve.direction, 'flat');
});

test('使用信号：命中过 ≠ 真被用上', () => {
  const state = {
    memories: [
      row('a', { hits: 5, usedCount: 2 }),
      row('b', { hits: 3, usedCount: 0 }),
      row('c', { hits: 0, usedCount: 0 }),
      row('d', { hits: 9, usedCount: 1, status: 'archived' }),
    ],
  };
  const signal = usedSignal(state);
  assert.equal(signal.active, 3, '归档的不算活跃');
  assert.equal(signal.hitRows, 2);
  assert.equal(signal.usedRows, 1);
  assert.equal(signal.echoRows, 1);
  assert.equal(signal.rate, 0.5);
});

test('折叠碎片：撞字的二元组碎片不重复打印', () => {
  const collapsed = collapseTokens(['码只', '源码', '只用', 'read/write/edit', 'GBK'], 8);
  assert.ok(collapsed.includes('read/write/edit'), '长词优先保留');
  assert.ok(collapsed.includes('GBK'));
  assert.ok(!(collapsed.includes('码只') && collapsed.includes('源码')), '撞字的碎片只留一个');
  assert.ok(collapsed.length <= 5);
  assert.deepEqual(collapseTokens([]), []);
});

test('区分词：去掉单字和问句填词', () => {
  const tokens = contentOf('什么才是好的记忆？');
  assert.ok(!tokens.includes('什'), '单字不算区分词');
  assert.ok(tokens.length > 0);
});

test('总读数：真库形状下给出可执行建议，而不是"一切正常"', () => {
  const now = 3 * DAY;
  const state = {
    memories: [
      row('a', { kind: 'constraint', text: SCAR_A, createdAt: 1 * DAY, hits: 2 }),
      row('b', { kind: 'constraint', text: SCAR_B, createdAt: 1 * DAY, hits: 2 }),
      row('c', { kind: 'constraint', text: UNRELATED, createdAt: 1 * DAY, hits: 1 }),
      row('d', { createdAt: 2 * DAY, text: '面板要深空底色，不要玻璃拟态', hits: 4, usedCount: 0 }),
      row('e', { createdAt: 2 * DAY, text: '星图点击判定要用位移现算', hits: 3, usedCount: 0 }),
    ],
    slots: [],
  };
  const report = analyzeGrowth(state, { now });
  assert.equal(report.status, 'patching', '有未合并的疤痕时状态是"在补"');
  assert.equal(report.groups.length, 1);
  assert.ok(report.groups[0].backtest !== undefined, '每组都要带自己的回测');
  assert.ok(report.contract.chars > 0);
  assert.ok(report.notes.length > 0);
  assert.ok(
    report.notes.some((note) => note.includes('同根因疤痕')),
    '最该说的那句不能被别的提示挤掉',
  );
  assert.ok(
    report.notes.some((note) => note.includes('改写率')),
    '价值信号那句必须在，而且排在 used 前面（used 在真库上结构性命中不了）',
  );
  assert.ok(
    report.notes.some((note) => note.includes('used')),
    'used 的失效口径要说出来，否则人会去追一个永远不会动的数',
  );
});

test('总读数：空库如实说空', () => {
  const report = analyzeGrowth({ memories: [], slots: [] }, { now: DAY });
  assert.equal(report.status, 'empty');
  assert.equal(report.headline, '还没有记忆');
  assert.equal(report.groups.length, 0);
  assert.equal(report.contract.chars, 0);
});
