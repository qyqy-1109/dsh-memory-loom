/**
 * 摘要层：把同主题的一堆条目归纳成一条可检索的摘要。
 *
 * 设计取舍（为什么不调模型）：
 * - 宿主把 LLM 能力交给各 provider 插件（`@deepseek-ai/dsh-llm` 的注入式 provider），
 *   记忆插件没有稳定的模型入口，硬接会带来超时、成本和"摘要失败就卡住写入"的问题；
 * - 归纳的目标是**压缩冗余**，不是重写文风。同一主题下几十条短句，抽取出彼此互补的要点
 *   就足够，而且可复现、可测试、离线、零延迟。
 *
 * 所以这里是**确定性抽取式归纳**：按主题聚类 → 每条取最互补的一段 → 拼成一条定点摘要。
 * 原始条目不是删除，而是转到归档（`reason: summarized`），随时可追溯。
 */

import { tokenize } from './text.js';

/** 出现在「几乎每条记忆里」的词没有区分度，不配当主题词。 */
const TOPIC_STOPWORDS = new Set([
  '用户', '我们', '一起', '现在', '然后', '这个', '那个', '一个', '可以', '需要', '已经', '还是',
  '不要', '就是', '因为', '所以', '但是', '如果', '而且', '这次', '上次', '下次', '同时', '以及',
]);

/**
 * 泛动词 / 泛名词：它们在**任何**一堆记忆里都可能高频，但当主题词等于什么也没说。
 *
 * 实测：11 条版本记录（"v0.20.0：…"、"v0.21.0 修复…"）没有公共前缀，
 * 兜底规则「取最高频二元组」选中了 changelog 里满篇的「新增」，
 * 面板上就成了「归纳·新增」——用户看不懂这簇是什么。
 * 所以兜底选标签时必须把这些词剔掉。
 */
const GENERIC_TOKENS = new Set([
  '新增', '增加', '补充', '删除', '移除', '修复', '修正', '改造', '优化', '完善', '补齐', '接入',
  '支持', '完成', '实现', '调整', '更新', '升级', '重构', '统一', '替换', '启用', '关闭', '验证',
  '问题', '功能', '方案', '结论', '数据', '内容', '方式', '方法', '情况', '时候', '部分', '相关',
  '要求', '必须', '默认', '本身', '目前', '整体', '一处', '两次', '多次', '各种', '其次', '另外',
]);

/** 纯版本号片段（"v0.2"、"20"、"3"）当主题词没有信息量。 */
function isVersionOnly(token) {
  return /^[vV]?[\d.]+$/.test(token) || /^\d/.test(token);
}

/**
 * 这个词配不配当主题词（泛词、版本片段、空串都不配）。
 * 布尔口径导出给 store 用：老库里存的泛词主题要在加载时重算。
 *
 * @param {string} token
 * @returns {boolean}
 */
export function isGenericLabel(token) {
  const text = String(token ?? '').trim();
  if (text.length === 0) return true;
  if (GENERIC_TOKENS.has(text) || TOPIC_STOPWORDS.has(text)) return true;
  if (isVersionOnly(text)) return true;
  return text === '同类结论';
}

/**
 * 版本记录簇：成员大多带版本号（"写入机制 v0.19.0：…"、"v0.20.1 修复：…"）。
 *
 * 这种簇块内容彼此不同（每条讲一件事），公共前缀只能截出 "v0."，
 * 任何具体主题词都只是碰巧高频 —— 唯一诚实的标签是「版本进展」。
 *
 * @param {Array<{text: string}>} members
 * @returns {boolean}
 */
export function looksLikeChangeLog(members) {
  const texts = members.map((member) => String(member.text ?? ''));
  if (texts.length < 3) return false;
  const versioned = texts.filter((text) => /(^|[\s（(【[])[vV]?\d+\.\d+/.test(text)).length;
  return versioned >= Math.max(3, Math.ceil(texts.length * 0.6));
}

/**
 * 一条记忆的主题记号。
 *
 * 只用二元组会选出「下需」「主侧」这种**跨词边界**的碎片当主题词（"场景下需要"、
 * "宿主侧栏"），读起来是乱码。所以这里同时生成 2~4 字的 n-gram；选主题词时
 * 在频次相同的情况下优先更长的——"渲染帧率" 会赢过 "下需"。
 *
 * @param {string} text
 * @returns {Map<string, string[]>} 记号 → 构成它的原始 chunk
 */
export function topicTokens(text) {
  const out = new Map();
  const raw = String(text ?? '').toLowerCase();
  for (const chunk of raw.split(/[^0-9a-z\u3400-\u4dbf\u4e00-\u9fff]+/)) {
    if (chunk.length === 0) continue;
    if (!/[\u3400-\u4dbf\u4e00-\u9fff]/.test(chunk)) {
      if (chunk.length >= 2 && !TOPIC_STOPWORDS.has(chunk)) out.set(chunk, [chunk]);
      continue;
    }
    const chars = [...chunk];
    for (let length = 2; length <= 4; length += 1) {
      for (let start = 0; start + length <= chars.length; start += 1) {
        const gram = chars.slice(start, start + length).join('');
        if (TOPIC_STOPWORDS.has(gram)) continue;
        out.set(gram, [chunk]);
      }
    }
  }
  return out;
}


/** 常见功能字：真正的主题词不会以它们开头或结尾，用它截断最长公共前缀。 */
const FUNCTION_CHARS = new Set([...'在的了和与是要就都也而及或把被给对为从向这那一个我你他她它们可以需要不要还有并且如果因为所以但是然后现在已经正在']);

/**
 * 标签的截断字符：功能字，外加序号/量词（"检索排序第 0 次实测" 的公共前缀是
 * "检索排序第 "，把「第」留在标签里，面板上就是半截句子）与空格。
 */
const LABEL_BREAK_CHARS = new Set([...FUNCTION_CHARS, ...'第号共条次种组批项份']);

/**
 * 两条文本的最长公共前缀。
 *
 * 不能用最长公共**子串**：那样会挑中共同尾巴（模板句里"种场景下需要自适应…"比
 * 句首的"渲染帧率"更长），标签就成了句子中段。主题通常在句首，所以取前缀。
 *
 * @param {string} a
 * @param {string} b
 * @returns {string}
 */
function commonPrefix(a, b) {
  const left = [...a];
  const right = [...b];
  let length = 0;
  while (length < left.length && length < right.length && left[length] === right[length]) length += 1;
  return left.slice(0, length).join('');
}

/**
 * 给一簇起名。
 *
 * 为什么不用「最高频 n-gram」：模板化文本里**任何**子串频次都一样高，
 * 于是 "场景下需要自适应" 里的 "下需要自" 也会满票当选 —— 标签变乱码。
 * 改用成员间的最长公共子串，再在第一个功能字处截断：
 * "渲染帧率在第" → "渲染帧率"，"宿主侧栏宽度可以拖拽" → "宿主侧栏宽度"。
 *
 * @param {Array<{text: string}>} members
 * @param {number} [maxLength]
 * @returns {string}
 */
export function labelOf(members, maxLength = 10) {
  const texts = members.map((member) => String(member.text ?? ''));
  if (texts.length === 0) return '';
  let common = texts[0];
  // 只跟下标等距的几条比，避免 O(n) 次全串比对；结果对顺序不敏感
  const step = Math.max(1, Math.floor(texts.length / 4));
  for (let index = step; index < texts.length; index += step) {
    common = commonPrefix(common, texts[index]);
    if (common.length < 2) break;
  }
  // 版本号片段（v0.2、3.0、2026）不配当主题词：把 "v0.23.0" 截成 "v0.2" 会让要点从 "3.0" 开始
  if (/^[vV]?[\d.]+$/.test(common.trim())) common = '';
  let label = '';
  for (const char of [...common]) {
    if (LABEL_BREAK_CHARS.has(char) || /\s/.test(char)) break;
    label += char;
    if (label.length >= maxLength) break;
  }
  label = label.replace(/[\s，,。；;、：:]+$/g, '').replace(/[vV]?[\d.]+$/, '').trim();
  if ([...label].length >= 2 && !isGenericLabel(label)) return label;
  // 公共前缀给不出可读标签时，版本记录簇有自己诚实的名字（见 looksLikeChangeLog）
  if (looksLikeChangeLog(members)) return '版本进展';
  return fallbackLabel(members);
}

/**
 * 兜底标签：按「覆盖了几条成员」选 n-gram。
 *
 * 与旧实现的差别：旧实现只看二元组频次，于是
 * - 「新增」「修复」这类泛动词当上了主题（changelog 满篇都是）；
 * - 「下需」「主侧」这类跨词边界碎片也可能当选。
 * 现在剔掉泛词、版本片段、以功能字开头/结尾的碎片，并且同频次时优先更长的记号
 * （"检索排序" 赢过 "检索"）。
 *
 * @param {Array<{text: string}>} members
 * @returns {string}
 */
function fallbackLabel(members) {
  const counts = new Map();
  for (const member of members) {
    for (const token of topicTokens(member.text).keys()) {
      const length = [...token].length;
      if (length < 2 || isVersionOnly(token) || isGenericLabel(token)) continue;
      if (FUNCTION_CHARS.has(token[0]) || FUNCTION_CHARS.has(token[length - 1])) continue;
      const cell = counts.get(token) ?? { coverage: 0, length };
      cell.coverage += 1;
      counts.set(token, cell);
    }
  }
  const best = [...counts.entries()].sort(
    (left, right) =>
      right[1].coverage - left[1].coverage ||
      right[1].length - left[1].length ||
      (left[0] < right[0] ? -1 : 1),
  )[0];
  return best === undefined ? '同类结论' : best[0];
}

/**
 * 按主题给条目聚类（单链接贪心，结果确定且与输入顺序无关）。
 *
 * 算法：先统计每个主题记号的条目频次，从最高频开始取「尚未分配的成员」；
 * 够 `minSize` 就成簇，否则丢弃继续看下一个记号。这样簇之间不重叠，也不会互相吞并。
 *
 * @param {Array<{id: string, text: string}>} memories
 * @param {{minSize?: number}} [options]
 * @returns {Array<{topic: string, members: Array<{id: string, text: string}>}>}
 */
export function clusterByTopic(memories, options = {}) {
  const minSize = options.minSize ?? 6;
  const index = new Map();
  for (const memory of memories) {
    for (const token of topicTokens(memory.text).keys()) {
      const bucket = index.get(token) ?? [];
      bucket.push(memory);
      index.set(token, bucket);
    }
  }

  const total = memories.length;
  // 语料里「几乎每条都有」的记号没有区分度：整个库都在讲记忆时，「记忆」当主题词等于没标签
  // （实测活跃簇的候选 key 就是「记忆 16/36」「ai 9/36」）。小语料里高频词很可能就是真主题，所以只在语料够大时启用。
  const minCorpus = options.saturationMinCorpus ?? 12;
  const saturatedAt = Math.max(minSize, Math.ceil(total * (options.saturationRatio ?? 0.4)));
  const saturated = (bucket) => total >= minCorpus && bucket.length >= saturatedAt;

  const cluster = (allowSaturated) => {
    const order = [...index.entries()]
      .filter(([, bucket]) => bucket.length >= minSize)
      .filter(([, bucket]) => allowSaturated || !saturated(bucket))
      .sort((left, right) => {
        // 先按覆盖条数，再按记号长度（长记号更具体），最后按字典序保证确定性
        if (right[1].length !== left[1].length) return right[1].length - left[1].length;
        if (right[0].length !== left[0].length) return right[0].length - left[0].length;
        return left[0] < right[0] ? -1 : 1;
      });

    const assigned = new Set();
    const clusters = [];
    for (const [topic, bucket] of order) {
      const members = bucket.filter((memory) => !assigned.has(memory.id));
      if (members.length < minSize) continue;
      for (const memory of members) assigned.add(memory.id);
      clusters.push({ topic: labelOf(members), bucketKey: topic, members });
    }
    return clusters;
  };

  const strict = cluster(false);
  // 退化：一簇都分不出来（每个记号都饱和）时，宁可标签不够好，也不能就此不再归纳
  return strict.length > 0 ? strict : cluster(true);
}

/**
 * 从一条记忆里抽「相对主题的剩余信息」：去掉主题词本身，避免摘要变成一串重复的主题名。
 * @param {string} text
 * @param {string} topic
 * @param {number} limit 最多保留多少字
 * @returns {string}
 */
export function extractPoint(text, topic, limit) {
  const raw = String(text ?? '').trim();
  let rest = raw;
  // 只有"像个词"的主题才值得剥；剥完以数字/标点开头说明剥坏了（v0.23.0 → 3.0），保留原文
  const worthStripping = topic.length >= 3 && !/^[vV]?[\d.]+$/.test(topic) && !/^[vV]?\d/.test(topic);
  if (worthStripping) {
    const stripped = raw.split(topic).join(' ').trim();
    if (stripped.length > 0 && !/^[\d.，,。；;、：:]/.test(stripped)) rest = stripped;
  }
  rest = rest.replace(/[，,。；;、：:\s]+/g, ' ').trim();
  if (rest.length === 0) rest = raw;
  return rest.length > limit ? `${rest.slice(0, limit)}…` : rest;
}

/**
 * 把一簇成员归纳成一条摘要文本。
 *
 * @param {string} topic 主题词
 * @param {Array<{text: string}>} members 已按重要度排好序
 * @param {{points?: number, pointLength?: number, maxLength?: number}} [options]
 * @returns {string}
 */
export function buildSummary(topic, members, options = {}) {
  const points = options.points ?? 4;
  const pointLength = options.pointLength ?? 46;
  const maxLength = options.maxLength ?? 400;
  const seen = new Set();
  const picked = [];
  for (const member of members) {
    if (picked.length >= points) break;
    const point = extractPoint(member.text, topic, pointLength);
    if (point.length === 0) continue;
    // 去掉和已有要点高度重合的：把数字抹平再比，
    // 否则「第 0 种场景」「第 1 种场景」会被当成两条互补要点。
    const key = point.replace(/\d+/g, '#').replace(/\s+/g, '');
    if (seen.has(key)) continue;
    seen.add(key);
    picked.push(point);
  }
  const head = `【归纳·${topic}】共 ${members.length} 条`;
  const body = picked.map((point, index) => `${index + 1}. ${point}`).join('；');
  const text = `${head}：${body}`;
  return { text: text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text, points: picked };
}

/** 只要文本时的薄封装。 */
export function buildSummaryText(topic, members, options = {}) {
  return buildSummary(topic, members, options).text;
}

/**
 * 一次压缩计划：哪些簇要归纳、各自的摘要文本、以及要归档的成员 id。
 *
 * @param {Array<{id: string, text: string, kind: string}>} memories
 * @param {{minSize?: number, points?: number, maxLength?: number, clusterLimit?: number}} [options]
 * @returns {Array<{topic: string, text: string, memberIds: string[]}>}
 */
export function planSummaries(memories, options = {}) {
  const clusterLimit = options.clusterLimit ?? 4;
  const clusters = clusterByTopic(memories, { minSize: options.minSize ?? 6 });
  return clusters.slice(0, clusterLimit).map((cluster) => {
    const built = buildSummary(cluster.topic, cluster.members, options);
    return {
      topic: cluster.topic,
      text: built.text,
      points: built.points,
      memberIds: cluster.members.map((memory) => memory.id),
    };
  });
}
