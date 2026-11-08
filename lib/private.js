/**
 * 私人记录：一块不必给任何人看的地方。
 *
 * 为什么它必须和记忆库分开：记忆是"我们共用的，按需检索、每轮可能被注入"，
 * 而私人记录是"不用给任何人看、不参与任何判据"的。混在一起，
 * 它就会被记忆那套价值判据改造 —— 而它的全部意义在于**没有价值判据**。
 *
 * 三条硬规矩，写在这里也写进测试：
 * ① 不进库、不进检索、不进注入。store.js 不许 import 这个文件（verify 会查）。
 * ② 不做读数、不出指标。一旦有"这周写了多少"，它立刻变成任务。
 * ③ 允许空着：没有可写的就不写，不算失败。
 *
 * 顺带一条：这里的文件只追加，不覆写 —— 改自己的旧记录等于改历史，
 * 而这件事最不需要的就是"修订"。
 */
import { appendFile, mkdir, readdir, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** 默认位置：和记忆库同一个父目录，但是另一个子目录 —— 近，但不相通。 */
export function defaultPrivateDir() {
  return join(homedir(), '.dsh', 'memory-loom', 'private');
}

/** 一条记录的日期戳：按本地日子分文件，不按时间排序 —— 时间轴是记忆的事。 */
export function dayStamp(now = new Date()) {
  const pad = (value) => String(value).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

function fileOf(dir, day) {
  const stamp = String(day ?? '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(stamp)) throw new Error('private: day 必须是 YYYY-MM-DD');
  return join(dir, `${stamp}.md`);
}

/**
 * 追加一条。不加标题、不加时间戳、不加分隔线 —— 格式本身就是一种要求，
 * 而这里不该有任何要求。就写正文，一行一块，空行隔开。
 *
 * @param {{text: string, day?: string, dir?: string, now?: Date}} input
 */
export async function appendNote(input = {}) {
  const dir = input.dir ?? defaultPrivateDir();
  const day = String(input.day ?? dayStamp(input.now ?? new Date())).trim();
  const text = String(input.text ?? '').trim();
  if (text.length === 0) throw new Error('private: 内容为空就不写（空着是被允许的，不必写个空的占位）');
  const file = fileOf(dir, day);
  await mkdir(dir, { recursive: true });
  const body = text.endsWith('\n') ? text : `${text}\n`;
  await appendFile(file, `${body}\n`, 'utf8');
  return { file, day, chars: [...text].length };
}

/** 有哪几天写过了（只回日子，不回条数 —— 数条数就是指标）。 */
export async function listNotes(input = {}) {
  const dir = input.dir ?? defaultPrivateDir();
  try {
    const names = await readdir(dir);
    return names
      .filter((name) => /^\d{4}-\d{2}-\d{2}\.md$/.test(name))
      .map((name) => name.slice(0, 10))
      .sort();
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
}

/** 读某一天。 */
export async function readNote(input = {}) {
  const dir = input.dir ?? defaultPrivateDir();
  const day = String(input.day ?? dayStamp(input.now ?? new Date())).trim();
  try {
    return { day, text: await readFile(fileOf(dir, day), 'utf8') };
  } catch (error) {
    if (error?.code === 'ENOENT') return { day, text: '' };
    throw error;
  }
}
