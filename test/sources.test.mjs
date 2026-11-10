/**
 * 「出处→用途」那条链的可查证那一半：写入时用 `sources` 指认来源。
 *
 * 为什么要有这条测试：这一节补的是**唯一不需要猜**的用途证据。
 * 之前只有两种信号 —— `hits`（被展示）和 `usedCount`（要求用户在下一句复述
 * 我的中文二元组，结构上恒为 0）。`sources` 不同：它是写入那一刻我们自己
 * 指认的「这条结论读的是哪几条」，一落库就能反查，不需要模型配合、不需要
 * 二次生成、也不会随时间衰减。
 *
 * 守的规矩：
 * ① 不存在的 id 丢掉并留一句，不许让一次 id 笔误连带整条记忆写不进去；
 * ② 自己不能当自己的出处；
 * ③ 同一条结论被再次写入（dedup）时，新出处要并进去 —— 句子一样不等于证据一样；
 * ④ 老库没有这个字段时补空数组，不当成坏数据。
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { MemoryStore } from '../lib/store.js';

async function openTempStore(options = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'loom-sources-'));
  const store = new MemoryStore({ storePath: join(dir, 'store.json'), compactAt: 0, ...options });
  await store.open();
  return { dir, store };
}

async function close(dir) {
  await rm(dir, { recursive: true, force: true });
}

test('出处：写进去就落库，引用链出边指得到，反查那条能看到"被用上了"', async () => {
  const { dir, store } = await openTempStore();
  try {
    const a = await store.write({ kind: 'fact', text: '注入块每轮都付钱' });
    const b = await store.write({ kind: 'self', text: '我先量再下结论' });
    const derived = await store.write({ kind: 'world', text: '契约块要算代价', sources: [a.id, b.id] });

    const row = store.byId(derived.id);
    assert.deepEqual(row.sources.sort(), [a.id, b.id].sort(), '两条出处都要留在条目上');

    const out = store.traceOf({ kind: 'memory', id: derived.id });
    assert.deepEqual(out.out.map((item) => item.id).sort(), [a.id, b.id].sort(), '出边就是它长自的那几条');

    const back = store.traceOf({ kind: 'memory', id: a.id });
    const used = back.in.filter((item) => item.edge === 'derived');
    assert.equal(used.length, 1, '被引用的那条要能反查到用途');
    assert.equal(used[0].id, derived.id);
  } finally {
    await close(dir);
  }
});

test('出处：不在库里的 id 丢掉并说明，写入本身不失败；自己不能当自己的出处', async () => {
  const { dir, store } = await openTempStore();
  try {
    const kept = await store.write({ kind: 'fact', text: '一条真存在的' });
    const result = await store.write({
      kind: 'fact',
      text: '带一个假 id 的',
      sources: [kept.id, 'no-such-memory-id'],
    });
    assert.equal(result.status, 'created', '假 id 不该让整条写不进去');
    assert.deepEqual(store.byId(result.id).sources, [kept.id]);
    assert.ok(
      result.notes.some((note) => note.includes('不在库里')),
      '丢掉的 id 要留一句，不能静默吞',
    );
  } finally {
    await close(dir);
  }
});

test('出处：同一条结论再写一次时，新出处并进去（句子一样不等于证据一样）', async () => {
  const { dir, store } = await openTempStore();
  try {
    const a = await store.write({ kind: 'fact', text: '第一条出处' });
    const b = await store.write({ kind: 'fact', text: '第二条出处' });
    const first = await store.write({ kind: 'world', text: '同一句结论', sources: [a.id] });
    const again = await store.write({ kind: 'world', text: '同一句结论', sources: [b.id] });

    assert.equal(again.status, 'deduped');
    assert.deepEqual(store.byId(first.id).sources.sort(), [a.id, b.id].sort(), '两条出处都要在');
  } finally {
    await close(dir);
  }
});

test('出处：老库没有这个字段时补空数组，不当成坏数据', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'loom-sources-old-'));
  try {
    const file = join(dir, 'store.json');
    await writeFile(
      file,
      JSON.stringify({
        version: 1,
        memories: [
          {
            id: 'm1',
            kind: 'fact',
            text: '老库里的一条',
            status: 'active',
            createdAt: Date.now(),
            updatedAt: Date.now(),
          },
        ],
        slots: [],
        summaries: [],
        edges: [],
        events: [],
        meta: {},
      }),
      'utf8',
    );
    const store = new MemoryStore({ storePath: file, compactAt: 0 });
    await store.open();
    assert.deepEqual(store.byId('m1').sources, [], '缺字段补空数组');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('出处：面板快照里带出 sources 与 derivedBy，且 derivedBy 只数真指向它的条目', async () => {
  const { dir, store } = await openTempStore();
  try {
    const source = await store.write({ kind: 'fact', text: '被用到的出处' });
    // 两条要写得不像，而且不同 kind：同 kind 又够像的话会被查重合并成一条，
    // derivedBy 就只剩 1 —— 那样的失败是测试自己写错，不是逻辑错。
    await store.write({ kind: 'world', text: '从它推出：注入块每轮都要付钱', sources: [source.id] });
    await store.write({ kind: 'self', text: '我习惯先量一遍再动手改', sources: [source.id] });
    const lonely = await store.write({ kind: 'fact', text: '没人引用的那条' });

    const snap = store.snapshot();
    const usedRow = snap.memories.find((row) => row.id === source.id);
    const lonelyRow = snap.memories.find((row) => row.id === lonely.id);
    assert.deepEqual(usedRow.sources, []);
    assert.equal(usedRow.derivedBy, 2, '两条记忆把它列进了出处');
    assert.equal(lonelyRow.derivedBy, 0);
  } finally {
    await close(dir);
  }
});
