# UTF-8 with BOM. ASCII-only so Windows PowerShell 5.1 and pwsh can parse
# this file regardless of the console code page. Recommended host: pwsh.
#Requires -Version 5.1
[CmdletBinding()]
param(
  [Parameter(Position = 0)]
  [ValidateSet("up", "down", "status", "logs", "check", "pull")]
  [string]$Action = "up",

  [Parameter(Position = 1)]
  [ValidateSet("fake", "real")]
  [string]$Mode = "real",

  [Parameter(Position = 2)]
  [ValidateSet("pull", "build")]
  [string]$Source = "pull",

  [switch]$NoBuild
)

$ErrorActionPreference = "Stop"
if ($NoBuild) { $Source = "pull" }

$DeployDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$RepoRoot = (Resolve-Path (Join-Path $DeployDir "..")).Path
$EnvFile = Join-Path $DeployDir ".env"
$EnvExample = Join-Path $DeployDir ".env.example"
$MasterKeyFile = Join-Path $DeployDir "master.key"
$ComposeFile = Join-Path $DeployDir "docker-compose.prod.yml"
$RealComposeFile = Join-Path $DeployDir "docker-compose.real.yml"
$DefaultImageRegistry = "crpi-6s5wwv0nhl6dq1l0.cn-hangzhou.personal.cr.aliyuncs.com/summersec"
$AcrHost = "crpi-6s5wwv0nhl6dq1l0.cn-hangzhou.personal.cr.aliyuncs.com"
$DefaultSharedAssetsHelperImage = "docker.io/library/busybox@sha256:fc6dddc4c44b1bfe37f41cae8e67d1693828e8f42a91862816d7953e2c9d3f23"
$Utf8NoBom = [Text.UTF8Encoding]::new($false)

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

function Get-DefaultImageTag {
  $registryFile = Join-Path $DeployDir "runtime-image-registry.json"
  if (Test-Path -LiteralPath $registryFile) {
    try {
      $registry = [IO.File]::ReadAllText($registryFile, $Utf8NoBom) | ConvertFrom-Json
      $version = [string]$registry.images[0].versions[0].version
      if ($version -match "^[0-9]") { return $version }
    } catch {}
  }
  $exampleTag = [IO.File]::ReadAllLines($EnvExample, $Utf8NoBom) |
    Where-Object { $_ -match "^DEEPSONAR_IMAGE_TAG=(.+)$" } |
    Select-Object -First 1
  if ($exampleTag -match "^DEEPSONAR_IMAGE_TAG=(.+)$") {
    $value = $Matches[1].Trim().TrimStart("v")
    if ($value) { return $value }
  }
  throw "Cannot resolve the current release version from deploy/runtime-image-registry.json or deploy/.env.example"
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
  $raw = Read-EnvFileRaw
  if ($raw -match "change-me-") {
    throw "deploy/.env still contains change-me placeholders"
  }

  $defaultImageTag = Get-DefaultImageTag
  Ensure-EnvKv "DEEPSONAR_IMAGE_REGISTRY" $DefaultImageRegistry
  Ensure-EnvKv "DEEPSONAR_IMAGE_TAG" $defaultImageTag
  Ensure-EnvKv "DEEPSONAR_SHARED_ASSETS_HELPER_IMAGE" $DefaultSharedAssetsHelperImage
  $raw = Read-EnvFileRaw
  if ($raw -match "(?m)^DEEPSONAR_IMAGE_TAG=latest$") {
    Ensure-EnvValue "DEEPSONAR_IMAGE_TAG" $defaultImageTag
    Write-Host "[deploy] Normalized legacy latest image tag to $defaultImageTag"
  }
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

function Get-SharedAssetsHelperImage {
  $image = Read-EnvValue "DEEPSONAR_SHARED_ASSETS_HELPER_IMAGE" $DefaultSharedAssetsHelperImage
  if ($image -notmatch "^[^@\s]+@sha256:[0-9a-f]{64}$") {
    throw "DEEPSONAR_SHARED_ASSETS_HELPER_IMAGE must be an immutable image ref with a 64-char lowercase sha256 digest"
  }
  return $image
}

function Pull-SharedAssetsHelper {
  if ($Mode -ne "real") { return }
  $image = Get-SharedAssetsHelperImage
  Write-Host "[deploy] Pulling shared-assets helper: $image"
  & docker pull $image
  if ($LASTEXITCODE -ne 0) { throw "Failed to pull DEEPSONAR_SHARED_ASSETS_HELPER_IMAGE: $image" }
}

function Pull-AppImages {
  $registry = Read-EnvValue "DEEPSONAR_IMAGE_REGISTRY" $DefaultImageRegistry
  $tag = Read-EnvValue "DEEPSONAR_IMAGE_TAG" (Get-DefaultImageTag)
  Write-Host "[deploy] Pulling app images from ${registry} tag=${tag}"
  foreach ($name in @("deepsonar-scheduler", "deepsonar-web", "deepsonar-image-admission")) {
    $ref = "${registry}/${name}:${tag}"
    Write-Host "[deploy] pull $ref"
    & docker pull $ref
    if ($LASTEXITCODE -ne 0) { throw "Failed to pull $ref" }
  }
}

Assert-Command "docker"
& docker compose version | Out-Null
Initialize-Env

$ComposeArgs = @("compose", "-p", "deepsonar", "--env-file", $EnvFile, "-f", $ComposeFile)
if ($Mode -eq "real") {
  $ComposeArgs += @("-f", $RealComposeFile)
}

Push-Location $RepoRoot
try {
  switch ($Action) {
    "check" {
      & docker @ComposeArgs config --quiet
      if ($LASTEXITCODE -ne 0) { throw "Docker Compose validation failed" }
      if ($Mode -eq "real") { $null = Get-SharedAssetsHelperImage }
      Write-Host "[deploy] Compose configuration is valid." -ForegroundColor Green
      Write-Host "[deploy] Image source: $(Read-EnvValue 'DEEPSONAR_IMAGE_REGISTRY' $DefaultImageRegistry) / $(Read-EnvValue 'DEEPSONAR_IMAGE_TAG' (Get-DefaultImageTag))"
    }
    "pull" {
      Pull-AppImages
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
      Pull-SharedAssetsHelper

      if ($Source -eq "build") {
        Write-Host "[deploy] Local Dockerfile build mode"
        & docker @ComposeArgs up -d --build
      } else {
        Pull-AppImages
        & docker @ComposeArgs up -d --pull missing
      }
      if ($LASTEXITCODE -ne 0) { throw "Failed to start services" }

      $port = Read-EnvValue "DEEPSONAR_WEB_PORT" "8080"
      $health = "http://127.0.0.1:$port/api/health"
      $ready = $false
      for ($i = 0; $i -lt 60; $i++) {
        try {
          $response = Invoke-RestMethod -Uri $health -TimeoutSec 3
          if ($response.ok -eq $true) { $ready = $true; break }
        } catch {}
        Start-Sleep -Seconds 2
      }
      if (-not $ready) {
        & docker @ComposeArgs ps
        & docker @ComposeArgs logs --tail 100 scheduler image-admission web
        throw "Services did not become healthy within 120 seconds: $health"
      }

      Write-Host "[deploy] DeepSonar is ready: http://127.0.0.1:$port" -ForegroundColor Green
      Write-Host "[deploy] App images: $(Read-EnvValue 'DEEPSONAR_IMAGE_REGISTRY' $DefaultImageRegistry)/*:$(Read-EnvValue 'DEEPSONAR_IMAGE_TAG' (Get-DefaultImageTag))"
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
