import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createAuthClient,
  mapAuthError,
  validateCredentials,
  parseAuthCallback,
  normalizeSession,
  sessionIsFresh
} from '../web/cloud/auth.js';
import { createLocalStore } from '../web/storage.js';
import { createMemoryStorage } from './helpers/memory-storage.mjs';
import { createFakeSupabase, makeAccessToken } from './fake-supabase/supabase-fake.mjs';
import { createFakeFetch, networkFailure } from './fake-supabase/server.mjs';

const ANON = makeAccessToken('anon', { role: 'anon' });

function setup({ startMs = 1_700_000_000_000, onRequest } = {}) {
  const fake = createFakeSupabase({ startMs });
  let nowMs = startMs;
  const requests = [];
  const store = createLocalStore(createMemoryStorage());
  const fetchImpl = createFakeFetch(fake, {
    onRequest: (ctx) => {
      requests.push(ctx.path);
      return onRequest ? onRequest(ctx) : null;
    }
  });
  const auth = createAuthClient({
    url: 'https://demo.supabase.co',
    anonKey: ANON,
    fetchImpl,
    store,
    now: () => nowMs
  });
  return {
    fake, auth, store, requests,
    advance: (ms) => { nowMs += ms; fake.advance(ms); }
  };
}

async function registerConfirmed(fake, auth, email = 'a@example.com', password = 'goodpassword') {
  await auth.signUp({ email, password });
  const user = fake.users.get(email);
  user.confirmed = true;
  return user;
}

// ----------------------------------------------------------------- 纯函数

test('本地凭据校验只做即时提示，不代替服务端规则', () => {
  assert.equal(validateCredentials({ email: '', password: 'x' }).code, 'email_required');
  assert.equal(validateCredentials({ email: 'nope', password: 'x' }).code, 'email_invalid');
  assert.equal(validateCredentials({ email: 'a@b.com', password: '' }).code, 'password_required');
  assert.equal(validateCredentials({ email: 'a@b.com', password: '12345' }).code, 'password_too_short');
  assert.equal(validateCredentials({ email: 'a@b.com', password: 'x'.repeat(73) }).code, 'password_too_long');
  assert.equal(validateCredentials({ email: 'a@b.com', password: '123456' }), null);
  assert.equal(validateCredentials({ email: 'a@b.com' }, { requirePassword: false }), null);
});

test('错误码映射成中文提示，未知码走状态兜底', () => {
  assert.equal(mapAuthError(400, { error_code: 'invalid_credentials' }).message, '邮箱或密码不正确');
  assert.equal(mapAuthError(400, { error_code: 'email_not_confirmed' }).message, '邮箱还没有验证，请先点开验证邮件里的链接');
  assert.equal(mapAuthError(400, { code: 'user_already_exists', msg: 'User already registered' }).message, '这个邮箱已经注册过了，请直接登录');
  assert.equal(mapAuthError(429, { error_code: 'over_email_send_rate_limit' }).message, '验证邮件发得太频繁了，请稍后再试');
  assert.equal(mapAuthError(422, { error_code: 'same_password' }).message, '新密码不能和当前密码相同');
  assert.equal(mapAuthError(500, {}).message, '云服务暂时不可用，请稍后再试');
  assert.equal(mapAuthError(401, {}).message, '登录状态已失效，请重新登录');
  assert.equal(mapAuthError(418, { error_code: 'teapot' }).code, 'teapot');
  assert.ok(mapAuthError(0, null, { network: true }).message.includes('网络'));
  assert.ok(!JSON.stringify(mapAuthError(400, { msg: 'Invalid login credentials' })).includes('Invalid login credentials'),
    '不把服务端英文原文直接透给用户');
});

test('邮件回调参数解析：会话 / 错误 / PKCE 三种情形', () => {
  const session = parseAuthCallback({ hash: '#access_token=abc&expires_in=3600&refresh_token=def&type=signup' });
  assert.deepEqual(session, { kind: 'session', type: 'signup', accessToken: 'abc', refreshToken: 'def', expiresIn: 3600 });

  const recovery = parseAuthCallback({ hash: '#access_token=abc&refresh_token=def&type=recovery' });
  assert.equal(recovery.type, 'recovery');
  assert.equal(recovery.expiresIn, 3600, '缺少 expires_in 时用 1 小时兜底');

  const expired = parseAuthCallback({ hash: '#error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid' });
  assert.equal(expired.kind, 'error');
  assert.equal(expired.errorCode, 'otp_expired');

  const queryError = parseAuthCallback({ search: '?error=access_denied&error_code=otp_expired' });
  assert.equal(queryError.kind, 'error');

  const pkce = parseAuthCallback({ search: '?code=abc123' });
  assert.equal(pkce.kind, 'pkce_code');

  assert.equal(parseAuthCallback({}).kind, 'none');
  assert.equal(parseAuthCallback({ hash: '#' }).kind, 'none');
});

test('会话过期判定带 60 秒提前量', () => {
  const session = normalizeSession({ access_token: 't', expires_in: 3600 }, 1_000_000_000_000);
  assert.equal(session.expires_at, 1_000_003_600);
  assert.equal(sessionIsFresh(session, 1_000_000_000_000 + 3_500_000), true);
  assert.equal(sessionIsFresh(session, 1_000_000_000_000 + 3_570_000), false, '剩不到 60 秒即视为过期');
  assert.equal(sessionIsFresh(null, 1_000_000_000_000), false);
});

// ----------------------------------------------------------------- 真实请求流

test('注册：需要邮箱验证时只返回 user，不写会话', async () => {
  const { auth, fake, store } = setup();
  const res = await auth.signUp({ email: 'new@example.com', password: 'goodpassword' });
  assert.equal(res.ok, true);
  assert.equal(res.needsConfirmation, true);
  assert.equal(store.readSession(), null, '未验证的注册不应产生登录会话');
  assert.equal(fake.emails.filter(e => e.type === 'signup').length, 1, '应触发一封验证邮件');

  const dup = await auth.signUp({ email: 'new@example.com', password: 'goodpassword' });
  assert.equal(dup.ok, false);
  assert.equal(dup.error.message, '这个邮箱已经注册过了，请直接登录');

  const weak = await auth.signUp({ email: 'x@example.com', password: '123' });
  assert.equal(weak.ok, false);
  assert.equal(weak.error.code, 'password_too_short', '本地先拦，不打无意义的请求');
});

test('登录：未验证邮箱给出可操作提示，验证后可登录并保存会话', async () => {
  const { auth, fake, store } = setup();
  await auth.signUp({ email: 'a@example.com', password: 'goodpassword' });

  const blocked = await auth.signIn({ email: 'a@example.com', password: 'goodpassword' });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.error.message, '邮箱还没有验证，请先点开验证邮件里的链接');
  assert.equal(store.readSession(), null);

  fake.users.get('a@example.com').confirmed = true;
  const wrong = await auth.signIn({ email: 'a@example.com', password: 'badpassword' });
  assert.equal(wrong.ok, false);
  assert.equal(wrong.error.code, 'invalid_credentials');

  const ok = await auth.signIn({ email: 'a@example.com', password: 'goodpassword' });
  assert.equal(ok.ok, true);
  assert.ok(ok.session.access_token);
  const saved = store.readSession();
  assert.equal(saved.user.email, 'a@example.com');
  assert.ok(!('password' in saved), '会话里不能出现密码字段');
});

test('会话过期自动刷新，刷新失败则清除会话', async () => {
  const { auth, fake, store, advance } = setup();
  const user = await registerConfirmed(fake, auth);
  await auth.signIn({ email: 'a@example.com', password: 'goodpassword' });

  advance(3_600_000);
  const refreshed = await auth.getSession();
  assert.equal(refreshed.ok, true, '过期后应自动刷新');
  assert.equal(refreshed.session.user.id, user.id);

  // 刷新令牌失效（例如已在别的设备登出或被撤销）
  const broken = createAuthClient({
    url: 'https://demo.supabase.co',
    anonKey: ANON,
    fetchImpl: createFakeFetch(fake, {
      onRequest: ({ path }) => (path === '/auth/v1/token'
        ? { ok: false, status: 400, async text() { return JSON.stringify({ error_code: 'refresh_token_not_found', msg: 'Invalid Refresh Token' }); } }
        : null)
    }),
    store,
    now: () => Date.now()
  });
  const failed = await broken.getSession();
  assert.equal(failed.ok, false);
  assert.equal(store.readSession(), null, '刷新失败必须清除本地会话');
});

test('并发刷新只发一次请求', async () => {
  let refreshCalls = 0;
  const { auth, fake, advance } = setup({
    onRequest: ({ path, url }) => {
      if (path === '/auth/v1/token' && url.searchParams.get('grant_type') === 'refresh_token') refreshCalls++;
      return null;
    }
  });
  await registerConfirmed(fake, auth);
  await auth.signIn({ email: 'a@example.com', password: 'goodpassword' });
  advance(3_600_000);

  const [a, b, c] = await Promise.all([auth.refresh(), auth.refresh(), auth.refresh()]);
  assert.ok(a.ok && b.ok && c.ok);
  assert.equal(refreshCalls, 1, '三个并发刷新共用一次请求');
});

test('退出登录：即使远端失败也清掉本地会话', async () => {
  const { auth, fake, store } = setup();
  await registerConfirmed(fake, auth);
  await auth.signIn({ email: 'a@example.com', password: 'goodpassword' });
  assert.ok(store.readSession());

  const remoteFail = createAuthClient({
    url: 'https://demo.supabase.co',
    anonKey: ANON,
    fetchImpl: networkFailure(),
    store,
    now: () => Date.now()
  });
  const res = await remoteFail.signOut();
  assert.equal(res.ok, true);
  assert.equal(res.remoteOk, false, '远端失败要如实上报');
  assert.equal(store.readSession(), null, '本地会话必须清掉');
});

test('重置密码：未知邮箱也返回成功（不暴露账号是否存在）', async () => {
  const { auth, fake } = setup();
  await registerConfirmed(fake, auth, 'known@example.com');

  const known = await auth.requestPasswordReset('known@example.com');
  assert.equal(known.ok, true);
  const unknown = await auth.requestPasswordReset('nobody@example.com');
  assert.equal(unknown.ok, true, '两种情况下界面表现应一致');
  assert.equal(fake.emails.filter(e => e.type === 'recovery').length, 1, '只有真实存在的邮箱才真的发信');

  const bad = await auth.requestPasswordReset('not-an-email');
  assert.equal(bad.ok, false);
  assert.equal(bad.error.code, 'email_invalid');
});

test('重置/改密：可用回调带回的令牌设置新密码，然后能用新密码登录', async () => {
  const { auth, fake, store } = setup();
  await registerConfirmed(fake, auth);
  await auth.signIn({ email: 'a@example.com', password: 'goodpassword' });

  const short = await auth.updatePassword('123');
  assert.equal(short.ok, false);
  assert.equal(short.error.code, 'password_too_short');

  const same = await auth.updatePassword('goodpassword');
  assert.equal(same.ok, false);
  assert.equal(same.error.code, 'same_password');

  const changed = await auth.updatePassword('brandnewpassword');
  assert.equal(changed.ok, true);

  await auth.signOut();
  const relogin = await auth.signIn({ email: 'a@example.com', password: 'brandnewpassword' });
  assert.equal(relogin.ok, true, '新密码可以登录');
  assert.ok(store.readSession());
});

test('邮件回调会话可被接受并落盘；无会话时改密给出明确提示', async () => {
  const { auth, store } = setup();
  const callback = parseAuthCallback({ hash: '#access_token=fromemail&refresh_token=r1&type=recovery&expires_in=3600' });
  const accepted = auth.acceptCallbackSession(callback);
  assert.equal(accepted.ok, true);
  assert.equal(store.readSession().access_token, 'fromemail');

  const noSession = createAuthClient({ url: 'https://demo.supabase.co', anonKey: ANON, fetchImpl: networkFailure(), store: createLocalStore(createMemoryStorage()) });
  const res = await noSession.updatePassword('whatever123');
  assert.equal(res.ok, false);
  assert.equal(res.error.code, 'no_session');
});

test('网络不可达时给出网络类错误而不是“密码错误”', async () => {
  const store = createLocalStore(createMemoryStorage());
  const auth = createAuthClient({ url: 'https://demo.supabase.co', anonKey: ANON, fetchImpl: networkFailure('offline'), store });
  const res = await auth.signIn({ email: 'a@example.com', password: 'goodpassword' });
  assert.equal(res.ok, false);
  assert.equal(res.error.code, 'network_error');
  assert.equal(res.error.retryable, true);
});

test('未配置云端时所有认证动作都返回 not_configured，不发请求', async () => {
  let called = 0;
  const auth = createAuthClient({ url: '', anonKey: '', fetchImpl: async () => { called++; }, store: createLocalStore(createMemoryStorage()) });
  assert.equal(auth.configured, false);
  const res = await auth.signIn({ email: 'a@example.com', password: 'goodpassword' });
  assert.equal(res.ok, false);
  assert.equal(res.error.code, 'cloud_not_configured');
  assert.equal(called, 0);
});

test('服务端返回非 JSON（例如网关 HTML 报错页）也不崩，映射为可重试错误', async () => {
  const auth = createAuthClient({
    url: 'https://demo.supabase.co',
    anonKey: ANON,
    fetchImpl: async () => ({ ok: false, status: 502, async text() { return '<html>Bad Gateway</html>'; } }),
    store: createLocalStore(createMemoryStorage())
  });
  const res = await auth.signIn({ email: 'a@example.com', password: 'goodpassword' });
  assert.equal(res.ok, false);
  assert.equal(res.error.code, 'server_error');
  assert.equal(res.error.retryable, true);
});
