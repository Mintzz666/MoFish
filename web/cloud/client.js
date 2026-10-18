// 把认证、数据接口与配置凭据串成一个可直接使用的云栈。
// app.js 与测试都通过这里装配，避免两边的接线逻辑出现分叉。
import { createAuthClient } from './auth.js';
import { createCloudApi } from './api.js';
import { readCloudConfig } from './config.js';

export function createCloudStack({
  config = readCloudConfig(),
  store,
  fetchImpl = globalThis.fetch,
  now = () => Date.now(),
  emailRedirectTo = null,
  timeoutMs = 15000
} = {}) {
  const auth = createAuthClient({
    url: config.url,
    anonKey: config.anonKey,
    fetchImpl,
    store,
    now,
    emailRedirectTo
  });

  const api = createCloudApi({
    url: config.url,
    anonKey: config.anonKey,
    fetchImpl,
    timeoutMs,
    // 取当前访问令牌：会话已过期时也返回旧令牌，由 api 层收到 401 后刷新一次再重试。
    // transient 区分「暂时拿不到令牌（离线）」与「未登录」：前者必须保留本机改动。
    getAccessToken: async () => {
      const result = await auth.getSession({ allowRefresh: false });
      return { token: result.session?.access_token ?? null, transient: false };
    },
    refreshAccessToken: async () => {
      const refreshed = await auth.refresh();
      if (refreshed.ok) return { token: refreshed.session.access_token, transient: false };
      return { token: null, transient: Boolean(refreshed.transient) };
    }
  });

  return { config, auth, api };
}
