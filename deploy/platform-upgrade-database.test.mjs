import test from 'node:test';
import assert from 'node:assert/strict';
import { createDatabaseFence, databaseIdentity } from './platform-upgrade-database.mjs';

const base = () => ({runtimeRole: 'deepsonar', admin: databaseIdentity('ds_admin'), operationId: 'test_operation_123'});
test('database identities are random, bounded and independently generated', () => {
  const a = databaseIdentity(), b = databaseIdentity();
  assert.notEqual(a.role, b.role); assert.notEqual(a.password, b.password);
  assert.match(a.role, /^[a-z][a-z0-9_]{0,62}$/); assert.equal(a.password.length, 64);
  assert.throws(() => databaseIdentity("x';DROP ROLE y"), /invalid/);
});
test('invalid identity cannot reach the runner', () => {
  let calls = 0;
  assert.throws(() => createDatabaseFence({...base(), runtimeRole: 'bad"role', runSql: () => calls++}), /invalid/);
  assert.equal(calls, 0);
});
test('runner errors cannot expose SQL or credentials', async () => {
  const config = base();
  const f = createDatabaseFence({...config, runSql: async () => { throw new Error(config.admin.password); }});
  await assert.rejects(f.verify(), error => {
    assert.equal(error.message.includes(config.admin.password), false);
    assert.match(error.message, /suppressed/); return true;
  });
});
test('unknown LOGIN writer fails before any identity mutation', async () => {
  const calls = [], config = base();
  const f = createDatabaseFence({...config, runSql: async input => {
    calls.push(input.sql);
    if (input.sql.includes('pg_control_system')) return {id: '12345'};
    return [{name: 'deepsonar', login: true, superuser: true}, {name: 'other_writer', login: true, superuser: false}];
  }});
  await assert.rejects(f.fence(), /unknown login/);
  assert.equal(calls.length, 2); assert.ok(calls.every(sql => sql.startsWith('SELECT ')));
});
test('same-name administrator without operation ownership is not adopted', async () => {
  const config = base();
  const f = createDatabaseFence({...config, runSql: async () => [
    {name: 'deepsonar', login: true, superuser: true},
    {name: config.admin.role, login: true, superuser: true, marker: 'someone-else'},
  ]});
  await assert.rejects(f.bootstrap(), /not owned/);
});
test('unbounded waits and system database scopes are rejected', () => {
  for (const timeoutMs of [Infinity, NaN, -1]) assert.throws(() => createDatabaseFence({...base(), runSql() {}, timeoutMs}), /bounded/);
  assert.throws(() => createDatabaseFence({...base(), runSql() {}, dedicatedDatabases: ['postgres']}), /system database/);
});
test('logical subscriptions block fence before role mutation', async () => {
  const config = base(), calls = [];
  const f = createDatabaseFence({...config, runSql: async input => {
    calls.push(input.sql);
    if (input.sql.includes('pg_control_system')) return {id: '12345'};
    if (input.sql.includes('FROM pg_subscription')) return 1;
    return [{name: 'deepsonar', oid: 10, login: true, superuser: true}];
  }});
  await assert.rejects(f.fence(), /logical subscriptions/);
  assert.equal(calls.some(sql => sql.includes('ALTER ROLE')), false);
});
