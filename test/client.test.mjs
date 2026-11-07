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
    measureText(text) {
      if (counters !== null && typeof counters.measureText === 'number') counters.measureText += 1;
      return { width: String(text ?? '').length * 6 };
    },
    createRadialGradient() {
      tick('gradient');
      return { addColorStop() {} };
    },
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
    },
    head: { appendChild: () => {} },
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
  const counters = { fillText: 0, fillRect: 0, measureText: 0 };
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
  assert.ok(counters.fillRect > 0, '透明度上来后应该有底衬');
  assert.ok(counters.fillRect <= counters.fillText * 2, '每个标签最多底衬 + 引线两条矩形');

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
