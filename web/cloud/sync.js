// 同步引擎：把「本机状态」与「云端权威存档」对齐。
//
// 设计要点（对应 ROADMAP 阶段 A 的必须行为）：
// - 只同步持久属性（鱼的身份/名字/种类/成长/喂食记录 + 造景）。每帧位置、光柱、水波都在本机计算。
// - 写入去抖，并且只在规范化后的状态真的变了才发请求；没有固定轮询定时器。
// - 冲突靠数据库 revision 判定；冲突时保留未同步本地副本，绝不静默覆盖。
// - 已登录时的离线成长由服务端结算（服务端时间、上限 24 小时、重复调用不重复奖励）；
//   客户端在云端模式下不做本地时间成长，避免同一段时间被两边各加一次。
// - 退出登录只清除内存与界面状态；缓存的键里带 userId 与 aquariumId，换号不会串档。
//
// 依赖全部注入，便于在 Node 中用假 api / 假存储做单元测试。

import { STATE_VERSION, canonicalState, cloneState, validate } from '../model.js';

export const STATUS = {
  GUEST: 'guest',
  CLOUD_OFF: 'cloud_off',
  OFFLINE: 'offline',
  SYNCING: 'syncing',
  SYNCED: 'synced',
  ERROR: 'error',
  CONFLICT: 'conflict',
  SIGNED_OUT: 'signed_out'
};

export const STATUS_LABEL = {
  [STATUS.GUEST]: '游客 · 本机保存',
  [STATUS.CLOUD_OFF]: '未连接云端 · 本机保存',
  [STATUS.OFFLINE]: '离线 · 已存本机',
  [STATUS.SYNCING]: '同步中…',
  [STATUS.SYNCED]: '已同步到云端',
  [STATUS.ERROR]: '同步失败 · 已存本机',
  [STATUS.CONFLICT]: '有冲突待处理',
  [STATUS.SIGNED_OUT]: '登录已失效'
};

export const CONFLICT_REASON = {
  GUEST_IMPORT: 'guest_import',   // 首次登录时本机有旧存档，云端也已有存档
  PENDING: 'pending',             // 本机有未同步修改（离线期间的改动）
  SAVE: 'save'                    // 保存时 revision 不匹配
};

/** 服务端成长速率与本地 model.catchUp 保持一致：每小时 +0.008，上限 1。 */
export const GROWTH_PER_HOUR = 0.008;

/** 把服务端结算出的秒数换算成成长增量并叠加到本地副本（用于存在未同步修改时的记账）。 */
export function applyGrowthDelta(state, creditedSeconds) {
  const next = cloneState(state);
  if (!creditedSeconds || creditedSeconds <= 0) return next;
  const delta = (creditedSeconds / 3600) * GROWTH_PER_HOUR;
  for (const fish of next.fish) {
    const value = Math.min(1, Math.max(0, Number(fish.growth || 0) + delta));
    fish.growth = Math.round(value * 1e6) / 1e6;
  }
  return next;
}

export function describeStatus(status) {
  return STATUS_LABEL[status] || '未知状态';
}

/**
 * @param {object} deps
 * @param {object} deps.api            createCloudApi 的实例
 * @param {object} deps.store          createLocalStore 的实例
 * @param {function} deps.getState     读取当前内存状态
 * @param {function} deps.setState     用云端/本地权威状态替换内存状态
 * @param {function} [deps.initialState] 生成初始存档（与 model.initial 一致）
 * @param {number}  [deps.debounceMs]  写入去抖毫秒数
 * @param {function} [deps.now]
 * @param {function} [deps.setTimeoutFn]
 * @param {function} [deps.clearTimeoutFn]
 * @param {function} [deps.isOnline]
 * @param {function} [deps.onStatus]   状态变化回调（用于界面提示）
 * @param {function} [deps.onNotice]   一次性提示文案回调
 */
export function createSyncEngine({
  api,
  store,
  getState,
  setState,
  initialState,
  debounceMs = 2500,
  now = () => Date.now(),
  setTimeoutFn = (fn, ms) => setTimeout(fn, ms),
  clearTimeoutFn = (handle) => clearTimeout(handle),
  isOnline = () => (typeof navigator === 'undefined' ? true : navigator.onLine !== false),
  onStatus = () => {},
  onNotice = () => {}
} = {}) {
  let mode = 'guest';                 // 'guest' | 'cloud'
  let session = null;
  let aquariumId = null;
  let revision = 0;
  let lastGrowthAt = null;
  let lastSyncedCanonical = null;
  let conflict = null;
  let status = api?.configured ? STATUS.GUEST : STATUS.CLOUD_OFF;
  let timer = null;
  let inFlight = null;
  let queued = false;
  let disposed = false;

  const configured = Boolean(api?.configured);

  function snapshot() {
    return {
      status,
      label: describeStatus(status),
      mode,
      configured,
      user: session ? { id: session.user.id, email: session.user.email } : null,
      aquariumId,
      revision,
      lastGrowthAt,
      conflict: conflict ? { reason: conflict.reason, cloudRevision: conflict.cloudRevision } : null
    };
  }

  function setStatus(next, message = '') {
    status = next;
    // 回调是界面层的代码，必须隔离：界面渲染出问题不能让同步状态机崩掉或卡住。
    try {
      onStatus({ ...snapshot(), message });
    } catch (err) {
      if (typeof console !== 'undefined') console.warn('同步状态回调出错（已忽略）', err);
    }
  }

  function notify(message) {
    try { onNotice(message); } catch { /* 忽略界面回调异常 */ }
  }

  function clearSaveTimer() {
    if (timer !== null) { clearTimeoutFn(timer); timer = null; }
  }

  function scheduleSave() {
    clearSaveTimer();
    // 回调返回 flush 的 promise：浏览器忽略返回值，但测试可以据此等待写入真正完成。
    timer = setTimeoutFn(() => { timer = null; return flush({ reason: 'debounce' }); }, debounceMs);
  }

  function userId() {
    return session?.user?.id || null;
  }

  /** 用一份权威状态替换内存状态：服务端返回的数据仍然要过一遍本地校验，坏数据不进渲染层。 */
  function adopt(state, { writeCache = true } = {}) {
    const parsed = validate(state);
    setState(parsed);
    lastSyncedCanonical = canonicalState(parsed);
    if (writeCache && userId() && aquariumId) store.writeAccountState(userId(), aquariumId, parsed);
    return parsed;
  }

  /** 离线时用本机可用副本继续游玩，并把「有未同步内容」如实反映到状态上。 */
  function adoptLocalFallback(local) {
    const parsed = validate(local || (initialState ? initialState() : getState()));
    setState(parsed);
    lastSyncedCanonical = null;   // 未知云端内容，下一次联网必须重新对账
    return parsed;
  }

  async function setSession(nextSession) {
    if (disposed) return { ok: false, skipped: 'disposed' };
    clearSaveTimer();
    inFlight = null; queued = false; conflict = null;
    session = nextSession && nextSession.user && nextSession.user.id ? nextSession : null;

    if (!session) {
      mode = 'guest';
      aquariumId = null; revision = 0; lastGrowthAt = null; lastSyncedCanonical = null;
      setStatus(configured ? STATUS.GUEST : STATUS.CLOUD_OFF);
      return { ok: true, mode: 'guest' };
    }

    mode = 'cloud';
    return hydrate();
  }

  /**
   * 登录后对账：读本机各份副本 → 幂等开缸/取回云端 → 服务端结算成长 → 决定是否需要用户选择。
   */
  async function hydrate() {
    const uid = userId();
    if (!uid) return { ok: false, skipped: 'no_session' };
    setStatus(STATUS.SYNCING);

    const pointer = store.readCurrent(uid);
    const cachedState = pointer?.aquariumId ? store.readAccountState(uid, pointer.aquariumId) : null;
    const pendingState = pointer?.aquariumId ? store.readPending(uid, pointer.aquariumId) : null;
    const guestState = store.hasGuest() ? store.readGuest() : null;

    // 候选存档：未同步修改 > 上次同步缓存 > 登录前的本机（游客）存档 > 当前内存
    const candidate = pendingState || cachedState || guestState || getState();

    const ensured = await api.ensureAquarium(candidate, STATE_VERSION);
    if (!ensured.ok) {
      const result = ensured.result || {};
      if (result.kind === 'unauthenticated' || result.kind === 'forbidden') {
        setStatus(STATUS.SIGNED_OUT, result.message || '');
        return { ok: false, result };
      }
      if (result.kind === 'not_configured') {
        mode = 'guest';
        setStatus(STATUS.CLOUD_OFF, result.message || '');
        return { ok: false, result };
      }
      adoptLocalFallback(candidate);
      setStatus(isOnline() ? STATUS.ERROR : STATUS.OFFLINE, result.message || '');
      return { ok: false, result, offline: true };
    }

    aquariumId = ensured.result.aquariumId;
    revision = ensured.result.revision;
    lastGrowthAt = ensured.result.lastGrowthAt || null;
    store.writeCurrent(uid, { aquariumId, revision, lastGrowthAt });

    // 服务端时间结算离线成长：重复调用不会重复奖励；返回值就是权威状态。
    const settled = await api.settleGrowth(aquariumId);
    let cloudState = ensured.result.state;
    let creditedSeconds = 0;
    if (settled.ok) {
      cloudState = settled.result.state ?? cloudState;
      revision = settled.result.revision ?? revision;
      lastGrowthAt = settled.result.lastGrowthAt || lastGrowthAt;
      creditedSeconds = settled.result.creditedSeconds || 0;
      store.writeCurrent(uid, { aquariumId, revision, lastGrowthAt });
    }

    // 存在未同步修改时，把这次结算的成长增量也记到本地副本上（时间成长只算一次，
    // 离线期间的喂食等用户动作仍然保留）。
    const pendingAdjusted = pendingState ? applyGrowthDelta(pendingState, creditedSeconds) : null;

    if (ensured.result.created === true) {
      // 云端刚刚用本机候选存档开缸：不存在「两份存档」的情形，直接视为已同步。
      adopt(cloudState, { writeCache: true });
      store.clearPending(uid, aquariumId);
      setStatus(STATUS.SYNCED);
      if (guestState && canonicalState(guestState) !== canonicalState(cloudState)) {
        notify('本机鱼缸已上传到云端，之后换设备登录就能接着养。');
      }
      return { ok: true, created: true, mode: 'cloud' };
    }

    if (pendingAdjusted) {
      return raiseConflict({
        reason: CONFLICT_REASON.PENDING,
        cloudState,
        cloudRevision: revision,
        localState: pendingAdjusted,
        message: '本机有还没同步的修改，云端也有新内容。请选择保留哪一份。'
      });
    }

    if (guestState && canonicalState(guestState) !== canonicalState(cloudState)) {
      return raiseConflict({
        reason: CONFLICT_REASON.GUEST_IMPORT,
        cloudState,
        cloudRevision: revision,
        localState: guestState,
        message: '这台设备上有一份旧的本地鱼缸，云端账号里也有一份存档。请选择保留哪一份。'
      });
    }

    adopt(cloudState, { writeCache: true });
    store.clearPending(uid, aquariumId);
    setStatus(STATUS.SYNCED);
    return { ok: true, mode: 'cloud', revision };
  }

  function raiseConflict({ reason, cloudState, cloudRevision, localState, message }) {
    conflict = { reason, cloudState, cloudRevision, localState };
    if (userId() && aquariumId) store.writePending(userId(), aquariumId, localState);
    setStatus(STATUS.CONFLICT, message);
    return { ok: false, conflict: snapshot().conflict, mode: 'cloud' };
  }

  /** 供界面在用户做出选择后读取本地/云端两份内容。 */
  function conflictDetail() {
    if (!conflict) return null;
    const localState = conflict.localState;
    const cloudState = conflict.cloudState;
    return {
      reason: conflict.reason,
      cloudRevision: conflict.cloudRevision,
      // 保存时冲突（revision 不匹配）只知道云端 revision，还没有取回云端内容，
      // 界面必须能处理 cloudKnown=false，不能假定一定有两份可比较的存档。
      cloudKnown: Boolean(cloudState),
      localFish: (localState?.fish || []).map(f => ({ id: f.id, name: f.name, growth: f.growth, meals: f.meals })),
      cloudFish: (cloudState?.fish || []).map(f => ({ id: f.id, name: f.name, growth: f.growth, meals: f.meals }))
    };
  }

  /**
   * 变更通知：只做「是否真的变了」与去抖，不建立固定轮询。
   */
  function markDirty() {
    if (disposed || mode !== 'cloud' || conflict || !aquariumId) return false;
    const canonical = canonicalState(getState());
    if (canonical === lastSyncedCanonical) {
      clearSaveTimer();          // 撤销尚未发出的无意义写入
      return false;
    }
    scheduleSave();
    return true;
  }

  /** 立即写入（用于「立即同步」按钮、切后台、断线重连、页面关闭）。 */
  async function flush({ reason = 'manual', keepalive = false } = {}) {
    clearSaveTimer();
    if (disposed) return { ok: false, skipped: 'disposed' };
    if (mode !== 'cloud') return { ok: true, skipped: 'guest' };
    if (!aquariumId) return { ok: false, skipped: 'no_aquarium' };
    if (conflict) return { ok: false, skipped: 'conflict' };
    if (inFlight) { queued = true; return inFlight; }

    const state = getState();
    const canonical = canonicalState(state);
    if (canonical === lastSyncedCanonical) return { ok: true, skipped: 'unchanged' };

    setStatus(STATUS.SYNCING);
    inFlight = (async () => {
      const uid = userId();
      const res = await api.saveAquarium({
        aquariumId,
        expectedRevision: revision,
        state: cloneState(state),
        stateVersion: STATE_VERSION,
        keepalive
      });

      if (res.ok) {
        revision = res.result.revision;
        lastSyncedCanonical = canonical;
        store.writeAccountState(uid, aquariumId, state);
        store.writeCurrent(uid, { aquariumId, revision, lastGrowthAt });
        store.clearPending(uid, aquariumId);
        setStatus(STATUS.SYNCED);
        return { ok: true, revision, reason };
      }

      const result = res.result || {};
      if (result.kind === 'conflict') {
        raiseConflict({
          reason: CONFLICT_REASON.SAVE,
          cloudState: null,
          cloudRevision: result.revision,
          localState: state,
          message: '云端存档已经被其它设备改过（revision 不一致）。本机的改动已保留，请选择如何处理。'
        });
        return { ok: false, result, reason };
      }
      if (result.kind === 'unauthenticated' || result.kind === 'forbidden') {
        store.writePending(uid, aquariumId, state);
        setStatus(STATUS.SIGNED_OUT, result.message || '');
        return { ok: false, result, reason };
      }
      if (result.kind === 'invalid_state' || result.kind === 'invalid_argument') {
        // 云端认为存档不合法：不重试、不覆盖，保留本机副本并明确报错。
        store.writePending(uid, aquariumId, state);
        setStatus(STATUS.ERROR, result.message || '');
        return { ok: false, result, reason };
      }
      store.writePending(uid, aquariumId, state);
      setStatus(isOnline() ? STATUS.ERROR : STATUS.OFFLINE, result.message || '网络不可达');
      return { ok: false, result, reason };
    })();

    try {
      return await inFlight;
    } finally {
      inFlight = null;
      if (queued && !disposed && !conflict) { queued = false; scheduleSave(); }
    }
  }

  /**
   * 处理冲突。choice:
   *  - 'cloud'：放弃本机未同步改动，采用云端存档（本机副本仍以 pending 键保留，可导出）。
   *  - 'local'：用本机存档覆盖云端：先取云端最新 revision，再以它做条件写入。
   *  - 'later'：保持现状，稍后决定。
   */
  async function resolveConflict(choice) {
    if (!conflict) return { ok: true, skipped: 'no_conflict' };
    const uid = userId();
    const pendingLocal = conflict.localState;

    if (choice === 'later') return { ok: true, skipped: 'later' };

    if (choice === 'cloud') {
      // 先把本机未同步的改动归档成备份，再采用云端存档：用户的选择不该等于数据消失。
      if (uid && aquariumId) store.writeBackup(uid, aquariumId, pendingLocal);
      // 重新读取云端权威状态（含这段时间的服务端成长结算）。
      const ensured = await api.ensureAquarium(pendingLocal, STATE_VERSION);
      if (!ensured.ok) {
        setStatus(isOnline() ? STATUS.ERROR : STATUS.OFFLINE, ensured.result?.message || '');
        return { ok: false, result: ensured.result };
      }
      revision = ensured.result.revision;
      let cloudState = ensured.result.state;
      const settled = await api.settleGrowth(ensured.result.aquariumId);
      if (settled.ok) {
        cloudState = settled.result.state ?? cloudState;
        revision = settled.result.revision ?? revision;
        lastGrowthAt = settled.result.lastGrowthAt || lastGrowthAt;
      }
      aquariumId = ensured.result.aquariumId;
      store.writeCurrent(uid, { aquariumId, revision, lastGrowthAt });
      adopt(cloudState, { writeCache: true });
      store.clearPending(uid, aquariumId);
      conflict = null;
      setStatus(STATUS.SYNCED);
      return { ok: true, resolution: 'cloud' };
    }

    if (choice === 'local') {
      // 用本机覆盖云端之前：先取一次云端最新状态，一是拿到最新 revision（避免再次冲突），
      // 二是把将被覆盖的云端版本归档为本机备份，做到「旧数据不丢失」。
      let targetRevision = conflict.cloudRevision;
      const current = await api.ensureAquarium(pendingLocal, STATE_VERSION);
      if (current.ok) {
        if (current.result.state) store.writeBackup(uid, current.result.aquariumId, current.result.state);
        targetRevision = current.result.revision;
        aquariumId = current.result.aquariumId;
      }

      conflict = null;
      if (Number.isFinite(targetRevision)) revision = targetRevision;
      if (uid && aquariumId) store.writePending(uid, aquariumId, pendingLocal);
      setState(validate(pendingLocal));
      lastSyncedCanonical = null;   // 强制走一次真实写入
      const res = await flush({ reason: 'conflict-resolution' });
      return res.ok ? { ok: true, resolution: 'local' } : { ok: false, result: res.result };
    }

    return { ok: false, error: { code: 'unknown_choice', message: '未知的处理方式' } };
  }

  /** 手动/自动重新对账：结算服务端成长并写入待同步内容。 */
  async function syncNow({ reason = 'manual' } = {}) {
    if (disposed) return { ok: false, skipped: 'disposed' };
    if (mode !== 'cloud') return { ok: true, skipped: 'guest' };
    if (conflict) return { ok: false, skipped: 'conflict' };
    if (!aquariumId) return hydrate();

    if (isOnline()) {
      const settled = await api.settleGrowth(aquariumId);
      if (settled.ok) {
        revision = settled.result.revision ?? revision;
        lastGrowthAt = settled.result.lastGrowthAt || lastGrowthAt;
        store.writeCurrent(userId(), { aquariumId, revision, lastGrowthAt });
        if ((settled.result.creditedSeconds || 0) > 0) {
          // 服务端成长是权威值；本机若有未同步改动，按同一增量记账后再合并。
          const grown = settled.result.state;
          const local = getState();
          const hasLocalChanges = lastSyncedCanonical !== null && canonicalState(local) !== lastSyncedCanonical;
          if (hasLocalChanges) {
            const merged = applyGrowthDelta(local, settled.result.creditedSeconds);
            setState(merged);
            notify('云端结算了离线成长，本机的修改保留着。');
          } else {
            adopt(grown, { writeCache: true });
          }
        }
      } else if (settled.result?.kind === 'unauthenticated') {
        setStatus(STATUS.SIGNED_OUT);
        return { ok: false, result: settled.result };
      }
    }

    const res = await flush({ reason });
    if (res.skipped === 'unchanged') return { ok: true, skipped: 'unchanged' };
    return res;
  }

  function handleOffline() {
    if (mode !== 'cloud') return;
    clearSaveTimer();
    setStatus(STATUS.OFFLINE);
  }

  function handleOnline() {
    if (mode !== 'cloud') return;
    if (conflict) { setStatus(STATUS.CONFLICT); return; }
    syncNow({ reason: 'reconnect' });
  }

  function dispose() {
    disposed = true;
    clearSaveTimer();
  }

  return {
    get mode() { return mode; },
    get status() { return status; },
    get snapshot() { return snapshot(); },
    get isCloud() { return mode === 'cloud'; },
    get pendingSaveScheduled() { return timer !== null; },
    setSession,
    hydrate,
    markDirty,
    flush,
    syncNow,
    resolveConflict,
    conflictDetail,
    handleOnline,
    handleOffline,
    dispose
  };
}
