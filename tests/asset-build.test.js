import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,existsSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';

test('versioned shell excludes Three.js, pairs hashed entry/styles, and validates every published asset',()=>{
 execFileSync(process.execPath,['build.mjs'],{cwd:new URL('..',import.meta.url),stdio:'pipe'});
 const m=JSON.parse(readFileSync('dist/asset-manifest.json','utf8'));
 assert.equal(m.version,'0.2.0');assert.match(m.buildId,/^[a-f\d]{16}$/);assert.match(m.sourceSha,/^[a-f\d]{40}$/);
 const html=readFileSync('dist/index.html','utf8');assert.ok(html.includes(`src="${m.entry}"`));
 assert.ok(m.lazy.length>0);assert.ok(m.lazy.every(x=>!m.shell.includes(x)));
 let initial='';for(const name of m.shell){assert.ok(existsSync('dist/'+name));if(name.endsWith('.js'))initial+=readFileSync('dist/'+name,'utf8');}
 assert.ok(!initial.includes('WebGLRenderer'));assert.ok(m.lazy.some(name=>readFileSync('dist/'+name,'utf8').includes('WebGLRenderer')));
 for(const [name,hash] of Object.entries(m.hashes))assert.equal(createHash('sha256').update(readFileSync('dist/'+name)).digest('hex'),hash,name);
 const sw=readFileSync('dist/sw.js','utf8');assert.ok(sw.includes(m.buildId));assert.ok(!sw.includes('__MOFISH_ASSET_MANIFEST__'));
 assert.ok(!existsSync('dist/cloud/auth.js'));
});
