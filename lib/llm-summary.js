/**
 * 用宿主模型服务重写摘要（抽取式 → 模型式）。
 *
 * 几条硬规矩，都是从"写路径不能被模型拖住"推出来的：
 *
 * 1. **不在写入路径上调用**：`store` 生成抽取式摘要后只是**通知**这里，写入立刻返回；
 *    这里慢、超时、报错，都不影响那条记忆已经落库、摘要已经能用。
 * 2. **永远有降级**：失败只记一条事件，摘要保持抽取式文本，不改数据。
 * 3. **路由必须显式或可发现**：`@deepseek-ai/dsh-llm` 的 `resolveRoute` 在没有显式
 *    provider/model 时会回落到**当前请求的路由**；但归纳是后台任务，不在请求里，
 *    没有路由可回落。所以要么配置里给死，要么运行时从 `listProviders()/listModels()` 发现。
 * 4. **自己拼流**：不 import `BlockAssembler`（那是宿主的包，`link:` 安装下依赖解析不稳），
 *    直接累加 `text-delta` 分片，二十行的事。
 */

/** 空路由的负缓存时长：隔一分钟允许重新发现，免得配好 provider 后还一直显示"不可用"。 */
const ROUTE_RETRY_MS = 60_000;

/** 归纳用 system prompt：口径写得越死，产出越稳定。 */
export const SUMMARY_SYSTEM = [
  '你是一个记忆归纳器。把同一主题下的一堆短结论压成一条可读的中文摘要。',
  '规则：',
  '- 只写结论本身，不要「用户说」「记录显示」这类转述前缀；',
  '- 保留具体数值、名称、以及「要 A 不要 B」这种取舍；',
  '- 重复的说法合并成一句，不要逐条复述；',
  '- 不超过 120 字，一到三句；',
  '- 材料里没有的内容一律不要编。',
].join('\n');

/**
 * 把一簇的要点拼成模型输入。
 * @param {{topic: string, points: string[], memberCount: number}} payload
 * @returns {string}
 */
export function buildSummaryPrompt(payload) {
  const points = Array.isArray(payload.points) ? payload.points.filter((point) => typeof point === 'string' && point.length > 0) : [];
  const lines = points.map((point, index) => `${index + 1}. ${point}`);
  return [
    `主题：${payload.topic}`,
    `共 ${payload.memberCount ?? points.length} 条同主题记忆，要点如下：`,
    lines.length > 0 ? lines.join('\n') : '（没有可用要点，请按主题概括）',
    '',
    '请输出一条摘要。',
  ].join('\n');
}

/**
 * 建一个归纳器。
 *
 * @param {object} options
 * @param {() => any} options.getLlm 取宿主 llm 服务（可能返回 undefined）
 * @param {() => {provider?: string, model?: string, timeoutMs?: number, maxTokens?: number}} options.getConfig
 * @param {{info?: Function, warn?: Function}} [options.logger]
 * @returns {{available: () => Promise<boolean>, describe: () => string, summarize: (payload: object) => Promise<string>}}
 */
export function createSummarizer(options) {
  const getLlm = options.getLlm;
  const getConfig = options.getConfig;
  const logger = options.logger ?? {};
  /** 发现到的路由缓存；undefined=还没发现，null=发现过但没有（有时效，见 ROUTE_RETRY_MS） */
  let cachedRoute;
  /** 上一次"确实没有路由"的时刻：空结果也要隔一阵重试，配置好 provider 后不能一直卡着 */
  let routeMissAt = 0;

  const llm = () => {
    try {
      const service = getLlm();
      return service ?? null;
    } catch {
      return null;
    }
  };

  /**
   * 跑一次归纳请求，返回正文（可能为空串 —— 空串交给上层决定要不要放大预算重试）。
   *
   * @param {any} service
   * @param {{provider: string, model: string}} route
   * @param {{topic: string, points: string[], memberCount: number}} payload
   * @param {{timeoutMs: number, maxTokens: number}} limits
   * @returns {Promise<string>}
   */
  async function attempt(service, route, payload, limits) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error('归纳超时（' + limits.timeoutMs + 'ms）')), limits.timeoutMs);
    try {
      const call =
        typeof service.prepareCall === 'function'
          ? await service.prepareCall({ provider: route.provider, model: route.model, maxTokens: limits.maxTokens }, controller.signal)
          : { config: { provider: route.provider, model: route.model, maxTokens: limits.maxTokens } };
      let text = '';
      for await (const chunk of service.stream({
        ...call.config,
        messages: [{ role: 'user', content: [{ type: 'text', text: buildSummaryPrompt(payload) }] }],
        system: SUMMARY_SYSTEM,
        purpose: 'memory-loom-summary',
        signal: controller.signal,
      })) {
        if (chunk?.type === 'text-delta' && typeof chunk.text === 'string') text += chunk.text;
        if (chunk?.type === 'finish') {
          // finish.reason 是 { kind } 联合：stop / tool-calls / max-tokens / error / aborted
          const kind = chunk.reason?.kind;
          if (kind === 'error') throw new Error(chunk.reason?.failure?.message ?? '模型调用失败');
          if (kind === 'aborted') throw new Error('归纳被中止');
          if (kind === 'max-tokens' && text.trim().length > 0 && !/[。！？.!?]$/.test(text.trim())) {
            throw new Error('归纳被输出上限截断');
          }
        }
      }
      return text.trim();
    } finally {
      clearTimeout(timer);
    }
  }

  /** 显式配置优先；否则从 provider 目录里发现第一条可用路由。 */
  async function resolveRoute() {
    /**
     * 缓存口径要分清三种情况，混在一起就会永久中毒：
     * - `undefined` = 还没发现过；
     * - 有路由 = 直接用；
     * - `null` = **发现过、确实没有** —— 但这个"没有"有时效，隔一会儿要允许重试。
     *
     * 踩过的坑：`ctx.inject(['llm'])` 是异步的，启动早期任何一次 route() 调用都会在
     * "服务还没注入"时把 `null` 写进缓存，于是之后永远返回不可用 ——
     * 诊断口也看到服务在、provider 在、model 在，就是路由空着（0.65.1 修的就是这个）。
     */
    if (cachedRoute !== undefined && cachedRoute !== null) return cachedRoute;
    if (cachedRoute === null && Date.now() - routeMissAt < ROUTE_RETRY_MS) return null;
    const config = getConfig() ?? {};
    if (typeof config.provider === 'string' && config.provider.length > 0 && typeof config.model === 'string' && config.model.length > 0) {
      cachedRoute = { provider: config.provider, model: config.model, source: 'config' };
      return cachedRoute;
    }
    const service = llm();
    if (service === null || typeof service.listProviders !== 'function') {
      // **不缓存**：这不是"没有路由"，是"现在还问不到"。下次调用要能重新发现。
      return null;
    }
    try {
      const listed = await service.listProviders();
      const providers = Array.isArray(listed) ? listed : [];
      // 官方路由优先：装了多个 provider 时，官方 DeepSeek 比本地代理更稳定、更适合后台任务
      const providerId = (item) => String(typeof item === 'string' ? item : item?.id ?? item?.provider ?? '');
      const ordered = [...providers].sort(
        (left, right) => (providerId(left).includes('deepseek-official') ? 0 : 1) - (providerId(right).includes('deepseek-official') ? 0 : 1),
      );
      for (const provider of ordered) {
        const id = typeof provider === 'string' ? provider : provider?.id ?? provider?.provider;
        if (typeof id !== 'string' || id.length === 0) continue;
        const models = typeof service.listModels === 'function' ? await service.listModels(id) : [];
        const first = Array.isArray(models) && models.length > 0 ? models[0] : null;
        const modelId = typeof first === 'string' ? first : first?.id ?? first?.model;
        if (typeof modelId === 'string' && modelId.length > 0) {
          cachedRoute = { provider: id, model: modelId, source: 'discovered' };
          return cachedRoute;
        }
      }
    } catch (error) {
      logger.warn?.(`memory-loom: 发现模型路由失败：${error instanceof Error ? error.message : String(error)}`);
    }
    // 到这里才是"真的没有"：服务在、列过了、确实挑不出路由。记下时刻，一分钟后再试。
    cachedRoute = null;
    routeMissAt = Date.now();
    return null;
  }

  /** 配置变了要重新发现（面板改 provider/model 时调用）。 */
  function invalidate() {
    cachedRoute = undefined;
    routeMissAt = 0;
  }

  return {
    invalidate,
    /**
     * 当前解析到的路由。消融实验复用它 —— 另起一套路由发现只会多一个会漂的口径。
     * @returns {Promise<{provider: string, model: string, source: string}|null>}
     */
    async route() {
      return resolveRoute();
    },
    async available() {
      return (await resolveRoute()) !== null;
    },
    /** 设置页上显示的一行说明。 */
    describe() {
      if (cachedRoute === undefined) return '模型归纳：待发现';
      if (cachedRoute === null) return '模型归纳：不可用（回落到抽取式）';
      return `模型归纳：${cachedRoute.provider} · ${cachedRoute.model}`;
    },
    /**
     * 归纳一次。成功返回文本；任何失败都抛错，由调用方记事件并保留原摘要。
     * @param {{topic: string, points: string[], memberCount: number}} payload
     * @returns {Promise<string>}
     */
    async summarize(payload) {
      const service = llm();
      if (service === null || typeof service.stream !== 'function') throw new Error('模型服务不可用');
      const route = await resolveRoute();
      if (route === null) throw new Error('没有可用的模型路由');
      const config = getConfig() ?? {};
      const timeoutMs = Number.isFinite(config.timeoutMs) && config.timeoutMs > 0 ? config.timeoutMs : 12_000;
      // 400 太小：deepseek-flash 的 reasoning 也算在 max_tokens 里，预算被思考吃掉时正文会是空的
      const maxTokens = Number.isFinite(config.maxTokens) && config.maxTokens > 0 ? config.maxTokens : 800;

      const first = await attempt(service, route, payload, { timeoutMs, maxTokens });
      if (first.length > 0) return first;
      // 空正文 = 预算被 reasoning 吃掉：放大一次预算再试，仍空才认输
      if (maxTokens < 1600) {
        const retried = await attempt(service, route, payload, { timeoutMs, maxTokens: maxTokens * 2 });
        if (retried.length > 0) return retried;
      }
      throw new Error('模型返回了空文本');
    },
  };
}
