/**
 * 记忆库：存储 + 写路径治理 + 读路径召回。
 *
 * 和「旧识」的对应关系（同一套口径，介质从 SQLite 换成单个 JSON 文件）：
 * - `memories`：提炼后的事实短句（不存对话原文），带 actor / event_date / scene /
 *   significance / hits / archived_at；`status` 实现软删归档，`relaxedAt` 是约束解除，
 *   不是删除 —— 被放宽的约束留在活跃集里留档。
 * - `slots`：覆盖式状态槽位（entity × attr 唯一），不参与淘汰。
 * - `summaries`：滚动摘要位（本插件不自动生成，留给上层写入，健康灯会如实说 empty）。
 * - `events`：只增的机制埋点，回答「去重到底有没有用」这类问题。
 * - `recall`：最近一次召回现场（查询、逐条得分、注入了哪些块），面板据此可视化。
 *
 * 并发：所有写操作串行化（`#mutate`），文件用「同目录临时文件 + fsync + rename」原子发布。
 * 读操作不加锁 —— 读的是内存快照，加锁换不到正确性。
 *
 * @module dsh-memory-loom/store
 */

import { copyFile, mkdir, open as openFile, readFile, readdir, rename, stat as statFile, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { describeAge, findEventDate, isoDay, looksLikeChange, looksLikeProcessLog, similarity, isSameClaim, tokenize } from './text.js';
import { planSummaries, labelOf, isGenericLabel } from './summary.js';
import { buildCorpus, coverageScore, contentTokens } from './rank.js';
import { anchorsOf } from './usage.js';
import { expandQueryTokens } from './aliases.js';
import { coActivate, pruneEdges, visibleEdges, graphStats } from './graph.js';

/** 记忆种类。`self` 是「她的经历」一类第一人称条目，保留原项目的分层。 */
export const KINDS = ['fact', 'world', 'constraint', 'episode', 'self', 'slot', 'choice'];

/**
 * 「同根因」门槛：两条约束讲的是不是同一件事。
 *
 * 0.18 落在真实库实测出来的空隙里：讲同一件事的那对相似度 0.28，其余任意两对都 ≤ 0.09。
 * 这个数同时被成长读数（`lib/growth.js` 的 `rootCauseThreshold` 默认值）引用 ——
 * 写入期提示和事后度量必须是同一把尺子，否则会出现「写的时候没提醒、事后又说它俩同根因」，
 * 两句话互相打脸，人就再也不信任何一句。
 */
export const SAME_ROOT_THRESHOLD = 0.18;

/** 会被淘汰的 kind：world / constraint / explicit 永久豁免（原项目口径）。 */
const EVICTABLE = new Set(['fact', 'self', 'episode']);

/**
 * 「从未被想起」整理的**分档**门槛（天）。
 *
 * 为什么分档、而不是一刀切排除 world：真实库体检里 `hits = 0` 的 38 条中，
 * **fact 一条都没有**（11 条全被召回过了），而 world 占了 27 条 ——
 * 也就是说死重的主体恰恰是 world，把它一刀切排除之后，这个功能在真实库上挑不出东西。
 *
 * 但 world 里也真有"长期设定"（形态、否决、偏好），它们本来就该常驻、不该按热度淘汰，
 * 所以给它更长的耐心：30 天。没被召回不是因为不重要，可能是还没遇到那个问题。
 *
 * `episode` / `constraint` / `slot` 不在表里 = 永不入选：
 * 共同经历不可再生、约束和槽位每轮无条件注入（`hits` 的语义跟别的层根本不是一回事）。
 */
const UNUSED_DAYS = { fact: 7, self: 7, world: 30 };

/** 容量与阈值默认值。全部可被插件 config 覆盖。 */
/**
 * 面板可调的参数与合法区间。
 *
 * 只开放"调手感"的旋钮；storePath / 物理删除相关的不开放 ——
 * 在界面上点两下就把库写坏，是比"没有调参入口"严重得多的问题。
 */
export const TUNABLE = {
  maxActiveMemories: { min: 100, max: 20000, step: 100, label: '活跃上限' },
  maxArchive: { min: 0, max: 5000, step: 100, label: '归档上限' },
  compactAt: { min: 0, max: 20000, step: 100, label: '压缩触发线' },
  summaryMinMembers: { min: 3, max: 50, step: 1, label: '成簇最少条数' },
  maxWorld: { min: 20, max: 5000, step: 20, label: 'world 上限' },
  dedupeThreshold: { min: 0.5, max: 0.99, step: 0.01, label: '查重阈值' },
  recallThreshold: { min: 0.05, max: 0.9, step: 0.01, label: '召回阈值' },
  halfLifeDays: { min: 1, max: 365, step: 1, label: '半衰天数' },
  edgeMaxDegree: { min: 2, max: 64, step: 1, label: '单点关系上限' },
  edgeMinWeight: { min: 0.05, max: 8, step: 0.05, label: '关系存活阈值' },
  recallMinContentTokens: { min: 0, max: 6, step: 1, label: '检索最少内容词' },
};

/**
 * 夹取一个可调参数；非法值返回 null（调用方据此报错）。
 * @param {string} key
 * @param {unknown} value
 * @returns {number|null}
 */
export function clampTunable(key, value) {
  const spec = TUNABLE[key];
  if (spec === undefined) return null;
  const numeric = typeof value === 'number' ? value : Number.parseFloat(String(value ?? ''));
  if (!Number.isFinite(numeric)) return null;
  return Math.min(spec.max, Math.max(spec.min, numeric));
}

/**
 * 面板可调的**文本型**参数（只能填字符串的那几个）。
 * 与 TUNABLE 同一套思路：白名单 + 长度校验，不留后门。
 */
export const TUNABLE_TEXT = {
  summaryProvider: { label: '归纳 provider', maxLength: 120 },
  summaryModel: { label: '归纳 model', maxLength: 120 },
};

/**
 * 校验一个文本型可调参数。
 * @param {string} key
 * @param {unknown} value
 * @returns {string|null}
 */
export function clampTunableText(key, value) {
  const spec = TUNABLE_TEXT[key];
  if (spec === undefined) return null;
  const raw = typeof value === 'string' ? value.trim() : '';
  if (raw.length === 0) return '';
  if (raw.length > spec.maxLength) return raw.slice(0, spec.maxLength);
  return raw;
}

export const DEFAULTS = {
  storePath: '',
  maxActiveMemories: 2000,
  maxArchive: 500,
  eventsKeep: 5000,
  dedupeThreshold: 0.72,
  /** 主动压缩触发线：活跃条数到这个数就开始把同主题冗余归纳掉（不必等到硬上限） */
  compactAt: 1200,
  /** 一簇至少多少条才值得归纳 */
  summaryMinMembers: 6,
  /** 一条摘要最多几个要点 */
  summaryPoints: 4,
  /** 一次最多归纳几簇（避免一次写入做太多活） */
  summaryClusterLimit: 4,
  /** 摘要保留条数上限 */
  maxSummaries: 60,
  /** world 自己的上限：它豁免容量淘汰，但不能无限长 */
  maxWorld: 240,
  /** 破坏性操作（物理删除归档）前留几份备份 */
  backupKeep: 3,
  /** 两次备份的最小间隔，避免频繁写盘 */
  backupIntervalMs: 600_000,
  /** 单次压缩最多看多少条（按权重取高的一侧），保证有界 */
  summarySampleLimit: 800,
  /** 归纳只压缩权重靠后的部分：最高的这一比例保持活跃（重要结论不该被 absorb） */
  compactKeepRatio: 0.3,
  /** 是否允许用模型重写摘要（store 只负责通知，真正调模型在上层） */
  useLlmSummary: true,
  recallThreshold: 0.18,
  /** 检索覆盖度阈值：问句里混着高频词，低于这个值基本是瞎猜 */
  searchThreshold: 0.34,
  weakMargin: 1.3,
  recallTopK: 3,
  worldTopK: 3,
  episodeTop: 2,
  constraintLimit: 12,
  slotLimit: 12,
  halfLifeDays: 30,
  maxTextLength: 400,
  /**
   * 共激活图（`edges`）的参数。
   *
   * 这一层**只观测、不参与注入决策**：边只影响面板怎么画，不影响哪条记忆被召回。
   * 先让它跑一段时间，看长出来的关系是不是真的有意义，再决定要不要让它反过来影响召回。
   *
   * - `coActivate: false` 可整层关掉（老库、或用户不想让库再多这一层数据）
   * - `edgeFanout`：一轮召回最多让前几条参与配对（8 条 = 28 对），防噪声灌图
   * - `edgeMaxDegree`：每点上限。没有上限就会长出全连接图，等于没有结构
   * - `edgeMaxEdges`：全局上限，防 store.json 被这一层拖肥
   * - `edgeMinWeight`：衰减到这个值以下算死边，直接剪掉
   */
  coActivate: true,
  edgeFanout: 8,
  edgeMaxDegree: 12,
  edgeMaxEdges: 6000,
  edgeMinWeight: 0.25,
  /**
   * 读闸门：一条查询至少要有几个「内容词」才值得去翻记忆库。
   *
   * 0 表示不设闸门（老行为）。为什么需要它：注入是**常量开销**，
   * 实测「今天先做什么」这种问题也会灌进去 5 块 1536 字符 —— 而它并不需要记忆。
   * 判据为什么不用「相关度」：覆盖率的分母只有查询词，短查询撞上一个二元组就是 1.0，
   * 实测「继续」「现在几点了」的峰值覆盖率是 1.000，比一半真相关查询还高（详见 `contentTokens`）。
   *
   * 闸门只掐世界/事实/摘要三块；约束、槽位、共同经历是"每轮无条件注入"的契约，永远照旧。
   */
  recallMinContentTokens: 2,
  /**
   * 每条记忆取几个「指纹词」用于判定"有没有被用上"。
   *
   * 3 是权衡：取 1 个容易撞词，取 5 个要求太高（下一轮你得同时提到好几个词）。
   */
  usedAnchorCount: 3,
  /**
   * 写前是否复查磁盘（外部改动先并进来再写）。
   *
   * 默认开：单窗口也会遇到手工编辑 store.json、导入、备份恢复这些"外部改动"，
   * 不开的话下一次写就把它们整份覆盖掉。多实例同时写时它只能减少互相覆盖，
   * 不能替代跨进程锁。要老行为就设 false。
   */
  autoReload: true,
  /**
   * 自我叙事的字数上限。
   *
   * 800 是「一段话说清自己是谁」的量级。超过它就不是叙事，是把条目换个地方堆 ——
   * 而堆是这套系统已经证明会变胖的那种长法（密度跌、注意力摊薄）。
   */
  maxSelfNarrativeLength: 800,
  /**
   * 人格三层预算（见 docs/specs/self-growth-v0.md D1）。
   *
   * 这些不是"建议值"而是写入闸门：超了直接拒绝，不做自动截断 ——
   * 自动截断等于静默丢掉人格片段，正是这套东西要防的事。
   */
  maxSelfCoreLength: 120,
  maxPrincipleLength: 40,
  principleLimit: 9,
  selfContractBudget: 600,
  selfOplogLimit: 200,
  /**
   * 叙事留几版历史。
   *
   * **轨迹本身就是证据**：三个版本都在讲同一件事 = 没长；每版都在换说法、去掉旧结论 = 在长。
   * 但也不需要留成完整档案，12 版够看半年的走向。
   */
  selfNarrativeVersions: 12,
  /**
   * 每条记忆最多记几个「被想起的语境」。
   *
   * 8 够看出分歧了；再多不是信息，是长大 —— 而且这一层是**每条被召回的记忆都要长**的，
   * 放大一位就是全库一起放大。
   */
  contextCap: 8,
};

/** 空库形状。 */
function emptyState() {
  const now = Date.now();
  return {
    version: 1,
    createdAt: now,
    updatedAt: now,
    memories: [],
    slots: [],
    summaries: [],
    /**
     * 共激活边：`{a, b, w, at}`，端点 a < b。
     * 只由「同一轮一起被召回」产生，不由文本相似度产生 —— 理由见 `lib/graph.js` 头注释。
     */
    edges: [],
    /** 面板改过的参数覆盖项（重启后仍然生效） */
    cfgOverrides: {},
    events: [],
    recall: { last: null, count: 0 },
    /**
     * 自我叙事：一段**被重写**而不是被追加的自我描述。
     *
     * 为什么它不能只是又一堆 `self` 条目：`self` 是"我经历过什么"（碎片、可增量、按检索取用），
     * 叙事是"我是谁"（单一、必须整体成立、每轮都在场）。两者形态不同，
     * 混在一层里的结果是：十一条碎片各自被检索到一点，从来没有一个完整的我。
     *
     * `versions` 存旧版全文，最新的一版在 `current`。重写时旧版整份压进历史，
     * 所以「成长」是可以回看的东西，而不是一句自我宣称。
     */
    selfNarrative: { current: null, versions: [] },
    /**
     * 自我（人格）的真身：内核 + 带证据账的原理 + 操作日志。
     *
     * `selfNarrative` 从 0.51 起只是它的**合成视图**：每次自我改动后重算一次，
     * 好让注入、成长曲线、面板这些老读者一行不用改。真相在 `self` 里 ——
     * 因为"我是谁"必须拆成可 diff 的碎片（哪一条、为什么、凭什么），
     * 而"整段文本"只能是它的投影。
     */
    self: emptySelf(),
    meta: { writeCount: 0, dedupeCount: 0, archiveCount: 0, relaxCount: 0, forgetCount: 0 },
  };
}

/**
 * 收一条叙事版本：形状不对的整条丢掉（叙事是"要么完整成立、要么不存在"的东西，
 * 半条叙事比没有更糟 —— 它会被当成我的自我描述读进来）。
 */
function normalizeNarrativeEntry(row) {
  if (row === null || typeof row !== 'object') return null;
  const text = String(row.text ?? '').trim();
  if (text.length === 0) return null;
  return {
    id: String(row.id ?? ''),
    text,
    at: Number(row.at) || 0,
    reason: String(row.reason ?? ''),
    source: String(row.source ?? 'tool'),
    sessionId: row.sessionId == null ? null : String(row.sessionId),
    chars: [...text].length,
  };
}

/** 兼容老库：没有自我叙事就是"还没写过"，不是坏数据。 */
function normalizeNarrative(raw) {
  if (raw === null || typeof raw !== 'object') return { current: null, versions: [] };
  const current = normalizeNarrativeEntry(raw.current);
  const versions = (Array.isArray(raw.versions) ? raw.versions : []).map(normalizeNarrativeEntry).filter((row) => row !== null);
  return { current, versions };
}

/** 本地日子（YYYY-MM-DD）：时间轴按"那一天"分组，不按 UTC —— 人在本地过日期。 */
function localDay(ts) {
  const date = new Date(Number(ts) || 0);
  const pad = (value) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** 空的自我：内核空缺不是坏数据，是"还没写"。 */
function emptySelf() {
  return { core: null, principles: [], oplog: [], versions: [] };
}

/**
 * 把内核与生效中的原理合成一段文本 —— 每轮注入的就是它。
 *
 * 不加项目符号、只用换行连接：迁移时必须能和老叙事一字不差地还原，
 * 多一个 "- " 就等于偷偷改了字节（这一条踩过三次了）。
 */
function composeSelfText(core, principles) {
  const parts = [];
  const head = String(core ?? '').trim();
  if (head.length > 0) parts.push(head);
  const lines = (Array.isArray(principles) ? principles : [])
    .filter((row) => row !== null && typeof row === 'object' && row.status !== 'retired')
    .map((row) => String(row.text ?? '').trim())
    .filter((line) => line.length > 0);
  if (lines.length > 0) parts.push(lines.join('\n'));
  return parts.join('\n');
}

/**
 * 把一整段自我叙事拆成原理。
 *
 * 两级拆：先按行（作者自己划的段），太长再按句（。！？；）。
 * 为什么要有第二级：真实库里那段 127 字是**一整行**的，只按行拆会得到
 * 一条 130 字的"原理"——而原理该是判断，不是叙述。拆句不猜语义、不改一个字。
 * 拆完仍然超长的就留着：字数上限只约束新写入，历史数据不追罚。
 */
function splitNarrative(text, maxChars) {
  const pieces = [];
  for (const line of String(text ?? '').split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    if ([...trimmed].length <= maxChars) {
      pieces.push(trimmed);
      continue;
    }
    const sentences = trimmed
      .split(/(?<=[。！？；!?;])/u)
      .map((part) => part.trim())
      .filter((part) => part.length > 0);
    pieces.push(...(sentences.length > 1 ? sentences : [trimmed]));
  }
  return pieces;
}

function normalizeCore(raw) {
  if (raw === null || typeof raw !== 'object') return null;
  const text = String(raw.text ?? '').trim();
  if (text.length === 0) return null;
  const at = Number(raw.updatedAt ?? raw.lockedAt) || 0;
  return {
    text,
    chars: [...text].length,
    lockedAt: Number(raw.lockedAt) || at,
    updatedAt: at,
    by: 'user',
  };
}

function normalizePrinciple(raw) {
  if (raw === null || typeof raw !== 'object') return null;
  const text = String(raw.text ?? '').trim();
  if (text.length === 0) return null;
  const evidence = raw.evidence !== null && typeof raw.evidence === 'object' ? raw.evidence : {};
  return {
    id: String(raw.id ?? ''),
    text,
    born: Number(raw.born) || 0,
    bornFrom: (Array.isArray(raw.bornFrom) ? raw.bornFrom : []).map(String),
    evidence: {
      proven: Math.max(0, Number(evidence.proven) || 0),
      broken: Math.max(0, Number(evidence.broken) || 0),
      lastAt: Number(evidence.lastAt) || null,
      lastPointer: evidence.lastPointer == null ? null : String(evidence.lastPointer),
    },
    status: raw.status === 'retired' ? 'retired' : 'live',
    retiredAt: Number(raw.retiredAt) || null,
    retiredReason: raw.retiredReason == null ? null : String(raw.retiredReason),
  };
}

function normalizeOplogEntry(raw) {
  if (raw === null || typeof raw !== 'object') return null;
  const op = String(raw.op ?? '');
  if (op.length === 0) return null;
  return {
    id: String(raw.id ?? ''),
    ts: Number(raw.ts) || 0,
    op,
    target: raw.target == null ? null : String(raw.target),
    before: raw.before == null ? null : String(raw.before),
    after: raw.after == null ? null : String(raw.after),
    reason: String(raw.reason ?? ''),
    evidence: (Array.isArray(raw.evidence) ? raw.evidence : []).map(String),
    source: String(raw.source ?? 'tool'),
    /** 合并时被合进来的那几条 id：回退要靠它把原文复职。 */
    targets: (Array.isArray(raw.targets) ? raw.targets : []).map(String),
    /** 被哪一次回退撤掉了（null = 仍然生效）。流水只标记，不删除。 */
    undoneAt: Number(raw.undoneAt) || null,
  };
}

/** 兼容老库：没有 self 字段就是"还没迁移"，交给迁移补，不当成坏数据。 */
function normalizeSelf(raw) {
  if (raw === null || typeof raw !== 'object') return emptySelf();
  return {
    core: normalizeCore(raw.core),
    principles: (Array.isArray(raw.principles) ? raw.principles : []).map(normalizePrinciple).filter((row) => row !== null),
    oplog: (Array.isArray(raw.oplog) ? raw.oplog : []).map(normalizeOplogEntry).filter((row) => row !== null),
    versions: (Array.isArray(raw.versions) ? raw.versions : []).map(normalizeNarrativeEntry).filter((row) => row !== null),
  };
}

/** 把任意输入收敛成一条干净的记忆行；缺关键字段直接抛，不写半条。 */
function normalizeInput(input, cfg) {
  const kind = String(input.kind ?? 'fact');
  if (!KINDS.includes(kind)) throw new Error(`memory-loom: unknown kind "${kind}" (expected ${KINDS.join('|')})`);
  const text = String(input.text ?? '').trim().slice(0, cfg.maxTextLength);
  if (kind === 'slot') {
    const entity = String(input.entity ?? '').trim();
    const attr = String(input.attr ?? '').trim();
    if (entity.length === 0 || attr.length === 0) throw new Error('memory-loom: slot 需要 entity 与 attr 三键齐全');
    if (text.length === 0) throw new Error('memory-loom: slot 需要 text 作为 value');
    return { kind, text, entity, attr };
  }
  if (text.length === 0) throw new Error('memory-loom: text 不能为空');
  /**
   * 取舍（choice）：一次两难里选了哪边。
   *
   * 为什么要结构化存三键而不是只写一句话：性格读的是 `picked` 的**分布与频次**，
   * 而"我在 A 和 B 之间选了 A"这句话没法用正则可靠地拆回来。
   * `text` 仍然保留给人读（一句话说清），机器读的是三键。
   */
  const choice = kind === 'choice' ? normalizeChoice(input) : null;
  const significance = kind === 'episode' ? Math.min(5, Math.max(1, Number(input.significance ?? 3))) : null;
  return {
    kind,
    text,
    entity: null,
    attr: null,
    scene: kind === 'episode' ? (String(input.scene ?? '').trim() || null) : null,
    significance,
    actor: String(input.actor ?? (kind === 'self' ? 'assistant' : kind === 'episode' ? 'shared' : 'user')),
    choice,
  };
}

/**
 * 收一个取舍三键：A 是什么、B 是什么、选了哪个。
 *
 * 三键缺一就直接拒绝 —— 半个取舍是没有信息量的：
 * 只有"选了什么"而没有"另一条路是什么"，读不出偏好，只能读出行为。
 */
function normalizeChoice(input) {
  const raw = input.choice !== null && typeof input.choice === 'object' ? input.choice : input;
  const a = String(raw.a ?? raw.choiceA ?? '').trim();
  const b = String(raw.b ?? raw.choiceB ?? '').trim();
  const picked = String(raw.picked ?? raw.choicePicked ?? '').trim().toLowerCase();
  if (a.length === 0 || b.length === 0) {
    throw new Error('memory-loom: kind=choice 需要两个选项（a 与 b）—— 只有一个选项就不叫取舍');
  }
  if (a === b) throw new Error('memory-loom: 取舍的两个选项不能是同一件事');
  if (picked !== 'a' && picked !== 'b') throw new Error('memory-loom: kind=choice 需要 picked，取值只能是 a 或 b');
  /**
   * 位置必须与「我选了哪边」无关。
   *
   * 真实教训（0.56.2）：前 12 条取舍**全部** picked=b，因为写的人（我）习惯把
   * "我实际选的那条"放在 b、"另一条路"放在 a —— 位置本身被当成了结论。
   * 于是 picked 恒定，账本记的是排版，不是偏好。
   *
   * 所以这里按码点定序，`picked` 跟着翻：语义（选了哪个字符串）一个字不变，
   * 位置由代码定，写的人无权决定。
   */
  const [finalA, finalB, finalPicked] = a <= b ? [a, b, picked] : [b, a, picked === 'a' ? 'b' : 'a'];
  return { a: finalA, b: finalB, picked: finalPicked };
}

/** 时间衰减权重：(1 + 命中加成) × 半衰期衰减。 */
export function weightOf(memory, now = Date.now(), halfLifeDays = DEFAULTS.halfLifeDays) {
  const anchor = memory.lastHitAt ?? memory.updatedAt ?? memory.createdAt;
  const ageDays = Math.max(0, (now - anchor) / 86_400_000);
  const decay = 0.5 ** (ageDays / Math.max(1, halfLifeDays));
  return (1 + 0.35 * Math.log1p(Math.max(0, memory.hits ?? 0))) * decay;
}

/** 一条记忆的模型可读标签。 */
function kindLabel(kind) {
  return (
    {
      fact: '事实',
      world: '世界',
      constraint: '约束',
      episode: '共同经历',
      self: '她的经历',
      slot: '状态',
      choice: '取舍',
    }[kind] ?? kind
  );
}

export class MemoryStore {
  /**
   * @param {{file: string} & Partial<typeof DEFAULTS>} options 文件路径与阈值覆盖
   */
  constructor(options = {}) {
    this.cfg = { ...DEFAULTS, ...options };
    if (typeof this.cfg.storePath !== 'string' || this.cfg.storePath.length === 0) {
      this.file = options.file;
    } else {
      this.file = this.cfg.storePath;
    }
    if (typeof this.file !== 'string' || this.file.length === 0) throw new Error('memory-loom: storePath is required');
    this.state = emptyState();
    this.opened = false;
    this.loadError = null;
    this.chain = Promise.resolve();
  }

  /**
   * 把面板改过的参数覆盖项应用到运行配置上。
   * 越界的值一律丢弃 —— 旧版本写进去的坏值不该让库起不来。
   */
  #applyOverrides() {
    const overrides = this.state?.cfgOverrides;
    if (overrides === null || typeof overrides !== 'object') return;
    for (const [key, value] of Object.entries(overrides)) {
      if (Object.hasOwn(TUNABLE_TEXT, key)) {
        const normalized = clampTunableText(key, value);
        if (normalized === null) continue;
        this.cfg[key] = normalized;
        continue;
      }
      const clamped = clampTunable(key, value);
      if (clamped === null) continue;
      this.cfg[key] = clamped;
    }
  }

  /** 面板保存一次参数：夹取后写入覆盖项并持久化。 */
  async tune(patch) {
    return this.#mutate(async () => {
      const applied = {};
      const rejected = [];
      for (const [key, value] of Object.entries(patch ?? {})) {
        // 文本型（provider / model）：允许清空，表示"回落到自动发现"
        if (Object.hasOwn(TUNABLE_TEXT, key)) {
          const normalized = clampTunableText(key, value);
          if (normalized === null) {
            rejected.push(key);
            continue;
          }
          this.cfg[key] = normalized;
          this.state.cfgOverrides[key] = normalized;
          applied[key] = normalized;
          continue;
        }
        const clamped = clampTunable(key, value);
        if (clamped === null) {
          rejected.push(key);
          continue;
        }
        this.cfg[key] = clamped;
        this.state.cfgOverrides[key] = clamped;
        applied[key] = clamped;
      }
      if (Object.keys(applied).length > 0) this.#event('cfg.tune', applied);
      return { applied, rejected };
    });
  }

  /**
   * 挂一个摘要增强器：压缩生成摘要后**同步**通知它，由上层决定要不要用模型重写。
   *
   * 约定：增强器必须立刻返回（自己内部异步），store 不会 await 它 ——
   * 写入路径不允许等待模型，否则一次归纳超时就会拖住整次写入。
   *
   * @param {((payload: {id: string, topic: string, text: string, points: string[]}) => void) | null} fn
   */
  /** 把一条记忆的词挂进倒排索引（写入路径增量维护，避免全量重建）。 */
  #indexRow(row) {
    if (this.corpusPostings === undefined) return;
    for (const token of new Set(tokenize(row.text))) {
      const bucket = this.corpusPostings.get(token);
      if (bucket === undefined) this.corpusPostings.set(token, new Set([row.id]));
      else bucket.add(row.id);
    }
  }

  /**
   * 找一条和它同根因的**活跃约束**（写入期体检用）。
   *
   * 只体检约束层：它是每轮无条件注入的常量开销，重复一条的代价是永久的
   * （世界/事实只在被检索到时才付钱，重复一次只是占个名额）。
   * 已解除的约束不算同类 —— 它已经不是禁令了，和它合并没有意义。
   *
   * @param {{id: string, text: string}} row 刚写入的约束
   * @returns {{row: object, score: number}|null}
   */
  #sameRootSibling(row) {
    let best = null;
    for (const other of this.active()) {
      if (other.kind !== 'constraint' || other.id === row.id || other.relaxedAt != null) continue;
      const score = similarity(row.text, other.text);
      if (score < SAME_ROOT_THRESHOLD) continue;
      if (best === null || score > best.score) best = { row: other, score };
    }
    return best;
  }

  setSummaryEnhancer(fn) {
    this.summaryEnhancer = typeof fn === 'function' ? fn : null;
  }

  /** 读取磁盘上的库；不存在就建空库（不写盘，等第一次写入）。 */
  async open() {
    try {
      const raw = await readFile(this.file, 'utf8');
      const parsed = JSON.parse(raw);
      this.state = this.#normalizeShape(parsed);
      this.loadError = null;
    } catch (error) {
      if (error?.code === 'ENOENT') {
        this.state = emptyState();
        this.loadError = null;
        // 首次启动就把空库落盘：面板要显示真实库路径，用户要能直接备份这个文件。
        this.opened = true;
        this.#applyOverrides();
        await this.#persist();
        return this;
      } else {
        // 损坏的库不能静默当成空库：留档并以只读可用的空库启动，健康灯会显示 degraded。
        this.loadError = error instanceof Error ? error.message : String(error);
        this.state = emptyState();
      }
    }
    this.opened = true;
    // 面板改过的参数在这里生效（越界值丢弃）
    this.#applyOverrides();
    // 主题词是派生数据：规则升级后按新规则重算老库里那些没信息量的标签（「归纳·新增」这类）。
    // 只改泛词/空词/版本片段，别的一概不动，改了就落盘，免得每次启动都重来一遍。
    if (this.#relabelStaleSummaries()) await this.#persist();
    // 同理：`revisedCount` 是后加的字段，历史埋点里已经有改写记录，补一次让它别从 0 起算。
    if (this.#backfillRevisions()) await this.#persist();
    // 0.51：「一整段自我叙事」拆成内核 + 原理 + 操作流水。幂等，老库只迁一次。
    if (this.#migrateSelf()) await this.#persist();
    // 记住当前磁盘签名：不然第一次写前的复查会把"open 时读到的那份"也当成外部改动
    await this.#rememberDiskSignature();
    return this;
  }

  /**
   * 把老库里没信息量的摘要主题词按当前规则重算。
   *
   * 为什么不在压缩时只管新摘要：老摘要会一直在面板上显示「归纳·新增」，
   * 而主题词本身就是派生值（成员和文本都在库里），重算没有任何信息损失。
   *
   * @returns {boolean} 是否有改动
   */
  #relabelStaleSummaries() {
    let changed = false;
    for (const summary of this.state.summaries) {
      if (!isGenericLabel(summary.topic)) continue;
      const memberIds = new Set(Array.isArray(summary.memberIds) ? summary.memberIds : []);
      const members = this.state.memories.filter((row) => memberIds.has(row.id));
      if (members.length === 0) continue;
      const next = labelOf(members);
      if ([...String(next ?? '')].length < 2 || next === summary.topic) continue;
      const before = String(summary.topic ?? '');
      summary.topic = next;
      // 文本里若还带着旧前缀，一起换掉：面板上标题和正文不能各说一套
      if (before.length > 0) summary.text = String(summary.text ?? '').replace(`【归纳·${before}】`, `【归纳·${next}】`);
      this.#event('summary.relabel', { id: summary.id, from: before, to: next });
      changed = true;
    }
    return changed;
  }

  /**
   * 从历史埋点里补一次「被改写」计数（一次性，跑过就置标记）。
   *
   * 字段是后加的，而库里**已经发生过**改写：`memory.supersede` / `constraint.relax`
   * 这两个事件的 payload 里都带着被改的 id。不补的话新读数会从 0 起算，
   * 看起来像"这库从没改写过任何东西"——而日志里明明记着。
   *
   * 只认**带 id 的**那两类事件：`write.change-hint` 早期的 payload 没有 `targetId`，
   * 补不出来就不补，不猜一个上去。幂等靠 `meta.revisedBackfill`，
   * 而且每次只往高处补（`>= count` 就跳过），所以活数据不会被压回去。
   *
   * @returns {boolean} 是否有改动
   */
  #backfillRevisions() {
    if (this.state.meta.revisedBackfill === true) return false;
    const tally = new Map();
    for (const event of this.state.events) {
      const ids = event?.payload?.ids;
      if (event?.kind !== 'memory.supersede' && event?.kind !== 'constraint.relax') continue;
      if (!Array.isArray(ids)) continue;
      for (const id of ids) {
        const current = tally.get(String(id)) ?? { count: 0, at: 0 };
        tally.set(String(id), { count: current.count + 1, at: Math.max(current.at, Number(event.ts) || 0) });
      }
    }
    let changed = false;
    for (const [id, entry] of tally) {
      const row = this.byId(id);
      if (row === undefined) continue;
      if ((row.revisedCount ?? 0) >= entry.count) continue;
      row.revisedCount = entry.count;
      row.lastRevisedAt = entry.at;
      changed = true;
    }
    this.state.meta.revisedBackfill = true;
    return changed;
  }

  /** 兼容历史/半损坏结构：缺字段补齐，坏行丢弃（不静默改写语义）。 */
  #normalizeShape(parsed) {
    const base = emptyState();
    if (parsed === null || typeof parsed !== 'object') throw new Error('store: root must be an object');
    const memories = Array.isArray(parsed.memories) ? parsed.memories : [];
    return {
      ...base,
      ...parsed,
      memories: memories
        .filter((row) => row !== null && typeof row === 'object' && typeof row.text === 'string' && KINDS.includes(row.kind))
        .map((row) => ({
          significance: null,
          scene: null,
          eventDate: null,
          hits: 0,
          /**
           * 被**用上**的次数（与 `hits` 的"被召回"分开记）。
           * 老库没有这个字段，补 0；两把尺子不能混，混了就分不清"被展示"和"有用"。
           */
          usedCount: 0,
          lastUsedAt: null,
          /**
           * 被**改写**的次数（被 supersedes 取代、或被近似新条目撞上）。
           *
           * 这是比 `usedCount` 更硬的价值信号：`usedCount` 数的是"下一轮又被复述"，
           * 而真实库里它结构性趋零（锚词是中文二元组，用户不会复述我的内部词汇）；
           * `revisedCount` 数的是"这条不够用" —— 被推翻、被解除、被改写成新说法。
           * 一条被改写过的记忆，比一条被复述过的记忆信息量大得多。
           */
          revisedCount: 0,
          lastRevisedAt: null,
          /**
           * 被**想起来**的语境：每次靠检索命中它时，把查询的内容词签名记一条。
           *
           * 为什么要这个：`hits` 只说"被展示了多少次"，说不清**是不是总在同一个话题里**。
           * 一条永远只在同一个问法下被想起来的记忆，等于没迁移；而迁移是这套系统
           * 唯一骗不了人的成长证据 —— 所以得先把它变成可算的东西。
           * 常驻块（约束/槽位/共同经历）没有分数，天然不记：它们每轮都在，谈不上"想起来"。
           */
          contexts: [],
          explicit: false,
          status: 'active',
          archivedAt: null,
          archivedReason: null,
          relaxedAt: null,
          supersedes: [],
          supersededBy: null,
          sessionId: null,
          source: 'tool',
          /** 仅 kind=choice：一次两难里选了哪边。其余 kind 恒为 null。 */
          choice: null,
          ...row,
        })),
      slots: Array.isArray(parsed.slots) ? parsed.slots : [],
      summaries: Array.isArray(parsed.summaries) ? parsed.summaries : [],
      // 边只认形状完整的行：端点非空、权重是正数。半损坏的边静默丢弃 ——
      // 它是派生观测数据，丢了只是少一条连线，不该让整库起不来。
      edges: (Array.isArray(parsed.edges) ? parsed.edges : []).filter(
        (row) =>
          row !== null &&
          typeof row === 'object' &&
          typeof row.a === 'string' &&
          typeof row.b === 'string' &&
          row.a.length > 0 &&
          row.b.length > 0 &&
          row.a !== row.b &&
          Number.isFinite(Number(row.w)) &&
          Number(row.w) > 0 &&
          Number.isFinite(Number(row.at)),
      ).map((row) => ({ a: row.a, b: row.b, w: Number(row.w), at: Number(row.at) })),
      cfgOverrides: parsed.cfgOverrides !== null && typeof parsed.cfgOverrides === 'object' ? parsed.cfgOverrides : {},
      events: Array.isArray(parsed.events) ? parsed.events : [],
      selfNarrative: normalizeNarrative(parsed.selfNarrative),
      self: normalizeSelf(parsed.self),
      recall: parsed.recall && typeof parsed.recall === 'object' ? parsed.recall : base.recall,
      meta: { ...base.meta, ...(parsed.meta ?? {}) },
    };
  }

  /** 原子发布：临时文件 → fsync → rename。 */
  async #persist() {
    this.state.updatedAt = Date.now();
    const body = `${JSON.stringify(this.state, null, 2)}\n`;
    await mkdir(dirname(this.file), { recursive: true });
    const temp = join(dirname(this.file), `.${Date.now().toString(36)}-${randomUUID().slice(0, 8)}.tmp`);
    const handle = await openFile(temp, 'w');
    try {
      await handle.writeFile(body, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await rename(temp, this.file);
    } catch (error) {
      await unlink(temp).catch(() => {});
      throw error;
    }
    // 记下"这次写完之后磁盘长什么样"：没有这个基线，下一次写前的复查会把
    // 我们自己的写入当成"别人改了文件"，于是每次都先丢一遍内存状态。
    await this.#rememberDiskSignature();
  }

  /** 记录磁盘上的 (size, mtimeMs) 签名；拿不到就算了（不要阻断写）。 */
  async #rememberDiskSignature() {
    try {
      const info = await statFile(this.file);
      this.diskSignature = `${info.size}:${Math.round(info.mtimeMs)}`;
    } catch {
      this.diskSignature = undefined;
    }
  }

  /**
   * 写前复查：磁盘若被外部改过（另一个实例、手工编辑、导入、网盘同步），
   * 先把磁盘那份读进来，再让本次写入叠加上去。
   *
   * 为什么只在**写前**做：读路径（每轮注入）里重载会把本轮的召回现场冲掉，
   * 而且读多写少，放读路径等于让每次注入都多一次 stat + 可能的全量 parse。
   *
   * 判据是 size + mtime 双签名，不是内容哈希：2000 条约 4MB，每次写都全量哈希不值得；
   * 代价是"长度与毫秒都恰好相同的外部改动"会漏检 —— 这种概率远低于每次哈希的成本。
   *
   * @returns {Promise<boolean>} 是否真的重载了
   */
  async #syncFromDisk() {
    if (this.cfg.autoReload === false) return false;
    let info;
    try {
      info = await statFile(this.file);
    } catch {
      return false; // 文件被删/读不到：交给本次写入重建，不做重载
    }
    const signature = `${info.size}:${Math.round(info.mtimeMs)}`;
    if (this.diskSignature === undefined) {
      this.diskSignature = signature;
      return false;
    }
    if (signature === this.diskSignature) return false;

    let parsed;
    try {
      parsed = JSON.parse(await readFile(this.file, 'utf8'));
    } catch (error) {
      // 坏文件不静默当空库：保留内存里能用的状态，只留痕，并记住签名免得每次写都重试
      this.#event('store.reload-failed', { message: error instanceof Error ? error.message : String(error) });
      this.diskSignature = signature;
      return false;
    }

    const before = this.state.memories.length;
    this.state = this.#normalizeShape(parsed);
    this.diskSignature = signature;
    this.revision = (this.revision ?? 0) + 1;
    this.corpusCache = undefined;
    this.corpusPostings = undefined;
    this.#event('store.reload', { memories: this.state.memories.length, before });
    return true;
  }

  /** 串行执行一个写事务：读改写不交错，失败不影响后续。 */
  #mutate(fn) {
    const run = this.chain.then(async () => {
      // 先把外部改动并进来，再跑这次事务 —— 否则后写的会把别人的整份库覆盖掉
      await this.#syncFromDisk();
      const result = await fn(this.state);
      // 批量写入期间挂起落盘，由 writeMany 在最后统一落一次 ——
      // 一次 atomic write 就是 tmp+fsync+rename，写 20 条落 20 次纯属浪费。
      // 任何变更都让语料缓存失效（检索按需重建，平时命中缓存）
      this.revision = (this.revision ?? 0) + 1;
      if ((this.persistHold ?? 0) === 0) await this.#persist();
      return result;
    });
    this.chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /** 追加一条机制埋点；自身绝不抛（埋点坏了不能影响主流程）。 */
  #event(kind, payload) {
    try {
      this.state.events.push({ ts: Date.now(), kind, payload: payload ?? {} });
      const overflow = this.state.events.length - this.cfg.eventsKeep;
      if (overflow > 0) this.state.events.splice(0, overflow);
    } catch {
      /* 埋点失败静默 */
    }
  }

  /** 当前活跃记忆（含 relaxed 的约束：它们还在活跃集里留档）。 */
  active() {
    return this.state.memories.filter((row) => row.status === 'active');
  }

  /** 已归档（软删）记忆。 */
  archived() {
    return this.state.memories.filter((row) => row.status === 'archived');
  }

  /** 按 id 取一条（含归档）。 */
  byId(id) {
    return this.state.memories.find((row) => row.id === id);
  }

  /**
   * 写入一条记忆，走完整治理链：
   * 查重 → 作废/解除旧条目 → 落库 → 容量淘汰 → 归档修剪。
   *
   * @param {object} input kind/text/entity/attr/scene/significance/supersedes/explicit/sessionId/source
   * @returns {Promise<{id: string|null, kind: string, status: 'created'|'deduped'|'superseded-only', notes: string[], archived: string[], relaxed: string[]}>}
   */
  async write(input) {
    const normalized = normalizeInput(input, this.cfg);
    const supersedes = Array.isArray(input.supersedes) ? input.supersedes.map(String) : [];
    const explicit = input.explicit === true || input.source === 'explicit';
    const sessionId = input.sessionId == null ? null : String(input.sessionId);
    const notes = [];

    return this.#mutate(async () => {
      const now = Date.now();

      // ① 状态槽位是覆盖式写入，不参与查重与淘汰。
      if (normalized.kind === 'slot') {
        const existing = this.state.slots.find((row) => row.entity === normalized.entity && row.attr === normalized.attr);
        if (existing === undefined) {
          this.state.slots.push({
            id: randomUUID(),
            entity: normalized.entity,
            attr: normalized.attr,
            value: normalized.text,
            createdAt: now,
            updatedAt: now,
            sessionId,
          });
          this.#event('slot.create', { entity: normalized.entity, attr: normalized.attr });
          notes.push(`新建状态槽位 ${normalized.entity}·${normalized.attr}`);
        } else {
          if (existing.value !== normalized.text) notes.push(`旧值「${existing.value}」被覆盖`);
          existing.value = normalized.text;
          existing.updatedAt = now;
          existing.sessionId = sessionId ?? existing.sessionId;
          this.#event('slot.update', { entity: normalized.entity, attr: normalized.attr });
        }
        return { id: existing?.id ?? this.state.slots.at(-1).id, kind: 'slot', status: 'created', notes, archived: [], relaxed: [] };
      }

      // ② 查重：同 kind 的活跃条目里找近似句，命中就只加命中数。
      //
      // 例外：`choice` 不做查重。取舍是**事件**不是事实 —— 同一个两难里选同一边，
      // 选十次就是十次；去重之后"频次"就没了，而频次正是性格唯一的度量。
      // 在这件事上查重不是节省，是把证据吃掉。
      const skipDedupe = normalized.kind === 'choice';
      let best = null;
      // 长度预筛：相似度 = 0.5*Jaccard + 0.5*containment，上界是 0.5 + 0.5*(短/长)。
      // 长度差 2.5 倍以上时上界已低于 0.72，没必要做分词比对 —— 库大了这条能省一大截。
      const probeLength = normalized.text.length;
      // 倒排索引预筛：只有和新文本共享至少一个词的条目才可能近似。
      // 2000 条规模下这一步把"逐条比对"变成"几十条比对"。
      const probeTokens = tokenize(normalized.text);
      // 倒排索引按需建一次，之后靠写入时增量补充 —— 不能每次写都重建，
      // 那样 2000 条库每写一条就要多付 20ms。
      if (this.corpusPostings === undefined) {
        this.corpusPostings = buildCorpus(this.state.memories.map((row) => ({ id: row.id, text: row.text }))).postings;
      }
      const candidateIds = new Set();
      for (const token of probeTokens) {
        const bucket = this.corpusPostings?.get(token);
        if (bucket === undefined) continue;
        for (const id of bucket) candidateIds.add(id);
      }
      const scanRows = skipDedupe
        ? []
        : candidateIds.size > 0
          ? this.state.memories.filter((row) => candidateIds.has(row.id))
          : this.state.memories;
      for (const row of scanRows) {
        if (row.status !== 'active' || row.kind !== normalized.kind) continue;
        const rowLength = String(row.text ?? '').length;
        const ratio = Math.min(probeLength, rowLength) / Math.max(probeLength, rowLength, 1);
        if (ratio < 0.4) continue;
        const score = similarity(normalized.text, row.text);
        if (best === null || score > best.score) best = { row, score };
      }
      /**
       * 把"最像的那条"先留住，再让查重逻辑去清理它。
       *
       * 为什么要在 `best = null` 之前抓一份：查重判据里有两条会**故意**放弃合并 ——
       * 极性相反、编号不同。而这两种恰恰是最该记成"被改写"的场景
       * （「喜欢深色」被「不喜欢深色了，改成浅色」推翻，相似度 0.74）。
       * 丢了这份引用，最有力的证伪样本正好全漏掉。
       */
      const nearest = best;
      // 相似度够高只是必要条件：极性（有/无否定）或编号不同，一律不合并
      if (best !== null && best.score >= this.cfg.dedupeThreshold && !isSameClaim(normalized.text, best.row.text)) {
        best = null;
      }
      if (best !== null && best.score >= this.cfg.dedupeThreshold) {
        // 查重命中 = 同一件事又说了一遍，算加强，不算改写：它没推翻任何东西。
        best.row.hits = (best.row.hits ?? 0) + 1;
        best.row.updatedAt = now;
        this.state.meta.dedupeCount += 1;
        this.#event('write.dedup', { id: best.row.id, score: Number(best.score.toFixed(3)), kind: normalized.kind });
        return {
          id: best.row.id,
          kind: normalized.kind,
          status: 'deduped',
          notes: [`与已有条目重复（相似度 ${best.score.toFixed(2)}），只累加命中`],
          archived: [],
          relaxed: [],
        };
      }

      const row = {
        id: randomUUID(),
        kind: normalized.kind,
        text: normalized.text,
        actor: normalized.actor,
        scene: normalized.scene ?? null,
        significance: normalized.significance ?? null,
        /** 仅 kind=choice：{ a, b, picked }。性格读的是 picked 的分布。 */
        choice: normalized.choice ?? null,
        eventDate: input.eventDate === null ? null : (input.eventDate ?? findEventDate(normalized.text)),
        hits: 0,
        usedCount: 0,
        revisedCount: 0,
        contexts: [],
        explicit,
        status: 'active',
        createdAt: now,
        updatedAt: now,
        lastHitAt: null,
        lastUsedAt: null,
        lastRevisedAt: null,
        archivedAt: null,
        archivedReason: null,
        relaxedAt: null,
        supersedes,
        supersededBy: null,
        sessionId,
        source: input.source === 'explicit' ? 'explicit' : 'tool',
      };

      // ③ 作废/解除：约束走「解除」留档，其余软删归档。两种都算「被改写」。
      const archived = [];
      const relaxed = [];
      for (const targetId of supersedes) {
        const target = this.byId(targetId);
        if (target === undefined || target.status !== 'active') continue;
        target.revisedCount = (target.revisedCount ?? 0) + 1;
        target.lastRevisedAt = now;
        if (target.kind === 'constraint') {
          target.relaxedAt = now;
          target.updatedAt = now;
          relaxed.push(target.id);
        } else {
          target.status = 'archived';
          target.archivedAt = now;
          target.archivedReason = 'superseded';
          target.supersededBy = row.id;
          archived.push(target.id);
        }
      }
      if (relaxed.length > 0) {
        this.state.meta.relaxCount += relaxed.length;
        this.#event('constraint.relax', { ids: relaxed });
        notes.push(`解除 ${relaxed.length} 条旧约束（保留留档，不再当禁令）`);
      }
      if (archived.length > 0) {
        this.state.meta.archiveCount += archived.length;
        this.#event('memory.supersede', { by: row.id, ids: archived });
        notes.push(`作废 ${archived.length} 条被推翻的旧条目`);
      }

      // ④ 先落库，再谈淘汰 —— 顺序反了会出现「旧的没了、新的也没写下」的空窗。
      this.state.memories.push(row);
      this.#indexRow(row);
      this.state.meta.writeCount += 1;
      this.#event('write.create', { id: row.id, kind: row.kind, explicit, supersedes: supersedes.length });
      if (looksLikeChange(row.text) && supersedes.length === 0) {
        /**
         * 没有显式 `supersedes`，但这句话在讲"换了/改成/不再"。
         * 如果附近真有一条长得像的旧条目，就当**它**被改写了 —— 这是本插件唯一的
         * 「旧条目不够用」证据来源，不记下来就白丢了。
         *
         * 门槛借用 `searchThreshold`（0.34）而不是 0.72：0.72 是"同一件事"，
         * 而改写标志的是"同一件事的不同版本"，版本之间本来就不会那么像。
         */
        const anchor = nearest !== null && nearest.score >= this.cfg.searchThreshold ? nearest : null;
        if (anchor !== null) {
          anchor.row.revisedCount = (anchor.row.revisedCount ?? 0) + 1;
          anchor.row.lastRevisedAt = now;
          notes.push(
            `这条带状态变化口吻，最像的旧条目是「${String(anchor.row.text).slice(0, 16)}…」，已记为被改写；` +
              '如果确实是它，请用 supersedes 指定那条的 id',
          );
          this.#event('write.change-hint', {
            id: row.id,
            targetId: anchor.row.id,
            score: Number(anchor.score.toFixed(3)),
          });
        } else {
          notes.push('这条带状态变化口吻：如果它取代了某条旧记忆，请用 supersedes 指定那条的 id');
          this.#event('write.change-hint', { id: row.id });
        }
      }

      // ④.5 约束写入前的同根因体检：只提示，不改行为。
      // 约束是**每轮无条件注入**的，所以它增长的代价是永久的；让它默认走「合并」而不是「追加」。
      if (row.kind === 'constraint') {
        const sibling = this.#sameRootSibling(row);
        if (sibling !== null) {
          this.#event('constraint.same-root', {
            id: row.id,
            targetId: sibling.row.id,
            score: Number(sibling.score.toFixed(3)),
          });
          notes.push(
            `这条和已有约束「${String(sibling.row.text).slice(0, 16)}…」同根因（相似度 ${sibling.score.toFixed(2)}）：` +
              '建议合并进那一条、或写一条把两者都包住的原理，而不是新增 —— 约束每轮都要付这笔钱',
          );
        }
      }

      // ⑤a world 自己的上限（它豁免容量淘汰，但也不能无限长）
      const worldEvicted = this.#evictWorld(now);
      if (worldEvicted.length > 0) notes.push(`world 超出上限，归档 ${worldEvicted.length} 条最久没用的设定`);

      // ⑤b 主动压缩：到 compactAt 就把同主题冗余归纳成摘要，而不是等撑到硬上限
      const compacted = this.#compact(now);
      if (compacted.summaries > 0) {
        notes.push(`归纳了 ${compacted.summaries} 组同主题记忆（归档 ${compacted.members} 条，可追溯）`);
      }

      // ⑤c 容量淘汰：只动可淘汰集合，删不够就显式说。
      const evicted = this.#evict(now);
      if (evicted.length > 0) notes.push(`超出容量，归档 ${evicted.length} 条权重最低的旧记忆`);

      // ⑥ 归档上限修剪。
      const trimmed = await this.#trimArchive();
      if (trimmed > 0) notes.push(`归档超出上限，物理删除最老的 ${trimmed} 条`);

      return { id: row.id, kind: row.kind, status: 'created', notes, archived, relaxed };
    });
  }

  /** 活跃集超出上限时淘汰权重最低的可淘汰条目（world/constraint/explicit 不动）。 */
  /** world 超上限时归档权重最低的（explicit 豁免）。 */
  #evictWorld(now) {
    const worlds = this.active().filter((row) => row.kind === 'world');
    const overflow = worlds.length - this.cfg.maxWorld;
    if (overflow <= 0) return [];
    const doomed = worlds
      .filter((row) => row.explicit !== true)
      .sort((left, right) => weightOf(left, now, this.cfg.halfLifeDays) - weightOf(right, now, this.cfg.halfLifeDays))
      .slice(0, overflow);
    const evicted = [];
    for (const row of doomed) {
      row.status = 'archived';
      row.archivedAt = now;
      row.archivedReason = 'world-capacity';
      evicted.push(row.id);
    }
    if (evicted.length > 0) {
      this.state.meta.archiveCount += evicted.length;
      this.#event('world.evict', { count: evicted.length });
    }
    return evicted;
  }

  /**
   * 主动压缩：把同主题的一堆条目归纳成一条摘要，原条目转归档。
   *
   * 与 #evict 的区别：#evict 是「丢掉最不重要的」，这里是「把冗余压成一条」。
   * 前者会损失信息，后者只是把已说过的同类结论合并，且原文在归档里可追溯。
   */
  #compact(now) {
    const result = { summaries: 0, members: 0 };
    const compactAt = this.cfg.compactAt ?? 0;
    if (compactAt <= 0) return result;
    const active = this.active();
    if (active.length < compactAt) return result;
    if (this.state.summaries.length >= this.cfg.maxSummaries) return result;

    // 冷却：压缩本身要遍历全库，不能每写一条就跑一遍。
    // 距上次压缩不到 60 秒、或活跃条数没再涨 80 条，就先不动。
    const guard = this.compactGuard ?? { activeAt: 0, at: 0 };
    if (active.length - guard.activeAt < 80 && now - guard.at < 60_000) return result;
    this.compactGuard = { activeAt: active.length, at: now };

    // 只归纳可淘汰种类：constraint / slot 是硬信息，不能进摘要
    const evictable = active
      .filter((row) => EVICTABLE.has(row.kind) && row.explicit !== true)
      .sort((left, right) => weightOf(right, now, this.cfg.halfLifeDays) - weightOf(left, now, this.cfg.halfLifeDays));
    // 只归纳"尾部"：权重最高的那一截保持活跃。
    // 否则一次压缩会把「用户偏好 X」这种核心事实也一起吸进摘要，原文变归档。
    const keepRatio = Math.min(0.8, Math.max(0, this.cfg.compactKeepRatio ?? 0.3));
    const keepHead = Math.floor(evictable.length * keepRatio);
    const candidates = evictable
      .slice(keepHead, keepHead + (this.cfg.summarySampleLimit ?? 800))
      .map((row) => ({ id: row.id, text: row.text, kind: row.kind }));
    if (candidates.length < (this.cfg.summaryMinMembers ?? 6)) return result;

    const plans = planSummaries(candidates, {
      minSize: this.cfg.summaryMinMembers ?? 6,
      points: this.cfg.summaryPoints ?? 4,
      maxLength: this.cfg.maxTextLength,
      clusterLimit: this.cfg.summaryClusterLimit ?? 4,
    });
    for (const plan of plans) {
      const summaryId = randomUUID();
      const doomed = new Set(plan.memberIds);
      let archivedCount = 0;
      for (const row of this.state.memories) {
        if (!doomed.has(row.id) || row.status !== 'active') continue;
        row.status = 'archived';
        row.archivedAt = now;
        row.archivedReason = 'summarized';
        row.summarizedBy = summaryId;
        archivedCount += 1;
      }
      if (archivedCount === 0) continue;
      this.state.summaries.push({
        id: summaryId,
        sessionId: null,
        topic: plan.topic,
        text: plan.text,
        memberIds: plan.memberIds,
        memberCount: archivedCount,
        createdAt: now,
        source: 'compact',
        // 先标成抽取式：模型重写要是有结果，再改成 llm —— 降级路径必须是"已经能用"的那条
        generator: 'extractive',
      });
      this.#event('summary.compact', { id: summaryId, topic: plan.topic, members: archivedCount });
      // 交给上层异步增强（不在这里 await，写入路径绝不等待模型）
      if (typeof this.summaryEnhancer === 'function' && (this.cfg.useLlmSummary ?? true)) {
        try {
          this.summaryEnhancer({
            id: summaryId,
            topic: plan.topic,
            text: plan.text,
            points: Array.isArray(plan.points) ? plan.points : [],
          });
        } catch {
          // 增强器自己报错不该影响写入
        }
      }
      result.summaries += 1;
      result.members += archivedCount;
    }
    if (result.summaries > 0) {
      // 摘要自身也有上限：超了丢最老的（成员留在归档里，不会丢）
      const overflow = this.state.summaries.length - this.cfg.maxSummaries;
      if (overflow > 0) this.state.summaries = this.state.summaries.slice(overflow);
      this.state.meta.archiveCount += result.members;
    }
    return result;
  }

  #evict(now) {
    const active = this.active();
    const overflow = active.length - this.cfg.maxActiveMemories;
    if (overflow <= 0) return [];
    const candidates = active
      .filter((row) => EVICTABLE.has(row.kind) && row.explicit !== true)
      .sort((left, right) => weightOf(left, now, this.cfg.halfLifeDays) - weightOf(right, now, this.cfg.halfLifeDays));
    const evicted = [];
    for (const row of candidates.slice(0, overflow)) {
      row.status = 'archived';
      row.archivedAt = now;
      row.archivedReason = 'capacity';
      evicted.push(row.id);
    }
    if (evicted.length > 0) {
      this.state.meta.archiveCount += evicted.length;
      this.#event('memory.evict', { ids: evicted, overflow, evicted: evicted.length });
    }
    if (evicted.length !== overflow) {
      // 上限达不成必须显式：这条在「旧识」里也是 WARNING 而不是静默。
      this.#event('memory.evict-shortfall', { overflow, evicted: evicted.length });
    }
    return evicted;
  }

  /**
   * 破坏性操作前留一份备份。
   *
   * 归档修剪是真删（不可恢复），而 store.json 是单文件 —— 一次误判或断电就没了。
   * 这里在物理删除前复制一份带时间戳的副本，保留最近 `backupKeep` 份；
   * 有冷却，避免每次写入都写盘。
   *
   * @param {string} reason
   */
  async #backup(reason, force = false) {
    const interval = this.cfg.backupIntervalMs ?? 600_000;
    const now = Date.now();
    if (!force && this.lastBackupAt !== undefined && now - this.lastBackupAt < interval) return;
    this.lastBackupAt = now;
    try {
      const stamp = new Date(now).toISOString().replace(/[:.]/g, '-');
      const target = `${this.file}.bak-${stamp}`;
      await copyFile(this.file, target);
      const dir = dirname(this.file);
      const prefix = `${this.file.split(/[\\/]/).pop()}.bak-`;
      const backups = (await readdir(dir)).filter((name) => name.startsWith(prefix)).sort();
      const keep = this.cfg.backupKeep ?? 3;
      for (const stale of backups.slice(0, Math.max(0, backups.length - keep))) {
        await unlink(join(dir, stale)).catch(() => {});
      }
      this.#event('store.backup', { reason, file: target.split(/[\\/]/).pop() });
    } catch (error) {
      // 备份失败不阻断主流程，但要留痕
      this.#event('store.backup-failed', { reason, message: error instanceof Error ? error.message : String(error) });
    }
  }

  /** 归档超过上限时物理删除最老的。 */
  async #trimArchive() {
    const archived = this.archived().sort((left, right) => (left.archivedAt ?? 0) - (right.archivedAt ?? 0));
    const overflow = archived.length - this.cfg.maxArchive;
    if (overflow <= 0) return 0;
    // 真删之前先留一份备份：单文件库，一次误判就没法回头了。
    await this.#backup('trim-archive');
    const doomed = new Set(archived.slice(0, overflow).map((row) => row.id));
    this.state.memories = this.state.memories.filter((row) => !doomed.has(row.id));
    this.#event('archive.trim', { count: doomed.size });
    return doomed.size;
  }

  /**
   * 软删归档；`hard` 为真时物理删除（只给明确的遗忘意图用）。
   * @param {string} id
   * @param {{reason?: string, hard?: boolean}} [options]
   */
  async forget(id, options = {}) {
    const reason = options.reason ?? 'explicit';
    const hard = options.hard === true;
    return this.#mutate(async () => {
      const row = this.byId(String(id));
      if (row === undefined) return { found: false, hard };
      if (hard) {
        this.state.memories = this.state.memories.filter((candidate) => candidate.id !== row.id);
        this.state.meta.forgetCount += 1;
        this.#event('memory.forget', { id: row.id, hard: true, kind: row.kind });
        return { found: true, hard };
      }
      row.status = 'archived';
      row.archivedAt = Date.now();
      row.archivedReason = reason;
      this.state.meta.archiveCount += 1;
      this.#event('memory.archive', { id: row.id, reason, kind: row.kind });
      // 归档上限是恒定不变式：手工归档也要修剪，不能只靠下一次写入。
      await this.#trimArchive();
      return { found: true, hard };
    });
  }

  /**
   * 批量写入：逐条走同一套治理（查重/取代/淘汰），但**只落盘一次**。
   *
   * @param {Array<object>} inputs
   * @returns {Promise<Array<object>>} 每条的结果，顺序与输入一致
   */
  async writeMany(inputs) {
    const list = Array.isArray(inputs) ? inputs : [];
    if (list.length === 0) return [];
    this.persistHold = (this.persistHold ?? 0) + 1;
    const results = [];
    try {
      for (const input of list) {
        results.push(await this.write(input));
      }
    } finally {
      this.persistHold = Math.max(0, (this.persistHold ?? 1) - 1);
    }
    // 统一落一次（走 #mutate 保证与其它写入串行）
    await this.#mutate(async () => undefined);
    return results;
  }

  /**
   * 用模型重写过的文本替换摘要（抽取式 → 模型式）。
   *
   * 只在模型真的给出可用文本时调用；任何失败都不该走到这里 ——
   * 摘要必须永远有一条能用的文本，不能因为"模型没回"变成空壳。
   *
   * @param {string} summaryId
   * @param {string} text
   * @returns {Promise<boolean>}
   */
  async rewriteSummary(summaryId, text) {
    const clean = String(text ?? '').trim();
    if (clean.length === 0) return false;
    return this.#mutate(async () => {
      const row = this.state.summaries.find((item) => item.id === String(summaryId));
      if (row === undefined) return false;
      row.text = clean.slice(0, this.cfg.maxTextLength * 2);
      row.generator = 'llm';
      row.rewrittenAt = Date.now();
      this.#event('summary.rewrite', { id: row.id, chars: clean.length });
      return true;
    });
  }

  /** 记录一次增强失败（只留痕，不改数据）。 */
  async markSummaryFailure(summaryId, message) {
    return this.#mutate(async () => {
      const row = this.state.summaries.find((item) => item.id === String(summaryId));
      if (row === undefined) return false;
      row.llmError = String(message ?? '').slice(0, 200);
      this.#event('summary.rewrite-failed', { id: row.id, message: row.llmError });
      return true;
    });
  }

  /**
   * 恢复一条归档记忆。
   *
   * 为什么需要：摘要归纳是**自动**的，判断偶尔会错；一旦归纳错，原文只能在归档里躺着，
   * 没有一键回来的路就等于真丢了。恢复时把 updatedAt 推到当前时刻，
   * 否则它带着旧权重会被下一次淘汰立刻挑中，等于没恢复。
   *
   * @param {string} id
   * @returns {Promise<{found: boolean, restored: boolean, reason?: string}>}
   */
  async restore(id) {
    return this.#mutate(async () => {
      const row = this.byId(String(id));
      if (row === undefined) return { found: false, restored: false, reason: 'not-found' };
      if (row.status === 'active') return { found: true, restored: false, reason: 'already-active' };
      const summaryId = row.summarizedBy;
      row.status = 'active';
      row.archivedAt = null;
      row.archivedReason = null;
      row.summarizedBy = null;
      row.updatedAt = Date.now();
      // 单条恢复也要从摘要里摘掉，否则摘要声称覆盖 N 条、实际只剩 N-1，
      // 面板「查看原文」的数字会对不上。
      if (summaryId !== null && summaryId !== undefined) {
        const summary = this.state.summaries.find((item) => item.id === summaryId);
        if (summary !== undefined) {
          if (Array.isArray(summary.memberIds)) summary.memberIds = summary.memberIds.filter((id) => id !== row.id);
          summary.memberCount = Math.max(0, (summary.memberCount ?? 1) - 1);
        }
      }
      // 恢复本身就是一次"用到"，给一点权重，避免刚回来又被淘汰
      row.hits = (row.hits ?? 0) + 1;
      row.lastHitAt = Date.now();
      this.#event('memory.restore', { id: row.id, kind: row.kind });
      return { found: true, restored: true };
    });
  }

  /**
   * 撤销一整条摘要：恢复它覆盖的全部成员，并删掉这条摘要。
   * 用于「这组归纳错了」的整组回退。
   *
   * @param {string} summaryId
   * @returns {Promise<{found: boolean, restored: number}>}
   */
  async restoreSummary(summaryId) {
    return this.#mutate(async () => {
      const index = this.state.summaries.findIndex((row) => row.id === String(summaryId));
      if (index < 0) return { found: false, restored: 0 };
      const summary = this.state.summaries[index];
      const memberIds = new Set(Array.isArray(summary.memberIds) ? summary.memberIds : []);
      let restored = 0;
      const now = Date.now();
      for (const row of this.state.memories) {
        if (!memberIds.has(row.id) || row.status === 'active') continue;
        row.status = 'active';
        row.archivedAt = null;
        row.archivedReason = null;
        row.summarizedBy = null;
        row.updatedAt = now;
        row.hits = (row.hits ?? 0) + 1;
        row.lastHitAt = now;
        restored += 1;
      }
      this.state.summaries.splice(index, 1);
      this.#event('summary.restore', { id: summary.id, restored });
      return { found: true, restored };
    });
  }

  /**
   * 导出整库为 JSON 文本（面板「导出」用）。
   *
   * 导出的就是磁盘上那份形状 —— 不做另一套备份格式：这个文件既能当备份，
   * 也能原样丢回来导入，出问题时不至于还要「先把格式转一下」。
   *
   * @returns {Promise<string>}
   */
  async exportJson() {
    return `${JSON.stringify(this.state, null, 2)}\n`;
  }

  /**
   * 导入一整份库（面板「导入」用）：整体替换。
   *
   * 替换是危险动作，所以三条护栏：
   * ① 先过 `#normalizeShape` —— 结构不对直接抛，现有数据一个字都不碰；
   * ② 空库拒绝覆盖（误传个空文件不该把记忆清空）；
   * ③ 落盘前**强制**备份一份（不受 #backup 的 10 分钟冷却限制）。
   *
   * @param {string|object} input
   * @returns {Promise<{ok: boolean, memories: number, summaries: number}>}
   */
  async importJson(input) {
    let parsed = input;
    if (typeof input === 'string') {
      try {
        parsed = JSON.parse(input);
      } catch (error) {
        throw new Error(`不是合法的 JSON：${error instanceof Error ? error.message : String(error)}`);
      }
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('导入内容必须是一个对象');
    }
    if (!Array.isArray(parsed.memories)) throw new Error('导入内容缺少 memories 数组');
    const next = this.#normalizeShape(parsed);
    if (next.memories.length === 0) throw new Error('导入的记忆库是空的，已拒绝覆盖');
    await this.#backup('import', true);
    return this.#mutate(() => {
      next.updatedAt = Date.now();
      this.state = next;
      // 导入的老库同样要迁：自我叙事拆成原理，别让「人格」页读到一片空白
      this.#migrateSelf();
      // 语料缓存与倒排索引都指向旧库：一起丢掉，下次检索按新 revision 重建
      this.corpusCache = undefined;
      this.corpusPostings = undefined;
      this.#event('store.import', { memories: next.memories.length, summaries: next.summaries.length });
      return { ok: true, memories: next.memories.length, summaries: next.summaries.length };
    });
  }

  /**
   * 过程记录整理：把 changelog 式条目（「v0.30.1 修…」「写入机制 v0.19.0：…」）批量归档。
   *
   * 为什么需要：这类条目会随开发自己长出来 —— 它们记的是「哪一版改了什么」，
   * 对「现在怎么定」没价值，却占着活跃名额、稀释召回。
   * 但过程也可能日后要查，所以只**归档**（`reason: bulk-log`，随时可单条恢复），不删。
   *
   * 两条硬约束：只动可淘汰种类（fact / self / episode）、`explicit`（用户亲口说的）一条都不碰。
   *
   * @param {{apply?: boolean}} [options] `apply:false` 只预览，不改数据
   * @returns {Promise<{ok: boolean, dryRun: boolean, count: number, preview: Array<{id: string, text: string}>, archived?: number}>}
   */
  async tidyProcessLogs(options = {}) {
    const apply = options.apply === true;
    const candidates = this.active().filter(
      (row) => EVICTABLE.has(row.kind) && row.explicit !== true && looksLikeProcessLog(row.text),
    );
    const preview = candidates.slice(0, 5).map((row) => ({ id: row.id, text: row.text }));
    if (!apply || candidates.length === 0) {
      return { ok: true, dryRun: !apply, count: candidates.length, preview };
    }
    return this.#mutate(() => {
      const now = Date.now();
      for (const row of candidates) {
        row.status = 'archived';
        row.archivedAt = now;
        row.archivedReason = 'bulk-log';
        row.updatedAt = now;
      }
      this.state.meta.archiveCount += candidates.length;
      this.#event('memory.tidy', { archived: candidates.length });
      return { ok: true, dryRun: false, count: candidates.length, preview, archived: candidates.length };
    });
  }

  /**
   * 「从未被想起」的候选：够老、可淘汰、一次都没被召回过的条目。
   *
   * 为什么需要：真实库体检里 84 条活跃有 42% 的 `hits = 0` —— 它们占着活跃名额、
   * 稀释召回，却从来没帮上忙。
   *
   * 为什么**不自动删**：`hits` 是**曝光**信号（被注入才算），不是价值信号。
   * 一条从没被召回的记忆可能是"写得很好、只是还没遇到对的问题"。
   * 判错的代价是丢掉一条本来有用的结论，判对的收益只是省一点上下文 ——
   * 所以这里只出**候选清单**，动不动由人决定，且只归档可恢复。
   *
   * 判据里最要紧的是**分档门槛**（见 `UNUSED_DAYS`）：
   * - `fact` / `self` 满 7 天没被召回就算候选；
   * - `world` 要满 30 天 —— 它里面既有"某次排查的根因"这种过程知识，也有真正的长期设定，
   *   而"没被召回"对后者说明不了什么；
   * - `episode` / `constraint` / `slot` 永不入选：不可再生，或者 `hits` 的语义与别的层不同。
   * 拿曝光信号去删这几类，是最典型的误杀。
   *
   * @param {{olderThanDays?: number}} [options] 显式给天数则覆盖分档（测试与面板手动清理用）
   * @returns {Array<object>}
   */
  unusedCandidates(options = {}) {
    const override = Number.isFinite(options.olderThanDays) ? Math.max(0, options.olderThanDays) : null;
    const now = Date.now();
    return this.active().filter((row) => {
      const days = override ?? UNUSED_DAYS[row.kind];
      if (days === undefined) return false;
      return (
        row.explicit !== true &&
        (row.hits ?? 0) === 0 &&
        (row.usedCount ?? 0) === 0 &&
        (row.supersededBy ?? null) === null &&
        (row.createdAt ?? 0) < now - days * 86_400_000
      );
    });
  }

  /**
   * 整理「从未被想起」的条目：先预览，确认后批量归档（`reason: unused`，可单条恢复）。
   *
   * @param {{apply?: boolean, olderThanDays?: number}} [options] 不给天数就按 `UNUSED_DAYS` 分档
   * @returns {Promise<{ok: boolean, dryRun: boolean, count: number, preview: Array<{id: string, text: string}>, archived?: number}>}
   */
  async tidyUnused(options = {}) {
    const apply = options.apply === true;
    const olderThanDays = Number.isFinite(options.olderThanDays) ? Math.max(0, options.olderThanDays) : undefined;
    const candidates = this.unusedCandidates(olderThanDays === undefined ? {} : { olderThanDays });
    const preview = candidates.slice(0, 5).map((row) => ({ id: row.id, text: row.text }));
    /**
     * 还没到期的那些。
     *
     * 面板必须能回答"为什么是 0 条" —— 库还年轻的时候（真实库才两天）候选必然是 0，
     * 如果只回一个 0，按钮点下去就像坏了（"共鸣"那次就是这么被当成没反应的）。
     */
    const now = Date.now();
    const never = this.active().filter(
      (row) =>
        UNUSED_DAYS[row.kind] !== undefined &&
        row.explicit !== true &&
        (row.hits ?? 0) === 0 &&
        (row.usedCount ?? 0) === 0,
    );
    let soonest = null;
    for (const row of never) {
      const wait = UNUSED_DAYS[row.kind] - (now - (row.createdAt ?? 0)) / 86_400_000;
      if (wait > 0 && (soonest === null || wait < soonest)) soonest = wait;
    }
    const stats = {
      /** 从没被想起、且属于"会到期"的那几类 */
      never: never.length,
      /** 其中已经满门槛、现在就能清的 */
      ready: candidates.length,
      /** 最早还有几天到期（全部到期时为 0，够不着为 null） */
      soonestInDays: soonest === null ? (never.length > 0 ? 0 : null) : Math.ceil(soonest),
    };
    if (!apply || candidates.length === 0) {
      return { ok: true, dryRun: !apply, count: candidates.length, preview, stats };
    }
    const ids = candidates.map((row) => row.id);
    return this.#mutate(() => {
      const now = Date.now();
      let archived = 0;
      for (const id of ids) {
        // 按 id 重新取：写前可能刚从磁盘并进来一份更新过的状态，旧引用会失效
        const row = this.byId(id);
        if (row === undefined || row.status !== 'active') continue;
        row.status = 'archived';
        row.archivedAt = now;
        row.archivedReason = 'unused';
        row.updatedAt = now;
        archived += 1;
      }
      if (archived > 0) {
        this.state.meta.archiveCount += archived;
        this.#event('memory.tidy-unused', { archived });
      }
      return { ok: true, dryRun: false, count: archived, preview, stats, archived };
    });
  }

  /** 解除一条约束（保留留档，不当禁令）。 */
  async relax(id) {
    return this.#mutate(() => {
      const row = this.byId(String(id));
      if (row === undefined || row.kind !== 'constraint' || row.status !== 'active') return { found: false };
      row.relaxedAt = Date.now();
      row.updatedAt = Date.now();
      this.state.meta.relaxCount += 1;
      this.#event('constraint.relax', { ids: [row.id], manual: true });
      return { found: true };
    });
  }

  /**
   * 批量累加命中（只记"被召回了一次"，不建关系）。
   *
   * 召回路径实际用的是 `coRecall()` —— 它做同一件事，外加把这一批记成共激活关系，
   * 而且只落一次盘。`touch` 留给"只想加命中、不关心关系"的调用方（例如回放工具）。
   */
  async touch(ids) {
    if (!Array.isArray(ids) || ids.length === 0) return;
    return this.#mutate(() => {
      const now = Date.now();
      for (const id of ids) {
        const row = this.byId(String(id));
        if (row === undefined) continue;
        row.hits = (row.hits ?? 0) + 1;
        row.lastHitAt = now;
      }
    });
  }

  /**
   * 一轮召回落地：累加命中，并把这批 id 记成「一起被想起来过」。
   *
   * 为什么合成一个方法：命中和共激活说的是同一件事（这一轮这几条被一起注入了），
   * 分两次调用就会落两次盘 —— 每次落盘都是一整份 JSON 的字符串化 + fsync + rename。
   *
   * 参与配对的只有**检索命中且非弱相关**的条目（调用方用 `hit.score` 是否数字来筛）。
   * 常驻块（约束 / 槽位 / 共同经历）每轮都注入，和所有东西都共现，
   * 放进来会让图塌成以约束为中心的星形 —— 那等于没有结构。
   *
   * @param {string[]} ids 本轮一起被召回的记忆 id
   * @returns {Promise<{pairs: number, created: number, updated: number, pruned: number}>}
   */
  async coRecall(ids) {
    const list = Array.isArray(ids) ? ids : [];
    return this.#mutate(() => {
      const now = Date.now();
      for (const id of list) {
        const row = this.byId(String(id));
        if (row === undefined) continue;
        row.hits = (row.hits ?? 0) + 1;
        row.lastHitAt = now;
      }
      if (this.cfg.coActivate === false || list.length < 2) return { pairs: 0, created: 0, updated: 0, pruned: 0 };
      const stat = coActivate(this.state.edges, list, {
        now,
        halfLifeDays: this.cfg.halfLifeDays,
        fanout: this.cfg.edgeFanout,
      });
      const pruned = pruneEdges(this.state.edges, {
        now,
        halfLifeDays: this.cfg.halfLifeDays,
        minWeight: this.cfg.edgeMinWeight,
        maxDegree: this.cfg.edgeMaxDegree,
        maxEdges: this.cfg.edgeMaxEdges,
        // 物理删除过的记忆，它的边没有意义：留着只会占着额度
        alive: (id) => this.byId(id) !== undefined,
      });
      this.state.edges = pruned.edges;
      if (stat.created > 0 || stat.updated > 0) {
        this.#event('edge.coactivate', { pairs: stat.pairs, created: stat.created, updated: stat.updated, pruned: pruned.dropped });
      }
      return { ...stat, pruned: pruned.dropped };
    });
  }

  /** 记录一次召回现场（面板的「召回轨迹」）。 */
  async recordRecall(snapshot) {
    return this.#mutate(() => {
      this.state.recall = { last: snapshot, count: (this.state.recall?.count ?? 0) + 1 };
      /**
       * 迁移痕迹：这一轮**靠检索想起来**的每条记忆，记下"是在什么语境里想起来的"。
       *
       * 只认有分数的命中：常驻块（约束/槽位/共同经历）每轮都在，谈不上被想起来，
       * 记了只会让"语境"变成"所有话题"，一个永远满格的假信号。
       *
       * 为什么不单独写一次盘：这个函数每轮都跑，再开一次 atomic write 就是白付。
       * 挤在同一次落盘里，代价是零。
       */
      const contextTokens = Array.isArray(snapshot?.gate?.list) ? snapshot.gate.list : [];
      if (contextTokens.length > 0) {
        const now = Date.now();
        const cap = Math.max(1, Number(this.cfg.contextCap ?? 8));
        // 同一组词换个顺序不算新语境：签名排序后比较
        const signature = [...new Set(contextTokens.map(String))].slice(0, 6).sort().join('|');
        let added = 0;
        for (const hit of Array.isArray(snapshot?.hits) ? snapshot.hits : []) {
          if (typeof hit?.score !== 'number') continue;
          const row = this.byId(String(hit.id));
          if (row === undefined || row.status !== 'active') continue;
          const contexts = Array.isArray(row.contexts) ? row.contexts : [];
          if (contexts.some((item) => item?.t === signature)) continue;
          contexts.push({ t: signature, at: now });
          if (contexts.length > cap) contexts.splice(0, contexts.length - cap);
          row.contexts = contexts;
          added += 1;
        }
        if (added > 0) this.#event('memory.context', { added, tokens: contextTokens.length });
      }
      /**
       * 每轮一条结构埋点：只记体积与预算，**不记正文**。
       *
       * 为什么必须有它：`used` 上线一天后 usedTotal 仍是 0，而翻遍库也说不清
       * "是没命中，还是根本没注入过有内容的东西" —— 没有注入次数这个分母，
       * 命中率永远算不出来，后面的淘汰策略就全是猜。
       */
      this.#event('recall', {
        query: String(snapshot?.query ?? '').slice(0, 60),
        budget: snapshot?.gate?.budget ?? null,
        tokens: snapshot?.gate?.tokens ?? null,
        chars: snapshot?.size?.chars ?? 0,
        blocks: snapshot?.size?.blocks ?? 0,
        entries: snapshot?.size?.entries ?? 0,
      });
      /**
       * 上一份注入的验收结果（命中了几条 / 给了几条 / 第几轮结案）。
       * 跟召回埋点挤在同一次落盘里 —— 单独写会多一次 atomic write，而它每轮都有。
       */
      if (snapshot?.usage !== undefined && snapshot?.usage !== null) this.#event('memory.usage', snapshot.usage);
    });
  }

  /** 写入一条摘要（本插件不自动生成，供上层或手工挂载）。 */
  async addSummary(input) {
    return this.#mutate(() => {
      const now = Date.now();
      const row = {
        id: randomUUID(),
        sessionId: input.sessionId == null ? null : String(input.sessionId),
        text: String(input.text ?? '').slice(0, this.cfg.maxTextLength * 2),
        createdAt: now,
      };
      this.state.summaries.push(row);
      this.#event('summary.create', { id: row.id });
      return row;
    });
  }

  /**
   * 召回用的语料统计（带缓存）。
   *
   * 归档条目默认不参与：优先给"现在有效"的结论——但允许显式打开，
   * 压缩之后细节藏在归档里，找不到就等于丢了。
   *
   * @param {boolean} includeArchived
   * @returns {{N: number, df: Map<string, number>, tokensById: Map<string, string[]>, postings: Map<string, Set<string>>}}
   */
  #corpusOf(includeArchived = false) {
    const candidateRows = includeArchived
      ? this.state.memories.filter((row) => row.archivedReason !== 'superseded' || row.status === 'active')
      : this.active();
    const key = `${this.revision ?? 0}:${includeArchived ? 'all' : 'active'}`;
    if (this.corpusCache === undefined || this.corpusCache.key !== key) {
      this.corpusCache = {
        key,
        corpus: buildCorpus([
          ...candidateRows.map((row) => ({ id: row.id, text: row.text })),
          ...this.state.summaries.map((row) => ({ id: row.id, text: row.text })),
        ]),
      };
    }
    const corpus = this.corpusCache.corpus;
    this.corpusPostings = corpus.postings;
    return corpus;
  }

  /**
   * 读闸门：这条查询有没有「可检索的内容」。
   *
   * 返回 `{open, tokens, need}`。`open === false` 时 `buildRecall` 只注入常驻块。
   * 判据与阈值都写在 `contentTokens` 上（`lib/rank.js`），这里只负责取语料和读配置。
   *
   * @param {string} query
   * @returns {{open: boolean, tokens: number, need: number}}
   */
  /**
   * 记一次「被用上」。
   *
   * 和 `touch` / `coRecall` 的区别：那两个记的是**被注入**（每轮都会发生），
   * 这个记的是**被用上**（下一轮你说话时出现了这条记忆的指纹词）。两把尺子分开存，
   * 谁也不污染谁 —— 合在一起就再也分不清"被展示"和"有用"了。
   *
   * 这一版**只记不改**：不动 `weightOf`，所以淘汰顺序和以前完全一样。
   * 先攒一段时间数据，看 used 的分布是不是真的能把"有用的"和"只是被展示过的"分开，
   * 再决定要不要让它进权重公式。上来就改权重等于又拍一次脑袋。
   *
   * @param {string[]} ids
   * @returns {Promise<{used: number}>}
   */
  async markUsed(ids) {
    const list = Array.isArray(ids) ? ids : [];
    return this.#mutate(() => {
      const now = Date.now();
      let used = 0;
      const hitIds = [];
      for (const id of list) {
        const row = this.byId(String(id));
        if (row === undefined) continue;
        row.usedCount = (row.usedCount ?? 0) + 1;
        row.lastUsedAt = now;
        hitIds.push(row.id);
        used += 1;
      }
      if (used > 0) this.#event('memory.used', { ids: hitIds, count: used });
      return { used };
    });
  }

  // ── 自我（人格） ──
  //
  // 从 0.51 起不再"整段重写"：整段替换等于每轮重打一遍人格稿子 —— 同样三句原理
  // 换几次措辞，"人"就飘了，而且事后无法归因到底哪一条变了。
  // 这里只接受 diff：加一条 / 合两条 / 退一条，每条都带理由。
  // 真相在 `state.self`；`state.selfNarrative` 是它的合成视图（注入、成长曲线、
  // 面板都在读它，所以那些地方一行都不用改）。

  /** 内核：三观与底线。只有人经面板写，工具侧没有写入口（规格 D3）。 */
  selfCore() {
    return this.state.self?.core ?? null;
  }

  /** 原理（含已退役的，按诞生时间排序）。 */
  selfPrinciples() {
    return [...(this.state.self?.principles ?? [])].sort((left, right) => left.born - right.born);
  }

  /** 还在生效的原理。 */
  livePrinciples() {
    return this.selfPrinciples().filter((row) => row.status === 'live');
  }

  /** 操作日志，最新在前。 */
  selfOplog(limit = 20) {
    const list = [...(this.state.self?.oplog ?? [])].reverse();
    return Number.isFinite(limit) && limit > 0 ? list.slice(0, limit) : list;
  }

  /** 当前的自我叙事（合成视图；内核与原理都空就是 null）。 */
  selfNarrative() {
    return this.state.selfNarrative?.current ?? null;
  }

  /** 合成视图的历史，最新在前（不含当前版）。 */
  selfNarrativeHistory() {
    return [...(this.state.selfNarrative?.versions ?? [])].reverse();
  }

  /**
   * 取舍账本：按两难聚一次，给「性格」看的是分布，不是条目数。
   *
   * 为什么按原样的 (a, b) 分组、不把 A/B 排序合并：排序会让"选了 a"和"选了 b"
   * 在两条方向相反的记录之间错位。宁可留下两个组（A vs B、B vs A），也不悄悄并错。
   *
   * @returns {Array<{a: string, b: string, aCount: number, bCount: number, total: number, lastAt: number}>}
   */
  choiceSummary() {
    const groups = new Map();
    for (const row of this.active()) {
      if (row.kind !== 'choice' || row.choice === null || row.choice === undefined) continue;
      const { a, b, picked } = row.choice;
      const key = `${a}\u0000${b}`;
      const entry = groups.get(key) ?? { a, b, aCount: 0, bCount: 0, total: 0, lastAt: 0 };
      if (picked === 'a') entry.aCount += 1;
      else entry.bCount += 1;
      entry.total += 1;
      entry.lastAt = Math.max(entry.lastAt, Number(row.createdAt) || 0);
      groups.set(key, entry);
    }
    return [...groups.values()].sort((left, right) => right.lastAt - left.lastAt);
  }

  /**
   * 引用链：一个节点，以及它的出边（我长自什么）和入边（谁引用了我）。
   *
   * 纯读：不写盘、不记 hits、不碰 lastHitAt。打开面板不该改变任何东西 ——
   * 这是「看」和「用」必须分开的那条线（used 那个信号就是在这一步被弄脏的）。
   *
   * @param {{kind?: 'memory'|'principle'|'core', id?: string}} input
   */
  traceOf(input = {}) {
    const kind = String(input.kind ?? 'memory');
    const id = String(input.id ?? '');

    const memoryRef = (memoryId) => {
      const row = this.byId(memoryId);
      if (row === undefined) {
        return { kind: 'memory', id: memoryId, title: '（已不在库里）', state: 'missing', at: null };
      }
      return {
        kind: row.kind === 'choice' ? 'choice' : 'memory',
        id: row.id,
        title: row.text,
        state: row.status === 'archived' ? 'archived' : 'active',
        archivedReason: row.archivedReason ?? null,
        at: row.createdAt ?? null,
        choice: row.choice ?? null,
      };
    };

    if (kind === 'principle') {
      const row = (this.state.self?.principles ?? []).find((item) => item.id === id);
      if (row === undefined) return null;
      return {
        node: {
          kind: 'principle',
          id: row.id,
          title: row.text,
          state: row.status === 'retired' ? 'retired' : 'live',
          at: row.born ?? null,
          proven: row.evidence?.proven ?? 0,
          broken: row.evidence?.broken ?? 0,
        },
        /** 出边：它长自哪几条记忆。归档的、丢了的都如实标出来，不许装成正常。 */
        out: (row.bornFrom ?? []).map(memoryRef),
        in: [],
      };
    }

    if (kind === 'core') {
      const core = this.selfCore();
      if (core === null) return null;
      const history = (this.state.self?.oplog ?? []).filter((row) => row.op === 'core');
      return {
        node: { kind: 'core', id: 'core', title: core.text, state: 'locked', at: core.updatedAt ?? null },
        out: history.map((row) => ({
          kind: 'core',
          id: row.id,
          title: row.after ?? '',
          state: row.undoneAt != null ? 'undone' : 'active',
          at: row.ts ?? null,
          before: row.before ?? null,
          reason: row.reason ?? '',
        })),
        in: [],
      };
    }

    // kind === 'memory'
    const memo = memoryRef(id);
    const referrers = [];
    for (const row of this.state.self?.principles ?? []) {
      if (!(row.bornFrom ?? []).includes(id)) continue;
      referrers.push({
        kind: 'principle',
        id: row.id,
        title: row.text,
        state: row.status === 'retired' ? 'retired' : 'live',
        at: row.born ?? null,
      });
    }
    return { node: memo, out: [], in: referrers };
  }

  /**
   * 时间轴：把"记忆 / 取舍 / 人格改动"排成一条线。
   *
   * 人格事件**只从 oplog 取一份**：原理的诞生、合并、退役、内核改写，
   * 全在流水里记过了。若再从 principles.born / core.updatedAt 算一遍，
   * 同一件事会在同一天出现两次，线就变成噪音。
   *
   * @param {{days?: number}} [input]
   * @returns {Array<{day: string, events: Array<{ts: number, kind: string, id: string, title: string}>}>}
   */
  timeline(input = {}) {
    const days = Math.max(1, Math.min(365, Number(input.days) || 14));
    const since = Date.now() - days * 86_400_000;
    const events = [];

    for (const row of this.state.memories) {
      if ((row.createdAt ?? 0) < since) continue;
      if (row.kind === 'slot') continue; // 槽位是覆盖式的当下状态，没有"那一刻"可讲
      if (row.kind === 'choice') {
        const pair = row.choice === null || row.choice === undefined ? '' : `${row.choice.a} ／ ${row.choice.b}`;
        events.push({ ts: row.createdAt, kind: 'choice', id: row.id, title: pair });
        continue;
      }
      events.push({ ts: row.createdAt, kind: 'memory', id: row.id, title: row.text });
    }

    for (const row of this.state.self?.oplog ?? []) {
      if ((row.ts ?? 0) < since) continue;
      const title =
        row.op === 'core'
          ? '改写内核'
          : row.op === 'add'
            ? `加一条原理：${row.after ?? ''}`
            : row.op === 'merge'
              ? `合两条：${row.after ?? ''}`
              : row.op === 'retire'
                ? `退一条：${row.before ?? ''}`
                : row.op === 'evidence'
                  ? `记了一次${row.after === 'broken' ? '推翻' : '验证'}`
                  : row.op === 'restore'
                    ? `回退：${row.after ?? ''}`
                    : row.op;
      events.push({ ts: row.ts, kind: row.op === 'core' ? 'core' : 'principle', id: row.id, title, undone: row.undoneAt != null });
    }

    const buckets = new Map();
    for (const event of events) {
      const day = localDay(event.ts);
      if (!buckets.has(day)) buckets.set(day, []);
      buckets.get(day).push(event);
    }
    return [...buckets.entries()]
      .map(([day, list]) => ({ day, events: list.sort((left, right) => right.ts - left.ts) }))
      .sort((left, right) => (left.day < right.day ? 1 : -1));
  }

  /** 「人格」页要的一整页：内核 + 原理 + 流水 + 合成结果 + 预算用量。 */
  selfView() {
    const core = this.selfCore();
    const principles = this.selfPrinciples();
    const live = principles.filter((row) => row.status === 'live');
    const text = String(this.selfNarrative()?.text ?? '');
    const chars = [...text].length;
    return {
      core,
      principles,
      oplog: this.selfOplog(50).map((row) => ({
        ...row,
        undone: row.undoneAt != null,
        /** 能不能"回到这一步之前"：迁移那步不行，已经撤掉的也不行。 */
        undoable: row.undoneAt == null && row.source !== 'migrate',
      })),
      composed: { text, chars },
      /** 取舍账本（性格的原料）：不注入、不进契约块，只给面板和原理当证据。 */
      choices: this.choiceSummary(),
      budget: {
        coreChars: core === null ? 0 : core.chars,
        coreMax: this.cfg.maxSelfCoreLength,
        principleCount: live.length,
        principleLimit: this.cfg.principleLimit,
        principleMax: this.cfg.maxPrincipleLength,
        totalChars: chars,
        totalMax: this.cfg.selfContractBudget,
      },
      counts: {
        live: live.length,
        retired: principles.length - live.length,
        adds: (this.state.self?.oplog ?? []).filter((row) => row.op === 'add' && row.undoneAt == null).length,
        merges: (this.state.self?.oplog ?? []).filter((row) => row.op === 'merge' && row.undoneAt == null).length,
        retires: (this.state.self?.oplog ?? []).filter((row) => row.op === 'retire' && row.undoneAt == null).length,
        restores: (this.state.self?.oplog ?? []).filter((row) => row.op === 'restore' && row.undoneAt == null).length,
        undone: (this.state.self?.oplog ?? []).filter((row) => row.undoneAt != null).length,
      },
    };
  }

  /**
   * 写内核。
   *
   * `source` 必须是 `'panel'`：这不是风格检查，是**D3 的执行点**。
   * 工具没有"写内核"这个 action，这里再拒一次非面板来源 —— 两道锁都在同一件事上：
   * 一个会自己改三观的东西不可信，因为它判断"该不该改"时用的已经是改完的它。
   *
   * @param {{text: string, reason: string, source?: string}} input
   */
  async setCore(input = {}) {
    if (String(input.source ?? '') !== 'panel') {
      throw new Error('memory-loom: 内核只能由人经面板写入（模型侧没有入口）');
    }
    const text = String(input.text ?? '').trim();
    const reason = this.#assertReason(input.reason, '写内核');
    const chars = [...text].length;
    if (chars === 0) throw new Error('memory-loom: 内核不能为空 —— 不想写就留空，空表示"未定"');
    if (chars > this.cfg.maxSelfCoreLength) {
      throw new Error(`memory-loom: 内核 ${chars} 字，超过上限 ${this.cfg.maxSelfCoreLength} 字 —— 每轮都付钱的东西不能长`);
    }
    this.#assertSelfBudget(composeSelfText(text, this.selfPrinciples()));

    return this.#mutate(() => {
      const now = Date.now();
      const self = this.#selfState();
      const before = self.core?.text ?? null;
      self.core = { text, chars, lockedAt: self.core?.lockedAt ?? now, updatedAt: now, by: 'user' };
      this.#pushOplog(now, { op: 'core', before, after: text, reason, source: 'panel' });
      this.#recompose(now);
      this.#event('self.core', { chars, previousChars: before === null ? 0 : [...before].length });
      return { ok: true, chars, previousChars: before === null ? 0 : [...before].length, budget: this.selfView().budget };
    });
  }

  /**
   * 加一条原理。
   *
   * 必须挂证据（`evidence` = 让它成立的那几条记忆 id）：没有证据的不叫原理，叫许愿。
   * 这条约束是"反证刹车"的正向一半 —— 正向要求给得出出处，反向要求退得掉（见 retirePrinciple）。
   *
   * @param {{text: string, reason: string, evidence: string[], source?: string}} input
   */
  async addPrinciple(input = {}) {
    const text = String(input.text ?? '').trim();
    const reason = this.#assertReason(input.reason, '加一条原理');
    const chars = [...text].length;
    if (chars === 0) throw new Error('memory-loom: 原理不能为空');
    if (chars > this.cfg.maxPrincipleLength) {
      throw new Error(`memory-loom: 原理 ${chars} 字，超过单条上限 ${this.cfg.maxPrincipleLength} 字 —— 原理是判断，不是叙述`);
    }
    const evidence = (Array.isArray(input.evidence) ? input.evidence : []).map((id) => String(id)).filter((id) => id.length > 0);
    if (evidence.length === 0) throw new Error('memory-loom: 加原理必须挂证据（哪条记忆让它成立）—— 没有证据的不叫原理');
    const missing = evidence.filter((id) => this.byId(id) === undefined);
    if (missing.length > 0) throw new Error(`memory-loom: 找不到证据记忆 ${missing.join(', ')}`);
    const live = this.livePrinciples();
    if (live.length >= this.cfg.principleLimit) {
      throw new Error(`memory-loom: 已有 ${live.length} 条原理，到上限 ${this.cfg.principleLimit} —— 请先合并或退役一条`);
    }
    this.#assertSelfBudget(composeSelfText(this.selfCore()?.text ?? '', [...this.selfPrinciples(), { text, status: 'live' }]));

    return this.#mutate(() => {
      const now = Date.now();
      const self = this.#selfState();
      const row = {
        id: randomUUID(),
        text,
        born: now,
        bornFrom: evidence,
        evidence: { proven: evidence.length, broken: 0, lastAt: now, lastPointer: evidence[evidence.length - 1] },
        status: 'live',
        retiredAt: null,
        retiredReason: null,
      };
      self.principles.push(row);
      this.#pushOplog(now, { op: 'add', target: row.id, after: text, reason, evidence, source: input.source });
      this.#recompose(now);
      this.#event('self.add', { id: row.id, chars });
      return { ok: true, id: row.id, chars, live: this.livePrinciples().length, budget: this.selfView().budget };
    });
  }

  /**
   * 合并两条以上原理成一条。
   *
   * 合并后**字数不得增加**：合并的意义是把话说短。允许越合越长的话，
   * 合并就变成"换个地方继续膨胀"。
   *
   * @param {{ids: string[], text: string, reason: string, source?: string}} input
   */
  async mergePrinciples(input = {}) {
    const ids = (Array.isArray(input.ids) ? input.ids : []).map((id) => String(id)).filter((id) => id.length > 0);
    const text = String(input.text ?? '').trim();
    const reason = this.#assertReason(input.reason, '合并原理');
    if (ids.length < 2) throw new Error('memory-loom: 合并至少要两条原理');
    const rows = ids.map((id) => this.state.self?.principles?.find((row) => row.id === id));
    const missing = ids.filter((id, index) => rows[index] === undefined);
    if (missing.length > 0) throw new Error(`memory-loom: 找不到原理 ${missing.join(', ')}`);
    if (new Set(ids).size !== ids.length) throw new Error('memory-loom: 合并的 id 有重复');
    if (rows.some((row) => row.status !== 'live')) throw new Error('memory-loom: 已退役的原理不参与合并');
    const chars = [...text].length;
    if (chars === 0) throw new Error('memory-loom: 合并后的原理不能为空');
    if (chars > this.cfg.maxPrincipleLength) {
      throw new Error(`memory-loom: 合并后 ${chars} 字，超过单条上限 ${this.cfg.maxPrincipleLength} 字`);
    }
    const beforeChars = rows.reduce((sum, row) => sum + [...row.text].length, 0);
    if (chars > beforeChars) {
      throw new Error(`memory-loom: 合并后（${chars} 字）比原来的 ${beforeChars} 字还长 —— 合并不是换个地方继续膨胀`);
    }

    return this.#mutate(() => {
      const now = Date.now();
      const self = this.#selfState();
      const kept = self.principles.filter((row) => ids.includes(row.id));
      const evidence = [...new Set(kept.flatMap((row) => row.bornFrom))];
      const proven = kept.reduce((sum, row) => sum + row.evidence.proven, 0);
      const broken = kept.reduce((sum, row) => sum + row.evidence.broken, 0);
      for (const row of kept) {
        row.status = 'retired';
        row.retiredAt = now;
        row.retiredReason = `合并进新条目：${reason}`;
      }
      const merged = {
        id: randomUUID(),
        text,
        born: now,
        bornFrom: evidence,
        evidence: { proven, broken, lastAt: now, lastPointer: evidence[evidence.length - 1] ?? null },
        status: 'live',
        retiredAt: null,
        retiredReason: null,
      };
      self.principles.push(merged);
      this.#pushOplog(now, {
        op: 'merge',
        target: merged.id,
        targets: ids,
        before: kept.map((row) => row.text).join(' ｜ '),
        after: text,
        reason,
        evidence,
        source: input.source,
      });
      this.#recompose(now);
      this.#event('self.merge', { id: merged.id, from: kept.length, chars });
      return { ok: true, id: merged.id, merged: kept.length, chars, budget: this.selfView().budget };
    });
  }

  /**
   * 退役一条原理。
   *
   * 门槛：要么它被推翻过（`evidence.broken` ≥ 1），要么显式承认"被更好的那条取代了"。
   * 为什么卡这一道：只加不减的自我不是成长，是僵化 —— 而且它会越来越自信，
   * 因为它记得自己每次都对，因为没人记它错在哪。
   *
   * @param {{id: string, reason: string, superseded?: boolean, source?: string}} input
   */
  async retirePrinciple(input = {}) {
    const id = String(input.id ?? '');
    const reason = this.#assertReason(input.reason, '退役一条原理');
    const row = this.state.self?.principles?.find((item) => item.id === id);
    if (row === undefined) throw new Error(`memory-loom: 找不到这条原理（${id}）`);
    if (row.status === 'retired') throw new Error('memory-loom: 这条原理已经退役了');
    if (row.evidence.broken === 0 && input.superseded !== true) {
      throw new Error('memory-loom: 这条原理还没有被推翻过（broken 0）—— 要么先记一次反证，要么显式标 superseded');
    }

    return this.#mutate(() => {
      const now = Date.now();
      const self = this.#selfState();
      const target = self.principles.find((item) => item.id === id);
      target.status = 'retired';
      target.retiredAt = now;
      target.retiredReason = reason;
      this.#pushOplog(now, { op: 'retire', target: id, before: target.text, reason, source: input.source });
      this.#recompose(now);
      this.#event('self.retire', { id, chars: [...target.text].length });
      return { ok: true, id, budget: this.selfView().budget };
    });
  }

  /**
   * 给一条原理记一次证据。
   *
   * `note` 必填：光有计数没有缘由，"被验证三次"和"被记了三次"就分不开。
   *
   * @param {{id: string, result: 'proven'|'broken', note: string, memoryId?: string|null, source?: string}} input
   */
  async recordPrincipleEvidence(input = {}) {
    const id = String(input.id ?? '');
    const result = String(input.result ?? '');
    const note = String(input.note ?? '').trim();
    if (result !== 'proven' && result !== 'broken') throw new Error('memory-loom: result 只能是 proven 或 broken');
    if (note.length === 0) throw new Error('memory-loom: 记证据必须写一句 note（凭什么算验证或推翻）');
    const row = this.state.self?.principles?.find((item) => item.id === id);
    if (row === undefined) throw new Error(`memory-loom: 找不到这条原理（${id}）`);
    if (row.status === 'retired') throw new Error('memory-loom: 已退役的原理不再记证据');
    const memoryId = input.memoryId == null ? null : String(input.memoryId);
    if (memoryId !== null && this.byId(memoryId) === undefined) throw new Error(`memory-loom: 找不到证据记忆 ${memoryId}`);

    return this.#mutate(() => {
      const now = Date.now();
      const self = this.#selfState();
      const target = self.principles.find((item) => item.id === id);
      target.evidence[result] += 1;
      target.evidence.lastAt = now;
      if (memoryId !== null) target.evidence.lastPointer = memoryId;
      this.#pushOplog(now, {
        op: 'evidence',
        target: id,
        after: result,
        reason: note,
        evidence: memoryId === null ? [] : [memoryId],
        source: input.source,
      });
      this.#recompose(now);
      this.#event('self.evidence', { id, result });
      return { ok: true, id, evidence: { ...target.evidence } };
    });
  }

  /**
   * 按流水回退：退回到某次操作**之前**。
   *
   * 从最新一条往回逐条撤销，直到目标那条（含）。三条规矩：
   * ① 被撤销的流水**不删**，只打 `undoneAt` —— 历史记的是"我改过什么"，
   *    删掉就再也归不了因；
   * ② 回退本身也记一条流水：这样分得清"我又想回去了"和"那次根本没发生"；
   * ③ 迁移那一步不可回退（它之前还没有"人格"这个结构）；回退会动到内核时，
   *    只有面板能发（模型侧一律拒）—— 三观的每一次变动都必须是人的手。
   *
   * @param {{id: string, reason: string, source?: string}} input 目标流水的 id
   */
  async restoreSelf(input = {}) {
    const id = String(input.id ?? '');
    const reason = this.#assertReason(input.reason, '回退');
    const oplog = this.state.self?.oplog ?? [];
    const target = oplog.find((row) => row.id === id);
    if (target === undefined) throw new Error(`memory-loom: 找不到这条流水（${id}）`);
    if (target.undoneAt != null) throw new Error('memory-loom: 这条流水已经被回退过了');
    const index = oplog.indexOf(target);
    const pending = oplog.slice(index).filter((row) => row.undoneAt == null);
    if (pending.some((row) => row.source === 'migrate')) {
      throw new Error('memory-loom: 迁移那一步不可回退 —— 它之前还没有"人格"这个结构');
    }
    if (pending.some((row) => row.op === 'merge' && row.targets.length === 0)) {
      throw new Error('memory-loom: 这条合并流水是旧版本写的，缺被合并的 id，无法精确回退');
    }
    if (String(input.source ?? 'tool') !== 'panel' && pending.some((row) => row.op === 'core')) {
      throw new Error('memory-loom: 回退会动到内核 —— 内核只能由人经面板改（模型侧没有入口）');
    }

    return this.#mutate(() => {
      const now = Date.now();
      const self = this.#selfState();
      // 从最新往回撤：后面的操作依赖前面的状态，倒着撤才不会撤出矛盾
      const undone = [];
      for (let cursor = self.oplog.length - 1; cursor >= 0; cursor -= 1) {
        const row = self.oplog[cursor];
        if (row.undoneAt != null) continue;
        this.#undoSelfOp(self, row, now);
        row.undoneAt = now;
        undone.push(row.op);
        if (row.id === id) break;
      }
      this.#pushOplog(now, {
        op: 'restore',
        target: id,
        before: `${undone.length} 步`,
        after: '已回到这一步之前',
        reason,
        source: input.source,
      });
      this.#recompose(now);
      this.#event('self.restore', { steps: undone.length, target: id });
      return { ok: true, steps: undone.length, undone, budget: this.selfView().budget, live: this.livePrinciples().length };
    });
  }

  /**
   * 撤掉一条流水。每种操作都有自己的反演，不猜、不重放。
   *
   * `restore` 自己不需要反演：它撤掉的那些流水已经被标了 `undoneAt`，
   * 再往前回退时它们本来就不会被重放 —— 所以它只要被标掉就行。
   */
  #undoSelfOp(self, entry, now) {
    if (entry.op === 'core') {
      self.core =
        entry.before === null
          ? null
          : {
              text: entry.before,
              chars: [...entry.before].length,
              lockedAt: self.core?.lockedAt ?? now,
              updatedAt: now,
              by: 'user',
            };
      return;
    }
    if (entry.op === 'add') {
      self.principles = self.principles.filter((row) => row.id !== entry.target);
      return;
    }
    if (entry.op === 'retire') {
      const row = self.principles.find((item) => item.id === entry.target);
      if (row !== undefined) {
        row.status = 'live';
        row.retiredAt = null;
        row.retiredReason = null;
      }
      return;
    }
    if (entry.op === 'merge') {
      // 合并后的那条撤掉，被合进来的原文复职
      self.principles = self.principles.filter((row) => row.id !== entry.target);
      for (const originalId of entry.targets) {
        const row = self.principles.find((item) => item.id === originalId);
        if (row !== undefined) {
          row.status = 'live';
          row.retiredAt = null;
          row.retiredReason = null;
        }
      }
      return;
    }
    if (entry.op === 'evidence') {
      const row = self.principles.find((item) => item.id === entry.target);
      const which = String(entry.after ?? '');
      if (row !== undefined && (which === 'proven' || which === 'broken')) {
        row.evidence[which] = Math.max(0, row.evidence[which] - 1);
      }
      return;
    }
    // restore / 未知种类：没有状态可反演
  }

  /** 取（必要时建）自我状态容器。调用方必须在 `#mutate` 里。 */
  #selfState() {
    if (this.state.self === null || typeof this.state.self !== 'object') this.state.self = emptySelf();
    return this.state.self;
  }

  #assertReason(reason, what) {
    const text = String(reason ?? '').trim();
    if (text.length === 0) throw new Error(`memory-loom: ${what}必须写明理由（那句理由就是成长的证据）`);
    return text;
  }

  /**
   * 契约预算闸门。
   *
   * 超了直接拒绝，**不做自动截断**：截断等于静默丢掉人格片段，
   * 正是这套东西存在的理由。
   */
  #assertSelfBudget(text) {
    const chars = [...text].length;
    if (chars > this.cfg.selfContractBudget) {
      throw new Error(
        `memory-loom: 自我块 ${chars} 字，超过契约预算 ${this.cfg.selfContractBudget} 字 —— 请先合并或退役一条原理（不做自动截断）`,
      );
    }
  }

  /** 追加一条操作流水；退役与内核的流水永不丢（那是不可回放的决策）。 */
  #pushOplog(now, entry) {
    const self = this.#selfState();
    const record = {
      id: randomUUID(),
      ts: now,
      op: String(entry.op),
      target: entry.target == null ? null : String(entry.target),
      before: entry.before == null ? null : String(entry.before),
      after: entry.after == null ? null : String(entry.after),
      reason: String(entry.reason ?? ''),
      evidence: (Array.isArray(entry.evidence) ? entry.evidence : []).map((id) => String(id)),
      source: String(entry.source ?? 'tool'),
      targets: (Array.isArray(entry.targets) ? entry.targets : []).map((id) => String(id)),
      undoneAt: null,
    };
    self.oplog.push(record);
    const overflow = self.oplog.length - this.cfg.selfOplogLimit;
    if (overflow > 0) {
      let removed = 0;
      for (let index = 0; index < self.oplog.length && removed < overflow; ) {
        const op = self.oplog[index].op;
        if (op === 'retire' || op === 'core' || op === 'restore') {
          index += 1;
          continue;
        }
        self.oplog.splice(index, 1);
        removed += 1;
      }
      if (removed > 0) this.#event('self.oplog.trim', { removed });
    }
    return record;
  }

  /**
   * 重算合成视图：`state.selfNarrative` 是 `state.self` 的投影。
   *
   * 变了的旧文本才进历史 —— 一字未改的"版本"只会把漂移读数稀释成噪音。
   */
  #recompose(now = Date.now()) {
    const self = this.#selfState();
    const text = composeSelfText(self.core?.text ?? '', self.principles);
    const previous = this.state.selfNarrative?.current ?? null;
    if (previous !== null && previous.text !== text) {
      self.versions.push(previous);
      const dropped = self.versions.length - this.cfg.selfNarrativeVersions;
      if (dropped > 0) {
        self.versions.splice(0, dropped);
        this.#event('self.trim', { dropped });
      }
    }
    const last = self.oplog[self.oplog.length - 1] ?? null;
    this.state.selfNarrative = {
      current:
        text.length === 0
          ? null
          : {
              id: last?.id ?? `composed-${now}`,
              text,
              at: last?.ts ?? now,
              reason: last?.reason ?? '合成：内核 + 原理',
              source: last?.source ?? 'compose',
              sessionId: null,
              chars: [...text].length,
            },
      versions: self.versions,
    };
  }

  /**
   * 老库迁移：把"一整段自我叙事"拆成「内核空缺 + 若干条原理」。
   *
   * 拆分只有一条规则：按行拆。不猜语义、不改措辞 ——
   * 合出来的文本必须和老叙事一字不差（`composeSelfText` 用换行连接，不加项目符号），
   * 否则迁移本身就成了"静默改字节"。
   *
   * @returns {boolean} 是否有改动（要落盘）
   */
  #migrateSelf() {
    const self = this.#selfState();
    const narrative = this.state.selfNarrative?.current ?? null;
    const fresh = self.core === null && self.principles.length === 0 && self.oplog.length === 0;
    const reSplit = !fresh && this.#needsResplit(self);
    if (!fresh && !reSplit) return false;
    if (narrative === null) {
      this.state.selfNarrative = { current: null, versions: [] };
      return false;
    }
    const lines = splitNarrative(narrative.text, this.cfg.maxPrincipleLength);
    const now = Date.now();
    const born = Number(narrative.at) || now;
    if (reSplit) {
      // 0.51.0 那版只按行拆，真实库里那段是一整行 → 拆出一条 130 字的"原理"。
      // 这里补拆一次：原 id 与诞生时间留着，只把这一条换成几句。
      const only = self.principles[0];
      self.principles = lines.map((text) => ({
        id: randomUUID(),
        text,
        born: only.born,
        bornFrom: only.bornFrom,
        evidence: { ...only.evidence },
        status: 'live',
        retiredAt: null,
        retiredReason: null,
      }));
    } else {
      self.principles = lines.map((text) => ({
        id: randomUUID(),
        text,
        born,
        bornFrom: [],
        evidence: { proven: 0, broken: 0, lastAt: null, lastPointer: null },
        status: 'live',
        retiredAt: null,
        retiredReason: null,
      }));
    }
    self.versions = (Array.isArray(this.state.selfNarrative?.versions) ? this.state.selfNarrative.versions : []).map((row) => ({ ...row }));
    self.oplog.push({
      id: randomUUID(),
      ts: now,
      op: 'restore',
      target: null,
      before: null,
      after: String(narrative.text),
      reason: reSplit
        ? `迁移补拆：原来那条 ${[...String(self.oplog[0]?.after ?? '')].length} 字整段太长，按句拆成 ${lines.length} 条`
        : `迁移：把自我叙事拆成 ${lines.length} 条原理（原版理由：${narrative.reason || '没写'}）`,
      evidence: [],
      source: 'migrate',
    });
    this.#recompose(now);
    this.#event('self.migrate', { principles: lines.length, resplit: reSplit });
    return true;
  }

  /**
   * 认出 0.51.0 的迁移残留：**迁移来的唯一一条、且超过单条上限**。
   *
   * 只认这一种形状：拆完条数必然 > 1，于是不会再次触发（天然幂等）。
   * 不碰用户自己写的原理，也不碰有任何破/验账的那种。
   */
  #needsResplit(self) {
    if (self.core !== null) return false;
    if (self.principles.length !== 1) return false;
    const only = self.principles[0];
    if (only.status !== 'live' || [...only.text].length <= this.cfg.maxPrincipleLength) return false;
    if (only.evidence.proven !== 0 || only.evidence.broken !== 0) return false;
    return self.oplog.length === 1 && self.oplog[0].source === 'migrate';
  }

  /**
   * 取一批记忆的锚词（指纹词），供"下一轮再判定有没有被用上"。
   *
   * 为什么现在就算、而不是判定时算：判定发生在下一轮，那时语料可能已经变了
   * （新写入会改 df），锚词跟着漂就再也对不上了。要在注入的当口把指纹定下来。
   *
   * @param {string[]} ids
   * @returns {Map<string, string[]>}
   */
  anchorsFor(ids) {
    const out = new Map();
    const list = Array.isArray(ids) ? ids : [];
    if (list.length === 0) return out;
    const corpus = this.#corpusOf(false);
    for (const id of list) {
      const row = this.byId(String(id));
      if (row === undefined) continue;
      out.set(String(id), anchorsOf(row.text, corpus, { limit: this.cfg.usedAnchorCount }));
    }
    return out;
  }

  /**
   * 读闸门：这条查询该**注入几条**。
   *
   * 不是开关，是预算。为什么：
   * - 零个内容词（"继续"/"你好"/"现在几点了"）→ 0 条：库里没有可想起的东西；
   * - 一个内容词（"咖啡"/"面板"）→ 1 条：单词查询是**指路牌**，往往恰好指向一条具体记忆，
   *   掐掉就等于"用户说咖啡，想不起他爱喝手冲"；但也不该灌满 topK；
   * - 两个以上 → 正常 topK。
   *
   * 这里曾经有一版"单个稀有词放行"的例外（df ≤ 2 就按有内容算），实测直接失效：
   * 80 条的库里 df ≤ 2 的词一大片，任何两字短语都可能"稀有"，闸门只在 0 词时才生效。
   * 拿绝对计数当阈值，库一小就全部命中 —— 换成预算之后这个不可靠的中间概念整块删掉了。
   *
   * 返回 `{budget, tokens, need}`。`need` 是"给足预算所需的内容词数"（`recallMinContentTokens`）。
   *
   * @param {string} query
   * @returns {{budget: number, tokens: number, need: number}}
   */
  #recallGate(query) {
    const need = Math.max(0, Number(this.cfg.recallMinContentTokens ?? 0));
    const topK = Math.max(1, Number(this.cfg.recallTopK ?? 3));
    // 0 = 不设闸门：老行为，低内容查询也照样按 topK 检索
    if (need === 0) {
      // 不设闸门也要算一份词表：迁移统计要用它当"这一次是在什么语境里想起的"
      const corpus = this.#corpusOf(false);
      const list = contentTokens(expandQueryTokens(tokenize(query), corpus), corpus);
      return { budget: topK, tokens: 0, need: 0, list };
    }
    const corpus = this.#corpusOf(false);
    const tokens = contentTokens(expandQueryTokens(tokenize(query), corpus), corpus);
    const budget = tokens.length === 0 ? 0 : tokens.length < need ? 1 : topK;
    return { budget, tokens: tokens.length, need, list: tokens };
  }

  /**
   * 召回打分：只比文本相似度，阈值由 config 决定。
   * @param {string} query
   * @param {{kinds?: string[], limit?: number, threshold?: number}} [options]
   */
  search(query, options = {}) {
    const threshold = options.threshold ?? this.cfg.searchThreshold ?? 0.34;
    const limit = options.limit ?? 8;
    const kinds = options.kinds === undefined ? null : new Set(options.kinds);
    const since = Number.isFinite(options.since) ? options.since : null;
    const until = Number.isFinite(options.until) ? options.until : null;
    // 空查询 + 时间窗口 = 按时间线列出来（"今天下午做了什么"这类问题）
    const byTime = String(query ?? '').trim().length === 0 && (since !== null || until !== null);
    const now = Date.now();
    const scored = [];
    const activeRows = this.active();
    const includeArchived = options.includeArchived === true;
    // 归档条目默认不参与：优先给"现在有效"的结论。
    // 但允许显式打开 —— 压缩之后细节藏在归档里，找不到就等于丢了。
    const candidateRows = includeArchived
      ? this.state.memories.filter((row) => row.archivedReason !== 'superseded' || row.status === 'active')
      : activeRows;
    // 语料统计按"这次要搜的候选集"算，IDF 才反映真实稀有度
    // 缓存按 revision + 是否含归档做键，2000 条时省掉每次 20ms 的重建
    const corpus = this.#corpusOf(includeArchived);
    // 查询侧补领域别名（搜索→search、恢复→restore…），文档侧不动
    const queryTokens = expandQueryTokens(tokenize(query), corpus);
    // 倒排预筛：与查询共享 0 个词时覆盖度必然是 0，直接跳过（2000 条时省掉整轮打分）
    const matchedIds = new Set();
    for (const token of queryTokens) {
      const bucket = corpus.postings?.get(token);
      if (bucket === undefined) continue;
      for (const id of bucket) matchedIds.add(id);
    }
    const scanRows = byTime ? candidateRows : candidateRows.filter((row) => matchedIds.has(row.id));
    for (const row of scanRows) {
      if (kinds !== null && !kinds.has(row.kind)) continue;
      if (since !== null || until !== null) {
        const at = row.eventDate !== undefined && row.eventDate !== null ? Date.parse(row.eventDate) : row.createdAt ?? 0;
        const stamp = Number.isFinite(at) ? at : row.createdAt ?? 0;
        if (since !== null && stamp < since) continue;
        if (until !== null && stamp > until) continue;
      }
      if (byTime) {
        scored.push({
          id: row.id,
          kind: row.kind,
          text: row.text,
          score: 0,
          hits: row.hits ?? 0,
          eventDate: row.eventDate,
          weak: false,
          createdAt: row.createdAt ?? 0,
          weight: Number(weightOf(row, now, this.cfg.halfLifeDays).toFixed(3)),
        });
        continue;
      }
      const score = coverageScore(queryTokens, corpus.tokensById.get(row.id) ?? [], corpus);
      if (score < threshold) continue;
      scored.push({
        id: row.id,
        kind: row.kind,
        text: row.text,
        score: Number((score * (includeArchived && row.status !== 'active' ? 0.97 : 1)).toFixed(3)),
        archived: row.status !== 'active',
        hits: row.hits ?? 0,
        eventDate: row.eventDate,
        weak: score < threshold * this.cfg.weakMargin,
        weight: Number(weightOf(row, now, this.cfg.halfLifeDays).toFixed(3)),
        // 排序第三顺位要用它：漏掉这个字段的话 `undefined - undefined` 是 NaN，
        // 比较器一遇 NaN 就等于随机 —— 并列时到底谁在前全看数组原顺序。
        createdAt: row.createdAt ?? 0,
      });
    }
    // 摘要也进检索：它是归纳后的结论，只靠注入碰运气等于半个能力。
    // 显式按 kinds 过滤时不带摘要（summary 不是记忆种类，硬塞会让过滤语义变味）。
    if (kinds === null) {
      for (const row of this.state.summaries) {
        if (since !== null || until !== null) {
          const stamp = row.createdAt ?? 0;
          if (since !== null && stamp < since) continue;
          if (until !== null && stamp > until) continue;
        }
        if (byTime) {
          scored.push({
            id: row.id,
            kind: 'summary',
            text: row.text,
            score: 0,
            hits: 0,
            eventDate: null,
            weak: false,
            createdAt: row.createdAt ?? 0,
            topic: row.topic ?? '',
            members: row.memberCount ?? (Array.isArray(row.memberIds) ? row.memberIds.length : 0),
          });
          continue;
        }
        const score = coverageScore(queryTokens, corpus.tokensById.get(row.id) ?? [], corpus);
        // 摘要正文可能没写全主题词，主题单独再算一次覆盖度，取高的
        const topicScore =
          row.topic === undefined ? 0 : coverageScore(queryTokens, tokenize(String(row.topic)), corpus);
        const best = Math.max(score, topicScore);
        if (best < threshold) continue;
        scored.push({
          id: row.id,
          kind: 'summary',
          text: row.text,
          // 摘要覆盖 N 条成员，同样覆盖率下比任何单条更值得先给出来
          score: Number(Math.min(1, best * 1.05).toFixed(3)),
          hits: 0,
          eventDate: null,
          weak: best < threshold * this.cfg.weakMargin,
          createdAt: row.createdAt ?? 0,
          topic: row.topic ?? '',
          members: row.memberCount ?? (Array.isArray(row.memberIds) ? row.memberIds.length : 0),
        });
      }
    }

    if (byTime) scored.sort((left, right) => right.createdAt - left.createdAt);
    else
      scored.sort(
        (left, right) =>
          right.score - left.score ||
          // 覆盖率并列时摘要优先：它是 N 条记忆压出来的结论，同样的相关性下先给压缩版
          Number(right.kind === 'summary') - Number(left.kind === 'summary') ||
          // 再并列时看权重：反复被用到/被确认的结论，比"刚写进去的过程记录"更该排在前面
          (right.weight ?? 0) - (left.weight ?? 0) ||
          (right.createdAt ?? 0) - (left.createdAt ?? 0) ||
          String(left.id).localeCompare(String(right.id)),
      );
    return scored.slice(0, limit);
  }

  /** 活跃约束（含已解除，由调用方过滤）。 */
  constraints() {
    return this.active()
      .filter((row) => row.kind === 'constraint')
      .sort((left, right) => (right.updatedAt ?? 0) - (left.updatedAt ?? 0));
  }

  /** 状态槽位（覆盖式，全量注入）。 */
  slots() {
    return [...this.state.slots].sort((left, right) => (right.updatedAt ?? 0) - (left.updatedAt ?? 0));
  }

  /** 按重要度取共同经历 top-N。 */
  episodes(limit = this.cfg.episodeTop) {
    return this.active()
      .filter((row) => row.kind === 'episode')
      .sort((left, right) => (right.significance ?? 0) - (left.significance ?? 0) || (right.updatedAt ?? 0) - (left.updatedAt ?? 0))
      .slice(0, limit);
  }

  /** 最近写入的活跃条目。 */
  recent(limit = 5) {
    return this.active()
      .sort((left, right) => (right.createdAt ?? 0) - (left.createdAt ?? 0))
      .slice(0, limit);
  }

  /**
   * 组装本轮召回：约束常驻 → 槽位 → 共同经历 → 世界 → 事实/她的经历 → 摘要。
   * 返回结构化块与逐条得分，面板和注入共用同一份结果（不重复算）。
   */
  buildRecall(query, options = {}) {
    const now = Date.now();
    const threshold = options.threshold ?? this.cfg.recallThreshold;
    /**
     * 读闸门：先判断这条查询「有没有可检索的内容」，再决定要不要翻记忆库。
     *
     * 闸门只管**检索**（世界 / 事实 / 摘要）。约束、槽位、共同经历是每轮无条件注入的契约，
     * 不受影响 —— 它们不是"这一轮想起了什么"，而是"任何时候都必须知道的"。
     */
    const gate = this.#recallGate(query);
    const blocks = [];
    const hits = [];
    const dropped = { staleConstraints: 0 };

    const constraints = this.constraints().filter((row) => row.relaxedAt == null).slice(0, this.cfg.constraintLimit);
    dropped.staleConstraints = this.constraints().filter((row) => row.relaxedAt != null).length;
    if (constraints.length > 0) {
      blocks.push({
        name: 'constraints',
        title: '【必须遵守的约束】',
        text: constraints.map((row, index) => `${index + 1}. ${row.text}`).join('\n'),
        ids: constraints.map((row) => row.id),
      });
      hits.push(...constraints.map((row) => ({ id: row.id, kind: row.kind, text: row.text, score: null, block: 'constraints' })));
    }

    /**
     * 自我叙事：每轮在场，位置在硬约束之后、状态之前。
     *
     * 不进 `hits`：它不是一条可召回的条目，给了 `hits` 就会污染"曝光"统计
     * （每轮都在场的东西，命中数会永久虚高）。它的成本记在契约块开销里，那才是真账。
     */
    const narrative = this.selfNarrative();
    if (narrative !== null) {
      blocks.push({ name: 'narrative', title: '【我是谁】', text: narrative.text, ids: [] });
    }

    const slots = this.slots().slice(0, this.cfg.slotLimit);
    if (slots.length > 0) {
      blocks.push({
        name: 'slots',
        title: '【此刻的状态】',
        text: slots.map((row) => `- ${row.entity}·${row.attr}：${row.value}`).join('\n'),
        ids: slots.map((row) => row.id),
      });
    }

    const episodes = this.episodes();
    if (episodes.length > 0) {
      blocks.push({
        name: 'episodes',
        title: '【一起经历过的事】',
        text: episodes
          .map((row) => `- ${row.text}${row.scene ? `（场景：${row.scene}）` : ''}${row.eventDate ? `（${row.eventDate}）` : ''}`)
          .join('\n'),
        ids: episodes.map((row) => row.id),
      });
      hits.push(...episodes.map((row) => ({ id: row.id, kind: row.kind, text: row.text, score: null, block: 'episodes' })));
    }

    // 闸门 = 预算：0 条就整块跳过；1 条就只给一条（单词查询是指路牌，不是"没内容"）。
    const worldLimit = Math.min(this.cfg.worldTopK, gate.budget);
    const world = gate.budget > 0 ? this.search(query, { kinds: ['world'], limit: worldLimit, threshold }) : [];
    if (world.length > 0) {
      blocks.push({
        name: 'world',
        title: '【共同生活的世界】',
        text: world.map((row) => `- ${row.text}${row.weak ? '（弱相关）' : ''}`).join('\n'),
        ids: world.map((row) => row.id),
      });
      hits.push(...world.map((row) => ({ ...row, block: 'world' })));
    }

    const factLimit = Math.min(this.cfg.recallTopK, gate.budget);
    const facts = gate.budget > 0 ? this.search(query, { kinds: ['fact', 'self'], limit: factLimit, threshold }) : [];
    if (facts.length > 0) {
      blocks.push({
        name: 'facts',
        title: '【想起来的事】',
        text: facts
          .map((row) => {
            const when = row.eventDate ? `事件日期 ${row.eventDate}` : `记于 ${describeAge(this.byId(row.id)?.createdAt ?? now, now)}`;
            return `- ${row.text}（${when}${row.weak ? '，弱相关' : ''}）`;
          })
          .join('\n'),
        ids: facts.map((row) => row.id),
      });
      hits.push(...facts.map((row) => ({ ...row, block: 'facts' })));
    }

    // 摘要可能有多条（每簇一条）：取最相关的两条 + 最新的一条，最多三条，避免占用预算。
    // 相关性走和检索同一套覆盖率打分 —— 这里原来用 Jaccard（`similarity`），
    // 也就是 v0.29.0 已经从检索里换掉的那把尺子：同一份查询，两块用了两种口径，排序会互相打脸。
    const summaries = gate.budget > 0 ? this.state.summaries : [];
    if (summaries.length > 0) {
      const byId = new Map(summaries.map((row) => [row.id, row]));
      const byScore = this.search(query, { limit: 6, threshold })
        .filter((hit) => hit.kind === 'summary')
        .slice(0, 2)
        .map((hit) => byId.get(hit.id))
        .filter((row) => row !== undefined);
      const newest = summaries.at(-1);
      const picked = [];
      for (const candidate of [...byScore, newest]) {
        if (candidate === undefined) continue;
        if (picked.some((row) => row.id === candidate.id)) continue;
        picked.push(candidate);
      }
      // 摘要条数也跟着预算走：只给一条预算时不该再塞三条旧事
      const chosen = picked.slice(0, Math.min(3, Math.max(1, gate.budget)));
      blocks.push({
        name: 'summary',
        title: '【更早之前】',
        text: chosen.map((row) => row.text).join('\n'),
        ids: chosen.map((row) => row.id),
      });
    }

    const snapshot = {
      at: now,
      query: String(query ?? ''),
      threshold,
      /** 读闸门的结果：面板据此说出"这一轮为什么没注入记忆" */
      gate,
      /**
       * 注入体积。面板与埋点都用它回答"这一轮到底花了多少上下文"——
       * 以前这个数字看不见，于是"注入太多"只能靠感觉。
       */
      size: {
        chars: blocks.reduce((sum, block) => sum + `${block.title}\n${block.text}`.length + 2, 0),
        blocks: blocks.length,
        entries: hits.filter((hit) => typeof hit.score === 'number').length,
      },
      blocks: blocks.map((block) => ({ name: block.name, title: block.title, text: block.text })),
      hits,
      dropped,
    };
    return snapshot;
  }

  /** 面板用的整库快照（一次取全，客户端只做渲染）。 */
  snapshot(options = {}) {
    const now = Date.now();
    const memoryLimit = options.memoryLimit ?? 400;
    // 状态（slot）本来单独存在 state.slots 里，面板只渲染 memories ——
    // 结果「状态」分类永远是 0 条，数据在但看不见。这里把它们并进列表。
    const slotRows = this.state.slots.map((row) => ({
      id: row.id,
      kind: 'slot',
      kindLabel: '状态',
      text: row.value,
      value: row.value,
      entity: row.entity,
      attr: row.attr,
      actor: row.actor ?? null,
      scene: null,
      significance: null,
      eventDate: null,
      hits: row.hits ?? 0,
      usedCount: row.usedCount ?? 0,
      revisedCount: 0,
      explicit: row.explicit === true,
      status: 'active',
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      lastHitAt: row.lastHitAt ?? null,
      lastRevisedAt: null,
      archivedAt: null,
      archivedReason: null,
      relaxedAt: null,
      supersedes: [],
      supersededBy: null,
      summarizedBy: null,
      sessionId: row.sessionId ?? null,
      source: row.source,
      slot: true,
      weight: 1,
    }));
    const rows = [...slotRows, ...this.state.memories]
      .sort((left, right) => (right.createdAt ?? 0) - (left.createdAt ?? 0))
      .slice(0, memoryLimit)
      .map((row) => ({
        id: row.id,
        kind: row.kind,
        kindLabel: kindLabel(row.kind),
        text: row.text,
        actor: row.actor,
        scene: row.scene,
        significance: row.significance,
        eventDate: row.eventDate,
        /** 仅 kind=choice：两难三键，面板要照它排"选了什么 / 多少次" */
        choice: row.choice ?? null,
        hits: row.hits ?? 0,
        /** 被用上的次数（与 hits 分开：hits 是"被注入"，这才是"有用"） */
        usedCount: row.usedCount ?? 0,
        lastUsedAt: row.lastUsedAt ?? null,
        /** 被改写的次数（被取代 / 被近似新条目撞上）：这是"这条不够用"的证据 */
        revisedCount: row.revisedCount ?? 0,
        lastRevisedAt: row.lastRevisedAt ?? null,
        explicit: row.explicit === true,
        status: row.status,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
        lastHitAt: row.lastHitAt ?? null,
        archivedAt: row.archivedAt ?? null,
        archivedReason: row.archivedReason ?? null,
        /** 被哪条摘要归纳过：面板「查看原文」按它过滤，漏了就会是空列表 */
        summarizedBy: row.summarizedBy ?? null,
        /** 状态类专有：快照按固定字段重建，这里漏了面板就读不到实体/属性 */
        slot: row.slot === true,
        entity: row.entity ?? null,
        attr: row.attr ?? null,
        value: row.value ?? null,
        relaxedAt: row.relaxedAt ?? null,
        supersedes: row.supersedes ?? [],
        supersededBy: row.supersededBy ?? null,
        sessionId: row.sessionId,
        source: row.source,
        weight: Number(weightOf(row, now, this.cfg.halfLifeDays).toFixed(3)),
        age: describeAge(row.createdAt, now),
      }));
    return {
      file: this.file,
      loadError: this.loadError,
      cfg: {
        maxActiveMemories: this.cfg.maxActiveMemories,
        maxArchive: this.cfg.maxArchive,
        dedupeThreshold: this.cfg.dedupeThreshold,
        recallThreshold: this.cfg.recallThreshold,
        halfLifeDays: this.cfg.halfLifeDays,
      },
      counts: this.counts(),
      memories: rows,
      slots: this.slots().map((row) => ({ ...row, age: describeAge(row.updatedAt ?? row.createdAt, now) })),
      /**
       * 自我叙事：面板要和其它几层一样能看见 —— 一段看不见的自我描述，
       * 等于它只在注入里起作用，人能感觉到的只有"字变多了"。
       * 历史版本一起给出去，`reason` 就是那条版本轨迹的注释。
       */
      selfNarrative: {
        current: this.selfNarrative(),
        versions: this.selfNarrativeHistory(),
      },
      summaries: this.state.summaries.slice(-5),
      events: this.state.events.slice(-120).reverse(),
      recall: this.state.recall?.last ?? null,
      recallCount: this.state.recall?.count ?? 0,
      /**
       * 共激活图。**只给面板画线用，不参与注入决策**（这一版刻意只观测）。
       * 面板拿到的是衰减后强度达标的边，`graph` 里是整体形状统计。
       */
      edges: visibleEdges(this.state.edges, {
        now,
        halfLifeDays: this.cfg.halfLifeDays,
        minWeight: this.cfg.edgeMinWeight,
      }),
      graph: graphStats(this.state.edges, { now, halfLifeDays: this.cfg.halfLifeDays, minWeight: this.cfg.edgeMinWeight }),
      meta: this.state.meta,
      generatedAt: now,
      today: isoDay(now),
    };
  }

  /** 各层计数（健康灯与顶部卡片共用）。 */
  counts() {
    const active = this.active();
    const byKind = Object.fromEntries(KINDS.map((kind) => [kind, 0]));
    for (const row of active) byKind[row.kind] = (byKind[row.kind] ?? 0) + 1;
    return {
      active: active.length,
      archived: this.archived().length,
      slots: this.state.slots.length,
      summaries: this.state.summaries.length,
      events: this.state.events.length,
      byKind,
      constraintsActive: this.constraints().filter((row) => row.relaxedAt == null).length,
      constraintsRelaxed: this.constraints().filter((row) => row.relaxedAt != null).length,
      explicit: active.filter((row) => row.explicit === true).length,
      capacity: this.cfg.maxActiveMemories,
      recallCount: this.state.recall?.count ?? 0,
      /** 共激活边总数（含未达展示阈值的弱边）。观测用，不参与注入。 */
      edges: this.state.edges.length,
      /** 累计"被用上"的次数（与 hits 的"被注入"分开统计） */
      usedTotal: active.reduce((sum, row) => sum + (row.usedCount ?? 0), 0),
      /**
       * 累计"被改写"的次数。**故意数全库（含归档）**：
       * 被取代的那条通常已经归档或已解除，只数活跃集会把它整类漏掉 ——
       * `usedCount` 就是栽在"口径把自己算死"上（锚词要用户在下一句复述，永远命中不了）。
       */
      revisedTotal: this.state.memories.reduce((sum, row) => sum + (row.revisedCount ?? 0), 0),
      /** 自我叙事：有没有写过、写了多少字、留了几版历史 */
      narrativeChars: [...String(this.selfNarrative()?.text ?? '')].length,
      narrativeVersions: (this.state.selfNarrative?.versions ?? []).length,
    };
  }
}
