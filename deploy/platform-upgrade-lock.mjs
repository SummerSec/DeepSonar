import {open, mkdir} from 'node:fs/promises';
import {dirname, resolve} from 'node:path';
import {spawnSync} from 'node:child_process';

// Linux flock locks the open file description, not the child PID. The child
// inherits this exact description as fd 3. After it exits, the parent's handle
// remains its sole owner; close(), process exit and SIGKILL all release the lock.
// Never unlink the file: another opener could otherwise lock a different inode.
export async function withUpgradeLock(file, action) {
  if (process.platform === 'win32') {
    const {withWindowsUpgradeLock} = await import('./platform-upgrade-windows.mjs');
    return withWindowsUpgradeLock(resolve(file), action);
  }
  if (process.platform !== 'linux') {
    throw new Error('automatic upgrade locking requires Linux flock; this platform has no supported crash-safe lock backend');
  }
  const path = resolve(file);
  await mkdir(dirname(path), {recursive: true, mode: 0o700});
  const handle = await open(path, 'a+', 0o600);
  try {
    const result = spawnSync('flock', ['--exclusive', '--nonblock', '--conflict-exit-code', '73', '3'], {
      stdio: ['ignore', 'pipe', 'pipe', handle.fd], windowsHide: true,
    });
    if (result.error || result.signal || ![0, 73].includes(result.status)) {
      throw new Error('Linux flock is unavailable or could not acquire the upgrade lock');
    }
    if (result.status === 73) throw new Error('another upgrade process holds the deployment lock');
    return await action();
  } finally {
    await handle.close();
  }
}
