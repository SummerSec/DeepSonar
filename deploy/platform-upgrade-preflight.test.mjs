import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, writeFile, chmod, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {collectPreflightHostFiles} from './platform-upgrade-preflight.mjs';
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
    compose.services.scheduler.volumes = []; [proof] = await collectPreflightHostFiles(compose); assert.equal(proof.exists, false);
    compose.secrets = {master: {file: source}}; compose.services.scheduler.secrets = [{source: 'master', target: 'key'}];
    [proof] = await collectPreflightHostFiles(compose); assert.equal(proof.exists, true); assert.equal(proof.read_only, true);
  } finally { await rm(directory, {recursive: true, force: true}); }
});
