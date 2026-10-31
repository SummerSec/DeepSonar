// Planning only: this module never requests OIDC tokens, signs or writes to a registry.
import {platformSignatureTarget, platformSignatureAnnotations, PLATFORM_SERVICES, PLATFORM_SIGNER_REPOSITORY, signatureError} from '../deploy/platform-upgrade-signature-contract.mjs';
export function createPlatformSignaturePlan({enabled = false, target: input, github} = {}) {
  if (enabled !== true) signatureError('signature_signing_disabled');
  const target = platformSignatureTarget(input);
  if (github?.repository !== PLATFORM_SIGNER_REPOSITORY || github.ref !== target.ref || github.sha !== target.commit_sha
    || github.workflow_ref !== `${PLATFORM_SIGNER_REPOSITORY}/.github/workflows/release.yml@${target.ref}`) signatureError('signature_release_identity_mismatch');
  return {targetSha256: target.targetSha256, identity: target.identity, requires: ['job-scoped id-token:write approval', 'pinned cosign and trusted Sigstore root', 'GHCR write access'],
    commands: PLATFORM_SERVICES.map(service => ({service, args: ['sign', '--yes',
      ...Object.entries(platformSignatureAnnotations(target, service)).flatMap(([key, value]) => ['-a', `${key}=${value}`]), target.images[service]]}))};
}
