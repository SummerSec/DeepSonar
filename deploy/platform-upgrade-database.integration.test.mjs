import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createDatabaseFence, databaseIdentity } from './platform-upgrade-database.mjs';

// Explicit opt-in: this suite creates and removes only its unique disposable PG container.
const enabled = process.env.DEEPSONAR_FENCE_PG_TEST === '1';
test('isolated PostgreSQL role fencing, DML-only generation and interruption retries', {skip: !enabled}, async () => {
  const name = `pr747-fence-${randomBytes(8).toString('hex')}`;
  const docker = (args, input) => execFileSync('docker', args, {input, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 30_000});
  const sql = ({role, database = 'postgres', sql}) => {
    // Container-local trust deliberately tests that NOLOGIN also blocks passwordless access.
    return docker(['exec', '-i', name, 'psql', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-U', role, '-d', database], sql);
  };
  const scalar = args => JSON.parse(sql(args).trim());
  const admin = databaseIdentity('ds_admin'), next = {...databaseIdentity('ds_runtime'), database: 'business'};
  const operationId = randomBytes(16).toString('hex');
  const config = {runSql: sql, runtimeRole: 'deepsonar', admin, operationId, runtimeIdentities: [next.role], dedicatedDatabases: ['business']};
  let session, containerCreated = false;
  try {
    docker(['run', '-d', '--name', name, '--label', `deepsonar.test=${name}`, '--tmpfs', '/var/lib/postgresql/data', '-e', 'POSTGRES_USER=deepsonar', '-e', 'POSTGRES_HOST_AUTH_METHOD=trust', 'postgres:16-alpine', '-c', 'max_prepared_transactions=2']);
    containerCreated = true;
    let ready = false;
    for (let i = 0; i < 100; i++) {
      try { docker(['exec', name, 'pg_isready', '-h', '127.0.0.1', '-U', 'deepsonar']); if (scalar({role: 'deepsonar', sql: 'SELECT 1;'}) === 1) { ready = true; break; } } catch {}
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.equal(ready, true, 'isolated database started');
    sql({role: 'deepsonar', sql: 'CREATE DATABASE business; CREATE ROLE unexpected LOGIN SUPERUSER;'});
    sql({role: 'deepsonar', database: 'business', sql: 'CREATE TABLE owner_data(id int); INSERT INTO owner_data VALUES (1); GRANT CREATE ON SCHEMA public TO PUBLIC;'});
    const f = createDatabaseFence(config);
    await assert.rejects(f.bootstrap(), /unknown login/);
    assert.equal(scalar({role: 'deepsonar', sql: "SELECT to_json(rolsuper) FROM pg_roles WHERE rolname='deepsonar';"}), true);
    sql({role: 'deepsonar', sql: 'DROP ROLE unexpected;'});
    await f.bootstrap(); await f.bootstrap();
    session = spawn('docker', ['exec', '-i', name, 'psql', '-X', '-qAt', '-U', 'deepsonar', '-d', 'business'], {stdio: ['pipe', 'pipe', 'pipe']});
    session.stdin.end("SET application_name='not-scheduler'; SELECT pg_sleep(60);");
    let count = 0;
    for (let i = 0; i < 50; i++) {
      count = scalar({role: admin.role, sql: "SELECT count(*)::int FROM pg_stat_activity WHERE usename='deepsonar' AND datname='business';"});
      if (count) break;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.equal(count, 1);
    // A lost response after committing NOLOGIN must not cause a reopening on retry.
    let loseFenceResponse = true;
    const interrupted = createDatabaseFence({...config, runSql: input => {
      const output = sql(input);
      if (loseFenceResponse && input.sql.includes('ALTER ROLE') && input.sql.includes('NOLOGIN')) { loseFenceResponse = false; throw new Error('connection lost after commit'); }
      return output;
    }});
    await assert.rejects(interrupted.fence(), /suppressed/);
    const receipt = await f.fence();
    assert.equal(receipt.stage, 'fenced'); assert.ok(receipt.runtimeRoleOid); assert.match(receipt.clusterSystemIdentifier, /^\d+$/);
    assert.equal(JSON.stringify(receipt).includes(admin.password), false);
    // Retry from a new controller models a crash after disabling the old identity.
    const retry = createDatabaseFence(config);
    await retry.bootstrap(); await retry.fence(); await retry.verify();
    sql({role: admin.role, sql: "BEGIN; SELECT 1; PREPARE TRANSACTION 'fence_test';"});
    await assert.rejects(retry.verify(), /prepared transactions/);
    sql({role: admin.role, sql: "ROLLBACK PREPARED 'fence_test';"});
    for (const database of ['postgres', 'business', 'template1']) {
      assert.throws(() => sql({role: 'deepsonar', database, sql: 'SELECT 1;'}), /not permitted to log in/);
    }
    let loseCreateResponse = true;
    const interruptedCreate = createDatabaseFence({...config, runSql: input => {
      const output = sql(input);
      if (loseCreateResponse && input.sql.includes('CREATE ROLE')) { loseCreateResponse = false; throw new Error('lost role creation response'); }
      return output;
    }});
    await assert.rejects(interruptedCreate.createRuntime(next), /suppressed/);
    const runtimeReceipt = await retry.createRuntime(next); await retry.createRuntime(next);
    assert.ok(runtimeReceipt.privilegesChanged.includes('public_schema_create_revoked_from_public'));
    assert.equal(scalar({role: next.role, database: 'business', sql: "SELECT to_json(has_schema_privilege(current_user,'public','CREATE'));"}), false);
    assert.equal(scalar({role: next.role, database: 'business', sql: 'SELECT to_json(rolsuper) FROM pg_roles WHERE rolname=current_user;'}), false);
    // Only DML is allowed; neither owner DDL nor SET ROLE can recover bootstrap powers.
    sql({role: next.role, database: 'business', sql: 'INSERT INTO owner_data(id) VALUES (2);'});
    assert.throws(() => sql({role: next.role, database: 'business', sql: 'ALTER TABLE owner_data ADD COLUMN note text;'}));
    assert.throws(() => sql({role: next.role, database: 'business', sql: 'SET ROLE deepsonar;'}));
    assert.equal(scalar({role: next.role, database: 'business', sql: 'SELECT count(*)::int FROM owner_data;'}), 2);
    assert.throws(() => sql({role: next.role, database: 'business', sql: 'ALTER ROLE deepsonar LOGIN;'}));
    sql({role: admin.role, database: 'business', sql: `CREATE TABLE platform_upgrade_state(id text, phase text, generation text, runtime_role text); INSERT INTO platform_upgrade_state VALUES('global','preparing','${operationId}','${next.role}');`});
    await retry.suspendRuntime(next.role, {database: 'business', generation: operationId});
    assert.throws(() => sql({role: next.role, database: 'business', sql: 'SELECT 1;'}));
    await retry.createRuntime(next);
    sql({role: admin.role, database: 'business', sql: "UPDATE platform_upgrade_state SET phase='active'"});
    await assert.rejects(retry.suspendRuntime(next.role, {database: 'business', generation: operationId}), /suppressed/);
    assert.equal(scalar({role: next.role, database: 'business', sql: 'SELECT 1;'}), 1);
    await retry.revokeRuntime(next.role); await retry.revokeRuntime(next.role);
    assert.throws(() => sql({role: next.role, database: 'business', sql: 'SELECT 1;'}), /not permitted to log in/);
    await assert.rejects(retry.createRuntime(next), /attributes mismatch/);
    await retry.verify();
    const currentForSecond = {...databaseIdentity('ds_runtime'), database: 'business'};
    await retry.createRuntime(currentForSecond);
    const successor = {...databaseIdentity('ds_runtime'), database: 'business'};
    const secondConfig = {...config, runtimeRole: currentForSecond.role,
      operationId: randomBytes(16).toString('hex'), adminOperationId: operationId,
      expectedClusterSystemIdentifier: receipt.clusterSystemIdentifier, runtimeIdentities: [successor.role]};
    const wrongCluster = createDatabaseFence({...secondConfig, expectedClusterSystemIdentifier: '1'});
    await assert.rejects(wrongCluster.bootstrap(), /cluster identity mismatch/);
    const second = createDatabaseFence(secondConfig);
    await second.bootstrap(); await second.fence(); await second.createRuntime(successor);
    assert.throws(() => sql({role: currentForSecond.role, database: 'business', sql: 'SELECT 1;'}));
    sql({role: successor.role, database: 'business', sql: 'INSERT INTO owner_data(id) VALUES (3);'});
    assert.equal(scalar({role: successor.role, database: 'business', sql: 'SELECT count(*)::int FROM owner_data;'}), 3);
    await second.revokeRuntime(successor.role); await second.verify();
  } finally {
    if (session && session.exitCode === null) session.kill();
    // Never prune, reuse a deployment container, or remove an unrelated volume.
    if (containerCreated) docker(['rm', '-f', name]);
  }
});
