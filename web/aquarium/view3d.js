// 3D 视图：把领域状态（fish/decor）映射成场景对象，并处理相机、选取、布景拖拽与喂食。
//
// 分工：
// - 状态（鱼的成长/名字/造景变换）只由 app.js 修改；本文件只读状态并调用回调报告交互。
// - 每帧只更新 uniform / transform，不重建几何；只有阶段变化或换 seed 才重建单个对象。
// - 所有 GPU 资源都能通过 dispose() 释放，供画质切换、2D 降级和页面卸载时使用。
import * as THREE from 'three';
import { TANK, QUALITY, createTankScene } from './scene.js';
import { createFishMesh, disposeFish } from './fish.js';
import { createDecorMesh, disposeDecor } from './decor.js';
import { FISH_TYPE_BY_ID, DECOR_KINDS } from '../catalog.js';
import { fishAppearance, decorAppearance, fishSizeFactor, stageOf } from '../model.js';

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
  reduceMotion = false
}) {
  let qualityKey = QUALITY[quality] ? quality : 'high';
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
  let mode = 'view';            // 'view' | 'decor'
  let foodMesh = null;
  let foodDummy = new THREE.Object3D();
  let animationHandle = null;
  let dragState = null;
  let pointers = new Map();
  let lastPinch = 0;
  let nightTarget = night;
  let currentQuality = qualityKey;
  let needsResize = true;

  function settings() {
    return QUALITY[qualityKey];
  }

  // ---------------------------------------------------------------- 初始化
  function init() {
    scene3d = createTankScene({ canvas, quality: qualityKey });
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
      new THREE.RingGeometry(0.16, 0.2, 40),
      new THREE.MeshBasicMaterial({ color: '#f6f2d8', transparent: true, opacity: 0.72, side: THREE.DoubleSide, depthWrite: false })
    );
    selectionRing.rotation.x = -Math.PI / 2;
    selectionRing.visible = false;
    selectionRing.renderOrder = 5;
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
      tailPivot: group.userData.tailPivot
    };
    return agent;
  }

  function rebuildAgentMesh(agent, fish, type, appearance, stageIndex) {
    disposeFish(agent.group);
    // disposeFish 会清空 group 的子对象，但保留 group 本身与其变换。
    const fresh = createFishMesh(type, appearance, fish.growth, settings().fishSegments);
    while (fresh.children.length) agent.group.add(fresh.children[0]);
    agent.group.userData = fresh.userData;
    agent.group.userData.fishId = fish.id;
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
    // 低画质用一张柔和的接触阴影替代实时阴影
    if (!settings().shadows) {
      const radius = item.kind === 'plant' ? 0.24 : item.kind === 'rock' ? 0.3 : 0.34;
      const blob = new THREE.Mesh(new THREE.PlaneGeometry(radius * 2.4, radius * 2.4), scene3d.blobMaterial.clone());
      blob.rotation.x = -Math.PI / 2;
      blob.position.y = 0.012;
      blob.renderOrder = 1;
      group.add(blob);
      group.userData.blob = blob;
    }
    return { group, key, item };
  }

  function applyDecorTransform(node, item) {
    const world = worldFromNormalized(item.x, item.z);
    node.group.position.set(world.x, 0, world.z);
    node.group.rotation.y = Math.PI * 2 - item.rot;
    const appearance = node.group.userData.appearance;
    node.group.scale.setScalar(item.scale * (appearance?.scaleJitter ?? 1));
  }

  // ---------------------------------------------------------------- 选中
  function selectDecor(id) {
    selection = id;
    updateSelectionRing();
  }

  function updateSelectionRing() {
    if (!selectionRing) return;
    const node = selection ? decorNodes.get(selection) : null;
    if (!node) {
      selectionRing.visible = false;
      return;
    }
    const appearance = node.group.userData.appearance;
    const radius = appearance?.kind === 'plant' ? 0.2 : appearance?.kind === 'rock' ? (appearance.params.size || 0.25) * 1.15 : 0.26;
    selectionRing.scale.setScalar(Math.max(0.7, radius / 0.18));
    selectionRing.position.set(node.group.position.x, 0.02, node.group.position.z);
    selectionRing.visible = true;
  }

  // ---------------------------------------------------------------- 食物
  function spawnFood(x, z, count = 5) {
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
    const speedScale = reduceMotion ? 0.55 : 1;
    const list = [...agents.values()];
    for (const agent of list) {
      const fish = agent.fish;
      if (!fish) continue;
      const type = FISH_TYPE_BY_ID[agent.typeId] || FISH_TYPE_BY_ID.sunset;
      const pos = agent.group.position;
      const maxX = TANK.width / 2 - 0.22;
      const maxZ = TANK.depth / 2 - 0.18;
      const minY = 0.26;
      const maxY = TANK.waterY - 0.2;

      // 目标：水面食物优先，其次漫游
      let target = null;
      let best = Infinity;
      for (const food of foods) {
        const d = (food.x - pos.x) ** 2 + (food.y - pos.y) ** 2 + (food.z - pos.z) ** 2;
        if (d < best) { best = d; target = food; }
      }
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
        if (!agent.cruise || agent.cruiseAge > 6 || Math.hypot(agent.cruise.x - pos.x, agent.cruise.z - pos.z) < 0.35) {
          // 优先挑对侧的水域，让鱼以「横着游过鱼缸」为主（正面/背面朝相机时鱼会显得很薄）。
          const side = pos.x > 0 ? -1 : 1;
          agent.cruise = {
            x: side * (1.1 + Math.random() * 0.8),
            z: clamp(pos.z + (Math.random() - 0.5) * 0.5, -(TANK.depth / 2 - 0.35), TANK.depth / 2 - 0.35),
            y: 0.26 + agent.depthBias * (TANK.waterY - 0.55) + (Math.random() - 0.5) * 0.22
          };
          agent.cruiseAge = 0;
        }
        agent.cruiseAge = (agent.cruiseAge || 0) + dt;
        desired = Math.atan2(agent.cruise.z - pos.z, agent.cruise.x - pos.x);
        targetSpeed = agent.baseSpeed * (0.85 + 0.22 * Math.sin(time * 0.23 + agent.phase));
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

      const diff = Math.atan2(Math.sin(desired - agent.heading), Math.cos(desired - agent.heading));
      const maxTurn = agent.turnRate * dt * (reduceMotion ? 0.7 : 1);
      const turn = clamp(diff, -maxTurn, maxTurn);
      agent.heading += turn;
      agent.bend += ((clamp(turn / Math.max(dt, 0.001) / 4, -1, 1)) - agent.bend) * Math.min(1, dt * 4);
      agent.speed += (targetSpeed * speedScale - agent.speed) * Math.min(1, dt * 1.6);

      pos.x += Math.cos(agent.heading) * agent.speed * dt;
      pos.z += Math.sin(agent.heading) * agent.speed * dt;

      // 垂直方向：偏好水层 + 轻微起伏；追食时朝食物高度靠拢
      const preferredY = clamp(
        (agent.cruise ? agent.cruise.y : 0.24 + agent.depthBias * (maxY - 0.24)) + Math.sin(time * 0.5 + agent.bobPhase) * agent.bob,
        minY,
        maxY
      );
      const wantY = target ? target.y : preferredY;
      pos.y += (wantY - pos.y) * Math.min(1, dt * 0.9);

      pos.x = clamp(pos.x, -maxX, maxX);
      pos.z = clamp(pos.z, -maxZ, maxZ);
      pos.y = clamp(pos.y, minY, maxY);
      if (Math.abs(pos.x) >= maxX - 0.001) agent.heading = pos.x > 0 ? Math.PI : 0;
      if (Math.abs(pos.z) >= maxZ - 0.001) agent.heading = pos.z > 0 ? -Math.PI / 2 : Math.PI / 2;

      // 姿态：模型朝 +X，heading 是 XZ 平面角度 → 绕 Y 取反
      agent.group.rotation.y = -agent.heading;
      agent.group.rotation.z = clamp(-(wantY - pos.y) * 0.9, -0.1, 0.1);
      agent.group.rotation.x = Math.sin(time * 0.4 + agent.phase) * 0.025;

      // 体素鱼的尾巴是独立刚体：绕尾柄左右摆，速度越快摆得越勤、幅度越大
      if (agent.tailPivot) {
        const speedRatio = clamp(agent.speed / Math.max(0.12, agent.baseSpeed * 1.6), 0, 1.6);
        const wag = agent.group.userData.wagAmp * (0.55 + 0.45 * speedRatio) * (reduceMotion ? 0.6 : 1);
        const freq = agent.group.userData.wagFreq * (0.7 + 0.5 * speedRatio);
        agent.tailPivot.rotation.y = Math.sin(time * freq + (agent.group.userData.wagPhase || 0)) * wag + agent.bend * 0.25;
      }
      // 胸鳍小幅划水
      const flap = Math.sin(time * (1.6 + agent.freq * 0.4) + agent.phase) * 0.45;
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
    const t = ts / 1000;
    const dt = clock.last ? Math.min((ts - clock.last) / 1000, 0.05) : 0;
    clock.last = ts;
    clock.time = t;
    if (needsResize) {
      scene3d.resize(canvas.clientWidth, canvas.clientHeight);
      needsResize = false;
    }
    updateFood(dt, t);
    updateFish(dt, t);
    decorNodes.forEach((node) => {
      const uniforms = node.group.userData.material?.userData?.uniforms;
      if (uniforms) uniforms.uTime.value = t;
    });
    if (selectionRing && selectionRing.visible) {
      selectionRing.material.opacity = 0.5 + Math.sin(t * 2.2) * 0.18;
    }
    scene3d.update(dt, t);
    animationHandle = requestAnimationFrame(frame);
  }

  function start() {
    if (animationHandle || disposed) return;
    clock.last = 0;
    animationHandle = requestAnimationFrame(frame);
  }

  function stop() {
    if (animationHandle) cancelAnimationFrame(animationHandle);
    animationHandle = null;
  }

  function pause() {
    paused = true;
    stop();
  }

  function resume() {
    paused = false;
    if (!disposed) start();
  }

  // ---------------------------------------------------------------- 指针交互
  function setMode(next) {
    mode = next === 'decor' ? 'decor' : 'view';
    canvas.style.cursor = mode === 'decor' ? 'grab' : 'default';
    if (mode === 'view') selectDecor(null);
  }

  function getPointer(event) {
    const rect = canvas.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top, width: rect.width, height: rect.height };
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
    if (fishHit && (!decorHit || fishHit.distance <= decorHit.distance)) {
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
    canvas.addEventListener('pointerdown', (event) => {
      canvas.focus?.();
      pointers.set(event.pointerId, getPointer(event));
      canvas.setPointerCapture?.(event.pointerId);
      if (pointers.size === 2) {
        const [a, b] = [...pointers.values()];
        lastPinch = Math.hypot(a.x - b.x, a.y - b.y);
        dragState = null;
        return;
      }
      const p = getPointer(event);
      const hit = pickAt(p.x, p.y, p);
      dragState = {
        pointerId: event.pointerId,
        startX: event.clientX, startY: event.clientY,
        lastX: event.clientX, lastY: event.clientY,
        moved: 0,
        hit,
        dragging: false,
        mode,
        anchor: hit?.kind === 'decor' && mode === 'decor' ? { x: hit.point.x, z: hit.point.z } : null
      };
      if (mode === 'decor' && hit?.kind === 'decor') {
        selectDecor(hit.id);
        canvas.style.cursor = 'grabbing';
      }
    });

    canvas.addEventListener('pointermove', (event) => {
      if (pointers.has(event.pointerId)) pointers.set(event.pointerId, getPointer(event));
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
      if (!dragState.dragging && dragState.moved > 6) dragState.dragging = true;

      if (mode === 'decor' && dragState.hit?.kind === 'decor' && dragState.dragging) {
        const rect = canvas.getBoundingClientRect();
        const hit = pickAt(event.clientX - rect.left, event.clientY - rect.top, rect);
        if (hit?.kind === 'water' || hit?.kind === 'decor') {
          const node = decorNodes.get(dragState.hit.id);
          if (node) {
            const nx = hit.kind === 'water' ? hit.x : clamp(node.group.position.x / (TANK.width * 0.9) + 0.5, 0, 1);
            const nz = hit.kind === 'water' ? hit.z : clamp(node.group.position.z / (TANK.depth * 0.82) + 0.5, 0, 1);
            onDecorMove(dragState.hit.id, { x: clamp(nx, 0.03, 0.97), z: clamp(nz, 0.03, 0.97) }, false);
            node.group.position.set((nx - 0.5) * TANK.width * 0.9, 0, (nz - 0.5) * TANK.depth * 0.82);
            updateSelectionRing();
          }
        }
        return;
      }
      if (dragState.dragging) {
        scene3d?.orbit(dx / Math.max(220, canvas.clientWidth), -dy / Math.max(180, canvas.clientHeight));
      }
    });

    const finish = (event) => {
      pointers.delete(event.pointerId);
      if (pointers.size < 2) lastPinch = 0;
      if (!dragState || dragState.pointerId !== event.pointerId) return;
      const stateSnapshot = dragState;
      dragState = null;
      canvas.style.cursor = mode === 'decor' ? 'grab' : 'default';
      if (stateSnapshot.dragging && mode === 'decor' && stateSnapshot.hit?.kind === 'decor') {
        const node = decorNodes.get(stateSnapshot.hit.id);
        if (node) {
          const nx = clamp(node.group.position.x / (TANK.width * 0.9) + 0.5, 0, 1);
          const nz = clamp(node.group.position.z / (TANK.depth * 0.82) + 0.5, 0, 1);
          onDecorMove(stateSnapshot.hit.id, { x: nx, z: nz }, true);
          onDecorCommit(stateSnapshot.hit.id, { x: nx, z: nz });
        }
        return;
      }
      const moved = stateSnapshot.moved > 6;
      if (moved) return;
      const hit = stateSnapshot.hit;
      if (!hit) return;
      if (hit.kind === 'fish') onPickFish(hit.id);
      else if (hit.kind === 'decor') {
        if (mode === 'decor') selectDecor(hit.id);
        else onPickDecor(hit.id);
      } else if (hit.kind === 'water') {
        if (mode === 'view') {
          spawnFood(hit.point.x, hit.point.z, 5);
          onFeed({ x: hit.point.x, z: hit.point.z, source: 'tap' });
        } else {
          selectDecor(null);
          onPickDecor(null);
        }
      }
    };
    canvas.addEventListener('pointerup', finish);
    canvas.addEventListener('pointercancel', finish);
    canvas.addEventListener('pointerleave', (event) => {
      if (dragState && dragState.pointerId === event.pointerId && dragState.dragging) finish(event);
    });

    canvas.addEventListener('wheel', (event) => {
      event.preventDefault();
      scene3d?.zoom(event.deltaY > 0 ? 1.06 : 0.94);
    }, { passive: false });

    canvas.addEventListener('keydown', (event) => {
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
            onDecorMove(selection, { x: nx, z: nz }, true);
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
        spawnFood(0, 0, 6);
        onFeed({ x: 0, z: 0, source: 'keyboard' });
      }
    });
  }

  function feedRandom() {
    const x = (Math.random() - 0.5) * TANK.width * 0.5;
    const z = (Math.random() - 0.5) * TANK.depth * 0.5;
    spawnFood(x, z, 6);
    onFeed({ x, z, source: 'button' });
  }

  // ---------------------------------------------------------------- 生命周期
  // 画质切换由 app.js 负责：它会换一块新的 canvas 再重新创建视图，
  // 因为同一个 canvas 元素不能再拿一个新的 WebGL 上下文。
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
    disposed = true;
    // 先摘掉 contextlost 监听：dispose 里的 forceContextLoss 会触发它，
    // 否则会被误判成「运行中丢失上下文」，导致递归切换到 2D。
    canvas.removeEventListener('webglcontextlost', onContextLost);
    stop();
    if (scene3d) scene3d.dispose();
    scene3d = null;
    agents.clear();
    decorNodes.clear();
    foods.length = 0;
  }

  init();
  bindPointer();
  canvas.addEventListener('webglcontextlost', onContextLost, false);

  return {
    setState, setMode, setNight, feedRandom, resize, pause, resume, dispose,
    selectDecor, getSelected, nudgeSelected,
    spawnFood,
    get quality() { return currentQuality; },
    get hasSelection() { return Boolean(selection); },
    get isDisposed() { return disposed; },
    get rendererInfo() { return scene3d?.renderer?.info?.render || null; }
  };
}
