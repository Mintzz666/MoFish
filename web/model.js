// MoFish 领域模型（存档 v2）。
//
// v2 相对 v1 的变化（A 阶段存档必须无损升级）：
// - 每条鱼新增稳定类型 id（字符串 `species`）与持久外观 `look {v, seed}`；
// - 造景从「水草数量」升级为对象列表 `decor[]`（水草/石头/沉木，含位置/旋转/缩放/种子）；
// - 成长规则改为四阶段（鱼苗→幼鱼→亚成年→成年），时间 + 实际进食共同贡献，周期约为上一版两倍。
// 迁移是确定性的：同一份 v1 存档反复升级都会得到同一批鱼、同一批水草（按 id 哈希取种子），
// 不会刷新一次就换一批造型。

import {
  SPECIES, FISH_TYPES, FISH_TYPE_BY_ID, LEGACY_SPECIES_MAP, PLANT_TYPES, ROCK_TYPES, WOOD_TYPES,
  DECOR_KINDS, DECOR_MAX, LEGACY_PLANT_X, LEGACY_PLANT_TYPES, normalizeSpeciesId, decorType
} from './catalog.js';

export { SPECIES, FISH_TYPES, DECOR_KINDS, DECOR_MAX };

export const KEY = 'mofish.v1';
export const MAX_FISH = 12;
// 存档结构版本：写入云端时作为 state_version 提交。v2 需要新的服务端迁移（见 supabase/migrations）。
export const STATE_VERSION = 2;
/** 外观生成器版本：升级时必须保留旧算法，不能重掷已有鱼/造景的外观。 */
export const LOOK_VERSION = 1;

const DAY_MS = 86400000;
const clamp = (n, a, b) => Math.min(b, Math.max(a, n));
// Preserve already-normalized values exactly: adding 2π on every read changes
// decimal payloads by an ulp and can cause false shared-operation conflicts.
function normalizedRotation(n) {
  const turn = Math.PI * 2;
  if (n >= 0 && n < turn) return n;
  const remainder = n % turn;
  return remainder < 0 ? remainder + turn : remainder;
}


/**
 * 成长规则（四阶段）。默认体验：持续照料约 14 天成年，正常进食约 10 天。
 * - 时间成长 0.05/24h；营养成长最多 0.02/24h，来自每天最多 3 口被吃到的食物。
 * - 成年阈值仍是 0.7（旧成年鱼不会因新增阶段而倒退），0.7 之后只做很缓的收尾长大。
 * 服务端以同一组数字结算（supabase/migrations/20261018…phase_b_growth.sql）。
 */
export const GROWTH = Object.freeze({
  naturalPerDay: 0.05,
  nutritionPerDay: 0.02,
  bitesPerDay: 3,
  biteGrowth: 0.02 / 3,
  offlineCapHours: 24,
  max: 1
});

export const STAGES = Object.freeze([
  { key: 'fry', name: '鱼苗期', min: 0 },
  { key: 'juvenile', name: '幼鱼期', min: 0.15 },
  { key: 'subadult', name: '亚成年期', min: 0.4 },
  { key: 'adult', name: '成年期', min: 0.7 }
]);

// ------------------------------------------------------------------ 随机与哈希

/** 32 位字符串哈希（FNV-1a 变体）：迁移时用来把旧 id 稳定映射成外观种子。 */
export function hashSeed(text) {
  let h = 2166136261 >>> 0;
  const s = String(text);
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

/** mulberry32：小而稳的确定性 PRNG，同一个种子永远给出同一串数值。 */
export function mulberry32(seed) {
  let a = (seed >>> 0) || 1;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function randomSeed() {
  const c = globalThis.crypto;
  if (c && typeof c.getRandomValues === 'function') {
    const buf = new Uint32Array(1);
    c.getRandomValues(buf);
    return buf[0] >>> 0;
  }
  return (Math.random() * 4294967296) >>> 0;
}

function newId() {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  return `id-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e9).toString(36)}`;
}

const lerp = (a, b, t) => a + (b - a) * t;
const pick = (rnd, arr) => arr[Math.min(arr.length - 1, Math.floor(rnd() * arr.length))];
const range = (rnd, pair) => lerp(pair[0], pair[1], rnd());

function hslToHex(h, s, l) {
  const hue = ((h % 360) + 360) % 360;
  const sat = clamp(s, 0, 1);
  const light = clamp(l, 0, 1);
  const c = (1 - Math.abs(2 * light - 1)) * sat;
  const x = c * (1 - Math.abs(((hue / 60) % 2) - 1));
  const m = light - c / 2;
  let rgb;
  if (hue < 60) rgb = [c, x, 0];
  else if (hue < 120) rgb = [x, c, 0];
  else if (hue < 180) rgb = [0, c, x];
  else if (hue < 240) rgb = [0, x, c];
  else if (hue < 300) rgb = [x, 0, c];
  else rgb = [c, 0, x];
  const to = (v) => Math.round(clamp(v + m, 0, 1) * 255).toString(16).padStart(2, '0');
  return `#${to(rgb[0])}${to(rgb[1])}${to(rgb[2])}`;
}

// ------------------------------------------------------------------ 外观推导（持久种子的唯一消费者）

/** 体型随成长连续变化：0.34（鱼苗）→ 1.0（成年 0.7）→ 约 1.05（0.7 以后继续缓慢长大）。 */
export function fishSizeFactor(growth) {
  const g = clamp(growth, 0, 1);
  const reached = g >= STAGES[3].min ? 1 + (g - STAGES[3].min) * 0.18 : Math.pow(g / STAGES[3].min, 0.85);
  return 0.34 + 0.66 * reached;
}

/** 幼态比例：鱼苗头部相对更大、鳍更短，随成长平滑过渡（不在阈值处跳变）。 */
export function fishProportions(growth) {
  const g = clamp(growth, 0, 1);
  const reached = g >= STAGES[3].min ? 1 : Math.pow(g / STAGES[3].min, 0.85);
  return {
    size: fishSizeFactor(growth),
    head: 1.16 - 0.16 * reached,
    fin: 0.5 + 0.5 * reached,
    eye: 1.25 - 0.25 * reached,
    vivid: 0.52 + 0.48 * reached
  };
}

/**
 * 同种鱼的个体外观：主辅色、花纹、体长/体宽/鳍比例、游动节律都从持久 seed 派生。
 * 只读 look.seed / look.v，不修改存档；同一条鱼在任何设备、任何画质下都是同一副样子。
 */
export function fishAppearance(fish) {
  const type = FISH_TYPE_BY_ID[normalizeSpeciesId(fish?.species)] || FISH_TYPES[0];
  const seed = Number.isFinite(fish?.look?.seed) ? fish.look.seed >>> 0 : hashSeed(fish?.id ?? 'fish');
  const rnd = mulberry32(seed);
  const p = type.palette;
  const hue = range(rnd, p.hue) + (rnd() - 0.5) * 6;
  const sat = range(rnd, p.sat) + (rnd() - 0.5) * 0.05;
  const light = range(rnd, p.light) + (rnd() - 0.5) * 0.05;
  const accentHue = p.accentHue + (rnd() - 0.5) * 12;
  const accentSat = range(rnd, p.accentSat);
  const pattern = pick(rnd, p.patterns);
  const props = fishProportions(fish?.growth ?? 0);
  const bodyColor = hslToHex(hue, sat * props.vivid, light + (1 - props.vivid) * 0.12);
  const accentColor = hslToHex(accentHue, accentSat * props.vivid, Math.min(0.78, light - 0.04));
  return {
    typeId: type.id,
    name: type.name,
    note: type.note,
    body: bodyColor,
    accent: accentColor,
    belly: hslToHex(hue, sat * 0.45 * props.vivid, Math.min(0.86, light + 0.1)),
    fin: hslToHex(accentHue, Math.min(0.62, accentSat * 0.95), Math.max(0.24, light - 0.02)),
    eye: '#1d2f31',
    pattern,
    patternScale: 0.75 + rnd() * 0.6,
    lenScale: 0.93 + rnd() * 0.14,
    depthScale: 0.93 + rnd() * 0.14,
    finScale: 0.88 + rnd() * 0.24,
    phase: rnd() * Math.PI * 2,
    tempo: 0.88 + rnd() * 0.24,
    props
  };
}

/** 造景个体参数：轮廓、尺度比例、色差都由 seed 决定，换「造型」只是换 seed。 */
export function decorAppearance(kind, typeId, seed) {
  const type = decorType(kind, typeId);
  if (!type) return null;
  const rnd = mulberry32((seed >>> 0) || 1);
  const params = {};
  for (const [key, value] of Object.entries(type.params || {})) {
    if (Array.isArray(value) && value.length === 2) params[key] = range(rnd, value);
    else params[key] = value;
  }
  const p = type.palette || { hue: [0, 0], sat: [0, 0], light: [0.5, 0.5] };
  const hue = range(rnd, p.hue) + (rnd() - 0.5) * 8;
  const sat = range(rnd, p.sat);
  const light = range(rnd, p.light);
  return {
    kind, typeId: type.id, typeName: type.name, shape: type.shape, params,
    seed: (seed >>> 0) || 1,
    color: hslToHex(hue, sat, light),
    shade: hslToHex(hue - 6, sat * 0.9, Math.max(0.12, light - 0.12)),
    highlight: hslToHex(hue + 4, sat * 0.7, Math.min(0.9, light + 0.14)),
    hue, sat, light,
    scaleJitter: 0.92 + rnd() * 0.16,
    tilt: (rnd() - 0.5) * 0.5
  };
}

// ------------------------------------------------------------------ 成长阶段与鱼龄

export function stageOf(growth) {
  const g = clamp(Number.isFinite(growth) ? growth : 0, 0, 1);
  let index = 0;
  for (let i = STAGES.length - 1; i >= 0; i -= 1) {
    if (g >= STAGES[i].min) { index = i; break; }
  }
  const current = STAGES[index];
  const next = STAGES[index + 1] || null;
  const progress = next ? clamp((g - current.min) / (next.min - current.min), 0, 1) : clamp((g - current.min) / (1 - current.min), 0, 1);
  return { index, key: current.key, name: current.name, min: current.min, next: next ? next.min : 1, progress };
}

/** 鱼龄（日龄，按出生时间以来的实际天数，与成长阶段分开）。 */
export function ageDays(born, now = Date.now()) {
  return Math.max(0, (now - born) / DAY_MS);
}

/** 到下一阶段还差多少成长值；已成年返回 0。 */
export function growthToNextStage(growth) {
  const stage = stageOf(growth);
  return stage.next == null ? 0 : Math.max(0, stage.next - clamp(growth, 0, 1));
}

// ------------------------------------------------------------------ 创建

export function makeFish(index = 0, now = Date.now(), options = {}) {
  const typeId = options.species
    ? normalizeSpeciesId(options.species)
    : FISH_TYPES[index % FISH_TYPES.length].id;
  const id = options.id || newId();
  return {
    id,
    name: options.name || ['小满', '泡泡', '阿橘', '小月', '青团', '慢慢', '星子', '团子', '须须'][index % 9],
    species: typeId,
    born: options.born ?? now,
    growth: clamp(options.growth ?? 0, 0, 1),
    meals: clamp(Math.floor(options.meals ?? 0), 0, 1e6),
    look: { v: LOOK_VERSION, seed: options.seed != null ? options.seed >>> 0 : randomSeed() }
  };
}

/**
 * 首缸推荐构图：4 套模板按 layoutSeed 选一套再轻微抖动。
 * 首次创建后写入存档，之后进入/切画质/刷新都不会重新排布。
 */
const STARTER_LAYOUTS = [
  [
    { kind: 'plant', type: 'vallis', x: 0.12, z: 0.16, scale: 1.0 },
    { kind: 'plant', type: 'vallis', x: 0.21, z: 0.1, scale: 0.86 },
    { kind: 'plant', type: 'rotala', x: 0.31, z: 0.14, scale: 0.95 },
    { kind: 'rock', type: 'seiryu', x: 0.44, z: 0.3, scale: 1.0 },
    { kind: 'rock', type: 'pebble', x: 0.56, z: 0.44, scale: 0.8 },
    { kind: 'wood', type: 'branch', x: 0.74, z: 0.24, scale: 1.0 },
    { kind: 'plant', type: 'anubias', x: 0.84, z: 0.3, scale: 0.95 },
    { kind: 'plant', type: 'carpet', x: 0.5, z: 0.66, scale: 1.1 }
  ],
  [
    { kind: 'plant', type: 'fern', x: 0.16, z: 0.12, scale: 1.05 },
    { kind: 'plant', type: 'carpet', x: 0.28, z: 0.62, scale: 1.15 },
    { kind: 'rock', type: 'sandstone', x: 0.36, z: 0.26, scale: 1.05 },
    { kind: 'rock', type: 'slate', x: 0.5, z: 0.34, scale: 0.95 },
    { kind: 'plant', type: 'vallis', x: 0.63, z: 0.12, scale: 1.1 },
    { kind: 'wood', type: 'stump', x: 0.72, z: 0.32, scale: 0.95 },
    { kind: 'plant', type: 'moss', x: 0.8, z: 0.2, scale: 1.0 },
    { kind: 'plant', type: 'vallis', x: 0.9, z: 0.16, scale: 0.9 }
  ],
  [
    { kind: 'wood', type: 'branch', x: 0.2, z: 0.16, scale: 1.05 },
    { kind: 'plant', type: 'anubias', x: 0.3, z: 0.24, scale: 1.0 },
    { kind: 'plant', type: 'rotala', x: 0.42, z: 0.12, scale: 0.95 },
    { kind: 'rock', type: 'lava', x: 0.55, z: 0.3, scale: 1.0 },
    { kind: 'rock', type: 'pebble', x: 0.62, z: 0.46, scale: 0.85 },
    { kind: 'plant', type: 'fern', x: 0.8, z: 0.18, scale: 1.1 },
    { kind: 'plant', type: 'carpet', x: 0.7, z: 0.64, scale: 1.05 }
  ],
  [
    { kind: 'plant', type: 'carpet', x: 0.18, z: 0.6, scale: 1.1 },
    { kind: 'rock', type: 'seiryu', x: 0.3, z: 0.28, scale: 1.1 },
    { kind: 'plant', type: 'moss', x: 0.38, z: 0.19, scale: 1.0 },
    { kind: 'wood', type: 'stump', x: 0.52, z: 0.24, scale: 1.0 },
    { kind: 'plant', type: 'vallis', x: 0.66, z: 0.12, scale: 1.0 },
    { kind: 'plant', type: 'vallis', x: 0.75, z: 0.18, scale: 0.9 },
    { kind: 'rock', type: 'sandstone', x: 0.86, z: 0.34, scale: 0.95 },
    { kind: 'plant', type: 'rotala', x: 0.94, z: 0.2, scale: 0.95 }
  ]
];

/** 生成首次布景：结构固定、参数由 layoutSeed 决定，因此同一份 seed 永远得到同一份构图。 */
export function starterDecor(layoutSeed, decorate = (item, i) => item) {
  const rnd = mulberry32(layoutSeed);
  const template = STARTER_LAYOUTS[Math.floor(rnd() * STARTER_LAYOUTS.length) % STARTER_LAYOUTS.length];
  return template.map((slot, i) => {
    const jitterX = (rnd() - 0.5) * 0.03;
    const jitterZ = (rnd() - 0.5) * 0.03;
    const item = {
      id: `d${i + 1}-${(layoutSeed >>> 0).toString(36)}`,
      kind: slot.kind,
      type: slot.type,
      x: clamp(slot.x + jitterX, 0.04, 0.96),
      z: clamp(slot.z + jitterZ, 0.05, 0.95),
      rot: rnd() * Math.PI * 2,
      scale: clamp(slot.scale * (0.92 + rnd() * 0.16), 0.6, 1.6),
      seed: hashSeed(`${layoutSeed}:${i}:${slot.type}`),
      v: LOOK_VERSION
    };
    return decorate(item, i) || item;
  });
}

export function initial(now = Date.now()) {
  const layoutSeed = randomSeed();
  return {
    version: STATE_VERSION,
    fish: [0, 1, 2].map((i) => makeFish(i, now, { species: FISH_TYPES[i].id })),
    decor: starterDecor(layoutSeed),
    layout: { v: LOOK_VERSION, seed: layoutSeed },
    night: false,
    sound: false,
    savedAt: now
  };
}

// ------------------------------------------------------------------ 迁移与校验

function migrateV1(raw, now) {
  const fish = raw.fish.map((f) => {
    const id = String(f.id).slice(0, 100);
    const typeId = normalizeSpeciesId(f.species);
    return {
      id,
      name: String(f.name).trim().slice(0, 16) || '小鱼',
      species: typeId,
      born: clamp(Number(f.born), 0, now),
      growth: clamp(Number(f.growth), 0, 1),
      meals: clamp(Math.floor(Number(f.meals)), 0, 1e6),
      // 旧鱼没有外观种子：用 id 哈希，保证「同一条鱼」每次都得到同一副样子。
      look: { v: LOOK_VERSION, seed: hashSeed(`fish:${id}`) }
    };
  });
  const count = clamp(Math.floor(Number(raw.plants) || 0), 0, 8);
  const decor = Array.from({ length: count }, (_, i) => ({
    id: `legacy-plant-${i + 1}`,
    kind: 'plant',
    type: LEGACY_PLANT_TYPES[i % LEGACY_PLANT_TYPES.length],
    x: clamp(LEGACY_PLANT_X[i] ?? 0.2 + i * 0.1, 0.03, 0.97),
    z: clamp(0.16 + (i % 3) * 0.14, 0.05, 0.95),
    rot: (i * 1.7) % (Math.PI * 2),
    scale: 1,
    seed: hashSeed(`legacy-plant:${i}`),
    v: LOOK_VERSION
  }));
  return {
    version: STATE_VERSION,
    fish,
    decor,
    layout: { v: LOOK_VERSION, seed: hashSeed(`legacy-layout:${fish.map((f) => f.id).join(',')}`) },
    night: raw.night === true,
    sound: raw.sound === true,
    savedAt: Number.isFinite(raw.savedAt) ? raw.savedAt : now
  };
}

const SPECIES_ID_RE = /^[a-z][a-z0-9_-]{1,31}$/;
const DECOR_TYPE_RE = /^[a-z][a-z0-9_-]{0,23}$/;

/**
 * 读取/导入存档的统一入口：v1 自动升级为 v2，v2 逐字段清洗并限幅。
 * 结构性问题直接抛错，让调用方保留原档；数值越界只做限幅，不丢鱼。
 */
export function validate(raw, now = Date.now()) {
  if (!raw || typeof raw !== 'object') throw new Error('存档格式不正确');
  if (raw.version === 1) {
    if (!Array.isArray(raw.fish) || raw.fish.length < 1 || raw.fish.length > MAX_FISH) throw new Error('存档格式不正确');
    return validateV2(migrateV1(raw, now), now);
  }
  if (raw.version !== STATE_VERSION) throw new Error('存档格式不正确');
  return validateV2(raw, now);
}

function validateV2(raw, now) {
  if (!raw || typeof raw !== 'object' || raw.version !== STATE_VERSION) throw new Error('存档格式不正确');
  if (!Array.isArray(raw.fish) || raw.fish.length < 1 || raw.fish.length > MAX_FISH) throw new Error('存档格式不正确');

  const ids = new Set();
  const fish = raw.fish.map((f) => {
    if (!f || typeof f.id !== 'string') throw new Error('鱼儿数据不完整');
    if (ids.has(f.id)) throw new Error('鱼儿数据不完整');
    ids.add(f.id);
    if (typeof f.name !== 'string') throw new Error('鱼儿数据不完整');
    if (typeof f.species !== 'string' && !Number.isInteger(f.species)) throw new Error('鱼儿数据不完整');
    if (![f.born, f.growth, f.meals].every(Number.isFinite)) throw new Error('鱼儿数据不完整');
    const species = typeof f.species === 'string' && SPECIES_ID_RE.test(f.species)
      ? f.species
      : normalizeSpeciesId(f.species);
    const seed = Number.isFinite(f.look?.seed) ? (f.look.seed >>> 0) : hashSeed(`fish:${f.id}`);
    const fedAt = Array.isArray(f.fedAt)
      ? f.fedAt.filter((t) => Number.isFinite(t) && t >= 0 && t <= now + 60000).slice(-GROWTH.bitesPerDay * 2)
      : [];
    const out = {
      id: f.id.slice(0, 100),
      name: f.name.trim().slice(0, 16) || '小鱼',
      species,
      born: clamp(f.born, 0, now),
      growth: clamp(f.growth, 0, 1),
      meals: clamp(Math.floor(f.meals), 0, 1e6),
      look: { v: LOOK_VERSION, seed }
    };
    if (fedAt.length) out.fedAt = fedAt;
    return out;
  });

  const decorRaw = Array.isArray(raw.decor) ? raw.decor : [];
  if (decorRaw.length > DECOR_MAX) throw new Error('造景数量超出上限');
  const decorIds = new Set();
  const perKind = { plant: 0, rock: 0, wood: 0 };
  const decor = decorRaw.map((d) => {
    if (!d || typeof d.id !== 'string' || !d.id) throw new Error('造景数据不完整');
    if (decorIds.has(d.id)) throw new Error('造景数据不完整');
    decorIds.add(d.id);
    const kind = DECOR_KINDS[d.kind] ? d.kind : null;
    if (!kind) throw new Error('造景数据不完整');
    perKind[kind] += 1;
    if (perKind[kind] > DECOR_KINDS[kind].max) throw new Error('造景数量超出上限');
    const type = typeof d.type === 'string' && DECOR_TYPE_RE.test(d.type) ? d.type : DECOR_KINDS[kind].types[0].id;
    if (![d.x, d.z, d.rot, d.scale].every(Number.isFinite)) throw new Error('造景数据不完整');
    return {
      id: d.id.slice(0, 100),
      kind,
      type,
      x: clamp(d.x, 0, 1),
      z: clamp(d.z, 0, 1),
      rot: normalizedRotation(d.rot),
      scale: clamp(d.scale, 0.6, 1.6),
      seed: Number.isFinite(d.seed) ? (d.seed >>> 0) : hashSeed(`decor:${d.id}`),
      v: LOOK_VERSION
    };
  });

  const layoutSeed = Number.isFinite(raw.layout?.seed) ? (raw.layout.seed >>> 0) : randomSeed();
  return {
    version: STATE_VERSION,
    fish,
    decor,
    layout: { v: LOOK_VERSION, seed: layoutSeed },
    night: raw.night === true,
    sound: raw.sound === true,
    savedAt: Number.isFinite(raw.savedAt) ? clamp(raw.savedAt, 0, now) : now
  };
}

// ------------------------------------------------------------------ 成长

/**
 * 离线/离开页面期间的成长（时间部分）。游客本机直接用它；
 * 已登录时由服务端 settle_growth 按服务端时间结算，避免同一段时间加两次。
 */
export function catchUp(state, now = Date.now()) {
  const hours = clamp((now - state.savedAt) / 3600000, 0, GROWTH.offlineCapHours);
  state.fish.forEach((f) => {
    f.growth = clamp(f.growth + (hours / 24) * GROWTH.naturalPerDay, 0, 1);
    if (Array.isArray(f.fedAt)) f.fedAt = f.fedAt.filter((t) => now - t < DAY_MS);
  });
  state.savedAt = now;
  return hours;
}

/**
 * 游客模式：鱼真的吃到一口食物时调用。
 * 每天（滚动 24h）最多 3 口计入营养成长；超出仍然记录 meals（互动反馈），但不再加速成长。
 */
export function eat(fish, now = Date.now()) {
  fish.meals = clamp((fish.meals || 0) + 1, 0, 1e6);
  const recent = (Array.isArray(fish.fedAt) ? fish.fedAt : []).filter((t) => Number.isFinite(t) && now - t < DAY_MS && t <= now + 60000);
  const credited = recent.length < GROWTH.bitesPerDay;
  if (credited) {
    recent.push(now);
    fish.growth = clamp((fish.growth || 0) + GROWTH.biteGrowth, 0, 1);
  }
  fish.fedAt = recent.slice(-GROWTH.bitesPerDay);
  return { credited, remaining: Math.max(0, GROWTH.bitesPerDay - recent.length) };
}

export function cloneState(state) {
  return JSON.parse(JSON.stringify(state));
}

/**
 * 「是否有实质变更」的稳定指纹：用于云端去抖与冲突判断。
 * 刻意排除 savedAt、瞬时位置、相机、画质等随渲染或时间自行变化的字段。
 */
export function canonicalState(state) {
  return JSON.stringify([
    state.version,
    state.fish.map((f) => [f.id, f.name, f.species, f.born, Math.round(f.growth * 1e6) / 1e6, f.meals,
      f.look?.v ?? LOOK_VERSION, f.look?.seed ?? 0]),
    [...state.decor].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      .map((d) => [d.id, d.kind, d.type, round3(d.x), round3(d.z), round3(d.rot), round3(d.scale), d.seed, d.v ?? LOOK_VERSION]),
    state.layout?.v ?? LOOK_VERSION,
    state.layout?.seed ?? 0,
    state.night === true,
    state.sound === true
  ]);
}

function round3(n) {
  return Math.round(n * 1000) / 1000;
}

// ------------------------------------------------------------------ 造景增删改（纯函数，便于测试）

/** 在鱼缸空位生成一个新造景对象；返回 {state, object}，不修改入参。 */
export function addDecor(state, kind, typeId, seed = randomSeed(), now = Date.now()) {
  const bucket = DECOR_KINDS[kind];
  if (!bucket) throw new Error('未知的造景类型');
  if (state.decor.length >= DECOR_MAX) throw new Error('鱼缸里的摆件已经满了');
  if (state.decor.filter((d) => d.kind === kind).length >= bucket.max) throw new Error(`${bucket.name}已经到上限了`);
  const rnd = mulberry32(seed);
  const object = {
    id: newId(),
    kind,
    type: bucket.types.some((t) => t.id === typeId) ? typeId : bucket.types[0].id,
    x: clamp(0.18 + rnd() * 0.64, 0.05, 0.95),
    z: clamp(0.22 + rnd() * 0.5, 0.05, 0.95),
    rot: rnd() * Math.PI * 2,
    scale: 0.85 + rnd() * 0.35,
    seed: (seed ^ hashSeed(typeId)) >>> 0,
    v: LOOK_VERSION
  };
  const next = cloneState(state);
  next.decor.push(object);
  next.savedAt = now;
  return { state: next, object };
}

/** 换一个造型：只换 seed，保持位置与大小。 */
export function reshuffleDecor(state, id, seed = randomSeed(), now = Date.now()) {
  const next = cloneState(state);
  const target = next.decor.find((d) => d.id === id);
  if (!target) return { state: next, object: null };
  target.seed = seed >>> 0;
  next.savedAt = now;
  return { state: next, object: target };
}

export function removeDecor(state, id, now = Date.now()) {
  const next = cloneState(state);
  const index = next.decor.findIndex((d) => d.id === id);
  if (index < 0) return { state: next, removed: null };
  const [removed] = next.decor.splice(index, 1);
  next.savedAt = now;
  return { state: next, removed };
}

/** 统一约束一次变换：位置限制在缸底、旋转归一化、缩放限幅。 */
export function clampTransform({ x, z, rot, scale }) {
  return {
    x: clamp(Number.isFinite(x) ? x : 0.5, 0, 1),
    z: clamp(Number.isFinite(z) ? z : 0.5, 0, 1),
    rot: Number.isFinite(rot) ? normalizedRotation(rot) : 0,
    scale: clamp(Number.isFinite(scale) ? scale : 1, 0.6, 1.6)
  };
}

export function updateDecor(state, id, transform, now = Date.now()) {
  const next = cloneState(state);
  const target = next.decor.find((d) => d.id === id);
  if (!target) return { state: next, object: null };
  Object.assign(target, clampTransform({ ...target, ...transform }));
  next.savedAt = now;
  return { state: next, object: target };
}

// Storage adapter: 游客模式使用；账号级缓存见 web/storage.js。
export function createStorage(storage) {
  return {
    load() {
      const raw = storage.getItem(KEY);
      return raw ? validate(JSON.parse(raw)) : null;
    },
    save(state) {
      storage.setItem(KEY, JSON.stringify(state));
    }
  };
}
