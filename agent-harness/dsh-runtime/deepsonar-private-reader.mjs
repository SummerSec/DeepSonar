
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
