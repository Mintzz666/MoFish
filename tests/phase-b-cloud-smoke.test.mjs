import test from 'node:test';
import assert from 'node:assert/strict';
import { runCloudSmoke } from '../scripts/cloud-smoke.mjs';
import { checkPhaseBTarget, runPhaseBChecks, phaseBEnvironment } from '../scripts/phase-b-cloud-checks.mjs';
import { createCloudApi } from '../web/cloud/api.js';
import { createTestDb, USERS } from './sql/harness.mjs';
import { spawnSync } from 'node:child_process';
import { createFakeSupabase } from './fake-supabase/supabase-fake.mjs';

const ref = 'bbbbbbbbbbbbbbbbbbbb';
test('B deploy dry-run rejects the current A project before build or Wrangler', () => {
  const result = spawnSync(process.execPath, ['scripts/deploy-cloudflare.mjs', '--phase=b', '--dry-run'], {
    cwd: new URL('../', import.meta.url), encoding: 'utf8',
    env: { ...process.env, MOFISH_B_SUPABASE_URL: 'https://jxqlzuvpuaqwcdvgxnle.supabase.co',
      MOFISH_B_SUPABASE_ANON_KEY: 'sb_publishable_test-only', MOFISH_B_PROJECT_REF: 'jxqlzuvpuaqwcdvgxnle' }
  });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /B 联调拒绝现有 A 项目/);
  assert.doesNotMatch(result.stdout + result.stderr, /Built static aquarium|Total Upload/);
});
test('B requires an exact independent project and blocks the A project before all HTTP calls', async () => {
  assert.doesNotThrow(() => checkPhaseBTarget(`https://${ref}.supabase.co`, ref));
  assert.doesNotThrow(() => checkPhaseBTarget('https://bbbbbbbbbbbbbbbbbbb1.supabase.co', 'bbbbbbbbbbbbbbbbbbb1'));
  for (const [url, expected] of [
    [`https://${ref}.supabase.co`, ''], [`https://${ref}.supabase.co`, 'cccccccccccccccccccc'],
    [`https://${ref}.supabase.co.evil.test`, ref],
    ['https://jxqlzuvpuaqwcdvgxnle.supabase.co', 'jxqlzuvpuaqwcdvgxnle']
  ]) {
    let calls = 0;
    const logs = [];
    const result = await runCloudSmoke({
      phase: 'b', env: { MOFISH_B_SUPABASE_URL: url, MOFISH_B_SUPABASE_ANON_KEY: 'test-public',
        MOFISH_B_SMOKE_SERVICE_ROLE_KEY: 'proxy-placeholder-private', MOFISH_B_PROJECT_REF: expected },
      fetchImpl: async () => { calls++; throw new Error('must never send'); },
      logger: { log: line => logs.push(line) }
    });
    assert.equal(result.ok, false);
    assert.equal(calls, 0);
    assert.match(logs.join('\n'), /独立测试项目|独立配置|拒绝现有 A 项目/);
    assert.ok(!logs.join('\n').includes('proxy-placeholder-private'));
  }
});

test('B upgrade failure still cleans only its own temporary accounts and audits their rows (mock HTTP)', async () => {
  const fake = createFakeSupabase({ startMs: Date.now() });
  fake.handleAuth('POST', '/auth/v1/signup', new URLSearchParams(), {}, { email: 'existing@example.test', password: 'keep-this-user' });
  const existing = fake.users.get('existing@example.test');
  const owned = new Map(), deleted = [], audited = [];
  const privateKey = 'proxy-test-private-key';
  const json = (status, body) => new Response(JSON.stringify(body), { status });
  const fetchImpl = async (input, init = {}) => {
    const url = new URL(String(input)), method = init.method || 'GET';
    const headers = Object.fromEntries(new Headers(init.headers));
    const body = init.body ? JSON.parse(init.body) : null;
    if (url.pathname === '/auth/v1/admin/users') {
      assert.equal(headers.apikey, privateKey);
      assert.match(body.email, /^mofish-smoke-[0-9a-f-]+-[ab]@example\.com$/);
      const r = fake.handleAuth('POST', '/auth/v1/signup', url.searchParams, headers, body);
      const user = fake.users.get(body.email);
      user.confirmed = true;
      owned.set(user.id, user);
      return json(r.status, r.body);
    }
    if (url.pathname.startsWith('/auth/v1/admin/users/')) {
      const id = url.pathname.split('/').at(-1), user = owned.get(id);
      if (method === 'DELETE') {
        assert.ok(user, 'never delete an account not created in this run');
        assert.notEqual(id, existing.id);
        deleted.push(id); fake.users.delete(user.email); fake.aquariums.delete(id); owned.delete(id);
        return json(200, { id });
      }
      return user ? json(200, { id: user.id, email: user.email }) : json(404, { error_code: 'user_not_found' });
    }
    if (url.pathname.startsWith('/auth/')) {
      const r = fake.handleAuth(method, url.pathname, url.searchParams, headers, body);
      return new Response(r.body === null ? null : JSON.stringify(r.body), { status: r.status });
    }
    if (url.pathname.startsWith('/rest/v1/rpc/')) {
      if (body?.p_state_version === 2) return json(404, { code: 'PGRST202' });
      const r = fake.handleRpc(url.pathname.split('/').at(-1), headers, body);
      return json(r.status, r.body);
    }
    if (headers.apikey === privateKey) {
      assert.ok(url.searchParams.get('id')?.startsWith('eq.') || url.searchParams.get('aquarium_id')?.startsWith('eq.'));
      audited.push(url.pathname);
      return json(200, []);
    }
    return method === 'GET' ? json(200, []) : json(403, { code: '42501' });
  };
  const result = await runCloudSmoke({ phase: 'b', env: { MOFISH_B_SUPABASE_URL: `https://${ref}.supabase.co`,
    MOFISH_B_PROJECT_REF: ref, MOFISH_B_SUPABASE_ANON_KEY: 'sb_publishable_test-only', MOFISH_B_SMOKE_SERVICE_ROLE_KEY: privateKey },
    fetchImpl, logger: { log() {} }
  });
  assert.equal(result.ok, false);
  assert.ok(result.results.some(item => !item.ok && /B：v1→v2/.test(item.name)), 'must reach the B upgrade before failing');
  assert.equal(deleted.length, 2);
  assert.equal(owned.size, 0);
  assert.equal(fake.users.size, 1);
  assert.equal(fake.users.get(existing.email), existing);
  assert.deepEqual(audited.sort(), ['/rest/v1/aquariums', '/rest/v1/mofish_feed_events']);
});

test('B does not inherit A config or service credentials when B bindings are absent', () => {
  const env = phaseBEnvironment({ MOFISH_SUPABASE_URL: 'https://jxqlzuvpuaqwcdvgxnle.supabase.co',
    MOFISH_SUPABASE_ANON_KEY: 'a-public', MOFISH_SMOKE_SERVICE_ROLE_KEY: 'a-private' });
  assert.equal(env.MOFISH_SUPABASE_URL, '');
  assert.equal(env.MOFISH_SUPABASE_ANON_KEY, '');
  assert.equal(env.MOFISH_SMOKE_SERVICE_ROLE_KEY, '');
  const explicit = phaseBEnvironment({ ...env,
    MOFISH_SUPABASE_URL: 'a-url', MOFISH_SUPABASE_ANON_KEY: 'a-public', MOFISH_SMOKE_SERVICE_ROLE_KEY: 'a-private',
    MOFISH_B_SUPABASE_URL: 'b-url', MOFISH_B_SUPABASE_ANON_KEY: 'b-public', MOFISH_B_SMOKE_SERVICE_ROLE_KEY: 'b-private',
    MOFISH_B_PROJECT_REF: ref
  });
  assert.equal(explicit.MOFISH_SUPABASE_URL, 'b-url');
  assert.equal(explicit.MOFISH_SUPABASE_ANON_KEY, 'b-public');
  assert.equal(explicit.MOFISH_SMOKE_SERVICE_ROLE_KEY, 'b-private');
});

test('B workflow runs real migration SQL plus production API/sync against an isolated Postgres kernel (not cloud)', async t => {
  const db = await createTestDb();
  t.after(() => db.close());
  await db.addUser(USERS.alice, 'smoke-a@example.test');
  await db.addUser(USERS.bob, 'smoke-b@example.test');
  const calls = [];
  const fetchImpl = async (input, init = {}) => {
    const url = new URL(String(input));
    const token = new Headers(init.headers).get('authorization')?.replace(/^Bearer /, '');
    const uid = token === 'token-a' ? USERS.alice : token === 'token-b' ? USERS.bob : null;
    const body = init.body ? JSON.parse(init.body) : null;
    const method = init.method || 'GET';
    calls.push({ path: url.pathname, method });
    const rpc = url.pathname.split('/').at(-1);
    const specs = {
      ensure_aquarium: ['select * from public.ensure_aquarium($1::jsonb, $2)', body && [JSON.stringify(body.p_initial_state), body.p_state_version]],
      save_aquarium: ['select * from public.save_aquarium($1, $2, $3::jsonb, $4)', body && [body.p_id, body.p_expected_revision, JSON.stringify(body.p_state), body.p_state_version]],
      settle_growth: ['select * from public.settle_growth($1, $2)', body && [body.p_id, body.p_cap_seconds]],
      record_feeding: ['select * from public.record_feeding($1, $2, $3, $4)', body && [body.p_id, body.p_operation_id, body.p_fish_id, body.p_bites]]
    };
    const query = async () => {
      if (url.pathname.startsWith('/rest/v1/rpc/')) {
        const spec = specs[rpc];
        assert.ok(spec, `unexpected RPC ${rpc}`);
        return db.query(...spec);
      }
      assert.equal(url.pathname, '/rest/v1/mofish_feed_events');
      const id = url.searchParams.get('aquarium_id')?.slice(3);
      assert.ok(id, 'event table checks must be scoped to this aquarium');
      if (method === 'GET') return db.query('select id from public.mofish_feed_events where aquarium_id = $1', [id]);
      if (method === 'PATCH') return db.query('update public.mofish_feed_events set credited = 8 where aquarium_id = $1 returning id', [id]);
      if (method === 'DELETE') return db.query('delete from public.mofish_feed_events where aquarium_id = $1 returning id', [id]);
      assert.equal(method, 'POST');
      return db.query('insert into public.mofish_feed_events(aquarium_id, operation_id, fish_id, bites) values($1,$2,$3,$4) returning id',
        [body.aquarium_id, body.operation_id, body.fish_id, body.bites]);
    };
    try {
      const rows = await (uid ? db.asUser(uid, query) : db.asAnon(query));
      return new Response(JSON.stringify(rows), { status: 200, headers: { 'Content-Type': 'application/json' } });
    } catch (error) {
      if (error.code !== '42501') throw error;
      return new Response(JSON.stringify({ code: error.code }), { status: 403 });
    }
  };
  const api = token => createCloudApi({ url: `https://${ref}.supabase.co`, anonKey: 'test-public', fetchImpl,
    getAccessToken: async () => token });
  const apiA = api('token-a'), apiA2 = api('token-a'), apiB = api('token-b');
  const legacy = { version: 1, fish: [{ id: 'legacy-fish', name: '旧档鱼', species: 0, born: Date.now() - 86400000,
    growth: 0.1, meals: 3 }], plants: 3, night: false, sound: false, savedAt: Date.now() };
  const first = await apiA.ensureAquarium(legacy, 1);
  assert.ok(first.ok);
  const results = [];
  const call = async (path, options = {}) => {
    const r = await fetchImpl(`https://${ref}.supabase.co${path}`, {
      method: options.method || 'GET', headers: { authorization: options.token ? `Bearer ${options.token}` : '' },
      body: options.body ? JSON.stringify(options.body) : undefined
    });
    return { ok: r.ok, status: r.status, body: await r.json() };
  };
  await runPhaseBChecks({ apiA, apiA2, apiB, initialRow: first.row, call, accessToken: 'token-a',
    sessionA: { user: { id: USERS.alice } }, sessionB: { user: { id: USERS.bob } },
    requireCheck: (ok, name) => { results.push(name); assert.ok(ok, name); }
  });
  assert.ok(results.length >= 35);
  assert.ok(results.some(name => /冲突备份/.test(name)));
  assert.ok(results.some(name => /退出换号/.test(name)));
  assert.equal(calls.filter(call => call.path.includes('/auth/')).length, 0, 'this test does not pretend to verify GoTrue');
});
