import {readPrivateJson} from '../deploy/platform-upgrade-filesystem.mjs';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createPlatformSignaturePlan} from './platform-signature-plan.mjs';
import {verifyPlatformSignatures} from '../deploy/platform-upgrade-signature.mjs';
import {withPinnedPlatformCosign} from '../deploy/platform-upgrade-signature-runtime.mjs';
import {signatureError} from '../deploy/platform-upgrade-signature-contract.mjs';

const githubIdentity = env => ({repository: env.GITHUB_REPOSITORY, ref: env.GITHUB_REF,
  sha: env.GITHUB_SHA, workflow_ref: env.GITHUB_WORKFLOW_REF});
/** Execution is explicitly opt-in. A plan is not proof of signing or publisher authorization. */
export async function releasePlatformSignatures({target, policy, execute = false, github, environment = process.env} = {}) {
  const identity = execute ? githubIdentity(environment) : (github ?? githubIdentity(environment));
  const plan = createPlatformSignaturePlan({enabled: true, target, github: identity});
  if (!execute) return {status: 'planned', ...plan};
  if (environment.GITHUB_ACTIONS !== 'true' || !environment.ACTIONS_ID_TOKEN_REQUEST_TOKEN || !environment.ACTIONS_ID_TOKEN_REQUEST_URL)
    signatureError('signature_oidc_permission_required');
  const signingEnvironment = Object.fromEntries(['ACTIONS_ID_TOKEN_REQUEST_TOKEN', 'ACTIONS_ID_TOKEN_REQUEST_URL', 'DOCKER_CONFIG']
    .filter(key => environment[key]).map(key => [key, environment[key]]));
  // OIDC request credentials are inherited only by the signer, never argv/report/persistent files.
  await withPinnedPlatformCosign(policy, async run => {
    for (const command of plan.commands) await run(rootPath => [...command.args.slice(0, -1), '--trusted-root', rootPath, command.args.at(-1)]);
  }, signingEnvironment);
  // Successful publication is not acceptance until all signatures/metadata are independently verified.
  return {status: 'signed_and_verified', verification: await verifyPlatformSignatures({target, policy})};
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    if (args.some((arg, i) => arg !== '--execute' && arg !== '--policy' && args[i - 1] !== '--policy') || args.filter(v => v === '--execute').length > 1)
      signatureError('signature_cli_arguments_invalid');
    const execute = args.includes('--execute');
    const policyIndex = args.indexOf('--policy');
    if (execute && (policyIndex < 0 || !args[policyIndex + 1])) signatureError('signature_trust_configuration_invalid');
    let raw = ''; for await (const chunk of process.stdin) {raw += chunk; if (Buffer.byteLength(raw) > 1024 * 1024) signatureError('signature_input_too_large');}
    const input = JSON.parse(raw);
    const policy = policyIndex < 0 ? undefined : await readPrivateJson(args[policyIndex + 1]);
    process.stdout.write(JSON.stringify(await releasePlatformSignatures({target: input.target, github: input.github, policy, execute})) + '\n');
  } catch (error) {
    process.stdout.write(JSON.stringify({status: 'blocked', code: error?.name === 'PlatformSignatureError' ? error.code : 'signature_release_failed'}) + '\n');
    process.exitCode = 1;
  }
}
