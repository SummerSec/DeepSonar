// #740 P1 slice 3: platform images are deployed by immutable digest only.
// Runs the real deploy.sh / deploy.ps1 against a temp copy of deploy/ with a
// fake `docker`, so .env handling and fail-closed messages are exercised end to end.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const deployDir = dirname(fileURLToPath(import.meta.url));
const envExample = readFileSync(join(deployDir, ".env.example"), "utf8");
const prodCompose = readFileSync(join(deployDir, "docker-compose.prod.yml"), "utf8");
const hostCompose = readFileSync(join(deployDir, "docker-compose.opensandbox.host.yml"), "utf8");
const deploySh = readFileSync(join(deployDir, "deploy.sh"), "utf8");
const deployPs1 = readFileSync(join(deployDir, "deploy.ps1"), "utf8");

const REPOS = {
  DEEPSONAR_SCHEDULER_IMAGE: "deepsonar-scheduler",
  DEEPSONAR_WEB_IMAGE: "deepsonar-web",
  DEEPSONAR_IMAGE_ADMISSION_IMAGE: "deepsonar-image-admission",
};
const DIGEST_RE = (repo) => new RegExp(`^[^@\\s]+/${repo}@sha256:[0-9a-f]{64}$`);

function exampleValue(key) {
  const line = envExample.split(/\r?\n/).find((l) => l.startsWith(`${key}=`));
  return line ? line.slice(key.length + 1).trim() : undefined;
}

const VERSION = exampleValue("DEEPSONAR_VERSION");
const REFS = Object.fromEntries(Object.keys(REPOS).map((key) => [key, exampleValue(key)]));

test("deploy/.env.example declares DEEPSONAR_VERSION and three digest refs, no DEEPSONAR_IMAGE_TAG", () => {
  assert.match(VERSION ?? "", /^[0-9]+\.[0-9]+\.[0-9]+$/);
  for (const [key, repo] of Object.entries(REPOS)) {
    assert.match(REFS[key] ?? "", DIGEST_RE(repo), `${key} must be an immutable ${repo} digest ref`);
    assert.equal(envExample.split(/\r?\n/).filter((l) => l.startsWith(`${key}=`)).length, 1, `${key} must appear once`);
  }
  assert.doesNotMatch(envExample, /^\s*DEEPSONAR_IMAGE_TAG\s*=/m);
});

test("prod and host compose reference platform images only through the digest variables", () => {
  for (const [name, text] of [["prod", prodCompose], ["host", hostCompose]]) {
    assert.doesNotMatch(text, /\$\{DEEPSONAR_IMAGE_TAG|^\s+DEEPSONAR_IMAGE_TAG:/m, `${name} compose still uses DEEPSONAR_IMAGE_TAG`);
    assert.match(text, /image: \$\{DEEPSONAR_SCHEDULER_IMAGE:\?/, `${name} scheduler image must be required`);
    assert.match(text, /image: \$\{DEEPSONAR_WEB_IMAGE:\?/, `${name} web image must be required`);
    assert.match(text, /DEEPSONAR_VERSION: \$\{DEEPSONAR_VERSION:\?/, `${name} DEEPSONAR_VERSION must be required`);
    assert.doesNotMatch(text, /deepsonar-(?:scheduler|web|image-admission):\$\{/, `${name} compose builds a tag ref`);
  }
  assert.match(prodCompose, /image: \$\{DEEPSONAR_IMAGE_ADMISSION_IMAGE:\?/);
});

test("deploy scripts no longer resolve or write DEEPSONAR_IMAGE_TAG and tag local builds explicitly", () => {
  assert.doesNotMatch(deploySh, /ensure_env_kv "DEEPSONAR_IMAGE_TAG"|\$\{IMAGE_TAG\}/);
  assert.doesNotMatch(deployPs1, /Ensure-EnvKv "DEEPSONAR_IMAGE_TAG"|Get-DefaultImageTag/);
  assert.match(deploySh, /ds_export_local_build_platform_images\n[\s\S]{0,200}up -d --build/);
  assert.match(deployPs1, /Set-LocalBuildPlatformImages\n[\s\S]{0,200}"-d", "--build"/);
});

const FAKE_DOCKER = `#!/bin/sh
printf '%s\\n' "$*" >> "$DOCKER_LOG"
exit 0
`;

function makeDeployCopy() {
  const root = mkdtempSync(join(tmpdir(), "ds-platform-images-"));
  const dir = join(root, "deploy");
  const bin = join(root, "bin");
  mkdirSync(dir);
  mkdirSync(bin);
  for (const file of ["deploy.sh", "deploy.ps1", "bounded-wait.sh", "platform-images.sh", ".env.example"]) {
    copyFileSync(join(deployDir, file), join(dir, file));
  }
  writeFileSync(join(bin, "docker"), FAKE_DOCKER, { mode: 0o755 });
  const log = join(root, "docker.log");
  return { root, dir, bin, log, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function baseEnv(overrides = {}) {
  const lines = [
    "POSTGRES_PASSWORD=test-postgres",
    "DEEPSONAR_ADMIN_TOKEN=test-admin",
    "DEEPSONAR_WORKER_BOOTSTRAP_TOKEN=test-bootstrap",
    "DEEPSONAR_IMAGE_REGISTRY=registry.example/summersec",
    `DEEPSONAR_VERSION=${VERSION}`,
    ...Object.entries(REFS).map(([k, v]) => `${k}=${v}`),
  ];
  const map = new Map(lines.map((l) => [l.slice(0, l.indexOf("=")), l]));
  for (const [key, value] of Object.entries(overrides)) {
    if (value === null) map.delete(key);
    else map.set(key, `${key}=${value}`);
  }
  return [...map.values(), ""].join("\n");
}

function firstPwsh() {
  for (const cmd of ["pwsh", "powershell"]) {
    const probe = spawnSync(cmd, ["-NoProfile", "-Command", "exit 0"], { encoding: "utf8" });
    if (!probe.error && probe.status === 0) return cmd;
  }
  return null;
}

const RUNNERS = {
  sh: { available: () => true, argv: (dir, args) => ["sh", [join(dir, "deploy.sh"), ...args]] },
  ps1: {
    available: () => firstPwsh() !== null,
    argv: (dir, args) => [firstPwsh(), ["-NoProfile", "-File", join(dir, "deploy.ps1"), ...args]],
  },
};

function run(kind, copy, args, extraEnv = {}) {
  const [cmd, argv] = RUNNERS[kind].argv(copy.dir, args);
  const env = { ...process.env, PATH: `${copy.bin}:${process.env.PATH}`, DOCKER_LOG: copy.log, DEEPSONAR_CONTAINER_RUNTIME: "docker", ...extraEnv };
  for (const key of ["DEEPSONAR_IMAGE_TAG", "DEEPSONAR_VERSION", ...Object.keys(REPOS)]) {
    if (!(key in extraEnv)) delete env[key];
  }
  const result = spawnSync(cmd, argv, { encoding: "utf8", env, timeout: 60_000 });
  const pulls = existsSync(copy.log)
    ? readFileSync(copy.log, "utf8").split("\n").filter((l) => l.startsWith("pull ")).map((l) => l.slice(5))
    : [];
  return { status: result.status, out: `${result.stdout}${result.stderr}`, pulls };
}

function scenario(kind, title, fn) {
  test(`${kind}: ${title}`, (t) => {
    if (process.platform === "win32") { t.skip("Unix fake docker fixture"); return; }
    if (!RUNNERS[kind].available()) {
      assert.ok(!process.env.CI, "CI must provide pwsh/powershell for deployment behavior tests");
      t.skip("pwsh/powershell is not installed on this runner");
      return;
    }
    const copy = makeDeployCopy();
    try { fn(copy); } finally { copy.cleanup(); }
  });
}

for (const kind of Object.keys(RUNNERS)) {
  scenario(kind, "fresh install copies digest refs from .env.example and passes check", (copy) => {
    const r = run(kind, copy, ["check", "fake"]);
    assert.equal(r.status, 0, r.out);
    const env = readFileSync(join(copy.dir, ".env"), "utf8");
    assert.doesNotMatch(env, /^DEEPSONAR_IMAGE_TAG=/m);
    for (const ref of Object.values(REFS)) assert.ok(env.includes(ref), `missing ${ref}`);
    assert.ok(r.out.includes(REFS.DEEPSONAR_SCHEDULER_IMAGE), r.out);
  });

  scenario(kind, "pull fetches exactly the three digest refs, never a platform tag", (copy) => {
    writeFileSync(join(copy.dir, ".env"), baseEnv());
    const r = run(kind, copy, ["pull", "fake"]);
    assert.equal(r.status, 0, r.out);
    const platformPulls = r.pulls.filter((ref) => /deepsonar-(?:scheduler|web|image-admission)\b/.test(ref));
    assert.deepEqual(platformPulls, Object.values(REFS));
    assert.ok(r.pulls.includes(`registry.example/summersec/deepsonar-silo:${VERSION}`), r.pulls.join("\n"));
  });

  scenario(kind, "legacy DEEPSONAR_IMAGE_TAG in deploy/.env fails closed with a regenerate hint", (copy) => {
    writeFileSync(join(copy.dir, ".env"), baseEnv({ DEEPSONAR_IMAGE_TAG: VERSION }));
    const r = run(kind, copy, ["check", "fake"]);
    assert.notEqual(r.status, 0, r.out);
    assert.match(r.out, /DEEPSONAR_IMAGE_TAG/);
    assert.ok(r.out.includes(`DEEPSONAR_SCHEDULER_IMAGE=${REFS.DEEPSONAR_SCHEDULER_IMAGE}`), r.out);
    assert.match(r.out, /upgrade/);
    assert.equal(r.pulls.length, 0);
  });

  for (const declaration of ["DEEPSONAR_IMAGE_TAG: mutable", "export DEEPSONAR_IMAGE_TAG = mutable", "DEEPSONAR_IMAGE_TAG"]) {
    scenario(kind, `rejects obsolete dotenv declaration ${declaration}`, (copy) => {
      writeFileSync(join(copy.dir, ".env"), baseEnv() + "\n" + declaration + "\n");
      const r = run(kind, copy, ["check", "fake"]);
      assert.notEqual(r.status, 0, r.out);
      assert.match(r.out, /DEEPSONAR_IMAGE_TAG/);
      assert.equal(r.pulls.length, 0);
    });
  }

  scenario(kind, "legacy DEEPSONAR_IMAGE_TAG in the process environment fails closed", (copy) => {
    writeFileSync(join(copy.dir, ".env"), baseEnv());
    const r = run(kind, copy, ["check", "fake"], { DEEPSONAR_IMAGE_TAG: VERSION });
    assert.notEqual(r.status, 0, r.out);
    assert.match(r.out, /DEEPSONAR_IMAGE_TAG/);
  });

  for (const [title, overrides] of [
    ["a tag ref", { DEEPSONAR_SCHEDULER_IMAGE: `registry.example/summersec/deepsonar-scheduler:${VERSION}` }],
    ["a digest for the wrong repository", { DEEPSONAR_WEB_IMAGE: REFS.DEEPSONAR_SCHEDULER_IMAGE }],
    ["an uppercase / short digest", { DEEPSONAR_IMAGE_ADMISSION_IMAGE: "registry.example/summersec/deepsonar-image-admission@sha256:ABC" }],
    ["a missing image ref", { DEEPSONAR_WEB_IMAGE: null }],
    ["a missing DEEPSONAR_VERSION", { DEEPSONAR_VERSION: null }],
    ["a v-prefixed DEEPSONAR_VERSION", { DEEPSONAR_VERSION: `v${VERSION}` }],
  ]) {
    scenario(kind, `rejects ${title}`, (copy) => {
      writeFileSync(join(copy.dir, ".env"), baseEnv(overrides));
      const r = run(kind, copy, ["pull", "fake"]);
      assert.notEqual(r.status, 0, r.out);
      assert.equal(r.pulls.length, 0, `pulled despite invalid contract: ${r.pulls.join(", ")}`);
      const key = Object.keys(overrides)[0];
      assert.ok(r.out.includes(key), r.out);
    });
  }

  for (const key of ["DEEPSONAR_VERSION", ...Object.keys(REPOS)]) {
    for (const assignment of [`${key}=mutable`, ` export ${key} = mutable`, `${key}: mutable`, key]) {
      scenario(kind, `rejects ambiguous duplicate ${JSON.stringify(assignment)} before pulls`, (copy) => {
        writeFileSync(join(copy.dir, ".env"), baseEnv() + assignment + "\n");
        const r = run(kind, copy, ["pull", "fake"]);
        assert.notEqual(r.status, 0, r.out);
        assert.match(r.out, /canonical KEY=value/);
        assert.equal(r.pulls.length, 0);
      });
    }
  }

  scenario(kind, "rejects interpolated registry names before Compose can change the validated ref", (copy) => {
    writeFileSync(join(copy.dir, ".env"), baseEnv({ DEEPSONAR_WEB_IMAGE: `$REGISTRY/deepsonar-web@sha256:${"a".repeat(64)}` }));
    const r = run(kind, copy, ["pull", "fake"]);
    assert.notEqual(r.status, 0, r.out);
    assert.equal(r.pulls.length, 0);
  });

  scenario(kind, "process env wins over deploy/.env and is validated too", (copy) => {
    writeFileSync(join(copy.dir, ".env"), baseEnv());
    const r = run(kind, copy, ["pull", "fake"], { DEEPSONAR_SCHEDULER_IMAGE: "registry.example/summersec/deepsonar-scheduler:latest" });
    assert.notEqual(r.status, 0, r.out);
    assert.equal(r.pulls.length, 0);
  });

  scenario(kind, "worker-join does not require platform refs but still rejects DEEPSONAR_IMAGE_TAG", (copy) => {
    const cp = kind === "sh" ? ["--control-plane", "https://scheduler.example:3100"] : ["-ControlPlane", "https://scheduler.example:3100"];
    writeFileSync(join(copy.dir, ".env"), baseEnv({ DEEPSONAR_VERSION: null, DEEPSONAR_SCHEDULER_IMAGE: null, DEEPSONAR_WEB_IMAGE: null, DEEPSONAR_IMAGE_ADMISSION_IMAGE: null }));
    const ok = run(kind, copy, ["check", "worker-join", ...cp]);
    assert.equal(ok.status, 0, ok.out);
    writeFileSync(join(copy.dir, ".env"), baseEnv({ DEEPSONAR_IMAGE_TAG: VERSION }));
    const legacy = run(kind, copy, ["check", "worker-join", ...cp]);
    assert.notEqual(legacy.status, 0, legacy.out);
    assert.match(legacy.out, /DEEPSONAR_IMAGE_TAG/);
  });
}

test("ds_export_local_build_platform_images tags local builds with plain names", () => {
  const script = `set -eu\n. "${join(deployDir, "platform-images.sh")}"\nds_export_local_build_platform_images\nsh -c 'printf "%s|%s|%s" "$DEEPSONAR_SCHEDULER_IMAGE" "$DEEPSONAR_WEB_IMAGE" "$DEEPSONAR_IMAGE_ADMISSION_IMAGE"'`;
  const r = spawnSync("sh", ["-c", script], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, "deepsonar-scheduler:local-build|deepsonar-web:local-build|deepsonar-image-admission:local-build");
});
