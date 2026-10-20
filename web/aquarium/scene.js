// 3D 鱼缸场景：本机 GPU 实时渲染，无外部模型/贴图/字体/远程资源。
//
// 结构：五块有厚度的无边框玻璃 + 沙底 + 水面，开口向上，相机在缸外前半空间内受限环绕。
// 光影走「柔和主光 + 环境补光 + 接触阴影 + 水面高光 + 水下焦散」的组合，
// 高画质开启阴影贴图与焦散，低画质关闭阴影、降低像素比与粒子数量。
import * as THREE from 'three';
import { createGlassTank, GLASS_THICKNESS } from './glass.js';

export const TANK = Object.freeze({
  width: 4.4,
  height: 2.3,
  depth: 2.0,
  waterY: 2.14,
  sandY: 0,
  front: 1.0
});

export function sandHeightAt(x, z) {
  return TANK.sandY + Math.sin(x * 1.1 + z * 0.7) * 0.035 + Math.sin(x * 2.3 - z * 1.4) * 0.018 + 0.02;
}

export function tankFitScale(aspect) {
  // Match the default camera's 42° vertical field of view and 0.32 pitch.
  const halfFov = Math.tan(THREE.MathUtils.degToRad(42 / 2));
  const halfWidth = TANK.width / 2 + GLASS_THICKNESS + 0.08;
  const fitDistance = (TANK.depth / 2 + GLASS_THICKNESS
    + halfWidth * 1.06 / (halfFov * Math.max(0.2, aspect))) / Math.cos(0.32);
  return Math.max(1, fitDistance / 5.1);
}

export const QUALITY = {
  high: {
    pixelRatio: 2,
    shadows: true,
    shadowSize: 2048,
    antialias: true,
    caustics: true,
    motes: 140,
    fishSegments: 'high',
    decorDetail: 'high'
  },
  low: {
    pixelRatio: 1.5,
    shadows: false,
    shadowSize: 512,
    antialias: false,
    caustics: false,
    motes: 46,
    fishSegments: 'low',
    decorDetail: 'low'
  }
};

const DAY = {
  bg: new THREE.Color('#ecf2e9'),
  fog: new THREE.Color('#d3e9df'),
  water: new THREE.Color('#a2e2d1'),
  key: new THREE.Color('#fff8ea'),
  fill: new THREE.Color('#cdeee2'),
  hemiSky: new THREE.Color('#f2fbf6'),
  hemiGround: new THREE.Color('#c8b48f'),
  exposure: 1.14
};

const NIGHT = {
  bg: new THREE.Color('#172c33'),
  fog: new THREE.Color('#122730'),
  water: new THREE.Color('#2f5860'),
  key: new THREE.Color('#9fc6d8'),
  fill: new THREE.Color('#3f7a86'),
  hemiSky: new THREE.Color('#2b4a55'),
  hemiGround: new THREE.Color('#16262b'),
  exposure: 0.9
};

function gradientTexture(colors) {
  const canvas = document.createElement('canvas');
  canvas.width = 2;
  canvas.height = 256;
  const ctx = canvas.getContext('2d');
  const grad = ctx.createLinearGradient(0, 0, 0, 256);
  colors.forEach(([stop, color]) => grad.addColorStop(stop, color));
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, 2, 256);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function blobShadowTexture() {
  const canvas = document.createElement('canvas');
  canvas.width = 64;
  canvas.height = 64;
  const ctx = canvas.getContext('2d');
  const grad = ctx.createRadialGradient(32, 32, 2, 32, 32, 30);
  grad.addColorStop(0, 'rgba(12,30,30,0.34)');
  grad.addColorStop(0.55, 'rgba(12,30,30,0.16)');
  grad.addColorStop(1, 'rgba(12,30,30,0)');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(canvas);
}

const WATER_VERT = `
  varying vec3 vWorld;
  varying vec2 vUv;
  void main() {
    vUv = uv;
    vec4 world = modelMatrix * vec4(position, 1.0);
    vWorld = world.xyz;
    gl_Position = projectionMatrix * viewMatrix * world;
  }
`;

const WATER_FRAG = `
  precision highp float;
  varying vec3 vWorld;
  varying vec2 vUv;
  uniform float uTime;
  uniform float uNight;
  uniform vec3 uColor;
  uniform vec3 uKeyColor;
  void main() {
    vec2 p = vWorld.xz * 1.35;
    float t = uTime;
    vec3 n = normalize(vec3(
      cos(p.x * 2.2 + t * 0.9) * 0.07 + cos((p.x + p.y) * 3.1 - t * 1.3) * 0.04,
      1.0,
      cos(p.y * 2.6 - t * 0.8) * 0.07 + cos((p.x - p.y) * 2.4 + t * 1.1) * 0.04
    ));
    vec3 V = normalize(cameraPosition - vWorld);
    float fres = pow(1.0 - clamp(dot(V, n), 0.0, 1.0), 2.2);
    vec3 L = normalize(vec3(0.25, 1.0, 0.4));
    float spec = pow(max(dot(reflect(-L, n), V), 0.0), 64.0);
    vec3 col = mix(uColor, vec3(1.0), fres * 0.32 + spec * 0.35);
    col = mix(col, uKeyColor, 0.18);
    float alpha = (0.10 + fres * 0.16 + spec * 0.18) * (1.0 - uNight * 0.28);
    gl_FragColor = vec4(col, alpha);
  }
`;

const CAUSTIC_FRAG = `
  precision highp float;
  varying vec3 vWorld;
  uniform float uTime;
  uniform float uNight;
  uniform vec3 uColor;
  void main() {
    vec2 uv = vWorld.xz;
    float t = uTime;
    float a = sin(uv.x * 7.2 + t * 0.6) * sin(uv.y * 6.4 - t * 0.5);
    float b = sin((uv.x + uv.y) * 4.6 - t * 0.38) * sin((uv.x - uv.y) * 5.3 + t * 0.32);
    float c = smoothstep(0.35, 1.0, a) * 0.6 + smoothstep(0.4, 1.0, b) * 0.4;
    float fade = smoothstep(0.0, 0.55, uv.y + 0.9);
    float alpha = c * 0.05 * (1.0 - uNight * 0.5) * (0.6 + fade * 0.5);
    gl_FragColor = vec4(uColor, alpha);
  }
`;

const SHAFT_FRAG = `
  precision highp float;
  varying vec3 vWorld;
  varying vec2 vUv;
  uniform float uTime;
  uniform float uNight;
  void main() {
    float sway = sin(vUv.x * 3.0 + uTime * 0.25) * 0.06;
    float x = abs(vUv.x - 0.5 + sway);
    float horizontal = smoothstep(0.5, 0.02, x);
    float vertical = smoothstep(0.0, 0.35, vUv.y) * smoothstep(1.0, 0.55, vUv.y);
    float alpha = horizontal * vertical * 0.055 * (1.0 - uNight * 0.55);
    gl_FragColor = vec4(vec3(1.0, 0.98, 0.9), alpha);
  }
`;

const SIMPLE_VERT = `
  varying vec3 vWorld;
  varying vec2 vUv;
  void main() {
    vUv = uv;
    vec4 world = modelMatrix * vec4(position, 1.0);
    vWorld = world.xyz;
    gl_Position = projectionMatrix * viewMatrix * world;
  }
`;

function makeWaterMaterial() {
  return new THREE.ShaderMaterial({
    vertexShader: WATER_VERT,
    fragmentShader: WATER_FRAG,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    uniforms: {
      uTime: { value: 0 },
      uNight: { value: 0 },
      uColor: { value: DAY.water.clone() },
      uKeyColor: { value: DAY.key.clone() }
    }
  });
}

function makeCausticMaterial() {
  return new THREE.ShaderMaterial({
    vertexShader: SIMPLE_VERT,
    fragmentShader: CAUSTIC_FRAG,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
    uniforms: {
      uTime: { value: 0 },
      uNight: { value: 0 },
      uColor: { value: new THREE.Color('#eaf7d8') }
    }
  });
}

function makeShaftMaterial() {
  return new THREE.ShaderMaterial({
    vertexShader: SIMPLE_VERT,
    fragmentShader: SHAFT_FRAG,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
    uniforms: { uTime: { value: 0 }, uNight: { value: 0 } }
  });
}

/**
 * 建场景。返回的对象由 view3d 持有；dispose() 必须能释放全部 GPU 资源，
 * 因为用户可能在 2D/3D 之间反复切换（要求：切换后内存不能持续上涨）。
 */
export function createTankScene({ canvas, quality = 'high' }) {
  const settings = QUALITY[quality] || QUALITY.high;
  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: settings.antialias,
    alpha: false,
    powerPreference: 'high-performance',
    preserveDrawingBuffer: false
  });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, settings.pixelRatio));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = DAY.exposure;
  renderer.shadowMap.enabled = settings.shadows;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;

  const scene = new THREE.Scene();
  scene.background = DAY.bg.clone();
  scene.fog = new THREE.FogExp2(DAY.fog.getHex(), 0.075);

  const camera = new THREE.PerspectiveCamera(42, 1, 0.1, 80);
  camera.position.set(0, 1.5, 5.1);

  // ---------------------------------------------------------------- 灯光
  const hemi = new THREE.HemisphereLight(DAY.hemiSky.getHex(), DAY.hemiGround.getHex(), 1.15);
  scene.add(hemi);

  const key = new THREE.DirectionalLight(DAY.key.getHex(), 2.15);
  key.position.set(1.4, 6.2, 3.4);
  key.castShadow = settings.shadows;
  key.shadow.mapSize.set(settings.shadowSize, settings.shadowSize);
  key.shadow.camera.left = -3.2;
  key.shadow.camera.right = 3.2;
  key.shadow.camera.top = 3.0;
  key.shadow.camera.bottom = -0.6;
  key.shadow.camera.near = 0.5;
  key.shadow.camera.far = 14;
  key.shadow.bias = -0.0012;
  key.shadow.radius = 2;
  scene.add(key);

  const fill = new THREE.DirectionalLight(DAY.fill.getHex(), 0.45);
  fill.position.set(-3.2, 2.4, 2.0);
  scene.add(fill);

  const rim = new THREE.PointLight(DAY.key.getHex(), 2.0, 9, 2);
  rim.position.set(0, 2.6, -0.8);
  scene.add(rim);

  // ---------------------------------------------------------------- 缸体
  const tankGroup = new THREE.Group();
  scene.add(tankGroup);

  const wallMat = new THREE.MeshBasicMaterial({
    map: gradientTexture([
      [0, '#d4e9dd'],
      [0.35, '#9acdbb'],
      [0.75, '#72ac9d'],
      [1, '#508b80']
    ]),
    toneMapped: false,
    side: THREE.DoubleSide
  });
  const wallBaseColor = wallMat.color.clone();
  const backWall = new THREE.Mesh(new THREE.PlaneGeometry(TANK.width, TANK.height), wallMat);
  backWall.position.set(0, TANK.height / 2, -TANK.depth / 2 - GLASS_THICKNESS - 0.015);
  tankGroup.add(backWall);

  // 沙面：轻微起伏，顶点色做深浅过渡，接收阴影。
  const sandGeo = new THREE.PlaneGeometry(TANK.width, TANK.depth, 48, 26);
  sandGeo.rotateX(-Math.PI / 2);
  const sandPos = sandGeo.getAttribute('position');
  const sandColors = [];
  const cSand = new THREE.Color('#e6d6b4');
  const cSandDeep = new THREE.Color('#b8aa88');
  for (let i = 0; i < sandPos.count; i += 1) {
    const x = sandPos.getX(i);
    const z = sandPos.getZ(i);
    sandPos.setY(i, sandHeightAt(x, z) - TANK.sandY);
    const shade = clamp01(0.5 + Math.sin(x * 0.8) * 0.2 - z * 0.12);
    const color = cSand.clone().lerp(cSandDeep, shade * 0.55);
    sandColors.push(color.r, color.g, color.b);
  }
  sandGeo.setAttribute('color', new THREE.Float32BufferAttribute(sandColors, 3));
  sandGeo.computeVertexNormals();
  const sand = new THREE.Mesh(sandGeo, new THREE.MeshStandardMaterial({
    vertexColors: true, roughness: 0.96, metalness: 0
  }));
  sand.receiveShadow = settings.shadows;
  sand.position.set(0, TANK.sandY, 0);
  sand.userData.kind = 'sand';
  tankGroup.add(sand);

  // 沙面碎卵石：固定种子，刷新/切换画质都保持同一批（不进入存档，也不影响操作）
  {
    let seed = 90210;
    const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
    const count = settings.caustics ? 46 : 22;
    const geo = new THREE.DodecahedronGeometry(0.028, 0);
    const mat = new THREE.MeshStandardMaterial({ color: '#b9ad90', roughness: 0.95, metalness: 0, flatShading: true, vertexColors: false });
    const pebbles = new THREE.InstancedMesh(geo, mat, count);
    const dummy = new THREE.Object3D();
    for (let i = 0; i < count; i += 1) {
      dummy.position.set((rnd() - 0.5) * TANK.width * 0.92, 0.03, (rnd() - 0.5) * TANK.depth * 0.9);
      dummy.rotation.set(rnd() * 3, rnd() * 3, rnd() * 3);
      const s2 = 0.5 + rnd() * 1.2;
      dummy.scale.set(s2, s2 * (0.5 + rnd() * 0.4), s2);
      dummy.updateMatrix();
      pebbles.setMatrixAt(i, dummy.matrix);
    }
    pebbles.receiveShadow = settings.shadows;
    pebbles.instanceMatrix.needsUpdate = true;
    tankGroup.add(pebbles);
  }

  // 水面
  const waterGeo = new THREE.PlaneGeometry(TANK.width, TANK.depth, 1, 1);
  waterGeo.rotateX(-Math.PI / 2);
  const waterMat = makeWaterMaterial();
  const water = new THREE.Mesh(waterGeo, waterMat);
  water.position.set(0, TANK.waterY, 0);
  water.renderOrder = 3;
  tankGroup.add(water);

  // 水下焦散：贴沙面的加色平面，用极轻的图案暗示光斑（不做昂贵流体）。
  let caustics = null;
  if (settings.caustics) {
    const geo = new THREE.PlaneGeometry(TANK.width * 0.98, TANK.depth * 0.98, 1, 1);
    geo.rotateX(-Math.PI / 2);
    caustics = new THREE.Mesh(geo, makeCausticMaterial());
    caustics.position.set(0, TANK.sandY + 0.09, 0);
    caustics.renderOrder = 2;
    tankGroup.add(caustics);
  }

  // 光柱：几片从水面斜向下的柔和渐变，夜间自动变暗。
  const shafts = [];
  const shaftMats = [];
  const shaftPositions = new WeakMap();
  const shaftCount = settings.caustics ? 3 : 0;
  for (let i = 0; i < shaftCount; i += 1) {
    const mat = makeShaftMaterial();
    shaftMats.push(mat);
    const geo = new THREE.PlaneGeometry(0.9 + i * 0.22, TANK.height * 1.15, 1, 1);
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(-1.1 + i * 1.05, TANK.height * 0.48, -0.25 + i * 0.12);
    mesh.rotation.z = 0.18 - i * 0.08;
    mesh.renderOrder = 4;
    shaftPositions.set(mesh, { baseX: mesh.position.x, phase: i * 1.7 });
    shafts.push(mesh);
    tankGroup.add(mesh);
  }

  const glassTank = createGlassTank(TANK, { quality });
  const glass = glassTank.group;
  tankGroup.add(glass);


  // ---------------------------------------------------------------- 微粒
  const moteCount = settings.motes;
  const motePositions = new Float32Array(moteCount * 3);
  const moteSeeds = new Float32Array(moteCount);
  for (let i = 0; i < moteCount; i += 1) {
    motePositions[i * 3] = (Math.random() - 0.5) * TANK.width * 0.94;
    motePositions[i * 3 + 1] = 0.15 + Math.random() * (TANK.height - 0.4);
    motePositions[i * 3 + 2] = (Math.random() - 0.5) * TANK.depth * 0.8;
    moteSeeds[i] = Math.random() * 100;
  }
  const moteGeo = new THREE.BufferGeometry();
  moteGeo.setAttribute('position', new THREE.Float32BufferAttribute(motePositions, 3));
  const moteMat = new THREE.PointsMaterial({
    color: '#eef7e6', size: 0.016, transparent: true, opacity: 0.5,
    depthWrite: false, blending: THREE.AdditiveBlending, sizeAttenuation: true
  });
  const motes = new THREE.Points(moteGeo, moteMat);
  tankGroup.add(motes);

  const shadowTex = blobShadowTexture();
  const blobMat = new THREE.MeshBasicMaterial({ map: shadowTex, transparent: true, opacity: 0.62, depthWrite: false });

  // ---------------------------------------------------------------- 相机控制
  const cameraState = { yaw: 0, pitch: 0.32, distance: 5.1, target: new THREE.Vector3(0, 0.98, 0) };
  let fitScale = 1;
  const LIMITS = { yaw: 0.62, pitchMin: 0.02, pitchMax: 0.62, distMin: 3.6, distMax: 7.2 };
  let night = 0;
  let nightTarget = 0;
  let elapsed = 0;
  let disposed = false;

  function applyCamera() {
    const yaw = cameraState.yaw;
    const pitch = cameraState.pitch;
    const d = cameraState.distance * fitScale;
    const x = Math.sin(yaw) * Math.cos(pitch) * d;
    const y = cameraState.target.y + Math.sin(pitch) * d;
    const z = Math.cos(yaw) * Math.cos(pitch) * d + 0.15;
    camera.position.set(x, y, z);
    camera.lookAt(cameraState.target);
  }
  applyCamera();

  function orbit(dx, dy) {
    cameraState.yaw = clamp(cameraState.yaw + dx * 0.85, -LIMITS.yaw, LIMITS.yaw);
    cameraState.pitch = clamp(cameraState.pitch + dy * 0.6, LIMITS.pitchMin, LIMITS.pitchMax);
    applyCamera();
  }
  function zoom(factor) {
    cameraState.distance = clamp(cameraState.distance * factor, LIMITS.distMin, LIMITS.distMax);
    applyCamera();
  }
  function resetCamera() {
    cameraState.yaw = 0;
    cameraState.pitch = 0.32;
    cameraState.distance = 5.1;
    applyCamera();
  }

  function resize(width, height) {
    if (width < 2 || height < 2) return;
    camera.aspect = width / height;
    // Fit the nearest front rim, rather than a plane through the tank centre.
    // Otherwise portrait screens clip both glass corners despite fitting fish.
    fitScale = tankFitScale(camera.aspect);
    scene.fog.density = 0.075 / fitScale;
    applyCamera();
    camera.updateProjectionMatrix();
    renderer.setSize(width, height, false);
  }

  function setNight(on) {
    nightTarget = on ? 1 : 0;
  }

  function applyNight(value) {
    night = value;
    const from = DAY;
    const to = NIGHT;
    scene.background.copy(from.bg).lerp(to.bg, value);
    scene.fog.color.copy(from.fog).lerp(to.fog, value);
    hemi.color.copy(from.hemiSky).lerp(to.hemiSky, value);
    hemi.groundColor.copy(from.hemiGround).lerp(to.hemiGround, value);
    hemi.intensity = 1.15 - value * 0.76;
    key.color.copy(from.key).lerp(to.key, value);
    key.intensity = 2.15 - value * 1.48;
    fill.color.copy(from.fill).lerp(to.fill, value);
    fill.intensity = 0.45 - value * 0.2;
    rim.color.copy(from.key).lerp(to.key, value);
    rim.intensity = 2.0 - value * 1.5;
    renderer.toneMappingExposure = from.exposure + (to.exposure - from.exposure) * value;
    tankGroup.traverse((obj) => {
      if (obj.material && obj.material.uniforms) {
        if (obj.material.uniforms.uNight) obj.material.uniforms.uNight.value = value;
        if (obj.material.uniforms.uColor && obj.material === waterMat) {
          obj.material.uniforms.uColor.value.copy(DAY.water).lerp(NIGHT.water, value);
        }
      }
    });
    wallMat.color.copy(wallBaseColor).lerp(new THREE.Color('#7d9a9a'), value * 0.55);
    glassTank.setNight(value);
  }
  applyNight(0);

  function update(dt, time) {
    elapsed = time;
    if (night !== nightTarget) {
      const step = Math.min(1, dt * 1.6);
      applyNight(night + (nightTarget - night) * step);
      if (Math.abs(nightTarget - night) < 0.01) applyNight(nightTarget);
    }
    waterMat.uniforms.uTime.value = time;
    if (caustics) caustics.material.uniforms.uTime.value = time;
    shaftMats.forEach((m) => { m.uniforms.uTime.value = time; });
    shafts.forEach((mesh) => {
      const info = shaftPositions.get(mesh);
      mesh.position.x = info.baseX + Math.sin(time * 0.22 + info.phase) * 0.12;
    });
    // 微粒缓慢漂浮
    const pos = moteGeo.getAttribute('position');
    for (let i = 0; i < moteCount; i += 1) {
      const seed = moteSeeds[i];
      pos.setY(i, pos.getY(i) + dt * (0.018 + (i % 5) * 0.006));
      if (pos.getY(i) > TANK.height - 0.15) pos.setY(i, 0.12);
      pos.setX(i, pos.getX(i) + Math.sin(time * 0.3 + seed) * dt * 0.012);
    }
    pos.needsUpdate = true;
    renderer.render(scene, camera);
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    const geometries = new Set(), materials = new Set(), textures = new Set();
    scene.traverse((obj) => {
      if (obj.geometry) geometries.add(obj.geometry);
      const mat = obj.material;
      for (const material of Array.isArray(mat) ? mat : mat ? [mat] : []) {
        materials.add(material);
        Object.values(material).forEach((v) => { if (v && v.isTexture) textures.add(v); });
      }
    });
    textures.add(shadowTex);
    textures.forEach(texture => texture.dispose());
    materials.forEach(material => material.dispose());
    geometries.forEach(geometry => geometry.dispose());
    renderer.dispose();
    renderer.forceContextLoss?.();
  }

  return {
    renderer, scene, camera, tankGroup, sand, glass, water, caustics,
    blobMaterial: blobMat, shadowTexture: shadowTex,
    settings, cameraState,
    orbit, zoom, resetCamera, resize, update, setNight, dispose,
    get elapsed() { return elapsed; },
    get night() { return night; }
  };
}

function clamp01(v) { return Math.min(1, Math.max(0, v)); }
function clamp(v, a, b) { return Math.min(b, Math.max(a, v)); }
