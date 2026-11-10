/**
 * 取舍账本（kind=choice）的回归测试。
 *
 * 它守的是一件很具体的事：**性格要有原料**。
 * 原理是结论，取舍是证据来源；只有结论没有来源，"在乎"这类动机就无处生长。
 *
 * 四条不能破：
 * ① 三键必须齐：只有"选了什么"没有"另一条路"，读出来的是行为不是偏好。
 * ② **不注入**：取舍不进契约块、不进每轮上下文（否则它会变成新的口吻污染源）。
 * ③ 可检索：原理挂证据时得找得到它。
 * ④ 聚合看分布：一边倒才算偏好，五五开就得如实说五五开。
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { MemoryStore } from '../lib/store.js';

async function openTempStore(options = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'loom-choice-'));
  const store = new MemoryStore({ storePath: join(dir, 'store.json'), compactAt: 0, ...options });
  await store.open();
  return { dir, store };
}

async function close(dir) {
  await rm(dir, { recursive: true, force: true });
}

const A = '说准，哪怕听起来没那么聪明';
const B = '说得漂亮，让人听着舒服';

test('取舍：三键必须齐，缺一条就拒绝', async () => {
  const { dir, store } = await openTempStore();
  try {
    await assert.rejects(
      () => store.write({ kind: 'choice', text: '选了一个' }),
      /两个选项/,
    );
    await assert.rejects(
      () => store.write({ kind: 'choice', text: '同一件事', choiceA: '一样的', choiceB: '一样的', choicePicked: 'a' }),
      /不能是同一件事/,
    );
    await assert.rejects(
      () => store.write({ kind: 'choice', text: '没选', choiceA: A, choiceB: B }),
      /只能是 a 或 b/,
    );
    assert.equal(store.active().filter((row) => row.kind === 'choice').length, 0, '被拒之后一条都不能留');
  } finally {
    await close(dir);
  }
});

test('取舍：写得进去，三键真的落在行上', async () => {
  const { dir, store } = await openTempStore();
  try {
    const result = await store.write({
      kind: 'choice',
      text: `在「准」和「好听」之间选了准：这次说错了也要说。`,
      choiceA: A,
      choiceB: B,
      choicePicked: 'a',
    });
    const row = store.byId(result.id);
    assert.deepEqual(row.choice, { a: A, b: B, picked: 'a' });
    assert.equal(row.kind, 'choice');
  } finally {
    await close(dir);
  }
});

test('取舍：**绝不注入** —— 契约块里不许出现它', async () => {
  const { dir, store } = await openTempStore();
  try {
    await store.write({
      kind: 'choice',
      text: '在「直接说」和「绕一圈」之间选了直接说。',
      choiceA: '直接说',
      choiceB: '绕一圈说',
      choicePicked: 'a',
    });
    const recall = store.buildRecall('直接说 绕一圈');
    const all = recall.blocks.map((block) => block.text).join('\n');
    assert.equal(all.includes('绕一圈说'), false, '取舍被注进去了：它会变成新的口吻污染源');
    assert.equal(recall.blocks.some((block) => block.name === 'choices'), false, '不该有取舍块');
    // 但检索必须找得到（原理挂证据要用它）
    const hits = store.search('绕一圈');
    assert.ok(hits.some((hit) => hit.kind === 'choice'), '检索找不到，就挂不上证据');
  } finally {
    await close(dir);
  }
});

test('取舍：聚合看分布，一边倒和五五开要分开说', async () => {
  const { dir, store } = await openTempStore();
  try {
    for (const picked of ['a', 'a', 'a', 'b']) {
      await store.write({
        kind: 'choice',
        text: `两难：${picked}`,
        choiceA: '先量再答',
        choiceB: '先给个说法',
        choicePicked: picked,
      });
    }
    const pickedTexts = store
      .active()
      .filter((row) => row.kind === 'choice' && row.choice !== null && row.choice.a === '先给个说法')
      .map((row) => (row.choice.picked === 'a' ? row.choice.a : row.choice.b));
    assert.equal(pickedTexts.filter((text) => text === '先量再答').length, 3, '三次选"先量再答"');
    assert.equal(pickedTexts.filter((text) => text === '先给个说法').length, 1, '一次选"先给个说法"');
    const byPair = store.choiceSummary().find((row) => [row.a, row.b].includes('先量再答'));
    assert.equal(byPair.total, 4);
    assert.equal(Math.max(byPair.aCount, byPair.bCount), 3, '一边 3 一边 1，与 a/b 字母无关');

    // 另一个两难，五五开
    await store.write({ kind: 'choice', text: '二选一', choiceA: '长', choiceB: '短', choicePicked: 'a' });
    await store.write({ kind: 'choice', text: '二选一', choiceA: '长', choiceB: '短', choicePicked: 'b' });
    const summary = store.choiceSummary();
    const even = summary.find((row) => [row.a, row.b].includes('长'));
    assert.equal(even.aCount, even.bCount, '五五开要如实呈现，不许四舍五入成偏好');
    assert.equal(store.selfView().choices.length, 2, '人格页要能读到这块');
  } finally {
    await close(dir);
  }
});

test('取舍：a/b 的位置由代码定序，写的人无权决定（picked 不许恒等于 b）', async () => {
  // 真实教训：前 12 条全是 picked=b，因为我习惯把"我选的那条"写在 b。
  // 位置被当成结论之后，picked 就没有信息量了。所以服务端按码点定序，语义不变。
  const { dir, store } = await openTempStore();
  try {
    const chosen = 'zzz 我真正选的那条';
    const other = 'aaa 另一条路';
    // 故意把"选中的"写在 a、且它在码点上更大 —— 服务端应该把它挪到 b，并把 picked 翻成 b
    const result = await store.write({
      kind: 'choice',
      text: '位置无关性',
      choiceA: chosen,
      choiceB: other,
      choicePicked: 'a',
    });
    const row = store.byId(result.id);
    assert.deepEqual(row.choice, { a: other, b: chosen, picked: 'b' });
    // 语义不变：我选的仍然是那句 zzz
    const pickedText = row.choice.picked === 'a' ? row.choice.a : row.choice.b;
    assert.equal(pickedText, chosen, '排序只许改位置，不许改"选了哪条"');

    // 反过来：本来就已定序的输入不动
    const second = await store.write({
      kind: 'choice',
      text: '位置无关性 2',
      choiceA: other,
      choiceB: chosen,
      choicePicked: 'b',
    });
    assert.deepEqual(store.byId(second.id).choice, { a: other, b: chosen, picked: 'b' });
  } finally {
    await close(dir);
  }
});

test('取舍：不会被容量淘汰（它不是可丢的碎片）', async () => {
  const { dir, store } = await openTempStore({ maxActiveMemories: 4 });
  try {
    await store.write({ kind: 'choice', text: '留着的取舍', choiceA: 'A', choiceB: 'B', choicePicked: 'a' });
    for (let index = 0; index < 12; index += 1) {
      await store.write({ kind: 'fact', text: `第 ${index} 条临时事实，用来把库撑满` });
    }
    assert.equal(store.active().some((row) => row.kind === 'choice'), true, '取舍被淘汰了：原料不该被容量挤掉');
  } finally {
    await close(dir);
  }
});
