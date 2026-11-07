/**
 * 主题词取名的回归测试。
 *
 * 起因（真实库实测）：11 条版本记录被压成一条摘要后，主题词是「新增」——
 * 成员句首各不相同 ⇒ 公共前缀为空 ⇒ 兜底取最高频二元组 ⇒ changelog 满篇的「新增」当选。
 * 面板上就显示「归纳·新增」。同一批候选里活跃簇的 key 是「记忆 16/36」「ai 9/36」，
 * 也就是域内饱和词和跨词碎片。这里把两条规则钉住。
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { labelOf, clusterByTopic, isGenericLabel, looksLikeChangeLog } from '../lib/summary.js';
import { MemoryStore } from '../lib/store.js';

/** 真实库里那 11 条版本记录（句首各不相同，只有版本号是共同点）。 */
const CHANGELOG = [
  '写入机制 v0.19.0：memory_write 支持 entries 批量（≤20 条，各自可带 supersedes）。',
  'v0.20.0：memory_search 支持 since/until 时间窗口（接受日期与 ISO 时间）。',
  'v0.20.1 修复：pre-step 里 injectRecall 曾被当成总闸放在写入之前。',
  'v0.21.0 修复严重查重 bug：「用户喜欢深色主题」与「用户不喜欢深色主题」相似度 0.86。',
  'v0.22.0 补齐三缺口：摘要层自动归纳、面板可见摘要、归档可追溯。',
  'v0.23.0：记忆海面板新增「摘要」标签页，可点「查看原文」跳到记忆库。',
  'v0.24.0：面板加了健康灯与备份份数显示，损坏的库不再静默当空库。',
  'v0.25.0 三项完成，摘要进检索（kind=summary 带 topic）。',
  'v0.26.1 接入模型归纳，新增 lib/llm-summary.js。',
  'v0.27.0 已用官方 DeepSeek API 实测通过，真实库副本加 deepseek-flash 跑通。',
  'v0.27.2 修「查看原文」空列表：snapshot() 每行映射漏了 summarizedBy 字段。',
];

test('主题词：版本记录簇标成「版本进展」，不是「新增」', () => {
  const members = CHANGELOG.map((text, index) => ({ id: `c${index}`, text }));
  assert.equal(looksLikeChangeLog(members), true, '11 条都带版本号，应识别为版本记录簇');
  assert.equal(labelOf(members), '版本进展');
});

test('主题词：普通内容簇仍然优先进公共前缀，不被版本号规则抢走', () => {
  const members = [];
  for (let i = 0; i < 8; i += 1) {
    members.push({ id: `r${i}`, text: `渲染帧率 v1.${i} 版本在第 ${i} 种场景下需要自适应降档` });
  }
  // 每条都带版本号，但句首（公共前缀）是可读主题 —— 不能标成「版本进展」
  assert.equal(labelOf(members), '渲染帧率');
});

test('主题词：兜底不选泛动词，跨词碎片也不当标签', () => {
  const members = [
    '新增 lib/rank 检索打分',
    '新增 lib/store 写入路径',
    '新增 面板摘要页签',
    '新增 侧栏导航入口',
    '新增 归纳冷却窗口',
    '新增 归档上限校验',
  ].map((text, index) => ({ id: `g${index}`, text }));
  const label = labelOf(members);
  assert.notEqual(label, '新增', '「新增」是泛动词，不能当主题词');
  assert.equal(isGenericLabel(label), false, `兜底标签必须是可读主题词，实际拿到「${label}」`);
  assert.ok([...label].length >= 2);
});

test('成簇：域内饱和词不当 key（整个库都在讲记忆时，「记忆」不是主题）', () => {
  const members = [];
  for (let i = 0; i < 15; i += 1) members.push({ id: `m${i}`, kind: 'fact', text: `记忆 ${i} 号：面板渲染细节` });
  for (let i = 0; i < 7; i += 1) members.push({ id: `x${i}`, kind: 'fact', text: `检索排序第 ${i} 次实测` });

  const clusters = clusterByTopic(members, { minSize: 6 });
  assert.equal(clusters.length, 1, '「记忆」「面板」「渲染」都饱和，只剩检索排序这一簇');
  assert.equal(clusters[0].topic, '检索排序');
  assert.ok(clusters[0].members.every((member) => member.id.startsWith('x')), '异类成员不能被卷进来');
});

test('成簇：全部饱和时退化成「先归纳」而不是「不归纳」', () => {
  const members = [];
  for (let i = 0; i < 8; i += 1) members.push({ id: `d${i}`, kind: 'fact', text: `记忆 第 ${i} 条：渲染取舍` });
  const clusters = clusterByTopic(members, { minSize: 6 });
  assert.equal(clusters.length, 1, '饱和词全被剔除时也必须给出一簇，不能停止归纳');
  assert.ok(clusters[0].members.length === 8);
  assert.ok(clusters[0].topic.length > 0);
});

test('旧库迁移：加载时把「新增」这类老主题词按新规则重算，且只改一次', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'loom-relabel-'));
  const storePath = join(dir, 'store.json');
  const now = Date.now();
  const members = CHANGELOG.map((text, index) => ({
    id: `c${index}`,
    kind: 'fact',
    text,
    hits: 0,
    explicit: false,
    status: 'archived',
    archivedAt: now,
    archivedReason: 'summarized',
    summarizedBy: 's1',
    createdAt: now - index * 1000,
    updatedAt: now - index * 1000,
  }));
  await writeFile(
    storePath,
    JSON.stringify({
      version: 1,
      createdAt: now,
      updatedAt: now,
      memories: members,
      slots: [],
      summaries: [
        {
          id: 's1',
          sessionId: null,
          topic: '新增',
          text: `【归纳·新增】共 ${members.length} 条：1. 写入机制批量；2. 时间窗口检索`,
          memberIds: members.map((row) => row.id),
          memberCount: members.length,
          createdAt: now,
          source: 'compact',
          generator: 'llm',
        },
      ],
      cfgOverrides: {},
      events: [],
      recall: {},
      meta: {},
    }),
    'utf8',
  );

  const store = new MemoryStore({ storePath });
  await store.open();
  assert.equal(store.state.summaries[0].topic, '版本进展', '老标签必须被重算');
  assert.ok(store.state.summaries[0].text.startsWith('【归纳·版本进展】'), '正文里的旧前缀要一起换掉');

  // 落盘了：重新打开一个新实例读的是磁盘上的值
  const reopened = new MemoryStore({ storePath });
  await reopened.open();
  assert.equal(reopened.state.summaries[0].topic, '版本进展');

  // 幂等：第二次加载不该再产生 relabel 事件
  const before = reopened.state.events.filter((event) => event.kind === 'summary.relabel').length;
  const third = new MemoryStore({ storePath });
  await third.open();
  const after = third.state.events.filter((event) => event.kind === 'summary.relabel').length;
  assert.equal(after, before, '已经改好的标签不该每次启动都再改一遍');

  // 手工起的主题词不归规则管，不能被覆盖
  const raw = JSON.parse(await readFile(storePath, 'utf8'));
  raw.summaries[0].topic = '新增';
  raw.summaries[0].text = '用户手工写的一句话摘要';
  await writeFile(storePath, JSON.stringify(raw), 'utf8');
  const untouched = new MemoryStore({ storePath });
  await untouched.open();
  assert.equal(untouched.state.summaries[0].topic, '版本进展', '泛词仍应被重算');
  assert.equal(untouched.state.summaries[0].text, '用户手工写的一句话摘要', '正文不能被规则改写');

  await rm(dir, { recursive: true, force: true });
});
