# MoFish 阶段 A 交接

当前开发分支：`codex/phase-a-review-fixes`。基于 Hermes 的
`1d4f16eb8b95a617c46bc6e7979bec74e9e4043e`，并合入 `origin/main` 的协作及资源清理规则
（`3c67d91`）。最终提交 SHA 以交接回复和 GitHub 为准。

用户已授权 Codex 指挥 Luna（max 思考）修复阶段 A，Codex 负责独立复核、集成验证和开发分支版本管理。
用户进一步要求双方完成阶段 A，包括独立云入口和真实联调；已授权准备和部署测试入口，
尚未合并 main、未打产品版本标签、未运行正式 release、未真实部署，仍需用户验收。

## 范围和架构

本阶段实现邮箱密码注册、验证、登录、重置密码，以及单用户跨设备云存档：

- Cloudflare 提供独立静态访问入口，不需要 ChatGPT 登录。
- Supabase Auth 负责密码校验和发信，数据库通过权限、RLS、受控 RPC 和 revision 条件更新保护账号存档。
- 游客继续使用本地存档；账号缓存、未同步副本、备份按账号及鱼缸隔离。旧 `version: 1` 存档兼容。
- 共享鱼缸、3D、鱼类运动和造景升级尚未实施，按 `docs/ROADMAP.md` 后续推进。

## 本轮修复

1. **保存期间继续编辑**：请求使用不可变快照，成功响应只确认实际发送的内容；后续编辑继续保留为 pending 并排队上传。失败与冲突分支也保留最新本地编辑。
2. **成长结算期间编辑**：结算与保存串行；结算返回前若发生本地编辑，保留本地状态和原 revision，进入可见冲突，供用户选择，不静默采用旧快照。
3. **账号切换竞态**：认证 store 写入/清除通过会话代次和令牌检查；旧刷新成功、失败及邮件回调不能覆盖新账号。同步请求的 finally 也仅释放自身的保存指针或结算锁。
4. **离线冷启动**：新引擎恢复账号鱼缸指针、已知 revision 和 pending，使后续离线编辑仍可落盘，并在真正重启后恢复。
5. **认证维护**：使用官方 `@supabase/auth-js`，通过 esbuild 随站点打包，不依赖 CDN。保留原有 facade、测试和 implicit 邮件回调。每次操作使用独立内存 SDK，由 facade 控制应用会话；刷新基础设施错误单次返回，保留凭据供后续重试。构建只打包 auth 模块，公开配置仍由独立 `dist/config.js` 注入。
6. **数据库测试安全**：拒绝 `MOFISH_TEST_PG_URL`，只操作本轮新建的 embedded PostgreSQL；唯一目录和端口，不重置外部 schema/角色。若无法确认服务停止，保留目录并报告。
7. **浏览器测试资源**：支持 Chrome/Chromium 路径配置；每轮独立 profile、临时目录和调试端口；正常完成或中断均清理本轮服务和浏览器。`--keep` 只保留证据，不保留运行进程。
8. **云端验收工具**：冒烟脚本使用应用的认证 SDK/API；随机创建测试账号，检查刷新、第二会话恢复、revision 和权限，finally 验证删除。修复接口报错误判为空结果、退出跳过清理、JSONB 键顺序差异等问题；不触碰已有用户存档。新增 8 项脚本回归仍属于假 HTTP 检查，不能冒充云服务联调。
9. **部署和 CI**：新增 `npm run deploy:cloudflare`，检查必要配置后构建并只部署 `mofish` Worker；支持 `--dry-run`。构建/部署/冒烟 CLI 可读本机 `.env`，环境变量优先。新增 GitHub Actions，数据库严格模式不能用 SKIP 获取通过。

Hermes 的权限、行锁、服务端校验等前轮修复已包含在基线中。
首次云端应用后，原 `0001` 仅改名为 `20261016065742_phase_a_cloud_saves.sql` 以匹配云端历史，
SQL 字节未改。新增 `20261016070336_phase_a_cloud_hardening.sql` 收回平台内部 event-trigger helper
的客户端执行权，并将 owner 策略改为 `(select auth.uid())`，保持相同归属过滤。
已应用的迁移不再改写；后续结构、函数或策略调整均新增版本化迁移。

## 已完成的 Supabase 数据库接入

项目 `MoFish`（`jxqlzuvpuaqwcdvgxnle`），地区 `ap-south-1`，PostgreSQL 17.11。
2026-10-16 通过用户已授权的 Supabase 集成应用两份迁移，云端历史与仓库文件名一致。
原迁移 SHA256 `c58044a46bc978554449f9e09863401e8860fe6d0c206511b6b478113f08790f`；
hardening SHA256 `83736e39e57690a501a5cd9b4fe7dcc883f9254357519ba7e6b8009f78ca8b41`。

真实云数据库事务验证 **13 项通过**：创建、幂等创建、本人读取、保存、revision 冲突、直接写表拒绝、
非法存档拒绝、他人读取/保存/结算拒绝、成长结算与重复结算、匿名访问拒绝。
测试身份和数据全部在同一事务回滚；检查结束后两个表均无测试数据。
这些检查在云端 PostgreSQL 内以数据库角色及 claims 验证，未经过 GoTrue/PostgREST HTTP。

Supabase 性能 advisors 无提示；安全 advisors 仅保留三个有意开放给已登录用户的受控写入 RPC 提示。
各函数固定 search_path、检查 uid/owner、拒绝匿名；客户端仍没有表级写权限。
参见 [SECURITY DEFINER 提示说明](https://supabase.com/docs/guides/database/database-linter?lint=0029_authenticated_security_definer_function_executable)。
平台 `rls_auto_enable()` 的 anon/authenticated 执行权已撤回，原 event trigger 仍启用。
Luna 新增相应迁移回归，检查撤权、owner 权限保留及 RLS InitPlan/账号隔离。
公开项目配置已写入忽略的 `.env`，用实际项目 publishable key 构建成功；未获取或提交管理密钥。

## 复现与测试

要求 Node.js 22+。依赖首次用 `npm ci` 安装，不反复重装。

```sh
npm test
npm run build
npm start
# 浏览器访问 http://127.0.0.1:5173
npm run test:e2e
npm run test:concurrency
```

自定义浏览器用 `MOFISH_CHROME_PATH=/path/to/chrome`。
当前隔离 Linux 容器运行 headless 时使用 `MOFISH_CHROME_NO_SANDBOX=1`；普通桌面无需设置。

2026-10-16，Codex 在隔离 Linux 工作区独立执行：

| 检查 | 实际结果 |
| --- | --- |
| `MOFISH_REQUIRE_POSTGRES=1 npm test` | 本次迁移后复跑：125/125 通过，0 失败、0 跳过；隔离 ICU 60 运行库，含真实 PostgreSQL 18.4 多连接 |
| `npm run build` | 成功；本次使用实际 MoFish Supabase 公开配置；认证 bundle 约 117 KB（未压缩传输） |
| `MOFISH_CHROME_NO_SANDBOX=1 npm run test:e2e` | Chromium headless，50/50 通过；真实 dist、响应头和本地假后端；含 390/320px 视口 |
| 构建管理密钥闸 | 注入假的 `sb_secret_` 测试值，构建以 exit 1 拒绝，原有产物哈希不变 |
| `npm run deploy:cloudflare -- --dry-run` | Wrangler 4.151.0 实际打包成功，识别 19 个静态资源；使用占位公开配置，未连接真实 Supabase，未发布 |
| CI Linux 运行库准备 | 官方 Ubuntu ICU 60 包校验、隔离解压及 PostgreSQL 18.4 版本启动验证通过；不替换系统库 |
| `git diff --check` | 通过 |

Luna 定向测试还覆盖认证/配置、同步/存储、云端脚本和并发安全检查；
最终以 Codex 的全套集成结果为准，不把重复运行累加成额外测试数量。

新增回归通过可控请求门闩复现竞态，先确认旧实现失败，再检验修复。
测试假后端只是 Supabase 的本地替身：不验 JWT 签名、不发信、不证明真实 GoTrue/PostgREST 行为。

## 仍需完成的真实联调

- 两份真实 Supabase 数据库迁移及 13 项云端 SQL 验证已完成；未运行 `npm run test:cloud`，JWT 轮换、RPC HTTP 链路及真实 REST 错误码仍待验证。
- 未验证邮箱确认及重置邮件投递、SMTP、模板和跳转白名单。
- 未部署 Cloudflare，CSP 等响应头目前只在本地预览验证。
- 未测试 iOS Safari / Android Chrome 真机；移动尺寸测试属于浏览器视口仿真。
- GitHub Actions 在 `fd407390d75434d7b83f64d756b340e1d4de2021` 已通过 124 项测试、50 项 E2E、构建与部署预演；本次新增迁移回归的 CI 以新提交检查为准。
- 用户已有 Cloudflare 账号（Tibo 正在使用）；Supabase 项目已创建并连接，无需再授权同一次迁移。
- 当前环境没有云凭据，网络只开放包仓库等指定域名；真实 HTTP 联调需要配置实际项目、Cloudflare API 和访问域名的网络许可，或在已有权限的本机执行。

## 阶段 A 验收进度

| 门槛 | 当前证据 |
| --- | --- |
| 代码、旧存档兼容、账号/同步竞态 | 单元/集成及本地浏览器检查已通过 |
| 数据库 RLS、权限、原子 revision、真实并发成长 | 本地内核、多连接及真实 Supabase SQL 13 项通过；临时去掉行锁会复现重复奖励 |
| Supabase Auth / PostgREST 真实项目 | 已连接并应用迁移；真实 HTTP 及 Auth 仍待验证 |
| 验证及重置邮件实际投递 | 等待 SMTP 与真实邮箱检查，未验证 |
| Cloudflare 独立 HTTPS 入口 | Wrangler 预演通过，等待部署接入，未上线 |
| 用户电脑/手机的真实网络体验 | 等待上线后双设备检查，未验证 |

以上未完成的真实环节通过前，阶段 A 不标记为完成；不提前开始 B/C/D。

配置与回滚见 `docs/CLOUD-SETUP.md`。公开项目 URL/anon key 可进入构建，service_role/secret key 不得进入前端。
不要求用户提供密钥到聊天或仓库；SMTP 和私密凭据只在服务控制台配置。

## 有意保留的边界

- 每账号一个鱼缸；未来共享鱼缸使用新的成员表、RPC 与迁移，不放宽已有 owner 检查。
- 已登录时离线成长由服务端重连结算，24 小时以上余量丢弃，不在客户端重复累计。
- 成长结算与本地编辑同时发生时采用显式冲突；用户选择本机覆盖会替换云端状态，云端版本先归档备份。
- 会话存 localStorage，CSP 和不注入用户 HTML 缓解 XSS 风险，不能保证消除风险。
- Supabase 免费计划的配额、闲置暂停及备份限制需在上线前核对；无需常开家用 Mac mini。

## 资源和交接

源码、锁文件和第三方许可保留；node_modules、dist、个人存档、密钥、大型诊断产物不提交。
本轮复审 worktree 为 `/workspace/MoFish-phase-a-fixes`，保留供用户验收和后续版本管理。
测试只清理自身临时目录及进程，不删除用户缓存或其他任务的数据库。
浏览器端到端完成后已关闭本轮 Chromium、预览及假后端服务，并删除本轮 profile、截图和结果临时目录。
本轮临时 ICU 运行目录已在最终整套验证后删除，没有留下 PostgreSQL 进程或测试集群。
保留的精简集成日志位于 `/workspace/reviews/mofish-phase-a-completion/`，上一轮位于
`/workspace/reviews/mofish-phase-a-fixes/`，均不提交 Git。
本次迁移验证证据与 125 项回归日志位于 `/workspace/reviews/mofish-supabase-migration/`。
Supabase CLI 运行缓存 `supabase/.temp/` 已忽略；临时 ICU 目录与本轮数据库进程已清理。

正式版本仍按 `AGENTS.md`：用户明确接受当前版本后才运行 release hook；分支推送或草稿 PR 不是发版。
