import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createSummarizer, buildSummaryPrompt, SUMMARY_SYSTEM } from '../lib/llm-summary.js';

/** 造一个假的 llm 服务：按预设返回分片。 */
function fakeLlm({ deltas = ['模型'], finish = { kind: 'stop' }, providers = ['p1'], models = ['m1'], throwOn = null } = {}) {
  const calls = [];
  return {
    calls,
    async listProviders() {
      return providers;
    },
    async listModels() {
      return models;
    },
    async prepareCall(config) {
      calls.push({ kind: 'prepare', config });
      return { config };
    },
    async *stream(options) {
      calls.push({ kind: 'stream', options });
      if (throwOn !== null) throw throwOn;
      for (const text of deltas) yield { type: 'text-delta', index: 0, text };
      yield { type: 'finish', reason: finish };
    },
  };
}

const payload = { id: 's1', topic: '渲染帧率', points: ['降档到 45fps', '关闭光晕'], memberCount: 6 };

test('归纳输入：主题与要点都进 prompt，空的要点不会变成破句子', () => {
  const prompt = buildSummaryPrompt(payload);
  assert.match(prompt, /主题：渲染帧率/);
  assert.match(prompt, /共 6 条/);
  assert.match(prompt, /1\. 降档到 45fps/);
  assert.match(prompt, /2\. 关闭光晕/);
  const empty = buildSummaryPrompt({ topic: '空簇', points: [], memberCount: 0 });
  assert.match(empty, /没有可用要点/);
  assert.ok(SUMMARY_SYSTEM.includes('不要编'));
});

test('归纳：显式配置的路由直接使用，文本按 text-delta 累加', async () => {
  const llm = fakeLlm({ deltas: ['帧率', '不足时', '降档。'] });
  const summarizer = createSummarizer({
    getLlm: () => llm,
    getConfig: () => ({ provider: 'p1', model: 'm1', timeoutMs: 5000, maxTokens: 200 }),
  });
  const text = await summarizer.summarize(payload);
  assert.equal(text, '帧率不足时降档。');
  const stream = llm.calls.find((call) => call.kind === 'stream');
  assert.equal(stream.options.provider, 'p1');
  assert.equal(stream.options.model, 'm1');
  assert.equal(stream.options.purpose, 'memory-loom-summary');
  assert.equal(stream.options.system, SUMMARY_SYSTEM);
  assert.ok(typeof stream.options.signal?.aborted === 'boolean', '必须传中止信号');
});

test('归纳：没配置路由时从 provider 目录发现第一条', async () => {
  const llm = fakeLlm({ deltas: ['ok'] });
  const summarizer = createSummarizer({ getLlm: () => llm, getConfig: () => ({}) });
  assert.equal(await summarizer.summarize(payload), 'ok');
  assert.match(summarizer.describe(), /p1 · m1/);
});

test('归纳：没有服务 / 没有路由 / 空文本 / 非正常终止，都必须抛错而不是返回半句话', async () => {
  const none = createSummarizer({ getLlm: () => null, getConfig: () => ({}) });
  await assert.rejects(() => none.summarize(payload), /模型服务不可用/);

  const noRoute = createSummarizer({ getLlm: () => fakeLlm({ providers: [], models: [] }), getConfig: () => ({}) });
  await assert.rejects(() => noRoute.summarize(payload), /没有可用的模型路由/);

  const empty = createSummarizer({ getLlm: () => fakeLlm({ deltas: [] }), getConfig: () => ({ provider: 'p', model: 'm' }) });
  await assert.rejects(() => empty.summarize(payload), /空文本/);

  const aborted = createSummarizer({
    getLlm: () => fakeLlm({ deltas: ['半句'], finish: { kind: 'aborted' } }),
    getConfig: () => ({ provider: 'p', model: 'm' }),
  });
  await assert.rejects(() => aborted.summarize(payload), /被中止/);

  // 输出被截断且没说完：不写半句话
  const truncated = createSummarizer({
    getLlm: () => fakeLlm({ deltas: ['这是一段没说完的'], finish: { kind: 'max-tokens' } }),
    getConfig: () => ({ provider: 'p', model: 'm' }),
  });
  await assert.rejects(() => truncated.summarize(payload), /输出上限截断/);

  // 截断但正好说完：接受
  const okTruncated = createSummarizer({
    getLlm: () => fakeLlm({ deltas: ['正好说完。'], finish: { kind: 'max-tokens' } }),
    getConfig: () => ({ provider: 'p', model: 'm' }),
  });
  assert.equal(await okTruncated.summarize(payload), '正好说完。');
});

test('归纳：超时会中断，不会挂住调用方', async () => {
  const hanging = {
    async prepareCall(config) {
      return { config };
    },
    async *stream(options) {
      yield { type: 'text-delta', index: 0, text: '开头' };
      // 永远不结束，直到被 abort
      await new Promise((resolve, reject) => {
        options.signal.addEventListener('abort', () => reject(options.signal.reason ?? new Error('aborted')), { once: true });
      });
    },
  };
  const summarizer = createSummarizer({
    getLlm: () => hanging,
    getConfig: () => ({ provider: 'p', model: 'm', timeoutMs: 30 }),
  });
  await assert.rejects(() => summarizer.summarize(payload));
});
