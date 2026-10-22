import {readFile, writeFile, appendFile, mkdir} from 'node:fs/promises';
import {resolve, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
import {sha256, platformSignatureTarget, signatureError} from '../deploy/platform-upgrade-signature-contract.mjs';
import {assertPlatformManifest} from './generate-runtime-image-registry.mjs';
import {releasePlatformSignatures} from './platform-signature-release.mjs';
import {verifyPlatformSignatures} from '../deploy/platform-upgrade-signature.mjs';
export const TRUST = Object.freeze({
  cosignUrl: 'https://github.com/sigstore/cosign/releases/download/v3.1.4/cosign-linux-amd64',
  cosignSha256: '424e2c97d0b45fd7a6b608a87f090f35633f4c23ece5f092d48bba11aaf4bbfa',
  trustedRootUrl: 'https://raw.githubusercontent.com/sigstore/root-signing/f138b503846c9b9c5a78eeee470aae395ee85dfa/targets/trusted_root.json',
  trustedRootSha256: '6494e21ea73fa7ee769f85f57d5a3e6a08725eae1e38c755fc3517c9e6bc0b66',
});
export function releaseIdentity(env, head = env.GITHUB_SHA, tag = head) {
  const match = /^refs\/tags\/v((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*))$/.exec(env.GITHUB_REF ?? '');
  if (!match || env.GITHUB_REPOSITORY !== 'SummerSec/DeepSonar' ||
      env.GITHUB_WORKFLOW_REF !== `SummerSec/DeepSonar/.github/workflows/release.yml@${env.GITHUB_REF}` ||
      !/^[a-f0-9]{40}$/.test(env.GITHUB_SHA ?? '') || head !== env.GITHUB_SHA || tag !== head ||
      !['push', 'workflow_dispatch'].includes(env.GITHUB_EVENT_NAME) ||
      (env.INPUT_VERSION && env.INPUT_VERSION.replace(/^v/, '') !== match[1]) ||
      (env.INPUT_REF && ![env.GITHUB_REF, `v${match[1]}`, head].includes(env.INPUT_REF))) signatureError('signature_release_identity_invalid');
  return {version: match[1], commit_sha: head};
}
const files = version => ['deploy/runtime-image-registry.json', 'runtime-image-registry-v2.json', 'release-body.md',
  `deepsonar-reverse-evidence-${version}.tar.gz`, `deepsonar-management-skill-${version}.tar.gz`];
export async function freezePublication(directory, identity) {
  const catalog = JSON.parse(await readFile(join(directory, files(identity.version)[0]), 'utf8'));
  assertPlatformManifest(catalog.platform, catalog.platform_version);
  if (catalog.platform_version !== identity.version || catalog.platform.commit_sha !== identity.commit_sha) signatureError('signature_publication_identity_mismatch');
  const target = {version: identity.version, commit_sha: identity.commit_sha, schema_version: catalog.platform.schema_version,
    images: Object.fromEntries(Object.entries(catalog.platform.images).map(([service, image]) => [service, image.registry_refs.github]))};
  const normalized = platformSignatureTarget(target);
  const assets = Object.fromEntries(await Promise.all(files(identity.version).map(async path => [path, sha256(await readFile(join(directory, path)))])));
  if (assets[files(identity.version)[0]] !== assets['runtime-image-registry-v2.json']) signatureError('signature_publication_catalog_mismatch');
  return {format: 1, target, targetSha256: normalized.targetSha256, assets};
}
export async function checkPublication(directory, expectedHash, identity) {
  const bytes = await readFile(join(directory, 'platform-release-freeze.json'));
  if (sha256(bytes) !== expectedHash) signatureError('signature_publication_hash_mismatch');
  const frozen = JSON.parse(bytes);
  const actual = await freezePublication(directory, identity);
  if (JSON.stringify(actual) !== JSON.stringify(frozen)) signatureError('signature_publication_assets_mismatch');
  return frozen;
}
export async function signPublication(frozen, policy, sign = releasePlatformSignatures, verify = verifyPlatformSignatures) {
  const result = await sign({target: frozen.target, policy, execute: true});
  if (result.status !== 'signed_and_verified' || result.verification?.verified !== true || result.verification.targetSha256 !== frozen.targetSha256)
    signatureError('signature_publication_verification_missing');
  let rejected = false;
  try {await verify({target: {...frozen.target, schema_version: frozen.target.schema_version + 1}, policy});}
  catch (error) {if (error?.code === 'signature_claim_mismatch') rejected = true; else throw error;}
  if (!rejected) signatureError('signature_publication_negative_failed');
  return {verification: result.verification, negative: {mutation: 'schema_version_plus_one', code: 'signature_claim_mismatch'}};
}
export function checkSignatureReceipt(bytes, receiptHash, freezeHash, frozen) {
  const receipt = JSON.parse(bytes);
  const v = receipt.verification;
  if (sha256(bytes) !== receiptHash || receipt.freezeSha256 !== freezeHash ||
      v?.verified !== true || v.targetSha256 !== frozen.targetSha256 ||
      v.cosignSha256 !== TRUST.cosignSha256 || v.trustedRootSha256 !== TRUST.trustedRootSha256 ||
      receipt.negative?.mutation !== 'schema_version_plus_one' || receipt.negative?.code !== 'signature_claim_mismatch')
    signatureError('signature_publication_receipt_mismatch');
  return receipt;
}
async function pinnedPolicy(directory) {
  await mkdir(directory, {recursive: true, mode: 0o700});
  for (const [name, url, digest] of [['cosign', TRUST.cosignUrl, TRUST.cosignSha256], ['trusted-root.json', TRUST.trustedRootUrl, TRUST.trustedRootSha256]]) {
    const response = await fetch(url, {signal: AbortSignal.timeout(120000)});
    if (!response.ok) signatureError('signature_trust_download_failed');
    const bytes = Buffer.from(await response.arrayBuffer());
    if (sha256(bytes) !== digest) signatureError('signature_trust_hash_mismatch');
    await writeFile(join(directory, name), bytes, {mode: 0o600});
  }
  return {enabled: true, cosignPath: join(directory, 'cosign'), cosignSha256: TRUST.cosignSha256,
    trustedRootPath: join(directory, 'trusted-root.json'), trustedRootSha256: TRUST.trustedRootSha256};
}
async function cli() {
  const [command, rawDirectory = '.'] = process.argv.slice(2);
  const env = process.env;
  const identity = releaseIdentity(env);
  if (command === 'identity') {
    releaseIdentity(env, execFileSync('git', ['rev-parse', 'HEAD'], {encoding: 'utf8'}).trim(),
      execFileSync('git', ['rev-parse', `${env.GITHUB_REF}^{commit}`], {encoding: 'utf8'}).trim());
    await appendFile(env.GITHUB_OUTPUT, `version=${identity.version}\nowner=summersec\ncheckout_ref=${identity.commit_sha}\n`); return;
  }
  const directory = resolve(rawDirectory);
  if (command === 'freeze') {
    const bytes = JSON.stringify(await freezePublication(directory, identity), null, 2) + '\n';
    await writeFile(join(directory, 'platform-release-freeze.json'), bytes);
    await appendFile(env.GITHUB_OUTPUT, `freeze_sha256=${sha256(bytes)}\n`); return;
  }
  const frozen = await checkPublication(directory, env.FREEZE_SHA256, identity);
  if (command === 'sign') {
    const policy = await pinnedPolicy(join(env.RUNNER_TEMP, 'platform-signature-trust'));
    const receipt = {freezeSha256: env.FREEZE_SHA256, ...await signPublication(frozen, policy)};
    const bytes = JSON.stringify(receipt, null, 2) + '\n';
    await writeFile('platform-signature-evidence.json', bytes);
    await appendFile(env.GITHUB_OUTPUT, `receipt_sha256=${sha256(bytes)}\n`); return;
  }
  if (command !== 'gate') signatureError('signature_cli_arguments_invalid');
  const bytes = await readFile('signature-evidence/platform-signature-evidence.json');
  checkSignatureReceipt(bytes, env.RECEIPT_SHA256, env.FREEZE_SHA256, frozen);
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) cli().catch(error => {
  process.stderr.write(`${error?.name === 'PlatformSignatureError' ? error.code : 'signature_publication_failed'}\n`); process.exitCode = 1;
});
