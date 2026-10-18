// 2D 降级渲染器：与 3D 读取同一份存档（同一批鱼、同一批造景、同一外观 seed）。
//
// 用途：WebGL 不可用 / 上下文丢失 / 用户主动切到 2D / 低端设备省电。
// 只做「看得懂、玩得动」：鱼、水草、石头、沉木、食物、水波、昼夜；
// 布景拖拽只在 3D 提供，2D 下会提示切回 3D 编辑（见 index.html 的提示）。
import { FISH_TYPE_BY_ID, DECOR_KINDS } from './catalog.js';
import { fishAppearance, decorAppearance, fishSizeFactor, fishProportions, mulberry32, hashSeed } from './model.js';

const TAU = Math.PI * 2;
const clamp = (n, a, b) => Math.min(b, Math.max(a, n));

export function createView2D({
  canvas,
  night = false,
  reduceMotion = false,
  onPickFish = () => {},
  onEat = () => {},
  onFeed = () => {}
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
  const agents = new Map();
  const foods = [];
  const ripples = [];

  function resize() {
    const rect = canvas.getBoundingClientRect();
    W = Math.max(2, rect.width);
    H = Math.max(2, rect.height);
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function setState(next) {
    state = next;
    const seen = new Set();
    next.fish.forEach((fish) => {
      seen.add(fish.id);
      let agent = agents.get(fish.id);
      if (!agent) {
        agent = {
          id: fish.id,
          x: W * (0.2 + Math.random() * 0.6),
          y: H * (0.3 + Math.random() * 0.4),
          angle: Math.random() * TAU,
          speed: 20,
          phase: Math.random() * TAU,
          bend: 0,
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
    });
    for (const [id] of agents) if (!seen.has(id)) agents.delete(id);
  }

  function setNight(on) {
    isNight = Boolean(on);
  }

  function spawnFood(x, y, count = 5) {
    for (let i = 0; i < count; i += 1) {
      foods.push({ x: x + (Math.random() - 0.5) * 26, y: y + (Math.random() - 0.5) * 10, vy: 9 + Math.random() * 6, age: 0 });
    }
    if (foods.length > 40) foods.splice(0, foods.length - 40);
    ripples.push({ x, y, age: 0 });
  }

  /** 鱼在 2D 里的可用水层：上留水面、下留沙面与前景水草。 */
  function bounds() {
    return { top: H * 0.22, bottom: H * 0.82, left: 18, right: W - 18 };
  }

  function update(dt, t) {
    const b = bounds();
    const list = [...agents.values()];
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
      if (target && best < 260) {
        desired = Math.atan2(target.y - agent.y, target.x - agent.x);
        speed = agent.baseSpeed * 1.8;
        if (best < 14) {
          const index = foods.indexOf(target);
          if (index >= 0) foods.splice(index, 1);
          onEat(fish.id, { x: target.x, y: target.y });
        }
      } else {
        agent.phase += dt * 0.5;
        desired = agent.angle + Math.sin(t * 0.45 + agent.phase) * dt * 1.2;
        speed = agent.baseSpeed * (0.85 + 0.25 * Math.sin(t * 0.3 + agent.phase));
      }
      const margin = 70;
      if (agent.x > b.right - margin) desired += (1 - (b.right - agent.x) / margin) * 1.5;
      if (agent.x < b.left + margin) desired -= (1 - (agent.x - b.left) / margin) * 1.5;
      if (agent.y < b.top + 40) desired += (1 - (agent.y - b.top) / 40) * 1.2;
      if (agent.y > b.bottom - 40) desired -= (1 - (b.bottom - agent.y) / 40) * 1.2;
      // 避开大型石头/沉木的横向位置，避免「穿石头」
      for (const item of state.decor) {
        if (item.kind === 'plant') continue;
        const cx = item.x * W;
        const cw = (item.kind === 'rock' ? 46 : 60) * item.scale;
        if (Math.abs(agent.x - cx) < cw && agent.y > b.bottom - 70) desired = agent.x < cx ? Math.PI : 0;
      }
      for (const other of list) {
        if (other === agent) continue;
        const d = Math.hypot(other.x - agent.x, other.y - agent.y);
        if (d < 26 && d > 0.001) desired = Math.atan2(agent.y - other.y, agent.x - other.x);
      }
      const diff = Math.atan2(Math.sin(desired - agent.angle), Math.cos(desired - agent.angle));
      const turn = clamp(diff, -agent.turnRate * dt, agent.turnRate * dt);
      agent.angle += turn;
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
    const bg = ctx.createLinearGradient(0, 0, 0, H);
    const nightK = nightMix;
    const mix = (a, b) => `rgb(${Math.round(a[0] + (b[0] - a[0]) * nightK)},${Math.round(a[1] + (b[1] - a[1]) * nightK)},${Math.round(a[2] + (b[2] - a[2]) * nightK)})`;
    bg.addColorStop(0, mix([126, 178, 170], [17, 36, 43]));
    bg.addColorStop(0.55, mix([96, 156, 149], [14, 32, 38]));
    bg.addColorStop(1, mix([72, 128, 122], [10, 26, 31]));
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, W, H);

    // 柔和光柱
    for (let i = 0; i < 4; i += 1) {
      const x = W * (0.16 + i * 0.22) + Math.sin(t * 0.12 + i) * 14;
      const g = ctx.createLinearGradient(x, 0, x + 60, H);
      g.addColorStop(0, `rgba(255,252,238,${0.16 * (1 - nightMix * 0.6)})`);
      g.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.moveTo(x - 26, 0);
      ctx.lineTo(x + 22, 0);
      ctx.lineTo(x + 120, H);
      ctx.lineTo(x - 46, H);
      ctx.fill();
    }
    // 水面波纹
    ctx.strokeStyle = `rgba(255,255,255,${0.22 * (1 - nightMix * 0.4)})`;
    ctx.lineWidth = 1;
    for (let i = 0; i < 3; i += 1) {
      ctx.beginPath();
      for (let x = 0; x <= W; x += 12) {
        const y = 14 + i * 7 + Math.sin(x * 0.02 + t * (0.8 + i * 0.2)) * 2.2;
        if (x === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
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
    ctx.save();
    ctx.translate(baseX, baseY);
    ctx.strokeStyle = a.color;
    ctx.fillStyle = a.color;
    const count = a.shape === 'carpet' ? 26 : a.shape === 'moss' ? 5 : Math.round((a.params.blades || a.params.leaves || a.params.fronds || a.params.stems || 5) * 0.8);
    for (let i = 0; i < count; i += 1) {
      const lean = (rnd() - 0.5) * 46 * scale;
      const h = (a.params.height || 0.5) * 120 * scale * (0.6 + rnd() * 0.6);
      const sway = Math.sin(t * 0.7 + i * 1.7 + item.seed % 7) * 5 * scale * (reduceMotion ? 0.3 : 1);
      ctx.globalAlpha = 0.55 + rnd() * 0.4;
      ctx.lineWidth = Math.max(1, (a.params.width || 0.02) * 260 * scale);
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.bezierCurveTo(lean * 0.2, -h * 0.35, lean + sway, -h * 0.7, lean + sway * 1.4, -h);
      ctx.stroke();
      if (a.shape === 'rosette' || a.shape === 'fern' || a.shape === 'stem') {
        ctx.beginPath();
        ctx.ellipse(lean + sway, -h * 0.8, 7 * scale, 3.4 * scale, lean * 0.01, 0, TAU);
        ctx.fill();
      }
    }
    ctx.restore();
  }

  function drawRock(item) {
    const a = decorAppearance('rock', item.type, item.seed);
    if (!a) return;
    const x = item.x * W;
    const y = H * 0.84 - (1 - item.z) * 16;
    const s = (a.params.size || 0.24) * 280 * item.scale * (0.8 + item.z * 0.4);
    ctx.save();
    ctx.translate(x, y);
    ctx.fillStyle = a.color;
    ctx.beginPath();
    if (a.shape === 'layered') {
      const layers = 3;
      for (let i = 0; i < layers; i += 1) {
        const w = s * (1 - i * 0.16);
        const h = s * 0.22;
        ctx.rect(-w / 2 + (i % 2 ? 2 : -2), -h * (i + 1) * 1.15, w, h);
      }
    } else if (a.shape === 'ridged' || a.shape === 'blocky') {
      const pts = 7;
      for (let i = 0; i < pts; i += 1) {
        const angle = (i / pts) * TAU;
        const r = s * (0.36 + ((i * 37 + item.seed) % 10) * 0.022);
        const px = Math.cos(angle) * r;
        const py = Math.sin(angle) * r * 0.62;
        if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
      }
      ctx.closePath();
    } else {
      ctx.ellipse(0, 0, s * 0.44, s * 0.26, 0, 0, TAU);
    }
    ctx.fill();
    ctx.globalAlpha = 0.35;
    ctx.fillStyle = a.highlight;
    ctx.beginPath();
    ctx.ellipse(-s * 0.12, -s * 0.1, s * 0.2, s * 0.08, -0.4, 0, TAU);
    ctx.fill();
    ctx.restore();
  }

  function drawWood(item) {
    const a = decorAppearance('wood', item.type, item.seed);
    if (!a) return;
    const x = item.x * W;
    const y = H * 0.84 - (1 - item.z) * 14;
    const s = (a.params.length || 0.6) * 175 * item.scale;
    ctx.save();
    ctx.translate(x, y);
    ctx.strokeStyle = a.color;
    ctx.lineCap = 'round';
    ctx.lineWidth = Math.max(2, (a.params.girth || 0.04) * 130 * item.scale);
    ctx.beginPath();
    ctx.moveTo(-s * 0.4, 0);
    ctx.bezierCurveTo(-s * 0.1, -s * 0.3, s * 0.1, -s * 0.2, s * 0.4, -s * 0.42);
    ctx.stroke();
    ctx.lineWidth = Math.max(1.4, ctx.lineWidth * 0.5);
    for (let i = 0; i < 3; i += 1) {
      const t = 0.3 + i * 0.2;
      ctx.beginPath();
      ctx.moveTo(-s * 0.4 + s * 0.8 * t, -s * 0.28 * t);
      ctx.lineTo(-s * 0.4 + s * 0.8 * t + s * 0.2, -s * (0.45 + i * 0.06));
      ctx.stroke();
    }
    ctx.restore();
  }

  function drawFish(agent, t) {
    const a = agent.appearance;
    const type = FISH_TYPE_BY_ID[agent.fish.species] || FISH_TYPE_BY_ID.sunset;
    const props = fishProportions(agent.fish.growth);
    const scale = (H / 460) * 70 * fishSizeFactor(agent.fish.growth) * a.lenScale;
    const bodyLen = scale * 1.5;
    const depth = type.body.depth * bodyLen;
    const wiggle = Math.sin(t * (2.2 + type.motion.freq) + a.phase) * type.motion.wag;
    ctx.save();
    ctx.translate(agent.x, agent.y);
    ctx.rotate(agent.angle);
    ctx.globalAlpha = isNight ? 0.86 : 0.96;

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
    ctx.arc(bodyLen * 0.34, -depth * 0.1, bodyLen * 0.028 * props.eye, 0, TAU);
    ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,0.85)';
    ctx.beginPath();
    ctx.arc(bodyLen * 0.35, -depth * 0.12, bodyLen * 0.01, 0, TAU);
    ctx.fill();
    ctx.restore();
  }

  function render(ts) {
    if (disposed || paused) return;
    const t = ts / 1000;
    const dt = last ? Math.min((ts - last) / 1000, 0.05) : 0;
    last = ts;
    nightMix += ((isNight ? 1 : 0) - nightMix) * Math.min(1, dt * 1.5);
    update(dt, t);
    drawBackground(t);
    // 造景按 z 排序：后面的先画
    const decor = [...(state?.decor || [])].sort((a, b) => a.z - b.z);
    for (const item of decor) {
      if (item.kind === 'plant') drawPlant(item, t);
      else if (item.kind === 'rock') drawRock(item);
      else drawWood(item);
    }
    // 鱼按 y 排序，形成前后遮挡
    [...agents.values()].sort((a, b) => a.y - b.y).forEach((agent) => drawFish(agent, t));
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
    raf = requestAnimationFrame(render);
  }

  function start() {
    if (raf || disposed) return;
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

  canvas.addEventListener('pointerdown', (event) => {
    const p = pointerToLocal(event);
    let picked = null;
    let best = 34;
    for (const agent of agents.values()) {
      const d = Math.hypot(agent.x - p.x, agent.y - p.y);
      if (d < best) { best = d; picked = agent; }
    }
    if (picked) {
      onPickFish(picked.id);
      return;
    }
    spawnFood(p.x, p.y, 5);
    onFeed({ x: p.x, y: p.y, source: 'tap' });
  });

  function feedRandom() {
    spawnFood(W * (0.35 + Math.random() * 0.3), H * 0.3, 6);
    onFeed({ source: 'button' });
  }

  resize();
  start();

  return {
    setState, setNight, resize, feedRandom, spawnFood,
    pause() { paused = true; stop(); },
    resume() { paused = false; start(); },
    dispose() {
      disposed = true;
      stop();
      agents.clear();
      foods.length = 0;
    },
    get kind() { return '2d'; }
  };
}
