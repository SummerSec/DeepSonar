import {spawnSync} from 'node:child_process';

// A Windows ACL cannot prove Linux container UID access. Probe the exact target
// image and numeric user with the selected file mounted read-only, off-network.
// The bounded private result is never logged or written to disk.
export const WINDOWS_KEY_PROBE = `const fs=require('node:fs');
const fd=fs.openSync('/run/deepsonar-preflight-key',fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);
const bytes=Buffer.alloc(4097);
try{const before=fs.fstatSync(fd);if(!before.isFile()||before.size>4096)throw Error();
const n=fs.readSync(fd,bytes,0,bytes.length,0),after=fs.fstatSync(fd);
if(n!==before.size||n>4096||before.size!==after.size||before.mtimeMs!==after.mtimeMs)throw Error();
process.stdout.write(JSON.stringify({mode:before.mode&4095,content:bytes.subarray(0,n).toString('utf8')}));
}finally{bytes.fill(0);fs.closeSync(fd);}`;

export async function probeWindowsMasterKey({file, image, user, assertPrivateFile, run = spawnSync}) {
  if (!assertPrivateFile) ({assertPrivateFile} = await import('./platform-upgrade-filesystem.mjs'));
  if (typeof file !== 'string' || /[,\r\n\0]/.test(file)
      || !/^[^\s@]+@sha256:[a-f0-9]{64}$/.test(image)
      || !/^\d+(?::\d+)?$/.test(user)) throw new Error('WINDOWS_KEY_PROBE_INVALID_BINDING');
  await assertPrivateFile(file);
  let result;
  try {
    result = run('docker', ['run', '--rm', '--network=none', '--read-only', '--cap-drop=ALL',
      '--security-opt=no-new-privileges', '--pids-limit=64', '--memory=128m', '--user', user,
      '--mount', `type=bind,source=${file},target=/run/deepsonar-preflight-key,readonly`,
      '--entrypoint=node', image, '-e', WINDOWS_KEY_PROBE],
    {timeout: 30_000, maxBuffer: 32_768, windowsHide: true});
    if (result.error || result.signal || result.status !== 0) throw new Error();
    const value = JSON.parse(result.stdout.toString());
    if (!Number.isInteger(value.mode) || value.mode < 0 || value.mode > 4095
        || typeof value.content !== 'string' || Buffer.byteLength(value.content) > 4096) throw new Error();
    await assertPrivateFile(file);
    return value;
  } catch {throw new Error('WINDOWS_KEY_PROBE_FAILED');}
  finally {result?.stdout?.fill?.(0); result?.stderr?.fill?.(0);}
}
