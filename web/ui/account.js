// 账号界面：登录 / 注册 / 忘记密码 / 邮箱验证后设置新密码 / 退出 / 冲突处理。
//
// 约定：
// - 不用框架、不拼 innerHTML 用户内容（仅用 textContent 与固定模板），避免把用户输入当 HTML 注入。
// - 所有网络动作都交给 web/cloud/auth.js 与同步引擎；本文件只负责表单、提示与状态呈现。
// - 未配置云端时表单保持可见但禁用，并明确说明原因，而不是假装可登录。

import { validateCredentials } from '../cloud/auth.js';
import { STATUS, describeStatus } from '../cloud/sync.js';

const STATUS_SHORT = {
  [STATUS.GUEST]: '游客',
  [STATUS.CLOUD_OFF]: '未连接云端',
  [STATUS.OFFLINE]: '离线',
  [STATUS.SYNCING]: '同步中',
  [STATUS.SYNCED]: '已同步',
  [STATUS.ERROR]: '同步失败',
  [STATUS.CONFLICT]: '有冲突',
  [STATUS.SIGNED_OUT]: '登录已失效'
};

export function createAccountUI({ auth, engine, store, config, onSessionChange = () => {} , doc = document }) {
  const $ = (id) => doc.getElementById(id);
  const cloudReady = config?.mode === 'ready';

  const els = {
    button: $('account-button'),
    chip: $('cloud-status'),
    dialog: $('account-dialog'),
    tabs: [...doc.querySelectorAll('[data-auth-tab]')],
    authPanel: $('auth-panel'),
    sessionPanel: $('session-panel'),
    resetPanel: $('reset-panel'),
    email: $('auth-email'),
    password: $('auth-password'),
    signIn: $('auth-sign-in'),
    signUp: $('auth-sign-up'),
    forgot: $('auth-forgot'),
    resend: $('auth-resend'),
    notice: $('account-notice'),
    accountTitle: $('account-title'),
    cloudOff: $('cloud-off-note'),
    sessionEmail: $('session-email'),
    sessionDetail: $('session-detail'),
    syncNow: $('session-sync-now'),
    signOut: $('session-sign-out'),
    forget: $('session-forget'),
    conflictBox: $('conflict-box'),
    conflictSummary: $('conflict-summary'),
    conflictKeepCloud: $('conflict-keep-cloud'),
    conflictKeepLocal: $('conflict-keep-local'),
    conflictLater: $('conflict-later'),
    backups: $('backups-box'),
    backupList: $('backup-list'),
    backupExport: $('backup-export'),
    newPassword: $('reset-password'),
    savePassword: $('reset-save'),
    resetLater: $('reset-later'),
    resetHint: $('reset-hint')
  };

  let activeTab = 'signin';
  let notice = null;
  // 界面操作代次：登录/退出/回调都会 +1，晚到的响应若已经过期就丢弃，
  // 避免「换号后旧请求把上一个账号的状态写进界面」。
  let opToken = 0;
  // 'auto' = 按登录状态显示；'reset' = 正在处理重置密码链接（会一直保留到改密成功或用户推迟）。
  let view = 'auto';

  function isStale(token) { return token !== opToken; }

  function readFlow() {
    try { return store.readAuthFlow?.() || null; } catch { return null; }
  }

  // 刷新页面后仍要回到「请设置新密码」：把待处理的链接状态记在本机（评审 P1-4）。
  if (readFlow()?.type === 'recovery') view = 'reset';

  function openDialog() {
    if (!els.dialog) return;
    if (!els.dialog.open) els.dialog.showModal();
  }

  function setNotice(text, kind = 'info') {
    notice = text ? { text, kind } : null;
    if (!els.notice) return;
    els.notice.textContent = text || '';
    els.notice.dataset.kind = kind;
    els.notice.hidden = !text;
  }

  function setTab(tab) {
    activeTab = tab;
    for (const el of els.tabs) el.setAttribute('aria-selected', String(el.dataset.authTab === tab));
    for (const el of doc.querySelectorAll('[data-auth-section]')) {
      el.hidden = el.dataset.authSection !== tab;
    }
    setNotice(null);
  }

  function renderChip() {
    const snap = engine.snapshot;
    const short = STATUS_SHORT[snap.status] || '未知';
    if (els.chip) {
      els.chip.textContent = short;
      els.chip.dataset.status = snap.status;
      els.chip.title = `${describeStatus(snap.status)}${snap.user ? ` · ${snap.user.email}` : ''}${snap.message ? ` · ${snap.message}` : ''}`;
    }
    if (els.button) {
      els.button.textContent = snap.user ? '账号' : (cloudReady ? '登录 / 注册' : '账号');
      els.button.title = snap.user ? `已登录：${snap.user.email}` : '登录后可跨设备保存鱼缸';
    }
  }

  function renderConflict() {
    const detail = engine.conflictDetail();
    if (!els.conflictBox) return;
    els.conflictBox.hidden = !detail;
    if (!detail) return;
    const lines = [
      detail.reason === 'guest_import'
        ? '这台设备上有一份旧的本地鱼缸，云端账号里也有一份存档。'
        : detail.reason === 'pending'
          ? '本机有还没同步的修改，云端也有新内容。'
          : '云端存档已被其它设备改过（revision 不一致）。',
      `本机：${detail.localFish.map(f => `${f.name}(${Math.round(f.growth * 100)}%, ${f.meals}口)`).join('、') || '（无）'}`,
      detail.cloudKnown
        ? `云端：${detail.cloudFish.map(f => `${f.name}(${Math.round(f.growth * 100)}%, ${f.meals}口)`).join('、') || '（无）'}`
        : '云端：内容尚未读取，选择任意一项时都会先取回云端最新版本。'
    ];
    els.conflictSummary.textContent = lines.join('\n');
  }

  function renderBackups() {
    const snap = engine.snapshot;
    if (!els.backups) return;
    const list = snap.user && snap.aquariumId ? store.listBackups(snap.user.id, snap.aquariumId).filter(b => b.state) : [];
    els.backups.hidden = list.length === 0;
    if (!list.length) return;
    els.backupList.replaceChildren();
    for (const entry of list.slice().reverse()) {
      const li = doc.createElement('li');
      const label = doc.createElement('span');
      const stamp = Number(entry.stamp);
      label.textContent = Number.isFinite(stamp)
        ? new Date(stamp).toLocaleString('zh-CN', { hour12: false })
        : String(entry.stamp);
      const detail = doc.createElement('small');
      detail.textContent = `${entry.state.fish.length} 条鱼 · ${entry.state.plants} 株水草`;
      li.append(label, detail);
      li.dataset.backupKey = entry.key;
      els.backupList.append(li);
    }
  }

  function renderSections() {
    const snap = engine.snapshot;
    const signedIn = Boolean(snap.user);
    const showReset = view === 'reset';
    // 重置密码期间：只显示改密面板（登录/注册表单与账号面板都让位），
    // 但会话本身是有效的，所以仍然保留用户信息与冲突区，改完密码即可继续。
    if (els.authPanel) els.authPanel.hidden = showReset || signedIn;
    if (els.sessionPanel) els.sessionPanel.hidden = showReset || !signedIn;
    if (els.resetPanel) els.resetPanel.hidden = !showReset;
    if (showReset && els.resetHint) {
      const flow = readFlow();
      els.resetHint.textContent = flow?.email
        ? `为 ${flow.email} 设置新密码（至少 6 位）。链接对应的登录状态已经生效。`
        : '请设置一个新密码（至少 6 位）。';
    }
    if (els.accountTitle) els.accountTitle.textContent = showReset ? '设置新密码' : '把小鱼带到别的设备';

    if (els.cloudOff) {
      els.cloudOff.hidden = cloudReady;
      els.cloudOff.textContent = cloudReady
        ? ''
        : `未连接云端：${config?.problems?.join('；') || '未配置项目地址与公开 key'}。你现在可以在本机游玩，配置见 docs/CLOUD-SETUP.md。`;
    }
    for (const el of [els.email, els.password, els.signIn, els.signUp, els.forgot]) {
      if (el) el.disabled = !cloudReady;
    }

    if (signedIn && !showReset) {
      els.sessionEmail.textContent = snap.user.email;
      const parts = [describeStatus(snap.status)];
      if (snap.revision) parts.push(`revision ${snap.revision}`);
      if (snap.status === STATUS.OFFLINE) parts.push('联网后会自动同步');
      if (snap.dirty && snap.status !== STATUS.OFFLINE) parts.push('本机有未上传的改动');
      els.sessionDetail.textContent = parts.join(' · ');
      if (els.syncNow) els.syncNow.disabled = snap.status === STATUS.SYNCING || Boolean(snap.conflict);
    }
    renderConflict();
    renderBackups();
    renderChip();
  }

  function render() {
    renderSections();
  }

  async function guard(action) {
    try {
      const result = await action();
      return result;
    } catch (err) {
      setNotice(`操作失败：${err?.message || '未知错误'}`, 'error');
      return { ok: false };
    }
  }

  function requireEmail() {
    const email = els.email?.value || '';
    const local = validateCredentials({ email }, { requirePassword: false });
    if (local) { setNotice(local.message, 'error'); return null; }
    return email.trim();
  }

  async function doSignIn() {
    const email = requireEmail();
    if (!email) return;
    const password = els.password?.value || '';
    const local = validateCredentials({ email, password });
    if (local) { setNotice(local.message, 'error'); return; }

    const token = ++opToken;
    if (els.signIn) els.signIn.disabled = true;
    setNotice('正在登录…');
    const res = await guard(() => auth.signIn({ email, password }));
    if (isStale(token)) return;                  // 期间已退出或换了账号：丢弃这次响应
    if (els.signIn) els.signIn.disabled = !cloudReady;
    if (!res || !res.ok) {
      const code = res?.error?.code;
      const extra = code === 'email_not_confirmed' ? '（可点下方“重发验证邮件”）' : '';
      setNotice(`${res?.error?.message || '登录失败'}${extra}`, 'error');
      if (els.resend) els.resend.hidden = code !== 'email_not_confirmed';
      return;
    }
    if (els.resend) els.resend.hidden = true;
    if (els.password) els.password.value = '';
    setNotice('已登录，正在对齐云端存档…');
    const outcome = await engine.setSession(res.session);
    if (isStale(token)) return;
    view = 'auto';
    store.clearAuthFlow?.();
    onSessionChange(res.session);
    if (outcome?.conflict) setNotice('登录成功，但本机与云端各有一份存档，请选择保留哪一份。', 'warn');
    else if (outcome?.offline) setNotice('已登录，但当前连不上云端，先用本机存档继续。', 'warn');
    else setNotice('已登录，云端存档已对齐。');
    render();
  }

  async function doSignUp() {
    const email = requireEmail();
    if (!email) return;
    const password = els.password?.value || '';
    const local = validateCredentials({ email, password });
    if (local) { setNotice(local.message, 'error'); return; }

    const token = ++opToken;
    if (els.signUp) els.signUp.disabled = true;
    setNotice('正在创建账号…');
    const res = await guard(() => auth.signUp({ email, password }));
    if (isStale(token)) return;
    if (els.signUp) els.signUp.disabled = !cloudReady;
    if (!res || !res.ok) {
      setNotice(res?.error?.message || '注册失败', 'error');
      return;
    }
    if (els.password) els.password.value = '';
    if (res.needsConfirmation) {
      setTab('signin');
      setNotice('验证邮件已发出，请点开邮件里的链接完成验证，然后回来登录。', 'ok');
      return;
    }
    const outcome = await engine.setSession(res.session);
    if (isStale(token)) return;
    view = 'auto';
    onSessionChange(res.session);
    setNotice(outcome?.conflict ? '注册成功，但需要先选择保留哪一份存档。' : '注册成功，云端存档已建立。', 'ok');
    render();
  }

  async function doForgot() {
    const email = requireEmail();
    if (!email) return;
    setNotice('正在发送重置邮件…');
    const res = await guard(() => auth.requestPasswordReset(email));
    // 无论邮箱是否存在都给出同样的提示，避免暴露账号是否存在。
    setNotice(res?.ok ? '如果这个邮箱已经注册，重置密码的邮件已经发出。' : (res?.error?.message || '发送失败'),
      res?.ok ? 'ok' : 'error');
  }

  async function doResend() {
    const email = requireEmail();
    if (!email) return;
    const res = await guard(() => auth.resendConfirmation(email));
    setNotice(res?.ok ? '验证邮件已重新发送。' : (res?.error?.message || '发送失败'), res?.ok ? 'ok' : 'error');
  }

  async function doSynNow() {
    setNotice('正在同步…');
    const res = await engine.syncNow({ reason: 'manual' });
    if (res?.skipped === 'unchanged') setNotice('没有需要同步的改动。', 'ok');
    else if (res?.ok) setNotice('已同步到云端。', 'ok');
    else if (res?.result?.message) setNotice(res.result.message, 'error');
    else setNotice('同步没有完成，改动仍保存在本机。', 'warn');
    render();
  }

  async function doSignOut() {
    const token = ++opToken;            // 让所有在途的登录/回调响应立即作废
    const res = await guard(() => auth.signOut());
    if (isStale(token)) return;
    await engine.setSession(null);
    if (isStale(token)) return;
    view = 'auto';
    store.clearAuthFlow?.();            // 重置链接状态跟着会话一起失效
    onSessionChange(null);
    setNotice(res?.remoteOk === false ? '已在本机退出（远端会话可能仍然有效）。' : '已退出登录，回到本机存档。', 'ok');
    render();
  }

  function doForget() {
    const snap = engine.snapshot;
    if (!snap.user) return;
    const removed = store.forgetUser(snap.user.id);
    setNotice(`已清除这个账号在本机的 ${removed} 项缓存（云端存档不受影响）。`, 'ok');
    render();
  }

  async function doConflict(choice) {
    setNotice('正在处理…');
    const res = await engine.resolveConflict(choice);
    if (res?.skipped === 'later') { setNotice('已保留现状，稍后再处理。', 'warn'); render(); return; }
    if (res?.ok) {
      setNotice(choice === 'local' ? '已用本机存档更新云端。' : '已采用云端存档，本机改动留了备份。', 'ok');
    } else {
      setNotice(res?.result?.message || '处理没有完成，两份存档都还在。', 'error');
    }
    render();
  }

  function doBackupExport() {
    const snap = engine.snapshot;
    if (!snap.user || !snap.aquariumId) return;
    const list = store.listBackups(snap.user.id, snap.aquariumId);
    const usable = list[list.length - 1];
    if (!usable?.state) { setNotice('没有可导出的备份。', 'warn'); return; }
    const blob = new Blob([JSON.stringify(usable.state, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = doc.createElement('a');
    link.href = url;
    link.download = `mofish-backup-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.json`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    setNotice('备份已导出为 JSON，可用“导入存档”恢复。', 'ok');
  }

  async function doSavePassword() {
    const password = els.newPassword?.value || '';
    const local = validateCredentials({ email: 'placeholder@example.com', password });
    if (local) { setNotice(local.message, 'error'); return; }
    const token = ++opToken;
    setNotice('正在设置新密码…');
    const res = await guard(() => auth.updatePassword(password));
    if (isStale(token)) return;
    if (!res?.ok) { setNotice(res?.error?.message || '设置失败，请重新申请重置邮件', 'error'); return; }
    if (els.newPassword) els.newPassword.value = '';
    store.clearAuthFlow?.();
    view = 'auto';
    const session = await auth.getSession();
    if (isStale(token)) return;
    // 注意：session.session 在「凭据仍在但暂时连不上」时同样存在，此时也应当保持登录态。
    if (session.session) {
      await engine.setSession(session.session);
      if (isStale(token)) return;
      onSessionChange(session.session);
      setNotice('密码已更新，并且已登录。', 'ok');
    } else {
      setNotice('密码已更新，请用新密码登录。', 'ok');
    }
    render();
  }

  /** 「稍后设置」：收起改密面板但保留链接状态，下次打开页面还会提醒。 */
  function doResetLater() {
    view = 'auto';
    render();
    setNotice('已保留待处理的重置状态，你也可以随时在账号面板里继续设置新密码。', 'warn');
  }

  /**
   * 处理邮件链接带回来的会话或错误（页面加载时调用）。
   *
   * 两种链接的差别（评审 P1-4）：
   *  - 邮箱验证：确认身份后直接进入已登录状态；
   *  - 重置密码：确认身份后还要显示改密面板，并且这个面板要能跨刷新保持，
   *    打开账号弹窗时也不应该被「已登录」的账号面板顶掉。
   */
  async function handleCallback(callback) {
    const token = ++opToken;
    if (callback.kind === 'error') {
      setNotice(callback.errorCode === 'otp_expired'
        ? '链接已失效或已被使用，请重新申请验证/重置邮件。'
        : '链接无法使用，请重新申请邮件。', 'error');
      openDialog();
      render();
      return { ok: false };
    }
    if (callback.kind === 'pkce_code') {
      setNotice('这个链接需要在同一浏览器打开（当前流程使用 implicit 验证）。请重新点击邮件里的链接。', 'warn');
      openDialog();
      render();
      return { ok: false };
    }
    if (callback.kind !== 'session') return { ok: false };

    setNotice('正在确认链接…');
    const accepted = await auth.acceptCallbackSession(callback);
    if (isStale(token)) return { ok: false, skipped: 'stale' };
    if (!accepted.ok) {
      setNotice(accepted.error?.message || '链接无效，请重新申请邮件。', 'error');
      openDialog();
      render();
      return { ok: false };
    }

    const outcome = await engine.setSession(accepted.session);
    if (isStale(token)) return { ok: false, skipped: 'stale' };
    onSessionChange(accepted.session);

    if (accepted.type === 'recovery') {
      view = 'reset';
      store.writeAuthFlow?.({ type: 'recovery', email: accepted.session.user.email, at: Date.now() });
      setNotice(outcome?.conflict
        ? '链接有效，请先设置新密码；设置完成后还需要处理存档冲突。'
        : '链接有效，请设置新密码。', 'ok');
    } else {
      view = 'auto';
      store.clearAuthFlow?.();
      setNotice(outcome?.conflict
        ? '邮箱已验证并登录，但请先选择保留哪一份存档。'
        : '邮箱验证完成，已登录，存档已对齐。', 'ok');
    }
    openDialog();
    render();
    return { ok: true, needsPassword: accepted.type === 'recovery' };
  }

  function wire() {
    els.button?.addEventListener('click', () => {
      render();
      openDialog();
    });
    for (const el of els.tabs) el.addEventListener('click', () => setTab(el.dataset.authTab));
    els.signIn?.addEventListener('click', doSignIn);
    els.signUp?.addEventListener('click', doSignUp);
    els.forgot?.addEventListener('click', doForgot);
    els.resend?.addEventListener('click', doResend);
    els.syncNow?.addEventListener('click', doSynNow);
    els.signOut?.addEventListener('click', doSignOut);
    els.forget?.addEventListener('click', doForget);
    els.conflictKeepCloud?.addEventListener('click', () => doConflict('cloud'));
    els.conflictKeepLocal?.addEventListener('click', () => doConflict('local'));
    els.conflictLater?.addEventListener('click', () => doConflict('later'));
    els.backupExport?.addEventListener('click', doBackupExport);
    els.savePassword?.addEventListener('click', doSavePassword);
    els.resetLater?.addEventListener('click', doResetLater);
    els.password?.addEventListener('keydown', (e) => { if (e.key === 'Enter') doSignIn(); });
    els.email?.addEventListener('keydown', (e) => { if (e.key === 'Enter') doSignIn(); });
  }

  wire();
  render();

  return {
    render,
    setNotice,
    setTab,
    handleCallback,
    open: () => { render(); openDialog(); },
    get activeTab() { return activeTab; },
    get view() { return view; }
  };
}
