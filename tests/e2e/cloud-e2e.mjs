// MoFish 阶段 A 的浏览器端到端测试。
//
// 覆盖：guest 模式不发云请求 / 注册-验证-登录 / 去抖写入 / 两台设备（独立浏览器上下文）
//       同账号恢复 / revision 冲突与两种处理 / 旧本地存档与云端并存时的选择 /
//       离线改动与重连 / _headers（CSP）未破坏应用 / 手机与电脑布局。
//
// ⚠️ 后端是本地假 Supabase（tests/fake-supabase），只证明前端与同步逻辑；
//    真实 Supabase 联调见 docs/HANDOFF.md 的「阻塞项」。
//
// 用法：node tests/e2e/cloud-e2e.mjs            （需要本机 Chrome）
//      node tests/e2e/cloud-e2e.mjs --keep     （保留本轮截图与结果，浏览器始终关闭）
//      MOFISH_CHROME_PATH=/path/to/chrome npm run test:e2e

import { spawn, execFileSync } from 'node:child_process';
import { writeFileSync, mkdirSync, rmSync, mkdtempSync, readFileSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createFakeSupabase, makeAccessToken } from '../fake-supabase/supabase-fake.mjs';
import { startFakeServer } from '../fake-supabase/server.mjs';
import { startPreviewServer } from '../../scripts/serve.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../..');
const CHROME = process.env.MOFISH_CHROME_PATH || [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome',
  process.env.PROGRAMFILES && path.join(process.env.PROGRAMFILES, 'Google/Chrome/Application/chrome.exe')
].filter(Boolean).find(p => existsSync(p));
if (!CHROME || !existsSync(CHROME)) throw new Error('未找到 Chrome/Chromium，请通过 MOFISH_CHROME_PATH 指定浏览器。');
const RUN_DIR = mkdtempSync(path.join(os.tmpdir(), 'mofish-e2e-'));
const PROFILE = path.join(RUN_DIR, 'browser-profile');
const SHOTS = path.join(RUN_DIR, 'screenshots');
mkdirSync(SHOTS, { recursive: true });
const sockets = [];

const sleep = ms => new Promise(r => setTimeout(r, ms));
const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok: Boolean(ok), detail });
  console.log(`${ok ? '✅' : '❌'} ${name}${detail ? ` — ${detail}` : ''}`);
}

// ---------------------------------------------------------------- CDP 小工具
let msgId = 0;
async function connect(wsUrl, { pageDomains = true } = {}) {
  const ws = new WebSocket(wsUrl);
  sockets.push(ws);
  const pending = new Map();
  const events = [];
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++msgId;
    const timeout = setTimeout(() => { pending.delete(id); reject(new Error(`CDP 超时：${method}`)); }, 15000);
    pending.set(id, { resolve, reject, timeout });
    ws.send(JSON.stringify({ id, method, params }));
  });
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('CDP 连接超时')), 10000);
    ws.addEventListener('open', () => { clearTimeout(timeout); resolve(); }, { once: true });
    ws.addEventListener('error', () => { clearTimeout(timeout); reject(new Error('CDP 连接失败')); }, { once: true });
  });
  ws.addEventListener('close', () => {
    for (const p of pending.values()) { clearTimeout(p.timeout); p.reject(new Error('CDP 连接已关闭')); }
    pending.clear();
  });
  ws.addEventListener('message', ev => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) {
      const p = pending.get(m.id); pending.delete(m.id);
      clearTimeout(p.timeout);
      m.error ? p.reject(new Error(m.method + ' ' + JSON.stringify(m.error))) : p.resolve(m.result);
    } else if (m.method) events.push(m);
  });
  // 浏览器级连接（Target/Browser 域）不支持 Page/Runtime/Network 域，必须分开处理。
  if (!pageDomains) return { ws, events, send };
  await send('Page.enable'); await send('Runtime.enable'); await send('Log.enable'); await send('Network.enable');
  const page = {
    ws, events, send,
    async evaluate(expression) {
      const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
      if (r.exceptionDetails) throw new Error('页面异常: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
      return r.result.value;
    },
    async goto(url) { await send('Page.navigate', { url }); await sleep(1400); },
    async box(selector) {
      return page.evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)return null;e.scrollIntoView({block:'center'});const r=e.getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2,l:r.left,r:r.right,w:r.width,h:r.height};})()`);
    },
    async click(selector) {
      const b = await page.box(selector);
      if (!b) throw new Error('找不到元素: ' + selector);
      await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: b.x, y: b.y, button: 'left', clickCount: 1 });
      await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: b.x, y: b.y, button: 'left', clickCount: 1 });
      await sleep(320);
    },
    async type(selector, text) {
      // 先清空再输入：否则 insertText 会追加到已有内容后面，导致邮箱变成两遍拼接。
      await page.evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});e.value='';e.focus();return true;})()`);
      await send('Input.insertText', { text });
      await sleep(120);
    },
    async front() {
      // 后台标签页会被 Chrome 节流 setTimeout（去抖写入会长于 2.5 秒），交互前显式置前。
      try { await send('Page.bringToFront'); } catch {}
      await sleep(150);
    },
    async shot(name) {
      const r = await send('Page.captureScreenshot', { format: 'png' });
      const file = path.join(SHOTS, name);
      writeFileSync(file, Buffer.from(r.data, 'base64'));
      return file;
    },
    async setViewport(width, height, mobile = true) {
      await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: mobile ? 3 : 1, mobile });
    },
    errors() {
      return events
        .filter(e => (e.method === 'Log.entryAdded' && e.params.entry.level === 'error')
          || (e.method === 'Runtime.consoleAPICalled' && e.params.type === 'error')
          || e.method === 'Runtime.exceptionThrown')
        .map(e => e.method === 'Log.entryAdded' ? e.params.entry.text
          : e.method === 'Runtime.exceptionThrown' ? (e.params.exceptionDetails.exception?.description || e.params.exceptionDetails.text)
          : (e.params.args || []).map(a => a.value || a.description).join(' '));
    }
  };
  return page;
}

/** 轮询等待页面条件成立（软件渲染下 3D 初始化可能占用数秒主线程）。 */
async function waitFor(page, expression, { timeoutMs = 15000, intervalMs = 250 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    try { last = await page.evaluate(expression); } catch { last = null; }
    if (last) return last;
    await sleep(intervalMs);
  }
  return last;
}

async function newContextPage(browserWs, label) {
  const { browserContextId } = await browserWs.send('Target.createBrowserContext', { disposeOnDetach: false });
  const { targetId } = await browserWs.send('Target.createTarget', { url: 'about:blank', browserContextId });
  const list = await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`)).json();
  const target = list.find(t => t.id === targetId);
  const page = await connect(target.webSocketDebuggerUrl);
  // 同步用例使用 2D，避免多个后台软件 WebGL 场景争抢 CPU；E 独立验证真正 3D。
  await page.send('Page.addScriptToEvaluateOnNewDocument', {
    source: `try { localStorage.setItem('mofish.prefs', JSON.stringify(${JSON.stringify(label === 'E' ? {quality:'low'} : {renderer:'2d',quality:'low'})})); } catch {}`
  });
  page.label = label;
  page.contextId = browserContextId;
  return page;
}

let DEBUG_PORT;
let chrome, fake, fakeServer, preview, browserWs;

// ---------------------------------------------------------------- 主流程
async function main() {
  // 1) 假 Supabase + 构建（把 dist 指向假后端）+ 预览服务器（应用 _headers 的 CSP）
  fake = createFakeSupabase();
  fakeServer = await startFakeServer(fake);
  const ANON = makeAccessToken('anon', { role: 'anon' });

  execFileSync('node', ['build.mjs'], {
    cwd: repo,
    env: { ...process.env, MOFISH_SUPABASE_URL: fakeServer.url, MOFISH_SUPABASE_ANON_KEY: ANON },
    stdio: 'pipe'
  });
  preview = await startPreviewServer({ dir: 'dist', port: 0, allowConnect: [fakeServer.url] });
  console.log(`预览 ${preview.url} · 假后端 ${fakeServer.url} · _headers 规则 ${preview.rules.length} 条`);

  // 2) 每轮独立 profile 与由浏览器分配的端口，避免两轮测试互相删除文件或连接到旧进程。
  chrome = spawn(CHROME, ['--headless=new', '--mute-audio', '--disable-gpu', '--hide-scrollbars', '--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader',
    ...(process.env.MOFISH_CHROME_NO_SANDBOX === '1' ? ['--no-sandbox'] : []),
    // 自动化下必须关掉后台节流，否则隐藏页面的 setTimeout（去抖写入）会被推迟到 3 秒以上，
    // 让「等待去抖窗口」的断言变成随机失败。
    '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding',
    '--remote-debugging-port=0', `--user-data-dir=${PROFILE}`, 'about:blank'],
    { stdio: ['ignore', 'ignore', 'pipe'], detached: false });
  let startupDiagnostics = '';
  chrome.stderr.on('data', chunk => {
    startupDiagnostics = (startupDiagnostics + chunk.toString()).slice(-8000);
  });
  let spawnError;
  chrome.once('error', error => { spawnError = error; });
  console.log(`本轮临时目录 ${RUN_DIR} · 测试 PID ${process.pid} · Chrome PID ${chrome.pid ?? '启动失败'}`);
  let version = null;
  for (let i = 0; i < 40 && !version; i++) {
    if (spawnError) throw spawnError;
    if (chrome.exitCode !== null || chrome.signalCode !== null) {
      throw new Error(`Chrome 启动后退出（${chrome.exitCode ?? chrome.signalCode}）：${startupDiagnostics}`);
    }
    await sleep(400);
    try {
      DEBUG_PORT = Number(readFileSync(path.join(PROFILE, 'DevToolsActivePort'), 'utf8').split('\n')[0]);
      version = await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/version`)).json();
    } catch { /* 还没起来 */ }
  }
  if (!version) throw new Error(`Chrome 调试端口不可达：${startupDiagnostics}`);

  // 浏览器级连接（建隔离上下文用）
  const raw = await connect(version.webSocketDebuggerUrl, { pageDomains: false });
  browserWs = { send: raw.send };

  const deviceA = await newContextPage(browserWs, 'A');
  await deviceA.setViewport(1440, 900, false);
  await deviceA.goto(preview.url + '/');

  // ---- 场景 1：游客模式不发云请求 ----
  const guestChip = await deviceA.evaluate(`document.getElementById('cloud-status').textContent`);
  const cloudRequestsInGuest = fakeServer.requests.length;
  check('游客模式状态显示为“游客”', guestChip === '游客', `chip=${guestChip}`);
  check('未登录时不对云后端发出任何请求', cloudRequestsInGuest === 0, `请求数=${cloudRequestsInGuest}`);
  await deviceA.shot('01-desktop-guest.png');

  // ---- 场景 2：注册 → 邮箱验证 → 登录 ----
  await deviceA.click('#account-button');
  const dialogOpen = await deviceA.evaluate(`document.getElementById('account-dialog').open`);
  check('账号面板可以打开', dialogOpen === true);
  await deviceA.shot('02-desktop-account-dialog.png');

  await deviceA.click('[data-auth-tab="signup"]');
  await deviceA.type('#auth-email', 'alice@example.com');
  await deviceA.type('#auth-password', 'goodpassword123');
  await deviceA.click('#auth-sign-up');
  await sleep(600);
  const signupNotice = await deviceA.evaluate(`document.getElementById('account-notice').textContent`);
  check('注册后提示需要邮箱验证', /验证邮件/.test(signupNotice), signupNotice.slice(0, 40));
  check('假后端记录了注册发信', fake.emails.some(e => e.type === 'signup'));

  const blocked = await deviceA.evaluate(`(async()=>{
    const set=(sel,val)=>{document.querySelector(sel).value=val;};
    set('#auth-email','alice@example.com');set('#auth-password','goodpassword123');
    document.getElementById('auth-sign-in').click();
    await new Promise(r=>setTimeout(r,600));
    return document.getElementById('account-notice').textContent;
  })()`);
  check('未验证邮箱登录被拒绝并给出可操作提示', /还没有验证/.test(blocked), blocked.slice(0, 40));

  fake.users.get('alice@example.com').confirmed = true;
  await deviceA.click('[data-auth-tab="signin"]');
  await deviceA.type('#auth-email', 'alice@example.com');
  await deviceA.type('#auth-password', 'goodpassword123');
  await deviceA.click('#auth-sign-in');
  await sleep(1200);
  const chipAfterLogin = await deviceA.evaluate(`document.getElementById('cloud-status').textContent`);
  const sessionStored = await deviceA.evaluate(`Boolean(localStorage.getItem('mofish.auth.session'))`);
  check('验证后登录成功且状态变为已同步', chipAfterLogin === '已同步', `chip=${chipAfterLogin}`);
  check('会话保存在本机', sessionStored === true);
  check('登录后云端建立了鱼缸', fake.aquariums.size === 1);
  await deviceA.evaluate(`document.getElementById('account-dialog').close()`);

  // ---- 场景 3：改名 → 去抖写入 ----
  const savesBefore = fakeServer.requests.filter(r => r.path.includes('save_aquarium')).length;
  await deviceA.click('.fish-card');
  await deviceA.click('#detail-rename');   // 新界面：点卡片先选中，再点“改名”打开对话框
  await sleep(160);
  await deviceA.evaluate(`document.getElementById('fish-name').value='阿花'`);
  await deviceA.click('#rename');
  const pendingChip = await deviceA.evaluate(`document.getElementById('cloud-status').textContent`);
  check('去抖等待期间不提前显示已同步', pendingChip !== '已同步', `chip=${pendingChip}`);
  await deviceA.evaluate(`document.getElementById('fish-dialog').close()`);
  await deviceA.click('#account-button');
  const pendingSyncEnabled = await deviceA.evaluate(`!document.getElementById('session-sync-now').disabled`);
  const pendingNotice = await deviceA.evaluate(`document.getElementById('account-notice').textContent`);
  check('等待自动上传时仍可手动立即同步', pendingSyncEnabled === true);
  check('未上传提示提醒更换设备前等待完成', /本机有新改动/.test(pendingNotice) && /换设备/.test(pendingNotice), pendingNotice);
  await deviceA.evaluate(`document.getElementById('account-dialog').close()`);
  await sleep(3200);   // 等过去抖窗口
  const savesAfter = fakeServer.requests.filter(r => r.path.includes('save_aquarium')).length;
  const rowA = [...fake.aquariums.values()][0];
  check('改名后云端存档被更新', rowA.state.fish[0].name === '阿花', `云端=${rowA.state.fish[0].name}`);
  check('一次改名只产生一次云端写入', savesAfter - savesBefore === 1, `差值=${savesAfter - savesBefore}`);

  // ---- 场景 4：第二台设备（独立浏览器上下文）同账号恢复 ----
  const deviceB = await newContextPage(browserWs, 'B');
  await deviceB.setViewport(1440, 900, false);
  await deviceB.goto(preview.url + '/');
  await deviceB.click('#account-button');
  await deviceB.type('#auth-email', 'alice@example.com');
  await deviceB.type('#auth-password', 'goodpassword123');
  await deviceB.click('#auth-sign-in');
  await sleep(3000);
  const nameOnB = await deviceB.evaluate(`document.querySelector('.fish-card b').textContent`);
  const chipOnB = await deviceB.evaluate(`document.getElementById('cloud-status').textContent`);
  check('设备 B 登录后恢复云端鱼名', nameOnB === '阿花', `B 显示=${nameOnB}`);
  check('设备 B 状态为已同步', chipOnB === '已同步', `chip=${chipOnB}`);
  await deviceB.evaluate(`document.getElementById('account-dialog').close()`);

  // ---- 场景 5：同 revision 冲突与两种处理 ----
  // B 先离线，保留旧基线；正常在线切回窗口现在会自动检查云端新进度。
  await deviceB.send('Network.emulateNetworkConditions', { offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0 });
  await deviceA.front();
  await deviceA.click('.fish-card');
  await deviceA.click('#detail-rename');   // 新界面：点卡片先选中，再点“改名”打开对话框
  await sleep(160);
  await deviceA.evaluate(`document.getElementById('fish-name').value='A 改的'`);
  await deviceA.click('#rename');
  await sleep(3200);

  await deviceB.front();
  await deviceB.click('.fish-card');
  await deviceB.click('#detail-rename');   // 新界面：点卡片先选中，再点“改名”打开对话框
  await sleep(160);
  await deviceB.evaluate(`document.getElementById('fish-name').value='B 改的'`);
  await deviceB.click('#rename');
  await deviceB.send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
  await deviceB.evaluate(`window.dispatchEvent(new Event('online'))`);
  await sleep(3200);
  const chipConflict = await deviceB.evaluate(`document.getElementById('cloud-status').textContent`);
  const bDiag = await deviceB.evaluate(`JSON.stringify({hidden:document.hidden,vis:document.visibilityState,keys:Object.keys(localStorage).length,pending:Object.keys(localStorage).filter(k=>k.includes('pending')).length,focus:document.hasFocus()})`);
  const saveCalls = fakeServer.requests.filter(r => String(r.path).includes('save_aquarium')).length;
  console.log(`   诊断 B: ${bDiag} | save_aquarium 请求总数=${saveCalls} | 最近请求=${fakeServer.requests.slice(-3).map(r => r.path).join(' , ')}`);
  const conflictVisible = await deviceB.evaluate(`!document.getElementById('conflict-box').hidden`);
  const cloudStillA = [...fake.aquariums.values()][0].state.fish[0].name;
  check('设备 B 遇到冲突并显示冲突状态', chipConflict === '有冲突', `chip=${chipConflict}`);
  await deviceB.click('#account-button');
  const conflictVisible2 = await deviceB.evaluate(`!document.getElementById('conflict-box').hidden`);
  check('冲突处理界面可见', conflictVisible2 === true);
  const conflictNotice = await deviceB.evaluate(`document.getElementById('account-notice').textContent`);
  check('冲突时账号提示不残留登录成功或已对齐', /各有改动/.test(conflictNotice), conflictNotice);
  check('未处理前云端数据不被覆盖', cloudStillA === 'A 改的', `云端=${cloudStillA}`);
  await deviceB.shot('03-conflict-desktop.png');

  await deviceB.click('#conflict-keep-local');
  await sleep(1800);
  const afterLocal = [...fake.aquariums.values()][0].state.fish[0].name;
  const chipAfterLocal = await deviceB.evaluate(`document.getElementById('cloud-status').textContent`);
  check('选择“用本机覆盖云端”后云端变为 B 的版本', afterLocal === 'B 改的', `云端=${afterLocal}`);
  check('冲突解决后状态回到已同步', chipAfterLocal === '已同步', `chip=${chipAfterLocal}`);
  const backupCount = await deviceB.evaluate(`(()=>{let n=0;for(let i=0;i<localStorage.length;i++){if(String(localStorage.key(i)).includes('mofish.backup.'))n++;}return n;})()`);
  check('被覆盖的云端版本在本机留有备份', backupCount >= 1, `备份数=${backupCount}`);

  // ---- 场景 6：旧本地存档与云端并存时由用户选择 ----
  const deviceC = await newContextPage(browserWs, 'C');
  await deviceC.setViewport(1440, 900, false);
  // 先在同源的非应用页面写入旧存档，再打开应用：避免上一页 pagehide 保存把它覆盖掉。
  await deviceC.goto(preview.url + '/manifest.webmanifest');
  await deviceC.evaluate(`(()=>{const s={version:1,fish:[{id:'legacy-1',name:'登录前的本地鱼',species:1,born:Date.now()-86400000,growth:0.3,meals:7}],plants:4,night:false,sound:false,savedAt:Date.now()};localStorage.setItem('mofish.v1',JSON.stringify(s));return true;})()`);
  await deviceC.goto(preview.url + '/');
  const guestNameOnC = await deviceC.evaluate(`document.querySelector('.fish-card b').textContent`);
  check('设备 C 先显示本机旧存档', guestNameOnC === '登录前的本地鱼', `显示=${guestNameOnC}`);

  await deviceC.front();
  await deviceC.click('#account-button');
  await deviceC.type('#auth-email', 'alice@example.com');
  await deviceC.type('#auth-password', 'goodpassword123');
  await deviceC.click('#auth-sign-in');
  await sleep(1600);
  const cConflict = await deviceC.evaluate(`!document.getElementById('conflict-box').hidden`);
  const cSummary = await deviceC.evaluate(`document.getElementById('conflict-summary').textContent`);
  const cloudNameBeforeChoice = [...fake.aquariums.values()][0].state.fish[0].name;
  check('本机旧存档与云端并存时弹出选择', cConflict === true);
  check('选择界面同时列出本机与云端两份',
    /登录前的本地鱼/.test(cSummary) && cSummary.includes(cloudNameBeforeChoice), cSummary.replace(/\n/g, ' | ').slice(0, 80));
  check('用户选择前云端存档未被改动', cloudNameBeforeChoice === 'B 改的', `云端=${cloudNameBeforeChoice}`);
  await deviceC.shot('04-old-save-choice.png');

  await deviceC.click('#conflict-keep-cloud');
  await sleep(1600);
  const cNameAfter = await deviceC.evaluate(`document.querySelector('.fish-card b').textContent`);
  const cGuestKept = await deviceC.evaluate(`Boolean(localStorage.getItem('mofish.v1'))`);
  check('选择保留云端后界面切到云端存档', cNameAfter === cloudNameBeforeChoice, `显示=${cNameAfter}，云端=${cloudNameBeforeChoice}`);
  check('游客存档仍然留在本机（未被删除）', cGuestKept === true);
  const cBackups = await deviceC.evaluate(`(()=>{let n=0;for(let i=0;i<localStorage.length;i++){if(String(localStorage.key(i)).includes('mofish.backup.'))n++;}return n;})()`);
  check('放弃的本机版本已归档为备份（可导出）', cBackups >= 1, `备份数=${cBackups}`);

  // ---- 场景 11：邮箱验证回调必须真正登录（评审 P1-4）----
  const deviceD = await newContextPage(browserWs, 'D');
  await deviceD.setViewport(1440, 900, false);
  await deviceD.goto(preview.url + '/');
  await deviceD.front();
  await deviceD.click('#account-button');
  await deviceD.click('[data-auth-tab="signup"]');
  await deviceD.type('#auth-email', 'carol@example.com');
  await deviceD.type('#auth-password', 'goodpassword123');
  await deviceD.click('#auth-sign-up');
  await sleep(700);
  await deviceD.evaluate(`document.getElementById('account-dialog').close()`);

  const carol = fake.users.get('carol@example.com');
  carol.confirmed = true;
  const carolSession = fake.issueSession(carol);
  // 注意：只改 hash 属于同文档导航，浏览器不会重新加载页面（也就不会触发回调处理）。
  // 真实用户点邮件链接一定是新开文档，这里用查询参数强制一次真实导航来保持一致。
  const verifyUrl = `${preview.url}/?mail=verify#access_token=${carolSession.access_token}&refresh_token=${carolSession.refresh_token}&type=signup&expires_in=3600`;
  await deviceD.goto(verifyUrl);
  // 3D 初始化在软件渲染下可能占用数秒主线程；轮询等待回调真正完成。
  await waitFor(deviceD, `document.getElementById('cloud-status').textContent === '已同步'`);
  await sleep(300);

  const dChip = await deviceD.evaluate(`document.getElementById('cloud-status').textContent`);
  const dDialogOpen = await deviceD.evaluate(`document.getElementById('account-dialog').open`);
  const dNotice = await deviceD.evaluate(`document.getElementById('account-notice').textContent`);
  const dHashCleared = await deviceD.evaluate(`!location.hash.includes('access_token')`);
  const carolRow = fake.aquariums.get(carol.id);
  check('邮箱验证回调后真正进入已登录状态（不是游客）', dChip === '已同步', `chip=${dChip}`);
  check('验证回调后云端建立了该账号的鱼缸', Boolean(carolRow), `aquarium=${carolRow?.id}`);
  check('验证回调会自动打开账号面板并给出结果', dDialogOpen === true && /验证完成|已登录/.test(dNotice), `notice=${dNotice}`);
  check('回调令牌已从地址栏清除', dHashCleared === true);
  await deviceD.shot('07-verify-callback.png');

  // ---- 场景 12：重置密码回调要显示改密面板，并且跨刷新保持（评审 P1-4）----
  const carolSession2 = fake.issueSession(carol);
  const recoveryUrl = `${preview.url}/?mail=recovery#access_token=${carolSession2.access_token}&refresh_token=${carolSession2.refresh_token}&type=recovery&expires_in=3600`;
  await deviceD.goto(recoveryUrl);
  await waitFor(deviceD, `!document.getElementById('reset-panel').hidden`);
  await sleep(300);

  const resetVisible = await deviceD.evaluate(`!document.getElementById('reset-panel').hidden`);
  const sessionHidden = await deviceD.evaluate(`document.getElementById('session-panel').hidden`);
  const resetHint = await deviceD.evaluate(`document.getElementById('reset-hint').textContent`);
  check('重置密码回调自动打开改密面板', resetVisible === true, `hint=${resetHint}`);
  check('改密期间不显示普通账号面板（避免被顶掉）', sessionHidden === true);
  await deviceD.shot('08-recovery-callback.png');

  // 关掉再手动打开：面板不能被「已登录」视图顶掉
  await deviceD.evaluate(`document.getElementById('account-dialog').close()`);
  await deviceD.front();
  await deviceD.click('#account-button');
  const resetVisibleAgain = await deviceD.evaluate(`!document.getElementById('reset-panel').hidden`);
  check('手动打开账号面板时改密面板仍然可见', resetVisibleAgain === true);
  await deviceD.evaluate(`document.getElementById('account-dialog').close()`);

  // 刷新页面（不带回调参数）：改密面板仍然要出现
  await deviceD.goto(preview.url + '/');
  await sleep(1500);
  await deviceD.front();
  await deviceD.click('#account-button');
  const resetAfterReload = await deviceD.evaluate(`!document.getElementById('reset-panel').hidden`);
  check('刷新页面后仍保留待改密状态（不再丢失链接状态）', resetAfterReload === true);

  await deviceD.type('#reset-password', 'brandnewpassword1');
  await deviceD.click('#reset-save');
  await sleep(1600);
  const passwordChanged = fake.users.get('carol@example.com').password === 'brandnewpassword1';
  const dChipAfterReset = await deviceD.evaluate(`document.getElementById('cloud-status').textContent`);
  const resetHiddenAfter = await deviceD.evaluate(`document.getElementById('reset-panel').hidden`);
  const signInAgain = await deviceD.evaluate(`(async()=>{const r=await fetch('${fakeServer.url}/auth/v1/token?grant_type=password',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:'carol@example.com',password:'brandnewpassword1'})});return r.status;})()`);
  check('改密确实写入了服务端', passwordChanged === true);
  check('改密后新密码可以登录', signInAgain === 200, `HTTP ${signInAgain}`);
  check('改密后回到已登录状态并收起改密面板', dChipAfterReset === '已同步' && resetHiddenAfter === true, `chip=${dChipAfterReset}`);

  // ---- 场景 7：离线改动与重连 ----
  // 账号面板是模态对话框，会挡住页面点击；先关掉再操作鱼缸。
  await deviceC.evaluate(`document.getElementById('account-dialog').open && document.getElementById('account-dialog').close()`);
  await deviceC.front();
  await deviceC.send('Network.emulateNetworkConditions', { offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0 });
  await deviceC.click('.fish-card');
  await deviceC.click('#detail-rename');   // 新界面：点卡片先选中，再点“改名”打开对话框
  await sleep(160);
  await deviceC.evaluate(`document.getElementById('fish-name').value='离线改的名字'`);
  await deviceC.click('#rename');
  await sleep(3600);   // 等过离线状态下的去抖写入尝试
  const offlineChip = await deviceC.evaluate(`document.getElementById('cloud-status').textContent`);
  check('离线时状态显示为离线', offlineChip === '离线', `chip=${offlineChip}`);
  const pendingKeys = await deviceC.evaluate(`(()=>{const out=[];for(let i=0;i<localStorage.length;i++){const k=String(localStorage.key(i));if(k.includes('pending'))out.push(k);}return out;})()`);
  check('离线改动以未同步副本存在本机', pendingKeys.length === 1, `pending 键=${pendingKeys.join(',')}`);
  await deviceC.click('#account-button');
  const offlineNotice = await deviceC.evaluate(`document.getElementById('account-notice').textContent`);
  check('离线时账号提示本机保留与自动重连', /当前离线/.test(offlineNotice) && /自动同步/.test(offlineNotice), offlineNotice);
  await deviceC.evaluate(`document.getElementById('account-dialog').close()`);

  await deviceC.send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
  await sleep(800);
  await deviceC.front();
  await deviceC.evaluate(`window.dispatchEvent(new Event('online'))`);
  await sleep(3500);
  const onlineName = [...fake.aquariums.values()][0].state.fish[0].name;
  const chipOnline = await deviceC.evaluate(`document.getElementById('cloud-status').textContent`);
  const pendingAfter = await deviceC.evaluate(`(()=>{const out=[];for(let i=0;i<localStorage.length;i++){const k=String(localStorage.key(i));if(k.includes('pending'))out.push(k);}return out;})()`);
  check('重连后离线改动写入云端', onlineName === '离线改的名字', `云端=${onlineName}，pending=${pendingAfter.join(',') || '无'}，chip=${chipOnline}`);
  check('重连后状态回到已同步', chipOnline === '已同步', `chip=${chipOnline}`);

  // ---- 场景 8：成长结算不重复奖励（服务端时间）----
  const beforeGrowth = [...fake.aquariums.values()][0].state.fish[0].growth;
  fake.advance(3600_000);
  await deviceC.evaluate(`document.getElementById('session-sync-now')?.click()`);
  await sleep(2000);
  const afterGrowth = [...fake.aquariums.values()][0].state.fish[0].growth;
  await deviceC.evaluate(`document.getElementById('session-sync-now')?.click()`);
  await sleep(1500);
  const afterSecond = [...fake.aquariums.values()][0].state.fish[0].growth;
  check('服务端结算 1 小时成长（v2：+0.002083）', Math.abs(afterGrowth - (beforeGrowth + 0.05 / 24)) < 1e-6, `${beforeGrowth} → ${afterGrowth}`);
  check('重复同步不会重复奖励', afterSecond === afterGrowth, `${afterGrowth} → ${afterSecond}`);

  // 模拟另一端已提交的新版本：可见窗口重新获得焦点时应拉回，无需重新登录。
  const remoteRow = [...fake.aquariums.values()][0];
  remoteRow.state.fish[0].name = '另一端更新的鱼名';
  remoteRow.revision += 1;
  await deviceC.evaluate(`window.dispatchEvent(new Event('focus'))`);
  await sleep(800);
  const focusedName = await deviceC.evaluate(`document.querySelector('.fish-card b').textContent`);
  check('重新聚焦可见窗口自动恢复云端新进度', focusedName === '另一端更新的鱼名', focusedName);

  // 模拟移动端切后台：不能依赖可能被冻结的 2.5 秒去抖定时器。
  const hiddenSavesBefore = fakeServer.requests.filter(r => r.path.includes('save_aquarium')).length;
  await deviceC.evaluate(`(()=>{
    document.querySelector('.fish-card').click();
    document.getElementById('fish-name').value='切后台前的改名';
    document.getElementById('rename').click();
    Object.defineProperty(document,'hidden',{configurable:true,get:()=>true});
    try { document.dispatchEvent(new Event('visibilitychange')); }
    finally { delete document.hidden; }
  })()`);
  const hiddenDeadline = Date.now() + 1500;
  while (remoteRow.state.fish[0].name !== '切后台前的改名' && Date.now() < hiddenDeadline) await sleep(25);
  const hiddenSavesAfter = fakeServer.requests.filter(r => r.path.includes('save_aquarium')).length;
  check('切后台立即上传本机改动，不等待去抖定时器',
    remoteRow.state.fish[0].name === '切后台前的改名' && hiddenSavesAfter - hiddenSavesBefore === 1);

  // ---- 场景 9：CSP 与前端错误 ----
  const cspHeader = await deviceC.evaluate(`fetch(location.href,{method:'HEAD'}).then(r=>r.headers.get('content-security-policy'))`);
  check('响应带 CSP（_headers 生效）', typeof cspHeader === 'string' && cspHeader.includes("script-src 'self'"), String(cspHeader).slice(0, 60));

  const rawErrors = [...deviceA.errors(), ...deviceB.errors(), ...deviceC.errors()];
  // 故意触发的失败登录会返回 400，Chrome 会记一条 "Failed to load resource"；这不是前端缺陷。
  const networkNoise = rawErrors.filter(e => /Failed to load resource/.test(e));
  const cspViolations = rawErrors.filter(e => /Content Security Policy/i.test(e));
  const realErrors = rawErrors.filter(e => !/Failed to load resource/.test(e));
  check('没有 CSP 违规', cspViolations.length === 0, cspViolations.slice(0, 2).join(' | '));
  check('没有真实的前端错误（故意失败的登录 400 除外）', realErrors.length === 0,
    `真实错误=${realErrors.slice(0, 3).join(' | ') || '无'}；网络噪声=${networkNoise.length} 条`);

  // ---- 场景 10：手机布局（含账号面板）----
  for (const [name, w, h] of [['05-phone-390', 390, 844], ['06-phone-320', 320, 568]]) {
    await deviceC.setViewport(w, h, true);
    await deviceC.goto(preview.url + '/');
    await sleep(900);
    const layout = JSON.parse(await deviceC.evaluate(`JSON.stringify({scrollW:document.documentElement.scrollWidth,inner:innerWidth,chip:document.getElementById('cloud-status').textContent,headerRight:document.querySelector('.topbar-right').getBoundingClientRect().right})`));
    check(`${w}px 无横向溢出`, layout.scrollW <= layout.inner, JSON.stringify(layout));
    await deviceC.click('#account-button');
    const dialogFits = JSON.parse(await deviceC.evaluate(`(()=>{const r=document.getElementById('account-dialog').getBoundingClientRect();return JSON.stringify({l:r.left,r:r.right,w:r.width,scrollW:document.documentElement.scrollWidth,inner:innerWidth,open:document.getElementById('account-dialog').open})})()`));
    check(`${w}px 账号面板完整可见且不溢出`, dialogFits.open && dialogFits.l >= 0 && dialogFits.r <= dialogFits.inner, JSON.stringify(dialogFits));
    await deviceC.shot(`${name}-account.png`);
    await deviceC.evaluate(`document.getElementById('account-dialog').close()`);
    await deviceC.shot(`${name}-tank.png`);
  }

  // ---- 场景 11：阶段 B 单人体验（3D / 布景编辑 / 2D 降级 / 四阶段）----
  const devicePhaseB = await newContextPage(browserWs, 'E');
  await devicePhaseB.setViewport(1440, 900, false);
  await devicePhaseB.goto(preview.url + '/');

  // 预置四条不同成长阶段的鱼（加速时钟只用于测试；正式玩家没有这样的入口）
  // 用 addScriptToEvaluateOnNewDocument 在应用启动前写入，避免上一页 pagehide 的自动保存覆盖种子。
  const seeded = {
    version: 2,
    fish: [0.02, 0.22, 0.55, 0.9].map((g, i) => ({
      id: `stage-${i}`, name: `阶段鱼${i}`, species: ['sunset', 'mint', 'moon', 'fan'][i],
      born: Date.now() - 30 * 86400000, growth: g, meals: 10, look: { v: 1, seed: 900 + i }
    })),
    decor: [], layout: { v: 1, seed: 7 }, night: false, sound: false, savedAt: Date.now()
  };
  await devicePhaseB.send('Page.addScriptToEvaluateOnNewDocument', {
    source: `localStorage.setItem('mofish.v1', ${JSON.stringify(JSON.stringify(seeded))});`
  });
  await devicePhaseB.goto(preview.url + '/');
  await waitFor(devicePhaseB, 'Boolean(window.__mofish)');
  await waitFor(devicePhaseB, `window.__mofish.renderer === '3d'`);
  await sleep(400);
  check('阶段 B：存档为 v2', (await devicePhaseB.evaluate('window.__mofish?.version')) === 2);
  check('默认观赏模式与选中标签一致', await devicePhaseB.evaluate(`window.__mofish.editMode === 'view' && document.getElementById('mode-view').getAttribute('aria-selected') === 'true'`));
  check('阶段 B：默认使用 3D 渲染', (await devicePhaseB.evaluate('window.__mofish?.renderer')) === '3d');

  const stageLabels = [];
  for (let i = 0; i < 4; i += 1) {
    await devicePhaseB.evaluate(`document.querySelectorAll('.fish-card')[${i}].click()`);
    await sleep(120);
    stageLabels.push(await devicePhaseB.evaluate(`document.getElementById('detail-type').textContent`));
  }
  check('四阶段在界面上可辨认', ['鱼苗期', '幼鱼期', '亚成年期', '成年期'].every((n, i) => stageLabels[i].includes(n)),
    stageLabels.join(' / '));

  // 布景编辑：新增石头 → 转向 → 换造型 → 撤销 → 确认
  await devicePhaseB.click('#mode-decor');
  check('可以进入布景模式', (await devicePhaseB.evaluate('window.__mofish?.editMode')) === 'decor');
  const decorBefore = await devicePhaseB.evaluate('window.__mofish.state.decor.length');
  await devicePhaseB.click('#add-rock');
  const decorAfter = await devicePhaseB.evaluate('window.__mofish.state.decor.length');
  check('新增造景进入场景并等待确认', decorAfter === decorBefore + 1 && (await devicePhaseB.evaluate('!document.getElementById("decor-pending-actions").hidden')));
  check('新造景立即高亮且只指向当前物件', await devicePhaseB.evaluate(`(()=>{const f=window.__mofish.selectionFeedback;return f.visible && f.id===window.__mofish.state.decor.at(-1).id && f.intensity>0.5;})()`));
  check('造景实际几何底部贴合起伏沙面', await devicePhaseB.evaluate(`(()=>{const f=window.__mofish.selectionFeedback;return Math.abs(f.bottomY-f.sandY)<1e-6;})()`));
  await devicePhaseB.evaluate(`window.scrollTo(0,0);new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))`);
  await devicePhaseB.shot('09-selected-rock-desktop.png');
  const rotBefore = await devicePhaseB.evaluate('window.__mofish.state.decor[0]?.rot');
  await devicePhaseB.click('#decor-rotate');
  const rotAfter = await devicePhaseB.evaluate('window.__mofish.state.decor[0]?.rot');
  check('旋转按钮改变角度', Math.abs(rotAfter - rotBefore) > 0.01);
  const seedBefore = await devicePhaseB.evaluate('window.__mofish.state.decor[0]?.seed');
  await devicePhaseB.click('#decor-reshuffle');
  const seedAfter = await devicePhaseB.evaluate('window.__mofish.state.decor[0]?.seed');
  check('换个造型只改 seed', seedBefore !== seedAfter);
  check('换造型重建后仍高亮当前物件', await devicePhaseB.evaluate(`window.__mofish.selectionFeedback.visible && window.__mofish.selectionFeedback.id === window.__mofish.selectedDecor && window.__mofish.selectionFeedback.intensity > 0.5`));
  await devicePhaseB.click('#decor-confirm');
  // 撤销一次回到「换造型」之前（seed 恢复），再撤销一次回到「旋转」之前（角度恢复）
  await devicePhaseB.click('#decor-undo');
  check('撤销恢复上一个造型', (await devicePhaseB.evaluate('window.__mofish.state.decor[0]?.seed')) === seedBefore);
  await devicePhaseB.click('#decor-undo');
  check('再撤销一次回到旋转前', Math.abs((await devicePhaseB.evaluate('window.__mofish.state.decor[0]?.rot')) - rotBefore) < 1e-6);
  const savedDecor = await devicePhaseB.evaluate(`JSON.parse(localStorage.getItem('mofish.v1')).decor.length`);
  check('布景改动写入本机存档', savedDecor === decorAfter, `存档=${savedDecor}`);

  // 浮动工具条：小屏上面板可能在折叠区，底部浮动条必须真的可用（曾漏绑事件）
  await devicePhaseB.click('#add-rock');
  const floatCount = await devicePhaseB.evaluate('window.__mofish.state.decor.length');
  const floatRot0 = await devicePhaseB.evaluate('window.__mofish.state.decor.at(-1).rot');
  await devicePhaseB.click('#decor-float [data-decor-action="rotate"]');
  const floatRot1 = await devicePhaseB.evaluate('window.__mofish.state.decor.at(-1).rot');
  check('浮动工具条可以转向', Math.abs(floatRot1 - floatRot0) > 0.01, `${floatRot0} → ${floatRot1}`);
  await devicePhaseB.click('#float-confirm');
  check('浮动条“放在这里”生效', await devicePhaseB.evaluate('document.getElementById("decor-pending-actions").hidden === true'));
  await devicePhaseB.click('#add-rock');
  await devicePhaseB.click('#float-cancel');
  const floatAfterCancel = await devicePhaseB.evaluate('window.__mofish.state.decor.length');
  check('浮动条“取消”移除待确认物件', floatAfterCancel === floatCount,
    `取消前=${floatCount + 1}，取消后=${floatAfterCancel}`);
  check('取消后待确认按钮不再残留', await devicePhaseB.evaluate('document.getElementById("float-cancel").hidden === true'));
  check('取消新物件后清除高亮', await devicePhaseB.evaluate(`!window.__mofish.selectionFeedback.visible && window.__mofish.selectionFeedback.id === null`));

  await devicePhaseB.click('#add-rock');
  await devicePhaseB.click('#float-confirm');
  const beforeNudge = await devicePhaseB.evaluate('window.__mofish.state.decor.at(-1).x');
  await devicePhaseB.click('[data-decor-nudge="0.025,0"]');
  const nudged = await devicePhaseB.evaluate('window.__mofish.state.decor.at(-1).x');
  check('触屏方向按钮可移动造景', nudged > beforeNudge);
  await devicePhaseB.click('#decor-undo');
  check('方向微调一次撤销即可恢复', Math.abs((await devicePhaseB.evaluate('window.__mofish.state.decor.at(-1).x')) - beforeNudge) < 1e-6);
  check('取消按钮隐藏时不占据可点击布局', await devicePhaseB.evaluate(`document.getElementById('float-cancel').getClientRects().length === 0`));
  check('工具条位于鱼缸内', await devicePhaseB.evaluate(`(()=>{const a=document.getElementById('aquarium').getBoundingClientRect(), b=document.getElementById('decor-float').getBoundingClientRect();return b.top >= a.top && b.bottom <= a.bottom;})()`));
  const beforeFinish = await devicePhaseB.evaluate('JSON.stringify(window.__mofish.state.decor)');
  check('已选中造景显示完成布景按钮', await devicePhaseB.evaluate(`!document.getElementById('float-confirm').hidden && document.getElementById('float-confirm').textContent === '完成布景'`));
  await devicePhaseB.click('#float-confirm');
  check('完成布景收起工具条、取消选中并回到观赏', await devicePhaseB.evaluate(`window.__mofish.editMode === 'view' && window.__mofish.selectedDecor === null && document.getElementById('decor-float').hidden`));
  check('完成布景保留刚才的造景调整', (await devicePhaseB.evaluate('JSON.stringify(window.__mofish.state.decor)')) === beforeFinish);
  check('完成布景后恢复正常外观并隐藏定位圈', await devicePhaseB.evaluate(`!window.__mofish.selectionFeedback.visible && window.__mofish.selectionFeedback.id === null`));

  // 高水草与手机窄屏的实际渲染截图；仍属桌面浏览器仿真，不能当真机验收。
  await devicePhaseB.click('#add-plant');
  await devicePhaseB.evaluate(`window.scrollTo(0,0);new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))`);
  await devicePhaseB.shot('10-selected-plant-desktop.png');
  await devicePhaseB.setViewport(390, 844);
  await devicePhaseB.evaluate(`window.scrollTo(0,0);new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))`);
  await sleep(350);
  await devicePhaseB.shot('11-selected-plant-mobile.png');
  check('窄屏新增水草仍保持当前物件高亮', await devicePhaseB.evaluate(`window.__mofish.selectionFeedback.visible && window.__mofish.selectionFeedback.id === window.__mofish.state.decor.at(-1).id`));
  check('窄屏工具条位于画面下方，不遮住当前造景', await devicePhaseB.evaluate(`document.getElementById('decor-float').getBoundingClientRect().top >= document.getElementById('tank').getBoundingClientRect().bottom`));
  await devicePhaseB.click('#float-cancel');
  await devicePhaseB.setViewport(1440, 900, false);

  // 放置取消/退出与纯动画互动的回归：不让临时物件通过撤销复活。
  await devicePhaseB.click('#add-rock');
  const canceledDecorId = await devicePhaseB.evaluate('window.__mofish.selectedDecor');
  await devicePhaseB.click('#decor-float [data-decor-action="rotate"]');
  await devicePhaseB.click('#float-cancel');
  await devicePhaseB.click('#decor-undo');
  check('取消后撤销不会复活待放置物件', await devicePhaseB.evaluate(`!window.__mofish.state.decor.some(d=>d.id===${JSON.stringify(canceledDecorId)})`));
  await devicePhaseB.click('#add-plant');
  const retainedDecorId = await devicePhaseB.evaluate('window.__mofish.selectedDecor');
  await devicePhaseB.click('#mode-view');
  check('离开布景会确认并保存当前位置', await devicePhaseB.evaluate(`window.__mofish.editMode==='view' && JSON.parse(localStorage.getItem('mofish.v1')).decor.some(d=>d.id===${JSON.stringify(retainedDecorId)})`));
  const beforePlay = await devicePhaseB.evaluate('JSON.stringify(window.__mofish.state.fish)');
  await devicePhaseB.click('#play-mode');
  check('逗鱼按钮与实际互动模式同步', await devicePhaseB.evaluate(`window.__mofish.playMode && document.getElementById('play-mode').getAttribute('aria-pressed')==='true'`));
  const tankBox = await devicePhaseB.box('#tank');
  await devicePhaseB.send('Input.dispatchMouseEvent',{type:'mouseMoved',x:tankBox.x,y:tankBox.y});
  await sleep(700);
  check('鼠标移动启动跟手互动', await devicePhaseB.evaluate('window.__mofish.motionInfo.lureActive'));
  check('逗鱼不生成食物或修改鱼的持久状态', await devicePhaseB.evaluate(`window.__mofish.motionInfo.foodCount===0 && JSON.stringify(window.__mofish.state.fish)===${JSON.stringify(beforePlay)}`));
  await devicePhaseB.click('#mode-decor');
  check('进入布景会关闭逗鱼且恢复按钮状态', await devicePhaseB.evaluate(`!window.__mofish.playMode && document.getElementById('play-mode').getAttribute('aria-pressed')==='false'`));
  await devicePhaseB.click('#mode-view');
  await devicePhaseB.click('#sound');
  check('水声可由真实按钮点击启用',await devicePhaseB.evaluate(`window.__mofish.state.sound && document.getElementById('sound').getAttribute('aria-pressed')==='true'`));
  await devicePhaseB.click('#sound');
  check('关闭水声会恢复关闭状态',await devicePhaseB.evaluate(`!window.__mofish.state.sound && document.getElementById('sound').getAttribute('aria-pressed')==='false'`));

  // 2D 降级与画质
  await devicePhaseB.click('#toggle-2d');
  await sleep(900);
  check('可以切到 2D 降级渲染', (await devicePhaseB.evaluate('window.__mofish?.renderer')) === '2d');
  check('2D 下布景编辑按钮被禁用（避免误操作）', await devicePhaseB.evaluate('document.getElementById("mode-decor").disabled'));
  await devicePhaseB.shot('07-2d-fallback.png');
  await devicePhaseB.click('#toggle-2d');
  await sleep(1200);
  check('可以切回 3D', (await devicePhaseB.evaluate('window.__mofish?.renderer')) === '3d');
  await devicePhaseB.evaluate(`(()=>{const q=document.getElementById('quality');q.value='low';q.dispatchEvent(new Event('change'));return q.value;})()`);
  await sleep(1600);
  check('可以切到低画质且不报错', (await devicePhaseB.evaluate('window.__mofish?.quality')) === 'low');
  await devicePhaseB.evaluate(`(()=>{const q=document.getElementById('quality');q.value='high';q.dispatchEvent(new Event('change'));return q.value;})()`);
  await sleep(1600);

  await devicePhaseB.evaluate(`(()=>{const q=document.getElementById('quality');q.value='low';q.dispatchEvent(new Event('change'));})()`);
  await sleep(700);

  // 夜间
  await devicePhaseB.click('#night');
  check('夜间模式写入存档', (await devicePhaseB.evaluate('window.__mofish.state.night')) === true);
  await devicePhaseB.click('#night');

  // 喂食：鱼真的吃到才算成长（游客模式本机记账）
  const mealsBefore = await devicePhaseB.evaluate('window.__mofish.state.fish.reduce((s,f)=>s+f.meals,0)');
  await devicePhaseB.click('#feed');
  const feedDeadline = Date.now() + 30000;
  let mealsAfter = mealsBefore;
  while (mealsAfter === mealsBefore && Date.now() < feedDeadline) {
    await sleep(400);
    mealsAfter = await devicePhaseB.evaluate('window.__mofish.state.fish.reduce((s,f)=>s+f.meals,0)');
  }
  check('小鱼吃到食物后才记进食', mealsAfter > mealsBefore, `${mealsBefore} → ${mealsAfter}`);
  await devicePhaseB.shot('08-desktop-phase-b.png');

  // 布景撤销只能影响造景，不能撤回后来的改名/成长，更不能跨身份恢复快照。
  await devicePhaseB.click('#add-rock');
  await devicePhaseB.click('#float-confirm');
  await devicePhaseB.click('#decor-rotate');
  await devicePhaseB.click('.fish-card');
  await devicePhaseB.click('#detail-rename');
  await devicePhaseB.type('#fish-name', '撤销不改鱼名');
  await devicePhaseB.click('#rename');
  await devicePhaseB.click('#decor-undo');
  check('布景撤销保留之后的鱼名和进食记录', await devicePhaseB.evaluate(`window.__mofish.state.fish[0].name === '撤销不改鱼名' && window.__mofish.state.fish.reduce((s,f)=>s+f.meals,0) >= ${mealsAfter}`));

  await devicePhaseB.click('#account-button');
  await devicePhaseB.type('#auth-email', 'alice@example.com');
  await devicePhaseB.type('#auth-password', 'goodpassword123');
  await devicePhaseB.click('#auth-sign-in');
  await waitFor(devicePhaseB, `!document.getElementById('conflict-box').hidden || document.getElementById('cloud-status').textContent === '已同步'`);
  if (await devicePhaseB.evaluate(`!document.getElementById('conflict-box').hidden`)) {
    await devicePhaseB.click('#conflict-keep-cloud');
  }
  await waitFor(devicePhaseB, `document.getElementById('cloud-status').textContent === '已同步'`);
  await devicePhaseB.evaluate(`document.getElementById('account-dialog').close()`);
  const accountFishIds = await devicePhaseB.evaluate(`window.__mofish.state.fish.map(f=>f.id).join(',')`);
  await devicePhaseB.click('#mode-decor');
  await devicePhaseB.evaluate(`document.getElementById('decor-undo').click()`);
  check('切换身份后撤销不能恢复上一份鱼缸', (await devicePhaseB.evaluate(`window.__mofish.state.fish.map(f=>f.id).join(',')`)) === accountFishIds);

  const beforeLoss = await devicePhaseB.evaluate('JSON.stringify(window.__mofish.state.fish)');
  await devicePhaseB.evaluate(`(()=>{const gl=document.getElementById('tank').getContext('webgl2');gl.getExtension('WEBGL_lose_context').loseContext();})()`);
  await waitFor(devicePhaseB, `window.__mofish.renderer === '2d'`);
  check('实际触发 WebGL 上下文丢失后切换到 2D', await devicePhaseB.evaluate(`window.__mofish.renderer === '2d'`));
  check('上下文丢失后鱼的持久状态保留', (await devicePhaseB.evaluate('JSON.stringify(window.__mofish.state.fish)')) === beforeLoss);

  const phaseBErrors = devicePhaseB.errors().filter(e => !/Failed to load resource/.test(e));
  check('阶段 B 没有前端异常', phaseBErrors.length === 0, phaseBErrors.slice(0, 3).join(' | '));

  // 汇总
  const failed = results.filter(r => !r.ok);
  console.log(`\n=== 端到端结果：${results.length - failed.length}/${results.length} 通过 ===`);
  if (failed.length) {
    console.log('失败项：');
    for (const f of failed) console.log(` - ${f.name}${f.detail ? ` (${f.detail})` : ''}`);
  }
  writeFileSync(path.join(RUN_DIR, 'result.json'), JSON.stringify(results, null, 2));
  return failed.length;
}

let cleanupPromise;
function cleanup() {
  if (cleanupPromise) return cleanupPromise;
  cleanupPromise = (async () => {
  try { await browserWs?.send('Browser.close'); } catch {}
  for (const ws of sockets) { try { ws.close(); } catch {} }
  if (chrome?.pid && chrome.exitCode === null && chrome.signalCode === null) {
    chrome.kill('SIGTERM');
    await Promise.race([new Promise(resolve => chrome.once('exit', resolve)), sleep(2000)]);
    if (chrome.exitCode === null && chrome.signalCode === null) {
      chrome.kill('SIGKILL');
      await Promise.race([new Promise(resolve => chrome.once('exit', resolve)), sleep(2000)]);
    }
  }
  try { await preview?.close(); } catch {}
  try { await fakeServer?.close(); } catch {}
  rmSync(PROFILE, { recursive: true, force: true });
  if (process.argv.includes('--keep') || process.exitCode) {
    console.log(`保留本轮测试证据：${RUN_DIR}（浏览器已关闭，profile 已清理）`);
  } else {
    rmSync(RUN_DIR, { recursive: true, force: true });
    console.log('已关闭本轮浏览器与服务，清理临时目录。');
  }
  })();
  return cleanupPromise;
}
for (const [signal, code] of [['SIGINT', 130], ['SIGTERM', 143]]) {
  process.once(signal, () => {
    process.exitCode = code;
    void cleanup().finally(() => process.exit(code));
  });
}

try {
  const failed = await main();
  process.exitCode = failed ? 1 : 0;
} catch (err) {
  console.error('端到端执行失败：', err);
  process.exitCode = 1;
} finally {
  await cleanup();
}
