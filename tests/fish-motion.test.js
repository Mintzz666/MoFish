import test from 'node:test';
import assert from 'node:assert/strict';
import { angleDelta, clamp, damp, mixHeading, stepHeading, smoothstep } from '../web/aquarium/motion.js';

test('fish heading takes the short turn across the ±PI seam', () => {
  const heading = Math.PI - 0.1;
  const target = -Math.PI + 0.1;
  assert.ok(Math.abs(angleDelta(heading, target) - 0.2) < 1e-9);
  const stepped = stepHeading(heading, target, 1, 0.05);
  assert.ok(stepped > heading && stepped < Math.PI + 0.001);
  assert.ok(Math.abs(stepped - heading) <= 0.05 + 1e-9);
  assert.ok(Math.abs(mixHeading(heading, target, 0.5) - Math.PI) < 1e-9);
});

test('fish motion caps a stalled frame and damps consistently across small steps', () => {
  const capped = stepHeading(0, Math.PI, 1, 10);
  assert.ok(Math.abs(capped) <= 0.05 + 1e-9);

  const oneStep = damp(0, 1, 3, 0.05);
  let manySteps = 0;
  for (let i = 0; i < 5; i += 1) manySteps = damp(manySteps, 1, 3, 0.01);
  assert.ok(Math.abs(oneStep - manySteps) < 1e-9);
  assert.equal(damp(2, 4, 3, 0), 2);
});

test('smoothstep keeps bounded, gradual play and greeting responses', () => {
  assert.equal(smoothstep(-1), 0);
  assert.equal(smoothstep(0), 0);
  assert.equal(smoothstep(1), 1);
  assert.equal(smoothstep(2), 1);
  assert.ok(Math.abs(smoothstep(0.5) - 0.5) < 1e-9);
  assert.equal(clamp(-2, -1, 1), -1);
  assert.equal(clamp(0.4, -1, 1), 0.4);
  assert.equal(clamp(2, -1, 1), 1);
});
