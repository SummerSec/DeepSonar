import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const deployDir = dirname(fileURLToPath(import.meta.url));
const root = join(deployDir, "..");
const boundedWait = join(deployDir, "bounded-wait.sh");
const deploySh = join(deployDir, "deploy.sh");
const prodCompose = join(deployDir, "docker-compose.prod.yml");
const podmanCompat = join(deployDir, "docker-compose.podman-compat.yml");
const podmanCompatOs = join(deployDir, "docker-compose.podman-compat.opensandbox.yml");

test("bounded-wait.sh and deploy.sh are POSIX-sh parseable", () => {
  for (const file of [boundedWait, deploySh]) {
    const r = spawnSync("sh", ["-n", file], { encoding: "utf8" });
    assert.equal(r.status, 0, `${file}: ${r.stderr}`);
  }
});

test("deploy.sh sources bounded-wait and gates success on entry readiness (#726)", () => {
  const sh = readFileSync(deploySh, "utf8");
  assert.match(sh, /bounded-wait\.sh/);
  assert.match(sh, /ds_run_bounded/);
  assert.match(sh, /ds_wait_entry_ready/);
  assert.match(sh, /ds_wait_infra_ready/);
  assert.match(sh, /ds_dump_deploy_diagnostics/);
  assert.match(sh, /ds_ensure_app_services_started/);
  assert.match(sh, /docker-compose\.podman-compat\.yml/);
  assert.match(sh, /DEEPSONAR_COMPOSE_UP_TIMEOUT_SEC/);
  assert.match(sh, /DEEPSONAR_READY_TIMEOUT_SEC/);
  assert.match(sh, /DEEPSONAR_COMPOSE_DEPENDS_ON/);
  // Must not report success after unconditional start on timeout.
  assert.match(sh, /refusing success via service_started alone/);
  assert.doesNotMatch(sh, /up -d[\s\S]{0,80}echo "\[deploy\] DeepSonar 已启动"/);
});

test("podman-compat overlays weaken only to service_started and keep silo-init completion (#726)", () => {
  const compat = readFileSync(podmanCompat, "utf8");
  const os = readFileSync(podmanCompatOs, "utf8");
  assert.match(compat, /condition: service_started/);
  assert.match(compat, /silo-init:[\s\S]*condition: service_completed_successfully/);
  assert.doesNotMatch(compat, /condition: service_healthy/);
  assert.match(os, /opensandbox:[\s\S]*condition: service_started/);
  // Default prod compose still uses service_healthy (do not globally weaken).
  const prod = readFileSync(prodCompose, "utf8");
  assert.match(prod, /silo:[\s\S]*condition: service_healthy/);
  assert.match(prod, /postgres:[\s\S]*condition: service_healthy/);
});

test("silo-init command retries and stays a one-element sh -c script (#101 / #726)", () => {
  const prod = readFileSync(prodCompose, "utf8");
  assert.match(prod, /entrypoint: \["\/bin\/sh", "-c"\]/);
  assert.match(prod, /while \[ "\$\$i" -lt 60 \]/);
  assert.match(prod, /silo-init: silo not ready after 120s/);
  // Still a YAML list with a single scalar block (not a word-split string).
  assert.match(prod, /command:\n\s+- \|/);
});

test("ds_redact_secrets strips password/token-like values", () => {
  const script = `
set -eu
. "${boundedWait}"
printf '%s\\n' 'PASSWORD=super-secret TOKEN=abc Authorization: Bearer xyz postgres://u:p@h/db' | ds_redact_secrets
`;
  const r = spawnSync("sh", ["-c", script], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /PASSWORD=\*\*\*/);
  assert.match(r.stdout, /TOKEN=\*\*\*/);
  assert.match(r.stdout, /Bearer \*\*\*/);
  assert.match(r.stdout, /postgres:\/\/u:\*\*\*@h\/db/);
  assert.doesNotMatch(r.stdout, /super-secret/);
  assert.doesNotMatch(r.stdout, /\bxyz\b/);
});

test("ds_should_use_started_depends respects auto/podman/healthy/started", () => {
  const cases = [
    { env: { DEEPSONAR_COMPOSE_DEPENDS_ON: "started" }, expect: 0 },
    { env: { DEEPSONAR_COMPOSE_DEPENDS_ON: "healthy" }, expect: 1 },
    { env: { DEEPSONAR_COMPOSE_DEPENDS_ON: "auto", DEEPSONAR_CONTAINER_RUNTIME: "podman" }, expect: 0 },
    { env: { DEEPSONAR_COMPOSE_DEPENDS_ON: "auto", DEEPSONAR_CONTAINER_RUNTIME: "docker" }, expect: 1 },
  ];
  for (const c of cases) {
    const script = `set -eu; . "${boundedWait}"; ds_should_use_started_depends`;
    const r = spawnSync("sh", ["-c", script], {
      encoding: "utf8",
      env: { ...process.env, ...c.env },
    });
    assert.equal(r.status, c.expect, `env=${JSON.stringify(c.env)} stderr=${r.stderr}`);
  }
});

test("ds_run_bounded returns 124 when the child exceeds the wall clock", () => {
  const script = `
set -eu
. "${boundedWait}"
ds_run_bounded 1 sh -c 'sleep 5'
`;
  const r = spawnSync("sh", ["-c", script], { encoding: "utf8" });
  assert.equal(r.status, 124, `expected timeout 124, got ${r.status}: ${r.stderr}`);
});

test("ds_wait_http fails within the bound when the URL never answers", () => {
  const script = `
set -eu
. "${boundedWait}"
DEEPSONAR_PROBE_INTERVAL_SEC=1
ds_wait_http "http://127.0.0.1:1/nope" 2 "probe-test"
`;
  const started = Date.now();
  const r = spawnSync("sh", ["-c", script], { encoding: "utf8" });
  const elapsedMs = Date.now() - started;
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /readiness timeout/);
  assert.ok(elapsedMs < 15_000, `wait should be bounded, took ${elapsedMs}ms`);
});

test("controlled path refuses success when infra probes fail (unit simulation)", () => {
  const dir = mkdtempSync(join(tmpdir(), "ds726-"));
  try {
    const bin = join(dir, "bin");
    mkdirSync(bin);
    // Fake docker that always fails infra probes / reports created web.
    writeFileSync(
      join(bin, "docker"),
      `#!/bin/sh
echo "fake-docker $*" >&2
exit 1
`,
      { mode: 0o755 },
    );
    const script = `
set -eu
PATH="${bin}:$PATH"
. "${boundedWait}"
# Infra not ready → must fail closed.
if ds_infra_really_ready docker compose; then
  echo "unexpected ready" >&2
  exit 2
fi
echo "infra_not_ready_ok"
`;
    const r = spawnSync("sh", ["-c", script], { encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /infra_not_ready_ok/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("deploy.ps1 mirrors bounded compose up and podman-compat attach (#726)", () => {
  const bytes = readFileSync(join(deployDir, "deploy.ps1"));
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(3));
  assert.match(text, /Invoke-DockerComposeUpBounded/);
  assert.match(text, /Write-DeployDiagnostics/);
  assert.match(text, /Wait-EntryReady/);
  assert.match(text, /Should-UseStartedDepends/);
  assert.match(text, /podman-compat/);
  assert.match(text, /DEEPSONAR_COMPOSE_UP_TIMEOUT_SEC/);
  assert.match(text, /DEEPSONAR_READY_TIMEOUT_SEC/);
});

test("ONE_CLICK_DEPLOYMENT documents Podman healthcheck hang and tuning knobs", () => {
  const doc = readFileSync(join(root, "docs/ONE_CLICK_DEPLOYMENT.md"), "utf8");
  assert.match(doc, /#726|service_healthy|Podman/);
  assert.match(doc, /DEEPSONAR_COMPOSE_UP_TIMEOUT_SEC|DEEPSONAR_COMPOSE_DEPENDS_ON|有界/);
});
