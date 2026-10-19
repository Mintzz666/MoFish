// 真实 Postgres 引擎（PGlite/WASM）上的迁移与 RLS 集成测试基座。
//
// 说明（不要误读为 Supabase 云端联调）：
// - 这里运行的是真实的 Postgres 内核、真实的迁移 SQL、真实的 RLS 策略与 PL/pgSQL 函数。
// - 只模拟 Supabase 由平台提供的两样东西：`auth` schema 里的 `auth.users` 表与 `auth.uid()`，
//   以及 anon / authenticated / service_role 三个角色。模拟方式与 Supabase 的实现一致
//   （auth.uid() 读取 `request.jwt.claims` 中的 sub）。
// - 不覆盖：GoTrue HTTP 接口、PostgREST、JWT 签发与过期、Supabase 平台的连接池与配额。
//   这些属于「需要真实 Supabase 项目」的阻塞项，见 docs/HANDOFF.md。

import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
export const MIGRATIONS_DIR = path.resolve(here, '../../supabase/migrations');

export const SUPABASE_EMULATION = `
create role anon noinherit;
create role authenticated noinherit;
create role service_role noinherit bypassrls;

create schema if not exists auth;

create table if not exists auth.users (
  id    uuid primary key,
  email text unique,
  email_confirmed_at timestamptz default now()
);

-- 与 Supabase 语义一致：从会话 JWT claims 的 sub 取当前用户 id，未登录返回 null。
create or replace function auth.uid()
returns uuid
language sql
stable
as $$
  select coalesce(
           nullif(current_setting('request.jwt.claim.sub', true), ''),
           nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'
         )::uuid
$$;

grant usage on schema auth to anon, authenticated, service_role;
grant execute on function auth.uid() to anon, authenticated, service_role;
`;

/** 按文件名顺序读取全部迁移文件（版本化迁移，测试与生产使用同一批文件）。 */
export async function readMigrations() {
  const files = (await readdir(MIGRATIONS_DIR)).filter(f => f.endsWith('.sql')).sort();
  const out = [];
  for (const f of files) out.push({ name: f, sql: await readFile(path.join(MIGRATIONS_DIR, f), 'utf8') });
  return out;
}

export async function createTestDb({ pgliteModule: injectedModule } = {}) {
  const module = injectedModule ?? await import('@electric-sql/pglite');
  const { PGlite } = module;
  if (typeof PGlite?.create !== 'function') {
    throw new Error('@electric-sql/pglite 导入异常：未找到 PGlite.create');
  }
  const db = await PGlite.create();
  await db.exec(SUPABASE_EMULATION);
  const migrations = await readMigrations();
  for (const m of migrations) {
    try {
      await db.exec(m.sql);
    } catch (err) {
      throw new Error(`迁移 ${m.name} 应用失败: ${err.message}`);
    }
  }
  return new Harness(db, migrations);
}

class Harness {
  constructor(db, migrations) {
    this.db = db;
    this.migrations = migrations;
    this.role = null;
    this.currentUser = null;
  }

  async query(sql, params = []) {
    const r = await this.db.query(sql, params);
    return r.rows;
  }

  /** 以超级用户（相当于执行迁移的平台角色）身份执行。 */
  async asAdmin(fn) {
    await this.db.exec('reset role');
    this.role = null;
    await this.db.exec(`select set_config('request.jwt.claims', '', false)`);
    this.currentUser = null;
    return fn(this);
  }

  /** 以某个登录用户身份执行（RLS 生效）。 */
  async asUser(userId, fn) {
    if (this.role === 'authenticated' && this.currentUser === userId) return fn(this);
    if (this.role !== null) await this.db.exec('reset role');
    this.role = null;
    // 先以超级用户写入 claims，再降级到 authenticated（与 PostgREST 的顺序一致）。
    await this.db.exec(`select set_config('request.jwt.claims', '${JSON.stringify({ sub: userId })}', false)`);
    await this.db.exec(`set role authenticated`);
    this.role = 'authenticated';
    this.currentUser = userId;
    return fn(this);
  }

  /** 以匿名（匿名 key，无 JWT）身份执行，用于验证未登录访问被拒绝。 */
  async asAnon(fn) {
    if (this.role !== null) await this.db.exec('reset role');
    this.role = null;
    await this.db.exec(`select set_config('request.jwt.claims', '', false)`);
    this.currentUser = null;
    await this.db.exec(`set role anon`);
    this.role = 'anon';
    return fn(this);
  }

  /** 已降级为 authenticated 但没有任何 claims（会话过期/claims 缺失的边界情况）。 */
  async asAuthenticatedNoClaims(fn) {
    await this.asAdmin(async () => {});
    await this.db.exec(`set role authenticated`);
    this.role = 'authenticated';
    this.currentUser = null;
    return fn(this);
  }

  /** 未登录但未降级角色（相当于 PostgREST 缺失 claims 的边界情况）。 */
  async asNoClaims(fn) {
    return this.asAuthenticatedNoClaims(fn);
  }

  async addUser(id, email) {
    await this.asAdmin(async () => {
      await this.db.query('insert into auth.users (id, email) values ($1, $2)', [id, email]);
    });
    return id;
  }

  /** 捕获语句级错误信息（用于断言权限拒绝等）。 */
  async expectError(sql, params = []) {
    try {
      await this.db.query(sql, params);
      return null;
    } catch (err) {
      return err.message;
    }
  }

  /** 直接以超级用户改锚点/时间，模拟「经过了 N 小时」。 */
  async backdateAnchor(aquariumId, intervalSql) {
    await this.asAdmin(async () => {
      await this.db.query(
        `update public.aquariums set last_growth_at = now() - ${intervalSql}, updated_at = now() where id = $1`,
        [aquariumId],
      );
    });
  }

  async close() {
    await this.db.close();
  }
}

export const USERS = {
  alice: '11111111-1111-4111-8111-111111111111',
  bob: '22222222-2222-4222-8222-222222222222',
  carol: '33333333-3333-4333-8333-333333333333',
};

export const FIXTURE_NAMES = ['小满', '泡泡', '阿橘', '小月'];

/** 生成一个合法的 v1 存档（与 web/model.js initial() 同构）。 */
export function validState({ fishCount = 3, now = 1750000000000, idPrefix = 'fish' } = {}) {
  return {
    version: 1,
    fish: Array.from({ length: fishCount }, (_, i) => ({
      id: `${idPrefix}-${i}`,
      name: FIXTURE_NAMES[i % FIXTURE_NAMES.length],
      species: i % 4,
      born: now,
      growth: 0,
      meals: 0,
    })),
    plants: 3,
    night: false,
    sound: false,
    savedAt: now,
  };
}
