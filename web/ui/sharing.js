// Shared-aquarium controls. The controller owns authorization and persistence;
// this module only renders its results and forwards explicit user actions.

const ROLE_OPTIONS = [
  ['editor', '可编辑'],
  ['viewer', '仅观看']
];
const EXPIRY_OPTIONS = [
  ['1', '1 小时'],
  ['24', '24 小时'],
  ['72', '3 天'],
  ['168', '7 天']
];
const ROLE_NAMES = { owner: '主人', editor: '可编辑', viewer: '仅观看' };

const FAILURE_TEXT = {
  refresh: '暂时无法读取鱼缸共享信息，请稍后重试。',
  switch: '暂时无法切换鱼缸，请稍后重试。',
  personal: '暂时无法切回个人鱼缸，请稍后重试。',
  accept: '邀请暂时无法接受，请确认代码有效且尚未过期。',
  invite: '邀请没有创建成功，请检查邮箱后重试。',
  revoke: '邀请没有撤销成功，请稍后重试。',
  role: '成员权限没有更新，请稍后重试。',
  remove: '成员没有移除，请稍后重试。',
  leave: '暂时无法离开共享鱼缸，请稍后重试。',
  leaveAfterPersonal: '已退出共享鱼缸，但切回个人鱼缸没有完成，请再试一次。'
};

const BUSY_TEXT = {
  refresh: '正在读取共享信息…',
  switch: '正在切换鱼缸…',
  personal: '正在切回个人鱼缸…',
  accept: '正在接受邀请…',
  invite: '正在创建邀请…',
  revoke: '正在撤销邀请…',
  role: '正在更新成员权限…',
  remove: '正在移除成员…',
  leave: '正在退出共享鱼缸…'
};

function plainText(value, fallback = '') {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return fallback;
}

function roleName(role) {
  return ROLE_NAMES[role] || '成员';
}

function safeDate(value) {
  const stamp = Date.parse(plainText(value));
  if (!Number.isFinite(stamp)) return '';
  try {
    return new Intl.DateTimeFormat('zh-CN', {
      month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false
    }).format(new Date(stamp));
  } catch {
    return '';
  }
}

function expiryStatus(invite) {
  if (invite.accepted_at) return '已接受';
  if (invite.revoked_at) return '已撤销';
  const stamp = Date.parse(plainText(invite.expires_at));
  if (Number.isFinite(stamp) && stamp <= Date.now()) return '已过期';
  return '待处理';
}

export function createSharingUI({ doc = globalThis.document, host = doc?.body, button, controller, onNotice = () => {} } = {}) {
  if (!doc || typeof doc.createElement !== 'function' || !host || typeof host.append !== 'function') {
    throw new TypeError('createSharingUI requires a document and a host element');
  }

  let disposed = false;
  let epoch = 0;
  let busy = null;
  let busySequence = 0;
  let observedIdentity = null;
  let loadedIdentity = null;
  let notice = null;
  let createdInvite = null;
  let rooms = null;
  let members = null;
  let invites = null;
  const form = { token: '', email: '', inviteRole: 'editor', expiresHours: '24' };

  const dialog = doc.createElement('dialog');
  dialog.id = 'sharing-dialog';
  dialog.className = 'sharing-dialog';
  dialog.setAttribute('aria-labelledby', 'sharing-title');
  dialog.setAttribute('aria-modal', 'true');

  const header = doc.createElement('div');
  header.className = 'sharing-header';
  const eyebrow = doc.createElement('p');
  eyebrow.id = 'sharing-eyebrow';
  eyebrow.className = 'sharing-eyebrow';
  eyebrow.textContent = 'MOFISH · 共享鱼缸';
  const title = doc.createElement('h2');
  title.id = 'sharing-title';
  title.className = 'sharing-title';
  title.textContent = '和朋友一起照看';
  const closeButton = doc.createElement('button');
  closeButton.id = 'sharing-close';
  closeButton.className = 'sharing-close';
  closeButton.type = 'button';
  closeButton.setAttribute('aria-label', '关闭共享面板');
  closeButton.textContent = '×';
  header.append(eyebrow, title, closeButton);

  const lead = doc.createElement('p');
  lead.id = 'sharing-lead';
  lead.className = 'sharing-lead';
  lead.textContent = '挑一方鱼缸，邀请熟悉的人一起看看。';
  const noticeNode = doc.createElement('p');
  noticeNode.id = 'sharing-notice';
  noticeNode.className = 'sharing-notice';
  noticeNode.setAttribute('role', 'status');
  noticeNode.setAttribute('aria-live', 'polite');
  noticeNode.hidden = true;
  const statusNode = doc.createElement('p');
  statusNode.id = 'sharing-status';
  statusNode.className = 'sharing-status';
  statusNode.setAttribute('aria-live', 'polite');
  const content = doc.createElement('div');
  content.id = 'sharing-content';
  content.className = 'sharing-content';
  dialog.append(header, lead, noticeNode, statusNode, content);
  host.append(dialog);

  function normalizeContext() {
    try {
      const raw = typeof controller?.context === 'function' ? controller.context() : null;
      const rawUser = raw?.user;
      const userId = plainText(rawUser?.id);
      const role = ['owner', 'editor', 'viewer'].includes(raw?.role) ? raw.role : null;
      return {
        available: Boolean(raw),
        user: userId ? { id: userId, email: plainText(rawUser?.email) } : null,
        aquariumId: plainText(raw?.aquariumId) || null,
        role,
        isShared: Boolean(raw?.isShared)
      };
    } catch {
      return { available: false, user: null, aquariumId: null, role: null, isShared: false };
    }
  }

  function identityOf(ctx) {
    return JSON.stringify([
      ctx.available,
      ctx.user?.id || '',
      ctx.user?.email || '',
      ctx.aquariumId || '',
      ctx.role || '',
      ctx.isShared
    ]);
  }

  function clearData() {
    rooms = null;
    members = null;
    invites = null;
    loadedIdentity = null;
  }

  function resetForm() {
    form.token = '';
    form.email = '';
    form.inviteRole = 'editor';
    form.expiresHours = '24';
  }

  function observeContext(ctx = normalizeContext()) {
    const nextIdentity = identityOf(ctx);
    if (observedIdentity !== nextIdentity) {
      observedIdentity = nextIdentity;
      clearData();
      createdInvite = null;
      notice = null;
      resetForm();
    }
    return ctx;
  }

  function makeToken(ctx) {
    return { epoch, identity: identityOf(ctx), userId: ctx.user?.id || '' };
  }

  function isCurrent(token) {
    if (disposed || !dialog.open || epoch !== token.epoch) return false;
    const ctx = normalizeContext();
    const identity = identityOf(ctx);
    if (identity !== observedIdentity) observeContext(ctx);
    return identity === token.identity && epoch === token.epoch;
  }

  function isExpectedTransition(token, aquariumId) {
    if (disposed || !dialog.open || epoch !== token.epoch) return false;
    const ctx = normalizeContext();
    if ((ctx.user?.id || '') !== token.userId || (aquariumId ? ctx.aquariumId !== aquariumId : ctx.aquariumId && ctx.role !== 'owner')) {
      observeContext(ctx);
      return false;
    }
    observeContext(ctx);
    return true;
  }

  function localNotice(text, kind = 'info') {
    notice = text ? { text, kind } : null;
    updateStatus();
  }

  function announce(text, kind = 'info') {
    localNotice(text, kind);
    try { onNotice(text); } catch { /* UI feedback must not break the panel. */ }
  }

  function updateStatus() {
    noticeNode.hidden = !notice?.text;
    noticeNode.dataset.kind = notice?.kind || 'info';
    noticeNode.textContent = notice?.text || '';
    statusNode.textContent = busy ? (BUSY_TEXT[busy.name] || '正在处理…') : '';
    statusNode.hidden = !busy;
    dialog.setAttribute('aria-busy', String(Boolean(busy)));
  }

  function node(tag, text, className, id) {
    const el = doc.createElement(tag);
    if (id) el.id = id;
    if (className) el.className = className;
    if (text !== undefined) el.textContent = text;
    return el;
  }

  function section(titleText, detailText, id) {
    const box = node('section', undefined, 'sharing-section', id);
    const heading = node('h3', titleText, 'sharing-section-title');
    box.append(heading);
    if (detailText) box.append(node('p', detailText, 'sharing-section-detail'));
    return box;
  }

  function buttonNode(id, label, handler, options = {}) {
    const el = node('button', label, options.className || 'sharing-button', id);
    el.type = 'button';
    if (options.ariaLabel) el.setAttribute('aria-label', options.ariaLabel);
    if (options.disabled || busy) el.disabled = true;
    if (options.title) el.title = options.title;
    el.addEventListener('click', (event) => {
      event?.preventDefault?.();
      return handler?.(event);
    });
    return el;
  }

  function fieldLabel(id, text) {
    const label = node('label', text, 'sharing-label');
    label.setAttribute('for', id);
    return label;
  }

  function inputNode(id, type, value, options = {}) {
    const el = node('input', undefined, 'sharing-input', id);
    el.type = type;
    el.value = value;
    if (options.placeholder) el.placeholder = options.placeholder;
    if (options.maxLength) el.maxLength = options.maxLength;
    if (options.autoComplete) el.autocomplete = options.autoComplete;
    if (options.inputMode) el.inputMode = options.inputMode;
    if (options.disabled || busy) el.disabled = true;
    if (options.spellcheck === false) el.spellcheck = false;
    return el;
  }

  function selectNode(id, value, options, className = 'sharing-select') {
    const select = node('select', undefined, className, id);
    for (const [optionValue, label] of options) {
      const option = node('option', label);
      option.value = optionValue;
      select.append(option);
    }
    select.value = value;
    if (busy) select.disabled = true;
    return select;
  }

  function roleBadge(role) {
    const el = node('span', roleName(role), 'sharing-role');
    el.dataset.role = ['owner', 'editor', 'viewer'].includes(role) ? role : 'member';
    return el;
  }

  function renderGuest(ctx) {
    const box = node('section', undefined, 'sharing-guest-card', 'sharing-guest-card');
    if (!ctx.available) {
      box.append(node('h3', '账号状态暂时无法读取', 'sharing-section-title'));
      box.append(node('p', '请稍后重新打开共享面板。', 'sharing-section-detail'));
    } else {
      box.append(node('h3', '先登录 MoFish 账号', 'sharing-section-title'));
      box.append(node('p', '请点页面顶部「登录 / 注册」完成登录，再重新打开共享面板。这里不会代填密码。', 'sharing-section-detail'));
    }
    box.append(buttonNode('sharing-guest-close', '知道了', close, { className: 'sharing-button sharing-button-primary' }));
    content.replaceChildren(box);
  }

  function roomTitle(room) {
    return plainText(room.title, '一方鱼缸') || '一方鱼缸';
  }

  function renderRooms(ctx) {
    const box = section('可访问的鱼缸', '选择后会进入那一方水下花园。', 'sharing-rooms-section');
    const refresh = buttonNode('sharing-refresh', '刷新列表', () => loadData(), {
      className: 'sharing-button sharing-button-quiet',
      ariaLabel: '刷新可访问的鱼缸和共享信息'
    });
    const sectionHead = node('div', undefined, 'sharing-section-head');
    sectionHead.append(refresh);
    box.append(sectionHead);

    if (rooms === null) {
      const message = busy
        ? '正在读取可访问的鱼缸…'
        : '还没有读取鱼缸列表，点刷新试试。';
      box.append(node('p', message, 'sharing-empty'));
    } else if (!rooms.length) {
      box.append(node('p', '这个账号还没有可访问的云端鱼缸。接受邀请后，鱼缸会显示在这里。', 'sharing-empty'));
    } else {
      const list = node('ul', undefined, 'sharing-room-list', 'sharing-room-list');
      rooms.forEach((room, index) => {
        const item = node('li', undefined, 'sharing-room-item');
        const current = room.id === ctx.aquariumId;
        const details = node('div', undefined, 'sharing-room-details');
        details.append(node('span', roomTitle(room), 'sharing-room-title', 'sharing-room-title-' + index));
        details.append(roleBadge(room.role));
        if (current) details.append(node('span', '当前鱼缸', 'sharing-current-tag'));
        const choose = buttonNode('sharing-room-open-' + index, current ? '正在使用' : '进入', () => {
          return runAction('switch', () => callController('openAquarium', [room.id]), {
            expectedAquariumId: room.id,
            sourceIdentity: identityOf(ctx),
            success: '已切换到这方鱼缸。'
          });
        }, {
          className: current ? 'sharing-button sharing-button-current' : 'sharing-button sharing-button-primary',
          disabled: current
        });
        item.append(details, choose);
        list.append(item);
      });
      box.append(list);
    }

    const personal = buttonNode('sharing-go-personal', '回到我的鱼缸', () => {
      return runAction('personal', () => callController('goPersonal'), {
        expectedAquariumId: null,
        sourceIdentity: identityOf(ctx),
        success: '已回到个人鱼缸。'
      });
    }, {
      className: 'sharing-button sharing-button-quiet',
      disabled: !ctx.aquariumId || ctx.role === 'owner'
    });
    box.append(personal);
    return box;
  }

  function renderInviteAccept() {
    const box = section('接受邀请', '粘贴收到的邀请代码，再选择接受。打开面板不会自动使用链接中的代码。', 'sharing-accept-section');
    const id = 'sharing-token';
    const input = inputNode(id, 'text', form.token, {
      placeholder: '输入邀请代码', maxLength: 512, autoComplete: 'off', spellcheck: false
    });
    input.addEventListener('input', () => { form.token = input.value; });
    const label = fieldLabel(id, '邀请代码');
    const actions = node('div', undefined, 'sharing-form-actions');
    const accept = buttonNode('sharing-accept', '接受邀请', () => {
      const token = plainText(input.value).trim();
      form.token = token;
      if (!token) {
        announce('请先输入邀请代码。', 'warn');
        return;
      }
      return runAction('accept', () => callController('acceptInvite', [token]), {
        success: '邀请已接受，可在上方列表中选择进入。',
        afterSuccess: () => { form.token = ''; }
      });
    }, { className: 'sharing-button sharing-button-primary' });
    actions.append(accept);
    box.append(label, input, actions);
    return box;
  }

  function renderCreatedInvite() {
    if (!createdInvite) return null;
    const box = node('section', undefined, 'sharing-created-card', 'sharing-created-invite');
    box.setAttribute('role', 'status');
    box.append(node('h4', '邀请代码已创建', 'sharing-subtitle'));
    box.append(node('p', '请把这段代码交给 ' + createdInvite.email + '。代码只在这里显示一次；此页面不会发送邮件。', 'sharing-section-detail'));
    const code = node('code', createdInvite.token, 'sharing-invite-code', 'sharing-invite-code');
    code.setAttribute('aria-label', '新创建的邀请代码');
    box.append(code);
    box.append(buttonNode('sharing-copy-code', '复制邀请代码', async () => {
      try {
        if (!globalThis.navigator?.clipboard?.writeText) throw new Error('clipboard unavailable');
        await globalThis.navigator.clipboard.writeText(createdInvite.token);
        announce('邀请代码已复制，请交给对应邮箱的伙伴。', 'success');
      } catch {
        announce('请长按或选中上方代码进行复制。', 'info');
      }
    }, {className:'sharing-button sharing-button-quiet'}));
    const date = safeDate(createdInvite.expiresAt);
    box.append(node('p', date ? '有效至 ' + date + '；主人可以随时撤销。' : '主人可以随时撤销这次邀请。', 'sharing-note'));
    return box;
  }

  function renderMembers(ctx) {
    const box = section('鱼缸成员', '主人可以调整协作者权限，或移除非主人的成员。', 'sharing-members-section');
    if (members === null) {
      box.append(node('p', busy ? '正在读取成员…' : '成员列表暂不可用。', 'sharing-empty'));
      return box;
    }
    if (!members.length) {
      box.append(node('p', '目前还没有其他成员。', 'sharing-empty'));
      return box;
    }
    const list = node('ul', undefined, 'sharing-member-list', 'sharing-member-list');
    members.forEach((member, index) => {
      const row = node('li', undefined, 'sharing-member-item');
      const info = node('div', undefined, 'sharing-member-info');
      const isSelf = member.user_id === ctx.user?.id;
      const email = member.email || (isSelf ? ctx.user?.email : '') || 'MoFish 成员';
      info.append(node('span', email, 'sharing-member-email', 'sharing-member-email-' + index));
      if (isSelf) info.append(node('span', '你', 'sharing-self-tag'));
      if (member.role === 'owner' || (isSelf && ctx.role === 'owner')) {
        info.append(roleBadge('owner'));
        row.append(info);
      } else if (ctx.role === 'owner') {
        const controls = node('div', undefined, 'sharing-member-controls');
        const role = selectNode('sharing-member-role-' + index, ROLE_OPTIONS.some(([key]) => key === member.role) ? member.role : 'viewer', ROLE_OPTIONS, 'sharing-select sharing-member-role-select');
        role.setAttribute('aria-label', '更改 ' + email + ' 的权限');
        role.addEventListener('change', () => {
          const nextRole = role.value;
          if (!ROLE_OPTIONS.some(([key]) => key === nextRole)) {
            announce('成员权限只能设为可编辑或仅观看。', 'warn');
            render();
            return;
          }
          if (nextRole === member.role) return;
          return runAction('role', () => callController('setMemberRole', [{
            aquariumId: ctx.aquariumId,
            userId: member.user_id,
            role: nextRole
          }]), {
            sourceIdentity: identityOf(ctx),
            success: '成员权限已更新。',
            afterSuccess: () => {
              if (Array.isArray(members)) {
                members = members.map((item) => item.user_id === member.user_id ? { ...item, role: nextRole } : item);
              }
            }
          });
        });
        const remove = buttonNode('sharing-member-remove-' + index, '移除', () => {
          return runAction('remove', () => callController('removeMember', [{
            aquariumId: ctx.aquariumId,
            userId: member.user_id
          }]), {
            sourceIdentity: identityOf(ctx),
            success: '成员已移除。',
            afterSuccess: () => { members = members.filter((item) => item.user_id !== member.user_id); }
          });
        }, { className: 'sharing-button sharing-button-danger', ariaLabel: '移除 ' + email });
        controls.append(role, remove);
        row.append(info, controls);
      } else {
        info.append(roleBadge(member.role));
        row.append(info);
      }
      list.append(row);
    });
    box.append(list);
    return box;
  }

  function renderInvites(ctx) {
    const box = section('待处理邀请', '尚未接受的邀请会在有效期结束后自动失效。', 'sharing-pending-section');
    if (invites === null) {
      box.append(node('p', busy ? '正在读取邀请…' : '邀请列表暂不可用。', 'sharing-empty'));
      return box;
    }
    const visibleInvites = (invites || []).filter((invite) => !invite.accepted_at && !invite.revoked_at);
    if (!visibleInvites.length) {
      box.append(node('p', '还没有待处理邀请。', 'sharing-empty'));
      return box;
    }
    const list = node('ul', undefined, 'sharing-invite-list', 'sharing-invite-list');
    visibleInvites.forEach((invite, index) => {
      const row = node('li', undefined, 'sharing-invite-item');
      const info = node('div', undefined, 'sharing-invite-info');
      info.append(node('span', invite.email || '指定邮箱', 'sharing-invite-email', 'sharing-invite-email-' + index));
      info.append(roleBadge(invite.role));
      const status = expiryStatus(invite);
      const when = safeDate(invite.expires_at);
      info.append(node('small', status === '待处理' && when ? '有效至 ' + when : status, 'sharing-invite-expiry'));
      const revoke = buttonNode('sharing-invite-revoke-' + index, '撤销', () => {
        return runAction('revoke', () => callController('revokeInvite', [{
          aquariumId: ctx.aquariumId,
          inviteId: invite.id
        }]), {
          sourceIdentity: identityOf(ctx),
          success: '邀请已撤销。',
          afterSuccess: () => { invites = invites.filter((item) => item.id !== invite.id); }
        });
      }, {
        className: 'sharing-button sharing-button-danger',
        disabled: status !== '待处理',
        ariaLabel: '撤销发给 ' + (invite.email || '指定邮箱') + ' 的邀请'
      });
      row.append(info, revoke);
      list.append(row);
    });
    box.append(list);
    return box;
  }

  function renderCreateInvite(ctx) {
    const box = section('邀请一位伙伴', '邀请只发给指定邮箱。创建后代码只显示一次，需要你交给对应邮箱的收件人。', 'sharing-create-section');
    const emailId = 'sharing-invite-email';
    const email = inputNode(emailId, 'email', form.email, {
      placeholder: 'friend@example.com', maxLength: 254, autoComplete: 'email'
    });
    email.addEventListener('input', () => { form.email = email.value; });

    const roleId = 'sharing-invite-role';
    const role = selectNode(roleId, form.inviteRole, ROLE_OPTIONS);
    role.setAttribute('aria-label', '邀请对象的权限');
    role.addEventListener('change', () => {
      if (ROLE_OPTIONS.some(([key]) => key === role.value)) form.inviteRole = role.value;
    });

    const expiresId = 'sharing-invite-expiry';
    const expires = selectNode(expiresId, form.expiresHours, EXPIRY_OPTIONS);
    expires.setAttribute('aria-label', '邀请有效期');
    expires.addEventListener('change', () => {
      if (EXPIRY_OPTIONS.some(([key]) => key === expires.value)) form.expiresHours = expires.value;
    });

    const roleLabel = node('span', '加入后可以', 'sharing-label');
    const expiryLabel = node('span', '有效期', 'sharing-label');
    const fields = node('div', undefined, 'sharing-invite-fields');
    const emailField = node('div', undefined, 'sharing-field');
    emailField.append(fieldLabel(emailId, '对方邮箱'), email);
    const roleField = node('div', undefined, 'sharing-field');
    roleField.append(roleLabel, role);
    const expiryField = node('div', undefined, 'sharing-field');
    expiryField.append(expiryLabel, expires);
    fields.append(emailField, roleField, expiryField);
    const hint = node('p', '可编辑的伙伴可以一起布景；仅观看的伙伴只能欣赏。邀请到期后需要主人重新邀请。', 'sharing-note');
    const actions = node('div', undefined, 'sharing-form-actions');
    const create = buttonNode('sharing-invite-create', '创建邀请', () => {
      const targetEmail = plainText(email.value).trim();
      const targetRole = role.value;
      const expiry = expires.value;
      form.email = targetEmail;
      form.inviteRole = targetRole;
      form.expiresHours = expiry;
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(targetEmail)) {
        announce('请输入有效的邮箱地址。', 'warn');
        return;
      }
      if (!ROLE_OPTIONS.some(([key]) => key === targetRole)) {
        announce('权限只能设为可编辑或仅观看。', 'warn');
        return;
      }
      if (!EXPIRY_OPTIONS.some(([key]) => key === expiry)) {
        announce('请选择 1 小时、24 小时、3 天或 7 天的有效期。', 'warn');
        return;
      }
      if (!ctx.aquariumId || ctx.role !== 'owner') return;
      return runAction('invite', () => callController('createInvite', [{
        aquariumId: ctx.aquariumId,
        email: targetEmail,
        role: targetRole,
        expiresHours: Number(expiry)
      }]).then((result) => result?.ok && !plainText(result?.data?.token).trim() ? { ...result, ok: false } : result), {
        sourceIdentity: identityOf(ctx),
        success: '邀请已创建，请把代码交给对应邮箱的收件人。',
        afterSuccess: (result) => {
          const token = plainText(result?.data?.token).trim();
          if (!token) {
            createdInvite = null;
            notice = { text: FAILURE_TEXT.invite, kind: 'error' };
            return;
          }
          createdInvite = {
            token,
            email: targetEmail,
            expiresAt: plainText(result.data.expires_at)
          };
        }
      });
    }, { className: 'sharing-button sharing-button-primary', disabled: !ctx.aquariumId });
    actions.append(create);
    box.append(fields, hint, actions);
    const created = renderCreatedInvite();
    if (created) box.append(created);
    return box;
  }

  function renderCurrentAquarium(ctx) {
    if (!ctx.aquariumId) return null;
    const currentRoom = Array.isArray(rooms) ? rooms.find((room) => room.id === ctx.aquariumId) : null;
    const titleText = currentRoom ? roomTitle(currentRoom) : '当前鱼缸';
    const box = section(titleText, ctx.role === 'owner' ? '这是你的鱼缸，可以邀请伙伴一起照看。' : '这是你加入的共享鱼缸。', 'sharing-current-section');
    const roleLine = node('div', undefined, 'sharing-current-role-line');
    roleLine.append(node('span', '你的身份', 'sharing-muted-label'), roleBadge(ctx.role));
    box.append(roleLine);

    if (ctx.role === 'viewer') {
      box.dataset.mode = 'viewer';
      box.append(node('p', '你现在只能观看这方鱼缸。编辑、投食和成员管理入口已关闭。', 'sharing-viewer-note', 'sharing-viewer-note'));
    } else if (ctx.role === 'editor') {
      box.append(node('p', '你可以和主人一起照看鱼缸；邀请和成员管理由主人负责。', 'sharing-note'));
    } else if (ctx.role !== 'owner') {
      box.append(node('p', '暂时无法确认你在这方鱼缸的权限，请刷新后重试。', 'sharing-notice sharing-notice-warn'));
    }

    if (ctx.role) box.append(renderMembers(ctx));
    if (ctx.role === 'owner') {
      box.append(renderInvites(ctx));
      box.append(renderCreateInvite(ctx));
    } else if (ctx.role === 'editor' || ctx.role === 'viewer') {
      const leave = buttonNode('sharing-leave', '离开这方鱼缸', () => {
        return runAction('leave', async () => {
          const result = await callController('leaveAquarium', [ctx.aquariumId]);
          if (!result?.ok) return result;
          const personalResult = await callController('goPersonal');
          return personalResult?.ok ? result : { ok: false, partial: true };
        }, {
          expectedAquariumId: null,
          sourceIdentity: identityOf(ctx),
          success: '已离开共享鱼缸，并回到个人鱼缸。'
        });
      }, { className: 'sharing-button sharing-button-danger' });
      box.append(leave);
    }
    return box;
  }

  function renderView(ctx) {
    updateStatus();
    if (!ctx.user) {
      renderGuest(ctx);
      return;
    }

    const account = node('p', '已登录：' + (ctx.user.email || 'MoFish 账号'), 'sharing-account-line', 'sharing-account-line');
    const shortcuts=node('nav',undefined,'sharing-shortcuts');
    shortcuts.setAttribute('aria-label','共享面板快捷操作');
    const jump=(sectionId,inputId)=>()=>{
      doc.getElementById(sectionId)?.scrollIntoView?.({block:'start'});
      if(inputId)doc.getElementById(inputId)?.focus?.({preventScroll:true});
    };
    if(ctx.role==='owner')shortcuts.append(buttonNode('sharing-jump-invite','邀请伙伴',jump('sharing-create-section','sharing-invite-email')));
    shortcuts.append(buttonNode('sharing-jump-accept','接受邀请',jump('sharing-accept-section','sharing-token')));
    shortcuts.append(buttonNode('sharing-jump-rooms','切换鱼缸',jump('sharing-rooms-section')));
    const parts = [];
    const current = renderCurrentAquarium(ctx);
    if (current) parts.push(current);
    parts.push(renderRooms(ctx));
    parts.push(renderInviteAccept());
    content.replaceChildren(account, shortcuts, ...parts);
  }

  async function callController(method, args = []) {
    try {
      const action = controller?.[method];
      if (typeof action !== 'function') return { ok: false };
      const result = await action.apply(controller, args);
      return result && typeof result === 'object' ? result : { ok: false };
    } catch {
      return { ok: false };
    }
  }

  function isOkay(result) {
    return result?.ok === true;
  }

  function normalizeRooms(result) {
    const rows = Array.isArray(result?.data) ? result.data : result?.data?.rooms;
    if (!Array.isArray(rows)) return null;
    return rows.map((room) => ({
      id: plainText(room?.id),
      role: ['owner', 'editor', 'viewer'].includes(room?.role) ? room.role : null,
      title: plainText(room?.title, '一方鱼缸')
    })).filter((room) => room.id);
  }

  function normalizeMembers(result) {
    const rows = Array.isArray(result?.data) ? result.data : result?.data?.members;
    if (!Array.isArray(rows)) return null;
    return rows.map((member) => ({
      user_id: plainText(member?.user_id),
      email: plainText(member?.email),
      role: ['owner', 'editor', 'viewer'].includes(member?.role) ? member.role : null
    })).filter((member) => member.user_id);
  }

  function normalizeInvites(result) {
    const rows = Array.isArray(result?.data) ? result.data : result?.data?.invites;
    if (!Array.isArray(rows)) return null;
    return rows.map((invite) => ({
      id: plainText(invite?.id),
      email: plainText(invite?.email),
      role: ['editor', 'viewer'].includes(invite?.role) ? invite.role : null,
      expires_at: plainText(invite?.expires_at),
      revoked_at: plainText(invite?.revoked_at),
      accepted_at: plainText(invite?.accepted_at)
    })).filter((invite) => invite.id);
  }

  async function loadDataWhileBusy(token) {
    if (!isCurrent(token)) return false;
    if (!notice || notice.kind === 'loading') localNotice('正在读取共享信息…', 'loading');
    renderView(observeContext());

    const roomResult = await callController('listAquariums');
    if (!isCurrent(token)) return false;
    if (!isOkay(roomResult)) {
      loadedIdentity = token.identity;
      announce(FAILURE_TEXT.refresh, 'error');
      return false;
    }
    rooms = normalizeRooms(roomResult);
    if (!rooms) {
      loadedIdentity = token.identity;
      announce(FAILURE_TEXT.refresh, 'error');
      return false;
    }

    const ctx = observeContext();
    if (ctx.aquariumId && ctx.role) {
      const memberResult = await callController('listMembers', [ctx.aquariumId]);
      if (!isCurrent(token)) return false;
      const normalizedMembers = isOkay(memberResult) ? normalizeMembers(memberResult) : null;
      if (normalizedMembers) members = normalizedMembers;
      else {
        members = null;
        announce('成员列表暂时无法读取，请稍后重试。', 'error');
      }
      if (ctx.role === 'owner') {
        const inviteResult = await callController('listInvites', [ctx.aquariumId]);
        if (!isCurrent(token)) return false;
        const normalizedInvites = isOkay(inviteResult) ? normalizeInvites(inviteResult) : null;
        if (normalizedInvites) invites = normalizedInvites;
        else {
          invites = null;
          announce('邀请列表暂时无法读取，请稍后重试。', 'error');
        }
      } else {
        invites = null;
      }
    } else {
      members = null;
      invites = null;
    }

    if (!isCurrent(token)) return false;
    loadedIdentity = token.identity;
    if (notice?.kind === 'loading') localNotice('');
    return true;
  }

  async function loadData() {
    if (disposed || !dialog.open) return false;
    const ctx = observeContext();
    if (!ctx.user) {
      renderView(ctx);
      return false;
    }
    if (busy) return false;
    const token = makeToken(ctx);
    const operationId = ++busySequence;
    busy = { id: operationId, name: 'refresh' };
    renderView(ctx);
    try {
      return await loadDataWhileBusy(token);
    } finally {
      if (busy?.id === operationId) busy = null;
      if (!disposed && dialog.open) await render();
    }
  }

  async function runAction(name, action, options = {}) {
    if (disposed || busy || !dialog.open) return false;
    const ctx = observeContext();
    if (!ctx.user) {
      announce('请先登录 MoFish 账号，再使用共享功能。', 'warn');
      renderView(ctx);
      return false;
    }
    if (options.sourceIdentity && options.sourceIdentity !== identityOf(ctx)) {
      renderView(ctx);
      return render();
    }
    const token = makeToken(ctx);
    const operationId = ++busySequence;
    busy = { id: operationId, name };
    localNotice(BUSY_TEXT[name] || '正在处理…', 'info');
    renderView(ctx);
    try {
      const result = await action();
      if (!isOkay(result)) {
        if (!isCurrent(token)) return false;
        const failure = name === 'leave' && result?.partial ? FAILURE_TEXT.leaveAfterPersonal : (FAILURE_TEXT[name] || '操作没有完成，请稍后重试。');
        announce(plainText(result?.error) || failure, 'error');
        return false;
      }

      if (options.expectedAquariumId !== undefined) {
        if (!isExpectedTransition(token, plainText(options.expectedAquariumId) || null)) return false;
      } else if (!isCurrent(token)) {
        return false;
      }

      if (typeof options.afterSuccess === 'function') options.afterSuccess(result);
      announce(options.success || '操作已完成。', 'success');

      if (options.expectedAquariumId !== undefined) {
        observeContext();
      }
      const nextContext = observeContext();
      const nextToken = makeToken(nextContext);
      if (options.reload !== false && nextContext.user) {
        await loadDataWhileBusy(nextToken);
      }
      return true;
    } finally {
      if (busy?.id === operationId) busy = null;
      if (!disposed && dialog.open) await render();
    }
  }

  function render() {
    if (disposed) return Promise.resolve(false);
    const ctx = observeContext();
    renderView(ctx);
    if (dialog.open && ctx.user && !busy && loadedIdentity !== identityOf(ctx)) return loadData();
    return Promise.resolve(true);
  }

  function resetClosedState() {
    clearData();
    createdInvite = null;
    notice = null;
    resetForm();
  }

  function handleNativeClose() {
    if (dialog.open || disposed) return;
    epoch += 1;
    resetClosedState();
  }

  function close() {
    if (disposed) return;
    epoch += 1;
    resetClosedState();
    if (dialog.open) {
      try {
        if (typeof dialog.close === 'function') dialog.close();
        else dialog.open = false;
      } catch {
        dialog.open = false;
      }
    }
  }

  function open() {
    if (disposed) return Promise.resolve(false);
    if (!dialog.open) {
      epoch += 1;
      try {
        if (typeof dialog.showModal === 'function') dialog.showModal();
        else dialog.open = true;
      } catch {
        dialog.open = true;
      }
    }
    return render();
  }

  function onButtonClick(event) {
    event?.preventDefault?.();
    return open();
  }

  closeButton.addEventListener('click', close);
  dialog.addEventListener('close', handleNativeClose);
  dialog.addEventListener('cancel', () => { epoch += 1; });
  if (button?.addEventListener) button.addEventListener('click', onButtonClick);

  const initialContext = normalizeContext();
  observedIdentity = identityOf(initialContext);
  renderView(initialContext);

  function dispose() {
    if (disposed) return;
    close();
    disposed = true;
    if (button?.removeEventListener) button.removeEventListener('click', onButtonClick);
    if (closeButton.removeEventListener) closeButton.removeEventListener('click', close);
    if (dialog.removeEventListener) dialog.removeEventListener('close', handleNativeClose);
    if (typeof dialog.remove === 'function') dialog.remove();
    else if (host.removeChild) {
      try { host.removeChild(dialog); } catch { /* Already detached. */ }
    }
  }

  return { open, render, close, dispose };
}
