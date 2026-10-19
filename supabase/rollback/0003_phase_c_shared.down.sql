-- First restore the B frontend and export shared saves. Never silently discard membership/history.
begin;
do $$ begin
 if exists(select 1 from public.mofish_members) or exists(select 1 from public.mofish_invites) or exists(select 1 from public.mofish_room_operations) then
 raise exception 'C rollback refused: export and explicitly resolve shared membership, invitation and operation history first';
 end if;
end $$;
drop policy if exists mofish_member_aquarium_read on public.aquariums;
drop policy if exists mofish_revision_member_read on public.mofish_room_revisions;
drop trigger if exists mofish_revision_changed on public.aquariums;
drop function if exists public.mofish_room_role(uuid);
drop function if exists public.mofish_notify_revision();
drop function if exists public.shared_list_aquariums();
drop function if exists public.shared_get_aquarium(uuid);
drop function if exists public.shared_probe(uuid);
drop function if exists public.shared_list_members(uuid);
drop function if exists public.shared_list_invites(uuid);
drop function if exists public.shared_create_invite(uuid,text,text,integer);
drop function if exists public.shared_revoke_invite(uuid,uuid);
drop function if exists public.shared_accept_invite(text);
drop function if exists public.shared_manage_member(uuid,uuid,text);
drop function if exists public.shared_leave_aquarium(uuid);
drop function if exists public.shared_apply_operations(uuid,uuid,jsonb);
drop function if exists public.shared_record_feeding(uuid,uuid,text,integer);
drop function if exists public.shared_settle_growth(uuid,integer);
drop table if exists public.mofish_room_revisions,public.mofish_room_operations,public.mofish_invites,public.mofish_members;
create or replace function public.save_aquarium(
  p_id                uuid,
  p_expected_revision bigint,
  p_state             jsonb,
  p_state_version     integer default 1
)
returns table (status text, revision bigint, updated_at timestamptz, error_code text)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid     uuid := auth.uid();
  v_error   text;
  v_new_rev bigint;
  v_new_at  timestamptz;
  v_current bigint;
begin
  if v_uid is null then
    return query select 'not_authenticated', null::bigint, null::timestamptz, 'not_authenticated'::text;
    return;
  end if;

  if p_id is null or p_expected_revision is null or p_expected_revision < 1 then
    return query select 'invalid_argument', null::bigint, null::timestamptz, 'bad_revision'::text;
    return;
  end if;

  if p_state_version is null or p_state_version not in (1, 2) then
    return query select 'invalid_argument', null::bigint, null::timestamptz, 'unsupported_state_version'::text;
    return;
  end if;

  -- 存档自身的 version 必须与 state_version 参数一致，避免「标称 v2、内容是 v1」的歧义存档。
  -- 只在存档本身带合法 version 时比较，这样缺失字段/类型错误的 v1 仍由 mofish_state_error 给出
  -- 阶段 A 的细分错误码（保持旧测试与旧客户端的可诊断性）。
  if p_state is not null and jsonb_typeof(p_state) = 'object'
     and jsonb_typeof(p_state->'version') = 'number'
     and (p_state->>'version')::numeric <> p_state_version then
    return query select 'invalid_state', null::bigint, null::timestamptz, 'version_mismatch'::text;
    return;
  end if;
  if p_state_version = 2 and (p_state is null or jsonb_typeof(p_state) is distinct from 'object') then
    return query select 'invalid_state', null::bigint, null::timestamptz, 'version_mismatch'::text;
    return;
  end if;

  v_error := public.mofish_state_error_any(p_state);
  if v_error is not null then
    return query select 'invalid_state', null::bigint, null::timestamptz, v_error;
    return;
  end if;

  if pg_column_size(p_state) > 32768 then
    return query select 'invalid_state', null::bigint, null::timestamptz, 'state_too_large'::text;
    return;
  end if;

  update public.aquariums a
     set state_json    = p_state,
         state_version = p_state_version,
         revision      = a.revision + 1,
         updated_at    = now()
   where a.id = p_id
     and a.owner_id = v_uid
     and a.revision = p_expected_revision
   returning a.revision, a.updated_at into v_new_rev, v_new_at;

  if v_new_rev is not null then
    return query select 'ok', v_new_rev, v_new_at, null::text;
    return;
  end if;

  select a.revision into v_current from public.aquariums a where a.id = p_id and a.owner_id = v_uid;

  if v_current is null then
    return query select 'not_found', null::bigint, null::timestamptz, 'aquarium_not_found'::text;
  else
    return query select 'conflict', v_current, null::timestamptz, 'revision_conflict'::text;
  end if;
end $$;


commit;
