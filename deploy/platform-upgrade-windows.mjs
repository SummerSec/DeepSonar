import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {win32} from 'node:path';
import {AsyncLocalStorage} from 'node:async_hooks';

const script = fileURLToPath(new URL('./platform-upgrade-windows.ps1', import.meta.url));
const leases = new AsyncLocalStorage();
/** Fixed script and bounded stdin. Never forward native/PowerShell diagnostics:
 * write/read operations carry private recovery bytes in memory only. */
export function windowsUpgradeOperation(request, {run = spawnSync, executable = win32.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')} = {}) {
  const lease = leases.getStore();
  if (lease?.closed && request.action !== 'release') throw new Error('Windows upgrade lock scope already closed');
  if (lease && !['acquire', 'release'].includes(request.action)) request = {...request, lock_lease: lease};
  const result = run(executable, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script], {
    input: JSON.stringify(request), encoding: 'utf8', windowsHide: true, timeout: 60000, maxBuffer: 768 * 1024 * 1024,
  });
  let value;
  try {value = JSON.parse(result.stdout);} catch {throw new Error('Windows upgrade backend failed; private diagnostics suppressed');}
  if (result.error || result.signal || result.status !== 0 || value?.ok !== true) {
    if (value?.code === 'WINDOWS_UPGRADE_LOCK_BUSY') throw new Error('another upgrade process holds the deployment lock');
    throw new Error('Windows upgrade backend failed; private diagnostics suppressed');
  }
  return value;
}

export async function withWindowsUpgradeLock(path, action, {operation = windowsUpgradeOperation, ownerPid = process.pid} = {}) {
  operation({action: 'directory', path: win32.dirname(path)});
  const lease = operation({action: 'acquire', path, owner_pid: ownerPid});
  if (!/^[1-9][0-9]*$/.test(lease.handle) || !/^[1-9][0-9]*$/.test(lease.owner_creation)) throw new Error('Windows lock transfer receipt invalid; stop this process before retrying');
  const context = {...lease, owner_pid: ownerPid, closed: false};
  return leases.run(context, async () => {
    try {return await action();}
    finally {
      context.closed = true;
      // CLOSE_SOURCE is deliberately never retried, including an uncertain reply.
      operation({action: 'release', owner_pid: ownerPid, handle: lease.handle, owner_creation: lease.owner_creation});
    }
  });
}

export function assertWindowsPrivateFile(path) {windowsUpgradeOperation({action: 'assert_private', path});}
export function readWindowsPrivateBytes(path) {
  const result = windowsUpgradeOperation({action: 'read', path});
  if (result.contents_base64 === null) return null;
  if (typeof result.contents_base64 !== 'string') throw new Error('Windows private-file response invalid');
  return Buffer.from(result.contents_base64, 'base64');
}
