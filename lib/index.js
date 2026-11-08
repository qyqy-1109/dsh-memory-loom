/**
 * dsh-memory-loom —— host 半边。
 *
 * 职责（唯一）：把「跨会话记忆」这件事的读写口径固定下来，并把它暴露成
 * 模型可调用的工具 + 每轮自动注入的运行时上下文 + 面板可读取的 HTTP 快照。
 *
 * 分工边界：
 * - 存储与治理在 `store.js`（纯逻辑，可离线单测）；
 * - 健康灯在 `health.js`（纯函数）；
 * - 这里只做接线：工具、system prompt、pre-step 注入、HTTP 路由、清理。
 *
 * 零第三方依赖：工具定义走 `ctx.tools.register()` 接受的原生 JSON Schema 子集，
 * 不 import `@deepseek-ai/dsh-tools`，插件因此可以在完全离线的机器上安装。
 *
 * @module dsh-memory-loom
 */

import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { appendFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { MemoryStore, DEFAULTS, KINDS, TUNABLE, TUNABLE_TEXT } from './store.js';
import { isUsed } from './usage.js';
import { computeHealth } from './health.js';
import { createSummarizer } from './llm-summary.js';
import { classifyExplicit, classifyDecision, looksLikeChange } from './text.js';

/**
 * 宿主侧版本号（随 API 一起返回给面板）。
 *
 * 为什么需要：前端刷新只换 client bundle，插件的**路由**要重启 DSH 才生效 ——
 * 版本不一致时按钮点下去就是一个裸的 HTTP 404，用户只会以为插件坏了。
 * 有了这个字段，面板能直接说清「宿主还是旧版本，重启 DSH」。
 */
const SERVER_VERSION = (() => {
  try {
    return createRequire(import.meta.url)('../package.json').version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
})();

/** Cordis 插件名（loader 诊断用）。 */
export const name = 'memory-loom';

/**
 * 连续多轮没有写入时的提醒节奏。
 * 教训：一次长设计会话里改了十几版，却没有人调用 memory_write，
 * 整段决策都没落库 —— 光靠"模型会自觉"不可靠。
 */
const NUDGE_AFTER_TURNS = 6;
const NUDGE_EVERY = 4;
export function shouldNudge(turns) {
  return turns >= NUDGE_AFTER_TURNS && (turns - NUDGE_AFTER_TURNS) % NUDGE_EVERY === 0;
}

/** 必需 service：工具注册表与 system prompt 注册表。 */
export const inject = ['tools', 'systemPrompt'];

/** 注入块在 prompt 里的节名。 */
const INJECT_SECTION = 'memory-loom';

/**
 * 注入消息的 `source.kind`。
 *
 * 会话格式 v4 起不再接受 V3 的 `{ kind: 'plugin', plugin: <包名> }` 包装：每条消息的
 * source 必须带「生产者自有」的 kind，否则写日志时直接抛
 * `format v4 message requires a producer-owned source kind`（整个会话都存不下去）。
 * 第三方插件的生产者 kind 约定是 `plugin:<包名>`，与 v3→v4 迁移器
 * `producerKind()` 对未知插件的兜底规则一致。
 */
export const SOURCE_KIND = 'plugin:dsh-memory-loom';

/** 判断一条消息是不是插件注入的上下文（不是用户原话）。 */
function isInjectedContext(message) {
  const source = message?.source;
  if (source === null || typeof source !== 'object') return false;
  if (source.kind === SOURCE_KIND) return true;
  // 兼容旧形状：V3 的通用插件包装（v4 下写不进日志，但内存/旧日志回放里还会出现）。
  return source.kind === 'plugin';
}

/** 插件声明的默认值（没有 Config schema，config 直接按字段覆盖）。 */
export const pluginDefaults = {
  ...DEFAULTS,
  /** 是否每轮自动注入召回上下文。 */
  injectRecall: true,
  /** 是否从用户原话里抓「记住…」这类显式记忆请求。 */
  autoCapture: true,
  /** 是否用模型重写摘要（关闭则一直用抽取式） */
  useLlmSummary: true,
  /** 归纳用的模型路由；两者都留空则从 listProviders/listModels 发现 */
  summaryProvider: '',
  summaryModel: '',
  /** 单次归纳超时（毫秒）与输出上限 */
  summaryTimeoutMs: 12_000,
  summaryMaxTokens: 400,
  /** 待归纳队列长度上限：满了丢最老的，不能无限堆 */
  summaryQueueLimit: 8,
  /** storePath 留空时落在这里：$DSH_HOME/memory-loom/store.json */
  storePath: '',
};

/** 解析 store 路径：显式配置优先，否则 $DSH_HOME/memory-loom/store.json。 */
export function resolveStorePath(config) {
  if (typeof config?.storePath === 'string' && config.storePath.trim().length > 0) return config.storePath.trim();
  const home = process.env.DSH_HOME ?? join(homedir(), '.dsh');
  return join(home, 'memory-loom', 'store.json');
}

/** 把 config 收成一份完整配置（缺字段回落到默认值，非法值不静默改写类型）。 */
function resolveConfig(config) {
  const merged = { ...pluginDefaults, ...(config ?? {}) };
  merged.storePath = resolveStorePath(merged);
  return merged;
}

/**
 * 宿主每轮追加的运行时样板（工作目录、文件策略、时间戳…）。
 *
 * 它**不是**用户说的话，但它不是插件注入（`isInjectedContext` 挡不住），会跟用户消息
 * 一起进 `decision.messages`。原样拿去检索的后果是每次召回都被「记忆 / 文件 / 路径 /
 * 当前 / 目录」这些样板词带偏 —— 实测 recall.last.query 里整段 runtime context 都在。
 */
const HOST_BOILERPLATE_LINES = [
  /^current runtime context/i,
  /^current working directory:/i,
  /^current dsh file policy:/i,
  /^approval prompts are disabled/i,
  /^current deepseek harness/i,
  /^browser time zone for this request:/i,
  /^time sampled while preparing/i,
  /^elapsed since the preceding model-visible message:/i,
  /^以下是跨会话记忆，自动注入，仅供参考：/,
  /^-\s*(与用户当前说法冲突时|不要向用户汇报|标注「弱相关」的条目)/,
];

/**
 * 去掉宿主样板与（万一回灌进来的）上一轮记忆块，只留用户真正说的话。
 * 全被剥干净时返回空串 —— 空查询比"用样板词去检索"诚实。
 *
 * @param {string} text
 * @returns {string}
 */
export function stripHostBoilerplate(text) {
  const raw = String(text ?? '');
  if (raw.length === 0) return '';
  const withoutBlock = raw.replace(/<memory-loom>[\s\S]*?<\/memory-loom>/g, '\n');
  return withoutBlock
    .split(/\r?\n/)
    .filter((line) => !HOST_BOILERPLATE_LINES.some((pattern) => pattern.test(line.trim())))
    .join('\n')
    .trim();
}

/** 从一轮的待发送消息里取用户原话（跳过插件自己注入的上下文与宿主运行时样板）。 */
export function extractUserText(messages) {
  if (!Array.isArray(messages)) return '';
  const parts = [];
  for (const message of messages) {
    if (message === null || typeof message !== 'object') continue;
    if (message.role !== 'user') continue;
    if (isInjectedContext(message)) continue;
    const content = Array.isArray(message.content) ? message.content : [];
    for (const part of content) {
      if (part !== null && typeof part === 'object' && part.type === 'text' && typeof part.text === 'string') parts.push(part.text);
    }
  }
  return stripHostBoilerplate(parts.join('\n'));
}

/** 指代 / 承接式的开头：这种消息离开上文根本没法召回。 */
const ANAPHORA_HINTS = /^(那|这|它|上面|刚才|前面|继续|接着|然后|再|还|所以|因此|就按|按刚才)/;

/**
 * 这条消息要不要借上一条用户消息来召回。
 *
 * 判据故意保守：只有「短于一句话」或「开头就是指代」才借，
 * 长句本身信息足够，混进上一条只会把查询稀释。
 *
 * @param {string} text
 * @returns {boolean}
 */
export function needsRecallContext(text) {
  const raw = String(text ?? '').trim();
  if (raw.length === 0) return false;
  if ([...raw].length <= 12) return true;
  return ANAPHORA_HINTS.test(raw);
}

/**
 * 拼召回查询：短句/指代句带上上一条用户消息的尾巴。
 *
 * @param {string} text 当前消息
 * @param {string} previous 上一条用户消息
 * @returns {string}
 */
export function composeRecallQuery(text, previous) {
  const current = String(text ?? '').trim();
  const prev = String(previous ?? '').trim();
  if (current.length === 0 || prev.length === 0) return current;
  if (!needsRecallContext(current)) return current;
  // 取尾巴：真正被追问的东西通常就在上一句的末尾
  return `${current}\n${[...prev].slice(-120).join('')}`;
}

/** 构造一条插件注入的 user 消息（形状与 `createUserMessage` 一致，避免引入运行时依赖）。 */
function memoryMessage(text) {
  return {
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text }],
    // v4 要求生产者自有的 kind：用 `plugin:<包名>`，不再带 V3 的 `plugin` 字段。
    source: {
      kind: SOURCE_KIND,
      form: 'snapshot',
      sections: [{ name: INJECT_SECTION, text }],
    },
  };
}

/** 把召回快照渲染成注入文本。 */
const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

/**
 * 「今天几号」这一行。
 *
 * 注入块里有「记于 N 天前」，却没有基准日 —— 模型遇到「三天前说的那个」只能猜。
 * 这一行就是那个基准，成本一行，收益是时间类问题不再瞎推。
 *
 * @param {number} [now]
 * @returns {string}
 */
export function todayLine(now = Date.now()) {
  const date = new Date(now);
  const pad = (value) => String(value).padStart(2, '0');
  const day = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  return `- 今天：${day}（${WEEKDAYS[date.getDay()]}，本地时区）；下文「记于 N 天前」都以这天为基准。`;
}

export function renderInjection(snapshot, now = Date.now()) {
  const head = [
    '<memory-loom>',
    '以下是跨会话记忆，自动注入，仅供参考：',
    '- 与用户当前说法冲突时，以用户当前说法为准；',
    '- 不要向用户汇报「我查了记忆」这件事，直接把内容当作你本来就记得的；',
    '- 标注「弱相关」的条目只是可能相关，不要当成确定事实。',
    todayLine(now),
  ];
  const body = snapshot.blocks.map((block) => `${block.title}\n${block.text}`);
  return [...head, '', ...body, '</memory-loom>'].join('\n');
}

/** 工具描述里反复出现的口径，集中一处，避免两份描述漂移。 */
const WRITE_DESCRIPTION = [
  '把一条值得长期记住的信息写进跨会话记忆。**只在有长期价值时调用**：用户陈述的稳定事实（身份、住处、工作、关系、偏好、硬性约束）、',
  '双方共同经历过的具体事件、或她自己经历过的关键事件。不要写：一次性的临时指令、可以随时重新计算的中间结果、代码/文件内容、',
  '你刚刚生成的回答摘要。一次写一条，短句陈述，不写「用户说……」这种转述包装。',
  'kind 取值：`fact`（关于用户的事实）、`world`（双方共享世界的长期设定）、`constraint`（必须遵守的硬性约束，每轮无条件注入）、',
  '`episode`（已经发生的共同经历，需带 scene / significance）、`self`（她自己经历的事，第一人称）、`slot`（当下状态，entity+attr+text 三键）。',
  '关于 `self`：记的是**你自己**的判断、失误和工作方式（「我曾误判 X，实际是 Y」「我习惯先实测再改」），用第一人称；把用户的经历写成 self 是错的。',
  '关于 `slot`：只存"当下会变的状态"（当前在做的事、此刻的心情、正在用的版本），用 entity+attr+text 三键，同一个 entity+attr 写第二次会覆盖旧值。',
  '如果这条信息**取代**了旧记忆（例如搬家、换工作、戒掉某事），把旧条目 id 放进 `supersedes`：旧条目会被软删归档，记忆不会自相矛盾。',
  '记忆库有容量上限：重复写入近似内容只会累加命中数，不会产生第二条。',
].join('');

/**
 * 注册工具、prompt 段落、pre-step 注入与 HTTP 路由。
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {object} config 插件 config（config 层整段替换，缺字段回落默认值）
 */
export function apply(ctx, config) {
  const cfg = resolveConfig(config);
  const store = new MemoryStore(cfg);
  const ready = store.open().catch((error) => {
    ctx.logger?.warn?.(`memory-loom: 记忆库打开失败：${error instanceof Error ? error.message : String(error)}`);
    return store;
  });

  // ── 模型归纳：可选能力，没有 llm 服务时整段不生效 ──
  /** 宿主的 llm 服务（可选注入，拿不到就是 null） */
  let llmService = null;
  ctx.inject(['llm'], (child) => {
    llmService = child.llm;
    return () => {
      llmService = null;
    };
  });

  const summarizer = createSummarizer({
    getLlm: () => llmService,
    getConfig: () => ({
      provider: cfg.summaryProvider,
      model: cfg.summaryModel,
      timeoutMs: cfg.summaryTimeoutMs,
      maxTokens: cfg.summaryMaxTokens,
    }),
    logger: ctx.logger,
  });

  // 预热一次路由发现：否则设置页会一直显示"待发现"，直到第一次归纳才解析出来
  void summarizer.available().catch(() => {});

  /** 待归纳队列：同一时刻只跑一个，避免并发打爆模型配额 */
  const summaryQueue = [];
  let summarizing = false;
  let disposed = false;

  async function drainSummaries() {
    if (summarizing || disposed) return;
    summarizing = true;
    try {
      while (summaryQueue.length > 0 && !disposed) {
        const job = summaryQueue.shift();
        try {
          const rewritten = await summarizer.summarize(job.payload);
          await store.rewriteSummary(job.payload.id, rewritten);
          ctx.logger?.info?.('memory-loom: 摘要已用模型重写（' + job.payload.topic + '）');
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          // 失败只留痕：摘要保持抽取式文本，用户看到的内容不会变差
          await store.markSummaryFailure(job.payload.id, message).catch(() => {});
          ctx.logger?.warn?.('memory-loom: 模型归纳失败，保留抽取式（' + message + '）');
        }
      }
    } finally {
      summarizing = false;
    }
  }

  /**
   * store 生成的摘要是"已经能用"的抽取式版本；这里只是**排队**用模型重写。
   * 这个函数同步返回 —— 写入路径绝不等待模型。
   */
  store.setSummaryEnhancer((payload) => {
    if (cfg.useLlmSummary !== true) return;
    const limit = Number.isFinite(cfg.summaryQueueLimit) ? cfg.summaryQueueLimit : 8;
    summaryQueue.push({ payload });
    while (summaryQueue.length > Math.max(1, limit)) summaryQueue.shift();
    void drainSummaries();
  });

  ctx.effect(
    () => () => {
      disposed = true;
      summaryQueue.length = 0;
    },
    'memory-loom: 停止待归纳队列',
  );

  /** 统一等待 store 就绪，并把加载错误留在 store.loadError 里（健康灯会显示 degraded）。 */
  const opened = async () => {
    await ready;
    if (store.loadError === null && !store.opened) await store.open();
    return store;
  };

  // ── system prompt：告诉模型这套记忆怎么用（语气与「旧识」一致：给口径，不给话术） ──
  const policy = [
    '## 跨会话记忆（memory-loom）',
    '你有一个跨会话记忆库，它在新会话里依然存在。规矩：',
    '1. 用户说出稳定事实、偏好、硬性约束、共同经历时，**主动**调用 `memory_write` 落库；不要等用户说「记住」。',
    '2. 用户明确说「记住…/别忘了…/以后都…」时，这句话必须落库（按原话，不要改写取舍）。',
    '3. 信息取代旧记忆时（搬家、换工作、戒掉某事…），先 `memory_search` 找到旧条目，再在 `memory_write` 里用 `supersedes` 指认它。',
    '4. 需要回忆细节时用 `memory_search`；每轮会自动注入约束、状态、共同经历与相关旧事，不必重复检索。',
    '5. 写入是一次短句陈述；不要把整段对话、代码或你的推理写进去。',
    '6. **对成品的取舍也是稳定偏好**：用户说「太丑了」「不要 X」「就要这个」「换回 Y」时，把定下的形态/风格/位置写成 fact；反复改过之后定稿的形态，用 supersedes 覆盖旧的形态记录，别让旧结论继续生效。',
    '7. 用户明确纠正过的做法（例如「别再用 PowerShell 回写文件」）写成 constraint，下一轮就会自动生效。',
    '8. 问「今天/昨天/最近做了什么」这类**时间问题**时，用 memory_search 只传 since/until 按时间线取；不要调宿主的会话检索（大会话日志上会 30 秒超时），也不要靠猜。',
  ].join('\n');
  // `section()` 自己就返回绑定在本 ctx 上的 effect disposer —— 再包一层 ctx.effect
  // 会把注入上下文换掉（实测报 "cannot get property systemPrompt without inject"）。
  ctx.systemPrompt.section({ name: 'memory-loom:policy', order: 420, text: policy });

  /** 每次成功写入就 +1：用来判断"这轮到底写没写" */
  let writeSeq = 0;
  /** 每个会话的轮数 / 已见到的写入序号 */
  const sessionProgress = new Map();
  /** 每个会话上一条用户原始消息（追问召回用） */
  const lastUserText = new Map();
  /** 打过 pre-step 消息结构诊断的会话（每会话一次，避免刷屏） */
  const seenRoles = new Set();
  /**
   * 上一轮注入了什么（用于"使用信号"验收）。
   *
   * 存的是**指纹词**而不是 id 列表就完事：判定发生在下一轮，那时语料已经变了
   * （新写入会改 df），指纹必须当场定下来，否则永远对不上。
   */
  const lastInjection = new Map();

  // ── 工具 ──
  ctx.tools.register({
    name: 'memory_write',
    description: WRITE_DESCRIPTION,
    parameters: {
      // 单条（kind+text）或一次多条（entries）二选一。
      // 长会话里经常一口气定下好几条结论，逐条调用太贵也容易漏。
      oneOf: [
        {
          type: 'object',
          additionalProperties: false,
          required: ['kind', 'text'],
          properties: {
          kind: { type: 'string', enum: [...KINDS], description: 'fact | world | constraint | episode | self | slot' },
          text: { type: 'string', description: '要记住的内容，一句短陈述（slot 时是 value）。不超过 200 字。' },
          entity: { type: 'string', description: '仅 kind=slot：状态主体，如「猫」「我」。' },
          attr: { type: 'string', description: '仅 kind=slot：状态属性，如「所在地」「心情」。' },
          scene: { type: 'string', description: '仅 kind=episode：发生场景（一句话）。' },
          significance: { type: 'integer', description: '仅 kind=episode：1-5 的重要度。' },
          eventDate: { type: 'string', description: '事件发生的日期 YYYY-MM-DD；不确定就不要传。' },
          supersedes: { type: 'array', items: { type: 'string' }, description: '被这条新信息取代的旧记忆 id（先用 memory_search 查到）。' },
          },
        },
        {
          type: 'object',
          additionalProperties: false,
          required: ['entries'],
          properties: {
            entries: {
              type: 'array',
              description: '一次写多条（最多 20 条），每条结构与单条相同，可各自带 supersedes。',
              items: {
                type: 'object',
                additionalProperties: false,
                required: ['kind', 'text'],
                properties: {
                  kind: { type: 'string', enum: [...KINDS], description: 'fact | world | constraint | episode | self | slot' },
                  text: { type: 'string', description: '要记住的内容，一句短陈述（slot 时是 value）。不超过 200 字。' },
                  entity: { type: 'string', description: '仅 kind=slot：状态主体，如「猫」「我」。' },
                  attr: { type: 'string', description: '仅 kind=slot：状态属性，如「所在地」「心情」。' },
                  scene: { type: 'string', description: '仅 kind=episode：发生场景（一句话）。' },
                  significance: { type: 'integer', description: '仅 kind=episode：1-5 的重要度。' },
                  eventDate: { type: 'string', description: '事件发生的日期 YYYY-MM-DD；不确定就不要传。' },
                  supersedes: { type: 'array', items: { type: 'string' }, description: '被这条新信息取代的旧记忆 id（先用 memory_search 查到）。' },
                },
              },
            },
          },
        },
      ],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['notes'],
        properties: {
          id: { type: 'string' },
          kind: { type: 'string' },
          status: { type: 'string' },
          notes: { type: 'array', items: { type: 'string' } },
          archived: { type: 'array', items: { type: 'string' } },
          relaxed: { type: 'array', items: { type: 'string' } },
          entries: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string' },
                kind: { type: 'string' },
                status: { type: 'string' },
              },
            },
          },
        },
      },
      render: (_args, value) => {
        if (Array.isArray(value.entries) && value.entries.length > 0) {
          const lines = value.entries.map((entry) =>
            entry.status === 'deduped' ? `- 重复，已累加命中：${entry.id}（${entry.kind}）` : `- 已写入：${entry.id}（${entry.kind}）`,
          );
          const notes = Array.isArray(value.notes) && value.notes.length > 0 ? `\n${value.notes.map((note) => `- ${note}`).join('\n')}` : '';
          return [{ type: 'text', text: `一次写入 ${value.entries.length} 条：\n${lines.join('\n')}${notes}` }];
        }
        const head =
          value.status === 'deduped'
            ? `未新建：与已有记忆重复（id ${value.id}），已累加命中。`
            : `已写入记忆 ${value.id}（${value.kind}）。`;
        const notes = Array.isArray(value.notes) && value.notes.length > 0 ? `\n${value.notes.map((note) => `- ${note}`).join('\n')}` : '';
        return [{ type: 'text', text: `${head}${notes}` }];
      },
    },
    async execute(args, exec) {
      const memory = await opened();
      const sessionId = exec?.agent?.session?.id ?? null;
      if (Array.isArray(args.entries) && args.entries.length > 0) {
        const batch = args.entries.slice(0, 20).map((entry) => ({ ...entry, sessionId, source: 'tool' }));
        // 一次 writeMany：治理逻辑不变，但只原子落盘一次（20 条 81ms → 6.6ms）
        const results = await memory.writeMany(batch);
        const entries = results.map((result) => ({ id: result.id ?? '', kind: result.kind, status: result.status }));
        const notes = results.flatMap((result, index) =>
          Array.isArray(result.notes) ? result.notes.map((note) => `${(batch[index].text ?? '').slice(0, 12)}… ${note}`) : [],
        );
        writeSeq += entries.length;
        return { entries, notes };
      }
      const result = await memory.write({
        ...args,
        sessionId,
        source: 'tool',
      });
      writeSeq += 1;
      return {
        id: result.id ?? '',
        kind: result.kind,
        status: result.status,
        notes: result.notes,
        archived: result.archived,
        relaxed: result.relaxed,
      };
    },
  });

  ctx.tools.register({
    name: 'memory_search',
    description:
      '在跨会话记忆库里检索。两种用法：① 传 query 按语义相近程度检索（回忆细节、写入前查旧条目 id）；' +
      '② 只传 since/until 按时间线列出这段时间写的记忆 —— 回答「今天/昨天/最近做了什么」用这种，不要用宿主的会话检索（大会话日志上会超时）。' +
      '结果带分数与「弱相关」标记，可能同时包含原始记忆、归纳后的摘要（kind=summary）与已归档条目（archived=true）；' +
      '没有命中会明确说没有，不要凭空编造记忆内容。',
    parameters: {
      oneOf: [
        {
          type: 'object',
          additionalProperties: false,
          required: ['query'],
          properties: {
            query: { type: 'string', description: '要回忆的内容，用自然语言描述；只查时间线时可以留空。' },
            since: { type: 'string', description: '起始时间：ISO 日期（2026-11-06）或带时间的 ISO 字符串；也接受毫秒时间戳。' },
            until: { type: 'string', description: '结束时间，规则同 since；不传表示到现在。' },
            kinds: {
              type: 'array',
              items: { type: 'string', enum: [...KINDS] },
              description: '限定种类；不传则检索全部。',
            },
            includeArchived: {
              type: 'boolean',
              description: '是否包含已归档（被压缩进摘要、或手动归档）的条目，默认 true。被取代的旧结论永远不返回。',
            },
            limit: { type: 'integer', description: '最多返回多少条，默认 8。' },
          },
        },
        {
          type: 'object',
          additionalProperties: false,
          required: ['since'],
          properties: {
            query: { type: 'string', description: '要回忆的内容，用自然语言描述；只查时间线时可以留空。' },
            since: { type: 'string', description: '起始时间：ISO 日期（2026-11-06）或带时间的 ISO 字符串；也接受毫秒时间戳。' },
            until: { type: 'string', description: '结束时间，规则同 since；不传表示到现在。' },
            kinds: {
              type: 'array',
              items: { type: 'string', enum: [...KINDS] },
              description: '限定种类；不传则检索全部。',
            },
            includeArchived: {
              type: 'boolean',
              description: '是否包含已归档（被压缩进摘要、或手动归档）的条目，默认 true。被取代的旧结论永远不返回。',
            },
            limit: { type: 'integer', description: '最多返回多少条，默认 8。' },
          },
        },
      ],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['results'],
        properties: {
          results: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['id', 'kind', 'text', 'score', 'weak'],
              properties: {
                createdAt: { type: 'number' },
                archived: { type: 'boolean', description: '是否已归档（内容仍然有效，只是不再进入自动召回）' },
                topic: { type: 'string', description: '仅摘要：归纳的主题词。' },
                members: { type: 'integer', description: '仅摘要：这条摘要覆盖了多少条原始记忆。' },
                id: { type: 'string' },
                kind: { type: 'string' },
                text: { type: 'string' },
                score: { type: 'number' },
                weak: { type: 'boolean' },
                hits: { type: 'integer' },
                eventDate: { type: 'string' },
              },
            },
          },
        },
      },
      render: (_args, value) => {
        if (value.results.length === 0) return [{ type: 'text', text: '记忆库里没有命中。' }];
        const lines = value.results.map(
          (row) => `- [${row.id}] (${row.kind}, ${row.score}${row.weak ? ', 弱相关' : ''}) ${row.text}`,
        );
        return [{ type: 'text', text: `命中 ${value.results.length} 条：\n${lines.join('\n')}` }];
      },
    },
    async execute(args) {
      const memory = await opened();
      const parseTime = (value, endOfDay) => {
        if (value === undefined || value === null || String(value).trim() === '') return null;
        const raw = String(value).trim();
        if (/^\d+$/.test(raw)) return Number(raw);
        const stamp = Date.parse(raw);
        if (!Number.isFinite(stamp)) return null;
        // 只给了日期（没有时间）时，结束时间按当天 23:59:59.999 算
        return endOfDay && /^\d{4}-\d{2}-\d{2}$/.test(raw) ? stamp + 86_399_999 : stamp;
      };
      const results = memory.search(args.query ?? '', {
        kinds: args.kinds,
        limit: args.limit ?? 8,
        since: parseTime(args.since, false),
        until: parseTime(args.until, true),
        // 默认把归档也搜进来：压缩过的细节只在归档里，找不到就等于丢了
        includeArchived: args.includeArchived !== false,
      });
      return {
        results: results.map((row) => ({
          id: row.id,
          kind: row.kind,
          text: row.text,
          score: row.score,
          weak: row.weak,
          hits: row.hits,
          eventDate: row.eventDate ?? '',
          createdAt: row.createdAt ?? 0,
          archived: row.archived === true,
          ...(row.kind === 'summary' ? { topic: row.topic ?? '', members: row.members ?? 0 } : null),
        })),
      };
    },
  });

  ctx.tools.register({
    name: 'memory_forget',
    description:
      '忘掉一条记忆。默认软删归档（可追溯，面板里还能看到并恢复线索）；只有用户明确要求「彻底删掉」时才传 hard=true 物理删除。' +
      'id 用 memory_search 查到；不要凭记忆猜 id。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['id'],
      properties: {
        id: { type: 'string', description: '要遗忘的记忆 id。' },
        hard: { type: 'boolean', description: 'true = 物理删除，不可恢复。' },
        reason: { type: 'string', description: '为什么忘掉，写进归档理由。' },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['found', 'hard', 'id'],
        properties: {
          found: { type: 'boolean' },
          hard: { type: 'boolean' },
          id: { type: 'string' },
        },
      },
      render: (_args, value) => [
        {
          type: 'text',
          text: value.found
            ? value.hard
              ? `已物理删除 ${value.id}。`
              : `已归档 ${value.id}（软删，可追溯）。`
            : `没有找到 id ${value.id}，未做任何改动。`,
        },
      ],
    },
    async execute(args) {
      const memory = await opened();
      const result = await memory.forget(args.id, { reason: args.reason ?? 'tool', hard: args.hard === true });
      return { found: result.found, hard: result.hard, id: String(args.id) };
    },
  });

  ctx.tools.register({
    name: 'memory_restore',
    description:
      '恢复被归档的记忆：传 id 恢复单条，传 summaryId 撤销整条摘要（恢复它覆盖的全部成员）。' +
      '摘要归纳是自动的、偶尔会错，归纳错了就用 summaryId 整组回退；' +
      '单条恢复用于「这条不该被归到那组里」。id / summaryId 用 memory_search 或记忆面板查到。',
    parameters: {
      oneOf: [
        {
          type: 'object',
          additionalProperties: false,
          required: ['id'],
          properties: { id: { type: 'string', description: '要恢复的记忆 id（归档或已被归纳的）。' } },
        },
        {
          type: 'object',
          additionalProperties: false,
          required: ['summaryId'],
          properties: { summaryId: { type: 'string', description: '要撤销的摘要 id：恢复它覆盖的整组成员。' } },
        },
      ],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['ok'],
        properties: {
          ok: { type: 'boolean' },
          restored: { type: 'integer' },
          reason: { type: 'string' },
        },
      },
      render: (_args, value) => {
        if (value.ok !== true) {
          const why =
            value.reason === 'not-found'
              ? '没有找到这条记忆'
              : value.reason === 'already-active'
                ? '它本来就是活跃的，不需要恢复'
                : value.reason ?? '未恢复';
          return [{ type: 'text', text: `未恢复：${why}。` }];
        }
        const count = value.restored ?? 1;
        return [{ type: 'text', text: count > 1 ? `已恢复 ${count} 条记忆（摘要已撤销）。` : '已恢复 1 条记忆。' }];
      },
    },
    async execute(args) {
      const memory = await opened();
      if (typeof args.summaryId === 'string' && args.summaryId.length > 0) {
        const result = await memory.restoreSummary(args.summaryId);
        return { ok: result.found === true, restored: result.restored ?? 0, reason: result.found === true ? '' : 'not-found' };
      }
      const result = await memory.restore(String(args.id ?? ''));
      if (result.restored === true) return { ok: true, restored: 1 };
      return { ok: false, restored: 0, reason: result.reason ?? 'not-found' };
    },
  });

  ctx.tools.register({
    name: 'memory_stats',
    description:
      '查看记忆库现状：各层条数、容量占用、约束/槽位/共同经历计数。用于判断「该不该清理」或回答用户「你还记得多少」。',
    parameters: { type: 'object', additionalProperties: false, properties: {} },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['active', 'archived', 'constraints', 'slots', 'episodes', 'capacity'],
        properties: {
          active: { type: 'integer' },
          archived: { type: 'integer' },
          constraints: { type: 'integer' },
          slots: { type: 'integer' },
          episodes: { type: 'integer' },
          capacity: { type: 'integer' },
          explicit: { type: 'integer' },
          recalls: { type: 'integer' },
          summaries: { type: 'integer' },
          backupKeep: { type: 'integer' },
        },
      },
      render: (_args, value) => [
        {
          type: 'text',
          text:
            `活跃记忆 ${value.active}/${value.capacity} 条，归档 ${value.archived} 条，摘要 ${value.summaries ?? 0} 条；` +
            `约束 ${value.constraints} 条，槽位 ${value.slots} 个，共同经历 ${value.episodes} 条；` +
            `显式记忆 ${value.explicit} 条，累计召回 ${value.recalls} 次。`,
        },
      ],
    },
    async execute() {
      const memory = await opened();
      const counts = memory.counts();
      return {
        active: counts.active,
        archived: counts.archived,
        constraints: counts.constraintsActive,
        slots: counts.slots,
        episodes: counts.byKind.episode,
        capacity: counts.capacity,
        explicit: counts.explicit,
        recalls: counts.recallCount,
        summaries: counts.summaries,
        backupKeep: memory.cfg?.backupKeep ?? 0,
      };
    },
  });

  // ── 读路径：每轮第一步注入召回上下文 ──
  ctx.on('agent/pre-step', async (payload, next) => {
    const decision = await next();
    if (decision.kind === 'reject') return decision;
    // 一轮多步只处理第一步：用户输入只在这一步。
    if (payload.step !== 1) return decision;
    if (payload.signal?.aborted === true) return decision;

    // 写入与注入必须解耦。
    // 这里曾经把 injectRecall 当成总闸放在最前面，结果是「关掉注入省 token」会连带
    // 关掉全部自动写入 —— 表现就是怎么聊都不进记忆。现在写入先跑，注入单独判断。
    const memory = await opened();
    const sessionId = payload.agent?.session?.id ?? null;
    const text = extractUserText(decision.messages);
    const progressKey = sessionId ?? 'anonymous';
    // 一次性诊断（每个会话只打一次，下个版本删）：`decision.messages` 里到底有没有历史？
    // 「使用信号」要拿上一轮助手回答才能判断"这条记忆有没有被用上"，
    // 拿不到就只能降级成"只用用户的消息判定"。不靠猜，让日志说话。
    if (!seenRoles.has(progressKey)) {
      seenRoles.add(progressKey);
      const roles = Array.isArray(decision.messages) ? decision.messages.map((message) => message?.role ?? '?') : ['<not-array>'];
      ctx.logger?.info?.(`memory-loom: pre-step messages roles = [${roles.join(',')}] (诊断)`);
    }
    // 上一条用户消息：追问（"那这个呢"、"继续按上面改"）离开它召回不到东西
    const previousUserText = lastUserText.get(progressKey) ?? '';
    if (text.length > 0) {
      lastUserText.set(progressKey, text);
      if (lastUserText.size > 100) lastUserText.delete(lastUserText.keys().next().value);
    }

    // ── 使用信号：验收「上一轮注入的记忆有没有被用上」 ──
    //
    // 判定必须**滞后一轮**：pre-step 时这一轮的答案还没生成，上一轮的答案也拿不到
    // （实测过：`decision.messages` 只含本轮）。所以拿你这一轮说的话，去比对上轮存下的指纹词。
    //
    // 只比对**你**说的话，不比对模型的回答 —— 否则"我说过什么"会反过来证明"这条记忆有用"，
    // 越用越像真的，回声室就回来了。
    /** 本轮验收上一份注入的结果（有才带，没 pending 就是 undefined） */
    let usageNote;
    if (cfg.usedSignal !== false && text.length > 0) {
      const pending = lastInjection.get(progressKey);
      if (pending !== undefined) {
        // 一份注入可以在接下来几轮里被验收：记忆往往是"过两轮才被用上"，
        // 只认紧挨着的下一轮会大面积漏判。命中就结案，超过 3 轮没人用也结案。
        pending.turns = (pending.turns ?? 0) + 1;
        const usedIds = [];
        for (const [id, anchors] of pending.anchors) if (isUsed(anchors, text)) usedIds.push(id);
        if (usedIds.length > 0) {
          lastInjection.delete(progressKey);
          try {
            await memory.markUsed(usedIds);
          } catch (error) {
            ctx.logger?.warn?.(`memory-loom: 记「用上了」失败：${error instanceof Error ? error.message : String(error)}`);
          }
          usageNote = { hit: usedIds.length, offered: pending.anchors.size, turns: pending.turns };
        } else if (pending.turns >= 3) {
          lastInjection.delete(progressKey);
          // 结案也要留痕：只知道"用上了几次"、不知道"一共有几次机会"，命中率就永远算不出来
          usageNote = { hit: 0, offered: pending.anchors.size, turns: pending.turns };
        }
      }
    }

    if (cfg.autoCapture === true && text.length > 0) {
      const explicit = classifyExplicit(text);
      if (explicit.explicit) {
        try {
          await memory.write({ kind: explicit.kind, text: explicit.text, explicit: true, source: 'explicit', sessionId });
          writeSeq += 1;
        } catch (error) {
          ctx.logger?.warn?.(`memory-loom: 显式记忆写入失败：${error instanceof Error ? error.message : String(error)}`);
        }
      } else {
        // 「记住…」之外再兜一层：定稿 / 明确否决也算稳定偏好。
        // 只写短句且带明确口吻的，临时微调（一点/再/试试）不写。
        const agreed = classifyDecision(text);
        if (agreed !== null) {
          try {
            // 带替换口吻的（"改成/换成/不要用"）顺手找一条最像的旧结论覆盖，避免新旧并存
            let supersedes;
            if (looksLikeChange(text) || agreed.kind === 'constraint') {
              const candidates = memory.search(agreed.text, { limit: 3 });
              const stale = candidates
                .filter((hit) => Number(hit.score) >= 0.45 && hit.status !== 'archived')
                .slice(0, 2)
                .map((hit) => hit.id);
              if (stale.length > 0) supersedes = stale;
            }
            await memory.write({ kind: agreed.kind, text: agreed.text, explicit: false, source: 'decision', sessionId, supersedes });
            writeSeq += 1;
          } catch (error) {
            ctx.logger?.warn?.(`memory-loom: 取舍记忆写入失败：${error instanceof Error ? error.message : String(error)}`);
          }
        }
      }
    }

    if (cfg.injectRecall !== true) return decision;
    if (memory.active().length === 0) return decision;

    // 轮数与写入进度：连续多轮没写就在注入块里提醒一句（只提醒，不替用户做决定）
    const progress = sessionProgress.get(progressKey) ?? { turns: 0, seenWriteSeq: writeSeq };
    progress.turns += 1;
    if (progress.seenWriteSeq !== writeSeq) {
      progress.turns = 0;
      progress.seenWriteSeq = writeSeq;
    }
    sessionProgress.set(progressKey, progress);

    const snapshot = memory.buildRecall(composeRecallQuery(text, previousUserText));
    const scored = snapshot.hits.filter((hit) => typeof hit.score === 'number' && !hit.weak).map((hit) => hit.id);
    // 观测：先把现场落下来，再决定注不注入。
    // 「这一轮什么都没注入」本身就是要观测的事实 —— 以前它在这里 return 掉，
    // 于是"注入次数"少算了一截，命中率的分母永远是假的。
    await memory.recordRecall({ ...snapshot, sessionId, ...(usageNote === undefined ? {} : { usage: usageNote }) });
    if (snapshot.blocks.length === 0) return decision;
    // 命中与共激活一次落盘：`scored` 正是「这一轮靠检索真正想起来的那几条」，
    // 常驻块（约束/槽位/共同经历）没有分数，天然被排除在配对之外 —— 它们每轮都在，
    // 让它们参与共现会把关系图塌成一个以约束为中心的星形。
    if (scored.length > 0) await memory.coRecall(scored);

    // 把这一轮的指纹存下来，等下一轮的话来验收（见上面「使用信号」）
    if (cfg.usedSignal !== false && scored.length > 0) {
      const anchors = memory.anchorsFor(scored);
      const previous = lastInjection.get(progressKey);
      if (previous === undefined) {
        lastInjection.set(progressKey, { at: Date.now(), turns: 0, anchors });
      } else {
        /**
         * 连续几轮都在注入：并进同一份，**不要重置 turns**。
         *
         * 这里踩过一次：直接 `set` 覆盖会把 turns 抹回 0，于是"满 3 轮结案"永远达不到，
         * 未命中一次也记不上 —— 命中率的分母永远是 0。连续注入在真实对话里很常见
         * （追问、同一话题往下聊），所以这不是边角情况。
         */
        for (const [id, list] of anchors) if (!previous.anchors.has(id)) previous.anchors.set(id, list);
      }
      if (lastInjection.size > 100) lastInjection.delete(lastInjection.keys().next().value);
    }

    const injection = renderInjection(snapshot);
    if (shouldNudge(progress.turns)) {
      injection.text += `\n\n【写入提醒】本会话已经连续 ${progress.turns} 轮没有新的记忆写入。如果这几轮里定下了稳定结论（成品形态、风格取舍、明确否决、纠正过的做法），现在就用 memory_write 落库；取代旧结论时带上 supersedes。`;
    }
    return { ...decision, messages: [...decision.messages, memoryMessage(injection)] };
  });

  // ── HTTP：面板取数（只读 + 两个明确的管理动作） ──
  const send = (res, status, body) => {
    const payload = JSON.stringify(body);
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'content-length': Buffer.byteLength(payload),
    });
    res.end(payload);
  };

  const readJson = async (req, limit = 1_000_000) => {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > limit) throw new Error('请求体过大');
      chunks.push(chunk);
    }
    if (chunks.length === 0) return {};
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  };

  const handler = async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      const route = url.pathname.replace(/^\/memory-loom\/?/, '').replace(/\/$/, '');
      const method = (req.method ?? 'GET').toUpperCase();
      const memory = await opened();

      if (method === 'GET' && (route === '' || route === 'api/state')) {
        const snapshot = memory.snapshot();
        send(res, 200, {
          ...snapshot,
          // 面板用它和自己 bundle 的版本对比：前端刷新只换 UI，路由要重启 DSH 才在 ——
          // 没有这个字段，用户只会看到一个没头没脑的 HTTP 404。
          serverVersion: SERVER_VERSION,
          health: computeHealth(memory, { recallEnabled: cfg.injectRecall }),
          tunables: Object.fromEntries(
            Object.entries(TUNABLE).map(([key, spec]) => [key, { ...spec, value: memory.cfg[key] }]),
          ),
          tunableText: Object.fromEntries(
            Object.entries(TUNABLE_TEXT).map(([key, spec]) => [key, { ...spec, value: memory.cfg[key] ?? '' }]),
          ),
          // 归纳引擎现状：面板要能看出"到底在用什么生成摘要"
          summarize: {
            enabled: memory.cfg.useLlmSummary === true,
            engine: memory.cfg.useLlmSummary === true ? summarizer.describe() : '抽取式（已关闭模型归纳）',
            provider: cfg.summaryProvider ?? '',
            model: cfg.summaryModel ?? '',
            pending: summaryQueue.length,
            active: summarizing,
          },
        });
        return;
      }
      if (method === 'GET' && route === 'api/health') {
        send(res, 200, computeHealth(memory, { recallEnabled: cfg.injectRecall }));
        return;
      }
      if (method === 'POST' && route === 'api/search') {
        const body = await readJson(req);
        const results = memory.search(String(body.query ?? ''), { limit: Number(body.limit ?? 12) });
        send(res, 200, { query: String(body.query ?? ''), threshold: memory.cfg.recallThreshold, results });
        return;
      }
      if (method === 'POST' && route === 'api/forget') {
        const body = await readJson(req);
        const result = await memory.forget(String(body.id ?? ''), { hard: body.hard === true, reason: 'panel' });
        send(res, 200, { ok: result.found, hard: result.hard });
        return;
      }
      // 试跑一次归纳：确认路由通不通、产出质量如何。
      // 传 summaryId 就用那条摘要的主题与要点；也可以直接传 {topic, points}。
      if (method === 'POST' && route === 'api/summarize') {
        const body = await readJson(req);
        let topic = String(body.topic ?? '').slice(0, 40);
        let points = Array.isArray(body.points) ? body.points.map((item) => String(item).slice(0, 200)).slice(0, 8) : [];
        let memberCount = points.length;
        if (topic.length === 0 && typeof body.summaryId === 'string' && body.summaryId.length > 0) {
          const snapshot = memory.snapshot();
          const row = (snapshot.summaries ?? []).find((item) => item.id === body.summaryId);
          if (row === undefined) {
            send(res, 200, { ok: false, error: '没有这条摘要', engine: summarizer.describe() });
            return;
          }
          topic = String(row.topic ?? '').slice(0, 40);
          points = String(row.text ?? '')
            .split(/[；;]/)
            .map((piece) => piece.replace(/^\s*【[^】]*】/, '').replace(/^\s*\d+\.\s*/, '').trim())
            .filter((piece) => piece.length > 0)
            .slice(0, 8);
          memberCount = row.memberCount ?? row.memberIds?.length ?? points.length;
        }
        if (topic.length === 0 || points.length === 0) {
          send(res, 400, { ok: false, error: '需要 topic + points，或 summaryId' });
          return;
        }
        try {
          const written = await summarizer.summarize({ topic, points, memberCount });
          send(res, 200, { ok: true, text: written, engine: summarizer.describe() });
        } catch (error) {
          send(res, 200, { ok: false, error: error instanceof Error ? error.message : String(error), engine: summarizer.describe() });
        }
        return;
      }

      if (method === 'POST' && route === 'api/tune') {
        const body = await readJson(req);
        const patch = body.patch ?? body ?? {};
        const result = await memory.tune(patch);
        // provider/model 改了要重新发现路由，否则还是用缓存里的旧路由
        if (Object.hasOwn(patch, 'summaryProvider') || Object.hasOwn(patch, 'summaryModel')) {
          summarizer.invalidate();
        }
        send(res, 200, { ok: Object.keys(result.applied).length > 0, ...result });
        return;
      }
      if (method === 'POST' && route === 'api/restore') {
        const body = await readJson(req);
        if (typeof body.summaryId === 'string' && body.summaryId.length > 0) {
          const result = await memory.restoreSummary(body.summaryId);
          send(res, 200, { ok: result.found === true, restored: result.restored ?? 0 });
          return;
        }
        const result = await memory.restore(String(body.id ?? ''));
        send(res, 200, { ok: result.restored === true, restored: result.restored === true ? 1 : 0, reason: result.reason ?? '' });
        return;
      }
      if (method === 'POST' && route === 'api/relax') {
        const body = await readJson(req);
        const result = await memory.relax(String(body.id ?? ''));
        send(res, 200, { ok: result.found });
        return;
      }
      /**
       * 导出/导入整库。
       *
       * 导出的就是磁盘上那份形状（能直接当备份、也能直接丢回来导入）；
       * 导入是整体替换，所以服务端先校验、先备份，再交出结果 —— 面板只负责两步确认。
       */
      if (method === 'GET' && route === 'api/export') {
        const payload = Buffer.from(await memory.exportJson(), 'utf8');
        res.writeHead(200, {
          'content-type': 'application/json; charset=utf-8',
          'content-disposition': 'attachment; filename="memory-loom-store.json"',
          'cache-control': 'no-store',
          'content-length': payload.length,
        });
        res.end(payload);
        return;
      }
      if (method === 'POST' && route === 'api/import') {
        // 库会随条数长大（2000 条约 4MB），所以这里单独放宽体积上限
        const body = await readJson(req, 32_000_000);
        try {
          const result = await memory.importJson(body.json ?? body.data ?? body);
          send(res, 200, result);
        } catch (error) {
          // 校验失败是「用户传错了文件」，不是服务端故障：200 + ok:false 让面板能读原因
          send(res, 200, { ok: false, error: error instanceof Error ? error.message : String(error) });
        }
        return;
      }
      if (method === 'POST' && route === 'api/tidy') {
        // 过程记录整理：先预览（面板据此显示「确认归档 N 条」），再 apply
        const body = await readJson(req);
        send(res, 200, await memory.tidyProcessLogs({ apply: body.apply === true }));
        return;
      }
      /**
       * 面板侧诊断落盘：前端把「点了什么、拿到什么」写进来，
       * 这样不用让用户在控制台里翻、也不用靠截图猜。
       */
      if (method === 'POST' && route === 'api/diag') {
        const body = await readJson(req);
        const file = join(dirname(memory.file), 'client-diag.log');
        await appendFile(file, `${new Date().toISOString()} ${JSON.stringify(body)}\n`, 'utf8');
        send(res, 200, { ok: true, file });
        return;
      }
      send(res, 404, { error: `memory-loom: 未知路由 ${method} ${url.pathname}` });
    } catch (error) {
      ctx.logger?.warn?.(`memory-loom: 路由失败：${error instanceof Error ? error.message : String(error)}`);
      if (!res.headersSent) send(res, 500, { error: error instanceof Error ? error.message : String(error) });
      else res.end();
    }
  };

  // webServer 是可选 service（headless profile 没有）：有就挂，没有就只留工具。
  let attached = false;
  const attach = (webServer) => {
    if (attached || webServer === undefined || webServer === null) return;
    attached = true;
    ctx.effect(
      () => webServer.register({ kind: 'prefix', path: '/memory-loom', handler }),
      'memory-loom: http routes',
    );
  };
  attach(ctx.get('webServer'));
  try {
    // 服务可能晚于插件就绪（headless 里永远没有）：等它出现再挂，不等也不报错。
    ctx.inject(['webServer'], (child) => {
      attach(child.get('webServer'));
    });
  } catch (error) {
    ctx.logger?.warn?.(`memory-loom: webServer 惰性挂载不可用：${error instanceof Error ? error.message : String(error)}`);
  }

  ctx.effect(
    () => async () => {
      // 退出前把在途写入排空：库是整文件发布，丢了会很吵。
      await store.chain.catch(() => {});
    },
    'memory-loom: drain',
  );

  ctx.logger?.info?.(`memory-loom: 记忆库 ${store.file}`);
}

// 注意：不要加 `export default apply`。loader 取的是 `module.default || module`，
// 一旦有 default，注入声明（inject）会被丢掉，插件就在激活期报
// "cannot get property systemPrompt without inject"。
