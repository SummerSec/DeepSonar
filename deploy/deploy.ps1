[CmdletBinding()]
param(
  [ValidateSet("up", "down", "status", "logs", "check")]
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

function Assert-Command([string]$Name) {
  if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
    throw "Required command is missing: $Name"
  }
}

function New-HexSecret([int]$GuidCount = 2) {
  $parts = for ($i = 0; $i -lt $GuidCount; $i++) { [guid]::NewGuid().ToString("N") }
  return ($parts -join "")
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
  if ($raw -match "change-me-") {
    throw "deploy/.env still contains change-me placeholders"
  }
  if ($raw -notmatch "(?m)^DEEPSONAR_MASTER_KEY_FILE=") {
    $raw = "$($raw.TrimEnd())`nDEEPSONAR_MASTER_KEY_FILE=/run/secrets/deepsonar_master_key`n"
    [IO.File]::WriteAllText($EnvFile, $raw, [Text.UTF8Encoding]::new($false))
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
      Write-Host "[deploy] Compose configuration is valid." -ForegroundColor Green
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
        & docker @ComposeArgs logs --tail 100 scheduler web
        throw "Services did not become healthy within 120 seconds: $health"
      }

      Write-Host "[deploy] DeepSonar is ready: http://127.0.0.1:$port" -ForegroundColor Green
      Write-Host "[deploy] The bootstrap admin token is stored as DEEPSONAR_ADMIN_TOKEN in deploy/.env."
      if ($Mode -eq "fake") {
        Write-Host "[deploy] Running in fake mode. Configure credentials and use -Mode real for real agents." -ForegroundColor Yellow
      }
    }
  }
} finally {
  Pop-Location
}
