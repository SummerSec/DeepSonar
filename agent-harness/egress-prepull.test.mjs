import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createRequire} from 'node:module';

const {parse} = createRequire(new URL('../apps/scheduler/package.json', import.meta.url))('yaml');
const image = `docker.io/opensandbox/egress@sha256:${'a'.repeat(64)}`;
const config = `[egress]\nimage = "${image}"\n`;

// Exercise the checked-in run blocks, so duplicated release/PR scripts cannot
// drift away from a separately tested helper. No Docker daemon or waits needed.
function workflowScript(name) {
  const source = readFileSync(new URL(`../.github/workflows/${name}`, import.meta.url), 'utf8');
  const steps = Object.values(parse(source).jobs).flatMap(job => job.steps ?? [])
    .filter(step => step.name === 'Pre-pull the pinned sandbox egress sidecar');
  assert.equal(steps.length, 1, `${name}: expected exactly one pre-pull step`);
  assert.equal(typeof steps[0].run, 'string');
  return steps[0].run;
}

function run(script, {contents = config, successAt = 0, grepStub} = {}) {
  const root = mkdtempSync(join(tmpdir(), 'egress-prepull-'));
  try {
    const bin = join(root, 'bin');
    mkdirSync(bin);
    mkdirSync(join(root, 'deploy/opensandbox'), {recursive: true});
    if (contents !== null) writeFileSync(join(root, 'deploy/opensandbox/config.toml'), contents);
    writeFileSync(join(root, 'calls'), '');
    writeFileSync(join(root, 'count'), '0\n');
    writeFileSync(join(bin, 'docker'), `#!/bin/bash
set -eu
printf 'docker %s\\n' "$*" >> "$PREPULL_ROOT/calls"
read -r count < "$PREPULL_ROOT/count"
count=$((count + 1))
printf '%s\\n' "$count" > "$PREPULL_ROOT/count"
[ "$count" -eq "$PREPULL_SUCCESS_AT" ]
`, {mode: 0o755});
    writeFileSync(join(bin, 'sleep'), `#!/bin/bash
printf 'sleep %s\\n' "$*" >> "$PREPULL_ROOT/calls"
`, {mode: 0o755});
    if (grepStub !== undefined) writeFileSync(join(bin, 'grep'), `#!/bin/bash\n${grepStub}\n`, {mode: 0o755});
    const result = spawnSync('bash', ['--noprofile', '--norc', '-euo', 'pipefail', '-c', script], {
      cwd: root, encoding: 'utf8', timeout: 5000,
      env: {...process.env, PATH: `${bin}:${process.env.PATH}`, PREPULL_ROOT: root, PREPULL_SUCCESS_AT: String(successAt)},
    });
    assert.ifError(result.error);
    assert.equal(result.signal, null);
    return {...result, calls: readFileSync(join(root, 'calls'), 'utf8').trim().split('\n').filter(Boolean)};
  } finally {
    rmSync(root, {recursive: true, force: true});
  }
}

for (const workflow of ['reverse-runtime.yml', 'release.yml']) {
  const script = workflowScript(workflow);
  for (const [label, options] of [
    ['no pin', {contents: '[egress]\n'}],
    ['empty config', {contents: ''}],
    ['mutable tag', {contents: 'image = "docker.io/opensandbox/egress:v1"\n'}],
    ['invalid digest', {contents: 'image = "docker.io/opensandbox/egress@sha256:invalid"\n'}],
    ['missing config', {contents: null}],
    ['empty extraction', {grepStub: 'exit 0'}],
    ['extraction error with output', {grepStub: `printf '%s\\n' '${image}'; exit 2`}],
  ]) {
    test(`${workflow}: ${label} fails explicitly before pulling or sleeping`, () => {
      const result = run(script, options);
      assert.equal(result.status, 1);
      assert.match(result.stderr, /pinned egress sidecar image not found in deploy\/opensandbox\/config\.toml/);
      assert.deepEqual(result.calls, []);
    });
  }

  test(`${workflow}: four failures back off only before another attempt`, () => {
    const result = run(script);
    assert.equal(result.status, 1);
    assert.deepEqual(result.calls, [
      `docker pull ${image}`, 'sleep 10', `docker pull ${image}`, 'sleep 20',
      `docker pull ${image}`, 'sleep 30', `docker pull ${image}`,
    ]);
    assert.equal((result.stderr.match(/retrying/g) ?? []).length, 3);
    assert.match(result.stderr, /pinned egress sidecar image could not be pulled:/);
  });

  for (const successAt of [1, 2, 3, 4]) {
    test(`${workflow}: success on attempt ${successAt} stops immediately`, () => {
      const result = run(script, {successAt});
      assert.equal(result.status, 0);
      const expected = [];
      for (let attempt = 1; attempt <= successAt; attempt++) {
        expected.push(`docker pull ${image}`);
        if (attempt < successAt) expected.push(`sleep ${attempt * 10}`);
      }
      assert.deepEqual(result.calls, expected);
      assert.equal((result.stderr.match(/retrying/g) ?? []).length, successAt - 1);
      assert.doesNotMatch(result.stderr, /could not be pulled|not found/);
    });
  }
}
