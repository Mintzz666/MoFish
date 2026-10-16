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
//      node tests/e2e/cloud-e2e.mjs --keep     （保留截图与打开的浏览器）

import { spawn, execFileSync } from 'node:child_process';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createFakeSupabase, makeAccessToken } from '../fake-supabase/supabase-fake.mjs';
import { startFakeServer } from '../fake-supabase/server.mjs';
import { startPreviewServer } from '../../scripts/serve.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../..');
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const SHOTS = '/tmp/mofish-e2e';
mkdirSync(SHOTS, { recursive: true });

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
  const pending = new Map();
  const events = [];
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++msgId;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
  await new Promise(r => ws.addEventListener('open', r));
  ws.addEventListener('message', ev => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) {
      const p = pending.get(m.id); pending.delete(m.id);
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
          || (e.method === 'Runtime.consoleAPICalled' && e.params.type === 'error'))
        .map(e => e.method === 'Log.entryAdded' ? e.params.entry.text : (e.params.args || []).map(a => a.value || a.description).join(' '));
    }
  };
  return page;
}

async function newContextPage(browserWs, label) {
  const { browserContextId } = await browserWs.send('Target.createBrowserContext', { disposeOnDetach: false });
  const { targetId } = await browserWs.send('Target.createTarget', { url: 'about:blank', browserContextId });
  const list = await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`)).json();
  const target = list.find(t => t.id === targetId);
  const page = await connect(target.webSocketDebuggerUrl);
  page.label = label;
  page.contextId = browserContextId;
  return page;
}

const DEBUG_PORT = 9334;
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

  // 2) Chrome（清理上次残留的 profile，避免单例锁导致新实例不监听端口）
  rmSync('/tmp/mofish-e2e-chrome', { recursive: true, force: true });
  chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--hide-scrollbars',
    // 自动化下必须关掉后台节流，否则隐藏页面的 setTimeout（去抖写入）会被推迟到 3 秒以上，
    // 让「等待去抖窗口」的断言变成随机失败。
    '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding',
    `--remote-debugging-port=${DEBUG_PORT}`, '--user-data-dir=/tmp/mofish-e2e-chrome', 'about:blank'],
    { stdio: 'ignore', detached: false });
  let version = null;
  for (let i = 0; i < 40 && !version; i++) {
    await sleep(400);
    try { version = await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/version`)).json(); } catch { /* 还没起来 */ }
  }
  if (!version) throw new Error(`Chrome 未在 ${DEBUG_PORT} 上启动（headless 调试端口不可达）`);

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
  await deviceA.evaluate(`document.getElementById('fish-name').value='阿花'`);
  await deviceA.click('#rename');
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
  await sleep(1400);
  const nameOnB = await deviceB.evaluate(`document.querySelector('.fish-card b').textContent`);
  const chipOnB = await deviceB.evaluate(`document.getElementById('cloud-status').textContent`);
  check('设备 B 登录后恢复云端鱼名', nameOnB === '阿花', `B 显示=${nameOnB}`);
  check('设备 B 状态为已同步', chipOnB === '已同步', `chip=${chipOnB}`);
  await deviceB.evaluate(`document.getElementById('account-dialog').close()`);

  // ---- 场景 5：同 revision 冲突与两种处理 ----
  await deviceA.front();
  await deviceA.click('.fish-card');
  await deviceA.evaluate(`document.getElementById('fish-name').value='A 改的'`);
  await deviceA.click('#rename');
  await sleep(3200);

  await deviceB.front();
  await deviceB.click('.fish-card');
  await deviceB.evaluate(`document.getElementById('fish-name').value='B 改的'`);
  await deviceB.click('#rename');
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
  await sleep(1800);

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
  await sleep(1800);

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
  await deviceC.evaluate(`document.getElementById('fish-name').value='离线改的名字'`);
  await deviceC.click('#rename');
  await sleep(3600);   // 等过离线状态下的去抖写入尝试
  const offlineChip = await deviceC.evaluate(`document.getElementById('cloud-status').textContent`);
  check('离线时状态显示为离线', offlineChip === '离线', `chip=${offlineChip}`);
  const pendingKeys = await deviceC.evaluate(`(()=>{const out=[];for(let i=0;i<localStorage.length;i++){const k=String(localStorage.key(i));if(k.includes('pending'))out.push(k);}return out;})()`);
  check('离线改动以未同步副本存在本机', pendingKeys.length === 1, `pending 键=${pendingKeys.join(',')}`);

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
  check('服务端结算 1 小时成长（+0.008）', Math.abs(afterGrowth - (beforeGrowth + 0.008)) < 1e-6, `${beforeGrowth} → ${afterGrowth}`);
  check('重复同步不会重复奖励', afterSecond === afterGrowth, `${afterGrowth} → ${afterSecond}`);

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
    const layout = JSON.parse(await deviceC.evaluate(`JSON.stringify({scrollW:document.documentElement.scrollWidth,inner:innerWidth,chip:document.getElementById('cloud-status').textContent,headerRight:document.querySelector('.header-right').getBoundingClientRect().right})`));
    check(`${w}px 无横向溢出`, layout.scrollW <= layout.inner, JSON.stringify(layout));
    await deviceC.click('#account-button');
    const dialogFits = JSON.parse(await deviceC.evaluate(`(()=>{const r=document.getElementById('account-dialog').getBoundingClientRect();return JSON.stringify({l:r.left,r:r.right,w:r.width,scrollW:document.documentElement.scrollWidth,inner:innerWidth,open:document.getElementById('account-dialog').open})})()`));
    check(`${w}px 账号面板完整可见且不溢出`, dialogFits.open && dialogFits.l >= 0 && dialogFits.r <= dialogFits.inner, JSON.stringify(dialogFits));
    await deviceC.shot(`${name}-account.png`);
    await deviceC.evaluate(`document.getElementById('account-dialog').close()`);
    await deviceC.shot(`${name}-tank.png`);
  }

  // 汇总
  const failed = results.filter(r => !r.ok);
  console.log(`\n=== 端到端结果：${results.length - failed.length}/${results.length} 通过 ===`);
  if (failed.length) {
    console.log('失败项：');
    for (const f of failed) console.log(` - ${f.name}${f.detail ? ` (${f.detail})` : ''}`);
  }
  console.log(`截图目录：${SHOTS}`);
  writeFileSync('/tmp/mofish-e2e-result.json', JSON.stringify(results, null, 2));
  return failed.length;
}

try {
  const failed = await main();
  process.exitCode = failed ? 1 : 0;
} catch (err) {
  console.error('端到端执行失败：', err);
  process.exitCode = 1;
} finally {
  try { await preview?.close(); } catch {}
  try { await fakeServer?.close(); } catch {}
  try { chrome?.kill(); } catch {}
}
