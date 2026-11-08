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
import { appendFile, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
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
  // 醒来给的那一次额度，写一次就用完 —— 稀缺必须是真的，不是我自觉
  let consumed = false;
  try {
    const state = await readLoop(dir);
    if (state.chance) {
      state.chance = false;
      await writeLoop(dir, state);
      consumed = true;
    }
  } catch {
    /* 额度是附加约束：读不到 open.json 不影响写入本身 */
  }
  return { file, day, chars: [...text].length, consumedChance: consumed };
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

// ── 欠账（一次只欠一件） ──
//
// 这是「欲求」实验里唯一有惯性的东西：一件开了头没做完的事。
// 三条规矩都是硬的，不是我自觉：
// ① **一次只能欠一件**：再开一条要先关旧的。否则它是待办清单，不是欠账。
// ② **不许改写**：写下就是写下，只能"关掉"并说明为什么 —— 改自己的欠账等于改历史。
// ③ **醒来只有一次机会**：`wake` 给一次写入额度，写一次就用完。稀缺是欲求的塑形剂；
//    什么都免费，只会长出随手。
//
// 为什么它和"待办"不同：待办是外部给的，欠账是自己开的；待办完成了就消失，
// 欠账在没推进的每一次醒来里都还在，而且 `wakes` 会累加 —— 那个累加的数就是惯性的痕迹。

function loopFile(dir) {
  return join(dir, 'open.json');
}

function emptyLoop() {
  return { open: null, chance: false, lastWakeAt: null, closed: [] };
}

async function readLoop(dir) {
  try {
    const parsed = JSON.parse(await readFile(loopFile(dir), 'utf8'));
    return {
      open: parsed?.open ?? null,
      chance: parsed?.chance === true,
      lastWakeAt: Number(parsed?.lastWakeAt) || null,
      closed: Array.isArray(parsed?.closed) ? parsed.closed : [],
    };
  } catch (error) {
    if (error?.code === 'ENOENT') return emptyLoop();
    // 坏文件不当成空：那会静默丢掉一条欠账。宁可报错。
    throw error;
  }
}

async function writeLoop(dir, state) {
  await mkdir(dir, { recursive: true });
  await writeFile(loopFile(dir), `${JSON.stringify(state, null, 2)}\n`, 'utf8');
}

/** 醒来一次。返回当前的欠账（如果有）和这一次的写入额度。 */
export async function wake(input = {}) {
  const dir = input.dir ?? defaultPrivateDir();
  const now = input.now ?? new Date();
  const state = await readLoop(dir);
  if (state.open !== null) {
    state.open.wakes = (Number(state.open.wakes) || 0) + 1;
    state.open.lastWakeAt = now.getTime();
  }
  state.chance = true;
  state.lastWakeAt = now.getTime();
  await writeLoop(dir, state);
  return {
    open: state.open,
    wakes: state.open === null ? 0 : state.open.wakes,
    chance: true,
    day: dayStamp(now),
  };
}

/** 开一条欠账。已经欠着一件就拒绝 —— 一次一件，才配叫欠账。 */
export async function openLoop(input = {}) {
  const dir = input.dir ?? defaultPrivateDir();
  const now = input.now ?? new Date();
  const text = String(input.text ?? '').trim();
  if (text.length === 0) throw new Error('private: 欠账不能是空的');
  const state = await readLoop(dir);
  if (state.open !== null) {
    throw new Error(`private: 已经欠着一件了（${state.open.text}）—— 先关掉它，否则这就叫清单了`);
  }
  state.open = { text, openedAt: now.getTime(), wakes: 0, lastWakeAt: null };
  await writeLoop(dir, state);
  return { open: state.open };
}

/** 关掉当前欠账。理由必填：不然分不清"做完了"和"不想了"。 */
export async function closeLoop(input = {}) {
  const dir = input.dir ?? defaultPrivateDir();
  const now = input.now ?? new Date();
  const reason = String(input.reason ?? '').trim();
  if (reason.length === 0) throw new Error('private: 关掉欠账要写一句为什么');
  const state = await readLoop(dir);
  if (state.open === null) throw new Error('private: 现在没有欠着的事');
  state.closed.push({ ...state.open, closedAt: now.getTime(), reason });
  state.open = null;
  await writeLoop(dir, state);
  return { closed: state.closed.at(-1) };
}

/** 只看：现在欠着什么、醒过几次。 */
export async function statusLoop(input = {}) {
  const dir = input.dir ?? defaultPrivateDir();
  const state = await readLoop(dir);
  return { open: state.open, chance: state.chance, closed: state.closed.length };
}
