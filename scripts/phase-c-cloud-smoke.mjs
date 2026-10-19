// Real QA project only. Random, registered identities; no emails or existing-user access.
import {randomUUID,randomBytes} from 'node:crypto';
import {writeFile,mkdir} from 'node:fs/promises';
import {createAuthClient} from '../web/cloud/auth.js';
import {createSharingApi} from '../web/cloud/sharing-api.js';
import {createSharedSyncEngine} from '../web/cloud/shared-sync.js';
import {createLocalStore} from '../web/storage.js';
import {initial,validate,cloneState} from '../web/model.js';
import {checkPhaseCTarget,phaseCEnvironment} from './phase-c-config.mjs';
import {runCloudSmoke} from './cloud-smoke.mjs';
try{process.loadEnvFile(new URL('../.env.phase-c',import.meta.url));}catch(e){if(e.code!=='ENOENT')throw e;}
const env=phaseCEnvironment(process.env);checkPhaseCTarget(env.MOFISH_SUPABASE_URL,env.MOFISH_SMOKE_EXPECTED_PROJECT_REF);
if(process.argv.slice(2).some(arg=>arg!=='--only-c'))throw Error('仅支持 --only-c（定向复查，不重复 B 回归）');
const key=env.MOFISH_SMOKE_SERVICE_ROLE_KEY,url=env.MOFISH_SUPABASE_URL,anonKey=env.MOFISH_SUPABASE_ANON_KEY;
if(!key||key.startsWith('sb_secret_')||!anonKey)throw Error('需要本机独立 C 配置及 Legacy service_role；不要把秘密发到聊天。');
const logDir=new URL('../.local/phase-c-20261019/',import.meta.url);await mkdir(logDir,{recursive:true});
const owned=[],clients=[],engines=[],checks=[];let runFailed=false;
function check(name,ok){checks.push({name,ok:Boolean(ok)});console.log(`${ok?'PASS':'FAIL'}: ${name}`);if(!ok)throw Error('检查失败：'+name);}
function memory(){const map=new Map();return {getItem:k=>map.get(k)||null,setItem:(k,v)=>map.set(k,String(v)),removeItem:k=>map.delete(k),key:i=>[...map.keys()][i],get length(){return map.size;}};}
async function admin(path,method='GET',body){
 for(let attempt=0;attempt<3;attempt++)try{
  const r=await fetch(url+'/auth/v1/admin/'+path,{method,headers:{apikey:key,Authorization:'Bearer '+key,'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(20000)});
  let payload;try{payload=await r.json();}catch{payload=null;}return {status:r.status,body:payload};
 }catch(error){if(method!=='GET'||attempt===2)throw error;}
}
const missing=r=>r.status===404&&(r.body?.code==='user_not_found'||r.body?.error_code==='user_not_found'||/^user not found$/i.test(r.body?.msg||r.body?.message||''));
async function user(label){
 const email=`mofish-c-${randomUUID()}-${label}@example.com`,password=randomBytes(30).toString('base64url');
 const result=await admin('users','POST',{email,password,email_confirm:true});
 if(result.status!==200||!result.body?.id)throw Error('临时账号创建失败；没有复用已有账号');
 const entry={id:result.body.id,email};owned.push(entry);await writeFile(new URL('smoke-owned.json',logDir),JSON.stringify(owned),{mode:0o600});
 const store=createLocalStore(memory());const auth=createAuthClient({url,anonKey,store});const login=await auth.signIn({email,password});if(!login.ok)throw Error('临时身份登录失败');
 let offline=false;const api=createSharingApi({url,anonKey,auth,fetchImpl:(...args)=>{if(offline)throw Error('simulated offline');return fetch(...args);}});
 const client={...entry,auth,api,store,setOffline:v=>{offline=v;}};clients.push(client);return client;
}
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function waitUntil(predicate,label,timeout=12000){const start=Date.now();while(!predicate()){if(Date.now()-start>timeout)throw Error('等待超时：'+label);await delay(80);}}
try{
 check('只读 GoTrue 管理预检',missing(await admin('users/'+randomUUID())));
 if(!process.argv.includes('--only-c')){
  const b=await runCloudSmoke({phase:'b',env:{...process.env,MOFISH_B_PROJECT_REF:env.MOFISH_SMOKE_EXPECTED_PROJECT_REF,MOFISH_B_SUPABASE_URL:url,MOFISH_B_SUPABASE_ANON_KEY:anonKey,MOFISH_B_SMOKE_SERVICE_ROLE_KEY:key}});
  check('C 迁移后的真实 B 回归 64/64',b.ok&&b.results.length===64);
 }else console.log('定向 C 复查：B 回归本次未重复执行。');
 const owner=await user('owner'),editor=await user('editor'),viewer=await user('viewer'),outsider=await user('outsider');
 check('四个随机临时身份通过真实 Auth 登录',clients.length===4);
 const personal=await owner.api.preparePersonal(validate(initial()));check('个人鱼缸准备与旧档兼容入口',personal.ok);const id=personal.data.aquarium_id;
 let current=(await owner.api.get(id)).data.state_json;
 const editorInvite=await owner.api.createInvite({aquariumId:id,email:editor.email,role:'editor',expiresHours:24});check('创建定向编辑邀请',editorInvite.ok);
 check('其他邮箱不能认领定向邀请',!(await outsider.api.acceptInvite(editorInvite.data.token)).ok);
 check('被邀请邮箱接受并可重复确认', (await editor.api.acceptInvite(editorInvite.data.token)).ok&&(await editor.api.acceptInvite(editorInvite.data.token)).ok);
 const viewerInvite=await owner.api.createInvite({aquariumId:id,email:viewer.email,role:'viewer',expiresHours:1});check('仅观看邀请与接受',(await viewer.api.acceptInvite(viewerInvite.data.token)).ok);
 check('可访问列表只包含自己的/加入的鱼缸',(await editor.api.listAquariums()).data.some(r=>r.id===id)&&(await outsider.api.listAquariums()).data.length===0);
 check('editor 不能发邀请或提升角色',!(await editor.api.createInvite({aquariumId:id,email:outsider.email,role:'editor',expiresHours:1})).ok&&!(await editor.api.setMemberRole({aquariumId:id,userId:editor.id,role:'owner'})).ok);
 check('viewer 可以读但不能编辑/喂食/结算',(await viewer.api.get(id)).ok&&!(await viewer.api.apply(id,randomUUID(),[{kind:'set_night',before:false,value:true}])).ok&&!(await viewer.api.feed(id,randomUUID(),current.fish[0].id)).ok&&!(await viewer.api.settle(id)).ok);
 check('未加入账号不能读取或操作已知鱼缸ID',!(await outsider.api.get(id)).ok&&!(await outsider.api.apply(id,randomUUID(),[{kind:'set_night',before:false,value:true}])).ok);
 let rtStatus='',notifications=0,viewerNotifications=0;
 await editor.api.subscribe(id,()=>{notifications++;},s=>{rtStatus=s;});await waitUntil(()=>rtStatus==='READY','真实 Realtime 后端就绪',20000);
 let viewerRt='';await viewer.api.subscribe(id,()=>{viewerNotifications++;},s=>{viewerRt=s;});await waitUntil(()=>viewerRt==='READY','真实 viewer Realtime 后端就绪',20000);
 check('editor/viewer WebSocket 与后端复制均就绪',rtStatus==='READY'&&viewerRt==='READY');
 const one=current.decor[0],two=current.decor[1];
 const op1={kind:'decor_update',id:one.id,before:one,decor:{...one,x:one.x+0.01}},op2={kind:'decor_update',id:two.id,before:two,decor:{...two,x:two.x+0.01}};
 const changed=await Promise.all([owner.api.apply(id,randomUUID(),[op1]),editor.api.apply(id,randomUUID(),[op2])]);check('真实双身份并发编辑不同造景均成功',changed.every(r=>r.ok));
 await waitUntil(()=>notifications>0&&viewerNotifications>0,'已提交修订通知');check('真实 Realtime 收到已提交版本通知',notifications>0&&viewerNotifications>0);
 current=(await owner.api.get(id)).data.state_json;check('两份造景改动均保留',current.decor.find(d=>d.id===one.id).x===op1.decor.x&&current.decor.find(d=>d.id===two.id).x===op2.decor.x);
 const same=current.decor[0],operation=randomUUID(),payload=[{kind:'decor_update',id:same.id,before:same,decor:{...same,scale:Math.min(1.6,same.scale+0.01)}}];
 const first=await owner.api.apply(id,operation,payload),duplicate=await owner.api.apply(id,operation,payload);
 check('操作去重及重复响应',first.ok&&duplicate.ok&&duplicate.duplicate===true);
 check('异载荷或异身份不能复用操作ID',!(await owner.api.apply(id,operation,[{kind:'set_night',before:false,value:true}])).ok&&!(await editor.api.apply(id,operation,payload)).ok);
 check('同一造景旧基线冲突且不覆盖',!(await editor.api.apply(id,randomUUID(),[{kind:'decor_update',id:same.id,before:same,decor:{...same,z:Math.min(0.95,same.z+0.02)}}])).ok);
 const fakeFish={...cloneState(current.fish[0]),id:'forged-'+randomUUID(),growth:1,meals:50};check('服务端拒绝伪造成长新增鱼',!(await editor.api.apply(id,randomUUID(),[{kind:'fish_add',fish:fakeFish}])).ok);
 const feedId=randomUUID(),fishId=current.fish[0].id;const fed=await Promise.all([owner.api.feed(id,feedId,fishId),editor.api.feed(id,feedId,fishId)]);
 check('成员并发进食同ID只记一口',fed.every(r=>r.ok)&&fed.filter(r=>r.data.duplicate).length===1);
 await Promise.all([owner.api.settle(id),editor.api.settle(id)]);check('成员并发结算不重复奖励',(await owner.api.get(id)).data.state_json.fish[0].meals===1);
 // Exercise the production shared outbox through real RPCs, with a simulated transport outage.
 await editor.api.stopRealtime();let live=validate((await editor.api.get(id)).data.state_json);let revoked=false;
 let engine=createSharedSyncEngine({api:editor.api,store:editor.store,getState:()=>live,setState:s=>{live=s;},isOnline:()=>true,pollMs:300,onRevoked:()=>{revoked=true;}});engines.push(engine);
 const authSession=(await editor.auth.getSession()).session;await engine.start(authSession,id);
 editor.setOffline(true);live.decor[0].z=Math.min(0.95,live.decor[0].z+0.015);engine.markDirty();const keptZ=live.decor[0].z;await engine.stop();
 engine=createSharedSyncEngine({api:editor.api,store:editor.store,getState:()=>live,setState:s=>{live=s;},isOnline:()=>true,pollMs:300,onRevoked:()=>{revoked=true;}});engines.push(engine);
 await engine.start(authSession,id);editor.setOffline(false);check('生产共享引擎模拟离线重启后重放',(await engine.syncNow()).ok&&(await owner.api.get(id)).data.state_json.decor[0].z===keptZ);
 const revokedInvite=await owner.api.createInvite({aquariumId:id,email:outsider.email,role:'viewer',expiresHours:1});await owner.api.revokeInvite({aquariumId:id,inviteId:revokedInvite.data.id});check('撤销邀请后不可接受',!(await outsider.api.acceptInvite(revokedInvite.data.token)).ok);
 const removed=await owner.api.removeMember({aquariumId:id,userId:editor.id});check('owner 撤销编辑成员',removed.ok);await waitUntil(()=>revoked,'生产权限检查与订阅清理');
 check('撤销后 API 读取/写入/进食被拒绝',!(await editor.api.get(id)).ok&&!(await editor.api.apply(id,randomUUID(),[{kind:'set_night',before:false,value:true}])).ok&&!(await editor.api.feed(id,randomUUID(),fishId)).ok);
 await owner.api.removeMember({aquariumId:id,userId:viewer.id});await delay(1500);const noticeCount=viewerNotifications;
 const fresh=(await owner.api.get(id)).data.state_json;await owner.api.apply(id,randomUUID(),[{kind:'set_night',before:fresh.night,value:!fresh.night}]);await delay(1400);
 check('撤销 viewer 后既有订阅不再收到新版本通知',viewerNotifications===noticeCount);
 for(const client of clients)await client.api.stopRealtime();
 console.log('C真实云端核心链路完成；程序模拟断网不代表手机真机。');
}catch(e){runFailed=true;checks.push({name:'流程完成',ok:false});console.error('C云端检查未完成：'+e.message+(e.cause?.code?' ('+e.cause.code+')':''));}
finally{
 for(const engine of engines)await engine.stop().catch(()=>{});
 for(const client of clients){await client.api.stopRealtime().catch(()=>{});await client.auth.signOut().catch(()=>{});}
 for(const entry of [...owned].reverse()){
  try{const current=await admin('users/'+entry.id);if(current.status!==200||current.body?.email!==entry.email)throw Error('身份核对失败');const deleted=await admin('users/'+entry.id,'DELETE');const absent=await admin('users/'+entry.id);check('清理并确认本轮临时身份',deleted.status===200&&missing(absent));}
  catch{runFailed=true;console.error('临时身份清理未确认，见本机私有登记文件。');}
 }
 await writeFile(new URL('cloud-c-results.json',logDir),JSON.stringify({checks,ok:!runFailed,total:checks.length,passed:checks.filter(r=>r.ok).length,ownedIds:owned.map(u=>u.id)},null,2)+'\n');
 console.log(`C真实检查：${checks.filter(r=>r.ok).length}/${checks.length}；${runFailed?'未通过':'通过'}`);if(runFailed)process.exitCode=1;
}
