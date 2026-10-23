import test from 'node:test';
import assert from 'node:assert/strict';
import { createRenderPolicy } from '../web/render-policy.js';

test('auto and low pace idle at 30 fps, keep 60 fps for interaction grace, and high stays at 60 fps', () => {
  let now = 0;
  const policy = createRenderPolicy({ now: () => now });
  assert.equal(policy.performanceInfo.policy, 'auto');
  assert.equal(policy.performanceInfo.effectsLevel, 1);
  assert.equal(policy.performanceInfo.targetFps, 30);
  assert.equal(policy.shouldRender(0), true);
  assert.equal(policy.shouldRender(16), false);
  assert.equal(policy.shouldRender(34), true);

  now = 100;
  policy.notifyInteraction();
  assert.equal(policy.performanceInfo.targetFps, 60);
  assert.equal(policy.shouldRender(50), false);
  assert.equal(policy.shouldRender(51), true);
  now = 3100;
  assert.equal(policy.performanceInfo.targetFps, 30);

  policy.setQualityPolicy('low');
  assert.equal(policy.performanceInfo.effectsLevel, 0);
  assert.equal(policy.performanceInfo.targetFps, 30);
  now = 3200;
  policy.setActivity({ interacting: true });
  assert.equal(policy.performanceInfo.targetFps, 60);
  policy.setActivity({ interacting: false });
  now += 3001;
  assert.equal(policy.performanceInfo.targetFps, 30);

  policy.setQualityPolicy('high');
  assert.equal(policy.performanceInfo.effectsLevel, 2);
  assert.equal(policy.performanceInfo.targetFps, 60);
});

test('visibility pauses rendering and resets the next frame timestamp', () => {
  const policy = createRenderPolicy({ now: () => 0 });
  assert.equal(policy.shouldRender(100), true);
  policy.setActivity({ visible: false });
  assert.equal(policy.shouldRender(116), false);
  assert.equal(policy.performanceInfo.active, false);
  policy.setActivity({ visible: true });
  assert.equal(policy.shouldRender(5000), true);
  assert.equal(policy.performanceInfo.active, true);
});

test('auto lowers one effect tier after two overloaded windows and restores after five fast windows plus cooldown', () => {
  const policy = createRenderPolicy({ now: () => 0 });
  policy.shouldRender(0);
  policy.recordWork(30, 3000);
  assert.equal(policy.effectsLevel, 1);
  policy.recordWork(30, 6000);
  assert.equal(policy.effectsLevel, 0);

  for (const ts of [9000, 12000, 15000, 18000]) policy.recordWork(10, ts);
  assert.equal(policy.effectsLevel, 0, 'cooldown prevents rapid recovery');
  policy.recordWork(10, 21000);
  assert.equal(policy.effectsLevel, 1);
  assert.deepEqual(
    Object.keys(policy.performanceInfo).sort(),
    ['active', 'effectsLevel', 'frames', 'lastWorkMs', 'policy', 'presentationLagMs', 'targetFps', 'totalWorkMs'].sort()
  );
});

test('invalid quality policies fall back to auto without exposing controller methods in diagnostics', () => {
  const policy = createRenderPolicy({ now: () => 0 });
  policy.setQualityPolicy('ultra');
  const info = policy.performanceInfo;
  assert.equal(info.policy, 'auto');
  assert.equal(Object.isFrozen(info), true);
  assert.equal('setQualityPolicy' in info, false);
});

test('idle slow-device budget leaves CPU headroom without capping active interaction', () => {
  let now=0;
  const policy=createRenderPolicy({now:()=>now});
  assert.equal(policy.shouldRender(0),true);
  policy.recordWork(100,0);
  assert.equal(policy.shouldRender(100),false,'a saturated slow renderer receives idle breathing room');
  assert.equal(policy.shouldRender(160),true);
  now=170; policy.notifyInteraction();
  assert.equal(policy.shouldRender(180),true,'interaction bypasses the idle work budget');
});

test('asynchronous rasterizer delay participates in adaptive budget without reporting it as JS CPU work',()=>{
 const policy=createRenderPolicy({now:()=>0});
 assert.equal(policy.shouldRender(0),true);policy.recordWork(.5,0);
 assert.equal(policy.shouldRender(100),false);
 assert.ok(policy.performanceInfo.presentationLagMs>80);
 assert.equal(policy.performanceInfo.lastWorkMs,.5);
 assert.equal(policy.shouldRender(150),true);
});
