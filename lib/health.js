/**
 * 六层健康：把「记忆到底有没有在动」变成可核验的状态词。
 *
 * 词表固定成五个（和「旧识」一致）：`ok` / `empty` / `degraded` / `disabled` / `unknown`。
 * 规矩同样是「宁可显式 empty，也不留空白」：
 * - 还没到触发点 → `empty (0/…)`，不是沉默；
 * - 库读坏了 → `degraded` 并把原因写进 detail；
 * - 功能被配置关掉 → `disabled`。
 *
 * @module dsh-memory-loom/health
 */

/** 状态词。 */
export const STATUS = {
  OK: 'ok',
  EMPTY: 'empty',
  DEGRADED: 'degraded',
  DISABLED: 'disabled',
  UNKNOWN: 'unknown',
};

const DAY = 86_400_000;

/** 一条埋点里最近一次的某种 kind。 */
function lastEvent(state, kind) {
  for (let index = state.events.length - 1; index >= 0; index -= 1) {
    if (state.events[index]?.kind === kind) return state.events[index];
  }
  return undefined;
}

/** 最近 24 小时内的写入条数。 */
function writesWithin(state, windowMs, now) {
  const since = now - windowMs;
  return state.events.filter((event) => event.kind === 'write.create' && event.ts >= since).length;
}

/**
 * 计算六层状态。
 * @param {import('./store.js').MemoryStore} store
 * @param {{recallEnabled?: boolean, writeEnabled?: boolean, now?: number, summaryEvery?: number}} [options]
 * @returns {{layers: Array<{key: string, name: string, status: string, detail: string, value: number}>, statuses: Record<string, string>}}
 */
export function computeHealth(store, options = {}) {
  const now = options.now ?? Date.now();
  const state = store.state;
  const counts = store.counts();
  const layers = [];

  // ① 写入层：最近 24 小时有没有真的写进来。
  if (options.writeEnabled === false) {
    layers.push({ key: 'write', name: '写入层', status: STATUS.DISABLED, detail: '已在配置里关闭写入', value: 0 });
  } else if (store.loadError !== null && store.loadError !== undefined) {
    layers.push({
      key: 'write',
      name: '写入层',
      status: STATUS.DEGRADED,
      detail: `记忆库读取失败，已用空库启动：${store.loadError}`,
      value: 0,
    });
  } else if (counts.active === 0 && counts.archived === 0) {
    layers.push({ key: 'write', name: '写入层', status: STATUS.EMPTY, detail: '还没有任何记忆', value: 0 });
  } else {
    const recentWrites = writesWithin(state, DAY, now);
    const lastWrite = lastEvent(state, 'write.create');
    const detail =
      lastWrite === undefined
        ? '有存量记忆，但没有写路径埋点'
        : `24 小时内写入 ${recentWrites} 条，最近一次在 ${new Date(lastWrite.ts).toLocaleString('zh-CN')}`;
    layers.push({
      key: 'write',
      name: '写入层',
      status: recentWrites > 0 || counts.active > 0 ? STATUS.OK : STATUS.EMPTY,
      detail,
      value: recentWrites,
    });
  }

  // ② 摘要层：达到压缩线后由 store 自动归纳同主题冗余；没到线就如实说 empty。
  if (counts.summaries === 0) {
    const compactAt = store.cfg?.compactAt ?? 0;
    layers.push({
      key: 'summary',
      name: '摘要层',
      status: STATUS.EMPTY,
      detail:
        compactAt > 0
          ? `尚无摘要：活跃 ${counts.active} 条，到 ${compactAt} 条开始归纳同主题冗余`
          : '尚无摘要（自动压缩已关闭）',
      value: 0,
    });
  } else {
    layers.push({
      key: 'summary',
      name: '摘要层',
      status: STATUS.OK,
      detail: `已有 ${counts.summaries} 条滚动摘要`,
      value: counts.summaries,
    });
  }

  // ③ 召回层：看最近一次召回现场，而不是看计数器。
  const recall = state.recall?.last ?? null;
  if (options.recallEnabled === false) {
    layers.push({ key: 'recall', name: '召回层', status: STATUS.DISABLED, detail: '已在配置里关闭自动召回', value: 0 });
  } else if (recall === null) {
    layers.push({ key: 'recall', name: '召回层', status: STATUS.UNKNOWN, detail: '还没有跑过召回', value: 0 });
  } else {
    const hits = Array.isArray(recall.hits) ? recall.hits.filter((hit) => hit.score !== null) : [];
    const strong = hits.filter((hit) => hit.score >= (recall.threshold ?? 0) * 1.3).length;
    layers.push({
      key: 'recall',
      name: '召回层',
      status: hits.length === 0 ? STATUS.EMPTY : STATUS.OK,
      detail:
        hits.length === 0
          ? `最近一次查询没有命中（阈值 ${recall.threshold}）`
          : `最近一次召回命中 ${hits.length} 条，其中 ${strong} 条高于弱相关线（阈值 ${recall.threshold}）`,
      value: hits.length,
    });
  }

  // ④ 约束层：活跃 vs 已解除 —— 已解除的留在活跃集里留档，不算失效。
  if (counts.constraintsActive === 0 && counts.constraintsRelaxed === 0) {
    layers.push({ key: 'constraint', name: '约束层', status: STATUS.EMPTY, detail: '还没有硬性约束', value: 0 });
  } else {
    layers.push({
      key: 'constraint',
      name: '约束层',
      status: STATUS.OK,
      detail: `活跃 ${counts.constraintsActive} 条，已解除 ${counts.constraintsRelaxed} 条（解除只留档，不再当禁令）`,
      value: counts.constraintsActive,
    });
  }

  // ⑤ 槽位层：覆盖式状态，数量天然有限，不参与淘汰。
  layers.push({
    key: 'slot',
    name: '槽位层',
    status: counts.slots === 0 ? STATUS.EMPTY : STATUS.OK,
    detail: counts.slots === 0 ? '还没有状态槽位' : `${counts.slots} 个槽位（覆盖式更新）`,
    value: counts.slots,
  });

  // ⑥ 共同经历层：独立于事实，不参与普通淘汰。
  layers.push({
    key: 'episode',
    name: '共同经历层',
    status: counts.byKind.episode === 0 ? STATUS.EMPTY : STATUS.OK,
    detail: counts.byKind.episode === 0 ? '还没有共同经历' : `${counts.byKind.episode} 条共同经历`,
    value: counts.byKind.episode,
  });

  // 归档压力：接近上限要显式提醒，而不是等淘汰再说。
  const archiveRatio = counts.archived / Math.max(1, store.cfg.maxArchive);
  if (archiveRatio >= 0.9 && counts.archived > 0) {
    const write = layers.find((layer) => layer.key === 'write');
    if (write !== undefined) {
      write.status = STATUS.DEGRADED;
      write.detail += `；归档 ${counts.archived}/${store.cfg.maxArchive}，接近上限将物理删除最老条目`;
    }
  }

  return { layers, statuses: Object.fromEntries(layers.map((layer) => [layer.key, layer.status])) };
}
