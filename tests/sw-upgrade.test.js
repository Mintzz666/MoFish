import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {webcrypto} from 'node:crypto';
const origin='https://qa.example/';
const url=x=>new URL(x,origin).href;
const build={buildId:'new',version:'0.2.0',entry:'assets/app-new.js',shell:['index.html','config.js','assets/app-new.js'],lazy:['assets/three-new.js']};
async function harness({fail='',clients=[],hashes}={}) {
  const stores=new Map(), handlers=new Map(), requests=[];let skipped=0;
  const cacheFor=key=>{
    if(!stores.has(key))stores.set(key,new Map());
    const items=stores.get(key);
    return {async match(request){return items.get(typeof request==='string'?request:request.url)?.clone();},async put(request,response){items.set(typeof request==='string'?request:request.url,response.clone());},async addAll(list){for(const request of list){const href=typeof request==='string'?url(request):request.url;requests.push(href);if(href===url(fail))throw Error('network');items.set(href,new Response(href.endsWith('index.html')?'new html':'asset'));}}};
  };
  const caches={open:async key=>cacheFor(key),keys:async()=>[...stores.keys()],delete:async key=>stores.delete(key),match:async request=>{for(const key of stores.keys()){const hit=await cacheFor(key).match(request);if(hit)return hit;}}};
  const self={registration:{scope:origin},location:{origin:new URL(origin).origin},clients:{claim:async()=>{},matchAll:async()=>clients},skipWaiting:async()=>{skipped++;},addEventListener:(name,fn)=>handlers.set(name,fn)};
  const context={self,caches,URL,Request,Response,Map,Set,Uint8Array,crypto:webcrypto,fetch:async request=>{const href=typeof request==='string'?request:request.url;requests.push(href);if(fail && href===url(fail))throw Error('network');return new Response(href.endsWith('index.html')?'new html':'asset');}};
  vm.runInNewContext(readFileSync(new URL('../web/sw.js',import.meta.url),'utf8').replace('__MOFISH_ASSET_MANIFEST__',JSON.stringify({...build,...(hashes?{hashes}:{})})),context);
  async function emit(type,fields={}){const promises=[];let response;handlers.get(type)({...fields,waitUntil:p=>promises.push(p),respondWith:p=>{response=p;}});await Promise.all(promises);return response&&await response;}
  return {emit,caches,stores,requests,get skipped(){return skipped;}};
}

test('failed install removes incomplete new cache and preserves working old assets',async()=>{
 const h=await harness({fail:'assets/app-new.js'});const old=await h.caches.open('mofish-static-old');await old.put(url('index.html'),new Response('old html'));
 await assert.rejects(h.emit('install'));assert.deepEqual(await h.caches.keys(),['mofish-static-old']);assert.equal(await (await old.match(url('index.html'))).text(),'old html');
});
test('2D shell installation does not download 3D; explicit first use caches it',async()=>{
 const h=await harness();await h.emit('install');assert.ok(!h.requests.includes(url(build.lazy[0])));assert.equal(h.skipped,0);
 await h.emit('message',{data:{type:'MOFISH_CACHE_3D'},source:{postMessage(){}}});assert.ok(h.requests.includes(url(build.lazy[0])));
 await h.emit('message',{data:{type:'MOFISH_USE_UPDATE'}});assert.equal(h.skipped,1);
});
test('navigation stays paired to its installed build; old hashed chunks survive for an old tab',async()=>{
 const h=await harness();await h.emit('install');const old=await h.caches.open('mofish-static-old');await old.put(url('assets/old.js'),new Response('old chunk'));
 const nav=await h.emit('fetch',{request:{method:'GET',url:origin,mode:'navigate',headers:new Headers()}});assert.equal(await nav.text(),'new html');
 const asset=await h.emit('fetch',{request:new Request(url('assets/old.js'))});assert.equal(await asset.text(),'old chunk');
});
test('unknown and active old clients protect their caches; unused build is pruned after reporting',async()=>{
 const clients=[{id:'old',postMessage(){}}];const h=await harness({clients});await h.emit('install');const old=await h.caches.open('mofish-static-old');await old.put(url('__cached-build.json'),new Response(JSON.stringify({entry:'assets/app-old.js'})));
 await h.emit('activate');assert.ok((await h.caches.keys()).includes('mofish-static-old'));
 await h.emit('message',{data:{type:'MOFISH_BUILD_STATUS',entry:url('assets/app-old.js')},source:{id:'old'}});assert.ok((await h.caches.keys()).includes('mofish-static-old'));
 await h.emit('message',{data:{type:'MOFISH_BUILD_STATUS',entry:url(build.entry)},source:{id:'old'}});assert.ok(!(await h.caches.keys()).includes('mofish-static-old'));
});
test('cross-origin, credential-bearing and API requests bypass all cache handling',async()=>{
 const h=await harness();await h.emit('install');const before=h.requests.length;
 for(const request of [new Request('https://private.supabase.co/rest/v1/aquariums'),new Request(url('assets/private.js'),{headers:{authorization:'Bearer private'}}),new Request(url('rest/v1/aquariums')),new Request(url('assets/app-new.js'),{method:'POST'})])assert.equal(await h.emit('fetch',{request}),undefined);
 assert.equal(h.requests.length,before);
});

test('a successful HTTP response from another build is rejected by its expected digest',async()=>{
 const h=await harness({hashes:{'index.html':'0'.repeat(64)}});
 const old=await h.caches.open('mofish-static-old');await old.put(url('index.html'),new Response('old html'));
 await assert.rejects(h.emit('install'),/Mixed build rejected/);
 assert.deepEqual(await h.caches.keys(),['mofish-static-old']);
});

test('a corrupt lazy download is rejected and never poisons the offline cache',async()=>{
 const h=await harness({hashes:{'assets/three-new.js':'0'.repeat(64)}});
 await h.emit('install');
 await assert.rejects(h.emit('fetch',{request:new Request(url(build.lazy[0]))}),/Mixed build rejected/);
 assert.equal(await (await h.caches.open('mofish-static-new')).match(url(build.lazy[0])),undefined);
});

test('a fresh module retry URL reuses one verified canonical offline asset',async()=>{
 const h=await harness();await h.emit('install');
 await h.emit('message',{data:{type:'MOFISH_CACHE_3D'},source:{postMessage(){}}});
 const before=h.requests.length;
 const response=await h.emit('fetch',{request:new Request(url(build.lazy[0])+'?retry=1')});
 assert.equal(await response.text(),'asset');assert.equal(h.requests.length,before);
});
