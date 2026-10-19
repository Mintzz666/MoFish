// 同步引擎：把「本机状态」与「云端权威存档」对齐。
//
// 设计要点（对应 ROADMAP 阶段 A 的必须行为，以及第二轮评审的 P1/P2 修复）：
// - 只同步持久属性（鱼的身份/名字/种类/成长/喂食记录 + 造景）。每帧位置、光柱、水波都在本机计算。
// - 写入去抖，并且只在规范化后的状态真的变了才发请求；没有固定轮询定时器。
// - **上传统一以 baseRevision 为基线**：本机状态永远记得它基于哪个服务端 revision。
//   只有云端 revision 仍等于这个基线时才允许写入；否则判定为冲突并交给用户选择，
//   绝不用「刚结算出来的新 revision」去覆盖另一台设备的修改（评审 P1-1）。
// - 顺序固定为「先上传本机改动，再结算服务端成长」：save_aquarium 不改动成长锚点，
//   所以上传之后再结算，这段时间的成长照样会被补上，既不会丢成长也不会重复计算。
// - 每次本机落盘都会同时写下「未同步副本 + 它的基线」，因此刷新/关页/重开后能判断
//   云端有没有被改过，而不是盲目采用云端（评审 P1-2）。
// - 所有异步流程都带会话代次（generation）检查：换号或退出后，旧请求的响应一律丢弃，
//   不会把上一个账号的数据写进当前账号的界面与缓存（评审 P1-3）。
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

export function describeStatus(status) {
  return STATUS_LABEL[status] || '未知状态';
}

/** 只保留「本机那份」与「云端那份」的关键字段，供界面比较与展示。 */
function fishSummary(state) {
  return (state?.fish || []).map(f => ({ id: f.id, name: f.name, growth: f.growth, meals: f.meals }));
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
  let generation = 0;                 // 会话代次：换号/退出时 +1，用来丢弃在途响应
  let aquariumId = null;
  let baseRevision = null;            // 本机状态所基于的服务端 revision
  let baseCanonical = null;           // 该 revision 对应的状态指纹（null = 基线未知）
  let lastGrowthAt = null;
  let conflict = null;
  let status = api?.configured ? STATUS.GUEST : STATUS.CLOUD_OFF;
  let timer = null;
  let inFlight = null;
  let queued = false;
  let settling = false;
  let settlePromise = null;
  // 未提交的进食事件：严格单人，每条鱼吃到一口算一条，带唯一 operation_id 去重。
  let feedQueue = [];
  let feedTimer = null;
  let pushingFeeds = null;
  const hydrationCounts = new Map();
  const hydrationPromises = new Map();
  let settleToken = 0;
  let disposed = false;

  const configured = Boolean(api?.configured);

  function userId() {
    return session?.user?.id || null;
  }

  function snapshot() {
    return {
      status,
      label: describeStatus(status),
      mode,
      configured,
      user: session ? { id: session.user.id, email: session.user.email } : null,
      aquariumId,
      revision: baseRevision,
      baseRevision,
      dirty: isDirty(),
      busy: Boolean(inFlight || settling || pushingFeeds || (hydrationCounts.get(generation) || 0) > 0 || (status === STATUS.SYNCING && timer === null)),
      lastGrowthAt,
      pendingFeeds: feedQueue.length,
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

  /** 该异步流程是否已经过期（换号/退出/已销毁）。过期后不得再改状态、缓存或界面。 */
  function stale(gen) {
    return disposed || gen !== generation;
  }

  function clearSaveTimer() {
    if (timer !== null) { clearTimeoutFn(timer); timer = null; }
  }

  function scheduleSave() {
    clearSaveTimer();
    const gen = generation;
    // 回调返回 flush 的 promise：浏览器忽略返回值，但测试可以据此等待写入真正完成。
    timer = setTimeoutFn(() => { timer = null; return flush({ reason: 'debounce', gen }); }, debounceMs);
  }

  /** 本机是否有尚未同步到云端的改动。基线未知（离线首次对账）时保守地当作「有」。 */
  function isDirty() {
    if (mode !== 'cloud' || !aquariumId) return false;
    if (baseCanonical === null || baseRevision === null) return true;
    return canonicalState(getState()) !== baseCanonical;
  }

  /** 记录「本机状态已经与云端 revision 对齐」。 */
  function markSynced(state, revision) {
    const rev = revision == null ? null : Number(revision);
    if (Number.isFinite(rev)) baseRevision = rev;
    baseCanonical = canonicalState(state);
    // The acknowledged snapshot is the new baseline. Persist the current live
    // state against it so edits made while the request was in flight stay pending.
    persistLocal();
  }

  /** 用一份权威状态替换内存状态：服务端返回的数据仍然要过一遍本地校验，坏数据不进渲染层。 */
  function adopt(serverState, revision) {
    const parsed = validate(serverState);
    setState(parsed);
    markSynced(parsed, revision);
    return parsed;
  }

  /**
   * 本机落盘（不发网络请求）。除了账号缓存，还会在「有未同步改动」时写下
   * 未同步副本 + 它基于的 revision，这样刷新页面后不会把改动读丢（评审 P1-2）。
   */
  function persistLocal() {
    const uid = userId();
    if (mode !== 'cloud' || !uid || !aquariumId) return false;
    const state = getState();
    store.writeAccountState(uid, aquariumId, state);
    store.writeCurrent(uid, { aquariumId, revision: baseRevision, lastGrowthAt });
    store.writeFeeds(uid, aquariumId, feedQueue);
    if (conflict) store.writePending(uid, aquariumId, state, conflict.baseRevision ?? baseRevision);
    else if (isDirty()) store.writePending(uid, aquariumId, state, baseRevision);
    else store.clearPending(uid, aquariumId);
    return true;
  }

  // ------------------------------------------------------------------ 进食记账
  function loadFeeds() {
    const uid = userId();
    feedQueue = uid && aquariumId ? store.readFeeds(uid, aquariumId) : [];
  }

  function persistFeeds() {
    const uid = userId();
    if (!uid || !aquariumId) return;
    return store.writeFeeds(uid, aquariumId, feedQueue);
  }

  function clearFeedTimer() {
    if (feedTimer !== null) { clearTimeoutFn(feedTimer); feedTimer = null; }
  }

  function scheduleFeeds() {
    clearFeedTimer();
    const gen = generation;
    feedTimer = setTimeoutFn(() => { feedTimer = null; return syncNow({ reason: 'feeding', gen }); }, debounceMs);
  }

  /**
   * 鱼真的吃到一口时调用（不是点击喂食按钮的次数）。
   * 已登录时：本机只入队并落盘，成长与 meals 由服务端结算（客户端不重复加，避免双记）。
   * 游客时：调用方直接用 model.eat。
   */
  function queueFeed(fishId, bites = 1) {
    if (disposed) return { ok: false, skipped: 'disposed' };
    if (mode !== 'cloud' || !aquariumId) return { ok: false, skipped: 'guest' };
    if (conflict) return { ok: false, skipped: 'conflict' };
    if (feedQueue.length >= 200) {
      notify('待同步的进食记录已满，请联网同步后再继续喂食。');
      return { ok: false, skipped: 'queue_full' };
    }
    const op = (globalThis.crypto && typeof globalThis.crypto.randomUUID === 'function')
      ? globalThis.crypto.randomUUID()
      : `op-${now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    feedQueue.push({ op, fishId: String(fishId).slice(0, 100), bites: Math.max(1, Math.min(8, Math.floor(bites) || 1)), at: now() });
    persistFeeds();
    if (!isOnline()) {
      setStatus(STATUS.OFFLINE);
      return { ok: true, queued: true, offline: true, pending: feedQueue.length };
    }
    scheduleFeeds();
    setStatus(STATUS.SYNCING);
    return { ok: true, queued: true, pending: feedQueue.length };
  }

  /** 把未提交的进食事件按顺序提交；服务端按 operation_id 去重，重试安全。 */
  function pushFeeds(gen = generation) {
    if (stale(gen)) return Promise.resolve({ ok: false, skipped: 'stale' });
    if (!feedQueue.length) return Promise.resolve({ ok: true, sent: 0 });
    if (pushingFeeds) return pushingFeeds;
    if (!aquariumId || !isOnline()) {
      setStatus(STATUS.OFFLINE);
      return Promise.resolve({ ok: false, skipped: 'offline' });
    }
    const aquariumAtRequest = aquariumId;
    const operation = Promise.resolve().then(async () => {
      let sent = 0;
      while (feedQueue.length) {
        if (stale(gen)) return { ok: false, skipped: 'stale' };
        if (!isOnline()) { setStatus(STATUS.OFFLINE); return { ok: false, skipped: 'offline' }; }
        const item = feedQueue[0];
        const res = await api.recordFeeding(aquariumAtRequest, item.op, item.fishId, item.bites);
        if (stale(gen)) return { ok: false, skipped: 'stale' };
        if (res.ok) {
          feedQueue = feedQueue.filter(f => f.op !== item.op);
          persistFeeds(); // Commit each acknowledgement, not just the last batch.
          sent++;
          continue;
        }
        const result = res.result || {};
        if (result.kind === 'unauthenticated' || result.kind === 'forbidden') {
          setStatus(STATUS.SIGNED_OUT, result.message || '');
          return { ok: false, result };
        }
        if (['invalid_argument', 'invalid_state'].includes(result.kind) ||
            (result.kind === 'not_found' && !getState().fish.some(f => f.id === item.fishId))) {
          feedQueue = feedQueue.filter(f => f.op !== item.op);
          persistFeeds();
          notify(result.message || '有一条进食记录无法确认，已跳过。');
          continue;
        }
        persistFeeds();
        setStatus(isOnline() ? STATUS.ERROR : STATUS.OFFLINE, result.message || '');
        return { ok: false, result, retryable: true };
      }
      return { ok: true, sent };
    }).finally(() => {
      if (pushingFeeds === operation) pushingFeeds = null;
    });
    pushingFeeds = operation;
    return operation;
  }

  async function setSession(nextSession) {
    if (disposed) return { ok: false, skipped: 'disposed' };
    generation += 1;                        // 旧会话的在途响应全部作废
    const gen = generation;
    hydrationCounts.clear();
    hydrationPromises.clear();
    clearSaveTimer();
    clearFeedTimer();
    feedQueue = [];
    pushingFeeds = null;
    inFlight = null; queued = false; conflict = null;
    settleToken += 1; settling = false; settlePromise = null;
    session = nextSession && nextSession.user && nextSession.user.id ? nextSession : null;

    if (!session) {
      mode = 'guest';
      aquariumId = null; baseRevision = null; baseCanonical = null; lastGrowthAt = null;
      setStatus(configured ? STATUS.GUEST : STATUS.CLOUD_OFF);
      return { ok: true, mode: 'guest' };
    }

    mode = 'cloud';
    // Do not let a previous account's aquarium pointer survive while this
    // account is being hydrated, including when the request fails offline.
    aquariumId = null; baseRevision = null; baseCanonical = null; lastGrowthAt = null;
    return hydrate({ gen });
  }

  /**
   * 登录 / 刷新页面后的对账：
   *   1) 幂等开缸（顺便取回云端现有存档与 revision）
   *   2) 判断本机各份副本与云端的关系：能安全上传就上传，云端被人改过就交给用户选择
   *   3) 只有在本机与云端一致之后，才结算服务端成长并采用云端状态
   */
  function hydrate(options = {}) {
    const gen = options.gen ?? generation;
    const existing = hydrationPromises.get(gen);
    if (existing && !options.force) return existing;
    hydrationCounts.set(gen, (hydrationCounts.get(gen) || 0) + 1);
    const operation = Promise.resolve()
      .then(() => hydrateInternal(options))
      .finally(() => {
        const remaining = (hydrationCounts.get(gen) || 0) - 1;
        if (remaining > 0) hydrationCounts.set(gen, remaining);
        else hydrationCounts.delete(gen);
        if (hydrationPromises.get(gen) === operation) hydrationPromises.delete(gen);
        if (!disposed && gen === generation) setStatus(status);
      });
    if (!existing) hydrationPromises.set(gen, operation);
    return operation;
  }

  async function hydrateInternal({ gen = generation } = {}) {
    const uid = userId();
    if (!uid) return { ok: false, skipped: 'no_session' };
    setStatus(STATUS.SYNCING);

    const pointer = store.readCurrent(uid);
    const cachedState = pointer?.aquariumId ? store.readAccountState(uid, pointer.aquariumId) : null;
    const pending = pointer?.aquariumId ? store.readPending(uid, pointer.aquariumId) : null;
    const pendingState = pending?.state || null;
    const guestState = store.hasGuest() ? store.readGuest() : null;

    // 候选存档：未同步修改 > 上次同步缓存 > 登录前的本机（游客）存档 > 当前内存
    const candidate = pendingState || cachedState || guestState || getState();

    const ensured = await api.ensureAquarium(candidate, STATE_VERSION);
    if (stale(gen)) return { ok: false, skipped: 'stale' };
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
      // 离线/服务端故障：用本机可用副本继续游玩，并把「有未同步内容」如实反映出来。
      const fallback = validate(pendingState || cachedState || guestState || getState());
      setState(fallback);
      aquariumId = pointer?.aquariumId || null;
      // Pending has its own baseline, which can be unknown. A cached state was
      // last saved at the pointer revision. Guest/current fallbacks have no
      // account baseline, so keep that unknown rather than inventing one.
      baseRevision = pendingState
        ? pending.baseRevision
        : cachedState
          ? pointer?.revision ?? null
          : null;
      lastGrowthAt = pointer?.lastGrowthAt || null;
      baseCanonical = null;                 // 基线未知 → 下次联网必须重新对账
      if (uid && aquariumId) {
        store.writeCurrent(uid, { aquariumId, revision: baseRevision, lastGrowthAt });
        store.writePending(uid, aquariumId, fallback, baseRevision);
      }
      loadFeeds();
      setStatus(isOnline() ? STATUS.ERROR : STATUS.OFFLINE, result.message || '');
      return { ok: false, result, offline: true };
    }

    aquariumId = ensured.result.aquariumId;
    baseRevision = ensured.result.revision;
    lastGrowthAt = ensured.result.lastGrowthAt || null;
    store.writeCurrent(uid, { aquariumId, revision: baseRevision, lastGrowthAt });
    loadFeeds();

    const cloudParsed = validate(ensured.result.state);
    const cloudRevision = ensured.result.revision;

    if (ensured.result.created === true) {
      // 云端刚刚用本机候选存档开缸：只有一份存档，不存在「两份需要选择」的情形。
      adopt(cloudParsed, cloudRevision);
      if (guestState && canonicalState(guestState) !== canonicalState(cloudParsed)) {
        notify('本机鱼缸已上传到云端，之后换设备登录就能接着养。');
      }
      const settled = await finishHydration({ gen, reason: 'created' });
      return { ...settled, created: true };
    }

    if (pendingState) {
      const sameBase = pending.baseRevision != null && Number(pending.baseRevision) === Number(cloudRevision);
      if (sameBase) {
        // 云端没被别人改过：把本机未同步改动补上去（仍以基线 revision 做条件写入）。
        setState(validate(pendingState));
        baseCanonical = canonicalState(cloudParsed);   // 与 pending 不同 → isDirty() 为真
        const uploaded = await flush({ reason: 'pending-upload', gen });
        if (stale(gen)) return { ok: false, skipped: 'stale' };
        if (!uploaded.ok) return uploaded;             // 冲突/离线等已在 flush 内处理
        return finishHydration({ gen, reason: 'pending-upload' });
      }
      return raiseConflict({
        reason: CONFLICT_REASON.PENDING,
        cloudState: cloudParsed,
        cloudRevision,
        localState: pendingState,
        message: '本机有还没同步的修改，云端也被改过（不是同一个版本）。请选择保留哪一份。'
      });
    }

    if (guestState && canonicalState(guestState) !== canonicalState(cloudParsed)) {
      return raiseConflict({
        reason: CONFLICT_REASON.GUEST_IMPORT,
        cloudState: cloudParsed,
        cloudRevision,
        localState: guestState,
        message: '这台设备上有一份旧的本地鱼缸，云端账号里也有一份存档。请选择保留哪一份。'
      });
    }

    adopt(cloudParsed, cloudRevision);
    return finishHydration({ gen, reason: 'hydrate' });
  }

  async function finishHydration({ gen, reason }) {
    if (feedQueue.length) {
      const pushed = await pushFeeds(gen);
      if (stale(gen)) return { ok: false, skipped: 'stale' };
      if (!pushed.ok) return pushed;
    }
    return settleAndAdopt({ gen, reason });
  }

  /**
   * 结算服务端成长并采用云端状态。
   * 前提：本机没有未同步改动（否则先写入，见 syncNow 的顺序说明）。
   * 测试用大额推进服务端时间即可验证「重复调用不重复奖励」。
   */
  function settleAndAdopt({ gen = generation, reason = 'sync' } = {}) {
    if (!aquariumId) return { ok: false, skipped: 'no_aquarium' };
    if (settling) return settlePromise || { ok: true, skipped: 'settling', reason };
    if (isDirty()) return { ok: true, skipped: 'dirty', reason };
    if (!isOnline()) { setStatus(STATUS.OFFLINE); return { ok: false, skipped: 'offline' }; }

    const aquariumAtRequest = aquariumId;
    const revisionAtRequest = baseRevision;
    const stateAtRequest = cloneState(getState());
    const canonicalAtRequest = canonicalState(stateAtRequest);
    const token = ++settleToken;
    settling = true;
    const operation = Promise.resolve().then(async () => {
      try {
        const settled = await api.settleGrowth(aquariumAtRequest);
        if (stale(gen)) return { ok: false, skipped: 'stale' };
        if (!settled.ok) {
          const result = settled.result || {};
          if (result.kind === 'unauthenticated' || result.kind === 'forbidden') {
            setStatus(STATUS.SIGNED_OUT, result.message || '');
            return { ok: false, result };
          }
          if (result.kind === 'not_found') {
            // 云端那条鱼缸不在了（例如被删除）：先释放结算锁再重新对账。
            if (settleToken === token) {
              settling = false;
              settlePromise = null;
            }
            return hydrate({ gen, force: true });
          }
          if (result.retryable) {
            setStatus(isOnline() ? STATUS.ERROR : STATUS.OFFLINE, result.message || '');
            return { ok: false, result, offline: true };
          }
          setStatus(STATUS.ERROR, result.message || '');
          return { ok: false, result };
        }

        if (aquariumId !== aquariumAtRequest || baseRevision !== revisionAtRequest) {
          return { ok: false, skipped: 'baseline_changed' };
        }

        const current = getState();
        if (canonicalState(current) !== canonicalAtRequest || isDirty()) {
          // The server may have credited growth and advanced its revision.
          // Keep the newer local state and make the difference explicit instead
          // of adopting the stale response or using its revision as our baseline.
          return raiseConflict({
            reason: CONFLICT_REASON.PENDING,
            cloudState: validate(settled.result.state),
            cloudRevision: settled.result.revision,
            localState: validate(current),
            message: '成长结算期间本机也有修改，云端版本已更新。本机修改已保留，请选择如何处理。'
          });
        }

        adopt(validate(settled.result.state), settled.result.revision);
        lastGrowthAt = settled.result.lastGrowthAt || lastGrowthAt;
        const uid = userId();
        if (uid && aquariumId) store.writeCurrent(uid, { aquariumId, revision: baseRevision, lastGrowthAt });
        setStatus(feedQueue.length ? STATUS.SYNCING : STATUS.SYNCED);
        return { ok: true, creditedSeconds: settled.result.creditedSeconds || 0, revision: baseRevision, reason };
      } finally {
        if (settleToken === token) {
          settling = false;
          settlePromise = null;
          // A feed debounce may have elapsed while it was waiting for this
          // settlement. Keep those events visible and schedule their next pass.
          if (feedQueue.length && feedTimer === null && gen === generation && !disposed && !conflict) scheduleFeeds();
          if (queued && gen === generation) {
            queued = false;
            if (!disposed && !conflict && isDirty()) {
              persistLocal();
              scheduleSave();
            }
          }
          if (!disposed) setStatus(status);
        }
      }
    });
    settlePromise = operation;
    setStatus(STATUS.SYNCING);
    return operation;
  }

  function raiseConflict({ reason, cloudState, cloudRevision, localState, message }) {
    clearSaveTimer();
    // 关键：未同步副本连同「它基于哪个 revision」一起存下来，恢复对账时才能判断云端是否被改过。
    const base = conflict?.baseRevision ?? baseRevision;
    conflict = { reason, cloudState, cloudRevision, localState: validate(localState), baseRevision: base, message };
    const uid = userId();
    if (uid && aquariumId) store.writePending(uid, aquariumId, localState, base);
    // 冲突期间水面上显示「本机那一份」：用户最后看到的就是它，
    // 采用云端是用户显式选择之后才会发生的事（否则就成了先斩后奏的静默覆盖）。
    setState(validate(localState));
    setStatus(STATUS.CONFLICT, message);
    return { ok: false, conflict: snapshot().conflict, mode: 'cloud' };
  }

  /** 供界面在用户做出选择后读取本地/云端两份内容。 */
  function conflictDetail() {
    if (!conflict) return null;
    return {
      reason: conflict.reason,
      cloudRevision: conflict.cloudRevision,
      baseRevision: conflict.baseRevision ?? null,
      // 保存时冲突（revision 不匹配）只知道云端 revision，还没有取回云端内容，
      // 界面必须能处理 cloudKnown=false，不能假定一定有两份可比较的存档。
      cloudKnown: Boolean(conflict.cloudState),
      localFish: fishSummary(conflict.localState),
      cloudFish: fishSummary(conflict.cloudState),
      localDecor: conflict.localState?.decor || [],
      cloudDecor: conflict.cloudState?.decor || []
    };
  }

  /**
   * 变更通知：只做「是否真的变了」与去抖，不建立固定轮询。
   */
  function markDirty() {
    if (disposed || mode !== 'cloud' || !aquariumId) return false;
    const canonical = canonicalState(getState());
    if (conflict) {
      conflict.localState = validate(getState());
      persistLocal();
      setStatus(STATUS.CONFLICT);
      return true;
    }
    if (baseCanonical !== null && canonical === baseCanonical) {
      const wasWaiting = timer !== null;
      clearSaveTimer();          // 撤销尚未发出的无意义写入
      if (wasWaiting && !inFlight && !settling && !feedQueue.length) setStatus(STATUS.SYNCED);
      return false;
    }
    if (!isOnline()) {
      clearSaveTimer();
      persistLocal();
      setStatus(STATUS.OFFLINE);
      return true;
    }
    scheduleSave();
    setStatus(STATUS.SYNCING);
    return true;
  }

  /** 立即写入（用于「立即同步」按钮、切后台、断线重连、页面关闭）。 */
  async function flush({ reason = 'manual', keepalive = false, gen = generation } = {}) {
    clearSaveTimer();
    if (disposed) return { ok: false, skipped: 'disposed' };
    if (mode !== 'cloud') return { ok: true, skipped: 'guest' };
    if (!aquariumId) return { ok: false, skipped: 'no_aquarium' };
    if (conflict) return { ok: false, skipped: 'conflict' };
    if (settling) { queued = true; return { ok: true, skipped: 'settling' }; }
    if (inFlight) { queued = true; return inFlight; }

    const state = cloneState(getState());
    const canonical = canonicalState(state);
    if (baseCanonical !== null && canonical === baseCanonical) return { ok: true, skipped: 'unchanged' };

    const expected = baseRevision;
    if (expected == null || !Number.isFinite(Number(expected))) {
      // 基线未知（首次对账还没成功）：不能盲目写，先对账拿到 revision。
      return hydrate({ gen });
    }

    setStatus(STATUS.SYNCING);
    const request = (async () => {
      const uid = userId();
      const res = await api.saveAquarium({
        aquariumId,
        expectedRevision: expected,      // 永远用本机基线，不用「刚拿到的新 revision」
        state: cloneState(state),
        stateVersion: STATE_VERSION,
        keepalive
      });

      // 换号/退出之后到达的响应：一律丢弃，绝不写进当前账号的界面与缓存。
      //
      // 这里刻意不把这次写入记成 pending：请求很可能已经在服务端成功（revision 已经前进），
      // 若在旧账号名下留一份 pending，下次登录会因为基线过期而报出一次假冲突。
      // 数据本身不会丢——服务端已经保存，下次登录对账时会取回。
      if (stale(gen)) return { ok: false, skipped: 'stale' };

      if (res.ok) {
        markSynced(state, res.result.revision);
        if (isDirty()) {
          scheduleSave();
          setStatus(STATUS.SYNCING);
        } else {
          setStatus(feedQueue.length ? STATUS.SYNCING : STATUS.SYNCED);
        }
        return { ok: true, revision: baseRevision, reason };
      }

      const result = res.result || {};
      // The request may have failed after the user made another edit. Preserve
      // the current local copy and its current dirty state, never the older
      // request snapshot captured above.
      const keepPending = () => { persistLocal(); };

      if (result.kind === 'conflict') {
        raiseConflict({
          reason: CONFLICT_REASON.SAVE,
          cloudState: null,
          cloudRevision: result.revision,
          localState: cloneState(getState()),
          message: '云端存档已经被其它设备改过（版本不一致）。本机的改动已保留，请选择如何处理。'
        });
        return { ok: false, result, reason };
      }
      if (result.kind === 'unauthenticated' || result.kind === 'forbidden') {
        keepPending();
        setStatus(STATUS.SIGNED_OUT, result.message || '');
        return { ok: false, result, reason };
      }
      if (result.kind === 'invalid_state' || result.kind === 'invalid_argument') {
        // 云端认为存档不合法：不重试、不覆盖，保留本机副本并明确报错。
        keepPending();
        setStatus(STATUS.ERROR, result.message || '');
        return { ok: false, result, reason };
      }
      // 可重试（离线、5xx、超时、暂时拿不到令牌）：保留未同步副本，联网后再写。
      keepPending();
      setStatus(result.kind === 'offline' || !isOnline() ? STATUS.OFFLINE : STATUS.ERROR, result.message || '网络不可达');
      return { ok: false, result, reason };
    })();
    inFlight = request;

    try {
      return await request;
    } finally {
      // A previous account's response must not clear a newer account's save
      // pointer or consume its queued write.
      if (inFlight === request) {
        inFlight = null;
        if (queued && !disposed && !conflict && gen === generation) { queued = false; scheduleSave(); }
        if (!disposed) setStatus(status);
      }
    }
  }

  /**
   * 处理冲突。choice:
   *  - 'cloud'：采用云端存档；本机未同步的那一份先归档为本机备份（可导出），不会静默消失。
   *  - 'local'：用本机存档覆盖云端；先把云端当前版本归档为备份，再以它的 revision 做条件写入。
   *  - 'later'：保持现状，稍后决定。
   */
  async function resolveConflict(choice, { gen = generation } = {}) {
    if (!conflict) return { ok: true, skipped: 'no_conflict' };
    const uid = userId();

    if (choice === 'later') {
      conflict.localState = validate(getState());
      persistLocal();
      return { ok: true, skipped: 'later' };
    }

    if (choice === 'cloud') {
      const candidate = validate(getState());
      const ensured = await api.ensureAquarium(candidate, STATE_VERSION);
      if (stale(gen)) return { ok: false, skipped: 'stale' };
      if (!ensured.ok) {
        setStatus(ensured.result?.retryable === false ? STATUS.ERROR : (isOnline() ? STATUS.ERROR : STATUS.OFFLINE), ensured.result?.message || '');
        return { ok: false, result: ensured.result };
      }
      // The user can continue editing while ensureAquarium is in flight. Back
      // up the live state at resolution time so choosing cloud never erases
      // edits made after the conflict was first shown.
      const latestLocal = validate(getState());
      if (uid && aquariumId) store.writeBackup(uid, aquariumId, latestLocal);
      aquariumId = ensured.result.aquariumId;
      conflict = null;
      const parsed = adopt(validate(ensured.result.state), ensured.result.revision);
      const settled = await settleAndAdopt({ gen, reason: 'conflict-cloud' });
      return { ok: true, resolution: 'cloud', state: parsed, settled };
    }

    if (choice === 'local') {
      // 用本机覆盖云端之前：先取回云端最新状态。
      // 一是拿到最新 revision 做条件写入（避免再次冲突），二是把将被覆盖的云端版本归档为备份。
      const candidate = validate(getState());
      const current = await api.ensureAquarium(candidate, STATE_VERSION);
      if (stale(gen)) return { ok: false, skipped: 'stale' };
      if (!current.ok) {
        const result = current.result || {};
        if (result.kind === 'unauthenticated' || result.kind === 'forbidden') {
          setStatus(STATUS.SIGNED_OUT, result.message || '');
        } else {
          setStatus(result.kind === 'offline' || !isOnline() ? STATUS.OFFLINE : STATUS.ERROR, result.message || '');
        }
        return { ok: false, result };
      }

      const latestLocal = validate(getState());
      if (uid) store.writeBackup(uid, current.result.aquariumId, current.result.state);
      aquariumId = current.result.aquariumId;
      const targetRevision = current.result.revision;
      conflict = null;
      if (Number.isFinite(Number(targetRevision))) baseRevision = Number(targetRevision);
      const local = latestLocal;
      setState(local);
      baseCanonical = null;                 // 强制走一次真实写入
      if (uid && aquariumId) store.writePending(uid, aquariumId, local, baseRevision);
      const res = await flush({ reason: 'conflict-resolution', gen });
      if (!res.ok) return { ok: false, result: res.result };
      const settled = await settleAndAdopt({ gen, reason: 'conflict-local' });
      return { ok: true, resolution: 'local', settled };
    }

    return { ok: false, error: { code: 'unknown_choice', message: '未知的处理方式' } };
  }

  /**
   * 手动/自动重新对账（「立即同步」按钮、切回前台、断线重连）。
   *
   * 顺序很关键（评审 P1-1）：先上传本机改动，再结算成长。
   * 早期实现先结算、把结算返回的最新 revision 当成写入基线，于是「另一台设备已经提交的改名」
   * 会被本机的旧快照覆盖，而且界面还显示「已同步」。
   */
  async function syncNow({ reason = 'manual', gen = generation } = {}) {
    if (stale(gen)) return { ok: false, skipped: 'stale' };
    if (mode !== 'cloud') return { ok: true, skipped: 'guest' };
    if (conflict) return { ok: false, skipped: 'conflict' };
    if (settling) {
      const res = await settlePromise;
      if (stale(gen)) return { ok: false, skipped: 'stale' };
      return res;
    }
    const hydration = hydrationPromises.get(gen);
    if (hydration) return hydration;
    if (!aquariumId || baseRevision === null || baseCanonical === null) return hydrate({ gen });

    if (inFlight) {
      const res = await inFlight;
      if (stale(gen)) return { ok: false, skipped: 'stale' };
      if (!res.ok) return res;
    }

    // First persist new fish/edits against the known revision. Feeding an unsaved
    // fish otherwise returns not_found and blocks its entire queue.
    if (isDirty()) {
      const res = await flush({ reason, gen });
      if (stale(gen)) return { ok: false, skipped: 'stale' };
      if (!res.ok) return res;
    }
    if (feedQueue.length) {
      const pushed = await pushFeeds(gen);
      if (stale(gen)) return { ok: false, skipped: 'stale' };
      if (!pushed.ok) return pushed;
    }
    // Editing while feed acknowledgements arrive must also be saved before settle.
    if (isDirty()) {
      const res = await flush({ reason, gen });
      if (stale(gen)) return { ok: false, skipped: 'stale' };
      if (!res.ok) return res;
    }
    return settleAndAdopt({ gen, reason });
  }

  function handleOffline() {
    if (mode !== 'cloud') return;
    persistLocal();                          // 断网瞬间先把本机改动连同基线落盘
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
    generation += 1;
    settleToken += 1; settling = false; settlePromise = null;
    clearSaveTimer();
    clearFeedTimer();
  }

  return {
    get mode() { return mode; },
    get status() { return status; },
    get snapshot() { return snapshot(); },
    get isCloud() { return mode === 'cloud'; },
    get isDirty() { return isDirty(); },
    get baseRevision() { return baseRevision; },
    get generation() { return generation; },
    get conflictDetailValue() { return conflictDetail(); },
    get pendingSaveScheduled() { return timer !== null; },
    get pendingFeeds() { return feedQueue.length; },
    setSession,
    hydrate,
    markDirty,
    persistLocal,
    flush,
    syncNow,
    queueFeed,
    pushFeeds,
    resolveConflict,
    conflictDetail,
    handleOnline,
    handleOffline,
    dispose
  };
}
