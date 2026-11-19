import {spawnSync} from 'node:child_process';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

// Test harness only. -NoProfile does not disable ProfileOptimization: concurrent
// Unix hosts can corrupt their shared StartupProfileData-NonInteractive file.
// https://github.com/PowerShell/PowerShell/issues/26528
export function spawnPowerShellSync(command, args, options = {}) {
  const settings = {encoding: 'utf8', timeout: 30_000, windowsHide: true, ...options};
  if (process.platform === 'win32') return spawnSync(command, args, settings);
  const cache = mkdtempSync(join(tmpdir(), 'deepsonar-pwsh-cache-'));
  try {
    return spawnSync(command, args, {...settings, env: {...(settings.env ?? process.env), XDG_CACHE_HOME: cache}});
  } finally {
    rmSync(cache, {recursive: true, force: true});
  }
}

export function findPowerShell({commands = ['pwsh', 'powershell'], env = process.env, required = Boolean(process.env.CI)} = {}) {
  const marker = 'deepsonar-powershell-probe-ok';
  for (const command of commands) {
    const result = spawnPowerShellSync(command, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', `[Console]::Write('${marker}')`], {env});
    if (result.error?.code === 'ENOENT') continue;
    if (!result.error && result.status === 0 && result.stdout === marker) return command;
    throw new Error(`PowerShell startup failed (${command}; status=${result.status}; signal=${result.signal}): ${result.error?.message ?? ''}\n${result.stderr ?? ''}\nstdout=${result.stdout ?? ''}`);
  }
  if (required) throw new Error('CI must provide PowerShell');
  return null;
}
