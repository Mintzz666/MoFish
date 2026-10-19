import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createTestDb, USERS } from './harness.mjs';

test('standalone B cloud SQL acceptance passes all checks and rolls back its own fixtures only', async t => {
  const db = await createTestDb();
  t.after(() => db.close());
  await db.addUser(USERS.alice, 'untouched-sql-witness@example.test');
  const sql = await readFile(new URL('../../scripts/phase-b-sql-acceptance.sql', import.meta.url), 'utf8');
  const results = await db.db.exec(sql);
  const checks = results.at(-1).rows[0].checks;
  assert.equal(Object.keys(checks).length, 31);
  assert.ok(Object.values(checks).every(value => value === true));
  assert.deepEqual(await db.query('select id from auth.users'), [{ id: USERS.alice }]);
  assert.deepEqual(await db.query('select count(*)::integer as n from public.aquariums'), [{ n: 0 }]);
  assert.deepEqual(await db.query('select count(*)::integer as n from public.mofish_feed_events'), [{ n: 0 }]);
});
