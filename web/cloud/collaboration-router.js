// Keeps the accepted personal engine intact; a shared view uses an isolated semantic outbox.
export function createCollaborationRouter({legacy,shared,store,onModeChange=()=>{},autoShared=false,preparePersonal=null}){
 let current=legacy,session=null,epoch=0,switching=false;
 const proxy=new Proxy(legacy,{get(_target,name){
  if(name==='setSession')return setSession;
  if(name==='generation')return epoch*1000000+current.generation;
  if(name==='isShared')return current===shared;
  if(name==='canEdit')return current!==shared||shared.canEdit;
  if(name==='role')return current===shared?shared.role:session?'owner':null;
  if(name==='session')return session;
  const value=current[name];return typeof value==='function'?value.bind(current):value;
 }});
 async function setSession(next){
  const token=++epoch;switching=false;await shared.stop();if(token!==epoch)return {ok:false};
  current=legacy;session=next;onModeChange();
  if(autoShared&&next&&preparePersonal){
   await legacy.setSession(null);if(token!==epoch)return {ok:false};
   const own=await preparePersonal();if(token!==epoch)return {ok:false};
   if(!own.ok)return own;current=shared;onModeChange();return shared.start(session,own.data.aquarium_id);
  }
  const result=await legacy.setSession(next);if(token!==epoch)return {ok:false};
  return result;
 }
 async function prepare(){
  if(!session)return {ok:false,error:'请先登录，再选择共享鱼缸。'};
  if(switching)return {ok:false,error:'正在切换鱼缸，请稍候。'};
  if(current.snapshot.conflict)return {ok:false,error:'请先在账号面板处理当前冲突，或导出本机改动。'};
  if(current.isDirty||current.pendingFeeds){const r=await current.syncNow();if(!r.ok)return {ok:false,error:'当前鱼缸还有未同步改动，请先同步或保留备份。'};}
  return {ok:true};
 }
 async function openAquarium(id){
  const startedAt=epoch;const ready=await prepare();if(startedAt!==epoch)return {ok:false};if(!ready.ok)return ready;switching=true;const token=++epoch;
  try{
   if(current===shared)await shared.stop();else await legacy.setSession(null);
   if(token!==epoch)return {ok:false};current=shared;onModeChange();
   const r=await shared.start(session,id);if(token!==epoch)return {ok:false};return r.ok?{ok:true}: {ok:false,error:'共享鱼缸暂时未能打开。'};
  }finally{if(token===epoch)switching=false;}
 }
 async function goPersonal({force=false}={}){
  if(!force){const ready=await prepare();if(!ready.ok)return ready;}
  const token=++epoch;switching=true;
  try{await shared.stop();if(token!==epoch)return {ok:false};current=legacy;onModeChange();
   if(autoShared&&session&&preparePersonal){const own=await preparePersonal();if(token!==epoch)return {ok:false};if(!own.ok)return own;current=shared;onModeChange();return await shared.start(session,own.data.aquarium_id);}
   return await legacy.setSession(session);
  }
  finally{if(token===epoch)switching=false;}
 }
 return {engine:proxy,openAquarium,goPersonal,context:()=>({user:session?.user||null,aquariumId:current.snapshot.aquariumId,role:proxy.role,isShared:proxy.isShared})};
}
