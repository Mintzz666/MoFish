export function phaseCEnvironment(env){return {...env,MOFISH_SUPABASE_URL:env.MOFISH_C_SUPABASE_URL||'',MOFISH_SUPABASE_ANON_KEY:env.MOFISH_C_SUPABASE_ANON_KEY||'',MOFISH_SMOKE_SERVICE_ROLE_KEY:env.MOFISH_C_SMOKE_SERVICE_ROLE_KEY||'',MOFISH_SMOKE_EXPECTED_PROJECT_REF:env.MOFISH_C_PROJECT_REF||'',MOFISH_PHASE:'c'};}
export function checkPhaseCTarget(url,ref){
 if(ref!=='gbcfyqtbezkgkstrfbzn'||url!=='https://gbcfyqtbezkgkstrfbzn.supabase.co')throw Error('C 仅允许已授权的独立 QA 项目 gbcfyqtbezkgkstrfbzn；不回退到 A/B 配置。');
}
