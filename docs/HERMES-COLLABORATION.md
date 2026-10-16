# MoFish：Hermes + DeepSeek 与 Codex 的协作

## 分工与交接边界

- 用户决定功能目标、是否接受版本、是否上线。
- Hermes 使用 DeepSeek 进行开发和测试，在 `hermes/<task>` 分支提交代码。
- 用户已授权 Codex 直接拆分阶段 A 修复任务给 Luna（max 思考），由 Codex 独立复审、验证并维护开发分支。无需搭建云端 DeepSeek worker；Hermes 仍承接用户转发的任务。
- 用户请求 Codex 介入时，Codex 从 GitHub 获取指定分支/提交，检查代码和验证证据，提供建议。除非用户要求修复，默认只做评审。
- 两个工具不共享聊天、未提交文件、运行环境或密钥；GitHub 是交接来源。未推送的代码，另一端无法读取。
- 同一轮由一个工具负责修改。交接评审期间暂停对目标分支的修改，或明确指出新的提交。
- 日常开发分支可推送，但不能自行合并 main、调用正式 release、修改线上权限或部署。产品发版遵守根目录 `AGENTS.md`；只在用户明确接受当前版本后执行。

## 在自己的电脑上设置 Profile

以下针对 Nous Research Hermes Agent，按官方 CLI 文档编写。终端先确认 `hermes --version`；命令参数不匹配时查看该版本 `--help`，不要假装成功。

```sh
hermes profile create mofish-dev
hermes --profile mofish-dev setup
```

向导中选择 DeepSeek，把 API Key 输入 Hermes 的凭据输入框，API Base URL 使用 `https://api.deepseek.com`。从当前可用模型列表选择适合代码开发的模型；DeepSeek 官方 Hermes 集成示例使用 `deepseek-v4-pro`。凭据只在你本机 Profile 中保存，不粘贴进仓库、交接文档或聊天。

已经有 Profile 时，不重复创建；可用 `hermes profile list` 检查。图形版在 Profile 管理处选中该 Profile，Providers 里添加 DeepSeek；检查设置的 Applies to 指向 `mofish-dev`。

```sh
git clone https://github.com/Mintzz666/MoFish.git
cd MoFish
hermes --profile mofish-dev chat
```

已有 clone 则使用原目录，先检查是否有未提交改动，再更新，不要重复克隆覆盖工作。GitHub 权限与 DeepSeek API 是两套凭据：本机须单独完成正常的 GitHub Git 认证，才能推送开发分支。

## 首次发给 Hermes 的完整 prompt

```text
你是 MoFish 的开发与测试协作者，使用 DeepSeek。项目仓库是 https://github.com/Mintzz666/MoFish；用户需要时会请 Codex 评审，你们通过 GitHub 分支、提交和交接文档合作，不共享聊天上下文。

开始前：
1. 阅读根目录 AGENTS.md、README.md、本文件和 docs/HANDOFF.md，优先遵守用户当前指令。
2. 检查 git status、当前分支、origin 和最近提交，报告你实际读取的状态。用户未提交的改动不能覆盖、丢弃或自动纳入提交。
3. 代码干净时获取 origin/main，以用户指定的基线或最新 main 建立独立 hermes/<task> 分支；已有对应开发分支则继续它。不要直接在 main 开发，不强制推送，不擅自合并 main。

开发要求：
- 产品名称始终为 MoFish，目标是轻松休息的电子鱼缸；保留手机和电脑适配、本地存档、离线使用、无强制签到和无饿死惩罚。
- 先阅读现有实现，再针对用户任务做必要改动；保持提交小而清楚。未经用户要求不引入账号、付费服务、复杂框架或后台服务。
- 做适当测试，至少执行 npm test 和 npm run build；涉及交互或布局时用可用浏览器检查电脑及手机尺寸。区分实际执行、未执行、失败，不编造通过结果。
- 新功能不能破坏旧存档；修改存档结构时说明兼容迁移方案。
- 不读取、打印或提交 API Key、令牌、.env、个人存档等秘密或私人数据。不把 Hermes Profile 放进项目。

每轮交接：
1. 审查 diff，更新 docs/HANDOFF.md：任务、基线、改动、测试命令与结果、复现步骤、已知问题、请 Codex 重点评估的事项。
2. 将本轮审查过的变更提交到开发分支；用户未禁止且已具备写入权限时，推送该分支。没有权限则如实报告，不宣称已同步。
3. 最后回复分支名、最终 commit SHA、PR 链接（如有）、测试结果，以及一句可直接转给 Codex 的评审请求。交接文档可写父提交 SHA，最终 SHA 以这条回复为准，避免为记录自身 SHA 反复提交。
4. 没有用户明确验收，不运行正式 release，不打版本标签，不部署，不更改 Sites 配置。可以做发布预演，但预演不是正式发布。

现在先检查现有状态并简短汇报；如果我还没给具体开发任务，等待任务，不自行挑选功能。
```

## 每轮开发任务

```text
请按 docs/HERMES-COLLABORATION.md 的协作规则完成本轮任务：
任务：<需要实现或修复的内容>
验收标准：<用户可观察到的行为>
约束：<需要保留或不能改变的内容>
结束后测试、更新交接文档，并推送开发分支供 Codex 评审。不要正式发版或上线。
```

## 叫 Codex 介入时

```text
请评审 MoFish 的 Hermes 开发结果：
分支：hermes/<task>
提交：<Hermes 回复的完整 commit SHA>
本轮目标：<一句话>
请先读取该提交的 AGENTS.md 和 docs/HANDOFF.md，比较它与基线的代码差异，核对测试与存档兼容性。
本轮只评估并给建议，不修改代码、不合并、不发版。
```

Codex 应先保留现有工作区改动，通过 fetch 及单独 worktree/检出目录检查指定快照，不盲目 pull 覆盖。评审报告应标记严重程度、对应代码位置、复现方式和建议；没有发现实质问题就直说，并列出尚未验证的部分。

## 官方参考

- Profiles：https://hermes-agent.nousresearch.com/docs/reference/profile-commands
- CLI：https://hermes-agent.nousresearch.com/docs/reference/cli-commands
- DeepSeek 集成：https://api-docs.deepseek.com/quick_start/agent_integrations/hermes/
- Desktop 设置：https://hermes-agent.nousresearch.com/docs/user-guide/desktop

Profile 配置需在用户运行 Hermes 的电脑上完成；这份仓库文档不会自动创建用户本机 Profile，也不会建立无人值守的跨工具聊天连接。

## 每轮指令必须包含：本地文件与资源管理

```text
请管理好本轮本地文件和进程：复用项目目录，临时产物集中到唯一的任务临时目录，记录路径及自己启动的进程。浏览器测试尽量串行，完成后关闭本轮浏览器、预览服务和测试数据库；检查已完成的后台安装任务，不留重复或失控进程。

仅清理确认属于本轮且已无用的临时文件，不删除源码、锁文件、用户数据、必要测试证据或有用缓存。不要批量清空下载目录/缓存，不反复重装依赖，不把 node_modules、dist、大日志、个人存档或密钥提交 Git。

数据库测试必须使用专用可销毁测试库，不能对任意外部连接执行 DROP SCHEMA。临时数据库目录、端口和浏览器 profile 应隔离，防止两轮任务互相清理。

交接时简述：测试结果、保留的证据位置、已清理的临时内容、仍需保留的进程或文件及原因。未验证的项照实标明。
```
