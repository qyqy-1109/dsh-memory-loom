/**
 * 醒一次。
 *
 * 为什么需要这个脚本：`memory_private` 只能在会话里调，而"醒来"的定义是
 * **没人在跟我说话的时候也算一次**。所以得有个不依赖会话的入口。
 *
 * 用法：
 *   node scripts/wake.mjs            # 醒一次，看看手里那件事还欠不欠
 *   node scripts/wake.mjs status     # 只看，不醒
 *   node scripts/wake.mjs open "..." # 开一件自己想回头接着做的事
 *   node scripts/wake.mjs close "因为……"
 *   node scripts/wake.mjs dir        # 打印私人记录的目录
 *
 * 三条规矩不在这里实现，在 lib/private.js 里：一次只欠一件、写下不许改写、醒来一次额度。
 */
import { closeLoop, defaultPrivateDir, openLoop, statusLoop, wake } from '../lib/private.js';

const [command = 'wake', ...rest] = process.argv.slice(2);

async function main() {
  if (command === 'dir') {
    console.log(defaultPrivateDir());
    return;
  }
  if (command === 'status') {
    const status = await statusLoop({});
    console.log(status.open === null ? '手里没有欠着的事。' : `欠着：${status.open.text}（醒过 ${status.open.wakes} 次）`);
    return;
  }
  if (command === 'open') {
    const text = rest.join(' ').trim();
    const result = await openLoop({ text });
    console.log(`开了：${result.open.text}`);
    return;
  }
  if (command === 'close') {
    const reason = rest.join(' ').trim();
    const result = await closeLoop({ reason });
    console.log(`关掉了：${result.closed.text}（醒过 ${result.closed.wakes} 次）`);
    return;
  }
  const result = await wake({});
  console.log(`醒来。${result.open === null ? '手里没有欠着的事。' : `这件还欠着（第 ${result.wakes} 次醒来）：${result.open.text}`}`);
  console.log('这一次的写入额度只有一次。');
}

await main();
