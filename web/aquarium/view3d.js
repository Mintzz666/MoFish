// 3D 视图：把领域状态（fish/decor）映射成场景对象，并处理相机、选取、布景拖拽与喂食。
//
// 分工：
// - 状态（鱼的成长/名字/造景变换）只由 app.js 修改；本文件只读状态并调用回调报告交互。
// - 每帧只更新 uniform / transform，不重建几何；只有阶段变化或换 seed 才重建单个对象。
// - 所有 GPU 资源都能通过 dispose() 释放，供画质切换、2D 降级和页面卸载时使用。
import * as THREE from 'three';
import { TANK, QUALITY, createTankScene, sandHeightAt } from './scene.js';
import { createFishMesh, disposeFish } from './fish.js';
import { createDecorMesh, disposeDecor } from './decor.js';
import { FISH_TYPE_BY_ID, DECOR_KINDS } from '../catalog.js';
import { fishAppearance, decorAppearance, fishSizeFactor, stageOf } from '../model.js';
import { advanceMotion, damp, mixHeading, smoothstep, stepHeading } from './motion.js';
import { createRenderPolicy } from '../render-policy.js';

const FISH_RADIUS = 0.22;
const EAT_RADIUS = 0.12;
const MAX_FOOD = 40;
const TAU = Math.PI * 2;

const clamp = (n, a, b) => Math.min(b, Math.max(a, n));
const worldFromNormalized = (x, z) => ({
  x: (x - 0.5) * TANK.width * 0.9,
  z: (z - 0.5) * TANK.depth * 0.82
});

export function createView3D({
  canvas,
  quality = 'high',
  night = false,
  onEat = () => {},
  onPickFish = () => {},
  onPickDecor = () => {},
  onDecorMove = () => {},
  onDecorCommit = () => {},
  onError = () => {},
  onFeed = () => {},
  reduceMotion = false,
  canFeed = () => true
}) {
  const initialQuality = ['auto', 'low', 'high'].includes(quality) ? quality : 'high';
  const qualityKey = 'high'; // Geometry stays stable across effect-only quality changes.
  let currentQuality = initialQuality;
  const renderPolicy = createRenderPolicy();
  renderPolicy.setQualityPolicy(initialQuality);
  const listenerController = new AbortController();
  let scene3d = null;
  let disposed = false;
  let paused = false;
  let state = null;
  const agents = new Map();
  const decorNodes = new Map();
  const foodPool = [];
  const foods = [];
  const raycaster = new THREE.Raycaster();
  const pointer = new THREE.Vector2();
  const clock = { last: 0, time: 0 };
  let selection = null;         // 选中的造景 id
  let selectionRing = null;
  let highlightedNode = null;
  let mode = 'view';            // 'view' | 'decor'
  let playMode = false;
  let playPoint = null;
  let playPointerActive = false;
  let playTouchPointerId = null;
  let foodMesh = null;
  let foodDummy = new THREE.Object3D();
  let animationHandle = null;
  let dragState = null;
  let pointers = new Map();
  let lastPinch = 0;
  let nightTarget = night;
  let needsResize = true;
  let requestedVisible = true;
  let appliedEffectsLevel = -1;

  const now = () => globalThis.performance?.now?.() ?? Date.now();

  function settings() {
    const level = renderPolicy.effectsLevel;
    return {
      ...QUALITY[qualityKey],
      pixelRatio: [1, 1.25, 2][level] ?? 2,
      shadows: level > 0,
      caustics: level > 0,
      motes: level === 0 ? 46 : 140
    };
  }

  function applyEffectsLevel() {
    const level = renderPolicy.effectsLevel;
    if (appliedEffectsLevel === level) return;
    appliedEffectsLevel = level;
    scene3d?.setEffectsLevel(level);
    const shadows = level > 0;
    agents.forEach((agent) => {
      setFishCastShadow(agent, shadows);
    });
    decorNodes.forEach((node) => {
      const mesh = node.group.userData.mesh;
      if (mesh) {
        mesh.castShadow = shadows && node.item.kind !== 'plant';
        mesh.receiveShadow = shadows;
      }
    });
  }

  function setFishCastShadow(agent, enabled) {
    const body = agent.group.children.find((child) => child.isMesh);
    if (body) body.castShadow = enabled;
    const fishParts = agent.group.userData;
    fishParts.tailPivot?.children.forEach((child) => { if (child.isMesh) child.castShadow = enabled; });
    if (fishParts.pectoralL) fishParts.pectoralL.castShadow = enabled;
    if (fishParts.pectoralR) fishParts.pectoralR.castShadow = enabled;
  }

  function setQualityPolicy(policy) {
    renderPolicy.setQualityPolicy(policy);
    currentQuality = renderPolicy.performanceInfo.policy;
    applyEffectsLevel();
  }

  function setActivity(activity = {}) {
    if (Object.hasOwn(activity, 'visible')) requestedVisible = Boolean(activity.visible);
    renderPolicy.setActivity({
      visible: requestedVisible && !paused && !disposed,
      ...(Object.hasOwn(activity, 'interacting') ? { interacting: activity.interacting } : {})
    });
    if (requestedVisible && !paused && !disposed) start();
    else stop();
  }

  function notifyInteraction() {
    renderPolicy.notifyInteraction();
  }

  // ---------------------------------------------------------------- 初始化
  function init() {
    scene3d = createTankScene({ canvas, quality: qualityKey, reduceMotion, effectsLevel: renderPolicy.effectsLevel,
      powerPreference: initialQuality === 'high' ? 'high-performance' : 'low-power' });
    appliedEffectsLevel = renderPolicy.effectsLevel;
    scene3d.setNight(nightTarget ? 1 : 0);
    scene3d.resize(canvas.clientWidth || 800, canvas.clientHeight || 480);

    const foodGeo = new THREE.IcosahedronGeometry(0.016, 0);
    const foodMat = new THREE.MeshStandardMaterial({ color: '#e2c893', roughness: 0.8, emissive: '#7a6234', emissiveIntensity: 0.25 });
    foodMesh = new THREE.InstancedMesh(foodGeo, foodMat, MAX_FOOD);
    foodMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    foodMesh.count = 0;
    foodMesh.frustumCulled = false;
    scene3d.tankGroup.add(foodMesh);

    selectionRing = new THREE.Mesh(
      new THREE.RingGeometry(0.17, 0.2, 48),
      new THREE.MeshBasicMaterial({ color: '#ffdc78', transparent: true, opacity: 0.95, side: THREE.DoubleSide, depthWrite: false, depthTest: false, toneMapped: false })
    );
    selectionRing.rotation.x = -Math.PI / 2;
    selectionRing.visible = false;
    selectionRing.renderOrder = 11;
    const rim = new THREE.Mesh(
      new THREE.RingGeometry(0.158, 0.212, 48),
      new THREE.MeshBasicMaterial({ color: '#36594e', side: THREE.DoubleSide, depthWrite: false, depthTest: false, toneMapped: false })
    );
    rim.renderOrder = 10;
    selectionRing.add(rim);
    scene3d.tankGroup.add(selectionRing);

    start();
  }

  function onContextLost(event) {
    event.preventDefault();
    stop();
    onError('context-lost');
  }

  // ---------------------------------------------------------------- 状态同步
  function setState(next, { rebuildDecor = false } = {}) {
    state = next;
    if (!scene3d) return;
    syncFish(next.fish);
    syncDecor(next.decor, { rebuild: rebuildDecor });
    if (selection && !next.decor.some((d) => d.id === selection)) selectDecor(null);
    updateSelectionRing();
  }

  function syncFish(fishList) {
    const seen = new Set();
    fishList.forEach((fish, index) => {
      seen.add(fish.id);
      const type = FISH_TYPE_BY_ID[fish.species] || FISH_TYPE_BY_ID.sunset;
      let agent = agents.get(fish.id);
      if (!agent) {
        agent = createAgent(fish, type, index);
        agents.set(fish.id, agent);
        scene3d.tankGroup.add(agent.group);
      }
      const stage = stageOf(fish.growth);
      const stageIndex = stage.index;
      const needRebuild = agent.stageIndex !== stageIndex || agent.typeId !== type.id;
      const appearance = fishAppearance(fish);
      if (needRebuild) {
        rebuildAgentMesh(agent, fish, type, appearance, stageIndex);
      }
      agent.fish = fish;
      agent.appearance = appearance;
      const scale = type.body.len * fishSizeFactor(fish.growth) * appearance.lenScale * 1.2;
      agent.group.scale.setScalar(scale);
      if (agent.visualScale == null) agent.visualScale = scale;
      agent.visualScale = scale;
      agent.baseSpeed = type.motion.speed * 0.75 * appearance.tempo;
      agent.turnRate = type.motion.turn;
      agent.wag = type.motion.wag;
      agent.freq = type.motion.freq;
      agent.depthBias = type.motion.depthBias;
      agent.bob = type.motion.bob;
      agent.tailPivot = agent.group.userData.tailPivot;
    });
    for (const [id, agent] of agents) {
      if (!seen.has(id)) {
        disposeFish(agent.group);
        scene3d.tankGroup.remove(agent.group);
        agents.delete(id);
      }
    }
  }

  function createAgent(fish, type, index) {
    const appearance = fishAppearance(fish);
    const stageIndex = stageOf(fish.growth).index;
    const group = createFishMesh(type, appearance, fish.growth, settings().fishSegments);
    // 初始就铺开：沿缸宽均匀分布，深浅/高度按序错开，避免一开局挤成一团
    const spread = TANK.width * 0.78;
    const total = Math.max(1, state.fish.length);
    const slot = total <= 1 ? 0.5 : index / (total - 1);
    const y = 0.3 + type.motion.depthBias * (TANK.waterY - 0.8) + ((index % 3) - 1) * 0.16;
    group.position.set(-spread / 2 + slot * spread + (Math.random() - 0.5) * 0.25, Math.max(0.28, y), (Math.random() - 0.5) * (TANK.depth * 0.62));
    group.userData.fishId = fish.id;
    const agent = {
      id: fish.id, group, typeId: type.id, stageIndex, fish, appearance,
      heading: Math.random() < 0.5 ? 0 : Math.PI, speed: 0, bend: 0,
      y: group.position.y, phase: appearance.phase, index,
      baseSpeed: 0.4, turnRate: 1.5, wag: 0.6, freq: 2, depthBias: 0.5, bob: 0.06,
      wander: Math.random() * 100, bobPhase: Math.random() * TAU,
      cruise: null, cruiseFrom: null, cruiseTo: null, cruiseAge: 0,
      cruiseDuration: 7 + Math.random() * 3, cruiseBlendAge: 0, cruiseBlendDuration: 1.5,
      playWeight: 0, glide: 0, nextGlideAt: 11 + Math.random() * 12, glideUntil: 0,
      greetAt: -Infinity, visualScale: null,
      tailPivot: group.userData.tailPivot
    };
    setFishCastShadow(agent, renderPolicy.effectsLevel > 0);
    return agent;
  }

  function rebuildAgentMesh(agent, fish, type, appearance, stageIndex) {
    disposeFish(agent.group);
    // disposeFish 会清空 group 的子对象，但保留 group 本身与其变换。
    const fresh = createFishMesh(type, appearance, fish.growth, settings().fishSegments);
    while (fresh.children.length) agent.group.add(fresh.children[0]);
    agent.group.userData = fresh.userData;
    agent.group.userData.fishId = fish.id;
    setFishCastShadow(agent, renderPolicy.effectsLevel > 0);
    agent.stageIndex = stageIndex;
    agent.typeId = type.id;
    agent.tailPivot = fresh.userData.tailPivot;
  }

  function syncDecor(decorList, { rebuild = false } = {}) {
    const seen = new Set();
    decorList.forEach((item) => {
      seen.add(item.id);
      let node = decorNodes.get(item.id);
      const key = `${item.kind}:${item.type}:${item.seed}:${qualityKey}`;
      if (!node) {
        node = createDecorNode(item, key);
        decorNodes.set(item.id, node);
        scene3d.tankGroup.add(node.group);
      } else if (node.key !== key || rebuild) {
        disposeDecor(node.group);
        scene3d.tankGroup.remove(node.group);
        node = createDecorNode(item, key);
        decorNodes.set(item.id, node);
        scene3d.tankGroup.add(node.group);
      }
      node.item = item;
      applyDecorTransform(node, item);
    });
    for (const [id, node] of decorNodes) {
      if (!seen.has(id)) {
        disposeDecor(node.group);
        scene3d.tankGroup.remove(node.group);
        decorNodes.delete(id);
      }
    }
  }

  function createDecorNode(item, key) {
    const appearance = decorAppearance(item.kind, item.type, item.seed);
    const group = createDecorMesh(appearance, { quality: settings().decorDetail });
    group.userData.decorId = item.id;
    group.userData.appearance = appearance;
    const mesh = group.userData.mesh;
    if (mesh) {
      mesh.castShadow = settings().shadows && item.kind !== 'plant';
      mesh.receiveShadow = settings().shadows;
    }
    // Low effects use the sand's ambient shading. Never allocate a one-off blob
    // only for objects created after an automatic tier change.
    return { group, key, item };
  }

  function applyDecorTransform(node, item) {
    const world = worldFromNormalized(item.x, item.z);
    node.group.position.set(world.x, 0, world.z);
    node.group.rotation.y = Math.PI * 2 - item.rot;
    const appearance = node.group.userData.appearance;
    node.group.scale.setScalar(item.scale * (appearance?.scaleJitter ?? 1));
    const geometry = node.group.userData.geometry;
    if (!geometry.boundingBox) geometry.computeBoundingBox();
    // 沙面有起伏；让实际几何底部贴合当地沙面，避免矮石头被整个埋住。
    node.group.position.y = sandHeightAt(world.x, world.z) - geometry.boundingBox.min.y * node.group.scale.y;
  }

  // ---------------------------------------------------------------- 选中
  function selectDecor(id) {
    selection = id;
    updateSelectionRing();
  }

  function updateSelectionRing() {
    if (!selectionRing) return;
    const node = selection ? decorNodes.get(selection) : null;
    // 选中效果只留在视图材料中，不写入外观 seed 或云端存档。
    // 换造型/画质会重建 node，因此也要恢复旧材料并高亮新材料。
    if (highlightedNode !== node) {
      if (highlightedNode) {
        const material = highlightedNode.group.userData.material;
        material.emissive.copy(highlightedNode.selectionEmissive);
        material.emissiveIntensity = highlightedNode.selectionIntensity;
      }
      highlightedNode = node;
      if (node) {
        const material = node.group.userData.material;
        node.selectionEmissive = material.emissive.clone();
        node.selectionIntensity = material.emissiveIntensity;
        material.emissive.set('#ffcf63');
        material.emissiveIntensity = 0.65;
      }
    }
    if (!node) {
      selectionRing.visible = false;
      return;
    }
    const geometry = node.group.userData.geometry;
    if (!geometry.boundingBox) geometry.computeBoundingBox();
    const box = geometry.boundingBox;
    const radius = Math.hypot(Math.max(Math.abs(box.min.x), Math.abs(box.max.x)), Math.max(Math.abs(box.min.z), Math.abs(box.max.z))) * node.group.scale.x + 0.05;
    selectionRing.scale.setScalar(Math.max(0.8, radius / 0.17));
    selectionRing.position.set(node.group.position.x, sandHeightAt(node.group.position.x, node.group.position.z) + 0.08, node.group.position.z);
    selectionRing.visible = true;
  }

  // ---------------------------------------------------------------- 食物
  function spawnFood(x, z, count = 5) {
    if (canFeed() === false) return false;
    notifyInteraction();
    addFood(x, z, count);
    return true;
  }

  function addFood(x, z, count) {
    for (let i = 0; i < count; i += 1) {
      if (foods.length >= MAX_FOOD) foods.shift();
      foods.push({
        x: clamp(x + (Math.random() - 0.5) * 0.34, -TANK.width / 2 + 0.15, TANK.width / 2 - 0.15),
        y: TANK.waterY - 0.04,
        z: clamp(z + (Math.random() - 0.5) * 0.24, -TANK.depth / 2 + 0.12, TANK.depth / 2 - 0.12),
        vy: -(0.035 + Math.random() * 0.03),
        phase: Math.random() * TAU,
        age: 0
      });
    }
  }

  function updateFood(dt, time) {
    for (let i = foods.length - 1; i >= 0; i -= 1) {
      const food = foods[i];
      food.age += dt;
      food.y += food.vy * dt;
      food.x += Math.sin(time * 0.7 + food.phase) * dt * 0.02;
      if (food.y < 0.12 || food.age > 26) foods.splice(i, 1);
    }
    if (foodMesh) {
      foodMesh.count = foods.length;
      foods.forEach((food, i) => {
        foodDummy.position.set(food.x, food.y, food.z);
        foodDummy.updateMatrix();
        foodMesh.setMatrixAt(i, foodDummy.matrix);
      });
      foodMesh.instanceMatrix.needsUpdate = true;
    }
  }

  // ---------------------------------------------------------------- 游动
  function updateFish(dt, time) {
    const speedScale = reduceMotion ? 0.78 : 1;
    const list = [...agents.values()];
    const playTargets = new Set();
    if (playMode && mode === 'view' && playPointerActive && playPoint && list.length) {
      list
        .map((agent) => ({ agent, distance: (agent.group.position.x - playPoint.x) ** 2 + (agent.group.position.z - playPoint.z) ** 2 }))
        .sort((a, b) => a.distance - b.distance)
        .slice(0, 3)
        .forEach(({ agent }) => playTargets.add(agent.id));
    }

    for (const agent of list) {
      const fish = agent.fish;
      if (!fish) continue;
      const type = FISH_TYPE_BY_ID[agent.typeId] || FISH_TYPE_BY_ID.sunset;
      const pos = agent.group.position;
      const maxX = TANK.width / 2 - 0.22;
      const maxZ = TANK.depth / 2 - 0.18;
      const minY = 0.26;
      const maxY = TANK.waterY - 0.2;

      // 漫游目标缓慢换向：持续数秒横穿水域，随后在旧航向上平滑接入新目标。
      const reachedCruise = agent.cruiseTo && agent.cruiseBlendAge >= agent.cruiseBlendDuration && Math.hypot(agent.cruiseTo.x - pos.x, agent.cruiseTo.z - pos.z) < 0.38;
      if (!agent.cruiseTo || agent.cruiseAge >= agent.cruiseDuration || reachedCruise) {
        const side = pos.x >= 0 ? -1 : 1;
        const from = agent.cruise ? { ...agent.cruise } : { x: pos.x, y: pos.y, z: pos.z };
        const to = {
          x: side * maxX * (0.62 + Math.random() * 0.27),
          z: clamp(pos.z + (Math.random() - 0.5) * maxZ * 0.9, -maxZ * 0.82, maxZ * 0.82),
          y: clamp(0.26 + agent.depthBias * (maxY - 0.4) + (Math.random() - 0.5) * 0.2, minY + 0.06, maxY - 0.06)
        };
        agent.cruiseFrom = from;
        agent.cruiseTo = to;
        agent.cruiseAge = 0;
        agent.cruiseDuration = 7 + Math.random() * 3.5;
        agent.cruiseBlendAge = 0;
        agent.cruiseBlendDuration = 1.5 + Math.random() * 1.1;
      }
      agent.cruiseAge += dt;
      agent.cruiseBlendAge += dt;
      const cruiseBlend = smoothstep(agent.cruiseBlendAge / agent.cruiseBlendDuration);
      agent.cruise = {
        x: agent.cruiseFrom.x + (agent.cruiseTo.x - agent.cruiseFrom.x) * cruiseBlend,
        y: agent.cruiseFrom.y + (agent.cruiseTo.y - agent.cruiseFrom.y) * cruiseBlend,
        z: agent.cruiseFrom.z + (agent.cruiseTo.z - agent.cruiseFrom.z) * cruiseBlend
      };

      // 目标：水面食物优先，其次玩家逗鱼，再回到漫游航线。
      let nearestFood = null;
      let best = Infinity;
      for (const food of foods) {
        const d = (food.x - pos.x) ** 2 + (food.y - pos.y) ** 2 + (food.z - pos.z) ** 2;
        if (d < best) { best = d; nearestFood = food; }
      }
      const target = best < 32 ? nearestFood : null;
      let desired;
      let targetSpeed = agent.baseSpeed;
      if (target && best < 32) {   // 整缸范围内的食物都会被注意到（约 5.6 个世界单位）
        const dist = Math.sqrt(best);
        desired = Math.atan2(target.z - pos.z, target.x - pos.x);
        targetSpeed = agent.baseSpeed * 1.9;
        const eatRadius = EAT_RADIUS + agent.group.scale.x * 0.28;
        if (dist < eatRadius) {
          const idx = foods.indexOf(target);
          if (idx >= 0) foods.splice(idx, 1);
          onEat(fish.id, { x: target.x, y: target.y, z: target.z });
        }
      } else {
        agent.wander += dt * (0.42 + (type.motion.speed || 0.4) * 0.2);
        desired = Math.atan2(agent.cruise.z - pos.z, agent.cruise.x - pos.x);
        targetSpeed = agent.baseSpeed * (0.85 + 0.22 * Math.sin(time * 0.23 + agent.phase));
        agent.playWeight = damp(agent.playWeight, playTargets.has(agent.id) ? 1 : 0, 2.2, dt);
        if (agent.playWeight > 0.005 && playPoint) {
          const dx = playPoint.x - pos.x;
          const dz = playPoint.z - pos.z;
          const distance = Math.hypot(dx, dz);
          const influence = agent.playWeight * smoothstep(distance / 0.38);
          desired = mixHeading(desired, Math.atan2(dz, dx), influence);
          targetSpeed *= 0.35 + 0.65 * smoothstep(distance / 1.2);
        }
      }
      if (target) {
        agent.playWeight = damp(agent.playWeight, 0, 2.2, dt);
        agent.glide = damp(agent.glide, 0, 3.2, dt);
      } else {
        // 偶尔滑行一小段，给持续游动留出自然的节奏；追食期间不降低赶食速度。
        if (time >= agent.nextGlideAt) {
          agent.glideUntil = time + 0.55 + Math.random() * 0.55;
          agent.nextGlideAt = agent.glideUntil + 11 + Math.random() * 14;
        }
        agent.glide = damp(agent.glide, time < agent.glideUntil ? 1 : 0, 3.2, dt);
        targetSpeed *= 1 - agent.glide * 0.72;
      }

      // 边界：越过安全区就把目标方向拉回缸内
      const margin = 0.42;
      if (pos.x > maxX - margin) desired += (1 - (maxX - pos.x) / margin) * 1.6;
      if (pos.x < -maxX + margin) desired -= (1 - (pos.x + maxX) / margin) * 1.6;
      if (pos.z > maxZ - margin) desired += (1 - (maxZ - pos.z) / margin) * 1.2;
      if (pos.z < -maxZ + margin) desired -= (1 - (pos.z + maxZ) / margin) * 1.2;

      // 避让大型造景（石头/沉木），水草允许穿过
      for (const node of decorNodes.values()) {
        const appearance = node.group.userData.appearance;
        if (!appearance || appearance.kind === 'plant') continue;
        const r = (appearance.params.size || 0.24) * node.group.scale.y * 1.9 + 0.18;
        const dx = pos.x - node.group.position.x;
        const dz = pos.z - node.group.position.z;
        const dist = Math.hypot(dx, dz);
        if (dist < r && dist > 0.0001) {
          desired = Math.atan2(dz, dx);
          targetSpeed *= 0.7;
          break;
        }
      }

      // 鱼与鱼之间保持一点距离，避免叠在一起
      for (const other of list) {
        if (other === agent) continue;
        const dx = pos.x - other.group.position.x;
        const dz = pos.z - other.group.position.z;
        const dy = pos.y - other.group.position.y;
        const dist = Math.hypot(dx, dz);
        const personalSpace = FISH_RADIUS + (other.group.scale.x + agent.group.scale.x) * 0.78;
        if (dist < personalSpace && dist > 0.0001) {
          desired = Math.atan2(dz, dx);
          targetSpeed *= 0.85;
        }
        if (Math.abs(dy) < 0.06 && dist < 0.05) pos.y += 0.004;
      }

      const previousHeading = agent.heading;
      agent.heading = stepHeading(agent.heading, desired, agent.turnRate * (reduceMotion ? 0.88 : 1), dt);
      const turn = Math.atan2(Math.sin(agent.heading - previousHeading), Math.cos(agent.heading - previousHeading));
      agent.bend = damp(agent.bend, clamp(turn / Math.max(dt, 0.001) / 4, -1, 1), 4, dt);
      agent.speed = damp(agent.speed, targetSpeed * speedScale, 1.6, dt);

      pos.x += Math.cos(agent.heading) * agent.speed * dt;
      pos.z += Math.sin(agent.heading) * agent.speed * dt;

      // 垂直方向：偏好水层 + 轻微起伏；追食时朝食物高度靠拢
      const preferredY = clamp(
        (agent.cruise ? agent.cruise.y : 0.24 + agent.depthBias * (maxY - 0.24)) + Math.sin(time * 0.5 + agent.bobPhase) * agent.bob * (reduceMotion ? 0.72 : 1),
        minY,
        maxY
      );
      const wantY = target ? target.y : preferredY;
      pos.y = damp(pos.y, wantY, 0.9, dt);

      pos.x = clamp(pos.x, -maxX, maxX);
      pos.z = clamp(pos.z, -maxZ, maxZ);
      pos.y = clamp(pos.y, minY, maxY);
      if (Math.abs(pos.x) >= maxX - 0.001) agent.heading = pos.x > 0 ? Math.PI : 0;
      if (Math.abs(pos.z) >= maxZ - 0.001) agent.heading = pos.z > 0 ? -Math.PI / 2 : Math.PI / 2;

      // 姿态：模型朝 +X，heading 是 XZ 平面角度 → 绕 Y 取反
      agent.group.rotation.y = -agent.heading;
      const greetElapsed = time - agent.greetAt;
      const greetPulse = greetElapsed >= 0 && greetElapsed < 1.45 ? Math.sin(Math.PI * clamp(greetElapsed / 1.45, 0, 1)) : 0;
      agent.group.rotation.z = clamp(-(wantY - pos.y) * 0.65 + greetPulse * 0.13, -0.1, 0.18);
      agent.group.rotation.x = Math.sin(time * 0.4 + agent.phase) * 0.022 + agent.bend * 0.12;
      const breath = Math.sin(time * 1.65 + agent.phase) * 0.006;
      const visualScale = agent.visualScale || agent.group.scale.x;
      agent.group.scale.set(visualScale * (1 + breath), visualScale * (1 - breath * 0.35), visualScale * (1 + breath));

      // 体素鱼的尾巴是独立刚体：绕尾柄左右摆，速度越快摆得越勤、幅度越大
      if (agent.tailPivot) {
        const speedRatio = clamp(agent.speed / Math.max(0.12, agent.baseSpeed * 1.6), 0, 1.6);
        const wag = agent.group.userData.wagAmp * (0.55 + 0.45 * speedRatio) * (reduceMotion ? 0.8 : 1);
        const freq = agent.group.userData.wagFreq * (0.7 + 0.5 * speedRatio);
        agent.tailPivot.rotation.y = Math.sin(time * freq + (agent.group.userData.wagPhase || 0)) * wag + agent.bend * 0.25 + Math.sin(time * 12 + agent.phase) * greetPulse * 0.2;
      }
      // 胸鳍小幅划水
      const flap = Math.sin(time * (1.6 + agent.freq * 0.4) + agent.phase) * (0.45 + greetPulse * 0.1);
      const ud = agent.group.userData;
      if (ud.pectoralL) {
        ud.pectoralL.rotation.y = -0.5 + flap * 0.5;
        ud.pectoralR.rotation.y = Math.PI + 0.5 - flap * 0.5;
      }
    }
  }

  // ---------------------------------------------------------------- 渲染循环
  function frame(ts) {
    if (disposed || paused) return;
    if (!scene3d) return;
    if (!renderPolicy.shouldRender(ts)) {
      animationHandle = requestAnimationFrame(frame);
      return;
    }
    const workStartedAt = now();
    const t = ts / 1000;
    const dt = clock.last ? Math.min((ts - clock.last) / 1000, 0.25) : 0;
    clock.last = ts;
    clock.time = t;
    if (needsResize) {
      scene3d.resize(canvas.clientWidth, canvas.clientHeight);
      needsResize = false;
    }
    advanceMotion(dt,t,(step,time) => { updateFood(step,time); updateFish(step,time); });
    decorNodes.forEach((node) => {
      const uniforms = node.group.userData.material?.userData?.uniforms;
      if (uniforms) uniforms.uTime.value = t;
    });
    if (selectionRing && selectionRing.visible) {
      selectionRing.material.opacity = reduceMotion ? 0.95 : 0.88 + Math.sin(t * 2.2) * 0.07;
    }
    scene3d.update(dt, t);
    renderPolicy.recordWork(now() - workStartedAt, ts);
    applyEffectsLevel();
    animationHandle = requestAnimationFrame(frame);
  }

  function start() {
    if (animationHandle || disposed || paused || !requestedVisible) return;
    clock.last = 0;
    animationHandle = requestAnimationFrame(frame);
  }

  function stop() {
    if (animationHandle) cancelAnimationFrame(animationHandle);
    animationHandle = null;
  }

  function pause() {
    if (paused) return;
    paused = true;
    setActivity({});
  }

  function resume() {
    if (!paused) return;
    paused = false;
    setActivity({});
  }

  // ---------------------------------------------------------------- 指针交互
  function setMode(next) {
    mode = next === 'decor' ? 'decor' : 'view';
    if (mode !== 'view') setPlayMode(false);
    canvas.style.cursor = mode === 'decor' ? 'grab' : 'default';
    if (mode === 'view') selectDecor(null);
  }

  function setPlayMode(enabled) {
    playMode = Boolean(enabled) && mode === 'view';
    if (!playMode) {
      playPointerActive = false;
      playTouchPointerId = null;
    }
    return playMode;
  }

  function greetFish(id, { ripple = true } = {}) {
    const agent = agents.get(id);
    if (!agent) return false;
    agent.greetAt = clock.time;
    if (ripple) scene3d?.addRipple?.(agent.group.position.x, agent.group.position.z, 0.26);
    return true;
  }

  function greetNearestFish(point) {
    const nearest = [...agents.values()]
      .map((agent) => ({
        id: agent.id,
        distance: (agent.group.position.x - point.x) ** 2 + (agent.group.position.z - point.z) ** 2
      }))
      .sort((a, b) => a.distance - b.distance)
      .slice(0, 3);
    for (const { id } of nearest) greetFish(id, { ripple: false });
  }

  function getPointer(event) {
    const rect = canvas.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top, width: rect.width, height: rect.height };
  }

  const floorPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  function floorAt(px, py, rect) {
    if (!scene3d) return null;
    pointer.set((px / rect.width) * 2 - 1, -(py / rect.height) * 2 + 1);
    raycaster.setFromCamera(pointer, scene3d.camera);
    return raycaster.ray.intersectPlane(floorPlane, new THREE.Vector3());
  }

  function updatePlayPointer(event, p = getPointer(event)) {
    if (!playMode || mode !== 'view' || !scene3d) return;
    if (event.pointerType === 'touch' && playTouchPointerId !== event.pointerId) return;
    const point = floorAt(p.x, p.y, p);
    if (!point) return;
    const maxX = TANK.width / 2 - 0.22;
    const maxZ = TANK.depth / 2 - 0.18;
    playPoint = { x: clamp(point.x, -maxX, maxX), z: clamp(point.z, -maxZ, maxZ) };
    playPointerActive = true;
  }

  function pickAt(px, py, rect) {
    if (!scene3d) return null;
    pointer.x = (px / rect.width) * 2 - 1;
    pointer.y = -(py / rect.height) * 2 + 1;
    raycaster.setFromCamera(pointer, scene3d.camera);
    const fishHits = raycaster.intersectObjects([...agents.values()].map((a) => a.group), true);
    const decorHits = raycaster.intersectObjects([...decorNodes.values()].map((n) => n.group), true);
    const fishHit = fishHits[0];
    const decorHit = decorHits[0];
    if (mode === 'view' && fishHit && (!decorHit || fishHit.distance <= decorHit.distance)) {
      let obj = fishHit.object;
      while (obj && !obj.userData?.fishId) obj = obj.parent;
      if (obj) return { kind: 'fish', id: obj.userData.fishId };
    }
    if (decorHit) {
      let obj = decorHit.object;
      while (obj && !obj.userData?.decorId) obj = obj.parent;
      if (obj) return { kind: 'decor', id: obj.userData.decorId, point: decorHit.point };
    }
    const floor = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
    const point = new THREE.Vector3();
    const hit = raycaster.ray.intersectPlane(floor, point);
    if (hit) {
      const x = point.x / (TANK.width * 0.9) + 0.5;
      const z = point.z / (TANK.depth * 0.82) + 0.5;
      return { kind: 'water', point, x: clamp(x, 0, 1), z: clamp(z, 0, 1) };
    }
    return { kind: 'none' };
  }

  function bindPointer() {
    const onPointerDown = (event) => {
      notifyInteraction();
      canvas.focus?.();
      pointers.set(event.pointerId, getPointer(event));
      canvas.setPointerCapture?.(event.pointerId);
      if (playMode && mode === 'view') {
        if (event.pointerType === 'touch') playTouchPointerId = event.pointerId;
        updatePlayPointer(event);
      }
      if (pointers.size > 1) {
        if (pointers.size === 2) {
          const [a, b] = [...pointers.values()];
          lastPinch = Math.hypot(a.x - b.x, a.y - b.y);
        }
        dragState = null;
        return;
      }
      const p = getPointer(event);
      const hit = pickAt(p.x, p.y, p);
      const floorStart = floorAt(p.x, p.y, p);
      const decorNode = hit?.kind === 'decor' ? decorNodes.get(hit.id) : null;
      dragState = {
        pointerId: event.pointerId,
        startX: event.clientX, startY: event.clientY,
        lastX: event.clientX, lastY: event.clientY,
        moved: 0,
        maxDistance: 0,
        downAt: now(),
        hit,
        pointerType: event.pointerType,
        singleFinger: event.pointerType !== 'touch' || pointers.size === 1,
        dragging: false,
        decorPicked: false,
        mode,
        anchor: decorNode && floorStart ? { x: decorNode.group.position.x - floorStart.x, z: decorNode.group.position.z - floorStart.z } : { x: 0, z: 0 }
      };
    };

    const onPointerMove = (event) => {
      notifyInteraction();
      if (pointers.has(event.pointerId)) pointers.set(event.pointerId, getPointer(event));
      if (playMode && mode === 'view') updatePlayPointer(event);
      if (pointers.size === 2) {
        const [a, b] = [...pointers.values()];
        const dist = Math.hypot(a.x - b.x, a.y - b.y);
        if (lastPinch > 0) scene3d?.zoom(lastPinch / Math.max(1, dist));
        lastPinch = dist;
        return;
      }
      if (!dragState || dragState.pointerId !== event.pointerId) return;
      const dx = event.clientX - dragState.lastX;
      const dy = event.clientY - dragState.lastY;
      dragState.lastX = event.clientX;
      dragState.lastY = event.clientY;
      dragState.moved += Math.abs(dx) + Math.abs(dy);
      dragState.maxDistance = Math.max(dragState.maxDistance, Math.hypot(event.clientX - dragState.startX, event.clientY - dragState.startY));
      if (!dragState.dragging && dragState.maxDistance > 8) {
        dragState.dragging = true;
        if (mode === 'decor' && dragState.hit?.kind === 'decor') {
          selectDecor(dragState.hit.id);
          onPickDecor(dragState.hit.id);
          dragState.decorPicked = true;
          canvas.style.cursor = 'grabbing';
        }
      }

      // 触屏逗鱼时，手指沿缸面滑动来引导小鱼；不同时把同一手势解释为转相机。
      if (mode === 'view' && playMode) return;

      if (mode === 'decor' && dragState.hit?.kind === 'decor' && dragState.dragging) {
        const rect = canvas.getBoundingClientRect();
        const point = floorAt(event.clientX - rect.left, event.clientY - rect.top, rect);
        const node = decorNodes.get(dragState.hit.id);
        if (point && node) {
          const nx = clamp((point.x + dragState.anchor.x) / (TANK.width * 0.9) + 0.5, 0.03, 0.97);
          const nz = clamp((point.z + dragState.anchor.z) / (TANK.depth * 0.82) + 0.5, 0.03, 0.97);
          onDecorMove(dragState.hit.id, { x: nx, z: nz }, false);
          updateSelectionRing();
        }
        return;
      }
      if (dragState.dragging) {
        scene3d?.orbit(dx / Math.max(220, canvas.clientWidth), -dy / Math.max(180, canvas.clientHeight));
      }
    };

    const finish = (event) => {
      notifyInteraction();
      pointers.delete(event.pointerId);
      if (pointers.size < 2) lastPinch = 0;
      if (playTouchPointerId === event.pointerId) {
        playTouchPointerId = null;
        playPointerActive = false;
      }
      if (!dragState || dragState.pointerId !== event.pointerId) return;
      const stateSnapshot = dragState;
      dragState = null;
      canvas.style.cursor = mode === 'decor' ? 'grab' : 'default';
      if (event.type === 'pointercancel') return;
      if (stateSnapshot.dragging && mode === 'decor' && stateSnapshot.hit?.kind === 'decor') {
        const node = decorNodes.get(stateSnapshot.hit.id);
        if (node) {
          const nx = clamp(node.group.position.x / (TANK.width * 0.9) + 0.5, 0, 1);
          const nz = clamp(node.group.position.z / (TANK.depth * 0.82) + 0.5, 0, 1);
          onDecorCommit(stateSnapshot.hit.id, { x: nx, z: nz });
        }
        return;
      }
      if (stateSnapshot.dragging || !stateSnapshot.singleFinger || now() - stateSnapshot.downAt > 500 || stateSnapshot.maxDistance > 8) return;
      const hit = stateSnapshot.hit;
      if (!hit) return;
      if (hit.kind === 'fish') {
        greetFish(hit.id);
        onPickFish(hit.id);
      }
      else if (hit.kind === 'decor') {
        if (mode === 'decor') {
          if (!stateSnapshot.decorPicked) {
            selectDecor(hit.id);
            onPickDecor(hit.id);
          }
        }
        else onPickDecor(hit.id);
      } else if (hit.kind === 'water') {
        if (mode === 'view') {
          scene3d?.addRipple?.(hit.point.x, hit.point.z, 0.52);
          greetNearestFish(hit.point);
          if (playMode) return;
        } else {
          selectDecor(null);
          onPickDecor(null);
        }
      }
    };
    const onPointerLeave = (event) => {
      notifyInteraction();
      playPointerActive = false;
      if (playTouchPointerId === event.pointerId) playTouchPointerId = null;
      if (dragState && dragState.pointerId === event.pointerId && dragState.dragging) finish(event);
    };

    canvas.addEventListener('pointerdown', onPointerDown, { signal: listenerController.signal });
    canvas.addEventListener('pointermove', onPointerMove, { signal: listenerController.signal });
    canvas.addEventListener('pointerup', finish, { signal: listenerController.signal });
    canvas.addEventListener('pointercancel', finish, { signal: listenerController.signal });
    canvas.addEventListener('pointerleave', onPointerLeave, { signal: listenerController.signal });

    const onWheel = (event) => {
      notifyInteraction();
      event.preventDefault();
      scene3d?.zoom(event.deltaY > 0 ? 1.06 : 0.94);
    };
    canvas.addEventListener('wheel', onWheel, { passive: false, signal: listenerController.signal });

    const onKeyDown = (event) => {
      notifyInteraction();
      const step = event.shiftKey ? 0.06 : 0.02;
      if (event.key === 'ArrowLeft' || event.key === 'ArrowRight' || event.key === 'ArrowUp' || event.key === 'ArrowDown') {
        if (mode === 'decor' && selection) {
          event.preventDefault();
          const node = decorNodes.get(selection);
          if (node) {
            const dx = event.key === 'ArrowLeft' ? -step : event.key === 'ArrowRight' ? step : 0;
            const dz = event.key === 'ArrowUp' ? -step : event.key === 'ArrowDown' ? step : 0;
            const nx = clamp(node.group.position.x / (TANK.width * 0.9) + 0.5 + dx, 0.03, 0.97);
            const nz = clamp(node.group.position.z / (TANK.depth * 0.82) + 0.5 + dz, 0.03, 0.97);
            node.group.position.set((nx - 0.5) * TANK.width * 0.9, 0, (nz - 0.5) * TANK.depth * 0.82);
            onDecorCommit(selection, { x: nx, z: nz });
            updateSelectionRing();
          }
        } else {
          event.preventDefault();
          const dx = event.key === 'ArrowLeft' ? -0.08 : event.key === 'ArrowRight' ? 0.08 : 0;
          const dy = event.key === 'ArrowUp' ? -0.06 : event.key === 'ArrowDown' ? 0.06 : 0;
          if (dx || dy) scene3d?.orbit(dx, dy);
        }
      } else if ((event.key === ' ' || event.code === 'Space') && mode === 'view') {
        event.preventDefault();
        feedRandom('keyboard');
      }
    };
    canvas.addEventListener('keydown', onKeyDown, { signal: listenerController.signal });
  }

  function feedRandom(source = 'button') {
    if (canFeed() === false) return false;
    notifyInteraction();
    const x = (Math.random() - 0.5) * TANK.width * 0.5;
    const z = (Math.random() - 0.5) * TANK.depth * 0.5;
    addFood(x, z, 6);
    scene3d?.addRipple?.(x, z, 0.5);
    onFeed({ x, z, source });
    return true;
  }

  // ---------------------------------------------------------------- 生命周期
  // Quality changes affect runtime effects and frame pacing, retaining this canvas and geometry.
  function setNight(on) {
    nightTarget = Boolean(on);
    scene3d?.setNight(nightTarget);
  }

  function nudgeSelected(transform) {
    if (!selection) return null;
    const node = decorNodes.get(selection);
    if (!node) return null;
    const item = node.item;
    const next = { ...item, ...transform };
    node.item = next;
    applyDecorTransform(node, next);
    updateSelectionRing();
    return next;
  }

  function getSelected() {
    return selection;
  }

  function resize() {
    needsResize = true;
    if (scene3d) scene3d.resize(canvas.clientWidth, canvas.clientHeight);
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    // 先摘掉 contextlost 监听：dispose 里的 forceContextLoss 会触发它，
    // 否则会被误判成「运行中丢失上下文」，导致递归切换到 2D。
    canvas.removeEventListener('webglcontextlost', onContextLost);
    listenerController.abort();
    stop();
    renderPolicy.setActivity({ visible: false });
    if (scene3d) scene3d.dispose();
    scene3d = null;
    agents.clear();
    decorNodes.clear();
    foods.length = 0;
    pointers.clear();
  }

  init();
  bindPointer();
  canvas.addEventListener('webglcontextlost', onContextLost, { signal: listenerController.signal });

  return {
    setState, setMode, setPlayMode, greetFish, setNight, feedRandom, resize, pause, resume, dispose,
    setQualityPolicy, setActivity, notifyInteraction,
    selectDecor, getSelected, nudgeSelected,
    spawnFood,
    get quality() { return currentQuality; },
    get performanceInfo() { return renderPolicy.performanceInfo; },
    get playMode() { return playMode; },
    get motionInfo() {
      return {foodCount: foods.length, lureActive: playPointerActive, fish: [...agents.values()].map(a => ({id:a.id,x:a.group.position.x,y:a.group.position.y,z:a.group.position.z,speed:a.speed,heading:a.heading,greeting:clock.time-a.greetAt<1.8}))};
    },
    get hasSelection() { return Boolean(selection); },
    get selectionFeedback() {
      const group = highlightedNode?.group;
      return {
        id: highlightedNode?.item.id ?? null, visible: Boolean(selectionRing?.visible), intensity: group?.userData.material.emissiveIntensity ?? 0,
        bottomY: group ? group.position.y + group.userData.geometry.boundingBox.min.y * group.scale.y : null,
        sandY: group ? sandHeightAt(group.position.x, group.position.z) : null
      };
    },
    get isDisposed() { return disposed; },
    get rendererInfo() { return scene3d?.renderer?.info?.render || null; },
    get resourceInfo() {
      const info = scene3d?.renderer?.info;
      return info ? {geometries:info.memory.geometries,textures:info.memory.textures,drawCalls:info.render.calls,triangles:info.render.triangles} : null;
    }
  };
}
