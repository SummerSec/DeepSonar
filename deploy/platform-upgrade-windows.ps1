$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$borrowed = [IntPtr]::Zero
try {
  if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) { throw 'Unsupported kernel' }
  Add-Type -Path (Join-Path $PSScriptRoot 'platform-upgrade-windows.cs')
  $request = [Console]::In.ReadToEnd() | ConvertFrom-Json
  if ($request.lock_lease) {
    $borrowed = [UpgradeWindows]::BorrowLease([int]$request.lock_lease.owner_pid, $request.lock_lease.handle, $request.lock_lease.owner_creation)
  }
  switch ($request.action) {
    'acquire' {
      $lease = [UpgradeWindows]::Acquire($request.path, [int]$request.owner_pid)
      $result = @{ ok = $true; handle = $lease[0]; owner_creation = $lease[1] }
    }
    'release' {
      [UpgradeWindows]::Release([int]$request.owner_pid, $request.handle, $request.owner_creation)
      $result = @{ ok = $true }
    }
    'write' { [UpgradeWindows]::WritePrivate($request.path, $request.contents_base64); $result = @{ ok = $true } }
    'read' { $result = @{ ok = $true; contents_base64 = [UpgradeWindows]::ReadPrivate($request.path) } }
    'rename' { [UpgradeWindows]::Rename($request.source, $request.target); $result = @{ ok = $true } }
    'probe' { [UpgradeWindows]::Probe($request.path); $result = @{ ok = $true } }
    'directory' { [UpgradeWindows]::ProtectDirectory($request.path); $result = @{ ok = $true } }
    'assert_private' { [UpgradeWindows]::AssertPrivateFile($request.path); $result = @{ ok = $true } }
    default { throw 'Unknown operation' }
  }
  [Console]::Out.WriteLine(($result | ConvertTo-Json -Compress))
} catch {
  # Exception text can contain private paths or input. Expose only fixed codes.
  $busy = $_.Exception.ToString().Contains('WINDOWS_UPGRADE_LOCK_BUSY')
  [Console]::Out.WriteLine((@{ok = $false; code = $(if ($busy) {'WINDOWS_UPGRADE_LOCK_BUSY'} else {'WINDOWS_UPGRADE_IO_FAILED'})} | ConvertTo-Json -Compress))
  exit 1
} finally {
  if ($borrowed -ne [IntPtr]::Zero) { [UpgradeWindows]::CloseLease($borrowed) }
}
