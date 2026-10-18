# MoFish 成长规则（阶段 B）

本文件是四阶段成长的唯一说明书：阈值、时间/营养公式、服务端权威与去重、旧鱼兼容、以及怎样在测试里加速验证。
**规则版本：v2**（存档 `version: 2`）。v1 旧档仍按原规则结算，不会被新公式追算。

## 1. 阶段与阈值

| 阶段 | 阈值（累计 growth） | 说明 |
| --- | --- | --- |
| 鱼苗期 fry | `0 ≤ growth < 0.15` | 体型最小、鳍最短、颜色最淡，头部比例更大 |
| 幼鱼期 juvenile | `0.15 ≤ growth < 0.4` | 开始显色，鳍与体长明显增长 |
| 亚成年期 subadult | `0.4 ≤ growth < 0.7` | 鳍形与花纹接近成年，体型继续变大 |
| 成年期 adult | `0.7 ≤ growth ≤ 1.0` | 达到该鱼型稳定体态；0.7 之后仍有约 5% 的收尾长大 |

- 阈值集中在 `web/model.js` 的 `STAGES`，UI、2D/3D 渲染与服务端结算都引用同一组数字。
- **成年阈值仍是 0.7**：阶段 A 已有的成年鱼不会因为新增「亚成年」而倒退。
- 鱼龄（`born` 起算的日龄）与成长阶段是两个独立字段：鱼龄只用于展示，阶段完全由权威 growth 派生。

## 2. 成长来源

成长 = 时间成长 + 营养成长，二者都写入同一条鱼的 `growth`（0..1）。

### 2.1 时间成长（自然成长）

- `0.05 / 24h`，按秒线性累计：`Δgrowth = seconds / 86400 × 0.05`。
- 离线结算上限 **24 小时**（`p_cap_seconds = 86400`）：超过 24 小时的部分按设计丢弃，避免长期不登录一次性暴涨。
- 不喂食也会成长，不存在饿死、掉级或惩罚。

### 2.2 营养成长（实际吃到的食物）

- 只有「鱼真的吃到一口」才记账，**点击喂食按钮本身不算**；多条鱼按各自吃到的数量分别记账。
- 每口 `0.02 / 3 ≈ 0.00667`。
- 每条鱼在**滚动 24 小时**内最多 3 口计入营养；超出部分仍然记 `meals`（互动历史），但不再加速成长，UI 提示「已经吃饱了」。
- 营养上限因此是 `0.02 / 24h`。

### 2.3 周期换算

| 照料方式 | 每天成长 | 到成年（0.7） |
| --- | --- | --- |
| 只靠时间 | 0.05 | 14 天 |
| 正常喂食（每天 3 口都被吃到） | 0.05 + 0.02 = 0.07 | 10 天 |

这是「正常周期登录/照料」的目标值，不是要求验收时真的等 14 天；长期离线仍受 24 小时上限约束。

## 3. 服务端权威与去重

### 3.1 进食记账 `record_feeding`

```
record_feeding(p_id uuid, p_operation_id uuid, p_fish_id text, p_bites int)
  → (status, credited, duplicate, error_code)
```

- 客户端每次「鱼吃到一口」生成一个唯一 `operation_id`（UUID），先落本机队列，再提交服务端。
- `mofish_feed_events` 上 `unique (aquarium_id, operation_id)`：重复提交（重试、双端重放）返回 `duplicate = true`，不会记第二次。
- 服务端只写事件，**不改 growth / revision**；营养统一在 `settle_growth` 里结算。
- 鱼必须确实存在于该鱼缸的 `state_json.fish`，且鱼缸属于当前 `auth.uid()`；否则返回 `not_found`（不区分「不存在」与「不是你的」）。
- 防滥用：单缸 24 小时最多 500 条事件，超过返回 `rate_limited`。与结算共用鱼缸行锁，先判断 operation_id 重试再检查新事件限额；同 ID 不同鱼/口数返回 `operation_mismatch`。

### 3.2 成长结算 `settle_growth`

- `SELECT ... FOR UPDATE` 行锁：并发结算串行执行，不会重复奖励。
- 时间部分按 `state_version` 取速率：v1 `0.008/小时`，v2 `0.05/24h`。
- 营养部分：按 `created_at` 顺序处理未应用事件，逐条计算「该鱼在该事件时间点的 24 小时窗口内已计入的口数」，最多补到 3 口，写入 `credited` 与 `applied_at`。
- 一次 UPDATE 同时写 `growth`、`meals`、`revision + 1`、`last_growth_at = now()`。
- 没有可结算内容（不足 1 秒且没有未应用事件）时**不写库、不推进 revision**。

### 3.3 客户端与游客

- **游客**：`model.eat()` 本地记账（同样的 0.00667/口、同样 3 口窗口），`fedAt` 随存档持久化，刷新不会重复计入。
- **已登录**：鱼吃到时只调用 `engine.queueFeed(fishId)`，把 `{op, fishId, bites}` 落本机队列并去抖提交；本机**不**自增 `meals/growth`，避免与服务端重复计算。服务端结算返回后采用权威状态。
- 离线时队列落盘（`mofish.feeds.<userId>.<aquariumId>`），重连后按顺序补交全部待同步事件，逐条保存确认结果；重复提交由 `operation_id` 去重。先保存新鱼/编辑，再进食记账，再结算；失败时保留队列并显示失败，不能提前显示已同步。

## 4. 旧档与版本兼容

- v1 → v2 迁移保留鱼的 `id / name / born / growth / meals`，`species` 数字索引按 `LEGACY_SPECIES_MAP` 映射到稳定类型 id（0..3 → sunset/mint/moon/coral）。
- 旧鱼的外观种子由 `hash('fish:' + id)` 生成，因此反复迁移、刷新、换设备都是同一副样子。
- 旧 `plants` 数量迁移成确定性的水草对象（固定 id、固定 seed、固定位置），不会每次刷新多长一株。
- **旧成年鱼不倒退**：`growth ≥ 0.7` 仍是成年期。
- 已应用到云端的 v1 存档：在客户端保存为 v2 之前，服务端仍按 v1 速率结算；客户端首次保存后写入 `state_version = 2`。

## 5. 数据库迁移与回滚

- 新增迁移：`supabase/migrations/20261018120000_phase_b_growth_and_aquascaping.sql`
  - 新增 `mofish_state_error_v2` 与按版本分派的 `mofish_state_error_any`；
  - `aquariums.state_version` 允许 1 与 2；
  - 新增 `mofish_feed_events`（客户端无任何直接权限）与 `record_feeding`；
  - 替换 `save_aquarium` / `ensure_aquarium` / `settle_growth`，v1 行为保持不变。
- **未应用到任何真实项目**。部署顺序：先应用迁移 → 再部署 v2 前端（`docs/CLOUD-SETUP.md` 第 3 节）。
- 若 v2 前端先上线而迁移未应用：云端会拒绝 `state_version = 2` 的写入，客户端显示「云端拒绝」并保留本机副本，不丢档；这就是为什么必须按顺序升级。
- 回滚脚本：`supabase/rollback/0002_phase_b_growth.down.sql`。先停用 v2 写入、备份并明确转换 v2 存档后再回滚；脚本在显式事务内最先检查 v2 行，未转换则拒绝，不先删除事件表。

## 6. 测试与加速方法

真实时间不可等待，测试用**可控时间 + 预置存档**：

| 场景 | 方法 | 所在测试 |
| --- | --- | --- |
| 仅时间成长、24h 封顶、重复结算 | 把 `last_growth_at` 回拨 N 小时后调用 `settle_growth` | `tests/sql/phase-b-growth.test.js` |
| 四阶段边界、0.7 成年 | 直接调用 `stageOf()` / 预置 growth | `tests/model.test.js` |
| 实际进食贡献与 3 口上限 | 假后端时钟推进 + `queueFeed` + `settle` | `tests/cloud-sync.test.js` |
| 进食去重、越权、窗口重置 | PGlite 真实 Postgres + `record_feeding` | `tests/sql/phase-b-growth.test.js` |
| 旧鱼不倒退、v1 仍按旧速率 | PGlite 迁移 + v1 存档结算 | `tests/sql/migrations.test.js`、`tests/sql/phase-b-growth.test.js` |
| 四阶段外观与 UI 文案 | 预置 4 条不同 growth 的鱼后截图/断言 | `tests/e2e/cloud-e2e.mjs` 场景 11 |

加速只发生在测试与本地预置数据里：**没有**对正式玩家开放的管理后门、改时间接口或调试入口。e2e 的预置存档通过测试页写入 `localStorage`，与生产界面无关。
