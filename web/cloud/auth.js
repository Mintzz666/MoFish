// Supabase Auth（GoTrue）REST 客户端。
//
// 为什么不用官方 JS SDK：本项目刻意保持零第三方运行时代码与零构建依赖，且用户网络环境下
// CDN 并不总是可达。这里只用到 6 个经过公开文档确认的 REST 端点，全部走 fetch。
// 密码的存储、哈希、校验、发信与限流全部由 Supabase Auth 负责，本文件不接触也不保存密码。
//
// 认证流程：邮箱 + 密码（implicit 流程）。不发送 code_challenge，因此验证/重置邮件里的链接
// 会把 token 放在 URL fragment（#access_token=...）返回，由前端读取后立刻从地址栏清除。
// 已知取舍：token 存在 localStorage，存在 XSS 窃取风险；缓解手段是部署时的 CSP 与不自注入 HTML
// （本文件与 UI 都不写 innerHTML 用户内容）。详见 docs/CLOUD-SETUP.md 的安全说明。

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

/** 会话形状：{ access_token, refresh_token, expires_at(秒), user:{id,email,email_confirmed_at} } */
export function normalizeSession(data, nowMs) {
  if (!data || typeof data !== 'object' || !data.access_token) return null;
  const user = data.user && typeof data.user === 'object' ? data.user : {};
  const expiresAt = Number.isFinite(Number(data.expires_at))
    ? Number(data.expires_at)
    : Math.floor(nowMs / 1000) + (Number(data.expires_in) > 0 ? Number(data.expires_in) : 3600);
  return {
    access_token: String(data.access_token),
    refresh_token: typeof data.refresh_token === 'string' ? data.refresh_token : '',
    expires_at: expiresAt,
    user: {
      id: typeof user.id === 'string' ? user.id : '',
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
  let refreshInFlight = null;

  const endpoint = (path, query) => {
    const u = new URL(`${base}${path}`);
    if (query) for (const [k, v] of Object.entries(query)) if (v != null) u.searchParams.set(k, String(v));
    return u.toString();
  };

  async function request(path, { method = 'POST', body, token, query, keepSession = true } = {}) {
    if (!base || !anonKey) return { ok: false, status: 0, error: { code: 'cloud_not_configured', message: '未配置云端，当前为游客模式', retryable: false } };

    let response;
    try {
      response = await fetchImpl(endpoint(path, query), {
        method,
        headers: {
          apikey: anonKey,
          Authorization: `Bearer ${token || anonKey}`,
          'Content-Type': 'application/json',
          Accept: 'application/json'
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) })
      });
    } catch (err) {
      return { ok: false, status: 0, error: mapAuthError(0, null, { network: true }) };
    }

    if (response.status === 204) return { ok: true, status: 204, data: null };

    let data = null;
    try {
      const text = await response.text();
      data = text ? JSON.parse(text) : null;
    } catch { data = null; }

    if (response.ok) {
      const session = keepSession ? normalizeSession(data, now()) : null;
      return { ok: true, status: response.status, data, session };
    }
    return { ok: false, status: response.status, data, error: mapAuthError(response.status, data) };
  }

  const client = {
    configured: Boolean(base && anonKey),

    async signUp({ email, password }) {
      const local = validateCredentials({ email, password });
      if (local) return { ok: false, error: local };
      const res = await request('/auth/v1/signup', {
        body: { email: String(email).trim(), password },
        query: emailRedirectTo ? { redirect_to: emailRedirectTo } : null
      });
      if (!res.ok) return res;
      // 需要邮箱验证时 GoTrue 只返回 user 对象（没有 access_token）
      const needsConfirmation = !res.session;
      if (res.session) store?.writeSession(res.session);
      return { ok: true, needsConfirmation, session: res.session, user: res.data?.user || res.data || null };
    },

    async signIn({ email, password }) {
      const local = validateCredentials({ email, password });
      if (local) return { ok: false, error: local };
      const res = await request('/auth/v1/token', {
        query: { grant_type: 'password' },
        body: { email: String(email).trim(), password }
      });
      if (!res.ok) return res;
      if (!res.session) return { ok: false, error: { code: 'no_session', message: '登录没有返回有效会话，请稍后再试', retryable: true } };
      store?.writeSession(res.session);
      return { ok: true, session: res.session };
    },

    /** 用 refresh_token 换新会话；并发调用共享同一次请求。 */
    async refresh(refreshToken) {
      const token = refreshToken || store?.readSession()?.refresh_token;
      if (!token) return { ok: false, error: { code: 'no_refresh_token', message: '登录状态已失效，请重新登录', retryable: false } };
      if (refreshInFlight) return refreshInFlight;
      refreshInFlight = (async () => {
        const res = await request('/auth/v1/token', {
          query: { grant_type: 'refresh_token' },
          body: { refresh_token: token }
        });
        if (!res.ok || !res.session) {
          store?.clearSession();
          return { ok: false, error: res.error || { code: 'refresh_failed', message: '登录状态已失效，请重新登录', retryable: false } };
        }
        store?.writeSession(res.session);
        return { ok: true, session: res.session };
      })();
      try { return await refreshInFlight; } finally { refreshInFlight = null; }
    },

    async signOut() {
      const session = store?.readSession();
      let remoteOk = true;
      if (session?.access_token) {
        const res = await request('/auth/v1/logout', { method: 'POST', token: session.access_token });
        remoteOk = res.ok;
      }
      store?.clearSession();
      return { ok: true, remoteOk };
    },

    async getUser(token) {
      const access = token || store?.readSession()?.access_token;
      if (!access) return { ok: false, error: { code: 'no_session', message: '尚未登录', retryable: false } };
      return request('/auth/v1/user', { method: 'GET', token: access, keepSession: false });
    },

    async requestPasswordReset(email) {
      const local = validateCredentials({ email }, { requirePassword: false });
      if (local) return { ok: false, error: local };
      return request('/auth/v1/recover', {
        body: { email: String(email).trim() },
        query: emailRedirectTo ? { redirect_to: emailRedirectTo } : null
      });
    },

    async resendConfirmation(email) {
      const local = validateCredentials({ email }, { requirePassword: false });
      if (local) return { ok: false, error: local };
      return request('/auth/v1/resend', {
        body: { type: 'signup', email: String(email).trim() },
        query: emailRedirectTo ? { redirect_to: emailRedirectTo } : null
      });
    },

    /** 修改密码（重置流程最后一步，或登录后主动改密）。 */
    async updatePassword(password, token) {
      if (typeof password !== 'string' || password.length < 6) {
        return { ok: false, error: { code: 'password_too_short', message: '密码至少 6 位', retryable: false } };
      }
      if (password.length > 72) {
        return { ok: false, error: { code: 'password_too_long', message: '密码太长（最多 72 位）', retryable: false } };
      }
      const access = token || store?.readSession()?.access_token;
      if (!access) return { ok: false, error: { code: 'no_session', message: '链接已失效，请重新申请重置邮件', retryable: false } };
      const res = await request('/auth/v1/user', { method: 'PUT', token: access, body: { password }, keepSession: false });
      if (!res.ok) return res;
      return { ok: true };
    },

    /** 读会话：过期则自动刷新；刷新失败即清除并视为未登录。 */
    async getSession({ allowRefresh = true } = {}) {
      const session = store?.readSession();
      if (!session) return { ok: false, session: null, reason: 'no_session' };
      if (sessionIsFresh(session, now())) return { ok: true, session };
      if (!allowRefresh) return { ok: false, session, reason: 'expired' };
      const refreshed = await client.refresh(session.refresh_token);
      if (!refreshed.ok) return { ok: false, session: null, reason: 'refresh_failed', error: refreshed.error };
      return { ok: true, session: refreshed.session };
    },

    /** 保存邮件回调带回的会话（验证/重置链接）。 */
    acceptCallbackSession(callback) {
      if (!callback || callback.kind !== 'session') return { ok: false, error: { code: 'bad_callback', message: '链接无效', retryable: false } };
      const session = normalizeSession({
        access_token: callback.accessToken,
        refresh_token: callback.refreshToken,
        expires_in: callback.expiresIn
      }, now());
      if (!session) return { ok: false, error: { code: 'bad_callback', message: '链接无效', retryable: false } };
      store?.writeSession(session);
      return { ok: true, session, type: callback.type };
    }
  };

  return client;
}
