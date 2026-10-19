# MoFish

一个用来短暂休息的电子鱼缸。3D 主视图（WebGL，本机 GPU）+ 2D 降级，鱼、水草、石头、沉木全部程序化生成；
认证 SDK 与 three.js 随站点打包发布，不从外部 CDN 加载代码、图片或字体。

- 9 种鱼型、6 类水草、5 类石头、2 类沉木，同种鱼有稳定的随机颜色/花纹/体型差异；
- 鱼苗 → 幼鱼 → 亚成年 → 成年四阶段，时间与实际进食共同决定成长（自然约 14 天、正常喂食约 10 天）；
- 造景可移动、转向、有限缩放、换造型、撤销，结果随存档持久化；
- 无 WebGL / 上下文丢失时自动切 2D，共用同一份存档。

游客模式完全在本机运行，不需要账号；也可以注册邮箱账号，把鱼缸同步到云端，在多台设备上接着养。

## 文档

- [成长规则](docs/GROWTH-RULES.md)
- [视觉与渲染设计](docs/VISUAL-DESIGN.md)
- [阶段 B 实施记录](docs/POST-A-PROGRESS.md)
- [阶段 B 验收记录](docs/POST-A-ACCEPTANCE.md)
- [云端部署](docs/CLOUD-SETUP.md)、[协作流程](docs/HERMES-COLLABORATION.md)、[交接](docs/HANDOFF.md)

## 运行

需要 Node.js 22+ 与 npm（测试、打包及本地预览）。

```sh
npm ci
npm start
# 构建后启动预览，浏览器访问 http://127.0.0.1:5173
npm test          # 逻辑与同步单元测试（含真实 Postgres 引擎上的 RLS/迁移集成测试）
npm run build     # 生成 dist/
npm run preview   # 服务 dist/ 并应用 _headers（含 CSP），用于部署前自检
npm run test:e2e  # 浏览器端到端（需要本机 Chrome；用本地假后端模拟云服务）
npm run test:concurrency   # 安全隔离检查及自建临时 Postgres 多连接测试（见 docs/CLOUD-SETUP.md）
npm run deploy:cloudflare  # 配置 Supabase 公开值及 Cloudflare 部署凭据后，构建并部署独立 mofish Worker
```

`dist/` 可部署至 Cloudflare Workers 静态资源、GitHub Pages 或任意 HTTPS 静态托管。无需常驻应用服务器。
首次加载完成后通过 Service Worker 缓存静态资源，可离线使用；浏览器安装方式因平台而异。

构建和部署会读取本机 `.env`（不会覆盖已设置的环境变量）；样例见 `.env.example`，不要提交真实配置。
部署命令要求完整云配置，缺失时直接停止，避免误把游客构建当作云端版本发布。

GitHub PR 和 main 推送会运行 `.github/workflows/ci.yml`：单元、SQL/真实多连接、构建及浏览器测试。
CI 用校验过的 ICU 60 包提供隔离兼容库，并开启 `MOFISH_REQUIRE_POSTGRES=1`，数据库启动失败会使检查失败。

浏览器测试可通过 `MOFISH_CHROME_PATH` 指定 Chrome/Chromium；每轮使用独立临时 profile 和调试端口。
测试退出会关闭自己启动的浏览器与服务，默认清理临时产物；失败或传入 `--keep` 时保留截图/结果用于排查。
只在受信任的隔离环境确有需要时设置 `MOFISH_CHROME_NO_SANDBOX=1`，不要用于日常浏览。

## 云存档（阶段 A）

邮箱密码注册登录 + 单用户跨设备云存档，技术方案：Cloudflare Workers 静态资源（独立入口，不要求
ChatGPT 登录）+ Supabase Auth + Supabase Postgres（RLS + revision 条件更新）。

- 未配置云服务时自动降级为游客模式，界面明确标注「未连接云端」，不会发起任何网络请求。
- 已登录时状态会显示为 游客 / 离线 / 同步中 / 已同步 / 同步失败 / 有冲突。
- 只同步持久属性（鱼的身份、名字、种类、成长、喂食记录、造景）；每帧位置与水面光影在本机计算。
- 云端写入按 2.5 秒去抖，且只在内容真的变化时才发请求；已登录时的离线成长由服务端按时间结算
  （上限 24 小时，重复请求不重复奖励）。
- 冲突（两台设备同时改同一版本）由数据库 revision 判定：后写入的一方保留本机副本并交给用户选择，
  不会静默覆盖；被放弃的那一份会归档为本机备份，可导出。
- 本地缓存按「账号 + 鱼缸」隔离，退出或换号不会串档；登录前的游客存档仍保留在原处。

配置步骤、部署、备份/恢复/回滚与安全说明见 [`docs/CLOUD-SETUP.md`](docs/CLOUD-SETUP.md)。
产品路线与各阶段的验收标准见 [`docs/ROADMAP.md`](docs/ROADMAP.md)。

## 首版功能

- 响应式鱼缸、自然游动、点击/触屏投食、鱼追逐食物并成长。
- 最多 12 条鱼，改名、成长与投喂记录，最多 14 株水草及可持久石头/沉木造景。
- 昼夜、主动开启的合成水声、全屏（浏览器支持时）。
- 每 15 秒及切换后台时本地保存；离线成长上限 24 小时，不会饿死。
- JSON 存档导出与校验导入；导入前确认覆盖。清除浏览器数据会删除本地进度。
- 支持空格/回车投食、键盘工具按钮、减少动态效果偏好。

## 实施计划

1. **首版**：完成本地可玩、离线缓存、存档备份与移动布局。
2. **阶段 A**：邮箱登录、跨设备云存档和独立入口，已验收。
3. **阶段 B**：体素3D鱼缸、四阶段成长、持久造景及2D降级，已独立部署，待用户真机接受。
4. **阶段 C**：定向邀请、主人/编辑/观看权限、操作合并/冲突备份和实时版本通知，已实施并通过真实QA检查、独立部署，待用户验收。

最新入口：[MoFish C](https://mofish-phase-c.tibo-reset-notifier.workers.dev/)。完整证据见 [C验收记录](docs/PHASE-C-ACCEPTANCE.md)，人工检查见 [集中清单](docs/PHASE-C-DEVICE-ACCEPTANCE.md)。开发部署不代表正式release。

阶段划分与验收标准以 [`docs/ROADMAP.md`](docs/ROADMAP.md) 为准。

## 同步设计

云端权威数据是 Supabase Postgres 里的一行：`aquariums(id, owner_id, revision, state_version, state_json, created_at, updated_at, last_growth_at)`。
A/B个人缸写入带 `expected_revision` 走 `save_aquarium` 这个条件更新 RPC：revision 不匹配就返回 conflict 与
服务端当前版本，客户端保留未同步副本并交给用户选择，不使用客户端时间戳做「最后写入覆盖」。
离线成长由 `settle_growth` 按服务端时间整秒结算（上限 24 小时），锚点推进到 `now()`，因此重复调用不会重复奖励。

前端侧：`web/model.js` 是纯领域逻辑，`web/storage.js` 负责按账号/鱼缸隔离的本地缓存，
`web/cloud/*` 负责认证、数据接口与同步状态机，`web/ui/account.js` 只做表单与状态呈现。
Service Worker 只缓存同源静态资源，认证与存档接口不进入缓存。

C新增 `mofish_members` 等表，保留每人一个个人缸，通过成员关系加入别人的缸。C使用带唯一operation_id的语义操作RPC，合并不同物件改动；共享缸拒绝旧整缸覆盖。Realtime只提示版本后重新授权读取，队列按账号/缸隔离。
迁移历史及安全回滚见C验收记录；已应用迁移不重放。

## 用户确认版本后的发布 hook

这是一条由协作助手在你确认版本后调用的发布命令，不会监听聊天，也不会在每次保存或提交时自动发版。约定保存在 `AGENTS.md`，后续在此仓库工作的助手应遵守。

你说“这个版本可以了”后，助手审查并提交代码，再执行：

```sh
npm run release -- --dry-run
npm run release -- --message "当前版本的简短说明"
# 指定版本时：
npm run release -- --version 0.2.0 --message "新增功能说明"
```

首次使用 package.json 中的版本（当前为 0.1.0），后续默认递增 patch。Hook 要求工作区干净、测试和构建通过、远端 main 没有未整合变更；然后原子推送 main 与带说明的版本标签。失败时保留本地提交及标签供重试，不强制推送。不创建 GitHub Release 页面；版本入口是 GitHub Tags。Sites 上线需单独执行。

运行要求：已安装 Git/Node/Python（预览用），配置 origin 及有效的 GitHub 写入凭据；正式发布需要 Git 提交身份。脚本不保存任何凭据。
