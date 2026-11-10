/**
 * 消融实验：这条记忆到底有没有改变回答。
 *
 * 为什么只有这一种测法站得住：
 * `hits` 数的是"被展示"，不是"有用"；`usedCount` 要求用户在下一句里复述我的
 * 中文二元组，结构上恒为 0；两者都是**相关**，都能被别的东西顶替。
 * 唯一能给出**因果**的是对照：同一个问题问两次，一次带这一条、一次不带它，
 * 看回答变没变。变了，这条至少在这一问上有作用；没变，它在这一问上就是装饰。
 *
 * 三条边界，写在这里不许假装没有：
 * - **近似**：这里只放了「问题 + 注入块」，没有宿主的系统提示、没有工具、没有历史。
 *   所以它回答的是"这条对这个问题有没有可见影响"，不是"真实那一轮它有没有被用上"。
 * - **单条、一次性**：一条一次两次生成，只能按需抽样。做不成全库排行榜 ——
 *   把抽样结果说成统计量，就是 used 那个坑换了个坑口。
 * - **判定靠人**：相似度只用来提示"差得多不多"，不替人下结论。
 */

import { similarity } from './text.js';

/**
 * 实验用的 system：越中性越好。
 * 不让模型知道哪一次带记忆、更不许它复述"因为记忆里说……" —— 那会污染对比。
 */
export const ABLATE_SYSTEM = [
  '你在回答用户的一个问题。',
  '如果给了你一段背景材料，按它来；没给就按常识回答。',
  '正常、简洁地答，不要提"记忆""上下文""材料"这些词。',
].join('\n');

/**
 * 拼一次生成的用户消息。
 *
 * 注入块放在问题**后面**：宿主真实链路里注入也是作为一条附加消息跟在用户话之后，
 * 顺序保持一致，两次生成之间就只剩"有没有这一条"这一个差别。
 *
 * @param {string} question
 * @param {string} injection 注入块全文（可为空串 = 不给记忆）
 * @returns {string}
 */
export function buildAblateText(question, injection) {
  const ask = String(question ?? '').trim();
  const block = String(injection ?? '').trim();
  return block.length === 0 ? ask : `${ask}\n\n${block}`;
}

/**
 * 建一个消融器。
 *
 * @param {object} options
 * @param {() => any} options.getLlm 取宿主 llm 服务
 * @param {() => Promise<{provider: string, model: string}|null>} options.getRoute 取模型路由
 * @param {{info?: Function, warn?: Function}} [options.logger]
 */
export function createAblator(options) {
  const getLlm = options.getLlm;
  const getRoute = options.getRoute;
  const logger = options.logger ?? {};

  /**
   * 跑一次生成。
   * @param {any} service
   * @param {{provider: string, model: string}} route
   * @param {string} text
   * @param {{timeoutMs: number, maxTokens: number}} limits
   * @returns {Promise<string>}
   */
  async function generate(service, route, text, limits) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error(`消融生成超时（${limits.timeoutMs}ms）`)), limits.timeoutMs);
    try {
      const call =
        typeof service.prepareCall === 'function'
          ? await service.prepareCall({ provider: route.provider, model: route.model, maxTokens: limits.maxTokens }, controller.signal)
          : { config: { provider: route.provider, model: route.model, maxTokens: limits.maxTokens } };
      let out = '';
      for await (const chunk of service.stream({
        ...call.config,
        messages: [{ role: 'user', content: [{ type: 'text', text }] }],
        system: ABLATE_SYSTEM,
        purpose: 'memory-loom-ablate',
        signal: controller.signal,
      })) {
        if (chunk?.type === 'text-delta' && typeof chunk.text === 'string') out += chunk.text;
        if (chunk?.type === 'finish') {
          const kind = chunk.reason?.kind;
          if (kind === 'error') throw new Error(chunk.reason?.failure?.message ?? '模型调用失败');
          if (kind === 'aborted') throw new Error('消融被中止');
        }
      }
      return out.trim();
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    async available() {
      return (await getRoute()) !== null;
    },
    /**
     * 跑一次对照。
     *
     * @param {{question: string, withInjection: string, withoutInjection: string, timeoutMs?: number, maxTokens?: number}} input
     * @returns {Promise<{question: string, withMemory: {text: string, chars: number}, withoutMemory: {text: string, chars: number}, similarity: number}>}
     */
    async run(input) {
      const service = getLlm();
      if (service === null || typeof service.stream !== 'function') throw new Error('模型服务不可用');
      const route = await getRoute();
      if (route === null) throw new Error('没有可用的模型路由');
      const question = String(input.question ?? '').trim();
      if (question.length === 0) throw new Error('没有可实验的问题');
      const limits = {
        timeoutMs: Number.isFinite(input.timeoutMs) && input.timeoutMs > 0 ? input.timeoutMs : 30_000,
        maxTokens: Number.isFinite(input.maxTokens) && input.maxTokens > 0 ? input.maxTokens : 900,
      };
      // 顺序跑，不并发：同一时刻只吃一份配额，两次之间也没有别的请求插进来
      const withText = await generate(service, route, buildAblateText(question, input.withInjection), limits);
      const withoutText = await generate(service, route, buildAblateText(question, input.withoutInjection), limits);
      if (withText.length === 0 && withoutText.length === 0) throw new Error('两次生成都是空的，实验没跑成');
      logger.info?.(`memory-loom: 消融跑完（带 ${withText.length} 字 / 不带 ${withoutText.length} 字）`);
      return {
        question,
        withMemory: { text: withText, chars: [...withText].length },
        withoutMemory: { text: withoutText, chars: [...withoutText].length },
        /**
         * 两段回答的相似度（0 = 毫无重合，1 = 一模一样）。
         * 只当提示：写得短、写得长都会影响它，判定还得人读。
         */
        similarity: Number(similarity(withText, withoutText).toFixed(3)),
      };
    },
  };
}
