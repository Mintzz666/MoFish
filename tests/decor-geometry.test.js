import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { PLANT_TYPES, ROCK_TYPES, WOOD_TYPES } from '../web/catalog.js';
import { decorAppearance } from '../web/model.js';
import {
  buildPlantGeometry,
  buildRockGeometry,
  buildWoodGeometry,
  createDecorMesh,
  disposeDecor
} from '../web/aquarium/decor.js';

function snapshot(geometry) {
  return {
    positions: Array.from(geometry.getAttribute('position').array),
    colors: Array.from(geometry.getAttribute('color').array),
    sway: geometry.getAttribute('aSway') ? Array.from(geometry.getAttribute('aSway').array) : [],
    indices: Array.from(geometry.index.array)
  };
}

function assertFiniteGeometry(geometry, typeId, { sway = true } = {}) {
  const positions = geometry.getAttribute('position');
  assert.ok(positions?.count > 0, `${typeId} has vertices`);
  for (const name of ['position', 'color']) {
    const attribute = geometry.getAttribute(name);
    assert.ok(attribute, `${typeId} has ${name}`);
    assert.ok(Array.from(attribute.array).every(Number.isFinite), `${typeId} ${name} values are finite`);
  }
  const swayAttribute = geometry.getAttribute('aSway');
  if (sway) assert.ok(swayAttribute, `${typeId} has aSway`);
  if (swayAttribute) assert.ok(Array.from(swayAttribute.array).every(Number.isFinite), `${typeId} aSway values are finite`);
  assert.ok(geometry.index?.count > 0, `${typeId} has indexed faces`);
}

function assertQualityBoundsClose(high, low, label) {
  high.computeBoundingBox();
  low.computeBoundingBox();
  const highSize = high.boundingBox.getSize(new THREE.Vector3());
  const lowSize = low.boundingBox.getSize(new THREE.Vector3());
  for (const axis of ['x', 'y', 'z']) {
    assert.ok(Math.abs(highSize[axis] - lowSize[axis]) <= 0.055, `${label} keeps ${axis} bounds across quality`);
  }
}

test('all six plant types generate finite, deterministic geometry and low quality keeps height with fewer faces', () => {
  for (const type of PLANT_TYPES) {
    for (const seed of [0, 1, 0x5eed1234, 0xffffffff]) {
      const appearance = decorAppearance('plant', type.id, seed);
      const high = buildPlantGeometry(appearance, 'high');
      const highAgain = buildPlantGeometry(appearance, 'high');
      const low = buildPlantGeometry(appearance, 'low');
      try {
        assertFiniteGeometry(high, type.id);
        assertFiniteGeometry(low, type.id);
        assert.deepEqual(snapshot(highAgain), snapshot(high), `${type.id} repeats for seed ${seed}`);
        high.computeBoundingBox();
        low.computeBoundingBox();
        assert.ok(Math.abs(high.boundingBox.min.y - low.boundingBox.min.y) < 1e-6, `${type.id} keeps its base for seed ${seed}`);
        assert.ok(Math.abs(high.boundingBox.max.y - low.boundingBox.max.y) <= 0.05, `${type.id} keeps its height for seed ${seed}`);
        assertQualityBoundsClose(high, low, `${type.id} seed ${seed}`);
        assert.ok(low.index.count < high.index.count, `${type.id} has fewer low-quality faces for seed ${seed}`);
      } finally {
        high.dispose();
        highAgain.dispose();
        low.dispose();
      }
    }
  }
});

test('all decor categories are finite, deterministic, type-distinct and dimension-stable at low quality', () => {
  const categories = [
    { kind: 'plant', types: PLANT_TYPES, build: buildPlantGeometry },
    { kind: 'rock', types: ROCK_TYPES, build: buildRockGeometry },
    { kind: 'wood', types: WOOD_TYPES, build: buildWoodGeometry }
  ];
  for (const category of categories) {
    const silhouettes = category.types.map((type) => {
      const appearance = decorAppearance(category.kind, type.id, 0x5eed1234);
      const high = category.build(appearance, 'high');
      const highAgain = category.build(appearance, 'high');
      const low = category.build(appearance, 'low');
      try {
        assertFiniteGeometry(high, `${category.kind}/${type.id}`, { sway: category.kind === 'plant' });
        assertFiniteGeometry(low, `${category.kind}/${type.id} low`, { sway: category.kind === 'plant' });
        assert.deepEqual(snapshot(highAgain), snapshot(high), `${category.kind}/${type.id} repeats for the same seed`);
        assertQualityBoundsClose(high, low, `${category.kind}/${type.id}`);
        assert.ok(low.index.count < high.index.count, `${category.kind}/${type.id} has fewer low-quality faces`);
        return snapshot(high).positions;
      } finally {
        high.dispose();
        highAgain.dispose();
        low.dispose();
      }
    });
    for (let i = 0; i < silhouettes.length; i += 1) {
      for (let j = i + 1; j < silhouettes.length; j += 1) {
        assert.notDeepEqual(silhouettes[i], silhouettes[j], `${category.kind}/${category.types[i].id} differs from ${category.types[j].id}`);
      }
    }
  }
});

test('disposeDecor releases each owned geometry and material once, including child meshes', () => {
  const group = createDecorMesh(decorAppearance('plant', 'vallis', 2468), { quality: 'low' });
  const blobGeometry = new THREE.PlaneGeometry(0.4, 0.4);
  const blobMaterial = group.userData.material.clone();
  group.add(new THREE.Mesh(blobGeometry, blobMaterial), new THREE.Mesh(blobGeometry, blobMaterial));

  const resources = new Set([
    group.userData.geometry,
    group.userData.material,
    blobGeometry,
    blobMaterial
  ]);
  const calls = new Map([...resources].map((resource) => [resource, 0]));
  for (const resource of resources) {
    const originalDispose = resource.dispose.bind(resource);
    resource.dispose = () => {
      calls.set(resource, calls.get(resource) + 1);
      originalDispose();
    };
  }

  disposeDecor(group);

  for (const [resource, count] of calls) assert.equal(count, 1, `${resource.type} is disposed once`);
  assert.equal(group.children.length, 0);
});
