import {createHash} from 'node:crypto';
export const COSIGN_SIGN_PREDICATE = 'https://sigstore.dev/cosign/sign/v1';
export const COSIGN_VERSION = 'v3.1.4';
export const PLATFORM_SIGNER_REPOSITORY = 'SummerSec/DeepSonar';
export const PLATFORM_SIGNER_ISSUER = 'https://token.actions.githubusercontent.com';
export const PLATFORM_SERVICES = ['scheduler', 'web', 'image-admission'];
export class PlatformSignatureError extends Error {
  constructor(code) {super(code); this.name = 'PlatformSignatureError'; this.code = code;}
}
export const signatureError = code => {throw new PlatformSignatureError(code);};
export const sha256 = value => createHash('sha256').update(value).digest('hex');
/** Policy v1 supports GHCR only. The signed OCI index commits to its child manifests. */
export function platformSignatureTarget(target) {
  if (!target || typeof target.version !== 'string' || typeof target.commit_sha !== 'string' || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(target.version)
    || !/^[a-f0-9]{40}$/.test(target.commit_sha) || !Number.isSafeInteger(target.schema_version) || target.schema_version < 1
    || !target.images || Object.keys(target.images).length !== PLATFORM_SERVICES.length) signatureError('signature_target_invalid');
  const images = {};
  for (const service of PLATFORM_SERVICES) {
    const image = target.images[service];
    if (typeof image !== 'string' || !new RegExp(`^ghcr\\.io/summersec/deepsonar-${service}@sha256:[a-f0-9]{64}$`).test(image)) signatureError('signature_image_unsupported');
    images[service] = image;
  }
  const canonical = {version: target.version, commit_sha: target.commit_sha, schema_version: target.schema_version, images};
  const targetSha256 = sha256(JSON.stringify(canonical));
  const ref = `refs/tags/v${canonical.version}`;
  return {...canonical, targetSha256, ref, identity: `https://github.com/${PLATFORM_SIGNER_REPOSITORY}/.github/workflows/release.yml@${ref}`};
}
export function platformSignatureAnnotations(target, service) {
  if (!PLATFORM_SERVICES.includes(service)) signatureError('signature_service_invalid');
  return {'deepsonar.version': target.version, 'deepsonar.commit': target.commit_sha, 'deepsonar.schema': String(target.schema_version),
    'deepsonar.service': service, 'deepsonar.repository': target.images[service].split('@')[0], 'deepsonar.target-sha256': target.targetSha256};
}
