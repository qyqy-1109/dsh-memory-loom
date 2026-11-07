/**
 * 召回质量的回归测试。
 *
 * 三件事都是实测发现的问题：
 * ① 宿主每轮追加的 runtime context（工作目录 / 文件策略 / 时间）会跟着用户消息进检索，
 *    于是每次召回都被「记忆/文件/路径/当前/目录」这些样板词带偏；
 * ② 【更早之前】块原来用 Jaccard（`similarity`）挑摘要，而检索主体早就换成 IDF 覆盖率了 ——
 *    同一份查询两把尺子，排序互相打脸；
 * ③ 覆盖率并列时原来只按 createdAt 排，等于"刚写的过程记录"压过"反复被用到的结论"。
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { MemoryStore } from '../lib/store.js';
import { extractUserText, stripHostBoilerplate } from '../lib/index.js';

/** 宿主真实注入的运行时上下文（原文摘录）。 */
const RUNTIME_CONTEXT = [
  'Current runtime context. This snapshot supersedes earlier runtime-context snapshots.',
  '',
  'Current working directory: "D:\\demo".',
  '',
  'Current DSH file policy: danger-full-access. The DSH file sandbox does not restrict file modifications by available operations.',
  '',
  'Approval prompts are disabled in this session: actions that require approval are rejected automatically.',
  '',
  'Browser time zone for this request: Asia/Shanghai. Interpret otherwise-unqualified dates and times in this zone.',
].join('\n');

test('查询清洗：宿主运行时样板和自我注入的记忆块都不进检索查询', () => {
  const messages = [
    {
      role: 'user',
      content: [{ type: 'text', text: `把记忆面板的字号调大\n${RUNTIME_CONTEXT}\n\n<memory-loom>\n【想起来的事】\n- 旧内容\n</memory-loom>` }],
    },
  ];
  const text = extractUserText(messages);
  assert.equal(text, '把记忆面板的字号调大', '只留用户原话');
  assert.equal(stripHostBoilerplate(RUNTIME_CONTEXT), '', '纯样板应该被剥成空串，而不是拿去检索');
});

test('召回：摘要块按覆盖率挑，而不是按 Jaccard 或"最新的那条"', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'loom-recall-'));
  const store = new MemoryStore({ storePath: join(dir, 'store.json'), compactAt: 0 });
  await store.open();
  const relevant = await store.addSummary({
    text: '【归纳·检索排序】共 8 条：1. IDF 加权覆盖度替代 Jaccard；2. 停用词要单独压一层',
  });
  // 更新的一条完全无关：旧实现（"必取最新"）会把它顶上来
  const latest = await store.addSummary({ text: '【归纳·面板配色】共 6 条：1. 深空底色；2. 不要玻璃拟态' });
  assert.ok(relevant.id !== latest.id);

  const snapshot = store.buildRecall('检索排序为什么不用 Jaccard');
  const block = (snapshot.blocks ?? []).find((item) => item.name === 'summary');
  assert.ok(block !== undefined, '摘要块必须在');
  assert.ok(block.text.includes('IDF 加权覆盖度'), '相关的摘要要被挑进来');
  await rm(dir, { recursive: true, force: true });
});

test('召回：覆盖率并列时，反复被用到的结论排在刚写的过程记录前面', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'loom-tie-'));
  const store = new MemoryStore({ storePath: join(dir, 'store.json'), compactAt: 0 });
  await store.open();
  // 顺序很关键：结论先写、过程记录后写 —— 这样"按 createdAt 排"的旧实现一定会把过程记录顶到前面
  const decision = await store.write({ kind: 'fact', text: '渲染帧率必须有保底：低于 45 就自适应降档', source: 't' });
  const process = await store.write({ kind: 'fact', text: '渲染帧率自适应降档的试验记录第 7 次', source: 't' });
  // 结论被反复召回（touch 会抬权重），过程记录一次都没被用过
  for (let i = 0; i < 6; i += 1) await store.touch([decision.id]);

  const hits = store.search('渲染帧率 自适应降档', { threshold: 0.2, limit: 5 });
  const ids = hits.map((hit) => hit.id);
  assert.ok(ids.includes(process.id) && ids.includes(decision.id), '两条都应命中');
  assert.equal(ids[0], decision.id, '并列时按权重排，过程记录不该靠"更新"取胜');
  await rm(dir, { recursive: true, force: true });
});
