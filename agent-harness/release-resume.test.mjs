import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, writeFile, readFile, rm, cp} from 'node:fs/promises';
import {execFileSync, spawnSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {resumeInputs, resumeIdentity, validateSource, remoteTag, sourceEvidence, unpackArtifact, verifiedResume} from './release-resume.mjs';
import {freezePublication, TRUST, releaseIdentity} from './platform-signature-publication.mjs';
import {publicationState} from './release-publication-state.mjs';
import {sha256} from '../deploy/platform-upgrade-signature-contract.mjs';
const repo = 'SummerSec/DeepSonar';
const commit = 'a'.repeat(40);
const env = {VERSION: '0.6.0', SOURCE_RUN_ID: '42', STAGES: 'both', GITHUB_REPOSITORY: repo,
  GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_REF: 'refs/heads/main', GITHUB_SHA: commit,
  GITHUB_WORKFLOW_REF: `${repo}/.github/workflows/release-resume.yml@refs/heads/main`};
function metadata(sha = commit) {
  const run = {id: 42, repository: {id: 7, full_name: repo}, head_repository: {id: 7, full_name: repo},
    path: '.github/workflows/release.yml', workflow_id: 8, event: 'push', head_branch: 'v0.6.0', head_sha: sha,
    status: 'completed', conclusion: 'failure', run_attempt: 1};
  const workflow = {id: 8, path: run.path};
  const jobs = Object.entries({'base-image': 'Bind stable tag, source commit and publisher identity',
    'prepare-release': 'Freeze exact validated release payload',
    'platform-signatures': 'Sign frozen GHCR indexes and verify positive and tampered metadata'}).map(([name, step]) => ({
    name, run_id: 42, run_attempt: 1, head_sha: sha, status: 'completed', conclusion: 'success',
    started_at: '2026-01-01T00:00:00Z', completed_at: '2026-01-01T01:00:00Z',
    steps: [{name: step, status: 'completed', conclusion: 'success'}],
  }));
  const artifacts = ['platform-release-payload', 'platform-signature-evidence'].map((name, index) => ({name, id: 100 + index,
    expired: false, digest: `sha256:${'a'.repeat(64)}`, created_at: '2026-01-01T00:30:00Z', expires_at: '2099-01-01T00:00:00Z',
    workflow_run: {id: 42, repository_id: 7, head_repository_id: 7, head_sha: sha, head_branch: 'v0.6.0'},
  }));
  return {run, workflow, jobs, artifacts, tagSha: sha, env};
}
function requestFor(data) {
  return async path => {
    if (path === 'actions/runs/42') return data.run;
    if (path === 'actions/workflows/release.yml') return data.workflow;
    if (path === 'git/ref/tags/v0.6.0') return {object: {type: 'tag', sha: 'b'.repeat(40)}};
    if (path === `git/tags/${'b'.repeat(40)}`) return {object: {type: 'commit', sha: data.tagSha}};
    for (const [suffix, key] of [['attempts/1/jobs', 'jobs'], ['artifacts', 'artifacts']]) {
      if (path === `actions/runs/42/${suffix}?per_page=100&page=1`) return {total_count: data[key].length, [key]: data[key]};
    }
    throw Error(`unexpected API ${path}`);
  };
}
test('strict inputs and separate recovery identity never satisfy the original publisher', () => {
  for (const STAGES of ['both', 'writeback', 'publish']) assert.equal(resumeInputs({...env, STAGES}).version, '0.6.0');
  resumeIdentity(env, commit);
  assert.throws(() => releaseIdentity(env), /identity_invalid/);
  for (const patch of [{VERSION: 'v0.6.0'}, {VERSION: '01.2.3'}, {VERSION: '1.2.3;id'}, {SOURCE_RUN_ID: '0'},
    {SOURCE_RUN_ID: '42x'}, {SOURCE_RUN_ID: '99999999999999999'}, {STAGES: 'build'}]) assert.throws(() => resumeInputs({...env, ...patch}), /inputs_invalid/);
  for (const patch of [{GITHUB_REF: 'refs/tags/v0.6.0'}, {GITHUB_WORKFLOW_REF: `${repo}/.github/workflows/evil.yml@refs/heads/main`},
    {GITHUB_REPOSITORY: 'fork/DeepSonar'}, {GITHUB_EVENT_NAME: 'pull_request'}]) assert.throws(() => resumeIdentity({...env, ...patch}, commit), /identity_invalid/);
  assert.throws(() => resumeIdentity(env, 'b'.repeat(40)), /identity_invalid/);
});
test('authenticated source binds repository, workflow, version, tag, attempt, successful phases and artifacts', async () => {
  assert.equal((await sourceEvidence(env, requestFor(metadata()))).identity.commit_sha, commit);
  const mutations = [d => d.run.id++, d => d.run.repository.full_name = 'fork/DeepSonar',
    d => d.run.head_repository.id++, d => d.run.path = '.github/workflows/ci.yml', d => d.workflow.id++,
    d => d.run.event = 'pull_request', d => d.run.head_branch = 'v0.6.1', d => d.tagSha = 'b'.repeat(40),
    d => d.run.status = 'in_progress', d => d.run.run_attempt++, d => d.jobs.pop(),
    d => d.jobs.push(d.jobs[0]), d => d.jobs[0].conclusion = 'failure', d => d.jobs[1].steps[0].conclusion = 'skipped',
    d => d.jobs[2].run_attempt++, d => d.jobs[2].head_sha = 'b'.repeat(40), d => d.artifacts.pop(),
    d => d.artifacts.push(d.artifacts[0]), d => d.artifacts[0].expired = true,
    d => d.artifacts[0].expires_at = '2020-01-01', d => delete d.artifacts[0].digest,
    d => d.artifacts[0].workflow_run.id++, d => d.artifacts[0].workflow_run.repository_id++,
    d => d.artifacts[0].workflow_run.head_sha = 'b'.repeat(40), d => d.artifacts[0].created_at = '2026-01-02T00:00:00Z'];
  for (const mutate of mutations) {const data = metadata(); mutate(data); assert.throws(() => validateSource(data), /release_resume_/);}
  await assert.rejects(sourceEvidence(env, async () => {throw Error('403');}), /403/);
  await assert.rejects(remoteTag('0.6.0', async () => ({object: {type: 'tree', sha: commit}})), /tag_invalid/);
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'resume-test-'));
  const payload = join(root, 'payload'); const signatures = join(root, 'proof');
  await mkdir(join(payload, 'deploy'), {recursive: true}); await mkdir(signatures);
  const digest = `sha256:${'1'.repeat(64)}`;
  const platform = {version: '0.6.0', commit_sha: commit, schema_version: 62, images: {}};
  for (const service of ['scheduler', 'web', 'image-admission']) {
    const ref = `ghcr.io/summersec/deepsonar-${service}@${digest}`;
    platform.images[service] = {digest, platforms: ['linux/amd64', 'linux/arm64'], child_digests: {'linux/amd64': digest, 'linux/arm64': digest},
      registry_refs: {github: ref}, registry_evidence: {github: {available: true, ref, inspect_digest: digest, provenance: 'build-push+inspect'},
        dockerhub: {available: false, reason: 'credentials_missing', provenance: 'unavailable'},
        'aliyun-acr': {available: false, reason: 'credentials_missing', provenance: 'unavailable'}}};
  }
  const catalog = JSON.stringify({platform_version: '0.6.0', platform});
  for (const path of ['deploy/runtime-image-registry.json', 'runtime-image-registry-v2.json']) await writeFile(join(payload, path), catalog);
  for (const path of ['release-body.md', 'deepsonar-reverse-evidence-0.6.0.tar.gz', 'deepsonar-management-skill-0.6.0.tar.gz']) await writeFile(join(payload, path), 'fixture');
  const freeze = await freezePublication(payload, {version: '0.6.0', commit_sha: commit});
  const bytes = JSON.stringify(freeze);
  await writeFile(join(payload, 'platform-release-freeze.json'), bytes);
  await writeFile(join(signatures, 'platform-signature-evidence.json'), JSON.stringify({freezeSha256: sha256(bytes),
    verification: {verified: true, targetSha256: freeze.targetSha256, cosignSha256: TRUST.cosignSha256, trustedRootSha256: TRUST.trustedRootSha256},
    negative: {mutation: 'schema_version_plus_one', code: 'signature_claim_mismatch'}}));
  const archives = {};
  for (const [id, dir] of [[100, payload], [101, signatures]]) {
    const zip = join(root, `${id}.zip`);
    execFileSync('zip', ['-qr', zip, '.'], {cwd: dir}); archives[id] = await readFile(zip);
  }
  const data = metadata();
  for (const artifact of data.artifacts) artifact.digest = `sha256:${sha256(archives[artifact.id])}`;
  return {root, payload, signatures, data, archives, options: {request: requestFor(data), download: async id => archives[id], git: () => commit}};
}
test('three selections verify real frozen bytes and receipt before effects; mutation cannot self-approve', async () => {
  const f = await fixture();
  try {
    for (const STAGES of ['writeback', 'publish', 'both']) await verifiedResume({...env, STAGES}, f.payload, f.signatures, f.options);
    await assert.rejects(verifiedResume(env, f.payload, f.signatures, {...f.options, git: args => args[1] === 'HEAD' ? commit : 'b'.repeat(40)}), /checkout_tag_mismatch/);
    await assert.rejects(verifiedResume(env, f.payload, f.signatures, {...f.options, download: async () => Buffer.from('replaced')}), /archive_digest_mismatch/);
    const receiptPath = join(f.signatures, 'platform-signature-evidence.json');
    const receipt = await readFile(receiptPath);
    await writeFile(receiptPath, receipt.toString().replace('true', 'false'));
    await assert.rejects(verifiedResume(env, f.payload, f.signatures, f.options), /receipt_mismatch/);
    await writeFile(receiptPath, receipt);
    await writeFile(join(f.payload, 'release-body.md'), 'replacement');
    await assert.rejects(verifiedResume(env, f.payload, f.signatures, f.options), /assets_mismatch/);
    const archive = f.data.artifacts[0];
    await assert.rejects(unpackArtifact(archive, join(f.root, 'unsafe'), ['unexpected'], f.options.download), /archive_members_invalid/);
  } finally {await rm(f.root, {recursive: true, force: true});}
});
test('tag drift after authenticated download fails closed', async () => {
  const f = await fixture(); let reads = 0;
  try {
    const request = async path => path.startsWith('git/tags/') && ++reads > 1 ? {object: {type: 'commit', sha: 'b'.repeat(40)}} : f.options.request(path);
    await assert.rejects(verifiedResume(env, f.payload, f.signatures, {...f.options, request}), /tag_changed/);
  } finally {await rm(f.root, {recursive: true, force: true});}
});
test('release lookup distinguishes absence, completed release, draft and API failures', () => {
  const run = (status, code, body = {}) => () => ({status: code, stdout: `HTTP/2.0 ${status} Status\r\nContent-Type: application/json\r\n\r\n${JSON.stringify(body)}`});
  assert.equal(publicationState(env.VERSION, repo, run(404, 1)), 'missing');
  assert.equal(publicationState(env.VERSION, repo, run(200, 0, {tag_name: 'v0.6.0', draft: false, prerelease: false})), 'existing');
  const complete = {tag_name: 'v0.6.0', draft: false, prerelease: false, assets: [{name: 'catalog.json', state: 'uploaded', digest: 'sha256:expected'}]};
  assert.equal(publicationState(env.VERSION, repo, run(200, 0, complete), {'catalog.json': 'sha256:expected'}), 'existing');
  for (const assets of [[], [{name: 'catalog.json', state: 'uploaded', digest: 'sha256:wrong'}]])
    assert.throws(() => publicationState(env.VERSION, repo, run(200, 0, {...complete, assets}), {'catalog.json': 'sha256:expected'}), /assets_conflict/);
  for (const status of [401, 403, 429, 500]) assert.throws(() => publicationState(env.VERSION, repo, run(status, 1)), /lookup_failed/);
  assert.throws(() => publicationState(env.VERSION, repo, () => ({status: 1, stdout: ''})), /lookup_failed/);
  for (const body of [{tag_name: 'v0.6.0', draft: true, prerelease: false}, {tag_name: 'v0.6.1', draft: false, prerelease: false}])
    assert.throws(() => publicationState(env.VERSION, repo, run(200, 0, body)), /conflict/);
});
test('real publish shell gates custom signature directory, creates once and never treats API errors as absence', async () => {
  const f = await fixture();
  try {
    await cp(resolve('agent-harness'), join(f.root, 'agent-harness'), {recursive: true});
    await cp(resolve('deploy'), join(f.root, 'deploy'), {recursive: true});
    const bin = join(f.root, 'bin'); await mkdir(bin);
    const gh = `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
if (args[0] === 'api') {
  const exists = fs.existsSync(process.env.MARKER);
  const status = process.env.API_FAILURE ? 403 : exists ? 200 : 404;
  console.log('HTTP/2.0 ' + status + ' Status\\nContent-Type: application/json\\n\\n' + JSON.stringify({tag_name:'v0.6.0',draft:false,prerelease:false,assets: exists ? JSON.parse(fs.readFileSync(process.env.MARKER)).filter(a => fs.existsSync(a) && fs.statSync(a).isFile()).filter(a => !a.endsWith('release-body.md')).map(a => ({name:require('node:path').basename(a),state:'uploaded',digest:'sha256:' + require('node:crypto').createHash('sha256').update(fs.readFileSync(a)).digest('hex')})) : []}));
  process.exit(status === 200 ? 0 : 1);
}
if (args[0] !== 'release' || args[1] !== 'create') throw Error('unexpected effect');
if (fs.existsSync(process.env.MARKER)) throw Error('duplicate create');
fs.writeFileSync(process.env.MARKER, JSON.stringify(args));
`;
    await writeFile(join(bin, 'gh'), gh, {mode: 0o755});
    const scriptEnv = {...process.env, VERSION: env.VERSION, GH_TOKEN: 'fixture', GITHUB_REPOSITORY: repo,
      GITHUB_REF: 'refs/tags/v0.6.0', GITHUB_SHA: commit, GITHUB_EVENT_NAME: 'push',
      GITHUB_WORKFLOW_REF: `${repo}/.github/workflows/release.yml@refs/tags/v0.6.0`,
      FREEZE_SHA256: sha256(await readFile(join(f.payload, 'platform-release-freeze.json'))),
      RECEIPT_SHA256: sha256(await readFile(join(f.signatures, 'platform-signature-evidence.json'))),
      MARKER: join(f.root, 'created'), PATH: `${bin}:${process.env.PATH}`};
    delete scriptEnv.SOURCE_RUN_ID;
    const run = (patch = {}, signature = f.signatures) => spawnSync('bash', [resolve('agent-harness/release-publish.sh'), f.payload, signature],
      {cwd: f.root, encoding: 'utf8', env: {...scriptEnv, ...patch}});
    assert.notEqual(run({API_FAILURE: '1'}).status, 0);
    assert.notEqual(run({}, join(f.root, 'missing-proof')).status, 0);
    const first = run(); assert.equal(first.status, 0, first.stderr);
    const second = run(); assert.equal(second.status, 0, second.stderr); assert.match(second.stdout, /leaving it untouched/);
    const args = JSON.parse(await readFile(scriptEnv.MARKER, 'utf8'));
    assert.ok(args.includes('--verify-tag')); assert.ok(args.includes(join(f.signatures, 'platform-signature-evidence.json')));
  } finally {await rm(f.root, {recursive: true, force: true});}
});
test('workflow commands on fresh Git checkouts recover all selections; writeback failure cannot suppress publish', async () => {
  const {createRequire} = await import('node:module');
  const yaml = createRequire(new URL('../apps/scheduler/package.json', import.meta.url))('yaml');
  const workflow = yaml.parse(await readFile(new URL('../.github/workflows/release-resume.yml', import.meta.url), 'utf8'));
  const job = workflow.jobs.resume;
  assert.equal(job.strategy['fail-fast'], false);
  assert.equal(job.steps.find(step => step.uses?.startsWith('actions/checkout')).with.ref, '${{ github.sha }}');
  const f = await fixture();
  try {
    const origin = join(f.root, 'source'); await mkdir(origin);
    const git = (cwd, ...args) => execFileSync('git', args, {cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']}).trim();
    git(origin, 'init', '--initial-branch=main');
    git(origin, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--allow-empty', '-m', 'fixture');
    const head = git(origin, 'rev-parse', 'HEAD');
    git(origin, 'tag', 'v0.6.0');
    for (const path of ['deploy/runtime-image-registry.json', 'runtime-image-registry-v2.json']) {
      const file = join(f.payload, path); const catalog = JSON.parse(await readFile(file));
      catalog.platform.commit_sha = head; await writeFile(file, JSON.stringify(catalog));
    }
    const frozen = await freezePublication(f.payload, {version: env.VERSION, commit_sha: head});
    const freezeBytes = JSON.stringify(frozen);
    await writeFile(join(f.payload, 'platform-release-freeze.json'), freezeBytes);
    const receiptFile = join(f.signatures, 'platform-signature-evidence.json');
    const receipt = JSON.parse(await readFile(receiptFile));
    receipt.freezeSha256 = sha256(freezeBytes); receipt.verification.targetSha256 = frozen.targetSha256;
    await writeFile(receiptFile, JSON.stringify(receipt));
    const data = metadata(head); const responses = {};
    responses['actions/runs/42'] = data.run; responses['actions/workflows/release.yml'] = data.workflow;
    responses['git/ref/tags/v0.6.0'] = {object: {type: 'commit', sha: head}};
    responses['actions/runs/42/attempts/1/jobs?per_page=100&page=1'] = {total_count: 3, jobs: data.jobs};
    for (const [id, dir] of [[100, f.payload], [101, f.signatures]]) {
      const zip = join(f.root, `${id}.zip`); await rm(zip);
      execFileSync('zip', ['-qr', zip, '.'], {cwd: dir});
      data.artifacts[id - 100].digest = `sha256:${sha256(await readFile(zip))}`;
    }
    responses['actions/runs/42/artifacts?per_page=100&page=1'] = {total_count: 2, artifacts: data.artifacts};
    await writeFile(join(f.root, 'responses.json'), JSON.stringify(responses));
    const bin = join(f.root, 'commands'); await mkdir(bin);
    await writeFile(join(bin, 'gh'), `#!/usr/bin/env node
const fs = require('node:fs'); const path = require('node:path'); const a = process.argv.slice(2);
if (a[0] === 'api') {
  const endpoint = a.at(-1).replace('repos/SummerSec/DeepSonar/', '');
  const archive = /^actions\\/artifacts\\/(100|101)\\/zip$/.exec(endpoint);
  if (archive) {process.stdout.write(fs.readFileSync(path.join(process.env.FIXTURE_ROOT, archive[1] + '.zip'))); process.exit(0);}
  if (endpoint.startsWith('releases/tags/')) {console.log('HTTP/2.0 404 Not Found\\n\\n{}'); process.exit(1);}
  const response = JSON.parse(fs.readFileSync(path.join(process.env.FIXTURE_ROOT, 'responses.json')))[endpoint];
  if (!response) throw Error('unexpected endpoint ' + endpoint);
  console.log(JSON.stringify(response)); process.exit(0);
}
if (a[0] !== 'release' || a[1] !== 'create') throw Error('unexpected gh command');
fs.appendFileSync(process.env.EFFECTS, 'publish\\n');
`, {mode: 0o755});
    await writeFile(join(bin, 'bash'), `#!/bin/bash
if [[ "$1" == agent-harness/release-writeback.sh ]]; then
  echo writeback >> "$EFFECTS"
  exit "${'${WRITEBACK_EXIT:-0}'}"
fi
exec /bin/bash "$@"
`, {mode: 0o755});
    for (const selection of ['writeback', 'publish', 'both']) {
      const stages = selection === 'both' ? ['writeback', 'publish'] : [selection];
      const effects = join(f.root, `${selection}.effects`);
      for (const stage of stages) {
        const workspace = join(f.root, `${selection}-${stage}`);
        git(f.root, 'clone', '--quiet', origin, workspace);
        git(workspace, 'checkout', '--detach', head);
        await cp(resolve('agent-harness'), join(workspace, 'agent-harness'), {recursive: true});
        await cp(resolve('deploy'), join(workspace, 'deploy'), {recursive: true});
        const runtime = {...process.env, ...env, GITHUB_SHA: head, STAGES: selection, GH_TOKEN: 'fixture',
          FIXTURE_ROOT: f.root, EFFECTS: effects, PATH: `${bin}:${process.env.PATH}`, WRITEBACK_EXIT: selection === 'both' ? '1' : '0'};
        for (const step of job.steps.filter(step => step.run && (!step.if || step.if === `matrix.stage == '${stage}'`))) {
          const result = spawnSync('/bin/bash', ['-e', '-c', step.run], {cwd: workspace, env: runtime, encoding: 'utf8'});
          if (stage === 'writeback' && selection === 'both' && step.if) assert.notEqual(result.status, 0);
          else assert.equal(result.status, 0, `${step.name}: ${result.stderr}`);
        }
      }
      assert.deepEqual((await readFile(effects, 'utf8')).trim().split('\n'), stages);
    }
  } finally {await rm(f.root, {recursive: true, force: true});}
});
