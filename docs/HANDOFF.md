# MoFish 阶段 A 交接

当前开发分支：`codex/phase-a-review-fixes`。基于 Hermes 的
`1d4f16eb8b95a617c46bc6e7979bec74e9e4043e`，并合入 `origin/main` 的协作及资源清理规则
（`3c67d91`）。最终提交 SHA 以交接回复和 GitHub 为准。

用户已授权 Codex 指挥 Luna（max 思考）修复阶段 A，Codex 负责独立复核、集成验证和开发分支版本管理。
用户进一步要求双方完成阶段 A，包括独立云入口和真实联调；已授权准备和部署测试入口，
Cloudflare 独立测试入口已部署；尚未合并 main、未打产品版本标签、未运行正式 release；用户已于 2026-10-18 完成阶段 A 验收。

## 后续任务范围调整（2026-10-18）

用户决定先完善单人体验再考虑多人：B = 页面 + 完整 3D + 自然运动 + 水体/水草 + 可持久造景（原 C/D），
C = 多人共享（原 B）。当前 Hermes 长任务只覆盖 B，详见 `HERMES-POST-A-LONG-RUN-PROMPT.md`。
B 完成后先独立复核与用户验收，再决定启动 C；上一版多人优先的双阶段连续实施任务不再适用。
不改变 A 已验收状态，本次只整理任务文档，没有开始开发、云端迁移或发布。

## 阶段 A 已收口（2026-10-18）

用户按本聊天逐项执行剩余四组测试，依次确认密码重置、离线重连、双设备冲突及本机备份、退出换号与游客隔离成功，
最后回复“完成了，做收口吧”。同账号字段恢复核对也包含在最后一组指导中。
结合已有 23/23 真实云端 HTTP 冒烟、数据库/并发验证及本地回归，**阶段 A 验收完成**。
完整矩阵和证据边界见 [PHASE-A-ACCEPTANCE.md](PHASE-A-ACCEPTANCE.md)。

不臆造设备型号或浏览器版本；真实冲突手测为“采用云端”路径，另一选择已有自动化证据。
SMTP 配置审计、默认发信额度和公开推广可靠性保留为后续运维事项，不声称生产发信能力全面验收。
本次只更新验收文档及状态说明，未重跑已通过的代码测试、未创建账号/进程、未部署或访问已有用户存档。
本地和远端基线核对一致为 `f4c49215edd89de160e47218e2e8837e66d7a27d`，工作区原本干净。
继续保留 main、标签、构建令牌、Tibo 和旧 Sites；按本聊天明确范围，本次不执行 release。
阶段 B 可另行讨论，未开始实现。下方标明历史的记录只保留当时状态，以本节为最新结论。

## 历史：最终验收续验（2026-10-16）

基线远端与本地均核实为 `f6c27621bccca94b17eb58f365f9403c75bdcb05`；初始 `work` 分支干净，
抓取后以 FETCH_HEAD 创建 `codex/phase-a-review-fixes`，没有覆盖未提交内容。
以下为当时状态，现由顶部收口结论替代；历史测试数字不累加计数。

- 云环境 spec revision 2，observations current；网络、秘密和账号变量状态仍是 `unknown`，不能称平台 ready/enforced。
  变量存在性检查确认代理、管理测试密钥及构建凭据存在；缺少公开配置，从已连接 MoFish 项目取回公开 publishable key，
  只写入忽略的 `.env`。管理密钥不写文件、不打印、不本地解码。
- 实际管理 API 只读预检返回 GoTrue `404 user_not_found`；Cloudflare 只读部署查询 HTTP 200，
  `mofish` 当前 100% 指向 `30e04134-5a77-4f46-8f8b-116f0198ad72`，线上源码仍为
  `683aef1ff669f69d9b98f27c1b7654ece0605f4d`；首页 HTTP 200。没有重新部署。
- 修复 `scripts/cloud-smoke.mjs` 对代理占位凭据的兼容性：取消本地 JWT 解码闸，先 GET 随机不存在的用户 ID，
  只有 GoTrue 明确 `404 user_not_found` 才允许创建临时账号；401/403、通用 404、超时等停止写入。
  仍不支持直接 `sb_secret_`，不回退使用已有账号，不输出凭据或原始错误正文。
- `NODE_USE_ENV_PROXY=1 npm run test:cloud` **23/23 通过**：管理预检、临时账号登录/刷新和身份确认、
  同账号第二独立会话恢复、保存和旧 revision 冲突、跨账号 RPC/REST 拒绝、匿名拒绝、成长记账及非法存档拒绝。
  两个随机临时账号 DELETE 均 HTTP 200，后续 GET 均由 GoTrue 明确确认 404 `user_not_found`。
  鱼缸按既有外键级联删除；未访问已有用户存档，未改数据库结构或发送邮件。
- `node --test tests/cloud-smoke.test.mjs tests/cloud-auth.test.js tests/cloud-config.test.js` **37/37 通过，0 跳过**。
  新增预检回归覆盖占位注入及认证失败/通用 404 不允许写入。此次仅修改 CLI 与文档，未改前端或数据库；
  历史全套 136 项及浏览器 57 项证据不计为本轮重跑，新增提交的 CI 结果需另查。
- 用户明确回复密码重置、真实设备离线重连、冲突与退出换号“还没测，等待你的指导和测试”。
  四项均保持未测；操作和反馈模板见 [PHASE-A-ACCEPTANCE.md](PHASE-A-ACCEPTANCE.md)。
  阶段 A 尚未完成，暂不进入阶段 B。
- 本轮脱敏日志：`/workspace/reviews/mofish-phase-a-final-20261016-r2/`（`cloud-smoke.log`、`regression.log`）。
  未启动后台服务或浏览器；本轮命令均已结束。保留公开 `.env`、正常依赖缓存及脱敏证据；
  没有清理其他任务文件或进程。Tibo、旧 Sites、构建令牌均未修改；未合并 main、打标签或运行 release。
- Supabase changelog 域名不在本环境出站白名单，请求 CONNECT 403，未绕过代理；
  本轮不新增 Supabase 功能或 API，仅复用既有 Admin GET 进行凭据预检，并已真实验证。

## 历史：后续密码重置失败定位

用户 Safari 点击重置邮件后落到 `localhost:3000` 无法连接，密码重置验收更新为失败待修复。
用本轮单独创建的随机临时账号生成 recovery 链接（不发信）复现：指定线上 redirect_to 仍回退 localhost；
默认地址也为 localhost。测试账号已删除并由 GoTrue 404 确认，无令牌写日志。
应用代码传入正确线上回调，无需先改前端或重新部署。
当前连接缺少 Auth URL 配置修改接口，待用户在 Supabase URL Configuration 设置 Site URL 及 Redirect URLs 后，
Codex 重跑无发信诊断，用户再从线上申请新邮件完成真实改密。具体步骤见验收文档的“密码重置回调阻塞”。

## 历史：用户保存回调配置后的复核

用户确认已保存配置后，显式线上 redirect_to 与默认回调两项 Admin recovery 链接检查均返回线上 MoFish 根地址，2/2 通过。
仅使用新建随机临时账号、不发邮件；删除 HTTP 200、GoTrue 404 确认清理。
日志 `recovery-redirect-after-config.log` 保存在本轮证据目录。环境 spec revision 6 已观测为 current、网络 enforced、秘密和账号变量 ready。
URL 配置阻塞解除，真实 Safari 邮件打开、改密、退出并新密码登录仍待用户复测；尚不宣称密码重置验收通过。

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

## 历史：仍需完成的真实联调

- 两份真实 Supabase 数据库迁移及 13 项云端 SQL 验证已完成；本轮完整 `test:cloud` 23/23 通过，详见顶部最新记录。
- 用户已在真实测试入口完成注册确认邮件、验证后登录及电脑/手机同账号同步；截图显示已同步到 revision 2，随后用户确认跨设备登录和同步成功。这是用户侧验收证据，不是自动化管理冒烟。重置邮件、SMTP 配置、模板及跳转白名单仍未完整核验；验证链接曾打开困难但最终可用，原因尚未定位。
- Cloudflare 测试入口与线上 CSP 等响应头已验证，详见部署记录；SDK 登录后的 HTTP 冒烟通过，设备 UI 剩余项待验。
- 未测试 iOS Safari / Android Chrome 真机；移动尺寸测试属于浏览器视口仿真。
- 已核验 `7c975ddb20ac8de75f8b8460699778a48b46fa25` 的 [GitHub Actions #3](https://github.com/Mintzz666/MoFish/actions/runs/38865316559) 成功：严格 PostgreSQL 测试、构建、Wrangler 预演、本地假后端浏览器测试及运行库清理步骤均通过。这不替代真实 Auth/邮件验收。
- 用户已有 Cloudflare 账号（Tibo 正在使用）；Supabase 项目已创建并连接，无需再授权同一次迁移。
- 当前环境的 Cloudflare token/account 与三个目标域名已通过实际请求验证；公开 Supabase 构建配置已恢复到忽略的 `.env`。首轮部署的平台 readiness 为 `unknown`；本轮重新核验 spec revision 9，观测为 current，凭据和账号变量均 ready，网络 enforced。前轮完整冒烟所需管理密钥未配置；本轮已配置且实际请求通过，见顶部记录。私密配置不通过聊天传递。

## Cloudflare 测试部署记录（2026-10-16）

- 线上源码：`7c975ddb20ac8de75f8b8460699778a48b46fa25`，分支 `codex/phase-a-review-fixes`。
- 独立入口：https://mofish.tibo-reset-notifier.workers.dev ，不需要 ChatGPT 登录。
- Worker：`mofish`；Cloudflare version ID：`17b32988-f7e2-4b72-a062-0a3f9490fa15`。
- 构建、Wrangler 4.151.0 预演及实际部署成功；16 个可访问资源 HTTP 200，内容与本地构建逐字节一致。
- 线上 CSP、nosniff、DENY、COOP 生效；`config.js` / `sw.js` 返回 `Cache-Control: no-cache`。
- Chromium 1280×800 首页加载 HTTP 200，标题 MoFish，鱼缸 canvas 和登录入口存在，无页面脚本异常；390×844 无横向溢出。这是视口检查，不是真机或已登录跨设备验收。
- 36 项认证、配置及冒烟脚本回归通过，0 失败/跳过；未重新累计历史整套测试。
- 实际 Supabase `/auth/v1/settings` 返回 200，邮箱确认开启；匿名读取鱼缸表返回 401 / PostgreSQL `42501`，符合预期。没有创建真实账号、发送邮件或执行管理冒烟。
- Python 默认 User-Agent 被 Cloudflare 以 403 / 1010 拒绝；浏览器 User-Agent 与真实 Chromium 均成功，不能把默认脚本的 403 当作页面不可用。
- Tibo 的设置摘要和当前 deployment ID 在前后检查一致；旧 Sites 未访问或修改；现有构建/部署令牌保留，未轮换或撤销。
- 无凭据验证记录及截图：`/workspace/reviews/mofish-cloudflare-20261016/`。本轮 Chromium 已关闭，临时 profile 已清理。

## 历史：阶段 A 验收进度

| 门槛 | 当前证据 |
| --- | --- |
| 代码、旧存档兼容、账号/同步竞态 | 单元/集成及本地浏览器检查已通过 |
| 数据库 RLS、权限、原子 revision、真实并发成长 | 本地内核、多连接及真实 Supabase SQL 13 项通过；临时去掉行锁会复现重复奖励 |
| Supabase Auth / PostgREST 真实项目 | 已应用迁移；本轮完整管理/登录/刷新/恢复/受认证 RPC/越权拒绝/成长/清理 23/23 通过 |
| 验证及重置邮件实际投递 | 用户确认注册验证链路成功；密码重置邮件及 SMTP 配置仍待验证 |
| Cloudflare 独立 HTTPS 入口 | 已部署指定提交；线上资源一致性、响应头及 Chromium 首页检查通过 |
| 用户电脑/手机的真实网络体验 | 用户确认同账号登录和同步成功；线上冲突、离线重连、换号及重置流程仍待验证 |

以上未完成的真实环节通过前，阶段 A 不标记为完成；不提前开始 B/C/D。

## 历史：阶段 A 收口清单

最终验收对象、证据矩阵和剩余执行步骤见 [PHASE-A-ACCEPTANCE.md](PHASE-A-ACCEPTANCE.md)。
前轮补验 6 项真实公开/匿名 HTTP 均通过，完整 `test:cloud` 当时因管理变量缺失停止。本轮已解除该阻塞、23/23 通过；用户设备剩余验收未完成，阶段 A 仍未完成。

四阶段范围保持 `docs/ROADMAP.md` 的约定：A 身份与单用户云存档 → B 多人共享与成员权限 → C 页面与基础 3D → D 鱼体运动、水面、水草与造景。本轮只收口 A。

2026-10-16 用户最初确认各项均未测试，随后已完成注册验证、登录及电脑/手机同账号同步，并要求在收口前进一步打磨同步细节。该请求不属于正式版本验收。

按以下顺序补齐证据，每项记录日期、设备/浏览器、实际结果；未执行保持待验收：

| 项目 | 执行方式 / 通过标准 | 当前状态 |
| --- | --- | --- |
| 真实 HTTP 自动冒烟 | 用户在安全环境配置专用 `MOFISH_SMOKE_SERVICE_ROLE_KEY` 后运行 `npm run test:cloud`；随机测试账号登录/刷新、第二会话恢复、保存/冲突、越权拒绝、成长与清理全部成功；仅测试本轮账号 | 本轮 23/23 通过，含两个临时账号删除确认 |
| 邮件与回调 | 用户在 Supabase 核验 SMTP、Site URL 和 Redirect URLs 含测试入口；用专用测试邮箱从网页注册、收确认邮件并回到测试入口登录；忘记密码邮件回到同一入口，改密后重新登录成功 | 注册验证及登录已由用户确认；重置流程及配置核验待完成 |
| 双设备恢复 | 电脑 A 给鱼命名、喂食、改造景并等到已同步；手机 B 登录同账号，核对名字、鱼种、成长、造景，刷新后仍一致 | 用户确认电脑/手机同账号登录和同步成功；未声称已逐字段验收所有存档属性 |
| 冲突与离线 | A/B 从同 revision 同时编辑，只接受一个，另一端保留本地副本并显示冲突；离线编辑、重连、重复保存不丢档或重复成长 | 待线上实测；本地回归已通过 |
| 退出/换号/游客兼容 | 退出回到游客；测试账号乙看不到甲的数据；原游客存档、导入导出和备份保留；不使用重要个人存档做冲突试验 | 待线上实测；本地回归已通过 |
| 最终验收 | 上述结果补齐，修复实际发现的问题后由用户明确验收；产品版本建议 v0.2.0，正式发布按 AGENTS.md 单独执行 | 尚未验收、未发版 |

完整冒烟不发邮件，不能替代邮件验收；自动化两个会话不能替代用户真实电脑/手机网络检查。配置步骤和操作路径见 `docs/CLOUD-SETUP.md` 的 1.3、2.1、2.3。

## 收口前同步打磨（2026-10-16）

基于 `3122273833e52c2eafaf802b4011211f27c0f00e`，由 Codex 联合 Luna max 完成，最终提交以交接回复为准：

- 改动在去抖等待期间立即显示同步中；离线编辑直接保存未同步副本并保持离线提示，不反复发出注定失败的请求。撤回到已确认状态时取消无意义的待上传。
- 账号面板随离线、错误和冲突更新反馈，不残留旧的登录成功提示；同步/冲突操作有忙态与防重复保护，退出或换号后忽略旧操作的界面反馈。面板使用进度文案，不再要求用户理解 revision。
- 登录对账、重连与窗口聚焦的并发调用复用请求；成长结算期间的调用等待实际结果。忙态随当前会话释放，失败后可重试。
- 冲突出现后及解决请求期间继续编辑，最新本机内容持续落盘；保留本机时上传最新编辑，选择云端时备份最新本机副本。未成功读回云端备份前不执行覆盖。
- 可见窗口重新聚焦时检查云端；切后台时在本机落盘后立即尝试 keepalive 上传，降低移动端冻结去抖定时器导致的延迟。网络完成仍取决于浏览器，本机 pending 继续用于重启恢复；没有增加固定轮询。
- 不改数据库迁移、账号权限、存档结构或阶段 B/C/D；不获取已有用户数据，不发送测试邮件，不修改 Tibo/旧 Sites，也不轮换或撤销构建令牌。
- 独立验证：`MOFISH_REQUIRE_POSTGRES=1 npm test` **136/136 通过，0 失败、0 跳过**，含真实隔离 PostgreSQL 多连接；其中新增引擎回归 6 项、界面异步回归 5 项。`MOFISH_CHROME_NO_SANDBOX=1 npm run test:e2e` **57/57 通过**，含真实 dist + 本地假后端、窗口聚焦、后台立即上传、离线重连、冲突及 390/320px 布局；这些不是实际 Supabase Auth/邮件自动验收。部署源码见本轮交接回复。
- 精简日志位于 `/workspace/reviews/mofish-sync-polish-20261016/`，不提交 Git；测试仅操作本轮临时浏览器、假后端与隔离数据库，完成后清理本轮进程与运行库。

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
