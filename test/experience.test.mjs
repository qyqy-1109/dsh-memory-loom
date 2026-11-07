/**
 * 体验层的回归测试（v0.30.4）：
 * ① 注入块要有「今天几号」——否则「三天前说的那个」只能靠猜；
 * ② 追问要带上文——「那这个呢」这种消息本身召回不到任何东西；
 * ③ 整库能导出、能导入，且导入是「校验 → 备份 → 替换」。
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { MemoryStore } from '../lib/store.js';
import { looksLikeProcessLog } from '../lib/text.js';
import {
  composeRecallQuery,
  extractUserText,
  needsRecallContext,
  renderInjection,
  todayLine,
} from '../lib/index.js';

test('注入：带上今天的日期与星期（时间问题的基准日）', () => {
  const now = new Date(2026, 10, 7, 10, 0, 0).getTime(); // 2026-11-07
  const line = todayLine(now);
  const weekday = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][new Date(now).getDay()];
  assert.ok(line.includes('2026-11-07'), `应包含日期，实际：${line}`);
  assert.ok(line.includes(weekday), `应包含星期，实际：${line}`);

  const text = renderInjection(
    { blocks: [{ name: 'facts', title: '【想起来的事】', text: '- 用户对花生过敏' }] },
    now,
  );
  assert.ok(text.includes('2026-11-07'), '注入正文里要能读到基准日');
  assert.ok(text.includes('【想起来的事】'));
  assert.ok(text.startsWith('<memory-loom>') && text.endsWith('</memory-loom>'));
});

test('追问：短句与指代句才借上一条消息，长句不稀释查询', () => {
  assert.equal(needsRecallContext('那这个呢'), true);
  assert.equal(needsRecallContext('继续'), true);
  assert.equal(needsRecallContext('继续优化'), true);
  assert.equal(needsRecallContext(''), false);
  // 一整句本身就够用，不该再混进上文
  assert.equal(needsRecallContext('把面板里那个摘要页的撤销按钮改成两步确认'), false);
  assert.equal(needsRecallContext('顺便问一下召回阈值现在设成多少了'), false);

  const prev = '把记忆面板的字号调大一点，侧栏那块太挤了';
  assert.equal(composeRecallQuery('那这个呢', prev), `那这个呢\n${prev}`);
  assert.equal(composeRecallQuery('继续优化', prev), `继续优化\n${prev}`);
  // 长句：原样用当前消息
  assert.equal(composeRecallQuery('把面板里那个摘要页的撤销按钮改成两步确认', prev), '把面板里那个摘要页的撤销按钮改成两步确认');
  // 没有上文时也不能凭空造
  assert.equal(composeRecallQuery('那这个呢', ''), '那这个呢');
  // 上文太长只留尾巴（120 字）
  const long = '前'.repeat(300);
  assert.equal(composeRecallQuery('继续', long), `继续\n${'前'.repeat(120)}`);
});

test('导出/导入：往返后内容一致，且导入先备份、坏文件不覆盖', async () => {
  const dirA = await mkdtemp(join(tmpdir(), 'loom-exp-'));
  const dirB = await mkdtemp(join(tmpdir(), 'loom-imp-'));
  const a = new MemoryStore({ storePath: join(dirA, 'store.json'), compactAt: 0 });
  await a.open();
  await a.write({ kind: 'fact', text: '用户偏好不透明的深空面板', source: 't' });
  await a.write({ kind: 'world', text: 'DSH 的 main 是 keyed 槽', source: 't' });
  await a.write({ kind: 'slot', entity: '记忆海', attr: '形态', text: 'main 槽整页' });
  await a.addSummary({ text: '【归纳·面板】共 6 条：1. 不透明；2. 不要玻璃拟态' });

  const text = await a.exportJson();
  assert.ok(text.trim().endsWith('}'), '导出的应是完整 JSON');
  const exported = JSON.parse(text);
  assert.equal(exported.memories.length, 2, '槽位存在 slots 里，不算 memories');
  assert.equal(exported.slots.length, 1);

  const b = new MemoryStore({ storePath: join(dirB, 'store.json'), compactAt: 0 });
  await b.open();
  const result = await b.importJson(text);
  assert.equal(result.ok, true);
  assert.equal(b.active().length, 2);
  assert.deepEqual(b.active().map((row) => row.text).sort(), a.active().map((row) => row.text).sort());
  assert.equal(b.state.summaries.length, 1);
  assert.equal(b.slots().length, 1, '槽位也要跟着回来');
  // 落盘了：新开一个实例读到的是同一份
  const reopened = new MemoryStore({ storePath: join(dirB, 'store.json'), compactAt: 0 });
  await reopened.open();
  assert.equal(reopened.active().length, 2);

  // 导入前的强制备份：目录里要出现一个 .bak- 文件
  const backups = (await readdir(dirB)).filter((name) => name.includes('.bak-'));
  assert.ok(backups.length >= 1, '导入这种整体替换必须先留备份');

  // 坏输入一律拒绝，且现有数据一个字都不动
  const before = reopened.active().length;
  await assert.rejects(() => reopened.importJson('{坏的'), /不是合法的 JSON/);
  await assert.rejects(() => reopened.importJson({}), /缺少 memories/);
  await assert.rejects(() => reopened.importJson({ memories: [] }), /空/);
  assert.equal(reopened.active().length, before, '校验失败不能动到现有库');

  await rm(dirA, { recursive: true, force: true });
  await rm(dirB, { recursive: true, force: true });
});

test('会话消息抽取：只留用户原话（导出/导入这类按钮不参与召回）', () => {
  const messages = [
    { role: 'user', content: [{ type: 'text', text: '把导出按钮挪到页头' }] },
    { role: 'assistant', content: [{ type: 'text', text: '好' }] },
  ];
  assert.equal(extractUserText(messages), '把导出按钮挪到页头');
});

test('过程记录判据：带版本号 + 变更动作才算，结论式句子不算', () => {
  assert.equal(looksLikeProcessLog('v0.30.1 修「状态」分类永远 0 条：slot 数据存在 state.slots'), true);
  assert.equal(looksLikeProcessLog('写入机制 v0.19.0：memory_write 支持 entries 批量'), true);
  assert.equal(looksLikeProcessLog('v0.28.0：归纳加 keep-ratio，只压缩权重靠后的 70%'), true);
  // 提到版本号但是结论口吻：不归档
  assert.equal(looksLikeProcessLog('面板最终定为三维记忆海（v0.28 那版的效果）'), false);
  assert.equal(looksLikeProcessLog('用户偏好不透明的深空面板'), false);
  assert.equal(looksLikeProcessLog('2026-11-07 下午换过一次承载'), false);
});

test('整理过程记录：只归档 changelog 式条目，结论 / 亲口记忆 / 约束一条不碰', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'loom-tidy-'));
  const store = new MemoryStore({ storePath: join(dir, 'store.json'), compactAt: 0 });
  await store.open();
  await store.write({ kind: 'fact', text: 'v0.30.1 修「状态」分类永远 0 条：slot 数据存在 state.slots', source: 't' });
  await store.write({ kind: 'fact', text: '写入机制 v0.19.0：memory_write 支持 entries 批量', source: 't' });
  await store.write({ kind: 'fact', text: '用户偏好不透明的深空面板', source: 'tool' });
  await store.write({ kind: 'fact', text: 'v0.30.2 起面板不要任何返回按钮', explicit: true, source: 'explicit' });
  await store.write({ kind: 'constraint', text: 'v0.30.1 起：改源码只用 read/write/edit', source: 't' });

  const preview = await store.tidyProcessLogs({ apply: false });
  assert.equal(preview.count, 2, '只有两条 changelog 式条目');
  assert.equal(store.active().length, 5, '预览不能改库');

  const applied = await store.tidyProcessLogs({ apply: true });
  assert.equal(applied.archived, 2);
  const archived = store.state.memories.filter((row) => row.archivedReason === 'bulk-log');
  assert.equal(archived.length, 2);

  const alive = store.active().map((row) => row.text);
  assert.ok(alive.includes('用户偏好不透明的深空面板'), '结论不能被当成过程记录');
  assert.ok(alive.includes('v0.30.2 起面板不要任何返回按钮'), 'explicit（亲口说的）必须豁免');
  assert.ok(alive.includes('v0.30.1 起：改源码只用 read/write/edit'), '约束只解除不归档');

  // 归档可单条恢复
  const restored = await store.restore(archived[0].id);
  assert.equal(restored.restored, true);
  assert.ok(store.active().some((row) => row.id === archived[0].id));

  // 再预览一次：已经没候选了
  const again = await store.tidyProcessLogs({ apply: false });
  assert.equal(again.count, 1, '恢复出来的那条会重新成为候选（说明恢复真的生效了）');

  await rm(dir, { recursive: true, force: true });
});

