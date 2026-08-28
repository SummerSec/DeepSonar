import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
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
  assert.match(text, /up -d --pull missing/);
  assert.match(text, /up -d --build/);
  assert.match(text, /if \(\$NoBuild\) \{ \$Source = "pull" \}/);
  assert.match(text, /\$env:SANDBOX_PROVIDER -eq "opensandbox"/);
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
