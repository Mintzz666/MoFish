// Phase C sharing RPC integration tests against the isolated PGlite test database.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { initial } from '../../web/model.js';
import { createTestDb } from './harness.mjs';

let pgliteModule = null;
let skipReason = false;
try {
  pgliteModule = await import('@electric-sql/pglite');
} catch {
  skipReason = '未安装 @electric-sql/pglite';
}

let db;
let userSequence = 0;
let operationSequence = 0;

function uuid(sequence, prefix = 'a') {
  return `${prefix}0000000-0000-4000-8000-${String(sequence).padStart(12, '0')}`;
}

async function addUser(email, { confirmed = true } = {}) {
  const id = uuid(++userSequence, 'b');
  await db.addUser(id, email);
  if (!confirmed) {
    await db.asAdmin(() => db.db.query('update auth.users set email_confirmed_at = null where id = $1', [id]));
  }
  return id;
}

async function createRoom(ownerId) {
  const state = initial();
  assert.equal(state.version, 2, 'model.initial() 必须生成 v2 状态');
  const rows = await db.asUser(ownerId, () => db.query(
    'select * from public.ensure_aquarium($1::jsonb, 2)', [JSON.stringify(state)]
  ));
  assert.equal(rows[0].status, 'ok');
  assert.equal(rows[0].state_json.version, 2);
  return { id: rows[0].aquarium_id, state: rows[0].state_json, revision: rows[0].revision };
}

async function jsonRpc(userId, sql, params = []) {
  return db.asUser(userId, async () => {
    const rows = await db.query(sql, params);
    return rows[0].result;
  });
}

const invite = (userId, roomId, email, role = 'viewer', hours = 24) => jsonRpc(
  userId,
  'select public.shared_create_invite($1::uuid, $2::text, $3::text, $4::integer) as result',
  [roomId, email, role, hours]
);

const accept = (userId, token) => jsonRpc(
  userId,
  'select public.shared_accept_invite($1::text) as result',
  [token]
);

const getAquarium = (userId, roomId) => jsonRpc(
  userId,
  'select public.shared_get_aquarium($1::uuid) as result',
  [roomId]
);

const apply = (userId, roomId, operationId, operations) => jsonRpc(
  userId,
  'select public.shared_apply_operations($1::uuid, $2::uuid, $3::jsonb) as result',
  [roomId, operationId, JSON.stringify(operations)]
);

const manageMember = (userId, roomId, memberId, role = null) => jsonRpc(
  userId,
  'select public.shared_manage_member($1::uuid, $2::uuid, $3::text) as result',
  [roomId, memberId, role]
);

async function sharedFeeding(userId, roomId, fishId, opId = uuid(++operationSequence, 'c')) {
  return db.asUser(userId, async () => (await db.query(
    'select * from public.shared_record_feeding($1::uuid, $2::uuid, $3::text, 1)',
    [roomId, opId, fishId]
  ))[0]);
}

async function sharedSettle(userId, roomId, capSeconds = 0) {
  return db.asUser(userId, async () => (await db.query(
    'select * from public.shared_settle_growth($1::uuid, $2::integer)',
    [roomId, capSeconds]
  ))[0]);
}

function updateDecorOperation(before, patch) {
  const decor = { ...before, ...patch };
  return { kind: 'decor_update', id: before.id, before, decor };
}

before(async () => {
  if (!skipReason) db = await createTestDb({ pgliteModule });
});

after(async () => {
  if (db) await db.close();
});

test('directed invites require the matching verified email and reject expired or revoked tokens', { skip: skipReason }, async () => {
  const owner = await addUser('invite-owner@example.test');
  const room = await createRoom(owner);
  const target = await addUser('target@example.test', { confirmed: false });
  const wrongEmail = await addUser('someone-else@example.test');

  const created = await invite(owner, room.id, '  TARGET@EXAMPLE.TEST ', 'editor');
  assert.equal(created.ok, true);
  const token = created.data.token;

  const wrongAddress = await accept(wrongEmail, token);
  assert.deepEqual(wrongAddress, { ok: false, error: 'invalid_invite' });
  const unverified = await accept(target, token);
  assert.deepEqual(unverified, { ok: false, error: 'invalid_invite' });

  await db.asAdmin(() => db.db.query(
    'update auth.users set email_confirmed_at = now() where id = $1', [target]
  ));
  const accepted = await accept(target, token);
  assert.equal(accepted.ok, true);
  const replay = await accept(target, token);
  assert.equal(replay.ok, true, '同一受邀人重放已接受 token 应幂等成功');
  assert.equal((await getAquarium(target, room.id)).data.role, 'editor');
  const outsiderReplay = await accept(wrongEmail, token);
  assert.deepEqual(outsiderReplay, { ok: false, error: 'invalid_invite' });

  const expiredUser = await addUser('expired@example.test');
  const expiredInvite = await invite(owner, room.id, 'expired@example.test', 'viewer', 1);
  assert.equal(expiredInvite.ok, true);
  await db.asAdmin(() => db.db.query(
    "update public.mofish_invites set expires_at = now() - interval '1 second' where id = $1",
    [expiredInvite.data.id]
  ));
  assert.deepEqual(await accept(expiredUser, expiredInvite.data.token), { ok: false, error: 'invalid_invite' });

  const revokedUser = await addUser('revoked@example.test');
  const revokedInvite = await invite(owner, room.id, 'revoked@example.test', 'viewer');
  assert.equal(revokedInvite.ok, true);
  const revoked = await jsonRpc(owner,
    'select public.shared_revoke_invite($1::uuid, $2::uuid) as result',
    [room.id, revokedInvite.data.id]
  );
  assert.equal(revoked.ok, true);
  assert.deepEqual(await accept(revokedUser, revokedInvite.data.token), { ok: false, error: 'invalid_invite' });
});

test('owner, editor, viewer, and outsider permissions; revocation blocks reads and writes, reentry needs a new invite', { skip: skipReason }, async () => {
  const owner = await addUser('roles-owner@example.test');
  const editor = await addUser('roles-editor@example.test');
  const viewer = await addUser('roles-viewer@example.test');
  const outsider = await addUser('roles-outsider@example.test');
  const room = await createRoom(owner);

  const editorInvite = await invite(owner, room.id, 'roles-editor@example.test', 'editor');
  const viewerInvite = await invite(owner, room.id, 'roles-viewer@example.test', 'viewer');
  assert.equal((await accept(editor, editorInvite.data.token)).ok, true);
  assert.equal((await accept(viewer, viewerInvite.data.token)).ok, true);
  assert.equal((await getAquarium(owner, room.id)).data.role, 'owner');
  assert.equal((await getAquarium(editor, room.id)).data.role, 'editor');
  assert.equal((await getAquarium(viewer, room.id)).data.role, 'viewer');

  const fishId = room.state.fish[0].id;
  const decor = room.state.decor[0];
  const editorOps = await apply(editor, room.id, uuid(++operationSequence, 'c'), [
    { kind: 'set_night', before: false, value: true }
  ]);
  assert.equal(editorOps.ok, true, 'editor 可以提交共享操作');
  assert.equal((await sharedFeeding(editor, room.id, fishId)).status, 'ok');
  assert.equal((await sharedSettle(editor, room.id)).status, 'ok');
  const editorInviteAttempt = await invite(editor, room.id, 'forbidden@example.test', 'viewer');
  assert.deepEqual(editorInviteAttempt, { ok: false, error: 'forbidden' });
  assert.deepEqual(await manageMember(editor, room.id, viewer, 'editor'), { ok: false, error: 'forbidden' });
  assert.deepEqual(await manageMember(editor, room.id, owner, null), { ok: false, error: 'forbidden' });
  assert.deepEqual(await manageMember(owner, room.id, owner, 'editor'), { ok: false, error: 'forbidden' });

  for (const userId of [viewer, outsider]) {
    const beforeRevision = (await getAquarium(owner, room.id)).data.revision;
    assert.deepEqual(await apply(userId, room.id, uuid(++operationSequence, 'c'), [
      updateDecorOperation(decor, { x: 0.7 })
    ]), { ok: false, error: 'forbidden' });
    assert.equal((await sharedFeeding(userId, room.id, fishId)).status, 'not_found');
    assert.equal((await sharedSettle(userId, room.id)).status, 'not_found');
    assert.deepEqual(await manageMember(userId, room.id, editor, 'viewer'), { ok: false, error: 'forbidden' });
    assert.deepEqual(await invite(userId, room.id, 'forbidden@example.test', 'viewer'), { ok: false, error: 'forbidden' });
    assert.equal((await getAquarium(owner, room.id)).data.revision, beforeRevision);
  }

  const editorFullWrite = await db.asUser(editor, () => db.query(
    'select * from public.save_aquarium($1::uuid, $2::bigint, $3::jsonb, 2)',
    [room.id, room.revision, JSON.stringify(room.state)]
  ));
  assert.notEqual(editorFullWrite[0].status, 'ok', 'editor 不能调用旧 B 整缸写入 RPC');

  const removed = await manageMember(owner, room.id, editor, null);
  assert.equal(removed.ok, true);
  assert.deepEqual(await accept(editor, editorInvite.data.token), { ok: false, error: 'invalid_invite' });
  assert.deepEqual(await getAquarium(editor, room.id), { ok: false, error: 'forbidden' });
  assert.deepEqual(await jsonRpc(editor,
    'select public.shared_probe($1::uuid) as result', [room.id]), { ok: false, error: 'forbidden' });
  const hiddenAquarium = await db.asUser(editor, () => db.query(
    'select id from public.aquariums where id = $1::uuid', [room.id]
  ));
  const hiddenRevision = await db.asUser(editor, () => db.query(
    'select aquarium_id, revision from public.mofish_room_revisions where aquarium_id = $1::uuid', [room.id]
  ));
  assert.deepEqual(hiddenAquarium, []);
  assert.deepEqual(hiddenRevision, []);
  assert.equal((await sharedFeeding(editor, room.id, fishId)).status, 'not_found');
  assert.equal((await sharedSettle(editor, room.id)).status, 'not_found');
  assert.deepEqual(await apply(editor, room.id, uuid(++operationSequence, 'c'), [
    { kind: 'set_night', before: true, value: false }
  ]), { ok: false, error: 'forbidden' });

  const reentryInvite = await invite(owner, room.id, 'roles-editor@example.test', 'viewer');
  assert.equal(reentryInvite.ok, true);
  assert.equal((await accept(editor, reentryInvite.data.token)).ok, true);
  assert.equal((await getAquarium(editor, room.id)).data.role, 'viewer');
});

test('different decor edits merge in either order; same-decor conflict leaves the whole batch unapplied', { skip: skipReason }, async () => {
  const owner = await addUser('decor-owner@example.test');
  const room = await createRoom(owner);
  const [first, second] = room.state.decor;

  const editFirst = updateDecorOperation(first, { x: 0.71 });
  const editSecond = updateDecorOperation(second, { z: 0.82 });
  assert.equal((await apply(owner, room.id, uuid(++operationSequence, 'c'), [editFirst])).ok, true);
  assert.equal((await apply(owner, room.id, uuid(++operationSequence, 'c'), [editSecond])).ok, true);
  let current = (await getAquarium(owner, room.id)).data;
  assert.equal(current.state_json.decor.find((item) => item.id === first.id).x, 0.71);
  assert.equal(current.state_json.decor.find((item) => item.id === second.id).z, 0.82);

  const staleEdit = updateDecorOperation(first, { z: 0.93 });
  const beforeBatch = current;
  const newDecor = {
    id: 'batch-atomicity-check', kind: 'plant', type: 'vallis',
    x: 0.4, z: 0.4, rot: 0.2, scale: 1, seed: 812, v: 1
  };
  const conflict = await apply(owner, room.id, uuid(++operationSequence, 'c'), [
    { kind: 'decor_add', decor: newDecor }, staleEdit
  ]);
  assert.deepEqual(conflict, { ok: false, error: 'conflict' });
  current = (await getAquarium(owner, room.id)).data;
  assert.equal(current.revision, beforeBatch.revision);
  assert.equal(current.state_json.decor.some((item) => item.id === newDecor.id), false, '冲突不能留下批次前半段写入');
  assert.equal(current.state_json.decor.find((item) => item.id === first.id).x, 0.71);
});

test('operation_id retries are idempotent and reject changed payloads or a different actor', { skip: skipReason }, async () => {
  const owner = await addUser('operation-owner@example.test');
  const editor = await addUser('operation-editor@example.test');
  const room = await createRoom(owner);
  const editorInvite = await invite(owner, room.id, 'operation-editor@example.test', 'editor');
  assert.equal((await accept(editor, editorInvite.data.token)).ok, true);

  const decor = room.state.decor[0];
  const payload = [updateDecorOperation(decor, { x: 0.88 })];
  const operationId = uuid(++operationSequence, 'c');
  const first = await apply(owner, room.id, operationId, payload);
  assert.equal(first.ok, true);
  assert.equal(first.duplicate, false);
  const revision = first.data.revision;

  const replay = await apply(owner, room.id, operationId, payload);
  assert.equal(replay.ok, true);
  assert.equal(replay.duplicate, true);
  assert.equal(replay.data.revision, revision);

  const changedPayload = [updateDecorOperation(decor, { x: 0.89 })];
  assert.deepEqual(await apply(owner, room.id, operationId, changedPayload), {
    ok: false, error: 'operation_mismatch'
  });
  assert.deepEqual(await apply(editor, room.id, operationId, payload), {
    ok: false, error: 'operation_mismatch'
  });
});

test('server growth stays authoritative; shared whole-state saves are blocked while personal B saves remain available', { skip: skipReason }, async () => {
  const owner = await addUser('growth-owner@example.test');
  const editor = await addUser('growth-editor@example.test');
  const room = await createRoom(owner);
  const editorInvite = await invite(owner, room.id, 'growth-editor@example.test', 'editor');
  assert.equal((await accept(editor, editorInvite.data.token)).ok, true);

  const fakeFish = { ...room.state.fish[0], id: 'forged-growth-fish', growth: 0.3, meals: 10 };
  const forged = await apply(owner, room.id, uuid(++operationSequence, 'c'), [
    { kind: 'fish_add', fish: fakeFish }
  ]);
  assert.deepEqual(forged, { ok: false, error: 'server_growth_only' });

  await db.backdateAnchor(room.id, "interval '24 hours'");
  const settled = await sharedSettle(owner, room.id, 86400);
  assert.equal(settled.status, 'ok');
  const grown = settled.state_json.fish[0];
  assert.ok(grown.growth > room.state.fish[0].growth, '服务端结算应推进鱼的成长');
  const rename = await apply(owner, room.id, uuid(++operationSequence, 'c'), [
    { kind: 'fish_rename', id: grown.id, before: grown.name, name: '改名但保留成长' }
  ]);
  assert.equal(rename.ok, true);
  assert.equal(rename.data.state_json.fish[0].name, '改名但保留成长');
  assert.equal(rename.data.state_json.fish[0].growth, grown.growth);

  const oldBFeed = await db.asUser(owner, () => db.query(
    'select * from public.record_feeding($1::uuid, $2::uuid, $3::text, 1)',
    [room.id, uuid(++operationSequence, 'c'), grown.id]
  ));
  assert.equal(oldBFeed[0].status, 'ok');
  const oldBSettle = await db.asUser(owner, () => db.query(
    'select * from public.settle_growth($1::uuid)', [room.id]
  ));
  assert.equal(oldBSettle[0].status, 'ok');

  const latest = (await getAquarium(owner, room.id)).data;
  const sharedBSave = await db.asUser(owner, () => db.query(
    'select * from public.save_aquarium($1::uuid, $2::bigint, $3::jsonb, 2)',
    [room.id, latest.revision, JSON.stringify(latest.state_json)]
  ));
  assert.equal(sharedBSave[0].status, 'invalid_argument');
  assert.equal(sharedBSave[0].error_code, 'shared_requires_operations');

  const editorBSave = await db.asUser(editor, () => db.query(
    'select * from public.save_aquarium($1::uuid, $2::bigint, $3::jsonb, 2)',
    [room.id, latest.revision, JSON.stringify(latest.state_json)]
  ));
  assert.notEqual(editorBSave[0].status, 'ok', 'editor 不能通过旧 B 整缸写入 RPC 修改共享鱼缸');

  const personalOwner = await addUser('growth-personal-owner@example.test');
  const personalRoom = await createRoom(personalOwner);
  const personalState = JSON.parse(JSON.stringify(personalRoom.state));
  personalState.fish[0].name = '个人缸B保存';
  const personalBSave = await db.asUser(personalOwner, () => db.query(
    'select * from public.save_aquarium($1::uuid, $2::bigint, $3::jsonb, 2)',
    [personalRoom.id, personalRoom.revision, JSON.stringify(personalState)]
  ));
  assert.equal(personalBSave[0].status, 'ok', '无成员个人缸保留 B 整缸保存接口');
  assert.equal(personalBSave[0].revision, personalRoom.revision + 1);

  const editorOldBFeed = await db.asUser(editor, () => db.query(
    'select * from public.record_feeding($1::uuid, $2::uuid, $3::text, 1)',
    [room.id, uuid(++operationSequence, 'c'), grown.id]
  ));
  assert.equal(editorOldBFeed[0].status, 'not_found', 'editor 仍不能使用 B 阶段 owner-only RPC');
});
