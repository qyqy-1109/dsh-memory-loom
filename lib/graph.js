/**
 * 记忆之间的关系图：共激活边（co-activation）。
 *
 * 为什么用「共激活」而不是「文本相似度」建边：
 * 相似度是事先写好的一把尺子（CJK 二元组），用它连出来的图只是把相似矩阵画成线，
 * 形状完全由尺子决定，不产生任何新信息 —— 那是伪结构。
 * 共激活是使用留下的痕迹：两条记忆在同一轮召回里一起被注入、之后又反复一起被需要，
 * 才连成一条边。边是结果，不是预设。这是 Hebbian 的雏形，也是唯一能在本插件
 * 现有信号（每轮 hits）里免费拿到的「涌现」原料。
 *
 * 为什么只让**检索命中**的条目参与配对：
 * constraint / slot / episode 是常驻块，每轮无条件注入，和所有东西都"共现"。
 * 放它们进来，每个节点都会连到约束上，图塌成一个星形，信息量为零。
 * 这和 rank.js 把高频词从分母里剔掉是同一件事：饱和的东西不携带区分度。
 *
 * 边的寿命与上限（缺一不可）：
 * - 权重随半衰期衰减，低于 minWeight 的死边直接剪掉 —— 关系会淡，不该永久占位；
 * - 每节点度数有上限：不设上限就会长出全连接图，全连接图 = 熵最大 = 零结构。
 *   有人以为"连得越多越聪明"，实际上稠密到一定程度就和没有边一样没有信息。
 * - 全局条数上限，防止 store.json 被这一层拖肥。
 */

/** 一条边 {a, b, w, at}：a/b 是记忆 id（a < b 字典序，同一条边只存一次），w 权重，at 最后一次共现时刻。 */

/**
 * 规范化一条边的端点顺序，保证同一对记忆只可能有一个 key。
 * @param {string} a
 * @param {string} b
 * @returns {[string, string]}
 */
export function orderPair(a, b) {
  return a <= b ? [a, b] : [b, a];
}

/** 边的唯一键：端点 id 里不会出现 \u0000。 */
function keyOf(a, b) {
  const [left, right] = orderPair(a, b);
  return `${left}\u0000${right}`;
}

/**
 * 当前权重：按最后一次共现时刻做半衰。
 * @param {{w: number, at: number}} edge
 * @param {number} now
 * @param {number} halfLifeDays
 * @returns {number}
 */
export function strengthOf(edge, now, halfLifeDays) {
  const w = Number(edge?.w ?? 0);
  if (!Number.isFinite(w) || w <= 0) return 0;
  const ageDays = Math.max(0, (now - Number(edge?.at ?? now)) / 86_400_000);
  const decay = 0.5 ** (ageDays / Math.max(1, halfLifeDays));
  return w * decay;
}

/**
 * 记录一次共召回：把这一组 id 两两之间的边各加一分。
 *
 * 先衰减再累加（`w = w·decay + 1`），不是直接 `w + 1`：
 * 否则半年前连过的旧关系会带着满权重跟新关系抢排名。
 *
 * @param {Array<{a: string, b: string, w: number, at: number}>} edges 原地修改
 * @param {string[]} ids 本轮一起被召回的记忆 id（调用方需已过滤常驻块与弱相关）
 * @param {{now?: number, halfLifeDays?: number, fanout?: number}} [options]
 *   fanout：一轮最多让前几个条目参与配对。命中 8 条就有 28 对，
 *   再多的话每轮都在给图灌噪声 —— 相关度最高的那几条才是这次真正"一起想到"的。
 * @returns {{pairs: number, created: number, updated: number}}
 */
export function coActivate(edges, ids, options = {}) {
  const now = options.now ?? Date.now();
  const halfLifeDays = options.halfLifeDays ?? 30;
  const fanout = Math.max(2, options.fanout ?? 8);
  // 去重 + 截断（去重要用同一种字符串形态，否则同一 id 的不同写法会互相配对）
  const unique = [...new Set((ids ?? []).map((id) => String(id)).filter((id) => id.length > 0))].slice(0, fanout);
  if (unique.length < 2) return { pairs: 0, created: 0, updated: 0 };

  const index = new Map();
  for (const edge of edges) index.set(keyOf(edge.a, edge.b), edge);

  let created = 0;
  let updated = 0;
  let pairs = 0;
  for (let i = 0; i < unique.length; i += 1) {
    for (let j = i + 1; j < unique.length; j += 1) {
      const [left, right] = orderPair(unique[i], unique[j]);
      pairs += 1;
      const existing = index.get(keyOf(left, right));
      if (existing === undefined) {
        const edge = { a: left, b: right, w: 1, at: now };
        edges.push(edge);
        index.set(keyOf(left, right), edge);
        created += 1;
        continue;
      }
      existing.w = strengthOf(existing, now, halfLifeDays) + 1;
      existing.at = now;
      updated += 1;
    }
  }
  return { pairs, created, updated };
}

/**
 * 修剪：丢掉死边、幽灵端点、度数超标的弱关系、全局超量的低权重边。
 *
 * @param {Array<{a: string, b: string, w: number, at: number}>} edges
 * @param {{now?: number, halfLifeDays?: number, minWeight?: number, maxDegree?: number, maxEdges?: number, alive?: (id: string) => boolean}} [options]
 *   alive：端点是否仍然存在（记忆被物理删除后，边不该留着占额度）
 * @returns {{edges: Array<object>, dropped: number, byReason: {dead: number, ghost: number, degree: number, global: number}}}
 */
export function pruneEdges(edges, options = {}) {
  const now = options.now ?? Date.now();
  const halfLifeDays = options.halfLifeDays ?? 30;
  const minWeight = options.minWeight ?? 0.25;
  const maxDegree = Math.max(1, options.maxDegree ?? 12);
  const maxEdges = Math.max(0, options.maxEdges ?? 6000);
  const alive = typeof options.alive === 'function' ? options.alive : null;
  const byReason = { dead: 0, ghost: 0, degree: 0, global: 0 };

  // ① 死边（衰减到阈值以下）+ 幽灵边（端点已不在库里）
  const scored = [];
  for (const edge of edges) {
    if (alive !== null && (!alive(edge.a) || !alive(edge.b))) {
      byReason.ghost += 1;
      continue;
    }
    const strength = strengthOf(edge, now, halfLifeDays);
    if (strength < minWeight) {
      byReason.dead += 1;
      continue;
    }
    scored.push({ edge, strength });
  }

  // ② 度数上限：每个节点只留最强的 maxDegree 条
  // 先按强度从高到低排序，强的先占坑，弱的才被挤掉 —— 顺序决定了谁活下来。
  scored.sort((left, right) => right.strength - left.strength);
  const degree = new Map();
  const kept = [];
  for (const item of scored) {
    const { a, b } = item.edge;
    const da = degree.get(a) ?? 0;
    const db = degree.get(b) ?? 0;
    if (da >= maxDegree || db >= maxDegree) {
      byReason.degree += 1;
      continue;
    }
    degree.set(a, da + 1);
    degree.set(b, db + 1);
    kept.push(item);
  }

  // ③ 全局条数上限：最弱的先走
  if (kept.length > maxEdges) {
    byReason.global = kept.length - maxEdges;
    kept.length = maxEdges;
  }

  return {
    edges: kept.map((item) => item.edge),
    dropped: byReason.dead + byReason.ghost + byReason.degree + byReason.global,
    byReason,
  };
}

/**
 * 导出面板可用的边列表：只留在场端点之间的边，带衰减后的强度。
 *
 * @param {Array<{a: string, b: string, w: number, at: number}>} edges
 * @param {{now?: number, halfLifeDays?: number, minWeight?: number, limit?: number}} [options]
 * @returns {Array<{a: string, b: string, strength: number, at: number}>}
 */
export function visibleEdges(edges, options = {}) {
  const now = options.now ?? Date.now();
  const halfLifeDays = options.halfLifeDays ?? 30;
  const minWeight = options.minWeight ?? 0.25;
  const limit = options.limit ?? 1200;
  const out = [];
  for (const edge of edges) {
    const strength = strengthOf(edge, now, halfLifeDays);
    if (strength < minWeight) continue;
    out.push({ a: edge.a, b: edge.b, strength: Number(strength.toFixed(3)), at: edge.at });
  }
  out.sort((left, right) => right.strength - left.strength);
  return out.slice(0, limit);
}

/**
 * 图的粗粒度统计（面板顶部与健康灯用）。
 *
 * @param {Array<{a: string, b: string, w: number, at: number}>} edges
 * @param {{now?: number, halfLifeDays?: number, minWeight?: number}} [options]
 * @returns {{edges: number, nodes: number, density: number, meanDegree: number, maxDegree: number}}
 */
export function graphStats(edges, options = {}) {
  const now = options.now ?? Date.now();
  const halfLifeDays = options.halfLifeDays ?? 30;
  const minWeight = options.minWeight ?? 0.25;
  const degree = new Map();
  let live = 0;
  for (const edge of edges) {
    if (strengthOf(edge, now, halfLifeDays) < minWeight) continue;
    live += 1;
    degree.set(edge.a, (degree.get(edge.a) ?? 0) + 1);
    degree.set(edge.b, (degree.get(edge.b) ?? 0) + 1);
  }
  const nodes = degree.size;
  const degrees = [...degree.values()];
  const sum = degrees.reduce((acc, value) => acc + value, 0);
  return {
    edges: live,
    nodes,
    // 密度 = 实有边 / 完全图边数。这个值长期偏高就说明图已经稠密到没有结构了。
    density: nodes > 1 ? Number(((2 * live) / (nodes * (nodes - 1))).toFixed(4)) : 0,
    meanDegree: nodes > 0 ? Number((sum / nodes).toFixed(2)) : 0,
    maxDegree: degrees.length > 0 ? Math.max(...degrees) : 0,
  };
}
