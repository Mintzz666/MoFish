// Supabase PostgREST 客户端：只调用三个经过授权的 RPC。
//
// 为什么不用 PostgREST 的表级读写：表级 UPDATE 无法表达「revision 必须匹配」这个条件，
// 只能靠先读后写，存在竞态。三个 RPC 都在数据库内做条件更新与参数校验（见 supabase/migrations）。
//
// 本文件不信任自己的入参：所有权限判断都在数据库（RLS + auth.uid()），前端只负责传对参数。

const RPC_PATHS = {
  ensureAquarium: '/rest/v1/rpc/ensure_aquarium',
  saveAquarium: '/rest/v1/rpc/save_aquarium',
  settleGrowth: '/rest/v1/rpc/settle_growth',
  recordFeeding: '/rest/v1/rpc/record_feeding'
};

const FAILURES = {
  not_authenticated: { kind: 'unauthenticated', message: '登录状态已失效，请重新登录', retryable: false },
  invalid_mode: { kind: 'error', message: '请求方式不被接受', retryable: false }
};

function describeHttpFailure(status, body) {
  const serverMessage = body && typeof body === 'object' ? (body.message || body.details || '') : '';
  if (status === 401) return { kind: 'unauthenticated', message: '登录状态已失效，请重新登录', retryable: false };
  if (status === 403) return { kind: 'forbidden', message: '没有权限访问这个鱼缸', retryable: false };
  if (status === 404) {
    return {
      kind: 'missing_backend',
      message: serverMessage && /could not find the function/i.test(serverMessage)
        ? '云端还没有安装数据库迁移，请先执行 supabase/migrations 里的脚本'
        : '云服务接口不可用，请确认项目地址与迁移状态',
      retryable: false
    };
  }
  if (status === 400) return { kind: 'bad_request', message: '云端拒绝了这次请求，请稍后重试', retryable: false };
  if (status === 429) return { kind: 'rate_limited', message: '操作太频繁了，请稍后再试', retryable: true };
  if (status >= 500) return { kind: 'server_error', message: '云服务暂时不可用，请稍后再试', retryable: true };
  if (status === 0) return { kind: 'network_error', message: '网络不可达，修改已保存在本机', retryable: true };
  return { kind: 'unknown_error', message: '云端操作没有完成，请稍后重试', retryable: true };
}

/** 把数据库返回的状态字符串整理成前端统一的结果对象。 */
export function interpretRpcRow(row) {
  if (!row || typeof row !== 'object') {
    return { kind: 'error', message: '云端返回了无法识别的结果', retryable: true };
  }
  const status = row.status;
  if (status === 'ok') {
    return {
      kind: 'ok',
      revision: row.revision == null ? null : Number(row.revision),
      creditedSeconds: row.credited_seconds == null ? 0 : Number(row.credited_seconds),
      creditedBites: row.credited == null ? 0 : Number(row.credited),
      duplicate: row.duplicate === true,
      state: row.state_json ?? null,
      lastGrowthAt: row.last_growth_at ?? null,
      aquariumId: row.aquarium_id ?? null,
      created: row.created === true
    };
  }
  if (status === 'conflict') {
    return { kind: 'conflict', revision: row.revision == null ? null : Number(row.revision) };
  }
  if (status === 'rate_limited') return { kind: 'rate_limited', message: '今天的进食记录较多，待同步记录已保留，请稍后再试', retryable: true };
  if (status === 'not_found') return { kind: 'not_found', message: '云端没有这条鱼缸' };
  if (status === 'invalid_state') {
    return { kind: 'invalid_state', errorCode: row.error_code || 'invalid_state', message: '云端认为这份存档不合法，已停止写入以免损坏数据' };
  }
  if (status === 'invalid_argument') {
    return { kind: 'invalid_argument', errorCode: row.error_code || 'invalid_argument', message: '请求参数不完整，已停止写入' };
  }
  if (status === 'not_authenticated') return { ...FAILURES.not_authenticated };
  return { kind: 'error', message: `云端返回了未处理的状态：${String(status)}`, retryable: false };
}

export function createCloudApi({
  url,
  anonKey,
  fetchImpl = globalThis.fetch,
  getAccessToken = async () => null,
  refreshAccessToken = async () => null,
  timeoutMs = 15000
} = {}) {
  const base = String(url || '').replace(/\/+$/, '');
  const configured = Boolean(base && anonKey);

  async function post(path, payload, token, { keepalive = false } = {}) {
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
    try {
      const response = await fetchImpl(`${base}${path}`, {
        method: 'POST',
        headers: {
          apikey: anonKey,
          Authorization: `Bearer ${token || anonKey}`,
          'Content-Type': 'application/json',
          Accept: 'application/json'
        },
        body: JSON.stringify(payload),
        // 页面关闭时的最后一次写入：keepalive 让浏览器把请求发完，但代价是不能带自定义 signal。
        ...(keepalive ? { keepalive: true } : (controller ? { signal: controller.signal } : {}))
      });
      const text = await response.text();
      let body = null;
      try { body = text ? JSON.parse(text) : null; } catch { body = null; }
      return { status: response.status, ok: response.ok, body };
    } catch {
      return { status: 0, ok: false, body: null };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /**
   * 取访问令牌。允许两种返回形式：
   *   - 字符串（旧形式）
   *   - `{ token, transient }`：transient 表示「暂时拿不到令牌」而不是「未登录」。
   *     前者必须归为可重试的离线失败（保留本机改动），后者才是登录失效（评审 P2-8）。
   */
  async function acquireToken(getter) {
    const raw = await getter();
    if (raw == null) return { token: null, transient: false };
    if (typeof raw === 'string') return { token: raw, transient: false };
    return { token: raw.token ?? null, transient: Boolean(raw.transient) };
  }

  function noTokenFailure({ transient }) {
    if (transient) {
      return { ok: false, result: { kind: 'offline', message: '暂时无法连接云端，改动已保存在本机', retryable: true } };
    }
    return { ok: false, result: { ...FAILURES.not_authenticated } };
  }

  async function rpc(name, payload, { keepalive = false } = {}) {
    if (!configured) {
      return { ok: false, result: { kind: 'not_configured', message: '未配置云端，当前为游客模式', retryable: false } };
    }
    const path = RPC_PATHS[name];
    let { token, transient } = await acquireToken(getAccessToken);

    for (let attempt = 0; attempt < 2; attempt++) {
      const res = await post(path, payload, token, { keepalive });
      if (res.status === 401 && attempt === 0 && !keepalive) {
        // 访问令牌过期：刷新一次再重试，避免把用户直接踢下线。
        const refreshed = await acquireToken(refreshAccessToken);
        token = refreshed.token;
        transient = refreshed.transient;
        if (!token) return noTokenFailure({ transient });
        continue;
      }
      if (!res.ok) return { ok: false, result: describeHttpFailure(res.status, res.body) };
      const row = Array.isArray(res.body) ? res.body[0] : res.body;
      const result = interpretRpcRow(row);
      return { ok: result.kind === 'ok', result, row };
    }
    return noTokenFailure({ transient });
  }

  return {
    configured,

    /** 幂等开缸 / 读取云端现有鱼缸。传本地候选存档即可：云端已有记录时该参数被忽略。 */
    async ensureAquarium(initialState, stateVersion = 1) {
      return rpc('ensureAquarium', { p_initial_state: initialState, p_state_version: stateVersion });
    },

    /** 原子保存：revision 不匹配时云端返回 conflict 与服务端当前 revision。 */
    async saveAquarium({ aquariumId, expectedRevision, state, stateVersion = 1, keepalive = false }) {
      return rpc('saveAquarium', {
        p_id: aquariumId,
        p_expected_revision: expectedRevision,
        p_state: state,
        p_state_version: stateVersion
      }, { keepalive });
    },

    /** 服务端时间结算离线成长；重复调用不重复奖励。 */
    async settleGrowth(aquariumId, capSeconds = 86400) {
      return rpc('settleGrowth', { p_id: aquariumId, p_cap_seconds: capSeconds });
    },

    /**
     * 进食记账（可重试去重）：每次「鱼真的吃到一口」用一个唯一 operation_id 提交。
     * 服务端只记录事件，不直接改 growth —— 营养成长在 settle_growth 里统一结算，
     * 因此重复提交不会重复奖励，断网重连后重试也安全。
     */
    async recordFeeding(aquariumId, operationId, fishId, bites = 1) {
      return rpc('recordFeeding', {
        p_id: aquariumId,
        p_operation_id: operationId,
        p_fish_id: fishId,
        p_bites: bites
      });
    }
  };
}

export { describeHttpFailure };
