# 阶段 B 本机联调与独立部署记录

2026-10-19，Codex 本地 Project；交接提交 `85211641c676b0cc7c7686d4ca583120975caf3b`。
**真实云端联调与测试入口已完成，B 整体验收仍待真机、听感、审美及用户接受。**
不合并 main、不打标签、不运行 release、不启动多人 C。

## 入口与精确版本

- [B 测试入口](https://mofish-phase-b.tibo-reset-notifier.workers.dev/)，独立 Worker `mofish-phase-b`。
- 实际部署源码：`a7706e620d89cbd8a3530e9f2fb4492eb58afffd`。
- Cloudflare version：`0b424279-d44b-4d1f-b069-ceea7678d49d`，实际部署 `d12d98d3-1082-46cc-a6f8-03e13e4c1ccc`，100% 流量。
- [线上部署元数据](https://mofish-phase-b.tibo-reset-notifier.workers.dev/deployment.json) 的 SHA 与源码相符；
  Cloudflare 版本说明也记录完整源码 SHA。交接文档后续提交不代表重新部署。
- Supabase：`MoFish-Phase-B-QA` / `gbcfyqtbezkgkstrfbzn`，既有三份迁移未重放，项目未重复创建。

## 本机配置与改动

原 `/Users/mintzz/Documents/MoFish` 为干净的 `hermes/single-player-3d`，保持原状。
独立工作树 `/Users/mintzz/.codex/worktrees/mofish-phase-b-acceptance/MoFish`，分支 `codex/phase-b-review-polish`。
已恢复公开 URL/ref/publishable key；用户在 Git 忽略、0600 的 `.env.phase-b` 填入新 B Legacy service_role。
本机已有 Node 24.19.0 与 Cloudflare OAuth，未创建、复制或撤销令牌；部署显式指定已核对的账号。
详见 [本机配置](PHASE-B-ENV-SETUP.md)。不使用 Codex Cloud 白名单或代理占位凭据。

B 部署脚本复用现有 Wrangler OAuth，要求实际部署前工作区干净、代码已提交，
并生成公开部署元数据及版本说明；A 部署逻辑及目标保持不变。
Safari 真实链路发现 v2 冲突备份摘要仍读取 v1 `plants`，显示 `undefined 株水草`；
已改为 v2 造景件数、保留 v1 水草数量，加回归后部署并在 Safari 确认 `3 条鱼 · 9 件造景`。

## 实际验证

| 验证 | 结果与证据边界 |
| --- | --- |
| `MOFISH_REQUIRE_POSTGRES=1 npm test` | 最终 187/187、零跳过，包含嵌入式真实 PostgreSQL 多连接测试；首次原基线为 186/186 |
| `npm run test:cloud:b` | 真实 B Supabase HTTP 64/64；普通命令运行，未启用代理标志 |
| 部署脚本相关回归 | 5/5；修复后的账号 UI 6/6，不与全套数字相加 |
| `npm run deploy:cloudflare:b -- --dry-run` | 最终预演通过；随后同一源码实际部署成功 |
| 构建与线上读取 | 六个关键文件 HTTP 200、与最终 dist 逐字节一致；哈希保存在证据 JSON |
| CSP / 缓存 | 六个响应均有预期 CSP；`config.js` / `sw.js` 为 `no-cache`，其余 `max-age=0, must-revalidate` |
| 私密与源模块 | `.env.phase-b`、`model.js`、`cloud/api.js` 均 HTTP 404；构建私密值扫描通过 |
| B Auth URL | 原先 Site URL 为 localhost、Redirect URLs 为空；已只将 B 两项保存为实际 B 根地址 |
| 实际 recovery 链接 | 默认与显式 redirect 2/2 指向 B；只生成随机临时账号的链接，不发邮件、不记录令牌 |
| Safari 27.0.1 桌面实测 | 实际线上 3D 玻璃缸/体素鱼、邮箱登录、同步、刷新页面后会话与九件造景恢复、2D/夜间、退出通过 |
| Safari 冲突/备份 | 在同步完成前立即刷新触发保留冲突；本机改动未丢，选择本机后同步成功并有备份；修复后摘要正确 |
| A Worker 保护 | 只读部署历史前后逐项相等；本轮部署命令始终固定 B 名称 |
| 最终云端清理 | 2 个冒烟、1 个回调、1 个浏览器临时账号已删除，均 GoTrue 404 确认；三张表最终计数均 0 |

B API 直接连接可达；本机对 Workers 域名直接读取超时，使用已配置的环境代理 `NODE_USE_ENV_PROXY=1` 后核验通过。
Wrangler 自动使用既有代理；系统网络/代理未修改。Safari 实际成功打开入口。
这不保证任何网络均直连可达；真机反馈需记录实际网络。
应用内浏览器建页/绑定两次超时，实际浏览器验证改用已有 Safari；不将工具超时认作产品失败或浏览器通过。
历史 Chromium 假后端 87/87 未在本轮重复，不能替代本轮真实云端或手机证据。

## 证据与清理

入库的脱敏摘要：[phase-b-local-20261019.json](evidence/phase-b-local-20261019.json)。
本机完整脱敏日志保留在工作树 `.local/phase-b-acceptance-20261019/`：
`cloud-smoke.log`、`local-tests-final.log`、`deploy-dry-run-final.log`、`deploy-live-final.log`、
`deployment-verification.json`、`auth-redirect.log`、`browser-cleanup.log` 和 `cleanup.json`。
Safari 画面与 UI 状态已在本轮工具输出核验；没有另存桌面截图文件。

仅使用本轮登记的随机临时身份；临时身份、关联行已清理，临时身份注册文件及含合成测试密码的脚本已移除。
自建 Safari 测试标签已关闭并恢复用户原标签，Safari/Code 等原应用保留。
没有启动预览服务；嵌入式测试数据库已由测试生命周期停止，任务 CLI 均已退出。
应用内未标记的临时页按工具生命周期在回合结束关闭；不关闭用户应用来处理工具超时。
工作树、正常依赖缓存、Git 忽略的本机配置、B 项目和 B Worker 保留供用户验收。

## 剩余与收口判断

按 [电脑/手机集中验收](PHASE-B-DEVICE-ACCEPTANCE.md) 一次检查：真实触控造景、跨设备真断网重连、
冲突备份和换号、10 分钟持续运行/发热与前后台、实际 WebGL 丢失保档、音效和最终审美。
尚未执行完整 iPhone/Android 真机或 Firefox 组合，也未做真实发信/SMTP 可靠性验证。
**可交付用户真机验收，尚不能宣布 B 收口。** 用户接受后仅更新验收结论，仍遵守本轮禁止 release 的边界。
