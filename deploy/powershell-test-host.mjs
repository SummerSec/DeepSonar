// Baseline launcher: the regression tests exercise the current shared-cache path.
import {spawnSync} from 'node:child_process';

export const spawnPowerShellSync = spawnSync;

export function findPowerShell({commands = ['pwsh', 'powershell'], env = process.env, required = Boolean(process.env.CI)} = {}) {
  for (const command of commands) {
    if (spawnPowerShellSync(command, ['-NoProfile', '-Command', 'exit 0'], {env}).status === 0) return command;
  }
  if (required) throw new Error('CI must provide PowerShell');
  return null;
}
