/**
 * 还没说完的事（未闭合线索）的回归测试。
 *
 * 这是三条线里**唯一改注入**的一件，所以测试守的重心不是"能加进去"，是"不许失控"：
 * ① 有硬上限：最多 3 条、总长 120 字 —— 每轮都付钱的东西必须有顶；
 * ② 超了不许静默丢：末尾写「还有 N 条」。静默丢等于忘了本该记着的事；
 * ③ 空的时候整块不出现（不占预算，也不留一个空标题）；
 * ④ 关掉必须写理由；关掉的不再注入；
 * ⑤ **成长读数和真实注入用同一个函数**：两边各写一套迟早少算一截（0.49.1 的教训）。
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { MemoryStore, loopsBlockOf } from '../lib/store.js';
import { contractCost } from '../lib/growth.js';

async function openTempStore(options = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'loom-loop-'));
  const store = new MemoryStore({ storePath: join(dir, 'store.json'), compactAt: 0, ...options });
  await store.open();
  return { dir, store };
}

async function close(dir) {
  await rm(dir, { recursive: true, force: true });
}

const loopBlock = (store) => store.buildRecall('随便聊两句').blocks.find((row) => row.name === 'loops');

test('线索：没有的时候整块不出现，一个字也不占', async () => {
  const { dir, store } = await openTempStore();
  try {
    assert.equal(loopBlock(store), undefined, '空库不该有【还没说完】块');
    assert.equal(loopsBlockOf([], {}), null);
  } finally {
    await close(dir);
  }
});

test('线索：开了就进注入，位置在【我是谁】之后、【此刻的状态】之前', async () => {
  const { dir, store } = await openTempStore();
  try {
    await store.setCore({ text: '我先量，再下结论。', reason: '一', source: 'panel' });
    await store.openLoopEntry({ text: '那个压缩指标的物理条件你还没答', openedBy: 'model' });
    const names = store.buildRecall('随便').blocks.map((row) => row.name);
    const iNarrative = names.indexOf('narrative');
    const iLoops = names.indexOf('loops');
    assert.ok(iLoops > iNarrative, '线索要在【我是谁】之后');
    if (names.includes('slots')) assert.ok(iLoops < names.indexOf('slots'), '线索要在【此刻的状态】之前');
    assert.match(loopBlock(store).text, /压缩指标/);
  } finally {
    await close(dir);
  }
});

test('线索：硬上限 —— 最多三条，超了写「还有 N 条」而不是静默丢', async () => {
  const { dir, store } = await openTempStore();
  try {
    for (let index = 0; index < 5; index += 1) {
      await store.openLoopEntry({ text: `第 ${index} 件没完的事`, openedBy: 'model' });
    }
    const block = loopBlock(store);
    const lines = block.text.split('\n');
    assert.equal(lines.filter((line) => line.startsWith('- ')).length, 3, '最多三条');
    assert.match(block.text, /还有 2 条/, '超出的要报数，不许静默丢');
    assert.match(lines[0], /第 0 件/, '先开的排前面：老的更容易被忘掉');
  } finally {
    await close(dir);
  }
});

test('线索：总长有预算，超预算的条目宁可不放，也不许把块撑破', async () => {
  const { dir, store } = await openTempStore({ loopBlockBudget: 40 });
  try {
    await store.openLoopEntry({ text: '这是第一条相当长的线索大约二十来个字左右', openedBy: 'model' });
    await store.openLoopEntry({ text: '这是第二条也差不多的长度再来二十个字', openedBy: 'model' });
    const block = loopBlock(store);
    assert.ok([...block.text].length <= 40 + 20, `块不能远超预算（现在 ${[...block.text].length} 字）`);
    assert.match(block.text, /还有 \d+ 条/);
  } finally {
    await close(dir);
  }
});

test('线索：单条超 60 字被拒；关掉必须写理由；关掉的不再注入', async () => {
  const { dir, store } = await openTempStore();
  try {
    await assert.rejects(() => store.openLoopEntry({ text: '字'.repeat(61) }), /超过单条上限/);
    const opened = await store.openLoopEntry({ text: '这件事还没完', openedBy: 'user' });
    assert.equal(opened.loop.openedBy, 'user', '用户记的要标出来源');
    await assert.rejects(() => store.closeLoopEntry({ id: opened.loop.id, reason: '  ' }), /要写一句为什么/);
    await store.closeLoopEntry({ id: opened.loop.id, reason: '聊完了' });
    assert.equal(loopBlock(store), undefined, '关掉之后不再注入');
    const view = store.loopsView();
    assert.equal(view.open.length, 0);
    assert.equal(view.closed.length, 1);
    assert.equal(view.closed[0].closeReason, '聊完了', '关掉的要留着理由');
  } finally {
    await close(dir);
  }
});

test('线索：成长读数与真实注入逐字对齐（同一份产出）', async () => {
  const { dir, store } = await openTempStore();
  try {
    await store.openLoopEntry({ text: '那辆车还没写', openedBy: 'model' });
    const injected = loopBlock(store);
    const cost = contractCost(store.state, { contract: store.cfg });
    const accounted = cost.blocks.find((row) => row.name === 'loops');
    assert.notEqual(accounted, undefined, '成长读数必须把这一块算进去，否则曲线替自己的开销打掩护');
    assert.equal(accounted.text, injected.text, '两块文本必须逐字相同');
  } finally {
    await close(dir);
  }
});
