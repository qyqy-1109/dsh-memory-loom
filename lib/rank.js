/**
 * 语料级检索打分：IDF 加权的"查询覆盖度"。
 *
 * 为什么不用原来的 Jaccard：
 * 问句里天然带「为什么 / 怎么 / 是不是」这类高频词，它们在任何文档里都有，
 * 对区分毫无帮助却会稀释分母 —— 短查询打不过长文档，最后一条都搜不到。
 *
 * 覆盖度的思路：分母只算**查询**里的词权重和，分子只算**文档命中的**那部分。
 * 高频词 IDF 接近 0，几乎不影响；「批量」「恢复」这种稀有词 IDF 高，命中就拉满。
 */

import { tokenize } from './text.js';

/**
 * 时间词：它们是「时间线查询」的信号，不是内容词。
 *
 * 「现在几点了」「今天做了什么」这类问题拿时间词去撞文本，永远都能撞上
 * （库里到处是"今天/现在"），撞上了却什么信息也没有。时间问题该走
 * `memory_search` 的 since/until 时间线，不是关键词检索。
 *
 * 实测教训：「现在几点了」的峰值覆盖率是 1.000 —— 因为"点了"命中了
 * 「面板开关的教训……用户直接判为"没动静"」里那两个字。它不是内容词，不该计分。
 */
const TIME_WORDS = new Set([
  '今天', '昨天', '明天', '后天', '前天', '刚才', '现在', '上午', '中午', '下午', '晚上', '早上',
  '时候', '点了', '几天', '多久', '今天先',
]);

/**
 * 应答 / 寒暄词：它们不代表任何话题，撞上了说明不了"库里有相关内容"。
 *
 * 「继续」在真实库里的 df 是 1 —— 于是它命中一条含"继续"的记忆就拿满分 1.0。
 * 单字（继/续）本来就被打分排除，但二元组"继续"不在停用表里，就成了假高分的来源。
 */
const CHITCHAT_WORDS = new Set([
  '继续', '接着', '谢谢', '你好', '您好', '好的', '好呀', '辛苦', '麻烦', '请问', '可以吗',
  '没问题', '收到', '明白了', '知道了', '稍等',
]);

/**
 * 打分用的停用词（只影响检索排序，不影响查重）。
 *
 * 中文问句里的"为什么/怎么/记得吗"在语料里出现次数少 → IDF 不低 →
 * 一条恰好写了这些字样的记忆会抢走所有问句的排名。这类词必须直接不计分。
 *
 * 时间词与寒暄词同理：它们不携带话题，命中它们只说明"句子里有这两个字"。
 * 停用词只该排除**没有话题价值的词**，不能用来掩盖"这条查询没有内容"。
 */
const SCORE_STOP = new Set([
  '为什', '什么', '怎么', '为何', '如何', '哪些', '哪个', '哪里', '是不是', '能否', '可以', '需要',
  '记得', '记不', '得吗', '这件', '件你', '你了', '一下', '这个', '那个', '我们', '他们', '时候',
  '现在', '还是', '就是', '不是', '有没有', '可不', '告诉', '帮我', '请问',
  ...TIME_WORDS,
  ...CHITCHAT_WORDS,
]);

/** 语料少于这个条数时不判饱和词：小库里每个词都"饱和"，一判就全清空了。 */
const SATURATION_MIN_DOCS = 12;
/** 覆盖超过这个比例的算饱和词（与 summary.js 里成簇的判据同一个量级）。 */
const SATURATION_RATIO = 0.25;

/**
 * 这个词算不算「不携带话题」的词（单字 / 问句填词 / 时间词 / 寒暄词）。
 *
 * 打分和「使用信号」都要用同一套口径：一条记忆的指纹词不能是"记忆""面板"这种
 * 全库都有的词，也不能是"什么""现在"这种不含话题的词。
 *
 * @param {string} token
 * @returns {boolean}
 */
export function isStopToken(token) {
  return [...String(token)].length < 2 || SCORE_STOP.has(String(token));
}

/**
 * 从查询里挑出「可检索的内容词」。
 *
 * 用途是**读闸门**：一条查询的内容词少于两条时，不注入世界/事实/摘要块
 * —— 那几块是"想起点什么"，而这条查询没有可想起的东西，注进去只有噪音。
 *
 * 为什么不能用覆盖率当判据（实测过，行不通）：覆盖率的分母只有查询词，
 * 短查询撞上一个二元组就是 1.0。真实库上「继续」「现在几点了」的峰值覆盖率是 1.000，
 * 比一半真相关查询还高。换成"命中的内容词个数"才分得开：12 条无关查询里 9 条不足两条。
 *
 * 排掉的四类：
 * - 单字（跨句撞车概率太高，和打分同一条规矩）；
 * - 问句填词（`SCORE_STOP`：什么/怎么/记得…）；
 * - 时间词（见 `TIME_WORDS`）；
 * - 语料里没有的词（检索也检索不到，进不了候选），以及饱和词（全库都在讲它，没有区分度）。
 *
 * @param {string[]} queryTokens 已经过别名词展开的查询词
 * @param {{N: number, df: Map<string, number>}} corpus
 * @returns {string[]}
 */
export function contentTokens(queryTokens, corpus) {
  const out = [];
  for (const token of new Set(queryTokens)) {
    if ([...token].length < 2) continue;
    if (SCORE_STOP.has(token)) continue;
    if (TIME_WORDS.has(token)) continue;
    const df = corpus.df.get(token) ?? 0;
    if (df === 0) continue;
    if (corpus.N >= SATURATION_MIN_DOCS && df >= corpus.N * SATURATION_RATIO) continue;
    out.push(token);
  }
  return out;
}

/**
 * 为一批文档建倒排统计。
 * @param {Array<{id: string, text: string}>} rows
 * @returns {{N: number, df: Map<string, number>, tokensById: Map<string, string[]>}}
 */
export function buildCorpus(rows) {
  const df = new Map();
  const tokensById = new Map();
  const postings = new Map();
  for (const row of rows) {
    const tokens = tokenize(row.text);
    tokensById.set(row.id, tokens);
    for (const token of new Set(tokens)) {
      df.set(token, (df.get(token) ?? 0) + 1);
      const bucket = postings.get(token);
      if (bucket === undefined) postings.set(token, new Set([row.id]));
      else bucket.add(row.id);
    }
  }
  return { N: rows.length, df, tokensById, postings };
}

/**
 * 单个词的 IDF（BM25 常用形式，永远为正）。
 * @param {{N: number, df: Map<string, number>}} corpus
 * @param {string} token
 * @returns {number}
 */
export function idfOf(corpus, token) {
  const df = corpus.df.get(token) ?? 0;
  return Math.log(1 + (corpus.N - df + 0.5) / (df + 0.5));
}

/**
 * 查询覆盖度：文档命中的词权重 / 查询全部词权重。
 * 返回 0–1，1 表示查询里每个词都在这条记忆里出现过。
 *
 * @param {string[]} queryTokens
 * @param {string[]} docTokens
 * @param {{N: number, df: Map<string, number>}} corpus
 * @returns {number}
 */
export function coverageScore(queryTokens, docTokens, corpus) {
  const query = new Set(queryTokens);
  if (query.size === 0) return 0;
  const doc = new Set(docTokens);
  let total = 0;
  let matched = 0;
  for (const token of query) {
    if (SCORE_STOP.has(token)) continue;
    // 单字词一律不计：中文单字跨句撞车的概率太高（"量子色动力学"里的"学"
    // 能撞上"学吉他"），一个偶然的单字就能把无关查询顶到 1.0。
    if ([...token].length < 2) continue;
    // 语料里根本不存在的词（df=0）算不出稀有度，也永远匹配不上：
    // 让它进分母只会把"我/你/记得吗"这类问句填词变成惩罚项，把真关键词淹掉。
    if ((corpus.df.get(token) ?? 0) === 0) continue;
    const weight = idfOf(corpus, token);
    total += weight;
    if (doc.has(token)) matched += weight;
  }
  if (total <= 0) return 0;
  return matched / total;
}
