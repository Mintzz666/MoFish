# MoFish 阶段 B：新对话续接

## 已授权范围

用户确认使用推荐的 Supabase「MoFish」组织，报价为零可继续建立独立 B 项目、应用 B 迁移及部署独立测试入口。
组织 ID `wlpejmccgtsyzxzbycqo`，实际项目报价 $0/月；新项目已经创建，不再重复确认或创建。
保留现有 A 站点/数据库、Tibo、旧 Sites 和构建令牌。不合并 main、不打标签、不运行正式 release，不开始多人 C。

## 仓库与云状态

- 仓库 `Mintzz666/MoFish`，分支 `codex/phase-b-review-polish`。本轮开发基线 `bbe13e7ce64617bb4dda9926e10c26dccafb3950`。
- 新 B 项目 `MoFish-Phase-B-QA`，ref `gbcfyqtbezkgkstrfbzn`，API `https://gbcfyqtbezkgkstrfbzn.supabase.co`，区域 `ap-south-1`。
- A 项目 `jxqlzuvpuaqwcdvgxnle` 保持只有两份 A 迁移；不要在该项目执行 B 脚本、迁移或修改 Auth 配置。
- 计划 Worker `mofish-phase-b`，网址 `https://mofish-phase-b.tibo-reset-notifier.workers.dev/`。
  **Worker 尚未部署，该网址尚不是可用测试入口。**
- 新项目三份迁移已经成功应用，真实 SQL 31/31 通过，临时数据全部回滚；随后查询 auth.users/aquariums/mofish_feed_events 均为 0 行。
- HTTP 冒烟未执行，因为用户正在为新对话配置网络与独立 B 管理密钥；公开 publishable 配置已经从连接取回。
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

## 用户正在配置的内容

给用户的详细步骤见 [PHASE-B-ENV-SETUP.md](PHASE-B-ENV-SETUP.md)，包含网络、新秘密和新项目 Auth 回调。

网络允许域名追加（保留原域名）：

- `gbcfyqtbezkgkstrfbzn.supabase.co`
- `mofish-phase-b.tibo-reset-notifier.workers.dev`

新秘密变量 `MOFISH_B_SMOKE_SERVICE_ROLE_KEY`：新 B 项目的 Legacy service_role 密钥，
注入目标仅为 `gbcfyqtbezkgkstrfbzn.supabase.co`。不能复用 A 密钥；不要求用户把密钥发到聊天。
其余 B 公开变量为 `MOFISH_B_PROJECT_REF`、`MOFISH_B_SUPABASE_URL`、`MOFISH_B_SUPABASE_ANON_KEY`，
可从连接恢复至环境或忽略的 `.env.phase-b`。B 脚本不会回退使用 A 配置。

## 下一步按顺序执行

1. 读取 `AGENTS.md`、`docs/HANDOFF.md`、`docs/PHASE-B-CLOUD-PLAN.md`、本文件和 `docs/POST-A-ACCEPTANCE.md`。
   核对真实远端分支、HEAD、本地未提交内容；保留现有改动，缺工作区时再获取本分支。
2. 按 cloud-environment-runtime / Supabase skill 核验当前环境状态、域名与秘密注入，保留代理，所有输出脱敏。
   环境可使用代理占位字符串，不能仅因本地无法解析 JWT 就认定凭据缺失；运行脚本的只读 GoTrue 管理预检来确认。
3. 核对新项目迁移与配置。缺少公开变量时从已连接的新 B 项目取回 publishable 配置，不能把管理密钥放进构建。
4. Node 24 下沿用代理运行 `NODE_USE_ENV_PROXY=1 npm run test:cloud:b`。
   仅使用脚本新建的随机临时账号，验证 v1/v2、造景、双会话进食、成长、模拟离线重放、冲突备份及换号隔离，
   最后确认账号和关联数据清理。失败先排查修复，不能把本地替身结果当作真实 HTTP 通过。
5. 通过后运行 `NODE_USE_ENV_PROXY=1 npm run deploy:cloudflare:b`，只部署独立 B Worker。
   记录精确源码 SHA 和 Cloudflare version，验证实际页面、配置/CSP/缓存与新项目 Auth Site URL/Redirect URLs。
   新项目默认可能仍指 localhost；无法自动更改时给用户确切的新项目设置步骤，不碰 A 的 Auth 设置。
6. 如需临时浏览器账号，使用新 B 项目的随机临时身份并最终清理。接着给用户电脑/手机的集中验收步骤。
   iOS/Android 真机、触感、发热、音效、最终审美仍待验收，不用视口仿真替代。
7. 更新验收/交接并推送开发分支，保留必要脱敏证据，清理自己启动的临时进程/测试数据。
   新 B 项目与供用户验收的 Worker 需要保留，不在任务清理时删除。

## 已有证据

- 准备轮：185/185 严格本地检查，构建与独立 B Worker 部署预演通过；玻璃版历史浏览器 87/87。
- 本轮：新 B 项目真实 SQL 31/31，角色权限、RLS、版本/造景、成长/进食/限额、回滚清理全部通过。
- advisors 中 4 个受控 SECURITY DEFINER、事件表 RLS 无策略及新空库 unused index 提示已审阅，详见云方案；不放宽权限来消除提示。
- 旧环境证据目录 `/workspace/reviews/mofish-phase-b-cloud-live-20261019/`；换环境不能假定目录仍存在。
- 本轮最终本地测试与清理结果以 `docs/HANDOFF.md` 顶部及交接回复为准。
