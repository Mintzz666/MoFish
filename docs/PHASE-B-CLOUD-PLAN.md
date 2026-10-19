# 阶段 B 独立云端联调方案

2026-10-19 本机续接：真实 HTTP **64/64** 通过，独立 B Worker 已部署并完成线上文件/CSP/缓存核验。
当前入口、源码 SHA、Cloudflare version、证据和待验收范围见 [PHASE-B-LOCAL-ACCEPTANCE.md](PHASE-B-LOCAL-ACCEPTANCE.md)。
本机配置见 [PHASE-B-ENV-SETUP.md](PHASE-B-ENV-SETUP.md)，不需要 Codex Cloud 白名单、秘密注入或代理占位值。
本文件下方保留原准备方案及历史 SQL 证据，历史“尚未部署/待配置”状态以本段和本机验收记录为准。

## 具体目标

| 资源 | 目标 | 当前状态 |
| --- | --- | --- |
| Supabase | `MoFish-Phase-B-QA` / `gbcfyqtbezkgkstrfbzn`，区域 `ap-south-1` | 已在 MoFish 组织创建，三份迁移完成 |
| Cloudflare | 独立 Worker `mofish-phase-b` | 本机已预演并部署 |
| 测试网址 | `https://mofish-phase-b.tibo-reset-notifier.workers.dev/` | 已核验可用 |
| A 项目 | `jxqlzuvpuaqwcdvgxnle` | 只读检查健康，仅有 A 两份迁移；B 脚本主动拒绝它 |
| A 站点 | `mofish.tibo-reset-notifier.workers.dev` | 保持原站点及用户存档 |

组织已由用户确认、项目实际报价 $0/月并已创建；不要重复创建，也不新增收费资源。
本机使用用户安全填写的新 B Legacy service_role；不使用旧 A 密钥或云代理占位符。
不合并 main、不打标签、不运行 release，不接触 Tibo、旧 Sites，不替换现有构建令牌。

## 执行顺序与当前进度

1. 已完成组织、零费用范围确认及项目创建；不需要再询问相同授权。
2. 核验本机网络：B API 直连可达，Workers 域名本机直连超时，使用既有代理后可达；不改系统代理。
3. 公开 publishable 配置已从连接恢复；B 管理凭据由用户填写在 Git 忽略、0600 的本机 `.env.phase-b`。
4. 已在新项目按顺序应用三份迁移，并检查迁移历史及 advisors：
   `20261016065742_phase_a_cloud_saves.sql`、`20261016070336_phase_a_cloud_hardening.sql`、
   `20261018120000_phase_b_growth_and_aquascaping.sql`。云端 MCP 自动编号见续接文档；不要盲目 `db push` 或重放。
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

B 不回退使用 A 的任何配置。本机使用真实管理凭据，由 GoTrue 只读预检验证；不将云端代理占位值当作本机凭据。
下面命令默认普通运行，确实需要且已配置环境代理时才加 `NODE_USE_ENV_PROXY=1`。
`sb_secret_*` 沿用现有显式拒绝规则，不把 opaque key 伪装成用户 JWT。

```sh
npm run test:cloud:b
npm run deploy:cloudflare:b -- --dry-run
# 以下实际部署仅在测试资源获授权、迁移与冒烟通过后执行：
npm run deploy:cloudflare:b
```

原 `test:cloud` / `deploy:cloudflare` 保持 A 入口。B Worker 名固定为 `mofish-phase-b`，不能传任意目标名。
部署前精确核对新项目 ref 与 HTTPS 根地址并拒绝 A 项目；构建子进程显式使用校验后的新公开配置。
管理密钥不进入发布产物。B 部署支持已有 Wrangler OAuth，账号 ID 仍显式指定；不复制 OAuth token。

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

准备轮脚本验证：185/185 严格测试通过、零跳过。B 工作流使用实际迁移 SQL 的隔离 PGlite 数据库，
HTTP/GoTrue 清理保护使用本地替身；这些均不计为真实云端通过。
Wrangler 4.151.0 部署预演通过，配置为明确的占位新项目，未创建资源。部署预演不证明真实云权限已获准。
脱敏证据位于 `/workspace/reviews/mofish-phase-b-cloud-prep-20261019/`。

新项目真实 SQL 验证：`scripts/phase-b-sql-acceptance.sql` 的 31 项全部通过，包含 v1/v2 速率、旧档升级、
造景/版本校验、真实角色 RLS、越权拒绝、营养上限、24h 过期/离线上限、500 条限额及重试幂等。
所有临时身份/鱼缸/进食记录通过子事务回滚；查询确认新项目三张表均为 0 行、两张 public 表的 RLS 开启。
这是真实云端 SQL 证据，不是 GoTrue/JWT/HTTP 或真机通过。
证据保存在 `/workspace/reviews/mofish-phase-b-cloud-live-20261019/`。

安全 advisors：4 个受控 RPC 的 [SECURITY DEFINER 执行提示](https://supabase.com/docs/guides/database/database-linter?lint=0029_authenticated_security_definer_function_executable)，
进食表的 [RLS 无策略 INFO](https://supabase.com/docs/guides/database/database-linter?lint=0008_rls_enabled_no_policy) 属于主动拒绝客户端直访的设计；
已核对 owner 检查、固定 search_path、匿名无执行权及事件表无客户端权限，不为消除提示而放宽权限。
性能 advisors 仅有新空库的 [Unused Index INFO](https://supabase.com/docs/guides/database/database-linter?lint=0005_unused_index)，保留预期索引。

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
