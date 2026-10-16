# MoFish 云存档配置与运维（阶段 A）

本文是「邮箱密码登录 + 跨设备云存档」的落地指南：需要你在控制台做的最小步骤、部署与验证、
备份/恢复/回滚，以及本阶段尚未验证的边界。

配套实现：`supabase/migrations/0001_phase_a_cloud_saves.sql`（数据库）、`web/cloud/*`（前端）、
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

### 1.2 应用数据库迁移

方式一（最省事）：控制台 → SQL Editor → 新建查询 → 粘贴
`supabase/migrations/0001_phase_a_cloud_saves.sql` 全文件 → Run。
脚本是幂等的（`create ... if not exists` / `create or replace`），重复执行不会报错也不会丢数据。

方式二（有 supabase CLI 时）：

```sh
npx supabase link --project-ref <project-ref>
npx supabase db push
```

迁移会创建：`public.aquariums` 表、RLS 策略、唯一索引 `aquariums_owner_phase_a_uidx`，
以及三个函数 `ensure_aquarium` / `save_aquarium` / `settle_growth`（外加校验函数 `mofish_state_error`）。

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

### 1.5 本地联调（不需要云账号也能跑）

```sh
npm start        # 服务 web/ 源码，端口 5173（Python 静态服务，方便直接改代码）
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

它会真实执行：开缸 → 保存 → 旧 revision 冲突 → **另一个账号越权读/改/删被拒** →
幂等成长结算 → 服务端拒绝非法存档，并在结束时清理它创建的测试账号。
没有 service_role key 时，也可以提供两个已确认邮箱的账号（见脚本头部注释）。

### 2.2 人工验证（两台设备）

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

也可以在控制台 → Database → Backups 使用平台备份（免费项目的保留窗口有限，不要当唯一手段）。
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
| 数据库函数/策略出错 | 重新应用 `supabase/migrations/0001_phase_a_cloud_saves.sql`（幂等），修复后用同一脚本覆盖 |
| 需要彻底停用云功能 | 前端改回 `dist/config.js` 空配置（游客模式）并重新部署；数据库保留不动 |
| 确实要移除表 | **最后手段**：先备份并导出，再执行 `supabase/rollback/0001_phase_a_cloud_saves.down.sql`。该脚本会删表并连带删除全部云端存档，只在确认不再需要数据时使用 |

阶段 B 引入 `aquarium_members` 时需要新的迁移来放宽「每账号一条鱼缸」的唯一索引，
届时不要直接改本文件（已应用的迁移必须保持只读）。

## 4. 安全说明

- **公开 key 会出现在网页里**，这是设计如此：真正的边界是 RLS。所有数据库访问都必须经过
  `auth.uid()` 判断，越权请求在数据库层被拒绝（含 RPC 内部的身份与参数校验）。
- **会话令牌保存在 localStorage**（与 Supabase 官方 SDK 的默认行为一致）。代价是：一旦页面被注入
  恶意脚本，令牌可能被读走。缓解措施：`web/_headers` 里的 CSP 只允许同源脚本
  （`script-src 'self'`），前端不使用 `innerHTML` 写入用户输入，也没有第三方脚本。
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
| 点邮件链接回到首页但没有登录 | Redirect URLs 白名单里没有当前域名，见 1.3；本项目使用 implicit 流程 |
| 一直「同步中」 | 看 DevTools Network：401 → 会话失效需重新登录；404 → 迁移缺失；跨域报错 → CSP 的 `connect-src` 是否包含你的项目域名 |
| 部署后样式/脚本没更新 | Service Worker 已缓存旧静态资源；本地开发可在 DevTools → Application → Service Workers 里 unregister，线上刷新两次即可 |

## 6. 本阶段未验证的部分（不要当成已完成）

- **真实 Supabase 项目联调**：本轮没有云账号，`npm run test:cloud`（`scripts/cloud-smoke.mjs`）
  已写好但**尚未执行过**；数据库侧的 RLS/冲突/幂等只用本机真实 Postgres 引擎（PGlite）验证过。
- **真实发信**：验证邮件与重置邮件的实际投递、模板与跳转未在真机邮箱验证。
- **Cloudflare 线上部署**：`_headers`（含 CSP）只在本地预览服务器上验证过，未在 Cloudflare 上实测。
- **真机浏览器**：iOS Safari / Android Chrome 未实测（本轮为 Chrome headless + 真实视口仿真）。
- **多人共享、3D、页面重设计**：属于阶段 B/C/D，本阶段未实现。
