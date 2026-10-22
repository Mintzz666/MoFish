// 体素造景：水草 / 石头 / 沉木，统一用方块拼出来（Minecraft 风格，与体素鱼同一套画风）。
//
// 约定：
//   * 高画质使用 0.033、低画质使用 0.045 世界单位的方块网格，只输出暴露面；
//   * 顶点色整块着色 + 面明暗，材质统一开 vertexColors；
//   * 水草的 aSway 属性按高度递增，沿用既有的摆动着色器（整株柔和摆动，但骨子里是方块）。
import * as THREE from 'three';
import { meshVoxels } from './fish.js';

const LOW_VOXEL = 0.045;
const HIGH_VOXEL = 0.033;
const voxelForQuality = (quality) => quality === 'low' ? LOW_VOXEL : HIGH_VOXEL;
const cellsForWorld = (distance, voxel, minimum = 0) => Math.max(minimum, Math.round(distance / voxel));
const cellsAtBaseQuality = (cells, voxel, minimum = 1) => Math.max(minimum, Math.round(cells * LOW_VOXEL / voxel));

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
  const colorRnd = mulberry32((appearance.seed ^ 0xa511e9b3) >>> 0);
  const voxel = HIGH_VOXEL;
  const voxelMap = new Map();
  const H = Math.max(2, cellsForWorld(params.height || 0.6, voxel));
  const pick = (t) => (colorRnd() < t ? highlight : colorRnd() < 0.25 ? dark : color);
  const add = (x, y, z, voxelColor) => {
    const voxel = { x: Math.round(x), y: Math.max(0, Math.round(y)), z: Math.round(z), color: voxelColor };
    voxelMap.set([voxel.x, voxel.y, voxel.z].join(','), voxel);
  };
  const count = (value, minimum = 1) => {
    const total = Math.max(minimum, Math.round(value || minimum));
    return total;
  };
  const spreadCells = Math.max(1, (params.spread || 0.08) / voxel);

  switch (typeId) {
    case 'vallis': {
      const blades = count(params.blades || 9, 4);
      const bendCells = Math.max(0.5, (params.bend || 0.18) / voxel);
      const bladeWidth = Math.max(1, Math.round((params.width || LOW_VOXEL) / voxel * 1.6));
      for (let b = 0; b < blades; b += 1) {
        const bx = Math.round((rnd() - 0.5) * spreadCells * 1.5);
        const bz = Math.round((rnd() - 0.5) * spreadCells * 1.5);
        const h = b === 0 ? H : Math.max(3, Math.round(H * (0.62 + rnd() * 0.34)));
        const leanX = (rnd() - 0.5) * bendCells * 0.5;
        const leanZ = (rnd() - 0.5) * bendCells * 0.5;
        for (let y = 0; y < h; y += 1) {
          const t = h <= 1 ? 0 : y / (h - 1);
          const curve = Math.sin(t * Math.PI * 0.5);
          const x = bx + Math.round(leanX * curve);
          const z = bz + Math.round(leanZ * curve);
          const width = t > 0.82 ? 1 : bladeWidth;
          for (let side = 0; side < width; side += 1) {
            add(x + side, y, z, shade(pick(0.3), 0.85 + t * 0.3));
          }
        }
      }
      break;
    }
    case 'anubias': {
      const leaves = count(params.leaves || 7, 3);
      const width = Math.max(2, cellsForWorld(params.width || 0.1, voxel));
      const petioleY = Math.max(1, Math.round(H * 0.18));
      const bendCells = Math.max(0.5, (params.bend || 0.3) / voxel) * 0.12;
      for (let y = 0; y <= petioleY; y += 1) add(0, y, 0, shade(color, 0.88));
      for (let l = 0; l < leaves; l += 1) {
        const ang = (l / leaves) * Math.PI * 2 + rnd() * 0.4;
        const len = Math.max(3, Math.round(spreadCells * (1.8 + rnd() * 0.6)));
        const tipY = l === 0 ? H - 1 : Math.min(H - 1, Math.round(H * (0.7 + rnd() * 0.28)));
        const perpX = -Math.sin(ang), perpZ = Math.cos(ang);
        for (let k = 1; k <= len; k += 1) {
          const t = k / len;
          const curve = Math.sin(t * Math.PI) * bendCells;
          const centerX = Math.cos(ang) * k + perpX * curve;
          const centerZ = Math.sin(ang) * k + perpZ * curve;
          const y = Math.round(petioleY + (tipY - petioleY) * t);
          const taper = Math.sin(t * Math.PI);
          const halfWidth = Math.floor(((width - 1) * taper) / 2);
          for (let side = -halfWidth; side <= halfWidth; side += 1) {
            add(centerX + perpX * side, y, centerZ + perpZ * side, pick(0.35));
          }
        }
      }
      break;
    }
    case 'rotala': {
      const stems = count(params.stems || 6, 2);
      const leafBudget = count(params.leaves || 12, 4);
      const leavesPerStem = Math.max(2, Math.round(leafBudget / stems));
      const leafLength = Math.max(1, Math.round((params.width || LOW_VOXEL) / voxel * 1.5));
      const bendCells = Math.max(0.5, (params.bend || 0.1) / voxel) * 0.12;
      for (let s = 0; s < stems; s += 1) {
        const angle = rnd() * Math.PI * 2;
        const radius = rnd() * spreadCells;
        const bx = Math.round(Math.cos(angle) * radius);
        const bz = Math.round(Math.sin(angle) * radius);
        const h = s === 0 ? H : Math.max(3, Math.round(H * (0.78 + rnd() * 0.2)));
        for (let y = 0; y < h; y += 1) {
          const t = h <= 1 ? 0 : y / (h - 1);
          const curve = Math.sin(t * Math.PI) * bendCells;
          const x = bx + Math.round(Math.cos(angle + Math.PI / 2) * curve);
          const z = bz + Math.round(Math.sin(angle + Math.PI / 2) * curve);
          const stemColor = y === h - 1 ? shade(highlight, 1.04) : shade(color, 0.9 + t * 0.2);
          add(x, y, z, stemColor);
        }
        for (let pair = 0; pair < leavesPerStem; pair += 1) {
          const y = Math.max(1, Math.round(((pair + 1) / (leavesPerStem + 1)) * (h - 1)));
          const t = y / Math.max(1, h - 1);
          const curve = Math.sin(t * Math.PI) * bendCells;
          const x = bx + Math.round(Math.cos(angle + Math.PI / 2) * curve);
          const z = bz + Math.round(Math.sin(angle + Math.PI / 2) * curve);
          const leafColor = shade(highlight, 0.86 + t * 0.2);
          for (const side of [-1, 1]) {
            for (let k = 0; k <= leafLength; k += 1) {
              const leafX = x + Math.round(Math.cos(angle + Math.PI / 2) * side * k);
              const leafZ = z + Math.round(Math.sin(angle + Math.PI / 2) * side * k);
              add(leafX, y + Math.round(k * 0.18), leafZ, leafColor);
            }
          }
        }
      }
      break;
    }
    case 'moss': {
      const blobs = count(params.blobs || 5, 2);
      const radius = Math.max(2, cellsForWorld(params.width || 0.1, voxel));
      const clusterSpread = Math.max(0.5, spreadCells * 0.35);
      for (let b = 0; b < blobs; b += 1) {
        const angle = rnd() * Math.PI * 2;
        const centerRadius = rnd() * clusterSpread;
        const cx = Math.round(Math.cos(angle) * centerRadius);
        const cz = Math.round(Math.sin(angle) * centerRadius);
        const height = b === 0 ? H : Math.max(2, Math.round(H * (0.72 + rnd() * 0.24)));
        const rx = Math.max(1, radius - (b % 2));
        for (let x = -rx; x <= rx; x += 1) {
          for (let y = 0; y < height; y += 1) {
            for (let z = -rx; z <= rx; z += 1) {
              const ny = height <= 1 ? 0 : (y / (height - 1)) * 2 - 1;
              if ((x * x) / (rx * rx) + (z * z) / (rx * rx) + ny * ny > 1.12) continue;
              add(cx + x, y, cz + z, pick(0.3));
            }
          }
        }
      }
      break;
    }
    case 'fern': {
      const fronds = count(params.fronds || 8, 4);
      const pairsPerFrond = count(Math.round((params.leaves || 8) / 2), 2);
      const leafletLength = Math.max(1, Math.round((params.width || LOW_VOXEL) / voxel * 1.5));
      const bendCells = Math.max(0.5, (params.bend || 0.3) / voxel) * 0.1;
      for (let f = 0; f < fronds; f += 1) {
        const ang = (f / fronds) * Math.PI * 2 + rnd() * 0.3;
        const len = f === 0 ? H : Math.max(3, Math.round(H * (0.78 + rnd() * 0.18)));
        const baseX = Math.round((rnd() - 0.5) * spreadCells * 0.8);
        const baseZ = Math.round((rnd() - 0.5) * spreadCells * 0.8);
        for (let k = 0; k < len; k += 1) {
          const t = len <= 1 ? 0 : k / (len - 1);
          const curve = Math.sin(t * Math.PI * 0.5) * bendCells;
          const axisReach = cellsAtBaseQuality(2, voxel, 1);
          const x = baseX + Math.round(Math.cos(ang) * t * axisReach + Math.cos(ang + Math.PI / 2) * curve);
          const z = baseZ + Math.round(Math.sin(ang) * t * axisReach + Math.sin(ang + Math.PI / 2) * curve);
          const y = k;
          add(x, y, z, shade(color, 0.9 + t * 0.2));
        }
        for (let pair = 0; pair < pairsPerFrond; pair += 1) {
          const t = (pair + 1) / (pairsPerFrond + 1);
          const k = Math.min(len - 1, Math.max(0, Math.round(t * (len - 1))));
          const curve = Math.sin(t * Math.PI * 0.5) * bendCells;
          const axisReach = cellsAtBaseQuality(2, voxel, 1);
          const axisX = baseX + Math.round(Math.cos(ang) * t * axisReach + Math.cos(ang + Math.PI / 2) * curve);
          const axisZ = baseZ + Math.round(Math.sin(ang) * t * axisReach + Math.sin(ang + Math.PI / 2) * curve);
          const length = Math.max(1, Math.round(leafletLength * (1 - t * 0.65)));
          for (const side of [-1, 1]) {
            for (let j = 0; j <= length; j += 1) {
              const x = axisX + Math.round(Math.cos(ang + Math.PI / 2) * side * j);
              const z = axisZ + Math.round(Math.sin(ang + Math.PI / 2) * side * j);
              add(x, Math.max(0, k - Math.round(j * 0.18)), z, pick(0.3));
            }
          }
        }
      }
      break;
    }
    case 'carpet':
    default: {
      const spread = Math.max(2, Math.round(spreadCells * 0.42));
      const rz = Math.max(2, Math.round(spread * 0.72));
      const centers = [];
      for (let c = 0; c < 3; c += 1) {
        const angle = (c / 3) * Math.PI * 2 + rnd() * 0.2;
        centers.push({
          x: Math.round(Math.cos(angle) * spread * 0.35),
          z: Math.round(Math.sin(angle) * spread * 0.35)
        });
      }
      const ground = new Map();
      for (const center of centers) {
        for (let x = -spread; x <= spread; x += 1) {
          for (let z = -rz; z <= rz; z += 1) {
            if ((x * x) / (spread * spread) + (z * z) / (rz * rz) > 1.15) continue;
            const gx = center.x + x, gz = center.z + z;
            ground.set([gx, gz].join(','), { x: gx, z: gz });
          }
        }
      }
      const cells = [...ground.values()].sort((a, b) => {
        const da = Math.min(...centers.map(c => (a.x - c.x) ** 2 + (a.z - c.z) ** 2));
        const db = Math.min(...centers.map(c => (b.x - c.x) ** 2 + (b.z - c.z) ** 2));
        return da - db || a.x - b.x || a.z - b.z;
      });
      const widthFactor = clamp(0.8 + ((params.width || 0.01) / voxel) * 0.6, 0.85, 1.2);
      const needleTotal = Math.max(1, Math.round((params.needles || 48) * widthFactor));
      const needleCount = needleTotal;
      const tuftWidth = (params.width || 0.01) / voxel;
      for (const cell of cells) add(cell.x, 0, cell.z, shade(pick(0.25), 0.9));
      for (let n = 0; n < Math.min(needleCount, cells.length); n += 1) {
        const { x, z } = cells[n];
        const height = n === 0 ? H : 1 + Math.round(rnd() * (H - 1));
        for (let y = 1; y < height; y += 1) {
          add(x, y, z, shade(pick(0.25), 0.9 + y * 0.08));
          if (tuftWidth > 0.28 && y === 1 && rnd() < tuftWidth - 0.2) {
            add(x + (n % 2 ? 1 : -1), y, z, shade(pick(0.25), 0.9 + y * 0.08));
          }
        }
      }
      break;
    }
  }
  const voxels = [...voxelMap.values()];
  const maxY = Math.max(1, ...voxels.map((v) => v.y));
  return { voxels, maxY };
}

// ------------------------------------------------------------------ 石头

function rockVoxels(appearance) {
  const { shape, params, color, highlight, shade: dark } = appearance;
  const rnd = mulberry32(appearance.seed);
  const voxel = HIGH_VOXEL;
  const voxels = [];
  const size = params.size || 0.28;
  const rx = Math.max(2, Math.round(size / voxel / 2));
  const ry = Math.max(1, Math.round(rx * (shape === 'layered' ? 0.5 : shape === 'blocky' ? 0.85 : 0.72)));
  const rz = Math.max(2, Math.round(rx * (0.75 + rnd() * 0.35)));
  const seedX = rnd() * 10;
  const noiseScale = voxel / LOW_VOXEL;

  for (let x = -rx; x <= rx; x += 1) {
    for (let y = 0; y <= ry * 2; y += 1) {
      for (let z = -rz; z <= rz; z += 1) {
        const nx = x / rx;
        const ny = (y - ry) / (ry * 0.9);
        const nz = z / rz;
        const d = nx * nx + ny * ny * (shape === 'layered' ? 2.2 : 1.1) + nz * nz;
        const jitter = noise3(x * 0.7 * noiseScale + seedX, y * 0.9 * noiseScale, z * 0.6 * noiseScale) * 0.35;
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
  const voxel = HIGH_VOXEL;
  const voxels = [];
  const H = Math.max(3, cellsForWorld(params.height || 0.6, voxel));
  const baseCells = (cells, minimum = 1) => cellsAtBaseQuality(cells, voxel, minimum);
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
    addBranch(0, 0, 0, trunk, 0, 1, 0, baseCells(3, 2));
    for (let r = 0; r < 5; r += 1) {
      const ang = (r / 5) * Math.PI * 2 + rnd();
      const rootOffset = baseCells(1);
      addBranch(rootOffset, 0, rootOffset, baseCells(3), Math.cos(ang), 0.05, Math.sin(ang), 1);
    }
    voxels.push({ x: 0, y: trunk, z: 0, color: shade(highlight, 0.9) });
    voxels.push({ x: 1, y: trunk, z: 1, color: shade(highlight, 0.85) });
  } else {
    // 沉木枝：弯曲主干 + 分叉
    const len = Math.max(baseCells(5), H);
    for (let i = 0; i < len; i += 1) {
      const t = i / len;
      const x = Math.round(Math.sin(t * 2.4 + rnd() * 0.1) * baseCells(2));
      const y = Math.round(t * H * 0.7);
      addBranch(x, y, 0, 1, 0, 1, 0, i < len * 0.7 ? baseCells(2) : 1);
      if (i === Math.round(len * 0.4) || i === Math.round(len * 0.62)) {
        const dir = rnd() < 0.5 ? 1 : -1;
        addBranch(x, y, 0, baseCells(Math.round(3 + rnd() * 2)), 0.7 * dir, 0.5, 0.2 * dir, 1);
      }
    }
  }
  const maxY = Math.max(1, ...voxels.map((v) => v.y));
  return { voxels, maxY };
}

// ------------------------------------------------------------------ 组装

function downsampleVoxels(voxels, sourceVoxel, targetVoxel) {
  const ratio = sourceVoxel / targetVoxel;
  const sampled = new Map();
  for (const voxel of voxels) {
    const x = Math.round(voxel.x * ratio);
    const y = Math.round(voxel.y * ratio);
    const z = Math.round(voxel.z * ratio);
    sampled.set(`${x},${y},${z}`, { ...voxel, x, y, z });
  }
  return [...sampled.values()];
}

export function buildPlantGeometry(appearance, quality = 'high') {
  const source = plantVoxels(appearance);
  const voxel = voxelForQuality(quality);
  const voxels = quality === 'low' ? downsampleVoxels(source.voxels, HIGH_VOXEL, voxel) : source.voxels;
  const maxY = Math.max(1, ...voxels.map((v) => v.y));
  return meshVoxels(voxels, { x: 0, y: 0, z: 0 }, {
    voxel,
    sway: (x, y) => clamp((y / (maxY * voxel)) * 1.1, 0, 1)
  });
}

export function buildRockGeometry(appearance, quality = 'high') {
  const source = rockVoxels(appearance);
  const voxel = voxelForQuality(quality);
  const voxels = quality === 'low' ? downsampleVoxels(source.voxels, HIGH_VOXEL, voxel) : source.voxels;
  return meshVoxels(voxels, { x: 0, y: 0, z: 0 }, { voxel });
}

export function buildWoodGeometry(appearance, quality = 'high') {
  const source = woodVoxels(appearance);
  const voxel = voxelForQuality(quality);
  const voxels = quality === 'low' ? downsampleVoxels(source.voxels, HIGH_VOXEL, voxel) : source.voxels;
  const maxY = Math.max(1, ...voxels.map((v) => v.y));
  return meshVoxels(voxels, { x: 0, y: 0, z: 0 }, {
    voxel,
    sway: (x, y) => clamp((y / (maxY * voxel)) * 0.35, 0, 0.35)
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
  const geometries = new Set();
  const materials = new Set();
  const addMaterial = (material) => {
    if (Array.isArray(material)) material.forEach(addMaterial);
    else if (material?.dispose) materials.add(material);
  };
  const addGeometry = (geometry) => { if (geometry?.dispose) geometries.add(geometry); };
  addGeometry(data.geometry);
  addGeometry(data.mesh?.geometry);
  addMaterial(data.material);
  group.traverse?.((object) => {
    addGeometry(object.geometry);
    addMaterial(object.material);
  });
  geometries.forEach((geometry) => geometry.dispose());
  materials.forEach((material) => material.dispose());
  group.clear();
}

/** 沉木/石头摆到沙面上时，几何原点已经在底部中心，直接放到 y=0。 */
export function decorGroundOffset(appearance) {
  return 0;
}
