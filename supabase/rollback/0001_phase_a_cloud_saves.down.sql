-- MoFish 阶段 A：云端存档对象回滚
--
-- ⚠️ 这是最后手段，不是默认回滚步骤。
-- 本脚本会 **删除 public.aquariums 表及其中的全部云端存档**（执行后无法从数据库恢复，
-- 只能靠 pg_dump 备份恢复）。常见情况下应该：
--   1) 前端问题 → 回滚 Cloudflare 上一次部署，数据库不动；
--   2) 函数/策略问题 → 新建版本化修复迁移，先在测试项目验证；不改写已应用的迁移；
--   3) 暂时不用云功能 → 用空的 dist/config.js 重新构建部署，数据库保留；
--   4) 只有确认不再需要云端数据时，才执行本文件，并且先完成备份：
--        pg_dump "<连接串>" --no-owner --no-privileges -Fc -f mofish-before-drop.dump
--        psql "<连接串>" -c "\copy (select * from public.aquariums) to 'aquariums.csv' csv header"
--
-- 执行：在 Supabase SQL Editor 里整段运行，或用
--   psql "<连接串>" -f supabase/rollback/0001_phase_a_cloud_saves.down.sql

begin;

drop function if exists public.save_aquarium(uuid, bigint, jsonb, integer);
drop function if exists public.ensure_aquarium(jsonb, integer);
drop function if exists public.settle_growth(uuid, integer);
-- mofish_state_error 只被上面的函数使用，删除前确认没有其它依赖
drop function if exists public.mofish_state_error(jsonb);

drop table if exists public.aquariums;

commit;

-- 说明：auth.users 与 Supabase Auth 配置不在本脚本范围内。
-- 若同时要清理测试账号，请在控制台 Authentication → Users 里逐个删除；
-- 删除用户会级联删除其鱼缸（外键 on delete cascade）。
