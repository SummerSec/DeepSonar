import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {readFile, stat, mkdtemp, chmod, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, isAbsolute} from 'node:path';
import {ensurePrivateDirectory, durablePrivateWrite, assertPrivateFile} from './platform-upgrade-filesystem.mjs';
import {COSIGN_VERSION, sha256, signatureError} from './platform-upgrade-signature-contract.mjs';
const execute = promisify(execFile);
async function pinnedBytes(path, expected, limit) {
  if (typeof path !== 'string' || !isAbsolute(path) || !/^[a-f0-9]{64}$/.test(expected ?? '')) signatureError('signature_trust_configuration_invalid');
  try {
    const info = await stat(path);
    if (!info.isFile() || info.size > limit) signatureError('signature_trust_configuration_invalid');
    const bytes = await readFile(path);
    if (bytes.length > limit || sha256(bytes) !== expected) signatureError('signature_trust_hash_mismatch');
    return bytes;
  } catch (error) {
    if (error?.name === 'PlatformSignatureError') throw error;
    signatureError('signature_trust_configuration_invalid');
  }
}
/** Copies only independently pinned bytes, with native private ACLs on Windows. */
export async function withPinnedPlatformCosign(policy, callback, signingEnvironment = {}) {
  if (policy?.enabled !== true) signatureError('signature_policy_disabled');
  const binary = await pinnedBytes(policy.cosignPath, policy.cosignSha256, 256 * 1024 * 1024);
  const root = await pinnedBytes(policy.trustedRootPath, policy.trustedRootSha256, 4 * 1024 * 1024);
  const directory = await mkdtemp(join(tmpdir(), 'deepsonar-signature-'));
  try {
    await ensurePrivateDirectory(directory);
    const binaryPath = join(directory, process.platform === 'win32' ? 'cosign.exe' : 'cosign');
    const rootPath = join(directory, 'trusted-root.json');
    await durablePrivateWrite(binaryPath, binary); await durablePrivateWrite(rootPath, root);
    if (process.platform !== 'win32') await chmod(binaryPath, 0o700);
    const env = process.platform === 'win32'
      ? {PATH: join(process.env.SystemRoot, 'System32'), SystemRoot: process.env.SystemRoot, HOME: directory, USERPROFILE: directory}
      : {PATH: '/usr/bin:/bin', HOME: directory};
    const run = async argsOrFactory => {
      await assertPrivateFile(binaryPath); await assertPrivateFile(rootPath);
      return execute(binaryPath, typeof argsOrFactory === 'function' ? argsOrFactory(rootPath) : argsOrFactory,
        {timeout: 120000, maxBuffer: 4 * 1024 * 1024, encoding: 'utf8', windowsHide: true, env: {...env, ...signingEnvironment}});
    };
    const version = await run(['version', '--json']);
    if (JSON.parse(version.stdout).gitVersion !== COSIGN_VERSION) signatureError('signature_verifier_version_invalid');
    return await callback(run);
  } catch (error) {
    if (error?.name === 'PlatformSignatureError') throw error;
    signatureError('signature_verification_failed');
  } finally {await rm(directory, {recursive: true, force: true});}
}
