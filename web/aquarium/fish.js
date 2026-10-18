// 程序化鱼：体态轮廓 + 鳍 + 眼睛 + 游动着色器。
//
// 建模思路（目标是「一眼能看出是鱼」，而不是椭圆体加三角鳍）：
// - 体轴用一组控制点描述「高/宽/中轴」曲线，再按鱼种叠加自己的轮廓（圆身/细长/高盘等）；
// - 截面为带腹部加厚的椭圆，头尾自然收拢；吻端有嘴，眼位有眼窝暗环与鳃线；
// - 尾鳍/背鳍/臀鳍是有弧度的曲面网格（不是平面三角形），边缘带波浪，根部到梢部有色渐变；
// - 顶点色做反荫蔽（背深腹浅）+ 花纹 + 鳍条，配合清漆材质表现湿润的鳞面光。
// 游动变形仍在顶点着色器里（尾到头相位行波 + 转弯侧弯 + 鳍的独立摆动）。
import * as THREE from 'three';

const clamp = (n, a, b) => Math.min(b, Math.max(a, n));
const TAU = Math.PI * 2;

// 体轴控制点（u: 0 尾柄 → 1 吻端）。默认是一条典型的纺锤形鱼。
const DEFAULT_PROFILE = {
  h: [0.17, 0.4, 0.7, 0.94, 1.0, 0.92, 0.7, 0.42, 0.12],
  w: [0.15, 0.34, 0.64, 0.9, 0.96, 0.88, 0.64, 0.4, 0.14],
  cy: [0, -0.02, -0.03, -0.02, 0.0, 0.02, 0.02, 0.0, -0.03]
};

/** 均匀控制点的 Catmull-Rom 采样（端点夹紧），用来得到平滑的体态曲线。 */
function sampleCurve(values, u) {
  const t = clamp(u, 0, 1) * (values.length - 1);
  const i = Math.min(values.length - 2, Math.floor(t));
  const f = t - i;
  const p0 = values[Math.max(0, i - 1)];
  const p1 = values[i];
  const p2 = values[i + 1];
  const p3 = values[Math.min(values.length - 1, i + 2)];
  // Catmull-Rom → 三次 Hermite
  const m1 = (p2 - p0) / 2;
  const m2 = (p3 - p1) / 2;
  const f2 = f * f;
  const f3 = f2 * f;
  return (2 * f3 - 3 * f2 + 1) * p1 + (f3 - 2 * f2 + f) * m1 + (-2 * f3 + 3 * f2) * p2 + (f3 - f2) * m2;
}

function profileOf(type) {
  const custom = type.body.profile || {};
  return {
    h: custom.h || DEFAULT_PROFILE.h,
    w: custom.w || DEFAULT_PROFILE.w,
    cy: custom.cy || DEFAULT_PROFILE.cy
  };
}

/**
 * 体轴某一位置的截面参数。
 * 返回 {x, ry, rz, cy}：x 为体轴位置，ry 半高，rz 半宽，cy 中轴上下偏移。
 */
function bodySection(u, b, profile) {
  const x = -0.46 + u * 0.96;
  // 尾部收细：尾柄处保留一点厚度，避免变成针尖
  const peduncle = b.peduncle ?? 0.25;
  const tailTighten = 1 - (1 - peduncle) * Math.pow(1 - clamp(u / 0.16, 0, 1), 1.6);
  const headBlunt = 0.5 + (b.head ?? 0.6) * 0.55;   // head 越大，吻端越钝（0.5 → 尖，0.86 → 圆）
  const headTighten = 1 - (1 - headBlunt) * Math.pow(clamp((u - 0.8) / 0.2, 0, 1), 1.7);
  const ry = Math.max(0.004, b.depth * 0.5 * sampleCurve(profile.h, u) * tailTighten * headTighten);
  const rz = Math.max(0.003, ry * b.width * (0.92 + 0.16 * Math.sin(Math.PI * u)));
  const cy = b.arch ? (b.arch - 0.12) * ry * sampleCurve(profile.cy, u) * 2.2 : 0;
  return { x, ry, rz, cy };
}

// ------------------------------------------------------------------ 顶点色

function buildPatternPalette({ body, belly, accent, fin, pattern, patternScale }) {
  return {
    body: new THREE.Color(body),
    belly: new THREE.Color(belly),
    accent: new THREE.Color(accent),
    fin: new THREE.Color(fin),
    pattern: pattern || 'plain',
    scale: patternScale || 1
  };
}

/** 体表颜色：反荫蔽 + 花纹 + 鳃线/眼窝/嘴的细节。 */
function bodyColor(p, u, angle, ry, ey) {
  const top = (Math.sin(angle) + 1) / 2;
  const c = p.belly.clone().lerp(p.body, Math.pow(top, 0.7));
  c.multiplyScalar(0.86 + top * 0.18);

  const accent = p.accent.clone().lerp(p.body, 0.3);
  let mix = 0;
  switch (p.pattern) {
    case 'stripe': {
      const band = Math.sin(u * Math.PI * 7 * p.scale + 0.4);
      mix = band > 0.5 ? 0.55 : 0;
      break;
    }
    case 'band': {
      mix = Math.abs(u - 0.55) < 0.09 ? 0.52 : 0;
      break;
    }
    case 'spot': {
      const n = Math.sin(u * 30 * p.scale) * Math.cos(angle * 3.4) + Math.sin(angle * 6.2 + u * 11);
      mix = n > 0.75 ? 0.55 : 0;
      break;
    }
    case 'saddle': {
      mix = u > 0.3 && u < 0.62 && top > 0.45 ? 0.48 : 0;
      break;
    }
    case 'gradient': {
      mix = (1 - u) * 0.32;
      break;
    }
    default:
      mix = 0;
  }
  if (mix > 0) c.lerp(accent, mix);

  // 鳃线：头后一条很淡的暗环
  if (u > 0.7 && u < 0.74) c.multiplyScalar(0.9);
  // 眼窝：眼睛周围压暗一点，让眼睛「长」在头上
  if (u > 0.9 && u < 0.96 && Math.abs(ry * Math.sin(angle) - ey) < ry * 0.5) c.multiplyScalar(0.7);
  // 嘴：吻端中间压暗
  if (u > 0.972 && Math.abs(Math.sin(angle)) < 0.6) c.multiplyScalar(0.5);
  return c;
}

// ------------------------------------------------------------------ 鱼身

/**
 * 鱼身几何（单位体长）。返回带 position/normal/color/aWave/aPhase/aBend 的几何。
 * quality 决定分段数；高画质下鳞面细节更完整。
 */
export function buildBodyGeometry(type, growth, quality = 'high', appearance = null) {
  const stations = quality === 'high' ? 22 : 15;
  const radial = quality === 'high' ? 12 : 9;
  const b = type.body;
  const profile = profileOf(type);
  const palette = appearance ? buildPatternPalette(appearance) : null;
  const eyeSection = bodySection(0.925, b, profile);
  const ey = eyeSection.ry * 0.34;

  const positions = [];
  const normals = [];
  const colors = [];
  const wave = [];
  const bend = [];
  const phase = [];
  const indices = [];

  for (let i = 0; i <= stations; i += 1) {
    const u = i / stations;
    const { x, ry, rz, cy } = bodySection(u, b, profile);
    for (let j = 0; j <= radial; j += 1) {
      const angle = (j / radial) * TAU;
      const sin = Math.sin(angle);
      // 腹部略饱满、背部略收，避免正圆截面的塑料感
      const rySide = sin >= 0 ? ry : ry * (1 + (b.belly ?? 0.5) * 0.12);
      const y = cy + sin * rySide;
      const z = Math.cos(angle) * rz;
      positions.push(x, y, z);
      const len = Math.hypot(y - cy, z) || 1;
      normals.push(0, (y - cy) / len, z / len);
      if (palette) {
        const c = bodyColor(palette, u, angle, ry, ey);
        colors.push(c.r, c.g, c.b);
      }
      wave.push(Math.pow(u, 1.6) * 0.95);
      bend.push(Math.pow(u, 1.9));
      phase.push(0);
    }
  }
  for (let i = 0; i < stations; i += 1) {
    for (let j = 0; j < radial; j += 1) {
      const a = i * (radial + 1) + j;
      const bb = a + radial + 1;
      indices.push(a, bb, a + 1, bb, bb + 1, a + 1);
    }
  }

  // 头尾封口：用中心点收成一个圆润的端面（不是空洞）
  const headRing = stations * (radial + 1);
  const headSection = bodySection(1, b, profile);
  const headCenter = positions.length / 3;
  positions.push(headSection.x + 0.03, headSection.cy, 0);
  normals.push(1, 0, 0);
  if (palette) colors.push(palette.accent.r * 0.5, palette.accent.g * 0.5, palette.accent.b * 0.5);
  wave.push(0.02); bend.push(0.02); phase.push(0);
  for (let j = 0; j < radial; j += 1) indices.push(headRing + j, headRing + j + 1, headCenter);

  const tailCenter = positions.length / 3;
  const tailSection = bodySection(0, b, profile);
  positions.push(tailSection.x - 0.008, tailSection.cy, 0);
  normals.push(-1, 0, 0);
  if (palette) colors.push(palette.body.r, palette.body.g, palette.body.b);
  wave.push(0.95); bend.push(1); phase.push(0);
  for (let j = 0; j < radial; j += 1) indices.push(j + 1, j, tailCenter);

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  if (colors.length) geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  geo.setAttribute('aWave', new THREE.Float32BufferAttribute(wave, 1));
  geo.setAttribute('aPhase', new THREE.Float32BufferAttribute(phase, 1));
  geo.setAttribute('aBend', new THREE.Float32BufferAttribute(bend, 1));
  geo.setIndex(indices);
  geo.computeVertexNormals();
  return geo;
}

// ------------------------------------------------------------------ 鳍

/**
 * 通用鳍面：base(t) → tip(t) 的曲面网格（t 沿鳍根，q 从根到梢）。
 * 让鳍在 Z 方向有弧度、梢部边缘有波浪，并带根部→梢部的颜色渐变与鳍条暗线。
 */
function finSurface({
  cols = 12, rows = 5, base, tip, curveZ = 0.02, waveBase = 0.35, waveTip = 0.85,
  phase = 0, colorBase, colorTip, rayStrength = 0.12
}) {
  const positions = [];
  const colors = [];
  const wave = [];
  const bend = [];
  const phases = [];
  const fin = [];
  const indices = [];
  const c0 = new THREE.Color(colorBase);
  const c1 = new THREE.Color(colorTip);
  for (let j = 0; j <= rows; j += 1) {
    const q = j / rows;
    for (let i = 0; i <= cols; i += 1) {
      const t = i / cols;
      const [bx, by, bz] = base(t);
      const [tx, ty, tz] = tip(t);
      // 中间稍微向外鼓，边缘带细波浪
      const bulge = Math.sin(q * Math.PI) * curveZ;
      const ripple = Math.sin(t * Math.PI * 7 + phase) * 0.012 * q * q;
      const x = bx + (tx - bx) * q;
      const y = by + (ty - by) * q + ripple * 0.4;
      const z = bz + (tz - bz) * q + bulge;
      positions.push(x, y, z);
      const c = c0.clone().lerp(c1, Math.pow(q, 0.8));
      // 鳍条：每列一条略暗的线
      const ray = i % 2 === 0 ? 1 - rayStrength : 1;
      c.multiplyScalar(ray);
      colors.push(c.r, c.g, c.b);
      wave.push(waveBase + (waveTip - waveBase) * Math.pow(q, 1.2));
      bend.push(0.1);
      phases.push(phase);
      fin.push(0, 0);
    }
  }
  for (let j = 0; j < rows; j += 1) {
    for (let i = 0; i < cols; i += 1) {
      const a = j * (cols + 1) + i;
      const b2 = a + cols + 1;
      indices.push(a, b2, a + 1, b2, b2 + 1, a + 1);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  geo.setAttribute('aWave', new THREE.Float32BufferAttribute(wave, 1));
  geo.setAttribute('aPhase', new THREE.Float32BufferAttribute(phases, 1));
  geo.setAttribute('aBend', new THREE.Float32BufferAttribute(bend, 1));
  geo.setAttribute('aFinOffset', new THREE.Float32BufferAttribute(fin, 2));
  geo.setIndex(indices);
  geo.computeVertexNormals();
  return geo;
}

/** 尾鳍：从尾柄向后展开的曲面，外缘形状按鱼种。 */
function tailGeometry(type, props, palette) {
  const fins = type.fins;
  const size = (fins.tailSize || 0.35) * 0.86 * (0.72 + 0.28 * props.fin);
  const peduncle = type.body.peduncle ?? 0.25;
  const baseHalf = type.body.depth * 0.5 * 0.18 * (0.55 + peduncle);
  const tails = {
    fan: { spread: 0.5, r: (t) => 0.62 + 0.38 * Math.cos((t - 0.5) * Math.PI) },
    fork: { spread: 0.5, r: (t) => 0.42 + 0.58 * Math.abs(Math.cos((t - 0.5) * Math.PI)) },
    veil: { spread: 0.46, r: (t) => 0.5 + 0.5 * Math.abs(Math.cos((t - 0.5) * Math.PI)) * (1 + 0.1 * Math.sin(t * Math.PI * 5)) },
    round: { spread: 0.46, r: (t) => 0.64 + 0.36 * Math.cos((t - 0.5) * Math.PI) },
    lance: { spread: 0.3, r: (t) => 0.4 + 0.6 * Math.cos((t - 0.5) * Math.PI * 1.1) },
    spade: { spread: 0.48, r: (t) => 0.6 + 0.4 * Math.cos((t - 0.5) * Math.PI * 1.5) }
  };
  const shape = tails[fins.tail] || tails.fan;
  return finSurface({
    cols: 16,
    rows: 6,
    base: (t) => [-0.435, (t - 0.5) * baseHalf * 2.1, Math.cos(t * Math.PI) * baseHalf * 0.4],
    tip: (t) => {
      const spread = (t - 0.5) * 2 * shape.spread;
      const r = size * shape.r(t);
      return [-0.455 - r * (0.95 + 0.1 * Math.cos(t * Math.PI)), spread * r * 1.25, Math.cos(t * Math.PI) * 0.01];
    },
    curveZ: 0.03,
    waveBase: 0.75,
    waveTip: 1.25,
    phase: 0.2,
    colorBase: palette.body,
    colorTip: palette.fin,
    rayStrength: 0.16
  });
}

/** 背鳍：沿背部曲线生长，外缘按鱼种形状起伏。 */
function dorsalGeometry(type, props, palette, profile) {
  const fins = type.fins;
  const size = (fins.dorsalSize || 0.2) * 0.62 * (0.6 + 0.4 * props.fin);
  const span = fins.dorsal === 'long' ? 0.46 : fins.dorsal === 'ridge' ? 0.44 : 0.3;
  const startX = 0.24;
  const height = (t) => {
    switch (fins.dorsal) {
      case 'tri': return size * Math.sin(Math.PI * Math.min(1, t * 1.25)) * 1.1;
      case 'small': return size * (0.5 + 0.5 * Math.sin(Math.PI * t));
      case 'ridge': return size * 0.45;
      default: return size * (0.72 + 0.28 * Math.sin(Math.PI * t)) * (1 + 0.08 * Math.sin(t * Math.PI * 3));
    }
  };
  const backY = (x) => {
    const u = clamp((x + 0.46) / 0.96, 0, 1);
    const s = bodySection(u, type.body, profile);
    return s.cy + s.ry * 0.96;
  };
  return finSurface({
    cols: 14,
    rows: 4,
    base: (t) => {
      const x = startX - span * t;
      return [x, backY(x), 0];
    },
    tip: (t) => {
      // 后掠：鳍尖比根部更靠后，像一面前倾的帆
      const x = startX - span * t - 0.05 - 0.03 * t;
      return [x, backY(x) + height(t), 0.004];
    },
    curveZ: 0.016,
    waveBase: 0.3,
    waveTip: 0.6,
    phase: 0.9,
    colorBase: palette.body,
    colorTip: palette.fin,
    rayStrength: 0.14
  });
}

/** 臀鳍：腹部后方的小鳍。 */
function analGeometry(type, props, palette, profile) {
  const size = (type.fins.analSize ?? type.fins.anal ?? 0.18) * 0.55 * (0.65 + 0.35 * props.fin);
  const span = 0.24;
  const startX = 0.02;
  const bellyY = (x) => {
    const u = clamp((x + 0.46) / 0.96, 0, 1);
    const s = bodySection(u, type.body, profile);
    return s.cy - s.ry * 0.96 * (1 + (type.body.belly ?? 0.5) * 0.06);
  };
  return finSurface({
    cols: 9,
    rows: 3,
    base: (t) => {
      const x = startX - span * t;
      return [x, bellyY(x), 0];
    },
    tip: (t) => {
      const x = startX - span * t - 0.01;
      return [x, bellyY(x) - size * Math.sin(Math.PI * Math.min(1, t * 1.2)), 0.004];
    },
    curveZ: 0.012,
    waveBase: 0.3,
    waveTip: 0.55,
    phase: 1.4,
    colorBase: palette.body,
    colorTip: palette.fin,
    rayStrength: 0.12
  });
}

/** 胸鳍：贴在鳃后的两片小扇子，单独旋转做划水动画。 */
function pectoralGeometry(type, props, palette) {
  const size = (type.fins.pectoral || 0.2) * 0.62 * (0.7 + 0.3 * props.fin);
  return finSurface({
    cols: 8,
    rows: 3,
    base: (t) => [0, (t - 0.5) * size * 0.5, 0],
    tip: (t) => [
      -size * (0.75 + 0.25 * Math.sin(Math.PI * t)),
      (t - 0.5) * size * 1.5,
      0.002
    ],
    curveZ: 0.01,
    waveBase: 0.08,
    waveTip: 0.22,
    phase: 2.2,
    colorBase: palette.body,
    colorTip: palette.fin,
    rayStrength: 0.1
  });
}

/** 腹鳍： belly 下方的一对小鱼鳍。 */
function pelvicGeometry(type, palette, profile, baseX = 0.1) {
  const u = clamp((baseX + 0.46) / 0.96, 0, 1);
  const s = bodySection(u, type.body, profile);
  const y = s.cy - s.ry * 0.98;
  const size = (type.body.depth || 0.4) * 0.28;
  return finSurface({
    cols: 4,
    rows: 2,
    base: (t) => [baseX - 0.06 * t, y, (t - 0.5) * 0.01],
    tip: (t) => [baseX - 0.09 - 0.03 * t, y - size * (1 - 0.35 * t), 0.006],
    curveZ: 0.006,
    waveBase: 0.25,
    waveTip: 0.4,
    phase: 1.9,
    colorBase: palette.body,
    colorTip: palette.fin,
    rayStrength: 0.08
  });
}

// ------------------------------------------------------------------ 胡须

function barbelGeometry(count, type, profile, palette) {
  const positions = [];
  const colors = [];
  const wave = [];
  const bend = [];
  const phases = [];
  const indices = [];
  const c = new THREE.Color(palette.fin);
  for (let i = 0; i < count; i += 1) {
    const side = i % 2 === 0 ? 1 : -1;
    const pair = Math.floor(i / 2);
    const u = 0.93;
    const s = bodySection(u, type.body, profile);
    const baseX = s.x;
    const baseY = s.cy - s.ry * 0.35 - pair * 0.012;
    const baseZ = side * s.rz * 0.65;
    const len = 0.11 - pair * 0.02;
    const seg = 5;
    const start = positions.length / 3;
    for (let k = 0; k <= seg; k += 1) {
      const q = k / seg;
      const x = baseX + len * q * 0.5;
      const y = baseY - len * q * 0.9;
      const z = baseZ + side * len * q * 0.3;
      const w = 0.008 * (1 - q * 0.7);
      positions.push(x, y, z - w, x, y, z + w);
      colors.push(c.r, c.g, c.b, c.r, c.g, c.b);
      wave.push(0.05, 0.05);
      bend.push(0.05);
      phases.push(0.6);
    }
    for (let k = 0; k < seg; k += 1) {
      const a = start + k * 2;
      indices.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  geo.setAttribute('aWave', new THREE.Float32BufferAttribute(wave, 1));
  geo.setAttribute('aPhase', new THREE.Float32BufferAttribute(phases, 1));
  geo.setAttribute('aBend', new THREE.Float32BufferAttribute(bend, 1));
  geo.setAttribute('aFinOffset', new THREE.Float32BufferAttribute(new Array((positions.length / 3) * 2).fill(0), 2));
  geo.setIndex(indices);
  geo.computeVertexNormals();
  return geo;
}

// ------------------------------------------------------------------ 合并

/** 合并同材质的鳍几何（保留颜色与摆动属性），减少 draw call。 */
export function mergeGeometries(list) {
  const attrs = ['position', 'normal', 'color', 'aWave', 'aPhase', 'aBend', 'aFinOffset'];
  const out = new THREE.BufferGeometry();
  const buffers = {};
  let vertexCount = 0;
  let indexCount = 0;
  for (const geo of list) {
    vertexCount += geo.getAttribute('position').count;
    indexCount += geo.getIndex() ? geo.getIndex().count : geo.getAttribute('position').count;
  }
  for (const name of attrs) {
    const size = name === 'aFinOffset' ? 2 : name === 'position' || name === 'normal' || name === 'color' ? 3 : 1;
    buffers[name] = new Float32Array(vertexCount * size);
  }
  const indices = new Uint32Array(indexCount);
  let vOffset = 0;
  let iOffset = 0;
  for (const geo of list) {
    const count = geo.getAttribute('position').count;
    for (const name of attrs) {
      const attr = geo.getAttribute(name);
      if (!attr) continue;
      buffers[name].set(attr.array.subarray(0, count * attr.itemSize), vOffset * attr.itemSize);
    }
    const index = geo.getIndex();
    if (index) {
      for (let i = 0; i < index.count; i += 1) indices[iOffset + i] = index.getX(i) + vOffset;
      iOffset += index.count;
    } else {
      for (let i = 0; i < count; i += 1) indices[iOffset + i] = vOffset + i;
      iOffset += count;
    }
    vOffset += count;
  }
  for (const name of attrs) {
    const itemSize = name === 'aFinOffset' ? 2 : name === 'position' || name === 'normal' || name === 'color' ? 3 : 1;
    out.setAttribute(name, new THREE.Float32BufferAttribute(buffers[name], itemSize));
  }
  out.setIndex(new THREE.BufferAttribute(indices, 1));
  out.computeVertexNormals();
  return out;
}

// ------------------------------------------------------------------ 材质：游动变形 + 湿润鳞面

function injectFishShader(material, uniforms, { fins = false } = {}) {
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>
        uniform float uTime;
        uniform float uPhase;
        uniform float uAmp;
        uniform float uFreq;
        uniform float uBend;
        uniform float uFinScale;
        attribute float aWave;
        attribute float aPhase;
        attribute float aBend;
        attribute vec2 aFinOffset;`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        float mofishAng = uPhase + aPhase - uTime * uFreq;
        float mofishWave = sin(mofishAng) * aWave * uAmp;
        transformed.z += mofishWave;
        transformed.x += cos(mofishAng) * aWave * uAmp * 0.06;
        transformed.z += uBend * aBend * 0.13 * (0.3 + aWave);
        transformed.xy += aFinOffset * (uFinScale - 1.0);`);
    if (!fins) {
      // 用 fragment 里的 view-space normal（flatShading 时没有 vNormal），避免着色器编译失败。
      shader.fragmentShader = shader.fragmentShader.replace('#include <dithering_fragment>', `#include <dithering_fragment>
        float mofishRim = pow(1.0 - clamp(abs(dot(normalize(normal), normalize(vViewPosition))), 0.0, 1.0), 2.6);
        gl_FragColor.rgb *= mix(1.0, 0.6, mofishRim);`);
    }
  };
  material.customProgramCacheKey = () => (fins ? 'mofish-fish-fin-v2' : 'mofish-fish-body-v2');
}

export function makeFishMaterials(appearance) {
  const bodyUniforms = {
    uTime: { value: 0 }, uPhase: { value: appearance.phase }, uAmp: { value: 0.05 },
    uFreq: { value: 2.4 }, uBend: { value: 0 }, uFinScale: { value: 1 }
  };
  const finUniforms = {
    uTime: { value: 0 }, uPhase: { value: appearance.phase + 0.8 }, uAmp: { value: 0.05 },
    uFreq: { value: 2.4 }, uBend: { value: 0 }, uFinScale: { value: 1 }
  };
  const body = new THREE.MeshPhysicalMaterial({
    color: 0xffffff,
    vertexColors: true,
    roughness: 0.36,
    metalness: 0.04,
    flatShading: true,
    clearcoat: 0.55,
    clearcoatRoughness: 0.42,
    sheen: 0.25,
    sheenRoughness: 0.6,
    sheenColor: new THREE.Color(appearance.accent)
  });
  injectFishShader(body, bodyUniforms, { fins: false });
  const fins = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    vertexColors: true,
    roughness: 0.58,
    metalness: 0.0,
    flatShading: true,
    transparent: true,
    opacity: 0.9,
    side: THREE.DoubleSide,
    depthWrite: true
  });
  injectFishShader(fins, finUniforms, { fins: true });
  const eye = new THREE.MeshPhysicalMaterial({ color: '#101c1e', roughness: 0.18, metalness: 0.15, clearcoat: 0.8 });
  const glint = new THREE.MeshBasicMaterial({ color: '#f4fbf7' });
  return { body, fins, eye, glint, bodyUniforms, finUniforms };
}

/**
 * 组装一条可动的鱼：身体 + 鳍 + 胸鳍 + 眼睛（含高光点）+ 选项胡须。
 * group.userData 里保存着色器 uniform 与动画所需状态。
 */
export function createFishMesh(type, appearance, growth, quality) {
  const props = {
    fin: clamp(0.5 + 0.5 * Math.pow(clamp(growth / 0.7, 0, 1), 0.85), 0, 1)
  };
  const profile = profileOf(type);
  const palette = buildPatternPalette(appearance);
  const bodyGeo = buildBodyGeometry(type, growth, quality, appearance);
  const finsGeo = mergeGeometries([
    tailGeometry(type, props, palette),
    dorsalGeometry(type, props, palette, profile),
    analGeometry(type, props, palette, profile),
    pelvicGeometry(type, palette, profile, 0.12)
  ]);
  const pectoralGeo = pectoralGeometry(type, props, palette);
  const barbels = (type.fins.barbels || 0) > 0 ? barbelGeometry(type.fins.barbels, type, profile, palette) : null;

  const mats = makeFishMaterials(appearance);
  const group = new THREE.Group();

  const bodyMesh = new THREE.Mesh(bodyGeo, mats.body);
  bodyMesh.castShadow = quality === 'high';
  group.add(bodyMesh);

  const finMesh = new THREE.Mesh(finsGeo, mats.fins);
  finMesh.castShadow = false;
  group.add(finMesh);

  if (barbels) group.add(new THREE.Mesh(barbels, mats.fins));

  const pectoralMat = mats.fins.clone();
  pectoralMat.onBeforeCompile = mats.fins.onBeforeCompile;
  pectoralMat.customProgramCacheKey = () => 'mofish-fish-fin-v2';
  const pectoralL = new THREE.Mesh(pectoralGeo, pectoralMat);
  const pectoralR = new THREE.Mesh(pectoralGeo, pectoralMat);
  const gill = bodySection(0.76, type.body, profile);
  const sideZ = gill.rz * 0.92;
  pectoralL.position.set(0.16, gill.cy - gill.ry * 0.12, sideZ);
  pectoralL.rotation.set(0.2, -0.85, -0.25);
  pectoralR.position.set(0.16, gill.cy - gill.ry * 0.12, -sideZ);
  pectoralR.rotation.set(-0.2, Math.PI + 0.85, 0.25);
  group.add(pectoralL, pectoralR);

  // 眼睛：浅色巩膜环 + 深色瞳孔 + 高光点（低多边形鱼最抓人的细节就是这圈眼白）
  const eyeSection = bodySection(0.925, type.body, profile);
  const eyeR = 0.07 * (0.85 + (type.body.head || 0.6) * 0.3) * (0.92 + props.fin * 0.08);
  const eyeY = eyeSection.cy + eyeSection.ry * 0.3;
  const eyeZ = eyeSection.rz * 0.74;
  const eyeGeo = new THREE.SphereGeometry(1, quality === 'high' ? 16 : 10, quality === 'high' ? 12 : 8);
  const pupilGeo = new THREE.SphereGeometry(1, 12, 8);
  const glintGeo = new THREE.SphereGeometry(1, 8, 6);
  const scleraMat = new THREE.MeshPhysicalMaterial({ color: appearance.belly, roughness: 0.32, clearcoat: 0.5 });
  for (const side of [1, -1]) {
    const sclera = new THREE.Mesh(eyeGeo, scleraMat);
    sclera.position.set(eyeSection.x - 0.006, eyeY, side * eyeZ);
    sclera.scale.setScalar(eyeR);
    group.add(sclera);
    const pupil = new THREE.Mesh(pupilGeo, mats.eye);
    pupil.position.set(eyeSection.x + 0.006, eyeY, side * (eyeZ + eyeR * 0.45));
    pupil.scale.setScalar(eyeR * 0.62);
    group.add(pupil);
    const glint = new THREE.Mesh(glintGeo, mats.glint);
    glint.position.set(eyeSection.x + 0.012, eyeY + eyeR * 0.26, side * (eyeZ + eyeR * 0.8));
    glint.scale.setScalar(eyeR * 0.22);
    group.add(glint);
  }

  group.userData = {
    type, appearance, bodyMesh, finMesh, pectoralL, pectoralR,
    bodyUniforms: mats.bodyUniforms, finUniforms: mats.finUniforms, pectoralMat,
    materials: [mats.body, mats.fins, mats.eye, mats.glint, scleraMat, pectoralMat],
    geometries: [bodyGeo, finsGeo, pectoralGeo, barbels, eyeGeo, glintGeo].filter(Boolean),
    growth
  };
  return group;
}

/** 释放一条鱼占用的 GPU 资源（反复切换画质/进出场景时不能靠 GC）。 */
export function disposeFish(group) {
  if (!group) return;
  const data = group.userData || {};
  (data.geometries || []).forEach((g) => g.dispose?.());
  (data.materials || []).forEach((m) => m.dispose?.());
  group.traverse((child) => {
    if (child.isMesh && child.geometry && !(data.geometries || []).includes(child.geometry)) child.geometry.dispose?.();
  });
  group.clear();
}
