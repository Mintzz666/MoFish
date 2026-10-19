-- Phase C: directed membership, operation-based collaboration and revision-only notifications.
-- Existing personal aquarium uniqueness and the A/B migration files are preserved.
create table if not exists public.mofish_members (
  aquarium_id uuid not null references public.aquariums(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null check (role in ('editor','viewer')),
  created_at timestamptz not null default now(),
  primary key(aquarium_id,user_id)
);
create index if not exists mofish_members_user_idx on public.mofish_members(user_id,aquarium_id);
create table if not exists public.mofish_invites (
  id uuid primary key default gen_random_uuid(),
  aquarium_id uuid not null references public.aquariums(id) on delete cascade,
  email text not null,
  role text not null check (role in ('editor','viewer')),
  token_hash text not null unique,
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  revoked_at timestamptz,
  accepted_at timestamptz,
  accepted_by uuid references auth.users(id) on delete set null
);
create index if not exists mofish_invites_room_idx on public.mofish_invites(aquarium_id,created_at);
create table if not exists public.mofish_room_operations (
  aquarium_id uuid not null references public.aquariums(id) on delete cascade,
  operation_id uuid not null,
  actor_id uuid not null references auth.users(id) on delete cascade,
  operations jsonb not null,
  created_at timestamptz not null default now(),
  primary key(aquarium_id,operation_id),
  check (pg_column_size(operations)<=32768)
);
create index if not exists mofish_room_operations_rate_idx on public.mofish_room_operations(aquarium_id,created_at);
create table if not exists public.mofish_room_revisions (
  aquarium_id uuid primary key references public.aquariums(id) on delete cascade,
  revision bigint not null,
  changed_at timestamptz not null default now()
);
alter table public.mofish_members enable row level security;
alter table public.mofish_invites enable row level security;
alter table public.mofish_room_operations enable row level security;
alter table public.mofish_room_revisions enable row level security;
revoke all on public.mofish_members,public.mofish_invites,public.mofish_room_operations,public.mofish_room_revisions from public,anon,authenticated;

-- No caller-controlled user ID; the current authenticated identity is always used.
create or replace function public.mofish_room_role(p_id uuid) returns text
language sql stable security definer set search_path=public,pg_temp as $$
 select case when a.owner_id=auth.uid() then 'owner' else
   (select m.role from public.mofish_members m where m.aquarium_id=a.id and m.user_id=auth.uid()) end
 from public.aquariums a where a.id=p_id and auth.uid() is not null
$$;
revoke all on function public.mofish_room_role(uuid) from public,anon;
grant execute on function public.mofish_room_role(uuid) to authenticated;
grant select on public.mofish_room_revisions to authenticated;
drop policy if exists mofish_member_aquarium_read on public.aquariums;
create policy mofish_member_aquarium_read on public.aquariums for select to authenticated
 using (public.mofish_room_role(id) is not null);
drop policy if exists mofish_revision_member_read on public.mofish_room_revisions;
create policy mofish_revision_member_read on public.mofish_room_revisions for select to authenticated
 using (public.mofish_room_role(aquarium_id) is not null);

create or replace function public.mofish_notify_revision() returns trigger
language plpgsql security definer set search_path=public,pg_temp as $$
begin
 insert into public.mofish_room_revisions(aquarium_id,revision) values(new.id,new.revision)
 on conflict(aquarium_id) do update set revision=excluded.revision,changed_at=now();
 return new;
end $$;
revoke all on function public.mofish_notify_revision() from public,anon,authenticated;
drop trigger if exists mofish_revision_changed on public.aquariums;
create trigger mofish_revision_changed after insert or update on public.aquariums
 for each row execute function public.mofish_notify_revision();
insert into public.mofish_room_revisions(aquarium_id,revision) select id,revision from public.aquariums on conflict(aquarium_id) do nothing;
-- A local test kernel has no Realtime publication. Cloud publication includes only
-- small revision notices, never membership emails, invite hashes or full saves.
do $$ begin
 if exists(select 1 from pg_publication where pubname='supabase_realtime') and not exists(
 select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename='mofish_room_revisions') then
   alter publication supabase_realtime add table public.mofish_room_revisions;
 end if;
end $$;

create or replace function public.shared_list_aquariums() returns jsonb
language sql stable security definer set search_path=public,pg_temp as $$
 select case when auth.uid() is null then jsonb_build_object('ok',false,'error','not_authenticated') else
 jsonb_build_object('ok',true,'data',coalesce((select jsonb_agg(jsonb_build_object(
 'id',a.id,'role',public.mofish_room_role(a.id),'revision',a.revision,
 'title',case when a.owner_id=auth.uid() then '我的水下花园' else '共享花园 · '||left(a.id::text,4) end)
 order by a.created_at) from public.aquariums a where public.mofish_room_role(a.id) is not null),'[]'::jsonb)) end
$$;
create or replace function public.shared_get_aquarium(p_id uuid) returns jsonb
language plpgsql stable security definer set search_path=public,pg_temp as $$
declare v_role text:=public.mofish_room_role(p_id); v_row public.aquariums%rowtype;
begin
 if v_role is null then return jsonb_build_object('ok',false,'error','forbidden'); end if;
 select * into v_row from public.aquariums where id=p_id;
 return jsonb_build_object('ok',true,'data',jsonb_build_object('aquarium_id',p_id,'revision',v_row.revision,
 'role',v_role,'state_json',v_row.state_json,'last_growth_at',v_row.last_growth_at));
end $$;
create or replace function public.shared_probe(p_id uuid) returns jsonb
language sql stable security definer set search_path=public,pg_temp as $$
 select case when public.mofish_room_role(p_id) is null then jsonb_build_object('ok',false,'error','forbidden') else
 jsonb_build_object('ok',true,'data',jsonb_build_object('role',public.mofish_room_role(p_id),
 'revision',(select revision from public.aquariums where id=p_id))) end
$$;
create or replace function public.shared_list_members(p_id uuid) returns jsonb
language plpgsql stable security definer set search_path=public,pg_temp as $$
begin
 if public.mofish_room_role(p_id) is null then return jsonb_build_object('ok',false,'error','forbidden'); end if;
 return jsonb_build_object('ok',true,'data',(select coalesce(jsonb_agg(r),'[]'::jsonb) from (
 select u.id user_id,u.email,'owner'::text role from auth.users u join public.aquariums a on a.owner_id=u.id where a.id=p_id
 union all select u.id,u.email,m.role from public.mofish_members m join auth.users u on u.id=m.user_id where m.aquarium_id=p_id
 )r));
end $$;
create or replace function public.shared_list_invites(p_id uuid) returns jsonb
language plpgsql stable security definer set search_path=public,pg_temp as $$
begin
 if public.mofish_room_role(p_id) is distinct from 'owner' then return jsonb_build_object('ok',false,'error','forbidden'); end if;
 return jsonb_build_object('ok',true,'data',(select coalesce(jsonb_agg(r order by r.created_at desc),'[]'::jsonb) from (
 select id,email,role,expires_at,revoked_at,accepted_at,created_at from public.mofish_invites where aquarium_id=p_id order by created_at desc limit 40)r));
end $$;
create or replace function public.shared_create_invite(p_id uuid,p_email text,p_role text,p_hours integer default 24) returns jsonb
language plpgsql security definer set search_path=public,pg_temp as $$
declare v_token text;v_email text:=lower(btrim(p_email));v_id uuid;v_until timestamptz;
begin
 perform 1 from public.aquariums where id=p_id for update;
 if public.mofish_room_role(p_id) is distinct from 'owner' then return jsonb_build_object('ok',false,'error','forbidden'); end if;
 if p_role is null or p_role not in ('editor','viewer') or p_hours is null or p_hours<1 or p_hours>168 or v_email is null
 or length(v_email)>254 or v_email !~ '^[^[:space:]@]+@[^[:space:]@]+[.][^[:space:]@]+$'
 or exists(select 1 from auth.users where id=auth.uid() and lower(email)=v_email) then
 return jsonb_build_object('ok',false,'error','invalid_argument'); end if;
 if (select count(*) from public.mofish_invites where aquarium_id=p_id and created_at>now()-interval '24 hours')>=100 then
 return jsonb_build_object('ok',false,'error','rate_limited'); end if;
 update public.mofish_invites set revoked_at=now() where aquarium_id=p_id and email=v_email and revoked_at is null and accepted_at is null;
 v_token:=replace(gen_random_uuid()::text||gen_random_uuid()::text,'-','');v_until:=now()+make_interval(hours=>p_hours);
 insert into public.mofish_invites(aquarium_id,email,role,token_hash,expires_at)
 values(p_id,v_email,p_role,encode(sha256(convert_to(v_token,'UTF8')),'hex'),v_until) returning id into v_id;
 return jsonb_build_object('ok',true,'data',jsonb_build_object('id',v_id,'token',v_token,'expires_at',v_until));
end $$;
create or replace function public.shared_revoke_invite(p_id uuid,p_invite_id uuid) returns jsonb
language plpgsql security definer set search_path=public,pg_temp as $$
begin
 perform 1 from public.aquariums where id=p_id for update;
 if public.mofish_room_role(p_id) is distinct from 'owner' then return jsonb_build_object('ok',false,'error','forbidden'); end if;
 update public.mofish_invites set revoked_at=coalesce(revoked_at,now()) where aquarium_id=p_id and id=p_invite_id;
 return jsonb_build_object('ok',true);
end $$;
create or replace function public.shared_accept_invite(p_token text) returns jsonb
language plpgsql security definer set search_path=public,pg_temp as $$
declare v_i public.mofish_invites%rowtype;v_email text;v_confirmed timestamptz;
begin
 if auth.uid() is null then return jsonb_build_object('ok',false,'error','not_authenticated'); end if;
 if p_token is null or p_token !~ '^[0-9a-f]{64}$' then return jsonb_build_object('ok',false,'error','invalid_invite'); end if;
 -- Lock room first for consistent ordering with revoke/member writes/operations.
 select * into v_i from public.mofish_invites where token_hash=encode(sha256(convert_to(p_token,'UTF8')),'hex');
 if not found then return jsonb_build_object('ok',false,'error','invalid_invite'); end if;
 perform 1 from public.aquariums where id=v_i.aquarium_id for update;
 select * into v_i from public.mofish_invites where id=v_i.id for update;
 select lower(email),email_confirmed_at into v_email,v_confirmed from auth.users where id=auth.uid();
 if v_email is distinct from v_i.email or v_confirmed is null or v_i.revoked_at is not null or v_i.expires_at<=now()
 or (v_i.accepted_at is not null and v_i.accepted_by is distinct from auth.uid()) then
 return jsonb_build_object('ok',false,'error','invalid_invite'); end if;
 if v_i.accepted_at is not null then
   if public.mofish_room_role(v_i.aquarium_id) is null then return jsonb_build_object('ok',false,'error','invalid_invite'); end if;
   return jsonb_build_object('ok',true,'data',jsonb_build_object('aquarium_id',v_i.aquarium_id));
 end if;
 if public.mofish_room_role(v_i.aquarium_id)='owner' then return jsonb_build_object('ok',false,'error','invalid_invite'); end if;
 if (select count(*) from public.mofish_members where aquarium_id=v_i.aquarium_id)>=20 and not exists(
 select 1 from public.mofish_members where aquarium_id=v_i.aquarium_id and user_id=auth.uid()) then return jsonb_build_object('ok',false,'error','member_limit'); end if;
 insert into public.mofish_members(aquarium_id,user_id,role) values(v_i.aquarium_id,auth.uid(),v_i.role)
 on conflict(aquarium_id,user_id) do update set role=excluded.role;
 update public.mofish_invites set accepted_at=now(),accepted_by=auth.uid() where id=v_i.id;
 update public.aquariums set revision=revision+1 where id=v_i.aquarium_id;
 return jsonb_build_object('ok',true,'data',jsonb_build_object('aquarium_id',v_i.aquarium_id));
end $$;
create or replace function public.shared_manage_member(p_id uuid,p_user_id uuid,p_role text default null) returns jsonb
language plpgsql security definer set search_path=public,pg_temp as $$
begin
 perform 1 from public.aquariums where id=p_id for update;
 if public.mofish_room_role(p_id) is distinct from 'owner' or p_user_id is null or p_user_id=auth.uid() then return jsonb_build_object('ok',false,'error','forbidden'); end if;
 if p_role is not null and p_role not in ('editor','viewer') then return jsonb_build_object('ok',false,'error','invalid_argument'); end if;
 if p_role is null then
 delete from public.mofish_members where aquarium_id=p_id and user_id=p_user_id;
 update public.mofish_invites set revoked_at=now() where aquarium_id=p_id and email=(select lower(email) from auth.users where id=p_user_id) and revoked_at is null;
 else update public.mofish_members set role=p_role where aquarium_id=p_id and user_id=p_user_id; end if;
 update public.aquariums set revision=revision+1 where id=p_id;
 return jsonb_build_object('ok',true);
end $$;
create or replace function public.shared_leave_aquarium(p_id uuid) returns jsonb
language plpgsql security definer set search_path=public,pg_temp as $$
begin
 perform 1 from public.aquariums where id=p_id for update;
 if public.mofish_room_role(p_id) is null or public.mofish_room_role(p_id)='owner' then return jsonb_build_object('ok',false,'error','forbidden'); end if;
 delete from public.mofish_members where aquarium_id=p_id and user_id=auth.uid();
 update public.mofish_invites set revoked_at=now() where aquarium_id=p_id and accepted_by=auth.uid() and revoked_at is null;
 update public.aquariums set revision=revision+1 where id=p_id;
 return jsonb_build_object('ok',true);
end $$;

create or replace function public.shared_apply_operations(p_id uuid,p_operation_id uuid,p_operations jsonb) returns jsonb
language plpgsql security definer set search_path=public,pg_temp as $$
declare v_row public.aquariums%rowtype;v_existing public.mofish_room_operations%rowtype;
v_state jsonb;v_op jsonb;v_item jsonb;v_value jsonb;v_kind text;v_key text;v_id text;v_idx integer;v_error text;
begin
 if auth.uid() is null then return jsonb_build_object('ok',false,'error','not_authenticated'); end if;
 select * into v_row from public.aquariums where id=p_id for update;
 if not found or coalesce(public.mofish_room_role(p_id),'') not in ('owner','editor') then return jsonb_build_object('ok',false,'error','forbidden'); end if;
 if p_operation_id is null or jsonb_typeof(p_operations) is distinct from 'array' then return jsonb_build_object('ok',false,'error','invalid_operation'); end if;
 if jsonb_array_length(p_operations)<1 or jsonb_array_length(p_operations)>100 or pg_column_size(p_operations)>32768 then
 return jsonb_build_object('ok',false,'error','invalid_operation'); end if;
 select * into v_existing from public.mofish_room_operations where aquarium_id=p_id and operation_id=p_operation_id;
 if found then
 if v_existing.actor_id<>auth.uid() or v_existing.operations<>p_operations then return jsonb_build_object('ok',false,'error','operation_mismatch'); end if;
 return public.shared_get_aquarium(p_id)||jsonb_build_object('duplicate',true);
 end if;
 if v_row.state_version<>2 then return jsonb_build_object('ok',false,'error','upgrade_required'); end if;
 if (select count(*) from public.mofish_room_operations where aquarium_id=p_id and created_at>now()-interval '24 hours')>=5000 then
 return jsonb_build_object('ok',false,'error','rate_limited'); end if;
 v_state:=v_row.state_json;
 for v_op in select value from jsonb_array_elements(p_operations) loop
 if jsonb_typeof(v_op) is distinct from 'object' then return jsonb_build_object('ok',false,'error','invalid_operation'); end if;
 v_kind:=v_op->>'kind';v_item:=null;v_idx:=null;
 if v_kind='set_night' then
 if jsonb_typeof(v_op->'value') is distinct from 'boolean' or jsonb_typeof(v_op->'before') is distinct from 'boolean' then
 return jsonb_build_object('ok',false,'error','invalid_operation'); end if;
 if v_state->'night' is distinct from v_op->'before' then return jsonb_build_object('ok',false,'error','conflict'); end if;
 v_state:=jsonb_set(v_state,'{night}',v_op->'value');continue;
 end if;
 if v_kind not in ('fish_add','fish_remove','fish_rename','decor_add','decor_update','decor_remove') or v_kind is null then
 return jsonb_build_object('ok',false,'error','invalid_operation'); end if;
 v_key:=case when v_kind like 'fish_%' then 'fish' else 'decor' end;
 v_value:=case when v_kind='fish_add' then v_op->'fish' else v_op->'decor' end;
 v_id:=case when v_kind in ('fish_add','decor_add') then v_value->>'id' else v_op->>'id' end;
 if v_id is null or length(v_id)<1 or length(v_id)>100 then return jsonb_build_object('ok',false,'error','invalid_operation'); end if;
 select e.value,(e.ord-1)::integer into v_item,v_idx from jsonb_array_elements(v_state->v_key) with ordinality e(value,ord) where e.value->>'id'=v_id;
 if v_kind in ('fish_add','decor_add') then
 if jsonb_typeof(v_value) is distinct from 'object' then return jsonb_build_object('ok',false,'error','invalid_operation'); end if;
 if v_kind='fish_add' and (v_value->'growth' is distinct from '0'::jsonb or v_value->'meals' is distinct from '0'::jsonb) then
 return jsonb_build_object('ok',false,'error','server_growth_only'); end if;
 if v_item is not null then
 if (case when v_key='fish' then v_item-'growth'-'meals' else v_item end) is distinct from
 (case when v_key='fish' then v_value-'growth'-'meals' else v_value end) then return jsonb_build_object('ok',false,'error','conflict'); end if;
 else v_state:=jsonb_set(v_state,array[v_key],(v_state->v_key)||jsonb_build_array(v_value)); end if;
 elsif v_kind='fish_rename' then
 if v_item is null or v_item->'name' is distinct from v_op->'before' then return jsonb_build_object('ok',false,'error','conflict'); end if;
 if jsonb_typeof(v_op->'name') is distinct from 'string' then return jsonb_build_object('ok',false,'error','invalid_operation'); end if;
 v_state:=jsonb_set(v_state,array[v_key,v_idx::text,'name'],v_op->'name');
 else
 if v_item is null or (case when v_key='fish' then v_item-'growth'-'meals' else v_item end) is distinct from v_op->'before' then
 return jsonb_build_object('ok',false,'error','conflict'); end if;
 if v_kind='decor_update' then
 if v_value->>'id' is distinct from v_id then return jsonb_build_object('ok',false,'error','invalid_operation'); end if;
 v_state:=jsonb_set(v_state,array[v_key,v_idx::text],v_value);
 else v_state:=jsonb_set(v_state,array[v_key],(v_state->v_key)-v_idx);end if;
 end if;
 end loop;
 v_state:=jsonb_set(v_state,'{savedAt}',to_jsonb(floor(extract(epoch from now())*1000)::bigint));
 v_error:=public.mofish_state_error_v2(v_state);
 if v_error is not null or pg_column_size(v_state)>32768 then return jsonb_build_object('ok',false,'error','invalid_state','code',v_error); end if;
 insert into public.mofish_room_operations(aquarium_id,operation_id,actor_id,operations) values(p_id,p_operation_id,auth.uid(),p_operations);
 update public.aquariums set state_json=v_state,revision=revision+1,updated_at=now() where id=p_id;
 return public.shared_get_aquarium(p_id)||jsonb_build_object('duplicate',false);
end $$;

-- Dedicated C wrappers preserve the original owner-only B RPC contract.
-- Growth/nutrition formulas are byte-for-byte B logic except current-member authorization.
create or replace function public.shared_record_feeding(
  p_id           uuid,
  p_operation_id uuid,
  p_fish_id      text,
  p_bites        integer default 1
)
returns table (status text, credited integer, duplicate boolean, error_code text)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid    uuid := auth.uid();
  v_recent integer;
  v_row_id uuid;
  v_existing public.mofish_feed_events%rowtype;
begin
  if v_uid is null then
    return query select 'not_authenticated', 0, false, 'not_authenticated'::text;
    return;
  end if;

  if p_id is null or p_operation_id is null or p_fish_id is null
     or length(p_fish_id) < 1 or length(p_fish_id) > 100
     or p_bites is null or p_bites < 1 or p_bites > 8 then
    return query select 'invalid_argument', 0, false, 'bad_arguments'::text;
    return;
  end if;

  -- 归属 + 鱼必须确实在这条鱼缸里（不区分「不存在」与「不是我的」，避免泄露）
  -- Use the same aquarium row lock as settlement/save: checking the daily
  -- limit and accepting a feeding event must be atomic across connections.
  perform 1
    from public.aquariums a
   where a.id = p_id and coalesce(public.mofish_room_role(p_id),'') in ('owner','editor')
     and exists (select 1 from jsonb_array_elements(a.state_json->'fish') f where f->>'id' = p_fish_id)
   for update;

  if not found or coalesce(public.mofish_room_role(p_id),'') not in ('owner','editor') then
    return query select 'not_found', 0, false, 'fish_or_aquarium_not_found'::text;
    return;
  end if;

  -- Confirm an acknowledged request before rate limiting its retries. Reusing
  -- the ID with a different payload is not an idempotent retry.
  select * into v_existing from public.mofish_feed_events e
   where e.aquarium_id = p_id and e.operation_id = p_operation_id;
  if found then
    if v_existing.fish_id <> p_fish_id or v_existing.bites <> p_bites then
      return query select 'invalid_argument', 0, false, 'operation_mismatch'::text;
    else
      return query select 'ok', 0, true, null::text;
    end if;
    return;
  end if;

  -- 防滥用：单缸 24 小时内最多 500 条事件（远超正常喂食量）
  select count(*) into v_recent
    from public.mofish_feed_events e
   where e.aquarium_id = p_id
     and e.created_at > now() - interval '24 hours';
  if v_recent >= 500 then
    return query select 'rate_limited', 0, false, 'too_many_feed_events'::text;
    return;
  end if;

  insert into public.mofish_feed_events (aquarium_id, operation_id, fish_id, bites)
  values (p_id, p_operation_id, p_fish_id, p_bites)
  on conflict (aquarium_id, operation_id) do nothing
  returning id into v_row_id;

  if v_row_id is null then
    -- 重复提交（重试/双端重放）：幂等返回，不再记一次
    return query select 'ok', 0, true, null::text;
    return;
  end if;

  return query select 'ok', 0, false, null::text;
end $$;


create or replace function public.shared_settle_growth(
  p_id          uuid,
  p_cap_seconds integer default 86400
)
returns table (status text, revision bigint, credited_seconds integer,
               state_json jsonb, last_growth_at timestamptz, error_code text)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid       uuid := auth.uid();
  v_row       public.aquariums%rowtype;
  v_secs      integer;
  v_event     record;
  v_used      integer;
  v_credit    integer;
  v_growth    jsonb := '{}'::jsonb;
  v_meals     jsonb := '{}'::jsonb;
  v_natural   numeric;
  v_pending   boolean := false;
begin
  if v_uid is null then
    return query select 'not_authenticated', null::bigint, 0, null::jsonb, null::timestamptz, 'not_authenticated'::text;
    return;
  end if;

  if p_id is null or p_cap_seconds is null or p_cap_seconds < 0 or p_cap_seconds > 604800 then
    return query select 'invalid_argument', null::bigint, 0, null::jsonb, null::timestamptz, 'bad_arguments'::text;
    return;
  end if;

  select a.* into v_row
    from public.aquariums a
   where a.id = p_id
     and coalesce(public.mofish_room_role(p_id),'') in ('owner','editor')
     for update;

  if not found or coalesce(public.mofish_room_role(p_id),'') not in ('owner','editor') then
    return query select 'not_found', null::bigint, 0, null::jsonb, null::timestamptz, 'aquarium_not_found'::text;
    return;
  end if;

  v_secs := floor(extract(epoch from (now() - v_row.last_growth_at)))::integer;
  if v_secs < 0 then v_secs := 0; end if;
  if v_secs > p_cap_seconds then v_secs := p_cap_seconds; end if;

  select exists (
    select 1 from public.mofish_feed_events e
     where e.aquarium_id = p_id and e.applied_at is null
  ) into v_pending;

  if v_secs < 1 and not v_pending then
    return query select 'ok', v_row.revision, 0, v_row.state_json, v_row.last_growth_at, null::text;
    return;
  end if;

  -- 时间成长：v1 旧档保持每小时 0.008（0.192/天）；v2 新档 0.05/24h（约 14 天成年）。
  if v_row.state_version = 1 then
    v_natural := v_secs::numeric * (0.008 / 3600.0);
  else
    v_natural := v_secs::numeric * (0.05 / 86400.0);
  end if;

  -- 营养成长：未应用的进食事件按时间顺序结算，每鱼滚动 24 小时最多 3 口，每口 0.02/3。
  for v_event in
    select e.id, e.fish_id, e.bites, e.created_at
      from public.mofish_feed_events e
     where e.aquarium_id = p_id and e.applied_at is null
     order by e.created_at, e.id
  loop
    select coalesce(sum(e.credited), 0) into v_used
      from public.mofish_feed_events e
     where e.aquarium_id = p_id
       and e.fish_id = v_event.fish_id
       and e.applied_at is not null
       and e.created_at > v_event.created_at - interval '24 hours';

    v_credit := greatest(0, least(v_event.bites, 3 - v_used));

    update public.mofish_feed_events e
       set credited = v_credit, applied_at = now()
     where e.id = v_event.id;

    v_growth := jsonb_set(
      v_growth,
      array[v_event.fish_id],
      to_jsonb(coalesce((v_growth->>v_event.fish_id)::numeric, 0) + v_credit * (0.02 / 3.0))
    );
    v_meals := jsonb_set(
      v_meals,
      array[v_event.fish_id],
      to_jsonb(coalesce((v_meals->>v_event.fish_id)::numeric, 0) + v_event.bites)
    );
  end loop;

  update public.aquariums a
     set state_json = jsonb_set(
           a.state_json,
           '{fish}',
           coalesce((
             select jsonb_agg(
                      jsonb_set(
                        jsonb_set(
                          f,
                          '{growth}',
                          to_jsonb(round(least(1.0, greatest(0.0,
                            coalesce((f->>'growth')::numeric, 0)
                            + v_natural
                            + coalesce((v_growth->>(f->>'id'))::numeric, 0)
                          )), 6))
                        ),
                        '{meals}',
                        to_jsonb(((case when jsonb_typeof(f->'meals') = 'number' then (f->>'meals')::numeric else 0 end)
                          + coalesce((v_meals->>(f->>'id'))::numeric, 0))::bigint)
                      ) order by ord
                    )
             from jsonb_array_elements(a.state_json->'fish') with ordinality as t(f, ord)
           ), '[]'::jsonb)
         ),
         revision       = a.revision + 1,
         last_growth_at = now(),
         updated_at     = now()
   where a.id = p_id
     and coalesce(public.mofish_room_role(p_id),'') in ('owner','editor')
   returning a.revision, a.state_json, a.last_growth_at
        into v_row.revision, v_row.state_json, v_row.last_growth_at;

  if not found or coalesce(public.mofish_room_role(p_id),'') not in ('owner','editor') then
    return query select 'not_found', null::bigint, 0, null::jsonb, null::timestamptz, 'aquarium_not_found'::text;
    return;
  end if;

  return query select 'ok', v_row.revision, v_secs, v_row.state_json, v_row.last_growth_at, null::text;
end $$;



-- Every security-definer RPC has a fixed search_path and explicit public/anon revocation.
revoke all on function public.shared_list_aquariums() from public,anon;
grant execute on function public.shared_list_aquariums() to authenticated;
revoke all on function public.shared_get_aquarium(uuid) from public,anon;
grant execute on function public.shared_get_aquarium(uuid) to authenticated;
revoke all on function public.shared_probe(uuid) from public,anon;
grant execute on function public.shared_probe(uuid) to authenticated;
revoke all on function public.shared_list_members(uuid) from public,anon;
grant execute on function public.shared_list_members(uuid) to authenticated;
revoke all on function public.shared_list_invites(uuid) from public,anon;
grant execute on function public.shared_list_invites(uuid) to authenticated;
revoke all on function public.shared_create_invite(uuid,text,text,integer) from public,anon;
grant execute on function public.shared_create_invite(uuid,text,text,integer) to authenticated;
revoke all on function public.shared_revoke_invite(uuid,uuid) from public,anon;
grant execute on function public.shared_revoke_invite(uuid,uuid) to authenticated;
revoke all on function public.shared_accept_invite(text) from public,anon;
grant execute on function public.shared_accept_invite(text) to authenticated;
revoke all on function public.shared_manage_member(uuid,uuid,text) from public,anon;
grant execute on function public.shared_manage_member(uuid,uuid,text) to authenticated;
revoke all on function public.shared_leave_aquarium(uuid) from public,anon;
grant execute on function public.shared_leave_aquarium(uuid) to authenticated;
revoke all on function public.shared_apply_operations(uuid,uuid,jsonb) from public,anon;
grant execute on function public.shared_apply_operations(uuid,uuid,jsonb) to authenticated;
revoke all on function public.shared_record_feeding(uuid,uuid,text,integer) from public,anon;
grant execute on function public.shared_record_feeding(uuid,uuid,text,integer) to authenticated;
revoke all on function public.shared_settle_growth(uuid,integer) from public,anon;
grant execute on function public.shared_settle_growth(uuid,integer) to authenticated;

-- Personal B saves retain their contract; active collaborative rooms forbid whole snapshots.
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

  -- Serialize with member accept/revoke before deciding whether a whole save is allowed.
  perform 1 from public.aquariums where id=p_id and owner_id=v_uid for update;
  if exists(select 1 from public.mofish_members where aquarium_id=p_id) then
    return query select 'invalid_argument',null::bigint,null::timestamptz,'shared_requires_operations'::text;
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

