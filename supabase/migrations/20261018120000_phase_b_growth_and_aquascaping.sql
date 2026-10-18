-- MoFish 阶段 B：存档 v2（多样鱼型/造景）、四阶段成长与进食记账。
--
-- 状态：**尚未应用到任何真实项目**。必须在部署 v2 前端之前先在目标项目执行；
-- 执行顺序见 docs/CLOUD-SETUP.md「阶段 B 迁移」。本文件只新增/替换函数与一张新表，
-- 不修改 A 已应用的两份迁移，也不放宽任何既有授权。
--
-- 向后兼容：
--   * 旧的 state_version=1 存档继续通过原有校验与旧成长速率结算（老客户端不会被新公式影响）；
--   * 新客户端写 state_version=2，走 mofish_state_error_v2 校验；
--   * 鱼的类型 id 变成字符串（如 'sunset'），造景从 plants 数量变成 decor 对象列表；
--   * 服务端在 settle_growth 里统一结算「时间成长 + 进食营养」，客户端不自行加营养，
--     因此重复请求 / 重连重试不会重复奖励。
--
-- 权限模型与 A 相同：authenticated 只能 SELECT 自己的 aquariums 行，所有写入只能走
-- SECURITY DEFINER 函数；新表 mofish_feed_events 对客户端完全不可见（只由函数读写）。

-- ---------------------------------------------------------------- v2 存档校验

create or replace function public.mofish_state_error_v2(p_state jsonb)
returns text
language plpgsql
immutable
set search_path = public, pg_temp
as $$
declare
  v_fish   jsonb;
  v_decor  jsonb;
  v_id     text;
  v_ids    text[] := array[]::text[];
  v_num    numeric;
  v_kind   text;
  v_plants integer := 0;
  v_rocks  integer := 0;
  v_woods  integer := 0;
begin
  if p_state is null then return 'state_missing'; end if;
  if jsonb_typeof(p_state) is distinct from 'object' then return 'state_not_object'; end if;

  if p_state->'version' is null then return 'version_missing'; end if;
  if jsonb_typeof(p_state->'version') is distinct from 'number' then return 'version_not_number'; end if;
  if (p_state->>'version')::numeric <> 2 then return 'unsupported_state_version'; end if;

  -- 鱼：1..12 条，每条有稳定 id、类型字符串、出生时间、成长、进食与外观种子。
  if p_state->'fish' is null then return 'fish_missing'; end if;
  if jsonb_typeof(p_state->'fish') is distinct from 'array' then return 'fish_not_array'; end if;
  if jsonb_array_length(p_state->'fish') < 1 then return 'fish_count_below_min'; end if;
  if jsonb_array_length(p_state->'fish') > 12 then return 'fish_count_above_max'; end if;

  for v_fish in select value from jsonb_array_elements(p_state->'fish') loop
    if jsonb_typeof(v_fish) is distinct from 'object' then return 'fish_not_object'; end if;

    if v_fish->'id' is null then return 'fish_id_missing'; end if;
    if jsonb_typeof(v_fish->'id') is distinct from 'string' then return 'fish_id_invalid'; end if;
    v_id := v_fish->>'id';
    if length(v_id) < 1 or length(v_id) > 100 then return 'fish_id_invalid'; end if;
    if v_id = any(v_ids) then return 'fish_id_duplicated'; end if;
    v_ids := v_ids || v_id;

    if v_fish->'name' is null then return 'fish_name_missing'; end if;
    if jsonb_typeof(v_fish->'name') is distinct from 'string' then return 'fish_name_invalid'; end if;
    if length(v_fish->>'name') > 16 then return 'fish_name_invalid'; end if;

    -- 类型必须是稳定字符串 id（不再是 0..3 的数字），长度与字符集受限，未知类型由客户端回退显示。
    if v_fish->'species' is null then return 'fish_species_missing'; end if;
    if jsonb_typeof(v_fish->'species') is distinct from 'string' then return 'fish_species_invalid'; end if;
    if (v_fish->>'species') !~ '^[a-z][a-z0-9_-]{1,31}$' then return 'fish_species_invalid'; end if;

    if v_fish->'born' is null then return 'fish_born_missing'; end if;
    if jsonb_typeof(v_fish->'born') is distinct from 'number' then return 'fish_born_invalid'; end if;
    v_num := (v_fish->>'born')::numeric;
    if v_num < 0 or v_num > 4102444800000 then return 'fish_born_out_of_range'; end if;

    if v_fish->'growth' is null then return 'fish_growth_missing'; end if;
    if jsonb_typeof(v_fish->'growth') is distinct from 'number' then return 'fish_growth_invalid'; end if;
    v_num := (v_fish->>'growth')::numeric;
    if v_num < 0 or v_num > 1 then return 'fish_growth_out_of_range'; end if;

    if v_fish->'meals' is null then return 'fish_meals_missing'; end if;
    if jsonb_typeof(v_fish->'meals') is distinct from 'number' then return 'fish_meals_invalid'; end if;
    v_num := (v_fish->>'meals')::numeric;
    if v_num < 0 or v_num <> trunc(v_num) or v_num > 1000000 then return 'fish_meals_out_of_range'; end if;

    -- 外观种子：同一条鱼在刷新/换设备/切画质后必须得到同一副颜色与花纹。
    if v_fish->'look' is null then return 'fish_look_missing'; end if;
    if jsonb_typeof(v_fish->'look') is distinct from 'object' then return 'fish_look_invalid'; end if;
    if v_fish->'look'->'seed' is null then return 'fish_look_invalid'; end if;
    if jsonb_typeof(v_fish->'look'->'seed') is distinct from 'number' then return 'fish_look_invalid'; end if;
    v_num := (v_fish->'look'->>'seed')::numeric;
    if v_num < 0 or v_num > 4294967295 or v_num <> trunc(v_num) then return 'fish_look_invalid'; end if;
    if v_fish->'look'->'v' is not null then
      if jsonb_typeof(v_fish->'look'->'v') is distinct from 'number' then return 'fish_look_invalid'; end if;
      v_num := (v_fish->'look'->>'v')::numeric;
      if v_num < 1 or v_num > 16 or v_num <> trunc(v_num) then return 'fish_look_invalid'; end if;
    end if;

    -- 游客存档里的营养窗口（可选）：最多 8 个时间戳。
    if v_fish->'fedAt' is not null then
      if jsonb_typeof(v_fish->'fedAt') is distinct from 'array' then return 'fish_fed_at_invalid'; end if;
      if jsonb_array_length(v_fish->'fedAt') > 8 then return 'fish_fed_at_invalid'; end if;
    end if;
  end loop;

  -- 造景：对象列表，总数 24，各类型上限与前端一致；位置/旋转/缩放必须落在缸内可恢复范围。
  if p_state->'decor' is null then return 'decor_missing'; end if;
  if jsonb_typeof(p_state->'decor') is distinct from 'array' then return 'decor_not_array'; end if;
  if jsonb_array_length(p_state->'decor') > 24 then return 'decor_count_above_max'; end if;

  v_ids := array[]::text[];
  for v_decor in select value from jsonb_array_elements(p_state->'decor') loop
    if jsonb_typeof(v_decor) is distinct from 'object' then return 'decor_not_object'; end if;

    if v_decor->'id' is null then return 'decor_id_missing'; end if;
    if jsonb_typeof(v_decor->'id') is distinct from 'string' then return 'decor_id_invalid'; end if;
    v_id := v_decor->>'id';
    if length(v_id) < 1 or length(v_id) > 100 then return 'decor_id_invalid'; end if;
    if v_id = any(v_ids) then return 'decor_id_duplicated'; end if;
    v_ids := v_ids || v_id;

    if v_decor->'kind' is null then return 'decor_kind_invalid'; end if;
    if jsonb_typeof(v_decor->'kind') is distinct from 'string' then return 'decor_kind_invalid'; end if;
    v_kind := v_decor->>'kind';
    if v_kind not in ('plant', 'rock', 'wood') then return 'decor_kind_invalid'; end if;
    if v_kind = 'plant' then v_plants := v_plants + 1; elsif v_kind = 'rock' then v_rocks := v_rocks + 1; else v_woods := v_woods + 1; end if;
    if v_plants > 14 or v_rocks > 10 or v_woods > 6 then return 'decor_count_above_max'; end if;

    if v_decor->'type' is null then return 'decor_type_invalid'; end if;
    if jsonb_typeof(v_decor->'type') is distinct from 'string' then return 'decor_type_invalid'; end if;
    if (v_decor->>'type') !~ '^[a-z][a-z0-9_-]{0,23}$' then return 'decor_type_invalid'; end if;

    if v_decor->'seed' is null then return 'decor_seed_invalid'; end if;
    if jsonb_typeof(v_decor->'seed') is distinct from 'number' then return 'decor_seed_invalid'; end if;
    v_num := (v_decor->>'seed')::numeric;
    if v_num < 0 or v_num > 4294967295 or v_num <> trunc(v_num) then return 'decor_seed_invalid'; end if;

    if v_decor->'x' is null or v_decor->'z' is null then return 'decor_position_invalid'; end if;
    if jsonb_typeof(v_decor->'x') is distinct from 'number' or jsonb_typeof(v_decor->'z') is distinct from 'number' then return 'decor_position_invalid'; end if;
    if (v_decor->>'x')::numeric < 0 or (v_decor->>'x')::numeric > 1 then return 'decor_position_invalid'; end if;
    if (v_decor->>'z')::numeric < 0 or (v_decor->>'z')::numeric > 1 then return 'decor_position_invalid'; end if;

    if v_decor->'rot' is null then return 'decor_rotation_invalid'; end if;
    if jsonb_typeof(v_decor->'rot') is distinct from 'number' then return 'decor_rotation_invalid'; end if;
    v_num := (v_decor->>'rot')::numeric;
    if v_num < 0 or v_num >= 6.2832 then return 'decor_rotation_invalid'; end if;

    if v_decor->'scale' is null then return 'decor_scale_invalid'; end if;
    if jsonb_typeof(v_decor->'scale') is distinct from 'number' then return 'decor_scale_invalid'; end if;
    v_num := (v_decor->>'scale')::numeric;
    if v_num < 0.6 or v_num > 1.6 then return 'decor_scale_invalid'; end if;
  end loop;

  if p_state->'layout' is not null then
    if jsonb_typeof(p_state->'layout') is distinct from 'object' then return 'layout_invalid'; end if;
    if p_state->'layout'->'seed' is not null then
      if jsonb_typeof(p_state->'layout'->'seed') is distinct from 'number' then return 'layout_invalid'; end if;
      v_num := (p_state->'layout'->>'seed')::numeric;
      if v_num < 0 or v_num > 4294967295 or v_num <> trunc(v_num) then return 'layout_invalid'; end if;
    end if;
  end if;

  if p_state->'night' is null then return 'night_missing'; end if;
  if jsonb_typeof(p_state->'night') is distinct from 'boolean' then return 'night_not_boolean'; end if;
  if p_state->'sound' is null then return 'sound_missing'; end if;
  if jsonb_typeof(p_state->'sound') is distinct from 'boolean' then return 'sound_not_boolean'; end if;

  if p_state->'savedAt' is null then return 'saved_at_missing'; end if;
  if jsonb_typeof(p_state->'savedAt') is distinct from 'number' then return 'saved_at_not_number'; end if;
  v_num := (p_state->>'savedAt')::numeric;
  if v_num < 0 or v_num > 4102444800000 then return 'saved_at_out_of_range'; end if;

  return null;
end $$;

comment on function public.mofish_state_error_v2(jsonb) is
  'MoFish 存档 v2 校验：字符串鱼种 id、持久外观种子、造景对象列表（位置/旋转/缩放边界）。返回 null 表示合法。';

-- 分派器：v1 走原校验（老客户端不变），v2 走新校验。
create or replace function public.mofish_state_error_any(p_state jsonb)
returns text
language plpgsql
immutable
set search_path = public, pg_temp
as $$
declare
  v_version numeric;
begin
  if p_state is null then return 'state_missing'; end if;
  if jsonb_typeof(p_state) is distinct from 'object' then return 'state_not_object'; end if;
  if p_state->'version' is null then return 'version_missing'; end if;
  if jsonb_typeof(p_state->'version') is distinct from 'number' then return 'version_not_number'; end if;
  v_version := (p_state->>'version')::numeric;
  if v_version = 1 then return public.mofish_state_error(p_state); end if;
  if v_version = 2 then return public.mofish_state_error_v2(p_state); end if;
  return 'unsupported_state_version';
end $$;

comment on function public.mofish_state_error_any(jsonb) is
  '按存档 version 分派校验：1 用 mofish_state_error，2 用 mofish_state_error_v2，其它拒绝。';

-- ---------------------------------------------------------------- 表约束：允许 v2

alter table public.aquariums drop constraint if exists aquariums_state_version_supported;
alter table public.aquariums add constraint aquariums_state_version_supported check (state_version in (1, 2));

-- ---------------------------------------------------------------- 进食事件表

create table if not exists public.mofish_feed_events (
  id           uuid        primary key default gen_random_uuid(),
  aquarium_id  uuid        not null references public.aquariums (id) on delete cascade,
  operation_id uuid        not null,
  fish_id      text        not null,
  bites        integer     not null default 1,
  credited     integer     not null default 0,
  applied_at   timestamptz,
  created_at   timestamptz not null default now(),
  constraint mofish_feed_events_unique unique (aquarium_id, operation_id),
  constraint mofish_feed_events_fish_len check (length(fish_id) between 1 and 100),
  constraint mofish_feed_events_bites check (bites between 1 and 8),
  constraint mofish_feed_events_credited check (credited between 0 and 8)
);

comment on table public.mofish_feed_events is
  '进食记账（严格单人）。客户端每次「鱼真的吃到一口」用唯一 operation_id 提交；'
  '主键约束保证重试幂等，营养成长只在 settle_growth 里结算。';

create index if not exists mofish_feed_events_pending_idx
  on public.mofish_feed_events (aquarium_id, created_at)
  where applied_at is null;

alter table public.mofish_feed_events enable row level security;
revoke all on public.mofish_feed_events from anon;
revoke all on public.mofish_feed_events from public;
revoke all on public.mofish_feed_events from authenticated;

-- ---------------------------------------------------------------- 进食记账入口

create or replace function public.record_feeding(
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
   where a.id = p_id and a.owner_id = v_uid
     and exists (select 1 from jsonb_array_elements(a.state_json->'fish') f where f->>'id' = p_fish_id)
   for update;

  if not found then
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

comment on function public.record_feeding(uuid, uuid, text, integer) is
  '进食记账（SECURITY DEFINER）：按 operation_id 幂等去重，只写事件表，不改成长与 revision。'
  '营养成长在 settle_growth 内结算，每鱼滚动 24 小时最多 3 口。';

-- ---------------------------------------------------------------- 保存 / 开缸：支持 v2

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

  if p_state_version is null or p_state_version not in (1, 2) then
    return query select 'invalid_argument', null::uuid, null::bigint, null::jsonb, null::timestamptz, false, 'unsupported_state_version'::text;
    return;
  end if;

  if p_initial_state is not null and jsonb_typeof(p_initial_state) = 'object'
     and jsonb_typeof(p_initial_state->'version') = 'number'
     and (p_initial_state->>'version')::numeric <> p_state_version then
    return query select 'invalid_state', null::uuid, null::bigint, null::jsonb, null::timestamptz, false, 'version_mismatch'::text;
    return;
  end if;
  if p_state_version = 2 and (p_initial_state is null or jsonb_typeof(p_initial_state) is distinct from 'object') then
    return query select 'invalid_state', null::uuid, null::bigint, null::jsonb, null::timestamptz, false, 'version_mismatch'::text;
    return;
  end if;

  v_error := public.mofish_state_error_any(p_initial_state);
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

-- ---------------------------------------------------------------- 成长结算：时间 + 实际进食

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
     and a.owner_id = v_uid
     for update;

  if not found then
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
     and a.owner_id = v_uid
   returning a.revision, a.state_json, a.last_growth_at
        into v_row.revision, v_row.state_json, v_row.last_growth_at;

  if not found then
    return query select 'not_found', null::bigint, 0, null::jsonb, null::timestamptz, 'aquarium_not_found'::text;
    return;
  end if;

  return query select 'ok', v_row.revision, v_secs, v_row.state_json, v_row.last_growth_at, null::text;
end $$;

comment on function public.settle_growth(uuid, integer) is
  '按服务端时间结算成长（SECURITY DEFINER，默认上限 24 小时）。'
  'v1 存档沿用每小时 0.008；v2 存档为 0.05/24h，并结算未应用的进食事件（每鱼每 24h 最多 3 口）。'
  'SELECT ... FOR UPDATE 保证并发调用不重复奖励；锚点推进到 now()。';

-- ---------------------------------------------------------------- 函数权限

revoke all on function public.mofish_state_error_v2(jsonb) from public;
revoke all on function public.mofish_state_error_v2(jsonb) from anon;
revoke all on function public.mofish_state_error_v2(jsonb) from authenticated;
revoke all on function public.mofish_state_error_any(jsonb) from public;
revoke all on function public.mofish_state_error_any(jsonb) from anon;
revoke all on function public.mofish_state_error_any(jsonb) from authenticated;

revoke all on function public.save_aquarium(uuid, bigint, jsonb, integer) from public;
revoke all on function public.save_aquarium(uuid, bigint, jsonb, integer) from anon;
revoke all on function public.ensure_aquarium(jsonb, integer) from public;
revoke all on function public.ensure_aquarium(jsonb, integer) from anon;
revoke all on function public.settle_growth(uuid, integer) from public;
revoke all on function public.settle_growth(uuid, integer) from anon;
revoke all on function public.record_feeding(uuid, uuid, text, integer) from public;
revoke all on function public.record_feeding(uuid, uuid, text, integer) from anon;

grant execute on function public.save_aquarium(uuid, bigint, jsonb, integer) to authenticated;
grant execute on function public.ensure_aquarium(jsonb, integer) to authenticated;
grant execute on function public.settle_growth(uuid, integer) to authenticated;
grant execute on function public.record_feeding(uuid, uuid, text, integer) to authenticated;

-- 回滚（人工执行，不在迁移里自动跑）：
--   1) 先部署旧版前端（v1 存档仍可写），再执行 supabase/rollback/0002_phase_b_growth.down.sql；
--   2) 回滚会删除 mofish_feed_events 并把 state_version 约束改回 1；
--   3) 已在云端的 v2 存档需要先导出/转回 v1，否则旧前端读到会拒绝写入（报 invalid_state）。
