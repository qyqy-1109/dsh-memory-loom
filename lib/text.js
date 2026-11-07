/**
 * 文本度量：分词、相似度、时间词解析。
 *
 * 设计取向和「旧识」一致 —— 只做能复核的机械判断，不猜：
 * - 相似度只用于「判重」和「召回排序」两件事，阈值写在 config 里，不散落在调用点。
 * - 中文没有空格，用 CJK 二元组 + ASCII 词，避免引入分词依赖（插件要能离线安装）。
 * - 时间词解析只认能确定的情况；认不出就返回 null，绝不硬造日期。
 *
 * @module dsh-memory-loom/text
 */

/** CJK 统一表意文字（够用的范围；不含兼容区）。 */
const CJK = /[\u3400-\u4dbf\u4e00-\u9fff]/;

/** 需要整体剔除的标点与空白（保留 CJK、拉丁字母、数字）。 */
const STRIP = /[^\u3400-\u4dbf\u4e00-\u9fff0-9a-zA-Z]+/g;

/** 纯函数：归一化文本用于比较（小写、去标点、压空白）。 */
export function normalize(input) {
  if (typeof input !== 'string') return '';
  return input.toLowerCase().replace(STRIP, ' ').trim().replace(/\s+/g, ' ');
}

/**
 * 切词：ASCII 词按空白/标点切；CJK 连续段取「单字 + 二元组」。
 * 单字用于兜底短查询，二元组承担主要区分度。
 * @param {string} input
 * @returns {string[]} 去重后的词元
 */
/**
 * 分词结果缓存。
 *
 * 记忆文本几乎不变，但每次检索/查重都会把全部条目的文本重新切一遍 ——
 * 2000 条规模下这是 30ms+ 的纯浪费。缓存按文本串做键，容量有上限，
 * 超了就整体清空（比 LRU 简单，且记忆文本的重复率很低）。
 */
const TOKEN_CACHE = new Map();
const TOKEN_CACHE_LIMIT = 8000;

export function tokenize(input) {
  const text = normalize(input);
  if (text.length === 0) return [];
  const cached = TOKEN_CACHE.get(text);
  if (cached !== undefined) return cached;
  const out = new Set();
  for (const chunk of text.split(' ')) {
    if (chunk.length === 0) continue;
    if (!CJK.test(chunk)) {
      out.add(chunk);
      continue;
    }
    const chars = [...chunk];
    for (let index = 0; index < chars.length; index += 1) {
      const char = chars[index];
      if (CJK.test(char)) {
        out.add(char);
        const next = chars[index + 1];
        if (next !== undefined && CJK.test(next)) out.add(char + next);
      } else {
        // 拉丁/数字混排在 CJK 串里：整体算一个词更稳。
        let end = index;
        while (end < chars.length && !CJK.test(chars[end])) end += 1;
        const word = chars.slice(index, end).join('');
        if (word.length > 0) out.add(word);
        index = end - 1;
      }
    }
  }
  const list = [...out];
  if (TOKEN_CACHE.size >= TOKEN_CACHE_LIMIT) TOKEN_CACHE.clear();
  TOKEN_CACHE.set(text, list);
  return list;
}

/** 集合交集大小。 */
function overlap(left, right) {
  let hits = 0;
  for (const token of left) if (right.has(token)) hits += 1;
  return hits;
}

/**
 * 两条文本的相似度，落在 [0,1]。
 *
 * 组合口径：`0.5 * Jaccard + 0.5 * containment`。
 * - Jaccard 惩罚「一边说了很多」，负责整体相近；
 * - containment（交集 / 较短一侧）负责「旧条目被新句子整句包住」这种判重场景。
 * @param {string} left
 * @param {string} right
 * @returns {number}
 */
export function similarity(left, right) {
  const a = tokenize(left);
  const b = tokenize(right);
  if (a.length === 0 || b.length === 0) return 0;
  const setA = new Set(a);
  const setB = new Set(b);
  const shared = overlap(setA, setB);
  if (shared === 0) return 0;
  const union = setA.size + setB.size - shared;
  const jaccard = shared / union;
  const containment = shared / Math.min(setA.size, setB.size);
  return 0.5 * jaccard + 0.5 * containment;
}

/** 时距/日期显示用的紧凑格式：YYYY-MM-DD。 */
export function isoDay(epochMs) {
  const date = new Date(epochMs);
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
}

/** 时距显示：刚刚 / N 分钟前 / N 小时前 / N 天前 / YYYY-MM-DD。 */
export function describeAge(epochMs, now = Date.now()) {
  const delta = now - epochMs;
  if (!Number.isFinite(delta)) return '时间未知';
  if (delta < 0) {
    const ahead = -delta;
    if (ahead < 3600_000) return `${Math.round(ahead / 60_000)} 分钟后`;
    if (ahead < 86_400_000) return `${Math.round(ahead / 3_600_000)} 小时后`;
    return `${Math.round(ahead / 86_400_000)} 天后（${isoDay(epochMs)}）`;
  }
  if (delta < 60_000) return '刚刚';
  if (delta < 3_600_000) return `${Math.round(delta / 60_000)} 分钟前`;
  if (delta < 86_400_000) return `${Math.round(delta / 3_600_000)} 小时前`;
  if (delta < 30 * 86_400_000) return `${Math.round(delta / 86_400_000)} 天前`;
  return isoDay(epochMs);
}

/** 相对日词表：长词在前，避免「大后天」被「后天」先吃掉。 */
const RELATIVE_DAYS = [
  ['大后天', 3],
  ['大前天', -3],
  ['后天', 2],
  ['前天', -2],
  ['明天', 1],
  ['昨天', -1],
  ['今天', 0],
  ['今日', 0],
  ['明天', 1],
  ['今晚', 0],
  ['明晚', 1],
  ['昨晚', -1],
];

/** 起始日零点（本地时区），用于把日期词落成稳定的 YYYY-MM-DD。 */
function startOfDay(epochMs) {
  const date = new Date(epochMs);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

/**
 * 从一句话里解析事件日期，返回 `YYYY-MM-DD`，认不出返回 `null`。
 *
 * 认的口径（宁可返回 null 也不猜）：ISO 日期、`M月D日`、相对日词。
 * @param {string} text
 * @param {number} now 参考时刻（默认 Date.now()，测试可注入）
 * @returns {string|null}
 */
export function findEventDate(text, now = Date.now()) {
  if (typeof text !== 'string' || text.length === 0) return null;
  const iso = /(\d{4})-(\d{2})-(\d{2})/.exec(text);
  if (iso !== null) {
    const [, year, month, day] = iso;
    const stamp = new Date(Number(year), Number(month) - 1, Number(day));
    if (!Number.isNaN(stamp.getTime())) return isoDay(stamp.getTime());
  }
  const monthDay = /(\d{1,2})\s*月\s*(\d{1,2})\s*[日号]/.exec(text);
  if (monthDay !== null) {
    const month = Number(monthDay[1]);
    const day = Number(monthDay[2]);
    if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
      let year = new Date(now).getFullYear();
      const stamp = new Date(year, month - 1, day);
      // 明显落在未来的「月日」多半指去年（写作时的口误），回拨一年。
      if (stamp.getTime() - now > 180 * 86_400_000) year -= 1;
      const fixed = new Date(year, month - 1, day);
      if (!Number.isNaN(fixed.getTime())) return isoDay(fixed.getTime());
    }
  }
  for (const [word, offset] of RELATIVE_DAYS) {
    if (text.includes(word)) return isoDay(startOfDay(now) + offset * 86_400_000);
  }
  return null;
}

/** 显式记忆触发词：命中即原话直达，不经提炼取舍（「旧识」的 explicit 通道）。 */
const EXPLICIT_TRIGGERS = [
  /(?:请|帮我|麻烦)?记住[：:，,\s]?/,
  /(?:别忘了|别忘记|不要忘记)/,
  /(?:以后都|以后要|今后都|从现在起都)/,
  /(?:记一下|记录一下|备注一下)/,
];

/** 约束口吻：用于把显式原话归到 constraint 而不是普通事实。 */
const CONSTRAINT_HINTS = [/(?:不许|不准|不能|不要|别再|禁止|必须|一定|只能)/, /(?:每次都要|以后都要)/];

/**
 * 判断一条用户原话是否构成显式记忆请求。
 * @param {string} text
 * @returns {{explicit: boolean, kind: 'fact'|'constraint', text: string}}
 */
export function classifyExplicit(text) {
  const raw = typeof text === 'string' ? text.trim() : '';
  if (raw.length === 0) return { explicit: false, kind: 'fact', text: raw };
  const matched = EXPLICIT_TRIGGERS.find((pattern) => pattern.test(raw));
  if (matched === undefined) return { explicit: false, kind: 'fact', text: raw };
  const kind = CONSTRAINT_HINTS.some((pattern) => pattern.test(raw)) ? 'constraint' : 'fact';
  return { explicit: true, kind, text: raw };
}

/**
 * 状态变化词：写入后主动追问「哪些旧条目被取代」的第二道兜底用得上。
 *
 * 只认「明确的替换动作」——单个「改/换」会把「改代码」「换行」这类日常词全误判成
 * 状态变化（实测被自己写的「改 dsh-memory-loom」触发过一次）。
 */
export const SUPERSEDE_HINTS = [
  /(?:搬走|搬到|搬家|换成|改成了|改成|改为|戒了|戒掉|不再|取消|停了|停止|离职|辞职|分手|离婚|结婚|改名|已经搬|已经不在|已经戒)/,
];

/**
 * 句子是否带状态变化口吻。
 * @param {string} text
 * @returns {boolean}
 */
export function looksLikeChange(text) {
  return SUPERSEDE_HINTS.some((pattern) => pattern.test(text ?? ''));
}

/**
 * 设计取舍 / 明确否决 → 稳定偏好。
 *
 * 由来：一次长设计会话里用户反复说「太丑了」「不要返回按钮」「换成侧栏」，
 * 但这些都不匹配「记住…」，于是整段决策一条都没落库。
 * 这里只认**短句 + 明确的定稿/否决口吻**，宁可漏也不误收：
 * 带「一点 / 再 / 试试 / 暂时」这类临时措辞的一律不记。
 */
const DECISION_FACT_HINTS = /(?:就要这个|就要这版|就这个了|定稿|最终定|最后定|以后就用|换成|改成|改为|换回|切成)/;
const DECISION_CONSTRAINT_HINTS = /(?:不要用|别用|别再|以后都别|禁止)/;
const EPHEMERAL_HINTS = /(?:一点|稍|再大|再小|再快|再慢|试试|先这样|暂时|随便|看看)/;

/**
 * 判断一句用户原话是不是「定下来的取舍」。
 * @param {string} text
 * @returns {{kind: 'fact'|'constraint', text: string} | null}
 */
export function classifyDecision(text) {
  const raw = typeof text === 'string' ? text.trim() : '';
  if (raw.length === 0 || raw.length > 80) return null;
  if (EPHEMERAL_HINTS.test(raw)) return null;
  if (DECISION_CONSTRAINT_HINTS.test(raw)) return { kind: 'constraint', text: raw };
  if (DECISION_FACT_HINTS.test(raw)) return { kind: 'fact', text: raw };
  return null;
}

/**
 * 否定/极性标记。查重时必须拿它兜一道：
 * 「用户喜欢深色主题」和「用户不喜欢深色主题」的 CJK 二元组相似度高达 0.86，
 * 只按 0.72 阈值查重会把后者并进前者 —— 存下来的意思正好相反。
 */
const NEGATION_MARKERS = /(?:不要|不用|不需要|不必|不|别|没|无|非|勿|禁止|取消|停止|移除|去掉|不再|不能|禁止|避免)/g;

/**
 * 粗粒度极性：句子里有没有否定词。
 * @param {string} text
 * @returns {boolean} 是否含否定
 */
export function hasNegation(text) {
  const raw = String(text ?? '');
  NEGATION_MARKERS.lastIndex = 0;
  return NEGATION_MARKERS.test(raw);
}

/**
 * 抽出数字记号：句中编号不同就不是同一件事（"编号 1 的结论" vs "编号 2 的结论" 相似度 0.96）。
 * @param {string} text
 * @returns {string[]}
 */
export function numberTokens(text) {
  return String(text ?? '').match(/\d+(?:\.\d+)?/g) ?? [];
}

/**
 * 两条文本能不能算「同一件事」。
 * 相似度够高只是必要条件，极性或编号不同一律不合并。
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
export function isSameClaim(a, b) {
  if (hasNegation(a) !== hasNegation(b)) return false;
  const left = numberTokens(a).sort().join(',');
  const right = numberTokens(b).sort().join(',');
  if (left !== right) return false;
  return true;
}
