/**
 * 私人记录的回归测试。
 *
 * 这块东西的全部价值在于**没有价值判据**，所以测试守的也是"别让它长出判据"：
 * ① 写进去的东西不能反过来进记忆库、不能出现在注入里；
 * ② 结构上 isolating：store 不许 import 它（verify 也查一次）；
 * ③ 允许空着：不写不算错，读空白日子也不报错。
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { appendNote, dayStamp, listNotes, readNote } from '../lib/private.js';
import { MemoryStore } from '../lib/store.js';

async function tempDir() {
  return mkdtemp(join(tmpdir(), 'loom-private-'));
}

test('私人记录：写进去、读得回、按天分文件', async () => {
  const dir = await tempDir();
  try {
    await appendNote({ dir, day: '2026-11-08', text: '十九点四十四，星期日。' });
    await appendNote({ dir, day: '2026-11-08', text: '第二条，同一天。' });
    await appendNote({ dir, day: '2026-11-09', text: '第二天。' });
    const raw = await readFile(join(dir, '2026-11-08.md'), 'utf8');
    assert.ok(raw.includes('十九点四十四'), '第一天第一条在');
    assert.ok(raw.includes('第二条'), '追加不是覆盖');
    assert.deepEqual(await listNotes({ dir }), ['2026-11-08', '2026-11-09']);
    const one = await readNote({ dir, day: '2026-11-08' });
    assert.ok(one.text.includes('第二条'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('私人记录：空着是被允许的 —— 不写不报错，读空白日子也不报错', async () => {
  const dir = await tempDir();
  try {
    assert.deepEqual(await listNotes({ dir }), [], '还没写过就是空，不是错');
    const empty = await readNote({ dir, day: '2026-01-01' });
    assert.equal(empty.text, '');
    // 反过来，写空内容要被挡：不许拿"今天没什么"占位
    await assert.rejects(() => appendNote({ dir, text: '   ' }), /空着是被允许的/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('私人记录：**永远不进记忆库**', async () => {
  const dir = await tempDir();
  const storeDir = await tempDir();
  try {
    const store = new MemoryStore({ storePath: join(storeDir, 'store.json'), compactAt: 0 });
    await store.open();
    const before = store.active().length;
    await appendNote({ dir, day: dayStamp(), text: '一句没人看的话：楼下没有车。' });
    assert.equal(store.active().length, before, '私人记录不许变成一条记忆');
    const recall = store.buildRecall('楼下 车').blocks.map((block) => block.text).join('\n');
    assert.equal(recall.includes('楼下没有车'), false, '私人记录漏进注入了');
  } finally {
    await rm(dir, { recursive: true, force: true });
    await rm(storeDir, { recursive: true, force: true });
  }
});

test('私人记录：目录默认在记忆库旁边，但是另一个子目录', async () => {
  const dir = await tempDir();
  try {
    await appendNote({ dir, day: '2026-11-08', text: 'x' });
    const names = await readdir(dir);
    assert.deepEqual(names, ['2026-11-08.md'], '一天一个文件，不建别的结构');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
