import {open, rename, mkdir, chmod, readFile, lstat} from 'node:fs/promises';
import {dirname} from 'node:path';
import {windowsUpgradeOperation, assertWindowsPrivateFile, readWindowsPrivateBytes} from './platform-upgrade-windows.mjs';

export async function ensurePrivateDirectory(path) {
  if (process.platform === 'win32') {windowsUpgradeOperation({action: 'directory', path});return;}
  await mkdir(path, {recursive: true, mode: 0o700});
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('private directory must not be a symlink');
  await chmod(path, 0o700);
}

export async function assertDirectoryDurability(path) {
  if (process.platform === 'win32') {windowsUpgradeOperation({action: 'probe', path}); return;}
  let handle;
  try {handle = await open(path, 'r'); await handle.sync();}
  catch {throw new Error('HOST_DIRECTORY_DURABILITY_UNSUPPORTED: directory fsync is required before maintenance');}
  finally {await handle?.close();}
}

export async function durableRename(source, target) {
  if (process.platform === 'win32') {windowsUpgradeOperation({action: 'rename', source, target}); return;}
  if (dirname(source) !== dirname(target)) throw new Error('durable rename requires the same directory');
  await rename(source, target);
  const directory = await open(dirname(target), 'r');
  try {await directory.sync();} finally {await directory.close();}
}

export async function durablePrivateWrite(path, contents) {
  if (process.platform === 'win32') {
    windowsUpgradeOperation({action: 'write', path, contents_base64: Buffer.from(contents).toString('base64')});
    return;
  }
  await mkdir(dirname(path), {recursive: true, mode: 0o700});
  const temporary = `${path}.${process.pid}.tmp`;
  const file = await open(temporary, 'wx', 0o600);
  try {await file.writeFile(contents); await file.sync();} finally {await file.close();}
  await durableRename(temporary, path);
  await chmod(path, 0o600);
}

/** Metadata only. Windows checks the actual file handle's protected owner DACL. */
export async function assertPrivateFile(path) {
  if (process.platform === 'win32') {assertWindowsPrivateFile(path); return;}
  const info = await lstat(path);
  if (!info.isFile() || (info.mode & 0o077) !== 0) throw new Error('private recovery file has unsafe permissions');
}

export async function readPrivateJson(path) {
  if (process.platform === 'win32') {
    const bytes = readWindowsPrivateBytes(path);
    if (bytes === null) return null;
    try {return JSON.parse(bytes.toString('utf8'));}
    catch {throw new Error('private recovery JSON is invalid');}
    finally {bytes.fill(0);}
  }
  try {await assertPrivateFile(path);return JSON.parse(await readFile(path, 'utf8'));}
  catch (error) {if (error.code === 'ENOENT') return null;throw error;}
}
