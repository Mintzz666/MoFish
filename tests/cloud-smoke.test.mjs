import test from 'node:test';
import assert from 'node:assert/strict';
import {
  checkCrossAccountRowRead,
  checkTableWriteDenied,
  runCloudSmoke
} from '../scripts/cloud-smoke.mjs';

const response = (status, body = null) => new Response(
  body === null ? null : JSON.stringify(body),
  { status, headers: { 'Content-Type': 'application/json' } }
);
const serviceRoleTestJwt = `e30.${Buffer.from(JSON.stringify({
  role: 'service_role',
  exp: Math.floor(Date.now() / 1000) + 3600
})).toString('base64url')}.test-signature`;

test('RLS 越权读取只有真实的 HTTP 200 空数组才通过', async () => {
  const options = {
    url: 'https://smoke.example.test',
    anonKey: 'public-test-key',
    accessToken: 'user-b-token',
    aquariumId: 'aquarium-a',
    timeoutMs: 100
  };
  let readHeaders;
  const empty = await checkCrossAccountRowRead({
    ...options,
    fetchImpl: async (_input, init) => {
      readHeaders = init.headers;
      return response(200, []);
    }
  });
  assert.deepEqual(empty, { ok: true, status: 200 });
  assert.equal(readHeaders.apikey, options.anonKey, '数据 API 使用公开 anon apikey');
  assert.equal(readHeaders.Authorization, `Bearer ${options.accessToken}`, '数据 API 使用用户 session token');

  for (const failedResponse of [
    response(403, { code: '42501', message: 'permission denied' }),
    response(500, { code: 'XX000', message: 'database unavailable' }),
    response(200, { message: 'malformed result' }),
    response(200, [{ id: 'visible-row' }])
  ]) {
    const result = await checkCrossAccountRowRead({
      ...options,
      fetchImpl: async () => failedResponse
    });
    assert.equal(result.ok, false, `HTTP ${result.status} 不应被当成空结果`);
  }
});

test('表级写检查只接受 PostgreSQL 权限错误，不把其他失败或空响应算作拒绝', async () => {
  const options = {
    url: 'https://smoke.example.test',
    anonKey: 'public-test-key',
    accessToken: 'user-b-token',
    aquariumId: 'aquarium-a',
    method: 'PATCH',
    state: { version: 1 },
    timeoutMs: 100
  };
  const denied = await checkTableWriteDenied({
    ...options,
    fetchImpl: async () => response(403, { code: '42501', message: 'permission denied' })
  });
  assert.deepEqual(denied, { ok: true, status: 403, code: '42501' });

  for (const failedResponse of [
    response(500, { code: '42501', message: 'gateway failure' }),
    response(403, { code: 'PGRST301', message: 'JWT error' }),
    response(200, [])
  ]) {
    const result = await checkTableWriteDenied({
      ...options,
      fetchImpl: async () => failedResponse
    });
    assert.equal(result.ok, false, `HTTP ${result.status} / ${result.code} 不能证明写权限被拒绝`);
  }
});

test('请求超时按失败返回，不能因没有响应而冒充空行', async () => {
  const started = Date.now();
  const result = await checkCrossAccountRowRead({
    url: 'https://smoke.example.test',
    anonKey: 'public-test-key',
    accessToken: 'user-b-token',
    aquariumId: 'aquarium-a',
    timeoutMs: 10,
    fetchImpl: () => new Promise(() => {})
  });
  assert.equal(result.ok, false);
  assert.equal(result.status, 0);
  assert.ok(Date.now() - started < 1000, '超时应有界返回');
});

test('只有 service key 模式可运行，拒绝既有账号凭据且不发网络请求', async () => {
  let calls = 0;
  const logs = [];
  const result = await runCloudSmoke({
    env: {
      MOFISH_SUPABASE_URL: 'https://smoke.example.test',
      MOFISH_SUPABASE_ANON_KEY: 'public-test-key',
      MOFISH_SMOKE_EMAIL_A: 'existing@example.com',
      MOFISH_SMOKE_PASSWORD_A: 'never-used-password',
      MOFISH_SMOKE_EMAIL_B: 'other@example.com',
      MOFISH_SMOKE_PASSWORD_B: 'also-never-used'
    },
    fetchImpl: async () => { calls++; return response(200, {}); },
    logger: { log: line => logs.push(String(line)) }
  });
  assert.equal(result.ok, false);
  assert.equal(calls, 0);
  assert.ok(logs.join('\n').includes('MOFISH_SMOKE_SERVICE_ROLE_KEY'));
  assert.ok(!logs.join('\n').includes('existing@example.com'));
  assert.ok(!logs.join('\n').includes('never-used-password'));
});

test('拒绝 opaque secret key，避免把它当 JWT 放入 Authorization', async () => {
  let calls = 0;
  const logs = [];
  const result = await runCloudSmoke({
    env: {
      MOFISH_SUPABASE_URL: 'https://smoke.example.test',
      MOFISH_SUPABASE_ANON_KEY: 'public-test-key',
      MOFISH_SMOKE_SERVICE_ROLE_KEY: 'sb_secret_test-only'
    },
    fetchImpl: async () => { calls++; return response(200, {}); },
    logger: { log: line => logs.push(String(line)) }
  });
  assert.equal(result.ok, false);
  assert.equal(calls, 0);
  assert.ok(logs.join('\n').includes('opaque sb_secret_*'));
  assert.ok(!logs.join('\n').includes('sb_secret_test-only'));
});

test('代理占位凭据由服务端只读预检验证，认证失败或通用 404 时禁止写入', async () => {
  const placeholder = 'proxy-injected-test-placeholder';
  for (const [status, body, permitted] of [
    [404, { error_code: 'user_not_found' }, true],
    [401, { error_code: 'bad_jwt' }, false],
    [403, { error_code: 'not_admin' }, false],
    [404, { code: 'gateway_route_missing' }, false],
    [200, { id: 'unexpected-existing-user' }, false]
  ]) {
    const calls = [];
    const logs = [];
    const result = await runCloudSmoke({
      env: {
        MOFISH_SUPABASE_URL: 'https://smoke.example.test',
        MOFISH_SUPABASE_ANON_KEY: 'public-test-key',
        MOFISH_SMOKE_SERVICE_ROLE_KEY: placeholder
      },
      fetchImpl: async (input, init) => {
        calls.push({ input, init });
        assert.equal(init.headers.apikey, placeholder);
        assert.equal(init.headers.Authorization, `Bearer ${placeholder}`);
        if (init.method === 'GET') return response(status, body);
        return response(403, { error_code: 'create_blocked_for_test' });
      },
      logger: { log: line => logs.push(String(line)) }
    });
    assert.equal(result.ok, false);
    assert.match(calls[0].input, /\/auth\/v1\/admin\/users\/[0-9a-f-]{36}$/);
    assert.equal(calls[0].init.method, 'GET');
    assert.equal(calls.some(call => call.init.method === 'POST'), permitted);
    assert.ok(!logs.join('\n').includes(placeholder));
  }
});

test('即使账号创建流程失败，finally 仍删除并确认仅本轮创建的账号', async () => {
  const id = '12345678-1234-4234-8234-123456789abc';
  const logs = [];
  const calls = [];
  let createCount = 0;
  const fetchImpl = async (input, init = {}) => {
    const url = new URL(typeof input === 'string' ? input : input.url);
    const method = init.method || 'GET';
    calls.push({ path: url.pathname, method, headers: init.headers });

    if (method === 'GET' && url.pathname.startsWith('/auth/v1/admin/users/') && !url.pathname.endsWith(id)) {
      return response(404, { code: 'user_not_found' });
    }
    if (url.pathname === '/auth/v1/admin/users' && method === 'POST') {
      createCount++;
      if (createCount === 1) {
        const body = JSON.parse(init.body);
        return response(200, { id, email: body.email });
      }
      return response(409, { code: 'user_already_exists', message: 'Conflict' });
    }
    if (url.pathname === `/auth/v1/admin/users/${id}` && method === 'DELETE') return response(200, { id });
    if (url.pathname === `/auth/v1/admin/users/${id}` && method === 'GET') return response(404, { code: 'user_not_found' });
    return response(501, { code: 'unexpected_request' });
  };

  const result = await runCloudSmoke({
    env: {
      MOFISH_SUPABASE_URL: 'https://smoke.example.test',
      MOFISH_SUPABASE_ANON_KEY: 'public-test-key',
      MOFISH_SMOKE_SERVICE_ROLE_KEY: serviceRoleTestJwt
    },
    fetchImpl,
    logger: { log: line => logs.push(String(line)) },
    timeoutMs: 100
  });

  assert.equal(result.ok, false, '创建第二账号失败应使冒烟测试失败');
  assert.equal(calls.filter(call => call.path === '/auth/v1/token').length, 0,
    '创建失败时不能回退尝试登录或复用既有账号');
  assert.ok(calls.some(call => call.path === `/auth/v1/admin/users/${id}` && call.method === 'DELETE'));
  assert.ok(calls.some(call => call.path === `/auth/v1/admin/users/${id}` && call.method === 'GET'));
  assert.ok(result.results.some(item => item.name === '已验证临时测试账号清理' && item.ok));
  assert.ok(logs.some(line => line.includes('已验证临时测试账号清理')));
  for (const call of calls.filter(item => item.path.startsWith('/auth/v1/admin/users'))) {
    assert.equal(call.headers.apikey, serviceRoleTestJwt, 'admin API apikey 必须使用 service role key');
    assert.equal(call.headers.Authorization, `Bearer ${serviceRoleTestJwt}`);
  }
  assert.ok(!logs.join('\n').includes(serviceRoleTestJwt));
});

test('通用 HTTP 404 不足以宣称清理成功，并报告残留账号 ID', async () => {
  const id = '12345678-1234-4234-8234-123456789abc';
  let createCount = 0;
  const fetchImpl = async (input, init = {}) => {
    const url = new URL(typeof input === 'string' ? input : input.url);
    const method = init.method || 'GET';
    if (method === 'GET' && url.pathname.startsWith('/auth/v1/admin/users/') && !url.pathname.endsWith(id)) {
      return response(404, { code: 'user_not_found' });
    }
    if (url.pathname === '/auth/v1/admin/users' && method === 'POST') {
      createCount++;
      if (createCount === 1) {
        const body = JSON.parse(init.body);
        return response(200, { id, email: body.email });
      }
      return response(409, { code: 'duplicate' });
    }
    if (url.pathname === `/auth/v1/admin/users/${id}` && method === 'DELETE') return response(200, { id });
    if (url.pathname === `/auth/v1/admin/users/${id}`) return response(404, { code: 'gateway_route_missing' });
    return response(501, { code: 'unexpected_request' });
  };
  const logs = [];
  const result = await runCloudSmoke({
    env: {
      MOFISH_SUPABASE_URL: 'https://smoke.example.test',
      MOFISH_SUPABASE_ANON_KEY: 'sb_publishable_test-only',
      MOFISH_SMOKE_SERVICE_ROLE_KEY: serviceRoleTestJwt
    },
    fetchImpl,
    logger: { log: line => logs.push(String(line)) },
    timeoutMs: 100
  });
  assert.equal(result.ok, false);
  const cleanup = result.results.find(item => item.name === '已验证临时测试账号清理');
  assert.equal(cleanup.ok, false);
  assert.ok(cleanup.detail.includes(id));
  assert.ok(logs.some(line => line.includes(id)));
});

test('假 HTTP happy path 覆盖 SDK、双会话恢复、RLS 与清理，并容忍 JSONB 键重排', async () => {
  const anonKey = 'sb_publishable_test-only';
  const usersByEmail = new Map();
  const usersById = new Map();
  const accessTokens = new Map();
  const refreshTokens = new Map();
  const aquariums = new Map();
  const calls = [];
  let createIndex = 0;

  const reverseDeep = value => {
    if (Array.isArray(value)) return value.map(reverseDeep);
    if (value && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value).reverse().map(([key, item]) => [key, reverseDeep(item)]));
    }
    return value;
  };
  const success = body => response(200, body);
  const issueSession = user => {
    const access = `access-${Math.random()}`;
    const refresh = `refresh-${Math.random()}`;
    accessTokens.set(access, user.id);
    refreshTokens.set(refresh, user.id);
    return {
      access_token: access,
      refresh_token: refresh,
      token_type: 'bearer',
      expires_in: 3600,
      expires_at: Math.floor(Date.now() / 1000) + 3600,
      user: { id: user.id, email: user.email, email_confirmed_at: new Date().toISOString() }
    };
  };
  const rpcRow = (row, { created = false } = {}) => ({
    status: 'ok',
    aquarium_id: row.id,
    revision: row.revision,
    state_json: reverseDeep(row.state),
    last_growth_at: row.lastGrowthAt,
    created
  });
  const fakeFetch = async (input, init = {}) => {
    const requestUrl = new URL(input instanceof Request ? input.url : String(input));
    const method = init.method || (input instanceof Request ? input.method : 'GET');
    const headers = new Headers(init.headers || (input instanceof Request ? input.headers : undefined));
    const rawBody = init.body ?? (input instanceof Request ? await input.clone().text() : undefined);
    const body = typeof rawBody === 'string' && rawBody ? JSON.parse(rawBody) : null;
    const authHeader = headers.get('authorization');
    const accessToken = authHeader?.match(/^Bearer\s+(.+)$/i)?.[1] || null;
    const userId = accessTokens.get(accessToken) || null;
    calls.push({
      path: requestUrl.pathname,
      method,
      apikey: headers.get('apikey'),
      authorization: authHeader,
      grant: requestUrl.searchParams.get('grant_type'),
      body
    });

    if (requestUrl.pathname === '/auth/v1/admin/users' && method === 'POST') {
      assert.equal(headers.get('apikey'), serviceRoleTestJwt);
      assert.equal(authHeader, `Bearer ${serviceRoleTestJwt}`);
      const id = `10000000-0000-4000-8000-${String(++createIndex).padStart(12, '0')}`;
      const user = { id, email: body.email, password: body.password };
      usersByEmail.set(user.email, user);
      usersById.set(user.id, user);
      return success({ id, email: user.email });
    }
    const adminUser = /^\/auth\/v1\/admin\/users\/([^/]+)$/.exec(requestUrl.pathname);
    if (adminUser) {
      assert.equal(headers.get('apikey'), serviceRoleTestJwt);
      assert.equal(authHeader, `Bearer ${serviceRoleTestJwt}`);
      const user = usersById.get(decodeURIComponent(adminUser[1]));
      if (method === 'DELETE') {
        if (user) {
          usersById.delete(user.id);
          usersByEmail.delete(user.email);
        }
        return success({ id: decodeURIComponent(adminUser[1]) });
      }
      if (!user) return response(404, { code: 404, error_code: 'user_not_found', msg: 'User not found' });
      return success({ id: user.id, email: user.email });
    }

    if (requestUrl.pathname === '/auth/v1/token' && method === 'POST') {
      assert.equal(headers.get('apikey'), anonKey);
      const grant = requestUrl.searchParams.get('grant_type');
      if (grant === 'password') {
        const user = usersByEmail.get(body.email);
        if (!user || user.password !== body.password) return response(400, { error_code: 'invalid_credentials' });
        return success(issueSession(user));
      }
      if (grant === 'refresh_token') {
        const id = refreshTokens.get(body.refresh_token);
        const user = id ? usersById.get(id) : null;
        if (!user) return response(400, { error_code: 'refresh_token_not_found' });
        refreshTokens.delete(body.refresh_token);
        return success(issueSession(user));
      }
      return response(400, { error_code: 'unsupported_grant_type' });
    }

    if (requestUrl.pathname === '/auth/v1/user' && method === 'GET') {
      assert.equal(headers.get('apikey'), anonKey);
      const user = usersById.get(userId);
      if (!user) return response(401, { error_code: 'no_authorization' });
      return success({ id: user.id, email: user.email, email_confirmed_at: new Date().toISOString() });
    }

    if (requestUrl.pathname === '/rest/v1/aquariums' && method === 'GET') {
      assert.equal(headers.get('apikey'), anonKey);
      if (!authHeader) return response(403, { code: '42501', message: 'permission denied' });
      const requestedId = requestUrl.searchParams.get('id')?.replace(/^eq\./, '');
      const row = [...aquariums.values()].find(item => item.id === requestedId && item.ownerId === userId);
      return success(row ? [{ id: row.id, owner_id: row.ownerId }] : []);
    }
    if (requestUrl.pathname === '/rest/v1/aquariums' && ['PATCH', 'DELETE'].includes(method)) {
      assert.equal(headers.get('apikey'), anonKey);
      return response(403, { code: '42501', message: 'permission denied' });
    }

    const rpc = /^\/rest\/v1\/rpc\/([^/]+)$/.exec(requestUrl.pathname);
    if (rpc && method === 'POST') {
      assert.equal(headers.get('apikey'), anonKey);
      if (!userId) return response(401, { code: '42501' });
      const name = rpc[1];
      if (name === 'ensure_aquarium') {
        let row = aquariums.get(userId);
        let created = false;
        if (!row) {
          row = {
            id: '20000000-0000-4000-8000-000000000001',
            ownerId: userId,
            revision: 1,
            state: structuredClone(body.p_initial_state),
            lastGrowthAt: new Date().toISOString()
          };
          aquariums.set(userId, row);
          created = true;
        }
        return success([rpcRow(row, { created })]);
      }
      const row = aquariums.get(body.p_id === '20000000-0000-4000-8000-000000000001' ? [...aquariums.keys()].find(owner => aquariums.get(owner).id === body.p_id) : '');
      if (name === 'save_aquarium') {
        if (!row || row.ownerId !== userId) return success([{ status: 'not_found', revision: null }]);
        if (!Array.isArray(body.p_state?.fish) || body.p_state.fish.length === 0) {
          return success([{ status: 'invalid_state', error_code: 'empty_fish' }]);
        }
        if (Number(body.p_expected_revision) !== row.revision) {
          return success([{ status: 'conflict', revision: row.revision }]);
        }
        row.state = structuredClone(body.p_state);
        row.revision++;
        return success([{ status: 'ok', revision: row.revision }]);
      }
      if (name === 'settle_growth') {
        if (!row || row.ownerId !== userId) return success([{ status: 'not_found', credited_seconds: 0 }]);
        return success([{
          status: 'ok',
          revision: row.revision,
          credited_seconds: 0,
          state_json: reverseDeep(row.state),
          last_growth_at: row.lastGrowthAt
        }]);
      }
      return response(404, { code: 'PGRST202' });
    }

    return response(404, { code: 'unknown_route' });
  };

  const logs = [];
  const result = await runCloudSmoke({
    env: {
      MOFISH_SUPABASE_URL: 'https://smoke.example.test',
      MOFISH_SUPABASE_ANON_KEY: anonKey,
      MOFISH_SMOKE_SERVICE_ROLE_KEY: serviceRoleTestJwt
    },
    fetchImpl: fakeFetch,
    logger: { log: line => logs.push(String(line)) },
    timeoutMs: 100
  });

  assert.equal(result.ok, true, logs.join('\n'));
  assert.ok(result.results.every(item => item.ok), logs.join('\n'));
  assert.ok(calls.some(call => call.path === '/auth/v1/token' && call.grant === 'refresh_token'));
  const anonymousRead = calls.find(call => call.path === '/rest/v1/aquariums' && call.method === 'GET' && !call.authorization);
  assert.ok(anonymousRead, 'anon 查询应只用 apikey，不发送 opaque anon key 作为 Bearer');
  assert.equal(anonymousRead.apikey, anonKey);
  assert.equal(usersById.size, 0, '两个临时账号都应清理');
  assert.ok([...calls].some(call => call.path.startsWith('/auth/v1/admin/users/') && call.method === 'GET'));
  assert.ok(logs.some(line => line.includes('真实 Supabase 冒烟结果：')));
});
