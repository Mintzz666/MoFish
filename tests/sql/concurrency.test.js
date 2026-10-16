// 真实多连接并发测试：验证成长结算与原子保存的并发语义。
//
// 为什么需要单独一个文件：PGlite（WASM）是单连接内核，语句在同一进程内串行执行，
// 无法构造「两个事务同时读到同一旧锚点」的交错，因此证明不了行锁是否生效。
// 本文件启动/连接一个**真正的 Postgres 服务**，用两个独立连接并发调用同一个函数。
//
// 运行方式（任选其一）：
//   1) 默认：若安装了 devDependency `embedded-postgres`，会自动起一个本地实例（随机端口，
//      数据目录在系统临时目录，测试结束后关闭）。
//   2) 指定现有实例：MOFISH_TEST_PG_URL=postgresql://postgres:postgres@127.0.0.1:5432/postgres
//      （需要能创建角色、schema 与表的权限；测试会建 anon/authenticated 角色来模拟 Supabase）。
//   3) 两者都没有：本文件的用例会以明确的跳过原因标 SKIP，不会被当成通过。

import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { rm, stat } from 'node:fs/promises';
import { readMigrations, SUPABASE_EMULATION, USERS, validState } from './harness.mjs';

const PG_PORT = 54329;
const USER_A = USERS.alice;

let server = null;          // { url, stop }
let admin = null;           // pg.Client
let skipReason = false;

/**
 * 在**测试定义之前**决定是否跳过：node:test 的 { skip } 选项在定义时求值，
 * 如果放到 before 钩子里才失败，用例会照常执行并以失败告终（而不是明确跳过）。
 */
try {
  server = await startPostgres();
} catch (err) {
  skipReason = `无法启动/连接真实 Postgres（${err.message}）。`
    + ' 可设置 MOFISH_TEST_PG_URL 指向任意可用的 Postgres（需要建角色权限）后重跑。';
}

test.before(async () => {
  if (skipReason) return;
  const { Client } = await import('pg');
  admin = new Client({ connectionString: server.url });
  await admin.connect();

  // 每个用例都从干净状态开始：删掉上一轮可能残留的对象
  await admin.query('drop schema if exists public cascade; create schema public;');
  await admin.query('drop schema if exists auth cascade;');
  await admin.query(`do $$ begin
      if exists (select 1 from pg_roles where rolname = 'authenticated') then drop owned by authenticated; end if;
      if exists (select 1 from pg_roles where rolname = 'anon') then drop owned by anon; end if;
      if exists (select 1 from pg_roles where rolname = 'service_role') then drop owned by service_role; end if;
    end $$;`);
  await admin.query(`drop role if exists authenticated; drop role if exists anon; drop role if exists service_role;`);

  // 与 Supabase 一致的最小模拟 + 真实迁移
  await admin.query(SUPABASE_EMULATION);
  for (const migration of await readMigrations()) await admin.query(migration.sql);

  // aquariums.owner_id 外键指向 auth.users，先建好测试账号
  await admin.query('insert into auth.users (id, email) values ($1, $2), ($3, $4)',
    [USERS.alice, 'alice@example.com', USERS.bob, 'bob@example.com']);
});

async function startPostgres() {
  if (process.env.MOFISH_TEST_PG_URL) {
    return { url: process.env.MOFISH_TEST_PG_URL, stop: async () => {} };
  }
  await assertEmbeddedBinaryAvailable();
  const { default: EmbeddedPostgres } = await import('embedded-postgres');
  const dir = path.join(os.tmpdir(), 'mofish-pg-concurrency');
  await rm(dir, { recursive: true, force: true });
  const instance = new EmbeddedPostgres({
    databaseDir: dir,
    user: 'postgres',
    password: 'postgres',
    port: PG_PORT,
    persistent: false
  });
  await instance.initialise();
  await instance.start();
  return {
    url: `postgresql://postgres:postgres@127.0.0.1:${PG_PORT}/postgres`,
    stop: async () => { await instance.stop(); }
  };
}

/**
 * embedded-postgres 会在模块加载后**异步**去 import 平台二进制包（@embedded-postgres/<platform>-<arch>）。
 * 那个 import 的失败是未处理的 rejection，会直接把整个测试进程打挂 —— try/catch 兜不住。
 * 所以在引入它之前先做一次文件系统预检：二进制包不在就干脆跳过，而不是崩掉 npm test。
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
  throw new Error(
    `未安装本机对应的平台包（试过 ${candidates.join('、')}）。`
    + ' 可用 npm install -D embedded-postgres 安装，或设置 MOFISH_TEST_PG_URL 指向现有 Postgres'
  );
}

test.after(async () => {
  try { await admin?.end(); } catch { /* 忽略 */ }
  try { await server?.stop(); } catch { /* 忽略 */ }
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
