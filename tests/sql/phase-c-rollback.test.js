// Phase C rollback safety checks against the isolated PGlite database.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { initial } from '../../web/model.js';
import { createTestDb } from './harness.mjs';

let pgliteModule = null;
let skipReason = false;
try {
  pgliteModule = await import('@electric-sql/pglite');
} catch {
  skipReason = '未安装 @electric-sql/pglite';
}

const rollbackSql = await readFile(
  new URL('../../supabase/rollback/0003_phase_c_shared.down.sql', import.meta.url),
  'utf8'
);
let userSequence = 0;
let operationSequence = 0;

function uuid(sequence, prefix = 'b') {
  return `${prefix}0000000-0000-4000-8000-${String(sequence).padStart(12, '0')}`;
}

async function withDb(run) {
  const db = await createTestDb({ pgliteModule });
  try {
    return await run(db);
  } finally {
    await db.close();
  }
}

async function addUser(db, email) {
  const id = uuid(++userSequence);
  await db.addUser(id, email);
  return id;
}

async function createRoom(db, ownerId) {
  const state = initial();
  assert.equal(state.version, 2, 'fixture state must use model.initial() v2');
  const rows = await db.asUser(ownerId, () => db.query(
    'select * from public.ensure_aquarium($1::jsonb, 2)', [JSON.stringify(state)]
  ));
  assert.equal(rows[0].status, 'ok');
  return { id: rows[0].aquarium_id, state: rows[0].state_json, revision: rows[0].revision };
}

async function attemptRollback(db) {
  try {
    await db.asAdmin(() => db.db.exec(rollbackSql));
    return { ok: true, error: null };
  } catch (error) {
    // PGlite leaves an explicit BEGIN transaction aborted after a DO block raises.
    // Roll it back before checking that the protection preserved all C data.
    try { await db.db.exec('rollback'); } catch {}
    return { ok: false, error: error.message };
  }
}

async function cTablePresence(db) {
  const rows = await db.asAdmin(() => db.query(
    `select to_regclass('public.mofish_members') as members,
            to_regclass('public.mofish_invites') as invites,
            to_regclass('public.mofish_room_operations') as operations,
            to_regclass('public.mofish_room_revisions') as revisions`
  ));
  return rows[0];
}

test('empty Phase C rollback removes C metadata and restores the personal B save RPC', { skip: skipReason }, async () => {
  await withDb(async (db) => {
    const owner = await addUser(db, 'rollback-empty@example.test');
    const result = await attemptRollback(db);
    assert.deepEqual(result, { ok: true, error: null });
    assert.deepEqual(await cTablePresence(db), {
      members: null,
      invites: null,
      operations: null,
      revisions: null
    });

    const room = await createRoom(db, owner);
    const state = JSON.parse(JSON.stringify(room.state));
    state.fish[0].name = '回滚后仍可用B保存';
    const saved = await db.asUser(owner, () => db.query(
      'select * from public.save_aquarium($1::uuid, $2::bigint, $3::jsonb, 2)',
      [room.id, room.revision, JSON.stringify(state)]
    ));
    assert.equal(saved[0].status, 'ok');
    assert.equal(saved[0].revision, room.revision + 1);
  });
});

test('rollback refuses while a membership exists and preserves its row and C tables', { skip: skipReason }, async () => {
  await withDb(async (db) => {
    const owner = await addUser(db, 'rollback-member-owner@example.test');
    const member = await addUser(db, 'rollback-member@example.test');
    const room = await createRoom(db, owner);
    await db.asAdmin(() => db.query(
      "insert into public.mofish_members(aquarium_id,user_id,role) values ($1,$2,'viewer')",
      [room.id, member]
    ));

    const result = await attemptRollback(db);
    assert.equal(result.ok, false);
    assert.match(result.error, /C rollback refused/);
    assert.deepEqual(await cTablePresence(db), {
      members: 'mofish_members',
      invites: 'mofish_invites',
      operations: 'mofish_room_operations',
      revisions: 'mofish_room_revisions'
    });
    const counts = await db.asAdmin(() => db.query(
      'select (select count(*) from public.mofish_members) as members, (select count(*) from public.mofish_invites) as invites, (select count(*) from public.mofish_room_operations) as operations'
    ));
    assert.deepEqual(counts[0], { members: 1, invites: 0, operations: 0 });
  });
});

test('rollback refuses while an invitation exists and preserves it', { skip: skipReason }, async () => {
  await withDb(async (db) => {
    const owner = await addUser(db, 'rollback-invite-owner@example.test');
    const room = await createRoom(db, owner);
    const invite = await db.asUser(owner, async () => (await db.query(
      'select public.shared_create_invite($1::uuid,$2::text,$3::text,24) as result',
      [room.id, 'rollback-invitee@example.test', 'viewer']
    ))[0].result);
    assert.equal(invite.ok, true);

    const result = await attemptRollback(db);
    assert.equal(result.ok, false);
    assert.match(result.error, /C rollback refused/);
    const counts = await db.asAdmin(() => db.query(
      'select (select count(*) from public.mofish_members) as members, (select count(*) from public.mofish_invites) as invites, (select count(*) from public.mofish_room_operations) as operations'
    ));
    assert.deepEqual(counts[0], { members: 0, invites: 1, operations: 0 });
    assert.equal((await cTablePresence(db)).invites, 'mofish_invites');
  });
});

test('rollback refuses while an operation record exists and preserves it', { skip: skipReason }, async () => {
  await withDb(async (db) => {
    const owner = await addUser(db, 'rollback-operation-owner@example.test');
    const room = await createRoom(db, owner);
    const operationId = uuid(++operationSequence, 'c');
    const result = await db.asUser(owner, async () => (await db.query(
      'select public.shared_apply_operations($1::uuid,$2::uuid,$3::jsonb) as result',
      [room.id, operationId, JSON.stringify([{ kind: 'set_night', before: false, value: true }])]
    ))[0].result);
    assert.equal(result.ok, true);

    const rollbackResult = await attemptRollback(db);
    assert.equal(rollbackResult.ok, false);
    assert.match(rollbackResult.error, /C rollback refused/);
    const rows = await db.asAdmin(() => db.query(
      'select count(*) as operations, (select operation_id from public.mofish_room_operations limit 1) as operation_id from public.mofish_room_operations'
    ));
    assert.deepEqual(rows[0], { operations: 1, operation_id: operationId });
    assert.equal((await cTablePresence(db)).operations, 'mofish_room_operations');
  });
});
