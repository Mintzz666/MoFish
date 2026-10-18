// MoFish 视觉目录：鱼、水草、石头、沉木的类型与形态参数。
//
// 这里的数字同时被 3D（web/aquarium/*）与 2D 降级渲染（web/view2d.js）使用，
// 保证两种渲染器画的是「同一条鱼、同一株草」。
// 审美目标：清新、高级、自然、放松——低饱和、统一材质、克制的暖色点缀。
// 所有类型使用稳定字符串 id；旧存档里的数字 species 通过 LEGACY_SPECIES_MAP 映射。

/** 旧版 4 种 species 索引 → 新类型 id。顺序即语义，不能随意重排。 */
export const LEGACY_SPECIES_MAP = ['sunset', 'mint', 'moon', 'coral'];

/** 旧版配色（首版存档/2D 兼容用），新类型目录见 FISH_TYPES。 */
export const SPECIES = [
  { name: '落日金', color: '#eeac64', accent: '#e47851', typeId: 'sunset' },
  { name: '薄荷青', color: '#91cebc', accent: '#438c90', typeId: 'mint' },
  { name: '月光银', color: '#dae4de', accent: '#8ba9b1', typeId: 'moon' },
  { name: '珊瑚粉', color: '#eeb3ac', accent: '#be777f', typeId: 'coral' }
];

/**
 * 鱼型目录（9 种，成人轮廓差异明显）。
 * body.depth = 体高/体长；body.width = 体厚/体高；peduncle = 尾柄粗细。
 * fins.tail: fan 扇形 / fork 叉形 / veil 长裙 / round 圆尾 / spade 铲形 / lance 矛形。
 * motion: speed 巡游速度(体长/秒) / wag 摆尾幅度 / freq 摆动频率 / turn 转向速度 / depthBias 偏好水层。
 */
export const FISH_TYPES = [
  {
    id: 'sunset', name: '落日金', note: '圆润厚实，尾鳍像一小片薄纱',
    body: { len: 0.62, depth: 0.54, width: 0.52, head: 0.62, belly: 0.58, peduncle: 0.3, arch: 0.16 },
    fins: { tail: 'veil', tailSize: 0.46, dorsal: 'long', dorsalSize: 0.36, anal: 0.26, pectoral: 0.30, pelvic: 0.16, barbels: 0 },
    motion: { speed: 0.42, wag: 0.85, freq: 2.0, turn: 1.4, depthBias: 0.52, bob: 0.10 },
    palette: { hue: [34, 44], sat: [0.72, 0.86], light: [0.52, 0.61], accentHue: 24, accentSat: [0.56, 0.7], patterns: ['gradient', 'stripe'] }
  },
  {
    id: 'mint', name: '薄荷青', note: '细长轻快，喜欢在水流里穿来穿去',
    body: { len: 0.46, depth: 0.28, width: 0.38, head: 0.78, belly: 0.5, peduncle: 0.3, arch: 0.06 },
    fins: { tail: 'fork', tailSize: 0.36, dorsal: 'tri', dorsalSize: 0.20, anal: 0.14, pectoral: 0.18, pelvic: 0.10, barbels: 2 },
    motion: { speed: 1.0, wag: 0.55, freq: 4.2, turn: 3.0, depthBias: 0.64, bob: 0.05 },
    palette: { hue: [156, 174], sat: [0.54, 0.66], light: [0.52, 0.61], accentHue: 188, accentSat: [0.38, 0.5], patterns: ['stripe', 'plain', 'spot'] }
  },
  {
    id: 'moon', name: '月光银', note: '高身薄片，慢慢滑过水草上方',
    body: { len: 0.66, depth: 0.7, width: 0.32, head: 0.5, belly: 0.46, peduncle: 0.15, arch: 0.2 },
    fins: { tail: 'veil', tailSize: 0.42, dorsal: 'long', dorsalSize: 0.72, anal: 0.55, pectoral: 0.26, pelvic: 0.14, barbels: 2 },
    motion: { speed: 0.38, wag: 0.4, freq: 1.5, turn: 1.1, depthBias: 0.56, bob: 0.04 },
    palette: { hue: [188, 208], sat: [0.32, 0.42], light: [0.68, 0.75], accentHue: 212, accentSat: [0.16, 0.24], patterns: ['plain', 'band'] }
  },
  {
    id: 'coral', name: '珊瑚粉', note: '圆滚滚的小个子，尾巴一收一放',
    body: { len: 0.5, depth: 0.56, width: 0.46, head: 0.6, belly: 0.55, peduncle: 0.3, arch: 0.12 },
    fins: { tail: 'round', tailSize: 0.28, dorsal: 'tri', dorsalSize: 0.3, anal: 0.24, pectoral: 0.26, pelvic: 0.14, barbels: 0 },
    motion: { speed: 0.48, wag: 0.7, freq: 2.2, turn: 1.7, depthBias: 0.5, bob: 0.09 },
    palette: { hue: [8, 20], sat: [0.64, 0.78], light: [0.62, 0.69], accentHue: 344, accentSat: [0.4, 0.52], patterns: ['plain', 'gradient'] }
  },
  {
    id: 'ribbon', name: '缎带青', note: '一条柔软的丝带，顺着水草边缘游',
    body: { len: 0.92, depth: 0.16, width: 0.5, head: 0.86, belly: 0.5, peduncle: 0.42, arch: 0.02 },
    fins: { tail: 'lance', tailSize: 0.22, dorsal: 'ridge', dorsalSize: 0.1, anal: 'ridge', analSize: 0.08, pectoral: 0.1, pelvic: 0, barbels: 4 },
    motion: { speed: 0.6, wag: 1.2, freq: 1.5, turn: 1.9, depthBias: 0.3, bob: 0.03 },
    palette: { hue: [166, 186], sat: [0.56, 0.68], light: [0.42, 0.52], accentHue: 48, accentSat: [0.42, 0.54], patterns: ['stripe', 'plain'] }
  },
  {
    id: 'puff', name: '团子', note: '圆球一样浮着，偶尔扇两下小翅膀',
    body: { len: 0.4, depth: 0.78, width: 0.66, head: 0.66, belly: 0.6, peduncle: 0.26, arch: 0.1 },
    fins: { tail: 'fan', tailSize: 0.24, dorsal: 'small', dorsalSize: 0.14, anal: 0.12, pectoral: 0.24, pelvic: 0.08, barbels: 0 },
    motion: { speed: 0.34, wag: 0.45, freq: 2.6, turn: 1.3, depthBias: 0.6, bob: 0.2 },
    palette: { hue: [44, 58], sat: [0.60, 0.72], light: [0.57, 0.65], accentHue: 34, accentSat: [0.4, 0.52], patterns: ['spot', 'plain'] }
  },
  {
    id: 'fan', name: '罗扇', note: '高高的圆盘身形，转身像展开一把扇子',
    body: { len: 0.64, depth: 0.94, width: 0.3, head: 0.52, belly: 0.44, peduncle: 0.12, arch: 0.24 },
    fins: { tail: 'fan', tailSize: 0.34, dorsal: 'long', dorsalSize: 0.5, anal: 0.46, pectoral: 0.24, pelvic: 0.12, barbels: 0 },
    motion: { speed: 0.3, wag: 0.35, freq: 1.2, turn: 0.9, depthBias: 0.48, bob: 0.05 },
    palette: { hue: [22, 34], sat: [0.66, 0.78], light: [0.50, 0.60], accentHue: 12, accentSat: [0.46, 0.58], patterns: ['band', 'stripe'] }
  },
  {
    id: 'dart', name: '飞梭', note: '流线型的快枪手，转弯也干净利落',
    body: { len: 0.44, depth: 0.3, width: 0.4, head: 0.74, belly: 0.5, peduncle: 0.3, arch: 0.05 },
    fins: { tail: 'fork', tailSize: 0.44, dorsal: 'tri', dorsalSize: 0.22, anal: 0.16, pectoral: 0.2, pelvic: 0.1, barbels: 0 },
    motion: { speed: 1.2, wag: 0.5, freq: 5.0, turn: 3.6, depthBias: 0.68, bob: 0.04 },
    palette: { hue: [194, 214], sat: [0.62, 0.76], light: [0.47, 0.57], accentHue: 26, accentSat: [0.46, 0.6], patterns: ['stripe', 'spot'] }
  },
  {
    id: 'whisker', name: '须影', note: '贴着沙面巡游，嘴边有几根细细的须',
    body: { len: 0.56, depth: 0.22, width: 0.55, head: 0.72, belly: 0.62, peduncle: 0.26, arch: 0.04 },
    fins: { tail: 'fork', tailSize: 0.3, dorsal: 'tri', dorsalSize: 0.18, anal: 0.14, pectoral: 0.2, pelvic: 0.12, barbels: 4 },
    motion: { speed: 0.36, wag: 0.5, freq: 2.0, turn: 1.5, depthBias: 0.12, bob: 0.02 },
    palette: { hue: [28, 42], sat: [0.48, 0.60], light: [0.43, 0.53], accentHue: 24, accentSat: [0.32, 0.44], patterns: ['spot', 'saddle'] }
  }
];

export const FISH_TYPE_BY_ID = Object.fromEntries(FISH_TYPES.map(t => [t.id, t]));

/** 旧数字 species 或新字符串 id 都归一到稳定类型 id。未知值回落到 sunset。 */
export function normalizeSpeciesId(value) {
  if (typeof value === 'string' && FISH_TYPE_BY_ID[value]) return value;
  if (Number.isInteger(value) && value >= 0 && value < LEGACY_SPECIES_MAP.length) return LEGACY_SPECIES_MAP[value];
  return LEGACY_SPECIES_MAP[0];
}

/**
 * 水草目录（6 类），高度为鱼缸世界单位，与成鱼体长同一尺度。
 * shape 决定几何生成方式：blade 细长叶 / rosette 莲座宽叶 / stem 茎生小叶 / moss 团簇 / fern 羽状复叶 / carpet 针叶地毯。
 */
export const PLANT_TYPES = [
  {
    id: 'vallis', name: '细叶苦草', shape: 'blade',
    params: { blades: [14, 22], height: [0.78, 1.22], width: [0.038, 0.058], bend: [0.1, 0.36], spread: [0.07, 0.16] },
    palette: { hue: [148, 166], sat: [0.46, 0.58], light: [0.30, 0.37] }
  },
  {
    id: 'anubias', name: '小榕', shape: 'rosette',
    params: { leaves: [6, 9], height: [0.24, 0.4], width: [0.1, 0.15], bend: [0.28, 0.56], spread: [0.07, 0.16] },
    palette: { hue: [138, 156], sat: [0.48, 0.60], light: [0.30, 0.34] }
  },
  {
    id: 'rotala', name: '红松尾', shape: 'stem',
    params: { stems: [4, 7], height: [0.5, 0.82], leaves: [12, 20], width: [0.032, 0.05], bend: [0.05, 0.2], spread: [0.05, 0.12] },
    palette: { hue: [4, 22], sat: [0.46, 0.60], light: [0.30, 0.34] }
  },
  {
    id: 'moss', name: '苔球', shape: 'moss',
    params: { blobs: [4, 7], height: [0.12, 0.24], width: [0.09, 0.15], bend: [0, 0], spread: [0.05, 0.12] },
    palette: { hue: [86, 110], sat: [0.46, 0.56], light: [0.30, 0.34] }
  },
  {
    id: 'fern', name: '铁皇冠', shape: 'fern',
    params: { fronds: [7, 11], height: [0.38, 0.6], leaves: [8, 12], width: [0.06, 0.09], bend: [0.3, 0.62], spread: [0.06, 0.14] },
    palette: { hue: [142, 158], sat: [0.44, 0.54], light: [0.30, 0.34] }
  },
  {
    id: 'carpet', name: '牛毛毡', shape: 'carpet',
    params: { needles: [44, 74], height: [0.09, 0.17], width: [0.009, 0.014], bend: [0.1, 0.3], spread: [0.26, 0.46] },
    palette: { hue: [104, 126], sat: [0.50, 0.62], light: [0.30, 0.34] }
  }
];

export const PLANT_TYPE_BY_ID = Object.fromEntries(PLANT_TYPES.map(t => [t.id, t]));

/** 石头目录（5 类）：轮廓、表面结构与材质各不相同。 */
export const ROCK_TYPES = [
  {
    id: 'seiryu', name: '青龙石', shape: 'ridged',
    params: { size: [0.34, 0.65], height: [0.8, 1.4], rough: [0.18, 0.34], detail: [2, 4] },
    palette: { hue: [202, 218], sat: [0.29, 0.35], light: [0.30, 0.34] }
  },
  {
    id: 'lava', name: '火山岩', shape: 'porous',
    params: { size: [0.21, 0.42], height: [0.7, 1.1], rough: [0.3, 0.5], detail: [3, 6] },
    palette: { hue: [14, 28], sat: [0.32, 0.40], light: [0.30, 0.34] }
  },
  {
    id: 'pebble', name: '溪卵石', shape: 'smooth',
    params: { size: [0.16, 0.34], height: [0.45, 0.72], rough: [0.06, 0.14], detail: [1, 2] },
    palette: { hue: [34, 50], sat: [0.27, 0.33], light: [0.30, 0.37] }
  },
  {
    id: 'slate', name: '板岩', shape: 'layered',
    params: { size: [0.31, 0.57], height: [0.5, 0.9], rough: [0.16, 0.3], detail: [3, 5] },
    palette: { hue: [210, 228], sat: [0.27, 0.33], light: [0.30, 0.34] }
  },
  {
    id: 'sandstone', name: '砂岩', shape: 'blocky',
    params: { size: [0.26, 0.55], height: [0.55, 0.95], rough: [0.22, 0.38], detail: [2, 4] },
    palette: { hue: [36, 48], sat: [0.38, 0.48], light: [0.30, 0.39] }
  }
];

export const ROCK_TYPE_BY_ID = Object.fromEntries(ROCK_TYPES.map(t => [t.id, t]));

/** 沉木目录（2 类）。 */
export const WOOD_TYPES = [
  {
    id: 'branch', name: '沉木枝', shape: 'branch',
    params: { length: [0.5, 0.86], girth: [0.035, 0.055], branches: [2, 4], height: [0.3, 0.62] },
    palette: { hue: [24, 38], sat: [0.38, 0.48], light: [0.30, 0.34] }
  },
  {
    id: 'stump', name: '沉木桩', shape: 'stump',
    params: { length: [0.26, 0.42], girth: [0.08, 0.13], branches: [3, 5], height: [0.28, 0.46] },
    palette: { hue: [22, 34], sat: [0.34, 0.42], light: [0.30, 0.34] }
  }
];

export const WOOD_TYPE_BY_ID = Object.fromEntries(WOOD_TYPES.map(t => [t.id, t]));

export const DECOR_KINDS = {
  plant: { name: '水草', types: PLANT_TYPES, max: 14 },
  rock: { name: '石头', types: ROCK_TYPES, max: 10 },
  wood: { name: '沉木', types: WOOD_TYPES, max: 6 }
};

export const DECOR_MAX = 24;

/** 取某类造景的类型定义；未知类型返回该类的第一个，避免坏存档让渲染崩溃。 */
export function decorType(kind, typeId) {
  const bucket = DECOR_KINDS[kind];
  if (!bucket) return null;
  return bucket.types.find(t => t.id === typeId) || bucket.types[0];
}

/** 旧 plants 数量迁移时使用的位置（与首版 2D 布局一致，保持视觉连续）。 */
export const LEGACY_PLANT_X = [0.06, 0.88, 0.96, 0.15, 0.76, 0.28, 0.64, 0.4];
export const LEGACY_PLANT_TYPES = ['vallis', 'anubias', 'rotala', 'moss', 'fern', 'carpet'];
