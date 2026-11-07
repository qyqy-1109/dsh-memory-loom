import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * 记忆海（三维）那一半的离线门禁。
 *
 * 能离线验的：三维布局确定性、连线口径、相机收敛、透视投影、深度排序、每帧成本。
 * 真正的上屏帧率只能由面板自己的 FPS 读数与「压力自检」给出。
 */

/** 假 canvas 2D 上下文：只实现记忆海绘制真正用到的方法，并记录调用次数。 */
function makeFakeCtx(counters = null) {
  const tick = (name) => {
    if (counters !== null && typeof counters[name] === 'number') counters[name] += 1;
  };
  return {
    globalAlpha: 1,
    globalCompositeOperation: 'source-over',
    fillStyle: null,
    strokeStyle: null,
    lineWidth: 1,
    font: '',
    textAlign: 'left',
    setTransform() {},
    clearRect() {},
    fillRect() {
      tick('fillRect');
    },
    drawImage() {
      tick('drawImage');
      if (counters !== null && Array.isArray(counters.draws)) counters.draws.push([...arguments]);
    },
    beginPath() {
      tick('beginPath');
    },
    arc() {
      tick('arc');
    },
    rect() {},
    moveTo() {
      tick('moveTo');
    },
    lineTo() {},
    quadraticCurveTo() {
      tick('curve');
    },
    fill() {
      tick('fill');
    },
    stroke() {
      tick('stroke');
    },
    fillText() {
      tick('fillText');
    },
    strokeText() {
      tick('strokeText');
    },
    measureText(text) {
      if (counters !== null && typeof counters.measureText === 'number') counters.measureText += 1;
      return { width: String(text ?? '').length * 6 };
    },
    createRadialGradient() {
      tick('gradient');
      return { addColorStop() {} };
    },
    createLinearGradient() {
      tick('gradient');
      return { addColorStop() {} };
    },
    // 深空底会用到变换栈与旋转/缩放：没有这些方法时，调用会直接抛
    save() {},
    restore() {},
    translate() {},
    rotate() {},
    scale() {},
    createImageData(width, height) {
      return { width, height, data: new Uint8ClampedArray(width * height * 4) };
    },
    putImageData() {},
  };
}

async function loadClient() {
  const source = await readFile(join(process.cwd(), 'lib', 'client.js'), 'utf8');
  const fakeReact = {
    createElement: (...args) => ({ type: 'element', args }),
    Fragment: Symbol('Fragment'),
    useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
    useEffect: () => {},
    useRef: () => ({ current: null }),
    useCallback: (fn) => fn,
    useMemo: (fn) => fn(),
  };
  const fakeRequire = (id) => {
    if (id === 'react') return fakeReact;
    if (id === 'react-dom') return { createPortal: (node) => node };
    if (id === 'react/jsx-runtime') return {};
    throw new Error(`unexpected module: ${id}`);
  };
  globalThis.document = {
    querySelector: () => null,
    createElement: (tag) => {
      if (tag === 'canvas') {
        return { width: 0, height: 0, getContext: () => makeFakeCtx(), toDataURL: (type) => `data:${type};base64,x` };
      }
      return { dataset: {}, textContent: '' };
    },    head: { appendChild: () => {} },
    body: {},
    addEventListener: () => {},
    removeEventListener: () => {},
  };
  let exported;
  globalThis.window = {
    __ModuleLoader__: {
      load({ factory }) {
        exported = factory(fakeRequire);
      },
    },
    matchMedia: () => ({ matches: false }),
  };
  new Function(source)();
  return exported;
}

/** 造 n 条假记忆（字段与服务端快照一致）。 */
function makeMemories(n, options = {}) {
  const kinds = ['fact', 'world', 'constraint', 'episode', 'self', 'slot'];
  const base = Date.parse('2026-11-01T00:00:00Z');
  return Array.from({ length: n }, (_, index) => ({
    id: `mem-${index}`,
    kind: kinds[index % kinds.length],
    kindLabel: kinds[index % kinds.length],
    text: options.text ?? `第 ${index} 条记忆：杭州 咖啡 年糕 项目 ${index % 7}`,
    createdAt: base + index * 3_600_000,
    hits: index % 9,
    significance: (index % 5) + 1,
    status: index % 17 === 0 ? 'archived' : 'active',
    scene: index % 4 === 0 ? '杭州' : undefined,
    supersedes: index % 23 === 0 && index > 0 ? [`mem-${index - 1}`] : [],
    weight: 1,
    age: '刚刚',
  }));
}

test('关键词：中文二元组、去停用词、限条数', async () => {
  const client = await loadClient();
  const words = client.__internals.keywordsOf('今天我们去了杭州喝咖啡，咖啡很好', 5);
  assert.ok(words.length <= 5 && words.length > 0);
  assert.ok(words.includes('咖啡'), `应认出「咖啡」，实际 ${words.join('/')}`);
  assert.ok(!words.includes('我们') && !words.includes('今天'), `停用词不该进关键词，实际 ${words.join('/')}`);
  assert.deepEqual(client.__internals.keywordsOf(''), []);
});

test('三维布局：同一批数据两次布局完全一致，且落在合理半径内', async () => {
  const client = await loadClient();
  const memories = makeMemories(120);
  const a = client.__internals.layoutSea(memories);
  const b = client.__internals.layoutSea(memories);
  assert.equal(a.points.length, 120);
  for (let index = 0; index < a.points.length; index += 1) {
    const left = a.points[index];
    const right = b.points[index];
    assert.equal(left.id, right.id);
    assert.equal(left.x, right.x);
    assert.equal(left.y, right.y);
    assert.equal(left.z, right.z);
    // 簇心最多 ~420，簇内再加 ~136，超出这个量级说明坐标算错了
    assert.ok(Math.hypot(left.x, left.y, left.z) < 700, `点飞太远：${left.id}`);
  }
  assert.ok(a.topics.length >= 2, '应该至少分出两个簇');
});

test('连线：取代关系单独成金线，主题线每点最多 6 条且必须共享关键词', async () => {
  const client = await loadClient();
  const memories = makeMemories(80);
  const { points } = client.__internals.layoutSea(memories);
  const edges = client.__internals.buildEdges(points, { maxNeighbors: 6, minScore: 0.15 });
  assert.ok(edges.length > 0, '应该有连线');

  const byId = new Map(points.map((point) => [point.id, point]));
  const gold = edges.filter((edge) => edge.kind === 'supersede');
  assert.ok(gold.length > 0, 'supersedes 应产生金线');
  for (const edge of gold) {
    assert.ok(byId.get(edge.a).memory.supersedes.includes(edge.b), '金线必须对应 supersedes（a 取代 b）');
  }

  const topic = edges.filter((edge) => edge.kind === 'topic');
  const degree = new Map();
  const seen = new Set();
  for (const edge of topic) {
    assert.ok(edge.score >= 0.15, `分数低于阈值：${edge.score}`);
    const a = byId.get(edge.a);
    const b = byId.get(edge.b);
    const setA = new Set(a.keywords);
    assert.ok(b.keywords.some((word) => setA.has(word)), '主题线必须共享关键词');
    const key = edge.a < edge.b ? `${edge.a}|${edge.b}` : `${edge.b}|${edge.a}`;
    assert.ok(!seen.has(key), '不允许重复连线');
    seen.add(key);
    degree.set(edge.a, (degree.get(edge.a) ?? 0) + 1);
    degree.set(edge.b, (degree.get(edge.b) ?? 0) + 1);
  }
  for (const [, value] of degree) assert.ok(value <= 6, `度数超出上限：${value}`);
});

test('相机收敛：俯仰与距离被夹住，yaw 不限', async () => {
  const client = await loadClient();
  const { CAM_LIMITS } = client.__internals;
  const clamped = client.__internals.clampCamera({ yaw: 12.5, pitch: -9, dist: 10, panX: 3, panY: -4 });
  assert.equal(clamped.pitch, -CAM_LIMITS.maxPitch);
  assert.equal(clamped.dist, CAM_LIMITS.minDist);
  assert.equal(clamped.yaw, 12.5);
  assert.equal(clamped.panX, 3);
  const far = client.__internals.clampCamera({ yaw: 0, pitch: 0, dist: 9e9, panX: 0, panY: 0 });
  assert.equal(far.dist, CAM_LIMITS.maxDist);
});

test('透视投影：越近 f 越大、越靠画面中心；同一输入结果确定', async () => {
  const client = await loadClient();
  const camera = { ...client.__internals.CAM_DEFAULT };
  const near = { x: 200, y: 0, z: -600, phase: 0 };
  const far = { x: 200, y: 0, z: 600, phase: 0 };
  const pn = client.__internals.projectPoint(near, camera, 800, 600, 0, false);
  const pf = client.__internals.projectPoint(far, camera, 800, 600, 0, false);
  assert.ok(pn.f > pf.f, '近处的点投影系数应更大');
  assert.ok(pn.depth < pf.depth, '近处的深度应更小');
  assert.ok(Number.isFinite(pn.x) && Number.isFinite(pn.y) && Number.isFinite(pn.f));
  const again = client.__internals.projectPoint(near, camera, 800, 600, 0, false);
  assert.deepEqual(again, pn);
  // 原点应投到画面中心
  const center = client.__internals.projectPoint({ x: 0, y: 0, z: 0, phase: 0 }, camera, 800, 600, 0, false);
  assert.equal(Math.round(center.x), 400);
  assert.equal(Math.round(center.y), 300);
});

test('深度排序与回放：远到近排序，未到时刻的点标成幽灵', async () => {
  const client = await loadClient();
  const memories = makeMemories(40);
  const { points } = client.__internals.layoutSea(memories);
  const camera = { ...client.__internals.CAM_DEFAULT };
  const projected = client.__internals.projectAll(points, camera, 800, 600, 0, false, null);
  assert.equal(projected.length, 40);
  for (let index = 1; index < projected.length; index += 1) {
    assert.ok(projected[index - 1].depth >= projected[index].depth, '必须按深度从远到近');
  }
  const cutoff = memories[10].createdAt;
  const scrubbed = client.__internals.projectAll(points, camera, 800, 600, 0, false, cutoff);
  const ghosts = scrubbed.filter((p) => p.ghost).length;
  assert.ok(ghosts > 0, '回放应把未来的点标成幽灵');
  assert.ok(scrubbed.filter((p) => !p.ghost).length >= 10);
});

test('抗闪烁：尺寸离散（1:1 采样），位置保持亚像素（慢速转动不跳格）', async () => {
  const client = await loadClient();
  const { nearestSizeStep, POINT_SIZE_STEPS } = client.__internals;

  // ① 尺寸档位：单调、确定、越界收敛
  assert.deepEqual([...POINT_SIZE_STEPS].sort((a, b) => a - b), [...POINT_SIZE_STEPS]);
  assert.equal(nearestSizeStep(2.4), 2);
  assert.equal(nearestSizeStep(3.6), 4);
  assert.equal(nearestSizeStep(7.4), 7);
  assert.equal(nearestSizeStep(41), 40);
  assert.equal(nearestSizeStep(7.4), nearestSizeStep(7.4), '档位选择必须确定');

  // ② 位置不吸附：0.1px 的位移必须体现在绘制坐标上，否则慢速转动会每两帧跳一格
  const point = { id: 'snap', kind: 'fact', rgb: [138, 180, 255], radius: 2, phase: 0, createdAt: 0 };
  const project = (x) => ({ x, y: 100, f: 0.9, depth: 1000, ghost: false, point });
  const counters = { drawImage: 0, draws: [] };
  const ctx = makeFakeCtx(counters);
  client.__internals.paintPoints(ctx, [project(100.1), project(100.2), project(101.4)], {
    dpr: 2,
    quality: 0,
    presence: null,
  });
  const xs = counters.draws.map((call) => call[1]);
  assert.equal(xs.length, 3);
  assert.notEqual(xs[0], xs[1], '亚像素位置必须保留，不能被吸附成同一格');
  assert.ok(Math.abs(Math.abs(xs[1] - xs[0]) - 0.1) < 0.02, `位置位移应与输入线性对应，实测 ${(xs[1] - xs[0]).toFixed(3)}`);
  // 相近位置必须落在同一尺寸档位（尺寸恒定才不会每帧重采样）
  assert.equal(counters.draws[0][3], counters.draws[1][3], '相近深度应使用同一尺寸档位');
  // 目标尺寸必须是整设备像素
  for (const call of counters.draws) {
    const deviceWidth = call[3] * 2;
    assert.ok(Math.abs(deviceWidth - Math.round(deviceWidth)) < 1e-6, `绘制宽度应落到整设备像素，实际 ${deviceWidth}`);
  }
});

test('抗闪烁：尺寸档位带迟滞，边界附近不会来回横跳', async () => {
  const client = await loadClient();
  const point = { id: 'hz', kind: 'fact', rgb: [138, 180, 255], radius: 2.2, phase: 0, createdAt: 0 };
  const counters = { drawImage: 0, draws: [] };
  const ctx = makeFakeCtx(counters);
  const project = (f) => ({ x: 300, y: 200, f, depth: 1000, ghost: false, point });
  const drawAt = (f) => {
    counters.draws.length = 0;
    client.__internals.paintPoints(ctx, [project(f)], { dpr: 2, quality: 0, presence: null });
    return counters.draws[0][3];
  };
  const first = drawAt(0.9);
  // f 轻微变化（直径变化 < 1.2 设备像素）：档位不该变
  const steady = [drawAt(0.92), drawAt(0.94), drawAt(0.96)];
  for (const width of steady) assert.equal(width, first, '邻档边界附近不应来回切换尺寸');
  // 明显变化：必须换档
  const bigger = drawAt(1.4);
  assert.notEqual(bigger, first, '尺寸明显变化时必须换档');
});

test('连线总量封顶：超过上限只保留分数最高的一批（金线优先）', async () => {
  const client = await loadClient();
  const { points } = client.__internals.layoutSea(makeMemories(600));
  const all = client.__internals.buildEdges(points, { maxNeighbors: 6, maxEdges: 100000, minScore: 0.15 });
  const capped = client.__internals.buildEdges(points, { maxNeighbors: 6, maxEdges: 50, minScore: 0.15 });
  assert.ok(all.length > 50, `夹具应能造出多于 50 条线，实际 ${all.length}`);
  assert.equal(capped.length, 50);
  const keptTopic = capped.filter((edge) => edge.kind === 'topic').map((edge) => edge.score);
  const droppedTopic = all.slice(50).filter((edge) => edge.kind === 'topic').map((edge) => edge.score);
  if (keptTopic.length > 0 && droppedTopic.length > 0) {
    assert.ok(Math.min(...keptTopic) >= Math.max(...droppedTopic), '保留的应是分数更高的那批');
  }
  // 金线在数组前面，不该被截断
  assert.equal(capped.filter((edge) => edge.kind === 'supersede').length, all.filter((edge) => edge.kind === 'supersede').length);
});

test('连线绘制：上千条线压成不超过 7 次 stroke，金线单独一笔', async () => {
  const client = await loadClient();
  const memories = makeMemories(200);
  const { points } = client.__internals.layoutSea(memories);
  const edges = client.__internals.buildEdges(points, { maxNeighbors: 6, minScore: 0.15 });
  const camera = { ...client.__internals.CAM_DEFAULT };
  const projected = client.__internals.projectAll(points, camera, 900, 600, 0, false, null);
  const positions = new Map(projected.map((p) => [p.point.id, p]));
  const counters = { stroke: 0, beginPath: 0, moveTo: 0 };
  const ctx = makeFakeCtx(counters);
  const report = client.__internals.paintEdges(ctx, edges, positions, { focus: null, onlyFocus: false });
  assert.equal(report.total, edges.length);
  assert.ok(counters.stroke <= report.buckets + 1, `stroke 次数应被分桶压到 ${report.buckets + 1} 次内，实际 ${counters.stroke}`);
  assert.equal(counters.moveTo, edges.length, '每条线一次 moveTo（另一次 lineTo）');
});

test('星点绘制：走预热精灵贴图（不是逐点 arc+fill），800 颗 × 300 帧仍在预算内', async () => {
  const client = await loadClient();
  const memories = makeMemories(800);
  const { points } = client.__internals.layoutSea(memories);
  const camera = { ...client.__internals.CAM_DEFAULT };
  const projected = client.__internals.projectAll(points, camera, 900, 600, 0, false, null);
  const counters = { arc: 0, fill: 0, drawImage: 0, gradient: 0 };
  const ctx = makeFakeCtx(counters);
  const frames = 300;
  const started = process.hrtime.bigint();
  for (let frame = 0; frame < frames; frame += 1) {
    client.__internals.paintPoints(ctx, projected, {
      focus: null,
      onlyFocus: false,
      hovered: 'mem-3',
      selected: 'mem-7',
      time: frame * 16,
      quality: 2,
    });
  }
  const perFrameMs = Number(process.hrtime.bigint() - started) / 1e6 / frames;
  assert.ok(perFrameMs < 6, `每帧星点成本应远低于一帧预算，实测 ${perFrameMs.toFixed(3)}ms`);
  // 每颗星一次 drawImage；两个热点各多一次光晕 => 802 次
  assert.equal(counters.drawImage, (800 + 2) * frames, '星点应走精灵贴图');
  assert.equal(counters.arc, 2 * frames, '只有热点画描边环，实心点不再走 arc');
  assert.equal(counters.fill, 0, '不再逐点 fill');
  assert.ok(counters.gradient / frames <= 3, `光晕不该逐帧造渐变，实际每帧 ${(counters.gradient / frames).toFixed(1)} 个`);
});

test('丝带线：每条边带世界坐标控制点，绘制走二次曲线而不是直线', async () => {
  const client = await loadClient();
  const { points } = client.__internals.layoutSea(makeMemories(120));
  const edges = client.__internals.buildEdges(points, { maxNeighbors: 6, minScore: 0.15 });
  assert.ok(edges.length > 0);
  const byId = new Map(points.map((point) => [point.id, point]));
  for (const edge of edges) {
    assert.ok(edge.control !== undefined, '每条线都要有控制点');
    for (const key of ['x', 'y', 'z']) assert.ok(Number.isFinite(edge.control[key]), `控制点 ${key} 必须是有限数`);
    const a = byId.get(edge.a);
    const b = byId.get(edge.b);
    const mid = Math.hypot((a.x + b.x) / 2 - edge.control.x, (a.y + b.y) / 2 - edge.control.y, (a.z + b.z) / 2 - edge.control.z);
    const length = Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z);
    assert.ok(mid <= Math.max(1, length * 0.19), `弯曲幅度应受长度约束，实际偏移 ${mid.toFixed(2)}`);
  }

  const camera = { ...client.__internals.CAM_DEFAULT };
  const projected = client.__internals.projectAll(points, camera, 900, 600, 0, false, null);
  const positions = new Map(projected.map((p) => [p.point.id, p]));
  const counters = { stroke: 0, curve: 0, moveTo: 0 };
  const ctx = makeFakeCtx(counters);
  client.__internals.paintEdges(ctx, edges, positions, {
    focus: null,
    onlyFocus: false,
    projectWorld: (world) => client.__internals.projectPoint(world, camera, 900, 600, 0, false),
  });
  assert.equal(counters.curve, edges.length, '每条线一次二次曲线');
  assert.equal(counters.moveTo, edges.length);
});

test('淡入淡出：可见度按时间常数缓动，与帧率无关', async () => {
  const client = await loadClient();
  const { easePresence } = client.__internals;
  // 16ms 一步 vs 两个 8ms 小步：结果应非常接近（帧率无关）
  const one = easePresence(0, 1, 16);
  const two = easePresence(easePresence(0, 1, 8), 1, 8);
  assert.ok(Math.abs(one - two) < 0.01, `一次 16ms=${one.toFixed(4)}，两次 8ms=${two.toFixed(4)}`);
  // 单调、收敛、有界
  assert.ok(one > 0 && one < 1);
  assert.equal(easePresence(1, 1, 16), 1);
  assert.equal(easePresence(0, 0, 16), 0);
  let value = 0;
  for (let step = 0; step < 60; step += 1) value = easePresence(value, 1, 16);
  assert.ok(value > 0.99, `1 秒内应基本到位，实际 ${value.toFixed(3)}`);
});

test('回放淡出：可见度归零的点与线都不再画', async () => {
  const client = await loadClient();
  const { points } = client.__internals.layoutSea(makeMemories(30));
  const edges = client.__internals.buildEdges(points, { maxNeighbors: 6, minScore: 0.15 });
  const camera = { ...client.__internals.CAM_DEFAULT };
  const projected = client.__internals.projectAll(points, camera, 900, 600, 0, false, null);
  const positions = new Map(projected.map((p) => [p.point.id, p]));
  const hidden = new Map(points.map((point) => [point.id, 0]));
  const half = new Map(points.map((point) => [point.id, 0.5]));

  const counters = { stroke: 0, arc: 0 };
  const ctx = makeFakeCtx(counters);
  const gone = client.__internals.paintEdges(ctx, edges, positions, { focus: null, onlyFocus: false, presence: hidden });
  assert.equal(gone.total, 0, '全隐藏时不该画任何线');

  counters.arc = 0;
  client.__internals.paintPoints(ctx, projected, { focus: null, onlyFocus: false, presence: hidden });
  assert.equal(counters.arc, 0, '全隐藏时不该画任何点');

  const visible = client.__internals.paintEdges(ctx, edges, positions, { focus: null, onlyFocus: false, presence: half });
  assert.equal(visible.total, edges.length, '半可见时线仍在画（只是更淡）');
});

test('取景：自动算相机距离，让点云铺满画面而不是缩在一角', async () => {
  const client = await loadClient();
  const width = 900;
  const height = 620;
  for (const count of [7, 40, 400]) {
    const { points } = client.__internals.layoutSea(makeMemories(count));
    const dist = client.__internals.fitDistance(points, width, height);
    const camera = { ...client.__internals.CAM_DEFAULT, dist };
    const projected = client.__internals.projectAll(points, camera, width, height, 0, false, null);
    const xs = projected.map((p) => p.x);
    const ys = projected.map((p) => p.y);
    const spanX = Math.max(...xs) - Math.min(...xs);
    const spanY = Math.max(...ys) - Math.min(...ys);
    const fill = Math.max(spanX / width, spanY / height);
    assert.ok(fill >= 0.3, `${count} 条记忆时画面填充率过低：${fill.toFixed(2)}`);
    assert.ok(fill <= 1.05, `${count} 条记忆时内容溢出画布：${fill.toFixed(2)}`);
    assert.ok(dist >= 380 && dist <= 3200, `相机距离必须在夹取范围内，实际 ${dist}`);
  }
});

test('布局：先平移到质心，簇少时也不会偏在一边', async () => {
  const client = await loadClient();
  const { points } = client.__internals.layoutSea(makeMemories(7));
  const sum = points.reduce((acc, p) => ({ x: acc.x + p.x, y: acc.y + p.y, z: acc.z + p.z }), { x: 0, y: 0, z: 0 });
  const n = points.length;
  assert.ok(Math.abs(sum.x / n) < 1e-6 && Math.abs(sum.y / n) < 1e-6 && Math.abs(sum.z / n) < 1e-6, '质心应落在原点');
});

test('兜底粘连：没有关键词连线的孤点至少连到同簇最近的一颗', async () => {
  const client = await loadClient();
  const { points } = client.__internals.layoutSea(makeMemories(24));
  const raw = client.__internals.buildEdges(points, { maxNeighbors: 4, maxEdges: 1200, minScore: 0.15 });
  const withCohesion = client.__internals.addCohesion(raw, points, { maxNeighbors: 4 });
  const degree = new Map();
  for (const edge of withCohesion) {
    degree.set(edge.a, (degree.get(edge.a) ?? 0) + 1);
    degree.set(edge.b, (degree.get(edge.b) ?? 0) + 1);
  }
  // 每个「同簇里还有别的点」的点都应至少有一条线
  const clusterSize = new Map();
  for (const point of points) clusterSize.set(point.cluster, (clusterSize.get(point.cluster) ?? 0) + 1);
  for (const point of points) {
    if ((clusterSize.get(point.cluster) ?? 0) < 2) continue;
    assert.ok((degree.get(point.id) ?? 0) >= 1, `${point.id} 仍是孤点`);
  }
  for (const [, value] of degree) assert.ok(value <= 6, `粘连后度数应仍受控，实际 ${value}`);
});

test('标签跟随回放：可见度低的点不再挂着标签', async () => {
  const client = await loadClient();
  const { points } = client.__internals.layoutSea(makeMemories(60));
  const camera = { ...client.__internals.CAM_DEFAULT };
  const projected = client.__internals.projectAll(points, camera, 900, 600, 0, false, null);
  const positions = new Map(projected.map((p) => [p.point.id, p]));
  const candidates = client.__internals.pickLabelCandidates(points, 12);
  const counters = { fillText: 0 };
  const ctx = makeFakeCtx(counters);

  // 全部可见：应该画出若干标签
  const allVisible = new Map(points.map((point) => [point.id, 1]));
  const drawnAll = client.__internals.paintLabels(ctx, candidates, positions, 900, 600, {
    alphaMap: new Map(),
    dt: 200,
    presence: allVisible,
  });
  assert.ok(drawnAll > 0, '全部可见时应画出标签');

  // 回放到只剩一个时刻：其余都淡出，标签也必须跟着退场
  counters.fillText = 0;
  const almostGone = new Map(points.map((point) => [point.id, 0.02]));
  const drawnGone = client.__internals.paintLabels(ctx, candidates, positions, 900, 600, {
    alphaMap: new Map(points.map((point) => [point.id, 1])),
    dt: 16,
    presence: almostGone,
  });
  assert.equal(drawnGone, 0, '可见度低于阈值时不该再画标签');
  assert.equal(counters.fillText, 0);
});

test('标签：候选按权重定序且只算一次；宽度只量一次，带底衬', async () => {
  const client = await loadClient();
  const { points } = client.__internals.layoutSea(makeMemories(200));
  const candidates = client.__internals.pickLabelCandidates(points, 64);
  assert.equal(candidates.length, 64);
  for (let index = 1; index < candidates.length; index += 1) {
    assert.ok(candidates[index - 1].weight >= candidates[index].weight, '候选必须按权重降序');
  }
  // 同一批点两帧之间的候选集合不能变（变了就会闪进闪出）
  const again = client.__internals.pickLabelCandidates(points, 64);
  assert.deepEqual(again.map((p) => p.id), candidates.map((p) => p.id));

  const camera = { ...client.__internals.CAM_DEFAULT };
  const projected = client.__internals.projectAll(points, camera, 900, 600, 0, false, null);
  const positions = new Map(projected.map((p) => [p.point.id, p]));
  const counters = { fillText: 0, fillRect: 0, measureText: 0, strokeText: 0 };
  const ctx = makeFakeCtx(counters);
  const alphaMap = new Map();
  const batch = candidates.slice(0, 8);

  const drawn = client.__internals.paintLabels(ctx, batch, positions, 900, 600, { alphaMap, dt: 16 });
  assert.ok(drawn > 0, '可见的候选应该被画出来');
  assert.equal(counters.fillText, drawn, '每个标签一次 fillText');

  // 再画 10 帧：文字宽度必须命中缓存，不再反复 measureText
  const measuredAfterFirst = counters.measureText;
  for (let frame = 0; frame < 10; frame += 1) client.__internals.paintLabels(ctx, batch, positions, 900, 600, { alphaMap, dt: 16 });
  assert.equal(counters.measureText, measuredAfterFirst, '标签宽度只该量一次');
  assert.ok(counters.fillRect > 0, '应该画引线');
  assert.ok(counters.fillRect <= counters.fillText, '每个标签最多一条引线（不再有实心底衬方框）');
  assert.equal(counters.strokeText, counters.fillText, '文字靠描边当底衬，每个标签各一次');

  // 第二帧 alpha 继续上升（淡入而不是瞬间出现）
  assert.ok((alphaMap.get(batch[0].id) ?? 0) > 0.2, '标签透明度应随时间上升');
  // 位置表里没有的点不画
  const emptyDrawn = client.__internals.paintLabels(ctx, batch.slice(0, 4), new Map(), 900, 600, { alphaMap: new Map(), dt: 16 });
  assert.equal(emptyDrawn, 0);
});

test('数值覆盖值一律夹取，坏值回落默认（防止入口被“调到看不见”）', async () => {
  const client = await loadClient();
  const { clampNumber } = client.__internals;
  assert.equal(clampNumber(null, 138, 0, 2400), 138);
  assert.equal(clampNumber('', 138, 0, 2400), 138);
  assert.equal(clampNumber('abc', 138, 0, 2400), 138);
  assert.equal(clampNumber('156', 138, 0, 2400), 156);
  assert.equal(clampNumber('156px', 138, 0, 2400), 156);
  assert.equal(clampNumber('-50', 138, 0, 2400), 0, '负数不能把入口推到屏幕外');
  assert.equal(clampNumber('99999', 138, 0, 2400), 2400);
  // 字号：0 会让文字彻底看不见
  assert.equal(clampNumber('0', 14, 10, 22), 10);
  assert.equal(clampNumber('0.1', 14, 10, 22), 10);
  assert.equal(clampNumber('99', 14, 10, 22), 22);
  assert.equal(clampNumber('13.5', 14, 10, 22), 13.5);
});

test('选择语义：点开、再点同一个收起、点另一条切换', async () => {
  const client = await loadClient();
  const { nextSelection } = client.__internals;
  assert.equal(nextSelection(null, 'a'), 'a', '第一次点开');
  assert.equal(nextSelection('a', 'a'), null, '再点同一条应收起');
  assert.equal(nextSelection('a', 'b'), 'b', '点另一条应切换');
  assert.equal(nextSelection('a', null), null, '空选择归零');
  assert.equal(nextSelection('a', undefined), null);
  // 收起后再点一次能重新打开
  assert.equal(nextSelection(nextSelection('a', 'a'), 'a'), 'a');
});

test('回放时间归一：undefined / NaN / null 都当「全部」', async () => {
  const client = await loadClient();
  assert.equal(client.__internals.asScrubTime(undefined), null);
  assert.equal(client.__internals.asScrubTime(Number.NaN), null);
  assert.equal(client.__internals.asScrubTime(null), null);
  assert.equal(client.__internals.asScrubTime(0), 0);
  assert.equal(client.__internals.asScrubTime(1_700_000_000_000), 1_700_000_000_000);
});

test('界面语言：英文环境翻 chrome、缺词回落中文、测试环境默认中文', async () => {
  const client = await loadClient();
  const { detectLocale, translateWith, UI_LOCALE, EN_TEXT } = client.__internals;
  assert.equal(detectLocale({ language: 'zh-CN' }), 'zh');
  assert.equal(detectLocale({ language: 'en-US' }), 'en');
  assert.equal(detectLocale(null), 'zh', '拿不到 navigator 时保守用中文');
  assert.equal(detectLocale({}), 'zh');

  assert.equal(translateWith('en', '记忆库'), 'Library');
  assert.equal(translateWith('en', '整理'), 'Tidy');
  assert.equal(translateWith('en', '这条还没进字典'), '这条还没进字典', '缺词要原样返回，不能变成空标签');
  assert.equal(translateWith('zh', '记忆库'), '记忆库', '中文环境一个字都不该变');

  assert.equal(UI_LOCALE, 'zh', '测试环境没有 window.navigator，默认中文');
  assert.ok(Object.keys(EN_TEXT).length >= 30, '字典至少覆盖页签/按钮/页脚/种类/状态');
});

test('点击手势：抖动算点击，拖过头或按太久不算，且不留跨事件状态', async () => {
  const client = await loadClient();
  const { isClickGesture } = client.__internals;
  assert.equal(isClickGesture(null, { x: 10, y: 10 }), true, '没有按下记录时按点击处理');
  assert.equal(isClickGesture({ x: 100, y: 100, t: 0 }, { x: 102, y: 101 }), true, '3px 抖动仍然是点击');
  assert.equal(isClickGesture({ x: 100, y: 100, t: 0 }, { x: 120, y: 100 }), false, '拖了 20px 不算点击');
  assert.equal(isClickGesture({ x: 100, y: 100, t: 1000 }, { x: 100, y: 100 }, 5000), false, '按住 4 秒不算点击');
  // 回归点：上一次拖动不能影响下一次点击 —— 纯函数、没有残留标记，两次调用互不影响
  assert.equal(isClickGesture({ x: 100, y: 100, t: 1000 }, { x: 100, y: 100 }, 1200), true);
  assert.equal(isClickGesture({ x: 100, y: 100, t: 2000 }, { x: 100, y: 100 }, 2100), true);
});

test('回到顶端：滚过阈值才出现，异常滚动值不炸', async () => {
  const client = await loadClient();
  const { shouldShowTop } = client.__internals;
  assert.equal(shouldShowTop(0), false, '停在顶端时不该出现');
  assert.equal(shouldShowTop(120), false, '刚滚一点别急着冒按钮');
  assert.equal(shouldShowTop(240), true);
  assert.equal(shouldShowTop(9999), true);
  assert.equal(shouldShowTop(Number.NaN), false, '滚动值坏掉时别把按钮挂出来');
  assert.equal(shouldShowTop(undefined), false);
  // 自定义阈值
  assert.equal(shouldShowTop(60, 50), true);
  assert.equal(shouldShowTop(40, 50), false);
});

test('拖拽俯仰：按增量推进，冲过上限后往回拖立刻响应（不"还债"）', async () => {
  const client = await loadClient();
  const { stepOrbit, CAM_LIMITS } = client.__internals;

  // 左上：横向是无限转，纵向夹在 ±maxPitch
  const right = stepOrbit({ yaw: 0, pitch: 0 }, 100, 0);
  assert.equal(right.yaw, 0.6);

  // 一路往上拖：到顶就夹住，并明确告诉调用方"被夹了"
  let camera = { yaw: 0, pitch: 0 };
  for (let i = 0; i < 10; i += 1) camera = stepOrbit(camera, 0, -100);
  assert.equal(camera.pitch, CAM_LIMITS.maxPitch);
  assert.equal(stepOrbit(camera, 0, -50).clamped, true, '继续往上拖要报 clamped');

  // 关键回归：在顶部往回拖一小步，视图必须立刻动
  // （旧实现用"离按下点的总位移"算，越界量记在起点里，回拖要先还完债 —— 手感就是卡）
  const back = stepOrbit(camera, 0, 40);
  assert.ok(back.pitch < CAM_LIMITS.maxPitch, `回拖应立刻下降，实际 ${back.pitch}`);
  assert.ok(Math.abs(back.pitch - (CAM_LIMITS.maxPitch - 0.24)) < 1e-9);

  // 没被夹时，分多小步走和一步走到底的落点应当一致（增量推进不能改变手感）
  const oneStep = stepOrbit({ yaw: 0, pitch: 0 }, 30, -20);
  let many = { yaw: 0, pitch: 0 };
  for (let i = 0; i < 10; i += 1) many = stepOrbit(many, 3, -2);
  assert.ok(Math.abs(oneStep.yaw - many.yaw) < 1e-9);
  assert.ok(Math.abs(oneStep.pitch - many.pitch) < 1e-9);
});

test('金线：目标被物理删掉时要标出"已不在库里"，而不是静默只剩一条', async () => {
  const client = await loadClient();
  const { supersedeNote } = client.__internals;
  const ordered = [{ id: 'a' }, { id: 'b' }];
  assert.equal(supersedeNote({ supersedes: ['a'] }, ordered), '1 条');
  assert.equal(supersedeNote({ supersedes: ['a', 'b'] }, ordered), '2 条');
  assert.equal(supersedeNote({ supersedes: ['a', 'gone'] }, ordered), '2 条（1 条已不在库里）');
  assert.equal(supersedeNote({ supersedes: [] }, ordered), '0 条');
  assert.equal(supersedeNote({}, ordered), '0 条');
});

test('点星定位：归档 / 种类 / 文本 / 摘要聚焦该放开的都放开', async () => {
  const client = await loadClient();
  const { revealFiltersFor } = client.__internals;
  const base = { statusFilter: 'active', kindFilter: 'all', textFilter: '', summaryFocus: null };

  assert.deepEqual(revealFiltersFor({ kind: 'fact', status: 'active' }, base), {
    statusFilter: 'active',
    kindFilter: 'all',
    clearText: false,
    clearSummaryFocus: false,
  });

  assert.equal(
    revealFiltersFor({ kind: 'fact', status: 'archived' }, base).statusFilter,
    'all',
    '星图画的是全部记忆，归档星在"只活跃"下看不到 —— 必须放开',
  );
  assert.equal(
    revealFiltersFor({ kind: 'world', status: 'active' }, { ...base, kindFilter: 'fact' }).kindFilter,
    'all',
    '种类过滤会把目标挡掉',
  );
  const focused = revealFiltersFor({ kind: 'fact', status: 'active' }, { ...base, textFilter: '关键词', summaryFocus: 's1' });
  assert.equal(focused.clearText, true);
  assert.equal(focused.clearSummaryFocus, true);

  // 目标本来可见时一个字都不动
  assert.deepEqual(revealFiltersFor({ kind: 'fact', status: 'active' }, { statusFilter: 'all', kindFilter: 'fact', textFilter: '', summaryFocus: null }), {
    statusFilter: 'all',
    kindFilter: 'fact',
    clearText: false,
    clearSummaryFocus: false,
  });
});

test('高亮：召回命中的星只有光晕不画环，只有选中才画金环', async () => {
  const client = await loadClient();
  const { paintPoints } = client.__internals;
  const point = { id: 'p1', kind: 'fact', rgb: [138, 180, 255], radius: 2, phase: 0, createdAt: 0 };
  const project = () => ({ x: 100, y: 100, f: 0.9, depth: 1000, ghost: false, point });

  // 只是本轮召回命中：必须有光晕、但不能有环（否则看起来像"没点就选中了"）
  const focusOnly = { arc: 0, stroke: 0, drawImage: 0 };
  const ctx1 = makeFakeCtx(focusOnly);
  paintPoints(ctx1, [project()], { dpr: 2, quality: 2, presence: null, focus: new Set(['p1']), selected: null, hovered: null });
  assert.equal(focusOnly.arc, 0, '召回命中不该画环');
  assert.ok(focusOnly.drawImage >= 2, '召回命中要有光晕 + 星点');

  // 选中：画一个环，而且是金色（与列表行的金色强调一致）
  const selectedOnly = { arc: 0, stroke: 0, drawImage: 0 };
  const strokes = [];
  const ctx2 = makeFakeCtx(selectedOnly);
  const originalStroke = ctx2.stroke;
  ctx2.stroke = function stroke() {
    strokes.push(ctx2.strokeStyle);
    return originalStroke.apply(this, arguments);
  };
  paintPoints(ctx2, [project()], { dpr: 2, quality: 2, presence: null, focus: null, selected: 'p1', hovered: null });
  assert.equal(selectedOnly.arc, 1, '选中要画环');
  assert.ok(String(strokes[0]).includes('233,192,122'), `选中环应是金色，实际 ${strokes[0]}`);

  // 悬停：也要环，但不是金色
  const hoveredOnly = { arc: 0, stroke: 0, drawImage: 0 };
  const hoverStrokes = [];
  const ctx3 = makeFakeCtx(hoveredOnly);
  const originalStroke3 = ctx3.stroke;
  ctx3.stroke = function stroke() {
    hoverStrokes.push(ctx3.strokeStyle);
    return originalStroke3.apply(this, arguments);
  };
  paintPoints(ctx3, [project()], { dpr: 2, quality: 2, presence: null, focus: null, selected: null, hovered: 'p1' });
  assert.equal(hoveredOnly.arc, 1);
  assert.ok(!String(hoverStrokes[0]).includes('233,192,122'), '悬停环不该用金色，免得和选中混淆');
});

test('光效：每颗星多一层柔光，bloom 只在最高画质档开，且不吃掉帧预算', async () => {
  const client = await loadClient();
  const { layoutSea, projectAll, paintPoints, planBloom, toneOf, CAM_DEFAULT } = client.__internals;

  // 深度色调桶：远 / 中 / 近
  assert.equal(toneOf(0.2), 0, '远处应走冷灰档');
  assert.equal(toneOf(0.6), 1);
  assert.equal(toneOf(1.2), 2, '近处应走提白档');
  assert.equal(toneOf(0), 0);

  // bloom 计划：光效关 或 画质不到最高档，都不跑
  assert.equal(planBloom({ quality: 2, glow: true }).bloom, true);
  assert.equal(planBloom({ quality: 2, glow: false }).bloom, false, '光效关掉就不该跑 bloom');
  assert.equal(planBloom({ quality: 1, glow: true }).bloom, false, '掉帧降档时先牺牲 bloom');
  assert.equal(planBloom({ quality: 2, glow: true }).scale, 0.25, 'bloom 走 1/4 分辨率');

  const { points } = layoutSea(makeMemories(120));
  const projected = projectAll(points, { ...CAM_DEFAULT }, 900, 600, 0, false, null);
  const plain = { drawImage: 0 };
  const glowCounters = { drawImage: 0 };
  const bloomCounters = { drawImage: 0 };
  const drawn = paintPoints(makeFakeCtx(plain), projected, { quality: 2, halo: false, dpr: 1 });
  paintPoints(makeFakeCtx(glowCounters), projected, { quality: 2, halo: true, dpr: 1 });
  const bloomCtx = makeFakeCtx(bloomCounters);
  paintPoints(makeFakeCtx({ drawImage: 0 }), projected, { quality: 2, halo: true, dpr: 1, bloomCtx });

  assert.equal(drawn, projected.length, '每个可见点都要画');
  assert.equal(plain.drawImage, drawn, '朴素模式：一点一次');
  assert.equal(glowCounters.drawImage, drawn * 2, '光效模式：柔光 + 实体各一次');
  assert.equal(bloomCounters.drawImage, drawn, 'bloom 层也要各画一次柔光');

  // 性能：120 点 × 120 帧的光效模式必须远低于一帧预算
  const ctx = makeFakeCtx({ drawImage: 0 });
  const frames = 120;
  const started = process.hrtime.bigint();
  for (let frame = 0; frame < frames; frame += 1) {
    paintPoints(ctx, projected, { quality: 2, halo: true, dpr: 1, time: frame * 16 });
  }
  const perFrameMs = Number(process.hrtime.bigint() - started) / 1e6 / frames;
  assert.ok(perFrameMs < 8, `光效模式每帧成本应低于 8ms，实测 ${perFrameMs.toFixed(3)}ms`);
});

test('云层：每簇一张烘焙云，按深度从远到近画，低画质不出云', async () => {
  const client = await loadClient();
  const { clusterCloudPlan, paintClusterClouds, cloudSprite } = client.__internals;
  const mk = (cluster, x, y, depth) => ({
    x,
    y,
    depth,
    f: 1,
    ghost: false,
    point: { id: `${cluster}-${x}`, cluster, rgb: [138, 180, 255] },
  });
  const projected = [mk('a', 100, 100, 2200), mk('b', 400, 300, 800), mk('c', 700, 500, 1500)];

  const plan = clusterCloudPlan(projected, 900, 600, { quality: 2 });
  assert.equal(plan.length, 3);
  assert.deepEqual(plan.map((cloud) => cloud.cluster), ['a', 'c', 'b'], '必须从远到近：远处的云先画');
  assert.equal(clusterCloudPlan(projected, 900, 600, { quality: 1 }).length, 0, '掉档时不出云（整屏填充太大）');
  for (const cloud of plan) assert.ok(cloud.radius >= 100 && cloud.radius <= 440, '云半径要有上下限（太大就是一团雾）');

  const counters = { drawImage: 0 };
  const ctx = makeFakeCtx(counters);
  const drawn = paintClusterClouds(ctx, projected, 900, 600, { quality: 2, time: 1000 });
  assert.equal(drawn, 3, '每簇一张云');
  assert.equal(counters.drawImage, 3);
  assert.equal(ctx.globalCompositeOperation, 'source-over', '画完要把合成模式还原，否则后面的星会被叠亮');

  // 精灵按簇缓存：同键同实例、尺寸固定
  const spriteA = cloudSprite([138, 180, 255], 'k1');
  const spriteB = cloudSprite([138, 180, 255], 'k1');
  assert.equal(spriteA, spriteB, '同一簇的云必须复用同一张烘焙图');
  assert.equal(spriteA.width, 256);
});

test('深空底：满分辨率烘焙、铺大量星尘，且用完把合成模式还原', async () => {
  const client = await loadClient();
  const { paintDeepSpace } = client.__internals;
  const ctx = makeFakeCtx({ gradient: 0 });
  // 画布要把 ctx 缓存下来：paintDeepSpace 会自己再 getContext 一次，否则补丁打不到它用的那份
  const canvas = { width: 0, height: 0, getContext: () => ctx };
  const fills = [];
  const originalFillRect = ctx.fillRect;
  ctx.fillRect = function fillRect(x, y, w, h) {
    fills.push([x, y, w, h]);
    return originalFillRect.apply(this, arguments);
  };

  paintDeepSpace(canvas, 800, 500, 2, [[138, 180, 255], [192, 162, 255]]);
  // 满分辨率（受 1.5 倍上限约束）：不能再用半分辨率放大，那正是"糊"的来源
  assert.equal(canvas.width, Math.round((800 + 24) * 1.5));
  assert.equal(canvas.height, Math.round((500 + 24) * 1.5));
  // 星尘数量按面积走：800×500 应铺出上千颗 1px 级别的点
  // 碎光必须**稀疏**：上一版铺了上千颗，背景自己就成了一张星图，把记忆星压下去了
  const dots = fills.filter(([, , w, h]) => w <= 3 && h <= 3);
  assert.ok(dots.length > 100, `要有点碎光，实际 ${dots.length} 个`);
  assert.ok(dots.length < 900, `碎光不能密到抢戏，实际 ${dots.length} 个`);
  assert.equal(ctx.globalCompositeOperation, 'source-over', '画完要把加性合成还原');
});

test('呼吸光：逐星不同相位/周期，振幅有界，关掉就不动', async () => {
  const client = await loadClient();
  const { breathOf, layoutSea, projectAll, paintPoints, CAM_DEFAULT } = client.__internals;

  // 有界：任何时刻都在 1±amplitude 之内
  for (let step = 0; step < 40; step += 1) {
    const value = breathOf(step * 137, 1.23, 0.1);
    assert.ok(value >= 0.9 - 1e-9 && value <= 1.1 + 1e-9, `呼吸系数越界：${value}`);
  }
  assert.equal(breathOf(1234, 0.5, 0), 1, '振幅为 0 时必须不呼吸');
  // 不同相位的星在同一时刻不该同步（否则整屏一起闪）
  const a = breathOf(1500, 0.2, 0.1);
  const b = breathOf(1500, 2.6, 0.1);
  assert.ok(Math.abs(a - b) > 0.01, '不同相位应给出不同亮度');

  // 主画布上柔光层确实在随时间变化
  const { points } = layoutSea(makeMemories(30));
  const projected = projectAll(points, { ...CAM_DEFAULT }, 900, 600, 0, false, null);
  const alphasAt = (time) => {
    const seen = [];
    const ctx = makeFakeCtx({});
    const original = ctx.drawImage;
    ctx.drawImage = function capture(...args) {
      seen.push(ctx.globalAlpha);
      return original.apply(this, args);
    };
    paintPoints(ctx, projected, { quality: 2, halo: true, dpr: 1, time });
    return seen;
  };
  const first = alphasAt(0);
  const later = alphasAt(1800);
  assert.equal(first.length, later.length);
  const changed = first.filter((value, index) => Math.abs(value - later[index]) > 1e-6).length;
  assert.ok(changed > 10, `柔光透明度应随时间变化，实测只有 ${changed} 个点变了`);
});

test('呼吸光必须"看得见"：柔光尺寸要胀缩一成以上，透明度要变化两成以上', async () => {
  const client = await loadClient();
  const { layoutSea, projectAll, paintPoints, CAM_DEFAULT } = client.__internals;
  const { points } = layoutSea(makeMemories(20));
  const projected = projectAll(points, { ...CAM_DEFAULT }, 900, 600, 0, false, null);
  const capture = (time) => {
    const draws = [];
    const ctx = makeFakeCtx({});
    const original = ctx.drawImage;
    ctx.drawImage = function record(...args) {
      draws.push({ alpha: ctx.globalAlpha, width: args[3] });
      return original.apply(this, args);
    };
    paintPoints(ctx, projected, { quality: 2, halo: true, dpr: 1, time });
    return draws;
  };
  // 覆盖一个以上完整周期（周期 2.8–5.4s）
  const samples = [0, 700, 1400, 2100, 2800, 3500, 4200].map(capture);
  // 取第一颗（最远的那颗）：它没有热点加成，透明度不会被 1.0 截断，采样才看得出变化；
  // 注意绘制顺序是「先全部柔光、再全部实体」，所以第 0 个 drawImage 才是柔光层
  const index = 0;
  const widths = samples.map((draws) => draws[index].width);
  const alphaValues = samples.map((draws) => draws[index].alpha);
  const widthRatio = Math.max(...widths) / Math.min(...widths);
  const alphaRatio = Math.max(...alphaValues) / Math.min(...alphaValues);
  // 上一版振幅 10%、周期近 7 秒，在暗背景上等于静止 —— 这条就是防它回归
  assert.ok(widthRatio > 1.1, `柔光尺寸涨缩应超过 10%，实测 ${((widthRatio - 1) * 100).toFixed(1)}%`);
  assert.ok(alphaRatio > 1.2, `柔光透明度变化应超过 20%，实测 ${((alphaRatio - 1) * 100).toFixed(1)}%`);
});

test('焦点模式：没命中的云与标签也要一起压暗', async () => {
  const client = await loadClient();
  const { clusterCloudPlan, paintLabels, pickLabelCandidates, projectAll, layoutSea, CAM_DEFAULT } = client.__internals;
  const mk = (cluster, x, y, depth, id) => ({ x, y, depth, f: 1, ghost: false, point: { id, cluster, rgb: [138, 180, 255] } });
  const projected = [mk('a', 100, 100, 900, 'a1'), mk('b', 400, 300, 900, 'b1')];

  const plan = clusterCloudPlan(projected, 900, 600, { quality: 2, onlyFocus: true, focus: new Set(['a1']) });
  const byCluster = new Map(plan.map((cloud) => [cloud.cluster, cloud.focused]));
  assert.equal(byCluster.get('a'), true, '有命中的簇正常显示');
  assert.equal(byCluster.get('b'), false, '没命中的簇要跟着压暗，否则按钮按下后云还亮着');

  // 标签同理：非命中点的字色透明度必须显著更低
  const { points } = layoutSea(makeMemories(40));
  const projectedAll = projectAll(points, { ...CAM_DEFAULT }, 900, 600, 0, false, null);
  const positions = new Map(projectedAll.map((p) => [p.point.id, p]));
  const candidates = pickLabelCandidates(points, 8);
  const alphas = [];
  const counters = { fillText: 0 };
  const ctx = makeFakeCtx(counters);
  const original = ctx.fillText;
  ctx.fillText = function capture(...args) {
    alphas.push(ctx.globalAlpha);
    return original.apply(this, args);
  };
  paintLabels(ctx, candidates, positions, 900, 600, {
    alphaMap: new Map(),
    dt: 600,
    onlyFocus: true,
    focus: new Set([candidates[0].id]),
  });
  assert.ok(alphas.length >= 2, `至少要画出命中与非命中两类标签，实际 ${alphas.length}`);
  const brightest = Math.max(...alphas);
  const faintest = Math.min(...alphas);
  assert.ok(faintest <= brightest * 0.3, `非命中标签应压到约 1/8，实测 ${faintest} vs ${brightest}`);
});
