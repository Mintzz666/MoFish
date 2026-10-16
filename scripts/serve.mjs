// 本地静态预览服务器：用于验证 dist/ 的产物**与 Cloudflare 的 _headers 规则**。
//
// 为什么不用 `python3 -m http.server`：它不会应用 _headers，而 CSP 这类响应头只有在真机上
// 生效时才会暴露问题（例如内联脚本被拦、接口域名没进 connect-src）。这个脚本会解析
// 与 Cloudflare Workers 静态资源同名的 `_headers` 文件，让本地预览尽量贴近线上的行为。
//
// 用法：
//   node scripts/serve.mjs                        # 服务 dist/，端口 5173
//   node scripts/serve.mjs --dir web --port 5174  # 服务源码目录（开发用，无 CSP 影响）
//   node scripts/serve.mjs --allow-connect http://127.0.0.1:54321
//     —— 仅本地测试用：把额外来源追加到 connect-src，便于指向本地假 Supabase。
//        生产环境的 _headers 不含这些来源。

import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';

function parseArgs(argv) {
  const args = { dir: 'dist', port: 5173, allowConnect: [], headers: true };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dir') args.dir = argv[++i];
    else if (a === '--port') args.port = Number(argv[++i]);
    else if (a === '--allow-connect') args.allowConnect.push(argv[++i]);
    else if (a === '--no-headers') args.headers = false;
  }
  return args;
}

/** 解析 _headers：块之间用空行分隔，块首行是路径规则，后续缩进行是 "Name: value"。 */
export function parseHeadersFile(text) {
  const rules = [];
  let current = null;
  for (const rawLine of text.split(/\r?\n/)) {
    if (!rawLine.trim()) { current = null; continue; }
    if (/^\s/.test(rawLine)) {
      if (!current) continue;
      const idx = rawLine.indexOf(':');
      if (idx < 0) continue;
      current.headers.push([rawLine.slice(0, idx).trim(), rawLine.slice(idx + 1).trim()]);
    } else {
      current = { pattern: rawLine.trim(), headers: [] };
      rules.push(current);
    }
  }
  return rules;
}

export function headersFor(rules, pathname) {
  const out = {};
  for (const rule of rules) {
    const matches = rule.pattern === pathname || rule.pattern === '/*' || (rule.pattern.endsWith('*') && pathname.startsWith(rule.pattern.slice(0, -1)));
    if (!matches) continue;
    for (const [name, value] of rule.headers) out[name] = value;
  }
  return out;
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8'
};

export async function startPreviewServer({ dir = 'dist', port = 5173, allowConnect = [], headers = true, host = '127.0.0.1' } = {}) {
  const root = path.resolve(dir);
  let rules = [];
  if (headers) {
    try { rules = parseHeadersFile(await readFile(path.join(root, '_headers'), 'utf8')); } catch { rules = []; }
  }

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, `http://${host}:${port}`);
      let pathname = decodeURIComponent(url.pathname);
      if (pathname.endsWith('/')) pathname += 'index.html';

      const target = path.resolve(root, '.' + pathname);
      if (!target.startsWith(root)) { res.writeHead(403).end('forbidden'); return; }

      let body;
      try {
        const info = await stat(target);
        if (info.isDirectory()) throw new Error('dir');
        body = await readFile(target);
      } catch {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('404 Not Found');
        return;
      }

      const out = headersFor(rules, pathname);
      if (allowConnect.length && out['Content-Security-Policy']) {
        out['Content-Security-Policy'] = out['Content-Security-Policy'].replace(
          "connect-src 'self' https://*.supabase.co",
          `connect-src 'self' https://*.supabase.co ${allowConnect.join(' ')}`
        );
      }
      out['Content-Type'] = MIME[path.extname(target)] || 'application/octet-stream';
      res.writeHead(200, out).end(req.method === 'HEAD' ? undefined : body);
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' }).end('500 ' + err.message);
    }
  });

  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, host, resolve); });
  const actual = server.address().port;
  return { url: `http://${host}:${actual}`, port: actual, close: () => new Promise(r => server.close(r)), rules };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = parseArgs(process.argv.slice(2));
  const server = await startPreviewServer(args);
  const ruleInfo = server.rules.length ? `已应用 ${server.rules.length} 条 _headers 规则` : '无 _headers';
  console.log(`MoFish 预览: ${server.url} （目录 ${path.resolve(args.dir)}，${ruleInfo}）`);
  if (args.allowConnect.length) console.log(`本地 connect-src 追加: ${args.allowConnect.join(' ')}（仅测试用）`);
}
