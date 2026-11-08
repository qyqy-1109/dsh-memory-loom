/**
 * 迁移痕迹（语境记录）的回归测试。
 *
 * 这是整套系统里唯一接近「涌现」的读数，所以两件事必须钉死：
 *
 * ① **只记「被检索想起来」的那些**。常驻块（约束/槽位/共同经历）每轮都在，
 *    给它们记语境等于把"语境"定义成"所有话题"，信号永远满格 —— 假信号比没信号更坏。
 * ② **同一个说法不算新语境**。签名排序后比较：词序不同、措辞相同的一次重问，
 *    不该被记成"它又在一个新话题里被想起来了"。
 *
 * 还要认账一件事：它测得到「换了话题也会想起它」，测不到「它改变了判断」。
 * 所以输出只有「候选」，别让读的人把它当结论。
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { MemoryStore } from '../lib/store.js';
import { transferSignal } from '../lib/growth.js';

async function openTempStore(cfg = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'loom-transfer-'));
  const store = new MemoryStore({ storePath: join(dir, 'store.json'), compactAt: 0, ...cfg });
  await store.open();
  return { dir, store };
}

/** 造一份召回现场：只有带分数的命中才算"想起来"。 */
function recallOf(query, hits, list = ['编码', '管道']) {
  return { query, threshold: 0.18, gate: { budget: 3, tokens: list.length, need: 2, list }, hits, blocks: [], size: { chars: 0, blocks: 0, entries: hits.length } };
}

test('语境记录：只有带分数的命中会被记下来（常驻块不记）', async () => {
  const { dir, store } = await openTempStore();
  try {
    const fact = await store.write({ kind: 'fact', text: '用户偏好深空底色。' });
    const constraint = await store.write({ kind: 'constraint', text: '改源码只用 read/write/edit。' });

    await store.recordRecall(
      recallOf('面板 底色', [
        { id: fact.id, kind: 'fact', score: 0.5 },
        { id: constraint.id, kind: 'constraint', score: null },
      ]),
    );

    assert.equal(store.byId(fact.id).contexts.length, 1, '有分数的命中要记语境');
    assert.deepEqual(store.byId(constraint.id).contexts, [], '常驻块每轮都在，谈不上被想起来');
    assert.ok(store.state.events.some((event) => event.kind === 'memory.context'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('语境记录：同一个说法（词序不同）不算新语境', async () => {
  const { dir, store } = await openTempStore();
  try {
    const fact = await store.write({ kind: 'fact', text: '用户偏好深空底色。' });
    await store.recordRecall(recallOf('面板 底色', [{ id: fact.id, kind: 'fact', score: 0.5 }], ['面板', '底色']));
    await store.recordRecall(recallOf('底色 面板', [{ id: fact.id, kind: 'fact', score: 0.5 }], ['底色', '面板']));
    assert.equal(store.byId(fact.id).contexts.length, 1, '同一组词换个顺序不是新话题');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('语境记录：不同话题才加一条，且只留最近几条', async () => {
  const { dir, store } = await openTempStore({ contextCap: 2 });
  try {
    const fact = await store.write({ kind: 'fact', text: '用户偏好深空底色。' });
    for (const tokens of [['面板', '底色'], ['数据库', '连接池'], ['咖啡', '手冲']]) {
      await store.recordRecall(recallOf(tokens.join(' '), [{ id: fact.id, kind: 'fact', score: 0.5 }], tokens));
    }
    const contexts = store.byId(fact.id).contexts;
    assert.equal(contexts.length, 2, '上限是 2 就只留 2 条');
    assert.ok(contexts.at(-1).t.includes('咖啡'), '留下的应该是最新的');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('迁移读数：语境彼此不像才算候选', () => {
  const state = {
    memories: [
      {
        id: 'a',
        kind: 'world',
        text: '卡片阴影一律用两层，不用单层大模糊。',
        createdAt: 1,
        contexts: [
          { t: '面板|星图|密度', at: 1 },
          { t: '导出|接口|超时', at: 2 },
        ],
      },
      {
        id: 'b',
        kind: 'fact',
        text: '用户喜欢手冲。',
        createdAt: 1,
        contexts: [
          { t: '咖啡|手冲|温度', at: 1 },
          { t: '咖啡|手冲|比例', at: 2 },
        ],
      },
      { id: 'c', kind: 'fact', text: '只被想起过一次。', createdAt: 1, contexts: [{ t: '单次|语境', at: 1 }] },
      { id: 'd', kind: 'fact', text: '从没被想起过。', createdAt: 1 },
    ],
  };
  const signal = transferSignal(state);
  assert.equal(signal.tracked, 3, '有语境记录的算 3 条');
  assert.equal(signal.candidates, 2, '在 ≥2 个语境里出现的算 2 条');
  assert.equal(signal.transferred, 1, '只有语境彼此不像的那条才是候选');
  assert.equal(signal.top[0].id, 'a');
  assert.equal(signal.top[0].contexts, 2);
  assert.ok(signal.top[0].spread <= signal.threshold);
});

test('迁移读数：语境完全相同 = 同一个话题，不报候选', () => {
  const state = {
    memories: [
      {
        id: 'a',
        kind: 'fact',
        text: '同一件事被问了两次。',
        createdAt: 1,
        contexts: [
          { t: '面板|底色|深空', at: 1 },
          { t: '面板|底色|深空', at: 2 },
        ],
      },
    ],
  };
  const signal = transferSignal(state);
  assert.equal(signal.candidates, 1);
  assert.equal(signal.transferred, 0, '同一组词的重问不是迁移');
  assert.deepEqual(signal.top, []);
});

test('迁移读数：一条都没有时如实说 0，不编候选', () => {
  const signal = transferSignal({ memories: [{ id: 'a', kind: 'fact', text: '甲', createdAt: 1 }] });
  assert.equal(signal.tracked, 0);
  assert.equal(signal.candidates, 0);
  assert.equal(signal.transferred, 0);
  assert.deepEqual(signal.top, []);
});
