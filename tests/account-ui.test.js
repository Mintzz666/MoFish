import test from 'node:test';
import assert from 'node:assert/strict';
import { createAccountUI } from '../web/ui/account.js';
import { STATUS } from '../web/cloud/sync.js';

class FakeElement {
  constructor(id = '') {
    this.id = id;
    this.textContent = '';
    this.value = '';
    this.hidden = false;
    this.disabled = false;
    this.dataset = {};
    this.attributes = {};
    this.listeners = new Map();
    this.children = [];
    this.open = false;
  }

  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) || [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  setAttribute(name, value) { this.attributes[name] = value; }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = children; }
  showModal() { this.open = true; }

  click() {
    if (this.disabled) return undefined;
    const results = (this.listeners.get('click') || []).map(listener => listener({ target: this }));
    return Promise.all(results);
  }
}

class FakeDocument {
  constructor() {
    this.elements = new Map();
    this.tabs = ['signin', 'signup'].map(tab => {
      const element = new FakeElement(`tab-${tab}`);
      element.dataset.authTab = tab;
      return element;
    });
    this.sections = ['signin', 'signup'].map(section => {
      const element = new FakeElement(`section-${section}`);
      element.dataset.authSection = section;
      return element;
    });
  }

  getElementById(id) {
    if (!this.elements.has(id)) this.elements.set(id, new FakeElement(id));
    return this.elements.get(id);
  }

  querySelectorAll(selector) {
    if (selector === '[data-auth-tab]') return this.tabs;
    if (selector === '[data-auth-section]') return this.sections;
    return [];
  }

  createElement(tag) { return new FakeElement(tag); }
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function makeHarness({ syncNow = async () => {}, resolveConflict = async () => {}, backups = [] } = {}) {
  const doc = new FakeDocument();
  const snapshot = {
    user: { id: 'user-1', email: 'fish@example.test' },
    aquariumId: 'tank-1',
    status: STATUS.SYNCING,
    dirty: false,
    busy: false,
    conflict: null
  };
  const engine = {
    generation: 1,
    get snapshot() { return snapshot; },
    syncNow,
    resolveConflict,
    async setSession(session) {
      this.generation += 1;
      snapshot.user = session?.user || null;
      snapshot.status = snapshot.user ? STATUS.SYNCED : STATUS.GUEST;
      snapshot.conflict = null;
      return { ok: true };
    },
    conflictDetail() {
      if (!snapshot.conflict) return null;
      return {
        reason: snapshot.conflict.reason || 'save',
        localFish: [],
        cloudFish: [],
        cloudKnown: true
      };
    }
  };
  const store = {
    readAuthFlow: () => null,
    clearAuthFlow() {},
    listBackups: () => backups,
    forgetUser: () => 0
  };
  const auth = { signOut: async () => ({ remoteOk: true }) };
  const ui = createAccountUI({
    auth,
    engine,
    store,
    config: { mode: 'ready', problems: [] },
    doc
  });
  return { doc, engine, snapshot, ui, el: id => doc.getElementById(id) };
}

test('backup summaries describe v2 scenery and retain v1 plant counts', () => {
  const h = makeHarness({ backups: [
    { key: 'v1', stamp: 1, state: { version: 1, fish: [{ id: 'old' }], plants: 4 } },
    { key: 'v2', stamp: 2, state: { version: 2, fish: [{ id: 'new' }], decor: [
      { kind: 'plant' }, { kind: 'rock' }, { kind: 'wood' }
    ] } }
  ] });
  h.ui.render();
  const details = h.el('backup-list').children.map(row => row.children[1].textContent);
  assert.deepEqual(details, ['1 条鱼 · 3 件造景', '1 条鱼 · 4 株水草']);
});

test('manual sync runs once while pending and leaves a failure notice on rejection', async () => {
  const gate = deferred();
  let calls = 0;
  const h = makeHarness({ syncNow: () => { calls += 1; return gate.promise; } });
  const button = h.el('session-sync-now');

  const firstClick = button.click();
  assert.equal(calls, 1);
  assert.equal(button.disabled, true);
  assert.equal(button.attributes['aria-busy'], 'true');
  assert.equal(button.textContent, '正在同步…');

  await button.click();
  assert.equal(calls, 1, 'a second click while the request is pending must be ignored');

  gate.reject(new Error('network unavailable'));
  await firstClick;
  assert.match(h.el('account-notice').textContent, /同步没有完成/);
  assert.doesNotMatch(h.el('account-notice').textContent, /当前进度已同步/);
  assert.equal(button.disabled, false);
});

test('a manual sync that discovers a conflict does not show the synced notice', async () => {
  const h = makeHarness({
    syncNow: async () => {
      h.snapshot.status = STATUS.CONFLICT;
      h.snapshot.conflict = { reason: 'save' };
    }
  });

  await h.el('session-sync-now').click();

  assert.match(h.el('account-notice').textContent, /有改动|冲突/);
  assert.doesNotMatch(h.el('account-notice').textContent, /当前进度已同步/);
});

test('late manual sync completion cannot replace the sign-out notice', async () => {
  const gate = deferred();
  const h = makeHarness({ syncNow: () => gate.promise });
  const syncClick = h.el('session-sync-now').click();

  const signOutClick = h.el('session-sign-out').click();
  await signOutClick;
  assert.equal(h.snapshot.user, null);
  assert.match(h.el('account-notice').textContent, /已退出登录/);

  gate.resolve();
  await syncClick;
  assert.match(h.el('account-notice').textContent, /已退出登录/);
  assert.doesNotMatch(h.el('account-notice').textContent, /当前进度已同步/);
});

test('sync notice follows synced, offline, then conflict snapshots', () => {
  const h = makeHarness();
  h.snapshot.status = STATUS.SYNCED;
  h.ui.render();
  assert.match(h.el('account-notice').textContent, /当前进度已同步/);

  h.snapshot.status = STATUS.OFFLINE;
  h.ui.render();
  assert.match(h.el('account-notice').textContent, /当前离线/);

  h.snapshot.status = STATUS.CONFLICT;
  h.snapshot.conflict = { reason: 'pending' };
  h.ui.render();
  assert.match(h.el('account-notice').textContent, /各有改动/);
});

test('shared conflict summary reports decor count and added, removed, and changed objects', () => {
  const h = makeHarness();
  h.snapshot.isShared = true;
  h.snapshot.role = 'owner';
  h.snapshot.conflict = { reason: 'pending' };
  h.engine.conflictDetail = () => ({
    reason: 'pending',
    cloudKnown: true,
    localFish: [{ name: '小鱼', growth: 0.4, meals: 3 }],
    cloudFish: [{ name: '小鱼', growth: 0.4, meals: 3 }],
    localDecor: [{ id: 'plant-1', kind: 'plant', x: 0.2, seed: 10 }],
    cloudDecor: [
      { id: 'plant-1', kind: 'plant', x: 0.8, seed: 10 },
      { id: 'rock-1', kind: 'rock', x: 0.6, seed: 20 }
    ]
  });
  h.ui.render();

  const summary = h.el('conflict-summary').textContent;
  assert.match(summary, /本机造景：1 件（比云端新增 0 件、移走 1 件，另有 1 件位置或造型变动）/);
  assert.match(summary, /云端造景：2 件（比本机新增 1 件、移走 0 件，另有 1 件位置或造型变动）/);
  assert.equal(h.el('conflict-keep-local').textContent, '保留我的这项改动');
  assert.equal(h.el('conflict-keep-local').disabled, false);
});

test('decor comparison ignores key order but detects a position change at equal counts', () => {
  const h = makeHarness();
  h.snapshot.conflict = { reason: 'pending' };
  const localDecor = [{ id: 'plant-1', kind: 'plant', position: { x: 0.2, z: 0.4 } }];
  let cloudDecor = [{ position: { z: 0.4, x: 0.2 }, kind: 'plant', id: 'plant-1' }];
  h.engine.conflictDetail = () => ({ reason: 'pending', cloudKnown: true, localFish: [], cloudFish: [], localDecor, cloudDecor });
  h.ui.render();
  assert.match(h.el('conflict-summary').textContent, /本机和云端都有 1 件造景，物件内容相同/);

  cloudDecor = [{ position: { z: 0.4, x: 0.7 }, kind: 'plant', id: 'plant-1' }];
  h.ui.render();
  assert.match(h.el('conflict-summary').textContent, /另有 1 件位置或造型变动/);
  assert.match(h.el('conflict-summary').textContent, /本机造景：1 件/);
  assert.match(h.el('conflict-summary').textContent, /云端造景：1 件/);
});

test('shared viewer cannot choose the local copy and gets backup guidance', async () => {
  const h = makeHarness();
  let resolveCalls = 0;
  h.snapshot.isShared = true;
  h.snapshot.role = 'viewer';
  h.snapshot.conflict = { reason: 'pending' };
  h.engine.conflictDetail = () => ({
    reason: 'pending', cloudKnown: true,
    localFish: [], cloudFish: [], localDecor: [], cloudDecor: []
  });
  h.engine.resolveConflict = async () => { resolveCalls += 1; return { ok: true }; };
  h.ui.render();

  const local = h.el('conflict-keep-local');
  assert.equal(local.textContent, '保留我的这项改动');
  assert.equal(local.disabled, true);
  assert.equal(h.el('conflict-keep-cloud').disabled, false);
  assert.match(h.el('conflict-summary').textContent, /只有观看权限/);
  assert.match(h.el('conflict-summary').textContent, /导出本机备份/);

  await local.listeners.get('click')[0]({ target: local });
  assert.equal(resolveCalls, 0, 'the handler guard must reject a local choice even if called directly');
  assert.match(h.el('account-notice').textContent, /只有观看权限/);
});

test('older conflict details without decor fields still render', () => {
  const h = makeHarness();
  h.snapshot.conflict = { reason: 'pending' };
  h.ui.render();

  assert.match(h.el('conflict-summary').textContent, /本机：/);
  assert.match(h.el('conflict-summary').textContent, /云端：/);
  assert.doesNotMatch(h.el('conflict-summary').textContent, /造景/);
  assert.equal(h.el('conflict-keep-local').textContent, '用本机覆盖云端');
});

test('conflict choices are disabled while an asynchronous choice is running', async () => {
  const gate = deferred();
  let calls = 0;
  const h = makeHarness({ resolveConflict: () => { calls += 1; return gate.promise; } });
  h.snapshot.status = STATUS.CONFLICT;
  h.snapshot.conflict = { reason: 'save' };
  h.ui.render();

  const keepLocal = h.el('conflict-keep-local');
  const choice = keepLocal.click();
  assert.equal(calls, 1);
  for (const id of ['conflict-keep-cloud', 'conflict-keep-local', 'conflict-later']) {
    assert.equal(h.el(id).disabled, true, `${id} should be disabled during conflict resolution`);
  }

  await keepLocal.click();
  assert.equal(calls, 1, 'a disabled choice cannot start a second resolution');

  h.snapshot.status = STATUS.SYNCED;
  h.snapshot.conflict = null;
  gate.resolve();
  await choice;
  assert.equal(keepLocal.disabled, false);
});
