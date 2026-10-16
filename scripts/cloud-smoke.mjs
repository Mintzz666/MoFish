// Real Supabase smoke test for Phase A. It creates uniquely named temporary accounts
// with the service role key, exercises the app's auth-js facade and database API, then
// verifies that every account it created was deleted. It never reuses a supplied user.

import { randomBytes, randomUUID } from 'node:crypto';
import { loadEnvFile } from 'node:process';
import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { createAuthClient } from '../web/cloud/auth.js';
import { createCloudApi } from '../web/cloud/api.js';

const DEFAULT_TIMEOUT_MS = 12_000;

class SmokeError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SmokeError';
  }
}

/**
 * Read-only result classifiers are exported so regressions can prove that transport
 * errors are not mistaken for RLS success.
 */
export function isEmptyReadSuccess(response) {
  return response?.ok === true && response.status === 200 &&
    Array.isArray(response.body) && response.body.length === 0;
}

export function isPermissionDenied(response) {
  return response?.ok === false && [401, 403].includes(response.status) &&
    response.body?.code === '42501';
}

function isConfirmedMissingUser(response) {
  if (response?.status !== 404) return false;
  const body = response.body || {};
  const message = String(body.msg || body.message || body.error_description || '').trim();
  return body.error_code === 'user_not_found' || body.code === 'user_not_found' ||
    /^user not found$/i.test(message);
}

function isAnonymousReadDenied(response) {
  return isEmptyReadSuccess(response) || isPermissionDenied(response);
}

function projectUrl(url) {
  return String(url).replace(/\/+$/, '');
}

/** Authenticated reads must succeed with a real empty PostgREST result for an RLS-hidden row. */
export async function checkCrossAccountRowRead({
  fetchImpl = globalThis.fetch,
  url,
  anonKey,
  accessToken,
  aquariumId,
  timeoutMs = DEFAULT_TIMEOUT_MS
} = {}) {
  const response = await request(fetchImpl,
    `${projectUrl(url)}/rest/v1/aquariums?select=id,owner_id&id=eq.${encodeURIComponent(aquariumId)}`,
    { token: accessToken, apiKey: anonKey, timeoutMs });
  return { ok: isEmptyReadSuccess(response), status: response.status };
}

/** Table-level writes must be rejected by PostgreSQL permissions, not silently ignored. */
export async function checkTableWriteDenied({
  fetchImpl = globalThis.fetch,
  url,
  anonKey,
  accessToken,
  aquariumId,
  method,
  state,
  timeoutMs = DEFAULT_TIMEOUT_MS
} = {}) {
  if (method !== 'PATCH' && method !== 'DELETE') throw new TypeError('method must be PATCH or DELETE');
  const response = await request(fetchImpl,
    `${projectUrl(url)}/rest/v1/aquariums?id=eq.${encodeURIComponent(aquariumId)}`,
    {
      method,
      token: accessToken,
      apiKey: anonKey,
      body: method === 'PATCH' ? { state_json: state } : undefined,
      headers: { Prefer: 'return=representation' },
      timeoutMs
    });
  return { ok: isPermissionDenied(response), status: response.status, code: response.body?.code || null };
}

function readConfig(env) {
  const rawUrl = String(env.MOFISH_SUPABASE_URL || '').trim();
  const anonKey = String(env.MOFISH_SUPABASE_ANON_KEY || '').trim();
  const serviceKey = String(env.MOFISH_SMOKE_SERVICE_ROLE_KEY || '').trim();
  if (!rawUrl || !anonKey) throw new SmokeError('需要 MOFISH_SUPABASE_URL 与 MOFISH_SUPABASE_ANON_KEY');
  if (!serviceKey) {
    throw new SmokeError('真实联调只支持自动创建的临时账号；需要 MOFISH_SMOKE_SERVICE_ROLE_KEY，不接受既有账号凭据');
  }
  if (!isLegacyServiceRoleJwt(serviceKey)) {
    throw new SmokeError('MOFISH_SMOKE_SERVICE_ROLE_KEY 必须是 role=service_role 的 JWT；opaque sb_secret_* 暂不支持');
  }

  let parsed;
  try { parsed = new URL(rawUrl); } catch { throw new SmokeError('Supabase 项目地址格式无效'); }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.search || parsed.hash || parsed.pathname !== '/') {
    throw new SmokeError('项目地址必须是纯 HTTPS 根地址（不含路径、查询参数或内嵌凭据）');
  }
  return { url: parsed.origin, anonKey, serviceKey, target: parsed.host };
}

function isLegacyServiceRoleJwt(key) {
  const parts = String(key).split('.');
  if (parts.length !== 3 || !parts.every(Boolean)) return false;
  try {
    const claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    return claims?.role === 'service_role' && Number.isFinite(Number(claims.exp)) &&
      Number(claims.exp) > Math.floor(Date.now() / 1000);
  } catch {
    return false;
  }
}

function parseJson(text) {
  if (!text) return null;
  try { return JSON.parse(text); } catch { return null; }
}

/**
 * Bound both waiting for response headers and consuming the response body. Returning a
 * buffered Response keeps auth-js behavior intact while ensuring a stalled body cannot
 * hang the smoke run indefinitely.
 */
async function boundedResponse(fetchImpl, input, init = {}, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const controller = new AbortController();
  const signal = init.signal ? AbortSignal.any([init.signal, controller.signal]) : controller.signal;
  let timer;
  const work = (async () => {
    const response = await fetchImpl(input, { ...init, signal });
    const body = await response.text();
    return new Response(body || null, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers
    });
  })();
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      const error = new Error('Request timed out');
      error.name = 'TimeoutError';
      reject(error);
    }, timeoutMs);
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

async function request(fetchImpl, targetUrl, {
  method = 'GET', token, apiKey, body, headers = {}, timeoutMs = DEFAULT_TIMEOUT_MS
} = {}) {
  const requestHeaders = {
    apikey: apiKey,
    Accept: 'application/json',
    ...headers
  };
  if (token) requestHeaders.Authorization = `Bearer ${token}`;
  if (body !== undefined) requestHeaders['Content-Type'] = 'application/json';
  try {
    const response = await boundedResponse(fetchImpl, targetUrl, {
      method,
      headers: requestHeaders,
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    }, timeoutMs);
    return {
      status: response.status,
      ok: response.ok,
      body: parseJson(await response.text())
    };
  } catch (error) {
    return { status: 0, ok: false, body: null, errorName: error?.name || 'FetchError' };
  }
}

function makeSessionStore() {
  let session = null;
  return {
    readSession: () => session,
    writeSession: (next) => { session = next; },
    clearSession: () => { session = null; }
  };
}

function validState(name, fishId) {
  const now = Date.now();
  return {
    version: 1,
    fish: [{ id: fishId, name, species: 0, born: now, growth: 0, meals: 0 }],
    plants: 3,
    night: false,
    sound: false,
    savedAt: now
  };
}

function apiFor(auth, { url, anonKey, fetchImpl }) {
  return createCloudApi({
    url,
    anonKey,
    fetchImpl,
    getAccessToken: async () => {
      const current = await auth.getSession({ allowRefresh: false });
      return current.session?.access_token || null;
    },
    refreshAccessToken: async () => {
      const refreshed = await auth.refresh();
      return refreshed.ok ? refreshed.session.access_token : null;
    },
    timeoutMs: DEFAULT_TIMEOUT_MS
  });
}

function sessionMatches(result, account) {
  return result?.ok === true && result.session?.user?.id === account.id &&
    typeof result.session.access_token === 'string' && result.session.access_token.length > 0 &&
    typeof result.session.refresh_token === 'string' && result.session.refresh_token.length > 0;
}

/**
 * Run the real-cloud smoke test. fetchImpl and logger are injectable for focused local
 * regressions; a fake fetch result is never reported as a real cloud verification.
 */
export async function runCloudSmoke({
  env = process.env,
  fetchImpl = globalThis.fetch,
  logger = console,
  timeoutMs = DEFAULT_TIMEOUT_MS
} = {}) {
  const results = [];
  const created = [];
  let config = null;
  const record = (ok, name, detail = '') => {
    const result = { ok, name, detail };
    results.push(result);
    logger.log(`${ok ? '✅' : '❌'} ${name}${detail ? ` — ${detail}` : ''}`);
    return ok;
  };
  const requireCheck = (ok, name, detail = '') => {
    if (!record(ok, name, detail)) throw new SmokeError(name);
  };
  const call = (path, { method = 'GET', token, apiKey, body, headers } = {}) => request(
    fetchImpl,
    `${config.url}${path}`,
    { method, token, apiKey: apiKey ?? config.anonKey, body, headers, timeoutMs }
  );
  const rpc = async (name, args, token) => {
    const response = await call(`/rest/v1/rpc/${name}`, { method: 'POST', token, body: args });
    const row = Array.isArray(response.body) ? response.body[0] : response.body;
    return { ...response, row };
  };

  async function createAccount(label) {
    const idSuffix = randomUUID();
    const email = `mofish-smoke-${idSuffix}-${label}@example.com`;
    const password = `${randomBytes(36).toString('base64url')}Aa1!`;
    const response = await call('/auth/v1/admin/users', {
      method: 'POST',
      token: config.serviceKey,
      apiKey: config.serviceKey,
      body: { email, password, email_confirm: true }
    });
    if (!response.ok) throw new SmokeError(`创建临时账号失败（HTTP ${response.status || '请求超时'}）`);
    const id = typeof response.body?.id === 'string' ? response.body.id : '';
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
      throw new SmokeError('创建临时账号的响应缺少有效 ID，已停止联调');
    }
    // A successful admin create call can only create the unique email generated above;
    // record its ID immediately so finally can clean it even if later validation fails.
    created.push({ id, email });
    if (String(response.body?.email || '').toLowerCase() !== email.toLowerCase()) {
      throw new SmokeError('临时账号响应与本次生成的邮箱不匹配');
    }
    return { id, email, password };
  }

  function makeDevice() {
    const store = makeSessionStore();
    const auth = createAuthClient({
      url: config.url,
      anonKey: config.anonKey,
      fetchImpl: (input, init) => boundedResponse(fetchImpl, input, init, timeoutMs),
      store
    });
    return { auth, api: apiFor(auth, { url: config.url, anonKey: config.anonKey, fetchImpl }) };
  }

  try {
    config = readConfig(env);
    if (typeof fetchImpl !== 'function') throw new SmokeError('当前 Node 环境没有可用的 fetch');
    logger.log(`目标 Supabase 项目：${config.target}（只创建临时账号；密钥不会打印）\n`);

    const accountA = await createAccount('a');
    const accountB = await createAccount('b');
    requireCheck(true, '创建两个本轮专用临时测试账号');

    const deviceA = makeDevice();
    const deviceA2 = makeDevice();
    const deviceB = makeDevice();
    const loginA = await deviceA.auth.signIn({ email: accountA.email, password: accountA.password });
    requireCheck(sessionMatches(loginA, accountA), '设备 A 通过官方 auth-js 登录临时账号');

    const refreshedA = await deviceA.auth.refresh();
    requireCheck(sessionMatches(refreshedA, accountA), '设备 A 使用 refresh token 恢复会话');
    const checkedA = await deviceA.auth.getUser(refreshedA.session.access_token);
    requireCheck(checkedA.ok && checkedA.data?.id === accountA.id, '刷新后的会话可向 Auth 确认身份');

    const loginA2 = await deviceA2.auth.signIn({ email: accountA.email, password: accountA.password });
    requireCheck(sessionMatches(loginA2, accountA), '第二设备建立同账号独立会话');

    const loginB = await deviceB.auth.signIn({ email: accountB.email, password: accountB.password });
    requireCheck(sessionMatches(loginB, accountB), '另一个临时账号通过官方 auth-js 登录');

    const initialState = validState('云端冒烟鱼', `smoke-${randomUUID()}`);
    const ensuredA = await deviceA.api.ensureAquarium(initialState, 1);
    const initialRow = ensuredA.row;
    const aquariumId = initialRow?.aquarium_id;
    requireCheck(ensuredA.ok && initialRow?.status === 'ok' && initialRow.created === true &&
      typeof aquariumId === 'string' && Number(initialRow.revision) >= 1,
    '临时账号 A 首次开缸（created=true）', `HTTP ${ensuredA.ok ? 200 : ensuredA.status || 0}`);

    const restored = await deviceA2.api.ensureAquarium(validState('这份候选存档不会覆盖云端', `candidate-${randomUUID()}`), 1);
    requireCheck(restored.ok && restored.row?.status === 'ok' && restored.row.created === false &&
      restored.row.aquarium_id === aquariumId &&
      isDeepStrictEqual(restored.row.state_json, initialState),
    '第二设备恢复同账号鱼缸且不覆盖已有云端存档');

    let revision = Number(restored.row.revision);
    const updatedState = validState('A 设备保存的鱼', `smoke-${randomUUID()}`);
    const saved = await deviceA.api.saveAquarium({
      aquariumId,
      expectedRevision: revision,
      state: updatedState,
      stateVersion: 1
    });
    requireCheck(saved.ok && saved.row?.status === 'ok' && Number(saved.row.revision) === revision + 1,
      'A 设备保存成功并推进 revision');
    revision = Number(saved.row.revision);

    const stale = await deviceA.api.saveAquarium({
      aquariumId,
      expectedRevision: revision - 1,
      state: validState('过期写入', `stale-${randomUUID()}`),
      stateVersion: 1
    });
    requireCheck(!stale.ok && stale.row?.status === 'conflict' && Number(stale.row.revision) === revision,
      '旧 revision 写入返回冲突');

    const crossRpc = await deviceB.api.saveAquarium({
      aquariumId,
      expectedRevision: revision,
      state: validState('不应写入', `cross-${randomUUID()}`),
      stateVersion: 1
    });
    requireCheck(!crossRpc.ok && crossRpc.row?.status === 'not_found', '账号 B 的 RPC 无法修改账号 A 的鱼缸');

    const crossRead = await checkCrossAccountRowRead({
      fetchImpl,
      url: config.url,
      anonKey: config.anonKey,
      accessToken: loginB.session.access_token,
      aquariumId,
      timeoutMs
    });
    requireCheck(crossRead.ok, '账号 B 的 PostgREST 读取返回 200 空结果（RLS 隐藏 A 的行）', `HTTP ${crossRead.status}`);

    for (const [method, label] of [['PATCH', 'PATCH'], ['DELETE', 'DELETE']]) {
      const response = await checkTableWriteDenied({
        fetchImpl,
        url: config.url,
        anonKey: config.anonKey,
        accessToken: loginB.session.access_token,
        aquariumId,
        method,
        state: validState('不应覆写', `table-${randomUUID()}`),
        timeoutMs
      });
      requireCheck(response.ok, `账号 B 直接表级 ${label} 被数据库权限拒绝`, `HTTP ${response.status}; SQLSTATE ${response.code || 'unknown'}`);
    }

    const unchanged = await deviceA.api.ensureAquarium(validState('不会被使用', `candidate-${randomUUID()}`), 1);
    requireCheck(unchanged.ok && unchanged.row?.aquarium_id === aquariumId &&
      Number(unchanged.row.revision) === revision &&
      isDeepStrictEqual(unchanged.row.state_json, updatedState),
    '越权表操作后账号 A 的存档与 revision 保持不变');

    const anonRead = await call('/rest/v1/aquariums?select=id', { token: null });
    requireCheck(isAnonymousReadDenied(anonRead), '匿名访问存档表为空或收到数据库权限拒绝', `HTTP ${anonRead.status}; SQLSTATE ${anonRead.body?.code || 'none'}`);

    const settled1 = await rpc('settle_growth', { p_id: aquariumId, p_cap_seconds: 86400 }, refreshedA.session.access_token);
    requireCheck(settled1.ok && settled1.row?.status === 'ok', '账号 A 可结算服务端成长', `HTTP ${settled1.status}`);
    const settled2 = await rpc('settle_growth', { p_id: aquariumId, p_cap_seconds: 86400 }, refreshedA.session.access_token);
    const credited1 = Number(settled1.row?.credited_seconds);
    const credited2 = Number(settled2.row?.credited_seconds);
    const elapsedAnchor = Math.max(0, Math.floor((Date.parse(settled2.row?.last_growth_at) - Date.parse(initialRow.last_growth_at)) / 1000));
    requireCheck(settled2.ok && settled2.row?.status === 'ok' &&
      Number.isFinite(credited1) && Number.isFinite(credited2) && credited1 + credited2 <= elapsedAnchor,
    '重复结算的成长总量不超过服务端锚点经过时间', `credited=${credited1 + credited2}; elapsed=${elapsedAnchor}s`);

    const crossSettle = await rpc('settle_growth', { p_id: aquariumId, p_cap_seconds: 86400 }, loginB.session.access_token);
    requireCheck(crossSettle.ok && crossSettle.row?.status === 'not_found', '账号 B 无法结算账号 A 的鱼缸');

    const current = await deviceA.api.ensureAquarium(validState('不会被使用', `candidate-${randomUUID()}`), 1);
    const badState = await deviceA.api.saveAquarium({
      aquariumId,
      expectedRevision: Number(current.row?.revision),
      state: { version: 1, fish: [], plants: 0 },
      stateVersion: 1
    });
    requireCheck(!badState.ok && badState.row?.status === 'invalid_state', '服务端拒绝非法存档');
  } catch (error) {
    const message = error instanceof SmokeError
      ? error.message
      : `冒烟测试异常中断（${error?.name || '未知错误'}）`;
    record(false, '真实 Supabase 冒烟流程完成', message);
  } finally {
    if (config && created.length) {
      for (const account of created) {
        let deletion = await call(`/auth/v1/admin/users/${encodeURIComponent(account.id)}`, {
          method: 'DELETE',
          token: config.serviceKey,
          apiKey: config.serviceKey
        });
        let check = await call(`/auth/v1/admin/users/${encodeURIComponent(account.id)}`, {
          token: config.serviceKey,
          apiKey: config.serviceKey
        });
        if (!isConfirmedMissingUser(check)) {
          // Retry a failed or not-yet-visible deletion once, then verify a specific GoTrue
          // user_not_found result; a generic gateway/router 404 is not cleanup evidence.
          deletion = await call(`/auth/v1/admin/users/${encodeURIComponent(account.id)}`, {
            method: 'DELETE',
            token: config.serviceKey,
            apiKey: config.serviceKey
          });
          check = await call(`/auth/v1/admin/users/${encodeURIComponent(account.id)}`, {
            token: config.serviceKey,
            apiKey: config.serviceKey
          });
        }
        const clean = isConfirmedMissingUser(check);
        record(clean, '已验证临时测试账号清理', clean
          ? `DELETE HTTP ${deletion.status}; GoTrue 已确认 HTTP 404 user_not_found`
          : `DELETE HTTP ${deletion.status}; 查询 HTTP ${check.status}; 残留测试账号 ID=${account.id}`);
      }
    } else if (config) {
      record(true, '无需清理（尚未创建临时测试账号）');
    }
  }

  const failed = results.filter(result => !result.ok);
  logger.log(`\n=== 真实 Supabase 冒烟结果：${results.length - failed.length}/${results.length} 通过 ===`);
  if (failed.length) {
    logger.log('失败项：');
    for (const result of failed) logger.log(` - ${result.name}${result.detail ? ` (${result.detail})` : ''}`);
  }
  return { ok: failed.length === 0, results };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let envReady = true;
  try {
    loadEnvFile(new URL('../.env', import.meta.url));
  } catch (error) {
    if (error.code !== 'ENOENT') {
      console.error(`无法读取本机 .env（${error?.name || '未知错误'}）`);
      process.exitCode = 1;
      envReady = false;
    }
  }
  if (envReady) {
    const result = await runCloudSmoke();
    if (!result.ok) process.exitCode = 1;
  }
}
