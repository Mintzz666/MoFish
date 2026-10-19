import test from 'node:test';
import assert from 'node:assert/strict';
import { initial, cloneState, validate } from '../web/model.js';
import { applySharedOperations } from '../web/cloud/shared-operations.js';
import { createSharedSyncEngine } from '../web/cloud/shared-sync.js';
import { STATUS } from '../web/cloud/sync.js';
import { createLocalStore } from '../web/storage.js';
import { createMemoryStorage } from './helpers/memory-storage.mjs';

const clone = (value) => JSON.parse(JSON.stringify(value));

function makeState() {
  const state = initial();
  assert.equal(state.version, 2, '测试状态必须来自 model.initial() 的 v2 输出');
  return cloneState(state);
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

async function flushMicrotasks() {
  for (let i = 0; i < 8; i += 1) await Promise.resolve();
}

async function waitFor(predicate, message) {
  for (let i = 0; i < 40; i += 1) {
    if (predicate()) return;
    await Promise.resolve();
  }
  assert.fail(message);
}

function createTimers() {
  let next = 0;
  const pending = new Map();
  return {
    set(fn, delay) {
      const handle = { id: ++next, fn, delay };
      pending.set(handle, fn);
      return handle;
    },
    clear(handle) { pending.delete(handle); },
    get pendingCount() { return pending.size; },
    runNext() {
      const entry = pending.entries().next().value;
      if (!entry) return false;
      const [handle, fn] = entry;
      pending.delete(handle);
      fn();
      return true;
    }
  };
}

function createFakeApi() {
  const rooms = new Map();
  const calls = { probe: [], get: [], apply: [], feed: [], settle: [], subscribe: [], stopRealtime: 0 };
  const subscriptions = new Set();
  const subscriptionHistory = [];
  const operations = new Map();
  const commits = [];
  let applyHook = null;
  let probeHook = null;

  function roomData(roomId) {
    const room = rooms.get(roomId);
    return {
      state_json: cloneState(room.state),
      revision: room.revision,
      role: room.role
    };
  }

  function addRoom(roomId, state = makeState(), { revision = 1, role = 'owner' } = {}) {
    rooms.set(roomId, { state: validate(state), revision, role });
    return roomData(roomId);
  }

  function commitApply(roomId, operationId, ops) {
    const key = `${roomId}:${operationId}`;
    const payload = JSON.stringify(ops);
    const previous = operations.get(key);
    if (previous) {
      if (previous.payload !== payload) return { ok: false, code: 'operation_mismatch' };
      return { ok: true, data: roomData(roomId), duplicate: true };
    }
    const room = rooms.get(roomId);
    const result = applySharedOperations(room.state, ops);
    if (!result.ok) return { ok: false, code: 'conflict' };
    room.state = cloneState(result.state);
    room.revision += 1;
    operations.set(key, { payload });
    commits.push({ roomId, operationId, ops: clone(ops) });
    return { ok: true, data: roomData(roomId), duplicate: false };
  }

  const api = {
    rooms,
    calls,
    commits,
    subscriptions,
    subscriptionHistory,
    addRoom,
    commitApply,
    setApplyHook(hook) { applyHook = hook; },
    setProbeHook(hook) { probeHook = hook; },
    mutate(roomId, mutate) {
      const room = rooms.get(roomId);
      mutate(room.state);
      room.revision += 1;
    },
    async probe(roomId) {
      calls.probe.push(roomId);
      if (probeHook) return probeHook(roomId);
      const room = rooms.get(roomId);
      return { ok: true, data: { role: room.role, revision: room.revision } };
    },
    async get(roomId) {
      calls.get.push(roomId);
      return { ok: true, data: roomData(roomId) };
    },
    async apply(roomId, operationId, ops) {
      const call = { roomId, operationId, ops: clone(ops) };
      calls.apply.push(call);
      const commit = () => commitApply(roomId, operationId, ops);
      return applyHook ? applyHook({ ...call, commit }) : commit();
    },
    async feed(roomId, operationId, fishId, bites) {
      calls.feed.push({ roomId, operationId, fishId, bites });
      return { ok: true, data: { status: 'ok', duplicate: false } };
    },
    async settle(roomId) {
      calls.settle.push(roomId);
      return { ok: true, data: { status: 'ok', revision: rooms.get(roomId).revision } };
    },
    async subscribe(roomId, onChange, onStatus) {
      const subscription = { roomId, onChange, onStatus };
      subscriptions.add(subscription);
      subscriptionHistory.push(subscription);
      return () => subscriptions.delete(subscription);
    },
    async stopRealtime() {
      calls.stopRealtime += 1;
      subscriptions.clear();
    },
    emitOldestChange() {
      subscriptionHistory[0]?.onChange();
    },
    emitOldestStatus(status = 'CHANNEL_ERROR') {
      subscriptionHistory[0]?.onStatus(status);
    }
  };
  return api;
}

function createClient({
  api,
  userId,
  roomId,
  state = makeState(),
  online = () => true,
  store = undefined,
  storage = createMemoryStorage()
}) {
  const timers = createTimers();
  const localStore = store || createLocalStore(storage);
  let currentState = cloneState(state);
  const statuses = [];
  const notices = [];
  let revoked = 0;
  const engine = createSharedSyncEngine({
    api,
    store: localStore,
    getState: () => currentState,
    setState: (next) => { currentState = cloneState(next); },
    onStatus: (status) => statuses.push(status),
    onNotice: (notice) => notices.push(notice),
    onRevoked: () => { revoked += 1; },
    isOnline: online,
    setTimeoutFn: timers.set,
    clearTimeoutFn: timers.clear,
    pollMs: 60000
  });
  return {
    engine,
    store: localStore,
    storage,
    timers,
    statuses,
    notices,
    get state() { return currentState; },
    set state(next) { currentState = cloneState(next); },
    get revoked() { return revoked; },
    start() { return engine.start({ user: { id: userId } }, roomId); }
  };
}

const updateDecor = (before, patch) => ({
  kind: 'decor_update',
  id: before.id,
  before: clone(before),
  decor: { ...clone(before), ...patch }
});

test('backend readiness refetches an update missed during channel initialization', async () => {
  const api=createFakeApi();api.addRoom('ready-room');
  const client=createClient({api,userId:'ready-user',roomId:'ready-room'});await client.start();
  api.mutate('ready-room',state=>{state.fish[0].name='初始化期间的改名';});
  api.emitOldestStatus('READY');
  await waitFor(()=>client.state.fish[0].name==='初始化期间的改名','READY must recover the missed revision');
  assert.equal(client.revoked,0);
});

test('a removed fish does not poison queued feeding or revoke room access', async () => {
  const api=createFakeApi();api.addRoom('feed-room');
  const client=createClient({api,userId:'feed-user',roomId:'feed-room'});await client.start();
  const removed=client.state.fish[0].id;client.engine.queueFeed(removed);
  api.mutate('feed-room',state=>{state.fish=state.fish.filter(fish=>fish.id!==removed);});
  api.feed=async()=>({ok:false,code:'not_found'});
  assert.equal((await client.engine.syncNow()).ok,true);
  assert.equal(client.engine.pendingFeeds,0);
  assert.equal(client.revoked,0);
  assert.equal(client.state.fish.some(fish=>fish.id===removed),false);
  assert.match(client.notices.at(-1),/已移走/);
});

test('first C open preserves an unsent B snapshot and reuses its feeding operation IDs', async () => {
  const api=createFakeApi();api.addRoom('upgrade-room');
  const client=createClient({api,userId:'upgrade-user',roomId:'upgrade-room'});
  const legacy=makeState();legacy.fish[0].name='旧版还没上传';
  client.store.writePending('upgrade-user','upgrade-room',legacy,1);
  client.store.writeFeeds('upgrade-user','upgrade-room',[{op:'existing-feed-id',fishId:legacy.fish[0].id,bites:1}]);
  assert.equal((await client.start()).ok,true);
  assert.equal(client.store.listBackups('upgrade-user','upgrade-room').at(-1).state.fish[0].name,'旧版还没上传');
  assert.equal(api.calls.feed[0].operationId,'existing-feed-id');
  assert.equal(api.calls.apply.length,0,'an old whole snapshot must not be uploaded as collaborative operations');
  assert.match(client.notices[0],/旧版未上传副本/);
});

test('offline edits persist and replay from the local queue after an engine restart', async () => {
  const userId = 'offline-user';
  const roomId = 'offline-room';
  const api = createFakeApi();
  const serverState = makeState();
  api.addRoom(roomId, serverState);
  const storage = createMemoryStorage();
  let connected = false;
  const first = createClient({ api, userId, roomId, state: makeState(), storage, online: () => connected });
  assert.equal((await first.start()).ok, true);

  first.state.fish[0].name = '离线改名';
  assert.equal(first.engine.markDirty(), true);
  const cached = first.store.readMeta(userId, roomId);
  assert.equal(cached.kind, 'shared-v1');
  assert.equal(cached.queue.length, 1);
  const pendingId = cached.queue[0].id;
  assert.equal(first.store.readAccountState(userId, roomId).fish[0].name, '离线改名');
  await first.engine.stop();

  connected = true;
  const restarted = createClient({ api, userId, roomId, state: makeState(), storage, online: () => connected });
  assert.equal((await restarted.start()).ok, true);
  assert.equal(api.calls.apply.length, 1);
  assert.equal(api.calls.apply[0].operationId, pendingId);
  assert.equal(api.rooms.get(roomId).state.fish[0].name, '离线改名');
  assert.equal(restarted.state.fish[0].name, '离线改名');
  assert.equal(restarted.engine.isDirty, false);
});

test('a committed operation whose response is lost retries with the same ID and commits once', async () => {
  const userId = 'retry-user';
  const roomId = 'retry-room';
  const api = createFakeApi();
  api.addRoom(roomId);
  const client = createClient({ api, userId, roomId });
  await client.start();
  client.state.fish[0].name = '提交后丢响应';
  client.engine.markDirty();

  let first = true;
  api.setApplyHook(({ commit }) => {
    const result = commit();
    if (first) {
      first = false;
      return { ok: false, code: 'network_error', error: 'response lost after commit' };
    }
    return result;
  });
  const failed = await client.engine.syncNow();
  assert.equal(failed.ok, false);
  const queuedId = client.store.readMeta(userId, roomId).queue[0].id;
  assert.equal(api.rooms.get(roomId).state.fish[0].name, '提交后丢响应');
  assert.equal(api.commits.length, 1);

  api.setApplyHook(null);
  const retried = await client.engine.syncNow();
  assert.equal(retried.ok, true);
  assert.equal(api.calls.apply.length, 2);
  assert.equal(api.calls.apply[0].operationId, queuedId);
  assert.equal(api.calls.apply[1].operationId, queuedId);
  assert.equal(api.commits.length, 1, '同一 operation_id 只在服务端应用一次');
  assert.equal(client.engine.isDirty, false);
});

test('a remote change to another decor remains when local queued decor work is submitted', async () => {
  const userId = 'merge-user';
  const roomId = 'merge-room';
  const api = createFakeApi();
  const base = makeState();
  api.addRoom(roomId, base);
  const client = createClient({ api, userId, roomId, state: base });
  await client.start();
  const [localDecor, remoteDecor] = clone(client.state.decor);

  client.state.decor.find((item) => item.id === localDecor.id).x = 0.73;
  assert.equal(client.engine.markDirty(), true);
  api.mutate(roomId, (remote) => {
    remote.decor.find((item) => item.id === remoteDecor.id).z = 0.84;
  });

  const result = await client.engine.syncNow();
  assert.equal(result.ok, true);
  const merged = api.rooms.get(roomId).state.decor;
  assert.equal(merged.find((item) => item.id === localDecor.id).x, 0.73);
  assert.equal(merged.find((item) => item.id === remoteDecor.id).z, 0.84);
  assert.equal(client.state.decor.find((item) => item.id === remoteDecor.id).z, 0.84);
});

async function enterSameDecorConflict(client, api, roomId) {
  const decor = clone(client.state.decor[0]);
  client.state.decor.find((item) => item.id === decor.id).x = 0.67;
  client.engine.markDirty();
  api.mutate(roomId, (remote) => {
    remote.decor.find((item) => item.id === decor.id).x = 0.83;
  });
  const result = await client.engine.syncNow();
  assert.equal(result.code, 'conflict');
  assert.equal(client.engine.snapshot.status, STATUS.CONFLICT);
  assert.equal(client.state.decor.find((item) => item.id === decor.id).x, 0.67);
  return decor;
}

test('same-object conflict keeps the local version available when the user chooses cloud', async () => {
  const userId = 'cloud-choice-user';
  const roomId = 'cloud-choice-room';
  const api = createFakeApi();
  api.addRoom(roomId);
  const client = createClient({ api, userId, roomId });
  await client.start();
  const decor = await enterSameDecorConflict(client, api, roomId);
  const resolved = await client.engine.resolveConflict('cloud');

  assert.equal(resolved.ok, true);
  assert.equal(client.engine.snapshot.status, STATUS.SYNCED);
  assert.equal(client.state.decor.find((item) => item.id === decor.id).x, 0.83);
  const backups = client.store.listBackups(userId, roomId).map((entry) => entry.state);
  assert.ok(backups.some((backup) => backup.decor.find((item) => item.id === decor.id).x === 0.67));
});

test('choosing local replays only its target decor and keeps remote additions in both state and backup', async () => {
  const userId = 'local-choice-user';
  const roomId = 'local-choice-room';
  const api = createFakeApi();
  api.addRoom(roomId);
  const client = createClient({ api, userId, roomId });
  await client.start();
  const decor = await enterSameDecorConflict(client, api, roomId);
  const remoteExtra = { ...clone(client.state.decor[1]), id: 'remote-added-decor' };
  api.mutate(roomId, (remote) => remote.decor.push(remoteExtra));

  const resolved = await client.engine.resolveConflict('local');
  assert.equal(resolved.ok, true);
  const result = api.rooms.get(roomId).state;
  assert.equal(result.decor.find((item) => item.id === decor.id).x, 0.67);
  assert.ok(result.decor.some((item) => item.id === remoteExtra.id), '本机选择不能删除他人新增的物件');
  const backups = client.store.listBackups(userId, roomId).map((entry) => entry.state);
  assert.ok(backups.some((backup) => backup.decor.find((item) => item.id === decor.id).x === 0.67));
  assert.ok(backups.some((backup) => backup.decor.some((item) => item.id === remoteExtra.id)));
});

test('viewer cannot mark edits or queue feeding', async () => {
  const api = createFakeApi();
  const state = makeState();
  api.addRoom('viewer-room', state, { role: 'viewer' });
  const client = createClient({ api, userId: 'viewer-user', roomId: 'viewer-room', state });
  await client.start();

  client.state.fish[0].name = '不应接受';
  assert.equal(client.engine.markDirty(), false);
  assert.equal(client.state.fish[0].name, state.fish[0].name);
  assert.deepEqual(client.engine.queueFeed(state.fish[0].id), { ok: false, skipped: 'viewer' });
  assert.equal(api.calls.apply.length, 0);
  assert.equal(api.calls.feed.length, 0);
});

test('revocation stops realtime, backs up pending work, and ignores a queued stale callback', async () => {
  const userId = 'revoked-user';
  const roomId = 'revoked-room';
  const api = createFakeApi();
  api.addRoom(roomId);
  let online = false;
  const client = createClient({ api, userId, roomId, online: () => online });
  await client.start();
  client.state.fish[0].name = '撤权前本机编辑';
  client.engine.markDirty();
  online = true;
  api.setProbeHook(() => ({ ok: false, code: 'forbidden', error: 'revoked' }));

  await client.engine.syncNow();
  assert.equal(client.engine.snapshot.status, STATUS.SIGNED_OUT);
  assert.equal(client.revoked, 1);
  assert.equal(api.calls.stopRealtime, 2, '启动时清理一次，撤权后再清理一次');
  assert.equal(api.subscriptions.size, 0);
  assert.ok(client.store.listBackups(userId, roomId).some((entry) => entry.state.fish[0].name === '撤权前本机编辑'));

  api.setProbeHook(null);
  const probesAfterRevoke = api.calls.probe.length;
  const statusesAfterRevoke = client.statuses.length;
  api.emitOldestChange();
  api.emitOldestStatus();
  await flushMicrotasks();
  assert.equal(api.calls.probe.length, probesAfterRevoke, '撤权后排队到达的旧订阅回调不能启动同步');
  assert.equal(client.statuses.length, statusesAfterRevoke, '撤权后旧订阅状态回调也应失效');
  assert.equal(client.engine.snapshot.status, STATUS.SIGNED_OUT);
  assert.equal(client.revoked, 1);
});

test('responses from an old identity cannot replace new state or clear its in-flight request', async () => {
  const userA = 'identity-a';
  const userB = 'identity-b';
  const roomA = 'identity-room-a';
  const roomB = 'identity-room-b';
  const api = createFakeApi();
  const stateA = makeState();
  const stateB = makeState();
  api.addRoom(roomA, stateA);
  api.addRoom(roomB, stateB);
  const storage = createMemoryStorage();
  const client = createClient({ api, userId: userA, roomId: roomA, state: stateA, storage });
  await client.start();

  client.state.fish[0].name = 'A 的待提交改名';
  client.engine.markDirty();
  const heldA = [];
  api.setApplyHook((context) => {
    const pending = deferred();
    heldA.push({ ...context, pending });
    return pending.promise;
  });
  const oldJob = client.engine.syncNow();
  await waitFor(() => heldA.length === 1, '旧身份写入请求应进入等待');
  await client.engine.stop();

  await client.engine.start({ user: { id: userB } }, roomB);
  client.state.fish[0].name = 'B 的新身份状态';
  client.engine.markDirty();
  const heldB = [];
  api.setApplyHook((context) => {
    if (context.roomId !== roomB) return context.commit();
    const pending = deferred();
    heldB.push({ ...context, pending });
    return pending.promise;
  });
  const newJob = client.engine.syncNow();
  await waitFor(() => heldB.length === 1, '新身份写入请求应保持在途');

  heldA[0].pending.resolve(heldA[0].commit());
  const oldResult = await oldJob;
  assert.deepEqual(oldResult, { ok: false, skipped: 'stale' });
  assert.equal(client.state.fish[0].name, 'B 的新身份状态');
  assert.equal(client.engine.snapshot.user.id, userB);
  assert.equal(client.engine.snapshot.busy, true, '旧请求 finally 不能清除新身份的 in-flight');

  const coalesced = client.engine.syncNow();
  heldB[0].pending.resolve(heldB[0].commit());
  assert.equal((await newJob).ok, true);
  assert.equal((await coalesced).ok, true);
  assert.equal(api.rooms.get(roomB).state.fish[0].name, 'B 的新身份状态');
  assert.equal(client.engine.snapshot.busy, false);
});

test('an edit made while an earlier operation is in flight remains in the tail and is submitted', async () => {
  const userId = 'tail-user';
  const roomId = 'tail-room';
  const api = createFakeApi();
  const state = makeState();
  api.addRoom(roomId, state);
  const client = createClient({ api, userId, roomId, state });
  await client.start();

  client.state.decor[0].x = 0.69;
  client.engine.markDirty();
  const held = [];
  api.setApplyHook((context) => {
    if (held.length > 0) return context.commit();
    const pending = deferred();
    held.push({ ...context, pending });
    return pending.promise;
  });
  const sync = client.engine.syncNow();
  await waitFor(() => held.length === 1, '首个操作应在途');

  client.state.fish[0].name = '在途期间追加的编辑';
  assert.equal(client.engine.markDirty(), true);
  const tail = client.store.readMeta(userId, roomId).queue;
  assert.equal(tail.length, 2);
  const tailId = tail[1].id;
  held[0].pending.resolve(held[0].commit());

  const synced = await sync;
  assert.equal(synced.ok, true, JSON.stringify({ synced, calls: api.calls.apply, snapshot: client.engine.snapshot, notices: client.notices }));
  assert.equal(api.calls.apply.length, 2);
  assert.equal(api.calls.apply[1].operationId, tailId);
  assert.equal(api.rooms.get(roomId).state.decor[0].x, 0.69);
  assert.equal(api.rooms.get(roomId).state.fish[0].name, '在途期间追加的编辑');
  assert.equal(client.engine.isDirty, false);
});

test('a failed local cache write reports an error and preserves a backup', async () => {
  const userId = 'cache-user';
  const roomId = 'cache-room';
  const api = createFakeApi();
  api.addRoom(roomId);
  const storage = createMemoryStorage();
  const store = createLocalStore(storage);
  const writeAccountState = store.writeAccountState.bind(store);
  let failWrites = false;
  store.writeAccountState = (...args) => failWrites ? false : writeAccountState(...args);
  const client = createClient({ api, userId, roomId, store, storage });
  await client.start();

  failWrites = true;
  client.state.fish[0].name = '缓存失败仍需保留';
  assert.equal(client.engine.markDirty(), false);
  assert.equal(client.engine.snapshot.status, STATUS.ERROR);
  assert.match(client.statuses.at(-1).message, /缓存/);
  assert.ok(store.listBackups(userId, roomId).some((entry) => entry.state.fish[0].name === '缓存失败仍需保留'));
});
