# UTF-8 with BOM. ASCII-only so Windows PowerShell 5.1 and pwsh can parse
# this file regardless of the console code page. Recommended host: pwsh.
#Requires -Version 5.1
[CmdletBinding()]
param(
  [Parameter(Position = 0)]
  [ValidateSet("up", "down", "status", "logs", "check", "pull", "upgrade")]
  [string]$Action = "up",

  [Parameter(Position = 1)]
  [ValidateSet("fake", "real", "worker-join", "check", "apply", "rollback")]
  [string]$Mode = "real",

  [Parameter(Position = 2)]
  [ValidateSet("pull", "build")]
  [string]$Source = "pull",

  [string]$ControlPlane = $env:DEEPSONAR_CONTROL_PLANE,

  [string]$UpgradeVersion,
  [string]$ApiUrl,
  [string]$WebUrl,

  [switch]$NoBuild
)

$ErrorActionPreference = "Stop"
if ($Action -eq "upgrade") {
  if ($Mode -notin @("check", "apply", "rollback")) { throw "upgrade requires check, apply or rollback" }
  if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw "upgrade requires Node.js >=22" }
  $upgradeArgs = @((Join-Path $PSScriptRoot "platform-upgrade-host.mjs"), $Mode)
  if ($UpgradeVersion) { $upgradeArgs += @("--to", $UpgradeVersion) }
  if ($ApiUrl) { $upgradeArgs += @("--api", $ApiUrl) }
  if ($WebUrl) { $upgradeArgs += @("--web-url", $WebUrl) }
  & node @upgradeArgs
  exit $LASTEXITCODE
}
if ($Mode -notin @("fake", "real", "worker-join")) { throw "invalid deployment mode" }
if ($NoBuild) { $Source = "pull" }

$DeployDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$RepoRoot = (Resolve-Path (Join-Path $DeployDir "..")).Path
$EnvFile = Join-Path $DeployDir ".env"
$EnvExample = Join-Path $DeployDir ".env.example"
$MasterKeyFile = Join-Path $DeployDir "master.key"
$ComposeFile = Join-Path $DeployDir "docker-compose.prod.yml"
$RealComposeFile = Join-Path $DeployDir "docker-compose.real.yml"
$OpenSandboxComposeFile = Join-Path $DeployDir "docker-compose.opensandbox.prod.yml"
$WorkerComposeFile = Join-Path $DeployDir "docker-compose.worker.yml"
$PodmanCompatFile = Join-Path $DeployDir "docker-compose.podman-compat.yml"
$PodmanCompatOpenSandboxFile = Join-Path $DeployDir "docker-compose.podman-compat.opensandbox.yml"
$DefaultImageRegistry = "crpi-6s5wwv0nhl6dq1l0.cn-hangzhou.personal.cr.aliyuncs.com/summersec"
$AcrHost = "crpi-6s5wwv0nhl6dq1l0.cn-hangzhou.personal.cr.aliyuncs.com"
$DefaultSharedAssetsHelperImage = "docker.io/library/busybox@sha256:fc6dddc4c44b1bfe37f41cae8e67d1693828e8f42a91862816d7953e2c9d3f23"
$DefaultSiloImage = "docker.io/pgsty/silo:RELEASE.2026-08-06T00-00-00Z"
$Utf8NoBom = [Text.UTF8Encoding]::new($false)
$ImmutableDigestRe = "^[^@\s]+@sha256:[0-9a-f]{64}$"
# Platform images (#740): one full immutable digest ref per image, plus an explicit
# DEEPSONAR_VERSION. The removed DEEPSONAR_IMAGE_TAG and mutable tags fail closed.
$PlatformImageSpecs = [ordered]@{
  DEEPSONAR_SCHEDULER_IMAGE = "deepsonar-scheduler"
  DEEPSONAR_WEB_IMAGE = "deepsonar-web"
  DEEPSONAR_IMAGE_ADMISSION_IMAGE = "deepsonar-image-admission"
}
$PlatformVersionRe = "^[0-9]+\.[0-9]+\.[0-9]+([-+][0-9A-Za-z.+-]+)?$"
$LocalBuildTag = "local-build"

function Get-DeployTuningInt([string]$Name, [int]$Default) {
  $raw = [Environment]::GetEnvironmentVariable($Name)
  if ([string]::IsNullOrWhiteSpace($raw)) {
    $raw = Read-EnvValue $Name ""
  }
  if ([string]::IsNullOrWhiteSpace($raw)) { return $Default }
  $n = 0
  if (-not [int]::TryParse($raw, [ref]$n) -or $n -le 0) { return $Default }
  return $n
}

function Get-ContainerRuntimeHint {
  $forced = [Environment]::GetEnvironmentVariable("DEEPSONAR_CONTAINER_RUNTIME")
  if (-not [string]::IsNullOrWhiteSpace($forced)) { return $forced.Trim().ToLowerInvariant() }
  try {
    $result = Invoke-DockerBounded -DockerArgs @("info")
    $info = $result.Output
    if ($info -match "(?i)podman") { return "podman" }
  } catch {}
  $dh = [Environment]::GetEnvironmentVariable("DOCKER_HOST")
  if ($dh -and $dh -match "(?i)podman") { return "podman" }
  return "docker"
}

function Should-UseStartedDepends {
  $mode = [Environment]::GetEnvironmentVariable("DEEPSONAR_COMPOSE_DEPENDS_ON")
  if ([string]::IsNullOrWhiteSpace($mode)) {
    $mode = Read-EnvValue "DEEPSONAR_COMPOSE_DEPENDS_ON" "auto"
  }
  switch -Regex ($mode.Trim().ToLowerInvariant()) {
    "^(started|service_started)$" { return $true }
    "^(healthy|service_healthy)$" { return $false }
    default { return ((Get-ContainerRuntimeHint) -eq "podman") }
  }
}

function Protect-DeployOutput([string]$Text) {
  $Text = $Text -replace '(?i)([a-z0-9_]*(?:PASSWORD|SECRET|TOKEN|ACCESS_KEY|API_KEY|MASTER_KEY|BOOTSTRAP)[a-z0-9_]*["'']?\s*[:=]\s*["'']?)[^"''\s,}]+', '$1***'
  $Text = $Text -replace '(?i)(Authorization:\s*Bearer\s+)[^\s]+', '$1***'
  return ($Text -replace '(?i)(postgres(?:ql)?://[^:]+:)[^@]+@', '$1***@')
}

function ConvertTo-NativeArgument([string]$Value) {
  # Start-Process joins ArgumentList on PS 5.1: quote paths/JSON/Go templates safely.
  return '"' + ([regex]::Replace(([regex]::Replace($Value, '(\\*)"', '$1$1\"')), '(\\+)$', '$1$1')) + '"'
}

function Invoke-DockerBounded {
  param([string[]]$DockerArgs, [int]$TimeoutSec = 3)
  if ($TimeoutSec -le 0) { throw "Timeout must be positive" }
  $stdout = [IO.Path]::GetTempFileName()
  $stderr = [IO.Path]::GetTempFileName()
  try {
    $nativeArgs = @($DockerArgs | ForEach-Object { ConvertTo-NativeArgument $_ })
    $p = Start-Process -FilePath "docker" -ArgumentList $nativeArgs -NoNewWindow -PassThru `
      -RedirectStandardOutput $stdout -RedirectStandardError $stderr
    $ok = $p.WaitForExit($TimeoutSec * 1000)
    $rc = 124
    if (-not $ok) {
      # PS 7 supports tree kill; Windows PS 5.1 uses taskkill /T for compose plugins.
      try { $p.Kill($true) } catch {
        if ($env:OS -eq "Windows_NT") {
          try {
            $killer = Start-Process taskkill -ArgumentList @("/PID", $p.Id, "/T", "/F") -PassThru -NoNewWindow
            if (-not $killer.WaitForExit(1000)) { $killer.Kill() }
          } catch {}
        }
        try { $p.Kill() } catch {}
      }
      $null = $p.WaitForExit(1000)
    } else {
      $rc = $p.ExitCode
    }
    $output = [IO.File]::ReadAllText($stdout) + [IO.File]::ReadAllText($stderr)
    return [pscustomobject]@{ ExitCode = $rc; Output = $output }
  } finally {
    Remove-Item $stdout, $stderr -ErrorAction SilentlyContinue
  }
}

function Invoke-DockerComposeUpBounded {
  param([string[]]$ComposeArgs, [string[]]$UpArgs, [int]$TimeoutSec)
  $result = Invoke-DockerBounded -DockerArgs ($ComposeArgs + @("up") + $UpArgs) -TimeoutSec $TimeoutSec
  Write-Host (Protect-DeployOutput $result.Output)
  return $result.ExitCode
}

function Write-DeployDiagnostics {
  param([string[]]$ComposeArgs)
  Write-Host "[deploy] ===== deploy diagnostics (#726) ====="
  foreach ($argsToRun in @(@("version"), @("compose", "version"), @($ComposeArgs + @("ps", "-a")), @($ComposeArgs + @("logs", "--tail", "80", "postgres", "silo", "silo-init", "scheduler", "image-admission", "web", "opensandbox")))) {
    try {
      $result = Invoke-DockerBounded -DockerArgs $argsToRun -TimeoutSec 3
      Write-Host (Protect-DeployOutput $result.Output)
    } catch { Write-Host "[deploy] diagnostic command unavailable" }
  }
  Write-Host "[deploy] ===== end diagnostics ====="
}

function Wait-InfraReady {
  param([string[]]$ComposeArgs, [int]$TimeoutSec)
  $clock = [Diagnostics.Stopwatch]::StartNew()
  foreach ($probe in @(@("exec", "-T", "postgres", "pg_isready", "-U", "deepsonar", "-d", "deepsonar"), @("exec", "-T", "silo", "silo", "healthcheck", "ready"))) {
    while ($true) {
      $remaining = $TimeoutSec - [int][Math]::Ceiling($clock.Elapsed.TotalSeconds)
      if ($remaining -le 0) { return $false }
      $result = Invoke-DockerBounded -DockerArgs ($ComposeArgs + $probe) -TimeoutSec ([Math]::Min(3, $remaining))
      if ($result.ExitCode -eq 0) { break }
      $remainingMs = [int](($TimeoutSec * 1000) - $clock.Elapsed.TotalMilliseconds)
      if ($remainingMs -gt 0) { Start-Sleep -Milliseconds ([Math]::Min(2000, $remainingMs)) }
    }
  }
  return $true
}

function Test-RequiredServicesRunning {
  param([string[]]$ComposeArgs)
  foreach ($service in @("scheduler", "web")) {
    $ids = Invoke-DockerBounded -DockerArgs ($ComposeArgs + @("ps", "-a", "-q", $service))
    if ($ids.ExitCode -ne 0 -or [string]::IsNullOrWhiteSpace($ids.Output)) { return $false }
    $state = Invoke-DockerBounded -DockerArgs @("inspect", "--format", "{{.State.Status}}", $ids.Output.Trim())
    if ($state.ExitCode -ne 0 -or $state.Output.Trim() -ne "running") { return $false }
  }
  return $true
}

function Wait-EntryReady {
  param([string]$Url, [int]$TimeoutSec)
  Write-Host "[deploy] waiting for entry readiness: $Url (bound ${TimeoutSec}s)"
  $clock = [Diagnostics.Stopwatch]::StartNew()
  while ($clock.Elapsed.TotalSeconds -lt $TimeoutSec) {
    $remaining = $TimeoutSec - [int][Math]::Floor($clock.Elapsed.TotalSeconds)
    try {
      $response = Invoke-RestMethod -Uri $Url -TimeoutSec ([Math]::Min(3, $remaining))
      if (($response.ok -is [bool]) -and $response.ok -and ($response.ready -is [bool]) -and $response.ready) { return $true }
    } catch {}
    $remainingMs = [int](($TimeoutSec * 1000) - $clock.Elapsed.TotalMilliseconds)
    if ($remainingMs -gt 0) { Start-Sleep -Milliseconds ([Math]::Min(2000, $remainingMs)) }
  }
  return $false
}

function Assert-Command([string]$Name) {
  if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
    throw "Required command is missing: $Name"
  }
}

function New-HexSecret([int]$GuidCount = 2) {
  $parts = for ($i = 0; $i -lt $GuidCount; $i++) { [guid]::NewGuid().ToString("N") }
  return ($parts -join "")
}

function Read-EnvFileRaw {
  return [IO.File]::ReadAllText($EnvFile, $Utf8NoBom)
}

function Write-EnvFileRaw([string]$Raw) {
  [IO.File]::WriteAllText($EnvFile, $Raw, $Utf8NoBom)
}

function Ensure-EnvKv([string]$Name, [string]$Value) {
  $raw = Read-EnvFileRaw
  $pattern = "(?m)^$([regex]::Escape($Name))="
  if ([regex]::IsMatch($raw, $pattern)) { return }
  $raw = "$($raw.TrimEnd())`n$Name=$Value`n"
  Write-EnvFileRaw $raw
  Write-Host "[deploy] Wrote $Name=$Value"
}

function Ensure-EnvSecret([string]$Name, [string]$Value) {
  $raw = Read-EnvFileRaw
  $pattern = "(?m)^$([regex]::Escape($Name))=(.*)$"
  $match = [regex]::Match($raw, $pattern)
  if ($match.Success) {
    $current = $match.Groups[1].Value.Trim()
    if ($current -and $current -notmatch "^change-me-") { return }
    $raw = [regex]::Replace($raw, $pattern, "$Name=$Value", 1)
  } else {
    $raw = "$($raw.TrimEnd())`n$Name=$Value`n"
  }
  Write-EnvFileRaw $raw
  Write-Host "[deploy] Generated $Name." -ForegroundColor Green
}

function Ensure-EnvValue([string]$Name, [string]$Value) {
  $raw = Read-EnvFileRaw
  $pattern = "(?m)^$([regex]::Escape($Name))=.*$"
  if ([regex]::IsMatch($raw, $pattern)) {
    $raw = [regex]::Replace($raw, $pattern, "$Name=$Value", 1)
  } else {
    $raw = "$($raw.TrimEnd())`n$Name=$Value`n"
  }
  Write-EnvFileRaw $raw
}

function Ensure-AllowedImageRegistries {
  $raw = Read-EnvFileRaw
  $pattern = "(?m)^DEEPSONAR_ALLOWED_IMAGE_REGISTRIES=(.*)$"
  $match = [regex]::Match($raw, $pattern)
  if ($match.Success) {
    $current = $match.Groups[1].Value
    if ($current -like "*${AcrHost}*") { return }
    $raw = [regex]::Replace($raw, $pattern, "DEEPSONAR_ALLOWED_IMAGE_REGISTRIES=$current,$AcrHost", 1)
    Write-EnvFileRaw $raw
    Write-Host "[deploy] Added Aliyun ACR to DEEPSONAR_ALLOWED_IMAGE_REGISTRIES."
    return
  }
  Ensure-EnvKv "DEEPSONAR_ALLOWED_IMAGE_REGISTRIES" "ghcr.io,docker.io,registry-1.docker.io,$AcrHost"
}

function Initialize-Env {
  if (-not (Test-Path -LiteralPath $EnvFile)) {
    $content = [IO.File]::ReadAllText($EnvExample, $Utf8NoBom)
    $content = $content.Replace("change-me-postgres-password", (New-HexSecret 1))
    $content = $content.Replace("change-me-bootstrap-admin-token", "deepsonar_bootstrap_$(New-HexSecret 2)")
    Write-EnvFileRaw $content
    Write-Host "[deploy] Created deploy/.env with random database and bootstrap secrets." -ForegroundColor Green
  }

  $raw = Read-EnvFileRaw
  if ($raw -notmatch "(?m)^DEEPSONAR_MASTER_KEY_FILE=") {
    Write-EnvFileRaw "$($raw.TrimEnd())`nDEEPSONAR_MASTER_KEY_FILE=/run/secrets/deepsonar_master_key`n"
  }

  Ensure-EnvSecret "BLOB_S3_ACCESS_KEY_ID" (New-HexSecret 1)
  Ensure-EnvSecret "BLOB_S3_SECRET_ACCESS_KEY" (New-HexSecret 2)
  if ($Mode -ne "worker-join") {
    Ensure-EnvSecret "DEEPSONAR_WORKER_BOOTSTRAP_TOKEN" (New-HexSecret 2)
  }
  $raw = Read-EnvFileRaw
  if ($raw -match "change-me-") {
    throw "deploy/.env still contains change-me placeholders"
  }

  # No auto-fill and no tag fallback: worker-join runs no platform image, so it
  # only rejects the removed variable.
  $requirePlatform = -not ($Mode -eq "worker-join" -and $Action -ne "pull")
  Assert-PlatformImageContract $requirePlatform
  Ensure-EnvKv "DEEPSONAR_IMAGE_REGISTRY" $DefaultImageRegistry
  Ensure-EnvKv "DEEPSONAR_SHARED_ASSETS_HELPER_IMAGE" $DefaultSharedAssetsHelperImage
  Ensure-EnvKv "SILO_IMAGE" $DefaultSiloImage
  Ensure-AllowedImageRegistries

  if (-not (Test-Path -LiteralPath $MasterKeyFile)) {
    [IO.File]::WriteAllText($MasterKeyFile, (New-HexSecret 2), $Utf8NoBom)
    Write-Host "[deploy] Created deploy/master.key for encrypted provider credentials." -ForegroundColor Green
  }
}

function Read-EnvValue([string]$Name, [string]$Default = "") {
  $line = [IO.File]::ReadAllLines($EnvFile, $Utf8NoBom) |
    Where-Object { $_ -match "^$([regex]::Escape($Name))=" } |
    Select-Object -First 1
  if (-not $line) { return $Default }
  return ($line -split "=", 2)[1].Trim()
}

function Get-EffectiveEnvValue([string]$Name) {
  # Process env beats deploy/.env, matching Docker Compose interpolation.
  $fromProcess = [Environment]::GetEnvironmentVariable($Name)
  if ($null -ne $fromProcess) { return $fromProcess }
  if (-not (Test-Path -LiteralPath $EnvFile)) { return "" }
  return Read-EnvValue $Name ""
}

function Test-PlatformImageRef([string]$Ref, [string]$Repo) {
  return $Ref -cmatch ("^[a-z0-9][a-z0-9._:/-]*/" + [regex]::Escape($Repo) + "@sha256:[0-9a-f]{64}$")
}

function Get-PlatformImageContractErrors([bool]$RequirePlatform) {
  $errors = New-Object System.Collections.Generic.List[string]
  if (Test-Path -LiteralPath $EnvFile) {
    if ((Read-EnvFileRaw) -match "(?m)^[ \t]*(export[ \t]+)?DEEPSONAR_IMAGE_TAG([ \t]*[=:]|[ \t]*\r?$)") {
      $errors.Add("deploy/.env contains the removed DEEPSONAR_IMAGE_TAG (platform images are no longer deployed by tag)")
    }
  }
  if ($null -ne [Environment]::GetEnvironmentVariable("DEEPSONAR_IMAGE_TAG")) {
    $errors.Add("process environment sets the removed DEEPSONAR_IMAGE_TAG; unset it and retry")
  }
  if ($RequirePlatform) {
    if (Test-Path -LiteralPath $EnvFile) {
      foreach ($key in @("DEEPSONAR_VERSION") + @($PlatformImageSpecs.Keys)) {
        $escaped = [regex]::Escape($key)
        $assignments = @([IO.File]::ReadAllLines($EnvFile, $Utf8NoBom) |
          Where-Object { $_ -cmatch "^[ \t]*(export[ \t]+)?${escaped}([ \t]*[=:]|[ \t]*$)" })
        if ($assignments.Count -gt 1 -or ($assignments.Count -eq 1 -and -not $assignments[0].StartsWith("${key}="))) {
          $errors.Add("$key must have at most one canonical KEY=value assignment in deploy/.env")
        }
      }
    }
    foreach ($key in $PlatformImageSpecs.Keys) {
      $repo = $PlatformImageSpecs[$key]
      $value = Get-EffectiveEnvValue $key
      if ([string]::IsNullOrWhiteSpace($value)) {
        $errors.Add("missing $key (must be <registry>/$repo@sha256:<64 lowercase hex>)")
      } elseif (-not (Test-PlatformImageRef $value $repo)) {
        $errors.Add("$key=$value is not an immutable digest ref for $repo (must be <registry>/$repo@sha256:<64 lowercase hex>; tags are rejected)")
      }
    }
    $version = Get-EffectiveEnvValue "DEEPSONAR_VERSION"
    if ([string]::IsNullOrWhiteSpace($version)) {
      $errors.Add("missing DEEPSONAR_VERSION (the only source of /health.version; no image tag fallback)")
    } elseif ($version -cnotmatch $PlatformVersionRe) {
      $errors.Add("DEEPSONAR_VERSION=$version must be X.Y.Z without a v prefix (optional -/+ suffix)")
    }
  }
  return $errors.ToArray()
}

function Write-PlatformContractHint {
  Write-Host "[deploy] Platform images are now pinned by immutable digest (#740); DEEPSONAR_IMAGE_TAG and mutable tags are no longer accepted." -ForegroundColor Yellow
  Write-Host "[deploy] Remove DEEPSONAR_IMAGE_TAG from deploy/.env and copy these lines from the Release-synced deploy/.env.example, then retry:" -ForegroundColor Yellow
  if (Test-Path -LiteralPath $EnvExample) {
    [IO.File]::ReadAllLines($EnvExample, $Utf8NoBom) |
      Where-Object { $_ -match "^(DEEPSONAR_VERSION|DEEPSONAR_SCHEDULER_IMAGE|DEEPSONAR_WEB_IMAGE|DEEPSONAR_IMAGE_ADMISSION_IMAGE)=" } |
      ForEach-Object { Write-Host "  $_" }
  }
  Write-Host "[deploy] Do not delete the whole deploy/.env (it holds database passwords and keys); a later deploy.ps1 upgrade will regenerate these lines." -ForegroundColor Yellow
}

function Assert-PlatformImageContract([bool]$RequirePlatform) {
  $errors = @(Get-PlatformImageContractErrors $RequirePlatform)
  if ($errors.Count -eq 0) { return }
  foreach ($message in $errors) { Write-Host "[deploy] $message" -ForegroundColor Red }
  Write-PlatformContractHint
  throw "deploy/.env violates the platform image digest contract (#740); see the messages above"
}

function Get-PlatformImageRefs {
  return @($PlatformImageSpecs.Keys | ForEach-Object { Get-EffectiveEnvValue $_ })
}

function Write-PlatformImages {
  Write-Host "[deploy] Platform version: DEEPSONAR_VERSION=$(Get-EffectiveEnvValue 'DEEPSONAR_VERSION')"
  foreach ($key in $PlatformImageSpecs.Keys) {
    Write-Host "[deploy] ${key}: $(Get-EffectiveEnvValue $key)"
  }
}

function Set-LocalBuildPlatformImages {
  # Compose cannot tag a local build as name@sha256:...; deploy/.env stays untouched.
  foreach ($key in $PlatformImageSpecs.Keys) {
    [Environment]::SetEnvironmentVariable($key, "$($PlatformImageSpecs[$key]):$LocalBuildTag")
  }
}

function Get-SharedAssetsHelperImage {
  $image = Read-EnvValue "DEEPSONAR_SHARED_ASSETS_HELPER_IMAGE" $DefaultSharedAssetsHelperImage
  if ($image -notmatch $ImmutableDigestRe) {
    throw "DEEPSONAR_SHARED_ASSETS_HELPER_IMAGE must be an immutable image ref with a 64-char lowercase sha256 digest"
  }
  return $image
}

function Get-ImageRepoDigest([string]$Tag, [string]$NameNeedle) {
  $raw = & docker image inspect --format "{{range .RepoDigests}}{{println .}}{{end}}" $Tag
  if ($LASTEXITCODE -ne 0) { return $null }
  return @(
    $raw -split "\r?\n" |
      Where-Object { $_ -match $ImmutableDigestRe -and $_ -like "*${NameNeedle}*" }
  ) | Select-Object -First 1
}

function Pull-SharedAssetsHelper {
  if ($Mode -ne "real") { return }
  $registry = Read-EnvValue "DEEPSONAR_IMAGE_REGISTRY" $DefaultImageRegistry
  $tag = Get-EffectiveEnvValue "DEEPSONAR_VERSION"
  if ($registry -and $tag) {
    $official = "$registry/deepsonar-assets-helper:$tag"
    Write-Host "[deploy] Trying official shared-assets helper: $official"
    & docker pull $official
    if ($LASTEXITCODE -eq 0) {
      $digest = Get-ImageRepoDigest $official "deepsonar-assets-helper@"
      if ($digest -match $ImmutableDigestRe) {
        Ensure-EnvValue "DEEPSONAR_SHARED_ASSETS_HELPER_IMAGE" $digest
        Write-Host "[deploy] Resolved official helper immutable ref: $digest"
        return
      }
      Write-Host "[deploy] Official helper has no RepoDigest; falling back to busybox pin"
    } else {
      Write-Host "[deploy] Official helper tag is unavailable (this Release may not publish it yet); falling back to busybox pin"
    }
  }
  $image = Get-SharedAssetsHelperImage
  Write-Host "[deploy] Pulling shared-assets helper: $image"
  & docker pull $image
  if ($LASTEXITCODE -ne 0) { throw "Failed to pull DEEPSONAR_SHARED_ASSETS_HELPER_IMAGE: $image" }
}

function Test-PreferOfficialSilo([string]$Image) {
  return (-not $Image) -or ($Image -eq $DefaultSiloImage) -or ($Image -like "*deepsonar-silo*")
}

function Pull-OfficialSilo {
  $image = Read-EnvValue "SILO_IMAGE" $DefaultSiloImage
  if (-not (Test-PreferOfficialSilo $image)) {
    Write-Host "[deploy] Using overridden SILO_IMAGE=$image"
    & docker pull $image
    if ($LASTEXITCODE -ne 0) { throw "Failed to pull SILO_IMAGE: $image" }
    return
  }
  $registry = Read-EnvValue "DEEPSONAR_IMAGE_REGISTRY" $DefaultImageRegistry
  $tag = Get-EffectiveEnvValue "DEEPSONAR_VERSION"
  if ($registry -and $tag) {
    $official = "$registry/deepsonar-silo:$tag"
    Write-Host "[deploy] Trying official Silo: $official"
    & docker pull $official
    if ($LASTEXITCODE -eq 0) {
      $digest = Get-ImageRepoDigest $official "deepsonar-silo@"
      $resolved = if ($digest -match $ImmutableDigestRe) { $digest } else { $official }
      Ensure-EnvValue "SILO_IMAGE" $resolved
      Write-Host "[deploy] Set SILO_IMAGE=$resolved"
      return
    }
    Write-Host "[deploy] Official Silo tag is unavailable (this Release may not publish it yet); falling back to $DefaultSiloImage"
  }
  $fallback = Read-EnvValue "SILO_IMAGE" $DefaultSiloImage
  Write-Host "[deploy] Pulling Silo: $fallback"
  & docker pull $fallback
  if ($LASTEXITCODE -ne 0) { throw "Failed to pull SILO_IMAGE: $fallback" }
}

function Pull-AppImages {
  Write-Host "[deploy] Pulling platform images by immutable digest (DEEPSONAR_VERSION=$(Get-EffectiveEnvValue 'DEEPSONAR_VERSION'))"
  foreach ($ref in (Get-PlatformImageRefs)) {
    Write-Host "[deploy] pull $ref"
    & docker pull $ref
    if ($LASTEXITCODE -ne 0) { throw "Failed to pull $ref" }
  }
}

Assert-Command "docker"
& docker compose version | Out-Null
Initialize-Env

if ($Mode -eq "worker-join") {
  if ([string]::IsNullOrWhiteSpace($ControlPlane)) {
    throw "worker-join requires -ControlPlane or DEEPSONAR_CONTROL_PLANE"
  }
  Ensure-EnvValue "DEEPSONAR_CONTROL_PLANE" $ControlPlane
  $bootstrap = Read-EnvValue "DEEPSONAR_WORKER_BOOTSTRAP_TOKEN" ""
  if ([string]::IsNullOrWhiteSpace($bootstrap)) {
    throw "worker-join requires DEEPSONAR_WORKER_BOOTSTRAP_TOKEN to match the control plane"
  }
  $ComposeArgs = @("compose", "-p", "deepsonar-worker", "--env-file", $EnvFile, "-f", $WorkerComposeFile)
} else {
$ComposeArgs = @("compose", "-p", "deepsonar", "--env-file", $EnvFile, "-f", $ComposeFile)
if ($Mode -eq "real") {
  $ComposeArgs += @("-f", $RealComposeFile)
}
# Real mode defaults to OpenSandbox; set SANDBOX_PROVIDER to skip the overlay.
$sandboxProvider = if ([string]::IsNullOrWhiteSpace($env:SANDBOX_PROVIDER)) { "opensandbox" } else { $env:SANDBOX_PROVIDER }
$openSandboxOverlay = $false
if ($Mode -eq "real" -and $sandboxProvider -eq "opensandbox") {
  $ComposeArgs += @("-f", $OpenSandboxComposeFile)
  $openSandboxOverlay = $true
}
if (Should-UseStartedDepends) {
  Write-Host "[deploy] using service_started depends_on overlay (runtime=$(Get-ContainerRuntimeHint))"
  $ComposeArgs += @("-f", $PodmanCompatFile)
  if ($openSandboxOverlay) {
    $ComposeArgs += @("-f", $PodmanCompatOpenSandboxFile)
  }
}
}

Push-Location $RepoRoot
try {
  switch ($Action) {
    "check" {
      & docker @ComposeArgs config --quiet
      if ($LASTEXITCODE -ne 0) { throw "Docker Compose validation failed" }
      if ($Mode -eq "real") { $null = Get-SharedAssetsHelperImage }
      Write-Host "[deploy] Compose configuration is valid." -ForegroundColor Green
      if (-not ($Mode -eq "worker-join")) { Write-PlatformImages }
    }
    "pull" {
      Pull-AppImages
      Pull-OfficialSilo
      Pull-SharedAssetsHelper
      Write-Host "[deploy] App images pulled." -ForegroundColor Green
    }
    "status" {
      & docker @ComposeArgs ps
    }
    "logs" {
      & docker @ComposeArgs logs -f --tail 200
    }
    "down" {
      & docker @ComposeArgs down
      if ($LASTEXITCODE -ne 0) { throw "Failed to stop services" }
      Write-Host "[deploy] Services stopped; database and blob volumes were preserved." -ForegroundColor Yellow
    }
    "up" {
      & docker @ComposeArgs config --quiet
      if ($LASTEXITCODE -ne 0) { throw "Docker Compose validation failed" }
      $upTimeout = Get-DeployTuningInt "DEEPSONAR_COMPOSE_UP_TIMEOUT_SEC" 600
      $readyTimeout = Get-DeployTuningInt "DEEPSONAR_READY_TIMEOUT_SEC" 180
      if ($Mode -eq "worker-join") {
        if ($Source -eq "build") {
          $upRc = Invoke-DockerComposeUpBounded -ComposeArgs $ComposeArgs -UpArgs @("-d", "--build") -TimeoutSec $upTimeout
        } else {
          $upRc = Invoke-DockerComposeUpBounded -ComposeArgs $ComposeArgs -UpArgs @("-d", "--pull", "missing") -TimeoutSec $upTimeout
        }
        if ($upRc -ne 0) {
          Write-DeployDiagnostics -ComposeArgs $ComposeArgs
          throw "Failed to start worker-join services (exit=$upRc; 124=timeout)"
        }
        Write-Host "[deploy] worker-join started (compose project=deepsonar-worker)"
        Write-Host "[deploy] control-plane=$ControlPlane"
        break
      }
      Pull-OfficialSilo
      Pull-SharedAssetsHelper

      if ($Source -eq "build") {
        Write-Host "[deploy] Local Dockerfile build mode (platform images tagged *:$LocalBuildTag; deploy/.env digest refs unchanged)"
        Set-LocalBuildPlatformImages
        $upRc = Invoke-DockerComposeUpBounded -ComposeArgs $ComposeArgs -UpArgs @("-d", "--build") -TimeoutSec $upTimeout
      } else {
        Pull-AppImages
        $upRc = Invoke-DockerComposeUpBounded -ComposeArgs $ComposeArgs -UpArgs @("-d", "--pull", "missing") -TimeoutSec $upTimeout
      }
      if ($upRc -ne 0) {
        Write-DeployDiagnostics -ComposeArgs $ComposeArgs
        throw "Failed to start services within ${upTimeout}s (exit=$upRc; 124=timeout). See diagnostics above."
      }

      if (-not (Wait-InfraReady -ComposeArgs $ComposeArgs -TimeoutSec $readyTimeout)) {
        Write-DeployDiagnostics -ComposeArgs $ComposeArgs
        throw "Postgres/Silo real probes failed; refusing success via service_started alone"
      }
      $port = Read-EnvValue "DEEPSONAR_WEB_PORT" "8080"
      $health = "http://127.0.0.1:$port/api/health"
      $ready = Wait-EntryReady -Url $health -TimeoutSec $readyTimeout
      if (-not $ready) {
        Write-DeployDiagnostics -ComposeArgs $ComposeArgs
        throw "Services did not become healthy within ${readyTimeout}s: $health"
      }

      if (-not (Test-RequiredServicesRunning -ComposeArgs $ComposeArgs)) {
        Write-DeployDiagnostics -ComposeArgs $ComposeArgs
        throw "Required scheduler/web containers are not running"
      }
      Write-Host "[deploy] DeepSonar is ready: http://127.0.0.1:$port" -ForegroundColor Green
      if ($Source -eq "build") {
        Write-Host "[deploy] Platform images: local build *:$LocalBuildTag (DEEPSONAR_VERSION=$(Get-EffectiveEnvValue 'DEEPSONAR_VERSION'))"
      } else {
        Write-PlatformImages
      }
      Write-Host "[deploy] The bootstrap admin token is stored as DEEPSONAR_ADMIN_TOKEN in deploy/.env."
      Write-Host "[deploy] Human default admin: admin / Deep@Sonar66. Change the password (and preferably the username) immediately in production."
      if ($Mode -eq "fake") {
        Write-Host "[deploy] Running in fake mode. Use -Mode real for real agents." -ForegroundColor Yellow
      } else {
        Write-Host "[deploy] Running in real mode. docker.sock must be mounted (see docker-compose.real.yml)."
      }
    }
  }
} finally {
  Pop-Location
}
