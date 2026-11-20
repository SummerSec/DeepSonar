/** Embedded in trusted CLI bootstrap modules and the image-owned auth helper. */
export const PRIVATE_CREDENTIAL_READER_SOURCE = String.raw`
import { openSync as credentialOpen, closeSync as credentialClose, fstatSync as credentialStat,
  readFileSync as credentialRead, constants as credentialFlags } from 'node:fs';

export function readPrivateCredential(file, optional = false) {
  if (optional && file === undefined) return undefined;
  if (typeof file !== 'string' || !/^\/(?:[^/]+\/)*\.deepsonar-credentials-[a-f0-9-]{36}\/(control-token|gateway-token|om-token|pi-auth\.json)$/.test(file)
    || file.split('/').some(part => part === '.' || part === '..')) {
    throw new Error('PRIVATE_CREDENTIAL_REJECTED');
  }
  let parent;
  let fd;
  try {
    const parts = file.split('/');
    parent = credentialOpen('/', credentialFlags.O_RDONLY | credentialFlags.O_DIRECTORY | credentialFlags.O_NOFOLLOW);
    for (let index = 1; index < parts.length - 1; index++) {
      const child = credentialOpen('/proc/self/fd/' + parent + '/' + parts[index],
        credentialFlags.O_RDONLY | credentialFlags.O_DIRECTORY | credentialFlags.O_NOFOLLOW);
      credentialClose(parent);
      parent = child;
    }
    const directory = credentialStat(parent);
    if (!directory.isDirectory() || directory.uid !== process.geteuid() || (directory.mode & 0o777) !== 0o700) {
      throw new Error('PRIVATE_CREDENTIAL_REJECTED');
    }
    fd = credentialOpen('/proc/self/fd/' + parent + '/' + parts[parts.length - 1],
      credentialFlags.O_RDONLY | credentialFlags.O_NOFOLLOW | credentialFlags.O_NONBLOCK);
    const info = credentialStat(fd);
    if (!info.isFile() || info.nlink !== 1 || info.uid !== process.geteuid() || (info.mode & 0o777) !== 0o600
      || info.size <= 0 || info.size > 4 * 1024 * 1024) throw new Error('PRIVATE_CREDENTIAL_REJECTED');
    const value = credentialRead(fd, 'utf8');
    const after = credentialStat(fd);
    if (after.nlink !== 1 || after.uid !== process.geteuid() || (after.mode & 0o777) !== 0o600
      || after.size !== info.size || Buffer.byteLength(value) !== info.size
      || value.includes('\0')) throw new Error('PRIVATE_CREDENTIAL_REJECTED');
    return value;
  } catch {
    throw new Error('PRIVATE_CREDENTIAL_REJECTED');
  } finally {
    if (fd !== undefined) credentialClose(fd);
    if (parent !== undefined) credentialClose(parent);
  }
}
`;

export const CLAUDE_PRIVATE_HELPER_PATH = "/opt/deepsonar/dsh/deepsonar-claude-key.mjs";

/** Fixed image-owned entry point. No business-controlled command or token argv. */
export const CLAUDE_PRIVATE_KEY_HELPER_SOURCE = PRIVATE_CREDENTIAL_READER_SOURCE + String.raw`
if (process.argv.length !== 2) throw new Error('PRIVATE_CREDENTIAL_REJECTED');
const token = readPrivateCredential(process.env.DEEPSONAR_GATEWAY_TOKEN_FILE);
if (!token || /[\r\n]/.test(token)) throw new Error('PRIVATE_CREDENTIAL_REJECTED');
process.stdout.write(token);
`;

/** Official DSH 0.2.2-rc.1 CredentialProvider service, restricted to this Job. */
export const DSH_PRIVATE_CREDENTIALS_SOURCE = PRIVATE_CREDENTIAL_READER_SOURCE + String.raw`
import { CredentialProvider } from '@deepseek-ai/dsh-credentials';
export default class JobCredentials extends CredentialProvider {
  constructor(ctx, config) {
    super(ctx);
    if (typeof config?.provider !== 'string' || !config.provider || config.reference !== 'DEEPSONAR_JOB_GATEWAY') {
      throw new Error('PRIVATE_CREDENTIAL_REJECTED');
    }
    this.reference = config.reference;
    this.provider = config.provider;
    this.path = config.path;
    readPrivateCredential(this.path);
  }
  async resolve(ref) {
    if (ref !== this.reference) return undefined;
    let identity;
    try { identity = JSON.parse(process.env.DEEPSONAR_DSH_FROZEN_IDENTITY); }
    catch { throw new Error('PRIVATE_CREDENTIAL_REJECTED'); }
    if (identity?.provider !== this.provider) throw new Error('PRIVATE_CREDENTIAL_REJECTED');
    return { value: readPrivateCredential(this.path), source: 'file' };
  }
  async describe(ref) {
    if (ref !== this.reference) return { configured: false, writable: false };
    readPrivateCredential(this.path);
    return { configured: true, source: 'file', writable: false };
  }
  async readRecord() { return undefined; }
  async listRecords() { return []; }
  async describeRecord() { return { configured: false, writable: false }; }
  async set() { throw new Error('PRIVATE_CREDENTIAL_READ_ONLY'); }
  async unset() { throw new Error('PRIVATE_CREDENTIAL_READ_ONLY'); }
  async modifyRecord() { throw new Error('PRIVATE_CREDENTIAL_READ_ONLY'); }
}
`;
