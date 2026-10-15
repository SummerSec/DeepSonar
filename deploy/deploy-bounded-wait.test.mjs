import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, symlinkSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const deployDir = dirname(fileURLToPath(import.meta.url));
const root = join(deployDir, "..");
const boundedWait = join(deployDir, "bounded-wait.sh");
const platformImages = join(deployDir, "platform-images.sh");
const deploySh = join(deployDir, "deploy.sh");
const prodCompose = join(deployDir, "docker-compose.prod.yml");
const podmanCompat = join(deployDir, "docker-compose.podman-compat.yml");
const podmanCompatOs = join(deployDir, "docker-compose.podman-compat.opensandbox.yml");

test("bounded-wait.sh and deploy.sh are POSIX-sh parseable", () => {
  for (const file of [boundedWait, platformImages, deploySh]) {
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

function runShell(script, options = {}) {
  return spawnSync("sh", ["-c", `set -eu\n. "${boundedWait}"\n. "${platformImages}"\n${script}`], {
    encoding: "utf8", timeout: 15_000, ...options,
  });
}

test("compose failures retain their exit code; only 124 with healthy infra can recover", () => {
  const source = readFileSync(deploySh, "utf8");
  const branch = source.slice(source.indexOf("    up_rc=0"), source.indexOf("    attach_opensandbox_default_bridge", source.indexOf("    up_rc=0")));
  for (const mode of ["build", "pull"]) {
    for (const code of [0, 23, 124]) {
      for (const infra of [0, 1]) {
        const result = runShell(`
SOURCE=${mode}
pull_app_images() { :; }
ds_run_bounded() { return ${code}; }
ds_dump_deploy_diagnostics() { :; }
ds_infra_really_ready() { return ${infra}; }
ds_ensure_app_services_started() { echo recovered; }
${branch}
echo passed
`);
        const success = code === 0 || (code === 124 && infra === 0);
        assert.equal(result.status, success ? 0 : code, result.stderr);
        assert.equal(result.stdout.includes("recovered"), code === 124 && infra === 0);
        assert.equal(result.stdout.includes("passed"), success);
      }
    }
  }
});

test("entry requires parsed top-level boolean ok and ready, including runtime warmup", () => {
  const dir = mkdtempSync(join(tmpdir(), "ds-ready-"));
  try {
    writeFileSync(join(dir, "curl"), '#!/bin/sh\nprintf "%s" "$HEALTH_BODY"\n', { mode: 0o755 });
    writeFileSync(join(dir, "compose"), '#!/bin/sh\nshift 3\nexec "$@"\n', { mode: 0o755 });
    for (const body of [
      '{"ok":true,"ready":true}',
      '{"ok":true,"ready":false}',
      '{"ok":true}',
      '{"ok":true,"ready":"true"}',
      '{"ok":true,"nested":{"ready":true}}',
      'not json',
      '{"ok":false,"ready":true}',
    ]) {
      const result = runShell('ds_wait_entry_ready 8080 1 compose', {
        env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, HEALTH_BODY: body },
      });
      assert.equal(result.status === 0, body === '{"ok":true,"ready":true}', `${body}: ${result.stderr}`);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("readiness commands that hang or resist TERM cannot escape their deadline", () => {
  const started = Date.now();
  const result = runShell(`ds_wait_cmd 1 stuck -- sh -c 'trap "" TERM; while :; do sleep 1; done'`);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /readiness timeout/);
  assert.ok(Date.now() - started < 4000);
  const code = runShell(`ds_run_bounded 1 sh -c 'trap "" TERM; while :; do sleep 1; done'`);
  assert.equal(code.status, 124);
});

test("nested infra probes do not reset the shared timeout; Silo is probed inside the stack", () => {
  const source = readFileSync(boundedWait, "utf8");
  assert.doesNotMatch(source, /ds_probe_silo_http/);
  assert.match(source, /exec -T silo silo healthcheck ready/);
  const result = runShell(`
DEEPSONAR_READY_TIMEOUT_SEC=1
ds_wait_cmd() { sleep 2; return 0; }
ds_wait_infra_ready docker compose
`);
  assert.notEqual(result.status, 0);
});

test("controlled recovery will not start scheduler after silo-init failure", () => {
  const result = runShell(`
ds_run_bounded() {
  shift
  case "$*" in
    *config*) printf 'silo-init\\nscheduler\\nweb\\n' ;;
    *up*) echo "$*" ;;
  esac
}
ds_service_state() { echo 'exited 17'; }
ds_ensure_app_services_started docker compose
`);
  assert.notEqual(result.status, 0);
  assert.doesNotMatch(result.stdout, /up -d --no-deps scheduler/);
  assert.match(result.stderr, /silo-init failed/);
});

test("JSON-shaped diagnostics and postgres URLs redact secret values", () => {
  const result = runShell(`printf '%s\\n' '{"BLOB_S3_SECRET_ACCESS_KEY":"fake-private-value","token":"fake-token-value"} postgresql://u:fake-password@h/db' | ds_redact_secrets`);
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stdout, /fake-private-value|fake-token-value|fake-password/);
});

test("bounded runner preserves ordinary exit 137 instead of treating it as a recoverable timeout", () => {
  const result = runShell("ds_run_bounded 3 sh -c 'exit 137'");
  assert.equal(result.status, 137, result.stderr);
});

test("portable watchdog without setsid bounds TERM-resistant descendants", () => {
  const dir = mkdtempSync(join(tmpdir(), "ds-portable-"));
  try {
    for (const cmd of ["sh", "mktemp", "sleep", "ps", "awk", "rm"]) {
      const resolved = spawnSync("sh", ["-c", `command -v ${cmd}`], { encoding: "utf8" }).stdout.trim();
      symlinkSync(resolved, join(dir, cmd));
    }
    const start = Date.now();
    const result = runShell(`ds_run_bounded 1 sh -c 'trap "" TERM; sleep 10'`, { env: { ...process.env, PATH: dir } });
    assert.equal(result.status, 124, result.stderr);
    assert.ok(Date.now() - start < 4000, "watchdog must kill descendants holding output pipes open");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("all diagnostic engine queries carry a finite budget", () => {
  const result = runShell(`
docker() { echo 'unexpected unbounded docker' >&2; return 91; }
podman() { echo 'unexpected unbounded podman' >&2; return 91; }
ds_run_bounded() { [ "$1" -eq 3 ] || return 92; return 124; }
ds_dump_deploy_diagnostics docker compose
`);
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stderr, /unexpected unbounded/);
});

test("worker-join preserves failures/timeouts for build and pull and never reports success", () => {
  const source = readFileSync(deploySh, "utf8");
  const start = source.indexOf('    if [ "$MODE" = "worker-join" ]; then', source.indexOf('  up)'));
  const branch = source.slice(start, source.indexOf('    if [ "${break_worker:-}"', start));
  for (const mode of ["build", "pull"]) {
    for (const code of [0, 31, 124]) {
      const result = runShell(`
MODE=worker-join
SOURCE=${mode}
CONTROL_PLANE=http://127.0.0.1:3100
ds_run_bounded() { return ${code}; }
ds_dump_deploy_diagnostics() { :; }
attach_opensandbox_default_bridge() { :; }
${branch}
`);
      assert.equal(result.status, code, result.stderr);
      assert.equal(result.stdout.includes("worker-join 已启动"), code === 0);
    }
  }
});
