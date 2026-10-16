# MoFish 开发交接

当前状态：阶段 A（邮箱密码登录 + 单用户跨设备云存档 + Cloudflare 独立入口）的代码、数据库迁移、
测试与配置文档已完成，位于 `hermes/cloud-auth-sync` 分支。**第二轮：已按 Codex 对第一版提交
（`9d71aad`）的 8 项评审意见修复并补测试**，等待复审与用户验收。

真实云账号联调仍未进行（阻塞项见文末），因此「云端可用」这一结论目前只由本机真实 Postgres
引擎与本地假后端支撑，不能当成 Supabase 线上验证通过。

## 本轮目标

- Codex 评审提交 `9d71aad`，结论「暂不验收」，提出 5 项 P1 + 3 项 P2 问题。
- 本轮要求：逐项修复并为每项补回归测试；成长结算需要真实多数据库连接并发测试；
  不得仅调整测试预期来消除失败；完成后更新 HANDOFF、提供新 SHA、逐项修复说明与实际测试结果。
- 开发分支：`hermes/cloud-auth-sync`（基线 `1ed9040`）
- 本轮 commit SHA 与父提交：见本轮交接回复（文档不记录自身 SHA，避免为写 SHA 反复提交）

## 逐项修复说明

### P1-1 重连会绕过 revision 冲突，静默覆盖另一台设备的修改

- **根因**：`syncNow()` 先调用 `settle_growth`，并把返回的**服务端最新 revision** 写成本机
  `revision`，然后 `flush()` 用它作为 `expected_revision` 上传本机旧快照。云端确实等于这个新
  revision，于是条件更新成功——A 已提交的改名被 B 的旧快照覆盖，界面还显示「已同步」。
- **修复**：引入 `baseRevision`（本机状态所基于的服务端 revision，与「刚读到的最新 revision」严格区分）。
  写入永远用 `baseRevision` 做条件更新；只有云端 revision 仍等于基线才可能成功，否则判定为冲突。
  同步顺序固定为**先上传本机改动，再结算服务端成长**（`save_aquarium` 不改动成长锚点，
  所以写完之后再结算，这段时间的成长照样补上，既不会丢也不会重复计算）。
- **测试**：`[P1-1] 重连（syncNow）不会绕过冲突去覆盖另一台设备已经提交的改动`（复现 Codex 给出的
  路径：A 改名并保存 → B 改水草后重连 → 断定为冲突、A 的名字保留、B 的改动保留且可导出）；
  `[P1-1] 同步顺序固定为「先上传本机改动 → 再结算服务端成长」`（断言请求顺序 + 成长只加一次）。

### P1-2 本地已落盘、尚未上传的改动可能在恢复时丢失

- **根因**：`persistLocal()` 只写账号缓存，没有记录「有未同步改动」这件事；恢复对账发现没有
  pending，就直接采用云端。于是「本机已保存的水草 7」在重新对账后变回 3，且没有备份。
- **修复**：本机落盘统一交给同步引擎（`engine.persistLocal()`）：同时写账号缓存、当前指针，
  以及**未同步副本 + 它基于的 revision**（`mofish.pending.<uid>.<aid>` 存成
  `{v:1, baseRevision, state}` 信封）。恢复时：基线仍等于云端 revision → 直接补传；
  基线比云端旧 → 判定冲突交给用户；基线未知（离线首次对账）→ 保守地当作有改动。
- **测试**：`[P1-2] 本机已落盘但未上传的改动：重新打开页面后仍会上传，而不是被云端回退`；
  `[P1-2] 本机未同步改动遇上云端已变更：给出冲突而不是静默丢弃`（含冲突界面能同时列出两份内容）。

### P1-3 换号后旧请求仍能更新新账号的界面与缓存

- **根因**：`setSession()` 只清空变量，没有取消在途请求，也没有拒绝过期响应。A 的写入响应
  在 B 登录之后到达时，会调用 `adopt()`：用 `userId()`（此时是 B）去写缓存，结果把 A 的鱼缸
  写进 B 的键，界面也显示 A 的数据。数据库 RLS 管不到这种客户端串档。
- **修复**：加入会话代次 `generation`：`setSession`/`dispose` 时 +1；所有异步流程在 await 之后
  都要通过 `stale(gen)` 检查才能改状态、写缓存或刷新界面。界面层同样加了 `opToken`
  （登录/注册/回调/退出各自递增），晚到的响应直接丢弃。
- **测试**：`[P1-3] 换号后旧会话的响应必须被丢弃，不得写进新账号的界面与缓存`（用可控的
  响应门闩复现「响应晚到」）、`[P1-3] 退出登录后到达的响应不会把登录状态写回界面`。

### P1-4 邮件验证和重置密码的回调流程不可用

- **根因**：回调 URL 片段里只有令牌、没有用户信息，`acceptCallbackSession` 直接拿令牌拼会话，
  得到的会话 `user.id` 为空 → 同步引擎把它当游客，界面却提示已登录（错位）。此外重置回调
  只在当次渲染里临时显示改密面板，弹窗一关或刷新就丢。
- **修复**：
  1. `acceptCallbackSession` 改为异步：先用 `GET /auth/v1/user` 确认身份，再构造并落盘会话；
     确认失败就不写会话并给出明确提示。
  2. `normalizeSession` 拒绝没有 `user.id` 的会话，从类型上杜绝「假登录」。
  3. 重置流程改为持久状态：`mofish.auth.flow = {type:'recovery', email}`，改密面板在刷新后、
     手动打开账号弹窗后都保持显示，直到设置新密码或用户选「稍后设置」；退出登录会清掉它。
  4. 回调处理后面板自动打开并给出结果文案（验证成功 / 链接有效请改密 / 链接失效）。
- **测试**：单元层 `缺少 user.id 的响应不算有效会话`、`邮件回调：必须先取回用户身份才算登录；
  无效令牌不落盘`；端到端新增 9 项（验证回调真正登录并建缸、令牌从地址栏清除、
  重置回调自动打开改密面板、改密面板不被账号面板顶掉、刷新后仍保留、改密写入服务端且新密码可登录）。

### P1-5 数据库允许绕过 RPC 直接修改 revision、成长锚点和存档

- **根因**：迁移给 `authenticated` 授予了整表 `INSERT/UPDATE/DELETE`，RLS 只检查归属，
  因此用户可以 `update aquariums set revision = 42` 或把 `state_json` 改成 `{}`，
  函数里的校验与冲突控制形同虚设。
- **修复**：`revoke all on public.aquariums from anon, public, authenticated` 后只 `grant select`；
  三个写入函数改为 `SECURITY DEFINER`（属主执行），函数内自行做身份与归属过滤，
  `save_aquarium` 增加 `owner_id = v_uid` 条件（原来依赖 RLS，改为 definer 后必须显式写），
  `settle_growth` 的读取与更新同样带 owner 条件；`search_path` 固定为 `public, pg_temp`；
  删除已无意义的写策略；顺带补 `grant usage on schema public`，让迁移在原生 Postgres 上也能独立执行。
- **测试**：`authenticated 无法绕过 RPC 直接改写存档、revision 与成长锚点`（四类直接写都断言
  `permission denied`，并复核数据未被改动）；`迁移对象齐备…且只有 SELECT 表权限`
  （用 `has_table_privilege` / `has_function_privilege` 断言权限矩阵、`prosecdef`、`proconfig`）；
  `校验函数不对客户端开放，但受控 RPC 内部仍能使用它`。

### P1-6 成长结算缺少并发保护，可能重复奖励

- **根因**：`settle_growth()` 先读锚点、再无条件更新，两个会话可能读到同一个旧锚点，各加一次成长。
- **修复**：结算改为 `SELECT ... FOR UPDATE` 锁住该行后再计算，第二個事务会阻塞到第一个提交，
  之后读到的是已推进的锚点 → credited = 0。
- **测试**：新增 `tests/sql/concurrency.test.js`，用**两个/三个独立的真实 Postgres 连接**并发调用：
  - `并发结算成长：两个真实连接同时调用，只奖励一次` → 断言 credited 为 `[0, 3600]`、成长只 +0.008、revision 只 +1
  - `并发结算成长：三个连接同时调用也只奖励一次` → `[0, 0, 1800]`
  - `并发保存同一 revision：只有一个成功，另一个拿到 conflict 且不覆盖数据`
  - `并发结算 vs 并发保存交错：不会互相覆盖，且成长只结算一次`
- **鉴别力验证**（证明测试不是空过）：临时删掉 `for update` 后重跑，前两项立刻失败并复现双重/三重奖励
  （`[3600,3600]`、`[1800,1800,1800]`），恢复后 4/4 通过。
- **说明**：PGlite 是单连接内核，语句串行执行，证明不了行锁；所以这部分必须用真实多连接实例。
  测试默认用 `optionalDependencies` 里的 `embedded-postgres` 起本地实例，也可用
  `MOFISH_TEST_PG_URL` 指向现有 Postgres，两者都没有时明确 SKIP（不会伪装成通过）。

### P2-7 服务端校验会放过缺失字段

- **根因**：缺失字段在 jsonb 里取出来是 `NULL`，`<>` 比较得到 `NULL`（既不真也不假），
  所以 `if p_state->'night' not in ('boolean')` 这类判断对整份缺字段的存档不生效；
  另外没有检查重复的鱼 id。
- **修复**：重写 `mofish_state_error`，每个字段都先判存在性（`is null` / `is distinct from`）再判类型，
  数值统一用 `numeric` 比较（避免类型转换异常）；新增 `fish_id_duplicated`；`savedAt` 加上限。
- **测试**：`服务端校验：缺失字段必须被拒绝（jsonb 里缺失即 NULL，不能用 <> 判空）`（16 个用例覆盖
  顶层与鱼字段的缺失/类型错误 + 整份缺字段的存档）、`服务端校验：重复的鱼 id 被拒绝`、
  `前后端口径一致：客户端 model.validate 产出的存档一定能通过服务端校验`（跨边界属性测试，
  防止「前端裁剪出的存档被服务端拒绝」这类死锁）。
  同时把假后端的 `validateState` 对齐到同一套规则，避免端到端测试放过真实服务端会拒绝的存档。

### P2-8 暂时断网会删除仍可恢复的登录凭据

- **根因**：`refresh()` 只要失败就 `clearSession()`，网络错误、5xx、限流都算「失效」。
  用户断网刷新一次就会掉线，连离线缓存都读不出来。
- **修复**：区分两类失败。凭据真的失效（4xx，如 `invalid_grant` / `refresh_token_not_found`）→ 清除会话；
  暂时连不上（网络错误 / 5xx / 429）→ **保留会话与凭据**，返回 `reason: 'offline'`，
  由同步引擎进入离线状态并在恢复网络后自动重试。`getSession` 的 `reason` 明确为
  `fresh / refreshed / expired / offline / invalid_grant / no_session`；数据接口的取令牌改为
  `{token, transient}`，`transient` 走可重试的离线分支而不是 `unauthenticated`。
- **测试**：`刷新失败要区分「凭据失效」与「暂时连不上」`（三种情形分别断言会话是否被清除）；
  端到端 `离线时状态显示为离线` / `离线改动以未同步副本存在本机` / `重连后离线改动写入云端`。

## 代码改动清单（本轮）

| 文件 | 改动 |
| --- | --- |
| `web/cloud/sync.js` | 重写核心：`baseRevision`/`baseCanonical` 基线、先写后结算、pending 信封、会话代次、冲突时显示本机那份、`persistLocal()`；移除客户端成长增量记账 |
| `web/cloud/auth.js` | 回调先取回用户身份、`normalizeSession` 强制 `user.id`、刷新失败分类、`getSession.reason` 细化 |
| `web/cloud/api.js` | 取令牌契约改为 `{token, transient}`，新增可重试的 `offline` 失败类型 |
| `web/cloud/client.js` | 按新契约接线（`transient` 透传） |
| `web/storage.js` | pending 改为 `{v, baseRevision, state}` 信封，兼容旧的裸存档格式 |
| `web/ui/account.js` | 重置流程持久化（`auth.flow`）、回调自动打开面板、改密面板不被顶掉、界面层 `opToken` 防串档 |
| `web/app.js` | 本机落盘交给引擎（缓存 + 未同步副本 + 基线）；会话恢复按新 `reason` 分派 |
| `web/index.html` | 改密面板增加「稍后设置」按钮 |
| `supabase/migrations/0001_phase_a_cloud_saves.sql` | 收写权限、RPC 改 `SECURITY DEFINER` 并显式校验归属、`settle_growth` 加行锁、校验函数 NULL 安全 + 重复 id、`grant usage on schema public` |
| `tests/cloud-sync.test.js` | 新增 6 项回归测试（P1-1 ×2、P1-2 ×2、P1-3 ×2） |
| `tests/cloud-auth.test.js` | 新增/改写 3 项（回调身份、会话形状、刷新失败分类） |
| `tests/sql/migrations.test.js` | 新增/改写 5 项（权限矩阵、越权直写被拒、校验函数不开放、缺失字段、重复 id、前后端口径一致） |
| `tests/sql/concurrency.test.js` | 新增：真实多连接并发测试（4 项） |
| `tests/fake-supabase/supabase-fake.mjs` | 校验规则与服务端对齐 |
| `package.json` | 新增 `test:concurrency` 脚本；`pg` 进 devDependencies，`embedded-postgres` 放 optionalDependencies |
| `docs/CLOUD-SETUP.md`、`README.md` | 权限模型表、并发测试用法、回调注意事项、FAQ 补充 |

**迁移文件策略**：`0001` 从未应用到任何真实项目（用户尚未建 Supabase 项目），因此本轮直接在原文件上修订，
并在文件头写明「一旦应用过，后续修改必须新建 0002」。用户执行 1.2 的步骤时拿到的是修订后的版本。

**存档格式兼容性**：游戏存档结构未变（`version: 1`），旧本地存档与旧导出文件继续可用。
新增的只有本机 pending 信封格式（并兼容读取旧的裸存档写法）。

## 验证证据

| 项目 | 命令 / 操作 | 结果 |
| --- | --- | --- |
| 单元 + 集成测试 | `npm test` | **100 tests / 100 pass / 0 fail / 0 skipped**（Node v22.23.2；含 4 项真实并发测试） |
| 其中数据库与权限 | `tests/sql/migrations.test.js`（真实 Postgres 内核 PGlite + 真实迁移文件） | 26 项：迁移幂等、权限矩阵、四类越权直写被拒、RPC 越权、匿名/无 claims 被拒、原子 revision、缺失字段与重复 id 校验、前后端口径一致、成长幂等与 24 小时封顶 |
| 其中真实并发 | `tests/sql/concurrency.test.js`（真实 Postgres 18.4，2–3 个独立连接） | 4 项通过；**去掉行锁即可复现双重奖励**（见 P1-6） |
| 其中同步契约 | `tests/cloud-sync.test.js` | 31 项，含本轮 6 项回归 |
| 认证契约 | `tests/cloud-auth.test.js` | 17 项 |
| 静态构建 | `npm run build` | 成功；未配置云服务时输出「游客模式」 |
| 构建安全闸 | 用 service_role key 构建 | 构建失败（exit 1）且不破坏上一次产物 |
| 浏览器端到端 | `npm run test:e2e`（Chrome 152 headless + 真实 `dist` 产物 + 生效的 `_headers` + 本地假后端） | **50 / 50 通过**（新增 9 项回调相关） |
| 手机 / 电脑布局 | 同一套端到端内 | 390×844 与 320×568 无横向溢出、账号面板完整可见 |
| 缺依赖时的诚实降级 | 移走 `node_modules/@electric-sql/pglite` 或 `@embedded-postgres` 后重跑 | 相关用例标 **SKIP** 并说明原因，不会伪装成通过 |

鉴别力验证（证明测试真的能抓住问题，而不是事后对齐预期）：

1. 去掉 `settle_growth` 的 `for update` → 并发测试立即失败，复现 `[3600,3600]` / `[1800,1800,1800]`；
   恢复后通过。
2. 把 `acceptCallbackSession` 退回「直接用回调令牌建会话」的旧写法 → 端到端从 50/50 掉到 **41/50**，
   失败项正是回调相关 9 条；恢复后 50/50。

本轮另外修掉的两处自测工具缺陷（不影响产品，但会影响结论可信度，记录在此）：
`concurrency.test.js` 早期把跳过判定放在 `before` 钩子里（`skip` 选项在定义时求值，导致缺依赖时
用例会失败而不是跳过）；`embedded-postgres` 在二进制包缺失时会**异步** import 失败并打挂进程
（try/catch 兜不住），因此加了文件系统预检。

## 复现步骤

```sh
git fetch origin && git checkout hermes/cloud-auth-sync
npm install          # PGlite（测试内核）+ pg；embedded-postgres 为可选（并发测试用）
npm test             # 100 项，含真实 Postgres 内核上的权限/校验与真实多连接并发
npm run build
npm run preview      # http://127.0.0.1:5173 ，已应用 _headers（含 CSP）
npm run test:e2e     # 需要本机 Chrome；本地假后端跑完整两台设备与邮件回调流程
```

## 关于自写认证客户端（Codex 的建议）

Codex 指出「不使用 CDN 不需要以自写认证为代价，官方 SDK 可以打包随网站发布」。这个判断成立，
我按「本轮只做 8 项修复」的范围没有换实现，但把它记成待用户决策的事项：

- **保持自实现**：零第三方运行时依赖、可直接审查、不引入打包步骤；本轮已把回调、会话切换、
  刷新错误分类、并发刷新去重等已知坑补齐并有测试覆盖（auth 相关 17 项 + 端到端 9 项）。
- **改用官方 SDK**：需要在构建期引入 bundler（例如 esbuild）+ `@supabase/supabase-js`，
  产出一个随站点发布的 bundle（不依赖 CDN，国内网络也能用）；好处是 GoTrue/PostgREST 的边界行为
  由官方维护，代价是多一条构建链与一个约 100KB+ 的产物，且本轮为此写的 auth 客户端与测试要废弃重做。
- 建议：**如果阶段 B 要继续加深认证相关能力（多设备会话管理、PKCE、OAuth 等），就换成官方 SDK**；
  如果认证面保持现状，则继续用自实现并沿用现在的测试。
- 无论选哪条路，数据库侧的权限模型与同步引擎都不受影响。

## 已知问题与阻塞项

### 阻塞项（需要云账号才能真正闭环）

- **真实 Supabase 未联调**：`scripts/cloud-smoke.mjs` 已写好但**从未执行过**。GoTrue 的 HTTP 行为、
  JWT 签发与过期、PostgREST 的真实错误码、以及「收回表级写权限后 PostgREST 调用 RPC 是否一切正常」
  都还需要线上确认（本地用真实 Postgres 内核验证过，但那不是 Supabase）。
- **真实发信未验证**：邮箱验证与重置邮件的投递、模板、跳转地址依赖控制台 SMTP 配置。
- **Cloudflare 未部署**：`wrangler.toml` 与 `_headers` 只在本地预览服务器验证过。
- **真机浏览器未实测**：iOS Safari / Android Chrome 未验证（本轮为 Chrome headless + 真实视口仿真）。
- **无 CI**：仓库没有 `.github/workflows`，上述命令都是本机手工执行的结果。

### 复审建议关注点

1. **权限模型变更的影响面**：收回表级写权限后，任何未来想直接用 PostgREST 写表的功能都必须走新函数；
   请确认 `SECURITY DEFINER` + 固定 `search_path` + 显式 owner 过滤这套写法没有遗漏（尤其
   `save_aquarium` 的 conflict 探测查询与 `ensure_aquarium` 的 insert 分支）。
2. **`baseRevision` 语义**：请对照 `hydrate`/`flush`/`syncNow`/`resolveConflict` 四条路径，确认
   任何情况下都不会用「新读到的 revision」去写入旧快照；以及 pending 的 `baseRevision` 为 null 时
   保守判定为冲突是否可接受。
3. **会话代次的覆盖面**：`stale(gen)` 是否覆盖了所有 await 之后的写操作（含 `store.writeBackup`、
   `store.writePending`、`adopt`、`setStatus`）与界面层 `opToken` 的所有分支。
4. **回调流程图**：验证链接与重置链接的两条路径、`auth.flow` 的清理时机（改密成功 / 稍后设置 / 退出）。
5. **并发结论的适用范围**：并发测试用的是本机 Postgres 18.4 实例；Supabase 实际运行版本与连接池
   （pgbouncer 事务模式）下 `FOR UPDATE` 的行为是否有差异，建议在真实项目上重跑 `npm run test:concurrency`。
6. **迁移修订方式**：`0001` 未应用于任何真实项目因此就地修订；请确认这一处理可接受，
   并确认阶段 B 会以新迁移放宽唯一索引。

### 其它已知限制（有意为之，非缺陷）

- 已登录且离线期间不做本地时间成长（避免与服务端重复计算），重连时由服务端一次结算。
- 服务端 24 小时上限截掉的余量会丢弃（与本地 `clamp` 语义一致）。
- 阶段 A 一个账号只有一条鱼缸，因此没有「导入为新缸」选项。
- 冲突未解决期间水面上显示的是**本机那一份**（用户最后看到的内容），采用云端需要用户显式点击。
- 免费 Supabase 项目闲置会暂停；默认发信通道不适合真实用户，上线前必须配 SMTP。

## 版本与部署

- 用户是否验收：尚未验收（Codex 第一轮结论为暂不验收，本轮为修复后复审）。
- 是否调用正式发布 hook：否（未合并 main、未打标签、未运行 release）。
- 是否更新线上站点：否（未部署 Cloudflare，也未改动原有私有 Sites 地址）。
- 建议版本：阶段 A 目标为 `v0.2.0`，由用户在验收后决定是否调用 release hook。
