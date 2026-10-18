# 阶段 B 实施记录（单人完整体验）

基线：`38870f194b7e423240a03b803303cd636a891543`（`codex/phase-a-review-fixes`，含阶段 A 验收成果）。
开发分支：`hermes/single-player-3d`。本文记录「做了什么、为什么这样做、和原计划差在哪」，验收结论见
[POST-A-ACCEPTANCE.md](POST-A-ACCEPTANCE.md)，规则见 [GROWTH-RULES.md](GROWTH-RULES.md)，
视觉见 [VISUAL-DESIGN.md](VISUAL-DESIGN.md)。

## 1. 里程碑

| 阶段 | 内容 | 结果 |
| --- | --- | --- |
| M1 存档 v2 | 字符串鱼种、外观种子、造景对象列表、四阶段阈值、v1 无损迁移 | `web/model.js`，单测 20 项 |
| M2 视觉目录 | 9 鱼型 / 6 水草 / 5 石 / 2 沉木 + 初始构图模板 | `web/catalog.js` |
| M3 3D 渲染 | 玻璃缸、水面、灯光、焦散、光柱、粒子、画质档 | `web/aquarium/scene.js` |
| M4 鱼 | 体态轮廓、鳍、眼睛、花纹顶点色、游动着色器 | `web/aquarium/fish.js` |
| M5 造景 | 程序化水草/石头/沉木，seed 派生外观与摆动 | `web/aquarium/decor.js` |
| M6 视图 | 相机环绕、拾取、拖拽、喂食、资源释放、2D 降级 | `web/aquarium/view3d.js`、`web/view2d.js` |
| M7 页面 | 观赏/布景、工具条、浮动操作条、鱼卡、响应式 | `web/index.html`、`web/style.css`、`web/app.js` |
| M8 云端 | 进食记账、去重、结算、迁移与回滚 | `web/cloud/*`、`supabase/migrations/*` |
| M9 验证 | 单测、SQL、并发、e2e、截图、性能 | 163 + 10 + 74 全绿 |
| M10 体素化 | 用户反馈「整体还是太丑」，改为 Minecraft 式方块画风：鱼/水草/石头/沉木全部重写为体素几何 | `fish.js`、`decor.js` 重写，样式与截图更新 |
| M11 配色提亮 | 用户要求「鱼和页面配色更新鲜阳光」：提亮鱼体饱和度/明度、页面改暖奶油底 + 青绿/暖阳光晕、水体与背墙更清透 | `catalog.js`、`style.css`、`scene.js` |

## 2. 关键决定

1. **一份存档，两种渲染**：2D 与 3D 都从同一个 `state` 读 `species / look / decor`，2D 不是另一套数据；
   切换只是换渲染器，鱼、草、石头、位置完全一致。
2. **程序化资产**：没有外部模型/贴图/字体。好处是离线可用、许可证干净、包体可控、随机外观可无限派生；
   代价是模型精度不如手工资产，所以用「低多边形棱面 + 清漆高光 + 大眼白圈 + 分叉尾」这套可读性优先的做法。
3. **外观种子不可变**：`look.seed` 一旦生成就随存档走；成长只改体型/饱和度，不重掷颜色与花纹。
   `LOOK_VERSION` 留给未来算法升级。
4. **服务端权威 + 客户端只排队**：已登录时鱼吃到不本地加成长，只把 `{op, fishId, bites}` 入队；
   服务端 `settle_growth` 统一算时间 + 营养，`operation_id` 去重。游客才在本地按同一公式记账。
5. **画质切换要换 canvas**：同一 canvas 不能重复申请 WebGL 上下文，切画质/切渲染器时替换 canvas 元素并重建视图。
6. **迁移只加不改**：阶段 A 的两份迁移一行未动；新增迁移里 v1 路径的错误码与授权完全保留，v2 走新校验。
7. **旧档不重排**：v1 的 `plants` 迁移成固定 id/seed 的水草对象；旧鱼使用 `hash('fish:'+id)` 生成外观种子，
   刷新、换设备、重装都一致。

## 3. 文件地图

```
web/
  index.html            页面结构（观赏/布景、画质、2D、账号、鱼卡、布景面板、浮动条）
  style.css             暖白 + 薄荷视觉、响应式断点、浮动工具条
  app.js                领域状态、存档、视图切换、布景编辑、喂食、UI 绑定
  model.js              存档 v2、成长/阶段/进食、外观派生、v1 迁移、校验
  catalog.js            9 鱼型 / 6 水草 / 5 石 / 2 沉木的参数表
  view2d.js             2D 降级渲染（同一份存档）
  aquarium/
    scene.js            缸体、水面、灯光、焦散、光柱、粒子、画质档
    fish.js             鱼几何 + 鳍 + 眼睛 + 花纹 + 游动/摆鳍着色器
    decor.js            水草/石头/沉木的程序化几何与摆动
    view3d.js           3D 视图：相机、拾取、拖拽、喂食、昼夜、释放
  cloud/{api,sync}.js   进食队列、去重、冲突、离线保留（在阶段 A 之上扩展）
  sw.js                 只缓存发布产物（打包后的 app.js 等）
build.mjs               静态文件白名单 + esbuild 打包（含 three、认证 SDK）
supabase/
  migrations/20261018120000_phase_b_growth_and_aquascaping.sql
  rollback/0002_phase_b_growth.down.sql
tests/
  model.test.js         存档 v2 / 成长 / 外观 / 迁移（20）
  cloud-sync.test.js    同步、冲突、离线、进食队列（46）
  sql/migrations.test.js        v1 兼容与 RLS（27）
  sql/phase-b-growth.test.js    v2 校验、结算、进食去重（9）
  e2e/cloud-e2e.mjs     全链路浏览器测试（74 项检查）
docs/
  GROWTH-RULES.md       成长规则
  VISUAL-DESIGN.md      视觉与渲染设计
  POST-A-PROGRESS.md    本文件
  POST-A-ACCEPTANCE.md  验收矩阵与未验证项
  evidence/*.png        验收截图
```

## 4. 与任务书/原计划的差异

1. **鱼型 9 种**（要求 ≥8）：多出的 `whisker` 用来覆盖「贴底、扁头、带须」的生态位，让同一缸里不只是中上层鱼。
2. **石头 5 类，但默认构图只摆 4 类**：`slate` 已实现并可在布景里放，默认模板为了留白只选 4 类；
   验收截图展示的是默认构图，5 类的可建性由单测与布景面板覆盖。
3. **成长周期**按最新要求翻倍（自然 14 天 / 正常喂食 10 天），替代早前 7 天/5 天的安排。
4. **2D 模式不提供布景编辑**：2D 是降级/省电/兼容模式，拖拽与拾取精度不足，改为提示切回 3D；
   观赏、喂食、看鱼卡在 2D 下都可用。
5. **鱼的造型重做过两轮**：第一版「椭圆体 + 平面鳍」被用户否掉；第二版改为低多边形棱面 + 大眼白圈 +
   分叉尾，用户仍觉得「整体还是太丑」，并明确希望走更简单的像素/方块风（类似 Minecraft，不必圆润）。
   最终版把鱼、水草、石头、沉木全部重写为**体素方块**：鱼按列堆方块、尾巴独立摆动、眼睛是贴在体侧的
   像素点；造景是噪声侵蚀的方块团。参考只用于造型语言（Kenney 鱼包、公开低多边形鱼渲染），没有使用
   任何第三方资产。

## 5. 已知限制

- 真实 Supabase 项目未应用迁移，未做真实云端联调（PGlite + 假后端已覆盖逻辑）。
- 手机只有 Chromium 视口仿真，没有真机；iOS Safari 的 WebGL 行为未验证。
- 3D 上下文丢失的手动触发未在真机验证（自动降级路径已实现并有 e2e 覆盖「无 WebGL」分支）。
- 音效只做了开关与生命周期处理，没有做听感验收。
- 渲染在低端设备上的长时间稳定性（发热、降频、内存）未测。
