// 体素（voxel）鱼：Minecraft 风格的方块造型。
//
// 为什么换成体素：鱼的「可读性」在这么小的屏幕上比曲线精度更重要。方块鱼的轮廓一旦定下来就非常清楚，
// 颜色是整块的，眼睛是方点，鳍和尾是薄板，游动靠刚体摆动——这比光滑曲面更容易做得好、也更耐看。
//
// 结构：
//   * 身体：按列（tail→head）堆方块，列高/中轴来自该鱼型的轮廓参数，截面 2–5 格厚；
//   * 尾：独立网格 + 独立轴心，左右摆动（不是顶点剪切）；
//   * 背鳍：背上一排扁平方块；胸鳍：两片小方板，独立拍动；
//   * 眼睛：贴在两侧的深色方块 + 一个白色高光方块；嘴：吻端下方一个深色方块；
//   * 每个方块只输出暴露面，顶点色写死「上亮、侧中、下暗」的色阶，形成方块画风。
import * as THREE from 'three';

const clamp = (n, a, b) => Math.min(b, Math.max(a, n));

// 体素边长（世界单位）。整条鱼的长度 ≈ cols * VOXEL。
export const VOXEL = 0.045;

// 轮廓控制点：0 = 尾柄，1 = 吻端（与旧版一致，保证鱼型差异仍在参数表里）
const PROFILE = {
  h: [0.17, 0.4, 0.7, 0.94, 1.0, 0.92, 0.7, 0.42, 0.12],
  w: [0.15, 0.34, 0.64, 0.9, 0.96, 0.88, 0.64, 0.4, 0.14]
};

function sampleCurve(values, u) {
  const t = clamp(u, 0, 1) * (values.length - 1);
  const i = Math.min(values.length - 2, Math.floor(t));
  const f = t - i;
  const p0 = values[Math.max(0, i - 1)];
  const p1 = values[i];
  const p2 = values[i + 1];
  const p3 = values[Math.min(values.length - 1, i + 2)];
  const m1 = (p2 - p0) / 2;
  const m2 = (p3 - p1) / 2;
  const f2 = f * f;
  const f3 = f2 * f;
  return (2 * f3 - 3 * f2 + 1) * p1 + (f3 - 2 * f2 + f) * m1 + (-2 * f3 + 3 * f2) * p2 + (f3 - f2) * m2;
}

function specOf(type, quality) {
  const b = type.body;
  const detail = quality === 'low' ? 0.76 : 1;
  return {
    cols: clamp(Math.round(20 * (b.len / 0.55) * detail), 14, 32),
    rows: clamp(Math.round(b.depth * 22 * detail), 4, 22),
    depth: clamp(Math.round((b.width || 0.4) * 6 * detail) * 2 + 1, 3, 9),
    head: b.head ?? 0.6,
    peduncle: b.peduncle ?? 0.3,
    tail: type.fins.tail || 'fork',
    dorsal: type.fins.dorsal || 'sail'
  };
}

// 单方块六个面的法向与四角（逆时针朝外）
const FACES = [
  { dir: [1, 0, 0], shade: 0.95, corners: [[1, 0, 1], [1, 0, 0], [1, 1, 0], [1, 1, 1]] },
  { dir: [-1, 0, 0], shade: 0.9, corners: [[0, 0, 0], [0, 0, 1], [0, 1, 1], [0, 1, 0]] },
  { dir: [0, 1, 0], shade: 1.0, corners: [[0, 1, 1], [1, 1, 1], [1, 1, 0], [0, 1, 0]] },
  { dir: [0, -1, 0], shade: 0.78, corners: [[0, 0, 0], [1, 0, 0], [1, 0, 1], [0, 0, 1]] },
  { dir: [0, 0, 1], shade: 0.9, corners: [[0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1]] },
  { dir: [0, 0, -1], shade: 0.86, corners: [[1, 0, 0], [0, 0, 0], [0, 1, 0], [1, 1, 0]] }
];

/** 把一组 {x,y,z,color} 体素网格化成只含暴露面的几何（顶点色 + 面明暗）。 */
export function meshVoxels(voxels, origin = { x: 0, y: 0, z: 0 }, { voxel = VOXEL, sway = null } = {}) {
  const key = (x, y, z) => `${x},${y},${z}`;
  const filled = new Map();
  for (const v of voxels) filled.set(key(v.x, v.y, v.z), v);

  const positions = [];
  const normals = [];
  const colors = [];
  const indices = [];
  const shade = new THREE.Color();

  // 同一格可能由茎/叶、身体/花纹反复写入，最后一次着色生效；只生成一份表面。
  for (const v of filled.values()) {
    for (const face of FACES) {
      const [dx, dy, dz] = face.dir;
      if (filled.has(key(v.x + dx, v.y + dy, v.z + dz))) continue;
      const base = positions.length / 3;
      for (const [cx, cy, cz] of face.corners) {
        positions.push(
          (v.x + cx - origin.x) * voxel,
          (v.y + cy - origin.y) * voxel,
          (v.z + cz - origin.z) * voxel
        );
        normals.push(dx, dy, dz);
        shade.set(v.color).multiplyScalar(face.shade);
        colors.push(shade.r, shade.g, shade.b);
      }
      indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  if (sway) {
    const swayAttr = [];
    for (let i = 0; i < positions.length; i += 3) {
      swayAttr.push(sway(positions[i], positions[i + 1], positions[i + 2]));
    }
    geo.setAttribute('aSway', new THREE.Float32BufferAttribute(swayAttr, 1));
  }
  geo.setIndex(indices);
  return geo;
}

function colorOf(appearance, row, rows, pattern, col, cols) {
  const base = new THREE.Color(appearance.body);
  const belly = new THREE.Color(appearance.belly);
  const accent = new THREE.Color(appearance.accent);
  // 反荫蔽：背深腹浅（整格变化，正好符合方块画风）
  const t = rows <= 1 ? 0.5 : row / (rows - 1);
  const c = belly.clone().lerp(base, Math.pow(t, 0.8));
  const p = appearance.pattern;
  if (p === 'stripe' && col % 3 === 1) c.lerp(accent, 0.45);
  if (p === 'band' && Math.abs(col / Math.max(1, cols - 1) - 0.55) < 0.1) c.lerp(accent, 0.4);
  if (p === 'spot' && (row + col) % 4 === 0) c.lerp(accent, 0.4);
  if (p === 'saddle' && t > 0.55 && col > cols * 0.25 && col < cols * 0.7) c.lerp(accent, 0.35);
  if (p === 'gradient') c.lerp(accent, (1 - col / Math.max(1, cols - 1)) * 0.3);
  return c;
}

/**
 * 生成一条体素鱼。
 * 返回 group，userData 里有 tailPivot / pectoralL / pectoralR 供视图层做摆动。
 */
export function createFishMesh(type, appearance, growth, quality = 'high') {
  const spec = specOf(type, quality);
  const { cols, rows, depth } = spec;
  const props = appearance.props || { head: 1, fin: 1, eye: 1 };
  const group = new THREE.Group();
  const bodyVoxels = [];
  const tailVoxels = [];
  const tailStart = Math.max(2, Math.round(cols * 0.16));   // 尾柄位置（列）
  const z0 = -Math.floor(depth / 2);

  // 体侧轮廓：每列的半高与中轴
  const column = [];
  for (let i = 0; i < cols; i += 1) {
    const u = i / (cols - 1);
    const h = Math.max(1, sampleCurve(PROFILE.h, u) * rows);
    const headTaper = u > 0.72 ? 1 - Math.pow((u - 0.72) / 0.28, 1.5) * (1 - spec.head * 0.8) : 1;
    const peduncle = i < tailStart ? 0.45 + spec.peduncle + (i / tailStart) * 0.25 : 1;
    const juvenileHead = u > 0.62 ? props.head : 1;
    column.push({
      h: Math.max(1, Math.round(h * headTaper * peduncle * juvenileHead)),
      center: (rows - 1) / 2
    });
  }

  for (let i = 0; i < cols; i += 1) {
    const { h, center } = column[i];
    const half = h / 2;
    for (let r = 0; r < rows; r += 1) {
      const dy = Math.abs(r - center);
      if (dy > half) continue;
      // 椭圆截面：中间厚、上下薄（方块版的「圆身」）
      const edge = half === 0 ? 0 : 1 - Math.pow(dy / (half + 0.35), 2);
      const along = sampleCurve(PROFILE.w, i / (cols - 1));
      const wanted = depth * Math.sqrt(Math.max(0, edge)) * Math.sqrt(Math.max(0.08, along));
      const thick = clamp(1 + Math.round((wanted - 1) / 2) * 2, 1, depth);
      const zStart = -(thick - 1) / 2;
      for (let d = 0; d < thick; d += 1) {
        const color = colorOf(appearance, r, rows, appearance.pattern, i, cols);
        const voxel = { x: i, y: r, z: zStart + d, color, target: i < tailStart ? 'tail' : 'body' };
        if (voxel.target === 'tail') tailVoxels.push(voxel);
        else bodyVoxels.push(voxel);
      }
    }
  }

  // 眼睛：直接给身体最外层的方块换色（深色瞳孔 + 前上方一个白色高光），不额外长出方块
  const eyeCol = cols - Math.max(2, Math.round(cols * 0.16));
  const eyeRow = Math.min(rows - 1, Math.round(column[eyeCol].center + column[eyeCol].h * 0.22));
  const eyeColor = new THREE.Color('#121a1c');
  const eyeWhite = new THREE.Color('#f4fbf7');
  const at = new Map();
  for (const v of bodyVoxels) at.set(`${v.x},${v.y},${v.z}`, v);
  for (const side of [1, -1]) {
    let zOuter = null;
    for (const v of bodyVoxels) {
      if (v.x !== eyeCol || v.y !== eyeRow) continue;
      if (zOuter === null || (side > 0 ? v.z > zOuter : v.z < zOuter)) zOuter = v.z;
    }
    if (zOuter === null) continue;
    at.get(`${eyeCol},${eyeRow},${zOuter}`).color = eyeColor;
    const pupil2 = at.get(`${eyeCol + 1},${eyeRow},${zOuter}`);
    if (pupil2 && (props.eye > 1.12 || rows > 9)) pupil2.color = eyeColor;
    const glint = at.get(`${eyeCol + 1},${eyeRow + 1},${zOuter}`);
    if (glint) glint.color = eyeWhite;
  }

  // 嘴：吻端下方的深色方块
  const mouthColor = new THREE.Color(appearance.accent).multiplyScalar(0.45);
  bodyVoxels.push({ x: cols - 1, y: Math.max(0, Math.round(column[cols - 1].center - 1)), z: z0 + Math.floor(depth / 2), color: mouthColor });

  // 背鳍：背上一排扁平方块（沿体轴 2/3 长度）
  if (spec.dorsal !== 'none') {
    const from = Math.round(cols * 0.3);
    const to = Math.round(cols * 0.72);
    const finColor = new THREE.Color(appearance.fin).multiplyScalar(0.95);
    for (let i = from; i <= to; i += 1) {
      const top = Math.floor(column[i].center + column[i].h / 2);
      const span = (i - from) / Math.max(1, to - from);
      const finPeak = spec.dorsal === 'ridge' || spec.dorsal === 'small' ? 1 : Math.max(1, rows * (type.fins.dorsalSize || 0.25) * 0.5 * props.fin);
      const height = Math.max(1, Math.round(finPeak * Math.sin(Math.PI * (span * 0.8 + 0.1))));
      for (let k = 1; k <= height; k += 1) {
        bodyVoxels.push({ x: i, y: top + k, z: z0 + Math.floor(depth / 2), color: finColor });
      }
    }
  }

  // 臀鳍：腹后一排小方块
  if (type.fins.anal !== 'none') {
    const from = Math.round(cols * 0.22);
    const to = Math.round(cols * 0.4);
    const finColor = new THREE.Color(appearance.fin).multiplyScalar(0.9);
    for (let i = from; i <= to; i += 1) {
      const bottom = Math.ceil(column[i].center - column[i].h / 2);
      bodyVoxels.push({ x: i, y: bottom - 1, z: z0 + Math.floor(depth / 2), color: finColor });
    }
  }

  // 尾鳍：按鱼种形状在尾柄后铺方块（薄板）
  const tailColor = new THREE.Color(appearance.fin);
  const tailLen = Math.max(2, Math.round(({ veil: 5, fan: 4, round: 3, fork: 4, lance: 4, spade: 3 }[spec.tail] || 4) * props.fin));
  const tailRows = Math.max(3, Math.round(rows * (0.55 + (type.fins.tailSize || 0.3) * 0.45) * props.fin));
  for (let i = 1; i <= tailLen; i += 1) {
    const spread = i / tailLen;
    // 从尾柄向外张开，但不是一整块方板
    const half = Math.max(1, Math.round((tailRows / 2) * (0.55 + spread * 0.5)));
    const mid = (rows - 1) / 2;
    for (let k = -half; k <= half; k += 1) {
      const y = Math.round(mid + k);
      if (y < 0 || y >= rows) continue;
      // 分叉尾：外端中间留缺口
      if (spec.tail === 'fork' && i > 1 && Math.abs(k) <= Math.max(0, Math.round(half * spread) - 1)) continue;
      if (spec.tail === 'veil' && i === tailLen && Math.abs(k) < 1) continue;
      if (spec.tail === 'round' && i === tailLen && Math.abs(k) > half - 1) continue;
      tailVoxels.push({ x: -i, y, z: 0, color: tailColor.clone().multiplyScalar(0.9 + 0.1 * spread) });
    }
  }
  // 尾柄与尾板之间补一格，避免断开
  for (let y = Math.round((rows - 1) / 2) - 1; y <= Math.round((rows - 1) / 2) + 1; y += 1) {
    tailVoxels.push({ x: 0, y, z: 0, color: tailColor });
  }

  const vs = 1 / cols;   // 归一化：整条鱼长度 = 1，交给视图层按鱼型体长缩放
  const offsetX = -(cols * vs) / 2;
  // 身体以中心为原点；尾巴以尾柄为原点（便于绕尾柄转动）
  const bodyGeo = meshVoxels(bodyVoxels, { x: cols / 2, y: rows / 2, z: 0.5 }, { voxel: vs });
  const tailGeo = meshVoxels(tailVoxels, { x: tailStart, y: rows / 2, z: 0.5 }, { voxel: vs });

  const material = new THREE.MeshStandardMaterial({
    vertexColors: true,
    roughness: 0.72,
    metalness: 0.02,
    flatShading: true
  });

  const bodyMesh = new THREE.Mesh(bodyGeo, material);
  bodyMesh.castShadow = quality === 'high';
  group.add(bodyMesh);

  // 尾：独立轴心放在尾柄处，绕 Y 摆动
  const tailPivot = new THREE.Group();
  tailPivot.position.set(tailStart * vs + offsetX, 0, 0);
  const tailMesh = new THREE.Mesh(tailGeo, material);
  tailMesh.castShadow = quality === 'high';
  tailPivot.add(tailMesh);
  group.add(tailPivot);

  // 胸鳍：两片小方板，独立拍动
  const finColor = appearance.fin;
  const pectoralVoxels = [];
  for (let x = 0; x < 2; x += 1) {
    pectoralVoxels.push({ x, y: 0, z: 0, color: new THREE.Color(finColor).multiplyScalar(0.92 + x * 0.05) });
  }
  const pectoralGeo = meshVoxels(pectoralVoxels, { x: 0, y: 0.5, z: 0.5 }, { voxel: vs });
  const pectoralL = new THREE.Mesh(pectoralGeo, material);
  const pectoralR = new THREE.Mesh(pectoralGeo, material);
  const gillCol = Math.round(cols * 0.7);
  const gillY = -vs * 0.4;
  const gillZ = Math.max(0.65, (depth * Math.sqrt(sampleCurve(PROFILE.w, gillCol / (cols - 1))) - 1) / 2) * vs;
  pectoralL.castShadow = pectoralR.castShadow = quality === 'high';
  pectoralL.position.set(gillCol * vs + offsetX, gillY, gillZ);
  pectoralL.rotation.set(0.15, -0.7, -0.2);
  pectoralR.position.set(gillCol * vs + offsetX, gillY, -gillZ);
  pectoralR.rotation.set(-0.15, Math.PI + 0.7, 0.2);
  group.add(pectoralL, pectoralR);

  group.userData = {
    type,
    appearance,
    growth,
    tailPivot,
    pectoralL,
    pectoralR,
    wagAmp: 0.42 + (type.fins.tail === 'veil' ? 0.1 : 0),
    wagFreq: type.id === 'dart' ? 7.2 : type.id === 'puff' ? 2.6 : 4.4,
    wagPhase: appearance.phase ?? Math.random() * Math.PI * 2,
    materials: [material],
    geometries: [bodyGeo, tailGeo, pectoralGeo]
  };
  return group;
}

/** 释放一条鱼占用的 GPU 资源。 */
export function disposeFish(group) {
  if (!group) return;
  const data = group.userData || {};
  (data.geometries || []).forEach((g) => g.dispose?.());
  (data.materials || []).forEach((m) => m.dispose?.());
  group.clear();
}
