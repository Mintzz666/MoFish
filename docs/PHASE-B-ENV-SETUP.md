# 用户配置：阶段 B 新项目与云环境

只配置新项目 `MoFish-Phase-B-QA`（`gbcfyqtbezkgkstrfbzn`），不要改旧 A 项目。
项目已经创建、三份迁移已应用，真实云 SQL 31/31 通过；不需要重复建项目或运行 SQL。
B 测试站尚未部署，以下网址是后续部署目标。

## 1. 找到新项目的管理测试密钥

1. 打开 [新项目 API Keys](https://supabase.com/dashboard/project/gbcfyqtbezkgkstrfbzn/settings/api-keys)。
2. 核对项目名称 `MoFish-Phase-B-QA`，ref `gbcfyqtbezkgkstrfbzn`。
3. 在 `Legacy API Keys` / `Legacy anon, service_role API keys` 区域找到 `service_role`，显示并复制它。
   不选择 `anon` 或 `publishable`，也不要把 `sb_secret_...` 填进当前只支持 Legacy 的测试脚本。
4. 密钥只粘贴到下面的云环境秘密设置，不发聊天、不放仓库、不放网页配置。
   如果界面只有新 `secret` 类型、没有 Legacy，停止复制并告诉 Codex 你看到的字段名称，不发值。

## 2. 云环境网络配置

打开当前云环境的配置/编辑页面，找到网络允许域名列表，在原有列表上追加：

```text
gbcfyqtbezkgkstrfbzn.supabase.co
mofish-phase-b.tibo-reset-notifier.workers.dev
```

保持现有网络模式、代理和原域名；域名字段不加 `https://`、路径或通配符。
不要删除旧 A 项目的域名、Cloudflare API 域名或依赖下载配置。

## 3. 云环境新增秘密

在 `Secrets` / 秘密配置中新增一项：

| 字段 | 填写 |
| --- | --- |
| 名称 / 环境变量名 | `MOFISH_B_SMOKE_SERVICE_ROLE_KEY` |
| 值 | 第 1 步复制的新 B 项目 Legacy `service_role`，只在秘密输入框粘贴 |
| 允许注入的目标域名 | `gbcfyqtbezkgkstrfbzn.supabase.co` |

如果名称和环境变量名是两个输入框，两者都填上面的变量名。使用环境变量注入方式；不把值放普通公开变量。
原 `MOFISH_SMOKE_SERVICE_ROLE_KEY`、`CLOUDFLARE_API_TOKEN`、`CLOUDFLARE_ACCOUNT_ID` 保留不变。
公开的 B URL/ref/publishable 配置可由 Codex 重新取回，无需手抄公开 key。

## 4. 新 B 项目的邮件回调

打开 [新项目 Auth URL Configuration](https://supabase.com/dashboard/project/gbcfyqtbezkgkstrfbzn/auth/url-configuration)：

- Site URL 改为 `https://mofish-phase-b.tibo-reset-notifier.workers.dev/`。
- Redirect URLs 新增同一个完整地址，包含末尾 `/`。
- 保存。不要把旧 A 的 Auth URL 改到这里；Site URL 不应仍为 `http://localhost:3000`。

这能避免验证/重置邮件误跳 localhost。测试站尚未部署，现在直接打开目标网址不可用属正常。

## 5. 保存并在新对话继续

保存并应用云环境配置；如提示需要启动/重建环境，按界面操作等待就绪。
新对话必须选择/连接刚保存的这份云环境配置，不能默认旧环境已经继承新增秘密和域名。
不要把整个变量页、密钥值或完整验证邮件链接粘贴到聊天里。

然后发送：

```text
继续 Mintzz666/MoFish 阶段 B 验收。我已按说明保存 B 云环境配置。
请获取 codex/phase-b-review-polish 最新远端，保留本地改动，先读 AGENTS.md、docs/HANDOFF.md、docs/PHASE-B-NEXT-CHAT.md，再按里面的已授权范围继续。
独立 B 项目 gbcfyqtbezkgkstrfbzn 已创建、三份迁移已应用、真实 SQL 31/31 通过，不要重复建项目或重放迁移。
先安全核验网络与 MOFISH_B_SMOKE_SERVICE_ROLE_KEY 注入，不输出凭据；缺公开配置可从新 B 项目取回。代理占位符不能仅因无法解析 JWT 就判缺失。
沿用代理运行 NODE_USE_ENV_PROXY=1 npm run test:cloud:b，通过后只部署独立 mofish-phase-b Worker，并给我真机验收步骤。
保持 A 项目/入口、Tibo、旧 Sites 和令牌不变；不合并 main、不打标签、不运行 release。清理自己创建的临时账号和进程。
```

B 是独立测试环境，A 的账号和存档不会自动迁入；后续测试只使用本轮创建的临时身份或明确的 B 测试账号。
