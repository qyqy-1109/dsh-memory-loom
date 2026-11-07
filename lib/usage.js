/**
 * 使用信号：这条记忆到底有没有被**用上**。
 *
 * 为什么需要它：`hits` 记的是"被召回"，而被召回 ≈ 每轮都会被注入 → 它度量的是**曝光**，
 * 不是有用。后果是一个回声室：被召回的条目权重更高、于是更容易被召回，与"重不重要"无关。
 * 真实库体检里 42% 的条目从未被召回、命中前 10 条占了一半 —— 这就是曝光逻辑的产物。
 *
 * 判据：给每条记忆取几个**锚词**（它自己最有区分度的词），下一轮你的话里如果出现锚词，
 * 才算用上了。锚词是这条记忆的指纹，不是它的全文：
 * - 用全文比对 → 要求几乎逐字重合，永远不命中；
 * - 用全部词比对 → 被"记忆""面板"这种全库都有的词刷爆。
 *
 * 已知边界（写在这里，不许假装没有）：
 * - **自我引用**：只比对**你**的消息，不比对模型的回答。否则"我说了什么"会反过来
 *   强化"这条记忆有用"，越用越像真的。
 * - **漏判优先**：宁可少记。多记一次 used 会把回声室又请回来，少记只是统计保守。
 * - 滞后一轮：`decision.messages` 只含本轮，拿不到上一轮回答，所以判定发生在**下一轮**。
 */

import { tokenize } from './text.js';
import { idfOf, isStopToken } from './rank.js';

/**
 * 一条记忆的「指纹词」：按 IDF 从高到低取前几个。
 *
 * 为什么用相对排序而不是绝对阈值：上一版在别处试过"df ≤ 2 算稀有"，
 * 80 条的库里这种词一大片，等于没筛。按 IDF 排序天然收敛 ——
 * 饱和词（全库都有的"记忆""面板"）IDF 接近 0，自然排在后面进不了名单。
 *
 * @param {string} text
 * @param {{N: number, df: Map<string, number>}} corpus
 * @param {{limit?: number}} [options]
 * @returns {string[]} 最多 `limit` 个锚词，按区分度降序
 */
export function anchorsOf(text, corpus, options = {}) {
  const limit = Math.max(0, options.limit ?? 3);
  if (limit === 0) return [];
  const seen = new Map();
  for (const token of new Set(tokenize(String(text ?? '')))) {
    if (isStopToken(token)) continue;
    // 语料里不存在的词做不了指纹：下一轮你的话里也不可能出现它
    if ((corpus?.df?.get(token) ?? 0) === 0) continue;
    seen.set(token, idfOf(corpus, token));
  }
  return [...seen.entries()]
    .sort((left, right) => right[1] - left[1] || (left[0] < right[0] ? -1 : 1))
    .slice(0, limit)
    .map(([token]) => token);
}

/**
 * 一段文本命中了几个锚词。
 *
 * @param {string[]} anchors
 * @param {string} text
 * @returns {number}
 */
export function matchAnchors(anchors, text) {
  if (!Array.isArray(anchors) || anchors.length === 0) return 0;
  const tokens = new Set(tokenize(String(text ?? '')));
  let matched = 0;
  for (const anchor of anchors) if (tokens.has(anchor)) matched += 1;
  return matched;
}

/**
 * 这条记忆是不是被"用上"了。
 *
 * 门槛是**命中 1 个锚词**。
 *
 * 为什么不要求两个：锚词取的是 IDF 最高的那几个词（df 常常只有 1 —— 全库就这条有），
 * 命中一个已经是很强的信号。实测要求两个时，真实库里 7 条明显在说同一件事的消息
 * 只有 1 条判得上 —— 用户复述时未必会把两个指纹词都说到。
 *
 * 反过来"撞上一个泛词就算"的担心不成立：能当锚词的词本身就不泛（饱和词 IDF 接近 0，
 * 根本进不了名单），撞上的概率极低。
 *
 * 而漏判是有代价的：`used` 永远为 0 的信号等于没有信号，白搭一套机制。
 *
 * @param {string[]} anchors
 * @param {string} text
 * @param {{minHits?: number}} [options]
 * @returns {boolean}
 */
export function isUsed(anchors, text, options = {}) {
  if (!Array.isArray(anchors) || anchors.length === 0) return false;
  const minHits = options.minHits ?? 1;
  return matchAnchors(anchors, text) >= minHits;
}
