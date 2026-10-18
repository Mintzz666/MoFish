// 假 Supabase 的两种接入方式：
//  1) createFakeFetch —— Node 单测里直接当 fetch 用（快、可控、能注入故障）
//  2) startFakeServer —— 真起一个 HTTP 服务，供浏览器端到端测试指向它（带 CORS）
// 再次强调：这两个都只是本地替身，不代表 Supabase 云端联调。

import http from 'node:http';

function route(fake, url, method, headers, body) {
  const p = url.pathname;
  if (p.startsWith('/auth/v1')) return fake.handleAuth(method, p, url.searchParams, headers, body);
  if (p.startsWith('/rest/v1/rpc/')) return fake.handleRpc(p.replace('/rest/v1/rpc/', ''), headers, body);
  return { status: 404, body: { message: `no route ${method} ${p}` } };
}

function toResponse({ status, body }) {
  return new Response(body == null ? null : JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}

export function createFakeFetch(fake, { onRequest } = {}) {
  return async function fetchImpl(input, init = {}) {
    const url = new URL(typeof input === 'string' || input instanceof URL ? String(input) : input.url);
    const method = String(init.method || 'GET').toUpperCase();
    const headers = {};
    for (const [k, v] of new Headers(init.headers || input?.headers || {})) headers[k.toLowerCase()] = v;
    let body = null;
    if (init.body) { try { body = JSON.parse(init.body); } catch { body = null; } }

    if (onRequest) {
      const override = await onRequest({ url, method, headers, body, path: url.pathname });
      if (override) return override;
    }
    return toResponse(route(fake, url, method, headers, body));
  };
}

/** 让下一次请求抛错，用于测试「网络不可达」分支。 */
export function networkFailure(message = 'offline') {
  return async () => { throw new TypeError(message); };
}

export async function startFakeServer(fake, { port = 0, host = '127.0.0.1' } = {}) {
  const requests = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      let body = null;
      if (raw) { try { body = JSON.parse(raw); } catch { body = null; } }
      const headers = {};
      for (const [k, v] of Object.entries(req.headers)) headers[k.toLowerCase()] = v;
      if (req.method !== 'OPTIONS') requests.push({ method: req.method, path: req.url, body });

      // 与 Supabase 一致地放开 CORS（真正的边界是 RLS，不是 CORS）。
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Headers', 'authorization, apikey, content-type, accept, x-client-info, x-supabase-api-version');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, OPTIONS');

      if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

      const url = new URL(req.url, `http://${host}:${port}`);
      const { status, body: payload } = route(fake, url, req.method.toUpperCase(), headers, body);
      const text = payload == null ? '' : JSON.stringify(payload);
      res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(text) });
      res.end(text);
    });
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolve);
  });

  const address = server.address();
  return {
    url: `http://${host}:${address.port}`,
    port: address.port,
    requests,
    close: () => new Promise(resolve => server.close(resolve))
  };
}
