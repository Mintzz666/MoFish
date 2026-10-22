// Optional real Phase C browser acceptance. Run only after source review:
//   node --env-file=.env.phase-c tests/e2e/phase-c-real.mjs
// This script intentionally does not load the env file itself and never builds dist/.

import { randomBytes, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { decodeJwtPayload } from '../../web/cloud/config.js';
import { startPreviewServer } from '../../scripts/serve.mjs';
import { checkPhaseCTarget, phaseCEnvironment } from '../../scripts/phase-c-config.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../..');
const TARGET_URL = 'https://gbcfyqtbezkgkstrfbzn.supabase.co';
const TARGET_REF = 'gbcfyqtbezkgkstrfbzn';
const C_ROOT = 'https://mofish-phase-c.tibo-reset-notifier.workers.dev/';
const B_ROOT = 'https://mofish-phase-b.tibo-reset-notifier.workers.dev/';
const artifactName=process.env.MOFISH_QA_RUN_NAME||`phase-c-browser-${new Date().toISOString().replace(/[:.]/g,'-')}`;
if(!/^[a-zA-Z0-9_-]+$/.test(artifactName))throw Error('QA artifact name must be a local folder name');
const OUTPUT_DIR = path.join(repo, '.local', artifactName);
const SCREENSHOTS_DIR = path.join(OUTPUT_DIR, 'screenshots');
const RESULTS_FILE = path.join(SCREENSHOTS_DIR, 'results.json');
const OWNED_FILE = path.join(OUTPUT_DIR, 'browser-owned.json');
const RUN_ID = `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`;
const WAIT_MS = 60_000;

const checks = [];
const failures = [];
const owned = [];
const pages = [];
const sockets = [];
let previousRegistry = [];
let stage = 'preflight';
let targetValidated = false;
let preview = null;
let chrome = null;
let browserWs = null;
let debugPort = null;
let tempDir = null;
let profileDir = null;
let stopSignal = null;
let shutdownPromise = null;
let registryWritePromise = Promise.resolve();
let screenshotPaths = {};
let previewPort = null;

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function redact(value) {
  return String(value ?? '')
    .replace(/Bearer\s+[^\s'"`]+/gi, 'Bearer [redacted]')
    .replace(/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/g, '[email]')
    .replace(/\b[a-f0-9]{64}\b/gi, '[redacted]')
    .replace(/\b[A-Za-z0-9_-]{40,}\b/g, '[redacted]')
    .replace(/(apikey|authorization|password|token)\s*[:=]\s*[^,\s]+/gi, '$1=[redacted]')
    .slice(0, 500);
}

function record(name, ok) {
  const row = { name, ok: Boolean(ok) };
  checks.push(row);
  console.log(`${row.ok ? 'PASS' : 'FAIL'} ${name}`);
  if (!row.ok) throw new Error(`check_failed:${name}`);
  return row;
}

function recordCleanup(name, ok) {
  const row = { name, ok: Boolean(ok) };
  checks.push(row);
  if (!row.ok) failures.push({ stage: 'cleanup', error: name });
  console.log(`${row.ok ? 'PASS' : 'FAIL'} ${name}`);
}

function captureFailure(error) {
  const message = redact(error?.message || error || 'unknown failure');
  failures.push({ stage, error: message });
  console.error(`失败阶段 ${stage}: ${message}`);
}

function checkTargetEnvironment() {
  if (Number(process.versions.node.split('.')[0]) < 24) {
    throw new Error('需要 Node 24；请使用 node --env-file=.env.phase-c 启动。');
  }
  const env = phaseCEnvironment(process.env);
  checkPhaseCTarget(env.MOFISH_SUPABASE_URL, env.MOFISH_SMOKE_EXPECTED_PROJECT_REF);
  targetValidated = true;
  if (env.MOFISH_SUPABASE_URL !== TARGET_URL || env.MOFISH_SMOKE_EXPECTED_PROJECT_REF !== TARGET_REF) {
    throw new Error('Phase C target is not the approved QA project');
  }
  if (!env.MOFISH_SUPABASE_ANON_KEY) throw new Error('C public key is missing');
  const serviceRole = String(env.MOFISH_SMOKE_SERVICE_ROLE_KEY || '');
  if (!serviceRole || serviceRole.startsWith('sb_secret_') || decodeJwtPayload(serviceRole)?.role !== 'service_role') {
    throw new Error('需要本机独立 C 配置中的 Legacy service_role；不要把秘密发到聊天。');
  }
  return {
    anonKey: env.MOFISH_SUPABASE_ANON_KEY,
    serviceRole
  };
}

function requireCheck(name, ok) {
  return record(name, ok);
}

async function waitFor(page, expression, label, timeoutMs = WAIT_MS) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (stopSignal) throw new Error('browser test interrupted');
    try {
      const value = await page.evaluate(expression);
      if (value) return value;
    } catch {
      // Navigation can temporarily destroy a Runtime context; poll again.
    }
    await delay(150);
  }
  throw new Error(`wait_timeout:${label}`);
}

async function waitForNode(predicate, label, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (stopSignal) throw new Error('browser test interrupted');
    const value = await predicate().catch(() => null);
    if (value) return value;
    await delay(150);
  }
  throw new Error(`wait_timeout:${label}`);
}

let cdpMessageId = 0;
async function connect(wsUrl, { pageDomains = true } = {}) {
  const ws = new WebSocket(wsUrl);
  sockets.push(ws);
  const pending = new Map();
  const events = [];
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++cdpMessageId;
    const timeout = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`cdp_timeout:${method}`));
    }, 30_000);
    pending.set(id, { resolve, reject, timeout });
    ws.send(JSON.stringify({ id, method, params }));
  });

  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('cdp_connect_timeout')), 15_000);
    ws.addEventListener('open', () => { clearTimeout(timeout); resolve(); }, { once: true });
    ws.addEventListener('error', () => { clearTimeout(timeout); reject(new Error('cdp_connect_failed')); }, { once: true });
  });
  ws.addEventListener('close', () => {
    for (const item of pending.values()) {
      clearTimeout(item.timeout);
      item.reject(new Error('cdp_connection_closed'));
    }
    pending.clear();
  });
  ws.addEventListener('message', (event) => {
    let message;
    try { message = JSON.parse(event.data); } catch { return; }
    if (message.id && pending.has(message.id)) {
      const item = pending.get(message.id);
      pending.delete(message.id);
      clearTimeout(item.timeout);
      if (message.error) item.reject(new Error(`cdp_error:${message.error.code || 'unknown'}`));
      else item.resolve(message.result);
    } else if (message.method) {
      events.push(message);
    }
  });

  if (!pageDomains) return { ws, events, send };
  await send('Page.enable');
  await send('Runtime.enable');
  await send('Log.enable');
  await send('Network.enable');
  const page = {
    ws,
    events,
    send,
    async evaluate(expression) {
      const result = await send('Runtime.evaluate', {
        expression,
        returnByValue: true,
        awaitPromise: true
      });
      if (result.exceptionDetails) throw new Error('page_runtime_exception');
      return result.result?.value;
    },
    async goto(url) {
      await send('Page.navigate', { url });
      await waitFor(this, 'document.readyState === "complete"', 'document ready');
    },
    async box(selector) {
      return this.evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)return null;e.scrollIntoView({block:'center'});const r=e.getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2};})()`);
    },
    async click(selector) {
      await this.front();
      const point = await this.box(selector);
      if (!point) throw new Error(`missing_selector:${selector}`);
      await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button: 'left', clickCount: 1 });
      await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y, button: 'left', clickCount: 1 });
    },
    async type(selector, value) {
      await this.front();
      const ready = await waitFor(this, `(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e||e.disabled)return false;e.focus();e.value='';e.dispatchEvent(new Event('input',{bubbles:true}));return true;})()`, 'input ready '+selector);
      if (!ready) throw new Error(`missing_or_disabled_input:${selector}`);
      await send('Input.insertText', { text: String(value) });
    },
    async front() {
      try { await send('Page.bringToFront'); } catch { /* a closed tab is handled by the next operation */ }
    },
    async setViewport(width, height, mobile = false) {
      await send('Emulation.setDeviceMetricsOverride', {
        width,
        height,
        deviceScaleFactor: mobile ? 3 : 1,
        mobile
      });
    },
    async shot(file) {
      const screenshot = await send('Page.captureScreenshot', { format: 'png' });
      await writeFile(file, Buffer.from(screenshot.data, 'base64'), { mode: 0o600 });
      return file;
    },
    errors() {
      return events.filter((event) =>
        (event.method === 'Log.entryAdded' && event.params.entry.level === 'error') ||
        (event.method === 'Runtime.consoleAPICalled' && event.params.type === 'error') ||
        event.method === 'Runtime.exceptionThrown'
      ).map((event) => {
        if (event.method === 'Log.entryAdded') return event.params.entry.text;
        if (event.method === 'Runtime.exceptionThrown') return 'uncaught page exception';
        return (event.params.args || []).map((arg) => arg.value || arg.description || '').join(' ');
      }).map(redact);
    }
  };
  return page;
}

async function newContextPage(browser, label, previewUrl) {
  const { browserContextId } = await browser.send('Target.createBrowserContext', { disposeOnDetach: false });
  const { targetId } = await browser.send('Target.createTarget', { url: 'about:blank', browserContextId });
  const list = await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json();
  const target = list.find((item) => item.id === targetId);
  if (!target?.webSocketDebuggerUrl) throw new Error(`cdp_target_missing:${label}`);
  const page = await connect(target.webSocketDebuggerUrl);
  const prefs = JSON.stringify({ renderer: '2d', quality: 'low' });
  await page.send('Page.addScriptToEvaluateOnNewDocument', {
    source: `try{localStorage.setItem('mofish.prefs',${JSON.stringify(prefs)});}catch{}`
  });
  page.label = label;
  page.contextId = browserContextId;
  page.previewUrl = previewUrl;
  pages.push(page);
  await page.setViewport(1440, 900, false);
  await page.goto(`${previewUrl}/`);
  await waitFor(page, 'Boolean(window.__mofish) && window.__mofish.renderer === "2d"', `${label} app initialized`);
  return page;
}

async function typeAndClickLogin(page, account) {
  await page.click('#account-button');
  await waitFor(page, 'document.getElementById("account-dialog")?.open === true', `${page.label} account dialog`);
  await page.type('#auth-email', account.email);
  await page.type('#auth-password', account.password);
  await page.click('#auth-sign-in');
  await waitFor(page,
    'document.getElementById("session-panel")?.hidden === false && document.getElementById("cloud-status")?.textContent.trim() === "已同步"',
    `${page.label} cloud login`, 90_000);
  await waitFor(page, 'document.getElementById("sharing-button")?.hidden === false', `${page.label} C sharing button`);
  await page.evaluate(`(()=>{for(const id of ['auth-email','auth-password']){const e=document.getElementById(id);if(e)e.value='';}const d=document.getElementById('account-dialog');if(d?.open)d.close();return true;})()`);
  await waitFor(page, 'document.getElementById("account-dialog")?.open === false', `${page.label} account dialog closed`);
}

async function openSharing(page) {
  await page.click('#sharing-button');
  await waitFor(page,
    '(()=>{const d=document.getElementById("sharing-dialog");return Boolean(d?.open && document.getElementById("sharing-rooms-section") && document.getElementById("sharing-members-section") && d.getAttribute("aria-busy") === "false");})()',
    `${page.label} sharing panel loaded`);
}

async function closeSharing(page) {
  const open = await page.evaluate('document.getElementById("sharing-dialog")?.open === true');
  if (!open) return;
  await page.click('#sharing-close');
  await waitFor(page, 'document.getElementById("sharing-dialog")?.open === false', `${page.label} sharing panel closed`);
}

async function ensureOutputDirs() {
  await mkdir(OUTPUT_DIR, { recursive: true, mode: 0o700 });
  await chmod(OUTPUT_DIR, 0o700);
  await mkdir(SCREENSHOTS_DIR, { recursive: true, mode: 0o700 });
  await chmod(SCREENSHOTS_DIR, 0o700);
  try {
    const parsed = JSON.parse(await readFile(OWNED_FILE, 'utf8'));
    if (!Array.isArray(parsed)) throw new Error('invalid account registry');
    previousRegistry = parsed;
    await chmod(OWNED_FILE, 0o600);
  } catch (error) {
    if (error.code !== 'ENOENT') throw new Error('existing browser-owned registry is unreadable; preserved without overwrite');
  }
}

function persistRegistry() {
  registryWritePromise = registryWritePromise.then(async () => {
    if (!owned.length) return;
    const rows = [
      ...previousRegistry,
      ...owned.map(({ id, email, createdAt, cleanup }) => ({ id, email, createdAt, cleanup }))
    ];
    const temporary = `${OWNED_FILE}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify(rows, null, 2)}\n`, { mode: 0o600 });
    await chmod(temporary, 0o600);
    await rename(temporary, OWNED_FILE);
    await chmod(OWNED_FILE, 0o600);
  });
  return registryWritePromise;
}

async function adminRequest(pathname, method = 'GET', body = undefined) {
  if (!targetValidated) throw new Error('admin request blocked before target validation');
  const endpoint = new URL(`/auth/v1/admin/${pathname}`, TARGET_URL);
  if (endpoint.origin !== TARGET_URL) throw new Error('admin request escaped the approved project');
  const response = await fetch(endpoint, {
    method,
    headers: {
      apikey: adminKey,
      Authorization: `Bearer ${adminKey}`,
      'Content-Type': 'application/json'
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(20_000)
  });
  let payload = null;
  try { payload = await response.json(); } catch { /* 204 or non-JSON response */ }
  return { status: response.status, body: payload };
}

function userMissing(response) {
  const body = response?.body || {};
  const message = String(body.msg || body.message || body.error_description || '').trim();
  return response?.status === 404 && (
    body.code === 'user_not_found' || body.error_code === 'user_not_found' || /^user not found$/i.test(message)
  );
}

let adminKey = '';
async function createTemporaryAccount(label) {
  const email = `mofish-c-browser-${randomUUID()}-${label}@example.com`;
  const password = randomBytes(30).toString('base64url');
  const response = await adminRequest('users', 'POST', { email, password, email_confirm: true });
  if (response.status !== 200 || !response.body?.id || response.body?.email !== email) {
    throw new Error(`temporary_${label}_account_create_failed:http_${response.status}`);
  }
  const entry = {
    id: String(response.body.id),
    email,
    password,
    createdAt: new Date().toISOString(),
    cleanup: 'pending'
  };
  owned.push(entry);
  await persistRegistry();
  return entry;
}

async function verifyRecoveryRedirects(owner) {
  const explicit = await adminRequest('generate_link?redirect_to='+encodeURIComponent(C_ROOT), 'POST', {
    type: 'recovery',
    email: owner.email,
  });
  requireCheck('Admin recovery 显式 redirectTo 指向 C 根地址',
    explicit.status === 200 && explicit.body?.redirect_to === C_ROOT);

  const defaultRedirect = await adminRequest('generate_link', 'POST', {
    type: 'recovery',
    email: owner.email
  });
  requireCheck('Admin recovery 默认回调保留 B Site URL',
    defaultRedirect.status === 200 && defaultRedirect.body?.redirect_to === B_ROOT);
}

function chromeExecutable() {
  const candidates = [
    process.env.MOFISH_CHROME_PATH,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome for Testing',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/google-chrome'
  ].filter(Boolean);
  return candidates.find((candidate) => existsSync(candidate)) || null;
}

async function startChrome() {
  const executable = chromeExecutable();
  if (!executable) throw new Error('独立 Chrome/Chromium 不可用；请设置 MOFISH_CHROME_PATH。');
  tempDir = mkdtempSync(path.join(os.tmpdir(), 'mofish-phase-c-real-'));
  profileDir = path.join(tempDir, 'profile');
  chrome = spawn(executable, [
    '--headless=new',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-networking',
    '--disable-sync',
    '--disable-extensions',
    '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    '--enable-unsafe-swiftshader',
    '--use-gl=angle',
    '--use-angle=swiftshader',
    '--remote-debugging-port=0',
    `--user-data-dir=${profileDir}`,
    'about:blank'
  ], { stdio: 'ignore', detached: false });
  let spawnError = null;
  chrome.once('error', (error) => { spawnError = error; });
  console.log(`测试 PID=${process.pid} · 隔离 Chrome PID=${chrome.pid || 'starting'}`);

  let version = null;
  await waitForNode(async () => {
    if (spawnError) throw new Error('chrome_spawn_failed');
    if (chrome.exitCode !== null || chrome.signalCode !== null) throw new Error('chrome_exited_during_startup');
    try {
      const portText = await readFile(path.join(profileDir, 'DevToolsActivePort'), 'utf8');
      const port = Number(portText.split(/\r?\n/)[0]);
      const response = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (!response.ok) return null;
      const result = await response.json();
      if (!result.webSocketDebuggerUrl) return null;
      debugPort = port;
      version = result;
      return result;
    } catch {
      return null;
    }
  }, 'isolated Chrome DevTools port', 30_000);

  const browser = await connect(version.webSocketDebuggerUrl, { pageDomains: false });
  browserWs = { send: browser.send };
  return browserWs;
}

async function verifyExistingDist(anonKey) {
  const source = await readFile(path.join(repo, 'dist', 'config.js'), 'utf8');
  const match = source.match(/globalThis\.__MOFISH_CONFIG__\s*=\s*(\{[\s\S]*?\});/);
  if (!match) throw new Error('existing dist/config.js is not a generated config object');
  let config;
  try { config = JSON.parse(match[1]); } catch { throw new Error('existing dist/config.js cannot be parsed'); }
  const valid = config.phase === 'c' &&
    config.supabaseUrl === TARGET_URL &&
    new URL(config.supabaseUrl).hostname.replace(/\.supabase\.co$/, '') === TARGET_REF &&
    config.supabaseAnonKey === anonKey;
  requireCheck('现有 dist/config.js 指向 C 项目且 phase=c', valid);
}

async function verifyPreviewCsp() {
  const response = await fetch(`${preview.url}/config.js`);
  const csp = response.headers.get('content-security-policy') || '';
  const valid = response.ok && csp.includes('https://*.supabase.co') && csp.includes('wss://*.supabase.co');
  requireCheck('预览服务端应用现有 C CSP 规则', valid);
}

async function openOwnerPanelAndLoad(page) {
  await openSharing(page);
  const loaded = await waitFor(page,
    '(()=>{const d=document.getElementById("sharing-dialog");const rooms=[...document.querySelectorAll("#sharing-room-list .sharing-room-item")];const owner=rooms.some(r=>r.querySelector(".sharing-role[data-role=owner]"));return Boolean(d?.open && owner && document.getElementById("sharing-invite-email") && d.getAttribute("aria-busy")==="false");})()',
    'owner shared aquarium list loaded');
  requireCheck('主人共享面板可加载自己的鱼缸和邀请区域', Boolean(loaded));
}

async function findRoomButton(page, role) {
  const selector = `.sharing-role[data-role="${role}"]`;
  const expression = `(()=>{const row=[...document.querySelectorAll("#sharing-room-list .sharing-room-item")].find(item=>item.querySelector(${JSON.stringify(selector)}));return row?.querySelector("button")?.id||null;})()`;
  return page.evaluate(expression);
}

async function findMemberControl(page, email, tag) {
  const expression = `(()=>{const row=[...document.querySelectorAll(".sharing-member-item")].find(item=>item.textContent.includes(${JSON.stringify(email)}));return row?.querySelector(${JSON.stringify(tag)})?.id||null;})()`;
  return page.evaluate(expression);
}

async function collectBrowserErrors() {
  const errors = [];
  for (const page of pages) {
    for (const message of page.errors()) {
      if (/Failed to load resource/i.test(message)) continue;
      errors.push({ context: page.label, error: redact(message) });
    }
  }
  return errors.slice(0, 30);
}

async function run() {
  const env = checkTargetEnvironment();
  adminKey = env.serviceRole;
  await ensureOutputDirs();
  await verifyExistingDist(env.anonKey);

  stage = 'preview server';
  preview = await startPreviewServer({ dir: path.join(repo, 'dist'), port: 0, headers: true });
  previewPort = preview.port;
  await verifyPreviewCsp();

  stage = 'isolated browser';
  const browser = await startChrome();
  const ownerPage = await newContextPage(browser, 'owner', preview.url);
  const editorPage = await newContextPage(browser, 'editor', preview.url);
  requireCheck('协作浏览器上下文初始均使用 2D 视图',
    await ownerPage.evaluate('window.__mofish.renderer === "2d"') &&
    await editorPage.evaluate('window.__mofish.renderer === "2d"'));

  stage = 'temporary accounts';
  const owner = await createTemporaryAccount('owner');
  const editor = await createTemporaryAccount('editor');
  requireCheck('仅创建本轮 owner/editor 两个随机临时账号', owned.length === 2);

  stage = 'recovery redirect verification';
  await verifyRecoveryRedirects(owner);

  stage = 'owner login and sharing panel';
  await typeAndClickLogin(ownerPage, owner);
  await openOwnerPanelAndLoad(ownerPage);

  await ownerPage.setViewport(390, 844, true);
  await waitFor(ownerPage, 'innerWidth === 390 && document.getElementById("sharing-dialog")?.open === true', 'owner mobile viewport');
  const ownerMobileShot = path.join(SCREENSHOTS_DIR, `owner-shared-panel-${RUN_ID}.png`);
  await ownerPage.shot(ownerMobileShot);
  screenshotPaths.ownerMobilePanel = path.relative(repo, ownerMobileShot);
  await ownerPage.setViewport(1440, 900, false);
  await waitFor(ownerPage, 'innerWidth === 1440', 'owner desktop viewport');

  await ownerPage.type('#sharing-invite-email', editor.email);
  await ownerPage.click('#sharing-refresh');
  await waitFor(ownerPage,
    `(()=>{const d=document.getElementById("sharing-dialog");const e=document.getElementById("sharing-invite-email");return Boolean(d?.getAttribute("aria-busy")==="false"&&e?.value===${JSON.stringify(editor.email)});})()`,
    'invite email survives one panel refresh');
  requireCheck('邀请邮箱经过一轮远端刷新仍保留', true);
  await ownerPage.click('#sharing-invite-create');
  let inviteToken = await waitFor(ownerPage,
    'document.getElementById("sharing-invite-code")?.textContent.trim()',
    'owner invite code created');
  requireCheck('主人通过共享面板创建编辑邀请', Boolean(inviteToken));

  stage = 'editor login and invite acceptance';
  await typeAndClickLogin(editorPage, editor);
  await openSharing(editorPage);
  await waitFor(editorPage,
    'document.getElementById("sharing-dialog")?.open === true && document.getElementById("sharing-token")',
    'editor invite acceptance form');
  await editorPage.type('#sharing-token', inviteToken);
  await editorPage.click('#sharing-accept');
  inviteToken = '';
  await waitFor(editorPage,
    '(()=>[...document.querySelectorAll("#sharing-room-list .sharing-room-item")].some(row=>row.querySelector(".sharing-role[data-role=editor]")))()',
    'accepted owner room appears for editor');
  const editorRoomButton = await findRoomButton(editorPage, 'editor');
  if (!editorRoomButton) throw new Error('accepted owner room selector not found');
  await editorPage.click(`#${editorRoomButton}`);
  await waitFor(editorPage,
    'window.__mofish.state.version === 2 && document.getElementById("collaboration-banner")?.hidden === false && document.getElementById("room-label")?.textContent.includes("一起照看")',
    'editor enters owner shared aquarium');
  requireCheck('被邀请账号接受邀请并进入主人鱼缸', true);

  await editorPage.setViewport(390, 844, true);
  await waitFor(editorPage, 'innerWidth === 390', 'editor mobile viewport');
  const editorMobileShot = path.join(SCREENSHOTS_DIR, `editor-shared-panel-390-${RUN_ID}.png`);
  await editorPage.shot(editorMobileShot);
  screenshotPaths.editorMobilePanel = path.relative(repo, editorMobileShot);
  await editorPage.setViewport(1440, 900, false);
  await waitFor(editorPage, 'innerWidth === 1440', 'editor desktop viewport');
  await closeSharing(editorPage);
  await closeSharing(ownerPage);

  stage = 'cross-member synchronization';
  const ownerFishName = `C-${randomUUID().slice(0, 8)}`;
  await ownerPage.click('.fish-card');
  await ownerPage.click('#detail-rename');
  await waitFor(ownerPage, 'document.getElementById("fish-dialog")?.open === true', 'fish rename dialog');
  await ownerPage.type('#fish-name', ownerFishName);
  await ownerPage.click('#rename');
  await waitFor(ownerPage,
    `window.__mofish.state.fish.some(f=>f.name===${JSON.stringify(ownerFishName)}) && document.getElementById("fish-dialog")?.open === false`,
    'owner fish rename saved');
  await waitFor(editorPage,
    `window.__mofish.state.fish.some(f=>f.name===${JSON.stringify(ownerFishName)})`,
    'editor receives owner fish rename');
  requireCheck('主人改名同步到编辑成员', true);

  const nightBefore = await editorPage.evaluate('window.__mofish.state.night');
  await editorPage.click('#night');
  await waitFor(editorPage, `window.__mofish.state.night === ${!nightBefore}`, 'editor night change saved');
  await waitFor(ownerPage, `window.__mofish.state.night === ${!nightBefore}`, 'owner receives editor night change');
  requireCheck('编辑成员切换夜间状态并同步到主人', true);

  await editorPage.send('Network.emulateNetworkConditions',{offline:true,latency:0,downloadThroughput:-1,uploadThroughput:-1});
  await waitFor(editorPage,'navigator.onLine === false','isolated browser becomes offline');
  await editorPage.click('#night');
  await waitFor(editorPage,`window.__mofish.state.night === ${nightBefore}`,'offline change remains locally visible');
  await delay(700);
  requireCheck('浏览器实际断网时改动保留在本机、另一端不提前变化',await ownerPage.evaluate(`window.__mofish.state.night === ${!nightBefore}`));
  await editorPage.send('Network.emulateNetworkConditions',{offline:false,latency:0,downloadThroughput:-1,uploadThroughput:-1});
  await waitFor(editorPage,'navigator.onLine === true','isolated browser reconnects');
  await waitFor(ownerPage,`window.__mofish.state.night === ${nightBefore}`,'owner receives offline replay after reconnect');
  requireCheck('浏览器重连后离线操作同步到另一端',true);

  const decorCountBefore = await ownerPage.evaluate('window.__mofish.state.decor.length');
  await ownerPage.click('#toggle-2d');
  await waitFor(ownerPage, 'window.__mofish.renderer === "3d"', 'desktop 3D renderer ready', 90_000);
  requireCheck('桌面页面可切换到 3D 渲染', true);
  await ownerPage.click('#mode-decor');
  await ownerPage.click('#add-rock');
  await waitFor(ownerPage, 'document.getElementById("float-confirm")?.hidden === false', 'new decor placement pending');
  await ownerPage.click('#mode-view');
  await waitFor(ownerPage, `window.__mofish.state.decor.length === ${decorCountBefore + 1}`, 'new decor committed on owner');
  const newDecorId = await ownerPage.evaluate('window.__mofish.state.decor.at(-1)?.id');
  await waitFor(editorPage,
    `window.__mofish.state.decor.some(item=>item.id===${JSON.stringify(newDecorId)})`,
    'editor receives new decor');
  requireCheck('主人新增造景退出布景后也会保存并同步到编辑成员', Boolean(newDecorId));

  await ownerPage.click('#mode-view');
  const desktopShot = path.join(SCREENSHOTS_DIR, `desktop-3d-shared-${RUN_ID}.png`);
  await ownerPage.shot(desktopShot);
  screenshotPaths.desktop3d = path.relative(repo, desktopShot);

  stage = 'viewer permissions and removal';
  await openSharing(ownerPage);
  await waitFor(ownerPage,
    `(()=>[...document.querySelectorAll(".sharing-member-item")].some(row=>row.textContent.includes(${JSON.stringify(editor.email)})))()`,
    'owner sees editor member row');
  const roleId = await findMemberControl(ownerPage, editor.email, 'select');
  if (!roleId) throw new Error('editor role selector not found');
  await ownerPage.evaluate(`(()=>{const e=document.getElementById(${JSON.stringify(roleId)});if(!e)return false;e.value='viewer';e.dispatchEvent(new Event('change',{bubbles:true}));return true;})()`);
  await waitFor(ownerPage,
    `(()=>{const e=document.getElementById(${JSON.stringify(roleId)});const d=document.getElementById("sharing-dialog");return e?.value==="viewer"&&d?.getAttribute("aria-busy")==="false";})()`,
    'owner role change confirmed');
  requireCheck('主人将编辑成员权限改为仅观看', true);

  await editorPage.front();
  await waitFor(editorPage,
    'document.getElementById("add-rock")?.disabled === true && document.getElementById("night")?.disabled === true && document.getElementById("detail-rename")?.disabled === true',
    'editor write controls disabled after viewer role', 90_000);
  requireCheck('viewer 权限生效后编辑页面写入按钮禁用', true);
  await editorPage.evaluate('document.getElementById("tank").focus()');
  await editorPage.send('Input.dispatchKeyEvent',{type:'keyDown',key:' ',code:'Space',windowsVirtualKeyCode:32});
  await editorPage.send('Input.dispatchKeyEvent',{type:'keyUp',key:' ',code:'Space',windowsVirtualKeyCode:32});
  requireCheck('viewer 在2D画布按空格也不能生成本机食物',await editorPage.evaluate('window.__mofish.motionInfo.foodCount === 0'));
  await editorPage.click('#toggle-2d');
  await waitFor(editorPage,'window.__mofish.renderer === "3d"','viewer 3D ready',90_000);
  await editorPage.evaluate('document.getElementById("tank").focus()');
  await editorPage.send('Input.dispatchKeyEvent',{type:'keyDown',key:' ',code:'Space',windowsVirtualKeyCode:32});
  await editorPage.send('Input.dispatchKeyEvent',{type:'keyUp',key:' ',code:'Space',windowsVirtualKeyCode:32});
  requireCheck('viewer 在3D画布按空格也不能生成本机食物',await editorPage.evaluate('window.__mofish.motionInfo.foodCount === 0'));

  await ownerPage.front();
  const removeId = await findMemberControl(ownerPage, editor.email, 'button');
  if (!removeId) throw new Error('editor remove-member button not found');
  await ownerPage.click(`#${removeId}`);
  await waitFor(ownerPage,
    `(()=>![...document.querySelectorAll(".sharing-member-item")].some(row=>row.textContent.includes(${JSON.stringify(editor.email)}))&&document.getElementById("sharing-dialog")?.getAttribute("aria-busy")==="false")()`,
    'owner removes editor');
  await editorPage.front();
  await waitFor(editorPage,
    'document.getElementById("collaboration-banner")?.hidden === true && document.getElementById("room-label")?.textContent === "我的水下花园"',
    'removed editor returns to personal aquarium', 90_000);
  requireCheck('移除成员后 editor 自动回到个人鱼缸', true);

  const browserErrors = await collectBrowserErrors();
  const cspErrors = browserErrors.filter((entry) => /Content Security Policy/i.test(entry.error));
  requireCheck('浏览器页面无 CSP 违规', cspErrors.length === 0);
  requireCheck('双账号页面无前端异常', browserErrors.length === 0);
  return { browserErrors };
}

async function stopChromeAndPreview() {
  if (browserWs) {
    try { await browserWs.send('Browser.close'); } catch { /* Chrome may have exited already. */ }
  }
  for (const socket of sockets) {
    try { socket.close(); } catch { /* ignore already closed sockets */ }
  }
  if (chrome?.pid && chrome.exitCode === null && chrome.signalCode === null) {
    chrome.kill('SIGTERM');
    await Promise.race([
      new Promise((resolve) => chrome.once('exit', resolve)),
      delay(2500)
    ]);
    if (chrome.exitCode === null && chrome.signalCode === null) {
      chrome.kill('SIGKILL');
      await Promise.race([
        new Promise((resolve) => chrome.once('exit', resolve)),
        delay(2500)
      ]);
    }
  }
  if (preview) {
    try { await preview.close(); } catch { /* server already closed */ }
  }
  if (tempDir) {
    try { rmSync(tempDir, { recursive: true, force: true }); } catch { /* recorded below */ }
  }
}

async function cleanupAccounts() {
  if (!owned.length || !targetValidated || !adminKey) return;
  for (const account of [...owned].reverse()) {
    let deletedAndConfirmed = false;
    try {
      const current = await adminRequest(`users/${encodeURIComponent(account.id)}`);
      if (current.status !== 200 || current.body?.email !== account.email) {
        throw new Error('created account identity did not match registry; deletion withheld');
      }
      const deleted = await adminRequest(`users/${encodeURIComponent(account.id)}`, 'DELETE');
      const absent = await adminRequest(`users/${encodeURIComponent(account.id)}`);
      deletedAndConfirmed = [200, 204].includes(deleted.status) && userMissing(absent);
    } catch (error) {
      failures.push({ stage: 'account cleanup', error: redact(error?.message || error) });
    }
    account.cleanup = deletedAndConfirmed ? 'deleted_and_404_confirmed' : 'cleanup_unconfirmed';
    recordCleanup(`本轮 ${account.id === owned[0]?.id ? 'owner' : 'editor'} 临时账号完成 email 核验、删除与 404 确认`, deletedAndConfirmed);
    try { await persistRegistry(); } catch (error) {
      failures.push({ stage: 'account registry', error: redact(error?.message || error) });
      recordCleanup('临时账号登记文件保持可写且权限为 0600', false);
    }
  }
}

async function writeResults(runResult, startedAt) {
  const cleanupVerified = owned.filter((account) => account.cleanup === 'deleted_and_404_confirmed').length;
  const ok = failures.length === 0 && checks.every((entry) => entry.ok) && cleanupVerified === owned.length;
  const result = {
    runId: RUN_ID,
    startedAt,
    finishedAt: new Date().toISOString(),
    ok,
    targetProjectRef: TARGET_REF,
    viewportNote: '390 × 844 is Chrome CDP viewport emulation only; it is not a real phone acceptance.',
    pids: {
      test: process.pid,
      chrome: chrome?.pid || null,
      preview: previewPort ? process.pid : null,
      previewPort
    },
    temporaryProfile: {
      path: profileDir,
      removed: Boolean(tempDir && !existsSync(tempDir))
    },
    accounts: {
      createdThisRun: owned.length,
      deletedAnd404Confirmed: cleanupVerified
    },
    screenshots: screenshotPaths,
    checks,
    failures,
    browserErrors: runResult?.browserErrors || []
  };
  await writeFile(RESULTS_FILE, `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600 });
  await chmod(RESULTS_FILE, 0o600);
  return result;
}

async function execute() {
  const startedAt = new Date().toISOString();
  let runResult = null;
  let runFailed = false;
  for (const [signal, code] of [['SIGINT', 130], ['SIGTERM', 143]]) {
    process.once(signal, () => { stopSignal = code; process.exitCode = code; });
  }
  try {
    runResult = await run();
  } catch (error) {
    runFailed = true;
    captureFailure(error);
  } finally {
    if (!shutdownPromise) shutdownPromise = stopChromeAndPreview();
    try { await shutdownPromise; } catch (error) {
      runFailed = true;
      failures.push({ stage: 'resource cleanup', error: redact(error?.message || error) });
    }
    await cleanupAccounts();
    try {
      await registryWritePromise;
      if (owned.length && existsSync(OWNED_FILE)) await chmod(OWNED_FILE, 0o600);
    } catch (error) {
      runFailed = true;
      failures.push({ stage: 'account registry', error: redact(error?.message || error) });
    }
    const result = await writeResults(runResult, startedAt).catch((error) => {
      runFailed = true;
      console.error(`结果文件写入失败：${redact(error?.message || error)}`);
      return null;
    });
    if (!result?.ok || runFailed || stopSignal) process.exitCode = process.exitCode || 1;
    console.log(`C 浏览器验收 ${checks.filter((entry) => entry.ok).length}/${checks.length}；临时账号清理 ${owned.filter((account) => account.cleanup === 'deleted_and_404_confirmed').length}/${owned.length}；截图与结果保留在 ${path.relative(repo, SCREENSHOTS_DIR)}`);
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : '';
if (import.meta.url === invokedPath) await execute();
