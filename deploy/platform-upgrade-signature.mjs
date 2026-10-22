import {withPinnedPlatformCosign} from './platform-upgrade-signature-runtime.mjs';
import {COSIGN_SIGN_PREDICATE, PLATFORM_SERVICES, PLATFORM_SIGNER_REPOSITORY, PLATFORM_SIGNER_ISSUER,
  platformSignatureTarget, platformSignatureAnnotations, sha256, signatureError} from './platform-upgrade-signature-contract.mjs';

export function platformSignatureVerifyArgs(target, service, trustedRoot) {
  return ['verify-attestation', '--type', COSIGN_SIGN_PREDICATE, '--check-claims=true', '--trusted-root', trustedRoot,
    '--certificate-identity', target.identity, '--certificate-oidc-issuer', PLATFORM_SIGNER_ISSUER,
    '--certificate-github-workflow-repository', PLATFORM_SIGNER_REPOSITORY,
    '--certificate-github-workflow-ref', target.ref, '--certificate-github-workflow-sha', target.commit_sha,
    target.images[service]];
}
/** Parse only output from the pinned verifier, never registry claims submitted directly by a caller. */
export function assertPlatformSignatureOutput(stdout, target, service) {
  let rows;
  try {rows = stdout.trim().split('\n').map(line => JSON.parse(line));} catch {signatureError('signature_output_invalid');}
  if (!rows.length || rows.length > 32) signatureError('signature_output_invalid');
  const digest = target.images[service].split('@sha256:')[1];
  const expected = platformSignatureAnnotations(target, service);
  // Cosign 3 verify-attestation emits verified DSSE envelopes, preserving
  // the signed statement and annotations needed for the full metadata contract.
  for (const envelope of rows) {
    let statement;
    try {
      if (envelope?.payloadType !== 'application/vnd.in-toto+json' || typeof envelope.payload !== 'string'
        || !/^[A-Za-z0-9+/]+={0,2}$/.test(envelope.payload)) throw new Error();
      const bytes = Buffer.from(envelope.payload, 'base64');
      if (bytes.toString('base64') !== envelope.payload) throw new Error();
      statement = JSON.parse(bytes.toString('utf8'));
    } catch {signatureError('signature_output_invalid');}
    const subject = statement?.subject?.[0];
    if (statement?._type !== 'https://in-toto.io/Statement/v1' || statement.predicateType !== COSIGN_SIGN_PREDICATE
      || !Array.isArray(statement.subject) || statement.subject.length !== 1 || subject?.digest?.sha256 !== digest
      || Object.keys(subject.digest).length !== 1 || !Object.entries(expected).every(([key, value]) => subject.annotations?.[key] === value)) signatureError('signature_claim_mismatch');
  }
  return {service, image: target.images[service], verifiedSignatures: rows.length, payloadSha256: sha256(stdout)};
}

/** Host-owned policy only: never populate verifier/root hashes from a Release manifest. No unsigned fallback. */
export async function verifyPlatformSignatures({target: input, policy} = {}) {
  if (policy?.enabled !== true) signatureError('signature_policy_disabled');
  const target = platformSignatureTarget(input);
  return withPinnedPlatformCosign(policy, async run => {
    const evidence = [];
    for (const service of PLATFORM_SERVICES) {
      const {stdout} = await run(rootPath => platformSignatureVerifyArgs(target, service, rootPath));
      evidence.push(assertPlatformSignatureOutput(stdout, target, service));
    }
    return {verified: true, status: 'verified', version: target.version, commit_sha: target.commit_sha, schema_version: target.schema_version,
      images: target.images, targetSha256: target.targetSha256, signer: target.identity, issuer: PLATFORM_SIGNER_ISSUER,
      cosignSha256: policy.cosignSha256, trustedRootSha256: policy.trustedRootSha256, evidence};
  });
}

export const verifySignedPlatformTarget = (target, policy) => verifyPlatformSignatures({target, policy});
