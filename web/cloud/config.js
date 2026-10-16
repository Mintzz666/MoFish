// 云端配置读取与安全校验。
//
// 前端只允许拿到 Supabase 的项目 URL 与 publishable / anon key —— 这两样本来就是公开的，
// 真正的数据边界是数据库的 RLS（见 supabase/migrations）。service_role / secret key
// 一旦出现在前端就等于把整个项目交出去，所以这里主动识别并拒绝启动云功能。
//
// 配置来源：构建时注入 dist/config.js（见 build.mjs），或页面里先于 app.js 加载的
// 同名脚本设置 window.MOFISH_CONFIG。缺省（未配置）即为「游客/本地模式」，属正常状态。

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

/** 解析 JWT 的 payload（只为读 role，不做签名校验；签名由 Supabase 服务端负责）。 */
export function decodeJwtPayload(token) {
  if (typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  try {
    const b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const padded = b64.padEnd(Math.ceil(b64.length / 4) * 4, '=');
    // 用 TextDecoder 而不是已废弃的 escape()，正确处理非 ASCII 声明。
    const binary = typeof atob === 'function'
      ? atob(padded)
      : Buffer.from(padded, 'base64').toString('binary');
    const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
    const json = new TextDecoder('utf-8').decode(bytes);
    return JSON.parse(json);
  } catch {
    return null;
  }
}

/**
 * 判断一把 key 属于哪一类。
 * - 'publishable'：新版 `sb_publishable_...`，可进前端
 * - 'anon'：旧版 anon JWT（role=anon），可进前端
 * - 'secret'：`sb_secret_...` 或 role 为 service_role/supabase_admin，禁止进前端
 * - 'unknown'：格式无法识别，拒绝使用以避免误把密钥当公开 key
 */
export function classifyKey(key) {
  if (typeof key !== 'string' || key.trim() === '') return 'unknown';
  const value = key.trim();
  if (value.startsWith('sb_publishable_')) return 'publishable';
  if (value.startsWith('sb_secret_')) return 'secret';
  const payload = decodeJwtPayload(value);
  if (!payload) return 'unknown';
  if (payload.role === 'service_role' || payload.role === 'supabase_admin' || payload.role === 'postgres') {
    return 'secret';
  }
  if (payload.role === 'anon') return 'anon';
  return 'unknown';
}

function parseUrl(raw) {
  try { return new URL(String(raw)); } catch { return null; }
}

/**
 * 读取配置并判定云功能是否可用。
 * 返回 { mode, url, anonKey, keyKind, projectRef, problems }：
 *   mode: 'off'（未配置，游客模式） | 'ready'（可用） | 'blocked'（配置有安全问题，拒绝启用）
 * 注意：返回值里包含 anonKey（前端本来就需要它），但 problems 只描述类别，不复制密钥内容。
 */
export function readCloudConfig(source = (typeof globalThis !== 'undefined' ? globalThis.MOFISH_CONFIG : null)) {
  const raw = source && typeof source === 'object' ? source : {};
  const problems = [];
  const urlRaw = typeof raw.supabaseUrl === 'string' ? raw.supabaseUrl.trim() : '';
  const keyRaw = typeof raw.supabaseAnonKey === 'string' ? raw.supabaseAnonKey.trim() : '';

  if (!urlRaw && !keyRaw) {
    return { mode: 'off', url: '', anonKey: '', keyKind: 'none', projectRef: null, problems: ['未配置云端项目地址与公开 key'] };
  }

  const url = parseUrl(urlRaw);
  if (!url) {
    problems.push('项目地址不是合法 URL');
  } else if (url.protocol !== 'https:') {
    if (url.protocol === 'http:' && LOCAL_HOSTS.has(url.hostname)) {
      // 允许本机 http 用于本地联调（例如 tests/fake-supabase）；部署环境必须 https。
    } else {
      problems.push('项目地址必须使用 https');
    }
  }

  const keyKind = classifyKey(keyRaw);
  if (keyKind === 'secret') {
    problems.push('检测到 service_role / secret key：这类密钥绝不能放在前端，已拒绝启用云功能');
  } else if (keyKind === 'unknown') {
    problems.push('公开 key 格式无法识别（应为 anon JWT 或 sb_publishable_ 开头）');
  }

  const projectRef = url && url.hostname.endsWith('.supabase.co')
    ? url.hostname.replace(/\.supabase\.co$/, '')
    : null;

  const blocked = problems.some(p => p.includes('service_role') || p.includes('无法识别') || p.includes('必须使用 https') || p.includes('不是合法 URL'));
  const mode = blocked ? 'blocked' : (problems.length ? 'off' : 'ready');

  return { mode, url: url ? url.origin : urlRaw, anonKey: mode === 'blocked' ? '' : keyRaw, keyKind, projectRef, problems };
}

/** 生成给用户看的连接状态文案（不含任何密钥内容）。 */
export function describeCloudConfig(config) {
  if (!config) return '未连接云端';
  if (config.mode === 'ready') return '云服务已配置';
  if (config.mode === 'blocked') return '未连接云端（配置被拒绝）';
  return '未连接云端';
}
