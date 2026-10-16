-- MoFish 阶段 A：邮箱账号 + 云端鱼缸存档
-- 目标：每个账号一条鱼缸记录；只有 owner 本人可读写；写入按 revision 原子条件更新；
--       离线成长由服务端时间结算，最多 24 小时，重复调用不重复结算。
--
-- 约定：本文件必须整份在一个事务里应用（Supabase 迁移默认如此）。
-- 幂等：① 首次应用 ② 再次应用（无操作）③ 迁移被部分回滚后重放
--
-- 依赖：Supabase 预置的 auth schema、auth.uid()、authenticated / anon 角色、
--       扩展 pgcrypto（gen_random_uuid）。

-- ---------------------------------------------------------------- 凭证校验工具

-- 返回 null 表示存档结构合法；否则返回稳定的错误码（供前端提示，不返回用户数据）。
create or replace function public.mofish_state_error(p_state jsonb)
returns text
language plpgsql
immutable
set search_path = public, pg_temp
as $$
declare
  v_count integer;
  v_fish  jsonb;
  v_growth numeric;
  v_meals numeric;
  v_born numeric;
  v_species numeric;
  v_plants numeric;
begin
  if p_state is null or jsonb_typeof(p_state) <> 'object' then
    return 'state_not_object';
  end if;

  -- 状态结构版本：阶段 A 只接受 1。新增版本必须同时提供迁移脚本，不能就地放宽。
  if p_state->'version' is distinct from '1'::jsonb then
    return 'unsupported_state_version';
  end if;

  if jsonb_typeof(p_state->'fish') <> 'array' then
    return 'fish_not_array';
  end if;
  v_count := jsonb_array_length(p_state->'fish');
  if v_count < 1 then return 'fish_count_below_min'; end if;
  if v_count > 12 then return 'fish_count_above_max'; end if;

  v_plants := case when jsonb_typeof(p_state->'plants') = 'number' then (p_state->>'plants')::numeric end;
  if v_plants is null or v_plants <> trunc(v_plants) or v_plants < 0 or v_plants > 8 then
    return 'plants_out_of_range';
  end if;

  if jsonb_typeof(p_state->'night') not in ('boolean') then return 'night_not_boolean'; end if;
  if jsonb_typeof(p_state->'sound') not in ('boolean') then return 'sound_not_boolean'; end if;
  if jsonb_typeof(p_state->'savedAt') <> 'number' then return 'saved_at_not_number'; end if;

  for v_fish in select value from jsonb_array_elements(p_state->'fish') loop
    if jsonb_typeof(v_fish) <> 'object' then return 'fish_not_object'; end if;

    if jsonb_typeof(v_fish->'id') <> 'string'
       or length(v_fish->>'id') < 1
       or length(v_fish->>'id') > 100 then
      return 'fish_id_invalid';
    end if;

    if jsonb_typeof(v_fish->'name') <> 'string' or length(v_fish->>'name') > 16 then
      return 'fish_name_invalid';
    end if;

    v_species := case when jsonb_typeof(v_fish->'species') = 'number' then (v_fish->>'species')::numeric end;
    if v_species is null or v_species <> trunc(v_species) or v_species < 0 or v_species > 3 then
      return 'fish_species_out_of_range';
    end if;

    v_born := case when jsonb_typeof(v_fish->'born') = 'number' then (v_fish->>'born')::numeric end;
    -- 允许 0（历史存档）；上限 2100-01-01，防止客户端把时间戳放大到失控值。
    if v_born is null or v_born < 0 or v_born > 4102444800000 then
      return 'fish_born_out_of_range';
    end if;

    v_growth := case when jsonb_typeof(v_fish->'growth') = 'number' then (v_fish->>'growth')::numeric end;
    if v_growth is null or v_growth < 0 or v_growth > 1 then
      return 'fish_growth_out_of_range';
    end if;

    v_meals := case when jsonb_typeof(v_fish->'meals') = 'number' then (v_fish->>'meals')::numeric end;
    if v_meals is null or v_meals < 0 or v_meals <> trunc(v_meals) or v_meals > 1000000 then
      return 'fish_meals_out_of_range';
    end if;
  end loop;

  return null;
end $$;

comment on function public.mofish_state_error(jsonb) is
  'MoFish 存档结构校验（服务端权威）。返回 null 表示合法，否则返回稳定错误码。';

-- ---------------------------------------------------------------- 数据表

create table if not exists public.aquariums (
  id              uuid        primary key default gen_random_uuid(),
  owner_id        uuid        not null references auth.users (id) on delete cascade,
  revision        bigint      not null default 1,
  state_version   integer     not null default 1,
  state_json      jsonb       not null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  -- 成长结算锚点：已结算到哪一刻（服务端时间）。结算时整秒向前推进，余数丢弃。
  last_growth_at  timestamptz not null default now(),
  constraint aquariums_revision_positive check (revision >= 1),
  constraint aquariums_state_version_supported check (state_version = 1),
  constraint aquariums_state_is_object check (jsonb_typeof(state_json) = 'object'),
  constraint aquariums_state_size check (pg_column_size(state_json) <= 32768)
);

comment on table public.aquariums is
  'MoFish 云端鱼缸存档。阶段 A：一个账号一条鱼缸；阶段 B 引入 aquarium_members 时需同步调整唯一索引与策略。';
comment on column public.aquariums.revision is
  '每次成功写入 +1；客户端必须带 expected_revision 做条件更新，冲突时返回当前值。';
comment on column public.aquariums.last_growth_at is
  '离线成长结算锚点（服务端时间）。只由 settle_growth 推进，save_aquarium 不改动它。';

-- 阶段 A：每个账号恰好一条鱼缸，使首次登录的开缸动作可幂等重放。
-- 阶段 B（多人共享）必须改为 (owner_id, id) 之外的成员关系表，届时删除本索引并新增迁移。
create unique index if not exists aquariums_owner_phase_a_uidx
  on public.aquariums (owner_id);

create index if not exists aquariums_owner_updated_idx
  on public.aquariums (owner_id, updated_at desc);

-- ---------------------------------------------------------------- RLS

alter table public.aquariums enable row level security;

drop policy if exists aquariums_select_own on public.aquariums;
create policy aquariums_select_own on public.aquariums
  for select to authenticated
  using (owner_id = auth.uid());

drop policy if exists aquariums_insert_own on public.aquariums;
create policy aquariums_insert_own on public.aquariums
  for insert to authenticated
  with check (owner_id = auth.uid());

drop policy if exists aquariums_update_own on public.aquariums;
create policy aquariums_update_own on public.aquariums
  for update to authenticated
  using (owner_id = auth.uid())
  with check (owner_id = auth.uid());

drop policy if exists aquariums_delete_own on public.aquariums;
create policy aquariums_delete_own on public.aquariums
  for delete to authenticated
  using (owner_id = auth.uid());

revoke all on public.aquariums from anon;
revoke all on public.aquariums from public;
grant select, insert, update, delete on public.aquariums to authenticated;

-- ---------------------------------------------------------------- 编写鱼缸：原子 revision 条件更新

create or replace function public.save_aquarium(
  p_id                uuid,
  p_expected_revision bigint,
  p_state             jsonb,
  p_state_version     integer default 1
)
returns table (status text, revision bigint, updated_at timestamptz, error_code text)
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_uid     uuid := auth.uid();
  v_error   text;
  v_new_rev bigint;
  v_new_at  timestamptz;
  v_current bigint;
begin
  -- 身份：不接受由客户端指定的 owner，一律以 JWT 的 sub 为准。
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

  -- 参数校验：服务端权威，不依赖前端隐藏按钮。
  v_error := public.mofish_state_error(p_state);
  if v_error is not null then
    return query select 'invalid_state', null::bigint, null::timestamptz, v_error;
    return;
  end if;

  if pg_column_size(p_state) > 32768 then
    return query select 'invalid_state', null::bigint, null::timestamptz, 'state_too_large'::text;
    return;
  end if;

  -- 条件更新：revision 不匹配即 0 行受影响，构成原子冲突检测（不覆盖他人/自己的新版本）。
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

  -- 区分「不存在/不属于我」与「版本冲突」。RLS 保证这里只会读到自己的行。
  select a.revision into v_current from public.aquariums a where a.id = p_id;

  if v_current is null then
    return query select 'not_found', null::bigint, null::timestamptz, 'aquarium_not_found'::text;
  else
    return query select 'conflict', v_current, null::timestamptz, 'revision_conflict'::text;
  end if;
end $$;

comment on function public.save_aquarium(uuid, bigint, jsonb, integer) is
  '原子保存：仅当 revision 匹配且 owner=auth.uid() 时写入。返回 ok/conflict/not_found/invalid_state/invalid_argument/not_authenticated。';

-- ---------------------------------------------------------------- 开缸：幂等

create or replace function public.ensure_aquarium(
  p_initial_state jsonb,
  p_state_version integer default 1
)
returns table (status text, aquarium_id uuid, revision bigint, state_json jsonb,
               last_growth_at timestamptz, created boolean, error_code text)
language plpgsql
security invoker
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

  -- on conflict do nothing 时不会返回行，据此判断「这次真的开了新缸」还是「云端已有鱼缸」。
  -- 客户端正是靠 created 决定要不要弹出「本机存档 vs 云端存档」的选择，而不是静默覆盖。
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

comment on function public.ensure_aquarium(jsonb, integer) is
  '幂等开缸：不存在则按给定初始存档创建（created=true），存在则返回现有鱼缸（created=false）。重复调用不产生第二条记录。';

-- ---------------------------------------------------------------- 成长结算：服务端时间，幂等

create or replace function public.settle_growth(
  p_id          uuid,
  p_cap_seconds integer default 86400
)
returns table (status text, revision bigint, credited_seconds integer,
               state_json jsonb, last_growth_at timestamptz, error_code text)
language plpgsql
security invoker
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

  select a.* into v_row from public.aquariums a where a.id = p_id;
  if not found then
    return query select 'not_found', null::bigint, 0, null::jsonb, null::timestamptz, 'aquarium_not_found'::text;
    return;
  end if;

  -- 整秒计算：不足 1 秒的余数不结算（也不推进锚点），因此短时间内重复调用完全无副作用。
  v_secs := floor(extract(epoch from (now() - v_row.last_growth_at)))::integer;
  if v_secs < 0 then v_secs := 0; end if;                       -- 服务端时钟异常时视为无可结算
  if v_secs > p_cap_seconds then v_secs := p_cap_seconds; end if;

  if v_secs < 1 then
    -- 不写入、不提升 revision：重复请求不会重复奖励，也不会制造无意义的冲突。
    return query select 'ok', v_row.revision, 0, v_row.state_json, v_row.last_growth_at, null::text;
    return;
  end if;

  -- 成长规则与本地 model.catchUp 一致：每满 24 小时 +0.192（即每小时 0.008），上限 1。
  -- 结算后锚点推进到 now()，被 24 小时上限截掉的超出部分按设计丢弃（与本地 clamp 语义一致）。
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
                      )
                      order by ord
                    )
             from jsonb_array_elements(a.state_json->'fish') with ordinality as t(f, ord)
           ), '[]'::jsonb)
         ),
         revision       = a.revision + 1,
         last_growth_at = now(),
         updated_at     = now()
   where a.id = p_id
   returning a.revision, a.state_json, a.last_growth_at
        into v_row.revision, v_row.state_json, v_row.last_growth_at;

  if not found then
    return query select 'not_found', null::bigint, 0, null::jsonb, null::timestamptz, 'aquarium_not_found'::text;
    return;
  end if;

  return query select 'ok', v_row.revision, v_secs, v_row.state_json, v_row.last_growth_at, null::text;
end $$;

comment on function public.settle_growth(uuid, integer) is
  '按服务端时间结算离线成长（默认上限 24 小时=86400 秒）。整秒结算且锚点推进到 now()，重复调用不重复奖励。';

-- ---------------------------------------------------------------- 权限

-- 四个函数都只授予 authenticated：匿名 key 不能执行任何写入或读取逻辑。
revoke all on function public.mofish_state_error(jsonb) from public;
revoke all on function public.save_aquarium(uuid, bigint, jsonb, integer) from public;
revoke all on function public.ensure_aquarium(jsonb, integer) from public;
revoke all on function public.settle_growth(uuid, integer) from public;

-- mofish_state_error 必须授权给 authenticated：save_aquarium / ensure_aquarium 是
-- SECURITY INVOKER，调用者需要该函数的 EXECUTE 权限（撤销 PUBLIC 后必须显式补回）。
grant execute on function public.mofish_state_error(jsonb) to authenticated;
grant execute on function public.save_aquarium(uuid, bigint, jsonb, integer) to authenticated;
grant execute on function public.ensure_aquarium(jsonb, integer) to authenticated;
grant execute on function public.settle_growth(uuid, integer) to authenticated;
