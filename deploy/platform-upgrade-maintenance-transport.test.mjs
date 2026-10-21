import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, stat, chmod, rm, writeFile, readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createMaintenanceTransport, durablePrivateWrite, readPrivateJson, SQL_PROGRAM} from './platform-upgrade-maintenance-transport.mjs';

test('private durable state rejects broadly readable credentials and supports replacement', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'maintenance-store-'));
  try {
    const path = join(directory, 'identity.json');
    assert.equal(await readPrivateJson(path), null);
    await durablePrivateWrite(path, JSON.stringify({generation: 'one'}));
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    await durablePrivateWrite(path, JSON.stringify({generation: 'two'}));
    assert.deepEqual(await readPrivateJson(path), {generation: 'two'});
    await chmod(path, 0o644);
    await assert.rejects(readPrivateJson(path), /unsafe permissions/);
  } finally {await rm(directory, {recursive: true, force: true});}
});

test('SQL credentials and SQL stay on stdin, target transport is confined to PostgreSQL network', async () => {
  const calls = [], password = 'secret-never-in-argv', sql = "SELECT 'private-query'";
  const transport = createMaintenanceTransport({compose: ['compose', '-p', 'fixture'], commandEnv: {}, run: (args, input, env) => {
    calls.push({args, input, env});
    return args.includes('ps') ? Buffer.from('a'.repeat(64)) : Buffer.from('[{"value":true}]');
  }});
  assert.equal(await transport.scalar({image: 'target@sha256:abc', role: 'runtime', password, database: 'candidate', sql}), true);
  const operation = calls[1];
  assert.equal(operation.args.includes('--read-only'), true);
  assert.equal(operation.args.includes(`container:${'a'.repeat(64)}`), true);
  assert.equal(operation.args.includes(SQL_PROGRAM), true);
  assert.equal(JSON.stringify(operation.args).includes(password), false);
  assert.equal(JSON.stringify(operation.args).includes(sql), false);
  assert.equal(JSON.parse(operation.input).connection.password, password);
  assert.equal(JSON.parse(operation.input).sql, sql);
});

test('archive password uses an environment key without its value in arguments', () => {
  const calls = [];
  const transport = createMaintenanceTransport({compose: ['compose'], commandEnv: {}, run: (args, input, env) => {
    calls.push({args, input, env}); return args.includes('ps') ? Buffer.from('b'.repeat(64)) : Buffer.from('archive');
  }});
  transport.archive({action: 'pg_dump', role: 'admin', password: 'hidden-secret', database: 'source'});
  assert.equal(calls[1].args.includes('PGPASSWORD'), true);
  assert.equal(JSON.stringify(calls[1].args).includes('hidden-secret'), false);
  assert.equal(calls[1].env.PGPASSWORD, 'hidden-secret');
});

test('ambiguous PostgreSQL container selection fails closed', async () => {
  const transport = createMaintenanceTransport({compose: ['compose'], commandEnv: {}, run: () => Buffer.from('one\ntwo')});
  await assert.rejects(transport.rows({image: 'target', role: 'admin', password: 'hidden', database: 'source', sql: 'SELECT 1'}), /one running/);
});
test('schema CLI exit status must agree with its structured success report', async () => {
  const transport = createMaintenanceTransport({compose: ['compose'], commandEnv: {}, run: args => args.includes('ps') ? Buffer.from('c'.repeat(64)) : {status: 1, stdout: Buffer.from(JSON.stringify({schema: 'deepsonar.schema-upgrade-result/v1', ok: true}))}});
  await assert.rejects(transport.schema({image: 'target', role: 'admin', password: 'hidden', database: 'source', action: 'plan', source_database: 'source'}), /invalid schema CLI response/);
});
