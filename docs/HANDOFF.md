# MoFish 开发交接

当前状态：阶段 A（邮箱密码登录 + 单用户跨设备云存档 + Cloudflare 独立入口）的代码、数据库迁移、
测试与配置文档已完成，位于 `hermes/cloud-auth-sync` 分支，等待 Codex 评审与用户验收。
**真实云账号联调尚未进行**，因此「云端可用」这一结论目前只由本地真实 Postgres 引擎与本地假后端支撑，
不能被当成 Supabase 线上验证通过。

## 本轮目标

- 用户任务：按 `docs/HERMES-PHASE-A-PROMPT.md` 实施阶段 A —— Cloudflare 独立网页入口 +
  Supabase 邮箱密码认证与云存档；保留现有 2D 鱼缸；不同时做多人或 3D。
- 验收标准：两台设备同账号恢复同一鱼缸；不同账号互相隔离；离线/冲突不丢档；无 ChatGPT 登录门槛；
  未配置云服务时正常降级为游客模式。
- 开发分支：`hermes/cloud-auth-sync`
- 基线 commit SHA：`1ed9040ebf79da972540884017b02b8ac7335d0c`（origin/main）
- 本轮实现 commit / 父提交 SHA：见本轮交接回复（文档不记录自身 SHA，避免为写 SHA 反复提交）

## 代码改动与设计选择

### 新增

| 文件 | 作用 |
| --- | --- |
| `supabase/migrations/0001_phase_a_cloud_saves.sql` | `aquariums` 表、RLS 策略、服务端存档校验函数、三个 RPC（幂等开缸 / 原子保存 / 幂等成长结算） |
| `supabase/rollback/0001_phase_a_cloud_saves.down.sql` | 最后手段的删对象脚本（带备份警告；不是默认回滚步骤） |
| `web/storage.js` | 本地存储层：游客存档（沿用 `mofish.v1`）+ 按「账号 + 鱼缸」隔离的缓存 / 未同步副本 / 备份 |
| `web/cloud/config.js` | 读取并校验云端配置；识别并拒绝 service_role / secret key |
| `web/cloud/auth.js` | Supabase Auth（GoTrue）REST 客户端：注册、登录、刷新、退出、重置、改密、回调解析、错误映射 |
| `web/cloud/api.js` | PostgREST 客户端：只调用三个 RPC；401 自动刷新重试一次；超时与错误归类 |
| `web/cloud/sync.js` | 同步状态机：对账、去抖写入、revision 冲突、离线保留、成长记账、账号隔离 |
| `web/cloud/client.js` | 把认证与数据接口装配成一个云栈（app 与测试共用，避免接线分叉） |
| `web/ui/account.js` | 账号面板：登录/注册/忘记密码/设置新密码/退出/冲突处理/备份导出 |
| `web/config.js` | 云端配置占位（空 = 游客模式）；构建时被 `build.mjs` 覆盖为 `dist/config.js` |
| `web/_headers` | Cloudflare 响应头（含 CSP、`X-Frame-Options`、`sw.js` no-cache） |
| `wrangler.toml` | Cloudflare Workers 静态资源配置（纯静态，无 Worker 脚本） |
| `.env.example` | 变量清单，明确区分允许进前端的公开 key 与必须保密的密钥 |
| `scripts/serve.mjs` | 本地预览服务器：解析并应用 `_headers`，让 CSP 在本地就能提前暴露问题 |
| `scripts/cloud-smoke.mjs` | 对**真实 Supabase**的冒烟测试（认证、RLS 越权、revision 冲突、幂等结算、自动清理） |
| `docs/CLOUD-SETUP.md` | 控制台最小步骤、部署、验证清单、备份/恢复/回滚、安全说明、常见问题 |
| `tests/storage.test.js`、`tests/cloud-config.test.js`、`tests/cloud-auth.test.js`、`tests/cloud-sync.test.js` | 单元与契约测试 |
| `tests/sql/*` | 在真实 Postgres 引擎（PGlite/WASM）上执行真实迁移，验证 RLS / RPC / 冲突 / 幂等结算 |
| `tests/fake-supabase/*` | 本地假 Supabase（GoTrue + RPC 语义），供单元测试与浏览器端到端使用 |
| `tests/e2e/cloud-e2e.mjs` | 浏览器端到端：两台设备、冲突、旧存档选择、离线重连、CSP、手机与电脑布局 |

### 修改

- `web/app.js`：接入存储层与同步引擎；游客模式保留原有的本地离线成长，登录后改由服务端结算；
  每 15 秒只写 localStorage 且仅在内容变化时写；`visibilitychange` / `pagehide` / `online` / `offline`
  分别触发同步或落盘；启动时**不再**主动创建游客存档。
- `web/model.js`：新增 `STATE_VERSION`、`cloneState`、`canonicalState`（用于判断「是否真的有变更」，
  刻意排除 `savedAt` 与每帧位置）。存档结构本身未变，仍是 `version: 1`。
- `web/index.html`、`web/style.css`：页头状态标签与账号入口、账号面板、冲突与备份区块；
  文案从「无需登录」更新为「本地保存 · 可选云同步」。
- `web/sw.js`：明确只缓存同源静态资源，跨源（Supabase）放行，`/auth/`、`/rest/`、带 Authorization 的请求
  一律不进缓存；缓存版本升到 `mofish-static-v2`。
- `build.mjs`：构建期注入 `dist/config.js`；检测到 service_role/secret key 直接让构建失败；
  校验放在删除 `dist/` **之前**，避免配置写错时破坏上一次可用产物。
- `package.json`：新增 `preview`、`test:cloud`、`test:e2e` 脚本；新增仅用于测试的 devDependency
  `@electric-sql/pglite`（未安装时 SQL 集成测试会明确 SKIP，不会假装通过）。
- `.gitignore`：忽略 `.env`、`.dev.vars`、`.wrangler/`。
- `README.md`：新增「云存档（阶段 A）」与新的同步设计说明。

### 存档格式与兼容

- 游戏存档结构**未变化**（仍是 `version: 1`：`fish/plants/night/sound/savedAt`），因此旧本地存档、
  旧的 JSON 导出/导入都继续可用；游客存档键名仍是 `mofish.v1`。
- 云端新增的是**同步元数据**（revision、成长锚点）与按账号/鱼缸隔离的本地缓存键，
  不改动游戏存档本身。服务端会校验存档结构并且只接受 `state_version = 1`。
- 登录前若本机有旧存档而云端也有存档，界面会让用户选择保留哪一份；被放弃的一份会归档为本机备份
  （`mofish.backup.*`，每个鱼缸最多 3 份，可导出）。

### 关键设计选择（请评审时重点看）

1. **不引入 `supabase-js`**：只用 6 个公开 REST 端点自实现客户端。理由是保持零第三方运行时代码、
   避免依赖 CDN（国内网络不稳），并且全部逻辑可审查。代价是刷新令牌轮转与错误码映射需要自己维护。
2. **认证流程用 implicit**：不发送 `code_challenge`，邮件链接把令牌放在 URL 片段，前端读取后立刻
   `history.replaceState` 清除。
3. **成长记账**：已登录时客户端不做本地时间成长，由服务端 `settle_growth` 按服务端时间整秒结算
   （锚点推进到 `now()`，被 24 小时上限截掉的余量按设计丢弃，与本地 `clamp` 语义一致）。
   若此时本机还有未同步改动，客户端把服务端返回的 `credited_seconds` 增量同样记到本地副本上再合并，
   保证同一段时间只加一次、离线喂食等用户动作不丢。
4. **冲突处理**：revision 冲突时不重试覆盖，先保留未同步副本；用户选「用本机覆盖云端」时会先取云端
   最新状态，**把将被覆盖的云端版本归档为本机备份**，再用最新 revision 重试；选「采用云端」时把本机
   未同步副本归档为备份。
5. **阶段 A 每账号一条鱼缸**（唯一索引 `aquariums_owner_phase_a_uidx`）。ROADMAP 提到的
   「导入为新缸」需要有第二条鱼缸，本阶段未提供该选项（选择界面只有「采用云端 / 用本机覆盖云端 /
   稍后决定」）。阶段 B 引入成员关系时需新增迁移来放宽该索引。

## 验证证据

| 项目 | 实际命令或操作 | 结果 |
| --- | --- | --- |
| 逻辑 / 契约测试 | `npm test` | **83 tests / 83 pass / 0 fail / 0 skipped**（Node v22.23.2） |
| 其中：数据库迁移与 RLS | `tests/sql/migrations.test.js`（真实 Postgres 引擎 PGlite，跑的是仓库里的迁移文件） | 21 项通过：迁移幂等重放、跨账号读/改/删与 RPC 越权被拒、伪造 owner 插入被拒、匿名与无 claims 被拒、原子 revision 成功/冲突/不存在、9+X 类非法存档被服务端拒绝、成长结算幂等与 24 小时封顶、时钟回拨不产生负成长 |
| 其中：同步引擎契约 | `tests/cloud-sync.test.js` | 25 项通过：游客模式零请求、开缸 created 标志、第二设备恢复、去抖只写一次、无变更不写、冲突两种处理与备份留存、旧存档选择、离线保留与重连、5xx 不丢档、非法存档不重试、令牌过期自动刷新、结算只加一次、换号不串档 |
| 静态构建 | `npm run build` | 成功，`dist/` 输出 9 个文件 + `cloud/`、`ui/` 目录 + `_headers`；未配置时明确输出「游客模式」 |
| 构建安全闸 | 用 service_role JWT 作为 `MOFISH_SUPABASE_ANON_KEY` 构建 | **构建失败并给出中文说明**（exit 1），且不会破坏上一次的 `dist/` |
| 浏览器端到端（电脑） | `node tests/e2e/cloud-e2e.mjs`（Chrome 152 headless，真实构建产物 + 本地假 Supabase + `_headers` 生效） | **39/39 通过**：两设备同账号恢复、改名去抖只写一次、revision 冲突与两种处理（含备份留存）、旧存档与云端并存时的选择、离线改动→重连写入、成长结算不重复奖励、无 CSP 违规、无前端错误 |
| 浏览器端到端（手机） | 同上，真实移动视口仿真 | 390×844 与 320×568：`scrollWidth == innerWidth`（无横向溢出），账号面板完整可见（356px / 286px 宽），冲突区按钮不再被压成竖排 |
| 部署前自检 | `npm run preview` + `curl` 检查响应头 | CSP、`X-Frame-Options: DENY`、`Referrer-Policy`、`X-Content-Type-Options`、`sw.js` 的 `Cache-Control: no-cache` 均生效；未知路径返回 404（与 `not_found_handling = "none"` 一致）；目录穿越请求被拒 |
| 缺少测试依赖时的诚实降级 | 临时移走 `node_modules` 后运行 `node --test tests/sql/migrations.test.js` | 全部标记 **SKIP** 并说明原因，不会伪装成通过 |

本轮测试过程中发现并修掉的真实缺陷（都已补测试或明确说明）：

1. `settle_growth` 初版在 24 小时封顶后会把被截掉的余量在下次调用补发 → 改为结算后把锚点推进到
   `now()`，并加回归测试「封顶后不补发」。
2. 迁移里 `mofish_state_error` 撤权后没授权给 `authenticated`，`SECURITY INVOKER` 的 RPC 调用会因
   EXECUTE 权限被拒 → 补授权，由 SQL 集成测试发现。
3. `conflictDetail()` 在「保存时 revision 冲突」这种 `cloudState` 为 null 的情况下抛异常，
   导致界面状态卡在「同步中」→ 增加 `cloudKnown` 标记并容错，补了单元测试。
4. 应用启动时无条件写入游客存档，导致从未玩过游客模式的访客首次登录时被误判成「本机已有一份存档」，
   弹出多余的选择 → 改为仅在内容变化时落盘，由端到端测试发现。
5. `scripts/serve.mjs` 命令行入口读取了入参而非返回值，`npm run preview` 会直接崩溃 → 已修复并实测。

## 复现与体验步骤

```sh
git fetch origin && git checkout hermes/cloud-auth-sync
npm install            # 仅为 SQL 集成测试安装 PGlite；不装也能跑其余测试
npm test               # 83 项
npm run build
npm run preview        # http://127.0.0.1:5173 ，已应用 _headers
# 浏览器打开 → 右上「登录 / 注册」→ 未配置云端时会明确提示未连接云端，游客模式可正常游玩
npm run test:e2e       # 需要本机 Chrome；会用本地假后端跑完整两台设备流程
```

配置真实云服务（拿到 Supabase 项目后）：见 `docs/CLOUD-SETUP.md` 的 1.1–1.5；
上线后先跑 `npm run test:cloud`（脚本会真实建号、验证越权被拒、验证幂等结算，并自动清理测试账号）。

## 已知问题与评审重点

### 阻塞项（需要云账号才能真正闭环）

- **真实 Supabase 未联调**：`scripts/cloud-smoke.mjs` 已写好但**从未执行过**；GoTrue 的 HTTP 行为、
  JWT 签发与过期、PostgREST 的实际错误码都还没有被真实服务验证过。数据库侧的 RLS / 冲突 / 幂等结算
  已在本机真实 Postgres 引擎上验证，但那不等于 Supabase 线上验证。
- **真实发信未验证**：邮箱验证与重置密码的实际投递、模板、跳转地址依赖控制台 SMTP 配置。
- **Cloudflare 未部署**：`wrangler.toml` 与 `_headers` 只在本地预览服务器上验证过，未在 Cloudflare 上实测
  （CSP 是否与线上注入的其他响应头冲突、静态资源行为都需要上线确认）。
- **真机浏览器未验证**：iOS Safari / Android Chrome 未实测；本轮是 Chrome headless + 真实视口仿真。
- **无 CI**：仓库没有 `.github/workflows`，上述命令都是本机手工执行的结果。

### 希望 Codex 重点评审的问题

1. 自实现 GoTrue 客户端（不用 supabase-js）是否可接受？特别是刷新令牌轮转、并发刷新去重、
   会话过期判定与错误码映射有没有遗漏的坑（`web/cloud/auth.js`）。
2. 成长记账模型：已登录且离线时不做本地时间成长、存在未同步改动时把 `credited_seconds` 增量记到本地副本
   再合并（`web/cloud/sync.js` 的 `applyGrowthDelta` 与 `syncNow`）。请对照
   `tests/cloud-sync.test.js`「本机有未同步改动时…」用例判断是否会重复计算或丢成长。
3. 冲突语义是否满足「不静默覆盖」：`resolveConflict('local')` 会先取云端最新状态并归档备份再覆盖；
   `resolveConflict('cloud')` 会归档本机副本。请判断是否还有更该保留的东西。
4. 服务端校验 `mofish_state_error` 的边界是否足够（例如 `savedAt` 未校验上限、`species` 上限 3 与前端
   `SPECIES` 长度耦合、额外字段允许透传）。
5. 会话令牌存 localStorage 的取舍与 CSP 是否足够；是否需要改成内存会话 + 每次重登。
6. Service Worker 的排除规则（跨源、`/auth/`、`/rest/`、带 Authorization 的请求）是否足够严格。
7. 阶段 B 的前瞻：放宽「每账号一条鱼缸」唯一索引、引入 `aquarium_members` 时，本轮的 RPC 与策略
   需要怎样演进才不需要改动已应用的迁移。

### 其它已知限制（有意为之，非缺陷）

- 已登录且离线期间，鱼缸不会在本地按时间成长（避免与服务端重复计算），重连时由服务端一次结算。
- 服务端 24 小时上限截掉的余量会被丢弃（与本地 `clamp` 语义一致）。
- 阶段 A 一个账号只有一条鱼缸，因此没有「导入为新缸」选项。
- 本地缓存与未同步副本都只保存在浏览器；清除浏览器数据会删掉它们（云端存档不受影响）。
- 免费 Supabase 项目闲置会暂停；默认发信通道不适合真实用户，上线前必须配 SMTP。

## 版本与部署

- 用户是否验收：尚未验收本轮工作。
- 是否调用正式发布 hook：否（未合并 main、未打标签、未运行 release）。
- 是否更新线上站点：否（未部署 Cloudflare，也未改动原有私有 Sites 地址）。
- 建议版本：阶段 A 目标为 `v0.2.0`，由用户在验收后决定是否调用 release hook。
