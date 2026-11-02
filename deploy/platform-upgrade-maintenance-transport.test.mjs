import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, stat, chmod, rm, writeFile, readFile} from 'node:fs/promises';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
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

// #845: on podman, `docker exec -i ... pg_restore --list` exits after reading the
// TOC while Node is still writing a 200MB archive, so spawnSync reports EPIPE
// alongside a *successful* status. That turned a good backup into a failed step.
import {isRunFailure, runFailureMessage} from './platform-upgrade-maintenance-transport.mjs';

test('a successful child with EPIPE is not a failure', () => {
  const epipe = {status: 0, signal: null, error: Object.assign(new Error('write EPIPE'), {code: 'EPIPE'})};
  assert.equal(isRunFailure(epipe, [0]), false);
  assert.equal(isRunFailure(epipe, [0, 1]), false);
  // A missing binary (status null) stays a failure even with an `error` object.
  assert.equal(isRunFailure({status: null, error: Object.assign(new Error('spawn failed'), {code: 'ENOENT'})}, [0]), true);
  assert.equal(isRunFailure({status: 1}, [0]), true);
  assert.equal(isRunFailure({status: 1}, [0, 1]), false);
  assert.equal(isRunFailure({status: 125}, [0, 1]), true);
  assert.equal(isRunFailure(undefined, [0]), true);
});

test('failure detail carries exit status instead of "output suppressed", and hides stderr by default', () => {
  const result = {status: 125, signal: 'SIGTERM', error: {code: 'EPIPE'}, stderr: Buffer.from('password=s3cret refused')};
  const message = runFailureMessage(['exec', '-i', 'pg'], result, {debugStderr: false});
  assert.match(message, /docker exec exit 125/);
  assert.match(message, /signal SIGTERM/);
  assert.match(message, /error EPIPE/);
  assert.doesNotMatch(message, /s3cret/);
  assert.doesNotMatch(message, /output suppressed/);
});

test('opted-in stderr is redacted and bounded', () => {
  const stderr = Buffer.from(`FATAL: password=topsecret for postgres://runtime:topsecret@127.0.0.1/deepsonar${'x'.repeat(2000)}`);
  const message = runFailureMessage(['exec'], {status: 1, stderr}, {debugStderr: true});
  assert.doesNotMatch(message, /topsecret/);
  assert.match(message, /password=<redacted>/);
  assert.match(message, /postgres:\/\/<redacted>/);
  assert.ok(message.length < 700, `message must stay bounded, was ${message.length}`);
});

test('host upgrade paths no longer wait on compose health (podman never runs it)', () => {
  const root = fileURLToPath(new URL('..', import.meta.url));
  for (const file of ['deploy/platform-upgrade-maintenance-host.mjs', 'deploy/platform-upgrade-host.mjs']) {
    const source = readFileSync(`${root}/${file}`, 'utf8');
    // Comments may still explain the removal; the command itself must not pass it.
    for (const call of source.match(/dc\(\['up'[^\]]*\]/gu) ?? []) {
      assert.doesNotMatch(call, /--wait/, `${file} must assert readiness over HTTP, not compose health: ${call}`);
    }
    assert.match(source, /dc\(\['up', '-d', '--no-deps'[^\]]*\]/u, `${file} must still start services`);
  }
});
