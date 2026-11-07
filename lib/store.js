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
import { buildCorpus, coverageScore, contentTokens, RARE_DF } from './rank.js';
import { expandQueryTokens } from './aliases.js';
import { coActivate, pruneEdges, visibleEdges, graphStats } from './graph.js';

/** 记忆种类。`self` 是「她的经历」一类第一人称条目，保留原项目的分层。 */
export const KINDS = ['fact', 'world', 'constraint', 'episode', 'self', 'slot'];

/** 会被淘汰的 kind：world / constraint / explicit 永久豁免（原项目口径）。 */
const EVICTABLE = new Set(['fact', 'self', 'episode']);

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
   * 写前是否复查磁盘（外部改动先并进来再写）。
   *
   * 默认开：单窗口也会遇到手工编辑 store.json、导入、备份恢复这些"外部改动"，
   * 不开的话下一次写就把它们整份覆盖掉。多实例同时写时它只能减少互相覆盖，
   * 不能替代跨进程锁。要老行为就设 false。
   */
  autoReload: true,
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
    meta: { writeCount: 0, dedupeCount: 0, archiveCount: 0, relaxCount: 0, forgetCount: 0 },
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
  const significance = kind === 'episode' ? Math.min(5, Math.max(1, Number(input.significance ?? 3))) : null;
  return {
    kind,
    text,
    entity: null,
    attr: null,
    scene: kind === 'episode' ? (String(input.scene ?? '').trim() || null) : null,
    significance,
    actor: String(input.actor ?? (kind === 'self' ? 'assistant' : kind === 'episode' ? 'shared' : 'user')),
  };
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
          explicit: false,
          status: 'active',
          archivedAt: null,
          archivedReason: null,
          relaxedAt: null,
          supersedes: [],
          supersededBy: null,
          sessionId: null,
          source: 'tool',
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
      const scanRows =
        candidateIds.size > 0 ? this.state.memories.filter((row) => candidateIds.has(row.id)) : this.state.memories;
      for (const row of scanRows) {
        if (row.status !== 'active' || row.kind !== normalized.kind) continue;
        const rowLength = String(row.text ?? '').length;
        const ratio = Math.min(probeLength, rowLength) / Math.max(probeLength, rowLength, 1);
        if (ratio < 0.4) continue;
        const score = similarity(normalized.text, row.text);
        if (best === null || score > best.score) best = { row, score };
      }
      // 相似度够高只是必要条件：极性（有/无否定）或编号不同，一律不合并
      if (best !== null && best.score >= this.cfg.dedupeThreshold && !isSameClaim(normalized.text, best.row.text)) {
        best = null;
      }
      if (best !== null && best.score >= this.cfg.dedupeThreshold) {
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
        eventDate: input.eventDate === null ? null : (input.eventDate ?? findEventDate(normalized.text)),
        hits: 0,
        explicit,
        status: 'active',
        createdAt: now,
        updatedAt: now,
        lastHitAt: null,
        archivedAt: null,
        archivedReason: null,
        relaxedAt: null,
        supersedes,
        supersededBy: null,
        sessionId,
        source: input.source === 'explicit' ? 'explicit' : 'tool',
      };

      // ③ 作废/解除：约束走「解除」留档，其余软删归档。
      const archived = [];
      const relaxed = [];
      for (const targetId of supersedes) {
        const target = this.byId(targetId);
        if (target === undefined || target.status !== 'active') continue;
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
        notes.push('这条带状态变化口吻：如果它取代了某条旧记忆，请用 supersedes 指定那条的 id');
        this.#event('write.change-hint', { id: row.id });
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
  #recallGate(query) {
    const need = Math.max(0, Number(this.cfg.recallMinContentTokens ?? 0));
    // 0 = 不设闸门：老行为，低内容查询也照样检索
    if (need === 0) return { open: true, tokens: 0, need: 0 };
    const corpus = this.#corpusOf(false);
    const tokens = contentTokens(expandQueryTokens(tokenize(query), corpus), corpus);
    /**
     * 一个「稀有词」也算有内容。
     *
     * 单词查询不一定没内容：`咖啡` 在库里 df=1，几乎只能指向「用户喜欢喝手冲咖啡」，
     * 这种查询检索最准。只按"数量 ≥ 2"一刀切，用户说"咖啡"就再也想不起他爱喝手冲了
     * —— 六层健康灯那盏 `ok` 会直接掉成 `empty`，这条是测试打红之后才发现的。
     *
     * 反过来 `继续` 这种词虽然也 df=1，但它是应答词，已经在 `SCORE_STOP` 里被剔除，
     * 根本不会进内容词列表。
     */
    const rare = tokens.filter((token) => (corpus.df.get(token) ?? 0) <= RARE_DF).length;
    const open = tokens.length >= need || (tokens.length === 1 && rare === 1);
    return { open, tokens: tokens.length, need };
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

    // 闸门关（这条查询没有可检索的内容）：世界 / 事实 / 摘要一律不翻。
    // 这三块是"这一轮想起了什么"，而没有可检索的内容时，翻出来的只会是噪音 ——
    // 实测「今天先做什么」也会灌 5 块 1536 字符，而那些内容对这个问题毫无帮助。
    const world = gate.open ? this.search(query, { kinds: ['world'], limit: this.cfg.worldTopK, threshold }) : [];
    if (world.length > 0) {
      blocks.push({
        name: 'world',
        title: '【共同生活的世界】',
        text: world.map((row) => `- ${row.text}${row.weak ? '（弱相关）' : ''}`).join('\n'),
        ids: world.map((row) => row.id),
      });
      hits.push(...world.map((row) => ({ ...row, block: 'world' })));
    }

    const facts = gate.open ? this.search(query, { kinds: ['fact', 'self'], limit: this.cfg.recallTopK, threshold }) : [];
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
    const summaries = gate.open ? this.state.summaries : [];
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
      const chosen = picked.slice(0, 3);
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
      explicit: row.explicit === true,
      status: 'active',
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      lastHitAt: row.lastHitAt ?? null,
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
        hits: row.hits ?? 0,
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
    };
  }
}
