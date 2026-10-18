// 体素造景：水草 / 石头 / 沉木，统一用方块拼出来（Minecraft 风格，与体素鱼同一套画风）。
//
// 约定：
//   * 所有几何都用 0.045 世界单位的方块网格生成，只输出暴露面；
//   * 顶点色整块着色 + 面明暗，材质统一开 vertexColors；
//   * 水草的 aSway 属性按高度递增，沿用既有的摆动着色器（整株柔和摆动，但骨子里是方块）。
import * as THREE from 'three';
import { meshVoxels } from './fish.js';

const DV = 0.045;          // 造景体素边长

export const clamp = (n, a, b) => Math.min(b, Math.max(a, n));

/** 确定性伪随机（同一 seed 永远同一株草/同一块石头）。 */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function random() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function noise3(x, y, z) {
  const s = Math.sin(x * 12.9898 + y * 78.233 + z * 37.719) * 43758.5453;
  return s - Math.floor(s);
}

function shade(colorHex, factor) {
  return new THREE.Color(colorHex).multiplyScalar(factor);
}

// ------------------------------------------------------------------ 水草

function plantVoxels(appearance) {
  const { typeId, params, color, highlight, shade: dark } = appearance;
  const rnd = mulberry32(appearance.seed);
  const voxels = [];
  const H = Math.max(4, Math.round((params.height || 0.6) / DV));
  const pick = (t) => (rnd() < t ? highlight : rnd() < 0.25 ? dark : color);

  switch (typeId) {
    case 'vallis': {
      // 细长带状叶：每条叶一列方块，向上轻微倾斜
      const blades = Math.round(params.blades || 9);
      for (let b = 0; b < blades; b += 1) {
        const bx = Math.round((rnd() - 0.5) * (params.spread || 0.08) / DV * 2);
        const bz = Math.round((rnd() - 0.5) * (params.spread || 0.08) / DV * 2);
        const h = Math.max(3, Math.round(H * (0.55 + rnd() * 0.5)));
        const lean = (rnd() - 0.5) * 0.9;
        for (let y = 0; y < h; y += 1) {
          const x = bx + Math.round((y / h) * lean * 2);
          voxels.push({ x, y, z: bz, color: shade(pick(0.3), 0.85 + (y / h) * 0.3) });
        }
      }
      break;
    }
    case 'anubias': {
      // 低矮莲座：宽叶从中心放射
      const leaves = Math.round(params.leaves || 7);
      for (let l = 0; l < leaves; l += 1) {
        const ang = (l / leaves) * Math.PI * 2 + rnd() * 0.4;
        const len = Math.round((params.width || 0.1) / DV * (2 + rnd() * 1.2));
        const y = Math.round(H * 0.25);
        for (let k = 1; k <= len; k += 1) {
          const x = Math.round(Math.cos(ang) * k);
          const z = Math.round(Math.sin(ang) * k);
          voxels.push({ x, y, z, color: pick(0.35) });
          if (k > 1 && rnd() < 0.5) voxels.push({ x, y: y + 1, z, color: pick(0.35) });
        }
      }
      break;
    }
    case 'rotala': {
      // 多茎 + 对生小叶，顶端提亮
      const stems = Math.round(params.stems || 6);
      for (let s = 0; s < stems; s += 1) {
        const bx = Math.round((rnd() - 0.5) * 5);
        const bz = Math.round((rnd() - 0.5) * 5);
        const h = Math.max(4, Math.round(H * (0.5 + rnd() * 0.55)));
        for (let y = 0; y < h; y += 1) {
          const x = bx + Math.round(Math.sin(y * 0.5 + s) * 0.6);
          voxels.push({ x, y, z: bz, color: shade(color, 0.9 + y / h * 0.2) });
          if (y % 2 === 0) {
            voxels.push({ x: x + 1, y, z: bz, color: shade(highlight, 0.9 + y / h * 0.25) });
            voxels.push({ x: x - 1, y, z: bz, color: shade(color, 0.85) });
          }
        }
      }
      break;
    }
    case 'moss': {
      // 苔球：几个方块团
      const blobs = Math.round(params.blobs || 5);
      for (let b = 0; b < blobs; b += 1) {
        const cx = Math.round((rnd() - 0.5) * 6);
        const cz = Math.round((rnd() - 0.5) * 6);
        const cy = Math.round(rnd() * 2);
        const r = 1 + Math.round(rnd() * 1.4);
        for (let x = -r; x <= r; x += 1) {
          for (let y = 0; y <= r; y += 1) {
            for (let z = -r; z <= r; z += 1) {
              if (x * x + y * y * 1.6 + z * z > r * r) continue;
              voxels.push({ x: cx + x, y: cy + y, z: cz + z, color: pick(0.3) });
            }
          }
        }
      }
      break;
    }
    case 'fern': {
      // 羽状复叶：中轴 + 两侧小叶片
      const fronds = Math.round(params.fronds || 8);
      for (let f = 0; f < fronds; f += 1) {
        const ang = (f / fronds) * Math.PI * 2 + rnd() * 0.3;
        const len = Math.round(H * (0.45 + rnd() * 0.35));
        for (let k = 1; k <= len; k += 1) {
          const x = Math.round(Math.cos(ang) * k * 0.8);
          const z = Math.round(Math.sin(ang) * k * 0.8);
          const y = Math.round(k * 0.8);
          voxels.push({ x, y, z, color: shade(color, 0.9 + (k / len) * 0.2) });
          if (k % 2 === 0 && k < len - 1) {
            voxels.push({ x: x + Math.round(Math.cos(ang + 1.4)), y, z: z + Math.round(Math.sin(ang + 1.4)), color: pick(0.3) });
            voxels.push({ x: x + Math.round(Math.cos(ang - 1.4)), y, z: z + Math.round(Math.sin(ang - 1.4)), color: pick(0.3) });
          }
        }
      }
      break;
    }
    case 'carpet':
    default: {
      // 地毯草：密集短针叶
      const needles = Math.round(params.needles || 48);
      for (let n = 0; n < needles; n += 1) {
        const x = Math.round((rnd() - 0.5) * 16);
        const z = Math.round((rnd() - 0.5) * 16);
        const h = 1 + Math.round(rnd() * 2);
        for (let y = 0; y < h; y += 1) voxels.push({ x, y, z, color: shade(pick(0.25), 0.9 + y * 0.08) });
      }
      break;
    }
  }
  const maxY = Math.max(1, ...voxels.map((v) => v.y));
  return { voxels, maxY };
}

// ------------------------------------------------------------------ 石头

function rockVoxels(appearance) {
  const { shape, params, color, highlight, shade: dark } = appearance;
  const rnd = mulberry32(appearance.seed);
  const voxels = [];
  const size = params.size || 0.28;
  const rx = Math.max(2, Math.round(size / DV / 2));
  const ry = Math.max(1, Math.round(rx * (shape === 'layered' ? 0.5 : shape === 'blocky' ? 0.85 : 0.72)));
  const rz = Math.max(2, Math.round(rx * (0.75 + rnd() * 0.35)));
  const seedX = rnd() * 10;

  for (let x = -rx; x <= rx; x += 1) {
    for (let y = 0; y <= ry * 2; y += 1) {
      for (let z = -rz; z <= rz; z += 1) {
        const nx = x / rx;
        const ny = (y - ry) / (ry * 0.9);
        const nz = z / rz;
        const d = nx * nx + ny * ny * (shape === 'layered' ? 2.2 : 1.1) + nz * nz;
        const jitter = noise3(x * 0.7 + seedX, y * 0.9, z * 0.6) * 0.35;
        if (d > 1 + jitter - 0.15) continue;
        // 层理/孔隙：随机挖掉少量方块
        if ((shape === 'porous' || shape === 'layered') && rnd() < 0.12) continue;
        if (y === 0) continue;
        const tone = 0.86 + (y / (ry * 2)) * 0.22 + (rnd() - 0.5) * 0.1;
        voxels.push({ x, y: y - 1, z, color: rnd() < 0.18 ? dark : shade(color, tone) });
        if (rnd() < 0.03) voxels.push({ x, y: y, z, color: shade(highlight, 0.95) });
      }
    }
  }
  return { voxels, maxY: ry * 2 };
}

// ------------------------------------------------------------------ 沉木

function woodVoxels(appearance) {
  const { typeId, params, color, highlight, shade: dark } = appearance;
  const rnd = mulberry32(appearance.seed);
  const voxels = [];
  const H = Math.max(3, Math.round((params.height || 0.6) / DV));
  const addBranch = (x0, y0, z0, len, dx, dy, dz, thick) => {
    for (let i = 0; i < len; i += 1) {
      const x = Math.round(x0 + dx * i);
      const y = Math.round(y0 + dy * i);
      const z = Math.round(z0 + dz * i);
      for (let a = 0; a < thick; a += 1) {
        for (let b = 0; b < thick; b += 1) {
          voxels.push({
            x: x + a, y: y + (rnd() < 0.2 ? 1 : 0), z: z + b,
            color: rnd() < 0.15 ? dark : shade(color, 0.9 + rnd() * 0.18)
          });
        }
      }
    }
  };
  if (typeId === 'stump') {
    // 树桩：粗干 + 放射状根盘
    const trunk = Math.max(3, Math.round(H * 0.5));
    addBranch(0, 0, 0, trunk, 0, 1, 0, 3);
    for (let r = 0; r < 5; r += 1) {
      const ang = (r / 5) * Math.PI * 2 + rnd();
      addBranch(1, 0, 1, 3, Math.cos(ang), 0.05, Math.sin(ang), 1);
    }
    voxels.push({ x: 0, y: trunk, z: 0, color: shade(highlight, 0.9) });
    voxels.push({ x: 1, y: trunk, z: 1, color: shade(highlight, 0.85) });
  } else {
    // 沉木枝：弯曲主干 + 分叉
    const len = Math.max(5, H);
    for (let i = 0; i < len; i += 1) {
      const t = i / len;
      const x = Math.round(Math.sin(t * 2.4 + rnd() * 0.1) * 2);
      const y = Math.round(t * H * 0.7);
      addBranch(x, y, 0, 1, 0, 1, 0, i < len * 0.7 ? 2 : 1);
      if (i === Math.round(len * 0.4) || i === Math.round(len * 0.62)) {
        const dir = rnd() < 0.5 ? 1 : -1;
        addBranch(x, y, 0, Math.round(3 + rnd() * 2), 0.7 * dir, 0.5, 0.2 * dir, 1);
      }
    }
  }
  const maxY = Math.max(1, ...voxels.map((v) => v.y));
  return { voxels, maxY };
}

// ------------------------------------------------------------------ 组装

export function buildPlantGeometry(appearance, quality = 'high') {
  const { voxels, maxY } = plantVoxels(appearance);
  return meshVoxels(voxels, { x: 0, y: 0, z: 0 }, {
    voxel: DV,
    sway: (x, y) => clamp((y / (maxY * DV)) * 1.1, 0, 1)
  });
}

export function buildRockGeometry(appearance, quality = 'high') {
  const { voxels } = rockVoxels(appearance);
  return meshVoxels(voxels, { x: 0, y: 0, z: 0 }, { voxel: DV });
}

export function buildWoodGeometry(appearance, quality = 'high') {
  const { voxels, maxY } = woodVoxels(appearance);
  return meshVoxels(voxels, { x: 0, y: 0, z: 0 }, {
    voxel: DV,
    sway: (x, y) => clamp((y / (maxY * DV)) * 0.35, 0, 0.35)
  });
}

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
  material.customProgramCacheKey = () => 'mofish-decor-sway-v3';
}

export function makeDecorMaterial(appearance, { sway = false, quality = 'high' } = {}) {
  const mat = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    vertexColors: true,
    roughness: appearance.kind === 'rock' ? 0.94 : appearance.kind === 'wood' ? 0.88 : 0.7,
    metalness: 0.0,
    flatShading: true,
    side: THREE.FrontSide
  });
  mat.userData.uniforms = null;
  if (sway) {
    const uniforms = {
      uTime: { value: 0 },
      uPhase: { value: ((appearance.seed % 1000) / 1000) * Math.PI * 2 },
      uSwayAmp: { value: appearance.kind === 'plant' ? 0.05 : 0.012 },
      uSwayFreq: { value: appearance.kind === 'plant' ? 0.55 : 0.28 }
    };
    injectSway(mat, uniforms);
    mat.userData.uniforms = uniforms;
    mat.customProgramCacheKey = () => 'mofish-decor-sway-v3';
  }
  return mat;
}

/** 创建造景网格。返回 THREE.Group：root 里含主网格 + 可选的接触阴影。 */
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
