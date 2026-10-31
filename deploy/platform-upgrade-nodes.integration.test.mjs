import {startLoopbackSshFixture} from './platform-upgrade-nodes-ssh.fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdir, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {createHash, randomUUID} from 'node:crypto';
import {createManagedNodeRunner} from './platform-upgrade-nodes.mjs';
const IMAGE = 'node:22-bookworm-slim@sha256:f32b81066cde10a75dbac96646099533316d94bac4150c55da1636e1f0ffdc46';
const hash = value => createHash('sha256').update(value).digest('hex');
const exec = (command, args) => execFileSync(command, args, {encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 180000});
test('real loopback SSH stdin actor prepares, inspects and fences isolated worker and control Compose projects', {skip: process.env.DEEPSONAR_TEST_MANAGED_NODE_SSH !== '1' ? 'set DEEPSONAR_TEST_MANAGED_NODE_SSH=1 with sshd and cached pinned Node image' : false, timeout: 180000}, async () => {
  const ssh = await startLoopbackSshFixture();
  const {directory, sshOptions} = ssh;
  const projects = []; let sampler; let leaked = false; let sawSsh = false;
  try {
    exec('docker', ['image', 'inspect', IMAGE]);
    const controlImages = JSON.parse(process.env.DEEPSONAR_TEST_MANAGED_CONTROL_IMAGES || '{}');
    for (const service of ['scheduler', 'web', 'image-admission']) { assert.ok(controlImages[service], 'three cached platform digest refs are required'); exec('docker', ['image', 'inspect', controlImages[service]]); }
    const generation = randomUUID(); const token = 'isolated-$ssh-token-' + randomUUID();
    const password = 'isolated-$db-' + randomUUID();
    const nodes = [];
    for (const kind of ['worker', 'control']) {
      const root = join(directory, kind); await mkdir(root);
      const project = `ssh-${kind}-${directory.split('-').at(-1).toLowerCase()}`;
      const node = {id: kind, kind, ssh_host: ssh.sshHost, directory: root, project, compose_files: ['compose.json']}; nodes.push(node);
      const idle = {image: IMAGE, pull_policy: 'never', command: ['node', '-e', 'setInterval(()=>{},1000)']};
      const health = "require('http').createServer((q,s)=>s.end(JSON.stringify({maintenance_ready:true,upgrade_phase:'preparing',upgrade_generation:process.env.DEEPSONAR_UPGRADE_GENERATION,upgrade_runtime_role:process.env.DEEPSONAR_RUNTIME_ROLE,upgrade_target_version:process.env.DEEPSONAR_VERSION}))).listen(3100,'127.0.0.1')";
      if (kind === 'worker') await writeFile(join(root, 'old-worker.mjs'), 'setInterval(()=>{},1000);');
      const services = kind === 'worker' ? {'worker-agent': {...idle, command: ['node', '/agent/worker-register.mjs'], environment: {DEEPSONAR_WORKER_NODE_ID: 'worker'}, volumes: ['state:/var/lib/deepsonar-worker', {type: 'bind', source: join(root, 'old-worker.mjs'), target: '/agent/worker-register.mjs', read_only: true}]}, opensandbox: idle} : {scheduler: {...idle, command: ['node', '-e', health]}, web: idle, 'image-admission': idle};
      await writeFile(join(root, 'compose.json'), JSON.stringify({services, ...(kind === 'worker' ? {volumes: {state: {}}} : {})}));
      const args = ['compose', '--project-directory', root, '--project-name', project, '--file', join(root, 'compose.json')]; projects.push(args);
      exec('docker', [...args, 'up', '-d', '--wait']);
      if (kind === 'worker') exec('docker', [...args, 'exec', '-T', 'worker-agent', 'node', '-e', "require('fs').writeFileSync('/var/lib/deepsonar-worker/identity','original-installation')"]);
    }
    const runner = createManagedNodeRunner({inventory: {nodes}, registeredWorkerIds: ['worker'], sshOptions});
    const workerScript = "import {writeFileSync} from 'node:fs';import {protocol} from './worker-register-contract.mjs';writeFileSync('/var/lib/deepsonar-worker/candidate',String(protocol));setInterval(()=>{},1000);\n"; const workerContract = 'export const protocol = 1;\n';
    sampler = setInterval(() => { try { const args = exec('ps', ['-C', 'ssh', '-C', 'docker', '-o', 'args=']); sawSsh ||= args.includes('node -e'); leaked ||= args.includes(token) || args.includes(password); } catch {} }, 50);
    const evidence = await runner.prepareWorker({id: 'worker', generation, version: '0.5.7', generationToken: token, workerScript, workerContract, workerScriptSha256: hash(workerScript), workerContractSha256: hash(workerContract)});
    assert.equal(evidence.script_sha256, hash(workerScript)); assert.equal(evidence.token_sha256, hash(token));
    assert.deepEqual(await runner.inspect({id: 'worker', generation}), evidence);
    assert.equal(exec('docker', [...projects[0], 'exec', '-T', 'worker-agent', 'node', '-e', "process.stdout.write(require('fs').readFileSync('/var/lib/deepsonar-worker/identity'))"]), 'original-installation');
    assert.equal(exec('docker', [...projects[0], 'exec', '-T', 'worker-agent', 'node', '-e', "process.stdout.write(require('fs').readFileSync('/var/lib/deepsonar-worker/candidate'))"]), '1');
    const control = await runner.prepareControl({id: 'control', generation, version: '0.5.7', runtimeRole: 'candidate_fixture', databaseUrl: `postgres://candidate_fixture:${password}@db/candidate`, images: controlImages});
    assert.equal(control.health.upgrade_generation, generation);
    assert.deepEqual(await runner.inspect({id: 'control', generation}), control);
    const logs = ssh.logs() + JSON.stringify({evidence, control}) + exec('ps', ['-eo', 'args']);
    assert.equal(leaked, false); assert.equal(sawSsh, true);
    assert.ok(!logs.includes(token)); assert.ok(!logs.includes(password)); assert.ok(!logs.includes(workerScript));
    for (const node of nodes) assert.equal((await runner.fence({id: node.id, generation})).stopped, true);
    for (const args of projects) assert.equal(exec('docker', [...args, 'ps', '--status', 'running', '--quiet']).trim(), '');
  } catch (error) {
    throw new Error(`${error.message}\nIsolated sshd: ${ssh.logs()}`);
  } finally {
    clearInterval(sampler);
    const failures = [];
    for (const args of projects.reverse()) { try { exec('docker', [...args, 'down', '--volumes', '--remove-orphans']); } catch { failures.push('isolated Compose cleanup failed'); } }
    await ssh.close();
    assert.deepEqual(failures, []);
  }
});
