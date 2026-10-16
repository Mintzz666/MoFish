import test from 'node:test';
import assert from 'node:assert/strict';
import {initial,validate,catchUp,eat,createStorage} from '../web/model.js';
test('offline growth is capped at 24 hours and cannot run twice',()=>{const s=initial(1000);assert.equal(catchUp(s,1000+72*3600000),24);assert.equal(s.fish[0].growth,.192);assert.equal(catchUp(s,1000+72*3600000),0);assert.equal(s.fish[0].growth,.192);});
test('clock moving backwards never shrinks fish',()=>{const s=initial(5000);assert.equal(catchUp(s,1000),0);assert.equal(s.fish[0].growth,0);});
test('feeding caps growth without losing meal history',()=>{const f=initial().fish[0];for(let i=0;i<100;i++)eat(f);assert.equal(f.growth,1);assert.equal(f.meals,100);});
test('storage round trip preserves the tank',()=>{const map=new Map(),store=createStorage({getItem:k=>map.get(k),setItem:(k,v)=>map.set(k,v)});const s=initial();s.fish[0].name='我的小鱼';store.save(s);assert.deepEqual(store.load(),s);});
test('imports reject invalid data before replacing a tank',()=>{assert.throws(()=>validate({version:2,fish:[]}));const s=initial();s.fish[0].species=500;assert.throws(()=>validate(s));s.fish[0].species=0;s.fish[1].id=s.fish[0].id;assert.throws(()=>validate(s));});
test('imports strip foreign fields and bound numeric values',()=>{const s=initial();s.fish[0].growth=40;s.plants=99;s.injected='bad';const parsed=validate(s);assert.equal(parsed.fish[0].growth,1);assert.equal(parsed.plants,8);assert.equal(parsed.injected,undefined);});
