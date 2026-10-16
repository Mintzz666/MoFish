# MoFish 云存档配置与运维（阶段 A）

本文是「邮箱密码登录 + 跨设备云存档」的落地指南：需要你在控制台做的最小步骤、部署与验证、
备份/恢复/回滚，以及本阶段尚未验证的边界。

配套实现：`supabase/migrations/`（数据库）、`web/cloud/*`（前端）、
`wrangler.toml`（Cloudflare 静态资源）、`.env.example`（变量清单）。

## 0. 一分钟总览

| 部分 | 承担什么 | 谁持有密钥 |
| --- | --- | --- |
| Cloudflare Workers 静态资源 | 托管网页（无服务端代码） | 无需密钥；部署用 `CLOUDFLARE_API_TOKEN` |
| Supabase Auth（GoTrue） | 邮箱注册、验证、登录、退出、重置密码 | 服务端持有；前端只用公开 key |
| Supabase Postgres + RLS | 存鱼缸存档、revision 并发控制、成长结算 | 同上 |

前端只会拿到 **项目 URL** 与 **anon / sb_publishable key**。这两项本来就是公开信息，数据边界靠
数据库的行级安全策略（RLS）保证，而不是靠隐藏 key。`service_role` 密钥能绕过 RLS，**绝不放进网页**：
`npm run build` 检测到它会直接失败。

## 1. 你需要做的最小步骤（按顺序）

### 1.1 创建 Supabase 项目

1. 登录 https://supabase.com/dashboard ，新建项目（免费额度足够原型使用）。
2. 记下 **项目 URL**（形如 `https://abcdefghijklmnop.supabase.co`）与 **anon key**
   （Project Settings → API Keys；新版可能显示为 `sb_publishable_...`）。
3. 注意：免费项目长期无访问会暂停，恢复需要控制台操作。

当前用户的 **MoFish 项目已创建并连接**：ref `jxqlzuvpuaqwcdvgxnle`，
URL `https://jxqlzuvpuaqwcdvgxnle.supabase.co`，实际地区 `ap-south-1`，PostgreSQL 17.11。
无需再建项目。公开 publishable key 已用于本轮构建，仅存于忽略的本机配置中，未提交仓库。
Cloudflare 可复用 Tibo 所用账号，为 MoFish 建独立 Worker `mofish`，不复用 Tibo 的 Worker 或数据库。

### 1.2 应用数据库迁移

**当前项目已于 2026-10-16 通过 Supabase 集成应用以下迁移，不需要手工重跑：**

| 云端版本 / 仓库文件 | 内容 |
| --- | --- |
| `20261016065742_phase_a_cloud_saves.sql` | 鱼缸表、RLS、权限和三个写入 RPC |
| `20261016070336_phase_a_cloud_hardening.sql` | 收回平台内部 `rls_auto_enable()` 的客户端执行权，优化 owner 策略的身份子查询 |

原 `0001_phase_a_cloud_saves.sql` 仅按首次云端实际记录的版本改名，SQL 字节未改，SHA256 为
`c58044a46bc978554449f9e09863401e8860fe6d0c206511b6b478113f08790f`。
后续 hardening 迁移的 SHA256 为
`83736e39e57690a501a5cd9b4fe7dcc883f9254357519ba7e6b8009f78ca8b41`。
本地版本与云端迁移历史已对齐；已应用的 SQL 保持只读，后续变更新增迁移。

需要为另一个全新项目部署时，先确认目标项目，再按文件名顺序应用这两份迁移；推荐通过 CLI
记录迁移历史（不要对当前项目重新初始化）：

```sh
npx supabase link --project-ref <project-ref>
npx supabase db push
```

迁移会创建 `public.aquariums` 表、RLS 只读策略、唯一索引 `aquariums_owner_phase_a_uidx`，
以及三个**受控写入函数** `ensure_aquarium` / `save_aquarium` / `settle_growth`
（外加内部校验函数 `mofish_state_error`）。

实际云端 SQL 验证通过 13 项：创建及幂等创建、本人读取、原子保存、旧 revision 冲突、
直接写表被拒、非法存档被拒、跨账号读取/保存/结算被拒、成长结算及重复调用不重复奖励、匿名访问被拒。
验证使用事务内专用测试身份并回滚；结束后 `auth.users` 和 `aquariums` 均为 0 行。
这证明真实云数据库的权限及函数行为，不替代 Auth 发信、JWT 刷新和 HTTP API 联调。

Supabase advisors：性能提示为 0；安全检查保留三个已登录角色可调用 `SECURITY DEFINER` RPC 的提示，
属于上面的受控写入设计，函数固定 search_path、检查用户及 owner，匿名执行权已收回。
参见 [官方提示说明](https://supabase.com/docs/guides/database/database-linter?lint=0029_authenticated_security_definer_function_executable)。
平台内部辅助函数的客户端执行权已撤回，自动 RLS event trigger 仍保留并启用。

**权限模型（重要，请勿改成给客户端写表权限）**：

| 角色 | 对 `aquariums` 的权限 | 说明 |
| --- | --- | --- |
| `authenticated` | 只有 `SELECT`（受 RLS 限制为本人行） | 没有任何 INSERT/UPDATE/DELETE |
| `anon` | 无 | 也不能执行任何函数 |
| 三个写入函数 | `SECURITY DEFINER`，属主是执行迁移的角色 | 内部自行校验 `auth.uid()`、参数与存档结构 |
| `mofish_state_error` | 不对客户端开放 | 只被上面三个函数内部调用 |

这样做的原因：如果客户端能直接写表，就能绕过函数里的 `revision` 自增、成长锚点与存档校验
（例如把 `revision` 改成任意值、把 `last_growth_at` 回拨来刷成长）。把写权限收掉之后，
「冲突检测、服务端校验、成长结算」才是数据库强制的边界，而不是「请前端不要直接调表」的约定。

### 1.3 配置认证（Authentication）

1. **Site URL** 与 **Redirect URLs** 白名单：把最终访问地址加进去，例如
   `https://mofish.<你的域名>/` 与本地联调用的 `http://localhost:5173/`。
   邮箱验证、重置密码的邮件链接会带回这些地址。
2. **确认邮件**：保持开启（推荐）。注册后用户必须点邮件里的链接才能登录。
3. **SMTP（上线前必做）**：Supabase 自带发信通道有严格频率限制，不适合真实用户。
   在 Authentication → Emails → SMTP Settings 里配置你自己的发信服务
   （Resend / Brevo / Mailgun / 自建 SMTP 均可）。SMTP 密钥只填在 Supabase 控制台，不要进仓库。
4. **本项目使用 implicit 流程**（不发送 `code_challenge`）：验证/重置链接会把令牌放在 URL 片段里
   返回，前端读取后立刻从地址栏清除。请不要在控制台或前端改成强制 PKCE。

### 1.4 构建与部署（Cloudflare）

推荐在本机 `.env` 或云环境的安全变量设置中填入 `.env.example` 所列配置。
构建/部署/冒烟 CLI 会读取仓库 `.env`，已经导出的环境变量优先。不要提交真实 `.env`。
Cloudflare API token 限定到目标账号所需的 Workers 部署权限，账号 ID 在 Cloudflare 控制台获取。
`deploy:cloudflare` 要求显式的账号 ID、token 和 Supabase 公开配置；缺失时停止，不发布游客构建。

```sh
npm run deploy:cloudflare -- --dry-run  # 构建并由 Wrangler 校验，不发布；无需 Cloudflare 凭据
npm run deploy:cloudflare              # 配置齐全后，构建并部署独立 mofish Worker
```

也可自行用 Wrangler 登录并执行：

```sh
# 1) 构建：把公开凭据写进 dist/config.js（不入库）
MOFISH_SUPABASE_URL="https://<project-ref>.supabase.co" \
MOFISH_SUPABASE_ANON_KEY="<anon 或 sb_publishable_ key>" \
npm run build

# 2) 部署（首次会要求浏览器登录 Cloudflare）
npx wrangler@4 deploy
```

- `wrangler.toml` 里 `[assets] directory = "./dist"`，**没有 Worker 脚本**，不需要也不会运行服务端逻辑。
- 上线后建议绑定自定义域名并确认 HTTPS 生效；域名确定后回到 1.3 更新 Site URL / Redirect URLs。
- 私有旧的 Sites 地址不受影响，可继续用于旧版体验。
- 每次改动配置文件后都要重新 `npm run build` 再部署：`dist/config.js` 是构建产物。
- 当前云环境没有 Cloudflare 凭据，且网络仅开放包仓库等域名。真实部署/HTTP 联调前需要在云环境网络设置
  放行 `api.cloudflare.com`、所选项目的 `<ref>.supabase.co` 及实际 `*.workers.dev` 入口，
  或在用户已登录的本机环境执行；本机凭据不会自动同步到云聊天。

若希望在 Cloudflare 控制台接 GitHub 自动构建，可为 `Mintzz666/MoFish` 单独创建 Worker，
开发分支选择 `codex/phase-a-review-fixes`，构建命令 `npm ci && npm run build`，部署命令
`npx wrangler@4 deploy`。只配置 Supabase 公开构建变量；service_role/SMTP 密钥不进入站点构建。
控制台连接 GitHub 及选择账号需用户完成；项目创建后提供访问 URL，再配 Auth 跳转白名单。

### 1.5 本地联调（不需要云账号也能跑）

```sh
npm start        # 先打包认证 SDK，再以 Node 预览 dist/，端口 5173
npm run build && npm run preview   # 服务 dist/，并应用 _headers（含 CSP），贴近线上行为
```

`npm run preview` 会解析 `_headers` 并在本地生效，因此 CSP 是否破坏应用可以在本机提前发现。
需要指向本地假后端时（仅测试）：

```sh
node scripts/serve.mjs --dir dist --port 5173 --allow-connect http://127.0.0.1:54321
```

## 2. 上线后验证清单

### 2.1 真实云端冒烟（推荐先跑这个）

```sh
MOFISH_SUPABASE_URL="https://<ref>.supabase.co" \
MOFISH_SUPABASE_ANON_KEY="<anon key>" \
MOFISH_SMOKE_SERVICE_ROLE_KEY="<service role key，只在本机环境变量里>" \
node scripts/cloud-smoke.mjs
```

脚本只接受 Supabase Legacy API Keys 中未过期、`role=service_role` 的 JWT，不支持 `sb_secret_`。
它会用随机邮箱创建本轮专用临时账号，通过应用的官方 SDK facade 验证登录和刷新，
再验证第二设备同账号恢复 → 保存 → 旧 revision 冲突 → **另一个账号越权读/改/删被拒** →
成长记账 → 服务端拒绝非法存档，并在结束时删除及验证本轮创建的账号。
不接受已有账号的邮箱密码，也不接触已有账号存档。任何接口错误、超时或清理失败都会使检查失败。
临时账号由管理员直接确认，不发注册邮件；真实邮箱验证/重置邮件仍需按 1.3 和 2.3 单独实测。

### 2.2 并发测试（两个真实数据库连接）

成长结算必须防并发重复奖励，这一点无法用单连接的内核验证，需要真实的多连接 Postgres：

```sh
npm run test:concurrency
```

- 默认用 `optionalDependencies` 里的 `embedded-postgres` 启动自己创建的隔离实例，使用独立临时目录与空闲端口。
  测试结束后关闭实例并清理本轮目录；启动失败也会清理确认无运行实例的目录。停止失败则保留目录并报告路径。
- **不再支持 `MOFISH_TEST_PG_URL`**：配置该变量会在连接前报错。不要把生产库、Supabase 项目或任何已有业务库交给破坏性测试。
- 嵌入式二进制缺失或本机动态库不兼容时，真实并发用例明确标 SKIP 并说明原因；安全隔离单测仍应执行。SKIP 不等于真实并发通过。
- 设置 `MOFISH_REQUIRE_POSTGRES=1` 时启动失败将使测试失败，CI 默认启用，不能靠跳过得到绿色检查。
- GitHub CI 在 Ubuntu 24.04/Node 22 上运行；`scripts/ci/prepare-postgres-runtime.sh` 将 SHA256 校验过的
  Ubuntu ICU 60 官方包解压到唯一临时目录，通过本进程 `LD_LIBRARY_PATH` 给 embedded PostgreSQL 使用，
  不替换系统库、不进入前端产物。该适配命令及 PostgreSQL 18.4 启动已在云环境实际验证。
- 本轮云端补跑真实多连接与安全隔离检查 **10/10 通过、0 跳过**；移除行锁的临时迁移副本会触发双重/三重奖励失败，
  真实迁移保持原样。PostgreSQL 测试不能替代 Supabase Auth/PostgREST 线上联调。

### 2.3 人工验证（两台设备）

1. 设备 A 打开站点 → 右上「登录 / 注册」→ 注册 → 收邮件点验证链接 → 登录，状态显示「已同步」。
2. 设备 A 给鱼改名、喂几条、种水草。
3. 设备 B（另一台电脑/手机或另一个浏览器）打开同一站点 → 登录同一账号 → 应看到 A 的名字、成长与造景。
4. 两台设备同时改同一缸：后保存的一台应显示「有冲突」，界面列出两份存档，任选一项都有备份留存。
5. 断网后改名 → 状态显示「离线」，恢复网络后自动写入云端。
6. 退出登录 → 回到本机游客存档；换另一个账号登录 → 不会看到前一个账号的数据。

## 3. 备份、恢复与回滚

**核心原则：代码回滚与数据库回滚是两件不同的事，都不以删库作为默认步骤。**

### 3.1 备份

```sh
# 全库（含 auth schema）逻辑备份；密码用控制台 → Database → Connection string 里的值
pg_dump "postgresql://postgres:<密码>@db.<ref>.supabase.co:5432/postgres" \
  --no-owner --no-privileges -Fc -f mofish-backup-$(date +%F).dump

# 只导出鱼缸数据（便于查看/迁移）
psql "postgresql://.../postgres" -c "\copy (select * from public.aquariums) to 'aquariums.csv' csv header"
```

付费计划如提供平台备份，也可在控制台使用；免费项目不要依赖自动备份，应自行保存并验证逻辑备份。
执行迁移之前先做一次备份，是本文档唯一强制的运维步骤。

### 3.2 恢复

- **数据被误改**：优先用备份恢复受影响的行，而不是整库回滚：
  `pg_restore --data-only --table=aquariums -d "<连接串>" mofish-backup-YYYY-MM-DD.dump`
  （恢复前先 `select ... into aquariums_before_restore` 留存当前状态，便于二次比对。）
- **整库重建**：`pg_restore -d "<连接串>" mofish-backup-YYYY-MM-DD.dump`，随后重新执行
  `supabase/migrations` 确保函数与策略是最新版。
- **误删单个账号**：Supabase Auth 的删除会级联删除其鱼缸（外键 `on delete cascade`）；
  恢复需要同时恢复 `auth.users` 与 `public.aquariums` 两份数据。

### 3.3 回滚

| 场景 | 做法 |
| --- | --- |
| 前端有新问题 | 用 Cloudflare 上一份部署回滚（Dashboard → Deployments → Rollback），数据库不用动 |
| 数据库函数/策略出错 | 对已经应用过的迁移保持只读，新增版本化修复迁移；先备份，在测试项目验证后再应用 |
| 需要彻底停用云功能 | 前端改回 `dist/config.js` 空配置（游客模式）并重新部署；数据库保留不动 |
| 确实要移除表 | **最后手段**：先备份并导出，再执行 `supabase/rollback/0001_phase_a_cloud_saves.down.sql`。该脚本会删表并连带删除全部云端存档，只在确认不再需要数据时使用 |

阶段 B 引入 `aquarium_members` 时需要新的迁移来放宽「每账号一条鱼缸」的唯一索引，
届时不要直接改本文件（已应用的迁移必须保持只读）。

## 4. 安全说明

- **官方认证 SDK 随站点发布**：`@supabase/auth-js` 在构建期打包到同源静态资源，不使用外部 CDN。
  应用 facade 用会话代次和令牌检查保护账号切换，SDK 不直接写应用的 localStorage。
- **公开 key 会出现在网页里**，这是设计如此：真正的边界是数据库权限与 RLS。客户端**没有任何表级写权限**，
  所有写入只能经过三个 `SECURITY DEFINER` 函数；函数内部按 `auth.uid()` 过滤归属并做参数/结构校验，
  越权请求在数据库层被拒绝。
- **邮件回调**：验证/重置链接把令牌放在 URL 片段里，前端读取后立刻 `history.replaceState` 清除；
  并且必须先用 `GET /auth/v1/user` 确认身份才落盘会话——否则会出现「界面显示已登录、同步引擎却是游客」的错位。
- **会话令牌保存在 localStorage**（与 Supabase 官方 SDK 的默认行为一致）。代价是：一旦页面被注入
  恶意脚本，令牌可能被读走。缓解措施：`web/_headers` 里的 CSP 只允许同源脚本
  （`script-src 'self'`），前端不使用 `innerHTML` 写入用户输入，不从外部站点加载脚本。
  如果这层风险不可接受，改造方向是会话只存内存 + 每次打开重新登录（未在本阶段实现）。
- **管理密钥**：`service_role` 仅用于本地脚本/CI；`npm run build` 会拒绝把它打进前端。
- **不缓存云数据**：Service Worker 只缓存同源静态资源；Supabase 请求跨源，直接放行、不进缓存。
- **邮箱枚举**：重置密码对未注册邮箱也返回成功，界面提示一致，不暴露账号是否存在。
- **调试开关**：前端没有任何隐藏后门；需要人工排查时用浏览器 DevTools 即可。

## 5. 常见问题

| 现象 | 原因与处理 |
| --- | --- |
| 状态显示「未连接云端」 | 没配 `dist/config.js`，或 key 格式不被识别。重新执行 1.4 的构建命令 |
| 登录报「接口不存在 / 云服务接口不可用」 | 迁移没应用（RPC 不存在）或项目地址写错。执行 1.2 |
| 注册后收不到邮件 | 未配 SMTP 或超出默认发信频率限制，见 1.3；先看垃圾箱 |
| 点邮件链接回到首页但没有登录 | Redirect URLs 白名单里没有当前域名，见 1.3；确认链接是**新开文档**（只改 hash 的导航不会触发回调处理） |
| 一直「同步中」 | 看 DevTools Network：401 → 会话失效需重新登录；404 → 迁移缺失；403 + `permission denied for table aquariums` → 迁移没跑完整（写权限收回后表级写必须报这个错，属预期）；跨域报错 → CSP 的 `connect-src` 是否包含你的项目域名 |
| 存档写不进去、返回 `invalid_state` | 服务端校验比前端严（缺字段/重复鱼 id/越界值都会被拒）。先导出存档对照字段，不要放宽服务端校验 |
| 部署后样式/脚本没更新 | Service Worker 已缓存旧静态资源；本地开发可在 DevTools → Application → Service Workers 里 unregister，线上刷新两次即可 |

## 6. 本阶段未验证的部分（不要当成已完成）

- **真实 Auth / PostgREST HTTP 联调**：真实项目迁移和 13 项云端 SQL 验证已完成；
  `npm run test:cloud` 尚未执行，真实 JWT 刷新、REST 错误码及网页到 API 的链路仍待验证。
- **真实发信**：验证邮件与重置邮件的实际投递、模板与跳转未在真机邮箱验证。
- **Cloudflare 线上部署**：`_headers`（含 CSP）只在本地预览服务器上验证过，未在 Cloudflare 上实测。
- **真机浏览器**：iOS Safari / Android Chrome 未实测（本轮为 Chrome headless + 真实视口仿真）。
- **多人共享、3D、页面重设计**：属于阶段 B/C/D，本阶段未实现。
