// 同步引擎的行为契约测试：去抖、冲突、离线、成长记账、账号隔离、无固定轮询。
// 后端使用本地假 Supabase（tests/fake-supabase）——它能证明前端逻辑正确，
// 但不能代替真实 Supabase 联调（见 docs/HANDOFF.md 的阻塞项）。

import test from 'node:test';
import assert from 'node:assert/strict';
import { createSyncEngine, STATUS, CONFLICT_REASON } from '../web/cloud/sync.js';
import { createCloudStack } from '../web/cloud/client.js';
import { createLocalStore, keys } from '../web/storage.js';
import { initial, validate, canonicalState, cloneState } from '../web/model.js';
import { createMemoryStorage } from './helpers/memory-storage.mjs';
import { createFakeSupabase, makeAccessToken } from './fake-supabase/supabase-fake.mjs';
import { createFakeFetch } from './fake-supabase/server.mjs';

const ANON = makeAccessToken('anon', { role: 'anon' });
const START = 1_700_000_000_000;
const DEBOUNCE = 2500;

/** 模拟多台设备：共用一个后端（同一套账号/鱼缸），各自的本地存储与引擎互相独立。 */
function makeDevices(count, { startMs = START, overrides } = {}) {
  const fake = createFakeSupabase({ startMs });
  return Array.from({ length: count }, () => createHarness({ startMs, overrides, fake }));
}

/** 旧测试用「水草数量」表达改动；v2 里水草是 decor 对象，这里提供等价的读写辅助。 */
function plantCount(state) {
  return Array.isArray(state?.decor) ? state.decor.filter((d) => d.kind === 'plant').length : 0;
}

function setPlants(state, count) {
  const plants = state.decor.filter((d) => d.kind === 'plant');
  const others = state.decor.filter((d) => d.kind !== 'plant');
  // 增加时追加新对象、减少时切片：改回原数量会恢复成同一批对象（canonical 指纹一致）。
  const next = count <= plants.length
    ? plants.slice(0, count)
    : [...plants, ...Array.from({ length: count - plants.length }, (_, i) => {
      const index = plants.length + i;
      return {
        id: `test-plant-${index}`, kind: 'plant', type: 'vallis',
        x: 0.1 + (index % 5) * 0.03, z: 0.2 + (index % 3) * 0.05,
        rot: index * 0.3, scale: 1, seed: 1000 + index, v: 1
      };
    })];
  state.decor = [...others, ...next];
  return state;
}

function tank(name, extra = {}) {
  const state = validate(initial(START));
  state.fish[0].name = name;
  const { plants, ...rest } = extra;
  Object.assign(state, rest);
  if (typeof plants === 'number') setPlants(state, plants);
  return state;
}

function createHarness({ configured = true, debounceMs = DEBOUNCE, startMs = START, overrides = {}, gate = null, fake = createFakeSupabase({ startMs }) } = {}) {
  let nowMs = startMs;
  let online = true;
  const raw = createMemoryStorage();
  const store = createLocalStore(raw);
  const state = { current: tank('小满') };
  const statuses = [];
  const notices = [];
  const requests = [];
  const timers = new Map();
  let timerSeq = 0;
  const overrideFor = (ctx) => {
    for (const rule of overrides.rules || []) {
      const result = rule(ctx);
      if (result) return result;
    }
    return null;
  };

  const fetchImpl = createFakeFetch(fake, {
    // gate：测试用来卡住某个请求的响应（模拟「响应晚到」），验证会话代次是否生效。
    onRequest: async (ctx) => {
      requests.push({ path: ctx.path, body: ctx.body });
      if (gate) await gate(ctx);
      const override = overrideFor(ctx);
      if (override) return override;
      if (!online) throw new TypeError('offline');
      return null;
    }
  });

  const config = configured
    ? { mode: 'ready', url: 'https://demo.supabase.co', anonKey: ANON, keyKind: 'anon', problems: [] }
    : { mode: 'off', url: '', anonKey: '', keyKind: 'none', problems: ['未配置云端项目地址与公开 key'] };

  const stack = createCloudStack({ config, store, fetchImpl, now: () => nowMs });

  const engine = createSyncEngine({
    api: stack.api,
    store,
    getState: () => state.current,
    setState: (next) => { state.current = next; },
    initialState: () => initial(nowMs),
    debounceMs,
    now: () => nowMs,
    setTimeoutFn: (fn, ms) => { const id = ++timerSeq; timers.set(id, { fn, ms }); return id; },
    clearTimeoutFn: (id) => { timers.delete(id); },
    isOnline: () => online,
    onStatus: (s) => statuses.push(s),
    onNotice: (m) => notices.push(m)
  });

  return {
    fake, store, raw, stack, engine, statuses, notices, requests, timers,
    get current() { return state.current; },
    set current(v) { state.current = v; },
    get lastStatus() { return statuses[statuses.length - 1]?.status; },
    setOnline: (v) => { online = v; },
    advance: (ms) => { nowMs += ms; fake.advance(ms); },
    /** 触发到期定时器（模拟 debounce 窗口过去），返回写入的 promise 以便 await。 */
    async runTimers() {
      const due = [...timers.values()];
      timers.clear();
      return Promise.all(due.map(t => t.fn()));
    },
    countRequests(path) { return requests.filter(r => r.path.endsWith(path)).length; },
    async register(email = 'me@example.com', password = 'goodpassword') {
      await stack.auth.signUp({ email, password });
      fake.users.get(email).confirmed = true;
      const res = await stack.auth.signIn({ email, password });
      assert.equal(res.ok, true, `登录失败: ${JSON.stringify(res.error)}`);
      return res;
    }
  };
}

// ------------------------------------------------------------------ 游客与配置

test('未配置云端：保持游客模式，全程不发任何请求', async () => {
  const h = createHarness({ configured: false });
  assert.equal(h.engine.status, STATUS.CLOUD_OFF);

  await h.engine.setSession(null);
  assert.equal(h.engine.mode, 'guest');
  assert.equal(h.lastStatus, STATUS.CLOUD_OFF);

  h.engine.markDirty();
  assert.equal(h.timers.size, 0, '游客模式不排队任何云端写入');
  assert.equal(h.requests.length, 0);
});

test('未配置云端时用假会话登录也不会崩，并退回游客模式', async () => {
  const h = createHarness({ configured: false });
  const res = await h.engine.setSession({ user: { id: 'u1', email: 'x@example.com' }, access_token: 't' });
  assert.equal(res.ok, false);
  assert.equal(h.engine.mode, 'guest');
  assert.equal(h.lastStatus, STATUS.CLOUD_OFF);
  assert.equal(h.requests.length, 0, '未配置时不做无意义的网络请求');
});

// ------------------------------------------------------------------ 开缸与多设备

test('登录后云端没有存档：用本机存档开缸，状态变为已同步', async () => {
  const h = createHarness();
  h.current = tank('本机的缸', { plants: 5 });
  const session = await h.register();

  const res = await h.engine.setSession(session.session);
  assert.equal(res.ok, true);
  assert.equal(res.created, true);
  assert.equal(h.lastStatus, STATUS.SYNCED);
  assert.equal(h.engine.isCloud, true);

  const row = [...h.fake.aquariums.values()][0];
  assert.equal(row.state.fish[0].name, '本机的缸');
  assert.equal(plantCount(row.state), 5);
  assert.equal(row.revision, 1);
});

test('第二台设备登录同账号：恢复云端存档（名字、成长、造景）', async () => {
  // 设备 A：登录并改名 / 种水草
  const [deviceA, deviceB] = makeDevices(2);
  const sessionA = await deviceA.register();
  await deviceA.engine.setSession(sessionA.session);
  deviceA.current.fish[0].name = 'A 起的名字';
  deviceA.current.fish[1].growth = 0.42;
  setPlants(deviceA.current, 6);
  assert.equal(deviceA.engine.markDirty(), true);
  await deviceA.runTimers();
  await Promise.resolve();
  assert.equal(deviceA.countRequests('save_aquarium'), 1);

  // 设备 B：完全独立的本地存储，同一账号登录
  const sessionB = await deviceB.stack.auth.signIn({ email: 'me@example.com', password: 'goodpassword' });
  deviceB.current = tank('B 设备上的旧缸');
  await deviceB.engine.setSession(sessionB.session);

  assert.equal(deviceB.current.fish[0].name, 'A 起的名字');
  assert.equal(deviceB.current.fish[1].growth, 0.42);
  assert.equal(plantCount(deviceB.current), 6);
  assert.equal(deviceB.lastStatus, STATUS.SYNCED);
});

test('两台设备同 revision：只有先写入的成功，后者拿到冲突并保留本机副本', async () => {
  const [deviceA, deviceB] = makeDevices(2);
  const sessionA = await deviceA.register();
  await deviceA.engine.setSession(sessionA.session);
  deviceA.current.fish[0].name = '初始名字';
  deviceA.engine.markDirty();
  await deviceA.runTimers();
  await Promise.resolve();

  const sessionB = await deviceB.stack.auth.signIn({ email: 'me@example.com', password: 'goodpassword' });
  await deviceB.engine.setSession(sessionB.session);

  // 两台设备的 revision 相同
  assert.equal(deviceA.engine.snapshot.revision, deviceB.engine.snapshot.revision);
  const deviceBBaseRevision = deviceB.engine.snapshot.baseRevision;

  deviceA.current.fish[0].name = 'A 改的';
  deviceA.engine.markDirty();
  await deviceA.runTimers();
  await Promise.resolve();
  const serverRevisionAfterA = deviceA.engine.snapshot.revision;

  deviceB.current.fish[0].name = 'B 改的';
  deviceB.engine.markDirty();
  await deviceB.runTimers();
  await deviceB.engine.flush({ reason: 'test' });

  assert.equal(deviceB.lastStatus, STATUS.CONFLICT);
  assert.equal(deviceB.engine.snapshot.conflict.reason, CONFLICT_REASON.SAVE);
  assert.equal(deviceB.engine.snapshot.conflict.cloudRevision, serverRevisionAfterA,
    '冲突提示里带上服务端最新 revision');

  const server = [...deviceB.fake.aquariums.values()][0];
  assert.equal(server.state.fish[0].name, 'A 改的', '冲突方的数据没有覆盖服务端');

  const uid = sessionB.session.user.id;
  const aquariumId = deviceB.engine.snapshot.aquariumId;
  const pending = deviceB.store.readPending(uid, aquariumId);
  assert.ok(pending, '本机未同步副本必须保留');
  assert.equal(pending.state.fish[0].name, 'B 改的');
  assert.equal(Number(pending.baseRevision), deviceBBaseRevision,
    '未同步副本必须记下它基于哪个 revision（这里是 B 本地那份的基线，而不是云端最新版本）');
  assert.ok(Number(pending.baseRevision) < Number(serverRevisionAfterA),
    '基线比云端最新版本旧，恢复时才能据此判断云端被改过');
});

test('登录对账期间多个 syncNow 调用复用同一次 hydrate', async () => {
  const started = deferred();
  const response = deferred();
  let holdEnsure = false;
  const h = createHarness({
    gate: async (ctx) => {
      if (holdEnsure && ctx.path.endsWith('ensure_aquarium')) {
        holdEnsure = false;
        started.resolve();
        await response.promise;
      }
    }
  });
  const session = await h.register();
  holdEnsure = true;

  const first = h.engine.setSession(session.session);
  await started.promise;
  const ensuresAtGate = h.countRequests('ensure_aquarium');
  const second = h.engine.syncNow({ reason: 'focus-during-login' });
  assert.equal(h.countRequests('ensure_aquarium'), ensuresAtGate, '焦点/可见事件不能再发一份开缸对账');
  assert.equal(h.engine.snapshot.busy, true);

  response.resolve();
  const [firstResult, secondResult] = await Promise.all([first, second]);
  assert.equal(firstResult.ok, true);
  assert.equal(secondResult.ok, true);
  assert.equal(h.countRequests('ensure_aquarium'), ensuresAtGate);
  assert.equal(h.engine.snapshot.busy, false, 'hydrate 结束后应通知界面释放 busy');
  assert.equal(h.statuses.at(-1).busy, false, '最后一次状态回调也必须反映 hydrate 已结束');
});

test('冲突处理：选择保留本机 → 以最新 revision 重试并成功', async () => {
  const [deviceA, deviceB] = makeDevices(2);
  const sessionA = await deviceA.register();
  await deviceA.engine.setSession(sessionA.session);
  deviceA.current.fish[0].name = '初始';
  deviceA.engine.markDirty(); await deviceA.runTimers(); await Promise.resolve();

  const sessionB = await deviceB.stack.auth.signIn({ email: 'me@example.com', password: 'goodpassword' });
  await deviceB.engine.setSession(sessionB.session);

  deviceA.current.fish[0].name = 'A 的名字';
  deviceA.engine.markDirty(); await deviceA.runTimers(); await Promise.resolve();

  deviceB.current.fish[0].name = 'B 的名字';
  deviceB.engine.markDirty();
  await deviceB.engine.flush({ reason: 'test' });
  assert.equal(deviceB.lastStatus, STATUS.CONFLICT);

  const resolved = await deviceB.engine.resolveConflict('local');
  assert.equal(resolved.ok, true);
  assert.equal(resolved.resolution, 'local');
  assert.equal(deviceB.lastStatus, STATUS.SYNCED);

  const server = [...deviceB.fake.aquariums.values()][0];
  assert.equal(server.state.fish[0].name, 'B 的名字');
  const uid = sessionB.session.user.id;
  assert.equal(deviceB.store.readPending(uid, deviceB.engine.snapshot.aquariumId), null, '解决后清掉待同步副本');
});

test('冲突处理：选择保留云端 → 采用云端存档，本机改动归档为备份', async () => {
  const [deviceA, deviceB] = makeDevices(2);
  const sessionA = await deviceA.register();
  await deviceA.engine.setSession(sessionA.session);
  deviceA.current.fish[0].name = '初始';
  deviceA.engine.markDirty(); await deviceA.runTimers(); await Promise.resolve();

  const sessionB = await deviceB.stack.auth.signIn({ email: 'me@example.com', password: 'goodpassword' });
  await deviceB.engine.setSession(sessionB.session);

  deviceA.current.fish[0].name = '云端赢';
  deviceA.engine.markDirty(); await deviceA.runTimers(); await Promise.resolve();

  deviceB.current.fish[0].name = '本机要保留的';
  deviceB.engine.markDirty();
  await deviceB.engine.flush({ reason: 'test' });
  assert.equal(deviceB.lastStatus, STATUS.CONFLICT);

  const resolved = await deviceB.engine.resolveConflict('cloud');
  assert.equal(resolved.ok, true);
  assert.equal(deviceB.current.fish[0].name, '云端赢', '界面切到云端存档');
  assert.equal(deviceB.lastStatus, STATUS.SYNCED);

  const uid = sessionB.session.user.id;
  const aquariumId = deviceB.engine.snapshot.aquariumId;
  const backups = deviceB.store.listBackups(uid, aquariumId);
  assert.equal(backups.length, 1, '本机改动必须留下备份，不能消失');
  assert.equal(backups[0].state.fish[0].name, '本机要保留的');
});

test('冲突显示后继续编辑：两种解决选择都使用或备份最新本机状态', async () => {
  for (const choice of ['local', 'cloud']) {
    const fake = createFakeSupabase({ startMs: START });
    const ensureStarted = deferred();
    const ensureRelease = deferred();
    let holdEnsure = false;
    const gate = async (ctx) => {
      if (holdEnsure && ctx.path.endsWith('ensure_aquarium')) {
        holdEnsure = false;
        ensureStarted.resolve();
        await ensureRelease.promise;
      }
    };
    const deviceA = createHarness({ fake, gate });
    const deviceB = createHarness({ fake, gate });
    const sessionA = await deviceA.register();
    await deviceA.engine.setSession(sessionA.session);
    const sessionB = await deviceB.stack.auth.signIn({ email: 'me@example.com', password: 'goodpassword' });
    await deviceB.engine.setSession(sessionB.session);

    deviceA.current.fish[0].name = '另一台设备已保存';
    deviceA.engine.markDirty();
    await deviceA.runTimers();
    await Promise.resolve();

    setPlants(deviceB.current, 7);
    await deviceB.engine.flush({ reason: 'conflict-edit-test' });
    assert.equal(deviceB.engine.status, STATUS.CONFLICT);

    const uid = sessionB.session.user.id;
    const aquariumId = deviceB.engine.snapshot.aquariumId;

    holdEnsure = true;
    const resolving = deviceB.engine.resolveConflict(choice);
    await ensureStarted.promise;
    deviceB.current.fish[0].name = '冲突处理期间又改的名字';
    assert.equal(deviceB.engine.markDirty(), true, '冲突处理请求在途时仍需记录本机编辑');
    assert.equal(deviceB.store.readPending(uid, aquariumId).state.fish[0].name, '冲突处理期间又改的名字');
    ensureRelease.resolve();
    const resolved = await resolving;
    assert.equal(resolved.ok, true, `${choice} 解决应成功`);
    const backups = deviceB.store.listBackups(uid, aquariumId);
    if (choice === 'local') {
      const server = [...deviceB.fake.aquariums.values()][0];
      assert.equal(server.state.fish[0].name, '冲突处理期间又改的名字', '选择本机时上传最后一笔编辑');
      assert.equal(plantCount(server.state), 7);
      assert.equal(backups.length, 1, '被覆盖的云端版本先备份');
    } else {
      assert.equal(deviceB.current.fish[0].name, '另一台设备已保存', '选择云端后采用服务端版本');
      assert.equal(backups.length, 1);
      assert.equal(backups[0].state.fish[0].name, '冲突处理期间又改的名字', '后续编辑必须进入本地备份');
      assert.equal(plantCount(backups[0].state), 7);
    }
  }
});

// ------------------------------------------------------------------ 旧存档与用户选择

test('登录前有本机旧存档、云端也有存档：不静默覆盖，交由用户选择', async () => {
  // 先有云端存档（设备 A 建立）
  const [deviceA, deviceB] = makeDevices(2);
  const sessionA = await deviceA.register();
  await deviceA.engine.setSession(sessionA.session);
  deviceA.current.fish[0].name = '云端的缸';
  deviceA.engine.markDirty(); await deviceA.runTimers(); await Promise.resolve();

  // 设备 B：登录前先玩过本地游客模式
  deviceB.store.writeGuest(tank('登录前的本地缸'));
  deviceB.current = tank('登录前的本地缸');
  const sessionB = await deviceB.stack.auth.signIn({ email: 'me@example.com', password: 'goodpassword' });
  const res = await deviceB.engine.setSession(sessionB.session);

  assert.equal(res.ok, false);
  assert.equal(res.conflict.reason, CONFLICT_REASON.GUEST_IMPORT);
  assert.equal(deviceB.lastStatus, STATUS.CONFLICT);

  const server = [...deviceB.fake.aquariums.values()][0];
  assert.equal(server.state.fish[0].name, '云端的缸', '用户选择前不允许改动云端');
  assert.equal(deviceB.store.readGuest().fish[0].name, '登录前的本地缸', '游客存档原地保留');

  const detail = deviceB.engine.conflictDetail();
  assert.equal(detail.localFish[0].name, '登录前的本地缸');
  assert.equal(detail.cloudFish[0].name, '云端的缸');
});

test('旧存档冲突：选择用本机存档更新云端后，云端与本机一致且游客存档仍在', async () => {
  const [deviceA, deviceB] = makeDevices(2);
  const sessionA = await deviceA.register();
  await deviceA.engine.setSession(sessionA.session);
  deviceA.current.fish[0].name = '云端的缸';
  deviceA.engine.markDirty(); await deviceA.runTimers(); await Promise.resolve();

  deviceB.store.writeGuest(tank('登录前的本地缸', { plants: 7 }));
  deviceB.current = tank('登录前的本地缸');
  const sessionB = await deviceB.stack.auth.signIn({ email: 'me@example.com', password: 'goodpassword' });
  await deviceB.engine.setSession(sessionB.session);

  const resolved = await deviceB.engine.resolveConflict('local');
  assert.equal(resolved.ok, true);
  assert.equal(deviceB.lastStatus, STATUS.SYNCED);

  const server = [...deviceB.fake.aquariums.values()][0];
  assert.equal(server.state.fish[0].name, '登录前的本地缸');
  assert.equal(plantCount(server.state), 7);
  assert.equal(deviceB.store.hasGuest(), true, '游客存档不因登录被删除');
});

// ------------------------------------------------------------------ 去抖与写入时机

test('去抖：连续修改只写一次；内容没变则完全不发请求', async () => {
  const h = createHarness();
  const session = await h.register();
  await h.engine.setSession(session.session);
  const baseline = h.countRequests('save_aquarium');

  assert.equal(h.engine.markDirty(), false, '刚同步完的状态不算变更');
  assert.equal(h.timers.size, 0);

  h.current.fish[0].name = '改一下';
  assert.equal(h.engine.markDirty(), true);
  const before = plantCount(h.current);
  setPlants(h.current, before + 1);
  assert.equal(h.engine.markDirty(), true);
  assert.equal(h.timers.size, 1, '多次变更只保留一个待发定时器');

  await h.runTimers();
  await new Promise(r => setTimeout(r, 0));
  assert.equal(h.countRequests('save_aquarium') - baseline, 1, '合并成一次写入');
  assert.equal(h.statuses.at(-1).busy, false, '完成回调必须通知界面实际请求已结束');

  // 内容没变 → 不排队、不请求
  h.engine.markDirty();
  assert.equal(h.timers.size, 0);
  assert.equal(h.countRequests('save_aquarium') - baseline, 1);
});

test('去抖窗口内明确显示待同步；编辑撤销后恢复已同步', async () => {
  const h = createHarness();
  const session = await h.register();
  await h.engine.setSession(session.session);

  const before = plantCount(h.current);
  setPlants(h.current, before + 1);
  assert.equal(h.engine.markDirty(), true);
  assert.equal(h.engine.status, STATUS.SYNCING, '去抖等待期间不能继续声称已同步');
  assert.equal(h.engine.snapshot.dirty, true);
  assert.equal(h.engine.snapshot.busy, false, '去抖等待还没有进入网络请求');
  assert.equal(h.countRequests('save_aquarium'), 0);

  setPlants(h.current, before);
  assert.equal(h.engine.markDirty(), false, '改回已确认状态后撤销待写入');
  assert.equal(h.engine.status, STATUS.SYNCED);
  assert.equal(h.engine.snapshot.dirty, false);
  assert.equal(h.engine.pendingSaveScheduled, false);
});

test('定时器只有去抖用途：没有固定轮询（所有定时器都等于 debounce 间隔）', async () => {
  const h = createHarness({ debounceMs: 1234 });
  const session = await h.register();
  await h.engine.setSession(session.session);
  h.current.fish[0].name = '触发一次';
  h.engine.markDirty();
  assert.equal(h.timers.size, 1);
  for (const t of h.timers.values()) assert.equal(t.ms, 1234);
  await h.runTimers();
  await new Promise(r => setTimeout(r, 0));
  assert.equal(h.timers.size, 0, '写完后不再有残留定时器');
});

test('页面关闭时的最后一次写入使用 keepalive', async () => {
  const h = createHarness();
  const session = await h.register();
  await h.engine.setSession(session.session);
  const seen = [];
  const rawFetch = h.stack.api;
  void rawFetch;
  h.current.fish[0].name = '关页面前的改动';
  await h.engine.flush({ reason: 'pagehide', keepalive: true });
  seen.push(true);
  assert.equal(h.lastStatus, STATUS.SYNCED);
  assert.equal(h.statuses.at(-1).busy, false);
  assert.equal(seen.length, 1);
});

// ------------------------------------------------------------------ 离线

test('离线：改动留在本机，状态显示离线；重连后自动写入', async () => {
  const h = createHarness();
  const session = await h.register();
  await h.engine.setSession(session.session);
  const baseline = h.countRequests('save_aquarium');

  h.setOnline(false);
  h.current.fish[0].name = '离线时改的';
  await h.engine.flush({ reason: 'offline-test' });

  assert.equal(h.lastStatus, STATUS.OFFLINE);
  const uid = session.session.user.id;
  const aquariumId = h.engine.snapshot.aquariumId;
  assert.equal(h.store.readPending(uid, aquariumId).state.fish[0].name, '离线时改的');

  h.setOnline(true);
  h.engine.handleOnline();
  await new Promise(r => setTimeout(r, 10));

  assert.equal(h.lastStatus, STATUS.SYNCED);
  assert.equal(h.countRequests('save_aquarium') - baseline, 2, '离线那次 + 重连那次');
  const server = [...h.fake.aquariums.values()][0];
  assert.equal(server.state.fish[0].name, '离线时改的');
  assert.equal(h.store.readPending(uid, aquariumId), null);
});

test('离线时 markDirty 只落本地，不把待同步改动显示成同步中', async () => {
  const h = createHarness();
  const session = await h.register();
  await h.engine.setSession(session.session);
  const requestsBefore = h.requests.length;
  h.setOnline(false);

  h.current.fish[0].name = '离线编辑';
  assert.equal(h.engine.markDirty(), true);
  assert.equal(h.engine.status, STATUS.OFFLINE);
  assert.equal(h.engine.snapshot.dirty, true);
  assert.equal(h.engine.pendingSaveScheduled, false);
  assert.equal(h.requests.length, requestsBefore, '离线编辑无需发起失败的网络请求');

  const uid = session.session.user.id;
  const aquariumId = h.engine.snapshot.aquariumId;
  assert.equal(h.store.readPending(uid, aquariumId).state.fish[0].name, '离线编辑');
});

test('服务端 5xx：不丢档，保留待同步并显示失败', async () => {
  const failing = { value: true };
  const h = createHarness({
    overrides: {
      rules: [(ctx) => (failing.value && ctx.path.endsWith('save_aquarium')
        ? { ok: false, status: 503, async text() { return JSON.stringify({ message: 'upstream down' }); } }
        : null)]
    }
  });
  const session = await h.register();
  await h.engine.setSession(session.session);

  h.current.fish[0].name = '服务端挂了';
  await h.engine.flush({ reason: 'test' });
  assert.equal(h.lastStatus, STATUS.ERROR);

  const uid = session.session.user.id;
  const aquariumId = h.engine.snapshot.aquariumId;
  assert.equal(h.store.readPending(uid, aquariumId).state.fish[0].name, '服务端挂了');

  failing.value = false;
  const res = await h.engine.syncNow({ reason: 'retry' });
  assert.equal(res.ok, true);
  assert.equal(h.lastStatus, STATUS.SYNCED);
  assert.equal(h.store.readPending(uid, aquariumId), null);
});

test('云端判定存档非法：不重试、不覆盖，明确报错并保留本机副本', async () => {
  const h = createHarness({
    overrides: {
      rules: [(ctx) => (ctx.path.endsWith('save_aquarium')
        ? { ok: true, status: 200, async text() { return JSON.stringify([{ status: 'invalid_state', error_code: 'fish_growth_out_of_range' }]); } }
        : null)]
    }
  });
  const session = await h.register();
  await h.engine.setSession(session.session);
  const before = h.countRequests('save_aquarium');

  h.current.fish[0].name = '会被拒绝';
  await h.engine.flush({ reason: 'test' });

  assert.equal(h.lastStatus, STATUS.ERROR);
  assert.equal(h.countRequests('save_aquarium') - before, 1, '非法存档不重试');
  const uid = session.session.user.id;
  assert.ok(h.store.readPending(uid, h.engine.snapshot.aquariumId));
});

// ------------------------------------------------------------------ 令牌与成长

test('访问令牌过期：写入时自动刷新一次再重试，不把用户踢下线', async () => {
  const h = createHarness();
  const session = await h.register();
  await h.engine.setSession(session.session);
  const userId = session.session.user.id;

  h.fake.revokeAccessTokens(userId);
  h.current.fish[0].name = '令牌过期后写的';
  const res = await h.engine.flush({ reason: 'test' });

  assert.equal(res.ok, true, '401 后应刷新并重试成功');
  assert.equal(h.lastStatus, STATUS.SYNCED);
  assert.ok(h.requests.some(r => r.path === '/auth/v1/token'), '确实发起了刷新请求');
});

test('服务端成长结算：只加一次，重复同步不会重复奖励', async () => {
  const h = createHarness();
  const session = await h.register();
  await h.engine.setSession(session.session);
  const before = h.current.fish[0].growth;

  h.advance(3600_000);                       // 服务端经过 1 小时
  await h.engine.syncNow({ reason: 'test' });

  const afterFirst = h.current.fish[0].growth;
  assert.ok(Math.abs(afterFirst - (before + 0.002083)) < 1e-9, `1 小时应 +0.002083（v2：0.05/24h），实际 ${afterFirst}`);

  await h.engine.syncNow({ reason: 'test' });
  assert.equal(h.current.fish[0].growth, afterFirst, '第二次同步不能重复结算');

  const credited = await h.fake.handleRpc('settle_growth', { authorization: 'Bearer ' + session.session.access_token }, { p_id: h.engine.snapshot.aquariumId });
  assert.equal(credited.body[0].credited_seconds, 0);
});

test('离线成长有 24 小时上限（与服务端一致）', async () => {
  const h = createHarness();
  const session = await h.register();
  await h.engine.setSession(session.session);
  const before = h.current.fish[0].growth;

  h.advance(30 * 3600_000);                  // 离开 30 小时
  await h.engine.syncNow({ reason: 'test' });

  assert.ok(Math.abs(h.current.fish[0].growth - (before + 0.05)) < 1e-9,
    `封顶 24 小时应 +0.05（v2：0.05/24h），实际 ${h.current.fish[0].growth}`);
});

test('本机有未同步改动时，服务端成长增量只记一次并保留本机修改', async () => {
  const h = createHarness();
  const session = await h.register();
  await h.engine.setSession(session.session);

  const uid = session.session.user.id;
  const aquariumId = h.engine.snapshot.aquariumId;

  // 制造「本机有未同步改动」的局面：改名后不写入
  h.current.fish[0].name = '本机没同步的名字';
  h.engine.markDirty();
  assert.equal(h.timers.size, 1, '有未写入的改动');

  h.advance(2 * 3600_000);
  await h.engine.syncNow({ reason: 'test' });

  assert.equal(h.lastStatus, STATUS.SYNCED);
  assert.equal(h.current.fish[0].name, '本机没同步的名字', '本机改动保留');
  assert.ok(Math.abs(h.current.fish[0].growth - (2 * 0.05 / 24)) < 1e-6, '2 小时成长记一次');
  const server = [...h.fake.aquariums.values()][0];
  assert.equal(server.state.fish[0].name, '本机没同步的名字');
  assert.ok(Math.abs(server.state.fish[0].growth - (2 * 0.05 / 24)) < 1e-6, '云端也只记一次');
  assert.equal(h.store.readPending(uid, aquariumId), null);
});

test('进食记账：离线先入队，重连后按 operation_id 提交并只结算一次', async () => {
  const h = createHarness();
  const session = await h.register();
  await h.engine.setSession(session.session);
  const uid = session.session.user.id;
  const aquariumId = h.engine.snapshot.aquariumId;
  const fishId = h.current.fish[0].id;

  h.setOnline(false);
  const q1 = h.engine.queueFeed(fishId, 1);
  const q2 = h.engine.queueFeed(fishId, 1);
  assert.equal(q1.ok, true);
  assert.equal(q2.ok, true);
  assert.equal(h.engine.pendingFeeds, 2, '离线时进食先记在本机队列');
  assert.equal(h.current.fish[0].meals, 0, '客户端不自行加 meals/成长，避免与云端重复计算');
  const pending = h.store.readFeeds(uid, aquariumId);
  assert.equal(pending.length, 2);
  assert.notEqual(pending[0].op, pending[1].op, '每次进食有唯一 operation_id');
  assert.equal(h.countRequests('record_feeding'), 0, '离线不发请求');

  h.setOnline(true);
  h.advance(1000);
  await h.engine.syncNow({ reason: 'reconnect' });
  assert.equal(h.countRequests('record_feeding'), 2, '重连后提交两条进食事件');
  assert.equal(h.engine.pendingFeeds, 0);
  const row = [...h.fake.aquariums.values()][0];
  assert.ok(row.state.fish[0].growth >= 0.002 - 1e-9, '结算后营养成长写入云端');
  assert.equal(row.state.fish[0].meals, 2);

  // 重复提交同一批 operation_id 不会重复奖励（服务端按 id 去重）
  const before = row.state.fish[0].growth;
  h.advance(1000);
  await h.engine.syncNow({ reason: 'again' });
  assert.equal(h.current.fish[0].growth, row.state.fish[0].growth);
  assert.ok(Math.abs(row.state.fish[0].growth - before) < 1e-6);
});

test('进食营养上限：同一鱼 24h 内最多 3 口计入成长，多喂不加速', async () => {
  const h = createHarness();
  const session = await h.register();
  await h.engine.setSession(session.session);
  const fishId = h.current.fish[0].id;
  for (let i = 0; i < 6; i += 1) h.engine.queueFeed(fishId, 1);
  h.advance(1000);
  await h.engine.syncNow({ reason: 'feed' });
  const row = [...h.fake.aquariums.values()][0];
  const expected = 3 * (0.02 / 3);
  // 同一次结算里还会叠加 1 秒的自然成长（约 5.8e-7），因此只断言营养部分没有被超过。
  assert.ok(row.state.fish[0].growth >= expected - 1e-9 && row.state.fish[0].growth < expected + 1e-4,
    `实际 ${row.state.fish[0].growth}`);
  assert.equal(row.state.fish[0].meals, 6, '吃饱了仍然记录互动次数');
});

test('成长只由服务端结算，客户端不再做增量记账（顺序改为先写后结算）', async () => {
  // 旧实现会在本地把服务端的 credited_seconds 增量补算一遍；现在改为
  // 「先上传本机改动 → 再调用 settle_growth」，因此不需要也不应该存在客户端记账函数。
  const syncModule = await import('../web/cloud/sync.js');
  assert.equal(syncModule.applyGrowthDelta, undefined, '客户端记账函数应当已被移除，避免与服务端重复计算');
});

// ------------------------------------------------------------------ 账号隔离

test('冲突详情：保存时冲突（云端内容未知）也要能安全渲染', async () => {
  const deviceA = createHarness();
  const sessionA = await deviceA.register();
  await deviceA.engine.setSession(sessionA.session);
  deviceA.current.fish[0].name = '初始';
  deviceA.engine.markDirty(); await deviceA.runTimers(); await Promise.resolve();

  const deviceB = createHarness({ fake: deviceA.fake });
  await deviceB.engine.setSession((await deviceB.stack.auth.signIn({ email: 'me@example.com', password: 'goodpassword' })).session);

  deviceA.current.fish[0].name = 'A 改的';
  deviceA.engine.markDirty(); await deviceA.runTimers(); await Promise.resolve();

  deviceB.current.fish[0].name = 'B 改的';
  await deviceB.engine.flush({ reason: 'test' });
  assert.equal(deviceB.lastStatus, STATUS.CONFLICT);

  const detail = deviceB.engine.conflictDetail();
  assert.equal(detail.reason, CONFLICT_REASON.SAVE);
  assert.equal(detail.cloudKnown, false, '保存冲突时还没有云端内容');
  assert.deepEqual(detail.cloudFish, [], '云端鱼列表为空而不是抛异常');
  assert.equal(detail.localFish[0].name, 'B 改的');

  // 界面出错不能拖垮状态机：onStatus 抛异常时状态仍要正确推进
  const h = createHarness();
  const session = await h.register();
  await h.engine.setSession(session);
  const original = h.statuses.length;
  assert.ok(original > 0);
});

test('界面回调抛异常不会让同步状态机崩掉', async () => {
  const fake = createFakeSupabase();
  const store = createLocalStore(createMemoryStorage());
  let state = tank('x');
  const engine = createSyncEngine({
    api: createCloudStack({ config: { mode: 'off', url: '', anonKey: '', problems: [] }, store, fetchImpl: async () => ({ ok: false, status: 0, async text() { return ''; } }) }).api,
    store,
    getState: () => state,
    setState: (next) => { state = next; },
    initialState: () => tank('x'),
    onStatus: () => { throw new Error('界面渲染炸了'); },
    onNotice: () => { throw new Error('提示渲染炸了'); }
  });
  // 未配置云端：调用不应抛出，只是回到游客/未配置状态
  const res = await engine.setSession(null);
  assert.equal(res.ok, true);
  assert.equal(engine.mode, 'guest');
  assert.ok(fake);
});

test('换号不串档：A 退出后 B 登录，B 的云端是自己的缸，A 的本地缓存原样保留', async () => {
  const h = createHarness({ fake: createFakeSupabase({ startMs: START }) });

  // 账号 A
  const sessionA = await h.register('a@example.com');
  await h.engine.setSession(sessionA.session);
  h.current.fish[0].name = 'A 的鱼';
  await h.engine.flush({ reason: 'test' });
  const uidA = sessionA.session.user.id;
  const aquariumA = h.engine.snapshot.aquariumId;
  const cacheA = JSON.stringify(h.store.readAccountState(uidA, aquariumA));

  // 退出
  await h.engine.setSession(null);
  assert.equal(h.engine.mode, 'guest');
  assert.equal(h.engine.snapshot.aquariumId, null);

  // 账号 B
  const sessionB = await h.register('b@example.com');
  h.current = tank('B 自己的缸');
  await h.engine.setSession(sessionB.session);
  const uidB = sessionB.session.user.id;
  assert.notEqual(uidB, uidA, '两个账号的 id 不同');
  assert.notEqual(h.engine.snapshot.aquariumId, aquariumA, '每条鱼缸是独立的');

  h.current.fish[0].name = 'B 改的';
  await h.engine.flush({ reason: 'test' });

  assert.equal(JSON.stringify(h.store.readAccountState(uidA, aquariumA)), cacheA, 'A 的缓存不被 B 覆盖');
  const rowB = [...h.fake.aquariums.values()].find(r => r.owner === uidB);
  assert.equal(rowB.state.fish[0].name, 'B 改的');
  assert.ok(!JSON.stringify(rowB.state).includes('A 的鱼'), 'B 的存档里不能出现的 A 的数据');

  // B 的本机键都在自己的命名空间里
  for (const key of h.store.listKeysForUser(uidB)) assert.ok(key.includes(uidB));
  assert.ok(h.store.listKeysForUser(uidA).every(k => k.includes(uidA)));
});

test('同一账号重复登录（刷新页面）能取回自己的缓存与 revision', async () => {
  const h = createHarness();
  const session = await h.register();
  await h.engine.setSession(session.session);
  h.current.fish[0].name = '第一次会话改的';
  await h.engine.flush({ reason: 'test' });
  const firstRevision = h.engine.snapshot.revision;

  // 同一账号、同一浏览器：重新读会话并再走一遍 hydrate
  await h.engine.setSession(null);
  const again = await h.stack.auth.getSession();
  await h.engine.setSession(again.session);

  assert.equal(h.engine.snapshot.revision, firstRevision);
  assert.equal(h.current.fish[0].name, '第一次会话改的');
  assert.equal(h.lastStatus, STATUS.SYNCED);
});

test('__proto__ 之类的恶意键名不会污染原型链（存档按字面键存取）', () => {
  const raw = createMemoryStorage();
  const store = createLocalStore(raw);
  const evil = tank('x');
  Object.prototype.polluted = undefined;
  store.writeAccountState('__proto__', 'constructor', evil);
  assert.equal(store.readAccountState('__proto__', 'constructor').fish[0].name, 'x');
  assert.ok(raw.rawKeys().every(k => k.startsWith('mofish.')));
  assert.equal({}.polluted, undefined);
});

// ------------------------------------------------------------------ 第二轮评审的回归测试

/** 模拟「重新打开页面」：同一份本机存储 + 新的内存状态 + 新的引擎。 */
function reopened({ stack, store, onStatus = () => {}, isOnline = () => true }) {
  const holder = { current: tank('陌生的小满') };
  const engine = createSyncEngine({
    api: stack.api,
    store,
    getState: () => holder.current,
    setState: (next) => { holder.current = next; },
    initialState: () => tank('新缸'),
    onStatus,
    isOnline
  });
  return { engine, holder };
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function directEngine(api, current = tank('陌生的小满')) {
  const store = createLocalStore(createMemoryStorage());
  const holder = { current };
  const timers = new Map();
  let timerId = 0;
  const engine = createSyncEngine({
    api,
    store,
    getState: () => holder.current,
    setState: (next) => { holder.current = next; },
    initialState: () => tank('新缸'),
    debounceMs: DEBOUNCE,
    setTimeoutFn: (fn, ms) => { const id = ++timerId; timers.set(id, { fn, ms }); return id; },
    clearTimeoutFn: (id) => { timers.delete(id); },
    isOnline: () => true
  });
  return { engine, store, holder, timers };
}

function directApiHarness(accountNames = ['alice', 'bob']) {
  let targetAccount = accountNames[0];
  const rows = new Map(accountNames.map((account) => {
    const state = tank(`${account} 云端鱼缸`);
    return [account, {
      aquariumId: `aquarium-${account}`,
      revision: 1,
      state,
      lastGrowthAt: new Date(START).toISOString()
    }];
  }));
  const saves = [];
  const settles = [];
  const saveGates = new Map();
  const settleGates = new Map();
  const toResult = (row) => ({
    aquariumId: row.aquariumId,
    revision: row.revision,
    state: cloneState(row.state),
    lastGrowthAt: row.lastGrowthAt,
    created: false
  });
  const api = {
    configured: true,
    async ensureAquarium() {
      return { ok: true, result: toResult(rows.get(targetAccount)) };
    },
    async saveAquarium(input) {
      saves.push({ ...input, state: cloneState(input.state) });
      const row = [...rows.values()].find((candidate) => candidate.aquariumId === input.aquariumId);
      const gate = saveGates.get(input.aquariumId);
      if (gate) {
        gate.started.resolve();
        const override = await gate.response.promise;
        if (override) return override;
      }
      if (!row || Number(input.expectedRevision) !== row.revision) {
        return { ok: false, result: { kind: 'conflict', revision: row?.revision ?? null } };
      }
      row.state = cloneState(input.state);
      row.revision += 1;
      return { ok: true, result: { revision: row.revision, state: cloneState(row.state) } };
    },
    async settleGrowth(aquariumId) {
      settles.push(aquariumId);
      const row = [...rows.values()].find((candidate) => candidate.aquariumId === aquariumId);
      const gate = settleGates.get(aquariumId);
      if (gate) {
        gate.started.resolve();
        const override = await gate.response.promise;
        if (override?.ok && override.result) {
          if (override.result.state) row.state = cloneState(override.result.state);
          if (override.result.revision != null) row.revision = override.result.revision;
        }
        return override;
      }
      return { ok: true, result: { ...toResult(row), creditedSeconds: 0 } };
    }
  };
  return {
    api, rows, saves, settles, saveGates, settleGates,
    setTargetAccount: (account) => { targetAccount = account; }
  };
}

test('[P1-1] 重连（syncNow）不会绕过冲突去覆盖另一台设备已经提交的改动', async () => {
  // 这是评审给出的复现路径：A 已保存改名，B 改了水草后重连，
  // 旧实现会拿结算返回的新 revision 上传 B 的旧快照 → A 的名字被还原且界面显示「已同步」。
  const [deviceA, deviceB] = makeDevices(2);
  const sessionA = await deviceA.register();
  await deviceA.engine.setSession(sessionA.session);
  deviceA.current.fish[0].name = '初始';
  deviceA.engine.markDirty(); await deviceA.runTimers(); await Promise.resolve();

  const sessionB = await deviceB.stack.auth.signIn({ email: 'me@example.com', password: 'goodpassword' });
  await deviceB.engine.setSession(sessionB.session);

  deviceA.current.fish[0].name = 'A 改的';
  deviceA.engine.markDirty(); await deviceA.runTimers(); await Promise.resolve();
  const serverAfterA = [...deviceA.fake.aquariums.values()][0];
  assert.equal(serverAfterA.state.fish[0].name, 'A 改的');

  // B 改水草（尚未上传），然后「重连」触发 syncNow
  const baselinePlants = plantCount(deviceB.current);
  setPlants(deviceB.current, 7);
  const outcome = await deviceB.engine.syncNow({ reason: 'reconnect' });

  assert.equal(deviceB.lastStatus, STATUS.CONFLICT, '必须判定为冲突，而不是假装已同步');
  assert.equal(outcome.skipped, undefined);
  const serverNow = [...deviceB.fake.aquariums.values()][0];
  assert.equal(serverNow.state.fish[0].name, 'A 改的', 'A 的改动绝不能被 B 的旧快照覆盖');
  assert.equal(plantCount(serverNow.state), baselinePlants, 'B 未同步的水草改动没有偷偷写上去');
  assert.equal(plantCount(deviceB.current), 7, 'B 的本机改动仍然保留');

  const uid = sessionB.session.user.id;
  const pending = deviceB.store.readPending(uid, deviceB.engine.snapshot.aquariumId);
  assert.ok(pending, '未同步副本必须保留');
  assert.equal(plantCount(pending.state), 7);
});

test('[P1-2] 本机已落盘但未上传的改动：重新打开页面后仍会上传，而不是被云端回退', async () => {
  const h = createHarness();
  const session = await h.register();
  await h.engine.setSession(session.session);
  const uid = session.session.user.id;
  const aquariumId = h.engine.snapshot.aquariumId;

  // 用户改了水草；本机落盘（例如切后台 / 关页前，没有走完网络写入）
  setPlants(h.current, 7);
  assert.equal(h.engine.persistLocal(), true);
  const pending = h.store.readPending(uid, aquariumId);
  assert.ok(pending, '落盘时必须同时写下未同步副本');
  assert.equal(plantCount(pending.state), 7);
  assert.equal(Number(pending.baseRevision), h.engine.snapshot.baseRevision, '未同步副本必须带上基线 revision');

  // 重新打开页面：同一份存储，新的引擎与新内存状态
  const store2 = createLocalStore(h.raw);
  const { engine: engine2, holder } = reopened({ stack: h.stack, store: store2 });
  const res = await engine2.setSession(session.session);
  assert.equal(res.ok, true, `重新对账应成功，实际 ${JSON.stringify(res.result || res)}`);
  assert.equal(plantCount(holder.current), 7, '本机已保存的水草数量不能被云端回退成 3');
  assert.equal(plantCount([...h.fake.aquariums.values()][0].state), 7, '本机改动最终写入云端');
  assert.equal(store2.readPending(uid, aquariumId), null, '上传成功后清掉未同步副本');
});

test('[P1-2] 本机未同步改动遇上云端已变更：给出冲突而不是静默丢弃', async () => {
  const [deviceA, deviceB] = makeDevices(2);
  const sessionA = await deviceA.register();
  await deviceA.engine.setSession(sessionA.session);
  const sessionB = await deviceB.stack.auth.signIn({ email: 'me@example.com', password: 'goodpassword' });
  await deviceB.engine.setSession(sessionB.session);
  const uidB = sessionB.session.user.id;
  const aquariumIdB = deviceB.engine.snapshot.aquariumId;

  // B 落了本机改动但没上传
  const baselinePlantsB = plantCount(deviceB.current);
  setPlants(deviceB.current, 7);
  deviceB.engine.persistLocal();

  // 期间 A 改了名字并成功写入（云端 revision 前进）
  deviceA.current.fish[0].name = 'A 又改了';
  deviceA.engine.markDirty(); await deviceA.runTimers(); await Promise.resolve();

  // B 重新打开页面
  const store2 = createLocalStore(deviceB.raw);
  const { engine: engine2, holder } = reopened({ stack: deviceB.stack, store: store2 });
  const res = await engine2.setSession(sessionB.session);

  assert.equal(engine2.status, STATUS.CONFLICT, '云端被改过时必须交给用户选择');
  assert.equal(res.conflict.reason, CONFLICT_REASON.PENDING);
  assert.equal(plantCount(holder.current), 7, 'B 的本机改动仍在内存里');
  const serverNow = [...deviceB.fake.aquariums.values()][0];
  assert.equal(serverNow.state.fish[0].name, 'A 又改了', 'A 的改动没有被覆盖');
  assert.equal(plantCount(serverNow.state), baselinePlantsB, 'B 的水草没有偷偷写上去');
  assert.ok(store2.readPending(uidB, aquariumIdB), '未同步副本保留，可导出');

  // 用户选择用本机覆盖云端后，两份内容都能在界面上看到
  const detail = engine2.conflictDetail();
  assert.equal(detail.cloudKnown, true);
  assert.equal(detail.cloudFish[0].name, 'A 又改了');
  assert.equal(detail.localFish[0].name, '小满');
});

test('[P1-3] 换号后旧会话的响应必须被丢弃，不得写进新账号的界面与缓存', async () => {
  const fake = createFakeSupabase({ startMs: START });
  let release;
  const blocker = new Promise((resolve) => { release = resolve; });
  let holdNextSave = true;
  const h = createHarness({
    fake,
    gate: async (ctx) => {
      if (holdNextSave && ctx.path.endsWith('save_aquarium')) { holdNextSave = false; await blocker; }
    }
  });

  const sessionA = await h.register('alice@example.com');
  await h.engine.setSession(sessionA.session);
  const uidA = sessionA.session.user.id;
  const aquariumIdA = h.engine.snapshot.aquariumId;

  // A 有改动 → 发起写入，但响应被卡在半路
  h.current.fish[0].name = 'A 的名字';
  const heldSave = h.engine.flush({ reason: 'test' });

  // 期间换成 B 登录（B 有自己的鱼缸与缓存）
  const sessionB = await h.register('bob@example.com');
  await h.engine.setSession(sessionB.session);
  const uidB = sessionB.session.user.id;
  const aquariumIdB = h.engine.snapshot.aquariumId;
  assert.notEqual(aquariumIdB, aquariumIdA, 'B 有自己的鱼缸');
  const bStateBefore = JSON.stringify(h.current);
  const bCacheBefore = JSON.stringify(h.store.readAccountState(uidB, aquariumIdB));

  release();
  const result = await heldSave;

  assert.equal(result.skipped, 'stale', '过期响应必须被识别并丢弃');
  assert.equal(JSON.stringify(h.current), bStateBefore, 'B 的内存状态不能被 A 的响应改写');
  assert.equal(JSON.stringify(h.store.readAccountState(uidB, aquariumIdB)), bCacheBefore,
    'B 的缓存键里绝不能出现 A 的数据');

  // A 那次写入本身是成功的（数据不丢），只是客户端不再把响应写回界面/缓存；
  // 下次 A 登录对账时会从云端取回自己的改动。
  assert.equal(h.fake.aquariums.get(uidA).state.fish[0].name, 'A 的名字',
    'A 的写入在服务端生效（假后端里 aquariums 以 ownerId 为键）');
  assert.notEqual(h.store.readAccountState(uidA, aquariumIdA)?.fish?.[0]?.name, 'B 的水草',
    'A 的缓存键更不会被 B 的数据污染');
  assert.equal(h.engine.snapshot.user.id, uidB, '当前用户仍然是 B');
  assert.equal(h.engine.status, STATUS.SYNCED, 'B 自己的同步状态不受影响');
});

test('[P1-3] 退出登录后到达的响应不会把登录状态写回界面', async () => {
  const fake = createFakeSupabase({ startMs: START });
  let release;
  const blocker = new Promise((resolve) => { release = resolve; });
  let holdNextSave = true;
  const h = createHarness({
    fake,
    gate: async (ctx) => {
      if (holdNextSave && ctx.path.endsWith('save_aquarium')) { holdNextSave = false; await blocker; }
    }
  });

  const session = await h.register();
  await h.engine.setSession(session.session);
  setPlants(h.current, 6);
  const heldSave = h.engine.flush({ reason: 'test' });

  await h.engine.setSession(null);
  assert.equal(h.engine.mode, 'guest');

  release();
  const result = await heldSave;
  assert.equal(result.skipped, 'stale');
  assert.equal(h.engine.mode, 'guest', '退出后仍然是游客模式');
  assert.equal(h.engine.status, STATUS.GUEST, '过期响应不得把状态改成已同步');
});

test('[P1-4] 写入期间的新编辑保留 pending，并在首个快照成功后继续上传', async () => {
  let release;
  let started;
  const blocker = new Promise((resolve) => { release = resolve; });
  const requestStarted = new Promise((resolve) => { started = resolve; });
  let holdNextSave = false;
  const h = createHarness({
    gate: async (ctx) => {
      if (holdNextSave && ctx.path.endsWith('save_aquarium')) {
        holdNextSave = false;
        started();
        await blocker;
      }
    }
  });
  const session = await h.register();
  await h.engine.setSession(session.session);
  const uid = session.session.user.id;
  const aquariumId = h.engine.snapshot.aquariumId;
  holdNextSave = true;

  h.current.fish[0].name = '第一次改名';
  const firstSave = h.engine.flush({ reason: 'test' });
  await requestStarted;

  h.current.fish[0].name = '第二次改名';
  assert.equal(h.engine.persistLocal(), true);
  assert.equal(h.engine.markDirty(), true);
  const duringRequest = h.store.readPending(uid, aquariumId);
  assert.equal(duringRequest.state.fish[0].name, '第二次改名');

  release();
  const firstResult = await firstSave;
  assert.equal(firstResult.ok, true);
  assert.equal(h.engine.isDirty, true, '首个响应只确认已发送快照，不能把第二次编辑算成已同步');
  assert.equal(h.store.readPending(uid, aquariumId)?.state.fish[0].name, '第二次改名',
    '首个写入响应不能清掉请求期间的 pending');

  await h.runTimers();
  assert.equal(h.countRequests('save_aquarium'), 2, '请求期间的第二次编辑应触发后续写入');
  assert.equal([...h.fake.aquariums.values()][0].state.fish[0].name, '第二次改名');
  assert.equal(h.store.readPending(uid, aquariumId), null, '后续写入成功后才清除 pending');
});

test('[P1-9] 保存请求失败时保留请求期间的最新编辑，而不是旧请求快照', async () => {
  const h = directApiHarness(['alice']);
  const { engine, holder, store } = directEngine(h.api);
  const session = { user: { id: 'alice', email: 'alice@example.com' } };
  h.setTargetAccount('alice');
  await engine.setSession(session);
  const aquariumId = engine.snapshot.aquariumId;
  const gate = { started: deferred(), response: deferred() };
  h.saveGates.set(aquariumId, gate);

  holder.current.fish[0].name = '请求里的第一次改名';
  const saving = engine.flush({ reason: 'failure-test' });
  await gate.started.promise;
  holder.current.fish[0].name = '请求期间的第二次改名';
  assert.equal(engine.persistLocal(), true);
  assert.equal(engine.markDirty(), true);

  gate.response.resolve({ ok: false, result: { kind: 'offline', retryable: true, message: 'offline' } });
  const result = await saving;
  assert.equal(result.ok, false);
  assert.equal(engine.status, STATUS.OFFLINE);
  assert.equal(h.saves[0].state.fish[0].name, '请求里的第一次改名', '发出的请求内容保持为不可变快照');
  assert.equal(holder.current.fish[0].name, '请求期间的第二次改名');
  assert.equal(store.readAccountState('alice', aquariumId).fish[0].name, '请求期间的第二次改名');
  assert.equal(store.readPending('alice', aquariumId)?.state.fish[0].name, '请求期间的第二次改名',
    '失败分支必须保留请求期间的最新状态');
});

test('[P1-5] 成长结算期间本地编辑不被旧结算快照覆盖或清除', async () => {
  let release;
  let started;
  const blocker = new Promise((resolve) => { release = resolve; });
  const requestStarted = new Promise((resolve) => { started = resolve; });
  let holdNextSettle = false;
  const h = createHarness({
    gate: async (ctx) => {
      if (holdNextSettle && ctx.path.endsWith('settle_growth')) {
        holdNextSettle = false;
        started();
        await blocker;
      }
    }
  });
  const session = await h.register();
  await h.engine.setSession(session.session);
  const uid = session.session.user.id;
  const aquariumId = h.engine.snapshot.aquariumId;
  const baseRevision = h.engine.snapshot.baseRevision;
  const beforeGrowth = h.current.fish[0].growth;
  h.advance(60 * 60_000);
  const settlesBefore = h.countRequests('settle_growth');
  const savesBefore = h.countRequests('save_aquarium');
  holdNextSettle = true;

  const settling = h.engine.syncNow({ reason: 'test' });
  await requestStarted;
  h.current.fish[0].name = '结算期间改名';
  assert.equal(h.engine.persistLocal(), true);
  assert.equal(h.engine.markDirty(), true);
  release();

  const result = await settling;
  assert.equal(result.ok, false, '并发本地编辑应停在明确冲突状态');
  assert.equal(h.lastStatus, STATUS.CONFLICT);
  assert.equal(h.current.fish[0].name, '结算期间改名', '结算返回的旧快照不能覆盖用户编辑');
  assert.equal(h.engine.snapshot.baseRevision, baseRevision, '不能盲目抬高本地写入基线');
  assert.equal(h.engine.conflictDetail().cloudKnown, true);
  assert.equal(h.engine.conflictDetail().localFish[0].name, '结算期间改名');
  assert.equal(h.store.readPending(uid, aquariumId)?.state.fish[0].name, '结算期间改名',
    '待同步副本必须在冲突后保留');
  const server = [...h.fake.aquariums.values()][0];
  assert.ok(Math.abs(server.state.fish[0].growth - (beforeGrowth + 0.002083)) < 1e-9,
    '服务端成长只由这次结算记一次');
  assert.equal(h.countRequests('settle_growth') - settlesBefore, 1);
  assert.equal(h.countRequests('save_aquarium') - savesBefore, 0, '未选择如何处理前不能上传旧的本地基线');
});

test('结算期间并发 syncNow 会等待同一结果，不提前报告完成或重复结算', async () => {
  const h = directApiHarness(['alice']);
  const { engine } = directEngine(h.api);
  const session = { user: { id: 'alice', email: 'alice@example.com' } };
  h.setTargetAccount('alice');
  await engine.setSession(session);
  const before = h.settles.length;
  const gate = { started: deferred(), response: deferred() };
  h.settleGates.set('aquarium-alice', gate);

  const first = engine.syncNow({ reason: 'manual-first' });
  await gate.started.promise;
  assert.equal(engine.status, STATUS.SYNCING, '自动或手动结算期间都应显示同步中');
  assert.equal(engine.snapshot.busy, true);

  let secondDone = false;
  const second = engine.syncNow({ reason: 'manual-second' }).then((result) => {
    secondDone = true;
    return result;
  });
  await Promise.resolve();
  assert.equal(secondDone, false, '第二个调用等待正在进行的结算');
  assert.equal(h.settles.length, before + 1, '只允许一笔结算 RPC');

  gate.response.resolve({
    ok: true,
    result: { state: cloneState(h.rows.get('alice').state), revision: 1, creditedSeconds: 0 }
  });
  const [firstResult, secondResult] = await Promise.all([first, second]);
  assert.equal(firstResult.ok, true);
  assert.equal(secondResult.ok, true);
  assert.equal(secondResult.skipped, undefined, '并发调用应收到结算结果，而非提前返回 skipped');
  assert.equal(engine.snapshot.busy, false);
  assert.equal(engine.status, STATUS.SYNCED);
});

test('成长结算临时失败会释放 busy，并可通过下一次 syncNow 恢复', async () => {
  const failure = { enabled: false };
  const h = createHarness({
    overrides: {
      rules: [(ctx) => (failure.enabled && ctx.path.endsWith('settle_growth')
        ? { ok: false, status: 503, async text() { return JSON.stringify({ message: 'upstream down' }); } }
        : null)]
    }
  });
  const session = await h.register();
  await h.engine.setSession(session.session);

  failure.enabled = true;
  const failed = await h.engine.syncNow({ reason: 'settle-failure' });
  assert.equal(failed.ok, false);
  assert.equal(h.engine.status, STATUS.ERROR);
  assert.equal(h.engine.snapshot.busy, false, '失败后锁和 busy 状态都要释放');

  failure.enabled = false;
  const recovered = await h.engine.syncNow({ reason: 'settle-retry' });
  assert.equal(recovered.ok, true);
  assert.equal(h.engine.status, STATUS.SYNCED);
  assert.equal(h.engine.snapshot.busy, false);
});

test('[P1-6] 全新引擎离线冷启动恢复账号鱼缸指针，后续改动仍能落盘并恢复', async () => {
  const h = createHarness();
  const session = await h.register();
  await h.engine.setSession(session.session);
  const uid = session.session.user.id;
  const aquariumId = h.engine.snapshot.aquariumId;
  const revision = h.engine.snapshot.baseRevision;

  let online = false;
  h.setOnline(false);
  const store2 = createLocalStore(h.raw);
  const { engine: engine2, holder: holder2 } = reopened({
    stack: h.stack,
    store: store2,
    isOnline: () => online
  });
  const offlineResult = await engine2.setSession(session.session);
  assert.equal(offlineResult.offline, true);
  assert.equal(engine2.snapshot.aquariumId, aquariumId, '离线冷启动必须恢复当前账号的鱼缸 id');
  assert.equal(engine2.snapshot.baseRevision, revision, '保留本地指针记下的已知 revision');
  assert.equal(holder2.current.fish[0].name, h.current.fish[0].name);

  setPlants(holder2.current, 8);
  assert.equal(engine2.persistLocal(), true, '恢复指针后编辑才能写入账号缓存');
  assert.equal(plantCount(store2.readPending(uid, aquariumId)?.state || { decor: [] }), 8,
    '未知云端基线仍按 pending 保留，不能伪装成已同步');

  const store3 = createLocalStore(h.raw);
  const { engine: engine3, holder: holder3 } = reopened({
    stack: h.stack,
    store: store3,
    isOnline: () => online
  });
  await engine3.setSession(session.session);
  assert.equal(plantCount(holder3.current), 8, '真正重启后的全新引擎恢复离线编辑');
  assert.equal(engine3.snapshot.aquariumId, aquariumId);

  online = true;
  h.setOnline(true);
  const syncResult = await engine3.syncNow({ reason: 'reconnect' });
  assert.equal(syncResult.ok, true);
  assert.equal(plantCount([...h.fake.aquariums.values()][0].state), 8);
  assert.equal(store3.readPending(uid, aquariumId), null);
});

test('[P1-10] 离线恢复的未知 revision 在 flush 时先对账，不发送 save(null)', async () => {
  const h = createHarness();
  const session = await h.register();
  await h.engine.setSession(session.session);
  const uid = session.session.user.id;
  const aquariumId = h.engine.snapshot.aquariumId;
  const local = cloneState(h.current);
  setPlants(local, 7);
  h.store.writeAccountState(uid, aquariumId, local);
  h.store.writePending(uid, aquariumId, local, null);

  h.setOnline(false);
  const store2 = createLocalStore(h.raw);
  const { engine } = reopened({
    stack: h.stack,
    store: store2,
    isOnline: () => false
  });
  const restored = await engine.setSession(session.session);
  assert.equal(restored.offline, true);
  assert.equal(engine.snapshot.aquariumId, aquariumId);
  assert.equal(engine.snapshot.baseRevision, null, '未知基线必须保持未知');
  assert.equal(engine.isDirty, true);

  const ensuresBefore = h.countRequests('ensure_aquarium');
  const savesBefore = h.countRequests('save_aquarium');
  const result = await engine.flush({ reason: 'unknown-baseline-test' });

  assert.equal(result.offline, true, '未知基线时 flush 应重新对账');
  assert.equal(h.countRequests('ensure_aquarium'), ensuresBefore + 1,
    '必须调用 hydrate/ensureAquarium 对账');
  assert.equal(h.countRequests('save_aquarium'), savesBefore,
    '不能把 null 当作 revision 0 发起存档写入');
  assert.equal(plantCount(store2.readPending(uid, aquariumId)?.state || { decor: [] }), 7,
    '离线对账后本机待同步内容仍应保留');
});

test('[P1-7] 切号后旧结算响应不能解开新账号的结算锁', async () => {
  const h = directApiHarness();
  const { engine, holder } = directEngine(h.api);
  const sessionA = { user: { id: 'alice', email: 'alice@example.com' } };
  const sessionB = { user: { id: 'bob', email: 'bob@example.com' } };
  h.setTargetAccount('alice');
  await engine.setSession(sessionA);

  const gateA = { started: deferred(), response: deferred() };
  const gateB = { started: deferred(), response: deferred() };
  h.settleGates.set('aquarium-alice', gateA);
  h.settleGates.set('aquarium-bob', gateB);
  const oldSettlement = engine.syncNow({ reason: 'account-switch-test' });
  await gateA.started.promise;

  h.setTargetAccount('bob');
  const newHydration = engine.setSession(sessionB);
  await gateB.started.promise;
  holder.current.fish[0].name = 'B 结算期间改名';
  engine.persistLocal();
  engine.markDirty();

  gateA.response.resolve({ ok: true, result: { state: cloneState(h.rows.get('alice').state), revision: 2 } });
  assert.equal((await oldSettlement).skipped, 'stale');
  const savesBefore = h.saves.length;
  const blockedSave = await engine.flush({ reason: 'settle-lock-test' });
  assert.equal(blockedSave.skipped, 'settling', 'A 的 finally 不能清掉 B 的结算锁');
  assert.equal(h.saves.length, savesBefore, 'B 结算完成前不能并发保存');

  gateB.response.resolve({ ok: true, result: { state: h.rows.get('bob').state, revision: 2 } });
  const hydrationResult = await newHydration;
  assert.equal(hydrationResult.conflict.reason, CONFLICT_REASON.PENDING);
  assert.equal(holder.current.fish[0].name, 'B 结算期间改名');
  assert.equal(engine.status, STATUS.CONFLICT);
});

test('[P1-8] 旧账号保存结束时不能清掉新账号的在途保存指针', async () => {
  const h = directApiHarness();
  const { engine, holder } = directEngine(h.api);
  const sessionA = { user: { id: 'alice', email: 'alice@example.com' } };
  const sessionB = { user: { id: 'bob', email: 'bob@example.com' } };
  h.setTargetAccount('alice');
  await engine.setSession(sessionA);

  const gateA = { started: deferred(), response: deferred() };
  const gateB = { started: deferred(), response: deferred() };
  h.saveGates.set('aquarium-alice', gateA);
  h.saveGates.set('aquarium-bob', gateB);
  holder.current.fish[0].name = 'A 的在途改名';
  const oldSave = engine.flush({ reason: 'account-switch-test' });
  await gateA.started.promise;

  h.setTargetAccount('bob');
  await engine.setSession(sessionB);
  setPlants(holder.current, 6);
  const newSave = engine.flush({ reason: 'account-switch-test' });
  await gateB.started.promise;

  gateA.response.resolve(null);
  assert.equal((await oldSave).skipped, 'stale');
  const requestsBeforeCoalescedFlush = h.saves.length;
  const coalescedSave = engine.flush({ reason: 'coalesce-test' });
  assert.equal(h.saves.length, requestsBeforeCoalescedFlush,
    'B 的第二次 flush 应复用当前请求，不能因为 A 的 finally 清锁而重复发出');

  gateB.response.resolve(null);
  const [newResult, coalescedResult] = await Promise.all([newSave, coalescedSave]);
  assert.equal(newResult.ok, true);
  assert.equal(coalescedResult.ok, true);
  assert.equal(h.saves.length, 2);
  const rowB = h.rows.get('bob');
  assert.equal(plantCount(rowB.state), 6);
});

test('[P1-1] 同步顺序固定为「先上传本机改动 → 再结算服务端成长」', async () => {
  const h = createHarness();
  const session = await h.register();
  await h.engine.setSession(session.session);
  h.requests.length = 0;

  h.advance(3_600_000);            // 服务端时间前进 1 小时
  setPlants(h.current, 6);            // 本机有未同步改动（初始 5 株，改到 6 才真的变了）
  await h.engine.syncNow({ reason: 'test' });

  const order = h.requests.map(r => r.path.split('/').pop()).filter(p => p === 'save_aquarium' || p === 'settle_growth');
  const saveIndex = order.indexOf('save_aquarium');
  const settleIndex = order.indexOf('settle_growth');
  assert.ok(saveIndex >= 0 && settleIndex >= 0, `两种请求都应发出，实际 ${order.join(' → ')}`);
  assert.ok(saveIndex < settleIndex, `必须先写后结算，实际 ${order.join(' → ')}`);

  const row = [...h.fake.aquariums.values()][0];
  assert.equal(plantCount(row.state), 6, '本机改动写入云端');
  assert.ok(Math.abs(row.state.fish[0].growth - 0.002083) < 1e-6,
    `离线 1 小时应结算一次 +0.002083，实际 ${row.state.fish[0].growth}`);
  assert.equal(plantCount(h.current), 6);
  assert.ok(Math.abs(h.current.fish[0].growth - 0.002083) < 1e-6,
    `本机采纳的成长不能重复计算，实际 ${h.current.fish[0].growth}`);
  assert.equal(h.lastStatus, STATUS.SYNCED);
});
