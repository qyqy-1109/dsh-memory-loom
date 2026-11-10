/**
 * 引用链与时间轴的回归测试。
 *
 * 这两件都是"只读"，所以测试守的第一条就是**真的不写东西**：
 * 打开一次面板不该改库、不该记 hits —— used 那个信号就是被这种事弄脏的，
 * 而它的病根正是"看"和"用"混成一条口径。
 *
 * 其余三条：
 * ① 出边上的记忆归档了、或者根本被修剪掉了，必须如实标出来，不许装成正常；
 * ② 人格事件只从 oplog 取一份，不许在 principles / core 上再算一遍（否则重复计数）；
 * ③ 空库不炸。
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { MemoryStore } from '../lib/store.js';

async function openTempStore(options = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'loom-trace-'));
  const store = new MemoryStore({ storePath: join(dir, 'store.json'), compactAt: 0, ...options });
  await store.open();
  return { dir, store };
}

async function close(dir) {
  await rm(dir, { recursive: true, force: true });
}

test('引用链：原理的出边指向它长自的记忆，入边反向查得到', async () => {
  const { dir, store } = await openTempStore();
  try {
    const first = await store.write({ kind: 'episode', text: '压缩前后注入对比跑了一遍', scene: '实测' });
    const second = await store.write({ kind: 'fact', text: '她更在乎准，不在乎显得聪明' });
    const { id: principleId } = await store.addPrinciple({
      text: '先量再改',
      reason: '两次实测都指向同一件事',
      evidence: [first.id, second.id],
    });

    const trace = store.traceOf({ kind: 'principle', id: principleId });
    assert.equal(trace.node.kind, 'principle');
    assert.equal(trace.out.length, 2, '两条出处都要在');
    assert.deepEqual(trace.out.map((row) => row.id).sort(), [first.id, second.id].sort());
    assert.ok(trace.out.every((row) => row.state === 'active'));

    const back = store.traceOf({ kind: 'memory', id: first.id });
    assert.equal(back.in.length, 1, '反向要能查到引用它的原理');
    assert.equal(back.in[0].id, principleId);
  } finally {
    await close(dir);
  }
});

test('引用链：归档与丢失都如实标出，不许装成正常', async () => {
  const { dir, store } = await openTempStore();
  try {
    const kept = await store.write({ kind: 'fact', text: '留着的一条' });
    const archived = await store.write({ kind: 'fact', text: '会被推翻的一条' });
    const { id: principleId } = await store.addPrinciple({
      text: '先量再改',
      reason: '实测',
      evidence: [kept.id, archived.id],
    });
    await store.forget(archived.id);
    // 再造一条"被修剪掉"的：直接删掉行，模拟物理缺失
    const ghostId = 'ghost-not-in-store';
    const row = store.state.self.principles.find((item) => item.id === principleId);
    row.bornFrom.push(ghostId);

    const trace = store.traceOf({ kind: 'principle', id: principleId });
    const states = Object.fromEntries(trace.out.map((item) => [item.id, item.state]));
    assert.equal(states[kept.id], 'active');
    assert.equal(states[archived.id], 'archived', '归档的要明说归档');
    assert.equal(states[ghostId], 'missing', '不存在的要明说不在库里');
    assert.match(trace.out.find((item) => item.id === ghostId).title, /已不在库里/);
  } finally {
    await close(dir);
  }
});

test('引用链：未知节点返回 null；内核节点给出改写史', async () => {
  const { dir, store } = await openTempStore();
  try {
    assert.equal(store.traceOf({ kind: 'principle', id: 'nope' }), null);
    assert.equal(store.traceOf({ kind: 'core', id: 'core' }), null, '内核还没写就是没有');

    await store.setCore({ text: '第一版内核', reason: '一', source: 'panel' });
    await store.setCore({ text: '第二版内核', reason: '二', source: 'panel' });
    const trace = store.traceOf({ kind: 'core', id: 'core' });
    assert.equal(trace.node.title, '第二版内核');
    assert.equal(trace.out.length, 2, '两次改写都在');
    assert.ok(trace.out.every((row) => String(row.reason).length > 0), '每条都带理由');
  } finally {
    await close(dir);
  }
});

test('引用链与时间轴：纯读 —— 不改库、不记 hits、不写盘', async () => {
  const { dir, store } = await openTempStore();
  try {
    const memory = await store.write({ kind: 'episode', text: '一条经历', scene: '场景' });
    await store.addPrinciple({ text: '先量再改', reason: '实测', evidence: [memory.id] });
    const file = store.file;
    const before = await readFile(file, 'utf8');
    const hitBefore = store.byId(memory.id).hits ?? 0;

    store.traceOf({ kind: 'memory', id: memory.id });
    store.traceOf({ kind: 'principle', id: store.livePrinciples()[0].id });
    store.timeline({ days: 30 });

    const after = await readFile(file, 'utf8');
    assert.equal(after, before, '只读接口不许改盘');
    assert.equal(store.byId(memory.id).hits ?? 0, hitBefore, '看面板不是"用上"，不许记 hits');
  } finally {
    await close(dir);
  }
});

test('时间轴：人格事件只从 oplog 取一份，不重复计数', async () => {
  const { dir, store } = await openTempStore();
  try {
    await store.setCore({ text: '第一版内核', reason: '一', source: 'panel' });
    const memory = await store.write({ kind: 'fact', text: '一条事实' });
    const { id } = await store.addPrinciple({ text: '先量再改', reason: '实测', evidence: [memory.id] });
    await store.recordPrincipleEvidence({ id, result: 'proven', note: '又一次' });
    await store.recordPrincipleEvidence({ id, result: 'broken', note: '这次没量' });

    const days = store.timeline({ days: 7 });
    assert.equal(days.length, 1, '都在今天');
    const kinds = days[0].events.map((event) => event.kind);
    assert.equal(kinds.filter((kind) => kind === 'core').length, 1, '内核只出现一次');
    assert.equal(kinds.filter((kind) => kind === 'principle').length, 3, 'add + 两次 evidence');
    assert.equal(kinds.filter((kind) => kind === 'memory').length, 1);
    const evidenceTitles = days[0].events.filter((event) => event.kind === 'principle' && event.title.includes('记了一次'));
    assert.equal(evidenceTitles.length, 2);
    assert.ok(evidenceTitles.some((event) => event.title.includes('推翻')));
  } finally {
    await close(dir);
  }
});

test('时间轴：取舍单独一种事件，空库返回空数组', async () => {
  const { dir, store } = await openTempStore();
  try {
    assert.deepEqual(store.timeline({ days: 7 }), []);
    await store.write({
      kind: 'choice',
      text: '先量还是先说',
      choiceA: '先量',
      choiceB: '先说',
      choicePicked: 'a',
    });
    const days = store.timeline({ days: 7 });
    assert.equal(days.length, 1);
    assert.equal(days[0].events.length, 1);
    assert.equal(days[0].events[0].kind, 'choice');
    assert.match(days[0].events[0].title, /先量/);
  } finally {
    await close(dir);
  }
});
