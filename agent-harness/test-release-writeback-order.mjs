import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// #899: the extracted release-writeback.sh captured the bundled catalog *after*
// `git checkout -f -B`, so the capture held main's previous catalog and the v0.6.12
// writeback commit updated only deploy/.env.example. A string-only assertion could not
// see that, so this test drives the real script in a throwaway git repository and
// inspects the commit it produces.

const script = fileURLToPath(new URL("./release-writeback.sh", import.meta.url));
const version = "0.6.12";
const previous = "0.6.11";

const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

function catalog(platformVersion) {
  const digest = `sha256:${"a".repeat(64)}`;
  const images = {};
  for (const service of ["scheduler", "web", "image-admission"]) {
    images[service] = {
      digest,
      platforms: ["linux/amd64", "linux/arm64"],
      child_digests: {"linux/amd64": digest, "linux/arm64": digest},
      registry_refs: {github: `ghcr.io/summersec/deepsonar-${service}@${digest}`},
    };
  }
  return {
    platform_version: platformVersion,
    platform: {version: platformVersion, commit_sha: "b".repeat(40), schema_version: 67, images},
    images: {},
  };
}

function envExample(platformVersion) {
  const digest = `sha256:${"a".repeat(64)}`;
  const line = (name) => `${name}=ghcr.io/summersec/deepsonar-${name.slice("DEEPSONAR_".length, -"_IMAGE".length).toLowerCase()}@${digest}`;
  return `# bundled catalog fixture\nDEEPSONAR_VERSION=${platformVersion}\n${line("DEEPSONAR_SCHEDULER_IMAGE")}\n${line("DEEPSONAR_WEB_IMAGE")}\n${line("DEEPSONAR_IMAGE_ADMISSION_IMAGE")}\n`;
}

// Stubs keep the test hermetic (no docker, no registry) while preserving the contract
// the real tools enforce: --check validates the catalog, --write-env rewrites the four
// deployment variables from *that* catalog, and release-writeback.mjs records the call.
function writeStubs(workspace) {
  mkdirSync(join(workspace, "agent-harness"), {recursive: true});
  writeFileSync(join(workspace, "agent-harness", "generate-runtime-image-registry.mjs"), `
import {readFileSync} from "node:fs";
const [, , mode, file] = process.argv;
if (mode !== "--check") throw new Error("unexpected mode");
const catalog = JSON.parse(readFileSync(file, "utf8"));
if (!catalog.platform_version || !catalog.platform?.version) throw new Error("catalog missing platform version");
if (catalog.platform.version !== catalog.platform_version) throw new Error("catalog platform version mismatch");
`);
  writeFileSync(join(workspace, "agent-harness", "check-platform-release.mjs"), `
import {readFileSync, writeFileSync} from "node:fs";
const [, , mode, catalogPath, envPath] = process.argv;
if (mode !== "--write-env") throw new Error("unexpected mode");
const catalog = JSON.parse(readFileSync(catalogPath, "utf8"));
const platform = catalog.platform;
if (platform.version !== catalog.platform_version) throw new Error("catalog platform version mismatch");
let env = readFileSync(envPath, "utf8");
const values = {DEEPSONAR_VERSION: platform.version};
for (const key of Object.keys(platform.images)) {
  values["DEEPSONAR_" + key.replaceAll("-", "_").toUpperCase() + "_IMAGE"] = Object.values(platform.images[key].registry_refs)[0];
}
for (const [name, value] of Object.entries(values)) {
  const pattern = new RegExp("^" + name + "=.*$", "m");
  if (!pattern.test(env)) throw new Error("missing " + name);
  env = env.replace(pattern, name + "=" + value);
}
writeFileSync(envPath, env);
`);
  writeFileSync(join(workspace, "agent-harness", "release-writeback.mjs"), `
import {writeFileSync} from "node:fs";
if (!process.env.WRITEBACK_BRANCH || !process.env.WRITEBACK_SHA) throw new Error("writeback branch/sha missing");
writeFileSync(process.env.WRITEBACK_MARKER, JSON.stringify({
  branch: process.env.WRITEBACK_BRANCH, sha: process.env.WRITEBACK_SHA}));
console.log("{}");
`);
}

function seedOrigin(root) {
  const origin = join(root, "origin.git");
  git(root, "init", "--bare", "--initial-branch=main", origin);
  const seed = join(root, "seed");
  git(root, "clone", "--quiet", origin, seed);
  git(seed, "checkout", "--quiet", "-B", "main");
  git(seed, "config", "user.name", "Fixture");
  git(seed, "config", "user.email", "fixture@example.invalid");
  mkdirSync(join(seed, "deploy"), {recursive: true});
  writeFileSync(join(seed, "deploy", "runtime-image-registry.json"), `${JSON.stringify(catalog(previous), null, 2)}\n`);
  writeFileSync(join(seed, "deploy", ".env.example"), envExample(previous));
  git(seed, "add", "--", "deploy");
  git(seed, "commit", "--quiet", "-m", `chore(release): v${previous} bundled catalog`);
  git(seed, "push", "--quiet", "origin", "main");
  return origin;
}

try {
  const root = mkdtempSync(join(tmpdir(), "release-writeback-order-"));
  const origin = seedOrigin(root);
  const workspace = join(root, "workspace");
  git(root, "clone", "--quiet", origin, workspace);
  writeStubs(workspace);

  const payload = join(workspace, "frozen-release");
  mkdirSync(join(payload, "deploy"), {recursive: true});
  writeFileSync(join(payload, "deploy", "runtime-image-registry.json"), `${JSON.stringify(catalog(version), null, 2)}\n`);

  const marker = join(root, "writeback.json");
  execFileSync("bash", [script, "frozen-release"], {
    cwd: workspace,
    stdio: ["ignore", "pipe", "pipe"],
    env: {...process.env, VERSION: version, DEFAULT_BRANCH: "main", GH_TOKEN: "fixture", WRITEBACK_MARKER: marker},
  });

  const changed = git(workspace, "show", "--name-only", "--pretty=format:", "HEAD").trim().split("\n").filter(Boolean).sort();
  assert.deepEqual(changed, ["deploy/.env.example", "deploy/runtime-image-registry.json"],
    "回写提交必须同时包含 bundled 清单与部署示例（v0.6.12 只提交了后者）");

  const committed = JSON.parse(git(workspace, "show", "HEAD:deploy/runtime-image-registry.json"));
  assert.equal(committed.platform_version, version, "提交里的 bundled 清单必须是本版本的 platform_version");
  assert.match(git(workspace, "show", "HEAD:deploy/.env.example"), new RegExp(`^DEEPSONAR_VERSION=${version.replaceAll(".", "\\.")}$`, "m"));

  const recorded = JSON.parse(readFileSync(marker, "utf8"));
  assert.equal(recorded.branch, `bot/sync-runtime-registry-v${version}`);
  assert.equal(recorded.sha, git(workspace, "rev-parse", "HEAD").trim());

  // A second run has nothing left to do and must exit without creating a commit.
  // Simulate the merged state: the same content is now on the default branch.
  git(workspace, "push", "--quiet", "origin", "HEAD:main");
  git(workspace, "fetch", "--quiet", "origin", "main");
  const head = git(workspace, "rev-parse", "HEAD").trim();
  const second = execFileSync("bash", [script, "frozen-release"], {
    cwd: workspace,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: {...process.env, VERSION: version, DEFAULT_BRANCH: "main", GH_TOKEN: "fixture", WRITEBACK_MARKER: marker},
  });
  assert.match(second, /跳过回写/, "内容已是本版本时必须早退");
  assert.equal(git(workspace, "rev-parse", "HEAD").trim(), head, "内容已是本版本时必须早退，不产生空提交");

  // The guard must fire instead of silently skipping when the captured catalog is stale
  // (the v0.6.12 failure mode) — simulated by a payload that lies about its version.
  const stalePayload = join(workspace, "stale-release");
  mkdirSync(join(stalePayload, "deploy"), {recursive: true});
  writeFileSync(join(stalePayload, "deploy", "runtime-image-registry.json"), `${JSON.stringify(catalog(previous), null, 2)}\n`);
  assert.throws(() => execFileSync("bash", [script, "stale-release"], {
    cwd: workspace,
    stdio: ["ignore", "pipe", "pipe"],
    env: {...process.env, VERSION: version, DEFAULT_BRANCH: "main", GH_TOKEN: "fixture", WRITEBACK_MARKER: marker},
  }), (error) => /platform_version=0\.6\.11, expected 0\.6\.12/.test(String(error.stderr)));

  rmSync(root, {recursive: true, force: true});
  console.log("release writeback: catalog and deployment example land in one commit, ordering regressions fail");
} catch (error) {
  console.error(error);
  process.exit(1);
}