// 对**真实 Supabase 项目**的冒烟测试：验证认证、RLS、原子 revision 与幂等成长结算。
//
// 这是本阶段唯一能把「真实云端」这一项从阻塞变成已验证的手段。凭据只从本机环境变量读取，
// 不会打印、不会写入仓库；请不要把任何密钥粘贴到聊天或提交里。
//
// 用法（两种模式，任选其一）：
//
//   A. 有 service_role key（推荐，能自动建号并在结束时清理）：
//      MOFISH_SUPABASE_URL=https://<ref>.supabase.co \
//      MOFISH_SUPABASE_ANON_KEY=<anon key> \
//      MOFISH_SMOKE_SERVICE_ROLE_KEY=<service role key> \
//      node scripts/cloud-smoke.mjs
//
//   B. 只有 anon key + 两个已确认的测试账号（在控制台手动创建并完成邮箱验证）：
//      MOFISH_SUPABASE_URL=... MOFISH_SUPABASE_ANON_KEY=... \
//      MOFISH_SMOKE_EMAIL_A=a@example.com MOFISH_SMOKE_PASSWORD_A=... \
//      MOFISH_SMOKE_EMAIL_B=b@example.com MOFISH_SMOKE_PASSWORD_B=... \
//      node scripts/cloud-smoke.mjs
//
// 会执行：注册/登录 → 开缸 → 保存 → 越权访问被拒 → revision 冲突 → 幂等成长结算 → 清理。
// 任何一项失败都以非零退出码结束，不会把失败说成通过。

const url = (process.env.MOFISH_SUPABASE_URL || '').replace(/\/+$/, '');
const anonKey = process.env.MOFISH_SUPABASE_ANON_KEY || '';
const serviceKey = process.env.MOFISH_SMOKE_SERVICE_ROLE_KEY || '';

const results = [];
const log = (ok, name, detail = '') => {
  results.push({ ok, name, detail });
  console.log(`${ok ? '✅' : '❌'} ${name}${detail ? ` — ${detail}` : ''}`);
};
const fail = (message) => { console.error(`\n✖ ${message}`); process.exit(2); };

if (!url || !anonKey) fail('需要 MOFISH_SUPABASE_URL 与 MOFISH_SUPABASE_ANON_KEY');
if (!/^https:\/\//.test(url)) fail('项目地址必须是 https（本机 http 仅用于本地假后端）');
if (!serviceKey && !(process.env.MOFISH_SMOKE_EMAIL_A && process.env.MOFISH_SMOKE_PASSWORD_A
  && process.env.MOFISH_SMOKE_EMAIL_B && process.env.MOFISH_SMOKE_PASSWORD_B)) {
  fail('缺少凭据：要么提供 MOFISH_SMOKE_SERVICE_ROLE_KEY，要么提供两个已确认账号的邮箱与密码');
}

const projectRef = url.replace(/^https:\/\//, '').replace(/\.supabase\.co$/, '');
console.log(`目标项目：${projectRef}（不打印任何密钥）\n`);

async function call(path, { method = 'POST', token = anonKey, body, headers = {} } = {}) {
  const res = await fetch(`${url}${path}`, {
    method,
    headers: {
      apikey: anonKey,
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
      ...headers
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });
  const text = await res.text();
  let parsed = null;
  try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
  return { status: res.status, ok: res.ok, body: parsed };
}

const rpc = async (name, args, token) => {
  const res = await call(`/rest/v1/rpc/${name}`, { body: args, token });
  const row = Array.isArray(res.body) ? res.body[0] : res.body;
  return { ...res, row };
};

function validState(name = '冒烟鱼') {
  return {
    version: 1,
    fish: [{ id: `smoke-${Date.now()}`, name, species: 0, born: Date.now(), growth: 0, meals: 0 }],
    plants: 3, night: false, sound: false, savedAt: Date.now()
  };
}

const created = { users: [] };

async function ensureAccount(email, password) {
  if (!serviceKey) {
    const login = await call('/auth/v1/token?grant_type=password', { body: { email, password } });
    if (!login.ok) fail(`账号 ${email} 登录失败：${JSON.stringify(login.body)}`);
    return { id: login.body.user.id, email, session: login.body };
  }

  const created1 = await call('/auth/v1/admin/users', {
    token: serviceKey,
    body: { email, password, email_confirm: true }
  });
  if (!created1.ok) {
    // 账号可能已存在：退化为直接登录
    const login = await call('/auth/v1/token?grant_type=password', { body: { email, password } });
    if (!login.ok) fail(`无法创建或登录 ${email}：${JSON.stringify(created1.body)} / ${JSON.stringify(login.body)}`);
    return { id: login.body.user.id, email, session: login.body };
  }
  created.users.push(created1.body.id);
  const login = await call('/auth/v1/token?grant_type=password', { body: { email, password } });
  if (!login.ok) fail(`新建账号无法登录：${JSON.stringify(login.body)}`);
  return { id: created1.body.id, email, session: login.body };
}

async function main() {
  const stamp = Date.now();
  const a = await ensureAccount(`mofish-smoke-a-${stamp}@example.com`, 'smoke-password-a-1');
  const b = await ensureAccount(`mofish-smoke-b-${stamp}@example.com`, 'smoke-password-b-1');
  log(true, '两台设备的测试账号可用（A/B）', serviceKey ? '由 Admin API 创建并已确认邮箱' : '使用你提供的已确认账号');

  // 1) 开缸
  const ensuredA = await rpc('ensure_aquarium', { p_initial_state: validState('A 的鱼'), p_state_version: 1 }, a.session.access_token);
  const createdNew = ensuredA.row?.status === 'ok' && ensuredA.row?.created === true;
  log(createdNew, 'A 首次开缸（created=true）', `status=${ensuredA.row?.status}, revision=${ensuredA.row?.revision}`);
  if (!createdNew) fail('开缸失败，后续检查无法继续');
  const aquariumId = ensuredA.row.aquarium_id;

  const ensuredAgain = await rpc('ensure_aquarium', { p_initial_state: validState('重复开缸'), p_state_version: 1 }, a.session.access_token);
  log(ensuredAgain.row?.created === false && ensuredAgain.row?.aquarium_id === aquariumId,
    '重复开缸是幂等的（created=false，同一条鱼缸）', `aquarium=${ensuredAgain.row?.aquarium_id}`);

  // 2) 保存 + 原子 revision
  let revision = ensuredA.row.revision;
  const saved = await rpc('save_aquarium', { p_id: aquariumId, p_expected_revision: revision, p_state: validState('A 改名了'), p_state_version: 1 }, a.session.access_token);
  log(saved.row?.status === 'ok' && saved.row.revision === revision + 1, 'A 正常保存并 revision +1', `revision=${saved.row?.revision}`);
  revision = saved.row.revision;

  const stale = await rpc('save_aquarium', { p_id: aquariumId, p_expected_revision: revision - 1, p_state: validState('过期写入'), p_state_version: 1 }, a.session.access_token);
  log(stale.row?.status === 'conflict' && stale.row.revision === revision, '旧 revision 写入被判定为冲突并返回服务端 revision', `status=${stale.row?.status}`);

  // 3) 越权：B 尝试操作 A 的鱼缸（RPC 与表级直连都要被拒）
  const crossRpc = await rpc('save_aquarium', { p_id: aquariumId, p_expected_revision: revision, p_state: validState('越权写入'), p_state_version: 1 }, b.session.access_token);
  log(crossRpc.row?.status === 'not_found' || crossRpc.row?.status === 'not_authenticated',
    'B 调用 RPC 修改 A 的鱼缸被拒绝', `status=${crossRpc.row?.status}`);

  const crossSelect = await call(`/rest/v1/aquariums?select=id,owner_id&id=eq.${aquariumId}`, { method: 'GET', token: b.session.access_token });
  const bRows = Array.isArray(crossSelect.body) ? crossSelect.body : [];
  log(bRows.length === 0, 'B 通过 PostgREST 读不到 A 的存档行（RLS 生效）', `返回 ${bRows.length} 行`);

  const crossUpdate = await call(`/rest/v1/aquariums?id=eq.${aquariumId}`, {
    method: 'PATCH', token: b.session.access_token,
    body: { state_json: validState('越权表级写入') },
    headers: { Prefer: 'return=representation' }
  });
  const updatedRows = Array.isArray(crossUpdate.body) ? crossUpdate.body : [];
  log(updatedRows.length === 0, 'B 直接 PATCH 表也无法改动 A 的行', `受影响 ${updatedRows.length} 行，HTTP ${crossUpdate.status}`);

  const crossDelete = await call(`/rest/v1/aquariums?id=eq.${aquariumId}`, { method: 'DELETE', token: b.session.access_token, headers: { Prefer: 'return=representation' } });
  const deletedRows = Array.isArray(crossDelete.body) ? crossDelete.body : [];
  log(deletedRows.length === 0, 'B 直接 DELETE 删不掉 A 的行', `受影响 ${deletedRows.length} 行`);

  // 4) 匿名访问被拒
  const anonSelect = await call('/rest/v1/aquariums?select=id', { method: 'GET', token: null });
  log(!anonSelect.ok || (Array.isArray(anonSelect.body) && anonSelect.body.length === 0),
    '匿名（仅 anon key）读不到任何鱼缸', `HTTP ${anonSelect.status}`);

  // 5) 幂等成长结算
  const settle1 = await rpc('settle_growth', { p_id: aquariumId, p_cap_seconds: 86400 }, a.session.access_token);
  log(settle1.row?.status === 'ok', 'A 可以结算成长', `credited=${settle1.row?.credited_seconds}`);
  const settle2 = await rpc('settle_growth', { p_id: aquariumId, p_cap_seconds: 86400 }, a.session.access_token);
  log(settle2.row?.credited_seconds === 0, '紧接着重复结算不给额外奖励', `credited=${settle2.row?.credited_seconds}`);

  const settleCross = await rpc('settle_growth', { p_id: aquariumId, p_cap_seconds: 86400 }, b.session.access_token);
  log(settleCross.row?.status === 'not_found', 'B 无法结算 A 的鱼缸', `status=${settleCross.row?.status}`);

  // 6) 服务端参数校验
  const badState = await rpc('save_aquarium', {
    p_id: aquariumId, p_expected_revision: (await rpc('ensure_aquarium', { p_initial_state: validState(), p_state_version: 1 }, a.session.access_token)).row.revision,
    p_state: { version: 1, fish: [], plants: 0 }, p_state_version: 1
  }, a.session.access_token);
  log(badState.row?.status === 'invalid_state', '服务端拒绝非法存档（空鱼群）', `error_code=${badState.row?.error_code}`);
}

try {
  await main();
} catch (err) {
  console.error('\n✖ 冒烟测试异常中断：', err?.message || err);
  process.exitCode = 1;
} finally {
  // 清理：只删除本次由 Admin API 创建的账号（连带其鱼缸由外键级联删除）
  if (serviceKey && created.users.length) {
    for (const id of created.users) {
      await call(`/auth/v1/admin/users/${id}`, { method: 'DELETE', token: serviceKey });
    }
    console.log(`\n已清理本次创建的 ${created.users.length} 个测试账号。`);
  } else if (serviceKey) {
    console.log('\n本次没有新建账号，无需清理。');
  } else {
    console.log('\n提示：本次使用你提供的账号，未做删除；如需清理请在控制台自行处理。');
  }

  const failed = results.filter(r => !r.ok);
  console.log(`\n=== 真实 Supabase 冒烟结果：${results.length - failed.length}/${results.length} 通过 ===`);
  if (failed.length) {
    console.log('失败项：');
    for (const f of failed) console.log(` - ${f.name}${f.detail ? ` (${f.detail})` : ''}`);
    process.exitCode = 1;
  }
}
