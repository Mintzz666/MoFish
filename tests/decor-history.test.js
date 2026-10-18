import test from 'node:test';
import assert from 'node:assert/strict';
import { createDecorHistory } from '../web/decor-history.js';
import { initial, cloneState } from '../web/model.js';

test('撤销只恢复造景，保留之后的鱼名、成长、进食和夜间设置', () => {
  const history = createDecorHistory({ getScope: () => 1 });
  const before = initial();
  history.push(before);
  const live = cloneState(before);
  live.decor[0].rot += 0.4;
  live.fish[0].name = '新的名字';
  live.fish[0].growth = 0.8;
  live.fish[0].meals = 42;
  live.night = true;
  const restored = history.restore(live);
  assert.ok(Math.abs(restored.decor[0].rot - before.decor[0].rot) < 1e-9);
  assert.deepEqual(restored.fish, live.fish);
  assert.equal(restored.night, true);
});

test('退出、换号或重新对账后不能撤销上一身份的布局', () => {
  let scope = 1;
  const history = createDecorHistory({ getScope: () => scope });
  history.push(initial());
  scope++;
  assert.equal(history.length, 0);
  assert.equal(history.restore(initial()), null);
});
