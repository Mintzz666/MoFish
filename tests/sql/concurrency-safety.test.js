import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { readMigrations, SUPABASE_EMULATION, USERS } from './harness.mjs';
import {
  embeddedPostgresStartupFailure,
  prepareFreshTestDatabase,
  startOwnedEmbeddedPostgres,
  withEmbeddedPostgresOnly,
} from './concurrency-safety.mjs';

test('required embedded PostgreSQL startup failures are hard errors; default mode keeps an explicit skip', () => {
  const cause = new Error('simulated missing libicuuc.so.60');
  assert.throws(
    () => embeddedPostgresStartupFailure(cause, { MOFISH_REQUIRE_POSTGRES: '1' }),
    error => {
      assert.match(error.message, /MOFISH_REQUIRE_POSTGRES=1/);
      assert.equal(error.cause, cause);
      return true;
    }
  );
  assert.match(embeddedPostgresStartupFailure(cause, {}), /真实并发用例标为 SKIP/);
});

test('caller-provided PostgreSQL URLs are rejected before the launcher can connect', async () => {
  let launchCount = 0;
  await assert.rejects(
    withEmbeddedPostgresOnly({
      env: { MOFISH_TEST_PG_URL: 'postgresql://user:password@example.invalid/production' },
      launch: async () => { launchCount += 1; },
    }),
    /MOFISH_TEST_PG_URL is disabled for safety/
  );
  assert.equal(launchCount, 0, 'no PostgreSQL client/server launcher should run');
});

test('fresh-database setup runs real migrations without resetting databases or cluster roles', async () => {
  const executed = [];
  const admin = { query: async (sql, values) => executed.push({ sql, values }) };
  const migrations = await readMigrations();

  await prepareFreshTestDatabase(admin, {
    supabaseEmulation: SUPABASE_EMULATION,
    migrations,
    users: USERS,
  });
  assert.equal(executed.length, migrations.length + 2);
  assert.ok(executed.every(({ sql }) => !/\bdrop\s+(?:database|schema|owned|role|user)\b/i.test(sql)));
  assert.ok(executed.some(({ sql }) => /\bdrop\s+policy\b/i.test(sql)),
    'normal DROP POLICY statements in the actual migration remain allowed');
  assert.deepEqual(executed.at(-1).values, [
    USERS.alice, 'alice@example.com', USERS.bob, 'bob@example.com',
  ]);

  executed.length = 0;
  await assert.rejects(
    prepareFreshTestDatabase(admin, {
      supabaseEmulation: SUPABASE_EMULATION,
      migrations: [{ name: 'unsafe.sql', sql: 'drop schema public cascade;' }],
      users: USERS,
    }),
    /refuses DROP DATABASE\/SCHEMA\/OWNED\/ROLE\/USER/
  );
  assert.deepEqual(executed, [], 'validation must happen before the first setup statement runs');
});

test('parallel embedded runs get unique directories and ports; cleanup removes only its own directory', async t => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'mofish-concurrency-safety-test-'));
  const unrelatedFile = path.join(tempRoot, 'keep.txt');
  await writeFile(unrelatedFile, 'leave this file alone');

  const servers = [];
  t.after(async () => {
    for (const server of servers) await server.stop();
    await rm(tempRoot, { recursive: true, force: true });
  });

  class FakeEmbeddedPostgres {
    constructor(options) { this.options = options; this.stopCalls = 0; }
    async initialise() {
      await mkdir(this.options.databaseDir, { recursive: true });
      await writeFile(path.join(this.options.databaseDir, 'owned.txt'), 'owned');
    }
    async start() {}
    async stop() { this.stopCalls += 1; }
  }

  const [first, second] = await Promise.all([
    startOwnedEmbeddedPostgres({ EmbeddedPostgres: FakeEmbeddedPostgres, tempRoot }),
    startOwnedEmbeddedPostgres({ EmbeddedPostgres: FakeEmbeddedPostgres, tempRoot }),
  ]);
  servers.push(first, second);

  assert.notEqual(first.dataDir, second.dataDir);
  assert.notEqual(first.port, second.port);
  await first.stop();
  await assert.rejects(stat(first.dataDir), { code: 'ENOENT' });
  assert.equal(await readFile(unrelatedFile, 'utf8'), 'leave this file alone');
  await stat(second.dataDir);
  await second.stop();
  await assert.rejects(stat(second.dataDir), { code: 'ENOENT' });
});

test('initialise and start failures stop their instance and remove their unique directories', async () => {
  for (const failedPhase of ['initialise', 'start']) {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), `mofish-concurrency-${failedPhase}-failure-`));
    let instanceOptions;
    let stopCalls = 0;

    class FailingEmbeddedPostgres {
      constructor(options) { instanceOptions = options; }
      async initialise() {
        await mkdir(instanceOptions.databaseDir, { recursive: true });
        if (failedPhase === 'initialise') throw new Error('simulated initdb failure');
      }
      async start() {
        if (failedPhase === 'start') throw new Error('simulated startup failure');
      }
      async stop() { stopCalls += 1; }
    }

    try {
      await assert.rejects(
        startOwnedEmbeddedPostgres({ EmbeddedPostgres: FailingEmbeddedPostgres, tempRoot }),
        new RegExp(`simulated ${failedPhase === 'initialise' ? 'initdb' : 'startup'} failure`)
      );
      assert.equal(stopCalls, 1);
      await assert.rejects(stat(instanceOptions.databaseDir), { code: 'ENOENT' });
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  }
});

test('a failed stop preserves the directory and reports the possible live instance', async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'mofish-concurrency-stop-failure-'));
  let instanceOptions;

  class UnstoppableEmbeddedPostgres {
    constructor(options) { instanceOptions = options; }
    async initialise() { await mkdir(instanceOptions.databaseDir, { recursive: true }); }
    async start() {}
    async stop() { throw new Error('simulated stop failure'); }
  }

  let server;
  try {
    server = await startOwnedEmbeddedPostgres({ EmbeddedPostgres: UnstoppableEmbeddedPostgres, tempRoot });
    await assert.rejects(server.stop(), error => {
      assert.match(error.message, /Could not confirm embedded PostgreSQL stopped/);
      assert.match(error.message, new RegExp(instanceOptions.databaseDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
      return true;
    });
    await stat(instanceOptions.databaseDir);
  } finally {
    // The fake process cannot be alive; this only removes this unit test's private fixture.
    await rm(tempRoot, { recursive: true, force: true });
  }
});
