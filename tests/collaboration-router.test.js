import test from 'node:test';
import assert from 'node:assert/strict';
import { createCollaborationRouter } from '../web/cloud/collaboration-router.js';

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function fakeEngine(name, { delayedStartId = null, delayedStart = null } = {}) {
  const engine = {
    name,
    generation: 0,
    snapshot: { aquariumId: null, conflict: false },
    isDirty: false,
    pendingFeeds: false,
    canEdit: true,
    role: 'owner',
    sessionCalls: [],
    startCalls: [],
    stopCalls: 0,
    async setSession(session) {
      this.sessionCalls.push(session);
      this.generation += 1;
      return { ok: true };
    },
    async syncNow() { return { ok: true }; },
    async start(session, aquariumId) {
      this.startCalls.push({ session, aquariumId });
      if (aquariumId === delayedStartId) {
        delayedStart.onStart?.();
        return delayedStart.promise;
      }
      this.snapshot = { aquariumId, conflict: false };
      this.generation += 1;
      return { ok: true };
    },
    async stop() {
      this.stopCalls += 1;
      return { ok: true };
    }
  };
  return engine;
}

function makeRouter({ autoShared = false, preparePersonal = null, sharedOptions = {} } = {}) {
  const legacy = fakeEngine('legacy');
  const shared = fakeEngine('shared', sharedOptions);
  const router = createCollaborationRouter({
    legacy,
    shared,
    store: {},
    autoShared,
    preparePersonal
  });
  return { ...router, legacy, shared };
}

test('autoShared login and return to personal use the shared API without legacy snapshot hydration', async () => {
  const prepareCalls = [];
  const session = { user: { id: 'user-a' } };
  const router = makeRouter({
    autoShared: true,
    preparePersonal: async (...args) => {
      prepareCalls.push(args);
      return { ok: true, data: { aquarium_id: 'personal-a' } };
    }
  });

  assert.deepEqual(await router.engine.setSession(session), { ok: true });
  assert.deepEqual(router.legacy.sessionCalls, [null], 'autoShared login clears legacy state instead of hydrating the full session snapshot');
  assert.deepEqual(router.shared.startCalls, [{ session, aquariumId: 'personal-a' }]);
  assert.deepEqual(prepareCalls, [[]], 'personal preparation receives no shared aquarium state');

  assert.deepEqual(await router.openAquarium('friend-room'), { ok: true });
  assert.deepEqual(await router.goPersonal(), { ok: true });
  assert.deepEqual(router.legacy.sessionCalls, [null], 'returning to personal must not call legacy.setSession(session)');
  assert.deepEqual(prepareCalls, [[], []]);
  assert.deepEqual(router.shared.startCalls.map(({ aquariumId }) => aquariumId), [
    'personal-a', 'friend-room', 'personal-a'
  ]);
});

test('identity switch invalidates an outstanding open and prepares the new user from the app-owned personal path', async () => {
  const delayedStart = deferred();
  const slowStarted = deferred();
  const prepareCalls = [];
  let appOwnedPersonalSource = 'guest-or-initial';
  const userA = { user: { id: 'user-a' } };
  const userB = { user: { id: 'user-b' } };
  const router = makeRouter({
    autoShared: true,
    sharedOptions: {
      delayedStartId: 'slow-room',
      delayedStart: { promise: delayedStart.promise, onStart: () => slowStarted.resolve() }
    },
    preparePersonal: async (...args) => {
      prepareCalls.push({ args, source: appOwnedPersonalSource });
      return { ok: true, data: { aquarium_id: `personal-${prepareCalls.length}` } };
    }
  });

  await router.engine.setSession(userA);
  await router.openAquarium('previous-shared-room');
  appOwnedPersonalSource = 'fresh-guest-or-initial-for-user-b';

  const oldOpen = router.openAquarium('slow-room');
  await slowStarted.promise;
  await router.engine.setSession(userB);
  delayedStart.resolve({ ok: true });

  assert.deepEqual(await oldOpen, { ok: false }, 'the old open response must not be reported as current after identity changes');
  assert.equal(router.context().user.id, 'user-b');
  assert.equal(router.context().aquariumId, 'personal-2');
  assert.deepEqual(prepareCalls, [
    { args: [], source: 'guest-or-initial' },
    { args: [], source: 'fresh-guest-or-initial-for-user-b' }
  ]);
  assert.deepEqual(router.shared.startCalls.map(({ aquariumId }) => aquariumId), [
    'personal-1', 'previous-shared-room', 'slow-room', 'personal-2'
  ]);
});

test('autoShared defaults off and preserves the Phase B legacy session flow', async () => {
  const session = { user: { id: 'legacy-user' } };
  let prepareCalls = 0;
  const router = makeRouter({
    preparePersonal: async () => {
      prepareCalls += 1;
      return { ok: true, data: { aquarium_id: 'unused-room' } };
    }
  });

  assert.deepEqual(await router.engine.setSession(session), { ok: true });
  assert.deepEqual(router.legacy.sessionCalls, [session]);
  assert.equal(prepareCalls, 0);
  assert.deepEqual(router.shared.startCalls, []);
});
