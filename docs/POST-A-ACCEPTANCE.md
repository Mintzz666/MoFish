# 阶段 B 验收记录（单人完整体验）

- 分支：`hermes/single-player-3d`（基线 `38870f194b7e423240a03b803303cd636a891543`）
- 范围：单人 B（页面 + 完整 3D + 自然运动 + 水体水草 + 可持久造景 + 四阶段成长 + 2D 降级）。
- 不做：多人 C、合并 main、打标签、正式 release、修改线上数据库/部署。

本文件只记录**实际跑过的证据**。没有账号、真机、真实 Supabase 项目的地方明确标「未验证」，不代替用户验收。

## 1. 需求对照

| 任务书要求 | 实现 | 证据 |
| --- | --- | --- |
| 至少 8 鱼型 | 9 种（`web/catalog.js`） | `docs/evidence/desktop-catalog.png`；`npm test` 覆盖目录完整性 |
| 至少 6 类水草 | 6 类（vallis/anubias/rotala/moss/fern/carpet） | 同上 |
| 至少 5 类石头 | 5 类（seiryu/lava/pebble/slate/sandstone） | 同上（默认构图含 4 类，`tests/model.test.js` 覆盖 5 类可建） |
| 鱼型形态差异明显 | 体型/鳍尾/游姿参数分离，非换色 | `desktop-catalog.png`、`docs/VISUAL-DESIGN.md` §3 |
| 同种随机颜色/花纹/个体差异 | 每鱼 `look.seed` 派生，含花纹与比例抖动 | `tests/model.test.js`「外观由 seed 稳定派生」 |
| 随机结果持久保存、刷新不重掷 | `look {v, seed}` 入档；`LOOK_VERSION` | 同上 + e2e 重载后外观一致 |
| 四阶段：鱼苗/幼鱼/亚成年/成年 | `STAGES` 0.15 / 0.4 / 0.7 | `desktop-stages.png`；e2e 四条鱼标签断言 |
| 连续长大、渐进显色 | 体型/鳍/饱和度随 growth 连续插值 | `web/model.js` `fishSizeFactor` / `fishAppearance` |
| 自然约 14 天成年 | 0.05/24h → 0.7/0.05 = 14 天 | `tests/model.test.js`「自然成长 14 天成年」 |
| 正常喂食约 10 天 | +0.02/24h → 0.07/天 | 同上；`docs/GROWTH-RULES.md` §2.3 |
| 成长由时间 + 实际进食决定 | `settle_growth` 合并两路，服务端权威 | `tests/sql/phase-b-growth.test.js`、`tests/cloud-sync.test.js` |
| 造景移动/旋转/有限缩放/撤销 | 3D 拖拽 + 面板/浮动条按钮 + `Ctrl/⌘+Z` | `decor-edit.png`；e2e 场景 11；`/tmp` flow 脚本 18/18 |
| 本地 GPU 渲染 | three.js WebGL2；无远程渲染 | `gpu: ANGLE Metal Apple M4` 实测（§3） |
| 水面/柔和光影/材质/自然运动 | shader 水面、焦散、光柱、菲涅尔玻璃、顶点着色器游动 | `desktop-night.png`、`desktop-low.png` |
| 手机性能 | 低画质档、DPR 限制、暂停后台 rAF | 390×844 视口仿真实测（非真机，见 §4） |
| 画质调节 | 高/低两档，切换重建渲染器 | e2e「切到低画质且不报错」 |
| 2D 降级 | WebGL 不可用/丢失/手动切换 | `desktop-2d.png`；e2e 2D 切换 |
| 保留 A 的账号/旧档/同步/离线/冲突/换号 | 未改阶段 A 语义，仅扩展 | `tests/cloud-sync.test.js` 46 项、`tests/cloud-e2e.mjs` 场景 1–10 |
| 旧 v1 存档升级 | `migrate` 保留鱼与 plants | `tests/model.test.js`、`tests/sql/migrations.test.js` |
| 不修改 A 迁移、不放宽授权 | 只新增函数/表 | 迁移 diff 只加不改；`migrations.test.js` 27 项 |
| 不暴露源码模块 | esbuild 打包 + 显式静态文件列表 | `build.mjs`；e2e 检查 `dist` 无 `web/*.js` |

## 2. 自动化结果（本轮实跑）

| 命令 | 结果 | 说明 |
| --- | --- | --- |
| `npm test` | **163 / 163 通过** | 逻辑、存档、存储、同步、账号 UI、SQL 迁移（PGlite 真实 Postgres 内核） |
| `npm run test:concurrency` | **10 / 10 通过** | 真实临时 Postgres 多连接；阶段 A 的隔离与并发结算未被破坏 |
| `npm run test:e2e` | **74 / 74 通过** | 真实构建 + 假后端 + Chrome；覆盖账号、冲突、离线重连、旧档选择、CSP、手机布局、阶段 B 场景 |
| `npm run build` | 通过 | `dist/app.js` 约 764 KB（含 three 与认证 SDK），静态文件白名单 |
| 手动流程脚本（本轮 QA，非仓库） | 18 / 18 | 布景增删/旋转/缩放/换造型/撤销、2D/3D、夜间、喂食、加鱼、画质、无前端异常 |

e2e 本轮最终日志：`/tmp/mofish-b-20261018/final-e2e.log`（74/74），单测日志：`final-test.log`（163/163）。
这些是临时目录，不作为长期证据；仓库内的测试本身可复现同样结果。

## 3. 性能（本机实测）

环境：macOS，Apple M4，Chrome 155，ANGLE Metal（**真实 GPU**，窗口模式）。
场景：10 鱼（9 型）+ 12 造景。

| 视口 | 画质 | draw calls | 三角形 | 中位 FPS |
| --- | --- | --- | --- | --- |
| 1440×900 | 高 | 68 | 20,674 | 120（vsync 上限），最大帧 10.4 ms |
| 390×844（视口仿真） | 低 | 68 | 20,674 | 120（vsync 上限） |

诚实说明：
- 显示器上限 120Hz，实测被 vsync 钉住；只能说明「明显高于 60fps 目标」，不能外推到更高帧率。
- 体素化把 draw call 从 153 降到 68、三角形从 2.6 万降到约 2.07 万：每条鱼 4 个网格（身体/尾/两片胸鳍），造景各 1 个网格。
- **手机真机未测**：没有设备，也没有用 headless 视口冒充真机性能。需要在目标机型上用真实 Safari/Chrome 复测首屏、发热与续航。

## 4. 明确未验证 / 需要用户或 Codex 复核

1. **真实 Supabase 项目**：阶段 B 迁移**未应用**到任何项目，也没有跑真实云端联调。迁移与 RPC 只在 PGlite/假后端上验证过。
2. **真机与跨浏览器**：iPhone/Android 实机、Safari（含 iOS WebGL 限制）、Firefox 未测；移动端只有 Chromium 视口仿真。
3. **3D 上下文丢失**：代码路径与降级逻辑已实现（`webglcontextlost` → 2D），但没有在真实设备上人为触发验证；e2e 只验证了「WebGL 不可用时自动 2D」。
4. **音效**：水声开关存在，未做听感验收；默认静音，不阻塞主流程。
5. **审美**：截图见 `docs/evidence/`。造型按用户最新要求改成 Minecraft 式体素方块（鱼/水草/石头/沉木统一），**最终是否达标由用户判定**；前两版（圆润低多边形、光滑曲面）已被用户否掉。
6. **部署**：未部署、未合并 main、未打标签、未动线上数据库/令牌/Tibo/旧 Sites。

## 5. 复核建议（给 Codex）

1. 先读 `docs/GROWTH-RULES.md` 与迁移 SQL，确认 v1 行为完全未变（结算速率、错误码、授权）。
2. 重点看 `supabase/migrations/20261018120000_phase_b_growth_and_aquascaping.sql` 的 `mofish_state_error_any` 分派与 `record_feeding` 的越权/窗口逻辑。
3. 看 `web/aquarium/fish.js` / `decor.js` / `scene.js` 的资源释放与着色器注入（`onBeforeCompile` 的 cache key）。
4. 按 `docs/VISUAL-DESIGN.md` §9 的截图清单核对「8 鱼型 / 6 水草 / 5 石型 / 四阶段 / 2D 降级」。
5. 真机与真实云端是剩余风险，建议在合并前补一次。
