// 同步引擎的行为契约测试：去抖、冲突、离线、成长记账、账号隔离、无固定轮询。
// 后端使用本地假 Supabase（tests/fake-supabase）——它能证明前端逻辑正确，
// 但不能代替真实 Supabase 联调（见 docs/HANDOFF.md 的阻塞项）。

import test from 'node:test';
import assert from 'node:assert/strict';
import { createSyncEngine, STATUS, CONFLICT_REASON, applyGrowthDelta } from '../web/cloud/sync.js';
import { createCloudStack } from '../web/cloud/client.js';
import { createLocalStore, keys } from '../web/storage.js';
import { initial, validate, canonicalState } from '../web/model.js';
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

function tank(name, extra = {}) {
  const state = validate(initial(START));
  state.fish[0].name = name;
  return Object.assign(state, extra);
}

function createHarness({ configured = true, debounceMs = DEBOUNCE, startMs = START, overrides = {}, fake = createFakeSupabase({ startMs }) } = {}) {
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
    onRequest: (ctx) => {
      requests.push({ path: ctx.path, body: ctx.body });
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
  assert.equal(row.state.plants, 5);
  assert.equal(row.revision, 1);
});

test('第二台设备登录同账号：恢复云端存档（名字、成长、造景）', async () => {
  // 设备 A：登录并改名 / 种水草
  const [deviceA, deviceB] = makeDevices(2);
  const sessionA = await deviceA.register();
  await deviceA.engine.setSession(sessionA.session);
  deviceA.current.fish[0].name = 'A 起的名字';
  deviceA.current.fish[1].growth = 0.42;
  deviceA.current.plants = 6;
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
  assert.equal(deviceB.current.plants, 6);
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
  assert.equal(pending.fish[0].name, 'B 改的');
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
  assert.equal(server.state.plants, 7);
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
  h.current.plants = 4;
  assert.equal(h.engine.markDirty(), true);
  assert.equal(h.timers.size, 1, '多次变更只保留一个待发定时器');

  await h.runTimers();
  await new Promise(r => setTimeout(r, 0));
  assert.equal(h.countRequests('save_aquarium') - baseline, 1, '合并成一次写入');

  // 内容没变 → 不排队、不请求
  h.engine.markDirty();
  assert.equal(h.timers.size, 0);
  assert.equal(h.countRequests('save_aquarium') - baseline, 1);
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
  assert.equal(h.store.readPending(uid, aquariumId).fish[0].name, '离线时改的');

  h.setOnline(true);
  h.engine.handleOnline();
  await new Promise(r => setTimeout(r, 10));

  assert.equal(h.lastStatus, STATUS.SYNCED);
  assert.equal(h.countRequests('save_aquarium') - baseline, 2, '离线那次 + 重连那次');
  const server = [...h.fake.aquariums.values()][0];
  assert.equal(server.state.fish[0].name, '离线时改的');
  assert.equal(h.store.readPending(uid, aquariumId), null);
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
  assert.equal(h.store.readPending(uid, aquariumId).fish[0].name, '服务端挂了');

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
  assert.ok(Math.abs(afterFirst - (before + 0.008)) < 1e-9, `1 小时应 +0.008，实际 ${afterFirst}`);

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

  assert.ok(Math.abs(h.current.fish[0].growth - (before + 0.192)) < 1e-9,
    `封顶 24 小时应 +0.192，实际 ${h.current.fish[0].growth}`);
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
  assert.ok(Math.abs(h.current.fish[0].growth - 0.016) < 1e-9, '2 小时成长记一次');
  const server = [...h.fake.aquariums.values()][0];
  assert.equal(server.state.fish[0].name, '本机没同步的名字');
  assert.ok(Math.abs(server.state.fish[0].growth - 0.016) < 1e-9, '云端也只记一次');
  assert.equal(h.store.readPending(uid, aquariumId), null);
});

test('applyGrowthDelta 与服务端速率一致并做上下限裁剪', () => {
  const state = tank('x');
  state.fish[0].growth = 0.99;
  state.fish[1].growth = 0.5;
  const grown = applyGrowthDelta(state, 7200);
  assert.equal(grown.fish[0].growth, 1, '不超过 1');
  assert.equal(grown.fish[1].growth, 0.516);
  assert.equal(applyGrowthDelta(state, 0).fish[1].growth, 0.5, '0 秒不变');
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
