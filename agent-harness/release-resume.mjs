// Recovery trusts GitHub's authenticated run/artifact records, never payload claims.
import {execFileSync} from 'node:child_process';
import {mkdtemp, mkdir, readFile, writeFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {sha256} from '../deploy/platform-upgrade-signature-contract.mjs';
import {checkPublication, checkSignatureReceipt} from './platform-signature-publication.mjs';
const REPO = 'SummerSec/DeepSonar';
const fail = code => {throw new Error(`release_resume_${code}`);};
const command = (file, args) => execFileSync(file, args, {maxBuffer: 128 * 1024 * 1024, timeout: 120000});
export function resumeInputs(env) {
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(env.VERSION ?? '') ||
      !/^[1-9]\d*$/.test(env.SOURCE_RUN_ID ?? '') || !Number.isSafeInteger(Number(env.SOURCE_RUN_ID)) ||
      !['writeback', 'publish', 'both'].includes(env.STAGES)) fail('inputs_invalid');
  return {version: env.VERSION, runId: env.SOURCE_RUN_ID};
}
export function resumeIdentity(env, head) {
  resumeInputs(env);
  if (env.GITHUB_REPOSITORY !== REPO || env.GITHUB_EVENT_NAME !== 'workflow_dispatch' ||
      env.GITHUB_REF !== 'refs/heads/main' ||
      env.GITHUB_WORKFLOW_REF !== `${REPO}/.github/workflows/release-resume.yml@refs/heads/main` ||
      !/^[a-f0-9]{40}$/.test(env.GITHUB_SHA ?? '') || head !== env.GITHUB_SHA) fail('identity_invalid');
}
export function validateSource({run, workflow, jobs, artifacts, tagSha, env, now = Date.now()}) {
  const {version, runId} = resumeInputs(env);
  if (String(run.id) !== runId || run.repository?.full_name !== REPO || run.head_repository?.full_name !== REPO ||
      run.repository?.id !== run.head_repository?.id || !Number.isSafeInteger(run.repository?.id) ||
      run.path !== '.github/workflows/release.yml' || workflow.path !== run.path || workflow.id !== run.workflow_id ||
      !['push', 'workflow_dispatch'].includes(run.event) || run.head_branch !== `v${version}` ||
      !/^[a-f0-9]{40}$/.test(run.head_sha ?? '') || run.head_sha !== tagSha ||
      run.status !== 'completed' || !['success', 'failure', 'cancelled'].includes(run.conclusion) ||
      run.run_attempt !== 1) fail('source_invalid');
  // Attempt 1 only: the artifacts API cannot bind mixed rerun artifacts to an attempt.
  const required = {
    'base-image': 'Bind stable tag, source commit and publisher identity',
    'prepare-release': 'Freeze exact validated release payload',
    'platform-signatures': 'Sign frozen GHCR indexes and verify positive and tampered metadata',
  };
  const producers = {};
  for (const [name, stepName] of Object.entries(required)) {
    const matches = jobs.filter(job => job.name === name);
    const job = matches[0];
    if (matches.length !== 1 || job.run_id !== run.id || job.run_attempt !== 1 || job.head_sha !== tagSha ||
        job.status !== 'completed' || job.conclusion !== 'success' ||
        !job.steps?.some(step => step.name === stepName && step.status === 'completed' && step.conclusion === 'success')) fail('stage_incomplete');
    producers[name] = job;
  }
  const selected = {};
  for (const [name, producer] of [['platform-release-payload', 'prepare-release'], ['platform-signature-evidence', 'platform-signatures']]) {
    const matches = artifacts.filter(artifact => artifact.name === name);
    const artifact = matches[0];
    const job = producers[producer];
    const created = Date.parse(artifact?.created_at);
    const expires = Date.parse(artifact?.expires_at);
    if (matches.length !== 1 || !Number.isSafeInteger(artifact.id) || artifact.id <= 0 || artifact.expired !== false ||
        !/^sha256:[a-f0-9]{64}$/.test(artifact.digest ?? '') || !Number.isFinite(created) || !Number.isFinite(expires) || expires <= now ||
        !(created >= Date.parse(job.started_at) && created <= Date.parse(job.completed_at)) ||
        artifact.workflow_run?.id !== run.id || artifact.workflow_run?.repository_id !== run.repository.id ||
        artifact.workflow_run?.head_repository_id !== run.repository.id || artifact.workflow_run?.head_sha !== tagSha ||
        artifact.workflow_run?.head_branch !== `v${version}`) fail('artifact_invalid');
    selected[name] = artifact;
  }
  return {identity: {version, commit_sha: tagSha}, selected};
}
const api = path => JSON.parse(command('gh', ['api', '--hostname', 'github.com', `repos/${REPO}/${path}`]));
async function pages(path, key, request) {
  const result = [];
  for (let page = 1; page <= 100; page++) {
    const response = await request(`${path}${path.includes('?') ? '&' : '?'}per_page=100&page=${page}`);
    if (!Array.isArray(response[key])) fail('api_invalid');
    result.push(...response[key]);
    if (result.length === response.total_count) return result;
    if (!response[key].length || result.length > response.total_count) fail('api_incomplete');
  }
  fail('api_limit');
}
export async function remoteTag(version, request = api) {
  let object = (await request(`git/ref/tags/v${version}`)).object;
  for (let depth = 0; object?.type === 'tag' && depth < 5; depth++) object = (await request(`git/tags/${object.sha}`)).object;
  if (object?.type !== 'commit' || !/^[a-f0-9]{40}$/.test(object.sha)) fail('tag_invalid');
  return object.sha;
}
export async function sourceEvidence(env, request = api) {
  const {version, runId} = resumeInputs(env);
  const run = await request(`actions/runs/${runId}`);
  const workflow = await request('actions/workflows/release.yml');
  const jobs = await pages(`actions/runs/${runId}/attempts/1/jobs`, 'jobs', request);
  const artifacts = await pages(`actions/runs/${runId}/artifacts`, 'artifacts', request);
  return validateSource({run, workflow, jobs, artifacts, tagSha: await remoteTag(version, request), env});
}
export async function unpackArtifact(artifact, destination, paths, download = id => command('gh', [
  'api', '--hostname', 'github.com', `repos/${REPO}/actions/artifacts/${id}/zip`])) {
  const bytes = await download(artifact.id);
  if (`sha256:${sha256(bytes)}` !== artifact.digest) fail('archive_digest_mismatch');
  const temp = await mkdtemp(join(tmpdir(), 'release-archive-'));
  try {
    const zip = join(temp, 'artifact.zip');
    await writeFile(zip, bytes);
    // Read only exact allowlisted members; never extract archive paths or modes.
    const members = command('unzip', ['-Z1', zip]).toString().trim().split('\n');
    const files = members.filter(path => !path.endsWith('/'));
    if (new Set(members).size !== members.length || files.length !== paths.length || files.some(path => !paths.includes(path)) ||
        members.some(path => path.endsWith('/') && path !== 'deploy/')) fail('archive_members_invalid');
    for (const path of paths) {
      const target = join(destination, path);
      await mkdir(resolve(target, '..'), {recursive: true});
      await writeFile(target, command('unzip', ['-p', zip, path]), {flag: 'wx'});
    }
  } finally {await rm(temp, {recursive: true, force: true});}
}
export async function verifiedResume(env, payload, signatures, {request = api, download, git = args => command('git', args).toString().trim()} = {}) {
  resumeIdentity(env, git(['rev-parse', 'HEAD']));
  const evidence = await sourceEvidence(env, request);
  if (git(['rev-parse', `refs/tags/v${env.VERSION}^{commit}`]) !== evidence.identity.commit_sha) fail('checkout_tag_mismatch');
  const temp = await mkdtemp(join(tmpdir(), 'release-resume-'));
  try {
    const frozenDir = join(temp, 'payload');
    const signatureDir = join(temp, 'signatures');
    const paths = ['platform-release-freeze.json', 'deploy/runtime-image-registry.json', 'runtime-image-registry-v2.json',
      'release-body.md', `deepsonar-reverse-evidence-${env.VERSION}.tar.gz`, `deepsonar-management-skill-${env.VERSION}.tar.gz`];
    await unpackArtifact(evidence.selected['platform-release-payload'], frozenDir, paths, download);
    await unpackArtifact(evidence.selected['platform-signature-evidence'], signatureDir, ['platform-signature-evidence.json'], download);
    // Hashes are trusted only AFTER both archive bytes match authenticated GitHub digests.
    const freezeHash = sha256(await readFile(join(frozenDir, 'platform-release-freeze.json')));
    const receipt = await readFile(join(signatureDir, 'platform-signature-evidence.json'));
    const frozen = await checkPublication(frozenDir, freezeHash, evidence.identity);
    checkSignatureReceipt(receipt, sha256(receipt), freezeHash, frozen);
    if (payload) {
      await checkPublication(payload, freezeHash, evidence.identity);
      checkSignatureReceipt(await readFile(join(signatures, 'platform-signature-evidence.json')), sha256(receipt), freezeHash, frozen);
    } else {
      // Fresh directories only; never overwrite workspace files from an artifact.
      for (const [dir, source, names] of [['frozen-release', frozenDir, paths], ['signature-evidence', signatureDir, ['platform-signature-evidence.json']]]) {
        for (const name of names) {
          const target = join(dir, name);
          await mkdir(resolve(target, '..'), {recursive: true});
          await writeFile(target, await readFile(join(source, name)), {flag: 'wx'});
        }
      }
    }
    if (await remoteTag(env.VERSION, request) !== evidence.identity.commit_sha) fail('tag_changed');
    return evidence;
  } finally {await rm(temp, {recursive: true, force: true});}
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  verifiedResume(process.env).then(evidence => console.log(JSON.stringify(evidence))).catch(error => {
    console.error(error.message); process.exitCode = 1;
  });
}
