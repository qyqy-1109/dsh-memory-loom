import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { classifyExplicit, findEventDate, looksLikeChange, similarity, tokenize } from '../lib/text.js';
import { MemoryStore, DEFAULTS, weightOf, TUNABLE, TUNABLE_TEXT, clampTunable, clampTunableText } from '../lib/store.js';
import { computeHealth, STATUS } from '../lib/health.js';
import { clusterByTopic, planSummaries } from '../lib/summary.js';

/** 造一个临时库。 */
async function makeStore(overrides = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'loom-'));
  const store = new MemoryStore({ file: join(dir, 'store.json'), ...overrides });
  await store.open();
  return { store, dir, cleanup: () => rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 60 }) };
}

test('分词与相似度：近似句高分，无关句零分', () => {
  assert.ok(tokenize('我对花生过敏').length > 0);
  assert.ok(similarity('用户对花生过敏', '我对花生过敏') > 0.5);
  assert.equal(similarity('用户对花生过敏', '今天天气不错'), 0);
  assert.ok(similarity('用户住在杭州', '用户住在杭州') > 0.99);
});

test('日期解析：只认能确定的，认不出返回 null', () => {
  const now = new Date(2026, 10, 6, 12, 0, 0).getTime();
  assert.equal(findEventDate('2026-03-04 搬家了', now), '2026-03-04');
  assert.equal(findEventDate('昨天她说要去医院', now), '2026-11-05');
  assert.equal(findEventDate('后天去爬山', now), '2026-11-08');
  assert.equal(findEventDate('3月4日见了一面', now), '2026-03-04');
  assert.equal(findEventDate('她喜欢猫', now), null);
});

test('显式触发：记住/别忘了命中，约束口吻归 constraint', () => {
  assert.equal(classifyExplicit('记住：我对花生过敏').explicit, true);
  assert.equal(classifyExplicit('别忘了周三交报告').explicit, true);
  assert.equal(classifyExplicit('以后都不许再提这件事').kind, 'constraint');
  assert.equal(classifyExplicit('今天有点累').explicit, false);
});

test('状态变化词：只认明确的替换动作，不把日常「改/换」误判', () => {
  assert.equal(looksLikeChange('用户搬到上海了'), true);
  assert.equal(looksLikeChange('把面板改成了星图'), true);
  assert.equal(looksLikeChange('已经戒掉了咖啡'), true);
  // 这两句以前会误报，现在必须放过
  assert.equal(looksLikeChange('改 dsh-memory-loom 的源码'), false);
  assert.equal(looksLikeChange('换个缩进风格'), false);
});

test('写入：新条目落库，重复条目只累加命中', async () => {
  const { store, cleanup } = await makeStore();
  try {
    const first = await store.write({ kind: 'fact', text: '用户对花生过敏' });
    assert.equal(first.status, 'created');
    assert.equal(store.active().length, 1);

    const second = await store.write({ kind: 'fact', text: '用户对花生过敏' });
    assert.equal(second.status, 'deduped');
    assert.equal(second.id, first.id);
    assert.equal(store.active().length, 1);
    assert.equal(store.active()[0].hits, 1);
    assert.ok(store.counts().active === 1);
  } finally {
    await cleanup();
  }
});

test('取代：旧条目软删归档，新条目记录 supersedes', async () => {
  const { store, cleanup } = await makeStore();
  try {
    const old = await store.write({ kind: 'fact', text: '用户住在杭州' });
    const next = await store.write({ kind: 'fact', text: '用户搬到上海了', supersedes: [old.id] });
    assert.equal(next.status, 'created');
    assert.deepEqual(next.archived, [old.id]);
    const archivedRow = store.byId(old.id);
    assert.equal(archivedRow.status, 'archived');
    assert.equal(archivedRow.archivedReason, 'superseded');
    assert.equal(archivedRow.supersededBy, next.id);
    assert.equal(store.byId(next.id).supersedes[0], old.id);
    assert.equal(store.counts().active, 1);
    assert.equal(store.counts().archived, 1);
  } finally {
    await cleanup();
  }
});

test('约束被取代时是「解除」而不是归档', async () => {
  const { store, cleanup } = await makeStore();
  try {
    const old = await store.write({ kind: 'constraint', text: '不要在晚上十点后发消息' });
    const next = await store.write({ kind: 'constraint', text: '晚上十点后可以发消息了', supersedes: [old.id] });
    assert.deepEqual(next.relaxed, [old.id]);
    const row = store.byId(old.id);
    assert.equal(row.status, 'active');
    assert.ok(row.relaxedAt !== null);
    assert.equal(store.counts().constraintsActive, 1);
    assert.equal(store.counts().constraintsRelaxed, 1);
    // 已解除的约束不再进注入块。
    const recall = store.buildRecall('随便说点什么');
    const constraintBlock = recall.blocks.find((block) => block.name === 'constraints');
    assert.ok(constraintBlock === undefined || !constraintBlock.text.includes('晚上十点后发消息'));
  } finally {
    await cleanup();
  }
});

test('槽位是覆盖式写入，不参与淘汰', async () => {
  const { store, cleanup } = await makeStore({ maxActiveMemories: 1 });
  try {
    await store.write({ kind: 'slot', entity: '猫', attr: '所在地', text: '客厅' });
    await store.write({ kind: 'slot', entity: '猫', attr: '所在地', text: '卧室' });
    assert.equal(store.slots().length, 1);
    assert.equal(store.slots()[0].value, '卧室');
    assert.equal(store.active().length, 0);
  } finally {
    await cleanup();
  }
});

test('容量淘汰：只动可淘汰集合，显式记忆与约束豁免', async () => {
  const { store, cleanup } = await makeStore({ maxActiveMemories: 3 });
  try {
    await store.write({ kind: 'constraint', text: '每次回答都要给结论' });
    await store.write({ kind: 'fact', text: '用户的生日是五月三日', explicit: true });
    const distinct = [
      '她养了一只叫年糕的猫',
      '用户在上海做后端开发',
      '周末喜欢去爬西山',
      '最近在读一本关于海洋生态的书',
      '咖啡只喝浅烘的手冲',
      '讨厌开会时被打断',
    ];
    for (const text of distinct) {
      await store.write({ kind: 'fact', text });
    }
    const active = store.active();
    assert.ok(active.length <= 3, `活跃集应被压到上限内，实际 ${active.length}`);
    assert.ok(active.some((row) => row.kind === 'constraint'));
    assert.ok(active.some((row) => row.explicit === true));
    assert.ok(store.counts().archived > 0);
    const evictEvents = store.state.events.filter((event) => event.kind === 'memory.evict');
    assert.ok(evictEvents.length > 0);
  } finally {
    await cleanup();
  }
});

test('归档超过上限时物理删除最老的', async () => {
  const { store, cleanup } = await makeStore({ maxArchive: 2 });
  try {
    const ids = [];
    for (let index = 0; index < 4; index += 1) {
      const written = await store.write({ kind: 'fact', text: `待归档事实 ${index}` });
      ids.push(written.id);
      await store.forget(written.id, { reason: 'test' });
    }
    // 每次遗忘都会触发修剪，最终归档不会超过 2。
    assert.ok(store.archived().length <= 2);
    assert.equal(store.state.memories.filter((row) => row.status === 'archived').length, store.archived().length);
  } finally {
    await cleanup();
  }
});

test('召回：阈值过滤 + 弱相关标记 + 常驻块', async () => {
  const { store, cleanup } = await makeStore({ recallThreshold: 0.2 });
  try {
    await store.write({ kind: 'constraint', text: '不要在深夜给建议' });
    await store.write({ kind: 'fact', text: '用户对花生过敏' });
    await store.write({ kind: 'episode', text: '一起在西湖边走了很久', scene: '杭州', significance: 4 });
    await store.write({ kind: 'slot', entity: '用户', attr: '心情', text: '低落' });

    const hit = store.buildRecall('我对花生过敏这件事你还记得吗');
    const facts = hit.blocks.find((block) => block.name === 'facts');
    assert.ok(facts !== undefined && facts.text.includes('花生'));
    assert.ok(hit.blocks.some((block) => block.name === 'constraints'));
    assert.ok(hit.blocks.some((block) => block.name === 'slots'));
    assert.ok(hit.blocks.some((block) => block.name === 'episodes'));

    const miss = store.buildRecall('量子色动力学的渐近自由');
    assert.equal(miss.blocks.some((block) => block.name === 'facts'), false);
    // 约束/槽位/经历是常驻注入，不随查询变化。
    assert.ok(miss.blocks.some((block) => block.name === 'constraints'));
  } finally {
    await cleanup();
  }
});

test('持久化：写盘后可重新打开，内容一致', async () => {
  const { store, dir, cleanup } = await makeStore();
  try {
    await store.write({ kind: 'episode', text: '第一次一起看电影', scene: '影院', significance: 5 });
    const raw = JSON.parse(await readFile(join(dir, 'store.json'), 'utf8'));
    assert.equal(raw.memories.length, 1);

    const reopened = new MemoryStore({ file: join(dir, 'store.json') });
    await reopened.open();
    assert.equal(reopened.active().length, 1);
    assert.equal(reopened.episodes()[0].significance, 5);
  } finally {
    await cleanup();
  }
});

test('损坏的库：不静默当空库，loadError 留给健康灯', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'loom-'));
  const file = join(dir, 'store.json');
  try {
    await writeFile(file, '{ 这不是 JSON', 'utf8');
    const store = new MemoryStore({ file });
    await store.open();
    assert.ok(typeof store.loadError === 'string' && store.loadError.length > 0);
    const health = computeHealth(store, {});
    assert.equal(health.statuses.write, STATUS.DEGRADED);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('健康灯：空库是 empty 而不是空白，注意摘要层如实报 empty', async () => {
  const { store, cleanup } = await makeStore();
  try {
    const health = computeHealth(store, {});
    assert.equal(health.layers.length, 6);
    assert.equal(health.statuses.write, STATUS.EMPTY);
    assert.equal(health.statuses.summary, STATUS.EMPTY);
    assert.equal(health.statuses.slot, STATUS.EMPTY);
    assert.equal(health.statuses.episode, STATUS.EMPTY);
    assert.equal(health.statuses.recall, STATUS.UNKNOWN);

    await store.write({ kind: 'fact', text: '用户喜欢喝手冲咖啡' });
    await store.write({ kind: 'episode', text: '一起去看海', scene: '海边', significance: 3 });
    await store.write({ kind: 'slot', entity: '用户', attr: '在做什么', text: '写代码' });
    await store.recordRecall(store.buildRecall('咖啡'));
    const next = computeHealth(store, {});
    assert.equal(next.statuses.write, STATUS.OK);
    assert.equal(next.statuses.episode, STATUS.OK);
    assert.equal(next.statuses.slot, STATUS.OK);
    assert.equal(next.statuses.recall, STATUS.OK);
  } finally {
    await cleanup();
  }
});

test('权重随时间衰减，命中越多权重越高', () => {
  const now = Date.now();
  const fresh = { createdAt: now, updatedAt: now, hits: 0 };
  const old = { createdAt: now - 60 * 86_400_000, updatedAt: now - 60 * 86_400_000, hits: 0 };
  assert.ok(weightOf(fresh, now, 30) > weightOf(old, now, 30));
  assert.ok(weightOf({ ...fresh, hits: 5 }, now, 30) > weightOf(fresh, now, 30));
});

test('默认值齐全：阈值给的是可复核的口径', () => {
  assert.equal(typeof DEFAULTS.dedupeThreshold, 'number');
  assert.ok(DEFAULTS.recallThreshold < DEFAULTS.dedupeThreshold);
  assert.ok(DEFAULTS.maxActiveMemories > 0);
});

test('时间窗口检索：空 query + since/until 按时间线倒序返回', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'loom-time-'));
  const store = new MemoryStore({ storePath: join(dir, 'store.json') });
  await store.open();
  const base = Date.parse('2026-11-06T10:00:00+08:00');
  await store.write({ kind: 'fact', text: '上午跑的体测脚本', source: 'test' });
  // 手动改 createdAt 造时间差，避免依赖真实时钟
  store.state.memories.at(-1).createdAt = base;
  await store.write({ kind: 'episode', text: '下午换了五种面板承载', scene: '桌面', source: 'test' });
  store.state.memories.at(-1).createdAt = base + 4 * 3600_000;
  await store.write({ kind: 'fact', text: '第二天才想到的结论', source: 'test' });
  store.state.memories.at(-1).createdAt = base + 30 * 3600_000;

  const sameDay = store.search('', {
    since: Date.parse('2026-11-06T00:00:00+08:00'),
    until: Date.parse('2026-11-06T23:59:59+08:00'),
  });
  assert.equal(sameDay.length, 2, '当天应只有两条');
  assert.ok(sameDay[0].createdAt > sameDay[1].createdAt, '时间线必须倒序');
  assert.match(sameDay[0].text, /下午换了五种/);

  const afternoon = store.search('', {
    since: Date.parse('2026-11-06T12:00:00+08:00'),
    until: Date.parse('2026-11-06T18:00:00+08:00'),
  });
  assert.equal(afternoon.length, 1, '只查下午应命中一条');
  await rm(dir, { recursive: true, force: true });
});

test('查重不能吞掉否定或编号：相似度高但极性/编号不同必须分开存', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'loom-neg-'));
  const store = new MemoryStore({ storePath: join(dir, 'store.json') });
  await store.open();

  const a = await store.write({ kind: 'fact', text: '用户喜欢深色主题', source: 't' });
  const b = await store.write({ kind: 'fact', text: '用户不喜欢深色主题', source: 't' });
  assert.equal(a.status, 'created');
  assert.equal(b.status, 'created', '否定句不能被并进肯定句（相似度 0.86 > 阈值 0.72）');
  assert.equal(store.active().length, 2);

  const c = await store.write({ kind: 'fact', text: '第 1 条结论：渲染要降档', source: 't' });
  const d = await store.write({ kind: 'fact', text: '第 2 条结论：渲染要降档', source: 't' });
  assert.equal(c.status, 'created');
  assert.equal(d.status, 'created', '编号不同不能合并（相似度 0.96）');

  // 真正的重复（仅标点差异）仍然要去重
  const e = await store.write({ kind: 'fact', text: '用户偏好深色主题的面板', source: 't' });
  const f = await store.write({ kind: 'fact', text: '用户偏好深色主题的面板。', source: 't' });
  assert.equal(e.status, 'created');
  assert.equal(f.status, 'deduped', '同一句话只差句号，应当合并');
  await rm(dir, { recursive: true, force: true });
});

test('容量：活跃上限、归档上限、world 上限都会被强制执行', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'loom-cap-'));
  // 关掉主动压缩，单独验证硬上限这条路径
  const store = new MemoryStore({ storePath: join(dir, 'store.json'), compactAt: 0, maxWorld: 30, maxActiveMemories: 150, maxArchive: 40 });
  await store.open();
  for (let i = 0; i < store.cfg.maxActiveMemories + 120; i += 1) {
    await store.write({ kind: 'fact', text: `第 ${i} 号独立结论：渲染取舍`, source: 't' });
  }
  assert.equal(store.active().length, store.cfg.maxActiveMemories, '活跃条数必须卡在上限');
  const archived = store.state.memories.filter((m) => m.status !== 'active');
  assert.ok(archived.length > 0, '超出的应进归档');
  assert.ok(archived.length <= store.cfg.maxArchive, '归档不得超过上限');
  assert.ok(archived.every((m) => m.archivedReason === 'capacity'));

  // world 有独立上限，且不参与容量淘汰
  for (let i = 0; i < 45; i += 1) await store.write({ kind: 'world', text: `世界设定 ${i} 号`, source: 't' });
  const worlds = store.active().filter((m) => m.kind === 'world');
  assert.equal(worlds.length, store.cfg.maxWorld, 'world 必须卡在自己的上限');
  await rm(dir, { recursive: true, force: true });
});


test('摘要：同主题条目被归纳成一条，标签是可读的主题词而不是句子碎片', async () => {
  const members = [];
  for (let i = 0; i < 8; i += 1) {
    members.push({ id: `r${i}`, kind: 'fact', text: `渲染帧率在第 ${i} 种场景下需要自适应降档以保持流畅` });
  }
  for (let i = 0; i < 6; i += 1) {
    members.push({ id: `w${i}`, kind: 'world', text: `宿主侧栏宽度可以拖拽调整，第 ${i} 次验证有效` });
  }
  const clusters = clusterByTopic(members, { minSize: 6 });
  assert.equal(clusters.length, 2, '应分成两组');
  const labels = clusters.map((cluster) => cluster.topic).sort();
  // 关键：不能是「下需要自」「种场景下」这类跨词边界碎片
  assert.deepEqual(labels, ['渲染帧率', '宿主侧栏宽度'].sort());

  const plan = planSummaries(members, { minSize: 6, points: 3, maxLength: 200 });
  assert.equal(plan.length, 2);
  for (const item of plan) {
    assert.ok(item.memberIds.length >= 6);
    assert.ok(item.text.startsWith('【归纳·'), '摘要要有可读前缀');
    assert.ok(item.text.length <= 200, '摘要必须受长度上限约束');
  }
  // 只差编号的重复句不该被算成多个要点
  const frame = plan.find((item) => item.topic.includes('渲染'));
  assert.equal((frame.text.match(/\d+\./g) ?? []).length, 1, '编号不同的同一句应只留一个要点');
});

test('摘要层：到压缩线自动归纳，成员转归档且在召回里能读到', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'loom-sum-'));
  const store = new MemoryStore({
    storePath: join(dir, 'store.json'),
    compactAt: 20,
    summaryMinMembers: 6,
    summaryPoints: 2,
    maxSummaries: 5,
    maxActiveMemories: 500,
  });
  await store.open();
  for (let i = 0; i < 24; i += 1) {
    await store.write({ kind: 'fact', text: `渲染帧率在第 ${i} 种场景下需要自适应降档以保持流畅`, source: 't' });
  }
  assert.ok(store.state.summaries.length >= 1, '应生成摘要');
  const summarized = store.state.memories.filter((m) => m.archivedReason === 'summarized');
  assert.ok(summarized.length >= 6, '成员应转到归档（可追溯）');
  assert.ok(summarized.every((m) => typeof m.summarizedBy === 'string'), '归档条目要指回摘要');

  const snapshot = store.buildRecall('渲染降档怎么处理');
  const block = snapshot.blocks.find((item) => item.name === 'summary');
  assert.ok(block !== undefined, '召回里应有摘要块');
  assert.match(block.text, /归纳·渲染帧率/);
  await rm(dir, { recursive: true, force: true });
});

test('破坏性修剪前会留备份，且只保留最近若干份', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'loom-bak-'));
  const store = new MemoryStore({
    storePath: join(dir, 'store.json'),
    maxActiveMemories: 40,
    maxArchive: 8,
    compactAt: 0,
    backupKeep: 2,
    backupIntervalMs: 0,
  });
  await store.open();
  for (let i = 0; i < 90; i += 1) await store.write({ kind: 'fact', text: `第 ${i} 号结论 渲染`, source: 't' });
  const backups = (await readdir(dir)).filter((name) => name.includes('.bak-'));
  assert.ok(backups.length >= 1, '真删归档前必须留备份');
  assert.ok(backups.length <= 2, `备份份数应受 backupKeep 限制，实际 ${backups.length}`);
  await rm(dir, { recursive: true, force: true });
});

test('恢复：归档条目能一键回来，且不会被立刻再次淘汰', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'loom-res-'));
  const store = new MemoryStore({ storePath: join(dir, 'store.json'), compactAt: 0 });
  await store.open();
  const created = await store.write({ kind: 'fact', text: '这条被误归档了', source: 't' });
  await store.forget(created.id, { reason: 'manual' });
  assert.equal(store.byId(created.id).status, 'archived');

  const result = await store.restore(created.id);
  assert.equal(result.restored, true);
  const row = store.byId(created.id);
  assert.equal(row.status, 'active');
  assert.equal(row.archivedReason, null);
  // 恢复本身算一次"用到"，权重必须提上来，否则下一次淘汰立刻又挑中它
  assert.ok(row.hits >= 1, '恢复应累加命中');
  assert.ok(Date.now() - row.updatedAt < 5_000, '恢复应把 updatedAt 推到当前');
  assert.equal((await store.restore(created.id)).reason, 'already-active');
  assert.equal((await store.restore('不存在')).found, false);
  await rm(dir, { recursive: true, force: true });
});

test('撤销归纳：整组恢复成员并删除摘要', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'loom-uns-'));
  const store = new MemoryStore({
    storePath: join(dir, 'store.json'),
    compactAt: 20,
    summaryMinMembers: 6,
    maxActiveMemories: 500,
  });
  await store.open();
  for (let i = 0; i < 24; i += 1) {
    await store.write({ kind: 'fact', text: `渲染帧率在第 ${i} 种场景下需要自适应降档以保持流畅`, source: 't' });
  }
  assert.ok(store.state.summaries.length >= 1);
  const summary = store.state.summaries[0];
  const archivedBefore = store.state.memories.filter((m) => m.summarizedBy === summary.id).length;
  assert.ok(archivedBefore >= 6);

  const result = await store.restoreSummary(summary.id);
  assert.equal(result.found, true);
  assert.equal(result.restored, archivedBefore, '应恢复全部成员');
  assert.equal(store.state.summaries.length, 0, '摘要应被删除');
  assert.equal(store.state.memories.filter((m) => m.summarizedBy === summary.id).length, 0, '成员不再指向该摘要');
  await rm(dir, { recursive: true, force: true });
});

test('摘要也能被检索，且显式按 kinds 过滤时不混进来', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'loom-ss-'));
  const store = new MemoryStore({ storePath: join(dir, 'store.json'), compactAt: 20, summaryMinMembers: 6, maxActiveMemories: 300 });
  await store.open();
  for (let i = 0; i < 24; i += 1) {
    await store.write({ kind: 'fact', text: `渲染帧率在第 ${i} 种场景下需要自适应降档以保持流畅`, source: 't' });
  }
  assert.ok(store.state.summaries.length >= 1);
  const hits = store.search('渲染帧率怎么处理', { limit: 6 });
  const summary = hits.find((hit) => hit.kind === 'summary');
  assert.ok(summary !== undefined, '摘要应出现在检索结果里');
  assert.equal(summary.text.startsWith('【归纳·'), true);
  assert.ok(summary.members >= 6, '要带覆盖条数');
  // 只按主题词也能命中（摘要正文未必完整包含问句）
  assert.ok(store.search('渲染帧率', { limit: 6 }).some((hit) => hit.kind === 'summary'));
  // kinds 过滤时不塞摘要
  assert.equal(store.search('渲染帧率', { limit: 6, kinds: ['episode'] }).some((hit) => hit.kind === 'summary'), false);
  await rm(dir, { recursive: true, force: true });
});

test('批量写入只落盘一次，结果与逐条写一致', async () => {
  const dirA = await mkdtemp(join(tmpdir(), 'loom-b1-'));
  const dirB = await mkdtemp(join(tmpdir(), 'loom-b2-'));
  const inputs = Array.from({ length: 12 }, (_, i) => ({ kind: 'fact', text: `第 ${i} 条结论 渲染取舍`, source: 't' }));

  const sequential = new MemoryStore({ storePath: join(dirA, 'store.json'), compactAt: 0 });
  await sequential.open();
  for (const input of inputs) await sequential.write(input);

  const batched = new MemoryStore({ storePath: join(dirB, 'store.json'), compactAt: 0 });
  await batched.open();
  const results = await batched.writeMany(inputs);

  assert.equal(results.length, inputs.length, '每条都要有结果');
  assert.deepEqual(batched.active().map((m) => m.text).sort(), sequential.active().map((m) => m.text).sort(), '两种写法落库内容应一致');
  // 落盘确实发生（重新打开能读到）
  const reopened = new MemoryStore({ storePath: join(dirB, 'store.json'), compactAt: 0 });
  await reopened.open();
  assert.equal(reopened.active().length, inputs.length, '批量写必须落盘');
  await rm(dirA, { recursive: true, force: true });
  await rm(dirB, { recursive: true, force: true });
});

test('参数调节：越界被夹取，非法值被拒，覆盖项重启后仍生效', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'loom-tune-'));
  const store = new MemoryStore({ storePath: join(dir, 'store.json') });
  await store.open();

  // 越界夹取
  const first = await store.tune({ compactAt: 999999, maxActiveMemories: 5, halfLifeDays: 999 });
  assert.equal(first.applied.compactAt, TUNABLE.compactAt.max);
  assert.equal(first.applied.maxActiveMemories, TUNABLE.maxActiveMemories.min);
  assert.equal(first.applied.halfLifeDays, TUNABLE.halfLifeDays.max);
  // 非法键与非法值被拒
  const second = await store.tune({ storePath: '/etc/passwd', compactAt: 'abc' });
  assert.deepEqual(second.rejected.sort(), ['compactAt', 'storePath']);
  assert.equal(store.cfg.storePath, join(dir, 'store.json'), 'storePath 不可通过面板修改');

  // 重启后仍然生效
  const reopened = new MemoryStore({ storePath: join(dir, 'store.json') });
  await reopened.open();
  assert.equal(reopened.cfg.compactAt, TUNABLE.compactAt.max, '覆盖项应持久化');
  assert.equal(reopened.cfg.maxActiveMemories, TUNABLE.maxActiveMemories.min);
  await rm(dir, { recursive: true, force: true });
});

test('文本型可调参数：provider/model 可改可清空，越界截断，重启保留', async () => {
  assert.equal(clampTunableText('summaryProvider', '  deepseek-official  '), 'deepseek-official');
  assert.equal(clampTunableText('summaryProvider', ''), '', '空串表示回落到自动发现');
  assert.equal(clampTunableText('summaryProvider', 'x'.repeat(300)).length, TUNABLE_TEXT.summaryProvider.maxLength);
  assert.equal(clampTunableText('storePath', '/etc/passwd'), null, '不在白名单的一律拒绝');

  const dir = await mkdtemp(join(tmpdir(), 'loom-text-'));
  const store = new MemoryStore({ storePath: join(dir, 'store.json') });
  await store.open();
  const result = await store.tune({ summaryProvider: ' deepseek-official ', summaryModel: 'deepseek-v4-flash' });
  assert.equal(result.applied.summaryProvider, 'deepseek-official');
  assert.equal(store.cfg.summaryModel, 'deepseek-v4-flash');

  const reopened = new MemoryStore({ storePath: join(dir, 'store.json') });
  await reopened.open();
  assert.equal(reopened.cfg.summaryProvider, 'deepseek-official', '文本覆盖项重启后仍在');
  assert.equal(reopened.cfg.summaryModel, 'deepseek-v4-flash');
  await rm(dir, { recursive: true, force: true });
});

test('检索打分：IDF 覆盖度让"问句填词"不拖后腿，稀有词命中就能排到前面', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'loom-rank-'));
  const store = new MemoryStore({ storePath: join(dir, 'store.json') });
  await store.open();
  await store.write({ kind: 'fact', text: '用户对花生过敏，任何含花生的食谱都不建议' });
  await store.write({ kind: 'fact', text: '用户平时喜欢在晚上写代码，喜欢安静的环境' });
  await store.write({ kind: 'fact', text: '用户提过想学吉他，但一直没开始' });

  // 长问句带大量填词：旧算法（Jaccard）会被稀释到阈值以下，覆盖度不会
  const rows = store.search('我对什么东西过敏这件事你还记得吗');
  assert.ok(rows.length >= 1, '长问句也要能命中');
  assert.match(rows[0].text, /花生/);

  // 完全无关的查询不该命中
  assert.equal(store.search('量子色动力学的渐近自由').length, 0);
  await rm(dir, { recursive: true, force: true });
});

test('检索：领域别名把中文提问接到英文标识上（搜索→search、撤销→restore）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'loom-alias-'));
  const store = new MemoryStore({ storePath: join(dir, 'store.json') });
  await store.open();
  await store.write({ kind: 'fact', text: 'memory_search 支持 since/until 时间窗口' });
  await store.write({ kind: 'fact', text: 'memory_restore 可以按 id 恢复单条归档记忆' });
  await store.write({ kind: 'world', text: '画布用 fill-rate 优化，关闭簇雾' });

  assert.ok(store.search('搜索能不能按时间查').some((row) => row.text.includes('时间窗口')), '搜索→search');
  assert.ok(store.search('撤销的工具叫什么').some((row) => row.text.includes('memory_restore')), '撤销→restore');
  await rm(dir, { recursive: true, force: true });
});

test('摘要的 memberCount 要跟着单条恢复走，不能虚报', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'loom-mc-'));
  const store = new MemoryStore({ storePath: join(dir, 'store.json'), compactAt: 12, summaryMinMembers: 5, maxActiveMemories: 300 });
  await store.open();
  for (let i = 0; i < 16; i += 1) {
    await store.write({ kind: 'fact', text: `渲染帧率在第 ${i} 种场景下需要自适应降档以保持流畅`, source: 't' });
  }
  const summary = store.state.summaries[0];
  const before = summary.memberCount;
  const member = store.state.memories.find((row) => row.summarizedBy === summary.id);
  await store.restore(member.id);
  assert.equal(summary.memberCount, before - 1, '恢复一条，摘要覆盖数应减一');
  assert.equal(summary.memberIds.includes(member.id), false, '成员 id 也要摘掉');
  const snapshot = store.snapshot();
  assert.equal(snapshot.memories.filter((row) => row.summarizedBy === summary.id).length, summary.memberCount, '快照与摘要声称应一致');
  await rm(dir, { recursive: true, force: true });
});

test('状态条目要出现在快照里（面板「状态」分类不能永远是 0）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'loom-slot-'));
  const store = new MemoryStore({ storePath: join(dir, 'store.json') });
  await store.open();
  await store.write({ kind: 'slot', entity: '记忆海', attr: '形态', text: '侧栏入口 + main 页' });
  await store.write({ kind: 'fact', text: '普通事实一条' });

  const snapshot = store.snapshot();
  const slots = snapshot.memories.filter((row) => row.kind === 'slot');
  assert.equal(slots.length, 1, 'slot 必须出现在 memories 里');
  assert.equal(slots[0].entity, '记忆海');
  assert.equal(slots[0].attr, '形态');
  assert.equal(slots[0].slot, true);
  assert.equal(slots[0].status, 'active');
  // 状态被新值覆盖，不应产生第二条
  await store.write({ kind: 'slot', entity: '记忆海', attr: '形态', text: '改成整页展示' });
  assert.equal(store.snapshot().memories.filter((row) => row.kind === 'slot').length, 1);
  assert.equal(store.snapshot().memories.find((row) => row.kind === 'slot').text, '改成整页展示');
  await rm(dir, { recursive: true, force: true });
});
