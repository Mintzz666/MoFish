// Safety and lifecycle helpers for the real-Postgres concurrency tests.
// The test harness only accepts its own disposable embedded server. A caller
// supplied connection string cannot prove that a database or cluster roles
// are safe to modify, so it is rejected before any Postgres client is created.

import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';

const reservedPorts = new Set();

/** Keep the default opt-in skip behavior, with a strict mode for CI. */
export function embeddedPostgresStartupFailure(err, env = process.env) {
  const cleanupDetail = err.cleanupError ? ` 清理状态：${err.cleanupError.message}` : '';
  const startupFailure = `无法启动隔离的嵌入式真实 Postgres（${err.message}）。${cleanupDetail}`;
  if (env.MOFISH_REQUIRE_POSTGRES === '1') {
    throw new Error(`${startupFailure} MOFISH_REQUIRE_POSTGRES=1，真实并发验证必须启动 PostgreSQL。`, { cause: err });
  }
  return `${startupFailure} 真实并发用例标为 SKIP；MOFISH_TEST_PG_URL 不受支持。`;
}

export function rejectExternalPostgresUrl(env = process.env) {
  if (typeof env.MOFISH_TEST_PG_URL === 'string' && env.MOFISH_TEST_PG_URL.trim()) {
    throw new Error(
      'MOFISH_TEST_PG_URL is disabled for safety. These tests only use a disposable embedded PostgreSQL instance; '
      + 'unset MOFISH_TEST_PG_URL to run it. A caller-provided server may contain user databases or cluster roles.'
    );
  }
}

/** Run the embedded-server launcher only after rejecting caller-provided URLs. */
export async function withEmbeddedPostgresOnly({ env = process.env, launch }) {
  rejectExternalPostgresUrl(env);
  if (typeof launch !== 'function') throw new TypeError('launch must be a function');
  return launch();
}

/**
 * Prepare the fresh embedded cluster. Supabase migrations may drop policies
 * as part of normal idempotent setup, but setup must never reset a database or
 * cluster-level roles.
 */
export async function prepareFreshTestDatabase(admin, { supabaseEmulation, migrations, users }) {
  const statements = [
    supabaseEmulation,
    ...migrations.map(migration => migration.sql),
    {
      sql: 'insert into auth.users (id, email) values ($1, $2), ($3, $4)',
      values: [users.alice, 'alice@example.com', users.bob, 'bob@example.com'],
    },
  ];

  for (const statement of statements) {
    const sql = typeof statement === 'string' ? statement : statement.sql;
    if (/\bdrop\s+(?:database|schema|owned|role|user)\b/i.test(sql)) {
      throw new Error('Concurrency-test setup refuses DROP DATABASE/SCHEMA/OWNED/ROLE/USER.');
    }
  }

  for (const statement of statements) {
    if (typeof statement === 'string') await admin.query(statement);
    else await admin.query(statement.sql, statement.values);
  }
}

async function findFreePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen({ host: '127.0.0.1', port: 0, exclusive: true }, () => {
      const address = probe.address();
      probe.close(error => error ? reject(error) : resolve(address.port));
    });
  });
}

async function reserveFreePort() {
  // Avoid duplicates between concurrent test runs in this Node process. The
  // OS chooses the candidate from its currently free port range.
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const port = await findFreePort();
    if (!reservedPorts.has(port)) {
      reservedPorts.add(port);
      return {
        port,
        release: () => reservedPorts.delete(port),
      };
    }
  }
  throw new Error('Could not reserve a unique free port for embedded PostgreSQL.');
}

/** Start one owned embedded server and clean only its unique data directory. */
export async function startOwnedEmbeddedPostgres({
  EmbeddedPostgres,
  tempRoot = os.tmpdir(),
}) {
  const dataDir = await mkdtemp(path.join(tempRoot, 'mofish-pg-concurrency-'));
  let instance = null;
  let portReservation = null;
  let cleanupStarted = false;
  let startAttempted = false;

  const cleanup = async () => {
    if (cleanupStarted) return;
    cleanupStarted = true;

    let cleanupError = null;
    let stopSucceeded = true;
    try {
      // stop() is attempted even if initialise() or start() failed partway.
      if (instance) {
        if (typeof instance.stop !== 'function' && startAttempted) {
          throw new Error('Embedded PostgreSQL instance does not expose stop().');
        }
        await instance.stop?.();
      }
    } catch (error) {
      cleanupError = error;
      stopSucceeded = false;
    }

    // A failed start() may have launched a server before rejecting. Preserve
    // its directory and reserve its port unless stop() confirms it has exited.
    const mayStillBeRunning = startAttempted && !stopSucceeded;
    if (mayStillBeRunning) {
      const report = new Error(
        `Could not confirm embedded PostgreSQL stopped; preserving ${dataDir} `
        + `and keeping port ${portReservation?.port ?? 'unknown'} reserved.`
      );
      report.cause = cleanupError;
      cleanupError = report;
    } else {
      try {
        await rm(dataDir, { recursive: true, force: true });
      } catch (error) {
        cleanupError ??= error;
      }
      portReservation?.release();
    }

    if (cleanupError) throw cleanupError;
  };

  try {
    portReservation = await reserveFreePort();
    instance = new EmbeddedPostgres({
      databaseDir: dataDir,
      user: 'postgres',
      password: 'postgres',
      port: portReservation.port,
      // The helper owns deletion. This prevents the package from removing the
      // directory itself before we know that its server process has stopped.
      persistent: true,
    });
    await instance.initialise();
    startAttempted = true;
    await instance.start();

    return {
      url: `postgresql://postgres:postgres@127.0.0.1:${portReservation.port}/postgres`,
      dataDir,
      port: portReservation.port,
      stop: cleanup,
    };
  } catch (error) {
    try {
      await cleanup();
    } catch (cleanupError) {
      if (error instanceof Error) error.cleanupError = cleanupError;
    }
    throw error;
  }
}
