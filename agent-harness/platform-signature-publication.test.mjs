import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, writeFile, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {releaseIdentity, freezePublication, checkPublication, signPublication, checkSignatureReceipt, TRUST} from './platform-signature-publication.mjs';
import {sha256} from '../deploy/platform-upgrade-signature-contract.mjs';
const env = {GITHUB_REPOSITORY: 'SummerSec/DeepSonar', GITHUB_REF: 'refs/tags/v0.6.0', GITHUB_SHA: 'a'.repeat(40),
  GITHUB_WORKFLOW_REF: 'SummerSec/DeepSonar/.github/workflows/release.yml@refs/tags/v0.6.0', GITHUB_EVENT_NAME: 'push'};
test('publisher requires actual stable tag workflow identity and matching checkout/tag SHA', () => {
  assert.deepEqual(releaseIdentity(env), {version: '0.6.0', commit_sha: env.GITHUB_SHA});
  assert.equal(releaseIdentity({...env, GITHUB_EVENT_NAME: 'workflow_dispatch', INPUT_REF: 'v0.6.0', INPUT_VERSION: '0.6.0'}).version, '0.6.0');
  for (const patch of [{GITHUB_REF: 'refs/heads/main'}, {GITHUB_REF: 'refs/tags/v0.6.0-rc1'}, {GITHUB_WORKFLOW_REF: 'other'},
    {GITHUB_REPOSITORY: 'fork/DeepSonar'}, {INPUT_VERSION: '0.5.6'}, {INPUT_REF: 'main'}, {GITHUB_SHA: 'short'}])
    assert.throws(() => releaseIdentity({...env, ...patch}), /signature_release_identity_invalid/);
  assert.throws(() => releaseIdentity(env, env.GITHUB_SHA, 'b'.repeat(40)), /identity_invalid/);
});
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'signature-publication-'));
  await mkdir(join(directory, 'deploy'));
  const digest = `sha256:${'1'.repeat(64)}`;
  const platform = {...releaseIdentity(env), schema_version: 62, images: {}};
  for (const service of ['scheduler', 'web', 'image-admission']) {
    const ref = `ghcr.io/summersec/deepsonar-${service}@${digest}`;
    platform.images[service] = {digest, platforms: ['linux/amd64', 'linux/arm64'], child_digests: {'linux/amd64': digest, 'linux/arm64': digest},
      registry_refs: {github: ref}, registry_evidence: {github: {available: true, ref, inspect_digest: digest, provenance: 'build-push+inspect'},
        dockerhub: {available: false, reason: 'credentials_missing', provenance: 'unavailable'},
        'aliyun-acr': {available: false, reason: 'credentials_missing', provenance: 'unavailable'}}};
  }
  const catalog = JSON.stringify({platform_version: '0.6.0', platform});
  for (const path of ['deploy/runtime-image-registry.json', 'runtime-image-registry-v2.json']) await writeFile(join(directory, path), catalog);
  for (const path of ['release-body.md', 'deepsonar-reverse-evidence-0.6.0.tar.gz', 'deepsonar-management-skill-0.6.0.tar.gz']) await writeFile(join(directory, path), 'fixture');
  return directory;
}
test('frozen publication binds all assets and exact catalog release metadata', async () => {
  const directory = await fixture();
  try {
    const frozen = await freezePublication(directory, releaseIdentity(env));
    const bytes = JSON.stringify(frozen);
    await writeFile(join(directory, 'platform-release-freeze.json'), bytes);
    assert.deepEqual(await checkPublication(directory, sha256(bytes), releaseIdentity(env)), frozen);
    await assert.rejects(checkPublication(directory, '0'.repeat(64), releaseIdentity(env)), /hash_mismatch/);
    await assert.rejects(freezePublication(directory, {...releaseIdentity(env), commit_sha: 'b'.repeat(40)}), /identity_mismatch/);
    await writeFile(join(directory, 'release-body.md'), 'tampered');
    await assert.rejects(checkPublication(directory, sha256(bytes), releaseIdentity(env)), /assets_mismatch/);
  } finally {await rm(directory, {recursive: true, force: true});}
});
test('signatures must pass independent positive and actual metadata rejection; network failure is not rejection evidence', async () => {
  const directory = await fixture();
  try {
    const frozen = await freezePublication(directory, releaseIdentity(env));
    const sign = async () => ({status: 'signed_and_verified', verification: {verified: true, targetSha256: frozen.targetSha256}});
    const reject = async ({target}) => {assert.equal(target.schema_version, 63); throw Object.assign(new Error(), {code: 'signature_claim_mismatch'});};
    assert.equal((await signPublication(frozen, {}, sign, reject)).negative.code, 'signature_claim_mismatch');
    await assert.rejects(signPublication(frozen, {}, async () => {throw Error('sign failed');}, reject), /sign failed/);
    await assert.rejects(signPublication(frozen, {}, sign, async () => {}), /negative_failed/);
    await assert.rejects(signPublication(frozen, {}, sign, async () => {throw Error('network');}), /network/);
    await assert.rejects(signPublication(frozen, {}, async () => ({status: 'signed'}), reject), /verification_missing/);
  } finally {await rm(directory, {recursive: true, force: true});}
});
test('workflow grants OIDC only to signing job and gates both release and writeback behind frozen verification', async () => {
  const workflow = (await readFile(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8')).replaceAll('\r\n', '\n');
  assert.equal(workflow.match(/id-token: write/g)?.length, 1);
  const signature = workflow.split('\n  platform-signatures:\n')[1].split('\n  release-publish:\n')[0];
  assert.match(signature, /contents: read\n      packages: write\n      id-token: write/);
  assert.doesNotMatch(signature.split('    steps:')[0], /runner\./);
  assert.ok(signature.includes('"$RUNNER_TEMP/platform-signatures-docker" >> "$GITHUB_ENV"'));
  assert.ok(signature.indexOf('>> "$GITHUB_ENV"') < signature.indexOf('docker/login-action'));
  assert.ok(signature.indexOf('docker/login-action') < signature.indexOf('publication.mjs sign'));
  assert.match(signature, /platform-signature-publication.mjs sign frozen-release/);
  // #893: publication and bundled writeback are separate, independently resumable stages
  // over the same frozen payload.
  const publish = workflow.split('\n  release-publish:\n')[1].split('\n  release-writeback:\n')[0];
  assert.match(publish, /needs: \[base-image, prepare-release, platform-signatures\]/);
  assert.match(publish, /release-publish\.sh frozen-release signature-evidence/);
  assert.match(publish, /ref: \$\{\{ needs.base-image.outputs.checkout_ref \}\}/);
  const writeback = workflow.split('\n  release-writeback:\n')[1];
  assert.match(writeback, /needs: \[base-image, prepare-release, platform-signatures\]/);
  assert.match(writeback, /release-writeback\.sh frozen-release/);
  // A writeback problem must never withhold or overwrite an already published Release.
  assert.doesNotMatch(writeback, /gh release create/);
  const publishScript = (await readFile(new URL('./release-publish.sh', import.meta.url), 'utf8')).replaceAll('\r\n', '\n');
  assert.ok(publishScript.indexOf('publication.mjs gate') < publishScript.indexOf('gh release create'));
  assert.ok(publishScript.indexOf('gh release view') < publishScript.indexOf('gh release create'));
  const writebackScript = (await readFile(new URL('./release-writeback.sh', import.meta.url), 'utf8')).replaceAll('\r\n', '\n');
  assert.ok(writebackScript.indexOf('git checkout -f -B') < writebackScript.indexOf('release-writeback.mjs'));
  assert.equal(TRUST.cosignSha256.length, 64); assert.equal(TRUST.trustedRootSha256.length, 64);
});

test('publication gate binds job output hashes, frozen target, pinned trust and negative proof', () => {
  const frozen = {targetSha256: 'a'.repeat(64)};
  const freezeHash = 'b'.repeat(64);
  const receipt = {freezeSha256: freezeHash, verification: {verified: true, targetSha256: frozen.targetSha256,
    cosignSha256: TRUST.cosignSha256, trustedRootSha256: TRUST.trustedRootSha256},
    negative: {mutation: 'schema_version_plus_one', code: 'signature_claim_mismatch'}};
  const bytes = JSON.stringify(receipt);
  assert.deepEqual(checkSignatureReceipt(bytes, sha256(bytes), freezeHash, frozen), receipt);
  assert.throws(() => checkSignatureReceipt(bytes + ' ', sha256(bytes), freezeHash, frozen), /receipt_mismatch/);
  assert.throws(() => checkSignatureReceipt(bytes, sha256(bytes), 'wrong-freeze', frozen), /receipt_mismatch/);
  for (const mutate of [r => r.verification.targetSha256 = 'wrong', r => r.verification.verified = false,
    r => r.verification.trustedRootSha256 = 'wrong', r => r.verification.cosignSha256 = 'wrong',
    r => r.negative.code = 'signature_verification_failed', r => r.negative.mutation = 'unrelated']) {
    const changed = structuredClone(receipt); mutate(changed); const raw = JSON.stringify(changed);
    assert.throws(() => checkSignatureReceipt(raw, sha256(raw), freezeHash, frozen), /receipt_mismatch/);
  }
});
