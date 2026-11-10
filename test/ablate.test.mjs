/**
 * 消融实验的回归测试。
 *
 * 这一件最容易做成"看起来测过了"：跑两段文字、并排放、用户点头。
 * 所以测试守的是**可比性**与**别装成统计**：
 * ① 两次生成的唯一差别只能是「有没有这一条」—— 问题与注入块的拼法必须固定；
 * ② 目标没进上下文时不许硬跑两次（那是假对照）；
 * ③ 一次只能测一条，结果不落库、不进任何读数。
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createAblator, buildAblateText, ABLATE_SYSTEM } from '../lib/ablate.js';
import { MemoryStore } from '../lib/store.js';

/** 假 llm：按输入里有没有注入块决定回什么，好验证两次调用确实只差那一块。 */
function fakeLlm(reply, options = {}) {
  const calls = [];
  return {
    calls,
    async prepareCall(config) {
      calls.push({ kind: 'prepare', config });
      return { config };
    },
    async *stream(request) {
      calls.push({ kind: 'stream', request });
      if (options.throwOn !== undefined) throw options.throwOn;
      const text = request?.messages?.[0]?.content?.[0]?.text ?? '';
      for (const piece of reply(text)) yield { type: 'text-delta', index: 0, text: piece };
      yield { type: 'finish', reason: options.finish ?? { kind: 'stop' } };
    },
  };
}

const route = async () => ({ provider: 'p1', model: 'm1' });

test('拼输入：问题在前、注入块在后；没有注入时只有问题', () => {
  assert.equal(buildAblateText('怎么排顺序', ''), '怎么排顺序');
  assert.equal(buildAblateText('  怎么排顺序  ', '  '), '怎么排顺序');
  const withBlock = buildAblateText('怎么排顺序', '<memory-loom>块</memory-loom>');
  assert.equal(withBlock, '怎么排顺序\n\n<memory-loom>块</memory-loom>');
  assert.ok(withBlock.indexOf('怎么排顺序') < withBlock.indexOf('<memory-loom>'), '问题必须在前面，注入跟在后面');
});

test('消融：跑两次，两次之间只差注入块；结果给出字数与相似度', async () => {
  const llm = fakeLlm((text) => (text.includes('<memory-loom>') ? ['带这一条的回答'] : ['不带这一条的回答']));
  const ablator = createAblator({ getLlm: () => llm, getRoute: route });
  const result = await ablator.run({
    question: '这条路该怎么走',
    withInjection: '<memory-loom>某条记忆</memory-loom>',
    withoutInjection: '',
  });

  assert.equal(result.withMemory.text, '带这一条的回答');
  assert.equal(result.withoutMemory.text, '不带这一条的回答');
  assert.equal(result.withMemory.chars, [...'带这一条的回答'].length);
  assert.equal(result.withoutMemory.chars, [...'不带这一条的回答'].length);
  assert.equal(result.question, '这条路该怎么走');
  assert.ok(result.similarity > 0 && result.similarity <= 1, '相似度要在 0~1 之间');

  const streams = llm.calls.filter((call) => call.kind === 'stream');
  assert.equal(streams.length, 2, '正好两次生成');
  assert.equal(streams[0].request.purpose, 'memory-loom-ablate');
  assert.equal(streams[0].request.system, ABLATE_SYSTEM);
  assert.equal(streams[0].request.provider, 'p1');
  assert.equal(streams[0].request.messages.length, 1, '一次只发一条用户消息，免得两次的差别不止一处');
});

test('消融：没服务 / 没路由 / 没问句 / 两次都空，都必须抛错而不是给半截结果', async () => {
  const noService = createAblator({ getLlm: () => null, getRoute: route });
  await assert.rejects(() => noService.run({ question: '问', withInjection: '', withoutInjection: '' }), /模型服务不可用/);

  const noRoute = createAblator({ getLlm: () => fakeLlm(() => ['x']), getRoute: async () => null });
  await assert.rejects(() => noRoute.run({ question: '问', withInjection: '', withoutInjection: '' }), /没有可用的模型路由/);

  const emptyQuestion = createAblator({ getLlm: () => fakeLlm(() => ['x']), getRoute: route });
  await assert.rejects(() => emptyQuestion.run({ question: '   ', withInjection: '', withoutInjection: '' }), /没有可实验的问题/);

  const bothEmpty = createAblator({ getLlm: () => fakeLlm(() => []), getRoute: route });
  await assert.rejects(() => bothEmpty.run({ question: '问', withInjection: '', withoutInjection: '' }), /两次生成都是空的/);
});

test('消融：模型中途报错时整次失败，不返回一段真一段假', async () => {
  const failing = createAblator({
    getLlm: () => fakeLlm(() => ['半段'], { finish: { kind: 'error', failure: { message: '额度用完了' } } }),
    getRoute: route,
  });
  await assert.rejects(() => failing.run({ question: '问', withInjection: 'a', withoutInjection: '' }), /额度用完了/);
});

test('召回：excludeIds 只摘掉指定那一条，别的块不动', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'loom-ablate-recall-'));
  try {
    const store = new MemoryStore({ storePath: join(dir, 'store.json'), compactAt: 0 });
    await store.open();
    const targetText = '消融实验要把这一条摘掉';
    const otherText = '消融实验里另一条不该被摘掉的';
    const target = await store.write({ kind: 'fact', text: targetText });
    const other = await store.write({ kind: 'world', text: otherText });
    // 两条原文一起当查询：确保这一问里它们都真的被召回到，才谈得上"摘掉一条再看"
    const query = `${targetText}\n${otherText}`;

    const full = store.buildRecall(query);
    const idsOf = (snap) => snap.blocks.flatMap((block) => block.ids ?? []);
    assert.ok(idsOf(full).includes(target.id), '没摘的时候它应该在');
    assert.ok(idsOf(full).includes(other.id), '另一条也应该在');

    const cut = store.buildRecall(query, { excludeIds: [target.id] });
    assert.ok(!idsOf(cut).includes(target.id), '摘掉的那条不许再出现');
    assert.ok(idsOf(cut).includes(other.id), '别的记忆不受影响');
    assert.ok(
      cut.blocks.every((block) => block.text.length > 0),
      '摘完不能留下空块（空块会把"没有"说成"有"）',
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
