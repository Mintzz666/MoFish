// MoFish 单人完整体验（阶段 B）：把领域状态、云同步、2D/3D 渲染与布景编辑接在一起。
//
// 分工：
// - 领域与持久化：web/model.js（v2 存档、四阶段成长、造景增删改）
// - 同步：web/cloud/*（A 的账号/冲突/离线保留不变，新增进食记账）
// - 渲染：web/aquarium/view3d.js（Three.js）与 web/view2d.js（降级），两者读同一份存档
// - 本文件只做接线、界面状态与用户操作，不自己算成长公式。
import {
  MAX_FISH, STATE_VERSION, STAGES, GROWTH, DECOR_KINDS, DECOR_MAX, FISH_TYPES,
  initial, makeFish, validate, catchUp, eat, canonicalState, cloneState,
  addDecor, removeDecor, reshuffleDecor, updateDecor, stageOf, ageDays, growthToNextStage,
  fishAppearance, decorAppearance
} from './model.js';
import { DECOR_KINDS as KIND_META } from './catalog.js';
import { createLocalStore, keys } from './storage.js';
import { readCloudConfig } from './cloud/config.js';
import { createCloudStack } from './cloud/client.js';
import { createSyncEngine, STATUS } from './cloud/sync.js';
import { parseAuthCallback } from './cloud/auth.js';
import { createAccountUI } from './ui/account.js';
import { createView3D } from './aquarium/view3d.js';
import { createView2D } from './view2d.js';
import { createDecorHistory } from './decor-history.js';

const $ = (id) => document.getElementById(id);
const bootAt = typeof performance !== 'undefined' ? performance.now() : 0;
let canvas = $('tank');
const floatBar = $('decor-float');
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
const PREFS_KEY = 'mofish.prefs';

// ------------------------------------------------------------------ 本机偏好（不进存档/不上云）
function readPrefs() {
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch { return {}; }
}
function writePrefs(patch) {
  try { localStorage.setItem(PREFS_KEY, JSON.stringify({ ...readPrefs(), ...patch })); } catch { /* 隐私模式忽略 */ }
}
const prefs = readPrefs();
const isPhone = matchMedia('(max-width: 720px)').matches || /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
let quality = prefs.quality === 'low' || prefs.quality === 'high' ? prefs.quality : (isPhone ? 'low' : 'high');

function supportsWebGL() {
  try {
    const probe = document.createElement('canvas');
    const gl = probe.getContext('webgl2') || probe.getContext('webgl');
    if (!gl) return false;
    const lose = gl.getExtension('WEBGL_lose_context');
    if (lose) lose.loseContext();
    return true;
  } catch { return false; }
}

// ------------------------------------------------------------------ 本地状态与云栈
const store = createLocalStore(localStorage);
const config = readCloudConfig(globalThis.__MOFISH_CONFIG__ || {});
const stack = createCloudStack({ config, store, emailRedirectTo: location.origin + location.pathname });
let accountUI = null;

let state;
let loadWarning = false;
{
  let raw = null;
  let saved = null;
  try {
    raw = localStorage.getItem(keys.guest());
    saved = store.readGuest();
  } catch { loadWarning = true; }
  state = saved || initial();
  if (raw !== null && !saved) loadWarning = true;
}

let viewMode = '3d';                 // '3d' | '2d'（渲染器）
let editMode = 'view';               // 'view' | 'decor'（交互模式）
let view = null;
let activeFishId = null;
let selectedDecorId = null;
let pendingDecorId = null;
let lastDragDecorId = null;
let toastTimer;
const undoStack = createDecorHistory({ getScope: () => engine.generation });
let lastStatusMessage = '';
let resizeObserver = null;
let switchingRenderer = false;

function toast(text) {
  $('toast').textContent = text;
  $('toast').classList.add('visible');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => $('toast').classList.remove('visible'), 3400);
}

// ------------------------------------------------------------------ 渲染器
/**
 * 同一个 canvas 元素不能同时拥有 2D 与 WebGL 上下文（先取 2d 就再也拿不到 webgl，反之亦然）。
 * 切换渲染器时换一块全新的 canvas，旧的一块连同它的上下文一起丢弃。
 */
function replaceCanvas() {
  const next = document.createElement('canvas');
  next.id = 'tank';
  next.tabIndex = 0;
  next.setAttribute('aria-label', canvas.getAttribute('aria-label') || '鱼缸');
  canvas.replaceWith(next);
  canvas = next;
  resizeObserver?.disconnect();
  resizeObserver?.observe(canvas);
  return next;
}

function disposeView() {
  if (view) {
    try { view.dispose(); } catch { /* 忽略释放异常，继续切换 */ }
    view = null;
  }
}

function createView(kind) {
  if (kind === '2d') {
    return createView2D({
      canvas,
      night: state.night,
      reduceMotion,
      onPickFish: (id) => selectFish(id),
      onEat: (fishId) => handleEat(fishId),
      onFeed: () => showTip('小鱼正在赶来，今天也有好好吃饭。')
    });
  }
  return createView3D({
    canvas,
    quality,
    night: state.night,
    reduceMotion,
    onEat: (fishId) => handleEat(fishId),
    onPickFish: (id) => selectFish(id),
    onPickDecor: (id) => { if (id) selectDecor(id); },
    onDecorMove: (id, transform, commit) => moveDecorFromView(id, transform, commit),
    onDecorCommit: (id, transform) => moveDecorFromView(id, transform, true),
    onFeed: () => showTip('小鱼正在赶来，今天也有好好吃饭。'),
    onError: (code) => {
      if (code === 'context-lost' && !switchingRenderer && viewMode === '3d') {
        toast('3D 显示中断，已切到 2D 继续使用；鱼缸和存档都没有受影响。');
        setRenderer('2d', { silent: true });
      }
    }
  });
}

function setRenderer(kind, { silent = false } = {}) {
  if (switchingRenderer || (kind === viewMode && view)) return;
  switchingRenderer = true;
  disposeView();
  replaceCanvas();
  viewMode = kind;
  try {
    view = createView(kind);
  } catch (err) {
    if (kind === '3d') {
      replaceCanvas();
      viewMode = '2d';
      view = createView('2d');
      if (!silent) toast('这台设备暂时无法使用 3D，已用 2D 模式打开。');
    } else {
      throw err;
    }
  }
  view.setState(state);
  view.setNight(state.night);
  writePrefs({ renderer: viewMode });
  updateRendererChrome();
  applyEditMode(editMode === 'decor' && viewMode === '3d' ? 'decor' : 'view');
  if (selectedDecorId) view.selectDecor?.(selectedDecorId);
  switchingRenderer = false;
}

/** 换一块新 canvas 重建 3D 视图：同一个 canvas 无法同时/重复申请 WebGL 上下文。 */
function recreate3D() {
  if (viewMode !== '3d') return;
  // Reuse the guarded initialization/fallback path, with a fresh canvas.
  viewMode = null;
  setRenderer('3d');
}

function updateRendererChrome() {
  const is2d = viewMode === '2d';
  $('toggle-2d').setAttribute('aria-pressed', String(is2d));
  $('toggle-2d').textContent = is2d ? '3D' : '2D';
  $('toggle-2d').setAttribute('title', is2d ? '切换到 3D' : '切换到 2D');
  $('renderer-note').hidden = !is2d;
  $('renderer-note').textContent = is2d ? '2D 模式 · 布景编辑请切回 3D' : '';
  $('retry-3d').hidden = !is2d;
  $('mode-decor').disabled = is2d;
  $('camera-reset').disabled = is2d;
  $('quality').disabled = is2d;
}

function applyEditMode(next) {
  editMode = next;
  $('aquarium').dataset.mode = next;
  $('mode-view').setAttribute('aria-selected', String(next === 'view'));
  $('mode-decor').setAttribute('aria-selected', String(next === 'decor'));
  view?.setMode?.(next);
  if (next === 'view') {
    selectedDecorId = null;
    pendingDecorId = null;
    view?.selectDecor?.(null);
  }
  $('decor-panel').classList.toggle('editing', next === 'decor');
  showTip(next === 'decor'
    ? '点选水草、石头或沉木；拖动换位置，松手即保存。'
    : '轻触水面就能投食；点一条鱼看看它多大了。');
  refreshPanels();
}

function showTip(text) { $('tank-tip').textContent = text; }

// ------------------------------------------------------------------ 同步引擎
const engine = createSyncEngine({
  api: stack.api,
  store,
  getState: () => state,
  setState: (next) => { applyState(next); },
  initialState: () => initial(),
  isOnline: () => navigator.onLine !== false,
  onStatus: (s) => {
    const label = {
      [STATUS.GUEST]: '本机存档',
      [STATUS.CLOUD_OFF]: '本机存档',
      [STATUS.SYNCING]: '同步中…',
      [STATUS.SYNCED]: '已同步到云端',
      [STATUS.OFFLINE]: '离线 · 已存本机',
      [STATUS.ERROR]: '同步失败 · 已存本机',
      [STATUS.CONFLICT]: '有冲突待处理',
      [STATUS.SIGNED_OUT]: '登录已失效 · 已存本机'
    }[s.status] || '本机存档';
    $('save-status').textContent = label;
    if (s.message && s.message !== lastStatusMessage && s.status !== STATUS.SYNCED && s.status !== STATUS.SYNCING) {
      lastStatusMessage = s.message;
      toast(s.message);
    }
    if (accountUI) accountUI.render();
    refreshPanels();
  },
  onNotice: (message) => toast(message)
});

// 未登录（游客）时保留本机离线成长；已登录时成长由服务端按时间结算。
const hasSession = Boolean(store.readSession());
const absent = hasSession ? 0 : catchUp(state);

// ------------------------------------------------------------------ 状态应用
let persistedCanonical = canonicalState(state);

function applyState(next) {
  state = next;
  view?.setState(state);
  view?.setNight(state.night);
  refreshAll();
}

function persistLocal() {
  if (engine.isCloud) {
    const ok = engine.persistLocal();
    if (ok) persistedCanonical = canonicalState(state);
    else $('save-status').textContent = '本机缓存暂不可用，请用导出备份';
    return ok;
  }
  const ok = store.writeGuest(state);
  if (ok) persistedCanonical = canonicalState(state);
  return ok;
}

function hasLocalChanges() { return canonicalState(state) !== persistedCanonical; }

function save({ silent = false } = {}) {
  state.savedAt = Date.now();
  const ok = persistLocal();
  if (engine.isCloud) engine.markDirty();
  if (!silent) {
    if (ok && !engine.isCloud) $('save-status').textContent = '已保存到本机';
    if (!ok && !engine.isCloud) $('save-status').textContent = '未能保存，请导出';
  }
  return ok;
}

// ------------------------------------------------------------------ 喂食与进食
let pendingBiteHint = 0;
function handleEat(fishId) {
  const fish = state.fish.find((f) => f.id === fishId);
  if (!fish) return;
  if (engine.isCloud) {
    const res = engine.queueFeed(fishId, 1);
    if (!res.ok) {
      // 还没完成首次对账时无法可靠记账：提示一下，不本地加分（避免云端重复计算）。
      if (res.skipped === 'guest') showTip('正在连接云端，这一口稍后再记。');
      return;
    }
    pendingBiteHint += 1;
    showTip('吃到了，正在记进云端…');
    refreshPanels();
    return;
  }
  const result = eat(fish, Date.now());
  save({ silent: true });
  showTip(result.credited ? `${fish.name} 吃到了，正在慢慢长大。` : `${fish.name} 已经吃饱了，还是很开心。`);
  refreshAll();
}

function feed() {
  view?.feedRandom?.();
}

// ------------------------------------------------------------------ 布景编辑
function pushUndo() {
  undoStack.push(state);
  refreshDecorPanel();
}

function restoreFromUndo() {
  try {
    const next = undoStack.restore(state);
    if (!next) { refreshDecorPanel(); toast('没有可以撤销的操作了。'); return; }
    pendingDecorId = null;
    lastDragDecorId = null;
    applyState(next);
    save();
    toast('已撤销上一步布景操作。');
  } catch { toast('撤销失败，存档没有被改动。'); }
}

function selectDecor(id) {
  selectedDecorId = id;
  pendingDecorId = null;
  view?.selectDecor?.(id);
  refreshDecorPanel();
}

function addDecorObject(kind) {
  if (viewMode === '2d') { toast('布景编辑需要 3D 模式，请先切回 3D。'); return; }
  const types = KIND_META[kind].types;
  const type = types[Math.floor(Math.random() * types.length)];
  try {
    const { state: next, object } = addDecor(state, kind, type.id);
    pushUndo();
    state = next;
    pendingDecorId = object.id;
    selectedDecorId = object.id;
    applyState(next);
    view?.setMode?.('decor');
    applyEditMode('decor');
    view?.selectDecor?.(object.id);
    // 3D 视图需要把新对象加进场景（setState 已经做了，这里只同步选中环）。
    refreshDecorPanel();
    toast(`${object.type && KIND_META[kind].types.find((t) => t.id === object.type)?.name || KIND_META[kind].name}已经摆好；不满意可以「换个造型」或取消。`);
  } catch (err) {
    toast(err.message || '暂时放不下了。');
  }
}

function moveDecorFromView(id, transform, commit) {
  if (!state.decor.some((d) => d.id === id)) return;
  if (lastDragDecorId !== id) {
    pushUndo();
    lastDragDecorId = id;
  }
  const { state: next } = updateDecor(state, id, transform);
  state = next;
  view?.setState(state);
  refreshDecorPanel();
  if (commit) {
    lastDragDecorId = null;
    save();
  }
}

function rotateDecor() {
  const item = state.decor.find((d) => d.id === selectedDecorId);
  if (!item) return;
  pushUndo();
  const { state: next } = updateDecor(state, item.id, { rot: item.rot + Math.PI / 12 });
  applyState(next);
  save();
}

function scaleDecor(delta) {
  const item = state.decor.find((d) => d.id === selectedDecorId);
  if (!item) return;
  pushUndo();
  const { state: next } = updateDecor(state, item.id, { scale: item.scale + delta });
  applyState(next);
  save();
}

function reshuffleSelectedDecor() {
  const item = state.decor.find((d) => d.id === selectedDecorId);
  if (!item) return;
  pushUndo();
  const { state: next } = reshuffleDecor(state, item.id);
  applyState(next);
  save();
  toast('换了个造型；位置和大小保持不变。');
}

function deleteSelectedDecor() {
  const item = state.decor.find((d) => d.id === selectedDecorId);
  if (!item) return;
  pushUndo();
  const { state: next } = removeDecor(state, item.id);
  selectedDecorId = null;
  pendingDecorId = null;
  view?.selectDecor?.(null);
  applyState(next);
  save();
  toast('已经移走了。可以用「撤销」找回来。');
}

function confirmPendingDecor() {
  if (!pendingDecorId) return;
  pendingDecorId = null;
  save();
  refreshDecorPanel();
  toast('摆好了。');
}

function cancelPendingDecor() {
  if (!pendingDecorId) return;
  const id = pendingDecorId;
  const { state: next } = removeDecor(state, id);
  pendingDecorId = null;
  selectedDecorId = null;
  view?.selectDecor?.(null);
  applyState(next);
  save();
  refreshDecorPanel();
}

// ------------------------------------------------------------------ 界面刷新
function fishSVG(fish) {
  const a = fishAppearance(fish);
  const type = FISH_TYPES.find((t) => t.id === a.typeId) || FISH_TYPES[0];
  const bodyH = 20 + type.body.depth * 14;
  const tail = type.fins.tail;
  const tailPath = tail === 'fork'
    ? 'M46 22 L62 10 L56 22 L62 34 Z'
    : tail === 'veil'
      ? 'M46 22 C56 8 66 8 68 14 C60 20 62 24 68 30 C66 36 56 36 46 22 Z'
      : 'M46 22 C56 12 66 14 66 22 C66 30 56 32 46 22 Z';
  return `<svg viewBox="0 0 70 44" aria-hidden="true"><path d="${tailPath}" fill="${a.fin}"/><path d="M14 22 Q32 6 50 22 Q32 38 14 22 Z" fill="${a.body}"/><path d="M24 12 L30 6 L38 12 Z" fill="${a.accent}" opacity="0.8"/><circle cx="22" cy="20" r="1.9" fill="${a.eye}"/></svg>`;
}

function selectedFish() {
  return activeFishId ? state.fish.find((f) => f.id === activeFishId) : null;
}

function selectFish(id) {
  activeFishId = id;
  refreshPanels();
  refreshFishList();
}

function describeStage(growth) {
  const stage = stageOf(growth);
  return stage;
}

function refreshAll() {
  $('aquarium').dataset.night = String(state.night);
  refreshCounters();
  refreshFishList();
  refreshPanels();
  $('scene-label').textContent = state.night ? '月光 · 好梦水域' : '日光 · 静谧水域';
  $('scene-sub').textContent = state.night ? '灯熄了，鱼也慢下来' : '随时回来，都有鱼在等你';
  $('night').setAttribute('aria-pressed', String(state.night));
  $('sound').setAttribute('aria-pressed', String(Boolean(audioCtx && audioCtx.state === 'running')));
}

function refreshCounters() {
  const plants = state.decor.filter((d) => d.kind === 'plant').length;
  const rocks = state.decor.filter((d) => d.kind === 'rock').length;
  const woods = state.decor.filter((d) => d.kind === 'wood').length;
  $('aquarium-count').textContent = `${state.fish.length} 条小鱼 · ${state.decor.length} 件造景`;
  $('fish-counter').textContent = `${state.fish.length} / ${MAX_FISH} 位小伙伴`;
  $('add-fish').disabled = state.fish.length >= MAX_FISH;
  $('plant-counter').textContent = `水草 ${plants} / ${KIND_META.plant.max}`;
  $('add-plant').disabled = plants >= KIND_META.plant.max || state.decor.length >= DECOR_MAX;
  $('rock-counter').textContent = `石头 ${rocks} / ${KIND_META.rock.max}`;
  $('add-rock').disabled = rocks >= KIND_META.rock.max || state.decor.length >= DECOR_MAX;
  $('wood-counter').textContent = `沉木 ${woods} / ${KIND_META.wood.max}`;
  $('add-wood').disabled = woods >= KIND_META.wood.max || state.decor.length >= DECOR_MAX;
}

function refreshFishList() {
  const list = $('fish-list');
  list.replaceChildren();
  const now = Date.now();
  state.fish.forEach((fish) => {
    const stage = describeStage(fish.growth);
    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'fish-card';
    card.setAttribute('aria-current', String(fish.id === activeFishId));
    card.innerHTML = fishSVG(fish);
    const name = document.createElement('b');
    name.textContent = fish.name;
    const detail = document.createElement('small');
    detail.textContent = `${stage.name} · ${Math.max(1, Math.floor(ageDays(fish.born, now)) + 1)} 天`;
    const bar = document.createElement('div');
    bar.className = 'growth';
    const fill = document.createElement('i');
    fill.style.width = `${Math.max(3, fish.growth * 100)}%`;
    bar.append(fill);
    card.append(name, detail, bar);
    card.setAttribute('aria-label', `查看 ${fish.name} 的信息`);
    card.onclick = () => selectFish(fish.id);
    list.append(card);
  });
}

function refreshPanels() {
  refreshFishPanel();
  refreshDecorPanel();
}

function refreshFishPanel() {
  const fish = selectedFish();
  $('fish-detail').hidden = !fish;
  $('panel-empty').hidden = Boolean(fish);
  $('panel-title').textContent = '小鱼的成长手记';
  if (!fish) return;
  const a = fishAppearance(fish);
  const stage = describeStage(fish.growth);
  const now = Date.now();
  $('detail-name').textContent = fish.name;
  $('detail-type').textContent = `${a.name} · ${stage.name}`;
  $('detail-age').textContent = `${Math.max(1, Math.floor(ageDays(fish.born, now)) + 1)} 天`;
  $('detail-meals').textContent = `${fish.meals} 口`;
  $('detail-growth').textContent = `${Math.round(fish.growth * 100)}%`;
  $('detail-growth-bar').style.width = `${Math.max(3, fish.growth * 100)}%`;
  const remain = growthToNextStage(fish.growth);
  const nextStage = STAGES[stage.index + 1] || null;
  if (!nextStage) {
    $('detail-next').textContent = '已经成年。之后还会慢慢变得更舒展一些。';
  } else if (remain === 0) {
    $('detail-next').textContent = `马上进入${nextStage.name}。`;
  } else {
    const days = remain / GROWTH.naturalPerDay;
    $('detail-next').textContent = `再长 ${Math.max(1, Math.ceil(days))} 天左右（正常喂食会更快）进入${nextStage.name}。`;
  }
  const pending = engine.isCloud ? engine.pendingFeeds : 0;
  $('detail-pending').hidden = !pending;
  $('detail-pending').textContent = pending ? `还有 ${pending} 口进食待云端确认；已先记在本机，不会丢。` : '';
}

function refreshDecorPanel() {
  const item = state.decor.find((d) => d.id === selectedDecorId);
  const isPending = Boolean(item && item.id === pendingDecorId);
  $('decor-detail').hidden = !item;
  $('decor-empty').hidden = Boolean(item);
  if (!item) {
    $('decor-title').textContent = editMode === 'decor' ? '点一件水草或石头开始摆。' : '摆一摆，让水底更自然。';
    floatBar.hidden = true;
    // 取消/移走后要清掉所有「待确认」痕迹，否则按钮会残留一行
    $('decor-pending-actions').hidden = true;
    $('float-confirm').hidden = true;
    $('float-cancel').hidden = true;
    $('decor-state').textContent = '';
    return;
  }
  const meta = KIND_META[item.kind];
  const typeName = meta.types.find((t) => t.id === item.type)?.name || meta.name;
  const index = state.decor.filter((d) => d.kind === item.kind).findIndex((d) => d.id === item.id) + 1;
  $('decor-name').textContent = typeName;
  $('decor-kind').textContent = `${meta.name} · 第 ${index} 件`;
  $('decor-state').textContent = isPending ? '待确认' : '已选中';
  $('decor-title').textContent = isPending ? '这个造型可以吗？' : '正在编辑这一件。';
  $('decor-pending-actions').hidden = !isPending;
  // 浮动工具条位于鱼缸内底部：小屏上面板可能在折叠区，确认/取消也必须看得见。
  floatBar.hidden = !(editMode === 'decor' && item);
  if (item) $('decor-float-name').textContent = `${typeName} · ${isPending ? '待确认' : '已选中'}`;
  $('float-confirm').hidden = !isPending;
  $('float-cancel').hidden = !isPending;
  for (const id of ['decor-rotate', 'decor-scale-down', 'decor-scale-up', 'decor-reshuffle', 'decor-delete']) {
    $(id).disabled = isPending && id === 'decor-delete';
  }
}

// ------------------------------------------------------------------ 声音
let audioCtx = null;
let audioNodes = null;
let mutedByVisibility = false;
function stopAudio() {
  if (audioNodes) {
    audioNodes.forEach((node) => { try { node.stop(); } catch { /* 已停止 */ } node.disconnect(); });
    audioNodes = null;
  }
}
async function setSound(on) {
  try {
    if (!on) {
      await audioCtx?.suspend();
      state.sound = false;
    } else {
      if (!audioCtx) {
        audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        const buffer = audioCtx.createBuffer(1, audioCtx.sampleRate * 3, audioCtx.sampleRate);
        const data = buffer.getChannelData(0);
        let previous = 0;
        for (let i = 0; i < data.length; i += 1) {
          previous = (previous + Math.random() * 0.04 - 0.02) / 1.02;
          data[i] = previous * 3;
        }
        const source = audioCtx.createBufferSource();
        source.buffer = buffer;
        source.loop = true;
        const filter = audioCtx.createBiquadFilter();
        filter.type = 'lowpass';
        filter.frequency.value = 620;
        const gain = audioCtx.createGain();
        gain.gain.value = 0.1;
        source.connect(filter).connect(gain).connect(audioCtx.destination);
        source.start();
        audioNodes = [source];
      }
      await audioCtx.resume();
      state.sound = true;
    }
    save();
    refreshAll();
  } catch {
    state.sound = false;
    toast('当前浏览器暂时无法播放水声。');
  }
}

// ------------------------------------------------------------------ 交互接线
$('feed').onclick = () => feed();
$('add-fish').onclick = () => openSpeciesPicker();
$('add-plant').onclick = () => addDecorObject('plant');
$('add-rock').onclick = () => addDecorObject('rock');
$('add-wood').onclick = () => addDecorObject('wood');
$('night').onclick = () => { state.night = !state.night; save(); view?.setNight(state.night); refreshAll(); };
$('sound').onclick = () => setSound(!(audioCtx && audioCtx.state === 'running'));
$('fullscreen').onclick = async () => {
  try {
    if (document.fullscreenElement) await document.exitFullscreen();
    else if ($('aquarium').requestFullscreen) await $('aquarium').requestFullscreen();
    else toast('可以将网页添加到主屏幕，获得更沉浸的体验。');
  } catch { toast('此浏览器暂不支持全屏。'); }
};
$('camera-reset').onclick = () => {
  if (viewMode === '2d') { toast('2D 模式不需要相机操作。'); return; }
  view?.resetCamera?.();
};
$('toggle-2d').onclick = () => setRenderer(viewMode === '3d' ? '2d' : '3d');
$('retry-3d').onclick = () => {
  if (!supportsWebGL()) { toast('这个浏览器环境没有可用的 WebGL。'); return; }
  setRenderer('3d');
};
$('quality').onchange = (event) => {
  quality = event.target.value === 'low' ? 'low' : 'high';
  writePrefs({ quality });
  recreate3D();
  toast(quality === 'high' ? '已切到高画质（阴影与焦散）。' : '已切到低画质，优先保证流畅。');
};
$('mode-view').onclick = () => applyEditMode('view');
$('mode-decor').onclick = () => {
  if (viewMode === '2d') { toast('布景编辑需要 3D 模式。'); return; }
  applyEditMode('decor');
};
$('decor-rotate').onclick = () => rotateDecor();
$('decor-scale-down').onclick = () => scaleDecor(-0.08);
$('decor-scale-up').onclick = () => scaleDecor(0.08);
$('decor-reshuffle').onclick = () => reshuffleSelectedDecor();
$('decor-delete').onclick = () => deleteSelectedDecor();
$('decor-undo').onclick = () => restoreFromUndo();
$('decor-confirm').onclick = () => confirmPendingDecor();
$('decor-cancel').onclick = () => cancelPendingDecor();

// 布景浮动工具条：动作转交给面板里的同名按钮，逻辑只有一份（面板在小屏上可能在折叠区）。
const FLOAT_ACTION_TARGETS = {
  rotate: 'decor-rotate',
  'scale-down': 'decor-scale-down',
  'scale-up': 'decor-scale-up',
  reshuffle: 'decor-reshuffle',
  undo: 'decor-undo',
  delete: 'decor-delete'
};
for (const btn of floatBar.querySelectorAll('[data-decor-action]')) {
  btn.onclick = () => {
    const target = $(FLOAT_ACTION_TARGETS[btn.dataset.decorAction]);
    if (target && !target.disabled) target.click();
  };
}
document.querySelectorAll('[data-decor-nudge]').forEach(button => {
  button.onclick = () => {
    const item = state.decor.find(d => d.id === selectedDecorId);
    if (!item) return;
    const [dx, dz] = button.dataset.decorNudge.split(',').map(Number);
    pushUndo();
    applyState(updateDecor(state, item.id, { x: item.x + dx, z: item.z + dz }).state);
    save();
  };
});
$('float-confirm').onclick = () => { if (!$('decor-confirm').disabled) $('decor-confirm').click(); };
$('float-cancel').onclick = () => $('decor-cancel').click();
$('detail-rename').onclick = () => openFishDialog(activeFishId);

// 键盘：Ctrl/⌘+Z 撤销布景编辑；Esc 退出布景选择
document.addEventListener('keydown', (event) => {
  if (event.target.closest?.('input, textarea, select, [contenteditable="true"], dialog[open]')) return;
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'z' && editMode === 'decor') {
    event.preventDefault();
    restoreFromUndo();
  }
  if (event.key === 'Escape' && editMode === 'decor') applyEditMode('view');
});

// ------------------------------------------------------------------ 鱼：添加 / 改名
function openSpeciesPicker() {
  if (state.fish.length >= MAX_FISH) return;
  const box = $('species-options');
  box.replaceChildren();
  FISH_TYPES.forEach((type) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'species-card';
    const preview = makeFish(0, Date.now(), { species: type.id, seed: 12345 });
    btn.innerHTML = fishSVG(preview);
    const name = document.createElement('b');
    name.textContent = type.name;
    const note = document.createElement('small');
    note.textContent = type.note;
    btn.append(name, note);
    btn.onclick = () => { addFish(type.id); $('species-dialog').close(); };
    box.append(btn);
  });
  $('species-dialog').showModal();
}

$('species-random').onclick = () => {
  const type = FISH_TYPES[Math.floor(Math.random() * FISH_TYPES.length)];
  addFish(type.id);
  $('species-dialog').close();
};

function addFish(typeId) {
  if (state.fish.length >= MAX_FISH) return;
  const fish = makeFish(state.fish.length, Date.now(), { species: typeId });
  state.fish.push(fish);
  activeFishId = fish.id;
  applyState(state);
  save();
  if (viewMode === '3d') view?.setState(state);
  toast(`${fish.name} 游进了你的水世界。`);
}

function openFishDialog(id) {
  const fish = state.fish.find((f) => f.id === id);
  if (!fish) return;
  activeFishId = fish.id;
  const a = fishAppearance(fish);
  const stage = describeStage(fish.growth);
  $('fish-title').textContent = fish.name;
  $('fish-info').textContent = `${a.name} · ${stage.name} · 陪伴第 ${Math.max(1, Math.floor(ageDays(fish.born) + 1))} 天 · 已吃 ${fish.meals} 口 · 成长 ${Math.round(fish.growth * 100)}%`;
  $('fish-name').value = fish.name;
  $('fish-dialog').showModal();
}
$('rename').onclick = () => {
  const fish = state.fish.find((f) => f.id === activeFishId);
  if (!fish) return;
  fish.name = $('fish-name').value.trim().slice(0, 16) || fish.name;
  applyState(state);
  save();
  $('fish-dialog').close();
  toast('名字记住啦。');
};

// ------------------------------------------------------------------ 存档面板
$('storage-button').onclick = () => $('storage-dialog').showModal();
$('export').onclick = () => {
  save();
  const url = URL.createObjectURL(new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = `mofish-${new Date().toISOString().slice(0, 10)}.json`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  toast('存档已导出，请妥善保存。');
};
$('import').onclick = () => $('import-file').click();
$('import-file').onchange = async (event) => {
  const file = event.target.files[0];
  if (!file) return;
  try {
    if (file.size > 400000) throw new Error('too large');
    const next = validate(JSON.parse(await file.text()));
    if (!confirm('导入将替换当前鱼缸。确认已经备份，并继续导入吗？')) return;
    if (!hasSession) catchUp(next);
    selectedDecorId = null;
    pendingDecorId = null;
    undoStack.clear();
    applyState(next);
    if (audioCtx) await audioCtx.suspend();
    const persisted = save();
    toast(persisted ? '鱼缸已搬过来，小鱼也都在。' : '已导入，但无法自动保存，请保留导出的存档。');
  } catch {
    toast('这份存档无法读取，请选择 MoFish 导出的 JSON 文件。');
  } finally {
    event.target.value = '';
  }
};

// ------------------------------------------------------------------ 账号界面
accountUI = createAccountUI({
  auth: stack.auth,
  engine,
  store,
  config,
  onSessionChange: () => {
    if (!engine.isCloud) {
      const guest = store.readGuest() || initial();
      catchUp(guest);
      applyState(guest);
    }
    undoStack.clear();
    selectedDecorId = null;
    pendingDecorId = null;
    activeFishId = null;
    refreshAll();
  }
});

const callback = parseAuthCallback({ hash: location.hash, search: location.search });
if (callback.kind !== 'none') {
  try { history.replaceState(null, '', location.pathname); } catch { /* 忽略 */ }
  accountUI.handleCallback(callback).catch(() => toast('链接处理失败，请重新申请邮件。'));
}

if (config.mode === 'ready' && callback.kind !== 'session') {
  stack.auth.getSession().then(async (restored) => {
    if (restored.ok) await engine.setSession(restored.session);
    else if (restored.session) await engine.setSession(restored.session);
    else if (restored.reason === 'invalid_grant') accountUI.setNotice('登录状态已失效，请重新登录。', 'warn');
  }).catch(() => {});
}

// ------------------------------------------------------------------ 生命周期
function startViews() {
  const preferred = prefs.renderer === '2d' ? '2d' : '3d';
  if (preferred === '3d' && !supportsWebGL()) {
    toast('这台设备没有可用的 WebGL，已用 2D 模式打开鱼缸。');
    setRenderer('2d', { silent: true });
    return;
  }
  setRenderer(preferred, { silent: true });
}

$('quality').value = quality;
refreshAll();
updateRendererChrome();
// 3D 初始化（编译着色器）放到下一帧：先把界面、账号回调与同步请求跑起来，
// 避免低端设备/软件渲染下首屏被 WebGL 初始化卡住。
requestAnimationFrame(() => startViews());

if (loadWarning) toast('自动存档暂不可用，或旧存档无法读取；请用导出保留进度。');
else if (absent > 0.1) toast(`欢迎回来！离开的 ${Math.round(absent * 10) / 10} 小时里，小鱼又长大了一点。`);

// 15 秒一次只写 localStorage，且只在内容真的变了才写。
setInterval(() => {
  if (!document.hidden && hasLocalChanges()) persistLocal();
}, 15000);

document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    save({ silent: true });
    view?.pause?.();
    if (engine.isCloud) engine.flush({ reason: 'hidden', keepalive: true }).catch(() => {});
    mutedByVisibility = audioCtx?.state === 'running';
    if (mutedByVisibility) audioCtx.suspend();
  } else {
    view?.resume?.();
    if (engine.isCloud) engine.syncNow({ reason: 'visible' }).catch(() => {});
    else {
      const hours = catchUp(state);
      if (hours > 0.02) { applyState(state); refreshAll(); }
    }
    if (mutedByVisibility) audioCtx?.resume().then(refreshAll).catch(() => {});
    mutedByVisibility = false;
    refreshAll();
  }
});

window.addEventListener('focus', () => {
  if (!document.hidden && engine.isCloud) engine.syncNow({ reason: 'focus' }).catch(() => {});
});
window.addEventListener('pagehide', () => {
  if (engine.isCloud) {
    engine.persistLocal();
    engine.flush({ reason: 'pagehide', keepalive: true }).catch(() => {});
  } else save({ silent: true });
});
window.addEventListener('online', () => { engine.handleOnline(); refreshAll(); });
window.addEventListener('offline', () => { engine.handleOffline(); refreshAll(); });

if ('ResizeObserver' in window) {
  resizeObserver = new ResizeObserver(() => view?.resize?.());
  resizeObserver.observe(canvas);
}

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js').then(() => navigator.serviceWorker.ready)
    .then(() => { $('offline-status').textContent = '离线资源已就绪：下次断网也可以打开鱼缸。'; })
    .catch(() => { $('offline-status').textContent = '当前环境不支持离线缓存，请联网使用。'; });
} else {
  $('offline-status').textContent = '此浏览器不支持离线缓存，请联网使用。';
}

// 供端到端测试与排障使用的只读探针（不暴露修改能力）。
window.__mofish = {
  get state() { return cloneState(state); },
  get renderer() { return viewMode; },
  get quality() { return quality; },
  get editMode() { return editMode; },
  get selectedDecor() { return selectedDecorId; },
  get pendingFeeds() { return engine.pendingFeeds; },
  get version() { return STATE_VERSION; },
  get decorCounts() {
    return state.decor.reduce((acc, d) => { acc[d.kind] = (acc[d.kind] || 0) + 1; return acc; }, {});
  },
  get bootMs() { return Math.round(bootAt); },
  get renderInfo() { return view?.rendererInfo || null; }
};
