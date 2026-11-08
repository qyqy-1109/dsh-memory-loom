/**
 * 成长度量：把「记得更多」和「变得更会判断」分开算。
 *
 * 为什么需要这个文件：条数增长是默认会发生的事，质变不是。
 * 库变胖的代价不在磁盘，而在**每轮注入的常量开销**和随之被稀释的注意力 ——
 * 约束 / 槽位 / 共同经历三块是每轮无条件注入的，句子越多，任何一条分到的注意力越少。
 *
 * 所以这里量的不是条数，是四件别的事：
 *
 *  1. `contractCost`   契约块开销 —— 每轮无条件注入的字符数，这是真金白银的预算。
 *  2. `rootCauseGroups` 同根因疤痕 —— 多条约束在讲同一件事，说明记住了场景、没抓住原理。
 *  3. `backtest`       回测 —— 把「合并后的原理」拿去重放它该覆盖的原条目：盖不住就是写窄了。
 *  4. `growthCurve`    密度 —— 每千字符承载多少区分词。跌 = 变胖，涨 = 变密。
 *
 * 全部是确定性计算：不调模型、不写库。这个数得天天能跑、天天一样，否则没法当趋势看。
 * 也因此它**只读** —— 度量器碰库，是比没有度量器更糟的事。
 *
 * @module dsh-memory-loom/growth
 */

import { similarity, tokenize, isoDay } from './text.js';
import { buildCorpus, coverageScore, idfOf, isStopToken } from './rank.js';
import { SAME_ROOT_THRESHOLD } from './store.js';

const DAY = 86_400_000;

/**
 * 度量默认参数。
 *
 * 不进 `TUNABLE`：这些是**读数口径**，不是库的参数。让用户在面板上调口径，
 * 得到的是一堆无法比较的历史曲线 —— 曲线只有口径固定才有意义。
 */
export const GROWTH_DEFAULTS = {
  /**
   * 两条约束算「同根因」的相似度门槛。
   *
   * 和写入期体检共用同一个常量（`store.js` 的 `SAME_ROOT_THRESHOLD`）：
   * 写的时候没提醒、事后又说它俩同根因，两句话互相打脸，人就再也不信任何一句。
   */
  rootCauseThreshold: SAME_ROOT_THRESHOLD,
  /** 回测：原理至少盖住原条目的多大比例，才算真的「包含了它」。 */
  coverageThreshold: 0.6,
  /** 成长曲线分几桶、每桶几天。 */
  buckets: 6,
  bucketDays: 7,
  /** 参与「同根因」判定的记忆种类。默认只看约束：疤痕主要长在这一层。 */
  kinds: ['constraint'],
};

/** 一条文本的「区分词」：去掉单字、问句填词、时间词、寒暄词之后剩下的词元。 */
export function contentOf(text) {
  return tokenize(text).filter((token) => !isStopToken(token));
}

/**
 * 契约块开销：本轮**必然**注入的那几块占多少字符。
 *
 * 格式与 `MemoryStore.buildRecall` 里三块的拼法逐字对齐（`1. ` / `- 实体·属性：值` /
 * `- 文本（场景：…）（日期）`），因为它度量的就是这个函数吐出来的东西。
 * 对齐这件事有测试盯着 —— 口径一旦漂移，曲线就不再可比。
 *
 * 为什么不算世界/事实/摘要：那几块受读闸门和查询影响，是**变量**开销；
 * 常量开销才是「库越大越贵」的那部分。
 *
 * @param {{memories?: Array<object>, slots?: Array<object>}} state
 * @param {{constraintLimit?: number, slotLimit?: number, episodeTop?: number}} [cfg]
 * @returns {{chars: number, total: number, blocks: Array<{name: string, title: string, count: number, chars: number, text: string}>}}
 */
export function contractCost(state, cfg = {}) {
  const limitConstraint = cfg.constraintLimit ?? 12;
  const limitSlot = cfg.slotLimit ?? 12;
  const topEpisode = cfg.episodeTop ?? 2;

  const memories = (state.memories ?? []).filter((row) => row.status === 'active');

  const constraints = memories
    .filter((row) => row.kind === 'constraint' && row.relaxedAt == null)
    .sort((left, right) => (right.updatedAt ?? 0) - (left.updatedAt ?? 0))
    .slice(0, limitConstraint);

  const slots = [...(state.slots ?? [])]
    .sort((left, right) => (right.updatedAt ?? 0) - (left.updatedAt ?? 0))
    .slice(0, limitSlot);

  const episodes = memories
    .filter((row) => row.kind === 'episode')
    .sort(
      (left, right) =>
        (right.significance ?? 0) - (left.significance ?? 0) || (right.updatedAt ?? 0) - (left.updatedAt ?? 0),
    )
    .slice(0, topEpisode);

  const blocks = [];
  if (constraints.length > 0) {
    blocks.push({
      name: 'constraints',
      title: '【必须遵守的约束】',
      count: constraints.length,
      text: constraints.map((row, index) => `${index + 1}. ${row.text}`).join('\n'),
    });
  }
  if (slots.length > 0) {
    blocks.push({
      name: 'slots',
      title: '【此刻的状态】',
      count: slots.length,
      text: slots.map((row) => `- ${row.entity}·${row.attr}：${row.value}`).join('\n'),
    });
  }
  if (episodes.length > 0) {
    blocks.push({
      name: 'episodes',
      title: '【一起经历过的事】',
      count: episodes.length,
      text: episodes
        .map((row) => `- ${row.text}${row.scene ? `（场景：${row.scene}）` : ''}${row.eventDate ? `（${row.eventDate}）` : ''}`)
        .join('\n'),
    });
  }

  const withChars = blocks.map((block) => ({ ...block, chars: [...block.text].length }));
  return {
    chars: withChars.reduce((sum, block) => sum + block.chars, 0),
    total: constraints.length + slots.length + episodes.length,
    blocks: withChars,
  };
}

/** 并查集：找根。 */
function rootOf(parents, id) {
  let cursor = id;
  while (parents.get(cursor) !== cursor) cursor = parents.get(cursor);
  return cursor;
}

/**
 * 同根因疤痕：把讲同一件事的多条约束聚成一组。
 *
 * 判据用的是库自己的 `similarity`（0.5 Jaccard + 0.5 containment），不另造一把尺子 ——
 * 度量口径和入库查重口径不一致的话，两条「明明是一回事」的约束会永远聚不到一起。
 *
 * 贪心聚类：相似度从高到低取边，两端还没合并就并。为什么不要求「组内两两都相似」：
 * 疤痕的典型形态正是 A≈B、B≈C、A 与 C 说法差很远，全连接会让它们留在外面。
 *
 * `margin` 是这组结果可不可信的唯一凭据：组内最弱的一对相似度 vs 组外最强的一对。
 * 前者不大于后者时，分组可能只是巧合，`stable` 会是 false —— 这种组不写进建议，只做提示。
 *
 * @param {Array<{id: string, text: string, kind?: string}>} rows
 * @param {{threshold?: number}} [options]
 * @returns {Array<object>}
 */
export function rootCauseGroups(rows, options = {}) {
  const threshold = options.threshold ?? GROWTH_DEFAULTS.rootCauseThreshold;
  const list = (rows ?? []).filter((row) => typeof row?.text === 'string' && row.text.trim().length > 0);
  if (list.length < 2) return [];

  const corpus = buildCorpus(list);
  const tokensById = new Map(list.map((row) => [row.id, contentOf(row.text)]));

  const edges = [];
  for (let left = 0; left < list.length; left += 1) {
    for (let right = left + 1; right < list.length; right += 1) {
      const score = similarity(list[left].text, list[right].text);
      if (score >= threshold) edges.push({ left, right, score });
    }
  }
  if (edges.length === 0) return [];
  edges.sort((a, b) => b.score - a.score);

  const parents = new Map(list.map((row) => [row.id, row.id]));
  for (const edge of edges) {
    const leftRoot = rootOf(parents, list[edge.left].id);
    const rightRoot = rootOf(parents, list[edge.right].id);
    if (leftRoot !== rightRoot) parents.set(leftRoot, rightRoot);
  }

  const buckets = new Map();
  for (const row of list) {
    const root = rootOf(parents, row.id);
    if (!buckets.has(root)) buckets.set(root, []);
    buckets.get(root).push(row);
  }

  const groups = [];
  for (const members of buckets.values()) {
    if (members.length < 2) continue;

    // 组内最弱的一对 vs 组外最强的一对：决定这组是不是巧合。
    let minIn = 1;
    for (let left = 0; left < members.length; left += 1) {
      for (let right = left + 1; right < members.length; right += 1) {
        minIn = Math.min(minIn, similarity(members[left].text, members[right].text));
      }
    }
    let maxOut = 0;
    const memberIds = new Set(members.map((row) => row.id));
    for (const row of list) {
      if (memberIds.has(row.id)) continue;
      for (const member of members) maxOut = Math.max(maxOut, similarity(row.text, member.text));
    }

    // 共同词 = 全组成员都有的区分词，按 IDF 从稀有到常见排（稀有的才是真正的根因线索）。
    const shared = [...tokensById.get(members[0].id)].filter((token) =>
      members.every((row) => tokensById.get(row.id).includes(token)),
    );
    const sharedTokens = shared
      .map((token) => ({ token, idf: idfOf(corpus, token) }))
      .sort((left, right) => right.idf - left.idf || left.token.localeCompare(right.token));

    // 骨架：把其它成员盖得最全的那条（不是最长的，也不是最新的）。
    let skeleton = null;
    for (const candidate of members) {
      const doc = tokensById.get(candidate.id);
      let sum = 0;
      for (const other of members) {
        if (other.id === candidate.id) continue;
        sum += coverageScore(tokensById.get(other.id), doc, corpus);
      }
      const average = members.length > 1 ? sum / (members.length - 1) : 0;
      const better =
        skeleton === null ||
        average > skeleton.average + 1e-9 ||
        (Math.abs(average - skeleton.average) <= 1e-9 && [...candidate.text].length > [...skeleton.row.text].length);
      if (better) skeleton = { row: candidate, average };
    }

    // 补充词：组内 ≥2 条共有、但骨架自己没提到的 —— 合并时必须显式补进去，
    // 否则「合并」等于偷偷丢信息，覆盖面看着高，实际是漏的。
    const skeletonTokens = new Set(tokensById.get(skeleton.row.id));
    const counts = new Map();
    for (const row of members) {
      for (const token of tokensById.get(row.id)) {
        if (skeletonTokens.has(token)) continue;
        counts.set(token, (counts.get(token) ?? 0) + 1);
      }
    }
    const supportTokens = [...counts.entries()]
      .filter(([, count]) => count >= 2)
      .map(([token, count]) => ({ token, count, idf: idfOf(corpus, token) }))
      .sort((left, right) => right.count - left.count || right.idf - left.idf || left.token.localeCompare(right.token));

    const before = members.reduce((sum, row) => sum + [...row.text].length, 0);
    const after = [...skeleton.row.text].length + supportTokens.reduce((sum, item) => sum + [...item.token].length, 0);

    groups.push({
      ids: members.map((row) => row.id),
      members: members.map((row) => ({ id: row.id, text: row.text, kind: row.kind ?? null })),
      size: members.length,
      minIn,
      maxOut,
      stable: minIn > maxOut,
      sharedTokens,
      skeletonId: skeleton.row.id,
      skeletonText: skeleton.row.text,
      skeletonAverage: skeleton.average,
      supportTokens,
      /** 上限估算：全组字符数 → 骨架 + 补充词。真实收益看 `backtest` 有没有满覆盖。 */
      save: { before, after, saved: Math.max(0, before - after), ratio: before > 0 ? Math.max(0, (before - after) / before) : 0 },
    });
  }

  return groups.sort((left, right) => right.size - left.size || right.save.saved - left.save.saved);
}

/**
 * 回测：骨架 + 补充词，能不能盖住它声称覆盖的那些原条目。
 *
 * 输出逐条的覆盖率，以及**盖不住的那部分词**。后者才是可执行的信息：
 * 「这条原理还差『编码』『GBK』两个词」比「覆盖率 0.62」有用得多。
 *
 * 注意这里是**重放**，不是预测：样本是写原理时手边就有的那几条，
 * 所以回测通过只说明「没丢信息」，不说明「能迁移」。迁移要看新条目第一次撞上时有没有被自动召回。
 *
 * 还有一处口径要认账：覆盖率是**词覆盖**，它分不清「根因细节」（编码、GBK）和「语境细节」
 * （某个仓库名）。所以低分不要当成「原理写错了」，它给的是定位线索 —— 缺哪些词，
 * 让人自己判断漏的那块是不是根因。真实库里那对 PowerShell 约束只到 10%，
 * 但两条确实是同一件事：一条讲 BOM，一条讲 GBK，同一个「静默改字节」的根因。
 * 这正是它该给出的结论形态：不是「合并它们」，而是「写一条把两者都包住的新原理」。
 *
 * @param {object} group `rootCauseGroups` 返回的一组
 * @param {{threshold?: number}} [options]
 */
export function backtest(group, options = {}) {
  const threshold = options.threshold ?? GROWTH_DEFAULTS.coverageThreshold;
  const members = group?.members ?? [];
  if (members.length === 0) return { rows: [], average: 0, minimum: 0, pass: true, threshold };

  const corpus = buildCorpus(members);
  const tokensById = new Map(members.map((row) => [row.id, contentOf(row.text)]));
  const skeletonTokens = tokensById.get(group.skeletonId) ?? [];
  const doc = new Set([...skeletonTokens, ...(group.supportTokens ?? []).map((item) => item.token)]);

  const rows = members.map((row) => {
    const own = tokensById.get(row.id);
    const missing = own.filter((token) => !doc.has(token));
    return {
      id: row.id,
      ratio: coverageScore(own, [...doc], corpus),
      missing,
      isSkeleton: row.id === group.skeletonId,
    };
  });

  const ratios = rows.map((row) => row.ratio);
  return {
    rows,
    average: ratios.reduce((sum, value) => sum + value, 0) / ratios.length,
    minimum: Math.min(...ratios),
    pass: ratios.every((value) => value >= threshold),
    threshold,
  };
}

/**
 * 成长曲线：按桶看「密度」而不是条数。
 *
 * 密度 = 活跃条目里的区分词总数 / 每千字符。
 * 它涨，说明新增的东西带来了新的区分度（在长）；它跌，说明在反复说差不多的话（在胖）。
 * 条数只是分子的一部分，所以条数涨而密度跌，是「变胖」最典型的形状。
 *
 * 桶从**最早一条**开始切，不从「今天往前推」切：往前推的话，早期内容会挤在第一个桶里，
 * 曲线开头必然虚高，看起来永远像在下滑。
 *
 * @param {{memories?: Array<object>, slots?: Array<object>}} state
 * @param {{now?: number, buckets?: number, bucketDays?: number}} [options]
 */
export function growthCurve(state, options = {}) {
  const now = options.now ?? Date.now();
  const bucketCount = Math.max(1, options.buckets ?? GROWTH_DEFAULTS.buckets);
  const requestedDays = Math.max(1, options.bucketDays ?? GROWTH_DEFAULTS.bucketDays);
  const memories = (state.memories ?? []).filter((row) => Number.isFinite(row?.createdAt));
  if (memories.length === 0) return { buckets: [], direction: 'flat', from: null, to: null, bucketDays: 0 };

  const oldest = Math.min(...memories.map((row) => row.createdAt));
  /**
   * 桶宽自适应：库还很年轻的时候（比如刚建三天）按 7 天切只会得到一个桶，
   * 那个桶的密度是**水平**不是**趋势** —— 一个点画不出斜率，报"持平"等于什么都没说。
   * 所以按「跨度 / 桶数」收窄，最小 1 天；等库老了自然回到配置值。
   */
  const spanDays = Math.max(1, Math.ceil((now - oldest) / DAY));
  const bucketDays = Math.max(1, Math.min(requestedDays, Math.ceil(spanDays / bucketCount)));
  const bucketMs = bucketDays * DAY;
  const span = Math.max(1, Math.ceil((now - oldest) / bucketMs));
  const count = Math.min(bucketCount, span);
  const startOf = (index) => oldest + index * bucketMs;

  const buckets = [];
  for (let index = 0; index < count; index += 1) {
    const start = startOf(index);
    const end = index === count - 1 ? now + 1 : startOf(index + 1);
    const alive = memories.filter(
      (row) => row.createdAt < end && (row.status === 'active' || (row.archivedAt ?? 0) >= end),
    );
    const added = memories.filter((row) => row.createdAt >= start && row.createdAt < end).length;
    const chars = alive.reduce((sum, row) => sum + [...String(row.text ?? '')].length, 0);
    const distinct = new Set(alive.flatMap((row) => contentOf(row.text))).size;
    const slots = (state.slots ?? []).filter((slot) => (slot.createdAt ?? 0) < end);
    buckets.push({
      start,
      end,
      day: isoDay(start),
      added,
      active: alive.length,
      chars,
      distinct,
      density: chars > 0 ? (distinct / chars) * 1000 : 0,
      contractChars: contractCost({ memories: alive, slots }).chars,
    });
  }

  const half = Math.max(1, Math.floor(buckets.length / 2));
  const meanOf = (slice) => slice.reduce((sum, bucket) => sum + bucket.density, 0) / Math.max(1, slice.length);
  const from = meanOf(buckets.slice(0, half));
  const to = meanOf(buckets.slice(-half));
  const direction = to > from * 1.05 ? 'up' : to < from * 0.95 ? 'down' : 'flat';

  return { buckets, direction, from, to, bucketDays };
}

/**
 * 把一串词元压成能读的短列表：长的优先，和已选词撞字就丢掉。
 *
 * 为什么需要：`tokenize` 对中文给的是**全部二元组**，包括跨词边界切出来的碎片
 * （「源码只用」会切出 `源码` / `码只` / `只用`）。这些碎片在检索里无害（权重低、会互相抵消），
 * 但打印给人看时像乱码 —— 而读数一旦看起来像乱码，就没人会信它。
 *
 * 压完还是会有碎片（`只用` 这种），所以文案里要如实标「含跨词碎片」，不假装切得干净。
 *
 * @param {string[]} tokens
 * @param {number} [limit]
 * @returns {string[]}
 */
export function collapseTokens(tokens, limit = 8) {
  const sorted = [...new Set(tokens ?? [])].sort(
    (left, right) => [...right].length - [...left].length || String(left).localeCompare(String(right)),
  );
  const kept = [];
  const used = new Set();
  for (const token of sorted) {
    const chars = [...String(token)];
    if (chars.some((char) => used.has(char))) continue;
    kept.push(token);
    for (const char of chars) used.add(char);
    if (kept.length >= limit) break;
  }
  return kept;
}

/**
 * 使用信号：命中过的条目里，有多少真的被用上了。
 *
 * `hits` 记的是「被展示」，`usedCount` 记的是「下一轮里它的指纹词出现了」。
 * 两者的差就是回声室的体积：展示一百次、一次也没用上的东西，仍然会越排越前。
 *
 * @param {{memories?: Array<object>}} state
 */
export function usedSignal(state) {
  const active = (state.memories ?? []).filter((row) => row.status === 'active');
  const hitRows = active.filter((row) => (row.hits ?? 0) > 0);
  const usedRows = hitRows.filter((row) => (row.usedCount ?? 0) > 0);
  return {
    active: active.length,
    hitRows: hitRows.length,
    usedRows: usedRows.length,
    rate: hitRows.length > 0 ? usedRows.length / hitRows.length : 0,
    /** 展示过、但从未在下一轮被用上 —— 这些是回声室的存量。 */
    echoRows: hitRows.length - usedRows.length,
  };
}

/**
 * 改写信号：有多少条目被推翻过。
 *
 * 这是比 `usedSignal` 更硬的价值信号，理由是对着真实库量出来的：
 * `usedCount` 要求"你在下一句里复述我的锚词"，而锚词是中文二元组，结构性命中不了 ——
 * 实测 `memory.usage` 两条都是 `offered 5~6 / hit 0`，全库 `usedCount > 0` 的条目 0 条。
 * 而"被改写"记的是**这条不够用**：被 supersedes 取代、被解除、或者是近似新条目撞上来
 * （写的时候没指定 supersedes，但形状对得上）。
 *
 * 口径上有一处必须数全库：被改写的那条通常已经归档或已解除，只数活跃集会把整类漏掉 ——
 * 那正是 `usedCount` 栽过的坑（口径把自己算死）。
 *
 * @param {{memories?: Array<object>}} state
 */
export function reviseSignal(state) {
  const rows = (state.memories ?? []).filter((row) => Number.isFinite(row?.createdAt));
  const revised = rows.filter((row) => (row.revisedCount ?? 0) > 0);
  const byKind = {};
  for (const row of revised) byKind[row.kind] = (byKind[row.kind] ?? 0) + 1;
  const touched = revised.reduce((sum, row) => sum + (row.revisedCount ?? 0), 0);
  return {
    rows: rows.length,
    revisedRows: revised.length,
    /** 被改写过的条目占全库比例：0 说明连证伪都没发生过，样本还不够 */
    rate: rows.length > 0 ? revised.length / rows.length : 0,
    /** 改写事件总次数（一条可能被改多次） */
    touched,
    byKind,
    /** 被改写的最多的那一类：契约层翻修多，说明疤痕在长 */
    heaviestKind: Object.entries(byKind).sort((left, right) => right[1] - left[1])[0]?.[0] ?? null,
    /**
     * 历史改写的回填有没有做过。
     *
     * 字段是后加的，回填发生在 `MemoryStore.open()` 里；而这个读数器是**只读开库**的，
     * 所以在一个新版本还没打开过的库上跑，它会看到一堆 0 —— 那是"还没补"，不是"没有"。
     * 不把这件事说出来，读数就会误导人：明明是没测，看着像没发生。
     */
    backfilled: state.meta?.revisedBackfill === true,
  };
}

/**
 * 一次算完所有读数，并给出可执行的话。
 *
 * `notes` 是要人看的那几句：每条都必须是「能改的东西」，不写「一切正常」这类填空题。
 *
 * @param {{memories?: Array<object>, slots?: Array<object>}} state
 * @param {object} [options] 透传给各读数：`now` / `threshold` / `coverageThreshold` / `buckets` / `kinds` / `contract`
 */
export function analyzeGrowth(state, options = {}) {
  const cfg = options.contract ?? {};
  const kinds = new Set(options.kinds ?? GROWTH_DEFAULTS.kinds);
  const contract = contractCost(state, cfg);

  const scarRows = (state.memories ?? []).filter(
    (row) => row.status === 'active' && kinds.has(row.kind) && row.relaxedAt == null,
  );
  const groups = rootCauseGroups(scarRows, { threshold: options.threshold }).map((group) => ({
    ...group,
    backtest: backtest(group, { threshold: options.coverageThreshold }),
  }));

  const growth = growthCurve(state, options);
  const used = usedSignal(state);
  const revise = reviseSignal(state);

  const notes = [];
  const stable = groups.filter((group) => group.stable);
  if (stable.length > 0) {
    const savedChars = stable.reduce((sum, group) => sum + group.save.saved, 0);
    const share = contract.chars > 0 ? savedChars / contract.chars : 0;
    notes.push(
      `${stable.length} 组同根因疤痕（共 ${stable.reduce((sum, group) => sum + group.size, 0)} 条），` +
        `按骨架合并可省 ${savedChars} 字，占契约块 ${(share * 100).toFixed(0)}%`,
    );
  }
  const fragile = groups.filter((group) => !group.stable);
  if (fragile.length > 0) {
    notes.push(`${fragile.length} 组相似度没有超过组外最高值，可能只是说法像，别急着合并`);
  }
  for (const group of groups) {
    if (group.backtest.pass) continue;
    const worst = [...group.backtest.rows].sort((left, right) => left.ratio - right.ratio)[0];
    const gap = collapseTokens(worst?.missing ?? [], 6).join('、') || '无';
    notes.push(
      `骨架盖不住全部原条目（最低 ${(group.backtest.minimum * 100).toFixed(0)}%），缺的词：${gap}` +
        ` —— 说明这不是「把两条合并成一条」，而是要写一条新的原理把两者都包住`,
    );
  }

  if (growth.direction === 'down') {
    notes.push(
      `密度在下滑（${growth.from.toFixed(1)} → ${growth.to.toFixed(1)} 区分词/千字）：条数在涨，内容在变稀`,
    );
  } else if (growth.direction === 'up') {
    notes.push(`密度在上升（${growth.from.toFixed(1)} → ${growth.to.toFixed(1)} 区分词/千字）：新增内容带来了新的区分度`);
  }

  /**
   * 改写率是**主**信号，used 是**副**信号 —— 顺序不是排版选择：
   * used 在真实库上结构性命中不了（offered 5 / hit 0），先把它摆在前面，
   * 人就会去追一个永远不会动的数。改写率先说。
   */
  if (revise.revisedRows > 0) {
    const kindNote =
      revise.heaviestKind === null ? '' : `，最集中在 ${revise.heaviestKind}（${revise.byKind[revise.heaviestKind]} 条）`;
    notes.push(
      `改写率 ${(revise.rate * 100).toFixed(0)}%（${revise.revisedRows}/${revise.rows}，共 ${revise.touched} 次）` +
        `${kindNote} —— 这是比 used 硬的价值信号：它记的是"这条不够用"`,
    );
  } else {
    notes.push(
      `改写率 0/${revise.rows}：还没有任何条目被推翻或被撞上，证伪信号暂时是空的 —— ` +
        (revise.backfilled
          ? '别据此认为库很稳，可能只是还没遇到反例'
          : '历史改写要等新版本首次打开库时才回填，现在这个 0 是"还没补"而不是"没发生"'),
    );
  }

  if (used.hitRows > 0 && used.rate < 0.3) {
    notes.push(
      `顺带：used 只有 ${used.usedRows}/${used.hitRows}（${(used.rate * 100).toFixed(0)}%），` +
        '这个口径要求你在下一句里复述我的锚词，结构上就命中不了，别把它的 0 当成"没用上"',
    );
  } else if (used.hitRows === 0) {
    notes.push('还没有任何条目被召回记录过：先让它跑一段时间，别急着下结论');
  }

  if (growth.buckets.length > 0 && growth.buckets.length < 4) {
    notes.push(`曲线只有 ${growth.buckets.length} 个桶，趋势只能当提示，不够下结论`);
  }

  if (contract.chars > 0) {
    const heaviest = [...contract.blocks].sort((left, right) => right.chars - left.chars)[0];
    notes.push(`契约块每轮固定 ${contract.chars} 字，最重的是${heaviest.title}（${heaviest.chars} 字）`);
  }

  const active = (state.memories ?? []).filter((row) => row.status === 'active').length;
  let status = 'growing';
  if (active === 0) status = 'empty';
  else if (growth.direction === 'down') status = 'fattening';
  else if (stable.length > 0) status = 'patching';
  else if (growth.direction === 'flat') status = 'flat';

  return {
    status,
    contract,
    groups,
    growth,
    used,
    revise,
    notes,
    /** 一句话读数：面板/命令行都显示这句。 */
    headline:
      {
        growing: '在长：新增内容带来了新的区分度',
        patching: '在补：疤痕还没合并，语料在按场景堆积',
        fattening: '在胖：条数涨、密度跌，说的还是那些话',
        flat: '平稳：没有变胖也没有变密',
        empty: '还没有记忆',
      }[status],
  };
}
