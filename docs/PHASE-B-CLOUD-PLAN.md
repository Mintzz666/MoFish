# 阶段 B 独立云端联调方案（待创建环境）

2026-10-19，分支 `codex/phase-b-review-polish`，本轮基线 `7606a1c8076895a04ea63e3afdf6d03683ced54c`。
脚本与方案已准备；**没有创建云项目、应用 B 迁移或部署 B 测试站**。

## 具体目标

| 资源 | 目标 | 当前状态 |
| --- | --- | --- |
| Supabase | 新项目 `MoFish-Phase-B-QA`，区域 `ap-south-1` | 待用户指定组织；目前只连接到 MoFish 组织 |
| Cloudflare | 独立 Worker `mofish-phase-b` | 只做部署预演，未创建 |
| 测试网址 | 预计 `https://mofish-phase-b.tibo-reset-notifier.workers.dev/` | 规划地址，尚不是可用测试入口 |
| A 项目 | `jxqlzuvpuaqwcdvgxnle` | 只读检查健康，仅有 A 两份迁移；B 脚本主动拒绝它 |
| A 站点 | `mofish.tibo-reset-notifier.workers.dev` | 保持原站点及用户存档 |

Supabase 创建工具要求用户指定组织。创建项目/分支可能收费，须先查询指定组织报价，再按工具规则确认费用。
本轮未查询报价或创建资源，不假定免费。旧服务密钥只绑定 A 域名，不能用其代理占位符访问新项目。
不合并 main、不打标签、不运行 release，不接触 Tibo、旧 Sites，不替换现有构建令牌。

## 获准后的执行顺序

1. 用户确认组织及独立 B 测试资源范围；查询实际费用后再创建项目。
2. 记录实际 project ref 与域名，给环境增加新 Supabase 域名及 B Worker 域名的网络授权。
3. 从连接取回公开 publishable 配置；新管理凭据通过独立安全变量注入，保留旧 A 凭据。
   若连接不能提供管理凭据，由用户在环境设置中补配一次；不粘贴聊天、不提交 Git。
4. 仅在新空项目按顺序应用三份迁移，检查迁移历史及 advisors：
   `20261016065742_phase_a_cloud_saves.sql`、`20261016070336_phase_a_cloud_hardening.sql`、
   `20261018120000_phase_b_growth_and_aquascaping.sql`。不在旧项目重放迁移。
5. 运行真实 HTTP 冒烟，确认临时账号及关联行清理后，部署独立 B Worker。
6. 新项目的 Auth Site URL/Redirect URLs 指向真实 B 测试网址，不能沿用 localhost；核对页面配置、CSP 与缓存。
7. 补真实浏览器链路，再指导用户一次集中完成真机验收。自动化只使用随机临时账号，不发送验证或重置邮件。

## 独立配置与命令

通过安全环境变量，或被 Git 忽略的 `.env.phase-b`（建议本机权限 0600）设置：

```dotenv
MOFISH_B_PROJECT_REF=<新项目实际20位ref>
MOFISH_B_SUPABASE_URL=https://<同一个ref>.supabase.co
MOFISH_B_SUPABASE_ANON_KEY=<新项目公开publishable或anon配置>
MOFISH_B_SMOKE_SERVICE_ROLE_KEY=<仅新项目Legacy service_role，安全注入>
```

B 不回退使用 A 的任何配置。管理凭据由 GoTrue 只读预检验证，不因本地无法解析代理占位符就认定缺失。
`sb_secret_*` 沿用现有显式拒绝规则，不把 opaque key 伪装成用户 JWT。

```sh
NODE_USE_ENV_PROXY=1 npm run test:cloud:b
NODE_USE_ENV_PROXY=1 npm run deploy:cloudflare:b -- --dry-run
# 以下实际部署仅在测试资源获授权、迁移与冒烟通过后执行：
NODE_USE_ENV_PROXY=1 npm run deploy:cloudflare:b
```

原 `test:cloud` / `deploy:cloudflare` 保持 A 入口。B Worker 名固定为 `mofish-phase-b`，不能传任意目标名。
部署前精确核对新项目 ref 与 HTTPS 根地址并拒绝 A 项目；构建子进程显式使用校验后的新公开配置。
管理密钥不进入发布产物。

## 自动化覆盖与证据边界

`test:cloud:b` 先跑 A 的基础 HTTP 检查，再对同一轮随机创建的两个临时账号追加：

- v1→v2 保留旧鱼字段，保存/恢复外观种子及造景位置/旋转/缩放，拒绝越界与过期 revision。
- 双会话并发重放同一进食 ID；拒绝不同载荷复用 ID、不存在的鱼、跨账号进食与匿名执行。
- 客户端不能直接 GET/POST/PATCH/DELETE 事件表；入账不直接增加成长、meals 或 revision。
- 一口营养、四口只奖励前三口、无新增时不写库、不重复奖励；自然成长使用 v2 的 0.05/24h 速率。
- 生产同步引擎：程序模拟断网和离线重启、队列重放、冲突备份、退出换号隔离。
- finally 删除并确认本轮临时账号；按登记的临时 aquarium ID 验证鱼缸/事件表无残留。

程序模拟断网不等于真实设备断网。24h 过期窗口、500 条限额及多连接竞态另有本地 SQL 检查，
此 HTTP 脚本不声称实际等待过 24h 或覆盖完整长期成长周期。

本轮脚本验证：185/185 严格测试通过、零跳过。B 工作流使用实际迁移 SQL 的隔离 PGlite 数据库，
HTTP/GoTrue 清理保护使用本地替身；这些均不计为真实云端通过。
Wrangler 4.151.0 部署预演通过，配置为明确的占位新项目，未创建资源。部署预演不证明真实云权限已获准。
脱敏证据位于 `/workspace/reviews/mofish-phase-b-cloud-prep-20261019/`。

## 用户最后需要配合的体验

测试入口就绪后，一次集中检查：

1. 手机/电脑看玻璃、鱼、造景和日夜效果；拖动/转向/缩放造景后刷新。
2. 手机真实断网修改，联网后在另一设备确认；双设备冲突选择后核对备份。
3. 退出换号、高/低画质、2D、前后台恢复；持续运行约 10 分钟反馈卡顿、发热和触感。
4. 开关水声并判断听感；最终审美由用户决定。

A 的真实密码重置已验收，不要求无故重跑完整 A 发信流程；新 B 项目的回调配置仍需验证。
不能用软件 WebGL 或视口仿真替代真实 iOS/Android、听感和用户审美。

## 回滚和清理

独立 B 站点可停用，现有 A 入口不变。数据库回滚脚本为 `supabase/rollback/0002_phase_b_growth.down.sql`；
残留 v2 存档时会先拒绝，必须明确导出和转换，不能直接删除营养历史。
只清理本轮随机账号及已登记关联资源；测试项目/Worker 若需删除，先核对所有权与保留需求。
浏览器 profile、测试数据库和兼容库按任务目录管理，正常依赖缓存与脱敏证据保留。
通过并获用户验收后才记录 B 收口；多人 C、合并、正式发版另行处理。
