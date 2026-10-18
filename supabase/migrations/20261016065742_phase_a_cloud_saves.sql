-- MoFish 阶段 A：云存档（表 + RLS + 受控写入函数）
--
-- 本文件可在 Supabase SQL Editor 里整份重复执行（幂等）。
--
-- 安全模型（务必先读这一段）：
--   * `authenticated` 只有 public.aquariums 的 **SELECT** 权限，没有任何 INSERT/UPDATE/DELETE 权限。
--     所有写入只能经由三个 SECURITY DEFINER 函数完成，函数内部再自行校验 auth.uid()、参数与存档结构。
--     这样客户端无法直接改写 revision、last_growth_at 或塞入未校验的 state_json —— 校验与并发控制
--     是数据库强制边界，而不是「请前端不要直接调表」的君子协定。
--   * anon / public 不持有任何表权限，也没有函数 EXECUTE 权限。
--
-- 注意：本迁移号 (0001) 从未应用到任何真实项目，因此本轮评审后直接在原文件上修订。
-- 一旦应用过，后续修改必须新建 0002 等迁移文件，不要就地改本文件。

-- ---------------------------------------------------------------- 存档结构校验（服务端权威）

create or replace function public.mofish_state_error(p_state jsonb)
returns text
language plpgsql
immutable
set search_path = public, pg_temp
as $$
declare
  v_fish jsonb;
  v_id   text;
  v_ids  text[] := array[]::text[];
  v_num  numeric;
begin
  if p_state is null then
    return 'state_missing';
  end if;
  if jsonb_typeof(p_state) is distinct from 'object' then
    return 'state_not_object';
  end if;

  -- 每个字段都显式判断「是否存在」与「类型是否正确」。
  -- 缺失字段在 jsonb 里取出来是 NULL，用 `<> value` 比较得到 NULL（既不真也不假），
  -- 早期版本因此会漏过整份缺字段的存档，必须用 `is null` / `is distinct from` 判空。
  if p_state->'version' is null then return 'version_missing'; end if;
  if jsonb_typeof(p_state->'version') is distinct from 'number' then return 'version_not_number'; end if;
  v_num := (p_state->>'version')::numeric;
  if v_num <> 1 then return 'unsupported_state_version'; end if;

  if p_state->'fish' is null then return 'fish_missing'; end if;
  if jsonb_typeof(p_state->'fish') is distinct from 'array' then return 'fish_not_array'; end if;
  if jsonb_array_length(p_state->'fish') < 1 then return 'fish_count_below_min'; end if;
  if jsonb_array_length(p_state->'fish') > 12 then return 'fish_count_above_max'; end if;

  if p_state->'plants' is null then return 'plants_missing'; end if;
  if jsonb_typeof(p_state->'plants') is distinct from 'number' then return 'plants_not_number'; end if;
  v_num := (p_state->>'plants')::numeric;
  if v_num <> trunc(v_num) or v_num < 0 or v_num > 8 then return 'plants_out_of_range'; end if;

  if p_state->'night' is null then return 'night_missing'; end if;
  if jsonb_typeof(p_state->'night') is distinct from 'boolean' then return 'night_not_boolean'; end if;

  if p_state->'sound' is null then return 'sound_missing'; end if;
  if jsonb_typeof(p_state->'sound') is distinct from 'boolean' then return 'sound_not_boolean'; end if;

  if p_state->'savedAt' is null then return 'saved_at_missing'; end if;
  if jsonb_typeof(p_state->'savedAt') is distinct from 'number' then return 'saved_at_not_number'; end if;
  v_num := (p_state->>'savedAt')::numeric;
  if v_num < 0 or v_num > 4102444800000 then return 'saved_at_out_of_range'; end if;

  for v_fish in select value from jsonb_array_elements(p_state->'fish') loop
    if jsonb_typeof(v_fish) is distinct from 'object' then return 'fish_not_object'; end if;

    if v_fish->'id' is null then return 'fish_id_missing'; end if;
    if jsonb_typeof(v_fish->'id') is distinct from 'string' then return 'fish_id_invalid'; end if;
    v_id := v_fish->>'id';
    if length(v_id) < 1 or length(v_id) > 100 then return 'fish_id_invalid'; end if;
    -- 重复 id 会让「按 id 定位某条鱼」的客户端逻辑指向不确定对象，必须拒绝。
    if v_id = any(v_ids) then return 'fish_id_duplicated'; end if;
    v_ids := v_ids || v_id;

    if v_fish->'name' is null then return 'fish_name_missing'; end if;
    if jsonb_typeof(v_fish->'name') is distinct from 'string' then return 'fish_name_invalid'; end if;
    if length(v_fish->>'name') > 16 then return 'fish_name_invalid'; end if;

    if v_fish->'species' is null then return 'fish_species_missing'; end if;
    if jsonb_typeof(v_fish->'species') is distinct from 'number' then return 'fish_species_invalid'; end if;
    v_num := (v_fish->>'species')::numeric;
    if v_num <> trunc(v_num) or v_num < 0 or v_num > 3 then return 'fish_species_out_of_range'; end if;

    if v_fish->'born' is null then return 'fish_born_missing'; end if;
    if jsonb_typeof(v_fish->'born') is distinct from 'number' then return 'fish_born_invalid'; end if;
    v_num := (v_fish->>'born')::numeric;
    -- 允许 0（历史存档）；上限 2100-01-01，防止客户端把时间戳放大到失控值。
    if v_num < 0 or v_num > 4102444800000 then return 'fish_born_out_of_range'; end if;

    if v_fish->'growth' is null then return 'fish_growth_missing'; end if;
    if jsonb_typeof(v_fish->'growth') is distinct from 'number' then return 'fish_growth_invalid'; end if;
    v_num := (v_fish->>'growth')::numeric;
    if v_num < 0 or v_num > 1 then return 'fish_growth_out_of_range'; end if;

    if v_fish->'meals' is null then return 'fish_meals_missing'; end if;
    if jsonb_typeof(v_fish->'meals') is distinct from 'number' then return 'fish_meals_invalid'; end if;
    v_num := (v_fish->>'meals')::numeric;
    if v_num < 0 or v_num <> trunc(v_num) or v_num > 1000000 then return 'fish_meals_out_of_range'; end if;
  end loop;

  return null;
end $$;

comment on function public.mofish_state_error(jsonb) is
  'MoFish 存档结构校验（服务端权威）。返回 null 表示合法，否则返回稳定错误码。'
  '每个字段都做存在性与类型检查（缺失字段是 NULL，不能用 <> 判空），并拒绝重复的鱼 id。';

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
  'MoFish 云端鱼缸存档。阶段 A：一个账号一条鱼缸；阶段 B 引入 aquarium_members 时需同步调整唯一索引与策略。'
  '写入只允许通过 ensure_aquarium / save_aquarium / settle_growth 三个函数。';
comment on column public.aquariums.revision is
  '每次成功写入 +1；客户端必须带 expected_revision 做条件更新，冲突时返回当前值。';
comment on column public.aquariums.last_growth_at is
  '离线成长结算锚点（服务端时间）。只由 settle_growth 推进，save_aquarium 不改动它。';

-- 阶段 A：每个账号恰好一条鱼缸，使首次登录的开缸动作可幂等重放。
-- 阶段 B（多人共享）必须改为成员关系表，届时新增迁移删除本索引。
create unique index if not exists aquariums_owner_phase_a_uidx
  on public.aquariums (owner_id);

create index if not exists aquariums_owner_updated_idx
  on public.aquariums (owner_id, updated_at desc);

-- ---------------------------------------------------------------- 权限边界

alter table public.aquariums enable row level security;

-- 只保留「读自己的那一行」：写入一律走受控函数，因此不再需要 insert/update/delete 策略。
-- 这些策略即使存在也无效（下表没有任何写权限），删掉是为了避免误以为可以直接写表。
drop policy if exists aquariums_insert_own on public.aquariums;
drop policy if exists aquariums_update_own on public.aquariums;
drop policy if exists aquariums_delete_own on public.aquariums;

drop policy if exists aquariums_select_own on public.aquariums;
create policy aquariums_select_own on public.aquariums
  for select to authenticated
  using (owner_id = auth.uid());

-- 关键：撤销 authenticated 的表级写权限。RLS 只做行归属判断，挡不住「直接调表改写 revision」。
revoke all on public.aquariums from anon;
revoke all on public.aquariums from public;
revoke all on public.aquariums from authenticated;
grant select on public.aquariums to authenticated;

-- Supabase 默认已把 public schema 的 USAGE 授予 authenticated；这里显式再授权一次，
-- 让迁移在原生 Postgres（15+ 不再默认给 PUBLIC CREATE/USAGE）上也能独立执行。
-- 只给 USAGE，表权限仍然只有 SELECT。
grant usage on schema public to authenticated;

-- ---------------------------------------------------------------- 编写鱼缸：原子 revision 条件更新

-- SECURITY DEFINER 说明：函数以属主（应用迁移的角色，通常是 postgres）身份执行，因此能够写入
-- 已被收回写权限的表；作为交换，函数内部必须自己完成鉴权与归属过滤，不能依赖 RLS。
-- search_path 固定为 public, pg_temp 且所有对象都带 schema 限定，避免被劫持。
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

  -- 条件更新：owner 与 revision 同时匹配才写入，两者都由数据库判断，构不成「先读后写」的竞态。
  -- revision 与 last_growth_at 都不接受客户端传入：revision 只能由服务端自增。
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

  -- 区分「不存在/不属于我」与「版本冲突」；两种情况都只在自己的行里查，不泄露他人的 aquarium id。
  select a.revision into v_current from public.aquariums a where a.id = p_id and a.owner_id = v_uid;

  if v_current is null then
    return query select 'not_found', null::bigint, null::timestamptz, 'aquarium_not_found'::text;
  else
    return query select 'conflict', v_current, null::timestamptz, 'revision_conflict'::text;
  end if;
end $$;

comment on function public.save_aquarium(uuid, bigint, jsonb, integer) is
  '原子保存（SECURITY DEFINER）：仅当 revision 匹配且 owner=auth.uid() 时写入，revision 由服务端自增。'
  '返回 ok/conflict/not_found/invalid_state/invalid_argument/not_authenticated。';

-- ---------------------------------------------------------------- 开缸：幂等

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
  '幂等开缸（SECURITY DEFINER）：不存在则按给定初始存档创建（created=true），存在则返回现有鱼缸（created=false）。'
  '重复调用不产生第二条记录。';

-- ---------------------------------------------------------------- 成长结算：服务端时间，幂等且并发安全

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

  -- 行锁（for update）：并发调用时后一个事务会阻塞到前一个提交，之后读到的就是已经推进过的锚点，
  -- 因此不存在「两个会话读到同一旧锚点、各自加一次成长」的重复奖励。
  -- 读取本身就带 owner 过滤：不属于自己的鱼缸按 not_found 处理，不泄露其是否存在。
  select a.* into v_row
    from public.aquariums a
   where a.id = p_id
     and a.owner_id = v_uid
     for update;

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
  '按服务端时间结算离线成长（SECURITY DEFINER，默认上限 24 小时=86400 秒）。'
  'SELECT ... FOR UPDATE 保证并发调用不重复奖励；锚点推进到 now()。';

-- ---------------------------------------------------------------- 函数权限

-- 只授予 authenticated：anon key 不能执行任何读写逻辑。
-- mofish_state_error 不对客户端开放：它是内部校验函数，只被上面三个 SECURITY DEFINER 函数调用
-- （以属主身份执行时不需要额外的 EXECUTE 授权）。
revoke all on function public.mofish_state_error(jsonb) from public;
revoke all on function public.mofish_state_error(jsonb) from anon;
revoke all on function public.mofish_state_error(jsonb) from authenticated;
revoke all on function public.save_aquarium(uuid, bigint, jsonb, integer) from public;
revoke all on function public.save_aquarium(uuid, bigint, jsonb, integer) from anon;
revoke all on function public.ensure_aquarium(jsonb, integer) from public;
revoke all on function public.ensure_aquarium(jsonb, integer) from anon;
revoke all on function public.settle_growth(uuid, integer) from public;
revoke all on function public.settle_growth(uuid, integer) from anon;

grant execute on function public.save_aquarium(uuid, bigint, jsonb, integer) to authenticated;
grant execute on function public.ensure_aquarium(jsonb, integer) to authenticated;
grant execute on function public.settle_growth(uuid, integer) to authenticated;
