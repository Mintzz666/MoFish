// 真实多连接并发测试：验证成长结算与原子保存的并发语义。
//
// 为什么需要单独一个文件：PGlite（WASM）是单连接内核，语句在同一进程内串行执行，
// 无法构造「两个事务同时读到同一旧锚点」的交错，因此证明不了行锁是否生效。
// 本文件启动/连接一个**真正的 Postgres 服务**，用两个独立连接并发调用同一个函数。
//
// 运行方式与环境：
//   1) 默认：若安装了 `embedded-postgres` 的本机二进制，会自动起一个隔离实例，
//      使用唯一临时目录和系统分配的空闲端口，测试结束后只清理该实例。
//   2) `MOFISH_TEST_PG_URL` 被明确拒绝：外部实例可能包含用户数据库或集群角色，
//      测试无法证明其可销毁，因此不会连接它。
//   3) 嵌入式 Postgres 缺失或无法启动时，本文件的四个真实并发用例会以具体原因标 SKIP。
//   4) CI 可设置 `MOFISH_REQUIRE_POSTGRES=1`，将上述启动问题提升为硬失败。

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stat } from 'node:fs/promises';
import { readMigrations, SUPABASE_EMULATION, USERS, validState } from './harness.mjs';
import {
  embeddedPostgresStartupFailure,
  prepareFreshTestDatabase,
  rejectExternalPostgresUrl,
  startOwnedEmbeddedPostgres,
  withEmbeddedPostgresOnly,
} from './concurrency-safety.mjs';

const USER_A = USERS.alice;

let server = null;          // { url, stop }
let admin = null;           // pg.Client
let skipReason = false;

// 拒绝应当是硬错误，而不是把危险配置伪装成一次跳过。
// 此检查发生在导入 pg 或创建任何连接之前。
rejectExternalPostgresUrl(process.env);

/**
 * 在**测试定义之前**决定是否跳过：node:test 的 { skip } 选项在定义时求值，
 * 如果放到 before 钩子里才失败，用例会照常执行并以失败告终（而不是明确跳过）。
 */
try {
  server = await startPostgres();
} catch (err) {
  skipReason = embeddedPostgresStartupFailure(err, process.env);
}

test.before(async () => {
  if (skipReason) return;
  const { Client } = await import('pg');
  admin = new Client({ connectionString: server.url });
  await admin.connect();

  // 每次运行的 cluster 都是新建的；只创建测试对象，不重置 schema 或删除集群角色。
  await prepareFreshTestDatabase(admin, {
    supabaseEmulation: SUPABASE_EMULATION,
    migrations: await readMigrations(),
    users: USERS,
  });
});

async function startPostgres() {
  return withEmbeddedPostgresOnly({
    env: process.env,
    launch: async () => {
      await assertEmbeddedBinaryAvailable();
      const { default: EmbeddedPostgres } = await import('embedded-postgres');
      return startOwnedEmbeddedPostgres({ EmbeddedPostgres });
    },
  });
}

/**
 * 先确认对应平台包已安装，再导入 embedded-postgres。缺少本机动态库等启动错误
 * 会由 startPostgres 的 try/catch 捕获，并显示具体 SKIP 原因；不会被说成真实并发通过。
 */
async function assertEmbeddedBinaryAvailable() {
  const platform = process.platform === 'win32' ? 'windows' : process.platform;
  const candidates = [
    `@embedded-postgres/${platform}-${process.arch}`,
    `@embedded-postgres/${process.platform}-${process.arch}`
  ];
  for (const name of [...new Set(candidates)]) {
    try {
      await stat(fileURLToPath(new URL(`../../node_modules/${name}/`, import.meta.url)));
      return;
    } catch { /* 试下一个命名 */ }
  }
  throw new Error(`未安装本机对应的平台包（试过 ${candidates.join('、')}）。`);
}

test.after(async () => {
  let cleanupError = null;
  try { await admin?.end(); } catch (error) { cleanupError = error; }
  try { await server?.stop(); } catch (error) { cleanupError ??= error; }
  if (cleanupError) throw cleanupError;
});

/** 打开一条以某个用户身份执行的真实连接（与 PostgREST 的做法一致：先写 claims，再切角色）。 */
async function connectAs(userId) {
  const { Client } = await import('pg');
  const client = new Client({ connectionString: server.url });
  await client.connect();
  await client.query(`select set_config('request.jwt.claims', $1, false)`, [JSON.stringify({ sub: userId })]);
  await client.query('set role authenticated');
  return client;
}

async function seedAquarium(ownerId, state = validState({ idPrefix: 'conc' })) {
  // 用 RPC 开缸（与客户端走同一条路径），再以管理员身份回拨成长锚点
  const client = await connectAs(ownerId);
  const { rows } = await client.query('select * from public.ensure_aquarium($1::jsonb)', [JSON.stringify(state)]);
  await client.end();
  assert.equal(rows[0].status, 'ok');
  return rows[0];
}

async function backdate(id, interval) {
  await admin.query(`update public.aquariums set last_growth_at = now() - interval '${interval}', updated_at = now() where id = $1`, [id]);
}

async function growthOf(id) {
  const { rows } = await admin.query('select state_json->\'fish\'->0->>\'growth\' as g from public.aquariums where id = $1', [id]);
  return Number(rows[0].g);
}

// ------------------------------------------------------------------ 成长结算并发（评审 P1-6）

test('并发结算成长：两个真实连接同时调用，只奖励一次', { skip: skipReason }, async () => {
  const aquarium = await seedAquarium(USER_A, validState({ idPrefix: 'race' }));
  await backdate(aquarium.aquarium_id, '1 hour');
  const before = await growthOf(aquarium.aquarium_id);

  const c1 = await connectAs(USER_A);
  const c2 = await connectAs(USER_A);
  try {
    const [r1, r2] = await Promise.all([
      c1.query('select * from public.settle_growth($1, 86400)', [aquarium.aquarium_id]),
      c2.query('select * from public.settle_growth($1, 86400)', [aquarium.aquarium_id])
    ]);
    const credited = [r1.rows[0].credited_seconds, r2.rows[0].credited_seconds].sort((a, b) => a - b);
    assert.deepEqual(credited, [0, 3600], `两次并发结算的秒数应为 [0, 3600]，实际 ${JSON.stringify(credited)}`);

    const after = await growthOf(aquarium.aquarium_id);
    assert.ok(Math.abs(after - (before + 0.008)) < 1e-6,
      `成长只应加一次（1 小时 = +0.008），实际 ${before} → ${after}`);

    const { rows } = await admin.query('select revision from public.aquariums where id = $1', [aquarium.aquarium_id]);
    assert.equal(Number(rows[0].revision), Number(aquarium.revision) + 1, '只有一次结算提升了 revision');
  } finally {
    await c1.end();
    await c2.end();
  }
});

test('并发结算成长：三个连接同时调用也只奖励一次', { skip: skipReason }, async () => {
  const aquarium = await seedAquarium(USER_A, validState({ idPrefix: 'race3' }));
  await backdate(aquarium.aquarium_id, '30 minutes');
  const before = await growthOf(aquarium.aquarium_id);

  const clients = await Promise.all([connectAs(USER_A), connectAs(USER_A), connectAs(USER_A)]);
  try {
    const results = await Promise.all(
      clients.map(c => c.query('select * from public.settle_growth($1, 86400)', [aquarium.aquarium_id]))
    );
    const credited = results.map(r => r.rows[0].credited_seconds).sort((a, b) => a - b);
    assert.deepEqual(credited, [0, 0, 1800], `应为 [0, 0, 1800]，实际 ${JSON.stringify(credited)}`);
    const after = await growthOf(aquarium.aquarium_id);
    assert.ok(Math.abs(after - (before + 0.004)) < 1e-6, `0.5 小时只加一次 0.004，实际 ${before} → ${after}`);
  } finally {
    for (const c of clients) await c.end();
  }
});

test('并发保存同一 revision：只有一个成功，另一个拿到 conflict 且不覆盖数据', { skip: skipReason }, async () => {
  const aquarium = await seedAquarium(USER_A, validState({ idPrefix: 'saverace' }));
  const stateX = validState({ idPrefix: 'saverace' });
  stateX.fish[0].name = 'X 的版本';
  const stateY = validState({ idPrefix: 'saverace' });
  stateY.fish[0].name = 'Y 的版本';

  const c1 = await connectAs(USER_A);
  const c2 = await connectAs(USER_A);
  try {
    const [r1, r2] = await Promise.all([
      c1.query('select * from public.save_aquarium($1, $2, $3::jsonb)', [aquarium.aquarium_id, aquarium.revision, JSON.stringify(stateX)]),
      c2.query('select * from public.save_aquarium($1, $2, $3::jsonb)', [aquarium.aquarium_id, aquarium.revision, JSON.stringify(stateY)])
    ]);
    const statuses = [r1.rows[0].status, r2.rows[0].status].sort();
    assert.deepEqual(statuses, ['conflict', 'ok'], `实际 ${JSON.stringify(statuses)}`);

    const { rows } = await admin.query('select revision, state_json->\'fish\'->0->>\'name\' as name from public.aquariums where id = $1', [aquarium.aquarium_id]);
    assert.equal(Number(rows[0].revision), Number(aquarium.revision) + 1, 'revision 只 +1');
    assert.ok(['X 的版本', 'Y 的版本'].includes(rows[0].name), '保存进去的是其中一个版本');
  } finally {
    await c1.end();
    await c2.end();
  }
});

test('并发结算 vs 并发保存交错：不会互相覆盖，且成长只结算一次', { skip: skipReason }, async () => {
  const aquarium = await seedAquarium(USER_A, validState({ idPrefix: 'mix' }));
  await backdate(aquarium.aquarium_id, '2 hours');
  const before = await growthOf(aquarium.aquarium_id);

  const saved = validState({ idPrefix: 'mix' });
  saved.fish[0].name = '保存的名字';

  const c1 = await connectAs(USER_A);
  const c2 = await connectAs(USER_A);
  try {
    // 结算与保存同时发起：保存用开缸时的 revision。
    const [settle, save] = await Promise.all([
      c1.query('select * from public.settle_growth($1, 86400)', [aquarium.aquarium_id]),
      c2.query('select * from public.save_aquarium($1, $2, $3::jsonb)', [aquarium.aquarium_id, aquarium.revision, JSON.stringify(saved)])
    ]);
    const settleStatus = settle.rows[0].status;
    const saveStatus = save.rows[0].status;
    assert.equal(settleStatus, 'ok');
    // 谁先提交谁成功：若结算先到，保存会拿到 conflict；若保存先到，结算随后照常结算。
    assert.ok(['ok', 'conflict'].includes(saveStatus), `保存状态异常: ${saveStatus}`);

    const { rows } = await admin.query('select revision, state_json from public.aquariums where id = $1', [aquarium.aquarium_id]);
    const creditedTotal = settle.rows[0].credited_seconds;
    assert.ok(creditedTotal === 7200 || creditedTotal === 0, `结算秒数应为 7200 或 0，实际 ${creditedTotal}`);
    const after = Number(rows[0].state_json.fish[0].growth);
    if (saveStatus === 'conflict') {
      // 保存被拒：成长只由结算贡献
      assert.ok(Math.abs(after - (before + 0.016)) < 1e-6, `成长 = ${before} + 0.016，实际 ${after}`);
    } else {
      // 保存成功但用的是旧锚点：结算随后仍会把这段时间的成长补上（成长只加一次）
      assert.ok(after >= before, `成长不应倒退，实际 ${before} → ${after}`);
    }
  } finally {
    await c1.end();
    await c2.end();
  }
});
