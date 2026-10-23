// 2D 降级渲染器：与 3D 读取同一份存档（同一批鱼、同一批造景、同一外观 seed）。
//
// 用途：WebGL 不可用 / 上下文丢失 / 用户主动切到 2D / 低端设备省电。
// 只做「看得懂、玩得动」：鱼、水草、石头、沉木、食物、水波、昼夜；
// 布景拖拽只在 3D 提供，2D 下会提示切回 3D 编辑（见 index.html 的提示）。
import { FISH_TYPE_BY_ID, DECOR_KINDS } from './catalog.js';
import { fishAppearance, decorAppearance, fishSizeFactor, fishProportions, mulberry32, hashSeed } from './model.js';
import { angleDelta, turnToward, uprightFishPose } from './aquarium/sprite-motion.js';
import { createRenderPolicy } from './render-policy.js';

const TAU = Math.PI * 2;
const clamp = (n, a, b) => Math.min(b, Math.max(a, n));

export function createView2D({
  canvas,
  night = false,
  reduceMotion = false,
  onPickFish = () => {},
  onEat = () => {},
  onFeed = () => {},
  canFeed = () => true,
  quality = 'high'
}) {
  const ctx = canvas.getContext('2d');
  let state = null;
  let W = 900;
  let H = 460;
  let dpr = 1;
  let raf = null;
  let last = 0;
  let paused = false;
  let disposed = false;
  let isNight = night;
  let nightMix = night ? 1 : 0;
  const renderPolicy = createRenderPolicy();
  renderPolicy.setQualityPolicy(quality);
  const listenerController = new AbortController();
  const agents = new Map();
  const agentList = [];
  const fishDrawList = [];
  const decorDrawList = [];
  const decorCache = new Map();
  const pointerGestures = new Map();
  const foods = [];
  const ripples = [];
  let requestedVisible = true;
  let appliedEffectsLevel = -1;

  const now = () => globalThis.performance?.now?.() ?? Date.now();

  function resize() {
    const rect = canvas.getBoundingClientRect();
    const nextW = Math.max(2, rect.width), nextH = Math.max(2, rect.height);
    if (nextW !== W || nextH !== H) {
      const sx = nextW / W, sy = nextH / H;
      for (const agent of agentList) {
        agent.x *= sx; agent.y *= sy;
        if (agent.wanderTarget) { agent.wanderTarget.x *= sx; agent.wanderTarget.y *= sy; }
      }
      for (const point of [...foods,...ripples]) { point.x *= sx; point.y *= sy; }
    }
    W = nextW;
    H = nextH;
    const cap = [1, 1.25, 2][renderPolicy.effectsLevel] ?? 2;
    dpr = Math.min(window.devicePixelRatio || 1, cap);
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function setState(next) {
    state = next;
    const seen = new Set();
    agentList.length = 0;
    fishDrawList.length = 0;
    next.fish.forEach((fish, index) => {
      seen.add(fish.id);
      let agent = agents.get(fish.id);
      if (!agent) {
        agent = {
          id: fish.id,
          x: W * (0.14 + 0.72 * (next.fish.length < 2 ? 0.5 : index / (next.fish.length - 1))),
          y: H * (0.34 + (index % 3) * 0.12),
          angle: Math.random() * TAU,
          speed: 20,
          phase: Math.random() * TAU,
          greetAt: -Infinity,
          bend: 0,
          wanderTarget: null,
          wanderUntil: 0,
          fish
        };
        agents.set(fish.id, agent);
      }
      agent.fish = fish;
      agent.appearance = fishAppearance(fish);
      const type = FISH_TYPE_BY_ID[fish.species] || FISH_TYPE_BY_ID.sunset;
      agent.baseSpeed = type.motion.speed * 46;
      agent.turnRate = type.motion.turn;
      agent.wag = type.motion.wag;
      agentList.push(agent);
      fishDrawList.push(agent);
    });
    for (const [id] of agents) if (!seen.has(id)) agents.delete(id);
    decorDrawList.length = 0;
    decorDrawList.push(...(next.decor || []));
    decorDrawList.sort((a, b) => a.z - b.z);
    const liveDecor = new Set(decorDrawList.filter((item) => item.kind === 'rock' || item.kind === 'wood').map((item) => item.id));
    for (const [id, entry] of decorCache) if (!liveDecor.has(id)) decorCache.delete(id);
    for (const item of decorDrawList) {
      const entry = decorCache.get(item.id);
      if (entry && entry.signature !== `${item.kind}:${item.type}:${item.seed}`) decorCache.delete(item.id);
    }
  }

  function setNight(on) {
    isNight = Boolean(on);
  }

  function spawnFood(x, y, count = 5) {
    if (!canFeed()) return false;
    notifyInteraction();
    const b = bounds();
    for (let i = 0; i < count; i += 1) {
      foods.push({
        x: clamp(x + (Math.random() - 0.5) * 26, b.left, b.right),
        y: clamp(y + (Math.random() - 0.5) * 10, b.top, b.bottom),
        vy: 9 + Math.random() * 6,
        age: 0
      });
    }
    if (foods.length > 40) foods.splice(0, foods.length - 40);
    if (ripples.length >= 8) ripples.shift();
    ripples.push({ x, y, age: 0 });
    return true;
  }

  function notifyInteraction() {
    renderPolicy.notifyInteraction();
  }

  function applyEffectsLevel() {
    if (appliedEffectsLevel === renderPolicy.effectsLevel) return;
    appliedEffectsLevel = renderPolicy.effectsLevel;
    resize();
  }

  function setQualityPolicy(policy) {
    renderPolicy.setQualityPolicy(policy);
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

  /** 鱼在 2D 里的可用水层：上留水面、下留沙面与前景水草。 */
  function bounds() {
    return { top: H * 0.22, bottom: H * 0.82, left: 18, right: W - 18 };
  }

  function chooseWanderTarget(agent, b, t) {
    const width = b.right - b.left;
    const height = b.bottom - b.top;
    const insetX = Math.min(72, width * 0.15);
    const minX = b.left + insetX;
    const maxX = b.right - insetX;
    const middle = clamp((b.left + b.right) * 0.5, minX, maxX);
    const splitPad = Math.min(38, width * 0.07);
    const targetMinX = agent.x < middle ? Math.min(maxX, middle + splitPad) : minX;
    const targetMaxX = agent.x < middle ? maxX : Math.max(minX, middle - splitPad);
    const insetY = Math.min(42, height * 0.16);
    const minY = b.top + insetY;
    const maxY = b.bottom - insetY;
    agent.wanderTarget = {
      x: targetMinX + Math.random() * Math.max(0, targetMaxX - targetMinX),
      y: minY + Math.random() * Math.max(0, maxY - minY)
    };
    agent.wanderUntil = t + 8 + Math.random() * 4;
  }

  function update(dt, t) {
    const b = bounds();
    const list = agentList;
    const speedScale = reduceMotion ? 0.55 : 1;
    for (const agent of list) {
      const fish = agent.fish;
      let target = null;
      let best = Infinity;
      for (const food of foods) {
        const d = Math.hypot(food.x - agent.x, food.y - agent.y);
        if (d < best) { best = d; target = food; }
      }
      let desired;
      let speed = agent.baseSpeed;
      const chasing = Boolean(target && best < 260);
      if (chasing) {
        desired = Math.atan2(target.y - agent.y, target.x - agent.x);
        speed = agent.baseSpeed * 1.8;
        if (best < 14) {
          const index = foods.indexOf(target);
          if (index >= 0) foods.splice(index, 1);
          onEat(fish.id, { x: target.x, y: target.y });
        }
      } else {
        const distance = agent.wanderTarget
          ? Math.hypot(agent.wanderTarget.x - agent.x, agent.wanderTarget.y - agent.y)
          : Infinity;
        if (!agent.wanderTarget || distance < 42 || t >= agent.wanderUntil) chooseWanderTarget(agent, b, t);
        desired = Math.atan2(agent.wanderTarget.y - agent.y, agent.wanderTarget.x - agent.x);
        agent.phase += dt * 0.22;
        speed = agent.baseSpeed * (0.92 + 0.08 * Math.sin(t * 0.28 + agent.phase));
        speed *= clamp(distance / 110, 0.58, 1);
      }

      let steerX = Math.cos(desired);
      let steerY = Math.sin(desired);
      if (!chasing) {
        const marginX = Math.min(72, (b.right - b.left) * 0.22);
        const marginY = Math.min(46, (b.bottom - b.top) * 0.24);
        if (agent.x < b.left + marginX) steerX += (1 - (agent.x - b.left) / marginX) * 2.2;
        if (agent.x > b.right - marginX) steerX -= (1 - (b.right - agent.x) / marginX) * 2.2;
        if (agent.y < b.top + marginY) steerY += (1 - (agent.y - b.top) / marginY) * 2;
        if (agent.y > b.bottom - marginY) steerY -= (1 - (b.bottom - agent.y) / marginY) * 2;
      }

      // Give nearby fish and low hardscape a gentle berth without snapping the heading.
      for (const other of list) {
        if (other === agent) continue;
        const dx = agent.x - other.x;
        const dy = agent.y - other.y;
        const d = Math.hypot(dx, dy);
        if (d < 30 && d > 0.001) {
          const strength = (30 - d) / 30;
          steerX += (dx / d) * strength * 0.9;
          steerY += (dy / d) * strength * 0.9;
        }
      }
      if (!chasing) {
        for (const item of state?.decor || []) {
          if (item.kind === 'plant') continue;
          const cx = item.x * W;
          const clearance = (item.kind === 'rock' ? 46 : 60) * item.scale + 18;
          const dx = agent.x - cx;
          const lower = clamp((agent.y - (b.bottom - 112)) / 112, 0, 1);
          const strength = clamp((clearance - Math.abs(dx)) / clearance, 0, 1) * lower;
          if (strength > 0) {
            steerX += Math.sign(dx) * strength * 1.1;
            steerY -= strength * 1.5;
          }
        }
      }
      desired = Math.atan2(steerY, steerX);
      const nextAngle = turnToward(agent.angle, desired, agent.turnRate * dt);
      const turn = angleDelta(agent.angle, nextAngle);
      agent.angle = nextAngle;
      agent.bend += (clamp(turn / Math.max(dt, 0.001) / 3, -1, 1) - agent.bend) * Math.min(1, dt * 5);
      agent.speed += (speed * speedScale - agent.speed) * Math.min(1, dt * 2);
      agent.x += Math.cos(agent.angle) * agent.speed * dt;
      agent.y += Math.sin(agent.angle) * agent.speed * dt;
      agent.x = clamp(agent.x, b.left, b.right);
      agent.y = clamp(agent.y, b.top, b.bottom);
    }
    for (let i = foods.length - 1; i >= 0; i -= 1) {
      const food = foods[i];
      food.age += dt;
      food.y += food.vy * dt;
      if (food.y > b.bottom + 10 || food.age > 30) foods.splice(i, 1);
    }
    for (let i = ripples.length - 1; i >= 0; i -= 1) {
      ripples[i].age += dt;
      if (ripples[i].age > 1.6) ripples.splice(i, 1);
    }
  }

  // ---------------------------------------------------------------- 绘制
  function drawBackground(t) {
    const motionScale = reduceMotion ? 0.18 : 1;
    const bg = ctx.createLinearGradient(0, 0, 0, H);
    const nightK = nightMix;
    const mix = (a, b) => `rgb(${Math.round(a[0] + (b[0] - a[0]) * nightK)},${Math.round(a[1] + (b[1] - a[1]) * nightK)},${Math.round(a[2] + (b[2] - a[2]) * nightK)})`;
    bg.addColorStop(0, mix([194, 225, 211], [17, 36, 43]));
    bg.addColorStop(0.55, mix([153, 197, 184], [14, 32, 38]));
    bg.addColorStop(1, mix([112, 164, 148], [10, 26, 31]));
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, W, H);

    // Soft daylight bands keep the water clear without a glossy beam effect.
    for (let i = 0; i < 3; i += 1) {
      const x = W * (0.18 + i * 0.3) + Math.sin(t * 0.1 * motionScale + i) * 10;
      const g = ctx.createLinearGradient(x, 0, x + 42, H);
      g.addColorStop(0, `rgba(255,252,238,${0.075 * (1 - nightMix * 0.55)})`);
      g.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.moveTo(x - 14, 0);
      ctx.lineTo(x + 14, 0);
      ctx.lineTo(x + 72, H);
      ctx.lineTo(x - 28, H);
      ctx.fill();
    }
    // A narrow surface glint and a few broken reflections.
    ctx.strokeStyle = `rgba(255,255,255,${0.24 * (1 - nightMix * 0.4)})`;
    ctx.lineWidth = 1;
    for (let i = 0; i < 2; i += 1) {
      ctx.beginPath();
      for (let x = 0; x <= W; x += 14) {
        const y = 13 + i * 6 + Math.sin(x * 0.018 + t * (0.7 + i * 0.16) * motionScale) * 1.5;
        if (x === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      ctx.stroke();
    }
    ctx.strokeStyle = `rgba(244, 251, 234, ${0.12 * (1 - nightMix * 0.45)})`;
    for (let i = 0; i < 7; i += 1) {
      const x = ((i * 149 + t * 7 * motionScale) % (W + 60)) - 30;
      const y = 34 + (i % 4) * 17;
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.quadraticCurveTo(x + 12, y - 2, x + 28, y);
      ctx.stroke();
    }
    // 沙面
    const sandY = H * 0.84;
    const sand = ctx.createLinearGradient(0, sandY - 16, 0, H);
    sand.addColorStop(0, mix([203, 184, 143], [58, 64, 56]));
    sand.addColorStop(1, mix([158, 141, 106], [36, 44, 42]));
    ctx.fillStyle = sand;
    ctx.beginPath();
    ctx.moveTo(0, sandY);
    ctx.bezierCurveTo(W * 0.3, sandY - 14, W * 0.66, sandY + 8, W, sandY - 6);
    ctx.lineTo(W, H);
    ctx.lineTo(0, H);
    ctx.fill();
    ctx.strokeStyle = `rgba(105, 111, 81, ${0.24 * (1 - nightMix * 0.35)})`;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, sandY + 1);
    ctx.bezierCurveTo(W * 0.3, sandY - 13, W * 0.66, sandY + 9, W, sandY - 5);
    ctx.stroke();
    const grain = mulberry32(2481);
    ctx.fillStyle = `rgba(103, 91, 62, ${0.22 * (1 - nightMix * 0.5)})`;
    for (let i = 0; i < 38; i += 1) {
      const x = grain() * W;
      const y = sandY + 8 + grain() * Math.max(1, H - sandY - 10);
      const size = 0.6 + grain() * 0.75;
      ctx.beginPath();
      ctx.arc(x, y, size, 0, TAU);
      ctx.fill();
    }
    // 水面焦散（极轻）
    if (!reduceMotion) {
      ctx.globalAlpha = 0.06 * (1 - nightMix * 0.5);
      ctx.strokeStyle = '#f4f8d8';
      for (let i = 0; i < 7; i += 1) {
        const x = ((i * 173 + t * 12) % (W + 80)) - 40;
        ctx.beginPath();
        ctx.ellipse(x, sandY + 12 + (i % 3) * 9, 30 + (i % 4) * 8, 5, 0.2, 0, TAU);
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
    }
  }

  function drawPlant(item, t) {
    const a = decorAppearance('plant', item.type, item.seed);
    if (!a) return;
    const baseX = item.x * W;
    const baseY = H * 0.84 - (1 - item.z) * 26;
    const scale = clamp(H / 460, 0.7, 1.5) * item.scale * (0.95 + item.z * 0.3) * 1.25;
    const rnd = mulberry32(item.seed);
    const swayScale = reduceMotion ? 0.25 : 1;
    const sway = Math.sin(t * 0.55 + item.seed % 11) * 3 * scale * swayScale;
    const highlight = a.highlight || a.color;
    ctx.save();
    ctx.translate(baseX, baseY);
    const drawLeaf = (length, width, color, alpha = 1) => {
      ctx.save();
      ctx.globalAlpha *= alpha;
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.bezierCurveTo(width * 0.72, -length * 0.24, width * 0.82, -length * 0.72, 0, -length);
      ctx.bezierCurveTo(-width * 0.82, -length * 0.72, -width * 0.72, -length * 0.24, 0, 0);
      ctx.closePath();
      ctx.fill();
      ctx.strokeStyle = 'rgba(230, 246, 221, 0.34)';
      ctx.lineWidth = Math.max(0.55, scale * 0.75);
      ctx.beginPath();
      ctx.moveTo(0, -length * 0.08);
      ctx.quadraticCurveTo(width * 0.04, -length * 0.48, 0, -length * 0.9);
      ctx.stroke();
      ctx.restore();
    };

    // Root clumps tie each plant into the sand instead of leaving floating stems.
    ctx.globalAlpha = 0.22;
    ctx.fillStyle = '#284d42';
    ctx.beginPath();
    ctx.ellipse(0, 0, 28 * scale, 5 * scale, 0, 0, TAU);
    ctx.fill();
    ctx.globalAlpha = 1;

    if (a.shape === 'carpet' || a.shape === 'moss') {
      const count = a.shape === 'carpet' ? 18 : 11;
      const spread = (a.shape === 'carpet' ? 74 : 60) * scale;
      for (let i = 0; i < count; i += 1) {
        const u = count === 1 ? 0 : i / (count - 1) - 0.5;
        const x = u * spread;
        const length = (a.shape === 'carpet' ? 22 : 30) * scale * (0.72 + rnd() * 0.46);
        const lean = u * 0.95 + (rnd() - 0.5) * 0.24 + sway * 0.012;
        ctx.save();
        ctx.translate(x, 0);
        ctx.rotate(lean);
        drawLeaf(length, length * 0.34, i % 3 === 0 ? highlight : a.color, 0.84 + rnd() * 0.16);
        ctx.restore();
      }
    } else if (a.shape === 'rosette') {
      const leaves = Math.max(8, Math.min(14, Math.round(a.params.leaves || 10)));
      for (let i = 0; i < leaves; i += 1) {
        const angle = -0.88 + (i / Math.max(1, leaves - 1)) * 1.76;
        const length = (48 + (1 - Math.abs(angle) / 0.9) * 20) * scale;
        ctx.save();
        ctx.translate(sway * 0.4, 0);
        ctx.rotate(angle);
        drawLeaf(length, length * 0.24, i % 3 === 0 ? highlight : a.color, 0.9);
        ctx.restore();
      }
      ctx.fillStyle = highlight;
      ctx.globalAlpha = 0.72;
      ctx.beginPath();
      ctx.ellipse(0, -8 * scale, 8 * scale, 13 * scale, 0, 0, TAU);
      ctx.fill();
    } else if (a.shape === 'fern') {
      const fronds = Math.max(2, Math.min(5, Math.round(a.params.fronds || 3)));
      for (let f = 0; f < fronds; f += 1) {
        const offset = (f - (fronds - 1) / 2) * 10 * scale;
        const height = (78 + rnd() * 18) * scale;
        const lean = (f - (fronds - 1) / 2) * 17 * scale;
        ctx.strokeStyle = a.color;
        ctx.lineWidth = Math.max(1.2, 1.8 * scale);
        ctx.beginPath();
        ctx.moveTo(offset, 0);
        ctx.bezierCurveTo(offset + lean * 0.4, -height * 0.4, offset + lean + sway, -height * 0.72, offset + lean + sway, -height);
        ctx.stroke();
        for (let j = 1; j <= 5; j += 1) {
          const u = j / 6;
          const x = offset + lean * u + sway * u;
          const y = -height * u;
          const size = (22 * scale) * (1 - u * 0.46);
          for (const side of [-1, 1]) {
            ctx.save();
            ctx.translate(x, y);
            ctx.rotate(side * (0.72 - u * 0.12));
            drawLeaf(size, size * 0.34, side < 0 ? a.color : highlight, 0.92);
            ctx.restore();
          }
        }
      }
    } else {
      const stems = Math.max(2, Math.min(6, Math.round(a.params.stems || a.params.leaves || 4)));
      for (let s = 0; s < stems; s += 1) {
        const offset = (s - (stems - 1) / 2) * 9 * scale;
        const height = (a.params.height || 0.5) * 138 * scale * (0.78 + rnd() * 0.34);
        const lean = (rnd() - 0.5) * 36 * scale;
        const tipX = offset + lean + sway;
        ctx.strokeStyle = a.color;
        ctx.lineWidth = Math.max(1.2, (a.params.width || 0.02) * 110 * scale);
        ctx.beginPath();
        ctx.moveTo(offset, 0);
        ctx.bezierCurveTo(offset + lean * 0.2, -height * 0.32, offset + lean * 0.8 + sway, -height * 0.72, tipX, -height);
        ctx.stroke();
        const pairs = Math.max(3, Math.min(6, Math.round((a.params.leaves || 7) / 2)));
        for (let j = 1; j <= pairs; j += 1) {
          const u = j / (pairs + 1);
          const x = offset + lean * u + sway * u;
          const y = -height * u;
          const length = 24 * scale * (1 - u * 0.28);
          for (const side of [-1, 1]) {
            if (s % 2 && j % 2 && side > 0) continue;
            ctx.save();
            ctx.translate(x, y);
            ctx.rotate(side * (0.78 - u * 0.12));
            drawLeaf(length, length * 0.31, side < 0 ? a.color : highlight, 0.88);
            ctx.restore();
          }
        }
        ctx.save();
        ctx.translate(tipX, -height);
        drawLeaf(22 * scale, 7 * scale, highlight, 0.9);
        ctx.restore();
      }
    }
    ctx.restore();
  }

  function getDecorCache(item) {
    const signature = `${item.kind}:${item.type}:${item.seed}`;
    let entry = decorCache.get(item.id);
    if (entry?.signature === signature) {
      decorCache.delete(item.id);
      decorCache.set(item.id, entry);
      return entry;
    }
    decorCache.delete(item.id);
    const a = decorAppearance(item.kind, item.type, item.seed);
    if (!a) return null;
    if (item.kind === 'rock') {
      const path = new Path2D();
      if (a.shape === 'layered') {
        for (let i = 0; i < 3; i += 1) {
          const w = 1 - i * 0.16;
          const h = 0.22;
          path.rect(-w / 2 + (i % 2 ? 0.025 : -0.025), -h * (i + 1) * 1.15, w, h);
        }
      } else if (a.shape === 'ridged' || a.shape === 'blocky') {
        for (let i = 0; i < 7; i += 1) {
          const angle = (i / 7) * TAU;
          const r = 0.36 + ((i * 37 + item.seed) % 10) * 0.022;
          const px = Math.cos(angle) * r;
          const py = Math.sin(angle) * r * 0.62;
          if (i === 0) path.moveTo(px, py); else path.lineTo(px, py);
        }
        path.closePath();
      } else path.ellipse(0, 0, 0.44, 0.26, 0, 0, TAU);
      const highlight = new Path2D();
      highlight.moveTo(-0.34, -0.08);
      highlight.lineTo(-0.12, -0.27);
      highlight.lineTo(0.1, -0.2);
      highlight.lineTo(0.01, -0.05);
      highlight.closePath();
      const shade = new Path2D();
      shade.moveTo(-0.28, 0.08);
      shade.lineTo(0.3, 0.04);
      shade.lineTo(0.16, 0.2);
      shade.lineTo(-0.08, 0.21);
      shade.closePath();
      entry = { signature, appearance: a, path, highlight, shade };
    } else {
      const trunk = new Path2D();
      trunk.moveTo(-0.4, 0);
      trunk.bezierCurveTo(-0.1, -0.3, 0.1, -0.2, 0.4, -0.42);
      const branches = new Path2D();
      for (let i = 0; i < 3; i += 1) {
        const u = 0.3 + i * 0.2;
        branches.moveTo(-0.4 + 0.8 * u, -0.28 * u);
        branches.lineTo(-0.4 + 0.8 * u + 0.2, -(0.45 + i * 0.06));
      }
      entry = { signature, appearance: a, trunk, branches };
    }
    decorCache.set(item.id, entry);
    while (decorCache.size > 32) decorCache.delete(decorCache.keys().next().value);
    return entry;
  }

  function drawRock(item) {
    const cached = getDecorCache(item);
    if (!cached) return;
    const { appearance: a } = cached;
    const x = item.x * W;
    const y = H * 0.84 - (1 - item.z) * 16;
    const s = (a.params.size || 0.24) * 280 * item.scale * (0.8 + item.z * 0.4);
    ctx.save();
    ctx.translate(x, y);
    ctx.scale(s, s);
    ctx.fillStyle = 'rgba(35, 49, 42, 0.16)';
    ctx.beginPath();
    ctx.ellipse(3 / s, 0.12, 0.48, 0.16, 0, 0, TAU);
    ctx.fill();
    ctx.fillStyle = a.color;
    ctx.fill(cached.path);
    ctx.globalAlpha = 0.32;
    ctx.fillStyle = a.highlight;
    ctx.fill(cached.highlight);
    ctx.globalAlpha = 0.15;
    ctx.fillStyle = '#203a33';
    ctx.fill(cached.shade);
    ctx.restore();
  }

  function drawWood(item) {
    const cached = getDecorCache(item);
    if (!cached) return;
    const { appearance: a } = cached;
    const x = item.x * W;
    const y = H * 0.84 - (1 - item.z) * 14;
    const s = (a.params.length || 0.6) * 175 * item.scale;
    ctx.save();
    ctx.translate(x, y);
    ctx.scale(s, s);
    ctx.lineCap = 'round';
    const trunkWidth = Math.max(2, (a.params.girth || 0.04) * 130 * item.scale);
    const normalizedWidth = trunkWidth / s;
    ctx.strokeStyle = 'rgba(31, 44, 36, 0.18)';
    ctx.lineWidth = normalizedWidth * 1.12;
    ctx.save(); ctx.translate(0, 3 / s); ctx.stroke(cached.trunk); ctx.restore();
    ctx.strokeStyle = a.color;
    ctx.lineWidth = normalizedWidth;
    ctx.stroke(cached.trunk);
    ctx.strokeStyle = a.highlight || '#d6c59a';
    ctx.globalAlpha = 0.5;
    ctx.lineWidth = Math.max(1, trunkWidth * 0.24) / s;
    ctx.save(); ctx.translate(0, -trunkWidth * 0.16 / s); ctx.stroke(cached.trunk); ctx.restore();
    ctx.globalAlpha = 1;
    ctx.strokeStyle = 'rgba(31, 44, 36, 0.16)';
    ctx.lineWidth = Math.max(1, trunkWidth * 0.42) / s;
    ctx.save(); ctx.translate(0, 2 / s); ctx.stroke(cached.branches); ctx.restore();
    ctx.strokeStyle = a.color;
    ctx.lineWidth = Math.max(1.4, trunkWidth * 0.5) / s;
    ctx.stroke(cached.branches);
    ctx.strokeStyle = a.highlight || '#d6c59a';
    ctx.globalAlpha = 0.45;
    ctx.lineWidth = Math.max(0.7, trunkWidth * 0.15) / s;
    ctx.save(); ctx.translate(0, -0.6 / s); ctx.stroke(cached.branches); ctx.restore();
    ctx.globalAlpha = 1;
    ctx.restore();
  }

  function drawFish(agent, t) {
    const a = agent.appearance;
    const type = FISH_TYPE_BY_ID[agent.fish.species] || FISH_TYPE_BY_ID.sunset;
    const props = fishProportions(agent.fish.growth);
    const scale = (H / 460) * 53 * (type.body.len / 0.62) * fishSizeFactor(agent.fish.growth) * a.lenScale;
    const bodyLen = scale * 1.5;
    const depth = type.body.depth * bodyLen;
    const swimMotion = reduceMotion ? 0.38 : 1;
    // An untouched fish starts at -Infinity; sin(Infinity) * 0 is still NaN
    // and silently invalidates the Canvas transform before its first greeting.
    const greetAge = Number.isFinite(agent.greetAt) ? t - agent.greetAt : -1;
    const greetPulse = greetAge >= 0 && greetAge < 1.4 ? Math.sin((1 - greetAge / 1.4) * Math.PI * 0.5) : 0;
    const wiggle = Math.sin(t * (2.2 + type.motion.freq) * swimMotion + a.phase) * type.motion.wag * swimMotion
      + Math.sin(greetAge * 8) * greetPulse * 0.12;
    const pose = uprightFishPose(agent.angle);
    ctx.save();
    ctx.translate(agent.x, agent.y - Math.sin(greetAge * 7) * greetPulse * 1.2);
    ctx.rotate(pose.tilt);
    ctx.scale(pose.flipX ? -1 : 1, 1);
    ctx.globalAlpha = isNight ? 0.88 : 0.96;

    // 尾鳍
    ctx.fillStyle = a.fin;
    ctx.beginPath();
    const tail = type.fins.tail;
    const tailLen = bodyLen * (type.fins.tailSize || 0.4) * props.fin;
    ctx.moveTo(-bodyLen * 0.46, 0);
    if (tail === 'fork') {
      ctx.quadraticCurveTo(-bodyLen * 0.7, -depth * 0.2 + wiggle * 2, -bodyLen * 0.46 - tailLen, -depth * 0.46);
      ctx.quadraticCurveTo(-bodyLen * 0.6, 0, -bodyLen * 0.46 - tailLen, depth * 0.46);
    } else if (tail === 'veil') {
      ctx.quadraticCurveTo(-bodyLen * 0.8, -depth * 0.5 + wiggle * 3, -bodyLen * 0.5 - tailLen, -depth * 0.62);
      ctx.quadraticCurveTo(-bodyLen * 0.62, 0, -bodyLen * 0.5 - tailLen, depth * 0.62);
    } else {
      ctx.quadraticCurveTo(-bodyLen * 0.7, -depth * 0.5 + wiggle * 2, -bodyLen * 0.5 - tailLen * 0.8, -depth * 0.3);
      ctx.quadraticCurveTo(-bodyLen * 0.56, 0, -bodyLen * 0.5 - tailLen * 0.8, depth * 0.3);
    }
    ctx.closePath();
    ctx.fill();

    // 背鳍/臀鳍
    ctx.globalAlpha *= 0.9;
    ctx.beginPath();
    ctx.moveTo(bodyLen * 0.12, -depth * 0.42);
    ctx.quadraticCurveTo(-bodyLen * 0.1, -depth * (0.55 + (type.fins.dorsalSize || 0.2)), -bodyLen * 0.3, -depth * 0.3);
    ctx.closePath();
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(bodyLen * 0.02, depth * 0.4);
    ctx.quadraticCurveTo(-bodyLen * 0.12, depth * (0.5 + (type.fins.anal || 0.2) * 0.6), -bodyLen * 0.28, depth * 0.3);
    ctx.closePath();
    ctx.fill();
    ctx.globalAlpha = isNight ? 0.86 : 0.96;

    // 身体
    const grad = ctx.createLinearGradient(0, -depth * 0.5, 0, depth * 0.5);
    grad.addColorStop(0, a.body);
    grad.addColorStop(0.55, a.body);
    grad.addColorStop(1, a.belly);
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.moveTo(bodyLen * 0.5, 0);
    ctx.bezierCurveTo(bodyLen * 0.42, -depth * 0.55, -bodyLen * 0.1, -depth * 0.58, -bodyLen * 0.46, -depth * 0.12);
    ctx.bezierCurveTo(-bodyLen * 0.5, 0, -bodyLen * 0.48, depth * 0.14, -bodyLen * 0.42, depth * 0.16);
    ctx.bezierCurveTo(-bodyLen * 0.05, depth * 0.6, bodyLen * 0.4, depth * 0.5, bodyLen * 0.5, 0);
    ctx.fill();
    ctx.strokeStyle = 'rgba(27, 58, 51, 0.24)';
    ctx.lineWidth = Math.max(0.8, bodyLen * 0.009);
    ctx.stroke();

    // A restrained pectoral fin gives the body a clear layered silhouette.
    ctx.globalAlpha *= 0.58;
    ctx.fillStyle = a.fin;
    ctx.beginPath();
    ctx.ellipse(-bodyLen * 0.02, depth * 0.09, bodyLen * 0.11, depth * 0.13, -0.52, 0, TAU);
    ctx.fill();
    ctx.globalAlpha = isNight ? 0.88 : 0.96;

    // 花纹
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(bodyLen * 0.5, 0);
    ctx.bezierCurveTo(bodyLen * 0.42, -depth * 0.55, -bodyLen * 0.1, -depth * 0.58, -bodyLen * 0.46, -depth * 0.12);
    ctx.bezierCurveTo(-bodyLen * 0.5, 0, -bodyLen * 0.48, depth * 0.14, -bodyLen * 0.42, depth * 0.16);
    ctx.bezierCurveTo(-bodyLen * 0.05, depth * 0.6, bodyLen * 0.4, depth * 0.5, bodyLen * 0.5, 0);
    ctx.clip();
    ctx.fillStyle = a.accent;
    ctx.globalAlpha *= 0.34;
    if (a.pattern === 'stripe') {
      for (let i = 0; i < 3; i += 1) {
        ctx.fillRect(bodyLen * (0.1 - i * 0.18), -depth * 0.6, bodyLen * 0.06, depth * 1.2);
      }
    } else if (a.pattern === 'band') {
      ctx.fillRect(-bodyLen * 0.5, -depth * 0.1, bodyLen, depth * 0.18);
    } else if (a.pattern === 'spot') {
      for (let i = 0; i < 5; i += 1) {
        ctx.beginPath();
        ctx.arc(bodyLen * (0.3 - i * 0.14), depth * (i % 2 ? 0.14 : -0.1), bodyLen * 0.035, 0, TAU);
        ctx.fill();
      }
    } else if (a.pattern === 'saddle') {
      ctx.fillRect(-bodyLen * 0.1, -depth * 0.6, bodyLen * 0.3, depth * 0.3);
    } else if (a.pattern === 'gradient') {
      const g2 = ctx.createLinearGradient(-bodyLen * 0.5, 0, bodyLen * 0.4, 0);
      g2.addColorStop(0, a.accent);
      g2.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = g2;
      ctx.fillRect(-bodyLen * 0.5, -depth * 0.6, bodyLen, depth * 1.2);
    }
    ctx.restore();

    // 眼睛
    ctx.fillStyle = a.eye;
    ctx.beginPath();
    ctx.arc(bodyLen * 0.34, -depth * 0.1, bodyLen * 0.021 * props.eye, 0, TAU);
    ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,0.85)';
    ctx.beginPath();
    ctx.arc(bodyLen * 0.35, -depth * 0.12, bodyLen * 0.008, 0, TAU);
    ctx.fill();
    ctx.restore();
  }

  function render(ts) {
    if (disposed || paused) return;
    if (!renderPolicy.shouldRender(ts)) {
      raf = requestAnimationFrame(render);
      return;
    }
    const workStartedAt = now();
    const t = ts / 1000;
    const dt = last ? Math.min((ts - last) / 1000, 0.25) : 0;
    last = ts;
    nightMix += ((isNight ? 1 : 0) - nightMix) * Math.min(1, dt * 1.5);
    update(dt, t);
    drawBackground(t);
    // Both draw lists are refreshed by setState; sorting in place avoids a per-frame array copy.
    for (const item of decorDrawList) {
      if (item.kind === 'plant') drawPlant(item, t);
      else if (item.kind === 'rock') drawRock(item);
      else drawWood(item);
    }
    // 鱼按 y 排序，形成前后遮挡
    fishDrawList.sort((a, b) => a.y - b.y);
    for (const agent of fishDrawList) drawFish(agent, t);
    for (const food of foods) {
      ctx.fillStyle = '#e6cd96';
      ctx.beginPath();
      ctx.arc(food.x, food.y, 2.4, 0, TAU);
      ctx.fill();
    }
    for (const ripple of ripples) {
      ctx.strokeStyle = `rgba(226,242,232,${Math.max(0, 0.4 - ripple.age * 0.24)})`;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.ellipse(ripple.x, ripple.y, 8 + ripple.age * 40, 3 + ripple.age * 14, 0, 0, TAU);
      ctx.stroke();
    }
    renderPolicy.recordWork(now() - workStartedAt, ts);
    applyEffectsLevel();
    raf = requestAnimationFrame(render);
  }

  function start() {
    if (raf || disposed || !requestedVisible || paused) return;
    last = 0;
    raf = requestAnimationFrame(render);
  }
  function stop() {
    if (raf) cancelAnimationFrame(raf);
    raf = null;
  }

  function pointerToLocal(event) {
    const rect = canvas.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  }

  function greetNearby(x, y, t) {
    const nearest = agentList
      .map((agent) => ({ agent, distance: (agent.x - x) ** 2 + (agent.y - y) ** 2 }))
      .sort((a, b) => a.distance - b.distance)
      .slice(0, 3);
    for (const { agent } of nearest) agent.greetAt = t;
  }

  function onPointerDown(event) {
    notifyInteraction();
    pointerGestures.set(event.pointerId, {
      x: event.clientX,
      y: event.clientY,
      maxDistance: 0,
      downAt: now(),
      pointerType: event.pointerType,
      multi: false
    });
    if (pointerGestures.size > 1) {
      for (const gesture of pointerGestures.values()) gesture.multi = true;
    }
    canvas.setPointerCapture?.(event.pointerId);
  }

  function onPointerMove(event) {
    const gesture = pointerGestures.get(event.pointerId);
    if (!gesture) return;
    notifyInteraction();
    gesture.maxDistance = Math.max(gesture.maxDistance, Math.hypot(event.clientX - gesture.x, event.clientY - gesture.y));
  }

  function onPointerUp(event) {
    notifyInteraction();
    const gesture = pointerGestures.get(event.pointerId);
    pointerGestures.delete(event.pointerId);
    if (!gesture || gesture.multi || event.type === 'pointercancel') return;
    if (now() - gesture.downAt > 500 || gesture.maxDistance > 8) return;
    const p = pointerToLocal(event);
    let picked = null;
    let best = 34;
    for (const agent of agentList) {
      const d = Math.hypot(agent.x - p.x, agent.y - p.y);
      if (d < best) { best = d; picked = agent; }
    }
    if (picked) {
      picked.greetAt = now() / 1000;
      onPickFish(picked.id);
      return;
    }
    if (ripples.length >= 8) ripples.shift();
    ripples.push({ x: p.x, y: p.y, age: 0 });
    greetNearby(p.x, p.y, now() / 1000);
  }

  canvas.addEventListener('pointerdown', onPointerDown, { signal: listenerController.signal });
  canvas.addEventListener('pointermove', onPointerMove, { signal: listenerController.signal });
  canvas.addEventListener('pointerup', onPointerUp, { signal: listenerController.signal });
  canvas.addEventListener('pointercancel', onPointerUp, { signal: listenerController.signal });

  function feedRandom() {
    notifyInteraction();
    if (spawnFood(W * (0.35 + Math.random() * 0.3), H * 0.3, 6)) onFeed({ source: 'button' });
  }

  const onKeyDown = event => {
    notifyInteraction();
    if (event.code !== 'Space' && event.key !== ' ') return;
    event.preventDefault();
    feedRandom();
  };
  canvas.addEventListener('keydown', onKeyDown, { signal: listenerController.signal });

  resize();
  start();

  return {
    setState, setNight, resize, feedRandom, spawnFood,
    setQualityPolicy,
    setActivity,
    notifyInteraction,
    pause() { paused = true; setActivity({}); },
    resume() { paused = false; setActivity({}); },
    dispose() {
      if (disposed) return;
      disposed = true;
      stop();
      listenerController.abort();
      renderPolicy.setActivity({ visible: false });
      agents.clear();
      agentList.length = 0;
      fishDrawList.length = 0;
      decorDrawList.length = 0;
      decorCache.clear();
      pointerGestures.clear();
      foods.length = 0;
      ripples.length = 0;
    },
    get kind() { return '2d'; },
    get performanceInfo() { return renderPolicy.performanceInfo; },
    get motionInfo() {
      return {foodCount:foods.length,fish:[...agents.values()].map(a=>({id:a.id,x:a.x,y:a.y,heading:a.angle,...uprightFishPose(a.angle)}))};
    }
  };
}
