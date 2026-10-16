// Supabase Auth facade，底层使用官方 auth-js，并由构建打进本地静态资源。
// 密码的存储、哈希、校验、发信与限流由 Supabase Auth 负责；前端仅临时传递密码，不保存它。
//
// 认证流程：邮箱 + 密码（implicit 流程）。不发送 code_challenge，因此验证/重置邮件里的链接
// 会把 token 放在 URL fragment（#access_token=...）返回，由前端读取后立刻从地址栏清除。
// 已知取舍：token 存在 localStorage，存在 XSS 窃取风险；缓解手段是部署时的 CSP 与不自注入 HTML
// （本文件与 UI 都不写 innerHTML 用户内容）。详见 docs/CLOUD-SETUP.md 的安全说明。

import { GoTrueClient } from '@supabase/auth-js';

const NETWORK_ERROR = { code: 'network_error', message: '网络不可达，请检查连接后重试', retryable: true };

const MESSAGES = {
  invalid_credentials: '邮箱或密码不正确',
  email_not_confirmed: '邮箱还没有验证，请先点开验证邮件里的链接',
  email_exists: '这个邮箱已经注册过了，请直接登录',
  user_already_exists: '这个邮箱已经注册过了，请直接登录',
  weak_password: '密码强度不够（至少 6 位）',
  validation_failed: '邮箱格式不正确',
  email_address_invalid: '邮箱格式不正确',
  over_email_send_rate_limit: '验证邮件发得太频繁了，请稍后再试',
  over_request_rate_limit: '操作太频繁了，请稍后再试',
  signup_disabled: '当前项目已关闭注册',
  same_password: '新密码不能和当前密码相同',
  otp_expired: '链接已失效或已被使用，请重新申请',
  access_denied: '链接已失效或已被使用，请重新申请',
  user_not_found: '找不到这个账号',
  session_not_found: '登录状态已失效，请重新登录',
  refresh_token_not_found: '登录状态已失效，请重新登录',
  invalid_token: '登录状态已失效，请重新登录',
  provider_disabled: '该登录方式未启用',
  user_banned: '该账号已被停用'
};

function pickErrorCode(body) {
  if (!body || typeof body !== 'object') return null;
  return body.error_code || body.code || null;
}

function pickErrorMessage(body) {
  if (!body || typeof body !== 'object') return null;
  return body.msg || body.message || body.error_description || body.error || null;
}

/**
 * 把 GoTrue 的响应映射成稳定的中文提示。
 * 未知错误码一律走 HTTP 状态兜底，绝不把服务端原始英文堆到界面上。
 */
export function mapAuthError(status, body, { network = false } = {}) {
  if (network) return { ...NETWORK_ERROR };

  const code = pickErrorCode(body);
  const raw = pickErrorMessage(body);
  const known = code && (MESSAGES[code] || (raw && MESSAGES[raw]) || (code in MESSAGES && MESSAGES[code]));
  if (code && MESSAGES[code]) return { code, message: MESSAGES[code], retryable: false };
  if (raw && MESSAGES[raw]) return { code: raw, message: MESSAGES[raw], retryable: false };

  if (status === 400) return { code: code || 'bad_request', message: '提交的信息不被接受，请检查后重试', retryable: false };
  if (status === 401) return { code: code || 'unauthorized', message: '登录状态已失效，请重新登录', retryable: false };
  if (status === 403) return { code: code || 'forbidden', message: '没有权限执行这个操作', retryable: false };
  if (status === 404) return { code: code || 'not_found', message: '接口不存在，请确认云项目地址是否正确', retryable: false };
  if (status === 422) return { code: code || 'unprocessable', message: '提交的信息不被接受，请检查后重试', retryable: false };
  if (status === 429) return { code: code || 'rate_limited', message: '操作太频繁了，请稍后再试', retryable: true };
  if (status >= 500) return { code: 'server_error', message: '云服务暂时不可用，请稍后再试', retryable: true };
  return { code: code || 'unknown_error', message: '操作没有完成，请稍后再试', retryable: true };
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** 提交前的本地校验：只做格式与长度的即时提示，真正的规则由 Supabase 判定。 */
export function validateCredentials({ email, password }, { requirePassword = true } = {}) {
  const mail = typeof email === 'string' ? email.trim() : '';
  if (!mail) return { code: 'email_required', message: '请填写邮箱' };
  if (!EMAIL_RE.test(mail) || mail.length > 254) return { code: 'email_invalid', message: '邮箱格式不正确' };
  if (!requirePassword) return null;
  const pwd = typeof password === 'string' ? password : '';
  if (!pwd) return { code: 'password_required', message: '请填写密码' };
  if (pwd.length < 6) return { code: 'password_too_short', message: '密码至少 6 位' };
  if (pwd.length > 72) return { code: 'password_too_long', message: '密码太长（最多 72 位）' };
  return null;
}

/**
 * 解析验证/重置邮件跳回来的地址参数。
 * 支持：
 *  - fragment：#access_token=...&refresh_token=...&type=signup|recovery
 *  - fragment 错误：#error=access_denied&error_code=otp_expired
 *  - query 错误：?error=...&error_code=...（部分场景 Supabase 会放在 query）
 *  - query 里的 PKCE code（本项目不发 code_challenge，收到即提示需在同一浏览器打开）
 */
export function parseAuthCallback({ hash = '', search = '' } = {}) {
  const fromHash = new URLSearchParams(String(hash).replace(/^#/, ''));
  const fromQuery = new URLSearchParams(String(search).replace(/^\?/, ''));
  const pick = (name) => fromHash.get(name) || fromQuery.get(name);

  const error = pick('error');
  const errorCode = pick('error_code');
  if (error || errorCode) {
    return {
      kind: 'error',
      error: error || 'access_denied',
      errorCode: errorCode || error,
      errorDescription: pick('error_description') || ''
    };
  }

  const code = fromQuery.get('code');
  if (code && !fromHash.get('access_token')) {
    return { kind: 'pkce_code', code };
  }

  const accessToken = pick('access_token');
  if (!accessToken) return { kind: 'none' };

  const expiresIn = Number(pick('expires_in'));
  return {
    kind: 'session',
    type: pick('type') || 'unknown',
    accessToken,
    refreshToken: pick('refresh_token') || '',
    expiresIn: Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn : 3600
  };
}

/**
 * 会话形状：{ access_token, refresh_token, expires_at(秒), user:{id,email,email_confirmed_at} }
 *
 * 重要：没有 user.id 的响应一律视为无效会话（返回 null）。邮件回调只带回令牌、
 * 不带用户信息，必须先用 GET /auth/v1/user 换回用户身份再调用本函数，否则会出现
 * 「界面显示已登录、同步引擎却因为没有 userId 而退回游客模式」的不一致状态。
 */
export function normalizeSession(data, nowMs) {
  if (!data || typeof data !== 'object' || !data.access_token) return null;
  const user = data.user && typeof data.user === 'object' ? data.user : {};
  const userId = typeof user.id === 'string' ? user.id.trim() : '';
  if (!userId) return null;
  const expiresAt = Number.isFinite(Number(data.expires_at))
    ? Number(data.expires_at)
    : Math.floor(nowMs / 1000) + (Number(data.expires_in) > 0 ? Number(data.expires_in) : 3600);
  return {
    access_token: String(data.access_token),
    refresh_token: typeof data.refresh_token === 'string' ? data.refresh_token : '',
    expires_at: expiresAt,
    user: {
      id: userId,
      email: typeof user.email === 'string' ? user.email : '',
      email_confirmed_at: user.email_confirmed_at || user.confirmed_at || null
    }
  };
}

export function sessionIsFresh(session, nowMs, skewSeconds = 60) {
  if (!session || !session.access_token) return false;
  return session.expires_at - skewSeconds > Math.floor(nowMs / 1000);
}

/**
 * 这次失败是「暂时连不上」还是「凭据真的失效」？
 * 网络错误（status 0 且带 network 标记）、5xx、429 属于前者：此时清会话会把用户
 * 直接踢下线、连离线缓存都读不出来，是最容易踩的坑（评审 P2-8）。
 */
export function isTransientAuthFailure(res) {
  if (!res) return false;
  const status = Number(res.status || 0);
  if (status === 0) return true;                 // 网络不可达 / 超时
  if (status === 429) return true;               // 限流
  if (status >= 500) return true;                // 服务端临时故障
  const code = res.error?.code || '';
  return code === 'network_unreachable' || code === 'timeout' || code === 'server_error' || code === 'rate_limited';
}

/**
 * 创建认证客户端。依赖全部注入，便于在 Node 里用假 fetch 做单元测试。
 */
export function createAuthClient({
  url,
  anonKey,
  fetchImpl = globalThis.fetch,
  store = null,
  now = () => Date.now(),
  emailRedirectTo = null
} = {}) {
  const base = String(url || '').replace(/\/+$/, '');
  const configured = Boolean(base && anonKey);
  let authGeneration = 0;
  let sdkSequence = 0;
  const refreshesInFlight = new Map();

  const noConfig = () => ({
    ok: false,
    status: 0,
    error: { code: 'cloud_not_configured', message: '未配置云端，当前为游客模式', retryable: false }
  });
  const staleError = () => ({
    code: 'stale_auth_operation',
    message: '登录状态已经改变，请重试',
    retryable: false
  });
  const readSession = () => {
    try { return store?.readSession?.() || null; } catch { return null; }
  };

  /**
   * 每个异步操作使用独立、仅在内存中的 auth-js 客户端。这样 GoTrue SDK 的状态更新
   * 永远不会直接碰应用会话；只有通过下方代次与令牌检查的结果才能写入应用 store。
   */
  function createSdk() {
    const refreshPath = new URL(`${base}/auth/v1/token`).pathname;
    return new GoTrueClient({
      url: `${base}/auth/v1`,
      headers: { apikey: anonKey },
      fetch: async (input, init) => {
        const requestUrl = new URL(typeof input === 'string' || input instanceof URL ? String(input) : input.url);
        const isRefresh = requestUrl.pathname === refreshPath &&
          requestUrl.searchParams.get('grant_type') === 'refresh_token';
        let response;
        try {
          response = await fetchImpl(input, init);
        } catch (error) {
          if (isRefresh) {
            return new Response(JSON.stringify({
              code: 'mofish_transient_0',
              error_code: 'mofish_transient_0',
              msg: 'Supabase Auth is temporarily unavailable'
            }), { status: 400, headers: { 'Content-Type': 'application/json' } });
          }
          throw error;
        }
        // auth-js retries refresh 5xx responses for up to one 30-second tick. Keep its
        // error parsing, but stop the retry loop after the first infrastructure response.
        if (isRefresh && response.status >= 500) {
          return new Response(JSON.stringify({
            code: `mofish_transient_${response.status}`,
            error_code: `mofish_transient_${response.status}`,
            msg: 'Supabase Auth is temporarily unavailable'
          }), { status: 400, headers: { 'Content-Type': 'application/json' } });
        }
        return response;
      },
      storageKey: `mofish-auth-operation-${++sdkSequence}`,
      autoRefreshToken: false,
      persistSession: false,
      detectSessionInUrl: false,
      skipAutoInitialize: true
    });
  }

  function sdkError(error) {
    const code = error?.code || error?.name || 'unknown_error';
    const boundedTransient = /^mofish_transient_(\d{1,3})$/.exec(String(code));
    const status = boundedTransient ? Number(boundedTransient[1]) : Number(error?.status || 0);
    const network = status === 0;
    return { ...mapAuthError(status, { code, error_code: code, message: error?.message }, { network }), status };
  }

  function sdkStatus(error) {
    const code = /^mofish_transient_(\d{1,3})$/.exec(String(error?.code || ''));
    return code ? Number(code[1]) : Number(error?.status || 0);
  }

  async function withSdk(action) {
    const sdk = createSdk();
    try {
      return await action(sdk);
    } catch (error) {
      const wrapped = Object.assign(new Error(error?.message || 'Auth SDK request failed'), {
        status: Number(error?.status || 0),
        code: error?.code || 'network_error',
        name: error?.name || 'AuthRetryableFetchError'
      });
      return { data: null, error: wrapped };
    } finally {
      try { await sdk.dispose(); } catch { /* 认证操作已结束；释放 SDK 定时器与监听器即可。 */ }
    }
  }

  function failure(result) {
    const error = result?.error || {};
    return {
      ok: false,
      status: sdkStatus(error),
      error: sdkError(error)
    };
  }

  function isCurrentContext(generation, originalSession) {
    if (authGeneration !== generation) return false;
    const current = readSession();
    if (!originalSession) return !current;
    return current?.access_token === originalSession.access_token &&
      current?.refresh_token === originalSession.refresh_token &&
      current?.user?.id === originalSession.user?.id;
  }

  function writeSession(session, generation, originalSession) {
    if (!isCurrentContext(generation, originalSession)) return false;
    store?.writeSession(session);
    return true;
  }

  function startIdentityOperation() {
    return ++authGeneration;
  }

  const client = {
    configured,

    async signUp({ email, password }) {
      const local = validateCredentials({ email, password });
      if (local) return { ok: false, error: local };
      if (!configured) return noConfig();
      const generation = startIdentityOperation();
      const result = await withSdk(sdk => sdk.signUp({
        email: String(email).trim(),
        password,
        options: emailRedirectTo ? { emailRedirectTo } : undefined
      }));
      if (result.error) return failure(result);
      const session = normalizeSession(result.data?.session, now());
      if (result.data?.session && !session) {
        return { ok: false, error: { code: 'no_session', message: '注册没有返回有效会话，请稍后再试', retryable: true } };
      }
      if (session && !writeSession(session, generation, readSession())) return { ok: false, stale: true, error: staleError() };
      return {
        ok: true,
        needsConfirmation: !session,
        session,
        user: result.data?.user || null
      };
    },

    async signIn({ email, password }) {
      const local = validateCredentials({ email, password });
      if (local) return { ok: false, error: local };
      if (!configured) return noConfig();
      const generation = startIdentityOperation();
      const result = await withSdk(sdk => sdk.signInWithPassword({ email: String(email).trim(), password }));
      if (result.error) return failure(result);
      const session = normalizeSession(result.data?.session, now());
      if (!session) return { ok: false, error: { code: 'no_session', message: '登录没有返回有效会话，请稍后再试', retryable: true } };
      if (!writeSession(session, generation, readSession())) return { ok: false, stale: true, error: staleError() };
      return { ok: true, session };
    },

    /**
     * 用 refresh_token 换新会话；并发调用共享同一次请求。
     *
     * 「刷新失败」有两种性质完全不同的情况，必须分开处理（评审 P2-8）：
     *  - 凭据真的失效（4xx：invalid_grant / refresh_token_not_found）→ 清除会话，要求重新登录；
     *  - 暂时连不上（网络错误 / 5xx / 429）→ **保留**会话与本地缓存，只报告可重试的失败，
     *    否则用户一断网就会发现登录态被清掉、账号缓存被当成「别人的数据」。
     */
    async refresh(refreshToken) {
      const originalSession = readSession();
      const generation = authGeneration;
      const token = refreshToken || originalSession?.refresh_token;
      if (!token) return { ok: false, transient: false, error: { code: 'no_refresh_token', message: '登录状态已失效，请重新登录', retryable: false } };
      if (!configured) return { ...noConfig(), transient: false };
      if (originalSession && token !== originalSession.refresh_token) return { ok: false, stale: true, error: staleError() };
      const flightKey = `${generation}:${token}`;
      if (refreshesInFlight.has(flightKey)) return refreshesInFlight.get(flightKey);
      const flight = (async () => {
        const result = await withSdk(sdk => sdk.refreshSession({ refresh_token: token }));
        if (result.error) {
          if (!isCurrentContext(generation, originalSession)) return { ok: false, stale: true, error: staleError() };
          const error = sdkError(result.error);
          if (isTransientAuthFailure({ status: sdkStatus(result.error), error })) {
            return {
              ok: false,
              transient: true,
              status: sdkStatus(result.error),
              error
            };
          }
          if (originalSession) store?.clearSession();
          return { ok: false, transient: false, error };
        }
        const session = normalizeSession(result.data?.session, now());
        if (!session) {
          if (!isCurrentContext(generation, originalSession)) return { ok: false, stale: true, error: staleError() };
          return { ok: false, transient: false, error: { code: 'no_session', message: '刷新没有返回有效会话，请重新登录', retryable: false } };
        }
        if (!writeSession(session, generation, originalSession)) return { ok: false, stale: true, error: staleError() };
        return { ok: true, session };
      })();
      refreshesInFlight.set(flightKey, flight);
      try { return await flight; }
      finally { if (refreshesInFlight.get(flightKey) === flight) refreshesInFlight.delete(flightKey); }
    },

    async signOut() {
      const session = readSession();
      startIdentityOperation();
      // 先同步退出本机，再请求远端；在途刷新与回调已因代次变化而失效。
      store?.clearSession();
      let remoteOk = true;
      if (session?.access_token) {
        if (!configured) remoteOk = false;
        else {
          const result = await withSdk(sdk => sdk.admin.signOut(session.access_token));
          remoteOk = !result.error;
        }
      }
      return { ok: true, remoteOk };
    },

    async getUser(token) {
      const access = token || readSession()?.access_token;
      if (!access) return { ok: false, error: { code: 'no_session', message: '尚未登录', retryable: false } };
      if (!configured) return noConfig();
      const result = await withSdk(sdk => sdk.getUser(access));
      if (result.error) return failure(result);
      return { ok: true, status: 200, data: result.data?.user || null };
    },

    async requestPasswordReset(email) {
      const local = validateCredentials({ email }, { requirePassword: false });
      if (local) return { ok: false, error: local };
      if (!configured) return noConfig();
      const result = await withSdk(sdk => sdk.resetPasswordForEmail(String(email).trim(),
        emailRedirectTo ? { redirectTo: emailRedirectTo } : undefined));
      return result.error ? failure(result) : { ok: true, status: 200, data: result.data || null };
    },

    async resendConfirmation(email) {
      const local = validateCredentials({ email }, { requirePassword: false });
      if (local) return { ok: false, error: local };
      if (!configured) return noConfig();
      const result = await withSdk(sdk => sdk.resend({
        type: 'signup',
        email: String(email).trim(),
        options: emailRedirectTo ? { emailRedirectTo } : undefined
      }));
      return result.error ? failure(result) : { ok: true, status: 200, data: result.data || null };
    },

    /** 修改密码（重置流程最后一步，或登录后主动改密）。 */
    async updatePassword(password, token) {
      if (typeof password !== 'string' || password.length < 6) {
        return { ok: false, error: { code: 'password_too_short', message: '密码至少 6 位', retryable: false } };
      }
      if (password.length > 72) {
        return { ok: false, error: { code: 'password_too_long', message: '密码太长（最多 72 位）', retryable: false } };
      }
      const originalSession = readSession();
      const access = token || originalSession?.access_token;
      if (!access) return { ok: false, error: { code: 'no_session', message: '链接已失效，请重新申请重置邮件', retryable: false } };
      if (!configured) return noConfig();
      const generation = authGeneration;
      if (originalSession && access !== originalSession.access_token) return { ok: false, stale: true, error: staleError() };
      if (!originalSession?.refresh_token) return { ok: false, error: { code: 'no_session', message: '登录状态已失效，请重新申请重置邮件', retryable: false } };

      const result = await withSdk(async sdk => {
        const hydrated = await sdk.setSession({ access_token: access, refresh_token: originalSession.refresh_token });
        if (hydrated.error) return hydrated;
        const activeSession = normalizeSession(hydrated.data?.session, now());
        if (!activeSession) return { data: null, error: new Error('No valid session') };
        if (!isCurrentContext(generation, originalSession)) return { data: null, error: null, stale: true };
        if (activeSession.refresh_token !== originalSession.refresh_token || activeSession.access_token !== originalSession.access_token) {
          if (!writeSession(activeSession, generation, originalSession)) return { data: null, error: null, stale: true };
        }
        const updated = await sdk.updateUser({ password });
        return { ...updated, session: activeSession };
      });
      if (result.stale || !isCurrentContext(generation, readSession())) return { ok: false, stale: true, error: staleError() };
      if (result.error) return failure(result);
      return { ok: true };
    },

    /**
     * 读会话：过期则自动刷新。
     *
     * reason 取值与含义（调用方必须区分，评审 P2-8）：
     *   'fresh'        —— 可用
     *   'refreshed'    —— 过期但已刷新成功
     *   'expired'      —— 过期且明确要求不刷新
     *   'offline'      —— 网络/服务端暂时不可用：**凭据与会话仍保留**（session 字段照常返回），
     *                    调用方应进入离线状态，稍后自动重试，而不是把用户踢下线
     *   'invalid_grant'—— refresh token 真的失效，会话已被清除，需要重新登录
     *   'no_session'   —— 本机没有会话
     */
    async getSession({ allowRefresh = true } = {}) {
      const session = readSession();
      if (!session) return { ok: false, session: null, reason: 'no_session' };
      if (sessionIsFresh(session, now())) return { ok: true, session, reason: 'fresh' };
      if (!allowRefresh) return { ok: false, session, reason: 'expired' };
      const refreshed = await client.refresh(session.refresh_token);
      if (refreshed.ok) return { ok: true, session: refreshed.session, reason: 'refreshed' };
      if (refreshed.stale) return { ok: false, session: readSession(), reason: 'stale', error: refreshed.error };
      if (refreshed.transient) {
        const kept = readSession() || session;
        return { ok: false, session: kept, reason: 'offline', error: refreshed.error };
      }
      return { ok: false, session: null, reason: 'invalid_grant', error: refreshed.error };
    },

    /**
     * 保存邮件回调带回的会话（邮箱验证 / 重置密码链接）。
     *
     * 回调的 URL 片段里只有令牌，没有用户信息。必须先向认证服务确认身份
     * （GET /auth/v1/user），否则会得到一份 user.id 为空的会话：界面以为已登录，
     * 同步引擎却因为没有 userId 而退回游客模式（评审 P1-4）。
     */
    async acceptCallbackSession(callback) {
      if (!callback || callback.kind !== 'session' || !callback.accessToken) {
        return { ok: false, error: { code: 'bad_callback', message: '链接无效或已过期', retryable: false } };
      }
      if (!configured) return noConfig();
      const generation = startIdentityOperation();
      const probe = await withSdk(sdk => sdk.getUser(callback.accessToken));
      if (probe.error) {
        return {
          ok: false,
          error: sdkError(probe.error)
        };
      }
      const session = normalizeSession({
        access_token: callback.accessToken,
        refresh_token: callback.refreshToken,
        expires_in: callback.expiresIn,
        user: probe.data?.user
      }, now());
      if (!session) {
        return { ok: false, error: { code: 'bad_callback', message: '链接没有对应到有效账号，请重新申请邮件', retryable: false } };
      }
      if (!writeSession(session, generation, readSession())) return { ok: false, stale: true, error: staleError() };
      return { ok: true, session, type: callback.type };
    }
  };

  return client;
}
