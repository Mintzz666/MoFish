# MoFish 交接

## C 真机反馈修复（2026-10-20，当前部署）

用户反馈选中已有造景后缺少确认退出。已在缸内工具条补「完成布景」，点击保留调整、取消选中并回到观赏；
新增物件继续先「放在这里」再「完成布景」。随后反馈新增对象不清楚，已加暖金高亮和深边定位圈、
修正矮石头被沙面遮住、窄屏工具条遮住物件。当前C入口源码
`640d43042f8878dcf24b46f327679b6159e7e68f`，Cloudflare version
`5d630ba3-ef73-42cd-ae1f-2c81c5fd5c3c`。浏览器完整回归96/96（假后端），最后布局修改后造景专项29/29，
场景测试4/4；已查看桌面/390px截图，线上五个相关文件/配置/CSP/缓存核验23/23。
用户真实账号与鱼缸未操作；A/B Worker及数据库未改。详细记录见 [真机反馈](PHASE-C-DEVICE-FEEDBACK.md)。
截图显示桌面已登录/同步，跨设备同步尚待用户按步骤确认；下文QA零数据是此前自动化结束时的历史状态，勿据此删除后续用户数据。

## C 实施与整体优化（2026-10-20，最新入口）

用户明确授权在B真机验收前继续多人C、与Luna max协作、整体自查和审美/交互升级，
并允许向既有QA项目追加C迁移、部署独立C Worker及其回调。B尚未取得用户接受。
C已部署：[测试入口](https://mofish-phase-c.tibo-reset-notifier.workers.dev/)，源码
`29fd28ecbf5e18e7fff01345a0b492ee1dbc9519`，Cloudflare version
`988e6707-c86e-49ad-82c7-9d61867c85c2`，100%流量；线上文件/配置/CSP/缓存核验56/56。
A/B Worker部署历史前后相等；最终QA临时身份及6张表均0，任务浏览器profile/临时登记/预览进程已清理。
公开概要见 [phase-c-local-20261020.json](evidence/phase-c-local-20261020.json)。

当前分支 `codex/phase-c-shared-aquariums`，起点 `00426c152969ee634d7ccc3e102fc38942b4b985`；
继续复用 `/Users/mintzz/.codex/worktrees/mofish-phase-b-acceptance/MoFish`，原Hermes工作区未覆盖。

已实现定向邀请/过期/撤销，owner/editor/viewer权限，语义操作并发合并及冲突备份，
真实Realtime版本通知与权限检查、离线队列和换号隔离；完成整体CSS/触控尺寸/共享导航及反馈打磨。
严格回归238/238、零跳过；迁移后真实B HTTP64/64、完整C31/31；B假后端浏览器回归87/87。
真实C双账号页面流程及最终打磨后复查均21/21，独立部署结果记录在
[PHASE-C-ACCEPTANCE.md](PHASE-C-ACCEPTANCE.md)及对应公开证据。

C迁移已应用一次：本地 `20261019155754_phase_c_shared_aquariums.sql` → 云端 `20261019161500`。
前三份未重放；不要盲目db push。B Site URL和回调保留，C精确根地址已加白名单；
随机账号生成的恢复链接显式C/默认B均正确，未发邮件、未输出令牌。
本机 `.env.phase-c` 已齐，Git忽略/0600，使用Node24与既有Wrangler OAuth，无需云环境设置。

明早只需按 [集中真机清单](PHASE-C-DEVICE-ACCEPTANCE.md) 反馈触控、真断网/跨设备、
10分钟发热/前后台、音效、邮件投递/回调和最终审美。自动化不替代这些项目。
B Worker保留冻结对照；已开C共享的账号请在C编辑，原B整缸覆盖会被服务端拒绝保护。
A项目/Worker、Tibo、Sites、既有令牌和用户存档不改；不合并main、不打标签、不运行release。

---

以下为B历史交接；其中“本轮不启动C”的旧边界已被上方用户新授权更新。

## 本机阶段 B 自动化与独立部署完成，待真机验收（2026-10-19）

本轮全程 Codex 本地 Project，从远端精确交接 `85211641c676b0cc7c7686d4ca583120975caf3b` 续接。
原 `/Users/mintzz/Documents/MoFish` 的 Hermes 分支与内容保留；独立工作树
`/Users/mintzz/.codex/worktrees/mofish-phase-b-acceptance/MoFish` 维护 `codex/phase-b-review-polish`。

- 真实 B HTTP **64/64** 通过；最终本机严格测试 **187/187、零跳过**，构建/部署预演通过。
- 已部署 [独立 B 入口](https://mofish-phase-b.tibo-reset-notifier.workers.dev/)，
  源码 **`a7706e620d89cbd8a3530e9f2fb4492eb58afffd`**，Cloudflare version
  **`0b424279-d44b-4d1f-b069-ceea7678d49d`**，部署 `d12d98d3-1082-46cc-a6f8-03e13e4c1ccc`，100% 流量。
  线上 `/deployment.json` 与 Cloudflare 说明记录该 SHA；本文件随后的文档提交不是重新部署。
- 已核验线上六个关键文件字节一致、公开配置只指新 B、CSP 和缓存正确、私密/源模块路径 404。
- 新 B Auth 原为 localhost、无白名单；已保存 Site URL/Redirect URLs 为 B 根地址，默认/显式 recovery 链接 **2/2** 正确，未发邮件。
- Safari 27.0.1 真实线上登录、造景同步/刷新、冲突/备份、2D/夜间及退出已验证。
  发现并修复 v2 备份摘要显示 `undefined 株水草`，补 v1/v2 回归并重新部署、线上确认。
- 本机公开配置从连接恢复，私密值由用户填写于 Git 忽略、0600 的 `.env.phase-b`；现有 Cloudflare OAuth 可用，未创建/复制/撤销令牌。
  不需要 Codex Cloud 环境；B API 直连通过，Workers 文件读取使用既有环境代理，未改系统网络配置。
- 冒烟 2、回调 1、浏览器 1 共四个随机临时账号均已删除并确认 404；B 三张表最终计数均 0。
  Safari 自建测试标签关闭、用户原标签与应用保留；测试数据库和 CLI 均已结束，无预览服务。
  临时身份脚本/注册文件清除，脱敏日志与正常缓存保留；B 项目/Worker 保留供验收。

**结论：可交付用户真机验收，B 尚未收口。** 触控、真实离线重连、持续运行发热、音效、完整跨浏览器和最终审美仍待用户确认。
按 [集中验收步骤](PHASE-B-DEVICE-ACCEPTANCE.md) 完成一次反馈；完整证据及工具/网络边界见
[本机验收记录](PHASE-B-LOCAL-ACCEPTANCE.md)，概要 JSON 在 `docs/evidence/phase-b-local-20261019.json`。
本机脱敏证据 `.local/phase-b-acceptance-20261019/`，清理记录 `cleanup.json`。
现有 A 数据库/Worker、Tibo、旧 Sites 和既有用户存档未写入；A Worker 部署历史前后相等。
未合并 main、未打标签、未运行 release、未启动多人 C。最终开发分支提交 SHA 以交接回复/远端为准。

---

以下为历史交接记录，状态以本节及本机验收记录为准。


## 独立 B 项目已创建，等待新环境配置续接（2026-10-19）

用户已确认推荐的 MoFish 组织与零费用继续条件；实际报价 $0/月，已创建 `MoFish-Phase-B-QA`
（`gbcfyqtbezkgkstrfbzn`，`ap-south-1`），仅在这个新项目应用三份迁移。A 项目仍只有两份 A 迁移，未更改。
真实 SQL `scripts/phase-b-sql-acceptance.sql` 31/31 通过：版本/造景、真实角色 RLS、越权、进食/营养/成长、
24h 窗口和离线上限、500 事件限额及限额下幂等重试。子事务回滚后新项目三张表均为 0 行，RLS 开启。
新增本地执行回归，确认同一 SQL 不会删除无关身份。最终严格本地测试 186/186、零跳过，构建通过。
公开配置已保存至忽略的 `.env.phase-b`（没有管理密钥），新环境可从连接恢复。

用户要求配置后在新对话继续；目前缺新域名的网络许可及 `MOFISH_B_SMOKE_SERVICE_ROLE_KEY` 安全注入。
**真实 HTTP 冒烟未执行，`mofish-phase-b` 尚未部署。** 新对话从 [PHASE-B-NEXT-CHAT.md](PHASE-B-NEXT-CHAT.md)
继续，包含实际项目/迁移记录、用户授权、配置、精确命令和边界；不要再次创建或重放已有迁移。
现有 A 站点、Tibo、旧 Sites、构建令牌保持原状；未合并、打标签或运行 release。
用户配置步骤及可复制的新对话提示在 [PHASE-B-ENV-SETUP.md](PHASE-B-ENV-SETUP.md)。
本轮证据 `/workspace/reviews/mofish-phase-b-cloud-live-20261019/`，SQL/本地检查完毕，临时兼容库已清理，未启动浏览器/预览服务；
新 B 项目及忽略的公开配置保留供续接，清理记录为 `cleanup.json`。

## B 云端联调准备（2026-10-19）

基于 `7606a1c8076895a04ea63e3afdf6d03683ced54c` 继续同一 Codex 分支。
新增 `test:cloud:b`：继承 A 临时账号/只读管理预检/finally 清理，追加 v2 造景、进食并发去重、营养和自然成长，
以及生产同步引擎程序模拟断网、离线重启、冲突备份与换号隔离。清理额外核验临时鱼缸及事件表无残留。
新增 `deploy:cloudflare:b`，Worker 固定 `mofish-phase-b`，A 部署路径保留；所有 B 公开/私有变量独立使用
`MOFISH_B_*`，不回退到 A 配置，B 测试/部署均拒绝现有 A 项目。

严格 `MOFISH_REQUIRE_POSTGRES=1 npm test`：185/185、零跳过；新 B 流程在真实迁移 SQL 的隔离 PGlite 上执行，
Auth/HTTP 清理使用替身单独检查。Wrangler 4.151.0 的 B 部署预演通过（占位新项目配置，没有云端写入）。
未重复浏览器套件：本轮只改 CLI/测试/文档，产品前端未改，上一轮玻璃版浏览器为 87/87。
最终构建通过；本轮证据 `/workspace/reviews/mofish-phase-b-cloud-prep-20261019/`。本地测试数据库已关闭、
自建兼容库已清理，未启动浏览器服务；清理记录为该目录的 `cleanup.json`，正常依赖缓存保留。

只读云检查：A 项目健康、迁移仍仅两份 A SQL；MoFish 组织目前仅一个项目、没有分支。
已有管理密钥只绑定 A 域名。未创建 B 项目、未应用云端 B 迁移、未实际部署，未更改 main/标签/Tibo/Sites/令牌。
具体可执行方案见 [PHASE-B-CLOUD-PLAN.md](PHASE-B-CLOUD-PLAN.md)。等待用户指定测试项目的组织与资源范围，
再查询费用并遵守确认规则；若连接无法提供新管理凭据，需要用户安全配置新 B 变量，不通过聊天传密钥。

## 实体玻璃缸与 B 剩余验收（2026-10-18）

继续 `codex/phase-b-review-polish`，基于 `17b667f0dc8513846d43aa23ecc2f47606f9700e`，原 A 工作区未动。
按用户要求将透明平面缸改为五块有厚度的开放玻璃容器：增加切边、缸沿、硅胶接缝、水线、底板/底垫和底床，
高画质提供本地程序化环境反光，低画质保留同样的几何结构。默认视角略抬高，内部尺寸与存档不变。
共享材质/环境纹理随场景销毁统一去重释放，缸体不参与鱼/造景拾取。
新增玻璃结构、内空间/开口与画质/夜间边界检查，避免玻璃侵入已保存的内部坐标。
修正手机默认取景裁切玻璃角的问题，按前缸沿实际投影拉远，并补充八角入画检查；雾密度随取景距离适配。
本轮 `MOFISH_REQUIRE_POSTGRES=1 npm test`：180/180 通过、零跳过（含 4 个玻璃/取景检查）。
最终 `MOFISH_CHROME_NO_SANDBOX=1 npm run test:e2e`：87/87 通过；仍为本地假后端，非真实云端证据。
最终构建通过（app.js 752,400 字节，gzip 200,905 字节），不发布源模块。
日间高/低画质和手机视口无前端报错；夜间稳定截图使用低画质补拍，无前端报错。
补拍脚本曾要求高画质软件 WebGL 在 45 秒内产生 200 帧，未达到该取证等待条件；日志保留，
不据此推断真实 GPU 或手机性能。真机性能仍待验收。
本轮自建浏览器、预览、假后端和测试数据库均关闭；浏览器 profile、失败拍摄临时目录和自建 ICU 运行库已清理，
保留下述证据与正常依赖缓存，清理记录为该目录的 `cleanup.json`。

剩余工作以 [POST-A-ACCEPTANCE.md](POST-A-ACCEPTANCE.md) 顶部清单为准：真实 B 云端联调、真机/跨浏览器、
用户视觉/交互、音效与证据收口。B 未验收；本轮未改云端、部署、合并 main、打标签或运行 release。
测试、截图与清理记录保留在 `/workspace/reviews/mofish-glass-tank-20261018/`。

## Codex 独立复核与打磨（2026-10-18）

按用户指定精确 SHA `23906074471d1764f103f3e0af127221ffc9ed2f` 先独立复核，
再按用户直接要求创建 `codex/phase-b-review-polish` 修复并提升设计，未改 Hermes 分支。
完整定位、复现与测试范围见 [PHASE-B-CODEX-REVIEW.md](PHASE-B-CODEX-REVIEW.md)。

原提交需修复：布景撤销持有跨身份整缸快照、可回退鱼名/成长；进食队列分批遗留、错误被结算掩盖、新鱼写入顺序、
旧 finally 与额度重试存在问题。本分支补齐回归并修复，增加真实多连接进食去重/结算/限额验证。
保留体素画风，改善米白/青绿页面、明亮水体/砂底、鱼缸内布景工具条、手机方向微调和输入框快捷键边界。
A 迁移不变，B 迁移未在任何实际项目应用；回滚新增显式事务和 v2 前置拒绝保护。
严格逻辑/数据库测试 176/176 通过、0 跳过；浏览器真实构建 + 假后端 87/87 通过。
本地浏览器链路使用假 Auth/PostgREST，真实 SQL 在隔离数据库单独验证，不冒充真实云端联调或真机性能。
用户尚未验收 B；未部署、未合并 main、未打标签、未运行 release，未接触 Supabase 项目/Tibo/旧 Sites/令牌。



本轮最终构建通过：app.js 745,180 字节，gzip 198,465 字节（仅包体，不是真机加载时间）；
补发 THIRD-PARTY-NOTICES.txt，构建产物不单独发布源模块。
自建浏览器、预览、假后端和嵌入式 PostgreSQL 均关闭；自建浏览器 profile、临时测试目录与 ICU 运行库已清理，
结果 JSON、脱敏日志与桌面/手机/夜间截图保存在 `/workspace/reviews/mofish-phase-b-review-20261018/`，
清理清单为 `cleanup.json`。独立 worktree 和正常依赖缓存保留供复核，原 A 工作区干净。


## 阶段 B：单人完整体验（本轮交付，2026-10-18）

**分支**：`hermes/single-player-3d`，基于阶段 A 验收提交 `38870f194b7e423240a03b803303cd636a891543`。
**最终提交 SHA 以本轮回复和 GitHub 分支为准**（本文件随最后一次提交更新，SHA 在提交后才产生）。
未合并 main、未打标签、未部署、未应用任何云端迁移、未触碰 Tibo / 旧 Sites / 令牌。

### 目标

在阶段 A 的账号、云存档、离线保留、冲突备份、换号隔离之上，交付单人完整体验：
页面改版 + 完整 3D（本机 GPU）+ 自然运动 + 水体与水草 + 可持久造景 + 四阶段成长 + 2D 降级。
只做 B，不启动多人 C。

### 主要改动

- 存档 v2：`web/model.js`（字符串鱼种、`look {v, seed}`、`decor[]`、四阶段、v1 无损迁移）。
- 视觉目录：`web/catalog.js`（9 鱼型 / 6 水草 / 5 石 / 2 沉木）。
- 3D：`web/aquarium/{scene,fish,decor,view3d}.js`（缸体、水面、灯光、焦散、光柱、体素鱼与造景、
  相机、拾取、拖拽、喂食、资源释放）。鱼/水草/石头/沉木统一为 Minecraft 式方块造型（用户明确要求）。
- 2D：`web/view2d.js`（同一份存档的降级渲染）。
- 页面：`web/{index.html,style.css,app.js}`（观赏/布景、画质、2D、鱼卡、浮动布景工具条、响应式）。
- 云端：`web/cloud/{api,sync}.js` 增加进食队列与 `record_feeding`；`web/storage.js` 增加 feeds 键。
- 数据库：新增 `supabase/migrations/20261018120000_phase_b_growth_and_aquascaping.sql` 与
  `supabase/rollback/0002_phase_b_growth.down.sql`。阶段 A 的两份迁移一行未改。
- 构建：`build.mjs` 改为静态文件白名单 + esbuild 打包（three 与认证 SDK 随包，不暴露源码模块）。
- 文档：`docs/GROWTH-RULES.md`、`docs/VISUAL-DESIGN.md`、`docs/POST-A-PROGRESS.md`、
  `docs/POST-A-ACCEPTANCE.md`、`docs/evidence/*.png`；README / ROADMAP / CLOUD-SETUP / AGENTS 同步更新。

### 关键规则

- 成长：鱼苗 `0–0.15`、幼鱼 `0.15–0.4`、亚成年 `0.4–0.7`、成年 `≥0.7`；
  时间 `0.05/24h`，营养 `0.02/24h`（每口 0.02/3，滚动 24h 最多 3 口）；自然 14 天、正常喂食 10 天到成年；离线结算上限 24h。
- 已登录时客户端只排队进食事件（`operation_id` 去重），成长由服务端 `settle_growth` 统一结算；游客按同一公式本地记账。
- 随机外观由持久 `look.seed` 派生，刷新/换设备不重掷；成长只改变体型与显色。

### 验证（本轮实跑）

| 项目 | 结果 |
| --- | --- |
| `npm test` | 163 / 163 通过（含 PGlite 上的 SQL 迁移与 v2 结算测试） |
| `npm run test:concurrency` | 10 / 10 通过（真实临时 Postgres 多连接） |
| `npm run test:e2e` | 74 / 74 通过（真实构建 + 假后端 + Chrome，含阶段 B 场景） |
| `npm run build` | 通过；dist 只含打包产物与白名单静态文件 |
| 手动 QA（本轮脚本，未入库） | 18 / 18（布景、2D/3D、夜间、喂食、画质、无前端异常） |
| 性能（M4 / Chrome 155 / 真 GPU） | 1440×900 高画质：153 draw calls、25,972 三角形、首帧 53ms、中位 120fps（vsync 上限） |

截图：`docs/evidence/desktop-catalog.png`、`desktop-stages.png`、`desktop-night.png`、`desktop-low.png`、
`desktop-2d.png`、`decor-edit.png`、`mobile-390.png`。

### 未验证 / 已知问题

1. 阶段 B 迁移**未应用**到任何真实 Supabase 项目，未做真实云端联调；只有 PGlite + 假后端证据。
2. 手机只有 Chromium 视口仿真，没有真机；iOS Safari 未测。
3. `webglcontextlost` 的手动触发未在真机验证（无 WebGL 时的自动 2D 已有 e2e 覆盖）。
4. 音效只做了开关与生命周期，未做听感验收。
5. 鱼的造型按「低多边形 + 棱面 + 大眼白圈 + 分叉尾」重做过一轮，最终审美由用户判定。
6. 部署顺序：**先应用迁移，再部署 v2 前端**；回滚顺序相反，见 `supabase/rollback/0002_phase_b_growth.down.sql`。

### 给 Codex 的复核入口

1. 迁移：`supabase/migrations/20261018120000_phase_b_growth_and_aquascaping.sql`
   （`mofish_state_error_any` 分派、v1 行为不变、`record_feeding` 的越权与窗口）。
2. 规则：`docs/GROWTH-RULES.md` 与实际常量是否一致（`web/model.js`、`web/cloud/sync.js`）。
3. 渲染：`web/aquarium/*` 的资源释放、着色器 cache key、画质切换换 canvas。
4. 界面：按 `docs/VISUAL-DESIGN.md` §9 的截图清单核对类型数量与四阶段。
5. 回归：`npm test` / `npm run test:concurrency` / `npm run test:e2e`。

---

## 历史：阶段 A 交接

当前开发分支：`codex/phase-a-review-fixes`。基于 Hermes 的
`1d4f16eb8b95a617c46bc6e7979bec74e9e4043e`，并合入 `origin/main` 的协作及资源清理规则
（`3c67d91`）。最终提交 SHA 以交接回复和 GitHub 为准。

用户已授权 Codex 指挥 Luna（max 思考）修复阶段 A，Codex 负责独立复核、集成验证和开发分支版本管理。
用户进一步要求双方完成阶段 A，包括独立云入口和真实联调；已授权准备和部署测试入口，
Cloudflare 独立测试入口已部署；尚未合并 main、未打产品版本标签、未运行正式 release；用户已于 2026-10-18 完成阶段 A 验收。

## 后续任务范围调整（2026-10-18）

用户决定先完善单人体验再考虑多人：B = 页面 + 完整 3D + 自然运动 + 水体/水草 + 可持久造景（原 C/D），
C = 多人共享（原 B）。当前 Hermes 长任务只覆盖 B，详见 `HERMES-POST-A-LONG-RUN-PROMPT.md`。
用户进一步补充多种鱼体、随机水草/石型、可移动造景、本地 GPU 光影与清新高级/放松审美，已细化进任务书；
另补每条鱼鱼苗/幼鱼/亚成年/成年四阶段，时间与实际进食共同成长、可见体型变化、营养上限和服务端去重，保留旧鱼进度与离线 24h 上限。
最新调整为 8 鱼型、6 水草类型、5 石型，同种鱼随机颜色，具体形态由 Hermes 设计；成长周期在原建议上翻倍为自然约 14 天、正常喂食约 10 天，增加幼鱼/亚成年区分共四阶段。
随机外观随存档持久化，默认验收规模为 8 鱼型、6 水草类型、5 石型，保留旧种类及 plants 迁移要求。
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
