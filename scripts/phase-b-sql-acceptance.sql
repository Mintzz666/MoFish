-- Run only against the explicitly selected independent B QA project.
-- No existing identities are reused. The inner exception subtransaction rolls
-- back every temporary identity, aquarium and event, including on test failure.
-- This is SQL evidence, not GoTrue/JWT/HTTP or real-device acceptance.
do $$
declare
  ua uuid := gen_random_uuid(); ub uuid := gen_random_uuid(); aid uuid;
  op uuid := gen_random_uuid(); old_state jsonb; state2 jsonb; bad jsonb;
  r record; s record; previous jsonb; rev bigint; n integer;
  checks jsonb := '{}'::jsonb; entry record;
begin
  begin
    insert into auth.users(id,email) values
      (ua,'mofish-b-sql-'||ua||'@example.com'), (ub,'mofish-b-sql-'||ub||'@example.com');
    old_state := jsonb_build_object('version',1,'fish',jsonb_build_array(jsonb_build_object(
      'id','sql-owned-fish','name','SQL验收鱼','species',0,'born',1700000000000,
      'growth',0.2,'meals',3)),'plants',2,'night',false,'sound',false,'savedAt',1700000000000);
    perform set_config('request.jwt.claim.sub',ua::text,true);
    perform set_config('request.jwt.claims',jsonb_build_object('sub',ua,'role','authenticated')::text,true);
    select * into r from public.ensure_aquarium(old_state,1);
    aid := r.aquarium_id;
    checks := checks || jsonb_build_object('v1_create',r.status='ok' and r.created and aid is not null);
    select * into s from public.ensure_aquarium(old_state,1);
    checks := checks || jsonb_build_object('v1_idempotent',s.status='ok' and not s.created and s.aquarium_id=aid);
    update public.aquariums set last_growth_at=now()-interval '1 hour' where id=aid and owner_id=ua;
    select * into r from public.settle_growth(aid,86400);
    checks := checks || jsonb_build_object('v1_rate_unchanged',r.credited_seconds=3600 and (r.state_json#>>'{fish,0,growth}')::numeric=0.208);

    state2 := jsonb_set(jsonb_set(r.state_json,'{version}','2'),'{fish,0,species}','"sunset"') - 'plants';
    state2 := jsonb_set(state2,'{fish,0,look}','{"v":1,"seed":12345}');
    state2 := state2 || '{"layout":{"v":1,"seed":42},"decor":[{"id":"owned-rock","kind":"rock","type":"seiryu","x":0.25,"z":0.72,"rot":0.85,"scale":1.1,"seed":5678,"v":1}]}'::jsonb;
    rev := r.revision;
    select * into r from public.save_aquarium(aid,rev,state2,2);
    checks := checks || jsonb_build_object('v2_upgrade_save',r.status='ok' and r.revision=rev+1);
    select * into r from public.ensure_aquarium(state2,2);
    rev := r.revision;
    checks := checks || jsonb_build_object('v2_exact_restore',r.state_json=state2 and r.aquarium_id=aid);
    select * into s from public.save_aquarium(aid,rev-1,state2,2);
    checks := checks || jsonb_build_object('v2_revision_conflict',s.status='conflict' and s.revision=rev);
    bad := jsonb_set(state2,'{decor,0,x}','1.5');
    select * into s from public.save_aquarium(aid,rev,bad,2);
    checks := checks || jsonb_build_object('decor_bounds_rejected',s.status='invalid_state' and s.error_code='decor_position_invalid');
    select * into s from public.save_aquarium(aid,rev,state2,1);
    checks := checks || jsonb_build_object('v2_as_v1_rejected',s.status='invalid_state');
    select * into s from public.save_aquarium(aid,rev,old_state,2);
    checks := checks || jsonb_build_object('v1_as_v2_rejected',s.status='invalid_state' and s.error_code='version_mismatch');
    select * into s from public.save_aquarium(aid,rev,'[]'::jsonb,2);
    checks := checks || jsonb_build_object('nonobject_rejected',s.status='invalid_state');

    perform set_config('request.jwt.claim.sub',ub::text,true);
    perform set_config('request.jwt.claims',jsonb_build_object('sub',ub,'role','authenticated')::text,true);
    select * into s from public.save_aquarium(aid,rev,state2,2);
    checks := checks || jsonb_build_object('cross_save_hidden',s.status='not_found');
    select * into s from public.settle_growth(aid,86400);
    checks := checks || jsonb_build_object('cross_settle_hidden',s.status='not_found');
    select * into s from public.record_feeding(aid,gen_random_uuid(),'sql-owned-fish',1);
    checks := checks || jsonb_build_object('cross_feed_hidden',s.status='not_found');
    execute 'set local role authenticated';
    select count(*) into n from public.aquariums where id=aid;
    checks := checks || jsonb_build_object('cross_rls_empty',n=0 and current_user='authenticated');
    begin
      update public.aquariums set state_json=state2 where id=aid;
      raise exception 'direct write unexpectedly permitted';
    exception when insufficient_privilege then checks := checks || '{"table_write_denied":true}'; end;
    begin
      perform id from public.mofish_feed_events where aquarium_id=aid;
      raise exception 'event read unexpectedly permitted';
    exception when insufficient_privilege then checks := checks || '{"event_read_denied":true}'; end;
    execute 'reset role';

    perform set_config('request.jwt.claim.sub',ua::text,true);
    perform set_config('request.jwt.claims',jsonb_build_object('sub',ua,'role','authenticated')::text,true);
    select * into s from public.record_feeding(aid,op,'sql-owned-fish',1);
    checks := checks || jsonb_build_object('feeding_recorded',s.status='ok' and not s.duplicate);
    select * into s from public.record_feeding(aid,op,'sql-owned-fish',1);
    checks := checks || jsonb_build_object('feeding_deduplicated',s.status='ok' and s.duplicate);
    select * into s from public.record_feeding(aid,op,'sql-owned-fish',2);
    checks := checks || jsonb_build_object('operation_payload_rejected',s.status='invalid_argument' and s.error_code='operation_mismatch');
    select * into s from public.record_feeding(aid,gen_random_uuid(),'missing-owned-fish',1);
    checks := checks || jsonb_build_object('missing_fish_rejected',s.status='not_found');
    select * into s from public.ensure_aquarium(state2,2);
    checks := checks || jsonb_build_object('feeding_no_direct_reward',s.state_json=state2 and s.revision=rev);
    select * into r from public.settle_growth(aid,0);
    checks := checks || jsonb_build_object('one_bite_settled',r.credited_seconds=0 and (r.state_json#>>'{fish,0,growth}')::numeric=0.214667 and (r.state_json#>>'{fish,0,meals}')::integer=4);
    for n in 1..3 loop perform public.record_feeding(aid,gen_random_uuid(),'sql-owned-fish',1); end loop;
    select * into r from public.settle_growth(aid,0);
    checks := checks || jsonb_build_object('nutrition_three_bites_cap',(r.state_json#>>'{fish,0,growth}')::numeric=0.228 and (r.state_json#>>'{fish,0,meals}')::integer=7);
    select * into s from public.settle_growth(aid,0);
    checks := checks || jsonb_build_object('settlement_idempotent',s.state_json=r.state_json and s.revision=r.revision);
    update public.aquariums set last_growth_at=now()-interval '1 hour' where id=aid and owner_id=ua;
    select * into r from public.settle_growth(aid,86400);
    checks := checks || jsonb_build_object('v2_hour_rate',r.credited_seconds=3600 and (r.state_json#>>'{fish,0,growth}')::numeric=0.230083);
    update public.aquariums set last_growth_at=now()-interval '25 hours' where id=aid and owner_id=ua;
    select * into r from public.settle_growth(aid,86400);
    checks := checks || jsonb_build_object('v2_offline_24h_cap',r.credited_seconds=86400 and (r.state_json#>>'{fish,0,growth}')::numeric=0.280083);
    update public.mofish_feed_events set created_at=now()-interval '25 hours' where aquarium_id=aid;
    perform public.record_feeding(aid,gen_random_uuid(),'sql-owned-fish',1);
    select * into r from public.settle_growth(aid,0);
    checks := checks || jsonb_build_object('rolling_window_expiry',(r.state_json#>>'{fish,0,growth}')::numeric=0.286750 and (r.state_json#>>'{fish,0,meals}')::integer=8);
    insert into public.mofish_feed_events(aquarium_id,operation_id,fish_id,bites,credited,applied_at)
      select aid,gen_random_uuid(),'sql-owned-fish',1,0,now() from generate_series(1,500);
    select * into s from public.record_feeding(aid,gen_random_uuid(),'sql-owned-fish',1);
    checks := checks || jsonb_build_object('feed_rate_limit',s.status='rate_limited');
    select * into s from public.record_feeding(aid,op,'sql-owned-fish',1);
    checks := checks || jsonb_build_object('retry_allowed_at_limit',s.status='ok' and s.duplicate);
    execute 'set local role anon';
    begin
      perform public.record_feeding(aid,gen_random_uuid(),'sql-owned-fish',1);
      raise exception 'anon execution unexpectedly permitted';
    exception when insufficient_privilege then checks := checks || '{"anon_feed_denied":true}'; end;
    execute 'reset role';
    for entry in select * from jsonb_each(checks) loop
      if entry.value is distinct from 'true'::jsonb then raise exception 'B SQL acceptance failed: %',entry.key; end if;
    end loop;
    raise exception using errcode='MX001',message='rollback owned QA fixtures';
  exception when sqlstate 'MX001' then null;
  end;
  if exists(select 1 from auth.users where id in (ua,ub))
    or exists(select 1 from public.aquariums where id=aid)
    or exists(select 1 from public.mofish_feed_events where aquarium_id=aid) then
    raise exception 'B SQL acceptance cleanup failed';
  end if;
  checks := checks || '{"owned_fixtures_rolled_back":true}';
  perform set_config('mofish.phase_b_qa',checks::text,true);
end $$;
select current_setting('mofish.phase_b_qa')::jsonb as checks;
