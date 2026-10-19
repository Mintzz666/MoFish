// Shared-room RPCs always use the current auth identity; no user-supplied token or direct table writes.
import { RealtimeClient } from '@supabase/realtime-js';
import {validate} from '../model.js';
import { interpretRpcRow } from './api.js';
const MESSAGES = {
 forbidden: '你已没有这个鱼缸的访问权限，或当前角色不能执行这项操作。',
 not_authenticated: '请先登录，再一起养鱼。', invalid_invite: '邀请无效、已过期，或不属于当前已验证的邮箱。',
 invalid_argument: '请检查邮箱、角色和有效期。', conflict: '这件物件刚被另一位伙伴修改了，你的改动已保留。',
 operation_mismatch: '这次操作的编号已经使用，已停止提交以保护存档。',
 server_growth_only: '成长由云端结算，不能通过导入或编辑增加。', invalid_state: '这份改动暂时无法保存，请保留备份。',
 invalid_operation: '无法保存这项改动，请保留备份后重试。', member_limit: '这个鱼缸的伙伴已经满了。',
 rate_limited: '今天的操作较多，改动已保留，稍后再试。', upgrade_required: '请主人先在个人鱼缸打开并同步旧存档，再开启共享。'
};
export function createSharingApi({url,anonKey,auth,fetchImpl=globalThis.fetch,timeoutMs=15000}={}) {
 const base=String(url||'').replace(/\/+$/,'');let realtime=null;let activeChannel=null;let realtimeEpoch=0;
 async function token(refresh=false){const r=refresh?await auth.refresh():await auth.getSession({allowRefresh:false});return r.session?.access_token||null;}
 async function rpc(name,payload={},table=false){
  let jwt=await token();if(!jwt)return {ok:false,code:'not_authenticated',error:MESSAGES.not_authenticated};
  for(let attempt=0;attempt<2;attempt++){
   try{
    const r=await fetchImpl(base+'/rest/v1/rpc/'+name,{method:'POST',headers:{apikey:anonKey,Authorization:'Bearer '+jwt,'Content-Type':'application/json'},body:JSON.stringify(payload),signal:AbortSignal.timeout(timeoutMs)});
    if(r.status===401&&attempt===0){jwt=await token(true);if(jwt)continue;}
    if(!r.ok)return {ok:false,code:r.status===401?'not_authenticated':r.status===403?'forbidden':r.status===404?'missing_backend':'network_error',error:r.status===404?'共享功能尚未安装，请稍后再试。':r.status===403?MESSAGES.forbidden:'暂时无法同步，改动已保存在本机。'};
    const raw=await r.json();
    if(table){const row=Array.isArray(raw)?raw[0]:raw;const result=interpretRpcRow(row);return {ok:result.kind==='ok',data:row,code:result.kind,error:MESSAGES[result.kind]||result.message};}
    if(!raw||typeof raw.ok!=='boolean')return {ok:false,code:'bad_response',error:'云端响应暂时无法读取。'};
    return raw.ok?raw:{...raw,code:raw.error,error:MESSAGES[raw.error]||'这项操作暂未完成，请稍后再试。'};
   }catch{return {ok:false,code:'network_error',error:'连接中断，改动已保存在本机。'};}
  }
  return {ok:false,code:'not_authenticated',error:MESSAGES.not_authenticated};
 }
 async function stopRealtime(){realtimeEpoch++;const channel=activeChannel,client=realtime;activeChannel=null;realtime=null;try{if(channel)await channel.unsubscribe();}finally{client?.disconnect();}}
 async function subscribe(aquariumId,onChange,onStatus=()=>{}){
  const stopping=stopRealtime();const gen=realtimeEpoch;await stopping;if(gen!==realtimeEpoch)return ()=>{};
  if(!/^[0-9a-f-]{36}$/i.test(aquariumId))return ()=>{};
  realtime=new RealtimeClient(base+'/realtime/v1',{params:{apikey:anonKey},accessToken:async()=>{const r=await auth.getSession();return r.session?.access_token||null;}});
  const local=realtime;
  await local.setAuth();
  if(gen!==realtimeEpoch){local.disconnect();return ()=>{};}
  activeChannel=local.channel('mofish-revision:'+aquariumId)
   .on('system',{},payload=>{if(gen===realtimeEpoch&&payload.extension==='postgres_changes')onStatus(payload.status==='ok'?'READY':'CHANNEL_ERROR');})
   .on('postgres_changes',{event:'UPDATE',schema:'public',table:'mofish_room_revisions',filter:'aquarium_id=eq.'+aquariumId},()=>{if(gen===realtimeEpoch)onChange();})
   .subscribe(status=>{if(gen===realtimeEpoch)onStatus(status);});
  return stopRealtime;
 }
 return {rpc,subscribe,stopRealtime,
  async preparePersonal(initialState){
   const found=await rpc('ensure_aquarium',{p_initial_state:initialState,p_state_version:2},true);
   if(!found.ok)return found;
   if(found.data.state_json?.version!==2){
    const upgraded=await rpc('save_aquarium',{p_id:found.data.aquarium_id,p_expected_revision:Number(found.data.revision),p_state:validate(found.data.state_json),p_state_version:2},true);
    if(!upgraded.ok)return upgraded;
   }
   return {ok:true,data:{aquarium_id:found.data.aquarium_id}};
  },
  listAquariums:()=>rpc('shared_list_aquariums'),get:id=>rpc('shared_get_aquarium',{p_id:id}),probe:id=>rpc('shared_probe',{p_id:id}),
  listMembers:id=>rpc('shared_list_members',{p_id:id}),listInvites:id=>rpc('shared_list_invites',{p_id:id}),
  createInvite:({aquariumId,email,role,expiresHours})=>rpc('shared_create_invite',{p_id:aquariumId,p_email:email,p_role:role,p_hours:Number(expiresHours)}),
  revokeInvite:({aquariumId,inviteId})=>rpc('shared_revoke_invite',{p_id:aquariumId,p_invite_id:inviteId}),
  setMemberRole:({aquariumId,userId,role})=>rpc('shared_manage_member',{p_id:aquariumId,p_user_id:userId,p_role:role}),
  removeMember:({aquariumId,userId})=>rpc('shared_manage_member',{p_id:aquariumId,p_user_id:userId,p_role:null}),
  acceptInvite:token=>rpc('shared_accept_invite',{p_token:String(token).trim()}),leaveAquarium:id=>rpc('shared_leave_aquarium',{p_id:id}),
  apply:(id,operationId,operations)=>rpc('shared_apply_operations',{p_id:id,p_operation_id:operationId,p_operations:operations}),
  feed:(id,operationId,fishId,bites=1)=>rpc('shared_record_feeding',{p_id:id,p_operation_id:operationId,p_fish_id:fishId,p_bites:bites},true),
  settle:id=>rpc('shared_settle_growth',{p_id:id,p_cap_seconds:86400},true)
 };
}
