import test from 'node:test';
import assert from 'node:assert/strict';
import { angleDelta, turnToward, uprightFishPose } from '../web/aquarium/sprite-motion.js';

test('2D fish stay upright and only lean slightly in every travel direction', () => {
  for (let i = 0; i <= 1440; i += 1) {
    const heading = -Math.PI + (i / 1440) * Math.PI * 2;
    const { flipX, tilt } = uprightFishPose(heading);
    const facing = flipX ? -1 : 1;
    const noseX = Math.cos(tilt) * facing;
    const noseY = Math.sin(tilt) * facing;

    assert.ok(Math.abs(tilt) <= 0.2 + 1e-12);
    if (Math.abs(Math.cos(heading)) > 1e-8) assert.equal(Math.sign(noseX), Math.sign(Math.cos(heading)));
    if (Math.abs(Math.sin(heading)) > 1e-8) assert.equal(Math.sign(noseY), Math.sign(Math.sin(heading)));
  }
});

test('fish heading turns take the shortest bounded step across the angle wrap', () => {
  const maxStep = 0.035;
  let heading = 3.12;
  const target = -3.08;
  let previousDelta = angleDelta(heading, target);

  for (let i = 0; i < 20; i += 1) {
    const next = turnToward(heading, target, maxStep);
    assert.ok(next >= -Math.PI && next <= Math.PI);
    assert.ok(Math.abs(angleDelta(heading, next)) <= maxStep + 1e-12);
    const delta = angleDelta(next, target);
    assert.ok(Math.abs(delta) <= Math.abs(previousDelta) + 1e-12);
    heading = next;
    previousDelta = delta;
  }
  assert.ok(Math.abs(angleDelta(heading, target)) < 1e-10);
});

