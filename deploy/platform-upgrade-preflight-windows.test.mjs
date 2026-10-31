import test from 'node:test';
import assert from 'node:assert/strict';
import {probeWindowsMasterKey} from './platform-upgrade-preflight-windows.mjs';
const binding = {file: 'C:\\private\\master.key', image: `example.test/platform@sha256:${'a'.repeat(64)}`, user: '1000:1000'};

test('Windows file key requires ACL checks and actual target-user read-only probe', async () => {
  let checks = 0, output;
  const value = await probeWindowsMasterKey({...binding,
    assertPrivateFile: async file => {assert.equal(file, binding.file); checks++;},
    run: (command, args, options) => {
      assert.equal(checks, 1); assert.equal(command, 'docker');
      for (const option of ['--network=none', '--read-only', '--cap-drop=ALL', '--security-opt=no-new-privileges']) assert.ok(args.includes(option));
      assert.equal(args[args.indexOf('--user') + 1], binding.user);
      assert.ok(args.includes(`type=bind,source=${binding.file},target=/run/deepsonar-preflight-key,readonly`));
      assert.ok(args.includes(binding.image)); assert.equal(options.timeout, 30000);
      output = Buffer.from(JSON.stringify({mode: 0o777, content: 'a'.repeat(64)}));
      return {status: 0, stdout: output};
    }});
  assert.equal(checks, 2); assert.equal(value.mode, 0o777); assert.equal(value.content, 'a'.repeat(64));
  assert.ok(output.every(byte => byte === 0));
});

test('ACL rejection never invokes Docker; invalid target identity and mount input fail closed', async () => {
  let invoked = false;
  await assert.rejects(probeWindowsMasterKey({...binding, assertPrivateFile: async () => {throw Error('unsafe ACL');}, run: () => {invoked = true;}}));
  assert.equal(invoked, false);
  for (const change of [{image: 'example.test/platform:latest'}, {file: 'C:\\key,readonly'}, {user: 'root'}]) {
    await assert.rejects(probeWindowsMasterKey({...binding, ...change, assertPrivateFile: async () => {}}), /INVALID_BINDING/);
  }
});

test('probe failures and secret-bearing malformed output are sanitized and buffers cleared', async () => {
  for (const result of [{status: 1}, {status: 0, signal: 'SIGKILL'}, {status: 0, stdout: Buffer.from('secret-invalid-json')},
    {status: 0, stdout: Buffer.from(JSON.stringify({mode: 0o600, content: 'x'.repeat(4097)}))}]) {
    result.stderr = Buffer.from('secret diagnostic');
    await assert.rejects(probeWindowsMasterKey({...binding, assertPrivateFile: async () => {}, run: () => result}), {message: 'WINDOWS_KEY_PROBE_FAILED'});
    assert.ok(result.stderr.every(byte => byte === 0));
    assert.ok(!result.stdout || result.stdout.every(byte => byte === 0));
  }
});
