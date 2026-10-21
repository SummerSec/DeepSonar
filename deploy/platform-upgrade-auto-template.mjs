import {isAbsolute, win32, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {autoError} from './platform-upgrade-auto-policy.mjs';

const xml = value => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;');
const systemdQuote = (value, expandEnvironment = true) => '"' + value.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('%', '%%').replaceAll('$', () => expandEnvironment ? '$$' : '$') + '"';
// CommandLineToArgvW / Node argument quoting, including trailing backslashes.
const windowsQuote = value => '"' + value.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1') + '"';

export function generateAutomaticTask({scheduler, policy, nodePath = process.execPath, hostPath = fileURLToPath(new URL('./platform-upgrade-host.mjs', import.meta.url))}) {
  if (!['systemd', 'windows'].includes(scheduler)) throw autoError('AUTO_TASK_SCHEDULER_INVALID');
  const absolute = scheduler === 'windows' ? win32.isAbsolute : isAbsolute;
  for (const path of [policy, nodePath, hostPath]) if (typeof path !== 'string' || !absolute(path) || /[\x00-\x1f\x7f]/.test(path)) throw autoError('AUTO_TASK_ABSOLUTE_PATH_REQUIRED');
  if (scheduler === 'systemd' && [policy, nodePath, hostPath].some(path => path.includes('\\'))) throw autoError('AUTO_TASK_PATH_UNSUPPORTED');
  if (scheduler === 'windows') {
    const contents = `<?xml version="1.0" encoding="UTF-8"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo><Description>DeepSonar opt-in patch maintenance. Disabled until an administrator configures policy, identity and explicitly enables the task.</Description></RegistrationInfo>
  <Triggers><CalendarTrigger><Repetition><Interval>PT1H</Interval><Duration>P1D</Duration><StopAtDurationEnd>false</StopAtDurationEnd></Repetition><StartBoundary>2026-01-01T00:00:00</StartBoundary><Enabled>true</Enabled><ScheduleByDay><DaysInterval>1</DaysInterval></ScheduleByDay></CalendarTrigger></Triggers>
  <Settings><MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy><DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries><StopIfGoingOnBatteries>false</StopIfGoingOnBatteries><StartWhenAvailable>true</StartWhenAvailable><Enabled>false</Enabled><ExecutionTimeLimit>PT0S</ExecutionTimeLimit></Settings>
  <Actions><Exec><Command>${xml(nodePath)}</Command><Arguments>${xml([hostPath, 'auto', '--policy', policy].map(windowsQuote).join(' '))}</Arguments><WorkingDirectory>${xml(win32.dirname(hostPath))}</WorkingDirectory></Exec></Actions>
</Task>
`;
    return {scheduler, enabled: false, installation: 'manual_only', files: {'deepsonar-auto-upgrade.xml': contents}};
  }
  const service = `[Unit]
Description=DeepSonar opt-in patch maintenance
After=docker.service network-online.target

[Service]
Type=oneshot
WorkingDirectory=${dirname(hostPath).replaceAll('%', '%%')}
ExecStart=${[nodePath, hostPath, 'auto', '--policy', policy].map(value => systemdQuote(value)).join(' ')}
TimeoutStartSec=infinity
`;
  const timer = `[Unit]
Description=DeepSonar maintenance policy check (administrator installation only)

[Timer]
OnCalendar=hourly
Persistent=true
Unit=deepsonar-auto-upgrade.service

[Install]
WantedBy=timers.target
`;
  // The .disabled suffix prevents these generated names being loaded as units.
  return {scheduler, enabled: false, installation: 'manual_only', files: {'deepsonar-auto-upgrade.service.disabled': service, 'deepsonar-auto-upgrade.timer.disabled': timer}};
}
