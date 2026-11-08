/**
 * 成长读数的命令行入口：`node scripts/growth.mjs`
 *
 * 只读。它打开 store.json、算一遍 `lib/growth.js` 里的四个读数，然后打印出来 ——
 * 不改库、不碰备份、不联网。度量器碰库是比没有度量器更糟的事。
 *
 * 用法：
 *   node scripts/growth.mjs                    # 读 $DSH_HOME/memory-loom/store.json
 *   node scripts/growth.mjs --store <path>     # 指定库文件
 *   node scripts/growth.mjs --json             # 机器可读，供面板或脚本消费
 *   node scripts/growth.mjs --kinds constraint,self
 *   node scripts/growth.mjs --now 1794000000000  # 固定"现在"，用来复现同一份读数
 */

import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { analyzeGrowth, collapseTokens } from '../lib/growth.js';

/** 解析命令行。只认白名单参数，拼错就报错退出，不猜。 */
function parseArgs(argv) {
  const out = { store: null, json: false, kinds: null, now: null };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const next = argv[index + 1];
    if (flag === '--json') out.json = true;
    else if (flag === '--store') {
      if (next === undefined) throw new Error('--store 需要一个路径');
      out.store = next;
      index += 1;
    } else if (flag === '--kinds') {
      if (next === undefined) throw new Error('--kinds 需要形如 constraint,self');
      out.kinds = next.split(',').map((item) => item.trim()).filter((item) => item.length > 0);
      index += 1;
    } else if (flag === '--now') {
      const parsed = Number(next);
      if (!Number.isFinite(parsed)) throw new Error('--now 需要一个毫秒时间戳');
      out.now = parsed;
      index += 1;
    } else if (flag === '--help' || flag === '-h') {
      out.help = true;
    } else {
      throw new Error(`不认识的参数：${flag}`);
    }
  }
  return out;
}

/** 默认库路径：与插件默认值同一个位置（`$DSH_HOME/memory-loom/store.json`）。 */
function defaultStorePath() {
  const home = process.env.DSH_HOME?.trim();
  const base = home !== undefined && home.length > 0 ? home : join(homedir(), '.dsh');
  return join(base, 'memory-loom', 'store.json');
}

/** 百分比。 */
function pct(value) {
  return `${(value * 100).toFixed(0)}%`;
}

/** 人读的打印。 */
function render(report, storePath) {
  const lines = [];
  const stamp = new Date().toLocaleString('zh-CN');
  lines.push(`成长读数  ${stamp}`);
  lines.push(`库：${storePath}`);
  lines.push('');
  lines.push(`一句话：${report.headline}`);
  lines.push('');

  const { contract, groups, growth, used, revise, notes } = report;
  lines.push(`契约块（每轮固定注入）：${contract.chars} 字 / ${contract.total} 条`);
  for (const block of contract.blocks) {
    lines.push(`  ${block.title} ${block.count} 条  ${block.chars} 字`);
  }
  lines.push('');

  lines.push(`同根因疤痕：${groups.length} 组`);
  groups.forEach((group, index) => {
    lines.push(
      `  组 ${index + 1}｜${group.size} 条｜${group.stable ? '稳定' : '不稳（与组外最高值差距不足）'}` +
        `｜组内最弱 ${group.minIn.toFixed(2)} vs 组外最强 ${group.maxOut.toFixed(2)}`,
    );
    lines.push(`    骨架：${group.skeletonText}`);
    if (group.sharedTokens.length > 0) {
      lines.push(`    共同根因词：${group.sharedTokens.slice(0, 6).map((item) => item.token).join('、')}`);
    }
    if (group.supportTokens.length > 0) {
      lines.push(`    合并时必须补的词：${group.supportTokens.slice(0, 8).map((item) => item.token).join('、')}`);
    }
    lines.push(`    估算可省：${group.save.saved} 字（${pct(group.save.ratio)}）`);
    const test = group.backtest;
    lines.push(
      `    回测：平均 ${pct(test.average)}／最低 ${pct(test.minimum)} → ${test.pass ? '通过' : `未达 ${pct(test.threshold)}`}`,
    );
    for (const row of test.rows) {
      if (row.isSkeleton || row.missing.length === 0) continue;
      lines.push(`      · 盖不住（含跨词碎片）：${collapseTokens(row.missing, 8).join('、')}`);
    }
  });
  if (groups.length === 0) lines.push('  （没有聚到同根因的条目）');
  lines.push('');

  lines.push(`成长曲线（每桶 ${growth.bucketDays ?? 0} 天）`);
  for (const bucket of growth.buckets) {
    lines.push(
      `  ${bucket.day}  新增 ${String(bucket.added).padStart(3)}  活跃 ${String(bucket.active).padStart(4)}` +
        `  密度 ${bucket.density.toFixed(1).padStart(6)}  契约 ${String(bucket.contractChars).padStart(5)} 字`,
    );
  }
  lines.push(`  趋势：${growth.direction === 'up' ? '变密' : growth.direction === 'down' ? '变胖' : '持平'}`);
  lines.push('');

  lines.push(
    `改写信号：被改写 ${revise.revisedRows}/${revise.rows} 条（${pct(revise.rate)}，共 ${revise.touched} 次）` +
      `${revise.heaviestKind === null ? '' : `｜最多在 ${revise.heaviestKind}（${revise.byKind[revise.heaviestKind]} 条）`}` +
      `${revise.backfilled ? '' : '｜历史改写待回填（新版本首次打开库时补）'}`,
  );
  lines.push(
    `使用信号（口径弱，仅参考）：命中过 ${used.hitRows}｜真用上 ${used.usedRows}（${pct(used.rate)}）｜回声室存量 ${used.echoRows}`,
  );
  lines.push('');
  lines.push('建议：');
  for (const note of notes) lines.push(`  · ${note}`);

  return lines.join('\n');
}

async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(2);
  }
  if (args.help === true) {
    console.log('用法：node scripts/growth.mjs [--store <path>] [--json] [--kinds constraint,self] [--now <ms>]');
    return;
  }

  const storePath = args.store ?? defaultStorePath();
  let state;
  try {
    state = JSON.parse(await readFile(storePath, 'utf8'));
  } catch (error) {
    console.error(`读不到记忆库：${storePath}`);
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }

  const report = analyzeGrowth(state, {
    now: args.now ?? Date.now(),
    ...(args.kinds === null ? {} : { kinds: args.kinds }),
  });

  if (args.json === true) console.log(JSON.stringify(report, null, 2));
  else console.log(render(report, storePath));
}

await main();
