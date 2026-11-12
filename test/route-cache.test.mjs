/**
 * 模型路由发现的回归测试。
 *
 * 这里守的是 0.65.1 修掉的那个坑：`ctx.inject(['llm'])` 是异步的，
 * 启动早期任何一次 route() 调用都发生在"服务还没注入"的时候；
 * 旧代码那时把 `null` 写进缓存，于是之后**永远**返回不可用 ——
 * 而诊断口明明看到服务在、provider 在、model 在。
 *
 * 判据很简单：暂时问不到 ≠ 没有。前者不许留痕。
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { createSummarizer } from '../lib/llm-summary.js';

const sleepingService = {
  async listProviders() {
    return [{ id: 'deepseek-official' }];
  },
  async listModels() {
    return ['deepseek-flash'];
  },
};

test('服务还没注入时问路由：返回 null，但不许污染缓存', async () => {
  let service = null;
  const summarizer = createSummarizer({
    getLlm: () => service,
    getConfig: () => ({}),
  });

  assert.equal(await summarizer.route(), null, '暂时问不到就是 null');
  // 关键：服务到位之后必须能发现，不能被上一句的 null 卡死
  service = sleepingService;
  const route = await summarizer.route();
  assert.notEqual(route, null, '服务注入后必须重新发现，旧代码在这里永久返回 null');
  assert.equal(route.provider, 'deepseek-official');
  assert.equal(route.model, 'deepseek-flash');
  assert.equal(route.source, 'discovered');
});

test('真的没有路由时：记下时刻，隔一阵允许重试', async () => {
  let providers = [];
  let models = [];
  const service = {
    async listProviders() {
      return providers;
    },
    async listModels() {
      return models;
    },
  };
  const summarizer = createSummarizer({ getLlm: () => service, getConfig: () => ({}) });

  assert.equal(await summarizer.route(), null);
  assert.match(summarizer.describe(), /不可用/);

  // 装好 provider 之后立即重问：仍然受负缓存保护（不会变成每个请求都去发现）
  providers = [{ id: 'deepseek-official' }];
  models = ['deepseek-flash'];
  assert.equal(await summarizer.route(), null, '一分钟内沿用"没有"这个结论');

  // 但 invalidate（面板改配置）之后必须立刻能发现
  summarizer.invalidate();
  const route = await summarizer.route();
  assert.notEqual(route, null, 'invalidate 之后要重新发现');
});

test('配置里给了 provider/model 就直接用，不去列 provider', async () => {
  const summarizer = createSummarizer({
    getLlm: () => sleepingService,
    getConfig: () => ({ provider: 'workbuddy', model: 'cn:kimi-k3.1-pro' }),
  });
  const route = await summarizer.route();
  assert.equal(route.source, 'config');
  assert.equal(route.provider, 'workbuddy');
});
