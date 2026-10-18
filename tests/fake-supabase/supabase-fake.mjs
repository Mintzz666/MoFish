// ⚠️ 这是**本地假后端**，只用于在拿不到真实 Supabase 项目时验证前端与同步逻辑。
// 它刻意复刻 supabase/migrations 里的判定语义（条件更新、冲突返回、整秒结算、24h 上限），
// 但它不是 Supabase：不校验 JWT 签名、不做限流、不发信、没有连接池。
// 任何「云端联调通过」的结论都不能以本文件的测试为依据（见 docs/HANDOFF.md 的阻塞项）。
//
// 认证端点形状对齐 GoTrue 的公开 REST 接口；数据端点是三个 RPC。

const b64url = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');

export function makeAccessToken(sub, { expSeconds = 3600, nowMs = Date.now(), role = 'authenticated' } = {}) {
  const header = b64url({ alg: 'none', typ: 'JWT' });
  const payload = b64url({ sub, role, exp: Math.floor(nowMs / 1000) + expSeconds });
  // 合法 Base64URL 结构，供官方 SDK 解析；这里只是假签名，不能用于真实认证。
  const signature = Buffer.from('fake-signature').toString('base64url');
  return `${header}.${payload}.${signature}`;
}

export function readTokenSub(token) {
  if (typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    return payload.sub || null;
  } catch { return null; }
}

const GROWTH_PER_HOUR = 0.008;

/** 与 public.mofish_state_error 对应的最小子集（前端用例只需要区分「合法/不合法」）。 */
export function validateState(state) {
  // 与 supabase/migrations 里的 mofish_state_error / mofish_state_error_v2 保持同一套判定。
  // 假后端只是替身，但边界必须一致，否则端到端测试会放过真实服务端会拒绝的存档。
  if (state === undefined || state === null) return 'state_missing';
  if (typeof state !== 'object' || Array.isArray(state)) return 'state_not_object';
  if (!('version' in state)) return 'version_missing';
  if (typeof state.version !== 'number') return 'version_not_number';
  if (state.version === 2) return validateStateV2(state);
  if (state.version !== 1) return 'unsupported_state_version';
  if (!('fish' in state)) return 'fish_missing';
  if (!Array.isArray(state.fish)) return 'fish_not_array';
  if (state.fish.length < 1) return 'fish_count_below_min';
  if (state.fish.length > 12) return 'fish_count_above_max';
  if (!('plants' in state)) return 'plants_missing';
  if (typeof state.plants !== 'number') return 'plants_not_number';
  if (!Number.isInteger(state.plants) || state.plants < 0 || state.plants > 8) return 'plants_out_of_range';
  if (!('night' in state)) return 'night_missing';
  if (typeof state.night !== 'boolean') return 'night_not_boolean';
  if (!('sound' in state)) return 'sound_missing';
  if (typeof state.sound !== 'boolean') return 'sound_not_boolean';
  if (!('savedAt' in state)) return 'saved_at_missing';
  if (typeof state.savedAt !== 'number') return 'saved_at_not_number';
  if (state.savedAt < 0 || state.savedAt > 4102444800000) return 'saved_at_out_of_range';

  const ids = new Set();
  for (const f of state.fish) {
    if (!f || typeof f !== 'object' || Array.isArray(f)) return 'fish_not_object';
    if (!('id' in f)) return 'fish_id_missing';
    if (typeof f.id !== 'string' || f.id.length < 1 || f.id.length > 100) return 'fish_id_invalid';
    if (ids.has(f.id)) return 'fish_id_duplicated';
    ids.add(f.id);
    if (!('name' in f)) return 'fish_name_missing';
    if (typeof f.name !== 'string' || f.name.length > 16) return 'fish_name_invalid';
    if (!('species' in f)) return 'fish_species_missing';
    if (typeof f.species !== 'number') return 'fish_species_invalid';
    if (!Number.isInteger(f.species) || f.species < 0 || f.species > 3) return 'fish_species_out_of_range';
    if (!('born' in f)) return 'fish_born_missing';
    if (typeof f.born !== 'number') return 'fish_born_invalid';
    if (f.born < 0 || f.born > 4102444800000) return 'fish_born_out_of_range';
    if (!('growth' in f)) return 'fish_growth_missing';
    if (typeof f.growth !== 'number') return 'fish_growth_invalid';
    if (f.growth < 0 || f.growth > 1) return 'fish_growth_out_of_range';
    if (!('meals' in f)) return 'fish_meals_missing';
    if (typeof f.meals !== 'number') return 'fish_meals_invalid';
    if (!Number.isInteger(f.meals) || f.meals < 0 || f.meals > 1000000) return 'fish_meals_out_of_range';
  }

  if (JSON.stringify(state).length > 32768) return 'state_too_large';
  return null;
}

/** v2 校验：字符串鱼种、持久外观种子、造景对象列表。 */
export function validateStateV2(state) {
  if (!('fish' in state)) return 'fish_missing';
  if (!Array.isArray(state.fish)) return 'fish_not_array';
  if (state.fish.length < 1) return 'fish_count_below_min';
  if (state.fish.length > 12) return 'fish_count_above_max';
  const ids = new Set();
  for (const f of state.fish) {
    if (!f || typeof f !== 'object' || Array.isArray(f)) return 'fish_not_object';
    if (typeof f.id !== 'string' || f.id.length < 1 || f.id.length > 100) return 'fish_id_invalid';
    if (ids.has(f.id)) return 'fish_id_duplicated';
    ids.add(f.id);
    if (typeof f.name !== 'string' || f.name.length > 16) return 'fish_name_invalid';
    if (typeof f.species !== 'string' || !/^[a-z][a-z0-9_-]{1,31}$/.test(f.species)) return 'fish_species_invalid';
    if (typeof f.born !== 'number' || f.born < 0 || f.born > 4102444800000) return 'fish_born_out_of_range';
    if (typeof f.growth !== 'number' || f.growth < 0 || f.growth > 1) return 'fish_growth_out_of_range';
    if (typeof f.meals !== 'number' || !Number.isInteger(f.meals) || f.meals < 0 || f.meals > 1000000) return 'fish_meals_out_of_range';
    if (!f.look || typeof f.look !== 'object') return 'fish_look_missing';
    if (typeof f.look.seed !== 'number' || !Number.isInteger(f.look.seed) || f.look.seed < 0 || f.look.seed > 4294967295) return 'fish_look_invalid';
    if ('fedAt' in f && (!Array.isArray(f.fedAt) || f.fedAt.length > 8)) return 'fish_fed_at_invalid';
  }
  if (!('decor' in state)) return 'decor_missing';
  if (!Array.isArray(state.decor)) return 'decor_not_array';
  if (state.decor.length > 24) return 'decor_count_above_max';
  const decorIds = new Set();
  const caps = { plant: 0, rock: 0, wood: 0 };
  for (const d of state.decor) {
    if (!d || typeof d !== 'object' || Array.isArray(d)) return 'decor_not_object';
    if (typeof d.id !== 'string' || d.id.length < 1 || d.id.length > 100) return 'decor_id_invalid';
    if (decorIds.has(d.id)) return 'decor_id_duplicated';
    decorIds.add(d.id);
    if (!['plant', 'rock', 'wood'].includes(d.kind)) return 'decor_kind_invalid';
    caps[d.kind] += 1;
    if (caps.plant > 14 || caps.rock > 10 || caps.wood > 6) return 'decor_count_above_max';
    if (typeof d.type !== 'string' || !/^[a-z][a-z0-9_-]{0,23}$/.test(d.type)) return 'decor_type_invalid';
    if (typeof d.seed !== 'number' || !Number.isInteger(d.seed) || d.seed < 0 || d.seed > 4294967295) return 'decor_seed_invalid';
    if (typeof d.x !== 'number' || d.x < 0 || d.x > 1) return 'decor_position_invalid';
    if (typeof d.z !== 'number' || d.z < 0 || d.z > 1) return 'decor_position_invalid';
    if (typeof d.rot !== 'number' || d.rot < 0 || d.rot >= 6.2832) return 'decor_rotation_invalid';
    if (typeof d.scale !== 'number' || d.scale < 0.6 || d.scale > 1.6) return 'decor_scale_invalid';
  }
  if ('layout' in state && state.layout !== null) {
    if (typeof state.layout !== 'object' || Array.isArray(state.layout)) return 'layout_invalid';
    if ('seed' in state.layout && (typeof state.layout.seed !== 'number' || !Number.isInteger(state.layout.seed) || state.layout.seed < 0)) return 'layout_invalid';
  }
  if (typeof state.night !== 'boolean') return 'night_not_boolean';
  if (typeof state.sound !== 'boolean') return 'sound_not_boolean';
  if (typeof state.savedAt !== 'number' || state.savedAt < 0 || state.savedAt > 4102444800000) return 'saved_at_out_of_range';
  if (JSON.stringify(state).length > 32768) return 'state_too_large';
  return null;
}

export function createFakeSupabase({ startMs = Date.now() } = {}) {
  let currentMs = startMs;
  const users = new Map();          // email -> { id, email, password, confirmed }
  const usersById = new Map();
  const tokens = new Map();         // accessToken -> { sub, revoked }
  const refreshTokens = new Map();  // refreshToken -> sub
  const aquariums = new Map();      // ownerId -> row
  const feedEvents = new Map();     // ownerId -> [{ op, fishId, bites, credited, appliedAt, createdAt }]
  const emails = [];                // 记录本应发出的邮件（测试断言用）
  let seq = 0;

  const clock = () => currentMs;
  const uuid = () => `00000000-0000-4000-8000-${String(++seq).padStart(12, '0')}`;

  function issueSession(user) {
    const access = makeAccessToken(user.id, { nowMs: clock() });
    const refresh = `refresh-${user.id}-${++seq}`;
    tokens.set(access, { sub: user.id, revoked: false });
    refreshTokens.set(refresh, user.id);
    return {
      access_token: access,
      token_type: 'bearer',
      expires_in: 3600,
      expires_at: Math.floor(clock() / 1000) + 3600,
      refresh_token: refresh,
      user: { id: user.id, email: user.email, email_confirmed_at: user.confirmed ? new Date(clock()).toISOString() : null }
    };
  }

  function authUser(headers = {}) {
    const auth = headers.authorization || headers.Authorization || '';
    const token = auth.replace(/^Bearer\s+/i, '');
    const record = tokens.get(token);
    if (!record || record.revoked) return null;
    return record.sub;
  }

  /** 让某个用户的所有访问令牌立即失效，用于测试「令牌过期后自动刷新」。 */
  function revokeAccessTokens(userId) {
    for (const [token, rec] of tokens) if (rec.sub === userId) rec.revoked = true;
  }

  const api = {
    users, aquariums, emails, clock, revokeAccessTokens, issueSession, validateState,

    handleAuth(method, path, search, headers, body) {
      const json = (status, payload) => ({ status, body: payload });
      const fail = (status, error_code, msg) => json(status, { code: status, error_code, msg });

      if (path === '/auth/v1/signup' && method === 'POST') {
        const email = String(body?.email || '').trim().toLowerCase();
        const password = String(body?.password || '');
        if (!email || !password) return fail(400, 'validation_failed', 'invalid email or password');
        if (password.length < 6) return fail(400, 'weak_password', 'Password should be at least 6 characters');
        if (users.has(email)) return fail(400, 'user_already_exists', 'User already registered');
        const user = { id: uuid(), email, password, confirmed: false };
        users.set(email, user);
        usersById.set(user.id, user);
        emails.push({ type: 'signup', email });
        return json(200, { id: user.id, email: user.email, confirmation_sent_at: new Date(clock()).toISOString() });
      }

      if (path === '/auth/v1/token' && method === 'POST') {
        const grant = search.get('grant_type');
        if (grant === 'password') {
          const email = String(body?.email || '').trim().toLowerCase();
          const user = users.get(email);
          if (!user || user.password !== body?.password) return fail(400, 'invalid_credentials', 'Invalid login credentials');
          if (!user.confirmed) return fail(400, 'email_not_confirmed', 'Email not confirmed');
          return json(200, issueSession(user));
        }
        if (grant === 'refresh_token') {
          const sub = refreshTokens.get(body?.refresh_token);
          const user = sub ? usersById.get(sub) : null;
          if (!user) return fail(400, 'refresh_token_not_found', 'Invalid Refresh Token');
          const session = issueSession(user);
          refreshTokens.delete(body.refresh_token);
          return json(200, session);
        }
        return fail(400, 'unsupported_grant_type', 'unsupported grant type');
      }

      if (path === '/auth/v1/logout' && method === 'POST') {
        const sub = authUser(headers);
        if (!sub) return fail(401, 'no_authorization', 'missing token');
        for (const [token, rec] of tokens) if (rec.sub === sub) rec.revoked = true;
        return { status: 204, body: null };
      }

      if (path === '/auth/v1/user' && method === 'GET') {
        const sub = authUser(headers);
        const user = sub ? usersById.get(sub) : null;
        if (!user) return fail(401, 'no_authorization', 'missing token');
        return json(200, { id: user.id, email: user.email, email_confirmed_at: user.confirmed ? new Date(clock()).toISOString() : null });
      }

      if (path === '/auth/v1/user' && method === 'PUT') {
        const sub = authUser(headers);
        const user = sub ? usersById.get(sub) : null;
        if (!user) return fail(401, 'no_authorization', 'missing token');
        if (typeof body?.password !== 'string' || body.password.length < 6) return fail(400, 'weak_password', 'Password should be at least 6 characters');
        if (user.password === body.password) return fail(422, 'same_password', 'New password should be different from the old password');
        user.password = body.password;
        return json(200, { id: user.id, email: user.email });
      }

      if (path === '/auth/v1/recover' && method === 'POST') {
        const email = String(body?.email || '').trim().toLowerCase();
        // 真实 Supabase 对未注册邮箱也返回成功，避免暴露「这个邮箱是否注册过」。
        if (users.has(email)) emails.push({ type: 'recovery', email });
        return json(200, {});
      }

      if (path === '/auth/v1/resend' && method === 'POST') {
        const email = String(body?.email || '').trim().toLowerCase();
        if (!users.has(email)) return fail(404, 'user_not_found', 'User not found');
        emails.push({ type: 'signup', email });
        return json(200, {});
      }

      return json(404, { error_code: 'not_found', msg: `no auth route ${path}` });
    },

    handleRpc(name, headers, body) {
      const json = (status, payload) => ({ status, body: payload });
      const sub = authUser(headers);
      if (!sub) return json(401, { code: 'PGRST301', message: 'JWT expired' });

      if (name === 'ensure_aquarium') {
        const version = body?.p_state_version == null ? 1 : body.p_state_version;
        if (version !== 1 && version !== 2) return json(200, [{ status: 'invalid_argument', error_code: 'unsupported_state_version' }]);
        if (version === 2 && (!body?.p_initial_state || body.p_initial_state.version !== 2)) {
          return json(200, [{ status: 'invalid_state', error_code: 'version_mismatch' }]);
        }
        const error = validateState(body?.p_initial_state);
        if (error) return json(200, [{ status: 'invalid_state', error_code: error }]);
        const existing = aquariums.get(sub);
        if (existing) {
          return json(200, [{
            status: 'ok',
            aquarium_id: existing.id,
            revision: existing.revision,
            state_json: existing.state,
            last_growth_at: new Date(existing.lastGrowthAt).toISOString(),
            created: false
          }]);
        }
        const row = {
          id: uuid(), owner: sub, revision: 1,
          state: JSON.parse(JSON.stringify(body.p_initial_state)),
          lastGrowthAt: clock()
        };
        aquariums.set(sub, row);
        return json(200, [{
          status: 'ok', aquarium_id: row.id, revision: row.revision,
          state_json: row.state, last_growth_at: new Date(row.lastGrowthAt).toISOString(), created: true
        }]);
      }

      if (name === 'save_aquarium') {
        const row = aquariums.get(sub);
        const version = body?.p_state_version == null ? 1 : body.p_state_version;
        if (version !== 1 && version !== 2) return json(200, [{ status: 'invalid_argument', error_code: 'unsupported_state_version' }]);
        if (version === 2 && (!body?.p_state || body.p_state.version !== 2)) {
          return json(200, [{ status: 'invalid_state', error_code: 'version_mismatch' }]);
        }
        const error = validateState(body?.p_state);
        if (error) return json(200, [{ status: 'invalid_state', error_code: error }]);
        if (!row || (body?.p_id && body.p_id !== row.id)) {
          return json(200, [{ status: 'not_found', error_code: 'aquarium_not_found' }]);
        }
        if (Number(body?.p_expected_revision) !== row.revision) {
          return json(200, [{ status: 'conflict', revision: row.revision, error_code: 'revision_conflict' }]);
        }
        row.state = JSON.parse(JSON.stringify(body.p_state));
        row.revision += 1;
        return json(200, [{ status: 'ok', revision: row.revision, state_json: row.state }]);
      }

      if (name === 'record_feeding') {
        const row = aquariums.get(sub);
        if (!row || (body?.p_id && body.p_id !== row.id)) {
          return json(200, [{ status: 'not_found', credited: 0, duplicate: false, error_code: 'fish_or_aquarium_not_found' }]);
        }
        const fishId = body?.p_fish_id;
        const op = body?.p_operation_id;
        const bites = body?.p_bites == null ? 1 : body.p_bites;
        if (!op || typeof fishId !== 'string' || !Number.isInteger(bites) || bites < 1 || bites > 8) {
          return json(200, [{ status: 'invalid_argument', credited: 0, duplicate: false, error_code: 'bad_arguments' }]);
        }
        if (!row.state.fish.some((f) => f.id === fishId)) {
          return json(200, [{ status: 'not_found', credited: 0, duplicate: false, error_code: 'fish_or_aquarium_not_found' }]);
        }
        const list = feedEvents.get(sub) || [];
        const existing = list.find(e => e.op === op);
        if (existing) {
          if (existing.fishId !== fishId || existing.bites !== bites) {
            return json(200, [{ status: 'invalid_argument', error_code: 'operation_mismatch' }]);
          }
          return json(200, [{ status: 'ok', credited: 0, duplicate: true }]);
        }
        if (list.filter(e => e.createdAt > clock() - 86400000).length >= 500) {
          return json(200, [{ status: 'rate_limited', error_code: 'too_many_feed_events' }]);
        }
        list.push({ op, fishId, bites, credited: 0, appliedAt: null, createdAt: clock() });
        feedEvents.set(sub, list);
        return json(200, [{ status: 'ok', credited: 0, duplicate: false }]);
      }

      if (name === 'settle_growth') {
        const row = aquariums.get(sub);
        if (!row || (body?.p_id && body.p_id !== row.id)) {
          return json(200, [{ status: 'not_found', error_code: 'aquarium_not_found' }]);
        }
        const cap = body?.p_cap_seconds == null ? 86400 : body.p_cap_seconds;
        const seconds = Math.max(0, Math.floor((clock() - row.lastGrowthAt) / 1000));
        const pending = (feedEvents.get(sub) || []).filter((e) => e.appliedAt === null);
        if (seconds < 1 && pending.length === 0) {
          return json(200, [{
            status: 'ok', revision: row.revision, credited_seconds: 0,
            state_json: row.state, last_growth_at: new Date(row.lastGrowthAt).toISOString()
          }]);
        }
        const credited = Math.min(seconds, cap);
        // v1 旧档保持每小时 0.008；v2 新档 0.05/24h（与模型 GROWTH.naturalPerDay 一致）。
        const natural = row.state.version === 2
          ? (credited / 86400) * 0.05
          : (credited / 3600) * GROWTH_PER_HOUR;
        const growthByFish = new Map();
        const mealsByFish = new Map();
        const list = feedEvents.get(sub) || [];
        for (const event of list.filter((e) => e.appliedAt === null).sort((a, b) => a.createdAt - b.createdAt)) {
          const used = list
            .filter((e) => e.appliedAt !== null && e.fishId === event.fishId && e.createdAt > event.createdAt - 86400000)
            .reduce((sum, e) => sum + e.credited, 0);
          event.credited = Math.max(0, Math.min(event.bites, 3 - used));
          event.appliedAt = clock();
          growthByFish.set(event.fishId, (growthByFish.get(event.fishId) || 0) + event.credited * (0.02 / 3));
          mealsByFish.set(event.fishId, (mealsByFish.get(event.fishId) || 0) + event.bites);
        }
        row.state = {
          ...row.state,
          fish: row.state.fish.map((f) => ({
            ...f,
            growth: Math.round(Math.min(1, Math.max(0, f.growth + natural + (growthByFish.get(f.id) || 0))) * 1e6) / 1e6,
            meals: f.meals + (mealsByFish.get(f.id) || 0)
          }))
        };
        row.revision += 1;
        row.lastGrowthAt = clock();
        return json(200, [{
          status: 'ok', revision: row.revision, credited_seconds: credited,
          state_json: row.state, last_growth_at: new Date(row.lastGrowthAt).toISOString()
        }]);
      }

      return json(404, { code: 'PGRST202', message: 'Could not find the function' });
    },

    /** 供测试推进服务端时间。 */
    advance(ms) { currentMs += ms; return currentMs; },
    setNow(ms) { currentMs = ms; return currentMs; }
  };

  return api;
}
