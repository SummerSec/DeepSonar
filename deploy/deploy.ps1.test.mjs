import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { fileURLToPath } from "node:url";

const scriptPath = join(dirname(fileURLToPath(import.meta.url)), "deploy.ps1");
const bytes = readFileSync(scriptPath);
const BOM = Buffer.from([0xef, 0xbb, 0xbf]);

const SMART_OR_FULLWIDTH = /[\u00ab\u00bb\u2018\u2019\u201c\u201d\u201e\u201f\u300c\u300d\u300e\u300f\u3002\uff01\uff02\uff08\uff09\uff0c\uff1a\uff1b\uff1f]/u;

function firstPwsh() {
  for (const cmd of ["pwsh", "powershell"]) {
    const probe = spawnSync(cmd, ["-NoProfile", "-Command", "exit 0"], {
      encoding: "utf8",
    });
    if (probe.error) continue;
    if (probe.status === 0) return cmd;
  }
  return null;
}

test("deploy.ps1 is UTF-8 with BOM so Windows PowerShell 5.1 can parse it", () => {
  assert.ok(bytes.length > 3, "deploy.ps1 is empty");
  assert.deepEqual([...bytes.subarray(0, 3)], [...BOM], "deploy.ps1 must start with a UTF-8 BOM");
  const body = bytes.subarray(3);
  assert.doesNotThrow(() => body.toString("utf8"), "body after BOM must be UTF-8");
  const text = new TextDecoder("utf-8", { fatal: true }).decode(body);
  assert.equal(text.charCodeAt(0), 35, "first character after BOM must be the comment marker");
});

test("deploy.ps1 stays ASCII-only (no smart quotes or fullwidth punctuation)", () => {
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(3));
  assert.match(text, /^[\t\n\r\x20-\x7e]+$/, "deploy.ps1 body must be ASCII so code pages cannot break parsing");
  const hit = SMART_OR_FULLWIDTH.exec(text);
  assert.equal(hit, null, hit ? `fragile punctuation at index ${hit.index}: ${JSON.stringify(hit[0])}` : "");
});

test("deploy.ps1 resolves the platform image tag from catalog platform_version", () => {
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(3));
  assert.match(text, /\$registry\.platform_version/);
  assert.doesNotMatch(text, /images\[0\]\.versions\[0\]\.version/);
});

test("deploy.ps1 pull/up matches deploy.sh app-image and official-image semantics", () => {
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(3));
  assert.match(text, /\$Mode = "real"/);
  assert.match(text, /\$Source = "pull"/);
  assert.match(text, /function Pull-AppImages/);
  for (const name of ["deepsonar-scheduler", "deepsonar-web", "deepsonar-image-admission"]) {
    assert.match(text, new RegExp(name));
  }
  assert.match(text, /deepsonar-assets-helper/);
  assert.match(text, /deepsonar-silo/);
  assert.match(text, /function Pull-OfficialSilo/);
  assert.match(text, /function Pull-SharedAssetsHelper/);
  assert.match(text, /falling back to busybox pin/);
  assert.match(text, /pgsty\/silo:RELEASE\.2026-08-06T00-00-00Z/);
  assert.match(text, /"-d", "--pull", "missing"/);
  assert.match(text, /"-d", "--build"/);
  assert.match(text, /Invoke-DockerComposeUpBounded/);
  assert.match(text, /if \(\$NoBuild\) \{ \$Source = "pull" \}/);
  assert.match(text, /IsNullOrWhiteSpace\(\$env:SANDBOX_PROVIDER\)/);
  assert.match(text, /"opensandbox"/);
  assert.match(text, /docker-compose.opensandbox.prod.yml/);
});

test("pwsh parser accepts deploy.ps1 when a PowerShell host is installed", (t) => {
  const cmd = firstPwsh();
  if (!cmd) {
    t.skip("pwsh/powershell is not installed on this runner");
    return;
  }
  const parse = `
    $errs = $null
    $null = [System.Management.Automation.Language.Parser]::ParseFile(${JSON.stringify(scriptPath)}, [ref]$null, [ref]$errs)
    if ($errs -and $errs.Count -gt 0) {
      $errs | ForEach-Object { $_.ToString() }
      exit 1
    }
    exit 0
  `;
  const result = spawnSync(cmd, ["-NoProfile", "-Command", parse], {
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
});

function runFunctions(t, script, options = {}) {
  const cmd = firstPwsh();
  if (!cmd) {
    assert.ok(!process.env.CI, "CI must provide pwsh/powershell for deployment behavior tests");
    t.skip("pwsh/powershell is not installed on this runner");
    return null;
  }
  const loadFunctions = `
$ErrorActionPreference = 'Stop'
$errors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile(${JSON.stringify(scriptPath)}, [ref]$null, [ref]$errors)
if ($errors.Count -gt 0) { throw ($errors | Out-String) }
$ast.FindAll({ param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] }, $false) | ForEach-Object { Invoke-Expression $_.Extent.Text }
`;
  const result = spawnSync(cmd, ["-NoProfile", "-Command", loadFunctions + script], {
    encoding: "utf8", timeout: 20_000, ...options,
  });
  assert.equal(result.status, 0, result.stdout + result.stderr + String(result.error ?? ""));
  return result;
}

test("PowerShell entry rejects live-only, malformed and string-valued readiness", (t) => {
  runFunctions(t, `
function Invoke-RestMethod { return $script:Health }
foreach ($json in @('{"ok":true}', '{"ok":true,"ready":false}', '{"ok":true,"ready":"true"}', '{"ok":true,"nested":{"ready":true}}', '{"ok":false,"ready":true}')) {
  $script:Health = $json | ConvertFrom-Json
  if (Wait-EntryReady -Url 'http://127.0.0.1:8080/api/health' -TimeoutSec 1) { throw "Accepted $json" }
}
$script:Health = '{"ok":true,"ready":true}' | ConvertFrom-Json
if (-not (Wait-EntryReady -Url 'http://127.0.0.1:8080/api/health' -TimeoutSec 1)) { throw 'Rejected ready response' }
`);
});

test("PowerShell dependencies and required containers fail closed", (t) => {
  runFunctions(t, `
$script:Calls = @()
$script:FailSilo = $false
$script:Created = $false
function Invoke-DockerBounded {
  param([string[]]$DockerArgs, [int]$TimeoutSec = 3)
  $line = $DockerArgs -join ' '
  $script:Calls += $line
  $rc = 0
  $output = ''
  if ($line -match 'silo healthcheck' -and $script:FailSilo) { $rc = 1 }
  if ($line -match 'ps -a -q') { $output = 'test-container' }
  if ($line -match '^inspect') { $output = if ($script:Created) { 'created' } else { 'running' } }
  return [pscustomobject]@{ExitCode=$rc; Output=$output}
}
if (-not (Wait-InfraReady -ComposeArgs @('compose') -TimeoutSec 3)) { throw 'Healthy dependencies rejected' }
if (-not (($script:Calls -join ';') -match 'exec -T postgres pg_isready')) { throw 'Postgres not probed' }
if (-not (($script:Calls -join ';') -match 'exec -T silo silo healthcheck ready')) { throw 'Silo not probed' }
$script:FailSilo = $true
if (Wait-InfraReady -ComposeArgs @('compose') -TimeoutSec 2) { throw 'Failed Silo accepted' }
if (-not (Test-RequiredServicesRunning -ComposeArgs @('compose'))) { throw 'Running containers rejected' }
$script:Created = $true
if (Test-RequiredServicesRunning -ComposeArgs @('compose')) { throw 'Created containers accepted' }
`);
});

test("PowerShell diagnostics redact secrets and pass bounded command budgets", (t) => {
  const result = runFunctions(t, `
function Invoke-DockerBounded {
  param([string[]]$DockerArgs, [int]$TimeoutSec)
  if ($TimeoutSec -ne 3) { throw 'Diagnostic command is not bounded' }
  return [pscustomobject]@{ExitCode=0; Output='PASSWORD=fake-secret {"token":"fake-token"} Authorization: Bearer fake-bearer postgresql://u:fake-password@h/db'}
}
Write-DeployDiagnostics -ComposeArgs @('compose')
`);
  if (result) assert.doesNotMatch(result.stdout + result.stderr, /fake-secret|fake-token|fake-bearer|fake-password/);
});

function withFakeDocker(t, check) {
  if (process.platform === "win32") { t.skip("Unix fake docker fixture; exercised by Ubuntu pwsh CI"); return; }
  const dir = mkdtempSync(join(tmpdir(), "ds-pwsh-"));
  const capture = join(dir, "received args.bin");
  try {
    writeFileSync(join(dir, "docker"), `#!/bin/sh
case "$1" in
  fail) exit 29 ;;
  hang) trap '' TERM; while :; do sleep 1; done ;;
  *) printf '%s\\0' "$@" > "$ARG_CAPTURE_FILE"; printf '<%s>' "$@" ;;
esac
`, { mode: 0o755 });
    check({ env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, ARG_CAPTURE_FILE: capture } }, capture);
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

test("PowerShell bounded process preserves exact native argv and reports exit zero", (t) => {
  withFakeDocker(t, (options, capture) => {
    const args = ["path with spaces", 'quote"inside', "trailing\\", "  padded  ", "", 'slash\\"quote'];
    const psArgs = args.map(value => `'${value.replaceAll("'", "''")}'`).join(", ");
    const result = runFunctions(t, `
$result = Invoke-DockerBounded -DockerArgs @(${psArgs}) -TimeoutSec 3
if ($null -eq $result.ExitCode) { throw 'Missing native exit code (null)' }
if ($result.ExitCode -ne 0) { throw "Expected exit zero, got $($result.ExitCode)" }
[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($result.Output))
`, options);
    if (!result) return;
    // Verify what the executable actually received, independently of stdout capture.
    assert.deepEqual(readFileSync(capture), Buffer.from(args.join("\0") + "\0"), "Native argv bytes changed");
    // Unix Start-Process redirects via StdOutputHandler -> StreamWriter.WriteLine,
    // which appends a newline even when the executable uses printf without one.
    // https://github.com/PowerShell/PowerShell/blob/v7.5.3/src/Microsoft.PowerShell.Commands.Management/commands/management/Process.cs#L2104-L2109
    const capturedOutput = Buffer.from(result.stdout.trim(), "base64").toString("utf8");
    assert.equal(capturedOutput, args.map(value => `<${value}>`).join("") + "\n", "Unexpected redirected stdout bytes");
  });
});

test("PowerShell bounded process preserves native exit 29", (t) => {
  withFakeDocker(t, (options) => {
    runFunctions(t, `
$result = Invoke-DockerBounded -DockerArgs @('fail') -TimeoutSec 3
if ($null -eq $result.ExitCode) { throw 'Missing failure exit code (null)' }
if ($result.ExitCode -ne 29) { throw "Lost exit code: $($result.ExitCode)" }
`, options);
  });
});

test("PowerShell bounded process kills a TERM-resistant child and reports 124", (t) => {
  withFakeDocker(t, (options) => {
    runFunctions(t, `
$clock = [Diagnostics.Stopwatch]::StartNew()
$result = Invoke-DockerBounded -DockerArgs @('hang') -TimeoutSec 1
if ($null -eq $result.ExitCode) { throw 'Missing timeout exit code (null)' }
if ($result.ExitCode -ne 124) { throw "Expected timeout 124, got $($result.ExitCode)" }
if ($clock.Elapsed.TotalSeconds -gt 4) { throw "Unbounded child: $($clock.Elapsed.TotalSeconds)s" }
`, options);
  });
});
