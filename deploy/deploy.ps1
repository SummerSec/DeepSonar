[CmdletBinding()]
param(
  [ValidateSet("up", "down", "status", "logs", "check", "pull")]
  [string]$Action = "up",

  [ValidateSet("fake", "real")]
  [string]$Mode = "fake",

  [switch]$NoBuild
)

$ErrorActionPreference = "Stop"
$DeployDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$RepoRoot = (Resolve-Path (Join-Path $DeployDir "..")).Path
$EnvFile = Join-Path $DeployDir ".env"
$EnvExample = Join-Path $DeployDir ".env.example"
$MasterKeyFile = Join-Path $DeployDir "master.key"
$ComposeFile = Join-Path $DeployDir "docker-compose.prod.yml"
$RealComposeFile = Join-Path $DeployDir "docker-compose.real.yml"
$DefaultSharedAssetsHelperImage = "docker.io/library/busybox@sha256:fc6dddc4c44b1bfe37f41cae8e67d1693828e8f42a91862816d7953e2c9d3f23"

function Assert-Command([string]$Name) {
  if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
    throw "Required command is missing: $Name"
  }
}

function New-HexSecret([int]$GuidCount = 2) {
  $parts = for ($i = 0; $i -lt $GuidCount; $i++) { [guid]::NewGuid().ToString("N") }
  return ($parts -join "")
}

function Get-DefaultImageTag {
  $registryFile = Join-Path $DeployDir "runtime-image-registry.json"
  if (Test-Path -LiteralPath $registryFile) {
    try {
      $registry = Get-Content -LiteralPath $registryFile -Raw -Encoding UTF8 | ConvertFrom-Json
      $version = [string]$registry.images[0].versions[0].version
      if ($version -match "^[0-9]") { return $version }
    } catch {}
  }
  $exampleTag = Get-Content -LiteralPath $EnvExample -Encoding UTF8 |
    Where-Object { $_ -match "^DEEPSONAR_IMAGE_TAG=(.+)$" } |
    Select-Object -First 1
  if ($exampleTag -match "^DEEPSONAR_IMAGE_TAG=(.+)$") {
    $value = $Matches[1].Trim().TrimStart("v")
    if ($value) { return $value }
  }
  throw "Cannot resolve the current release version from deploy/runtime-image-registry.json or deploy/.env.example"
}

function Ensure-EnvSecret([string]$Name, [string]$Value) {
  $raw = Get-Content -LiteralPath $EnvFile -Raw -Encoding UTF8
  $pattern = "(?m)^$([regex]::Escape($Name))=(.*)$"
  $match = [regex]::Match($raw, $pattern)
  if ($match.Success) {
    $current = $match.Groups[1].Value.Trim()
    if ($current -and $current -notmatch "^change-me-") { return }
    $raw = [regex]::Replace($raw, $pattern, { param($m) "$Name=$Value" }, 1)
  } else {
    $raw = "$($raw.TrimEnd())`n$Name=$Value`n"
  }
  [IO.File]::WriteAllText($EnvFile, $raw, [Text.UTF8Encoding]::new($false))
  Write-Host "[deploy] Generated $Name." -ForegroundColor Green
}

function Ensure-EnvValue([string]$Name, [string]$Value) {
  $raw = Get-Content -LiteralPath $EnvFile -Raw -Encoding UTF8
  $pattern = "(?m)^$([regex]::Escape($Name))=.*$"
  if ([regex]::IsMatch($raw, $pattern)) {
    $raw = [regex]::Replace($raw, $pattern, { param($m) "$Name=$Value" }, 1)
  } else {
    $raw = "$($raw.TrimEnd())`n$Name=$Value`n"
  }
  [IO.File]::WriteAllText($EnvFile, $raw, [Text.UTF8Encoding]::new($false))
}

function Initialize-Env {
  if (-not (Test-Path -LiteralPath $EnvFile)) {
    $content = Get-Content -LiteralPath $EnvExample -Raw -Encoding UTF8
    $content = $content.Replace("change-me-postgres-password", (New-HexSecret 1))
    $content = $content.Replace("change-me-bootstrap-admin-token", "deepsonar_bootstrap_$(New-HexSecret 2)")
    [IO.File]::WriteAllText($EnvFile, $content, [Text.UTF8Encoding]::new($false))
    Write-Host "[deploy] Created deploy/.env with random database and bootstrap secrets." -ForegroundColor Green
  }

  $raw = Get-Content -LiteralPath $EnvFile -Raw -Encoding UTF8
  if ($raw -notmatch "(?m)^DEEPSONAR_MASTER_KEY_FILE=") {
    $raw = "$($raw.TrimEnd())`nDEEPSONAR_MASTER_KEY_FILE=/run/secrets/deepsonar_master_key`n"
    [IO.File]::WriteAllText($EnvFile, $raw, [Text.UTF8Encoding]::new($false))
  }

  Ensure-EnvSecret "BLOB_S3_ACCESS_KEY_ID" (New-HexSecret 1)
  Ensure-EnvSecret "BLOB_S3_SECRET_ACCESS_KEY" (New-HexSecret 2)
  $raw = Get-Content -LiteralPath $EnvFile -Raw -Encoding UTF8
  if ($raw -match "change-me-") {
    throw "deploy/.env still contains change-me placeholders"
  }
  $defaultImageTag = Get-DefaultImageTag
  if ($raw -match "(?m)^DEEPSONAR_IMAGE_TAG=latest$") {
    Ensure-EnvValue "DEEPSONAR_IMAGE_TAG" $defaultImageTag
  } elseif ($raw -notmatch "(?m)^DEEPSONAR_IMAGE_TAG=") {
    Ensure-EnvValue "DEEPSONAR_IMAGE_TAG" $defaultImageTag
  }
  $raw = Get-Content -LiteralPath $EnvFile -Raw -Encoding UTF8
  if ($raw -notmatch "(?m)^DEEPSONAR_SHARED_ASSETS_HELPER_IMAGE=") {
    Ensure-EnvValue "DEEPSONAR_SHARED_ASSETS_HELPER_IMAGE" $DefaultSharedAssetsHelperImage
  }

  if (-not (Test-Path -LiteralPath $MasterKeyFile)) {
    [IO.File]::WriteAllText($MasterKeyFile, (New-HexSecret 2), [Text.UTF8Encoding]::new($false))
    Write-Host "[deploy] Created deploy/master.key for encrypted provider credentials." -ForegroundColor Green
  }
}

function Read-EnvValue([string]$Name, [string]$Default = "") {
  $line = Get-Content -LiteralPath $EnvFile -Encoding UTF8 |
    Where-Object { $_ -match "^$([regex]::Escape($Name))=" } |
    Select-Object -First 1
  if (-not $line) { return $Default }
  return ($line -split "=", 2)[1].Trim()
}

function Get-SharedAssetsHelperImage {
  $image = Read-EnvValue "DEEPSONAR_SHARED_ASSETS_HELPER_IMAGE" $DefaultSharedAssetsHelperImage
  if ($image -notmatch "^[^@\s]+@sha256:[0-9a-f]{64}$") {
    throw "DEEPSONAR_SHARED_ASSETS_HELPER_IMAGE 必须是带 64 位小写 sha256 digest 的 immutable image 引用"
  }
  return $image
}

function Get-ImageRepoDigest([string]$Tag) {
  $raw = & docker image inspect --format "{{range .RepoDigests}}{{println .}}{{end}}" $Tag
  if ($LASTEXITCODE -ne 0) { return $null }
  return @(
    $raw -split "\r?\n" |
      Where-Object { $_ -match "^[^@\s]+@sha256:[0-9a-f]{64}$" -and $_ -like "*deepsonar-assets-helper@*" }
  ) | Select-Object -First 1
}

function Pull-SharedAssetsHelper {
  if ($Mode -ne "real") { return }
  $registry = Read-EnvValue "DEEPSONAR_IMAGE_REGISTRY" ""
  $tag = Read-EnvValue "DEEPSONAR_IMAGE_TAG" (Get-DefaultImageTag)
  if ($registry) {
    $official = "$registry/deepsonar-assets-helper:$tag"
    Write-Host "[deploy] 尝试拉取官方共享资产 helper：$official"
    & docker pull $official
    if ($LASTEXITCODE -eq 0) {
      $digest = Get-ImageRepoDigest $official
      if ($digest -match "^[^@\s]+@sha256:[0-9a-f]{64}$") {
        Ensure-EnvValue "DEEPSONAR_SHARED_ASSETS_HELPER_IMAGE" $digest
        Write-Host "[deploy] 已解析官方 helper 不可变引用：$digest"
        return
      }
      Write-Host "[deploy] 官方 helper 缺少 RepoDigest，回退 busybox pin"
    } else {
      Write-Host "[deploy] 官方 helper 标签不可用（当前 Release 可能尚未发布），回退 busybox pin"
    }
  }
  $image = Get-SharedAssetsHelperImage
  Write-Host "[deploy] 拉取共享资产 helper：$image"
  & docker pull $image
  if ($LASTEXITCODE -ne 0) { throw "拉取 DEEPSONAR_SHARED_ASSETS_HELPER_IMAGE 失败：$image" }
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
    }
    "pull" {
      Pull-SharedAssetsHelper
      if ($Mode -eq "real") {
        Write-Host "[deploy] real 模式共享资产 helper 已拉取。" -ForegroundColor Green
      } else {
        Write-Host "[deploy] fake 模式不使用共享资产 helper。" -ForegroundColor Yellow
      }
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

      $UpArgs = @("up", "-d")
      if (-not $NoBuild) { $UpArgs += "--build" }
      & docker @ComposeArgs @UpArgs
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
      Write-Host "[deploy] The bootstrap admin token is stored as DEEPSONAR_ADMIN_TOKEN in deploy/.env."
      Write-Host "[deploy] Human default admin: admin / Deep@Sonar66. Change the password (and preferably the username) immediately in production."
      if ($Mode -eq "fake") {
        Write-Host "[deploy] Running in fake mode. Configure credentials and use -Mode real for real agents." -ForegroundColor Yellow
      }
    }
  }
} finally {
  Pop-Location
}
