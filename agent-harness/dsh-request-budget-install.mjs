// Build-time only: preserve the npm-installed bundle; create a separate governed
// module beside it so all official dependency resolution/conversion remains intact.
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { stripTypeScriptTypes } from 'node:module';
const hash = value => createHash('sha256').update(value).digest('hex');
const dataModule = source => 'data:text/javascript;base64,' + Buffer.from(source).toString('base64');
export async function installDshRequestBudget(installRoot, sourceRoot) {
  const root = resolve(installRoot, 'node_modules/@deepseek-ai/dsh-llm-pi-ai');
  const manifest = JSON.parse(await readFile(root + '/package.json', 'utf8'));
  if (manifest.name !== '@deepseek-ai/dsh-llm-pi-ai' || manifest.version !== '0.2.2-rc.1') throw new Error('DSH_BUDGET_VENDOR_VERSION');
  const privateModule = stripTypeScriptTypes(await readFile(resolve(sourceRoot, 'private-credential-reader.ts'), 'utf8'));
  const privateUrl = dataModule(privateModule);
  const privateArtifacts = await import(privateUrl);
  const shared = stripTypeScriptTypes(await readFile(resolve(sourceRoot, 'pi-main-request-budget.ts'), 'utf8'))
    .replace('"./private-credential-reader.js"', JSON.stringify(privateUrl));
  const policy = stripTypeScriptTypes(await readFile(resolve(sourceRoot, 'dsh-request-budget.ts'), 'utf8'))
    .replace('"./pi-main-request-budget.js"', JSON.stringify(dataModule(shared)));
  const { DSH_REQUEST_BUDGET_SOURCE: helper, DSH_REQUEST_BUDGET_VENDOR_SHA256: expected } = await import(dataModule(policy));
  const original = await readFile(root + '/lib/index.js', 'utf8');
  if (hash(original) !== expected) throw new Error('DSH_BUDGET_VENDOR_INTEGRITY');
  const start = 'const iterator = toStreamChunks(snapshot.models.streamSimple(model, context, {';
  const end = '}), model.contextWindow, options.signal, model.id)[Symbol.asyncIterator]();';
  if (original.split(start).length !== 2 || original.split(end).length !== 2) throw new Error('DSH_BUDGET_VENDOR_PATCH_AMBIGUOUS');
  const register = 'models.setProvider(profile.piProvider);';
  if (original.split(register).length !== 2) throw new Error('DSH_BUDGET_VENDOR_REGISTRATION_AMBIGUOUS');
  const piAiRoot = resolve(installRoot, 'node_modules/@earendil-works/pi-ai');
  const sdk = JSON.parse(await readFile(piAiRoot + '/package.json', 'utf8'));
  if (sdk.name !== '@earendil-works/pi-ai' || sdk.version !== '1.6.0') throw new Error('DSH_BUDGET_SDK_VERSION');
  const verification = `
import { readFile as readBudgetFile } from 'node:fs/promises';
import { createHash as budgetHash } from 'node:crypto';
const budgetManifest = JSON.parse(await readBudgetFile(new URL('./deepsonar-request-budget.manifest.json', import.meta.url), 'utf8'));
if (budgetManifest.version !== 1 || budgetManifest.vendorVersion !== '0.2.2-rc.1' || budgetManifest.vendorSha256 !== '${expected}') throw new Error('DSH_BUDGET_MANIFEST_INVALID');
for (const [file, expectedHash] of [['./index.js', budgetManifest.vendorSha256], ['./deepsonar-index.js', budgetManifest.artifactSha256], ['./deepsonar-request-budget.mjs', budgetManifest.helperSha256]]) {
  if (budgetHash('sha256').update(await readBudgetFile(new URL(file, import.meta.url))).digest('hex') !== expectedHash) throw new Error('DSH_BUDGET_ARTIFACT_INTEGRITY');
}
const budgetSdk = JSON.parse(await readBudgetFile(${JSON.stringify(piAiRoot + '/package.json')}, 'utf8'));
if (budgetSdk.name !== '@earendil-works/pi-ai' || budgetSdk.version !== '1.6.0') throw new Error('DSH_BUDGET_SDK_VERSION');
`;
  const registration = `models.setProvider({ ...profile.piProvider, streamSimple: (model, context, options) => {
    const identity = frozenDshIdentity();
    assertDshSdkIdentity(model, options, identity);
    return profile.piProvider.streamSimple(model, redactDshContext(context, identity), options);
  } });`;
  const patched = "import { prepareSdkCall, frozenDshIdentity, assertDshSdkIdentity, redactDshContext } from './deepsonar-request-budget.mjs';\n" + verification
    + original.replace(register, registration).replace(start, 'const sdkCall = await prepareSdkCall({ model, context, signal: watchdog.signal, frozenIdentity: frozenDshIdentity(), piAiRoot: ' + JSON.stringify(piAiRoot) + ', options: {')
      .replace(end, '} });\n\t\t\t\tconst iterator = toStreamChunks(snapshot.models.streamSimple(sdkCall.model, context, sdkCall.options), model.contextWindow, options.signal, model.id)[Symbol.asyncIterator]();');
  const output = root + '/lib/deepsonar-index.js';
  await writeFile(root + '/lib/deepsonar-request-budget.mjs', helper);
  await writeFile(resolve(installRoot, 'node_modules/@deepseek-ai/dsh-credentials/deepsonar-job-credentials.mjs'), privateArtifacts.DSH_PRIVATE_CREDENTIALS_SOURCE);
  await writeFile(resolve(installRoot, 'deepsonar-claude-key.mjs'), privateArtifacts.CLAUDE_PRIVATE_KEY_HELPER_SOURCE);
  await writeFile(resolve(installRoot, 'deepsonar-private-reader.mjs'), privateArtifacts.PRIVATE_CREDENTIAL_READER_SOURCE);
  await writeFile(output, patched);
  await writeFile(root + '/lib/deepsonar-request-budget.manifest.json', JSON.stringify({ version: 1, vendorVersion: manifest.version, vendorSha256: expected, artifactSha256: hash(patched), helperSha256: hash(helper), sdkVersion: '1.6.0' }, null, 2) + '\n');
  return output;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv.length !== 4) throw new Error('usage: install.mjs INSTALL_ROOT POLICY_SOURCE_DIRECTORY');
  await installDshRequestBudget(process.argv[2], process.argv[3]);
}
