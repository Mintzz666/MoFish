import test from 'node:test';
import assert from 'node:assert/strict';
import { createLocalStore, keys } from '../web/storage.js';
import { initial, initial as _initial, validate } from '../web/model.js';
import { createMemoryStorage } from './helpers/memory-storage.mjs';

const AQUARIUM_A = 'aaaaaaaa-0000-4000-8000-000000000001';
const AQUARIUM_B = 'bbbbbbbb-0000-4000-8000-000000000002';
const ALICE = 'user-alice';
const BOB = 'user-bob';

function tankWith(name) {
  const state = validate(initial(1700000000000));
  state.fish[0].name = name;
  return state;
}

test('游客存档沿用 mofish.v1，读写往返一致', () => {
  const raw = createMemoryStorage();
  const store = createLocalStore(raw);
  assert.equal(store.readGuest(), null);
  assert.equal(store.hasGuest(), false);

  const state = tankWith('老鱼缸');
  store.writeGuest(state);
  assert.equal(store.hasGuest(), true);
  assert.deepEqual(raw.rawKeys(), ['mofish.v1'], '游客存档的键名不变，老用户直接复用');

  const loaded = store.readGuest();
  assert.equal(loaded.fish[0].name, '老鱼缸');
  assert.ok(Number.isFinite(loaded.savedAt));
});

test('坏掉的本地存档返回 null，不把脏数据交给渲染层', () => {
  const store = createLocalStore(createMemoryStorage({ 'mofish.v1': '{ not json' }));
  assert.equal(store.readGuest(), null);

  const wrongShape = createLocalStore(createMemoryStorage({ 'mofish.v1': JSON.stringify({ version: 9, fish: [] }) }));
  assert.equal(wrongShape.readGuest(), null);

  const missingFields = createLocalStore(createMemoryStorage({ 'mofish.v1': JSON.stringify({ version: 1, fish: [{ id: 'x' }] }) }));
  assert.equal(missingFields.readGuest(), null);
});

test('账号缓存按 userId + aquariumId 隔离，互相读不到', () => {
  const raw = createMemoryStorage();
  const store = createLocalStore(raw);

  store.writeAccountState(ALICE, AQUARIUM_A, tankWith('alice 的缸'));
  store.writeAccountState(BOB, AQUARIUM_B, tankWith('bob 的缸'));

  assert.equal(store.readAccountState(ALICE, AQUARIUM_A).fish[0].name, 'alice 的缸');
  assert.equal(store.readAccountState(BOB, AQUARIUM_B).fish[0].name, 'bob 的缸');
  assert.equal(store.readAccountState(ALICE, AQUARIUM_B), null, '换鱼缸 id 读不到别人的缓存');
  assert.equal(store.readAccountState(BOB, AQUARIUM_A), null);

  assert.deepEqual(raw.rawKeys(), [
    keys.accountState(ALICE, AQUARIUM_A),
    keys.accountState(BOB, AQUARIUM_B)
  ].sort());
});

test('未同步副本与元数据也按账号隔离', () => {
  const raw = createMemoryStorage();
  const store = createLocalStore(raw);

  store.writePending(ALICE, AQUARIUM_A, tankWith('待同步'));
  store.writeMeta(ALICE, AQUARIUM_A, { revision: 7, lastGrowthAt: 123 });
  store.writePending(BOB, AQUARIUM_B, tankWith('bob 待同步'));

  assert.equal(store.readPending(ALICE, AQUARIUM_A).fish[0].name, '待同步');
  assert.equal(store.readPending(BOB, AQUARIUM_B).fish[0].name, 'bob 待同步');
  assert.equal(store.readPending(ALICE, AQUARIUM_B), null);
  assert.deepEqual(store.readMeta(ALICE, AQUARIUM_A), { revision: 7, lastGrowthAt: 123 });

  store.clearPending(ALICE, AQUARIUM_A);
  assert.equal(store.readPending(ALICE, AQUARIUM_A), null);
  assert.equal(store.readPending(BOB, AQUARIUM_B).fish[0].name, 'bob 待同步', '清一个账号不影响另一个');
});

test('当前鱼缸指针：离线时用来找回本地缓存', () => {
  const store = createLocalStore(createMemoryStorage());
  assert.equal(store.readCurrent(ALICE), null);
  store.writeCurrent(ALICE, { aquariumId: AQUARIUM_A, revision: 3, lastGrowthAt: '2026-01-01T00:00:00.000Z' });
  assert.equal(store.readCurrent(ALICE).aquariumId, AQUARIUM_A);
  assert.equal(store.readCurrent(ALICE).revision, 3);
  assert.equal(store.readCurrent(BOB), null, '别的账号没有指针');
  store.clearCurrent(ALICE);
  assert.equal(store.readCurrent(ALICE), null);
});

test('会话存取只保存 Supabase 返回的会话，不碰密码', () => {
  const raw = createMemoryStorage();
  const store = createLocalStore(raw);
  store.writeSession({ access_token: 'a.b.c', refresh_token: 'r', expires_at: 1, user: { id: ALICE, email: 'a@x.com' } });
  assert.equal(store.readSession().user.id, ALICE);
  const serialized = JSON.stringify(raw.snapshot());
  assert.ok(!/password/i.test(serialized), '本地不保存任何密码字段');
  store.clearSession();
  assert.equal(store.readSession(), null);
});

test('forgetUser 只清除该账号派生键，游客存档与其它账号不受影响', () => {
  const raw = createMemoryStorage();
  const store = createLocalStore(raw);

  store.writeGuest(tankWith('游客缸'));
  store.writeAccountState(ALICE, AQUARIUM_A, tankWith('alice'));
  store.writePending(ALICE, AQUARIUM_A, tankWith('alice pending'));
  store.writeMeta(ALICE, AQUARIUM_A, { revision: 1 });
  store.writeCurrent(ALICE, { aquariumId: AQUARIUM_A, revision: 1 });
  store.writeAccountState(BOB, AQUARIUM_B, tankWith('bob'));

  const before = raw.rawKeys();
  assert.ok(before.some(k => k.includes(ALICE)));
  assert.deepEqual(store.listKeysForUser(ALICE), before.filter(k => k.includes(ALICE)));

  const removed = store.forgetUser(ALICE);
  assert.equal(removed, before.filter(k => k.includes(ALICE)).length);

  assert.equal(store.hasGuest(), true, '游客存档必须保留');
  assert.equal(store.readAccountState(BOB, AQUARIUM_B).fish[0].name, 'bob');
  assert.equal(store.readAccountState(ALICE, AQUARIUM_A), null);
  assert.equal(store.readPending(ALICE, AQUARIUM_A), null);
  assert.equal(store.readMeta(ALICE, AQUARIUM_A), null);
  assert.equal(store.readCurrent(ALICE), null);
});

test('storage 抛异常（隐私模式配额）时返回 false 而不是崩掉', () => {
  const hostile = {
    getItem() { throw new Error('blocked'); },
    setItem() { throw new Error('quota'); },
    removeItem() { throw new Error('blocked'); },
    key() { throw new Error('blocked'); },
    length: 0
  };
  const store = createLocalStore(hostile);
  assert.equal(store.readGuest(), null);
  assert.equal(store.writeGuest(tankWith('x')), false);
  assert.equal(store.hasGuest(), false);
  assert.deepEqual(store.listKeysForUser(ALICE), []);
  assert.equal(store.forgetUser(ALICE), 0);
});
