// Browser-level V0.2 service-worker upgrade acceptance.
//
// This test only reads an existing build directory. It copies the build into
// .local/v02-20261023/upgrade-dist and performs every fake-version mutation
// there; it never invokes build.mjs or edits the input directory.
//
// Usage: node tests/e2e/version-upgrade.mjs [--dir dist] [--chrome <path>]

import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import {
  cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createFakeSupabase, makeAccessToken } from '../fake-supabase/supabase-fake.mjs';
import { startFakeServer } from '../fake-supabase/server.mjs';
import { startPreviewServer } from '../../scripts/serve.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../..');
const taskDir = path.join(repo, '.local', 'v02-20261023');
const upgradeDir = path.join(taskDir, 'upgrade-dist');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const checks = [];

function parseArgs(argv) {
  const args = { dir: 'dist', chrome: null, help: false, lazyRetryOnly: false };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--dir') args.dir = argv[++i];
    else if (argv[i] === '--chrome') args.chrome = argv[++i];
    else if (argv[i] === '--lazy-retry-only') args.lazyRetryOnly = true;
    else if (argv[i] === '--help' || argv[i] === '-h') args.help = true;
    else throw new Error(`未知参数：${argv[i]}`);
  }
  return args;
}

function printHelp() {
  console.log('用法：node tests/e2e/version-upgrade.mjs [--dir <现有静态构建目录>] [--chrome <Chrome/Chromium路径>] [--lazy-retry-only]');
}

function chooseChrome(explicit) {
  const candidates = [explicit, process.env.MOFISH_CHROME_PATH,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome',
    process.env.PROGRAMFILES && path.join(process.env.PROGRAMFILES, 'Google/Chrome/Application/chrome.exe')]
    .filter(Boolean);
  const found = candidates.find(candidate => existsSync(candidate));
  if (!found) throw new Error('未找到 Chrome/Chromium；请使用 --chrome 或 MOFISH_CHROME_PATH 指定。');
  return found;
}

function check(name, condition, detail = '') {
  const result = { name, ok: Boolean(condition), detail };
  checks.push(result);
  console.log(`${result.ok ? '✅' : '❌'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!result.ok) throw new Error(`${name}${detail ? `：${detail}` : ''}`);
}

function syntheticBuildId(baseId, label) {
  return createHash('sha256').update(`${baseId}:${label}`).digest('hex').slice(0, 16);
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function readBuildFromWorker(source) {
  const match = source.match(/^const BUILD = (\{[^\n]+\});$/m);
  if (!match) throw new Error('副本 sw.js 中找不到序列化 BUILD 清单。');
  return { manifest: JSON.parse(match[1]), start: match.index, length: match[0].length };
}

function writeWorkerBuild(source, manifest) {
  const found = readBuildFromWorker(source);
  return source.slice(0, found.start)
    + `const BUILD = ${JSON.stringify(manifest)};`
    + source.slice(found.start + found.length);
}

function installFakeConfig(buildDir, manifest, workerText, fakeUrl, anonKey, label) {
  const fakeConfig = `// task-local fake Supabase config
globalThis.__MOFISH_CONFIG__ = ${JSON.stringify({ supabaseUrl: fakeUrl, supabaseAnonKey: anonKey })};
`;
  writeFileSync(path.join(buildDir, 'config.js'), fakeConfig);
  const taskManifest = {
    ...manifest,
    buildId: syntheticBuildId(manifest.buildId, `${label}-${sha256(fakeConfig)}`),
    hashes: { ...manifest.hashes, 'config.js': sha256(fakeConfig) }
  };
  const taskWorkerText = writeWorkerBuild(workerText, taskManifest);
  writeFileSync(path.join(buildDir, 'sw.js'), taskWorkerText);
  writeFileSync(path.join(buildDir, 'asset-manifest.json'), `${JSON.stringify(taskManifest, null, 2)}\n`);
  return { manifest: taskManifest, workerText: taskWorkerText };
}

function connectCdp(wsUrl, { pageDomains = true } = {}) {
  const ws = new WebSocket(wsUrl);
  const pending = new Map();
  const events = [];
  let messageId = 0;

  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++messageId;
    const timeout = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`CDP 超时：${method}`));
    }, 30000);
    pending.set(id, { resolve, reject, timeout });
    ws.send(JSON.stringify({ id, method, params }));
  });

  const opened = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('CDP 连接超时')), 15000);
    ws.addEventListener('open', () => { clearTimeout(timeout); resolve(); }, { once: true });
    ws.addEventListener('error', () => { clearTimeout(timeout); reject(new Error('CDP 连接失败')); }, { once: true });
  });

  ws.addEventListener('close', () => {
    for (const call of pending.values()) {
      clearTimeout(call.timeout);
      call.reject(new Error('CDP 连接关闭'));
    }
    pending.clear();
  });
  ws.addEventListener('message', event => {
    let message;
    try { message = JSON.parse(event.data); } catch { return; }
    if (message.id && pending.has(message.id)) {
      const call = pending.get(message.id);
      pending.delete(message.id);
      clearTimeout(call.timeout);
      if (message.error) call.reject(new Error(`${message.error.code} ${message.error.message}`));
      else call.resolve(message.result);
    } else if (message.method) events.push(message);
  });

  const ready = opened.then(async () => {
    if (pageDomains) {
      await send('Page.enable');
      await send('Runtime.enable');
      await send('Log.enable');
      await send('Network.enable');
    }
  });

  const page = {
    ws, send, events, ready,
    async evaluate(expression) {
      await ready;
      const response = await send('Runtime.evaluate', {
        expression, returnByValue: true, awaitPromise: true
      });
      if (response.exceptionDetails) {
        const detail = response.exceptionDetails.exception?.description || response.exceptionDetails.text;
        throw new Error(`页面执行失败：${detail}`);
      }
      return response.result.value;
    },
    async goto(url) {
      await ready;
      await send('Page.navigate', { url });
      await waitFor(this, 'Boolean(window.__mofish)', { timeoutMs: 90000 });
    },
    async reload() {
      await ready;
      await send('Page.reload', { ignoreCache: false });
      await waitFor(this, 'Boolean(window.__mofish)', { timeoutMs: 90000 });
    },
    async box(selector) {
      return this.evaluate(`(()=>{
        const e=document.querySelector(${JSON.stringify(selector)});
        if(!e)return null;
        e.scrollIntoView({block:'center',inline:'center',behavior:'instant'});
        const r=e.getBoundingClientRect();
        const style=getComputedStyle(e);
        if(style.display==='none'||style.visibility==='hidden'||r.width<1||r.height<1)return null;
        const x=r.left+r.width/2,y=r.top+r.height/2,hit=document.elementFromPoint(x,y);
        return {x,y,hitMatches:Boolean(hit&&(hit===e||e.contains(hit))),
          hit:hit?{tag:hit.tagName,id:hit.id,classes:String(hit.className||'').slice(0,100)}:null,
          viewport:{width:innerWidth,height:innerHeight,scrollY}};
      })()`);
    },
    async click(selector, { allowHidden = false, ignoreHit = false } = {}) {
      await send('Page.bringToFront');
      const box = await this.box(selector);
      if (!box) {
        if (!allowHidden) throw new Error(`找不到可点击元素：${selector}`);
        await this.evaluate(`document.querySelector(${JSON.stringify(selector)})?.click()`);
        await sleep(250);
        return;
      }
      await sleep(50);
      if (!box.hitMatches && !ignoreHit) throw new Error(`点击坐标未命中 ${selector}：${JSON.stringify(box)}`);
      await send('Input.dispatchMouseEvent', {
        type: 'mousePressed', x: box.x, y: box.y, button: 'left', clickCount: 1
      });
      await send('Input.dispatchMouseEvent', {
        type: 'mouseReleased', x: box.x, y: box.y, button: 'left', clickCount: 1
      });
      await sleep(300);
    },
    async type(selector, text) {
      await this.evaluate(`(()=>{
        const e=document.querySelector(${JSON.stringify(selector)});
        if(!e)throw new Error('input missing: ${selector}');
        e.value='';e.focus();
      })()`);
      await send('Input.insertText', { text });
      await sleep(120);
    },
    async setOffline(offline) {
      await send('Network.emulateNetworkConditions', {
        offline, latency: 0,
        downloadThroughput: offline ? 0 : -1,
        uploadThroughput: offline ? 0 : -1
      });
    },
    close() { try { ws.close(); } catch {} }
  };
  return page;
}

async function waitFor(page, expression, { timeoutMs = 20000, intervalMs = 250 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastError = '';
  while (Date.now() < deadline) {
    try {
      const value = await page.evaluate(expression);
      if (value) return value;
    } catch (error) { lastError = error.message; }
    await sleep(intervalMs);
  }
  throw new Error(`等待页面条件超时：${expression}${lastError ? `；最近错误：${lastError}` : ''}`);
}

async function waitForPausedFetchRequest(page, { urlPrefix, method = 'POST', fromIndex = 0, timeoutMs = 30000 }) {
  const deadline = Date.now() + timeoutMs;
  const continued = new Set();
  while (Date.now() < deadline) {
    const paused = page.events.slice(fromIndex).filter(event => event.method === 'Fetch.requestPaused'
      && String(event.params?.request?.url || '').startsWith(urlPrefix));
    for (const event of paused) {
      const requestId = event.params.requestId;
      if (event.params.request?.method === method) return event;
      if (!continued.has(requestId)) {
        continued.add(requestId);
        await page.send('Fetch.continueRequest', { requestId });
      }
    }
    await sleep(30);
  }
  throw new Error(`等待被暂停的 ${method} 请求超时：${new URL(urlPrefix).pathname}`);
}

async function waitForTarget(debugPort, targetId) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const targets = await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json();
    const target = targets.find(item => item.id === targetId);
    if (target?.webSocketDebuggerUrl) return target;
    await sleep(100);
  }
  throw new Error(`无法找到 Chrome target ${targetId}`);
}

async function openTab(browser, debugPort) {
  const { targetId } = await browser.send('Target.createTarget', { url: 'about:blank' });
  const target = await waitForTarget(debugPort, targetId);
  const page = connectCdp(target.webSocketDebuggerUrl);
  await page.ready;
  page.targetId = targetId;
  return page;
}

async function activatePage(browser, page) {
  await browser.send('Target.activateTarget', { targetId: page.targetId });
  await sleep(200);
}

async function launchChrome(chromePath, profileDir) {
  const args = [
    '--headless=new', '--window-size=1440,1000', '--no-first-run', '--no-default-browser-check', '--mute-audio',
    '--disable-background-networking', '--disable-sync', '--disable-extensions', '--hide-scrollbars',
    '--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader',
    '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding', '--remote-debugging-port=0',
    `--user-data-dir=${profileDir}`, 'about:blank'
  ];
  if (process.env.MOFISH_CHROME_NO_SANDBOX === '1') args.splice(args.length - 2, 0, '--no-sandbox');
  const child = spawn(chromePath, args, { stdio: ['ignore', 'ignore', 'pipe'], detached: false });
  let diagnostics = '';
  let spawnError = null;
  child.stderr.on('data', chunk => { diagnostics = (diagnostics + chunk.toString()).slice(-12000); });
  child.once('error', error => { spawnError = error; });

  let debugPort = null;
  let version = null;
  for (let attempt = 0; attempt < 80 && !version; attempt += 1) {
    if (spawnError) throw spawnError;
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`Chrome 启动失败：${child.exitCode ?? child.signalCode}\n${diagnostics}`);
    }
    await sleep(250);
    try {
      debugPort = Number(readFileSync(path.join(profileDir, 'DevToolsActivePort'), 'utf8').split('\n')[0]);
      version = await (await fetch(`http://127.0.0.1:${debugPort}/json/version`)).json();
    } catch {}
  }
  if (!version) throw new Error(`Chrome DevTools 端口不可达。\n${diagnostics}`);
  const browser = connectCdp(version.webSocketDebuggerUrl, { pageDomains: false });
  await browser.ready;
  return { child, browser, debugPort, args, diagnostics: () => diagnostics };
}

async function shutdownChrome(run) {
  if (!run) return;
  try { run.browser.close(); } catch {}
  const child = run.child;
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM');
  const exited = await Promise.race([
    new Promise(resolve => child.once('exit', () => resolve(true))),
    sleep(8000).then(() => false)
  ]);
  if (!exited && child.exitCode === null && child.signalCode === null) {
    child.kill('SIGKILL');
    await Promise.race([new Promise(resolve => child.once('exit', resolve)), sleep(3000)]);
  }
}

async function cacheSnapshot(page) {
  return page.evaluate(`(async()=>{
    const names=await caches.keys();
    const entries=[];
    for(const name of names){
      const cache=await caches.open(name);
      for(const request of await cache.keys())entries.push({cache:name,url:request.url});
    }
    return {origin:location.origin,names,entries};
  })()`);
}

async function currentWorkerBuildId(page) {
  return page.evaluate(`(async()=>{
    const response=await fetch('./asset-manifest.json',{cache:'no-store'});
    return (await response.json()).buildId;
  })()`);
}

async function primeTabPreferences(page, preview, buildDir, prefs) {
  const name = `__upgrade-setup-${process.pid}-${randomUUID().slice(0, 8)}.html`;
  const setupPath = path.join(buildDir, name);
  writeFileSync(setupPath, '<!doctype html><meta charset="utf-8"><title>MoFish test setup</title>');
  try {
    await page.send('Page.navigate', { url: `${preview.url}/${name}` });
    await waitFor(page, `location.pathname===${JSON.stringify(`/${name}`)} && document.readyState==='complete'`);
    await page.evaluate(`localStorage.setItem('mofish.prefs',${JSON.stringify(JSON.stringify(prefs))})`);
  } finally {
    rmSync(setupPath, { force: true });
  }
}

async function createTestAccount(fakeServer, fake, page) {
  const email = `upgrade-${process.pid}-${randomUUID().slice(0, 8)}@example.test`;
  const password = `V02-upgrade-${randomUUID().slice(0, 8)}`;
  const response = await fetch(`${fakeServer.url}/auth/v1/signup`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password })
  });
  if (!response.ok) throw new Error(`本地假 Supabase 创建临时账号失败：HTTP ${response.status}`);
  const user = fake.users.get(email);
  if (!user) throw new Error('本地假 Supabase 未记录新账号。');
  user.confirmed = true;

  await page.click('#account-button');
  await waitFor(page, 'document.getElementById("account-dialog")?.open === true');
  await page.type('#auth-email', email);
  await page.type('#auth-password', password);
  await page.click('#auth-sign-in');
  await waitFor(page,
    'document.getElementById("session-panel")?.hidden === false && document.getElementById("cloud-status")?.textContent.trim() === "已同步"',
    { timeoutMs: 60000 });
  await page.click('#account-dialog .close');
  await waitFor(page, 'document.getElementById("account-dialog")?.open === false');
  return user;
}

async function waitForWorkerInstallFinish(page) {
  await waitFor(page, `(async()=>{
    const registration=await navigator.serviceWorker.getRegistration();
    return Boolean(registration && (!registration.installing || registration.installing.state==='redundant'));
  })()`, { timeoutMs: 45000 });
}

async function runLazyRetryOnly(sourceDir, chromeArg) {
  const lazyRetryDir = path.join(taskDir, 'upgrade-lazy-retry-dist');
  const resultPath = path.join(taskDir, 'upgrade-lazy-retry-result.json');
  const fake = createFakeSupabase();
  let fakeServer = null;
  let preview = null;
  let browserRun = null;
  let profileDir = null;
  const pages = [];
  const startCheckIndex = checks.length;
  const report = {
    schema: 'mofish-lazy-3d-retry-e2e-v1', status: 'running', sourceDir, lazyRetryDir,
    startedAt: new Date().toISOString()
  };
  let failure = null;

  try {
    rmSync(lazyRetryDir, { recursive: true, force: true });
    cpSync(sourceDir, lazyRetryDir, { recursive: true, force: true });
    const inputManifest = JSON.parse(readFileSync(path.join(lazyRetryDir, 'asset-manifest.json'), 'utf8'));
    if (!String(inputManifest.version || '').startsWith('0.2.')) {
      throw new Error(`输入构建不是 V0.2：${inputManifest.version || '缺少版本号'}`);
    }
    const inputWorker = readFileSync(path.join(lazyRetryDir, 'sw.js'), 'utf8');
    const anonKey = makeAccessToken('anon', { role: 'anon' });
    fakeServer = await startFakeServer(fake);
    const { manifest, workerText } = installFakeConfig(
      lazyRetryDir, inputManifest, inputWorker, fakeServer.url, anonKey, 'offline-lazy-retry'
    );
    const workerBuild = readBuildFromWorker(workerText).manifest;
    const view3dAsset = workerBuild.lazy.find(file => /view3d/i.test(file));
    if (!view3dAsset) throw new Error('V0.2 清单中找不到 lazy 3D 模块。');

    preview = await startPreviewServer({ dir: lazyRetryDir, port: 0, allowConnect: [fakeServer.url] });
    const assetBytesResponse = await fetch(new URL(view3dAsset, `${preview.url}/`));
    const assetBytes = Buffer.from(await assetBytesResponse.arrayBuffer());
    check('冻结输入中的 lazy 3D 模块在本地预览上可按 hash 提供',
      assetBytesResponse.status === 200 && sha256(assetBytes) === workerBuild.hashes[view3dAsset],
      `${view3dAsset}; HTTP ${assetBytesResponse.status}; bytes=${assetBytes.length}`);

    profileDir = mkdtempSync(path.join(taskDir, 'chrome-profile-lazy-retry-'));
    browserRun = await launchChrome(chooseChrome(chromeArg), profileDir);
    console.log(`lazy retry 输入 ${manifest.version}/${manifest.buildId} · ${preview.url} · PID ${browserRun.child.pid}`);
    const page = await openTab(browserRun.browser, browserRun.debugPort);
    pages.push(page);
    await activatePage(browserRun.browser, page);
    await primeTabPreferences(page, preview, lazyRetryDir, { renderer: '2d', quality: 'low' });
    await page.goto(`${preview.url}/`);
    await waitFor(page, 'window.__mofish?.renderer === "2d"');
    await waitFor(page, `(async()=>{
      const registration=await navigator.serviceWorker.ready;
      return Boolean(registration.active && navigator.serviceWorker.controller);
    })()`, { timeoutMs: 45000 });

    const baseCache = `mofish-static-${manifest.buildId}`;
    const beforeAttemptCache = await cacheSnapshot(page);
    const urlsBeforeAttempt = beforeAttemptCache.entries.filter(item => item.cache === baseCache).map(item => item.url);
    const lazyUrls = workerBuild.lazy.map(file => new URL(file, `${preview.url}/`).href);
    const aquariumContentBefore = await page.evaluate(`JSON.stringify({
      fish:window.__mofish.state.fish,
      decor:window.__mofish.state.decor
    })`);
    const aquariumSummary = JSON.parse(aquariumContentBefore);
    const aquariumContentHash = sha256(aquariumContentBefore);
    check('新装 2D 页面未加载或缓存任何 lazy 3D 资源',
      await page.evaluate('window.__mofish.renderer') === '2d'
        && lazyUrls.every(url => !urlsBeforeAttempt.includes(url)),
      `renderer=2d; lazy=${lazyUrls.length}; cache=${urlsBeforeAttempt.length}`);

    await page.setOffline(true);
    await waitFor(page, 'navigator.onLine === false');
    if (!(await page.evaluate('document.getElementById("more-settings")?.open'))) {
      await page.click('#more-button');
      await waitFor(page, 'document.getElementById("more-settings")?.open === true');
    }
    await page.evaluate(`window.__upgradeToggleClicks=0;
      document.getElementById('toggle-2d').addEventListener('click',()=>window.__upgradeToggleClicks++);`);
    const offlineAttemptEventIndex = page.events.length;
    const targetUrl = new URL(view3dAsset, `${preview.url}/`).href;
    const previewPort = preview.port;
    await preview.close();
    preview = null;
    await page.click('#toggle-2d');
    await waitFor(page, `window.__upgradeToggleClicks===1 && window.__mofish?.renderer==='2d'
      && document.getElementById('retry-3d')?.hidden===false
      && (document.getElementById('toast')?.textContent||'').includes('3D 资源暂时未能加载')`, { timeoutMs: 45000 });
    const failedImportRequest = page.events.slice(offlineAttemptEventIndex).find(event =>
      event.method === 'Network.loadingFailed' && page.events.some(request =>
        request.method === 'Network.requestWillBeSent'
        && request.params?.requestId === event.params?.requestId
        && request.params?.request?.url === targetUrl));
    check('离线加载未缓存的 lazy 3D 资源确实失败并回退到 2D',
      Boolean(failedImportRequest)
        && await page.evaluate(`navigator.onLine===false && window.__mofish.renderer==='2d'
          && document.getElementById('retry-3d')?.hidden===false
          && document.getElementById('toggle-2d')?.disabled===false`),
      JSON.stringify({ targetUrl, errorText: failedImportRequest?.params?.errorText || null,
        offline: true, previewStoppedDuringAttempt: true, renderer: '2d', retryVisible: true }));
    const aquariumContentAfterFailure = await page.evaluate(`JSON.stringify({
      fish:window.__mofish.state.fish,
      decor:window.__mofish.state.decor
    })`);
    check('首次 3D 加载失败并回退后鱼与造景数据不变',
      sha256(aquariumContentAfterFailure) === aquariumContentHash,
      `fish=${aquariumSummary.fish.length}; decor=${aquariumSummary.decor.length}; hash=${aquariumContentHash}`);
    const afterFailureCache = await cacheSnapshot(page);
    check('离线失败后 SW 仍未缓存 lazy 3D 模块',
      lazyUrls.every(url => !afterFailureCache.entries.some(entry => entry.cache === baseCache && entry.url === url)),
      `cached lazy=${lazyUrls.filter(url => afterFailureCache.entries.some(entry => entry.cache === baseCache && entry.url === url)).length}`);

    preview = await startPreviewServer({ dir: lazyRetryDir, port: previewPort, allowConnect: [fakeServer.url] });
    await page.setOffline(false);
    await waitFor(page, 'navigator.onLine === true');
    const retryEventIndex = page.events.length;
    await page.evaluate(`window.__upgradeRetryClicks=0;
      document.getElementById('retry-3d').addEventListener('click',()=>window.__upgradeRetryClicks++);`);
    const isSameModulePath = url => {
      try {
        const actual = new URL(url);
        const expected = new URL(targetUrl);
        return actual.origin === expected.origin && actual.pathname === expected.pathname;
      } catch { return false; }
    };
    const retryStartedAt = Date.now();
    await page.click('#retry-3d');
    let retryPageState = null;
    while (Date.now() - retryStartedAt < 60000) {
      retryPageState = await page.evaluate(`({renderer:window.__mofish?.renderer||null,
        retryClicks:window.__upgradeRetryClicks||0,
        retryHidden:document.getElementById('retry-3d')?.hidden,
        online:navigator.onLine})`);
      const hasNewModuleRequest = page.events.slice(retryEventIndex).some(event =>
        event.method === 'Network.requestWillBeSent' && isSameModulePath(event.params?.request?.url));
      if (retryPageState.renderer === '3d') break;
      if (retryPageState.retryClicks === 1 && !hasNewModuleRequest && Date.now() - retryStartedAt > 4000) break;
      await sleep(200);
    }
    const retryRequests = page.events.slice(retryEventIndex).filter(event =>
      event.method === 'Network.requestWillBeSent' && isSameModulePath(event.params?.request?.url));
    const retryResponse = page.events.slice(retryEventIndex).find(event =>
      event.method === 'Network.responseReceived'
        && isSameModulePath(event.params?.response?.url)
        && event.params?.response?.status === 200);
    check('恢复网络后真实点击了重试 3D 按钮',
      await page.evaluate('window.__upgradeRetryClicks===1'), 'retry click count=1');
    check('在线重试使用新的 lazy 模块 URL 重新发起请求',
      retryRequests.some(event => new URL(event.params.request.url).searchParams.has('retry')),
      JSON.stringify(retryRequests.map(event => event.params.request.url)));
    check('恢复网络后点击重试 3D 成功加载真实 lazy 模块',
      Boolean(retryResponse) && await page.evaluate(`window.__mofish.renderer==='3d'
        && document.getElementById('retry-3d')?.hidden===true`),
      JSON.stringify({ renderer: '3d', retryHidden: true, responseStatus: retryResponse?.params?.response?.status || null }));
    const aquariumContentAfterRetry = await page.evaluate(`JSON.stringify({
      fish:window.__mofish.state.fish,
      decor:window.__mofish.state.decor
    })`);
    check('3D 恢复后鱼与造景数据仍与重试前完全一致',
      sha256(aquariumContentAfterRetry) === aquariumContentHash,
      `fish=${aquariumSummary.fish.length}; decor=${aquariumSummary.decor.length}; hash=${aquariumContentHash}`);
    await waitFor(page, `(async()=>{
      const cache=await caches.open(${JSON.stringify(baseCache)});
      const urls=(await cache.keys()).map(request=>request.url);
      return ${JSON.stringify(workerBuild.lazy.map(file => new URL(file, `${preview.url}/`).href))}.every(url=>urls.includes(url));
    })()`, { timeoutMs: 45000 });
    const afterRetryCache = await cacheSnapshot(page);
    check('重试成功后全部 lazy 3D 资源进入版本缓存',
      lazyUrls.every(url => afterRetryCache.entries.some(entry => entry.cache === baseCache && entry.url === url)),
      `cached lazy=${lazyUrls.filter(url => afterRetryCache.entries.some(entry => entry.cache === baseCache && entry.url === url)).length}/${lazyUrls.length}`);

    report.status = 'passed';
  } catch (error) {
    failure = error;
    report.status = 'failed';
    report.error = error.stack || error.message;
    report.browserDiagnostics = await Promise.all(pages.map(async (page, index) => ({
      tab: index,
      state: await page.evaluate(`({url:location.href,renderer:window.__mofish?.renderer||null,
        online:navigator.onLine,retryHidden:document.getElementById('retry-3d')?.hidden,
        toggleDisabled:document.getElementById('toggle-2d')?.disabled,
        toast:document.getElementById('toast')?.textContent||''})`)
        .catch(diagnosticError => ({ evaluateError: diagnosticError.message })),
      network: page.events.filter(event => ['Network.requestWillBeSent','Network.responseReceived','Network.loadingFailed'].includes(event.method))
        .map(event => ({method:event.method,url:event.params?.request?.url||event.params?.response?.url||null,
          status:event.params?.response?.status||null,errorText:event.params?.errorText||null}))
        .filter(event => event.url?.includes('view3d'))
    })));
  } finally {
    for (const page of pages) page.close();
    await shutdownChrome(browserRun);
    if (preview) await preview.close();
    if (fakeServer) await fakeServer.close();
    if (profileDir) rmSync(profileDir, { recursive: true, force: true });
    report.checks = checks.slice(startCheckIndex);
    report.checkCount = report.checks.length;
    report.finishedAt = new Date().toISOString();
    report.cleanup = {
      profileRemoved: Boolean(profileDir), previewStopped: Boolean(preview),
      fakeSupabaseStopped: Boolean(fakeServer), lazyRetryDistRetained: existsSync(lazyRetryDir)
    };
    mkdirSync(taskDir, { recursive: true });
    writeFileSync(resultPath, `${JSON.stringify(report, null, 2)}\n`);
  }
  if (failure) throw new Error(`lazy 3D retry 场景失败，详见 ${resultPath}: ${failure.message}`);
  console.log(`lazy 3D retry 场景通过 ${report.checkCount} 项；结果：${resultPath}`);
  return report;
}

async function runLegacyMigration(sourceDir, chromeArg) {
  const baselineDir = path.join(taskDir, 'baseline-dist');
  const legacyDir = path.join(taskDir, 'upgrade-legacy-dist');
  if (!existsSync(path.join(baselineDir, 'index.html')) || !existsSync(path.join(baselineDir, 'sw.js'))) {
    return { status: 'skipped', reason: `冻结 V3 baseline 不存在：${baselineDir}` };
  }

  const legacyWorkerText = readFileSync(path.join(baselineDir, 'sw.js'), 'utf8');
  if (!legacyWorkerText.includes("const CACHE = 'mofish-static-v3'")) {
    throw new Error(`baseline-dist 不是预期的 V3 worker：${baselineDir}`);
  }
  rmSync(legacyDir, { recursive: true, force: true });
  cpSync(baselineDir, legacyDir, { recursive: true, force: true });

  const fake = createFakeSupabase();
  let fakeServer = null;
  let preview = null;
  let browserRun = null;
  let profileDir = null;
  const pages = [];
  const startCheckIndex = checks.length;
  const summary = {
    status: 'running', baselineDir, legacyDir, sourceDir,
    startedAt: new Date().toISOString()
  };

  try {
    fakeServer = await startFakeServer(fake);
    const anonKey = makeAccessToken('anon', { role: 'anon' });
    writeFileSync(path.join(legacyDir, 'config.js'),
      `// task-local fake Supabase config
globalThis.__MOFISH_CONFIG__ = ${JSON.stringify({ supabaseUrl: fakeServer.url, supabaseAnonKey: anonKey })};
`);
    preview = await startPreviewServer({ dir: legacyDir, port: 0, allowConnect: [fakeServer.url] });
    profileDir = mkdtempSync(path.join(taskDir, 'chrome-profile-legacy-'));
    browserRun = await launchChrome(chooseChrome(chromeArg), profileDir);
    const page = await openTab(browserRun.browser, browserRun.debugPort);
    pages.push(page);
    await activatePage(browserRun.browser, page);
    await primeTabPreferences(page, preview, legacyDir, { renderer: '2d', quality: 'low' });
    await page.goto(`${preview.url}/`);
    await waitFor(page, 'window.__mofish?.renderer === "2d"');
    await waitFor(page, `(async()=>{
      const registration=await navigator.serviceWorker.ready;
      return Boolean(registration.active && navigator.serviceWorker.controller);
    })()`, { timeoutMs: 45000 });

    const beforeMigrationCache = await cacheSnapshot(page);
    check('legacy v3 baseline 首装真实 v3 cache', beforeMigrationCache.names.includes('mofish-static-v3'), beforeMigrationCache.names.join(', '));
    await page.setOffline(true);
    await waitFor(page, 'navigator.onLine === false');
    await page.reload();
    const offlineLegacy = await page.evaluate(`({app:Boolean(window.__mofish),renderer:window.__mofish?.renderer,
      controller:Boolean(navigator.serviceWorker.controller)})`);
    check('legacy v3 页面可离线重载', offlineLegacy.app && offlineLegacy.renderer === '2d' && offlineLegacy.controller, JSON.stringify(offlineLegacy));
    await page.setOffline(false);
    await waitFor(page, 'navigator.onLine === true');

    rmSync(legacyDir, { recursive: true, force: true });
    cpSync(sourceDir, legacyDir, { recursive: true, force: true });
    const v02Manifest = JSON.parse(readFileSync(path.join(legacyDir, 'asset-manifest.json'), 'utf8'));
    const v02WorkerText = readFileSync(path.join(legacyDir, 'sw.js'), 'utf8');
    const { manifest, workerText } = installFakeConfig(
      legacyDir, v02Manifest, v02WorkerText, fakeServer.url, anonKey, 'legacy-migration'
    );
    const expectedWorkerBuild = readBuildFromWorker(workerText).manifest;
    summary.v02BuildId = manifest.buildId;
    console.log(`legacy migration: v3 -> V${manifest.version}/${manifest.buildId}`);

    await page.evaluate(`(async()=>{
      const registration=await navigator.serviceWorker.getRegistration();
      await registration.update();
      return true;
    })()`);
    await waitFor(page, `(async()=>{
      const registration=await navigator.serviceWorker.getRegistration();
      return Boolean(registration?.waiting);
    })()`, { timeoutMs: 60000 });
    const waitingCache = await cacheSnapshot(page);
    check('legacy v3 活跃时已完整安装 V0.2 waiting shell',
      waitingCache.names.includes(`mofish-static-${manifest.buildId}`)
        && expectedWorkerBuild.shell.every(file => waitingCache.entries.some(entry =>
          entry.cache === `mofish-static-${manifest.buildId}` && entry.url === new URL(file, preview.url + '/').href)),
      waitingCache.names.join(', '));

    await page.reload();
    await waitFor(page, 'window.__mofish?.appVersion === "0.2.0"', { timeoutMs: 60000 });
    await waitFor(page, 'document.getElementById("update-banner")?.hidden === false', { timeoutMs: 60000 });
    const preActivation = await page.evaluate(`({waiting:Boolean(navigator.serviceWorker.controller),
      bannerHidden:document.getElementById('update-banner')?.hidden,
      offlineStatus:document.getElementById('offline-status')?.textContent})`);
    check('从 v3 在线过渡到 V0.2 后显示待更新提示', preActivation.bannerHidden === false, JSON.stringify(preActivation));
    check('旧 v3 worker 未确认 V0.2 离线就绪前保持核对提示',
      /正在核对|另一构建/.test(preActivation.offlineStatus || ''), preActivation.offlineStatus || '');

    await page.click('#update-button');
    await waitFor(page, 'window.__mofish?.appVersion === "0.2.0" && navigator.serviceWorker.controller', { timeoutMs: 60000 });
    await waitFor(page, `document.getElementById('offline-status')?.textContent.includes('当前版本的离线 2D 资源已就绪')`, { timeoutMs: 45000 });
    check('接受 V0.2 更新后当前 worker 确认 shell 就绪',
      await currentWorkerBuildId(page) === manifest.buildId, manifest.buildId);

    await page.setOffline(true);
    await waitFor(page, 'navigator.onLine === false');
    await page.reload();
    await waitFor(page, 'window.__mofish?.appVersion === "0.2.0" && window.__mofish?.renderer === "2d"', { timeoutMs: 60000 });
    await waitFor(page, `document.getElementById('offline-status')?.textContent.includes('当前版本的离线 2D 资源已就绪')`, { timeoutMs: 45000 });
    check('legacy v3 -> V0.2 更新后的页面可离线重载', true);

    summary.status = 'passed';
    summary.checks = checks.slice(startCheckIndex);
    summary.finishedAt = new Date().toISOString();
    return summary;
  } catch (error) {
    summary.status = 'failed';
    summary.checks = checks.slice(startCheckIndex);
    summary.finishedAt = new Date().toISOString();
    summary.error = error.stack || error.message;
    summary.browserDiagnostics = await Promise.all(pages.map(async (page, index) => ({
      tab: index,
      state: await page.evaluate(`({url:location.href,readyState:document.readyState,title:document.title,
        text:(document.body?.innerText||'').slice(0,1200),app:Boolean(window.__mofish),
        appVersion:window.__mofish?.appVersion||null,renderer:window.__mofish?.renderer||null,
        controller:Boolean(navigator.serviceWorker?.controller)})`).catch(diagnosticError => ({ evaluateError: diagnosticError.message }))
    })));
    console.error(`legacy migration failure: ${JSON.stringify(summary.browserDiagnostics)}`);
    throw error;
  } finally {
    for (const page of pages) page.close();
    await shutdownChrome(browserRun);
    if (preview) await preview.close();
    if (fakeServer) await fakeServer.close();
    if (profileDir) rmSync(profileDir, { recursive: true, force: true });
    summary.cleanup = {
      profileRemoved: Boolean(profileDir), previewStopped: Boolean(preview),
      fakeSupabaseStopped: Boolean(fakeServer), legacyDistRetained: existsSync(legacyDir)
    };
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { printHelp(); return; }

  const sourceDir = path.resolve(repo, args.dir);
  const inputManifestPath = path.join(sourceDir, 'asset-manifest.json');
  const inputSwPath = path.join(sourceDir, 'sw.js');
  if (!existsSync(path.join(sourceDir, 'index.html'))
      || !existsSync(inputManifestPath)
      || !existsSync(inputSwPath)) {
    throw new Error(`--dir 必须指向已有静态构建（需要 index.html、asset-manifest.json 和 sw.js）：${sourceDir}`);
  }
  if (sourceDir === upgradeDir || sourceDir.startsWith(`${upgradeDir}${path.sep}`)) {
    throw new Error('--dir 不能指向任务副本本身，避免将伪版本再次作为基线。');
  }

  mkdirSync(taskDir, { recursive: true });
  if (args.lazyRetryOnly) {
    if (sourceDir === path.join(taskDir, 'upgrade-lazy-retry-dist')
        || sourceDir.startsWith(`${path.join(taskDir, 'upgrade-lazy-retry-dist')}${path.sep}`)) {
      throw new Error('--dir 不能指向 lazy-retry 任务副本本身。');
    }
    await runLazyRetryOnly(sourceDir, args.chrome);
    return;
  }
  rmSync(upgradeDir, { recursive: true, force: true });
  cpSync(sourceDir, upgradeDir, { recursive: true, force: true });
  const inputManifest = JSON.parse(readFileSync(path.join(upgradeDir, 'asset-manifest.json'), 'utf8'));
  if (!String(inputManifest.version || '').startsWith('0.2.')) {
    throw new Error(`输入构建不是 V0.2：${inputManifest.version || '缺少版本号'}`);
  }
  const inputWorkerText = readFileSync(path.join(upgradeDir, 'sw.js'), 'utf8');
  const inputWorkerBuild = readBuildFromWorker(inputWorkerText).manifest;
  if (inputManifest.buildId !== inputWorkerBuild.buildId) throw new Error('asset-manifest.json 与 sw.js 的 buildId 不一致。');

  const fake = createFakeSupabase();
  let fakeServer = null;
  let preview = null;
  let browserRun = null;
  const pages = [];
  let profileDir = null;
  const report = {
    schema: 'mofish-version-upgrade-e2e-v1',
    status: 'running',
    sourceDir,
    upgradeDir,
    version: inputManifest.version,
    baseBuildId: inputManifest.buildId,
    startedAt: new Date().toISOString(),
    checks
  };

  try {
    fakeServer = await startFakeServer(fake);
    const anonKey = makeAccessToken('anon', { role: 'anon' });
    const { manifest, workerText: baseWorkerText } = installFakeConfig(
      upgradeDir, inputManifest, inputWorkerText, fakeServer.url, anonKey, 'fake-supabase'
    );
    report.baseBuildId = manifest.buildId;
    const workerBuild = readBuildFromWorker(baseWorkerText).manifest;
    preview = await startPreviewServer({ dir: upgradeDir, port: 0, allowConnect: [fakeServer.url] });
    const lazyAssetChecks = await Promise.all(workerBuild.lazy.map(async file => {
      const response = await fetch(new URL(file, `${preview.url}/`));
      const bytes = Buffer.from(await response.arrayBuffer());
      return { file, status: response.status, bytes: bytes.length,
        hashMatches: sha256(bytes) === workerBuild.hashes[file] };
    }));
    check('同构建清单中的延迟 3D 模块可由预览服务器按 hash 提供',
      lazyAssetChecks.every(item => item.status === 200 && item.hashMatches), JSON.stringify(lazyAssetChecks));

    const chromePath = chooseChrome(args.chrome);
    profileDir = mkdtempSync(path.join(taskDir, 'chrome-profile-'));
    browserRun = await launchChrome(chromePath, profileDir);
    console.log(`输入构建 ${manifest.version}/${manifest.buildId} · 任务副本 ${upgradeDir}`);
    console.log(`本地预览 ${preview.url} · 隔离 Chrome PID ${browserRun.child.pid} · profile ${profileDir}`);

    const tabA = await openTab(browserRun.browser, browserRun.debugPort);
    const tabB = await openTab(browserRun.browser, browserRun.debugPort);
    pages.push(tabA, tabB);
    await activatePage(browserRun.browser, tabA);
    await primeTabPreferences(tabA, preview, upgradeDir, { renderer: '2d', quality: 'low' });
    await tabA.goto(`${preview.url}/`);
    await waitFor(tabA, 'window.__mofish?.renderer === "2d"');
    await activatePage(browserRun.browser, tabB);
    await tabB.goto(`${preview.url}/`);
    await waitFor(tabB, 'window.__mofish?.renderer === "2d"');
    await activatePage(browserRun.browser, tabA);
    await waitFor(tabA, `(async()=>{
      const registration=await navigator.serviceWorker.ready;
      return Boolean(registration.active && navigator.serviceWorker.controller);
    })()`, { timeoutMs: 45000 });
    await waitFor(tabB, 'Boolean(navigator.serviceWorker.controller)', { timeoutMs: 45000 });

    const installed = await cacheSnapshot(tabA);
    const baseCache = `mofish-static-${manifest.buildId}`;
    check('V0.2 首装创建与清单匹配的真实 CacheStorage',
      installed.names.includes(baseCache), installed.names.join(', '));
    const initialCacheUrls = installed.entries.filter(item => item.cache === baseCache).map(item => item.url);
    check('首次 2D 启动缓存 shell、未预取延迟 3D 资源',
      manifest.shell.every(file => initialCacheUrls.includes(new URL(file, preview.url + '/').href))
        && manifest.lazy.every(file => !initialCacheUrls.includes(new URL(file, preview.url + '/').href)));

    await tabA.setOffline(true);
    await waitFor(tabA, 'navigator.onLine === false');
    await tabA.reload();
    await waitFor(tabA, `document.getElementById('offline-status')?.textContent.includes('离线 2D 资源已就绪')`, { timeoutMs: 45000 });
    const offline2d = await tabA.evaluate(`({
      renderer:window.__mofish?.renderer,
      controller:Boolean(navigator.serviceWorker.controller),
      offlineStatus:document.getElementById('offline-status')?.textContent
    })`);
    check('初装后的 2D 页面断网重载成功',
      offline2d.renderer === '2d' && offline2d.controller && /离线 2D 资源已就绪/.test(offline2d.offlineStatus || ''),
      JSON.stringify(offline2d));
    await tabA.setOffline(false);
    await waitFor(tabA, 'navigator.onLine === true');

    if (!(await tabA.evaluate('document.getElementById("more-settings")?.open'))) {
      await tabA.click('#more-button');
      await waitFor(tabA, 'document.getElementById("more-settings")?.open === true');
    }
    await tabA.evaluate(`window.__upgradeToggleClickAt=0;window.__upgradeToggleClicks=0;
      document.getElementById('toggle-2d').addEventListener('click',()=>{
        window.__upgradeToggleClickAt=Date.now();window.__upgradeToggleClicks+=1;
      },{once:true})`);
    await tabA.click('#toggle-2d');
    await waitFor(tabA, `window.__mofish?.renderer === "3d"
      || (window.__upgradeToggleClicks===1 && Date.now()-window.__upgradeToggleClickAt>=5000
        && document.getElementById('toggle-2d')?.disabled===false)`, { timeoutMs: 45000 });
    const rendererAttempt = await tabA.evaluate(`({renderer:window.__mofish?.renderer,
      toggleClicks:window.__upgradeToggleClicks,toggleDisabled:document.getElementById('toggle-2d')?.disabled,
      retryVisible:document.getElementById('retry-3d')?.hidden===false,
      toast:document.getElementById('toast')?.textContent||'',
      stageStatus:document.getElementById('stage-status')?.textContent||'',
      resources:performance.getEntriesByType('resource')
        .filter(entry=>entry.name.includes('view3d')).map(entry=>({name:entry.name,duration:entry.duration,transferSize:entry.transferSize}))})`);
    const rendererRequests = tabA.events
      .filter(event => ['Network.requestWillBeSent', 'Network.responseReceived', 'Network.loadingFailed'].includes(event.method)
        && String(event.params?.request?.url || event.params?.response?.url || '').includes('view3d'))
      .map(event => ({method:event.method,url:event.params?.request?.url||event.params?.response?.url,
        status:event.params?.response?.status||null,errorText:event.params?.errorText||null}));
    check('首次切换 3D 动态模块并创建 renderer', rendererAttempt.renderer === '3d',
      JSON.stringify({ ...rendererAttempt, requests: rendererRequests }));
    await waitFor(tabA, `(async()=>{
      const build=await (await fetch('./asset-manifest.json',{cache:'no-store'})).json();
      const cache=await caches.open('mofish-static-'+build.buildId);
      const urls=(await cache.keys()).map(request=>request.url);
      return build.lazy.every(file=>urls.includes(new URL(file,location.href).href));
    })()`, { timeoutMs: 60000 });
    const cachedAfter3d = await cacheSnapshot(tabA);
    const lazyUrls = manifest.lazy.map(file => new URL(file, preview.url + '/').href);
    const cachedLazyCount = lazyUrls.filter(url => cachedAfter3d.entries.some(entry => entry.cache === baseCache && entry.url === url)).length;
    check('首次进入 3D 后延迟资源进入版本缓存', cachedLazyCount === lazyUrls.length, `${cachedLazyCount}/${lazyUrls.length}`);

    await tabA.setOffline(true);
    await waitFor(tabA, 'navigator.onLine === false');
    await tabA.reload();
    await waitFor(tabA, 'window.__mofish?.renderer === "3d"', { timeoutMs: 60000 });
    const offline3d = await tabA.evaluate(`({
      renderer:window.__mofish?.renderer,
      controller:Boolean(navigator.serviceWorker.controller),
      app:Boolean(window.__mofish)
    })`);
    check('使用过的 3D 资源可断网重开',
      offline3d.renderer === '3d' && offline3d.controller && offline3d.app,
      JSON.stringify(offline3d));
    await tabA.setOffline(false);
    await waitFor(tabA, 'navigator.onLine === true');

    const user = await createTestAccount(fakeServer, fake, tabA);
    const remoteRow = fake.aquariums.get(user.id);
    if (!remoteRow) throw new Error('假账号登录后未在本地假 Supabase 创建鱼缸。');
    const originalFishName = remoteRow.state.fish[0]?.name;
    const beforeApiAudit = await cacheSnapshot(tabA);
    const cachedApiEntries = beforeApiAudit.entries.filter(({ url }) => {
      const parsed = new URL(url);
      return /\/(auth|rest|rpc)(\/|$)/.test(parsed.pathname);
    });
    const fakeApiPaths = fakeServer.requests.map(request => request.path);
    check('跨源 Auth/RPC 实际请求未进入 CacheStorage',
      cachedApiEntries.length === 0
        && fakeApiPaths.some(value => value.startsWith('/auth/v1/token'))
        && fakeApiPaths.some(value => value.startsWith('/rest/v1/rpc/')),
      `缓存 API 项 ${cachedApiEntries.length}；假后端 Auth/RPC 请求均已观察`);
    check('CacheStorage 中所有资源仍为应用同源',
      beforeApiAudit.entries.every(({ url }) => new URL(url).origin === preview.url));

    const originalTimeOriginA = await tabA.evaluate('performance.timeOrigin');
    const oldCacheName = baseCache;
    const updateBuildId = syntheticBuildId(manifest.buildId, 'same-v02-resources-update');
    const nextManifest = { ...workerBuild, buildId: updateBuildId };
    check('正常伪版本只改变 buildId、shell/lazy/hash 完全不变',
      JSON.stringify(nextManifest.shell) === JSON.stringify(workerBuild.shell)
        && JSON.stringify(nextManifest.lazy) === JSON.stringify(workerBuild.lazy)
        && JSON.stringify(nextManifest.hashes) === JSON.stringify(workerBuild.hashes));
    writeFileSync(path.join(upgradeDir, 'sw.js'), writeWorkerBuild(baseWorkerText, nextManifest));

    await tabA.evaluate(`(async()=>{
      const registration=await navigator.serviceWorker.getRegistration();
      await registration.update();
      return true;
    })()`);
    await waitFor(tabA, `(async()=>{
      const registration=await navigator.serviceWorker.getRegistration();
      return Boolean(registration?.waiting && document.getElementById('update-banner')?.hidden===false);
    })()`, { timeoutMs: 60000 });
    check('新 SW 已进入 waiting 且更新横幅可见', true, `waiting build ${updateBuildId}`);
    const timeOriginBeforeDecision = await tabA.evaluate('performance.timeOrigin');
    await sleep(1800);
    const waitingState = await tabA.evaluate(`(async()=>{
      const registration=await navigator.serviceWorker.getRegistration();
      return {waiting:Boolean(registration?.waiting),bannerHidden:document.getElementById('update-banner')?.hidden,
        sameDocument:performance.timeOrigin===${JSON.stringify(timeOriginBeforeDecision)}};
    })()`);
    check('waiting 更新不自动激活或刷新旧页面',
      waitingState.waiting && waitingState.bannerHidden === false && waitingState.sameDocument,
      JSON.stringify(waitingState));

    const decorCountBeforePending = await tabA.evaluate('window.__mofish.state.decor.length');
    const remoteDecorCountBeforePending = remoteRow.state.decor.length;
    await tabA.click('#add-rock');
    await waitFor(tabA, `window.__mofish?.state.decor.length===${decorCountBeforePending + 1}
      && document.getElementById('float-cancel')?.hidden===false`);
    const pendingDecor = await tabA.evaluate(`({
      id:window.__mofish.state.decor.at(-1)?.id,
      count:window.__mofish.state.decor.length,
      state:document.getElementById('decor-state')?.textContent,
      cancelVisible:document.getElementById('float-cancel')?.hidden===false
    })`);
    check('3D 新增物件处于未确认状态时保留在鱼缸',
      pendingDecor.id && pendingDecor.count === decorCountBeforePending + 1
        && pendingDecor.state === '待确认' && pendingDecor.cancelVisible,
      JSON.stringify(pendingDecor));
    await tabA.evaluate(`(()=>{
      const original=ServiceWorker.prototype.postMessage;
      window.__upgradeUseUpdateMessages=[];
      ServiceWorker.prototype.postMessage=function(message,...args){
        if(message?.type==='MOFISH_USE_UPDATE')window.__upgradeUseUpdateMessages.push(message.type);
        return original.call(this,message,...args);
      };
    })()`);
    await tabA.click('#update-button');
    await waitFor(tabA, `document.getElementById('toast')?.textContent.includes('请先确认或取消当前造景')`);
    const pendingUpdateState = await tabA.evaluate(`(async()=>{
      const registration=await navigator.serviceWorker.getRegistration();
      return {count:window.__mofish?.state.decor.length,
        hasPending:window.__mofish?.state.decor.some(item=>item.id===${JSON.stringify(pendingDecor.id)}),
        waiting:Boolean(registration?.waiting),sameDocument:performance.timeOrigin===${JSON.stringify(timeOriginBeforeDecision)},
        inert:document.body.inert,buttonDisabled:document.getElementById('update-button')?.disabled,
        useUpdateMessages:window.__upgradeUseUpdateMessages?.length||0,
        toast:document.getElementById('toast')?.textContent||''};
    })()`);
    check('未确认的 3D 物件阻止更新并继续保留 waiting worker',
      pendingUpdateState.hasPending && pendingUpdateState.waiting && pendingUpdateState.sameDocument
        && pendingUpdateState.inert === false && pendingUpdateState.buttonDisabled === false,
      JSON.stringify(pendingUpdateState));
    check('未确认物件拦截路径没有发送 MOFISH_USE_UPDATE',
      pendingUpdateState.useUpdateMessages === 0, `messages=${pendingUpdateState.useUpdateMessages}`);
    check('未确认物件没有写入假服务端',
      remoteRow.state.decor.length === remoteDecorCountBeforePending
        && !remoteRow.state.decor.some(item => item.id === pendingDecor.id),
      `server decor count=${remoteRow.state.decor.length}`);

    const savesBeforeFlushGate = fakeServer.requests.filter(request => request.path.startsWith('/rest/v1/rpc/save_aquarium')).length;
    await tabA.send('Fetch.enable', { patterns: [
      { urlPattern: `${fakeServer.url}/rest/v1/rpc/save_aquarium*`, requestStage: 'Request' }
    ] });
    await tabA.click('#float-confirm');
    await waitFor(tabA, `window.__mofish?.state.decor.some(item=>item.id===${JSON.stringify(pendingDecor.id)})
      && document.getElementById('float-cancel')?.hidden===true`);
    const confirmedDecorCount = await tabA.evaluate('window.__mofish.state.decor.length');
    await tabA.click('#update-button');
    await waitFor(tabA, 'document.body.inert===true && document.getElementById("update-button")?.disabled===true');
    const countWhileFlushWaits = await tabA.evaluate('window.__mofish.state.decor.length');
    await tabA.click('#add-plant', { ignoreHit: true });
    const afterInertClickCount = await tabA.evaluate('window.__mofish.state.decor.length');
    check('同步等待期间 body.inert 锁定新增物件交互',
      afterInertClickCount === countWhileFlushWaits && afterInertClickCount === confirmedDecorCount,
      `before=${countWhileFlushWaits}; after=${afterInertClickCount}`);
    const pausedSave = await waitForPausedFetchRequest(tabA, {
      urlPrefix: `${fakeServer.url}/rest/v1/rpc/save_aquarium`, fromIndex: 0
    });
    const pausedPath = new URL(pausedSave.params.request.url).pathname;
    await tabA.send('Fetch.failRequest', { requestId: pausedSave.params.requestId, errorReason: 'Failed' });
    await tabA.send('Fetch.disable');
    await waitFor(tabA, `document.body.inert===false && document.getElementById('update-button')?.disabled===false
      && !document.getElementById('update-banner')?.hasAttribute('aria-busy')`);
    const failedFlushState = await tabA.evaluate(`(async()=>{
      const registration=await navigator.serviceWorker.getRegistration();
      return {count:window.__mofish?.state.decor.length,
        hasConfirmedDecor:window.__mofish?.state.decor.some(item=>item.id===${JSON.stringify(pendingDecor.id)}),
        waiting:Boolean(registration?.waiting),sameDocument:performance.timeOrigin===${JSON.stringify(timeOriginBeforeDecision)},
        inert:document.body.inert,buttonDisabled:document.getElementById('update-button')?.disabled,
        ariaBusy:document.getElementById('update-banner')?.hasAttribute('aria-busy'),
        useUpdateMessages:window.__upgradeUseUpdateMessages?.length||0,
        toast:document.getElementById('toast')?.textContent||''};
    })()`);
    check('云端 flush 失败后恢复页面交互且保留已确认物件',
      failedFlushState.hasConfirmedDecor && failedFlushState.count === confirmedDecorCount
        && failedFlushState.waiting && failedFlushState.sameDocument && failedFlushState.inert === false
        && failedFlushState.buttonDisabled === false && failedFlushState.ariaBusy === false,
      JSON.stringify(failedFlushState));
    check('flush 失败的更新请求没有激活 waiting worker',
      failedFlushState.useUpdateMessages === 0, `messages=${failedFlushState.useUpdateMessages}; path=${pausedPath}`);
    check('拦截的 flush 请求未到达假服务端且云端造景未变化',
      fakeServer.requests.filter(request => request.path.startsWith('/rest/v1/rpc/save_aquarium')).length === savesBeforeFlushGate
        && remoteRow.state.decor.length === remoteDecorCountBeforePending,
      `save requests=${fakeServer.requests.filter(request => request.path.startsWith('/rest/v1/rpc/save_aquarium')).length - savesBeforeFlushGate}; server decor count=${remoteRow.state.decor.length}`);
    await tabA.click('#add-plant');
    await waitFor(tabA, `window.__mofish?.state.decor.length===${confirmedDecorCount + 1}
      && document.getElementById('float-cancel')?.hidden===false`);
    await tabA.click('#float-cancel');
    await waitFor(tabA, `window.__mofish?.state.decor.length===${confirmedDecorCount}`);
    check('flush 失败后恢复的 UI 可继续编辑并撤销临时造景',
      await tabA.evaluate(`window.__mofish.state.decor.some(item=>item.id===${JSON.stringify(pendingDecor.id)})
        && document.body.inert===false`), `decor count=${confirmedDecorCount}`);
    await tabA.setOffline(true);
    await waitFor(tabA, 'navigator.onLine === false');

    await tabA.setOffline(true);
    await waitFor(tabA, 'navigator.onLine === false');
    const offlineAtB = await tabB.evaluate('navigator.onLine');
    check('第二个同源标签仍可联网用于独立更新选择', offlineAtB === true, `tab B online=${offlineAtB}`);
    await tabA.click('.fish-card');
    await tabA.click('#detail-rename');
    await waitFor(tabA, 'document.getElementById("fish-dialog")?.open === true');
    const editedName = `离线保留-${randomUUID().slice(0, 5)}`;
    await tabA.type('#fish-name', editedName);
    await tabA.click('#rename');
    await waitFor(tabA, `window.__mofish?.state.fish.some(f=>f.name===${JSON.stringify(editedName)})`);
    const pendingStorage = await tabA.evaluate(`(()=>{
      const uid=${JSON.stringify(user.id)};
      const current=JSON.parse(localStorage.getItem('mofish.current.'+uid)||'null');
      const key=current?.aquariumId?'mofish.pending.'+uid+'.'+current.aquariumId:null;
      const pending=key?JSON.parse(localStorage.getItem(key)||'null'):null;
      return {key,pendingName:pending?.state?.fish?.find(f=>f.name===${JSON.stringify(editedName)})?.name||null};
    })()`);
    check('离线修改已落到账号待同步副本', pendingStorage.pendingName === editedName, pendingStorage.key || 'pending key missing');

    await tabA.click('#update-button');
    await waitFor(tabA,
      `document.getElementById('toast')?.textContent.includes('还有未同步改动')`,
      { timeoutMs: 30000 });
    const afterBlockedUpdate = await tabA.evaluate(`({
      sameDocument:performance.timeOrigin===${JSON.stringify(originalTimeOriginA)},
      edited:window.__mofish?.state.fish.some(f=>f.name===${JSON.stringify(editedName)}),
      bannerHidden:document.getElementById('update-banner')?.hidden,
      toast:document.getElementById('toast')?.textContent
    })`);
    check('离线未同步改动阻止 update-button 重载且本机状态保留',
      afterBlockedUpdate.sameDocument && afterBlockedUpdate.edited && afterBlockedUpdate.bannerHidden === false,
      afterBlockedUpdate.toast || JSON.stringify(afterBlockedUpdate));
    check('离线改动尚未误写到假服务端',
      remoteRow.state.fish[0]?.name === originalFishName,
      `server=${remoteRow.state.fish[0]?.name}; local=${editedName}`);

    const tabBUpdateState = await tabB.evaluate(`(async()=>{
      const registration=await navigator.serviceWorker.getRegistration();
      return {waiting:Boolean(registration?.waiting),bannerHidden:document.getElementById('update-banner')?.hidden};
    })()`);
    check('同一 browserContext 第二个标签持有 waiting 更新', tabBUpdateState.waiting, JSON.stringify(tabBUpdateState));
    const originalTimeOriginB = await tabB.evaluate('performance.timeOrigin');
    await tabB.click('#update-button', { allowHidden: true });
    await waitFor(tabB, 'Boolean(window.__mofish) && performance.timeOrigin !== ' + JSON.stringify(originalTimeOriginB), { timeoutMs: 60000 });
    await waitFor(tabB, `navigator.serviceWorker.controller && (async()=>{
      const response=await fetch('./asset-manifest.json',{cache:'no-store'});
      return (await response.json()).buildId===${JSON.stringify(updateBuildId)};
    })()`, { timeoutMs: 45000 });

    const afterActivationA = await tabA.evaluate(`({
      sameDocument:performance.timeOrigin===${JSON.stringify(originalTimeOriginA)},
      edited:window.__mofish?.state.fish.some(f=>f.name===${JSON.stringify(editedName)}),
      controller:Boolean(navigator.serviceWorker.controller)
    })`);
    const afterActivationCache = await cacheSnapshot(tabA);
    check('新版本激活后旧 tab 保持原文档并继续可用',
      afterActivationA.sameDocument && afterActivationA.edited && afterActivationA.controller,
      JSON.stringify(afterActivationA));
    check('新版本激活没有清理仍被旧 tab 使用的旧缓存',
      afterActivationCache.names.includes(oldCacheName)
        && afterActivationCache.names.includes(`mofish-static-${updateBuildId}`),
      afterActivationCache.names.join(', '));
    check('伪版本激活后同源 Web Worker 报告的新 buildId 生效',
      await currentWorkerBuildId(tabB) === updateBuildId, updateBuildId);

    const brokenBuildId = syntheticBuildId(updateBuildId, 'missing-shell-asset');
    const brokenManifest = { ...nextManifest, buildId: brokenBuildId };
    const missingFile = '__upgrade-test__/missing-shell-asset.js';
    brokenManifest.shell = [...brokenManifest.shell, missingFile];
    brokenManifest.hashes = {
      ...brokenManifest.hashes,
      [missingFile]: createHash('sha256').update('intentionally absent shell resource').digest('hex')
    };
    writeFileSync(path.join(upgradeDir, 'sw.js'), writeWorkerBuild(readFileSync(path.join(upgradeDir, 'sw.js'), 'utf8'), brokenManifest));
    const timeOriginBeforeBroken = await tabB.evaluate('performance.timeOrigin');
    await tabB.evaluate(`(async()=>{
      const registration=await navigator.serviceWorker.getRegistration();
      try{await registration.update();}catch{}
      return true;
    })()`);
    await waitForWorkerInstallFinish(tabB);
    const afterBrokenCache = await cacheSnapshot(tabB);
    const brokenOutcome = await tabB.evaluate(`(async()=>{
      const registration=await navigator.serviceWorker.getRegistration();
      return {
        activeBuild:(await (await fetch('./asset-manifest.json',{cache:'no-store'})).json()).buildId,
        installing:registration?.installing?.state||null,
        waiting:Boolean(registration?.waiting),
        sameDocument:performance.timeOrigin===${JSON.stringify(timeOriginBeforeBroken)},
        app:Boolean(window.__mofish)
      };
    })()`);
    check('缺失 shell 资源使新 worker install 失败并删除半成品缓存',
      !afterBrokenCache.names.includes(`mofish-static-${brokenBuildId}`)
        && brokenOutcome.activeBuild === updateBuildId
        && !brokenOutcome.waiting,
      `${JSON.stringify(brokenOutcome)}; caches=${afterBrokenCache.names.join(',')}`);
    check('install 失败保留已工作缓存和打开页面',
      afterBrokenCache.names.includes(oldCacheName)
        && afterBrokenCache.names.includes(`mofish-static-${updateBuildId}`)
        && brokenOutcome.sameDocument && brokenOutcome.app,
      JSON.stringify(brokenOutcome));
    check('旧 tab 在损坏更新尝试后仍保留原 runtime 与离线改动',
      (await tabA.evaluate(`performance.timeOrigin===${JSON.stringify(originalTimeOriginA)}
        && window.__mofish?.state.fish.some(f=>f.name===${JSON.stringify(editedName)})`)) === true);

    const finalSnapshot = await cacheSnapshot(tabB);
    const finalCachedApis = finalSnapshot.entries.filter(({ url }) => /\/(auth|rest|rpc)(\/|$)/.test(new URL(url).pathname));
    check('结束时 CacheStorage 仍无 auth/RPC 路径', finalCachedApis.length === 0, `entries=${finalCachedApis.length}`);

    report.status = 'passed';
    report.finishedAt = new Date().toISOString();
    report.syntheticBuildIds = { update: updateBuildId, broken: brokenBuildId };
    report.checkCount = checks.length;
  } catch (error) {
    report.status = 'failed';
    report.finishedAt = new Date().toISOString();
    report.error = error.stack || error.message;
    report.browserDiagnostics = await Promise.all(pages.map(async (page, index) => {
      const state = await page.evaluate(`({url:location.href,readyState:document.readyState,title:document.title,
        text:(document.body?.innerText||'').slice(0,1200),prefs:localStorage.getItem('mofish.prefs'),
        app:Boolean(window.__mofish),renderer:window.__mofish?.renderer||null,
        controller:Boolean(navigator.serviceWorker?.controller)})`).catch(diagnosticError => ({ evaluateError: diagnosticError.message }));
      const events = page.events.filter(event => event.method === 'Log.entryAdded' || event.method === 'Network.loadingFailed')
        .slice(-30).map(event => event.method === 'Log.entryAdded'
          ? { method: event.method, entry: event.params.entry }
          : { method: event.method, requestId: event.params.requestId, errorText: event.params.errorText });
      return { tab: index, state, events };
    }));
    console.error(`浏览器失败诊断：${JSON.stringify(report.browserDiagnostics)}`);
    throw error;
  } finally {
    for (const page of pages) page.close();
    await shutdownChrome(browserRun);
    if (preview) await preview.close();
    if (fakeServer) await fakeServer.close();
    if (profileDir) rmSync(profileDir, { recursive: true, force: true });
    report.cleanup = {
      profileRemoved: Boolean(profileDir),
      previewStopped: Boolean(preview),
      fakeSupabaseStopped: Boolean(fakeServer),
      upgradeDistRetained: existsSync(upgradeDir)
    };
    mkdirSync(taskDir, { recursive: true });
    writeFileSync(path.join(taskDir, 'version-upgrade-result.json'), `${JSON.stringify(report, null, 2)}\n`);
  }

  if (report.status === 'passed') {
    try {
      report.legacyMigration = await runLegacyMigration(sourceDir, args.chrome);
    } catch (error) {
      report.status = 'failed';
      report.error = `legacy migration: ${error.stack || error.message}`;
      report.legacyMigration = { status: 'failed', error: error.message };
    }
    report.finishedAt = new Date().toISOString();
    report.checkCount = checks.length;
    writeFileSync(path.join(taskDir, 'version-upgrade-result.json'), `${JSON.stringify(report, null, 2)}\n`);
    if (report.status !== 'passed') throw new Error(report.error);
  }
}

main().catch(error => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
