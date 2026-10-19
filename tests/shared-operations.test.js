import test from 'node:test';
import assert from 'node:assert/strict';
import { applySharedOperations, diffSharedState } from '../web/cloud/shared-operations.js';

const clone = (value) => JSON.parse(JSON.stringify(value));

function fish(id, overrides = {}) {
  return {
    id,
    name: `鱼-${id}`,
    species: 'neon_tetra',
    born: 100,
    growth: 0.1,
    meals: 2,
    look: { v: 1, seed: 321 },
    ...overrides
  };
}

function decor(id, overrides = {}) {
  return {
    id,
    kind: 'plant',
    type: 'vallis',
    x: 0.2,
    z: 0.3,
    rot: 0.4,
    scale: 1,
    seed: 42,
    v: 1,
    ...overrides
  };
}

function state({ fish: fishes = [fish('f1')], decor: decors = [decor('d1'), decor('d2')], night = false } = {}) {
  return {
    version: 2,
    fish: clone(fishes),
    decor: clone(decors),
    layout: { v: 1, seed: 9 },
    night,
    sound: false,
    savedAt: 1000
  };
}

test('diff orders operations and ignores sound, savedAt, and server-owned fish growth', () => {
  const before = state({ fish: [fish('gone'), fish('rename')], decor: [decor('d1'), decor('d2')] });
  const after = clone(before);
  after.fish = [
    fish('rename', { name: '新名字', growth: 0.95, meals: 80 }),
    fish('new', { growth: 0, meals: 0 })
  ];
  after.decor = [decor('d2', { x: 0.6 }), decor('d3')];
  after.night = true;
  after.sound = true;
  after.savedAt = 9999;

  const operations = diffSharedState(before, after);
  assert.deepEqual(operations.map((operation) => operation.kind), [
    'fish_remove', 'fish_rename', 'fish_add',
    'decor_remove', 'decor_update', 'decor_add', 'set_night'
  ]);
  assert.deepEqual(operations[0].before, {
    id: 'gone', name: '鱼-gone', species: 'neon_tetra', born: 100, look: { v: 1, seed: 321 }
  });
  assert.equal(operations[1].before, '鱼-rename');
  assert.equal(operations[1].name, '新名字');
  assert.equal(operations[2].fish.growth, 0);
  assert.equal(operations[2].fish.meals, 0);
});

test('independent decor updates merge while concurrent edits to the same decor conflict', () => {
  const base = state();
  const branchA = clone(base);
  const branchB = clone(base);
  branchA.decor[0].x = 0.7;
  branchB.decor[1].z = 0.8;

  const changeA = diffSharedState(base, branchA);
  const changeB = diffSharedState(base, branchB);
  const afterA = applySharedOperations(base, changeA);
  const merged = applySharedOperations(afterA.state, changeB);
  assert.equal(merged.ok, true);
  assert.equal(merged.state.decor.find((item) => item.id === 'd1').x, 0.7);
  assert.equal(merged.state.decor.find((item) => item.id === 'd2').z, 0.8);

  const competing = clone(base);
  competing.decor[0].z = 0.9;
  const conflict = applySharedOperations(afterA.state, diffSharedState(base, competing));
  assert.deepEqual(conflict, { ok: false, conflict: true, state: afterA.state });
});

test('fish rename and removal tolerate server-owned growth and meals changes', () => {
  const base = state({ fish: [fish('f1'), fish('f2')] });
  const renamed = clone(base);
  renamed.fish[0].name = '小蓝';
  renamed.fish[0].growth = 0.9;
  renamed.fish[0].meals = 900;
  const renameOp = diffSharedState(base, renamed);
  assert.deepEqual(renameOp.map((operation) => operation.kind), ['fish_rename']);

  const serverState = clone(base);
  serverState.fish[0].growth = 0.43;
  serverState.fish[0].meals = 23;
  const afterRename = applySharedOperations(serverState, renameOp);
  assert.equal(afterRename.ok, true);
  assert.equal(afterRename.state.fish[0].name, '小蓝');
  assert.equal(afterRename.state.fish[0].growth, 0.43);
  assert.equal(afterRename.state.fish[0].meals, 23);

  const removed = clone(base);
  removed.fish.splice(0, 1);
  const removeOp = diffSharedState(base, removed);
  assert.equal('growth' in removeOp[0].before, false);
  assert.equal('meals' in removeOp[0].before, false);
  const afterRemove = applySharedOperations(serverState, removeOp);
  assert.equal(afterRemove.ok, true);
  assert.deepEqual(afterRemove.state.fish.map((item) => item.id), ['f2']);
});

test('replaying an identical fish or decor addition does not duplicate it', () => {
  const current = state({ fish: [fish('f1', { growth: 0.7, meals: 17 })], decor: [decor('d1')] });
  const fishAdd = { kind: 'fish_add', fish: fish('f1', { growth: 0, meals: 0 }) };
  const decorAdd = { kind: 'decor_add', decor: decor('d1') };
  const result = applySharedOperations(current, [fishAdd, decorAdd]);
  assert.equal(result.ok, true);
  assert.equal(result.state.fish.length, 1);
  assert.equal(result.state.decor.length, 1);
  assert.equal(result.state.fish[0].growth, 0.7);
});

test('addition ID collision with different content conflicts without changing input', () => {
  const current = state({ fish: [fish('f1')], decor: [decor('d1')] });
  const snapshot = clone(current);
  const conflict = applySharedOperations(current, [
    { kind: 'decor_add', decor: decor('d1', { x: 0.9 }) }
  ]);
  assert.equal(conflict.ok, false);
  assert.deepEqual(conflict.state, snapshot);
  assert.deepEqual(current, snapshot);
});

test('existing fish edits other than name are rejected, while new fish growth must be zero', () => {
  const before = state();
  const changedSpecies = clone(before);
  changedSpecies.fish[0].species = 'goldfish';
  assert.throws(() => diffSharedState(before, changedSpecies), /除名字外/);

  const addedWithGrowth = clone(before);
  addedWithGrowth.fish.push(fish('f2', { growth: 0.01 }));
  assert.throws(() => diffSharedState(before, addedWithGrowth), /必须为0/);
  assert.throws(() => applySharedOperations(before, [
    { kind: 'fish_add', fish: fish('f2', { meals: 1 }) }
  ]), /必须为0/);
});

test('an operation conflict is atomic and neither successful nor failed application mutates input', () => {
  const base = state();
  const changed = clone(base);
  changed.decor[0].x = 0.8;
  changed.night = true;
  const operations = diffSharedState(base, changed);
  const inputSnapshot = clone(base);
  operations.at(-1).before = true;

  const result = applySharedOperations(base, operations);
  assert.deepEqual(result, { ok: false, conflict: true, state: inputSnapshot });
  assert.deepEqual(base, inputSnapshot);

  const success = applySharedOperations(base, diffSharedState(base, changed));
  assert.equal(success.ok, true);
  assert.equal(success.state.decor[0].x, 0.8);
  assert.deepEqual(base, inputSnapshot);
});

test('stable comparison ignores nested object key order and diff ignores local-only fields', () => {
  const before = state();
  const after = clone(before);
  after.decor[0].params = { width: 1, depth: 2 };
  before.decor[0].params = { depth: 2, width: 1 };
  after.sound = true;
  after.savedAt = 12345;
  assert.deepEqual(diffSharedState(before, after), []);
});

test('invalid arrays, records, and duplicate IDs are rejected', () => {
  const invalidFish = state();
  invalidFish.fish = {};
  assert.throws(() => diffSharedState(invalidFish, state()), /必须是数组/);

  const duplicate = state({ fish: [fish('same'), fish('same')] });
  assert.throws(() => diffSharedState(duplicate, state()), /ID重复/);

  const invalidId = state({ decor: [decor('   ')] });
  assert.throws(() => diffSharedState(invalidId, state()), /ID无效/);
});

test('relaxed application projects onto matching objects and preserves unrelated ones', () => {
  const base = state();
  const ops = [{ kind: 'decor_update', id: 'd1', before: decor('d1'), decor: decor('d1', { x: 0.9 }) }];
  const server = clone(base);
  server.decor[0].x = 0.6;
  server.decor.push(decor('d3'));
  const result = applySharedOperations(server, ops, { strict: false });
  assert.equal(result.ok, true);
  assert.equal(result.state.decor.find((item) => item.id === 'd1').x, 0.9);
  assert.ok(result.state.decor.some((item) => item.id === 'd3'));
});
