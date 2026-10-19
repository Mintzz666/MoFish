// Extra Phase B HTTP checks. Called only after the parent smoke runner has
// created its own temporary accounts; never accepts an existing user's identity.
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual as equal } from 'node:util';
import { validate, addDecor, cloneState, GROWTH } from '../web/model.js';
import { createSyncEngine, STATUS } from '../web/cloud/sync.js';
import { createLocalStore } from '../web/storage.js';

// Keep existing A bindings intact. B never falls back to A's public config or
// admin credential, even when both sets are present in a managed environment.
export function phaseBEnvironment(env) {
  return { ...env,
    MOFISH_SUPABASE_URL: env.MOFISH_B_SUPABASE_URL || '',
    MOFISH_SUPABASE_ANON_KEY: env.MOFISH_B_SUPABASE_ANON_KEY || '',
    MOFISH_SMOKE_SERVICE_ROLE_KEY: env.MOFISH_B_SMOKE_SERVICE_ROLE_KEY || '',
    MOFISH_SMOKE_EXPECTED_PROJECT_REF: env.MOFISH_B_PROJECT_REF || ''
  };
}

export function checkPhaseBTarget(url, expectedRef) {
  const ref = String(expectedRef || '').trim();
  const target = new URL(url);
  if (!/^[a-z0-9]{20}$/.test(ref) || target.origin !== `https://${ref}.supabase.co`
    || target.username || target.password || target.pathname !== '/' || target.search || target.hash) {
    throw new Error('B 联调需要 MOFISH_B_PROJECT_REF 精确匹配独立测试项目 HTTPS 根地址');
  }
  if (ref === 'jxqlzuvpuaqwcdvgxnle') {
    throw new Error('B 联调拒绝现有 A 项目；请使用独立测试项目');
  }
}

const denied = response => response?.ok === false && [401, 403].includes(response.status)
  && response.body?.code === '42501';
const near = (a, b) => Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) < 0.000002;

export async function runPhaseBChecks({ apiA, apiA2, apiB, initialRow, call, accessToken, sessionA, sessionB, registerAquarium, requireCheck }) {
  const id = initialRow.aquarium_id;
  const oldState = initialRow.state_json;
  const upgraded = addDecor(validate(oldState), 'rock', 'seiryu', 20261019).state;
  const decor = upgraded.decor.at(-1);
  Object.assign(decor, { x: 0.25, z: 0.72, rot: 0.85, scale: 1.1 });
  requireCheck(oldState.fish.every((fish, i) => ['id', 'name', 'born', 'growth', 'meals']
    .every(key => upgraded.fish[i][key] === fish[key])), 'B：v1 升级保留鱼的身份、名字、年龄、成长和进食');

  const saved = await apiA.saveAquarium({ aquariumId: id, expectedRevision: Number(initialRow.revision), state: upgraded, stateVersion: 2 });
  requireCheck(saved.ok && Number(saved.row?.revision) === Number(initialRow.revision) + 1, 'B：v1→v2 升级及造景保存成功');
  let current = await apiA2.ensureAquarium(upgraded, 2);
  requireCheck(current.ok && current.row?.aquarium_id === id && equal(current.row.state_json, upgraded),
    'B：独立会话恢复相同鱼、外观种子、造景位置/旋转/缩放');

  const stale = await apiA2.saveAquarium({ aquariumId: id, expectedRevision: Number(initialRow.revision), state: upgraded, stateVersion: 2 });
  requireCheck(!stale.ok && stale.row?.status === 'conflict', 'B：旧 revision 的 v2 写入产生冲突');
  const malformed = cloneState(upgraded);
  malformed.decor[0].x = 1.5;
  const bad = await apiA.saveAquarium({ aquariumId: id, expectedRevision: Number(current.row.revision), state: malformed, stateVersion: 2 });
  requireCheck(!bad.ok && bad.row?.status === 'invalid_state', 'B：服务端拒绝越界造景');
  const crossSave = await apiB.saveAquarium({ aquariumId: id, expectedRevision: Number(current.row.revision), state: upgraded, stateVersion: 2 });
  requireCheck(!crossSave.ok && crossSave.row?.status === 'not_found', 'B：另一个账号不能写入 v2 鱼缸');

  const fish = upgraded.fish[0];
  const operationId = randomUUID();
  const pair = await Promise.all([
    apiA.recordFeeding(id, operationId, fish.id, 1),
    apiA2.recordFeeding(id, operationId, fish.id, 1)
  ]);
  requireCheck(pair.every(item => item.ok) && pair.filter(item => item.row?.duplicate === true).length === 1,
    'B：双会话并发重放同一进食事件，仅一条新记录');
  const unchanged = await apiA.ensureAquarium(upgraded, 2);
  requireCheck(unchanged.ok && Number(unchanged.row?.revision) === Number(current.row.revision)
    && equal(unchanged.row.state_json, upgraded), 'B：进食入账不直接修改成长、meals 或 revision');
  const mismatch = await apiA.recordFeeding(id, operationId, fish.id, 2);
  requireCheck(!mismatch.ok && mismatch.row?.status === 'invalid_argument'
    && mismatch.row.error_code === 'operation_mismatch', 'B：同一 operation_id 的不同载荷被拒绝');
  const missing = await apiA.recordFeeding(id, randomUUID(), `missing-${randomUUID()}`, 1);
  requireCheck(!missing.ok && missing.row?.status === 'not_found', 'B：不存在的鱼不能记进食');
  const crossFeed = await apiB.recordFeeding(id, randomUUID(), fish.id, 1);
  requireCheck(!crossFeed.ok && crossFeed.row?.status === 'not_found', 'B：另一个账号不能给当前鱼缸记进食');

  const anonFeed = await call('/rest/v1/rpc/record_feeding', {
    method: 'POST', body: { p_id: id, p_operation_id: randomUUID(), p_fish_id: fish.id, p_bites: 1 }
  });
  requireCheck(denied(anonFeed), 'B：匿名没有进食 RPC 执行权');
  for (const method of ['GET', 'POST', 'PATCH', 'DELETE']) {
    const response = await call(`/rest/v1/mofish_feed_events?aquarium_id=eq.${encodeURIComponent(id)}`, {
      method, token: accessToken,
      ...(method === 'GET' || method === 'DELETE' ? {} : {
        body: method === 'PATCH' ? { credited: 8 } : { aquarium_id: id, operation_id: randomUUID(), fish_id: fish.id, bites: 1 }
      })
    });
    requireCheck(denied(response), `B：已登录客户端无事件表 ${method} 权限`);
  }

  // A zero time cap isolates nutrition deterministically, without modifying the
  // database clock or directly backdating any user's rows. Only this test's fish
  // is involved. Other SQL tests separately verify real 24h rollover and caps.
  const first = await apiA.settleGrowth(id, 0);
  requireCheck(first.ok && first.row?.credited_seconds === 0 && first.row.state_json.fish[0].meals === fish.meals + 1
    && near(first.row.state_json.fish[0].growth, fish.growth + GROWTH.biteGrowth),
    'B：服务端结算一口营养，重复事件不重复增加 meals');
  const replay = await apiA2.recordFeeding(id, operationId, fish.id, 1);
  requireCheck(replay.ok && replay.row?.duplicate === true, 'B：已结算事件重放仍然幂等');
  for (let i = 0; i < 3; i += 1) {
    const fed = await apiA.recordFeeding(id, randomUUID(), fish.id, 1);
    requireCheck(fed.ok, `B：第 ${i + 2} 口进食记录被接受`);
  }
  const limited = await apiA.settleGrowth(id, 0);
  requireCheck(limited.ok && limited.row?.state_json.fish[0].meals === fish.meals + 4
    && near(limited.row.state_json.fish[0].growth, fish.growth + GROWTH.nutritionPerDay),
    'B：四口记互动、仅前三口加营养（滚动 24h 上限）');
  const repeated = await apiA2.settleGrowth(id, 0);
  requireCheck(repeated.ok && Number(repeated.row?.revision) === Number(limited.row.revision)
    && equal(repeated.row.state_json, limited.row.state_json), 'B：没有新增时间/进食时不写库、不推进 revision');

  await new Promise(resolve => setTimeout(resolve, 1100));
  const timed = await apiA.settleGrowth(id);
  const seconds = Number(timed.row?.credited_seconds);
  const expectedGrowth = Math.round((repeated.row.state_json.fish[0].growth
    + seconds * GROWTH.naturalPerDay / 86400) * 1e6) / 1e6;
  requireCheck(timed.ok && seconds >= 1 && seconds <= 86400
    && Math.abs(timed.row.state_json.fish[0].growth - expectedGrowth) < 1e-8,
    'B：服务端自然成长使用 v2 的 0.05/24h 速率');
  current = await apiA2.ensureAquarium(upgraded, 2);
  requireCheck(current.ok && equal(current.row?.state_json, timed.row.state_json)
    && equal(current.row.state_json.decor, upgraded.decor), 'B：另一会话恢复结算结果，外观与造景保持不变');
  await runClientChecks({ apiA, apiA2, apiB, sessionA, sessionB, id, state: current.row.state_json, registerAquarium, requireCheck });
}

async function runClientChecks({ apiA, apiA2, apiB, sessionA, sessionB, id, state, registerAquarium, requireCheck }) {
  const data = new Map(), timers = new Map(), engines = [];
  const raw = {
    get length() { return data.size; }, key: i => [...data.keys()][i] ?? null,
    getItem: key => data.get(key) ?? null, setItem: (key, value) => data.set(key, value),
    removeItem: key => data.delete(key)
  };
  const store = createLocalStore(raw);
  let current = cloneState(state), online = true, activeApi = apiA, timerId = 0;
  const api = new Proxy({}, { get: (_target, key) => key === 'configured' ? true : (...args) => online
    ? activeApi[key](...args) : Promise.resolve({ ok: false, result: { kind: 'network_error', retryable: true } }) });
  const makeEngine = () => {
    const engine = createSyncEngine({ api, store, getState: () => current,
      setState: value => { current = value; }, initialState: () => cloneState(state),
      isOnline: () => online,
      setTimeoutFn: fn => { const token = ++timerId; timers.set(token, fn); return token; },
      clearTimeoutFn: token => timers.delete(token)
    });
    engines.push(engine);
    return engine;
  };
  try {
    let engine = makeEngine();
    const hydrated = await engine.setSession(sessionA);
    requireCheck(hydrated.ok && engine.status === STATUS.SYNCED, 'B：生产同步引擎恢复临时账号');
    online = false;
    engine.handleOffline();
    current.fish[0].name = '离线布景鱼';
    current.decor[0].x = 0.37;
    engine.markDirty();
    const growthBefore = current.fish[0].growth;
    engine.queueFeed(current.fish[0].id, 1);
    const queue = store.readFeeds(sessionA.user.id, id);
    requireCheck(engine.pendingFeeds === 1 && queue.length === 1 && current.fish[0].growth === growthBefore,
      'B：程序模拟断网时进食落盘、客户端不加成长');
    engine.dispose();
    engine = makeEngine();
    await engine.setSession(sessionA);
    requireCheck(engine.pendingFeeds === 1 && current.fish[0].name === '离线布景鱼' && current.decor[0].x === 0.37,
      'B：程序模拟离线重启保留进食队列与造景');
    online = true;
    const reconnected = await engine.syncNow({ reason: 'smoke-reconnect' });
    requireCheck(reconnected.ok && engine.pendingFeeds === 0 && engine.status === STATUS.SYNCED,
      'B：模拟重连后存档、进食重放与服务端结算完成');
    let remote = await apiA2.ensureAquarium(state, 2);
    requireCheck(remote.ok && remote.row.state_json.fish[0].name === '离线布景鱼'
      && remote.row.state_json.decor[0].x === 0.37 && equal(remote.row.state_json, current),
      'B：另一真实 API 会话读到离线修改与服务端成长');
    const replay = await apiA2.recordFeeding(id, queue[0].op, current.fish[0].id, 1);
    requireCheck(replay.ok && replay.row?.duplicate === true, 'B：已确认的离线队列重放不会重复记进食');

    online = false;
    engine.handleOffline();
    current.fish[0].name = '离线冲突副本';
    engine.markDirty();
    const other = cloneState(remote.row.state_json);
    other.fish[0].name = '另一会话新版';
    const changed = await apiA2.saveAquarium({ aquariumId: id, expectedRevision: Number(remote.row.revision), state: other, stateVersion: 2 });
    requireCheck(changed.ok, 'B：另一会话写入 v2 新版本');
    online = true;
    await engine.syncNow({ reason: 'smoke-conflict' });
    requireCheck(engine.status === STATUS.CONFLICT, 'B：模拟离线修改遇到云端新版时保留冲突');
    const resolved = await engine.resolveConflict('cloud');
    requireCheck(resolved.ok && current.fish[0].name === '另一会话新版'
      && store.listBackups(sessionA.user.id, id).some(item => item.state.fish[0].name === '离线冲突副本'),
      'B：选择云端后保留本地 v2 冲突备份');

    const candidateB = cloneState(state);
    candidateB.fish[0].id = `account-b-${randomUUID()}`;
    candidateB.fish[0].name = 'B账号隔离鱼';
    const b = await apiB.ensureAquarium(candidateB, 2);
    requireCheck(b.ok && b.row?.aquarium_id !== id, 'B：第二临时账号拥有独立 v2 鱼缸');
    registerAquarium?.(sessionB.user.id, b.row.aquarium_id);
    await engine.setSession(null);
    activeApi = apiB;
    const switched = await engine.setSession(sessionB);
    requireCheck(switched.ok && engine.snapshot.aquariumId === b.row.aquarium_id
      && current.fish[0].name === 'B账号隔离鱼' && engine.pendingFeeds === 0,
      'B：退出换号后不带入上一账号的造景修改或进食队列');
    remote = await apiA2.ensureAquarium(state, 2);
    requireCheck(remote.ok && remote.row.state_json.fish[0].name === '另一会话新版',
      'B：换号后原临时账号存档保持独立');
  } finally {
    engines.forEach(engine => engine.dispose());
    timers.clear();
    data.clear();
  }
}
