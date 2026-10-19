# 最新续接入口（2026-10-20）

用户随后明确授权直接继续多人 C、整体优化、自查及独立 C 入口部署。请先读
[PHASE-C-PROGRESS.md](PHASE-C-PROGRESS.md)、[PHASE-C-ACCEPTANCE.md](PHASE-C-ACCEPTANCE.md) 与 HANDOFF 顶部。
下文 B 迁移映射及冻结部署仍有效，“不启动 C”属于旧轮范围，不覆盖最新授权。

# MoFish 阶段 B：新对话续接

## 已授权范围

用户确认使用推荐的 Supabase「MoFish」组织，报价为零可继续建立独立 B 项目、应用 B 迁移及部署独立测试入口。
组织 ID `wlpejmccgtsyzxzbycqo`，实际项目报价 $0/月；新项目已经创建，不再重复确认或创建。
保留现有 A 站点/数据库、Tibo、旧 Sites 和构建令牌。不合并 main、不打标签、不运行正式 release，不开始多人 C。

## 仓库与云状态

- 仓库 `Mintzz666/MoFish`，分支 `codex/phase-b-review-polish`。本轮开发基线 `bbe13e7ce64617bb4dda9926e10c26dccafb3950`。
- 新 B 项目 `MoFish-Phase-B-QA`，ref `gbcfyqtbezkgkstrfbzn`，API `https://gbcfyqtbezkgkstrfbzn.supabase.co`，区域 `ap-south-1`。
- A 项目 `jxqlzuvpuaqwcdvgxnle` 保持只有两份 A 迁移；不要在该项目执行 B 脚本、迁移或修改 Auth 配置。
- 已部署 Worker `mofish-phase-b`，网址 `https://mofish-phase-b.tibo-reset-notifier.workers.dev/`。
  **已在本机续接轮部署并核验，详见下方最新状态。**
- 新项目三份迁移已经成功应用，真实 SQL 31/31 通过，临时数据全部回滚；随后查询 auth.users/aquariums/mofish_feed_events 均为 0 行。
- 历史交接时 HTTP 未执行；本机续接轮已 64/64 通过，公开配置已从连接取回。
  旧工作区的忽略文件 `.env.phase-b` 只保存新 B 的公开配置，换环境可能不存在，可以从连接重新取回。

MCP 自动生成的迁移历史版本与仓库文件时间不同，但 SQL 来自同一份文件，不能盲目 `db push` 重放：

| 云端版本 | 名称 | 仓库来源 |
| --- | --- | --- |
| `20261019033451` | `phase_a_cloud_saves` | `20261016065742_phase_a_cloud_saves.sql` |
| `20261019033515` | `phase_a_cloud_hardening` | `20261016070336_phase_a_cloud_hardening.sql` |
| `20261019033518` | `phase_b_growth_and_aquascaping` | `20261018120000_phase_b_growth_and_aquascaping.sql` |

源文件 SHA256：A 首份 `c58044a46bc978554449f9e09863401e8860fe6d0c206511b6b478113f08790f`；
A hardening `83736e39e57690a501a5cd9b4fe7dcc883f9254357519ba7e6b8009f78ca8b41`；
B `8f6ef4ecfb861590b1de115175a04631d71bd2b337dfcc8465941658e126730f`。

## 本机续接状态（2026-10-19，优先于历史状态）

HTTP 64/64 通过；独立 B Worker 已部署。源码 `a7706e620d89cbd8a3530e9f2fb4492eb58afffd`，
Cloudflare version `0b424279-d44b-4d1f-b069-ceea7678d49d`。
线上六份文件与本机构建逐字节一致；CSP/缓存/私密路径已检查；A Worker 部署历史前后一致。
B Site URL/Redirect URLs 已由 localhost 改为实际 B 根地址；默认与显式 recovery 链接 2/2 正确，未发邮件。

工作树 `/Users/mintzz/.codex/worktrees/mofish-phase-b-acceptance/MoFish`，开发分支 `codex/phase-b-review-polish`。
原 `/Users/mintzz/Documents/MoFish` 仍为干净的 Hermes 分支。GitHub 开发分支最终 SHA 以交接回复/远端为准；
部署源码 SHA 固定如上，后续文档提交不代表重新部署。

本机 `.env.phase-b` 已准备（Git 忽略、0600），包含公开配置和用户填写的新 B 管理密钥；不要输出内容。
Node 24.19.0 已有；本机 Cloudflare OAuth 已验证，无需新令牌。无需设置 Codex Cloud 网络白名单或秘密注入。
API HTTP 测试使用普通命令成功；Workers 线上读取需要已有环境代理时使用 `NODE_USE_ENV_PROXY=1`。

完整本轮证据、范围和清理见 [PHASE-B-LOCAL-ACCEPTANCE.md](PHASE-B-LOCAL-ACCEPTANCE.md)。
用户接下来按 [PHASE-B-DEVICE-ACCEPTANCE.md](PHASE-B-DEVICE-ACCEPTANCE.md) 集中做真机/音效/审美验收，
收到反馈后仅修复实际问题、补相关回归并更新矩阵；尚不能宣布 B 已收口。
不无故重跑已有通过检查，不重复迁移、建项目或部署；不合并 main、不打标签、不运行 release、不启动 C。

## 已有证据

- 准备轮：185/185 严格本地检查，构建与独立 B Worker 部署预演通过；玻璃版历史浏览器 87/87。
- 本轮：新 B 项目真实 SQL 31/31，角色权限、RLS、版本/造景、成长/进食/限额、回滚清理全部通过。
- advisors 中 4 个受控 SECURITY DEFINER、事件表 RLS 无策略及新空库 unused index 提示已审阅，详见云方案；不放宽权限来消除提示。
- 旧环境证据目录 `/workspace/reviews/mofish-phase-b-cloud-live-20261019/`；换环境不能假定目录仍存在。
- 本机续接：最终严格测试 187/187、零跳过；HTTP 64/64、部署及 Safari 冒烟通过。真机仍待验收。
- 最终清理及交接以 `docs/HANDOFF.md` 顶部及本机验收记录为准。
