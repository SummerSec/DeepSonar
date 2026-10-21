import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, writeFile, chmod, rm, symlink, mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {collectPreflightHostFiles, resolveComposeEnvironment} from './platform-upgrade-preflight.mjs';
test('host evidence binds exact rendered secret path and preserves unavailable evidence', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'preflight-files-'));
  try {
    const source = path.join(directory, 'key'); await writeFile(source, 'must-not-leak', {mode: 0o600});
    const compose = {services: {scheduler: {environment: {DEEPSONAR_MASTER_KEY_FILE: '/run/secrets/key'}, volumes: [{type: 'bind', source, target: '/run/secrets/key', read_only: true}]}}};
    let [proof] = await collectPreflightHostFiles(compose);
    assert.equal(proof.readable, true); assert.equal(proof.regular_file, true); assert.equal(proof.mode, 0o600);
    assert.ok(!JSON.stringify(proof).includes('must-not-leak')); assert.ok(!JSON.stringify(proof).includes(directory));
    compose.services.scheduler.user = '65534:65534';
    [proof] = await collectPreflightHostFiles(compose); assert.equal(proof.readable, false);
    await chmod(source, 0o644); [proof] = await collectPreflightHostFiles(compose); assert.equal(proof.readable, true);
    const link = path.join(directory, 'link'); await symlink(source, link);
    compose.services.scheduler.volumes[0].source = link;
    [proof] = await collectPreflightHostFiles(compose); assert.equal(proof.readable, true);
    compose.services.scheduler.volumes = []; [proof] = await collectPreflightHostFiles(compose); assert.equal(proof.exists, false);
    compose.secrets = {master: {file: source}}; compose.services.scheduler.secrets = [{source: 'master', target: 'key'}];
    [proof] = await collectPreflightHostFiles(compose); assert.equal(proof.exists, true); assert.equal(proof.read_only, true);
  } finally { await rm(directory, {recursive: true, force: true}); }
});

test('directory bind rejects internal symlinks and requires traversable parents for target uid', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'preflight-directory-'));
  try {
    await chmod(directory, 0o755);
    const nested = path.join(directory, 'nested'); await mkdir(nested, {mode: 0o700});
    await writeFile(path.join(nested, 'key'), 'not-read', {mode: 0o644});
    await chmod(path.join(nested, 'key'), 0o644);
    const service = {user: '65534:65534', environment: {DEEPSONAR_MASTER_KEY_FILE: '/secrets/nested/key'}, volumes: [{type: 'bind', source: directory, target: '/secrets', read_only: true}]};
    const compose = {services: {scheduler: service}};
    let [proof] = await collectPreflightHostFiles(compose); assert.equal(proof.readable, false);
    await chmod(nested, 0o755); [proof] = await collectPreflightHostFiles(compose); assert.equal(proof.readable, true);
    service.volumes.push({type: 'volume', source: 'unknown', target: '/secrets/nested', read_only: true});
    [proof] = await collectPreflightHostFiles(compose); assert.equal(proof.readable, false);
    service.volumes.pop();
    await symlink(path.join(nested, 'key'), path.join(directory, 'link'));
    service.environment.DEEPSONAR_MASTER_KEY_FILE = '/secrets/link';
    [proof] = await collectPreflightHostFiles(compose); assert.equal(proof.readable, false);
    await symlink(nested, path.join(directory, 'linked-directory'));
    service.environment.DEEPSONAR_MASTER_KEY_FILE = '/secrets/linked-directory/key';
    [proof] = await collectPreflightHostFiles(compose); assert.equal(proof.readable, false);
    service.volumes[0].source = path.join(directory, 'linked-directory');
    service.environment.DEEPSONAR_MASTER_KEY_FILE = '/secrets/key';
    [proof] = await collectPreflightHostFiles(compose); assert.equal(proof.readable, true);
  } finally { await rm(directory, {recursive: true, force: true}); }
});

test('rendered Compose dollar escaping is decoded exactly once for values and secret paths', async () => {
  assert.deepEqual(resolveComposeEnvironment({DATABASE_URL: 'postgres://u:p$$a$$$$word@db/test'}), {DATABASE_URL: 'postgres://u:p$a$$word@db/test'});
  const directory = await mkdtemp(path.join(tmpdir(), 'preflight-dollar-'));
  try {
    const source = path.join(directory, 'key'); await writeFile(source, 'not-read', {mode: 0o600});
    const [proof] = await collectPreflightHostFiles({services: {scheduler: {environment: {DEEPSONAR_MASTER_KEY_FILE: '/run/key$$literal'}, volumes: [{type: 'bind', source, target: '/run/key$$literal', read_only: true}]}}});
    assert.equal(proof.path, '/run/key$literal'); assert.equal(proof.readable, true);
  } finally { await rm(directory, {recursive: true, force: true}); }
});
