// 迁移、RLS 与 RPC 的真实 Postgres 集成测试（PGlite/WASM 内核，非 Supabase 云联调）。
// 覆盖 ROADMAP「A 的必须验证项」中可在无云账号条件下真实执行的部分：
//   账号隔离 / RPC 越权 / 原子 revision 冲突 / 参数校验 / 幂等成长结算与 24 小时上限。

import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb, readMigrations, USERS, validState } from './harness.mjs';
import { initial as modelInitial, validate as modelValidate } from '../../web/model.js';

let pgliteModule = null;
let skipReason = false;
try {
  pgliteModule = await import('@electric-sql/pglite');
} catch {
  skipReason = '未安装 @electric-sql/pglite（在仓库根目录执行 npm install 后重跑）';
}

let db;

before(async () => {
  if (skipReason) return;
  db = await createTestDb({ pgliteModule });
  await db.addUser(USERS.alice, 'alice@example.com');
  await db.addUser(USERS.bob, 'bob@example.com');
  await db.addUser(USERS.carol, 'carol@example.com');
});

after(async () => {
  if (db) await db.close();
});

/** 每个用例用自己的账号开缸，避免互相污染（阶段 A 每账号只有一条鱼缸，故先清掉旧的）。 */
let seq = 0;
async function freshAquarium(userId, state = validState()) {
  const id = `aaaaaaaa-0000-4000-8000-${String(++seq).padStart(12, '0')}`;
  return db.asAdmin(async () => {
    await db.db.query('delete from public.aquariums where owner_id = $1', [userId]);
    await db.db.query('insert into auth.users (id, email) values ($1, $2) on conflict (id) do nothing',
      [id, `${id}@example.com`]);
    return db.asUser(userId, async () => {
      const rows = await db.query('select * from public.ensure_aquarium($1::jsonb)', [JSON.stringify(state)]);
      return rows[0];
    });
  });
}

// ------------------------------------------------------------------ 迁移本身

test('迁移可幂等重放（第二次应用不报错、不丢数据）', { skip: skipReason }, async () => {
  const aquarium = await freshAquarium(USERS.alice);
  assert.equal(aquarium.status, 'ok');

  const migrations = await readMigrations();
  await db.asAdmin(async () => {
    for (const m of migrations) await db.db.exec(m.sql);
  });

  await db.asUser(USERS.alice, async () => {
    const rows = await db.query('select id, revision from public.aquariums where id = $1', [aquarium.aquarium_id]);
    assert.equal(rows.length, 1, '重放迁移后原数据仍在');
    assert.equal(rows[0].revision, 1);
  });
});

test('迁移对象齐备：表、唯一索引、RLS、四个函数，且只有 SELECT 表权限', { skip: skipReason }, async () => {
  const [tbl] = await db.query(`select relrowsecurity from pg_class where oid = 'public.aquariums'::regclass`);
  assert.equal(tbl.relrowsecurity, true, 'aquariums 已启用 RLS');

  const idx = await db.query(`select indexname from pg_indexes where schemaname='public' and tablename='aquariums'`);
  const names = idx.map(r => r.indexname);
  assert.ok(names.includes('aquariums_owner_phase_a_uidx'), '阶段 A 的 owner 唯一索引存在');

  const fns = await db.query(`
    select p.proname, p.prosecdef, p.proconfig from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in ('mofish_state_error','save_aquarium','ensure_aquarium','settle_growth')
    order by p.proname`);
  assert.deepEqual(fns.map(r => r.proname),
    ['ensure_aquarium', 'mofish_state_error', 'save_aquarium', 'settle_growth']);
  for (const f of fns) {
    if (f.proname === 'mofish_state_error') continue;
    // 写入函数必须是 SECURITY DEFINER：表级写权限已收回，函数以属主身份写入，
    // 鉴权与归属过滤全部在函数内部完成（否则客户端又能直接调表改写 revision）。
    assert.equal(f.prosecdef, true, `${f.proname} 必须是 SECURITY DEFINER`);
    assert.ok((f.proconfig || []).some(c => c.startsWith('search_path=')),
      `${f.proname} 必须固定 search_path，避免被劫持`);
  }

  // 客户端角色只应能读自己的行，不能直接写表。
  const priv = await db.asAdmin(async () => (await db.query(`
    select has_table_privilege('authenticated','public.aquariums','SELECT')     as can_select,
           has_table_privilege('authenticated','public.aquariums','INSERT')     as can_insert,
           has_table_privilege('authenticated','public.aquariums','UPDATE')     as can_update,
           has_table_privilege('authenticated','public.aquariums','DELETE')     as can_delete,
           has_table_privilege('anon','public.aquariums','SELECT')              as anon_select,
           has_function_privilege('authenticated','public.save_aquarium(uuid,bigint,jsonb,integer)','EXECUTE') as can_save,
           has_function_privilege('anon','public.save_aquarium(uuid,bigint,jsonb,integer)','EXECUTE')          as anon_save,
           has_function_privilege('authenticated','public.mofish_state_error(jsonb)','EXECUTE')                as can_validate`))[0]);
  assert.equal(priv.can_select, true, 'authenticated 可读自己的行（仍受 RLS 限制）');
  assert.equal(priv.can_insert, false, 'authenticated 不能直接 INSERT');
  assert.equal(priv.can_update, false, 'authenticated 不能直接 UPDATE（否则可改写 revision）');
  assert.equal(priv.can_delete, false, 'authenticated 不能直接 DELETE');
  assert.equal(priv.anon_select, false, 'anon 不能读表');
  assert.equal(priv.can_save, true, 'authenticated 可以调用受控写入函数');
  assert.equal(priv.anon_save, false, 'anon 不能调用写入函数');
  assert.equal(priv.can_validate, false, '校验函数不对客户端开放');
});

test('hardening 迁移收紧平台 event-trigger helper 权限并保留 owner RLS initplan', { skip: skipReason }, async () => {
  const hardening = (await readMigrations()).find(m => m.name.includes('phase_a_cloud_hardening'));
  assert.ok(hardening, '版本化 hardening 迁移存在');

  await db.asAdmin(async () => {
    // Supabase 平台可能提供此 SECURITY DEFINER event-trigger helper。
    // 显式授予客户端，证明新迁移会撤回既有 grants，而非只依赖默认 ACL。
    await db.db.exec(`
      create or replace function public.rls_auto_enable()
      returns event_trigger
      language plpgsql
      security definer
      set search_path = public, pg_temp
      as $$ begin null; end $$;
      grant execute on function public.rls_auto_enable() to anon, authenticated;
    `);
    await db.db.exec(hardening.sql);
  });

  const privileges = await db.asAdmin(async () => (await db.query(`
    select p.prosecdef,
           p.proowner::regrole::text as owner_name,
           has_function_privilege('anon', 'public.rls_auto_enable()', 'EXECUTE') as anon_execute,
           has_function_privilege('authenticated', 'public.rls_auto_enable()', 'EXECUTE') as authenticated_execute,
           has_function_privilege(current_user, 'public.rls_auto_enable()', 'EXECUTE') as owner_execute
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname = 'rls_auto_enable'
  `))[0]);
  assert.equal(privileges.prosecdef, true, '平台 helper 保持 SECURITY DEFINER');
  assert.equal(privileges.anon_execute, false, 'anon 不能执行平台 helper');
  assert.equal(privileges.authenticated_execute, false, 'authenticated 不能执行平台 helper');
  assert.equal(privileges.owner_execute, true, `${privileges.owner_name} 仍保有函数执行权`);

  const policy = await db.asAdmin(async () => (await db.query(`
    select qual
      from pg_policies
     where schemaname = 'public'
       and tablename = 'aquariums'
       and policyname = 'aquariums_select_own'
  `))[0]);
  assert.ok(policy, '所有者读取策略仍存在');
  assert.match(policy.qual, /owner_id\s*=\s*\(\s*SELECT\s+auth\.uid\(\)/i,
    '策略仍按 auth.uid() 限制 owner，并使用 scalar subquery 形态');

  const mine = await freshAquarium(USERS.alice, validState({ idPrefix: 'hardening' }));
  const ownRows = await db.asUser(USERS.alice, async () => db.query(
    'select id from public.aquariums where id = $1', [mine.aquarium_id]));
  const otherRows = await db.asUser(USERS.bob, async () => db.query(
    'select id from public.aquariums where id = $1', [mine.aquarium_id]));
  assert.equal(ownRows.length, 1, 'owner 仍能读取自己的鱼缸');
  assert.equal(otherRows.length, 0, '其他登录用户仍读不到该鱼缸');

  const explainRows = await db.asUser(USERS.alice, async () => db.query(
    'explain (costs off) select id from public.aquariums'));
  const plan = explainRows.map(row => Object.values(row)[0]).join('\n');
  assert.match(plan, /InitPlan/i, `owner policy 应被规划为 InitPlan，实际计划：\n${plan}`);
});

// ------------------------------------------------------------------ 表级写权限已收回（评审 P1-5）

test('authenticated 无法绕过 RPC 直接改写存档、revision 与成长锚点', { skip: skipReason }, async () => {
  const mine = await freshAquarium(USERS.alice, validState({ idPrefix: 'guard' }));

  await db.asUser(USERS.alice, async () => {
    const overwrite = await db.expectError(
      `update public.aquariums set state_json = '{}'::jsonb where id = $1`, [mine.aquarium_id]);
    assert.ok(overwrite && /permission denied/i.test(overwrite), `直接改写存档应被拒绝，实际: ${overwrite}`);

    const bumpRevision = await db.expectError(
      `update public.aquariums set revision = 42 where id = $1`, [mine.aquarium_id]);
    assert.ok(bumpRevision && /permission denied/i.test(bumpRevision), `直接改写 revision 应被拒绝，实际: ${bumpRevision}`);

    const rewindAnchor = await db.expectError(
      `update public.aquariums set last_growth_at = now() - interval '10 days' where id = $1`, [mine.aquarium_id]);
    assert.ok(rewindAnchor && /permission denied/i.test(rewindAnchor), `直接回拨成长锚点应被拒绝，实际: ${rewindAnchor}`);

    const del = await db.expectError(`delete from public.aquariums where id = $1`, [mine.aquarium_id]);
    assert.ok(del && /permission denied/i.test(del), `直接删除应被拒绝，实际: ${del}`);
  });

  // 数据确实没被动过
  await db.asUser(USERS.alice, async () => {
    const [row] = await db.query('select revision, state_json from public.aquariums where id = $1', [mine.aquarium_id]);
    assert.equal(row.revision, mine.revision);
    assert.equal(row.state_json.fish[0].id, 'guard-0');
  });
});

test('校验函数不对客户端开放，但受控 RPC 内部仍能使用它', { skip: skipReason }, async () => {
  const mine = await freshAquarium(USERS.alice, validState({ idPrefix: 'vfn' }));
  await db.asUser(USERS.alice, async () => {
    const err = await db.expectError(`select public.mofish_state_error($1::jsonb)`, [JSON.stringify(validState())]);
    assert.ok(err && /permission denied/i.test(err), `直接调用校验函数应被拒绝，实际: ${err}`);

    // RPC 内部调用同样生效：非法存档仍被拒（说明 SECURITY DEFINER 的身份继承正常）
    const bad = await db.query('select * from public.save_aquarium($1, $2, $3::jsonb)',
      [mine.aquarium_id, mine.revision, JSON.stringify({ version: 1, fish: [] })]);
    assert.equal(bad[0].status, 'invalid_state');
  });
});

// ------------------------------------------------------------------ 开缸与账号隔离

test('ensure_aquarium 幂等：重复开缸返回同一条鱼缸，不新增记录', { skip: skipReason }, async () => {
  const first = await freshAquarium(USERS.bob);
  assert.equal(first.created, true, '首次开缸必须标记 created=true（客户端据此决定是否需要让用户选择存档）');

  const second = await db.asUser(USERS.bob, async () => (await db.query(
    'select * from public.ensure_aquarium($1::jsonb)', [JSON.stringify(validState({ fishCount: 5 }))]))[0]);

  assert.equal(second.status, 'ok');
  assert.equal(second.created, false, '已有鱼缸时必须标记 created=false');
  assert.equal(second.aquarium_id, first.aquarium_id, '同一个账号只有一条鱼缸');
  assert.equal(second.revision, first.revision, '重复开缸不提升 revision');
  assert.equal(second.state_json.fish.length, 3, '重复开缸不覆盖已有存档');

  const count = await db.asAdmin(async () => (await db.query('select count(*)::int as n from public.aquariums where owner_id = $1', [USERS.bob]))[0]);
  assert.equal(count.n, 1, '数据库里只有一条记录');
});

test('账号隔离：他人无法读、改、删我的鱼缸（表级写权限已收回）', { skip: skipReason }, async () => {
  const mine = await freshAquarium(USERS.alice, validState({ idPrefix: 'iso' }));
  const id = mine.aquarium_id;

  await db.asUser(USERS.bob, async () => {
    const read = await db.query('select * from public.aquariums where id = $1', [id]);
    assert.equal(read.length, 0, 'bob 读不到 alice 的鱼缸（RLS）');

    // 表级写权限已收回：连自己的行都不能直接改，越权改别人的自然更不可能。
    const upd = await db.expectError(
      `update public.aquariums set state_json = '{"hijacked":true}'::jsonb where id = $1`, [id]);
    assert.ok(upd && /permission denied/i.test(upd), `直接 update 应被拒绝，实际: ${upd}`);

    const del = await db.expectError('delete from public.aquariums where id = $1', [id]);
    assert.ok(del && /permission denied/i.test(del), `直接 delete 应被拒绝，实际: ${del}`);

    const rpc = await db.query('select * from public.save_aquarium($1, $2, $3::jsonb)',
      [id, 1, JSON.stringify(validState({ idPrefix: 'hacked' }))]);
    assert.equal(rpc[0].status, 'not_found', 'RPC 只按 auth.uid() 定位，不认传入的 id');
    assert.equal(rpc[0].error_code, 'aquarium_not_found');

    const settle = await db.query('select * from public.settle_growth($1, 86400)', [id]);
    assert.equal(settle[0].status, 'not_found', 'bob 无法结算 alice 的鱼缸');

    const list = await db.query('select id from public.aquariums');
    assert.equal(list.length, 1, 'bob 只看到自己的鱼缸');
    assert.ok(!list.some(r => r.id === id), 'alice 的鱼缸不在 bob 的结果里');
  });

  await db.asUser(USERS.alice, async () => {
    const rows = await db.query('select * from public.aquariums where id = $1', [id]);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].revision, 1, '被拒绝的写入没有改变 revision');
    assert.equal(rows[0].state_json.hijacked, undefined, '被拒绝的写入没有落到数据里');
    assert.equal(rows[0].state_json.fish[0].id, 'iso-0');
  });
});

test('账号隔离：伪造 owner_id 的插入被拒绝（无写权限）', { skip: skipReason }, async () => {
  const mine = await freshAquarium(USERS.alice);
  await db.asUser(USERS.bob, async () => {
    const err = await db.expectError(
      `insert into public.aquariums (owner_id, state_json) values ($1, '{}'::jsonb)`, [USERS.alice]);
    assert.ok(err && /permission denied/i.test(err), `期望权限拒绝，实际: ${err}`);

    // 即使是自己的 owner_id 也不能直接插入：开缸只能走 ensure_aquarium。
    const own = await db.expectError(
      `insert into public.aquariums (owner_id, state_json) values ($1, '{}'::jsonb)`, [USERS.bob]);
    assert.ok(own && /permission denied/i.test(own), `自己插入也应被拒绝，实际: ${own}`);
  });
  assert.ok(mine.aquarium_id);
});

test('未登录：匿名角色读表与调用 RPC 均被拒绝', { skip: skipReason }, async () => {
  const mine = await freshAquarium(USERS.carol);
  await db.asAnon(async () => {
    const readErr = await db.expectError('select * from public.aquariums');
    assert.ok(readErr && /permission denied/i.test(readErr), `匿名读表应被拒绝，实际: ${readErr}`);

    const rpcErr = await db.expectError('select * from public.save_aquarium($1, 1, $2::jsonb)',
      [mine.aquarium_id, JSON.stringify(validState())]);
    assert.ok(rpcErr && /permission denied/i.test(rpcErr), `匿名调 RPC 应被拒绝，实际: ${rpcErr}`);
  });
});

test('缺少 claims 的登录态：表不可见，RPC 返回 not_authenticated', { skip: skipReason }, async () => {
  await db.asAuthenticatedNoClaims(async () => {
    const rows = await db.query('select * from public.aquariums');
    assert.equal(rows.length, 0, 'auth.uid() 为 null 时看不到任何行');

    const rpc = await db.query('select * from public.save_aquarium($1, 1, $2::jsonb)',
      ['00000000-0000-4000-8000-000000000000', JSON.stringify(validState())]);
    assert.equal(rpc[0].status, 'not_authenticated');

    const ensure = await db.query('select * from public.ensure_aquarium($1::jsonb)', [JSON.stringify(validState())]);
    assert.equal(ensure[0].status, 'not_authenticated');
  });
  await db.asAdmin(async () => {});
});

// ------------------------------------------------------------------ 原子 revision 冲突

test('原子写入：revision 匹配时成功并 +1', { skip: skipReason }, async () => {
  const mine = await freshAquarium(USERS.alice, validState({ idPrefix: 'rev' }));
  await db.asUser(USERS.alice, async () => {
    const next = validState({ idPrefix: 'rev' });
    next.fish[0].name = '改过名';
    const r = await db.query('select * from public.save_aquarium($1, $2, $3::jsonb)',
      [mine.aquarium_id, mine.revision, JSON.stringify(next)]);
    assert.equal(r[0].status, 'ok');
    assert.equal(r[0].revision, mine.revision + 1);
    assert.equal(r[0].error_code, null);
  });
});

test('原子写入：旧 revision 返回 conflict 并附服务端当前 revision，不覆盖数据', { skip: skipReason }, async () => {
  const mine = await freshAquarium(USERS.alice, validState({ idPrefix: 'stale' }));
  await db.asUser(USERS.alice, async () => {
    // 设备 A 正常保存一次 → revision 2
    await db.query('select * from public.save_aquarium($1, 1, $2::jsonb)',
      [mine.aquarium_id, JSON.stringify(validState({ idPrefix: 'stale' }))]);

    // 设备 B 手里还是 revision 1
    const stale = validState({ idPrefix: 'stale' });
    stale.fish[0].name = 'B 的名字';
    const conflict = await db.query('select * from public.save_aquarium($1, 1, $2::jsonb)',
      [mine.aquarium_id, JSON.stringify(stale)]);

    assert.equal(conflict[0].status, 'conflict');
    assert.equal(conflict[0].revision, 2, '把服务端当前 revision 返回给客户端');
    assert.equal(conflict[0].error_code, 'revision_conflict');

    const cur = await db.query('select revision, state_json from public.aquariums where id = $1', [mine.aquarium_id]);
    assert.equal(cur[0].state_json.fish[0].name, '小满', '冲突方数据没有被静默写入');
    assert.equal(cur[0].revision, 2);
  });
});

test('两台设备同 revision 并发：只接受一个，另一个可控失败且不丢服务端数据', { skip: skipReason }, async () => {
  const mine = await freshAquarium(USERS.alice, validState({ idPrefix: 'race' }));
  const baseRev = mine.revision;

  const deviceA = validState({ idPrefix: 'race' });
  deviceA.fish[0].name = 'A 改的';
  const deviceB = validState({ idPrefix: 'race' });
  deviceB.fish[0].name = 'B 改的';

  await db.asUser(USERS.alice, async () => {
    const a = await db.query('select * from public.save_aquarium($1, $2, $3::jsonb)',
      [mine.aquarium_id, baseRev, JSON.stringify(deviceA)]);
    const b = await db.query('select * from public.save_aquarium($1, $2, $3::jsonb)',
      [mine.aquarium_id, baseRev, JSON.stringify(deviceB)]);

    assert.equal(a[0].status, 'ok');
    assert.equal(b[0].status, 'conflict');
    assert.equal(b[0].revision, baseRev + 1);

    const cur = await db.query('select state_json from public.aquariums where id = $1', [mine.aquarium_id]);
    assert.equal(cur[0].state_json.fish[0].name, 'A 改的', '只有先写入的那一份生效');
  });
});

test('原子写入：不属于自己的鱼缸 id 返回 not_found，不泄漏存在性', { skip: skipReason }, async () => {
  const mine = await freshAquarium(USERS.bob);
  await db.asUser(USERS.alice, async () => {
    const r = await db.query('select * from public.save_aquarium($1, 1, $2::jsonb)',
      [mine.aquarium_id, JSON.stringify(validState())]);
    assert.equal(r[0].status, 'not_found');

    const ghost = await db.query('select * from public.save_aquarium($1, 1, $2::jsonb)',
      ['00000000-0000-4000-8000-00000000dead', JSON.stringify(validState())]);
    assert.equal(ghost[0].status, 'not_found', '不存在的 id 与别人的 id 返回同一结果');
  });
});

// ------------------------------------------------------------------ 服务端存档校验

test('服务端校验：非法存档被拒绝并返回稳定错误码', { skip: skipReason }, async () => {
  const mine = await freshAquarium(USERS.carol, validState({ idPrefix: 'val' }));

  const bad = [
    ['state_not_object', '"just a string"'],
    ['state_not_object', 'null'],
    ['version_mismatch', JSON.stringify({ ...validState(), version: 3 })], // 声明的 state_version 与内容不一致
    ['fish_not_array', JSON.stringify({ ...validState(), fish: 'nope' })],
    ['fish_count_below_min', JSON.stringify({ ...validState(), fish: [] })],
    ['fish_count_above_max', JSON.stringify({ ...validState(), fish: Array.from({ length: 13 }, (_, i) => ({ id: 'x' + i, name: '鱼', species: 0, born: 1, growth: 0, meals: 0 })) })],
    ['plants_out_of_range', JSON.stringify({ ...validState(), plants: 9 })],
    ['night_not_boolean', JSON.stringify({ ...validState(), night: 'yes' })],
    ['saved_at_not_number', JSON.stringify({ ...validState(), savedAt: 'now' })],
  ];
  const fishBad = (mutate) => {
    const s = validState({ idPrefix: 'val' });
    mutate(s.fish[0]);
    return JSON.stringify(s);
  };
  bad.push(
    ['fish_id_invalid', fishBad(f => { f.id = ''; })],
    ['fish_name_invalid', fishBad(f => { f.name = 'x'.repeat(17); })],
    ['fish_species_out_of_range', fishBad(f => { f.species = 9; })],
    ['fish_growth_out_of_range', fishBad(f => { f.growth = 1.5; })],
    ['fish_growth_out_of_range', fishBad(f => { f.growth = -0.1; })],
    ['fish_meals_out_of_range', fishBad(f => { f.meals = -1; })],
    ['fish_meals_out_of_range', fishBad(f => { f.meals = 1.5; })],
    ['fish_born_out_of_range', fishBad(f => { f.born = -5; })],
  );

  await db.asUser(USERS.carol, async () => {
    for (const [expectedCode, payload] of bad) {
      const r = await db.query('select * from public.save_aquarium($1, $2, $3::jsonb)',
        [mine.aquarium_id, mine.revision, payload]);
      assert.equal(r[0].status, 'invalid_state', `${expectedCode}: 期望被拒绝，payload=${payload.slice(0, 60)}`);
      assert.equal(r[0].error_code, expectedCode);
    }

    // 被拒绝的请求没有改变数据库
    const cur = await db.query('select revision from public.aquariums where id = $1', [mine.aquarium_id]);
    assert.equal(cur[0].revision, mine.revision);
  });
});

test('服务端校验：缺失字段必须被拒绝（jsonb 里缺失即 NULL，不能用 <> 判空）', { skip: skipReason }, async () => {
  const mine = await freshAquarium(USERS.carol, validState({ idPrefix: 'miss' }));

  const withMissing = (mutate) => {
    const s = validState({ idPrefix: 'miss' });
    mutate(s);
    return JSON.stringify(s);
  };
  const cases = [
    ['version_missing', withMissing(s => { delete s.version; })],
    ['fish_missing', withMissing(s => { delete s.fish; })],
    ['plants_missing', withMissing(s => { delete s.plants; })],
    ['night_missing', withMissing(s => { delete s.night; })],
    ['sound_missing', withMissing(s => { delete s.sound; })],
    ['saved_at_missing', withMissing(s => { delete s.savedAt; })],
    ['fish_id_missing', withMissing(s => { delete s.fish[0].id; })],
    ['fish_name_missing', withMissing(s => { delete s.fish[0].name; })],
    ['fish_species_missing', withMissing(s => { delete s.fish[0].species; })],
    ['fish_born_missing', withMissing(s => { delete s.fish[0].born; })],
    ['fish_growth_missing', withMissing(s => { delete s.fish[0].growth; })],
    ['fish_meals_missing', withMissing(s => { delete s.fish[0].meals; })],
    ['version_not_number', withMissing(s => { s.version = '1'; })],
    ['plants_not_number', withMissing(s => { s.plants = '3'; })],
    ['saved_at_not_number', withMissing(s => { s.savedAt = null; })],
    ['fish_name_invalid', withMissing(s => { s.fish[0].name = 5; })]
  ];

  await db.asUser(USERS.carol, async () => {
    for (const [expectedCode, payload] of cases) {
      const r = await db.query('select * from public.save_aquarium($1, $2, $3::jsonb)',
        [mine.aquarium_id, mine.revision, payload]);
      assert.equal(r[0].status, 'invalid_state', `${expectedCode}: 期望被拒绝，payload=${payload.slice(0, 70)}`);
      assert.equal(r[0].error_code, expectedCode, `payload=${payload.slice(0, 70)}`);
    }
    // 整份缺字段的存档（早期会被漏过的形态）也必须被拒
    const stripped = await db.query('select * from public.save_aquarium($1, $2, $3::jsonb)',
      [mine.aquarium_id, mine.revision, JSON.stringify({ fish: [{ name: '无 id 的鱼' }] })]);
    assert.equal(stripped[0].status, 'invalid_state');

    const cur = await db.query('select revision from public.aquariums where id = $1', [mine.aquarium_id]);
    assert.equal(cur[0].revision, mine.revision, '被拒绝的请求没有改变 revision');
  });
});

test('服务端校验：重复的鱼 id 被拒绝', { skip: skipReason }, async () => {
  const mine = await freshAquarium(USERS.carol, validState({ idPrefix: 'dup' }));
  const dup = validState({ idPrefix: 'dup' });
  dup.fish[1].id = dup.fish[0].id;

  await db.asUser(USERS.carol, async () => {
    const r = await db.query('select * from public.save_aquarium($1, $2, $3::jsonb)',
      [mine.aquarium_id, mine.revision, JSON.stringify(dup)]);
    assert.equal(r[0].status, 'invalid_state');
    assert.equal(r[0].error_code, 'fish_id_duplicated');
  });
});

test('前后端口径一致：客户端 model.validate 产出的存档一定能通过服务端校验', { skip: skipReason }, async () => {
  const mine = await freshAquarium(USERS.carol, validState({ idPrefix: 'align' }));

  // 这些样本覆盖了客户端会把越界值「修正」而不是拒绝的路径（成长/喂食/水草/名字长度/时间戳）。
  const samples = [
    modelInitial(1750000000000),
    modelValidate({
      version: 1,
      fish: [{ id: 'legacy-1', name: '  空格   很多  ', species: 2, born: 1, growth: 5, meals: 3.7 }],
      plants: 99, night: 1, sound: 'x', savedAt: 'not-a-number'
    }, 1750000000000),
    modelValidate({
      version: 1,
      fish: Array.from({ length: 12 }, (_, i) => ({
        id: `f${i}`, name: '名'.repeat(20), species: i % 4, born: 1750000000000, growth: i / 12, meals: i
      })),
      plants: 8, night: true, sound: true, savedAt: 1750000000000
    }, 1750000000000)
  ];

  await db.asUser(USERS.carol, async () => {
    let revision = mine.revision;
    for (const [index, sample] of samples.entries()) {
      const r = await db.query('select * from public.save_aquarium($1, $2, $3::jsonb, $4)',
        [mine.aquarium_id, revision, JSON.stringify(sample), sample.version]);
      assert.equal(r[0].status, 'ok',
        `样本 ${index} 应被服务端接受，实际 ${r[0].status}/${r[0].error_code}: ${JSON.stringify(sample).slice(0, 120)}`);
      revision = r[0].revision;
    }
  });
});

test('服务端校验：夹带超长额外字段触发体积上限（前端裁剪之外的服务端兜底）', { skip: skipReason }, async () => {
  const mine = await freshAquarium(USERS.carol, validState({ idPrefix: 'big' }));
  await db.asUser(USERS.carol, async () => {
    const fat = { ...validState({ idPrefix: 'big' }), junk: 'x'.repeat(40000) };
    const r = await db.query('select * from public.save_aquarium($1, $2, $3::jsonb)',
      [mine.aquarium_id, mine.revision, JSON.stringify(fat)]);
    assert.equal(r[0].status, 'invalid_state');
    assert.equal(r[0].error_code, 'state_too_large');
  });
});

test('服务端校验：参数缺失与非法 revision 被拒绝', { skip: skipReason }, async () => {
  const mine = await freshAquarium(USERS.carol, validState({ idPrefix: 'arg' }));
  await db.asUser(USERS.carol, async () => {
    const noRev = await db.query('select * from public.save_aquarium($1, $2, $3::jsonb)',
      [mine.aquarium_id, null, JSON.stringify(validState())]);
    assert.equal(noRev[0].status, 'invalid_argument');

    const zeroRev = await db.query('select * from public.save_aquarium($1, $2, $3::jsonb)',
      [mine.aquarium_id, 0, JSON.stringify(validState())]);
    assert.equal(zeroRev[0].status, 'invalid_argument');

    const nullId = await db.query('select * from public.save_aquarium($1, $2, $3::jsonb)',
      [null, 1, JSON.stringify(validState())]);
    assert.equal(nullId[0].status, 'invalid_argument');

    const badCap = await db.query('select * from public.settle_growth($1, $2)', [mine.aquarium_id, -1]);
    assert.equal(badCap[0].status, 'invalid_argument');

    const hugeCap = await db.query('select * from public.settle_growth($1, $2)', [mine.aquarium_id, 999999999]);
    assert.equal(hugeCap[0].status, 'invalid_argument');
  });
});

// ------------------------------------------------------------------ 成长结算

test('成长结算：不足 1 秒不结算、不提升 revision（重复调用无副作用）', { skip: skipReason }, async () => {
  const mine = await freshAquarium(USERS.alice, validState({ idPrefix: 'g0' }));
  await db.asUser(USERS.alice, async () => {
    const first = await db.query('select * from public.settle_growth($1)', [mine.aquarium_id]);
    assert.equal(first[0].status, 'ok');
    assert.equal(first[0].credited_seconds, 0);
    assert.equal(first[0].revision, mine.revision, '无结算时不提升 revision，避免无意义的冲突');
    assert.equal(first[0].state_json.fish[0].growth, 0);

    const second = await db.query('select * from public.settle_growth($1)', [mine.aquarium_id]);
    assert.equal(second[0].credited_seconds, 0);
    assert.equal(second[0].revision, mine.revision);
  });
});

test('成长结算：1 小时后结算 3600 秒、成长 +0.008、revision +1', { skip: skipReason }, async () => {
  const mine = await freshAquarium(USERS.alice, validState({ fishCount: 2, idPrefix: 'g1' }));
  await db.backdateAnchor(mine.aquarium_id, `interval '3600 seconds'`);

  await db.asUser(USERS.alice, async () => {
    const r = await db.query('select * from public.settle_growth($1)', [mine.aquarium_id]);
    assert.equal(r[0].credited_seconds, 3600);
    assert.equal(r[0].revision, mine.revision + 1);
    assert.ok(Math.abs(r[0].state_json.fish[0].growth - 0.008) < 1e-9, `实际 ${r[0].state_json.fish[0].growth}`);
    assert.ok(Math.abs(r[0].state_json.fish[1].growth - 0.008) < 1e-9, '整缸鱼一起成长');
  });
});

test('成长结算：紧接着重复调用 credited=0 且 revision 不变（不重复奖励）', { skip: skipReason }, async () => {
  const mine = await freshAquarium(USERS.alice, validState({ idPrefix: 'g2' }));
  await db.backdateAnchor(mine.aquarium_id, `interval '7200 seconds'`);

  await db.asUser(USERS.alice, async () => {
    const first = await db.query('select * from public.settle_growth($1)', [mine.aquarium_id]);
    assert.equal(first[0].credited_seconds, 7200);
    const second = await db.query('select * from public.settle_growth($1)', [mine.aquarium_id]);
    assert.equal(second[0].credited_seconds, 0, '第二次不能再次奖励');
    assert.equal(second[0].revision, first[0].revision, '第二次没有改写任何字段');
    assert.equal(second[0].state_json.fish[0].growth, first[0].state_json.fish[0].growth, '成长值不变');
  });
});

test('成长结算：25 小时封顶为 86400 秒（+0.192），且封顶后不补发被截掉的部分', { skip: skipReason }, async () => {
  const mine = await freshAquarium(USERS.alice, validState({ idPrefix: 'g3' }));
  await db.backdateAnchor(mine.aquarium_id, `interval '25 hours'`);

  await db.asUser(USERS.alice, async () => {
    const r = await db.query('select * from public.settle_growth($1)', [mine.aquarium_id]);
    assert.equal(r[0].credited_seconds, 86400, '24 小时上限');
    assert.ok(Math.abs(r[0].state_json.fish[0].growth - 0.192) < 1e-9, `实际 ${r[0].state_json.fish[0].growth}`);

    // 关键回归：封顶结算后，被截掉的 1 小时不能在下一次调用里补发。
    const again = await db.query('select * from public.settle_growth($1)', [mine.aquarium_id]);
    assert.equal(again[0].credited_seconds, 0);
    assert.equal(again[0].state_json.fish[0].growth, r[0].state_json.fish[0].growth);

    const rest = await db.query(
      `select round(extract(epoch from (now() - last_growth_at))) as rest from public.aquariums where id = $1`,
      [mine.aquarium_id]);
    assert.equal(Number(rest[0].rest), 0, '锚点已推进到 now()，没有残留可结算时间');
  });
});

test('成长结算：成长封顶 1.0，且不改动名字/喂食/造景/鱼序', { skip: skipReason }, async () => {
  const state = validState({ fishCount: 12, idPrefix: 'g4' });
  state.fish[0].growth = 0.995;
  state.fish[0].name = '老鱼';
  state.fish[0].meals = 42;
  state.plants = 7;
  state.night = true;
  const mine = await freshAquarium(USERS.alice, state);
  await db.backdateAnchor(mine.aquarium_id, `interval '2 hours'`);

  await db.asUser(USERS.alice, async () => {
    const r = await db.query('select * from public.settle_growth($1)', [mine.aquarium_id]);
    assert.equal(r[0].credited_seconds, 7200);
    const after = r[0].state_json;

    assert.equal(after.fish[0].growth, 1, '超过 1 的部分被截断');
    assert.ok(Math.abs(after.fish[1].growth - 0.016) < 1e-9);
    assert.equal(after.fish[0].name, '老鱼', '名字不被结算改写');
    assert.equal(after.fish[0].meals, 42, '喂食记录不被结算改写');
    assert.equal(after.plants, 7);
    assert.equal(after.night, true);
    assert.equal(after.fish.length, 12);
    assert.deepEqual(after.fish.map(f => f.id), state.fish.map(f => f.id), '鱼的顺序与身份保持');
    assert.equal(after.version, 1);
  });
});

test('成长结算：只能结算自己的鱼缸，服务端时钟回拨不产生负成长', { skip: skipReason }, async () => {
  const mine = await freshAquarium(USERS.bob, validState({ idPrefix: 'g5' }));

  await db.asUser(USERS.alice, async () => {
    const r = await db.query('select * from public.settle_growth($1)', [mine.aquarium_id]);
    assert.equal(r[0].status, 'not_found', '别人的鱼缸结算不到');
    assert.equal(r[0].state_json, null);
  });

  // 锚点被人为拨到未来（等价于时钟回拨）
  await db.asAdmin(async () => {
    await db.db.query(
      `update public.aquariums set last_growth_at = now() + interval '2 hours', updated_at = now() where id = $1`,
      [mine.aquarium_id]);
  });

  await db.asUser(USERS.bob, async () => {
    const r = await db.query('select * from public.settle_growth($1)', [mine.aquarium_id]);
    assert.equal(r[0].credited_seconds, 0, '未来锚点按 0 处理，不会负成长');
    assert.equal(r[0].state_json.fish[0].growth, 0);
  });
});

test('成长结算：写入后锚点被推进到当前时间（下一次结算只计新增时间）', { skip: skipReason }, async () => {
  const mine = await freshAquarium(USERS.alice, validState({ idPrefix: 'g6' }));
  await db.backdateAnchor(mine.aquarium_id, `interval '3 hours'`);

  await db.asUser(USERS.alice, async () => {
    const r = await db.query('select * from public.settle_growth($1)', [mine.aquarium_id]);
    assert.equal(r[0].credited_seconds, 10800);
    const drift = await db.query(
      `select extract(epoch from (now() - last_growth_at)) as drift from public.aquariums where id = $1`,
      [mine.aquarium_id]);
    assert.ok(Math.abs(Number(drift[0].drift)) < 2, `锚点应贴近 now()，实际差了 ${drift[0].drift} 秒`);
  });
});
