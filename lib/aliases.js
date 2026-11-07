/**
 * 领域别名表：中文提问 ↔ 代码里的英文标识。
 *
 * 检索是字面的，而记忆里写的是 `memory_search`、`restore`、`config` 这类英文标识，
 * 用户问的却是「搜索」「恢复」「参数」——不打通这层，问句再好也搜不到。
 *
 * 只做**查询侧扩展**：文档侧不动，避免影响查重语义。
 */
const ALIASES = {
  搜索: ['search'],
  检索: ['search'],
  查询: ['search'],
  恢复: ['restore', 'recover'],
  撤销: ['restore', 'undo'],
  归档: ['archive', 'archived'],
  摘要: ['summary', 'summarize'],
  归纳: ['summary', 'summarize'],
  参数: ['config', 'tunable'],
  配置: ['config'],
  冷却: ['cooldown'],
  模型: ['model', 'llm'],
  记忆: ['memory'],
  帧率: ['fps'],
  面板: ['panel'],
  入口: ['entry'],
  窗口: ['window'],
  时间: ['since', 'until'],
  查重: ['dedupe', 'duplicate'],
  容量: ['capacity'],
  槽位: ['slot'],
  约束: ['constraint'],
  经历: ['episode'],
  权重: ['weight'],
  批量: ['batch', 'entries'],
  流式: ['stream'],
  超时: ['timeout'],
  备份: ['backup'],
  压缩: ['compact'],
};

/**
 * 给查询词补上领域别名（只补语料里真实存在的，避免污染分母）。
 *
 * @param {string[]} queryTokens
 * @param {{df: Map<string, number>}} corpus
 * @returns {string[]}
 */
export function expandQueryTokens(queryTokens, corpus) {
  const out = new Set(queryTokens);
  for (const token of queryTokens) {
    const aliases = ALIASES[token];
    if (aliases === undefined) continue;
    for (const alias of aliases) {
      if ((corpus.df.get(alias) ?? 0) > 0) out.add(alias);
    }
  }
  return [...out];
}
