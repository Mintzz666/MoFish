// Real multi-connection Postgres evidence; never connect to an external database.
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {Client} from 'pg';
import EmbeddedPostgres from 'embedded-postgres';
import {initial,validate} from '../../web/model.js';
import {SUPABASE_EMULATION,USERS,readMigrations} from './harness.mjs';
import {startOwnedEmbeddedPostgres,prepareFreshTestDatabase,rejectExternalPostgresUrl} from './concurrency-safety.mjs';
rejectExternalPostgresUrl(process.env);
let server,admin,a,b,room,state;
async function identity(client,uid){await client.query("select set_config('request.jwt.claims',$1,false)",[JSON.stringify({sub:uid})]);await client.query('set role authenticated');}
async function rpc(client,sql,args=[]){return (await client.query(sql,args)).rows[0].result;}
test.before(async()=>{
 server=await startOwnedEmbeddedPostgres({EmbeddedPostgres});admin=new Client({connectionString:server.url});await admin.connect();
 await prepareFreshTestDatabase(admin,{supabaseEmulation:SUPABASE_EMULATION,migrations:await readMigrations(),users:USERS});
 a=new Client({connectionString:server.url});b=new Client({connectionString:server.url});await Promise.all([a.connect(),b.connect()]);
 await identity(a,USERS.alice);await identity(b,USERS.bob);
 state=validate(initial());room=(await a.query('select * from public.ensure_aquarium($1::jsonb,2)',[JSON.stringify(state)])).rows[0].aquarium_id;
 const invite=await rpc(a,"select public.shared_create_invite($1,'bob@example.com','editor',24) result",[room]);assert.equal(invite.ok,true);
 assert.equal((await rpc(b,'select public.shared_accept_invite($1) result',[invite.data.token])).ok,true);
});
test.after(async()=>{await Promise.allSettled([a?.end(),b?.end(),admin?.end()]);await server?.stop();});
const apply=(client,ops)=>rpc(client,'select public.shared_apply_operations($1,$2,$3::jsonb) result',[room,randomUUID(),JSON.stringify(ops)]);
test('native concurrent edits to different objects both survive; same-object edits cannot overwrite',async()=>{
 const one=state.decor[0],two=state.decor[1];
 const results=await Promise.all([apply(a,[{kind:'decor_update',id:one.id,before:one,decor:{...one,x:one.x+0.01}}]),apply(b,[{kind:'decor_update',id:two.id,before:two,decor:{...two,x:two.x+0.01}}])]);
 assert.ok(results.every(r=>r.ok));
 const fresh=await rpc(a,'select public.shared_get_aquarium($1) result',[room]);
 assert.equal(fresh.data.state_json.decor.find(d=>d.id===one.id).x,one.x+0.01);assert.equal(fresh.data.state_json.decor.find(d=>d.id===two.id).x,two.x+0.01);
 const before=fresh.data.state_json.decor[0];
 const competing=await Promise.all([apply(a,[{kind:'decor_update',id:before.id,before,decor:{...before,x:before.x+0.01}}]),apply(b,[{kind:'decor_update',id:before.id,before,decor:{...before,x:before.x+0.02}}])]);
 assert.equal(competing.filter(r=>r.ok).length,1);assert.equal(competing.filter(r=>r.error==='conflict').length,1);
});
test('native shared feeding duplicate and concurrent settlement credit exactly once',async()=>{
 const operation=randomUUID(),fish=state.fish[0].id;
 const feeds=await Promise.all([a,b].map(c=>c.query('select * from public.shared_record_feeding($1,$2,$3,1)',[room,operation,fish])));
 assert.ok(feeds.every(r=>r.rows[0].status==='ok'));assert.equal(feeds.filter(r=>r.rows[0].duplicate).length,1);
 await Promise.all([a,b].map(c=>c.query('select * from public.shared_settle_growth($1,0)',[room])));
 const got=await rpc(a,'select public.shared_get_aquarium($1) result',[room]);assert.equal(got.data.state_json.fish.find(f=>f.id===fish).meals,1);
});
test('revocation wins before a waiting editor transaction; stale membership cannot authorize a write',async()=>{
 const fishName=(await rpc(a,'select public.shared_get_aquarium($1) result',[room])).data.state_json.fish[0].name;
 await admin.query("select set_config('request.jwt.claims',$1,false)",[JSON.stringify({sub:USERS.alice})]);
 await admin.query('begin');await admin.query('select id from public.aquariums where id=$1 for update',[room]);
 let entered;const queued=new Promise(resolve=>{entered=resolve;});
 const pending=(async()=>{entered();return apply(b,[{kind:'fish_rename',id:state.fish[0].id,before:fishName,name:'must not commit'}]);})();await queued;
 await rpc(admin,'select public.shared_manage_member($1,$2,null) result',[room,USERS.bob]);await admin.query('commit');
 const result=await pending;assert.equal(result.ok,false);assert.equal(result.error,'forbidden');
 const got=await rpc(a,'select public.shared_get_aquarium($1) result',[room]);assert.equal(got.data.state_json.fish[0].name,fishName);
});
