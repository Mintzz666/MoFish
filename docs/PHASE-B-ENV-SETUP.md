# 阶段 B 本机配置（2026-10-19）

本轮使用 Codex 本地 Project，不使用 Codex Cloud。不需要云环境网络白名单、秘密注入或代理占位配置。
仅操作 `MoFish-Phase-B-QA`（`gbcfyqtbezkgkstrfbzn`）；三份迁移已应用，不重复建项目、`db push` 或重放迁移。

## 本机文件

当前验收工作树：`/Users/mintzz/.codex/worktrees/mofish-phase-b-acceptance/MoFish`。
配置文件为该目录的 `.env.phase-b`，Git 忽略、权限 `0600`；不要复制到源码或聊天。
原 `/Users/mintzz/Documents/MoFish` 仍保留 Hermes 分支，未切换或覆盖。

公开 URL/ref/publishable key 已通过已连接 B 项目取回，不需要手抄。
`MOFISH_B_SMOKE_SERVICE_ROLE_KEY` 使用新 B 项目的真实 Legacy service_role，不能复用 A 或云代理占位值。
在 [B API Keys](https://supabase.com/dashboard/project/gbcfyqtbezkgkstrfbzn/settings/api-keys)
的 **Legacy anon, service_role API keys** 标签找到 `service_role`，Reveal 后仅粘贴到本机配置。
当前脚本显式拒绝 `sb_secret_...`。环境变量优先于文件；若修改文件后结果不符，检查是否有旧导出变量覆盖。

```dotenv
MOFISH_B_PROJECT_REF=gbcfyqtbezkgkstrfbzn
MOFISH_B_SUPABASE_URL=https://gbcfyqtbezkgkstrfbzn.supabase.co
MOFISH_B_SUPABASE_ANON_KEY=<已恢复的新 B 公开 key>
MOFISH_B_SMOKE_SERVICE_ROLE_KEY=<仅本机保存的新 B Legacy service_role>
CLOUDFLARE_ACCOUNT_ID=c718d031b16fe6edfe870bfe3551ab6b
```

## Node 与网络

本机已有 Node `24.19.0`，可在任务终端设置：

```sh
export PATH=/Users/mintzz/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin:$PATH
cd /Users/mintzz/.codex/worktrees/mofish-phase-b-acceptance/MoFish
node --version
npm run test:cloud:b
```

本轮直接连接 B API 可达，HTTP 冒烟使用普通命令；只有本机实际需要且已配置代理时才加 `NODE_USE_ENV_PROXY=1`。
保留现有代理及 TLS 校验，不修改系统代理或云环境。

## Cloudflare

本机 `wrangler@4.151.0 whoami` 已验证现有 OAuth 登录及目标账号，无需新建或复制令牌。
B 部署脚本支持现有 Wrangler OAuth，仍要求明确账号 ID；A 部署入口的凭据要求不变。
未来登录失效时，先在本机运行 `npx wrangler@4.151.0 login` 完成官方浏览器登录，再 `whoami` 核对账号。
也可安全配置已授权的 `CLOUDFLARE_API_TOKEN`；不要替换或撤销已有其他项目令牌。

HTTP 通过后，提交已审阅变更，在干净工作区执行：

```sh
npm run deploy:cloudflare:b -- --dry-run
npm run deploy:cloudflare:b
```

Worker 固定 `mofish-phase-b`；不操作原 `mofish`。B 产物 `/deployment.json` 和 Cloudflare 版本说明记录源码 SHA。
预演不等于部署成功；线上验证结果以验收文档为准。

## B Auth 回调

在 [B Auth URL Configuration](https://supabase.com/dashboard/project/gbcfyqtbezkgkstrfbzn/auth/url-configuration)
核对 Site URL 与 Redirect URLs 均包含 `https://mofish-phase-b.tibo-reset-notifier.workers.dev/`。
不能仍默认跳转 `localhost`。只修改 B；不改变 A 的回调。实际核验结果见交接和验收记录。

B 是独立测试环境，A 账号和存档不会自动迁入。自动化仅使用脚本随机临时身份，完成后清理；
新 B 项目和供用户验收的 Worker 保留。多人 C、main 合并、版本标签和正式 release 均不在本轮范围。
