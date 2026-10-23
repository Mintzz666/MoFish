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
// Three.js is downloaded only when 3D is actually requested.
let createView3D = null;
let rendererModulePromise = null;
let rendererImportFailed = false;
let rendererRetry = 0;
import { createView2D } from './view2d.js';
import { createDecorHistory } from './decor-history.js';
import { createSharingApi } from './cloud/sharing-api.js';
import { createSharedSyncEngine } from './cloud/shared-sync.js';
import { createCollaborationRouter } from './cloud/collaboration-router.js';
import { createSharingUI } from './ui/sharing.js';

const $ = (id) => document.getElementById(id);
const APP_VERSION = typeof __MOFISH_VERSION__ === 'string' ? __MOFISH_VERSION__ : '0.2.0';
const SOURCE_SHA = typeof __MOFISH_SOURCE_SHA__ === 'string' ? __MOFISH_SOURCE_SHA__ : 'development';
const BUILD_ENTRY = import.meta.url;
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
let quality = ['auto','low','high'].includes(prefs.quality) ? prefs.quality : 'auto';
let stageVisible = true;
let rendererUsed3d = false;
let rendererCacheRequestedFor = null;
let updateRequested = false;
let updateInProgress = false;
let serviceWorkerRegistration = null;
let updateAvailable = false;

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
let sharingUI = null;
let collaboration = null;
let sharedSignature = '';
const collaborationEnabled = globalThis.__MOFISH_CONFIG__?.phase === 'c';

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
const fishCards = new Map();
let decorPickerSignature = '';
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
      quality,
      night: state.night,
      reduceMotion,
      canFeed: canEditAquarium,
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
    canFeed: canEditAquarium,
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

async function setRenderer(kind, { silent = false } = {}) {
  if (switchingRenderer || (kind === viewMode && view)) return;
  switchingRenderer = true;
  $('toggle-2d').disabled = true;
  $('retry-3d').disabled = true;
  if (kind === '3d' && !createView3D) {
    $('stage-status').textContent = '正在打开 3D…';
    try {
      rendererModulePromise ||= (async () => {
        if (!rendererImportFailed) return import('./aquarium/view3d.js');
        // Browsers remember a failed module fetch for the lifetime of a page.
        // Retry the same build through a fresh module URL, preserving all state.
        const response = await fetch('./asset-manifest.json',{cache:'no-cache'});
        if (!response.ok) throw new Error('Renderer manifest unavailable');
        const manifest = await response.json();
        const file = manifest.lazy?.find(name => /^assets\/view3d-[\w-]+\.js$/.test(name));
        if (!file || new URL(manifest.entry,location.href).href !== BUILD_ENTRY) {
          const error = new Error('当前页面有新版本，请先完成同步并更新，再打开 3D。');
          error.needsUpdate = true; throw error;
        }
        const moduleUrl = new URL(file,location.href);
        moduleUrl.searchParams.set('retry',String(++rendererRetry));
        return import(moduleUrl.href);
      })();
      createView3D = (await rendererModulePromise).createView3D;
      rendererImportFailed = false;
    } catch (error) {
      rendererModulePromise = null;
      rendererImportFailed = true;
      kind = '2d';
      toast(error.needsUpdate ? error.message : '3D 资源暂时未能加载，先用 2D 继续；联网后可以重试。');
    }
  }
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
  $('toggle-2d').disabled = false;
  $('retry-3d').disabled = false;
  $('stage-status').textContent = '自在游动中';
  view?.setQualityPolicy?.(quality);
  applyRuntimeActivity();
  if (viewMode === '3d') { rendererUsed3d = true; cacheUsedRenderer(); }
}

function applyRuntimeActivity() {
  const visible = !document.hidden && (stageVisible || Boolean(document.fullscreenElement));
  if (view?.setActivity) view.setActivity({visible});
  else if (visible) view?.resume?.(); else view?.pause?.();
}
function cacheUsedRenderer() {
  const worker = serviceWorkerRegistration?.active;
  if (rendererUsed3d && worker && rendererCacheRequestedFor !== worker) {
    rendererCacheRequestedFor = worker;
    worker.postMessage({type:'MOFISH_CACHE_3D'});
  }
}
function markInteraction() { view?.notifyInteraction?.(); }

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
  $('renderer-note').textContent = is2d ? '2D 模式 · 更多互动请切回 3D' : '';
  $('retry-3d').hidden = !is2d;
  $('mode-decor').disabled = is2d;
  $('camera-reset').disabled = is2d;
  $('quality').disabled = false; // Frame pacing and resolution apply to 2D too.
  $('play-mode').disabled = is2d;
  $('play-mode').title = is2d ? '逗鱼需要 3D 模式' : '让小鱼跟随手指或鼠标';
  $('play-mode').setAttribute('aria-pressed', String(Boolean(view?.playMode)));
  canvas.setAttribute('aria-label', is2d ? '鱼缸：轻触水面看涟漪，点鱼查看成长；喂一点按钮或空格投食，布景请切回3D' : '鱼缸：轻触水面打招呼，喂一点按钮或空格投食；布景时可拖动造景');
}

function applyEditMode(next) {
  // 离开布景视作确认当前位置；换身份时旧id不在当前state中，绝不能写回旧物件。
  if (next === 'view' && pendingDecorId && state.decor.some(item => item.id === pendingDecorId) && canEditAquarium()) {
    pendingDecorId = null;
    save();
  }
  editMode = next;
  $('aquarium').dataset.mode = next;
  $('mode-view').setAttribute('aria-selected', String(next === 'view'));
  $('mode-decor').setAttribute('aria-selected', String(next === 'decor'));
  view?.setMode?.(next);
  $('play-mode').setAttribute('aria-pressed', String(Boolean(view?.playMode)));
  if (next === 'view') {
    selectedDecorId = null;
    pendingDecorId = null;
    view?.selectDecor?.(null);
  }
  $('decor-panel').classList.toggle('editing', next === 'decor');
  showTip(next === 'decor'
    ? '点选水草、石头或沉木；拖动换位置，松手即保存。'
    : viewMode === '2d' ? '轻触水面看涟漪，点小鱼查看成长；用「喂一点」或空格投食。' : '轻触水面打招呼；用「喂一点」或空格投食，打开「逗鱼」让小鱼跟随。');
  refreshPanels();
}

function showTip(text) { $('tank-tip').textContent = text; }

// ------------------------------------------------------------------ 同步引擎
const legacyEngine = createSyncEngine({
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
    if (collaboration?.engine.isShared) return;
    if (accountUI) accountUI.render();
    refreshPanels();
    refreshSharedAccess();
  },
  onNotice: (message) => toast(message)
});

const sharingApi = createSharingApi({ url: config.url, anonKey: config.anonKey, auth: stack.auth });
const sharedEngine = createSharedSyncEngine({
  api: sharingApi, store, getState: () => state, setState: next => applyState(next),
  isOnline: () => navigator.onLine !== false,
  onStatus: snap => {
    if (!collaboration?.engine.isShared) return;
    $('save-status').textContent = ({synced:'已同步到共享鱼缸',syncing:'正在与伙伴同步…',offline:'离线 · 改动已保留',conflict:'同一物件有不同改动',signed_out:'共享权限已变更',error:'同步暂未完成'})[snap.status] || '连接共享鱼缸中…';
    accountUI?.render(); refreshAll(); refreshSharedAccess();
    if (snap.message && snap.message !== lastStatusMessage) { lastStatusMessage = snap.message; toast(snap.message); }
  }, onNotice: toast,
  onRevoked: () => collaboration?.goPersonal({ force: true }).then(() => toast('已回到个人鱼缸。共享缸的本机未上传改动留作备份。')).catch(() => {})
});
collaboration = createCollaborationRouter({legacy:legacyEngine, shared:sharedEngine, store, autoShared:collaborationEnabled, preparePersonal:async()=>{
  const userId=collaboration.context().user?.id;
  const result=await sharingApi.preparePersonal(store.readGuest() || initial());
  if(result.ok&&userId)store.writeCurrent(userId,{aquariumId:result.data.aquarium_id});
  if(!result.ok&&result.code==='network_error'&&userId){
    const cached=store.readCurrent(userId);
    if(cached?.aquariumId&&store.readMeta(userId,cached.aquariumId)?.kind==='shared-v1')return {ok:true,data:{aquarium_id:cached.aquariumId}};
  }
  return result;
}, onModeChange:()=>{
  undoStack.clear(); selectedDecorId=null; pendingDecorId=null; activeFishId=null; applyEditMode('view');
}});
const engine = collaboration.engine;
function canEditAquarium() { return !updateInProgress && (!collaborationEnabled || engine.canEdit); }
function refreshSharedAccess() {
  if (!$('sharing-button')) return;
  $('sharing-button').hidden = !collaborationEnabled;
  const ctx = collaboration?.context();
  const names = {owner:'主人',editor:'一起照看',viewer:'仅观看'};
  $('room-label').textContent = ctx?.isShared && ctx.role !== 'owner' ? `${names[ctx.role] || '正在连接'} · 朋友的水下花园` : '我的水下花园';
  $('collaboration-banner').hidden = !ctx?.isShared || ctx.role === 'owner';
  $('collaboration-copy').textContent = ctx?.role === 'viewer' ? '你正在安静观赏朋友的鱼缸，鱼儿和造景会随伙伴的更新而变化。' : '和伙伴一起照看。不同物件的改动会合并，同一物件有分歧时保留两份。';
  const signature = JSON.stringify([ctx?.user?.id,ctx?.aquariumId,ctx?.role,ctx?.isShared]);
  if (signature !== sharedSignature) { sharedSignature=signature; sharingUI?.render(); }
  const readonly = ctx?.isShared && !engine.canEdit;
  for (const id of ['feed','night','detail-rename','rename']) $(id).disabled = readonly;
  $('import').disabled = Boolean(ctx?.isShared);
  $('import').title = ctx?.isShared ? '协作存档不能整缸覆盖；可先导出备份，退出账号后在游客模式导入。' : '';
  const importNote=$('import-note');
  if(importNote)importNote.textContent=ctx?.isShared ? '为保护伙伴的改动，云端协作存档不接受整缸导入。请先导出备份；需要查看旧存档时，退出账号后在游客模式导入。' : '导入会替换当前鱼缸，请先导出备份。旧版存档会自动升级，鱼的名字、成长和喂食记录都会保留。';
  if (readonly && editMode !== 'view') applyEditMode('view');
  $('mode-decor').disabled = readonly || viewMode === '2d';
}

// 未登录（游客）时保留本机离线成长；已登录时成长由服务端按时间结算。
const hasSession = Boolean(store.readSession());
const absent = hasSession ? 0 : catchUp(state);

// ------------------------------------------------------------------ 状态应用
let persistedCanonical = canonicalState(state);

function applyState(next) {
  if (pendingDecorId && engine.isShared && !next.decor.some(item=>item.id===pendingDecorId)) {
    pendingDecorId=null; selectedDecorId=null;
    toast('鱼缸有新更新，尚未放下的造景已取消；可以重新摆放。');
  }
  state = next;
  view?.setState(state);
  view?.setNight(state.night);
  refreshAll();
}

function persistLocal() {
  if (engine.isCloud) {
    const ok = engine.persistLocal();
    if ($('persistence-warning')) $('persistence-warning').hidden = ok;
    if (ok) persistedCanonical = canonicalState(state);
    else $('save-status').textContent = '本机缓存暂不可用，请用导出备份';
    return ok;
  }
  const ok = store.writeGuest(state);
  if ($('persistence-warning')) $('persistence-warning').hidden = ok;
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
  if (!canEditAquarium()) return;
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
  if (!canEditAquarium()) { toast('当前仅可观看，小鱼会由主人和伙伴照看。'); return; }
  view?.feedRandom?.();
}

// ------------------------------------------------------------------ 布景编辑
function pushUndo() {
  undoStack.push(state);
  refreshDecorPanel();
}

function restoreFromUndo() {
  if (!canEditAquarium()) return;
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
  if ($('inspector')) $('inspector').open = true;
  if (!canEditAquarium()) return;
  if (pendingDecorId && pendingDecorId !== id) confirmPendingDecor();
  selectedDecorId = id;
  if (pendingDecorId !== id) pendingDecorId = null;
  applyEditMode('decor');
  view?.selectDecor?.(id);
  refreshDecorPanel();
}

function addDecorObject(kind) {
  if (!canEditAquarium()) return;
  if (viewMode === '2d') { toast('布景编辑需要 3D 模式，请先切回 3D。'); return; }
  if (pendingDecorId) confirmPendingDecor();
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
  if (!canEditAquarium()) return;
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
  if (!canEditAquarium()) return;
  const item = state.decor.find((d) => d.id === selectedDecorId);
  if (!item) return;
  pushUndo();
  const { state: next } = updateDecor(state, item.id, { rot: item.rot + Math.PI / 12 });
  applyState(next);
  save();
}

function scaleDecor(delta) {
  if (!canEditAquarium()) return;
  const item = state.decor.find((d) => d.id === selectedDecorId);
  if (!item) return;
  pushUndo();
  const { state: next } = updateDecor(state, item.id, { scale: item.scale + delta });
  applyState(next);
  save();
}

function reshuffleSelectedDecor() {
  if (!canEditAquarium()) return;
  const item = state.decor.find((d) => d.id === selectedDecorId);
  if (!item) return;
  pushUndo();
  const { state: next } = reshuffleDecor(state, item.id);
  applyState(next);
  save();
  toast('换了个造型；位置和大小保持不变。');
}

function deleteSelectedDecor() {
  if (!canEditAquarium()) return;
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
  if (!canEditAquarium()) return;
  if (!pendingDecorId) return;
  pendingDecorId = null;
  save();
  refreshDecorPanel();
  toast('摆好了。');
}

function cancelPendingDecor() {
  if (!canEditAquarium()) return;
  if (!pendingDecorId) return;
  const id = pendingDecorId;
  const { state: next } = removeDecor(state, id);
  undoStack.discardObject(id, next);
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
  if (editMode === 'decor') applyEditMode('view');
  activeFishId = id;
  if ($('inspector')) $('inspector').open = true;
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
  refreshSharedAccess();
}

function refreshCounters() {
  const plants = state.decor.filter((d) => d.kind === 'plant').length;
  const rocks = state.decor.filter((d) => d.kind === 'rock').length;
  const woods = state.decor.filter((d) => d.kind === 'wood').length;
  $('aquarium-count').textContent = `${state.fish.length} 条小鱼 · ${state.decor.length} 件造景`;
  $('fish-counter').textContent = `${state.fish.length} / ${MAX_FISH} 位小伙伴`;
  $('add-fish').disabled = !canEditAquarium() || state.fish.length >= MAX_FISH;
  $('plant-counter').textContent = `水草 ${plants} / ${KIND_META.plant.max}`;
  $('add-plant').disabled = !canEditAquarium() || plants >= KIND_META.plant.max || state.decor.length >= DECOR_MAX;
  $('rock-counter').textContent = `石头 ${rocks} / ${KIND_META.rock.max}`;
  $('add-rock').disabled = !canEditAquarium() || rocks >= KIND_META.rock.max || state.decor.length >= DECOR_MAX;
  $('wood-counter').textContent = `沉木 ${woods} / ${KIND_META.wood.max}`;
  $('add-wood').disabled = !canEditAquarium() || woods >= KIND_META.wood.max || state.decor.length >= DECOR_MAX;
}

function refreshFishList() {
  const list = $('fish-list');
  const now = Date.now();
  const keep = new Set();
  let cursor = list.firstElementChild;
  for (const fish of state.fish) {
    keep.add(fish.id);
    let record = fishCards.get(fish.id);
    if (!record) {
      const card = document.createElement('button');
      card.type = 'button'; card.className = 'fish-card';
      const art = document.createElement('span'); art.className = 'fish-card-art';
      const name = document.createElement('b');
      const detail = document.createElement('small');
      const bar = document.createElement('div'); bar.className = 'growth';
      const fill = document.createElement('i'); bar.append(fill);
      card.append(art, name, detail, bar);
      card.onclick = () => { selectFish(fish.id); view?.greetFish?.(fish.id); markInteraction(); };
      record = {card,art,name,detail,fill,artKey:''};
      fishCards.set(fish.id,record);
    }
    const {card,art,name,detail,fill} = record;
    const stage = describeStage(fish.growth);
    const artKey = JSON.stringify([fish.species,fish.seed,fish.growth]);
    if (record.artKey !== artKey) { art.innerHTML = fishSVG(fish); record.artKey = artKey; }
    if (name.textContent !== fish.name) name.textContent = fish.name;
    const description = `${stage.name} · ${Math.max(1, Math.floor(ageDays(fish.born, now)) + 1)} 天`;
    if (detail.textContent !== description) detail.textContent = description;
    fill.style.width = `${Math.max(3, fish.growth * 100)}%`;
    card.setAttribute('aria-current',String(fish.id === activeFishId));
    card.setAttribute('aria-label', `查看 ${fish.name} 的信息`);
    if (card !== cursor) list.insertBefore(card,cursor);
    cursor = card.nextElementSibling;
  }
  for (const [id,record] of fishCards) if (!keep.has(id)) { record.card.remove(); fishCards.delete(id); }
}

function refreshPanels() {
  $('fish-panel').hidden = editMode === 'decor';
  $('decor-panel').hidden = editMode !== 'decor';
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
  const picker = $('decor-picker');
  if (picker) {
    const signature = state.decor.map(d=>`${d.id}:${d.type}`).join('|');
    if (signature !== decorPickerSignature) {
      picker.replaceChildren(new Option('点选物件，或从这里选择',''));
      for (const [i,d] of state.decor.entries()) {
        const meta=KIND_META[d.kind];
        const name=meta.types.find(t=>t.id===d.type)?.name || meta.name;
        picker.add(new Option(`${name} · ${i+1}`, d.id));
      }
      decorPickerSignature=signature;
    }
    picker.value=selectedDecorId || '';
    picker.disabled=!canEditAquarium() || viewMode==='2d';
  }
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
  $('float-confirm').hidden = false;
  $('float-confirm').textContent = isPending ? '放在这里' : '完成布景';
  $('float-cancel').hidden = !isPending;
  floatBar.querySelector('[data-decor-action="delete"]').disabled = isPending;
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
      writePrefs({sound:false});
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
        audioNodes = [source, filter, gain];
      }
      await audioCtx.resume();
      writePrefs({sound:true});
    }
    $('sound').setAttribute('aria-pressed', String(on));
  } catch {
    writePrefs({sound:false});
    toast('当前浏览器暂时无法播放水声。');
  }
}

// ------------------------------------------------------------------ 交互接线
$('feed').onclick = () => feed();
$('add-fish').onclick = () => openSpeciesPicker();
$('add-plant').onclick = () => addDecorObject('plant');
$('add-rock').onclick = () => addDecorObject('rock');
$('add-wood').onclick = () => addDecorObject('wood');
$('night').onclick = () => { if (!canEditAquarium()) return; state.night = !state.night; save(); view?.setNight(state.night); refreshAll(); };
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
  quality = ['auto','low','high'].includes(event.target.value) ? event.target.value : 'auto';
  writePrefs({ quality });
  view?.setQualityPolicy?.(quality);
  markInteraction();
  toast(({auto:'已启用自动省电，会按运行情况调整效果。',low:'已切到省电模式。',high:'已切到精致模式。'})[quality]);
};
$('mode-view').onclick = () => applyEditMode('view');
$('play-mode').onclick = () => {
  if (viewMode !== '3d') return;
  applyEditMode('view');
  const enabled = view?.setPlayMode?.(!view?.playMode);
  $('play-mode').setAttribute('aria-pressed', String(Boolean(enabled)));
  showTip(enabled ? '移动鼠标或按住水面轻轻滑动，小鱼会慢慢跟过来。' : '轻触水面打招呼，用「喂一点」或空格投食。');
};
$('mode-decor').onclick = () => {
  if (!canEditAquarium()) return;
  if (viewMode === '2d') { toast('布景编辑需要 3D 模式。'); return; }
  applyEditMode('decor');
};
$('decor-picker')?.addEventListener('change', event => { if (event.target.value && canEditAquarium()) selectDecor(event.target.value); });
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
    if (!canEditAquarium()) return;
    const item = state.decor.find(d => d.id === selectedDecorId);
    if (!item) return;
    const [dx, dz] = button.dataset.decorNudge.split(',').map(Number);
    pushUndo();
    applyState(updateDecor(state, item.id, { x: item.x + dx, z: item.z + dz }).state);
    save();
  };
});
$('float-confirm').onclick = () => {
  if (!canEditAquarium()) return;
  if (pendingDecorId) {
    if (!$('decor-confirm').disabled) $('decor-confirm').click();
    return;
  }
  save();
  applyEditMode('view');
  toast('布景已完成。');
};
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
  if (!canEditAquarium()) return;
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
  if (!canEditAquarium()) return;
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
  if (!canEditAquarium()) return;
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
  if (engine.isShared) { toast('请先导出备份，退出账号后可在游客模式导入旧存档。'); event.target.value=''; return; }
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

if (collaborationEnabled) sharingUI = createSharingUI({button:$('sharing-button'),controller:{
  context:collaboration.context,
  listAquariums:sharingApi.listAquariums, openAquarium:collaboration.openAquarium, goPersonal:()=>collaboration.goPersonal(),
  listMembers:sharingApi.listMembers,listInvites:sharingApi.listInvites,createInvite:sharingApi.createInvite,
  revokeInvite:sharingApi.revokeInvite,setMemberRole:sharingApi.setMemberRole,removeMember:sharingApi.removeMember,
  acceptInvite:sharingApi.acceptInvite,leaveAquarium:sharingApi.leaveAquarium
},onNotice:toast});
$('return-personal').onclick=()=>collaboration.goPersonal().then(r=>{if(!r.ok)toast(r.error||'请先处理未同步改动。');});

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
    applyRuntimeActivity();
    if (engine.isCloud) engine.flush({ reason: 'hidden', keepalive: true }).catch(() => {});
    mutedByVisibility = audioCtx?.state === 'running';
    if (mutedByVisibility) audioCtx.suspend();
  } else {
    applyRuntimeActivity();
    if (engine.isCloud) requestForegroundSync('visible');
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
  if (!document.hidden && engine.isCloud) requestForegroundSync('focus');
});
window.addEventListener('pagehide', () => {
  if (engine.isCloud) {
    engine.persistLocal();
    engine.flush({ reason: 'pagehide', keepalive: true }).catch(() => {});
  } else save({ silent: true });
});
window.addEventListener('online', () => { requestForegroundSync('online'); refreshAll(); });
window.addEventListener('offline', () => { engine.handleOffline(); refreshAll(); });

if ('ResizeObserver' in window) {
  resizeObserver = new ResizeObserver(() => view?.resize?.());
  resizeObserver.observe(canvas);
}

// Coalesce visible/focus/online events from one foreground transition.
let foregroundSyncTimer = null;
function requestForegroundSync(reason) {
  if (foregroundSyncTimer !== null) return;
  foregroundSyncTimer = setTimeout(() => {
    foregroundSyncTimer = null;
    if (navigator.onLine === false || document.hidden || !engine.isCloud) return;
    if (reason === 'online') engine.handleOnline();
    else engine.syncNow({reason:'foreground'}).catch(() => {});
  }, 200);
}
if ('IntersectionObserver' in window) {
  const observer = new IntersectionObserver(entries => {
    stageVisible = entries.some(entry => entry.isIntersecting);
    applyRuntimeActivity();
  }, {threshold:0.01});
  observer.observe($('aquarium'));
}
$('aquarium').addEventListener('pointerdown', markInteraction, {passive:true});
$('aquarium').addEventListener('pointermove', event => { if (event.buttons || view?.playMode) markInteraction(); }, {passive:true});
$('aquarium').addEventListener('keydown', markInteraction);

document.addEventListener('pointerdown', event => { const menu=$('more-settings'); if(menu?.open && !menu.contains(event.target)) menu.open=false; });
document.addEventListener('keydown', event => { if(event.key==='Escape' && $('more-settings')?.open) { $('more-settings').open=false; $('more-button').focus(); event.preventDefault(); } });
document.addEventListener('fullscreenchange', applyRuntimeActivity);

function reportBuild() { (navigator.serviceWorker?.controller || serviceWorkerRegistration?.active)?.postMessage({type:'MOFISH_BUILD_STATUS',entry:BUILD_ENTRY}); }
function showUpdate() {
  updateAvailable = Boolean(serviceWorkerRegistration?.waiting);
  if (!$('update-banner')) return;
  $('update-banner').hidden = !updateAvailable;
  $('update-copy').textContent = '有新的测试版本。当前改动保存后，可以更新。';
}
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.addEventListener('message', event => {
    if (event.data?.type === 'MOFISH_BUILD_QUERY') reportBuild();
    if (event.data?.type === 'MOFISH_SHELL_CACHED') {
      $('offline-status').textContent = event.data.entry === BUILD_ENTRY
        ? '当前版本的离线 2D 资源已就绪；使用过的 3D 将另外缓存。'
        : '离线缓存属于另一构建，请完成更新后再离线使用。';
      if (event.data.entry === BUILD_ENTRY) cacheUsedRenderer();
    }
    if (event.data?.type === 'MOFISH_3D_CACHED' && event.data.entry === BUILD_ENTRY) $('offline-status').textContent = '2D 与已用过的 3D 资源均已就绪，可离线打开。';
  });
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    reportBuild();
    if (updateRequested) location.reload();
  });
  navigator.serviceWorker.register('./sw.js').then(async registration => {
    serviceWorkerRegistration = registration;
    showUpdate();
    registration.addEventListener('updatefound', () => {
      const worker = registration.installing;
      worker?.addEventListener('statechange', () => { if (worker.state === 'installed') showUpdate(); });
    });
    await navigator.serviceWorker.ready;
    $('offline-status').textContent = '正在核对当前版本的离线资源；首次准备需要联网。';
    reportBuild(); cacheUsedRenderer();
    registration.update().catch(() => {});
  }).catch(() => { $('offline-status').textContent = '离线资源暂未就绪，请联网使用。'; });
} else $('offline-status').textContent = '此浏览器不支持离线缓存，请联网使用。';
$('update-button')?.addEventListener('click', async () => {
  if (!serviceWorkerRegistration?.waiting || updateInProgress) return;
  const generation = engine.generation;
  const wasInert = document.body.inert;
  const previousFocus = document.activeElement;
  $('update-button').disabled = true;
  try {
    if (pendingDecorId) throw new Error('请先确认或取消当前造景，再更新版本。');
    updateInProgress = true;
    document.body.inert = true;
    $('update-copy').textContent = '正在保存并核对当前鱼缸，请稍候…';
    $('update-banner').setAttribute('aria-busy','true');
    if (!persistLocal()) throw new Error('本机保存未完成，请先导出备份。');
    if (engine.isCloud) await engine.flush({reason:'app-update'});
    if (generation !== engine.generation) throw new Error('账号或鱼缸已变化，请确认当前内容后重新更新。');
    const snap = engine.snapshot;
    if (snap?.dirty || snap?.conflict || engine.isDirty || Number(engine.pendingFeeds || 0) > 0) throw new Error('还有未同步改动，请先完成同步或处理冲突后更新。');
    updateRequested = true;
    await new Promise((resolve,reject) => {
      const changed = () => { clearTimeout(timer); resolve(); };
      const timer = setTimeout(() => {
        navigator.serviceWorker.removeEventListener('controllerchange',changed);
        reject(new Error('更新尚未完成，请稍后重试；当前鱼缸继续保留。'));
      },15000);
      navigator.serviceWorker.addEventListener('controllerchange',changed,{once:true});
      serviceWorkerRegistration.waiting.postMessage({type:'MOFISH_USE_UPDATE'});
    });
  } catch (error) { updateRequested = false; toast(error.message || '更新暂未完成，当前鱼缸继续保留。'); }
  finally {
    updateInProgress = false;
    document.body.inert = wasInert;
    $('update-button').disabled = false;
    $('update-banner').removeAttribute('aria-busy');
    showUpdate(); refreshAll();
    if (!updateRequested && previousFocus?.isConnected) previousFocus.focus();
  }
});
if ($('app-version')) { $('app-version').textContent = `V${APP_VERSION.replace(/\.0$/, '')} 测试版`; $('app-version').title = `${APP_VERSION} · ${SOURCE_SHA.slice(0,12)}`; }
for (const note of document.querySelectorAll('[data-qa-note]')) note.hidden = !collaborationEnabled;
if ($('inspector') && matchMedia('(min-width:1024px)').matches) $('inspector').open = true;

// 供端到端测试与排障使用的只读探针（不暴露修改能力）。
window.__mofish = {
  get state() { return cloneState(state); },
  get renderer() { return viewMode; },
  get quality() { return quality; },
  get editMode() { return editMode; },
  get selectedDecor() { return selectedDecorId; },
  get selectionFeedback() { return view?.selectionFeedback || null; },
  get pendingFeeds() { return engine.pendingFeeds; },
  get version() { return STATE_VERSION; },
  get decorCounts() {
    return state.decor.reduce((acc, d) => { acc[d.kind] = (acc[d.kind] || 0) + 1; return acc; }, {});
  },
  get bootMs() { return Math.round(bootAt); },
  get renderInfo() { return view?.rendererInfo || null; },
  get playMode() { return Boolean(view?.playMode); },
  get motionInfo() { return view?.motionInfo || null; },
  get resourceInfo() { return view?.resourceInfo || null; },
  get performanceInfo() { return view?.performanceInfo || null; },
  get appVersion() { return APP_VERSION; },
  get sourceSha() { return SOURCE_SHA; },
  get updateAvailable() { return updateAvailable; }
};
