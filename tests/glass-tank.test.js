import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { createGlassTank, GLASS_THICKNESS, SUBSTRATE_DEPTH } from '../web/aquarium/glass.js';
import { TANK, tankFitScale } from '../web/aquarium/scene.js';

test('glass encloses the original interior on five sides and leaves the top open in both qualities', () => {
  for (const quality of ['high', 'low']) {
    const { group, panels } = createGlassTank(TANK, { quality });
    group.updateMatrixWorld(true);
    assert.equal(panels.length, 5);
    for (const panel of panels) {
      let nextIndex = 0;
      for (const face of panel.geometry.groups) {
        assert.equal(face.start, nextIndex, 'merged material groups must not leave invisible faces');
        assert.ok(panel.material[face.materialIndex]);
        nextIndex += face.count;
      }
      assert.equal(nextIndex, panel.geometry.index.count);
      const box = new THREE.Box3().setFromObject(panel);
      const size = box.getSize(new THREE.Vector3());
      assert.ok(Math.abs(Math.min(size.x, size.y, size.z) - GLASS_THICKNESS) < 1e-6);
      // Even the corners of the usable interior are never eaten by a pane.
      for (const x of [-TANK.width / 2 + 0.001, TANK.width / 2 - 0.001]) {
        for (const z of [-TANK.depth / 2 + 0.001, TANK.depth / 2 - 0.001]) {
          assert.equal(box.containsPoint(new THREE.Vector3(x, TANK.height / 2, z)), false);
        }
      }
    }
    const center = new THREE.Vector3(0, TANK.height / 2, 0);
    for (const direction of [new THREE.Vector3(1, 0, 0), new THREE.Vector3(-1, 0, 0),
      new THREE.Vector3(0, 0, 1), new THREE.Vector3(0, 0, -1), new THREE.Vector3(0, -1, 0)]) {
      assert.ok(panels.some(p => new THREE.Ray(center, direction).intersectsBox(new THREE.Box3().setFromObject(p))));
    }
    assert.equal(panels.some(p => new THREE.Ray(center, new THREE.Vector3(0, 1, 0))
      .intersectsBox(new THREE.Box3().setFromObject(p))), false);
    assert.ok(TANK.waterY < TANK.height);
    const bottom = new THREE.Box3().setFromObject(panels.find(p => p.name === 'bottom'));
    assert.ok(Math.abs(bottom.max.y + SUBSTRATE_DEPTH) < 1e-6);
  }
});

test('low quality retains the tank geometry without transmission or reflection texture allocation', () => {
  const high = createGlassTank(TANK, { quality: 'high' });
  const low = createGlassTank(TANK, { quality: 'low' });
  assert.deepEqual(high.panels.map(p => p.geometry.parameters), low.panels.map(p => p.geometry.parameters));
  low.group.traverse(node => {
    for (const mat of Array.isArray(node.material) ? node.material : node.material ? [node.material] : []) {
      assert.equal(mat.envMap ?? null, null);
      assert.equal(mat.transmission ?? 0, 0);
    }
  });
});

test('night transition dims glass reflections without changing tank geometry or material instances', () => {
  const { group, panels, setNight } = createGlassTank(TANK);
  const front = panels.find(p => p.name === 'front');
  const pane = front.material[4];
  const bounds = new THREE.Box3().setFromObject(group).clone();
  const dayIntensity = pane.envMapIntensity;
  setNight(1);
  assert.ok(pane.envMapIntensity < dayIntensity);
  assert.ok(new THREE.Box3().setFromObject(group).equals(bounds));
  setNight(0);
  assert.equal(front.material[4], pane);
  assert.equal(pane.envMapIntensity, dayIntensity);
});

test('the default camera fits every outer glass corner on portrait and desktop screens', () => {
  for (const aspect of [0.6, 0.85, 1.05, 1.8, 2.3]) {
    const camera = new THREE.PerspectiveCamera(42, aspect, 0.1, 80);
    const distance = 5.1 * tankFitScale(aspect);
    camera.position.set(0, 0.98 + Math.sin(0.32) * distance, Math.cos(0.32) * distance + 0.15);
    camera.lookAt(0, 0.98, 0);
    camera.updateMatrixWorld();
    for (const x of [-1, 1]) for (const z of [-1, 1]) for (const y of [-SUBSTRATE_DEPTH - GLASS_THICKNESS, TANK.height]) {
      const corner = new THREE.Vector3(x * (TANK.width / 2 + GLASS_THICKNESS), y,
        z * (TANK.depth / 2 + GLASS_THICKNESS)).project(camera);
      assert.ok(Math.abs(corner.x) < 1 && Math.abs(corner.y) < 1, `glass corner clipped at aspect ${aspect}`);
    }
  }
});
