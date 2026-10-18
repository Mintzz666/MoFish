-- 回滚 0002（阶段 B：存档 v2 + 进食记账）。
--
-- ⚠️ 这是人工执行的回滚脚本，迁移流程不会自动调用它。
-- 顺序要求：
--   1) 先把前端回滚到 v1 版本（或确认线上只有 v1 客户端）；
--   2) 再把云端 state_version=2 的存档导出并转回 v1（否则旧前端会拒绝该存档）；
--   3) 最后执行本脚本。
-- 数据影响：删除进食事件表（营养记账历史随之消失，鱼已有的 growth/meals 保留在 state_json 里）。

-- Keep psql/autocommit execution atomic too. Refuse before dropping any event
-- history if v2 saves have not been exported and converted deliberately.
begin;
do $$
begin
  if exists (select 1 from public.aquariums where state_version <> 1 or state_json->>'version' is distinct from '1') then
    raise exception 'phase_b_rollback_requires_v1: export and convert v2 saves before rollback';
  end if;
end $$;

-- 1) 收回 v2 专属函数权限并删除函数
revoke all on function public.record_feeding(uuid, uuid, text, integer) from authenticated;
drop function if exists public.record_feeding(uuid, uuid, text, integer);

-- 2) 删除进食事件表
drop table if exists public.mofish_feed_events;

-- 3) 还原成长结算为阶段 A 的公式（每小时 0.008，无营养项）
create or replace function public.settle_growth(
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
  v_uid    uuid := auth.uid();
  v_row    public.aquariums%rowtype;
  v_secs   integer;
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
   where a.id = p_id and a.owner_id = v_uid
     for update;

  if not found then
    return query select 'not_found', null::bigint, 0, null::jsonb, null::timestamptz, 'aquarium_not_found'::text;
    return;
  end if;

  v_secs := floor(extract(epoch from (now() - v_row.last_growth_at)))::integer;
  if v_secs < 0 then v_secs := 0; end if;
  if v_secs > p_cap_seconds then v_secs := p_cap_seconds; end if;

  if v_secs < 1 then
    return query select 'ok', v_row.revision, 0, v_row.state_json, v_row.last_growth_at, null::text;
    return;
  end if;

  update public.aquariums a
     set state_json = jsonb_set(
           a.state_json,
           '{fish}',
           coalesce((
             select jsonb_agg(
                      jsonb_set(
                        f,
                        '{growth}',
                        to_jsonb(round(
                          least(1.0, greatest(0.0,
                            (case when jsonb_typeof(f->'growth') = 'number' then (f->>'growth')::numeric else 0 end)
                            + ((v_secs::numeric / 3600.0) * 0.008)
                          )),
                          6))
                      ) order by ord
                    )
             from jsonb_array_elements(a.state_json->'fish') with ordinality as t(f, ord)
           ), '[]'::jsonb)
         ),
         revision       = a.revision + 1,
         last_growth_at = now(),
         updated_at     = now()
   where a.id = p_id and a.owner_id = v_uid
   returning a.revision, a.state_json, a.last_growth_at
        into v_row.revision, v_row.state_json, v_row.last_growth_at;

  if not found then
    return query select 'not_found', null::bigint, 0, null::jsonb, null::timestamptz, 'aquarium_not_found'::text;
    return;
  end if;

  return query select 'ok', v_row.revision, v_secs, v_row.state_json, v_row.last_growth_at, null::text;
end $$;

-- 4) 还原保存函数：只接受 v1，使用原校验函数
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

  if p_state_version is null or p_state_version <> 1 then
    return query select 'invalid_argument', null::bigint, null::timestamptz, 'unsupported_state_version'::text;
    return;
  end if;

  v_error := public.mofish_state_error(p_state);
  if v_error is not null then
    return query select 'invalid_state', null::bigint, null::timestamptz, v_error;
    return;
  end if;

  if pg_column_size(p_state) > 32768 then
    return query select 'invalid_state', null::bigint, null::timestamptz, 'state_too_large'::text;
    return;
  end if;

  update public.aquariums a
     set state_json = p_state, state_version = p_state_version,
         revision = a.revision + 1, updated_at = now()
   where a.id = p_id and a.owner_id = v_uid and a.revision = p_expected_revision
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

create or replace function public.ensure_aquarium(
  p_initial_state jsonb,
  p_state_version integer default 1
)
returns table (status text, aquarium_id uuid, revision bigint, state_json jsonb,
               last_growth_at timestamptz, created boolean, error_code text)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid      uuid := auth.uid();
  v_error    text;
  v_row      public.aquariums%rowtype;
  v_created  boolean := false;
begin
  if v_uid is null then
    return query select 'not_authenticated', null::uuid, null::bigint, null::jsonb, null::timestamptz, false, 'not_authenticated'::text;
    return;
  end if;

  if p_state_version is null or p_state_version <> 1 then
    return query select 'invalid_argument', null::uuid, null::bigint, null::jsonb, null::timestamptz, false, 'unsupported_state_version'::text;
    return;
  end if;

  v_error := public.mofish_state_error(p_initial_state);
  if v_error is not null then
    return query select 'invalid_state', null::uuid, null::bigint, null::jsonb, null::timestamptz, false, v_error;
    return;
  end if;

  insert into public.aquariums (owner_id, state_json, state_version)
  values (v_uid, p_initial_state, p_state_version)
  on conflict (owner_id) do nothing
  returning * into v_row;

  if found then
    v_created := true;
  else
    select a.* into v_row from public.aquariums a where a.owner_id = v_uid;
  end if;

  if v_row.id is null then
    return query select 'not_found', null::uuid, null::bigint, null::jsonb, null::timestamptz, false, 'aquarium_not_found'::text;
    return;
  end if;

  return query select 'ok', v_row.id, v_row.revision, v_row.state_json, v_row.last_growth_at, v_created, null::text;
end $$;

-- 5) 还原动态校验函数
drop function if exists public.mofish_state_error_any(jsonb);
drop function if exists public.mofish_state_error_v2(jsonb);

-- 6) 约束改回只允许 v1（只有在确认没有 v2 存档后才能执行）
alter table public.aquariums drop constraint if exists aquariums_state_version_supported;
alter table public.aquariums add constraint aquariums_state_version_supported check (state_version = 1);

revoke all on function public.save_aquarium(uuid, bigint, jsonb, integer) from public;
revoke all on function public.save_aquarium(uuid, bigint, jsonb, integer) from anon;
revoke all on function public.ensure_aquarium(jsonb, integer) from public;
revoke all on function public.ensure_aquarium(jsonb, integer) from anon;
revoke all on function public.settle_growth(uuid, integer) from public;
revoke all on function public.settle_growth(uuid, integer) from anon;
grant execute on function public.save_aquarium(uuid, bigint, jsonb, integer) to authenticated;
grant execute on function public.ensure_aquarium(jsonb, integer) to authenticated;
grant execute on function public.settle_growth(uuid, integer) to authenticated;

commit;
