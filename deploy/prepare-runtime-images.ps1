[CmdletBinding()]
param(
  [switch]$DryRun,
  [switch]$Pull,
  [switch]$Build,
  [string[]]$LoadPath = @(),
  [string[]]$LocalImage = @(),
  [switch]$Adopt,
  [string]$ApiUrl = ""
)

# Windows helper for the transport/trust split:
# 1. The operator may pull, build, or load an image on this Docker host.
# 2. The Scheduler detects the local image and returns immutable evidence.
# 3. Only an explicit administrator confirmation can adopt an adoptable candidate.
# This script never writes the database and never trusts a mutable tag by itself.

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
$RegistryFile = Join-Path $PSScriptRoot "runtime-image-registry.json"
$DefaultApiUrl = if ($env:DEEPSONAR_URL) { $env:DEEPSONAR_URL } else { "http://127.0.0.1:3100" }
$RequestedApiUrl = if ($ApiUrl) { $ApiUrl } else { $DefaultApiUrl }
$script:ApiRoot = $null
$script:ApiToken = if ($env:DEEPSONAR_TOKEN) { $env:DEEPSONAR_TOKEN } else { "" }
$script:RegistrySource = "static"
$script:RegistryDiagnostic = $null

function Write-Log {
  param([string]$Message)
  Write-Host "[runtime-images] $Message"
}

function Read-EnvToken {
  if ($env:DEEPSONAR_TOKEN) { return $env:DEEPSONAR_TOKEN }
  foreach ($file in @((Join-Path $Root ".env"), (Join-Path $PSScriptRoot ".env"))) {
    if (-not (Test-Path -LiteralPath $file)) { continue }
    $raw = Get-Content -LiteralPath $file -Raw -Encoding UTF8
    $match = [regex]::Match($raw, '(?m)^\s*DEEPSONAR_ADMIN_TOKEN\s*=\s*(.*?)\s*$')
    if ($match.Success) {
      $value = $match.Groups[1].Value.Trim()
      $doubleQuoted = [char]34
      $singleQuoted = [char]39
      if ($value.Length -ge 2 -and (($value.StartsWith($doubleQuoted) -and $value.EndsWith($doubleQuoted)) -or ($value.StartsWith($singleQuoted) -and $value.EndsWith($singleQuoted)))) {
        $value = $value.Substring(1, $value.Length - 2)
      }
      return $value
    }
  }
  return ""
}

$script:ApiToken = Read-EnvToken

function Invoke-DeepSonarJson {
  param(
    [Parameter(Mandatory = $true)][ValidateSet("GET", "POST")][string]$Method,
    [Parameter(Mandatory = $true)][string]$Path,
    [object]$Body
  )
  if (-not $script:ApiRoot) { throw "Scheduler API unavailable; check DEEPSONAR_URL and service status" }
  $headers = @{}
  if ($script:ApiToken) { $headers["Authorization"] = "Bearer $($script:ApiToken)" }
  $params = @{
    Uri = "$($script:ApiRoot)$Path"
    Method = $Method
    Headers = $headers
    ErrorAction = "Stop"
  }
  if ($null -ne $Body) {
    $params["ContentType"] = "application/json"
    $params["Body"] = ($Body | ConvertTo-Json -Depth 20 -Compress)
  }
  try {
    return Invoke-RestMethod @params
  } catch {
    $status = $null
    $responseBody = $null
    try {
      $status = [int]$_.Exception.Response.StatusCode
      $reader = New-Object System.IO.StreamReader($_.Exception.Response.GetResponseStream())
      $responseBody = $reader.ReadToEnd()
      $reader.Dispose()
    } catch { }
    $message = "HTTP $status"
    if ($responseBody) {
      try {
        $parsed = $responseBody | ConvertFrom-Json
        if ($parsed.error) { $message = [string]$parsed.error }
        elseif ($parsed.message) { $message = [string]$parsed.message }
      } catch {
        $message = $responseBody.Trim()
      }
    } elseif ($_.Exception.Message) {
      $message = $_.Exception.Message
    }
    if ($script:ApiToken) { $message = $message.Replace($script:ApiToken, "<redacted>") }
    throw "${message}"
  }
}

function Resolve-ApiRoot {
  $base = $RequestedApiUrl.TrimEnd('/')
  $roots = @($base)
  if (-not $base.EndsWith('/api')) { $roots += "$base/api" }
  if ($DryRun) {
    $script:ApiRoot = $roots[0]
    return
  }
  foreach ($root in $roots) {
    try {
      $headers = @{}
      if ($script:ApiToken) { $headers["Authorization"] = "Bearer $($script:ApiToken)" }
      Invoke-RestMethod -Uri "$root/health" -Method GET -Headers $headers -TimeoutSec 10 -ErrorAction Stop | Out-Null
      $script:ApiRoot = $root
      Write-Log "connected to Scheduler API: $root"
      return
    } catch {
      $script:RegistryDiagnostic = $_.Exception.Message
    }
  }
  $script:ApiRoot = $null
}

function Get-Registry {
  if (-not $DryRun) {
    Resolve-ApiRoot
    if ($script:ApiRoot) {
      try {
        $registry = Invoke-DeepSonarJson -Method GET -Path "/runtime-images/registry"
        if ($registry.source) {
          $script:RegistrySource = [string]$registry.source
        } elseif ($registry.fallback) {
          $script:RegistrySource = "bundled fallback"
        } else {
          $script:RegistrySource = "Scheduler API"
        }
        if ($registry.error) { $script:RegistryDiagnostic = [string]$registry.error }
        return $registry
      } catch {
        $script:RegistryDiagnostic = $_.Exception.Message
      }
    }
  }
  if (-not (Test-Path -LiteralPath $RegistryFile)) { throw "API and static registry are unavailable: $RegistryFile" }
  $script:RegistrySource = "static registry (fallback)"
  return (Get-Content -LiteralPath $RegistryFile -Raw -Encoding UTF8 | ConvertFrom-Json)
}

function Invoke-Docker {
  param([Parameter(Mandatory = $true)][string[]]$Arguments)
  if ($DryRun) {
    Write-Log "dry-run: docker $($Arguments -join ' ')"
    return $true
  }
  & docker @Arguments
  if ($LASTEXITCODE -ne 0) { throw "docker $($Arguments -join ' ') failed (exit $LASTEXITCODE)" }
  return $true
}

function Get-ImageMap {
  $map = @{}
  if ($LocalImage.Count -eq 0) {
    $map = @{
      "deepsonar-base" = "deepsonar-base:local";
      "deepsonar-audit" = "deepsonar-audit:local";
      "deepsonar-kali-minimal" = "deepsonar-kali-minimal:local";
      "deepsonar-openharmony-test" = "deepsonar-openharmony-test:local";
      "deepsonar-openharmony-audit" = "deepsonar-openharmony-audit:local";
      "deepsonar-openharmony-fuzz" = "deepsonar-openharmony-fuzz:local";
      "deepsonar-chrome-audit" = "deepsonar-chrome-audit:local";
      "deepsonar-chrome-test" = "deepsonar-chrome-test:local";
      "deepsonar-chrome-fuzz" = "deepsonar-chrome-fuzz:local";
    }
  }
  foreach ($spec in $LocalImage) {
    if ($spec -notmatch '^([^=]+)=(.+)$') { throw "-LocalImage must use image-key=local-tag/ref" }
    $map[$Matches[1].Trim()] = $Matches[2].Trim()
  }
  return $map
}

function Get-ImageVersion {
  param([object]$Image)
  $versions = @($Image.versions)
  if ($versions.Count -eq 0) { return $null }
  # v2 keeps the legacy GitHub projection in image_ref. Channel-only entries
  # are intentionally skipped until channel-aware pull selection exists.
  $immutable = $versions | Where-Object { [string]$_.image_ref -match '@sha256:[0-9a-fA-F]{64}$' }
  return @($immutable)[0]
}

function Pull-RegistryImages {
  param([object]$Registry, [hashtable]$ImageMap)
  foreach ($image in @($Registry.images)) {
    $version = Get-ImageVersion $image
    if ($null -eq $version) { continue }
    if (-not $ImageMap.ContainsKey([string]$image.image_key)) { continue }
    $localRef = [string]$ImageMap[[string]$image.image_key]
    $remoteRef = [string]$version.image_ref
    if ($remoteRef -notmatch '@sha256:[0-9a-fA-F]{64}$') { Write-Log "skip non-immutable registry ref: $remoteRef"; continue }
    Invoke-Docker -Arguments @("pull", $remoteRef) | Out-Null
    if ($remoteRef -ne $localRef) { Invoke-Docker -Arguments @("tag", $remoteRef, $localRef) | Out-Null }
    Write-Log "prepared $($image.image_key): $localRef (transport only; not adopted)"
  }
}

function Build-LocalImages {
  param([hashtable]$ImageMap)
  $dockerfiles = @{
    "deepsonar-base" = "deploy/Dockerfile.agent";
    "deepsonar-audit" = "deploy/Dockerfile.agent";
    "deepsonar-kali-minimal" = "deploy/Dockerfile.agent-kali-minimal";
    "deepsonar-openharmony-test" = "deploy/Dockerfile.agent-openharmony";
    "deepsonar-openharmony-audit" = "deploy/Dockerfile.agent-openharmony-audit";
    "deepsonar-openharmony-fuzz" = "deploy/Dockerfile.agent-openharmony-fuzz";
    "deepsonar-chrome-audit" = "deploy/Dockerfile.agent-chrome-audit";
    "deepsonar-chrome-test" = "deploy/Dockerfile.agent-chrome-test";
    "deepsonar-chrome-fuzz" = "deploy/Dockerfile.agent-chrome-fuzz";
  }
  $buildOrder = @(
    "deepsonar-base",
    "deepsonar-audit",
    "deepsonar-kali-minimal",
    "deepsonar-openharmony-test",
    "deepsonar-openharmony-audit",
    "deepsonar-openharmony-fuzz",
    "deepsonar-chrome-audit",
    "deepsonar-chrome-test",
    "deepsonar-chrome-fuzz"
  )
  foreach ($key in $buildOrder) {
    if (-not $ImageMap.ContainsKey($key)) { continue }
    if (-not $dockerfiles.ContainsKey($key)) { continue }
    $file = Join-Path $Root $dockerfiles[$key]
    if (-not (Test-Path -LiteralPath $file)) { Write-Log "skip $($key): Dockerfile not found: $file"; continue }
    $args = @("build", "--file", $file, "--tag", [string]$ImageMap[$key])
    if ($key -eq "deepsonar-base") { $args += @("--build-arg", "TOOLSET=base") }
    if ($key -eq "deepsonar-audit") { $args += @("--build-arg", "TOOLSET=audit") }
    if ($key -like "deepsonar-openharmony-*" -or $key -like "deepsonar-chrome-*") {
      $baseRef = if ($ImageMap.ContainsKey("deepsonar-base")) { [string]$ImageMap["deepsonar-base"] } else { "deepsonar-base:local" }
      $args += @("--build-arg", "BASE_IMAGE=$baseRef")
    }
    $args += $Root
    Invoke-Docker -Arguments $args | Out-Null
  }
}

function Load-LocalImages {
  foreach ($path in $LoadPath) {
    $resolved = (Resolve-Path -LiteralPath $path -ErrorAction Stop).Path
    Invoke-Docker -Arguments @("load", "--input", $resolved) | Out-Null
    Write-Log "loaded image archive: $resolved; pass -LocalImage with its local tag to detect"
  }
}

function Detect-LocalImage {
  param([object]$Image, [string]$LocalRef)
  if ($DryRun) {
    $id = if ($Image.id) { [string]$Image.id } else { "<image-id-for-$($Image.image_key)>" }
    Write-Log "dry-run: POST /runtime-images/$id/detect-local image_ref=$LocalRef"
    return $null
  }
  if (-not $script:ApiRoot) { throw "detect requires Scheduler API; start the service or check DEEPSONAR_URL" }
  return Invoke-DeepSonarJson -Method POST -Path "/runtime-images/$($Image.id)/detect-local" -Body @{ image_ref = $LocalRef }
}

function Adopt-LocalImage {
  param([object]$Image, [string]$LocalRef, [object]$Candidate)
  if (-not [bool]$Candidate.adoptable -or -not $Candidate.image_id) {
    Write-Log "skip $($Image.image_key): candidate is not adoptable; no approval request sent"
    return
  }
  $expected = [string]$Candidate.image_id
  $answer = Read-Host "Approve adoption for $($Image.image_key) (image_id=$expected)? Type ADOPT to continue"
  if ($answer -cne "ADOPT") {
    Write-Log "not confirmed for $($Image.image_key); remains untrusted"
    return
  }
  if ($DryRun) {
    $id = if ($Image.id) { [string]$Image.id } else { "<image-id-for-$($Image.image_key)>" }
    Write-Log "dry-run: POST /runtime-images/$id/adopt-local expected_image_id=$expected"
    return
  }
  Invoke-DeepSonarJson -Method POST -Path "/runtime-images/$($Image.id)/adopt-local" -Body @{
    image_ref = $LocalRef;
    expected_image_id = $expected;
  } | Out-Null
  Write-Log "adopted $($Image.image_key): $($expected.Substring(0, [Math]::Min(19, $expected.Length)))..."
}

try {
  Set-Location -LiteralPath $Root
  $registry = Get-Registry
  if (-not $registry.images) { throw "registry has no images" }
  $imageMap = Get-ImageMap
  $marketRows = @()
  if (-not $DryRun -and $script:ApiRoot) {
    try {
      $marketRows = @(Invoke-DeepSonarJson -Method GET -Path "/runtime-images")
    } catch {
      throw "cannot resolve runtime image product IDs: $($_.Exception.Message)"
    }
  }
  $marketIds = @{}
  foreach ($row in $marketRows) {
    if ($row.image_key -and $row.id) { $marketIds[[string]$row.image_key] = [string]$row.id }
  }
  Write-Log "registry source: $script:RegistrySource"
  if ($script:RegistryDiagnostic) { Write-Log "registry diagnostic: $script:RegistryDiagnostic" }
  if ($Pull) { Pull-RegistryImages -Registry $registry -ImageMap $imageMap }
  if ($Build) { Build-LocalImages -ImageMap $imageMap }
  if ($LoadPath.Count -gt 0) { Load-LocalImages }

  $success = 0
  $failed = 0
  foreach ($image in @($registry.images)) {
    if ([string]$image.source_kind -ne "official" -and $image.source_kind -ne $null) { continue }
    $key = [string]$image.image_key
    if (-not $imageMap.ContainsKey($key)) { continue }
    if (-not $image.id -and $marketIds.ContainsKey($key)) {
      $image | Add-Member -MemberType NoteProperty -Name id -Value $marketIds[$key] -Force
    }
    if (-not $DryRun -and -not $image.id) {
      $failed++
      Write-Log "$($key) failed: product ID is missing from /runtime-images"
      continue
    }
    $localRef = [string]$imageMap[$key]
    try {
      $candidate = Detect-LocalImage -Image $image -LocalRef $localRef
      if ($DryRun) { continue }
      if ([bool]$candidate.adoptable) {
        $candidateStatus = "adoptable"
      } else {
        $candidateStatus = "not adoptable"
      }
      Write-Log "$($key): $candidateStatus; image_id=$($candidate.image_id); immutable_ref=$($candidate.immutable_ref)"
      if ($candidate.reasons) {
        $reasonText = @($candidate.reasons) -join " | "
        Write-Log "  reasons: $reasonText"
      }
      if ($Adopt) { Adopt-LocalImage -Image $image -LocalRef $localRef -Candidate $candidate }
      $success++
    } catch {
      $failed++
      $message = $_.Exception.Message
      if ($script:ApiToken) { $message = $message.Replace($script:ApiToken, "<redacted>") }
      Write-Log "$key failed: $message"
    }
  }
  if ($DryRun) {
    Write-Log "dry-run complete: no docker, detect, or adopt write operations executed"
  } else {
    Write-Log "detect summary: success $success, failed $failed; detection never changes trust automatically"
  }
  if ($failed -gt 0) { exit 1 }
} catch {
  $message = $_.Exception.Message
  if ($script:ApiToken) { $message = $message.Replace($script:ApiToken, "<redacted>") }
  Write-Error $message
  exit 1
}
