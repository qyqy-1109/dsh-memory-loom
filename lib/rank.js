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
 * 打分用的停用词（只影响检索排序，不影响查重）。
 *
 * 中文问句里的"为什么/怎么/记得吗"在语料里出现次数少 → IDF 不低 →
 * 一条恰好写了这些字样的记忆会抢走所有问句的排名。这类词必须直接不计分。
 */
const SCORE_STOP = new Set([
  '为什', '什么', '怎么', '为何', '如何', '哪些', '哪个', '哪里', '是不是', '能否', '可以', '需要',
  '记得', '记不', '得吗', '这件', '件你', '你了', '一下', '这个', '那个', '我们', '他们', '时候',
  '现在', '还是', '就是', '不是', '有没有', '可不', '告诉', '帮我', '请问',
]);

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
