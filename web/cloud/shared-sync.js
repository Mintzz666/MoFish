import { validate, cloneState } from '../model.js';
import { STATUS } from './sync.js';
import { diffSharedState, applySharedOperations } from './shared-operations.js';
// A local outbox is scoped to identity + aquarium. No whole-save upload exists on this path.
export function createSharedSyncEngine({api,store,getState,setState,onStatus=()=>{},onNotice=()=>{},onRevoked=()=>{},isOnline=()=>navigator.onLine!==false,setTimeoutFn=setTimeout,clearTimeoutFn=clearTimeout,pollMs=15000}={}){
 let session=null,id=null,role=null,generation=0,revision=null,base=null,shadow=null,queue=[],feeds=[],conflict=null,status=STATUS.GUEST;
 let timer=null,watchdog=null,inFlight=null,again=false,active=false,paused=false,subscriptionBound=false;
 const uid=()=>session?.user?.id;
 const canEdit=()=>active&&['owner','editor'].includes(role);
 function snapshot(){return {user:session?.user||null,aquariumId:id,revision,baseRevision:revision,mode:active?'cloud':'guest',configured:true,status,dirty:queue.length>0,pendingFeeds:feeds.length,busy:Boolean(inFlight),role,conflict:conflict?{reason:'pending',cloudRevision:revision}:null,isShared:active};}
 function emit(next=status,message=''){status=next;onStatus({...snapshot(),message});}
 function persistLocal(){
  if(!active||!uid()||!id||!shadow)return false;
  return store.writeAccountState(uid(),id,getState())&&store.writeMeta(uid(),id,{kind:'shared-v1',revision,base,shadow,queue,feeds,role,paused});
 }
 function schedule(){if(timer!==null)clearTimeoutFn(timer);const gen=generation;timer=setTimeoutFn(()=>{timer=null;if(gen===generation)syncNow({reason:'edit'});},650);}
 function markDirty(){
  if(!active||!shadow)return false;
  if(!canEdit()){
   if(diffSharedState(shadow,getState()).length){setState(cloneState(shadow));onNotice('当前仅可观看这个鱼缸。');return false;}
   shadow=cloneState(getState());return persistLocal();
  }
  try{
   const ops=diffSharedState(shadow,getState());
   if(ops.length){if(queue.length>=200)throw Error('离线操作较多，请先联网同步；当前改动请导出备份。');queue.push({id:crypto.randomUUID(),ops});}
   shadow=cloneState(getState());if(conflict)conflict.localState=cloneState(shadow);
   if(!persistLocal())throw Error('本机缓存暂不可用，请先导出保留进度。');
   if(conflict)emit(STATUS.CONFLICT);else if(!isOnline())emit(STATUS.OFFLINE);else if(queue.length){emit(STATUS.SYNCING);schedule();}
   return true;
  }catch(e){store.writeBackup(uid(),id,getState());emit(STATUS.ERROR,e.message);return false;}
 }
 function queueFeed(fishId,bites=1){
  if(!canEdit()||!base)return {ok:false,skipped:'viewer'};
  if(feeds.length>=200){onNotice('进食记录较多，请先联网同步。');return {ok:false,skipped:'limit'};}
  feeds.push({id:crypto.randomUUID(),fishId,bites});persistLocal();if(isOnline())schedule();else emit(STATUS.OFFLINE);return {ok:true};
 }
 function raiseConflict(server){conflict={localState:cloneState(getState()),cloudState:cloneState(server),cloudRevision:revision};paused=true;persistLocal();emit(STATUS.CONFLICT,'同一物件有了新改动。你的版本已保留，请选择如何处理。');}
 function adopt(data){
  const server=validate(data.state_json);role=data.role||role;revision=Number(data.revision);base=cloneState(server);
  if(queue.length){
   const projected=applySharedOperations(server,queue.flatMap(q=>q.ops));
   if(!projected.ok){raiseConflict(server);return false;}
   const sound=getState().sound;setState(validate(projected.state));getState().sound=sound;
  }else{const sound=getState().sound;setState(server);getState().sound=sound;}
  shadow=cloneState(getState());persistLocal();return true;
 }
 async function revoke(){
  if(!active)return;const user=uid(),room=id;
  if(queue.length||feeds.length)store.writeBackup(user,room,getState());
  paused=true;role=null;persistLocal();const revokeGen=++generation;subscriptionBound=false;await api.stopRealtime();if(generation!==revokeGen)return;
  if(watchdog!==null)clearTimeoutFn(watchdog);watchdog=null;
  emit(STATUS.SIGNED_OUT,'共享权限已撤销，本机未上传改动已留作备份。');onRevoked();
 }
 async function failed(res,gen){
  if(gen!==generation)return {ok:false,skipped:'stale'};
  if(['forbidden','not_found','not_authenticated'].includes(res.code)){await revoke();return res;}
  persistLocal();emit(isOnline()?STATUS.ERROR:STATUS.OFFLINE,res.error||'连接中断，改动已保存在本机。');return res;
 }
 async function syncWork({reason='manual',settle=true}={},gen){
  if(!active||!isOnline()){if(active)emit(STATUS.OFFLINE);return {ok:false,skipped:'offline'};}
  if(conflict)return {ok:false,skipped:'conflict'};
  emit(STATUS.SYNCING);
  const checked=await api.probe(id);if(gen!==generation)return {ok:false,skipped:'stale'};
  if(!checked.ok)return failed(checked,gen);
  role=checked.data.role;
  if(!canEdit()&&(queue.length||feeds.length)){const latest=await api.get(id);if(gen!==generation)return {ok:false,skipped:'stale'};if(!latest.ok)return failed(latest,gen);raiseConflict(latest.data.state_json);return {ok:false,skipped:'role_changed'};}
  while(queue.length){
   const item=queue[0];const result=await api.apply(id,item.id,item.ops);
   if(gen!==generation)return {ok:false,skipped:'stale'};
   if(!result.ok){
    if(result.code==='conflict'){const fresh=await api.get(id);if(gen!==generation)return {ok:false,skipped:'stale'};if(fresh.ok){revision=Number(fresh.data.revision);raiseConflict(fresh.data.state_json);}else return failed(fresh,gen);return result;}
    return failed(result,gen);
   }
   queue.shift();if(!adopt(result.data))return {ok:false,skipped:'conflict'};
  }
  while(feeds.length){
   const item=feeds[0];const r=await api.feed(id,item.id,item.fishId,item.bites);if(gen!==generation)return {ok:false,skipped:'stale'};
   if(!r.ok){
    if(r.code==='not_found'){
     const latest=await api.get(id);if(gen!==generation)return {ok:false,skipped:'stale'};
     if(!latest.ok)return failed(latest,gen);
     role=latest.data.role;
     if(!canEdit()){revision=Number(latest.data.revision);raiseConflict(latest.data.state_json);return {ok:false,skipped:'role_changed'};}
     if(!latest.data.state_json.fish.some(fish=>fish.id===item.fishId)){
      feeds.shift();persistLocal();onNotice('伙伴已移走这条鱼，它的待同步进食已结束。');continue;
     }
     emit(STATUS.ERROR,'这口进食暂未确认，已留在本机稍后重试。');return r;
    }
    return failed(r,gen);
   }
   feeds.shift();persistLocal();
  }
  if(canEdit()&&settle){const r=await api.settle(id);if(gen!==generation)return {ok:false,skipped:'stale'};if(!r.ok)return failed(r,gen);}
  // Always read a fresh authorized snapshot after writes/settlement and on reconnection.
  const fresh=await api.get(id);if(gen!==generation)return {ok:false,skipped:'stale'};
  if(!fresh.ok)return failed(fresh,gen);
  if(!adopt(fresh.data))return {ok:false,skipped:'conflict'};
  emit(queue.length||feeds.length?STATUS.SYNCING:STATUS.SYNCED);await bindRealtime(gen);return {ok:true,reason};
 }
 function syncNow(options={}){
  if(inFlight){again=true;return inFlight;}
  const gen=generation;
  const job=syncWork(options,gen).catch(()=>{if(gen===generation){persistLocal();emit(STATUS.ERROR,'暂时未能同步，改动仍在本机。');}return {ok:false};});
  inFlight=job;
  job.finally(()=>{if(inFlight===job){inFlight=null;if(gen===generation&&active){emit();if(again&&!conflict){again=false;schedule();}}}});
  return job;
 }
 function watch(gen){
  if(gen!==generation||!active)return;
  watchdog=setTimeoutFn(async()=>{
   watchdog=null;if(gen!==generation||!active)return;
   if(isOnline()&&!(typeof document!=='undefined'&&document.hidden)){
    const probe=await api.probe(id);if(gen!==generation)return;
    if(!probe.ok&&['forbidden','not_authenticated'].includes(probe.code)){await revoke();return;}
    if(probe.ok&&(probe.data.role!==role||Number(probe.data.revision)!==revision))syncNow({reason:'watchdog',settle:false});
   }
   watch(gen);
  },pollMs);
 }
 async function bindRealtime(gen){
  if(subscriptionBound||gen!==generation||!active||!isOnline())return;
  subscriptionBound=true;
  await api.subscribe(id,()=>{if(gen===generation&&active&&!conflict)syncNow({reason:'realtime',settle:false});},state=>{
   if(gen===generation&&active){onStatus({...snapshot(),realtime:state});if(state==='READY'&&!conflict)syncNow({reason:'realtime-ready',settle:false});}
  });
  if(gen===generation&&watchdog===null)watch(gen);
 }
 async function start(nextSession,aquariumId){
  const stopping=stop();const gen=generation;await stopping;if(gen!==generation)return {ok:false,skipped:'stale'};
  active=true;session=nextSession;id=aquariumId;
  const cached=store.readMeta(uid(),id);
  queue=[];feeds=[];paused=false;conflict=null;base=null;shadow=null;revision=null;role=null;
  if(cached?.kind==='shared-v1')try{base=validate(cached.base);shadow=validate(cached.shadow);queue=Array.isArray(cached.queue)?cached.queue:[];feeds=Array.isArray(cached.feeds)?cached.feeds:[];role=cached.role;revision=cached.revision;paused=Boolean(cached.paused);setState(cloneState(shadow));}catch{onNotice('共享缓存无法读取，请保留导出文件后重新连接。');queue=[];feeds=[];}
  else {
   const legacyPending=store.readPending?.(uid(),id)?.state;
   if(legacyPending){
    if(!store.writeBackup(uid(),id,legacyPending)){emit(STATUS.ERROR,'旧版未上传存档暂时无法备份，请先导出后再打开。');return {ok:false};}
    onNotice('旧版未上传副本已保留在账号备份中，当前恢复云端；可先导出备份查看。');
   }
   feeds=(store.readFeeds?.(uid(),id)||[]).map(item=>({id:item.op,fishId:item.fishId,bites:item.bites}));
  }
  const res=await api.get(id);if(gen!==generation)return {ok:false,skipped:'stale'};
  if(!res.ok){if(shadow&&res.code==='network_error'){emit(STATUS.OFFLINE,res.error);watch(gen);return {ok:true,offline:true};}if(!shadow)emit(STATUS.ERROR,res.error);return failed(res,gen);}
  if(paused&&queue.length){role=res.data.role;revision=Number(res.data.revision);raiseConflict(res.data.state_json);}else adopt(res.data);
  if(!conflict)await syncNow({reason:'open'});
  if(gen!==generation)return {ok:false,skipped:'stale'};
  await bindRealtime(gen);
  return {ok:true};
 }
 async function stop(){
  persistLocal();generation++;active=false;subscriptionBound=false;
  if(timer!==null)clearTimeoutFn(timer);if(watchdog!==null)clearTimeoutFn(watchdog);timer=null;watchdog=null;inFlight=null;again=false;
  session=null;id=null;role=null;base=null;shadow=null;queue=[];feeds=[];conflict=null;paused=false;status=STATUS.GUEST;
  await api.stopRealtime();
 }
 async function resolveConflict(choice){
  if(!conflict)return {ok:true};if(choice==='later')return {ok:true,skipped:'later'};
  const gen=generation,fresh=await api.get(id);if(gen!==generation)return {ok:false,skipped:'stale'};if(!fresh.ok)return failed(fresh,gen);
  store.writeBackup(uid(),id,getState());
  if(choice==='cloud'){
   queue=[];feeds=[];paused=false;conflict=null;adopt(fresh.data);emit(STATUS.SYNCED);return {ok:true};
  }
  if(choice!=='local'||!canEdit())return {ok:false};
  // Reapply only this device's intended fields. Never replace unrelated remote changes.
  const projected=applySharedOperations(validate(fresh.data.state_json),queue.flatMap(q=>q.ops),{strict:false});
  if(!projected.ok){onNotice('物件身份发生冲突，请采用云端并从备份恢复需要的内容。');return {ok:false};}
  store.writeBackup(uid(),id,validate(fresh.data.state_json),Date.now()+1);
  const ops=diffSharedState(validate(fresh.data.state_json),projected.state);
  queue=ops.length?[{id:crypto.randomUUID(),ops}]:[];conflict=null;paused=false;base=validate(fresh.data.state_json);revision=Number(fresh.data.revision);setState(validate(projected.state));shadow=cloneState(getState());persistLocal();
  onNotice('保留了你的目标物件改动，其余伙伴的新内容也会留下。');return syncNow({reason:'resolve'});
 }
 return {start,stop,dispose:stop,markDirty,persistLocal,syncNow,flush:syncNow,queueFeed,resolveConflict,
  handleOnline:()=>syncNow({reason:'reconnect'}),handleOffline:()=>{persistLocal();emit(STATUS.OFFLINE);},
  conflictDetail:()=>conflict?{reason:'pending',cloudKnown:true,localFish:conflict.localState.fish,cloudFish:conflict.cloudState.fish,localDecor:conflict.localState.decor,cloudDecor:conflict.cloudState.decor}:null,
  get snapshot(){return snapshot();},get generation(){return generation;},get isCloud(){return active;},get isDirty(){return queue.length>0;},get pendingFeeds(){return feeds.length;},get canEdit(){return canEdit();},get role(){return role;}};
}
