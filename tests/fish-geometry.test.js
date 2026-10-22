import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import {FISH_TYPES} from '../web/catalog.js';
import {fishAppearance} from '../web/model.js';
import {meshVoxels,createFishMesh,disposeFish} from '../web/aquarium/fish.js';

test('shared voxel mesher emits each exposed face once, including overwritten cells',()=>{
  const red=new THREE.Color('#ff0000'),blue=new THREE.Color('#0000ff');
  const one=meshVoxels([{x:0,y:0,z:0,color:red},{x:0,y:0,z:0,color:blue}]);
  assert.equal(one.index.count,36);
  assert.equal(one.attributes.color.getX(0),0);
  assert.ok(one.attributes.color.getZ(0)>0.8);
  const pair=meshVoxels([{x:0,y:0,z:0,color:red},{x:1,y:0,z:0,color:red}]);
  assert.equal(pair.index.count,60);
  one.dispose();pair.dispose();
});

test('all fish have finite, centered bodies and attached pectoral fins in both qualities',()=>{
  for(const type of FISH_TYPES)for(const quality of ['high','low'])for(const growth of [0.02,0.22,0.55,0.9]){
    const fish={id:'fixture',species:type.id,growth,look:{seed:981,v:1}};
    const mesh=createFishMesh(type,fishAppearance(fish),growth,quality);
    const body=mesh.children[0].geometry;
    body.computeBoundingBox();
    assert.ok(body.boundingBox.min.y<0&&body.boundingBox.max.y>0,type.id);
    assert.ok(mesh.userData.pectoralL.position.y>body.boundingBox.min.y&&mesh.userData.pectoralL.position.y<body.boundingBox.max.y,type.id);
    for(const geometry of mesh.userData.geometries){
      assert.ok(geometry.index.count>0);
      assert.ok([...geometry.attributes.position.array].every(Number.isFinite));
    }
    disposeFish(mesh);
  }
});

test('fish low quality has fewer rendered triangles while preserving species silhouette',()=>{
  for(const type of FISH_TYPES){
    const fish={id:'fixture',species:type.id,growth:0.9,look:{seed:981,v:1}};
    const high=createFishMesh(type,fishAppearance(fish),0.9,'high');
    const low=createFishMesh(type,fishAppearance(fish),0.9,'low');
    const count=g=>g.userData.geometries.reduce((n,x)=>n+x.index.count,0);
    assert.ok(count(low)<count(high),type.id);
    const a=new THREE.Box3().setFromObject(high),b=new THREE.Box3().setFromObject(low);
    assert.ok(Math.abs(a.max.y-a.min.y-(b.max.y-b.min.y))<0.2,type.id);
    disposeFish(high);disposeFish(low);
  }
});
