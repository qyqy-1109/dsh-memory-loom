/**
 * 自我叙事（重写 + 版本留档）的回归测试。
 *
 * 这一层最容易被做成"又一个存储字段"，所以断言盯的是**它和条目的区别**：
 *
 * ① 叙事是**整段替换**，不是追加 —— 写第二版时第一版必须进历史，而不是库里有两条叙事。
 * ② `reason` 必填 —— 没有理由的版本序列只是自我编辑记录，看不出"为什么这次要改"。
 * ③ 回滚**本身也是一次重写**：当前版进历史、理由写"回滚"。
 *    不然就分不清"我又想回去了"和"那次改写根本没发生"。
 * ④ 它每轮都在场，所以必须出现在 `buildRecall` 的常量块里，并且**不进 `hits`**
 *    （每轮都在场的东西进曝光统计，命中数会永久虚高）。
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { MemoryStore } from '../lib/store.js';
import { contractCost, growthCurve, narrativeSignal } from '../lib/growth.js';

const V1 = '我倾向于先在真实数据上量一遍再下结论。';
const V2 = '我先量再下结论，但量完要敢承认某个指标不成立——口径错了就换，别硬撑。';
const V3 = '我量完就换口径，宁可承认上一个指标是废的，也不把 0 读成"没发生"。';

async function openTempStore(cfg = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'loom-narrative-'));
  const store = new MemoryStore({ storePath: join(dir, 'store.json'), compactAt: 0, ...cfg });
  await store.open();
  return { dir, store };
}

test('空库：没有叙事，读数如实说 0', async () => {
  const { dir, store } = await openTempStore();
  try {
    assert.equal(store.selfNarrative(), null);
    assert.deepEqual(store.selfNarrativeHistory(), []);
    assert.equal(store.counts().narrativeChars, 0);
    assert.equal(store.counts().narrativeVersions, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('第一版：写下就是当前版，历史为空', async () => {
  const { dir, store } = await openTempStore();
  try {
    const result = await store.rewriteSelfNarrative({ text: V1, reason: '第一次写下自我描述' });
    assert.equal(store.selfNarrative().text, V1);
    assert.equal(store.selfNarrativeHistory().length, 0, '第一版没有"旧版"可进历史');
    assert.equal(result.chars, [...V1].length);
    assert.ok(result.notes.some((note) => note.includes('第一条')));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('第二版：整段替换，旧版带理由压进历史（不是库里有两条叙事）', async () => {
  const { dir, store } = await openTempStore();
  try {
    await store.rewriteSelfNarrative({ text: V1, reason: '第一版' });
    await store.rewriteSelfNarrative({ text: V2, reason: '发现"先量再下结论"不够：量完要敢换口径' });

    assert.equal(store.selfNarrative().text, V2, '当前版是新的那一版');
    const history = store.selfNarrativeHistory();
    assert.equal(history.length, 1);
    assert.equal(history[0].text, V1);
    assert.equal(history[0].reason, '第一版', '旧版的理由要跟着它一起留档');
    assert.ok(store.state.events.some((event) => event.kind === 'self.rewrite'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('没有理由不许重写：那句理由就是成长的证据', async () => {
  const { dir, store } = await openTempStore();
  try {
    await assert.rejects(() => store.rewriteSelfNarrative({ text: V1, reason: '   ' }), /理由/);
    assert.equal(store.selfNarrative(), null, '拒绝之后不能留下半条叙事');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('空叙事不许写：没有内容的"我是谁"比没有更糟', async () => {
  const { dir, store } = await openTempStore();
  try {
    await assert.rejects(() => store.rewriteSelfNarrative({ text: '  ', reason: '试试' }), /不能为空/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('超长不许写：超过上限就不是叙事，是条目堆', async () => {
  const { dir, store } = await openTempStore({ maxSelfNarrativeLength: 20 });
  try {
    await assert.rejects(
      () => store.rewriteSelfNarrative({ text: '这是一段明显超过二十个字的自我描述，用来验证长度上限是否生效。', reason: '测试' }),
      /超过上限/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('回滚：旧版回来当当前版，当前版进历史，理由记成回滚', async () => {
  const { dir, store } = await openTempStore();
  try {
    await store.rewriteSelfNarrative({ text: V1, reason: '第一版' });
    await store.rewriteSelfNarrative({ text: V2, reason: '第二版：补上换口径' });
    const old = store.selfNarrativeHistory()[0];

    const result = await store.restoreSelfNarrative(old.id);
    assert.equal(store.selfNarrative().text, V1, '回滚后当前版就是旧版');
    assert.ok(result.notes.some((note) => note.includes('回滚')));
    const history = store.selfNarrativeHistory();
    assert.equal(history.length, 2, '当前版（V2）也要进历史，回滚不能抹掉它');
    assert.equal(history[0].text, V2);
    assert.ok(store.selfNarrative().reason.includes('回滚'), '回滚本身也要留理由');
    assert.ok(history.some((row) => row.text === V2), '被替换下来的那版还在');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('回滚：id 不存在时明确报错，不静默什么都不做', async () => {
  const { dir, store } = await openTempStore();
  try {
    await assert.rejects(() => store.restoreSelfNarrative('nope'), /找不到/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('版本上限：历史只留最近几版，丢的是最老的', async () => {
  const { dir, store } = await openTempStore({ selfNarrativeVersions: 2 });
  try {
    await store.rewriteSelfNarrative({ text: '第一版内容', reason: '一' });
    await store.rewriteSelfNarrative({ text: '第二版内容', reason: '二' });
    await store.rewriteSelfNarrative({ text: '第三版内容', reason: '三' });
    await store.rewriteSelfNarrative({ text: '第四版内容', reason: '四' });
    const history = store.selfNarrativeHistory();
    assert.equal(history.length, 2, '上限是 2 就只能留 2 版');
    assert.equal(history[0].text, '第三版内容', '最新在前');
    assert.equal(history[1].text, '第二版内容');
    assert.ok(store.state.events.some((event) => event.kind === 'self.trim'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('注入：叙事是常量块，位置在约束之后、状态之前，且不进 hits', async () => {
  const { dir, store } = await openTempStore();
  try {
    await store.write({ kind: 'constraint', text: '改源码只用 read/write/edit。' });
    await store.rewriteSelfNarrative({ text: V1, reason: '第一版' });
    await store.write({ kind: 'slot', entity: '记忆海', attr: '形态', text: '一整页' });

    const recall = store.buildRecall('');
    const names = (recall.blocks ?? []).map((block) => block.name);
    assert.ok(names.includes('narrative'), '叙事必须每轮都在场');
    assert.ok(names.indexOf('narrative') > names.indexOf('constraints'), '身份在硬约束之后');
    assert.ok(names.indexOf('narrative') < names.indexOf('slots'), '状态在身份之后');
    const block = recall.blocks.find((item) => item.name === 'narrative');
    assert.equal(block.title, '【我是谁】');
    assert.equal(block.text, V1);
    assert.ok(
      !(recall.hits ?? []).some((hit) => hit.block === 'narrative'),
      '每轮都在场的东西不能进曝光统计，否则命中数永久虚高',
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('契约块开销把叙事算进去，且与 buildRecall 逐字一致', async () => {
  const { dir, store } = await openTempStore();
  try {
    await store.write({ kind: 'constraint', text: '改源码只用 read/write/edit。' });
    await store.rewriteSelfNarrative({ text: V2, reason: '第一版' });

    const cost = contractCost(store.state, store.cfg);
    const recall = store.buildRecall('');
    const fromGrowth = cost.blocks.find((block) => block.name === 'narrative');
    const fromStore = recall.blocks.find((block) => block.name === 'narrative');
    assert.ok(fromGrowth !== undefined, '叙事每轮都注入，就必须计入常量开销');
    assert.equal(fromGrowth.text, fromStore.text);
    assert.equal(fromGrowth.chars, [...V2].length);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('落盘：叙事和历史都要真的写进文件', async () => {
  const { dir, store } = await openTempStore();
  try {
    await store.rewriteSelfNarrative({ text: V1, reason: '第一版' });
    await store.rewriteSelfNarrative({ text: V2, reason: '第二版' });
    const onDisk = JSON.parse(await readFile(join(dir, 'store.json'), 'utf8'));
    assert.equal(onDisk.selfNarrative.current.text, V2);
    assert.equal(onDisk.selfNarrative.versions.length, 1);
    assert.equal(onDisk.selfNarrative.versions[0].reason, '第一版');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('老库没有 selfNarrative 字段：补空形状，不当成坏数据', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'loom-narrative-legacy-'));
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
        events: [],
        recall: { last: null, count: 0 },
        meta: { writeCount: 1, dedupeCount: 0, archiveCount: 0, relaxCount: 0, forgetCount: 0 },
      }),
      'utf8',
    );
    const store = new MemoryStore({ storePath: file, compactAt: 0 });
    await store.open();
    assert.equal(store.selfNarrative(), null);
    assert.deepEqual(store.selfNarrativeHistory(), []);
    const snapshot = store.snapshot();
    assert.equal(snapshot.selfNarrative.current, null, '面板拿到的形状要完整');
    assert.deepEqual(snapshot.selfNarrative.versions, []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('成长曲线的契约字数要算上叙事（漏算自己人的开销，是最不该犯的错）', () => {
  const DAY = 86_400_000;
  const now = 10 * DAY;
  const memories = [{ id: 'a', kind: 'fact', text: '一条记忆。', status: 'active', createdAt: 1 * DAY, hits: 0 }];
  const base = growthCurve({ memories, slots: [], selfNarrative: { current: null, versions: [] } }, { now, buckets: 2, bucketDays: 7 });
  const withNarrative = growthCurve(
    {
      memories,
      slots: [],
      selfNarrative: {
        current: { id: 'n1', text: '我是谁：一段自我描述。', at: 8 * DAY, reason: '第一版' },
        versions: [],
      },
    },
    { now, buckets: 2, bucketDays: 7 },
  );
  assert.ok(withNarrative.buckets.at(-1).contractChars > base.buckets.at(-1).contractChars, '最后一桶必须包含叙事的字数');
  assert.equal(
    withNarrative.buckets.at(-1).contractChars - base.buckets.at(-1).contractChars,
    [...'我是谁：一段自我描述。'].length,
    '差额应当正好是叙事本身的字数',
  );
  assert.equal(
    withNarrative.buckets[0].contractChars,
    base.buckets[0].contractChars,
    '叙事写之前的那几桶不该被追溯性地加上去',
  );
});

test('叙事读数：版本之间一字未改要判成"誊抄"，不是成长', () => {
  const copy = narrativeSignal({
    selfNarrative: {
      current: { text: V1, at: Date.now(), reason: '又写了一遍' },
      versions: [
        { text: V1, at: 1, reason: '第一版' },
        { text: V1, at: 2, reason: '第二版' },
      ],
    },
  });
  assert.equal(copy.has, true);
  assert.equal(copy.versions, 2);
  assert.equal(copy.copyOnly, true, '三版几乎一样只能说明在誊抄');
  assert.ok(copy.drift < 0.1);

  const moved = narrativeSignal({
    selfNarrative: {
      current: { text: V3, at: Date.now(), reason: '第三版' },
      versions: [{ text: V1, at: 1, reason: '第一版' }],
    },
  });
  assert.equal(moved.copyOnly, false, '真的改写了就不能报誊抄');
  assert.ok(moved.drift > 0.1);
});

test('叙事读数：没写过时如实说没有，不编一个空字符串', () => {
  const signal = narrativeSignal({ selfNarrative: { current: null, versions: [] } });
  assert.equal(signal.has, false);
  assert.equal(signal.chars, 0);
  assert.equal(signal.drift, null);
  assert.equal(signal.copyOnly, false);
});
