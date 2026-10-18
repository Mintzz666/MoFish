// 程序化造景：水草（6 类）、石头（5 类）、沉木（2 类）。
//
// 每个对象的外观都由持久 seed 派生（见 model.decorAppearance），几何在创建时生成一次，
// 水草/沉木的摆动只靠顶点着色器，不逐帧改几何。
import * as THREE from 'three';

const TAU = Math.PI * 2;
const clamp = (n, a, b) => Math.min(b, Math.max(a, n));

/** 平滑的伪噪声：确定性、无需贴图，用来做石头表面的起伏与层理。 */
function noise3(x, y, z) {
  return (
    Math.sin(x * 1.7 + y * 2.3 + z * 1.1) * 0.5 +
    Math.sin(x * 3.1 - y * 1.3 + z * 2.7) * 0.28 +
    Math.sin(x * 5.3 + y * 4.1 - z * 3.3) * 0.16
  );
}

function mulberry32(seed) {
  let a = (seed >>> 0) || 1;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ------------------------------------------------------------------ 水草

/** 一条从根部向上弯曲的叶片：返回带 aSway 的条带几何。 */
function bladeStrip({ height, width, bend, segments = 7, lean = 0, twist = 0 }) {
  const positions = [];
  const sway = [];
  const indices = [];
  for (let i = 0; i <= segments; i += 1) {
    const t = i / segments;
    const y = height * t;
    const curve = bend * Math.pow(t, 1.7) * height;
    const x = curve + lean * t;
    const z = twist * Math.sin(t * Math.PI) * 0.2;
    const w = width * (1 - 0.82 * Math.pow(t, 1.5)) * (0.55 + 0.45 * Math.sin(Math.PI * Math.min(1, t * 2.4)));
    // 叶片是薄片：两列顶点，横向轻微弯曲让受光有层次
    positions.push(x - w, y, z + w * 0.25, x + w, y, z - w * 0.25);
    sway.push(Math.pow(t, 1.6), Math.pow(t, 1.6));
  }
  for (let i = 0; i < segments; i += 1) {
    const a = i * 2;
    indices.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('aSway', new THREE.Float32BufferAttribute(sway, 1));
  geo.setIndex(indices);
  geo.computeVertexNormals();
  return geo;
}

function mergeSimple(list, attrs = ['position', 'normal', 'aSway']) {
  const out = new THREE.BufferGeometry();
  const total = list.reduce((sum, g) => sum + g.getAttribute('position').count, 0);
  const indexTotal = list.reduce((sum, g) => sum + (g.getIndex()?.count ?? g.getAttribute('position').count), 0);
  const buffers = {};
  for (const name of attrs) {
    const size = name === 'position' || name === 'normal' ? 3 : 1;
    buffers[name] = new Float32Array(total * size);
  }
  const indices = new Uint32Array(indexTotal);
  let vOff = 0;
  let iOff = 0;
  for (const geo of list) {
    const count = geo.getAttribute('position').count;
    for (const name of attrs) {
      const attr = geo.getAttribute(name);
      if (!attr) continue;
      buffers[name].set(attr.array.subarray(0, count * attr.itemSize), vOff * attr.itemSize);
    }
    const idx = geo.getIndex();
    if (idx) {
      for (let i = 0; i < idx.count; i += 1) indices[iOff + i] = idx.getX(i) + vOff;
      iOff += idx.count;
    } else {
      for (let i = 0; i < count; i += 1) indices[iOff + i] = vOff + i;
      iOff += count;
    }
    vOff += count;
  }
  for (const name of attrs) {
    const size = name === 'position' || name === 'normal' ? 3 : 1;
    out.setAttribute(name, new THREE.Float32BufferAttribute(buffers[name], size));
  }
  out.setIndex(new THREE.BufferAttribute(indices, 1));
  return out;
}

function buildBladePlant(p, seed, quality) {
  const rnd = mulberry32(seed);
  const blades = Math.round(p.blades);
  const parts = [];
  for (let i = 0; i < blades; i += 1) {
    const angle = rnd() * TAU;
    const radius = p.spread * Math.sqrt(rnd());
    const h = p.height * (0.6 + rnd() * 0.55);
    const geo = bladeStrip({
      height: h,
      width: p.width * (0.8 + rnd() * 0.4),
      bend: p.bend * (0.5 + rnd()),
      segments: quality === 'high' ? 7 : 5,
      lean: (rnd() - 0.5) * 0.06,
      twist: (rnd() - 0.5) * 0.4
    });
    geo.rotateY(angle);
    geo.translate(Math.cos(angle) * radius, 0, Math.sin(angle) * radius);
    parts.push(geo);
  }
  return mergeSimple(parts);
}

function buildRosettePlant(p, seed, quality) {
  const rnd = mulberry32(seed);
  const leaves = Math.round(p.leaves);
  const parts = [];
  for (let i = 0; i < leaves; i += 1) {
    const angle = (i / leaves) * TAU + rnd() * 0.3;
    const geo = bladeStrip({
      height: p.height * (0.75 + rnd() * 0.4),
      width: p.width * (0.7 + rnd() * 0.5),
      bend: p.bend * (0.4 + rnd() * 0.6),
      segments: quality === 'high' ? 6 : 4,
      lean: 0.04 + rnd() * 0.04
    });
    geo.rotateZ((rnd() - 0.5) * 0.2);
    geo.rotateY(angle);
    geo.translate(Math.cos(angle) * p.spread * 0.25, 0, Math.sin(angle) * p.spread * 0.25);
    parts.push(geo);
  }
  return mergeSimple(parts);
}

function buildStemPlant(p, seed, quality) {
  const rnd = mulberry32(seed);
  const stems = Math.max(1, Math.round(p.stems));
  const parts = [];
  for (let s = 0; s < stems; s += 1) {
    const angle = (s / stems) * TAU + rnd();
    const radius = p.spread * Math.sqrt(rnd());
    const bx = Math.cos(angle) * radius;
    const bz = Math.sin(angle) * radius;
    const h = p.height * (0.65 + rnd() * 0.5);
    parts.push(bladeStrip({ height: h, width: p.width * 0.5, bend: p.bend, segments: 4, lean: 0 })
      .translate(bx, 0, bz));
    const pairs = Math.round(p.leaves * (quality === 'high' ? 1 : 0.6));
    for (let i = 1; i <= pairs; i += 1) {
      const t = i / (pairs + 1);
      const y = h * t;
      const leafLen = p.width * 3.4 * (1 - 0.45 * t);
      for (const side of [-1, 1]) {
        const leaf = bladeStrip({ height: leafLen, width: p.width * 0.7, bend: 0.12, segments: 2 });
        leaf.rotateZ(side * 1.15);
        leaf.rotateY(angle + side * 0.7 + t * 2.4);
        leaf.translate(bx + Math.cos(angle) * p.bend * t * 0.2, y, bz + Math.sin(angle) * p.bend * t * 0.2);
        parts.push(leaf);
      }
    }
  }
  return mergeSimple(parts);
}

function buildMossPlant(p, seed, quality) {
  const rnd = mulberry32(seed);
  const blobs = Math.max(1, Math.round(p.blobs));
  const parts = [];
  for (let i = 0; i < blobs; i += 1) {
    const radius = p.width * (0.55 + rnd() * 0.6);
    const geo = new THREE.IcosahedronGeometry(radius, quality === 'high' ? 2 : 1);
    const pos = geo.getAttribute('position');
    for (let v = 0; v < pos.count; v += 1) {
      const x = pos.getX(v);
      const y = pos.getY(v);
      const z = pos.getZ(v);
      const n = noise3(x * 14 + i, y * 14, z * 14) * radius * 0.22;
      pos.setXYZ(v, x + n, y * 0.72 + n, z + n);
    }
    geo.computeVertexNormals();
    geo.setAttribute('aSway', new THREE.Float32BufferAttribute(new Array(pos.count).fill(0.08), 1));
    const angle = rnd() * TAU;
    const spread = p.spread * Math.sqrt(rnd());
    geo.translate(Math.cos(angle) * spread, radius * 0.55 + p.height * rnd() * 0.4, Math.sin(angle) * spread);
    parts.push(geo);
  }
  return mergeSimple(parts);
}

function buildFernPlant(p, seed, quality) {
  const rnd = mulberry32(seed);
  const fronds = Math.round(p.fronds);
  const parts = [];
  for (let f = 0; f < fronds; f += 1) {
    const angle = (f / fronds) * TAU + rnd() * 0.4;
    const h = p.height * (0.7 + rnd() * 0.5);
    const spine = bladeStrip({ height: h, width: p.width * 0.18, bend: p.bend * 1.2, segments: quality === 'high' ? 6 : 4 })
      .rotateZ(0.35 + rnd() * 0.2);
    spine.rotateY(angle);
    spine.translate(Math.cos(angle) * p.spread * 0.2, 0, Math.sin(angle) * p.spread * 0.2);
    parts.push(spine);
    const leaflets = Math.round(p.leaves * (quality === 'high' ? 1 : 0.7));
    for (let i = 2; i <= leaflets; i += 1) {
      const t = i / (leaflets + 1);
      const y = h * t * 0.92;
      const len = p.width * 3.2 * (1 - 0.6 * t);
      for (const side of [-1, 1]) {
        const leaf = bladeStrip({ height: len, width: p.width * 0.55, bend: 0.2, segments: 2 });
        leaf.rotateZ(side * (1.1 + t * 0.2));
        leaf.rotateY(angle + side * 0.5);
        leaf.translate(Math.cos(angle) * (p.spread * 0.2 + p.bend * h * t * 0.4), y, Math.sin(angle) * (p.spread * 0.2 + p.bend * h * t * 0.4));
        parts.push(leaf);
      }
    }
  }
  return mergeSimple(parts);
}

function buildCarpetPlant(p, seed, quality) {
  const rnd = mulberry32(seed);
  const needles = Math.max(8, Math.round(p.needles * (quality === 'high' ? 1 : 0.55)));
  const parts = [];
  for (let i = 0; i < needles; i += 1) {
    const angle = rnd() * TAU;
    const radius = p.spread * Math.sqrt(rnd());
    const geo = bladeStrip({
      height: p.height * (0.5 + rnd() * 0.8),
      width: p.width,
      bend: p.bend * (0.4 + rnd()),
      segments: 3,
      lean: (rnd() - 0.5) * 0.08
    });
    geo.rotateY(angle);
    geo.translate(Math.cos(angle) * radius, 0, Math.sin(angle) * radius);
    parts.push(geo);
  }
  return mergeSimple(parts);
}

export function buildPlantGeometry(appearance, quality = 'high') {
  const p = appearance.params;
  const seed = (appearance.seed ?? 1) >>> 0;
  switch (appearance.shape) {
    case 'rosette': return buildRosettePlant(p, seed, quality);
    case 'stem': return buildStemPlant(p, seed, quality);
    case 'moss': return buildMossPlant(p, seed, quality);
    case 'fern': return buildFernPlant(p, seed, quality);
    case 'carpet': return buildCarpetPlant(p, seed, quality);
    default: return buildBladePlant(p, seed, quality);
  }
}

// ------------------------------------------------------------------ 石头

function deformRock(geo, { rough, detail, seed, squashY = 1, blocky = 0 }) {
  const rnd = mulberry32(seed);
  const offset = rnd() * 100;
  const pos = geo.getAttribute('position');
  for (let i = 0; i < pos.count; i += 1) {
    let x = pos.getX(i);
    let y = pos.getY(i);
    let z = pos.getZ(i);
    const n = noise3(x * (2 + detail) + offset, y * (2 + detail), z * (2 + detail));
    const n2 = noise3(x * (7 + detail * 2) - offset, y * (7 + detail * 2), z * (7 + detail * 2));
    const scale = 1 + (n * 0.6 + n2 * 0.4) * rough;
    x *= scale;
    z *= scale;
    y *= scale * squashY;
    if (blocky > 0) {
      // 让轮廓更「方」：把半径往最大轴推一点
      const m = Math.max(Math.abs(x), Math.abs(z));
      x += (Math.sign(x) * m - x) * blocky;
      z += (Math.sign(z) * m - z) * blocky;
    }
    pos.setXYZ(i, x, y, z);
  }
  geo.computeVertexNormals();
  return geo;
}

export function buildRockGeometry(appearance, quality = 'high') {
  const p = appearance.params;
  const seed = (appearance.seed ?? 1) >>> 0;
  const detail = quality === 'high' ? 3 : 2;
  const size = p.size;
  const height = p.height;
  const parts = [];
  if (appearance.shape === 'layered') {
    const layers = Math.max(2, Math.round(p.detail));
    const totalH = size * height * 1.35;
    for (let i = 0; i < layers; i += 1) {
      const rnd = mulberry32(seed + i * 97);
      const w = size * (0.8 + rnd() * 0.5) * (1 - i * 0.1);
      const d = w * (0.5 + rnd() * 0.4);
      const h = (totalH / layers) * (0.75 + rnd() * 0.5);
      const geo = new THREE.BoxGeometry(w, h, d, 2, 1, 2);
      const pos = geo.getAttribute('position');
      for (let v = 0; v < pos.count; v += 1) {
        pos.setX(v, pos.getX(v) + (rnd() - 0.5) * w * 0.18);
        pos.setZ(v, pos.getZ(v) + (rnd() - 0.5) * d * 0.18);
      }
      geo.computeVertexNormals();
      geo.rotateY(rnd() * TAU * 0.2);
      geo.rotateZ((rnd() - 0.5) * 0.12);
      geo.translate((rnd() - 0.5) * size * 0.2, h / 2 + (i * totalH) / layers, (rnd() - 0.5) * size * 0.2);
      parts.push(geo);
    }
    return mergeRocks(parts);
  }
  const shapeDetail = appearance.shape === 'ridged' ? (quality === 'high' ? 2 : 1) : detail;
  const geo = new THREE.IcosahedronGeometry(size, shapeDetail);
  deformRock(geo, {
    rough: p.rough,
    detail: p.detail,
    seed,
    squashY: height,
    blocky: appearance.shape === 'blocky' ? 0.28 : appearance.shape === 'ridged' ? 0.34 : 0
  });
  // 底部压平，石头坐在沙面上而不是陷进去
  const pos = geo.getAttribute('position');
  let minY = Infinity;
  for (let i = 0; i < pos.count; i += 1) minY = Math.min(minY, pos.getY(i));
  for (let i = 0; i < pos.count; i += 1) {
    if (pos.getY(i) < minY + size * 0.16) pos.setY(i, minY);
  }
  geo.translate(0, -minY, 0);
  const flat = appearance.shape === 'smooth' ? false : true;
  if (flat) geo.computeVertexNormals();
  parts.push(geo);
  return mergeRocks(parts);
}

function mergeRocks(list) {
  const merged = mergeSimpleRocks(list);
  return merged;
}

function mergeSimpleRocks(list) {
  // 岩石不需要 aSway，合并后重新计算法线（flat shading 由材质 flatShading 决定）。
  const out = new THREE.BufferGeometry();
  const total = list.reduce((s, g) => s + g.getAttribute('position').count, 0);
  const indexTotal = list.reduce((s, g) => s + (g.getIndex()?.count ?? g.getAttribute('position').count), 0);
  const positions = new Float32Array(total * 3);
  const normals = new Float32Array(total * 3);
  const indices = new Uint32Array(indexTotal);
  let vOff = 0;
  let iOff = 0;
  for (const geo of list) {
    const count = geo.getAttribute('position').count;
    positions.set(geo.getAttribute('position').array.subarray(0, count * 3), vOff * 3);
    normals.set(geo.getAttribute('normal').array.subarray(0, count * 3), vOff * 3);
    const idx = geo.getIndex();
    if (idx) {
      for (let i = 0; i < idx.count; i += 1) indices[iOff + i] = idx.getX(i) + vOff;
      iOff += idx.count;
    } else {
      for (let i = 0; i < count; i += 1) indices[iOff + i] = vOff + i;
      iOff += count;
    }
    vOff += count;
  }
  out.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  out.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  out.setIndex(new THREE.BufferAttribute(indices.slice(0, iOff), 1));
  out.computeVertexNormals();
  return out;
}

// ------------------------------------------------------------------ 沉木

function tubeAlong(points, radius, radialSegments) {
  const curve = new THREE.CatmullRomCurve3(points);
  return new THREE.TubeGeometry(curve, Math.max(6, points.length * 4), radius, radialSegments, false);
}

export function buildWoodGeometry(appearance, quality = 'high') {
  const p = appearance.params;
  const rnd = mulberry32((appearance.seed ?? 1) >>> 0);
  const radial = quality === 'high' ? 7 : 5;
  const length = p.length;
  const girth = p.girth;
  const height = p.height;
  const parts = [];
  const trunk = [];
  const lean = (rnd() - 0.5) * 0.35;
  for (let i = 0; i <= 4; i += 1) {
    const t = i / 4;
    trunk.push(new THREE.Vector3(
      (t - 0.5) * length,
      height * (0.12 + Math.sin(t * Math.PI) * 0.45) * (appearance.shape === 'stump' ? 0.9 : 1),
      Math.sin(t * 2.2 + rnd()) * 0.05 + lean * t
    ));
  }
  parts.push(tubeAlong(trunk, girth, radial));
  const branches = Math.max(1, Math.round(p.branches));
  for (let b = 0; b < branches; b += 1) {
    const t = 0.25 + rnd() * 0.55;
    const base = trunk[Math.min(trunk.length - 1, Math.round(t * 4))];
    const dir = rnd() > 0.5 ? 1 : -1;
    const len = length * (0.25 + rnd() * 0.35);
    const pts = [
      base.clone(),
      base.clone().add(new THREE.Vector3(dir * len * 0.4, len * (0.25 + rnd() * 0.3), (rnd() - 0.5) * len * 0.3)),
      base.clone().add(new THREE.Vector3(dir * len * 0.75, len * (0.4 + rnd() * 0.45), (rnd() - 0.5) * len * 0.45))
    ];
    parts.push(tubeAlong(pts, girth * (0.35 + rnd() * 0.3), Math.max(4, radial - 2)));
  }
  if (appearance.shape === 'stump') {
    // 根盘：向外散开的短根，让木桩坐得稳
    const roots = 5;
    for (let r = 0; r < roots; r += 1) {
      const angle = (r / roots) * TAU + rnd() * 0.4;
      const len = length * (0.3 + rnd() * 0.25);
      const start = new THREE.Vector3(0, height * 0.1, 0);
      const pts = [
        start,
        start.clone().add(new THREE.Vector3(Math.cos(angle) * len * 0.5, -height * 0.02, Math.sin(angle) * len * 0.5)),
        start.clone().add(new THREE.Vector3(Math.cos(angle) * len, 0.005, Math.sin(angle) * len))
      ];
      parts.push(tubeAlong(pts, girth * 0.3, Math.max(4, radial - 3)));
    }
  }
  const merged = mergeSimpleRocks(parts);
  merged.computeVertexNormals();
  return merged;
}

// ------------------------------------------------------------------ 材质与网格

function injectSway(material, uniforms) {
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>
        uniform float uTime;
        uniform float uPhase;
        uniform float uSwayAmp;
        uniform float uSwayFreq;
        attribute float aSway;`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        float mofishSwayT = uTime * uSwayFreq + uPhase;
        float mofishSway = sin(mofishSwayT) * 0.65 + sin(mofishSwayT * 1.7 + 1.3) * 0.35;
        transformed.x += mofishSway * aSway * aSway * uSwayAmp;
        transformed.z += cos(mofishSwayT * 0.8) * aSway * aSway * uSwayAmp * 0.55;`);
  };
  material.customProgramCacheKey = () => 'mofish-decor-sway';
}

export function makeDecorMaterial(appearance, { sway = false, quality = 'high' } = {}) {
  const flat = ['ridged', 'porous', 'layered', 'blocky', 'branch', 'stump'].includes(appearance.shape);
  const mat = new THREE.MeshStandardMaterial({
    color: appearance.color,
    roughness: appearance.kind === 'rock' ? 0.92 : appearance.kind === 'wood' ? 0.86 : 0.62,
    metalness: 0.0,
    flatShading: flat && appearance.kind === 'rock',
    side: appearance.kind === 'plant' ? THREE.DoubleSide : THREE.FrontSide
  });
  mat.userData.uniforms = null;
  if (sway) {
    const uniforms = {
      uTime: { value: 0 },
      uPhase: { value: (appearance.seed % 1000) / 1000 * Math.PI * 2 },
      uSwayAmp: { value: appearance.kind === 'plant' ? 0.055 : 0.012 },
      uSwayFreq: { value: appearance.kind === 'plant' ? 0.55 : 0.28 }
    };
    injectSway(mat, uniforms);
    mat.userData.uniforms = uniforms;
    mat.customProgramCacheKey = () => 'mofish-decor-sway';
  }
  return mat;
}

/**
 * 创建造景网格。返回 THREE.Group：root 里含主网格 + 可选的接触阴影。
 * 位置/旋转/缩放由调用方按存档里的归一化坐标设置（见 view3d.js）。
 */
export function createDecorMesh(appearance, { quality = 'high' } = {}) {
  let geometry;
  if (appearance.kind === 'plant') geometry = buildPlantGeometry(appearance, quality);
  else if (appearance.kind === 'rock') geometry = buildRockGeometry(appearance, quality);
  else geometry = buildWoodGeometry(appearance, quality);

  const material = makeDecorMaterial(appearance, { sway: appearance.kind !== 'rock', quality });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.castShadow = quality === 'high' && appearance.kind !== 'plant';
  mesh.receiveShadow = quality === 'high';
  const group = new THREE.Group();
  group.add(mesh);
  group.userData = { appearance, geometry, material, mesh };
  return group;
}

export function disposeDecor(group) {
  if (!group) return;
  const data = group.userData || {};
  data.geometry?.dispose?.();
  data.material?.dispose?.();
  data.mesh?.geometry?.dispose?.();
  group.clear();
}

/** 沉木/石头摆到沙面上时，几何原点已经在底部中心，直接放到 y=0。 */
export function decorGroundOffset(appearance) {
  return 0;
}

export { clamp, mulberry32, noise3 };
