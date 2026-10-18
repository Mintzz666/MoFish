// 阶段 B 的服务端集成测试（PGlite 真实 Postgres 内核 + 真实迁移 SQL，不是 Supabase 云联调）。
//
// 覆盖：
//   * v2 存档（字符串鱼种、外观种子、造景对象列表）的保存与校验边界；
//   * v1 旧档继续可用，旧客户端仍按每小时 0.008 结算（不回退成新公式）；
//   * 四阶段成长的 v2 速率（0.05/24h，24h 封顶）与重复结算幂等；
//   * 进食记账 record_feeding 的 operation_id 去重、归属校验、每鱼 24h 最多 3 口；
//   * 营养成长只在 settle_growth 结算，重复结算不重复奖励；
//   * 客户端对 mofish_feed_events 没有任何直接读写权限。

import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb, USERS } from './harness.mjs';

let pgliteModule = null;
let skipReason = false;
try {
  pgliteModule = await import('@electric-sql/pglite');
} catch {
  skipReason = '未安装 @electric-sql/pglite（在仓库根目录执行 npm install 后重跑）';
}

let db;
let seq = 0;

const NOW = 1750000000000;

function v2State({ fishCount = 3, idPrefix = 'v2', decor = [] } = {}) {
  return {
    version: 2,
    fish: Array.from({ length: fishCount }, (_, i) => ({
      id: `${idPrefix}-fish-${i}`,
      name: `鱼${i}`,
      species: ['sunset', 'mint', 'moon', 'coral'][i % 4],
      born: NOW - 86400000,
      growth: 0.2,
      meals: 3,
      look: { v: 1, seed: 1000 + i }
    })),
    decor,
    layout: { v: 1, seed: 42 },
    night: false,
    sound: false,
    savedAt: NOW
  };
}

function decorItem(i, over = {}) {
  return { id: `d${i}`, kind: 'plant', type: 'vallis', x: 0.2, z: 0.3, rot: 0.5, scale: 1, seed: 100 + i, v: 1, ...over };
}

async function freshAquarium(userId, state, stateVersion = 2) {
  const id = `cccccccc-0000-4000-8000-${String(++seq).padStart(12, '0')}`;
  return db.asAdmin(async () => {
    await db.db.query('delete from public.aquariums where owner_id = $1', [userId]);
    await db.db.query('insert into auth.users (id, email) values ($1, $2) on conflict (id) do nothing', [id, `${id}@example.com`]);
    return db.asUser(userId, async () => {
      const rows = await db.query('select * from public.ensure_aquarium($1::jsonb, $2)', [JSON.stringify(state), stateVersion]);
      return rows[0];
    });
  });
}

before(async () => {
  if (skipReason) return;
  db = await createTestDb({ pgliteModule });
  await db.addUser(USERS.alice, 'alice@example.com');
  await db.addUser(USERS.bob, 'bob@example.com');
});

after(async () => {
  if (db) await db.close();
});

// ------------------------------------------------------------------ 存档 v2

test('v2 存档可以开缸与保存，版本与参数一致', { skip: skipReason }, async () => {
  const state = v2State({ decor: [decorItem(1), decorItem(2, { kind: 'rock', type: 'seiryu' })] });
  const row = await freshAquarium(USERS.alice, state);
  assert.equal(row.status, 'ok');
  assert.equal(row.state_json.version, 2);
  assert.equal(row.state_json.fish[0].species, 'sunset');

  const saved = await db.asUser(USERS.alice, async () => {
    const next = { ...state, fish: state.fish.map((f) => ({ ...f, name: '改名后' })) };
    return db.query('select * from public.save_aquarium($1, $2, $3::jsonb, $4)', [row.aquarium_id, row.revision, JSON.stringify(next), 2]);
  });
  assert.equal(saved[0].status, 'ok');
  assert.equal(saved[0].revision, row.revision + 1);
});

test('v2 校验：越界坐标、非法种类、重复 id、超量与缺字段都被拒绝', { skip: skipReason }, async () => {
  const row = await freshAquarium(USERS.alice, v2State());
  const bad = [
    ['fish_species_invalid', { fish: [{ ...v2State().fish[0], species: 0 }] }],
    ['fish_look_missing', { fish: [{ ...v2State().fish[0], look: undefined }] }],
    ['fish_look_invalid', { fish: [{ ...v2State().fish[0], look: { v: 1, seed: -1 } }] }],
    ['decor_missing', { decor: undefined }],
    ['decor_kind_invalid', { decor: [decorItem(1, { kind: 'coral' })] }],
    ['decor_type_invalid', { decor: [decorItem(1, { type: 'Bad Type' })] }],
    ['decor_position_invalid', { decor: [decorItem(1, { x: 1.5 })] }],
    ['decor_rotation_invalid', { decor: [decorItem(1, { rot: -1 })] }],
    ['decor_scale_invalid', { decor: [decorItem(1, { scale: 3 })] }],
    ['decor_id_duplicated', { decor: [decorItem(1), decorItem(1)] }],
    ['decor_count_above_max', { decor: Array.from({ length: 25 }, (_, i) => decorItem(i)) }],
    ['fish_count_above_max', { fish: Array.from({ length: 13 }, (_, i) => ({ ...v2State().fish[0], id: `x${i}` })) }]
  ];

  await db.asUser(USERS.alice, async () => {
    for (const [code, patch] of bad) {
      const payload = JSON.stringify({ ...v2State(), ...patch });
      const r = await db.query('select * from public.save_aquarium($1, $2, $3::jsonb, $4)', [row.aquarium_id, row.revision, payload, 2]);
      assert.equal(r[0].status, 'invalid_state', `${code}: 期望被拒绝`);
      assert.equal(r[0].error_code, code, `${code}: 错误码不一致`);
    }
    const current = await db.query('select revision from public.aquariums where id = $1', [row.aquarium_id]);
    assert.equal(current[0].revision, row.revision, '被拒绝的写入没有推进 revision');
  });
});

test('版本一致性：v2 存档配 v1 参数会被拒绝，v1 存档配 v2 参数也会被拒绝', { skip: skipReason }, async () => {
  const row = await freshAquarium(USERS.alice, v2State());
  await db.asUser(USERS.alice, async () => {
    const mismatchA = await db.query('select * from public.save_aquarium($1, $2, $3::jsonb, $4)', [row.aquarium_id, row.revision, JSON.stringify(v2State()), 1]);
    assert.equal(mismatchA[0].status, 'invalid_state');
    const mismatchB = await db.query('select * from public.save_aquarium($1, $2, $3::jsonb, $4)', [row.aquarium_id, row.revision, JSON.stringify({ version: 1 }), 2]);
    assert.equal(mismatchB[0].status, 'invalid_state');
    assert.equal(mismatchB[0].error_code, 'version_mismatch');
  });
});

test('v1 旧档仍可保存，并按每小时 0.008 结算（老客户端不被新公式影响）', { skip: skipReason }, async () => {
  const legacy = {
    version: 1,
    fish: [{ id: 'old-1', name: '老鱼', species: 0, born: NOW, growth: 0, meals: 0 }],
    plants: 2,
    night: false,
    sound: false,
    savedAt: NOW
  };
  const row = await freshAquarium(USERS.alice, legacy, 1);
  assert.equal(row.status, 'ok');
  await db.backdateAnchor(row.aquarium_id, "interval '1 hour'");
  const settled = await db.asUser(USERS.alice, async () => db.query('select * from public.settle_growth($1)', [row.aquarium_id]));
  assert.equal(settled[0].credited_seconds, 3600);
  assert.ok(Math.abs(settled[0].state_json.fish[0].growth - 0.008) < 1e-6, `实际 ${settled[0].state_json.fish[0].growth}`);
});

// ------------------------------------------------------------------ 成长 v2

test('v2 时间成长：24 小时 +0.05，重复结算不重复奖励，25 小时仍按 24 小时封顶', { skip: skipReason }, async () => {
  const row = await freshAquarium(USERS.alice, v2State());
  await db.backdateAnchor(row.aquarium_id, "interval '25 hours'");
  const first = await db.asUser(USERS.alice, async () => db.query('select * from public.settle_growth($1)', [row.aquarium_id]));
  assert.equal(first[0].status, 'ok');
  assert.equal(first[0].credited_seconds, 86400);
  const growth = first[0].state_json.fish[0].growth;
  assert.ok(Math.abs(growth - (0.2 + 0.05)) < 1e-6, `实际 ${growth}`);

  const second = await db.asUser(USERS.alice, async () => db.query('select * from public.settle_growth($1)', [row.aquarium_id]));
  assert.equal(second[0].credited_seconds, 0);
  assert.equal(second[0].revision, first[0].revision, '没有可结算内容时不推进 revision');
  assert.equal(second[0].state_json.fish[0].growth, growth);
});

// ------------------------------------------------------------------ 进食记账

test('进食记账按 operation_id 幂等，且只允许记在自己鱼缸里存在的鱼', { skip: skipReason }, async () => {
  const row = await freshAquarium(USERS.alice, v2State());
  const fishId = row.state_json.fish[0].id;
  const op = '99999999-9999-4999-8999-999999999999';

  const first = await db.asUser(USERS.alice, async () => db.query('select * from public.record_feeding($1, $2, $3, 1)', [row.aquarium_id, op, fishId]));
  assert.equal(first[0].status, 'ok');
  assert.equal(first[0].duplicate, false);

  const again = await db.asUser(USERS.alice, async () => db.query('select * from public.record_feeding($1, $2, $3, 1)', [row.aquarium_id, op, fishId]));
  assert.equal(again[0].status, 'ok');
  assert.equal(again[0].duplicate, true, '重复提交同一 operation_id 不会记第二次');

  const missingFish = await db.asUser(USERS.alice, async () => db.query('select * from public.record_feeding($1, gen_random_uuid(), $2, 1)', [row.aquarium_id, 'not-a-fish']));
  assert.equal(missingFish[0].status, 'not_found');

  const otherOwner = await db.asUser(USERS.bob, async () => db.query('select * from public.record_feeding($1, gen_random_uuid(), $2, 1)', [row.aquarium_id, fishId]));
  assert.equal(otherOwner[0].status, 'not_found', '别人的鱼缸按不存在处理');

  const anon = await db.asAnon(async () => db.expectError('select * from public.record_feeding($1, gen_random_uuid(), $2, 1)', [row.aquarium_id, fishId]));
  assert.match(String(anon), /permission denied/i, '匿名没有执行权限');

  const rows = await db.asAdmin(async () => db.query('select count(*)::int as n from public.mofish_feed_events where aquarium_id = $1', [row.aquarium_id]));
  assert.equal(rows[0].n, 1, '同一 operation_id 只留一条事件');
});

test('营养成长在 settle 结算：每鱼 24h 最多 3 口，meals 记录全部进食', { skip: skipReason }, async () => {
  const row = await freshAquarium(USERS.alice, v2State());
  const fishId = row.state_json.fish[0].id;

  await db.asUser(USERS.alice, async () => {
    for (let i = 0; i < 6; i += 1) {
      await db.query('select * from public.record_feeding($1, gen_random_uuid(), $2, 1)', [row.aquarium_id, fishId]);
    }
  });
  const settled = await db.asUser(USERS.alice, async () => db.query('select * from public.settle_growth($1)', [row.aquarium_id]));
  const growth = settled[0].state_json.fish[0].growth;
  assert.ok(growth >= 0.2 + 0.02 - 1e-9, `3 口应加 0.02，实际 ${growth}`);
  assert.ok(growth < 0.2 + 0.02 + 1e-3, `不能超过营养上限，实际 ${growth}`);
  assert.equal(settled[0].state_json.fish[0].meals, 3 + 6, '吃饱后仍然记录互动次数');

  const before = settled[0].state_json.fish[0].growth;
  const again = await db.asUser(USERS.alice, async () => db.query('select * from public.settle_growth($1)', [row.aquarium_id]));
  assert.equal(again[0].state_json.fish[0].growth, before, '已应用的进食事件不会被重复结算');
});

test('超过 24 小时的旧进食事件不再占用当日额度', { skip: skipReason }, async () => {
  const row = await freshAquarium(USERS.alice, v2State());
  const fishId = row.state_json.fish[0].id;
  await db.asUser(USERS.alice, async () => {
    for (let i = 0; i < 3; i += 1) {
      await db.query('select * from public.record_feeding($1, gen_random_uuid(), $2, 1)', [row.aquarium_id, fishId]);
    }
  });
  await db.asUser(USERS.alice, async () => db.query('select * from public.settle_growth($1)', [row.aquarium_id]));

  // 把这批已结算事件挪到 25 小时前，再喂一口：新额度可用
  await db.asAdmin(async () => {
    await db.db.query("update public.mofish_feed_events set created_at = now() - interval '25 hours' where aquarium_id = $1", [row.aquarium_id]);
  });
  await db.asUser(USERS.alice, async () => {
    await db.query('select * from public.record_feeding($1, gen_random_uuid(), $2, 1)', [row.aquarium_id, fishId]);
  });
  const after = await db.asUser(USERS.alice, async () => db.query('select * from public.settle_growth($1)', [row.aquarium_id]));
  const growth = after[0].state_json.fish[0].growth;
  assert.ok(growth >= 0.2 + 0.02 + 0.02 / 3 - 1e-9, `新窗口应再记 1 口，实际 ${growth}`);
});

test('客户端没有进食事件表的直接读写权限，匿名与越权都被拒绝', { skip: skipReason }, async () => {
  const row = await freshAquarium(USERS.alice, v2State());
  const readDenied = await db.asUser(USERS.alice, async () => db.expectError('select * from public.mofish_feed_events'));
  assert.match(String(readDenied), /permission denied/i);
  const writeDenied = await db.asUser(USERS.alice, async () => db.expectError(
    "insert into public.mofish_feed_events (aquarium_id, operation_id, fish_id) values ($1, gen_random_uuid(), 'x')",
    [row.aquarium_id]
  ));
  assert.match(String(writeDenied), /permission denied/i);
  const anonRead = await db.asAnon(async () => db.expectError('select * from public.aquariums'));
  assert.match(String(anonRead), /permission denied/i);
});
