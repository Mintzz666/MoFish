import test from 'node:test';
import assert from 'node:assert/strict';
import { createSharingUI } from '../web/ui/sharing.js';

class FakeElement {
  constructor(tagName = 'div') {
    this.tagName = tagName.toLowerCase();
    this.id = '';
    this.className = '';
    this.textContent = '';
    this.value = '';
    this.type = '';
    this.hidden = false;
    this.disabled = false;
    this.open = false;
    this.dataset = {};
    this.attributes = {};
    this.listeners = new Map();
    this.children = [];
    this.parentNode = null;
  }

  setAttribute(name, value) { this.attributes[name] = String(value); }
  getAttribute(name) { return this.attributes[name] ?? null; }

  addEventListener(type, listener) {
    const list = this.listeners.get(type) || [];
    list.push(listener);
    this.listeners.set(type, list);
  }

  removeEventListener(type, listener) {
    this.listeners.set(type, (this.listeners.get(type) || []).filter(item => item !== listener));
  }

  append(...children) {
    for (const child of children) {
      child.parentNode = this;
      this.children.push(child);
    }
  }

  replaceChildren(...children) {
    for (const child of this.children) child.parentNode = null;
    this.children = [];
    this.append(...children);
  }

  remove() {
    if (!this.parentNode) return;
    this.parentNode.children = this.parentNode.children.filter(child => child !== this);
    this.parentNode = null;
  }

  showModal() { this.open = true; }
  close() {
    this.open = false;
    this.dispatch('close');
  }

  dispatch(type, event = {}) {
    event.target ||= this;
    event.preventDefault ||= () => {};
    const results = (this.listeners.get(type) || []).map(listener => listener(event));
    return Promise.all(results);
  }

  click() {
    if (this.disabled) return Promise.resolve([]);
    return this.dispatch('click');
  }

  change() { return this.dispatch('change'); }
  input() { return this.dispatch('input'); }
}

class FakeDocument {
  constructor() { this.body = new FakeElement('body'); }
  createElement(tagName) { return new FakeElement(tagName); }
  getElementById(id) { return findById(this.body, id); }
}

function findById(root, id) {
  if (!root) return null;
  if (root.id === id) return root;
  for (const child of root.children || []) {
    const match = findById(child, id);
    if (match) return match;
  }
  return null;
}

function allElements(root) {
  return [root, ...(root.children || []).flatMap(allElements)];
}

function deferred() {
  let resolve;
  const promise = new Promise(res => { resolve = res; });
  return { promise, resolve };
}

function makeHarness({ context, overrides = {} } = {}) {
  const doc = new FakeDocument();
  const state = {
    context: context || {
      user: { id: 'owner-1', email: 'owner@example.test' },
      aquariumId: 'tank-1', role: 'owner', isShared: true
    }
  };
  const calls = [];
  const controller = {
    context: () => state.context,
    listAquariums: async () => ({ ok: true, data: { rooms: [
      { id: 'tank-1', role: 'owner', title: '我的鱼缸' }
    ] } }),
    openAquarium: async id => ({ ok: true, data: { id } }),
    goPersonal: async () => ({ ok: true }),
    listMembers: async id => ({ ok: true, data: { members: [
      { user_id: 'owner-1', email: 'owner@example.test', role: 'owner' },
      { user_id: 'editor-1', email: 'friend@example.test', role: 'editor' }
    ] } }),
    listInvites: async id => ({ ok: true, data: { invites: [] } }),
    createInvite: async input => { calls.push(['createInvite', input]); return { ok: true, data: { token: 'invite-code', expires_at: '2030-01-01T00:00:00Z' } }; },
    revokeInvite: async input => ({ ok: true }),
    setMemberRole: async input => { calls.push(['setMemberRole', input]); return { ok: true }; },
    removeMember: async input => ({ ok: true }),
    acceptInvite: async token => ({ ok: true }),
    leaveAquarium: async id => ({ ok: true }),
    ...overrides
  };
  const ui = createSharingUI({ doc, controller, host: doc.body });
  return { doc, state, calls, controller, ui, el: id => doc.getElementById(id) };
}

test('role controls never offer owner and reject a forged owner role', async () => {
  const h = makeHarness();
  await h.ui.open();

  const inviteRole = h.el('sharing-invite-role');
  assert.deepEqual(inviteRole.children.map(option => option.value), ['editor', 'viewer']);
  const memberRole = h.el('sharing-member-role-1');
  assert.deepEqual(memberRole.children.map(option => option.value), ['editor', 'viewer']);
  assert.equal(h.el('sharing-member-role-0'), null, 'the owner has no editable role control');

  h.el('sharing-invite-email').value = 'friend@example.test';
  inviteRole.value = 'owner';
  await h.el('sharing-invite-create').click();

  assert.equal(h.calls.filter(([name]) => name === 'createInvite').length, 0);
  assert.match(h.el('sharing-notice').textContent, /权限只能设为可编辑或仅观看/);
});

test('real RPC array envelopes render rooms, members and invitations', async () => {
  const h=makeHarness({overrides:{
    listAquariums:async()=>({ok:true,data:[{id:'tank-1',role:'owner',title:'真实云端鱼缸'}]}),
    listMembers:async()=>({ok:true,data:[{user_id:'owner-1',email:'owner@example.test',role:'owner'}]}),
    listInvites:async()=>({ok:true,data:[{id:'invite-1',email:'friend@example.test',role:'viewer',expires_at:'2030-01-01T00:00:00Z'}]})
  }});
  await h.ui.open();
  assert.equal(h.el('sharing-room-title-0').textContent,'真实云端鱼缸');
  assert.equal(h.el('sharing-member-email-0').textContent,'owner@example.test');
  assert.equal(h.el('sharing-go-personal').disabled,true);
  assert.equal(h.el('sharing-invite-email-0').textContent,'friend@example.test');
});

test('returning from a joined room accepts the personal owner room identity', async () => {
  let h;
  h=makeHarness({context:{user:{id:'editor-1',email:'friend@example.test'},aquariumId:'shared-1',role:'editor',isShared:true},overrides:{
    goPersonal:async()=>{h.state.context={...h.state.context,aquariumId:'personal-1',role:'owner'};return {ok:true};}
  }});
  await h.ui.open();
  await h.el('sharing-go-personal').click();
  assert.equal(h.state.context.aquariumId,'personal-1');
  assert.match(h.el('sharing-notice').textContent,/已回到个人鱼缸/);
});

test('viewer sees read-only access and no invitation or member-edit controls', async () => {
  const h = makeHarness({
    context: { user: { id: 'viewer-1', email: 'viewer@example.test' }, aquariumId: 'tank-1', role: 'viewer', isShared: true },
    overrides: {
      listAquariums: async () => ({ ok: true, data: { rooms: [{ id: 'tank-1', role: 'viewer', title: '朋友的鱼缸' }] } }),
      listMembers: async () => ({ ok: true, data: { members: [
        { user_id: 'owner-1', email: 'owner@example.test', role: 'owner' },
        { user_id: 'viewer-1', email: 'viewer@example.test', role: 'viewer' }
      ] } })
    }
  });
  await h.ui.open();

  assert.match(h.el('sharing-viewer-note').textContent, /只能观看/);
  assert.equal(h.el('sharing-invite-email'), null);
  assert.equal(h.el('sharing-member-role-1'), null);
  assert.equal(h.el('sharing-member-remove-1'), null);
  assert.ok(h.el('sharing-leave'));
});

test('untrusted names, email addresses, and invitation codes render as text', async () => {
  const roomTitle = '<img src=x onerror=alert(1)>';
  const memberEmail = '<svg onload=alert(1)>';
  const inviteCode = '<script>alert(1)</script>';
  const h = makeHarness({
    overrides: {
      listAquariums: async () => ({ ok: true, data: { rooms: [{ id: 'tank-1', role: 'owner', title: roomTitle }] } }),
      listMembers: async () => ({ ok: true, data: { members: [
        { user_id: 'owner-1', email: 'owner@example.test', role: 'owner' },
        { user_id: 'member-1', email: memberEmail, role: 'viewer' }
      ] } }),
      createInvite: async () => ({ ok: true, data: { token: inviteCode, expires_at: '2030-01-01T00:00:00Z' } })
    }
  });
  await h.ui.open();

  assert.equal(h.el('sharing-room-title-0').textContent, roomTitle);
  assert.equal(h.el('sharing-member-email-1').textContent, memberEmail);
  assert.equal(allElements(h.doc.body).some(el => ['img', 'svg', 'script'].includes(el.tagName)), false);

  h.el('sharing-invite-email').value = 'friend@example.test';
  await h.el('sharing-invite-create').click();
  assert.equal(h.el('sharing-invite-code').textContent, inviteCode);
  assert.equal(allElements(h.doc.body).some(el => ['img', 'svg', 'script'].includes(el.tagName)), false);
});

test('a pending refresh disables controls and ignores repeat refresh clicks', async () => {
  const gate = deferred();
  let calls = 0;
  const h = makeHarness({ overrides: {
    listAquariums: () => { calls += 1; return gate.promise; }
  } });

  const opening = h.ui.open();
  assert.equal(calls, 1);
  assert.equal(h.el('sharing-refresh').disabled, true);
  await h.el('sharing-refresh').click();
  assert.equal(calls, 1);

  gate.resolve({ ok: true, data: { rooms: [{ id: 'tank-1', role: 'owner', title: '我的鱼缸' }] } });
  await opening;
  assert.equal(calls, 1);
  assert.equal(h.el('sharing-refresh').disabled, false);
});

test('closing the panel discards an outstanding list response', async () => {
  const gate = deferred();
  const h = makeHarness({ overrides: { listAquariums: () => gate.promise } });
  const opening = h.ui.open();
  h.ui.close();
  gate.resolve({ ok: true, data: { rooms: [{ id: 'tank-1', role: 'owner', title: '过期鱼缸响应' }] } });
  await opening;

  assert.equal(h.el('sharing-dialog').open, false);
  assert.equal(h.el('sharing-room-title-0'), null);
});

test('a list response for an old identity is discarded and the new identity is loaded', async () => {
  const first = deferred();
  let calls = 0;
  const h = makeHarness({ overrides: {
    listAquariums: () => {
      calls += 1;
      if (calls === 1) return first.promise;
      return Promise.resolve({ ok: true, data: { rooms: [{ id: 'tank-2', role: 'viewer', title: '新账号鱼缸' }] } });
    },
    listMembers: async () => ({ ok: true, data: { members: [{ user_id: 'owner-2', email: 'owner2@example.test', role: 'owner' }] } })
  } });

  const opening = h.ui.open();
  h.state.context = {
    user: { id: 'viewer-2', email: 'viewer2@example.test' },
    aquariumId: 'tank-2', role: 'viewer', isShared: true
  };
  await h.ui.render();
  first.resolve({ ok: true, data: { rooms: [{ id: 'tank-1', role: 'owner', title: '旧账号鱼缸' }] } });
  await opening;

  assert.equal(calls, 2);
  assert.equal(h.el('sharing-room-title-0').textContent, '新账号鱼缸');
  assert.equal(h.el('sharing-room-title-0').textContent.includes('旧账号'), false);
});
