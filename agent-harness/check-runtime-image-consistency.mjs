import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync as fsStatSync } from "node:fs";
import { COMMON_FINGERPRINT_PATHS, FINGERPRINT_SCHEMA_VERSION, PRESETS } from "./image-build-fingerprint.mjs";

// Git preserves the executable bit in the repository, but Windows reports a
// checkout's mode as 0644 regardless of that index bit. Keep the Linux gate
// strict while comparing against the git baseline on Windows.
const statSync = process.platform === "win32" ? (() => ({ mode: 0o755 })) : fsStatSync;

const config = JSON.parse(readFileSync(new URL("./runtime-images.json", import.meta.url), "utf8"));
const dockerfile = readFileSync(new URL("../deploy/Dockerfile.agent", import.meta.url), "utf8");
const localDefinition = readFileSync(new URL("./image.mjs", import.meta.url), "utf8");
const kaliConfig = JSON.parse(readFileSync(new URL("./kali-minimal-runtime.json", import.meta.url), "utf8"));
const kaliDockerfile = readFileSync(new URL("../deploy/Dockerfile.agent-kali-minimal", import.meta.url), "utf8");
const dshForbidden = [
  "dsh-cc-tui",
  '"@deepseek-ai/dsh"',
  "@deepseek-ai/dsh-app-tui",
  "@deepseek-ai/dsh-app-web",
  "@deepseek-ai/dsh-client-ui-",
  "@deepseek-ai/dsh-client-web",
  "@deepseek-ai/dsh-web-",
  "@deepseek-ai/dsh-tool-ask-user",
];
for (const forbidden of dshForbidden) {
  if (JSON.stringify(config).includes(forbidden) || JSON.stringify(kaliConfig).includes(forbidden) || dockerfile.includes(forbidden) || kaliDockerfile.includes(forbidden)) {
    throw new Error(`DSH machine runtime must not install UI package ${forbidden}`);
  }
}
for (const packageName of [
  "@deepseek-ai/dsh-sdk-jsonrpc-demo",
  "@deepseek-ai/dsh-sdk-jsonrpc-server",
  "@deepseek-ai/dsh-sdk-protocol",
  "@deepseek-ai/dsh-agent-spine-demo",
  "@deepseek-ai/dsh-skill",
  "@deepseek-ai/dsh-skill-filesystem",
  "@deepseek-ai/dsh-tool-skill",
  "@deepseek-ai/dsh-llm-pi-ai",
  "@deepseek-ai/dsh-sandbox-local",
  "@deepseek-ai/dsh-sandbox-policy",
  "@deepseek-ai/dsh-subprocess-local",
  "@deepseek-ai/dsh-bash-local",
  "@deepseek-ai/dsh-fs-local",
  "@deepseek-ai/dsh-tool-bash",
  "@deepseek-ai/dsh-tool-str-replace-editor",
  "@deepseek-ai/dsh-session-persistence-jsonl",
  "@deepseek-ai/dsh-session-checkpoint-policy",
  "@deepseek-ai/dsh-token-meter",
  "@deepseek-ai/dsh-code-runtime",
  "@deepseek-ai/dsh-code-runtime-worker-thread",
  "@deepseek-ai/dsh-compaction-basic",
]) {
  if (config.npm[packageName]?.version !== "0.1.0-rc.7" || kaliConfig.npm[packageName]?.version !== "0.1.0-rc.7") {
    throw new Error(`${packageName} must be pinned to 0.1.0-rc.7 in base and Kali manifests`);
  }
  if (!config.npm[packageName]?.integrity || !kaliConfig.npm[packageName]?.integrity) {
    throw new Error(`${packageName} must carry npm integrity in base and Kali manifests`);
  }
}
for (const [packageName, integrityArg] of [
  ["@deepseek-ai/dsh-subprocess-local", "DSH_SUBPROCESS_LOCAL_INTEGRITY"],
  ["@deepseek-ai/dsh-code-runtime", "DSH_CODE_RUNTIME_INTEGRITY"],
  ["@deepseek-ai/dsh-code-runtime-worker-thread", "DSH_CODE_RUNTIME_WORKER_INTEGRITY"],
]) {
  const baseEntry = config.npm[packageName];
  const kaliEntry = kaliConfig.npm[packageName];
  if (baseEntry?.license !== "MIT" || kaliEntry?.license !== "MIT") {
    throw new Error(`${packageName} must declare the published MIT license`);
  }
  if (!dockerfile.includes(`ARG ${integrityArg}=${baseEntry.integrity}`) || !kaliDockerfile.includes(`ARG ${integrityArg}=${kaliEntry.integrity}`)) {
    throw new Error(`${packageName} Docker integrity args must match the governed manifests`);
  }
}
const openHarmonyDockerfile = readFileSync(new URL("../deploy/Dockerfile.agent-openharmony", import.meta.url), "utf8");
const openHarmonyAuditDockerfile = readFileSync(new URL("../deploy/Dockerfile.agent-openharmony-audit", import.meta.url), "utf8");
const openHarmonyFuzzDockerfile = readFileSync(new URL("../deploy/Dockerfile.agent-openharmony-fuzz", import.meta.url), "utf8");
const chromeAuditConfig = JSON.parse(readFileSync(new URL("./chrome-audit-runtime.json", import.meta.url), "utf8"));
const chromeTestConfig = JSON.parse(readFileSync(new URL("./chrome-test-runtime.json", import.meta.url), "utf8"));
const chromeFuzzConfig = JSON.parse(readFileSync(new URL("./chrome-fuzz-runtime.json", import.meta.url), "utf8"));
const chromeSources = JSON.parse(readFileSync(new URL("../deploy/chrome-runtime-sources.json", import.meta.url), "utf8"));
const chromeAuditDockerfile = readFileSync(new URL("../deploy/Dockerfile.agent-chrome-audit", import.meta.url), "utf8");
const chromeTestDockerfile = readFileSync(new URL("../deploy/Dockerfile.agent-chrome-test", import.meta.url), "utf8");
const chromeFuzzDockerfile = readFileSync(new URL("../deploy/Dockerfile.agent-chrome-fuzz", import.meta.url), "utf8");
const chromeAuditEnv = readFileSync(new URL("../deploy/chrome-audit-env.sh", import.meta.url), "utf8");
const chromeHeadless = readFileSync(new URL("../deploy/chrome-headless.sh", import.meta.url), "utf8");
const chromeTestEnv = readFileSync(new URL("../deploy/chrome-test-env.sh", import.meta.url), "utf8");
const chromeTestSmoke = readFileSync(new URL("./chrome-test-smoke.mjs", import.meta.url), "utf8");
const chromeFuzzEnv = readFileSync(new URL("../deploy/chrome-fuzz-env.sh", import.meta.url), "utf8");
const chromeFuzzSmoke = readFileSync(new URL("../deploy/chrome-fuzz-smoke.sh", import.meta.url), "utf8");
const chromeFuzzPreflight = readFileSync(new URL("../deploy/chrome-fuzz-toolchain-preflight.sh", import.meta.url), "utf8");
const openHarmonyRepo = readFileSync(new URL("../deploy/vendor/gitcode-repo-py3", import.meta.url));
const normalizedOpenHarmonyRepo = Buffer.from(openHarmonyRepo.toString("utf8").replace(/\r\n/g, "\n"));
const openHarmonyEnv = readFileSync(new URL("../deploy/openharmony-env.sh", import.meta.url), "utf8");
const openHarmonyHdc = readFileSync(new URL("../deploy/openharmony-hdc.sh", import.meta.url), "utf8");
const openHarmonyHdcBin = readFileSync(new URL("../deploy/openharmony-hdc-bin.sh", import.meta.url), "utf8");
const openHarmonyTestConfig = JSON.parse(readFileSync(new URL("./openharmony-test-runtime.json", import.meta.url), "utf8"));
const openHarmonyHdcSmoke = readFileSync(new URL("./test-openharmony-hdc.mjs", import.meta.url), "utf8");
const openHarmonyInit = readFileSync(new URL("../deploy/openharmony-init.sh", import.meta.url), "utf8");
const openHarmonyBuild = readFileSync(new URL("../deploy/openharmony-build.sh", import.meta.url), "utf8");
const openHarmonyAuditEnv = readFileSync(new URL("../deploy/openharmony-audit-env.sh", import.meta.url), "utf8");
const openHarmonyAuditScan = readFileSync(new URL("../deploy/openharmony-audit-scan.sh", import.meta.url), "utf8");
const openHarmonyFuzzEnv = readFileSync(new URL("../deploy/openharmony-fuzz-env.sh", import.meta.url), "utf8");
const openHarmonyFuzzBuild = readFileSync(new URL("../deploy/openharmony-fuzz-build.sh", import.meta.url), "utf8");
const openHarmonyRegistry = JSON.parse(readFileSync(new URL("../deploy/runtime-image-registry.json", import.meta.url), "utf8"));
const prepareScript = readFileSync(new URL("../deploy/prepare-runtime-images.sh", import.meta.url), "utf8");
const releaseWorkflow = readFileSync(new URL("../.github/workflows/release.yml", import.meta.url), "utf8");
const descriptorScript = readFileSync(new URL("./record-runtime-image-digest.mjs", import.meta.url), "utf8");
const recordContractScript = readFileSync(new URL("./runtime-image-record.mjs", import.meta.url), "utf8");
const registryScript = readFileSync(new URL("./generate-runtime-image-registry.mjs", import.meta.url), "utf8");
const schedulerRegistryContract = readFileSync(new URL("../apps/scheduler/src/runtime-image-registry-contract.ts", import.meta.url), "utf8");
const schedulerRuntimeImages = readFileSync(new URL("../apps/scheduler/src/runtime-images.ts", import.meta.url), "utf8");
const schedulerRuntimeImageRoutes = readFileSync(
  new URL("../apps/scheduler/src/domains/runtime-image/routes.ts", import.meta.url),
  "utf8",
);
const runtimeSmoke = readFileSync(new URL("./test-runtime-image.mjs", import.meta.url), "utf8");
const chromeRuntimeSmoke = readFileSync(new URL("./test-chrome-runtime.mjs", import.meta.url), "utf8");
const mobileConfig = JSON.parse(readFileSync(new URL("./mobile-runtime.json", import.meta.url), "utf8"));
const mobileDockerfile = readFileSync(new URL("../deploy/Dockerfile.agent-mobile", import.meta.url), "utf8");
const mobileEnv = readFileSync(new URL("../deploy/mobile-env.sh", import.meta.url), "utf8");
const mobileAdb = readFileSync(new URL("../deploy/mobile-adb.sh", import.meta.url), "utf8");
const mobileAdbBin = readFileSync(new URL("../deploy/mobile-adb-bin.sh", import.meta.url), "utf8");
const mobileHdc = readFileSync(new URL("../deploy/mobile-hdc.sh", import.meta.url), "utf8");
const mobileIos = readFileSync(new URL("../deploy/mobile-ios.sh", import.meta.url), "utf8");
const mobileHap = readFileSync(new URL("../deploy/mobile-hap.sh", import.meta.url), "utf8");
const mobileSo = readFileSync(new URL("../deploy/mobile-so.sh", import.meta.url), "utf8");
const mobileSmoke = readFileSync(new URL("./test-mobile-runtime.mjs", import.meta.url), "utf8");
const mobileWorkflow = readFileSync(new URL("../.github/workflows/mobile-runtime.yml", import.meta.url), "utf8");
const mavenSmoke = readFileSync(new URL("./test-maven-package.mjs", import.meta.url), "utf8");
const ciWorkflow = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
const schedulerRuntimeSnapshot = readFileSync(
  new URL("../apps/scheduler/src/domains/role-runtime-snapshot/application.ts", import.meta.url),
  "utf8",
);
const schedulerDispatcher = readFileSync(new URL("../apps/scheduler/src/dispatcher.ts", import.meta.url), "utf8");
const schema = readFileSync(new URL("../database/schema.sql", import.meta.url), "utf8");
const roleSmoke = readFileSync(new URL("./test-runtime-images-api.py", import.meta.url), "utf8");
const dockerIgnore = readFileSync(new URL("../.dockerignore", import.meta.url), "utf8");
const chromeWorkflow = readFileSync(new URL("../.github/workflows/chrome-runtime.yml", import.meta.url), "utf8");
const openHarmonyWorkflow = readFileSync(new URL("../.github/workflows/openharmony-runtime.yml", import.meta.url), "utf8");

const failures = [];
const expect = (condition, message) => { if (!condition) failures.push(message); };
const reasoningPlugin = "dsh-reasoning-settings";
const reasoningPluginVersion = "0.3.0";
const reasoningPluginCommit = "5768999dbbbb5088fd27f89c85970fe2f7b2c5c6";
const reasoningPluginSha256 = "e583207774b2875c4f5914540a8df699b4f0f947b3e3a28722504237ba3dc6e3";
for (const [manifest, source, label] of [[config, dockerfile, "base"], [kaliConfig, kaliDockerfile, "Kali"]]) {
  const entry = manifest.npm[reasoningPlugin];
  expect(entry?.version === reasoningPluginVersion, `${label} reasoning plugin version drift`);
  expect(entry?.commit === reasoningPluginCommit, `${label} reasoning plugin commit drift`);
  expect(entry?.sha256 === reasoningPluginSha256, `${label} reasoning plugin SHA-256 drift`);
  expect(entry?.license === "MIT", `${label} reasoning plugin license drift`);
  expect(source.includes(`ARG DSH_REASONING_SETTINGS_VERSION=${reasoningPluginVersion}`), `${label} reasoning plugin version ARG missing`);
  expect(source.includes(`ARG DSH_REASONING_SETTINGS_COMMIT=${reasoningPluginCommit}`), `${label} reasoning plugin commit ARG missing`);
  expect(source.includes(`ARG DSH_REASONING_SETTINGS_SHA256=${reasoningPluginSha256}`), `${label} reasoning plugin SHA-256 ARG missing`);
  expect(source.includes("codeload.github.com/JuneLearn/dsh-reasoning-settings/tar.gz/${DSH_REASONING_SETTINGS_COMMIT}"), `${label} reasoning plugin must install the pinned archive`);
}
expect(FINGERPRINT_SCHEMA_VERSION === "v2", "fingerprint schema version must be bumped deliberately when semantics change");
expect(COMMON_FINGERPRINT_PATHS.length === 1 && COMMON_FINGERPRINT_PATHS[0] === ".dockerignore", "all image fingerprints must include the shared .dockerignore input");
expect(dockerIgnore.trim().length > 0, ".dockerignore must remain present for image-context fingerprinting");
const assertSpecialistWorkflow = (workflow, label, paths) => {
  expect(workflow.includes("pull_request:\n    paths:"), `${label} workflow must use a pull_request path filter`);
  expect(workflow.includes("push:\n    branches: [main]\n    paths:"), `${label} workflow must use a main push path filter`);
  expect(workflow.includes("workflow_dispatch:"), `${label} workflow must support workflow_dispatch`);
  expect(workflow.includes("concurrency:\n  group:") && workflow.includes("cancel-in-progress: true"), `${label} workflow must have independent cancellable concurrency`);
  for (const path of paths) expect(workflow.includes(`      - "${path}"`), `${label} workflow path filter missing ${path}`);
  expect(workflow.includes("image-build-fingerprint.mjs"), `${label} workflow must calculate an image fingerprint`);
  expect(workflow.includes("resolve-image-src-cache.sh resolve"), `${label} workflow must resolve immutable src-* cache tags`);
  expect(workflow.includes("SRC_TAG: ${{ steps.fingerprint.outputs.src_tag }}"), `${label} workflow must pass the fingerprint src tag to cache resolution`);
  expect(workflow.includes("steps.resolve.outputs.skip != 'true'") && workflow.includes("steps.resolve.outputs.skip == 'true'"), `${label} workflow must skip unchanged rebuilds`);
  expect(workflow.includes('docker push "${IMAGE_NAME}:${SRC_TAG}"'), `${label} workflow must pin newly built src-* cache tags`);
};
assertSpecialistWorkflow(chromeWorkflow, "Chrome", [
  "deploy/Dockerfile.agent-chrome-*", "deploy/chrome-*", "agent-harness/chrome-*-runtime.json",
  "agent-harness/chrome-*.mjs", "agent-harness/test-chrome-runtime.mjs", ".dockerignore",
  "agent-harness/image-build-fingerprint.mjs", "agent-harness/resolve-image-src-cache.sh", ".github/workflows/chrome-runtime.yml",
]);
assertSpecialistWorkflow(openHarmonyWorkflow, "OpenHarmony", [
  "deploy/Dockerfile.agent-openharmony", "deploy/Dockerfile.agent-openharmony-*", "deploy/openharmony-*.sh",
  "deploy/vendor/gitcode-repo-py3", "deploy/vendor/openharmony-hdc/**", "agent-harness/openharmony-test-runtime.json",
  "agent-harness/test-openharmony-hdc.mjs", ".dockerignore",
  "agent-harness/image-build-fingerprint.mjs", "agent-harness/resolve-image-src-cache.sh", ".github/workflows/openharmony-runtime.yml",
]);
assertSpecialistWorkflow(mobileWorkflow, "Mobile", [
  "deploy/Dockerfile.agent-mobile", "deploy/mobile-*.sh", "deploy/vendor/openharmony-hdc/**",
  "agent-harness/mobile-runtime.json",
  "agent-harness/test-mobile-runtime.mjs", ".dockerignore",
  "agent-harness/image-build-fingerprint.mjs", "agent-harness/resolve-image-src-cache.sh", ".github/workflows/mobile-runtime.yml",
]);
expect(!ciWorkflow.includes("chrome-runtime-images"), "core ci workflow must not contain the Chrome specialist job");
expect(!ciWorkflow.includes("openharmony-runtime-images"), "core ci workflow must not contain the OpenHarmony specialist job");
expect(!ciWorkflow.includes("mobile-runtime-images"), "core ci workflow must not contain the Mobile specialist job");
expect(!ciWorkflow.includes("android-runtime-images"), "core ci workflow must not contain a leftover Android specialist job");
expect(ciWorkflow.includes("toolset: base") && ciWorkflow.includes("toolset: audit") && ciWorkflow.includes("toolset: kali-minimal"), "core ci workflow must retain base/audit/kali runtime jobs");
expect(chromeWorkflow.includes("chrome-runtime-images:") && chromeWorkflow.includes("timeout-minutes: 240") && chromeWorkflow.includes("platforms: linux/amd64") && chromeWorkflow.includes("test-chrome-runtime.mjs"), "Chrome workflow must retain its cold-build allowance, amd64 matrix, and smoke");
expect(chromeWorkflow.includes('docker pull "${{ steps.resolve.outputs.src_ref }}"'), "Chrome workflow must pull immutable src-* images before cache-hit smoke");
expect(openHarmonyWorkflow.includes("openharmony-runtime-images:") && openHarmonyWorkflow.includes("setup-qemu-action@v3"), "OpenHarmony workflow must retain its QEMU-backed specialist job");
expect((openHarmonyWorkflow.match(/toolset: openharmony-test/g) ?? []).length === 2, "OpenHarmony workflow must retain exactly two test matrix entries");
expect((openHarmonyWorkflow.match(/toolset: openharmony-audit/g) ?? []).length === 2, "OpenHarmony workflow must retain exactly two audit matrix entries");
expect((openHarmonyWorkflow.match(/toolset: openharmony-fuzz/g) ?? []).length === 2, "OpenHarmony workflow must retain exactly two fuzz matrix entries");
expect((openHarmonyWorkflow.match(/platform: linux\/amd64/g) ?? []).length === 3 && (openHarmonyWorkflow.match(/platform: linux\/arm64/g) ?? []).length === 3, "OpenHarmony workflow must retain amd64/arm64 matrix coverage for test/audit/fuzz");
expect(openHarmonyWorkflow.includes("check_args: --check --static") && openHarmonyWorkflow.includes("matrix.check_args"), "OpenHarmony Fuzz CI must use static mode for arm64 smoke");
expect(openHarmonyWorkflow.includes("check_args: --check --hdc"), "OpenHarmony Test CI must smoke hdc version without requiring a device");
expect(localDefinition.includes('runtime-images.json'), "agent-harness/image.mjs must consume runtime-images.json");
expect(dockerfile.includes(`ARG BASE_IMAGE=${config.baseImage}`), "Dockerfile.agent base image differs from runtime-images.json");
expect(dockerfile.includes("FROM ${BASE_IMAGE}"), "Dockerfile.agent must consume the pinned BASE_IMAGE arg");
expect(dockerfile.includes(`ARG CLAUDE_CODE_VERSION=${config.npm["@anthropic-ai/claude-code"].version}`), "Claude Code version drift");
for (const [packageName, entry] of Object.entries(config.npm)) {
  if (!entry.agent_cli) continue;
  expect(Array.isArray(entry.compatible_image_keys) && entry.compatible_image_keys.includes("deepsonar-base"), `${packageName} base compatibility missing`);
  expect(Array.isArray(kaliConfig.npm[packageName]?.compatible_image_keys) && kaliConfig.npm[packageName].compatible_image_keys.includes("deepsonar-kali-minimal"), `${packageName} Kali compatibility missing`);
}
for (const [packageName, argName] of [["@openai/codex", "CODEX"], ["opencode-ai", "OPENCODE"]]) {
  expect(config.npm[packageName], `${packageName} runtime package missing from manifest`);
  if (config.npm[packageName]) {
    expect(dockerfile.includes(`ARG ${argName}_VERSION=${config.npm[packageName].version}`), `${packageName} version drift`);
    expect(dockerfile.includes(`${packageName}@\${${argName}_VERSION}`), `${packageName} must be installed from the pinned Docker ARG`);
    expect(kaliDockerfile.includes(`ARG ${argName}_VERSION=${kaliConfig.npm[packageName].version}`), `Kali ${packageName} version drift`);
    expect(kaliDockerfile.includes(`${packageName}@\${${argName}_VERSION}`), `Kali ${packageName} must be installed from the pinned Docker ARG`);
  }
}
const piPackage = "@earendil-works/pi-coding-agent";
const piManifest = config.npm[piPackage];
expect(piManifest?.version === "0.84.1", "Pi Coding Agent version must remain pinned");
expect(piManifest?.integrity === "sha512-ncAqFrG+iybuPGOhMiZoEHkEzTpJgz3guYD32pD+M7ucc0WeHmauP6wa7qwP8V/KWvsZDVNa5XGsdZ7fkC7w7A==", "Pi Coding Agent integrity drift");
const piInstallRef = `${piPackage}@\${PI_CODING_AGENT_VERSION}`;
const piIntegrityCheck = `npm view ${piInstallRef} dist.integrity`;
expect(dockerfile.includes("ARG PI_CODING_AGENT_VERSION=0.84.1") && dockerfile.includes(piInstallRef), "Pi Coding Agent must be installed from the pinned Docker ARG");
expect(kaliDockerfile.includes("ARG PI_CODING_AGENT_VERSION=0.84.1") && kaliDockerfile.includes(piInstallRef), "Kali Pi Coding Agent must be installed from the pinned Docker ARG");
expect(dockerfile.includes("ARG PI_CODING_AGENT_INTEGRITY=sha512-ncAqFrG+iybuPGOhMiZoEHkEzTpJgz3guYD32pD+M7ucc0WeHmauP6wa7qwP8V/KWvsZDVNa5XGsdZ7fkC7w7A==") && dockerfile.includes(piIntegrityCheck), "Pi Coding Agent integrity must be verified during the base image build");
expect(kaliDockerfile.includes("ARG PI_CODING_AGENT_INTEGRITY=sha512-ncAqFrG+iybuPGOhMiZoEHkEzTpJgz3guYD32pD+M7ucc0WeHmauP6wa7qwP8V/KWvsZDVNa5XGsdZ7fkC7w7A==") && kaliDockerfile.includes(piIntegrityCheck), "Kali Pi Coding Agent integrity must be verified during the image build");
const aptArgs = {
  git: "GIT", python3: "PYTHON", "ca-certificates": "CA_CERTIFICATES",
  curl: "CURL", ripgrep: "RIPGREP", jq: "JQ", file: "FILE", unzip: "UNZIP", "xz-utils": "XZ", binutils: "BINUTILS",
};
for (const [name, entry] of Object.entries(config.apt)) {
  expect(dockerfile.includes(`ARG ${aptArgs[name]}_VERSION=${entry.version}`), `${name} Debian version drift`);
}
for (const [name, entry] of Object.entries(config.downloads)) {
  expect(dockerfile.includes(`ARG ${name.toUpperCase()}_VERSION=${entry.version}`), `${name} version drift`);
  for (const asset of Object.values(entry.assets)) {
    const checksum = asset.sha256 ?? asset.sha512;
    expect(checksum, `${name} asset must declare sha256 or sha512`);
    expect(dockerfile.includes(checksum), `${name} asset checksum missing: ${checksum}`);
  }
}
for (const required of ["io.deepsonar.contract", "io.deepsonar.toolset", "io.deepsonar.tools-manifest", "org.opencontainers.image.source"]) {
  expect(dockerfile.includes(required), `Dockerfile.agent missing OCI label ${required}`);
  expect(kaliDockerfile.includes(required), `Dockerfile.agent-kali-minimal missing OCI label ${required}`);
}
for (const required of ["org.opencontainers.image.title", "org.opencontainers.image.description", "org.opencontainers.image.licenses"]) {
  expect(dockerfile.includes(required), `Dockerfile.agent missing package metadata ${required}`);
  expect(kaliDockerfile.includes(required), `Dockerfile.agent-kali-minimal missing package metadata ${required}`);
  expect(openHarmonyDockerfile.includes(required), `Dockerfile.agent-openharmony missing package metadata ${required}`);
  expect(openHarmonyAuditDockerfile.includes(required), `Dockerfile.agent-openharmony-audit missing package metadata ${required}`);
  expect(openHarmonyFuzzDockerfile.includes(required), `Dockerfile.agent-openharmony-fuzz missing package metadata ${required}`);
  expect(mobileDockerfile.includes(required), `Dockerfile.agent-mobile missing package metadata ${required}`);
}
expect(kaliDockerfile.includes(`ARG BASE_IMAGE=${kaliConfig.baseImage}`), "Kali minimal base image digest drift");
expect(kaliDockerfile.includes("FROM ${BASE_IMAGE}"), "Kali minimal Dockerfile must consume the pinned BASE_IMAGE arg");
const kaliMirror = "https://kali.download/kali";
const kaliAptSuite = "kali-last-snapshot main contrib non-free non-free-firmware";
expect(kaliDockerfile.includes(`ARG KALI_MIRROR=${kaliMirror}`), "Kali minimal APT mirror must use the pinned HTTPS default");
expect(kaliDockerfile.includes("rm -f /etc/apt/sources.list.d/kali.sources"), "Kali minimal APT sources must disable the base image's mutable mirror");
expect(kaliDockerfile.includes(`printf 'deb %s ${kaliAptSuite}\\n' "\${KALI_MIRROR}" > /etc/apt/sources.list`), "Kali minimal APT sources must use the stable snapshot suite");
const kaliCaImage = "debian:bookworm-slim@sha256:7b140f374b289a7c2befc338f42ebe6441b7ea838a042bbd5acbfca6ec875818";
expect(kaliDockerfile.includes(`ARG CA_IMAGE=${kaliCaImage}`), "Kali minimal CA bootstrap image digest drift");
expect(kaliDockerfile.includes("FROM ${CA_IMAGE} AS ca-bootstrap"), "Kali minimal CA bootstrap stage must consume the pinned image");
expect(kaliDockerfile.includes("apt-get install -y --no-install-recommends ca-certificates"), "Kali minimal CA bootstrap must install ca-certificates");
expect(kaliDockerfile.includes("COPY --from=ca-bootstrap /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/ca-certificates.crt"), "Kali minimal HTTPS APT must use the pinned CA bootstrap");
expect(kaliDockerfile.includes("COPY --from=ca-bootstrap /usr/lib/ssl/ /usr/lib/ssl/"), "Kali minimal HTTPS APT must include the pinned OpenSSL trust paths");
expect(!kaliDockerfile.includes("http://http.kali.org/kali"), "Kali minimal APT sources must not fall back to the mutable HTTP mirror");
expect(kaliDockerfile.includes(`ARG CLAUDE_CODE_VERSION=${kaliConfig.npm["@anthropic-ai/claude-code"].version}`), "Kali minimal Claude Code version drift");
for (const [name, entry] of Object.entries(kaliConfig.downloads)) {
  expect(kaliDockerfile.includes(`ARG ${name.toUpperCase()}_VERSION=${entry.version}`), `Kali minimal ${name} version drift`);
  for (const asset of Object.values(entry.assets)) {
    const checksum = asset.sha256 ?? asset.sha512;
    expect(checksum, `Kali minimal ${name} asset must declare sha256 or sha512`);
    expect(kaliDockerfile.includes(checksum), `Kali minimal ${name} checksum missing: ${checksum}`);
  }
}
const maven = kaliConfig.downloads.maven;
const mavenAsset = maven?.assets?.all;
expect(mavenAsset, "Kali minimal runtime must define the Maven all-platform asset");
if (mavenAsset) {
  expect(kaliDockerfile.includes(`ARG MAVEN_URL=${mavenAsset.url}`), "Kali minimal Maven URL drift");
  expect(kaliDockerfile.includes("sha512sum -c -"), "Kali minimal Maven download must use sha512sum");
}
expect(kaliDockerfile.includes("MAVEN_HOME=/opt/deepsonar/maven"), "Kali minimal Maven home is not exported");
expect(kaliDockerfile.includes("/opt/deepsonar/maven/bin"), "Kali minimal Maven bin directory is not on PATH");
expect(kaliDockerfile.includes("ln -s /opt/deepsonar/maven/bin/mvn /usr/local/bin/mvn"), "Kali minimal Maven must expose a stable /usr/local/bin/mvn symlink");
expect(kaliDockerfile.includes("ln -s /opt/deepsonar/jdks/17/bin/jar /usr/local/bin/jar"), "Kali minimal JDK must expose a stable /usr/local/bin/jar symlink");
expect(kaliDockerfile.includes("/root/.m2"), "Kali minimal image cleanup must remove Maven's .m2 cache");
expect(runtimeSmoke.includes("mvn -v"), "Kali minimal offline smoke must run mvn -v");
expect(runtimeSmoke.includes("command -v mvn"), "Kali minimal offline smoke must verify mvn PATH");
expect(runtimeSmoke.includes("readlink -f"), "Kali minimal offline smoke must resolve mvn to the immutable Maven home");
expect(runtimeSmoke.includes("command -v jar"), "Kali minimal offline smoke must verify jar PATH");
expect(runtimeSmoke.includes("jar --version"), "Kali minimal offline smoke must run jar --version");
expect(mavenSmoke.includes("mvn -q"), "Kali minimal online smoke must run a Maven package");
expect(mavenSmoke.includes("maven.repo.local=/tmp/maven-repository"), "Maven smoke must keep the repository outside .m2");
expect(mavenSmoke.includes("commons_jar=/tmp/maven-repository/org/apache/commons/commons-lang3/3.18.0/commons-lang3-3.18.0.jar"), "Maven smoke must locate the downloaded commons-lang3 dependency");
expect(mavenSmoke.includes('test -s \\\"$commons_jar\\\"'), "Maven smoke must assert the local commons-lang3 jar exists");
expect(mavenSmoke.includes('target/classes:$commons_jar'), "Maven smoke must run with target classes and the local dependency jar");
expect(ciWorkflow.includes("test-maven-package.mjs"), "CI must run the Maven package smoke");
expect(schedulerRuntimeImages.includes('test: "deepsonar-kali-minimal"'), "Scheduler Test default must resolve to Kali Test");
expect(schedulerRuntimeImages.includes('verify: "deepsonar-base"'), "Scheduler Verify default must remain Base");
expect(schedulerRuntimeSnapshot.includes("Runtime test toolchain (Scheduler policy)"), "Test snapshots must carry the prebuilt toolchain policy");
expect(schedulerRuntimeSnapshot.includes("OpenHarmony hdc device protocol (Scheduler policy)"), "OH Test snapshots must require official hdc device evidence");
expect(readFileSync(new URL("../package.json", import.meta.url), "utf8").includes("test-openharmony-hdc.mjs"), "ci:images must run the OpenHarmony hdc helper smoke");
expect(schedulerRuntimeSnapshot.includes("Do **not** install or download JDK, Maven"), "Test snapshots must prohibit runtime JDK/Maven bootstrap");
expect(schedulerDispatcher.includes("禁止 apt-get、下载 JDK/Maven"), "runtime_test intents must prohibit JDK/Maven downloads");
expect(schema.includes("WHEN r.name = 'test' THEN 'deepsonar-kali-minimal'"), "schema Test RoleConfig default must select Kali Test");
expect(schema.includes("Runtime test 工具链纪律"), "schema Test instructions must document prebuilt toolchain policy");
expect(roleSmoke.includes("explicit dynamic verify runtime smoke"), "API smoke must cover explicit dynamic Verify image selection");
expect(roleSmoke.includes("assert verify_role[\"runtime_image_key\"] is None"), "API smoke must preserve global Verify Base default");
for (const version of kaliConfig.managed.python.versions) {
  expect(kaliDockerfile.includes(version), `Kali minimal managed Python version drift: ${version}`);
}
for (const jdk of kaliConfig.managed.jdk.versions) {
  expect(kaliDockerfile.includes(jdk.image), `Kali minimal JDK ${jdk.major} image digest drift`);
}
for (const forbidden of ["kali-linux-core", "kali-linux-headless", "kali-linux-default", "kali-linux-large", "kali-linux-everything", "kali-tools-"]) {
  expect(!kaliDockerfile.match(new RegExp(`apt-get install[^;]*${forbidden}`, "s")), `Kali minimal must not install metapackage ${forbidden}`);
}
expect(kaliDockerfile.includes("--no-install-recommends"), "Kali minimal apt install must disable recommends");
const openHarmonyImages = [
  { key: "deepsonar-openharmony-test", role: "test", dockerfile: openHarmonyDockerfile },
  { key: "deepsonar-openharmony-audit", role: "audit", dockerfile: openHarmonyAuditDockerfile },
  { key: "deepsonar-openharmony-fuzz", role: "test", dockerfile: openHarmonyFuzzDockerfile },
];
for (const item of openHarmonyImages) {
  const image = openHarmonyRegistry.images?.find((entry) => entry.image_key === item.key);
  expect(image, `registry 缺少 ${item.key}`);
  if (image) {
    expect(image.source_kind === "official", `${item.key} 必须是 official`);
    expect(image.project_opt_in === true, `${item.key} 必须启用 project_opt_in`);
    expect(image.default_role === item.role, `${item.key} default_role 必须是 ${item.role}`);
    expect(Array.isArray(image.versions), `${item.key} registry versions 必须是数组`);
  }
}
const chromeImages = [
  { key: "deepsonar-chrome-audit", role: "audit", config: chromeAuditConfig, dockerfile: chromeAuditDockerfile },
  { key: "deepsonar-chrome-test", role: "test", config: chromeTestConfig, dockerfile: chromeTestDockerfile },
  { key: "deepsonar-chrome-fuzz", role: "test", config: chromeFuzzConfig, dockerfile: chromeFuzzDockerfile },
];
for (const item of chromeImages) {
  const image = openHarmonyRegistry.images?.find((entry) => entry.image_key === item.key);
  expect(image, `registry 缺少 ${item.key}`);
  if (image) {
    expect(image.source_kind === "official", `${item.key} 必须是 official`);
    expect(image.project_opt_in === true, `${item.key} 必须启用 project_opt_in`);
    expect(image.default_role === item.role, `${item.key} default_role 必须是 ${item.role}`);
    expect(Array.isArray(image.versions), `${item.key} registry versions 必须是数组`);
  }
  expect(item.config.contract === "deepsonar.runtime.contract/v1", `${item.key} runtime contract drift`);
  expect(item.config.project_opt_in === true, `${item.key} config must remain project_opt_in`);
  expect(item.config.platforms?.join(",") === "linux/amd64,linux/arm64", `${item.key} must declare both release platforms`);
  expect(item.dockerfile.includes("ARG BASE_IMAGE=deepsonar-base:local"), `${item.key} must default to local governed base`);
  expect(item.dockerfile.includes("FROM ${BASE_IMAGE}"), `${item.key} must consume BASE_IMAGE`);
  expect(item.dockerfile.includes("apt-get install -y --no-install-recommends"), `${item.key} apt install must disable recommends`);
  expect(item.dockerfile.includes("USER deepsonar"), `${item.key} must run as non-root`);
  expect(item.dockerfile.includes("/opt/deepsonar/tool-manifest.json"), `${item.key} must generate tool-manifest.json`);
  expect(item.dockerfile.includes("io.deepsonar.contract") && item.dockerfile.includes("org.opencontainers.image.description"), `${item.key} OCI metadata missing`);
}
const mobileImage = openHarmonyRegistry.images?.find((entry) => entry.image_key === "deepsonar-mobile");
expect(mobileImage, "registry 缺少 deepsonar-mobile");
if (mobileImage) {
  expect(mobileImage.source_kind === "official", "deepsonar-mobile 必须是 official");
  expect(mobileImage.project_opt_in === true, "deepsonar-mobile 必须启用 project_opt_in");
  expect(mobileImage.default_role === "audit", "deepsonar-mobile default_role 必须是 audit");
  expect(Array.isArray(mobileImage.versions), "deepsonar-mobile registry versions 必须是数组");
}
expect(mobileConfig.contract === "deepsonar.runtime.contract/v1", "Mobile runtime contract drift");
expect(mobileConfig.project_opt_in === true, "Mobile config must remain project_opt_in");
expect(mobileConfig.platforms?.join(",") === "linux/amd64,linux/arm64", "Mobile must declare both release platforms");
expect(mobileConfig.downloads?.jadx?.version === "1.5.6", "Mobile must pin JADX 1.5.6");
expect(mobileConfig.downloads?.apktool?.version === "3.0.3", "Mobile must pin apktool 3.0.3");
expect(mobileConfig.downloads?.bundletool?.version === "1.18.3", "Mobile must pin bundletool 1.18.3");
expect(mobileConfig.downloads?.apkeep?.version === "1.0.0", "Mobile must pin apkeep 1.0.0");
expect(mobileConfig.managed?.pip?.androguard?.version === "4.1.4", "Mobile must pin androguard 4.1.4");
expect(mobileConfig.managed?.pip?.lief?.version === "1.0.0", "Mobile must pin LIEF 1.0.0");
expect(mobileConfig.managed?.apt?.binutils?.version === "2.40-2", "Mobile must pin binutils 2.40-2");
expect(mobileConfig.downloads?.radare2?.version === "6.2.0", "Mobile must pin radare2 6.2.0");
expect(mobileConfig.downloads?.["platform-tools"]?.version === "36.0.0", "Mobile must pin platform-tools 36.0.0");
expect(mobileConfig.downloads?.hdc?.version === "3.2.0b", "Mobile must pin official hdc 3.2.0b");
expect(mobileConfig.downloads?.jadx?.assets?.all?.sha256 === "545ea2be9c242511bc145755cf4bda2485ade42966e096f8b4d3da2a230e8974", "Mobile JADX SHA256 drift");
expect(mobileConfig.downloads?.apktool?.assets?.all?.sha256 === "dbf930b076c6b9be08d57c449cacefc3bdd6b71ebd59b3066fc0e1f5b14f9423", "Mobile apktool SHA256 drift");
expect(mobileConfig.downloads?.bundletool?.assets?.all?.sha256 === "a099cfa1543f55593bc2ed16a70a7c67fe54b1747bb7301f37fdfd6d91028e29", "Mobile bundletool SHA256 drift");
expect(mobileConfig.downloads?.apkeep?.assets?.amd64?.sha256 === "a23579a3ba366d25a6d69848189b983d65662f4ecf4b9e11e16510811659de4e", "Mobile apkeep amd64 SHA256 drift");
expect(mobileConfig.downloads?.apkeep?.assets?.arm64?.sha256 === "5410acebd1b69427adcf98ccfdda6fa4dd3201e0540e5e2c01037b68e0a84049", "Mobile apkeep arm64 SHA256 drift");
expect(mobileConfig.downloads?.radare2?.assets?.amd64?.sha256 === "eb82324e83315887fbee6f5d8632c982c593e056a87180f1bec5ccb06c463aeb", "Mobile radare2 amd64 SHA256 drift");
expect(mobileConfig.downloads?.radare2?.assets?.arm64?.sha256 === "e866525e9874588d478d536cca38cf9a7562896725efb4119b886101fd93f1ec", "Mobile radare2 arm64 SHA256 drift");
expect(mobileConfig.downloads?.["platform-tools"]?.assets?.all?.sha256 === "0ead642c943ffe79701fccca8f5f1c69c4ce4f43df2eefee553f6ccb27cbfbe8", "Mobile platform-tools SHA256 drift");
expect(mobileConfig.downloads?.hdc?.assets?.amd64?.sha256 === "a72d26110eb6af8391c74325183b419c28355027ce9d68fcc528437fdf21eb6e", "Mobile hdc SHA256 drift");
expect(mobileDockerfile.includes("ARG BASE_IMAGE=deepsonar-base:local"), "Mobile must default to local governed base");
expect(mobileDockerfile.includes("FROM ${BASE_IMAGE}"), "Mobile must consume BASE_IMAGE");
expect(mobileDockerfile.includes("apt-get install -y --no-install-recommends"), "Mobile apt install must disable recommends");
expect(mobileDockerfile.includes("USER deepsonar"), "Mobile must run as non-root");
expect(mobileDockerfile.includes("/opt/deepsonar/tool-manifest.json"), "Mobile must generate tool-manifest.json");
expect(mobileDockerfile.includes("io.deepsonar.contract") && mobileDockerfile.includes("org.opencontainers.image.description"), "Mobile OCI metadata missing");
expect(mobileDockerfile.includes("ARG JADX_SHA256=545ea2be9c242511bc145755cf4bda2485ade42966e096f8b4d3da2a230e8974"), "Mobile Dockerfile JADX checksum drift");
expect(mobileDockerfile.includes("ARG APKTOOL_SHA256=dbf930b076c6b9be08d57c449cacefc3bdd6b71ebd59b3066fc0e1f5b14f9423"), "Mobile Dockerfile apktool checksum drift");
expect(mobileDockerfile.includes("ARG BUNDLETOOL_SHA256=a099cfa1543f55593bc2ed16a70a7c67fe54b1747bb7301f37fdfd6d91028e29"), "Mobile Dockerfile bundletool checksum drift");
expect(mobileDockerfile.includes("ARG APKEEP_AMD64_SHA256=a23579a3ba366d25a6d69848189b983d65662f4ecf4b9e11e16510811659de4e"), "Mobile Dockerfile apkeep amd64 checksum drift");
expect(mobileDockerfile.includes("ARG APKEEP_ARM64_SHA256=5410acebd1b69427adcf98ccfdda6fa4dd3201e0540e5e2c01037b68e0a84049"), "Mobile Dockerfile apkeep arm64 checksum drift");
expect(mobileDockerfile.includes("androguard==${ANDROGUARD_VERSION}"), "Mobile Dockerfile must install pinned androguard");
expect(mobileDockerfile.includes("lief==${LIEF_VERSION}"), "Mobile Dockerfile must install pinned LIEF");
expect(mobileDockerfile.includes("ARG RADARE2_AMD64_SHA256=eb82324e83315887fbee6f5d8632c982c593e056a87180f1bec5ccb06c463aeb"), "Mobile Dockerfile radare2 amd64 checksum drift");
expect(mobileDockerfile.includes("ARG RADARE2_ARM64_SHA256=e866525e9874588d478d536cca38cf9a7562896725efb4119b886101fd93f1ec"), "Mobile Dockerfile radare2 arm64 checksum drift");
expect(mobileDockerfile.includes("binutils=${BINUTILS_VERSION}"), "Mobile Dockerfile must pin binutils");
expect(mobileDockerfile.includes("ARG PLATFORM_TOOLS_SHA256=0ead642c943ffe79701fccca8f5f1c69c4ce4f43df2eefee553f6ccb27cbfbe8"), "Mobile Dockerfile platform-tools checksum drift");
expect(mobileDockerfile.includes("ARG HDC_SHA256=a72d26110eb6af8391c74325183b419c28355027ce9d68fcc528437fdf21eb6e"), "Mobile Dockerfile hdc checksum drift");
expect(mobileDockerfile.includes("libimobiledevice-utils") && mobileDockerfile.includes("ideviceinstaller"), "Mobile must install iOS host protocol tools");
expect(mobileDockerfile.includes("qemu-user-static") && mobileAdbBin.includes("qemu-x86_64-static"), "Mobile arm64 must run official linux-x64 adb via qemu-user-static");
expect(mobileDockerfile.includes("openharmony-hdc-bin.sh") && mobileDockerfile.includes("vendor/openharmony-hdc/hdc"), "Mobile must reuse vendored official hdc");
expect(!mobileDockerfile.includes("jadx-gui") || mobileDockerfile.includes("rm -f") && mobileDockerfile.includes("jadx-gui"), "Mobile must not keep jadx-gui");
expect(!/apt-get install[^\n]*(mobsf|MobSF|burp|Burp|ida64|deveco)/i.test(mobileDockerfile), "Mobile must not apt-install MobSF/Burp/IDA/DevEco");
expect(!/jadx-ai-mcp|apktool-mcp|firerpa|quark-engine/i.test(mobileDockerfile), "Mobile must not bake awesome-ai-reverse MCP wrappers or decision scanners");
expect(mobileDockerfile.includes("bundletool") && mobileDockerfile.includes("apkeep") && mobileDockerfile.includes("androguard"), "Mobile must install bundletool/apkeep/androguard");
expect(mobileDockerfile.includes("mobile-so.sh") && mobileDockerfile.includes("radare2") && !mobileDockerfile.includes("ghidra_"), "Mobile must install lightweight SO tools and must not bake Ghidra");
expect(mobileDockerfile.includes("不预装") && mobileDockerfile.includes("MobSF") && mobileDockerfile.includes("Burp"), "Mobile must document that MobSF/Burp/IDA stay out");
expect(mobileEnv.includes("jadx --version") && mobileEnv.includes("apktool --version") && mobileEnv.includes("bundletool version") && mobileEnv.includes("apkeep --help") && mobileEnv.includes("androguard --help") && mobileEnv.includes("adb version"), "Mobile env check must smoke JADX/apktool/bundletool/apkeep/androguard/adb");
expect(mobileEnv.includes("frida --version") && mobileEnv.includes("objection version"), "Mobile env check must smoke Frida/Objection");
expect(!mobileEnv.includes("mitmdump --version"), "Mobile env check must not require mitmdump");
expect(mobileEnv.includes("idevice_id") && mobileEnv.includes("plistutil") && mobileEnv.includes("hdc"), "Mobile env check must smoke iOS host tools and hdc");
expect(mobileEnv.includes("for command_name in semgrep gitleaks shellcheck mobsf jadx-gui burpsuite mitmdump mitmproxy ida64 ghidra analyzeHeadless cutter deveco"), "Mobile env check must fail if decision scanners, GUI, Ghidra, mitmproxy, or commercial tools reappear");
expect(!mobileDockerfile.includes("mitmproxy==") && !mobileDockerfile.includes("bin/mitmdump"), "Mobile must not install mitmproxy");
expect(mobileEnv.includes("r2 -qv") && mobileEnv.includes("mobile-so.sh --check"), "Mobile env check must smoke radare2 and SO helper");
expect(mobileSo.includes("readelf") && mobileSo.includes("r2 -qq") && mobileSo.includes("lief"), "Mobile SO helper must inspect ELF with readelf/r2/LIEF");
expect(mobileAdb.includes("needs_human") && mobileAdb.includes("inconclusive") && mobileAdb.includes("no_adb_target"), "Mobile adb helper must emit structured no-target evidence");
expect(mobileHdc.includes("needs_human") && mobileHdc.includes("no_hdc_target") && mobileIos.includes("no_ios_target"), "Mobile hdc/ios helpers must emit structured no-target evidence");
expect(mobileHap.includes("pack.info") && mobileHap.includes("module.json"), "Mobile HAP helper must inspect pack.info/module.json");
expect(mobileSmoke.includes("adb version smoke") || mobileSmoke.includes("Android Debug Bridge version"), "Mobile unit smoke must cover adb version");
expect(mobileSmoke.includes("no_adb_target") && mobileSmoke.includes("needs_human"), "Mobile unit smoke must cover empty adb devices without a device");
expect(mobileSmoke.includes("no_hdc_target") && mobileSmoke.includes("no_ios_target") && mobileSmoke.includes("pack.info"), "Mobile unit smoke must cover hdc, iOS, and HAP helpers");
expect(mobileSmoke.includes("so --check") && mobileSmoke.includes("libdemo.so"), "Mobile unit smoke must cover SO helper");
expect(PRESETS["deepsonar-mobile"]?.paths?.includes("deploy/mobile-so.sh"), "Mobile fingerprint must include the SO helper");
expect(mobileWorkflow.includes("mobile-runtime-images:") && mobileWorkflow.includes("setup-qemu-action@v3"), "Mobile workflow must retain its QEMU-backed specialist job");
expect((mobileWorkflow.match(/toolset: mobile/g) ?? []).length === 2, "Mobile workflow must retain exactly two matrix entries");
expect((mobileWorkflow.match(/platform: linux\/amd64/g) ?? []).length === 1 && (mobileWorkflow.match(/platform: linux\/arm64/g) ?? []).length === 1, "Mobile workflow must retain amd64/arm64 matrix coverage");
expect(PRESETS["deepsonar-mobile"]?.paths?.includes("agent-harness/mobile-runtime.json"), "Mobile fingerprint must include the runtime manifest");
expect(PRESETS["deepsonar-mobile"]?.paths?.includes("deploy/vendor/openharmony-hdc/hdc"), "Mobile fingerprint must include vendored hdc");
expect(schedulerRuntimeSnapshot.includes("Mobile device protocols (Scheduler policy)"), "Mobile snapshots must require official adb/hdc/ios device evidence");
expect(readFileSync(new URL("../package.json", import.meta.url), "utf8").includes("test-mobile-runtime.mjs"), "ci:images must run the Mobile helper smoke");
expect(chromeSources.contract === "deepsonar.chrome.runtime.sources/v1", "Chrome source metadata contract drift");
expect(chromeSources.chromium.version === "151.0.7922.71-1~deb12u1", "Chrome Chromium version must remain pinned");
expect(chromeSources.debianSecuritySnapshot === "20260731T162426Z", "Chrome Debian security snapshot must remain pinned");
expect(chromeSources.v8.commit === "792d9716fea48312ad7ce4413c538e00628b1d50" && chromeSources.v8.version === "15.1.206.10", "Chrome Fuzz V8 revision/version must remain pinned");
for (const arch of ["amd64", "arm64"]) {
  const asset = chromeSources.chromium.architectures?.[arch];
  expect(asset?.url?.startsWith("https://snapshot.debian.org/archive/debian-security/"), `Chrome ${arch} package must use pinned Debian security snapshot`);
  expect(asset?.common_url?.startsWith("https://snapshot.debian.org/archive/debian-security/"), `Chrome ${arch} common package must use pinned Debian security snapshot`);
  expect(asset?.url?.includes(chromeSources.chromium.version) && asset?.common_url?.includes(chromeSources.chromium.version), `Chrome ${arch} package URLs must match the pinned version`);
  expect(/^[0-9a-f]{64}$/.test(asset?.sha256 ?? ""), `Chrome ${arch} package must carry a SHA256 checksum`);
  expect(/^[0-9a-f]{64}$/.test(asset?.common_sha256 ?? ""), `Chrome ${arch} common package must carry a SHA256 checksum`);
  expect(chromeTestDockerfile.includes(asset?.sha256 ?? "") && chromeTestDockerfile.includes(asset?.common_sha256 ?? ""), `Chrome ${arch} package checksums missing from Dockerfile`);
}
expect(chromeAuditEnv.includes("git --version") && chromeAuditDockerfile.includes("git"), "Chrome Audit must keep git as a base tool");
expect(!existsSync(new URL("../deploy/chrome-audit-rules.yml", import.meta.url)), "Chrome Audit 不得捆绑平台扫描规则包");
expect(!existsSync(new URL("../deploy/chrome-audit-scan.sh", import.meta.url)), "Chrome Audit 不得提供平台固定扫描入口");
expect(!chromeAuditDockerfile.includes("chrome-audit-rules.yml") && !chromeAuditDockerfile.includes("chrome-audit-scan.sh") && !chromeAuditEnv.includes("chrome-audit-scan.sh"), "Chrome Audit 不得安装固定扫描脚本或规则包");
expect(chromeAuditDockerfile.includes("clang") && chromeAuditDockerfile.includes("clang-tools") && chromeAuditDockerfile.includes("clang-tidy") && chromeAuditDockerfile.includes("clangd") && chromeAuditDockerfile.includes("binutils"), "Chrome Audit must bundle Clang tooling and binutils");
expect(!chromeAuditDockerfile.includes("depot_tools"), "Chrome Audit must not include depot_tools");
expect(chromeTestDockerfile.includes(`ARG PLAYWRIGHT_CORE_VERSION=${chromeSources.playwright.version}`) && chromeTestDockerfile.includes(`ARG PLAYWRIGHT_CORE_INTEGRITY=${chromeSources.playwright.integrity}`) && chromeTestDockerfile.includes("playwright-core@${PLAYWRIGHT_CORE_VERSION}") && chromeTestDockerfile.includes("CHROMIUM_VERSION") && chromeTestDockerfile.includes("chromium-common"), "Chrome Test must pin Playwright, Chromium, and chromium-common versions");
expect(chromeHeadless.includes("--no-sandbox") && chromeHeadless.includes("--headless=new") && chromeHeadless.includes("--remote-debugging-port"), "Chrome Test wrapper must enforce headless no-sandbox CDP flags");
expect(chromeTestEnv.includes("connectOverCDP") && chromeTestSmoke.includes("connectOverCDP"), "Chrome Test must expose a Playwright/CDP path");
expect(chromeFuzzDockerfile.includes(chromeSources.v8.commit) && chromeFuzzDockerfile.includes(chromeSources.v8.compiler_rt_commit) && chromeFuzzDockerfile.includes(chromeSources.v8.compiler_rt_repository) && chromeFuzzDockerfile.includes("gclient sync") && chromeFuzzDockerfile.includes("autoninja") && chromeFuzzDockerfile.includes("d8") && chromeFuzzDockerfile.includes("v8_json_libfuzzer") && chromeFuzzDockerfile.includes("use_libfuzzer=true") && chromeFuzzDockerfile.includes("-fsanitize=fuzzer-no-link") && chromeFuzzDockerfile.includes('v8_source_set("deepsonar_libfuzzer")') && chromeFuzzDockerfile.includes("FuzzerMain.cpp") && chromeFuzzDockerfile.includes("remove_configs = [") && chromeFuzzDockerfile.includes("configs = [") && chromeFuzzDockerfile.includes("default_sanitizer_flags_but_coverage") && chromeFuzzDockerfile.includes("v8_enable_fuzztest=false") && chromeFuzzDockerfile.includes("FROM v8-build-rootfs AS v8-builder") && chromeFuzzDockerfile.includes("libsanitizer_shared_hooks.so") && chromeFuzzDockerfile.includes("LD_LIBRARY_PATH=/opt/deepsonar/lib"), "Chrome Fuzz must compile an instrumented pinned V8 target and ship its matching libFuzzer and sanitizer runtime closure through the V8 GN template contract");
expect(chromeFuzzDockerfile.includes("pkg-config") && chromeFuzzDockerfile.includes("clang-16") && chromeFuzzDockerfile.includes("lld-16") && chromeFuzzDockerfile.includes("libclang-rt-16-dev") && chromeFuzzDockerfile.includes("libfuzzer-16-dev") && chromeFuzzDockerfile.includes("afl++"), "Chrome Fuzz Debian toolchain package closure incomplete");
expect(chromeFuzzDockerfile.includes("FROM --platform=$BUILDPLATFORM ${BASE_IMAGE} AS v8-build-rootfs") && !chromeFuzzDockerfile.includes("clang_base_path=\"/usr/lib/llvm-16\"") && chromeFuzzDockerfile.includes("target_cpu=arm64") && chromeFuzzDockerfile.includes("install-sysroot.py --arch=arm64") && chromeFuzzDockerfile.includes("debian_bullseye_arm64-sysroot") && chromeFuzzPreflight.includes("third_party/llvm-build/Release+Asserts/bin/clang++") && chromeFuzzPreflight.includes("--target=aarch64-linux-gnu") && chromeFuzzPreflight.includes("/usr/bin/ninja") && chromeFuzzPreflight.includes("file -Lb") && chromeFuzzPreflight.includes("libclang_rt[.]builtins"), "Chrome Fuzz arm64 must use V8's pinned x86_64 Clang, sysroot, and compiler runtime as a checked cross-toolchain");
expect(chromeFuzzConfig.apt["libclang-rt-16-dev"]?.version === "16.0.6-15~deb12u1" && chromeFuzzConfig.apt["libfuzzer-16-dev"]?.version === "16.0.6-15~deb12u1", "Chrome Fuzz must declare verified Bookworm compiler-rt/libFuzzer package names");
expect(chromeFuzzEnv.includes(".fuzz.actual == true") && chromeFuzzSmoke.includes("actual V8 d8") && chromeFuzzSmoke.includes("-runs=1") && !chromeFuzzDockerfile.includes("toy"), "Chrome Fuzz must fail closed without real d8/libFuzzer");
const chromeFuzzRuntimeFinal = chromeFuzzDockerfile.slice(chromeFuzzDockerfile.indexOf("FROM runtime-rootfs AS runtime-final"));
const chromeFuzzRuntimeChecks = chromeFuzzRuntimeFinal.slice(chromeFuzzRuntimeFinal.indexOf('case "$TARGETARCH" in'), chromeFuzzRuntimeFinal.lastIndexOf("esac") + 4);
const chromeFuzzAmd64Checks = chromeFuzzRuntimeChecks.slice(chromeFuzzRuntimeChecks.indexOf("amd64)"), chromeFuzzRuntimeChecks.indexOf("arm64)"));
const chromeFuzzArm64Checks = chromeFuzzRuntimeChecks.slice(chromeFuzzRuntimeChecks.indexOf("arm64)"), chromeFuzzRuntimeChecks.lastIndexOf("*)"));
expect(
  /FROM runtime-rootfs AS runtime-final\r?\nARG TARGETARCH/.test(chromeFuzzRuntimeFinal) &&
    chromeFuzzAmd64Checks.includes("/opt/deepsonar/bin/d8 --version") &&
    chromeFuzzAmd64Checks.includes("/opt/deepsonar/bin/chrome-fuzz-env.sh --check") &&
    chromeFuzzArm64Checks.includes("file -Lb /opt/deepsonar/bin/d8") &&
    chromeFuzzArm64Checks.includes("test -x /opt/deepsonar/bin/d8") &&
    chromeFuzzArm64Checks.includes("test -x /opt/deepsonar/bin/v8_json_libfuzzer") &&
    chromeFuzzArm64Checks.includes("test -f /opt/deepsonar/lib/libsanitizer_shared_hooks.so") &&
    !chromeFuzzArm64Checks.includes("/opt/deepsonar/bin/d8 --version") &&
    !chromeFuzzArm64Checks.includes("/opt/deepsonar/bin/chrome-fuzz-env.sh --check"),
  "Chrome Fuzz build-time checks must run dynamically on amd64 and use gated static checks on arm64",
);
for (const [file, content] of [
  ["chrome-audit-env.sh", chromeAuditEnv],
  ["chrome-headless.sh", chromeHeadless], ["chrome-test-env.sh", chromeTestEnv],
  ["chrome-fuzz-env.sh", chromeFuzzEnv], ["chrome-fuzz-smoke.sh", chromeFuzzSmoke],
  ["chrome-fuzz-toolchain-preflight.sh", chromeFuzzPreflight],
]) {
  const mode = statSync(new URL(`../deploy/${file}`, import.meta.url)).mode;
  expect((mode & 0o111) !== 0, `${file} 必须可执行`);
  expect(content.includes("set -euo pipefail"), `${file} 必须启用严格 shell 模式`);
}
expect(prepareScript.includes("deepsonar-chrome-audit") && prepareScript.includes("deepsonar-chrome-test") && prepareScript.includes("deepsonar-chrome-fuzz"), "prepare 脚本必须接入 Chrome 三项镜像");
expect(prepareScript.includes("deepsonar-mobile") && prepareScript.includes("Dockerfile.agent-mobile"), "prepare 脚本必须接入 Mobile 镜像");
expect(chromeWorkflow.includes("chrome-runtime-images") && chromeWorkflow.includes("test-chrome-runtime.mjs"), "Chrome CI must build and smoke Chrome runtime images");
expect(chromeRuntimeSmoke.includes('const targetPlatform = process.argv[5] ?? "linux/amd64"') && chromeRuntimeSmoke.includes('"--platform", targetPlatform') && chromeRuntimeSmoke.includes("linux/amd64") && chromeRuntimeSmoke.includes("linux/arm64"), "Chrome runtime smoke must validate a target platform and pass it to every Docker run");
expect(ciWorkflow.includes("chrome-fuzz-arm64-build:") && ciWorkflow.includes("chrome-fuzz-arm64:") && ciWorkflow.includes("needs: chrome-fuzz-arm64-build") && ciWorkflow.includes("runs-on: ubuntu-24.04-arm") && ciWorkflow.includes("steps.image.outputs.digest") && ciWorkflow.includes("docker/setup-qemu-action@v3") && ciWorkflow.includes("platforms: linux/arm64") && ciWorkflow.includes('docker pull --platform linux/arm64 "$image_ref"') && ciWorkflow.includes("test-chrome-runtime.mjs") && ciWorkflow.includes("agent-harness/chrome-fuzz-runtime.json linux/arm64"), "核心 CI 必须交叉构建 Chrome Fuzz arm64，并在原生 ARM64 runner 上执行不可变镜像冒烟");
expect(releaseWorkflow.includes("chrome-images:") && releaseWorkflow.includes("chrome-fuzz-arm64-smoke:") && releaseWorkflow.includes("needs: [base-image, chrome-image-builds]") && releaseWorkflow.includes("chrome-images:\n    needs: [base-image, chrome-image-builds, chrome-fuzz-arm64-smoke]") && releaseWorkflow.includes("Dockerfile.agent-chrome-audit") && releaseWorkflow.includes("Dockerfile.agent-chrome-test") && releaseWorkflow.includes("Dockerfile.agent-chrome-fuzz") && releaseWorkflow.includes("matrix.name == 'chrome-fuzz' && matrix.arch == 'arm64'") && releaseWorkflow.includes("matrix.name != 'chrome-fuzz' || matrix.arch != 'arm64'") && releaseWorkflow.includes("runs-on: ubuntu-24.04-arm"), "Release 必须在发布多架构 index 前，将 Chrome Fuzz arm64 冒烟延后到原生 ARM64 门禁");
expect(releaseWorkflow.includes('docker pull --platform "${{ matrix.platform }}" "$image_ref"') && releaseWorkflow.includes('test-chrome-runtime.mjs "$image_ref" "${{ matrix.toolset }}" "${{ matrix.config }}" "${{ matrix.platform }}"'), "release Chrome smoke must pull and run the matrix target platform");
for (const [file, content] of [
  ["openharmony-env.sh", openHarmonyEnv],
  ["openharmony-hdc.sh", openHarmonyHdc],
  ["openharmony-hdc-bin.sh", openHarmonyHdcBin],
  ["openharmony-init.sh", openHarmonyInit],
  ["openharmony-build.sh", openHarmonyBuild],
  ["openharmony-audit-env.sh", openHarmonyAuditEnv],
  ["openharmony-audit-scan.sh", openHarmonyAuditScan],
  ["openharmony-fuzz-env.sh", openHarmonyFuzzEnv],
  ["openharmony-fuzz-build.sh", openHarmonyFuzzBuild],
  ["mobile-env.sh", mobileEnv],
  ["mobile-adb.sh", mobileAdb],
  ["mobile-adb-bin.sh", mobileAdbBin],
  ["mobile-hdc.sh", mobileHdc],
  ["mobile-ios.sh", mobileIos],
  ["mobile-hap.sh", mobileHap],
  ["mobile-so.sh", mobileSo],
]) {
  const mode = statSync(new URL(`../deploy/${file}`, import.meta.url)).mode;
  expect((mode & 0o111) !== 0, `${file} 必须可执行`);
  expect(content.includes("set -euo pipefail"), `${file} 必须启用严格 shell 模式`);
}
const openHarmonyRepoSha256 = "2410cfea0b746fa175acd7130116e3cab26fb2f1cb8107e7a030cd50b0f2c020";
expect(createHash("sha256").update(normalizedOpenHarmonyRepo).digest("hex") === openHarmonyRepoSha256, "OpenHarmony vendored repo launcher checksum 不匹配");
for (const item of openHarmonyImages) {
  const df = item.dockerfile;
  const label = item.key;
  expect(df.includes("ARG BASE_IMAGE=deepsonar-base:local"), `${label} 必须默认依赖本地 base 镜像`);
  expect(df.includes("apt-get install -y --no-install-recommends"), `${label} apt 安装必须禁用 recommends`);
  expect(df.includes("USER deepsonar"), `${label} 必须使用非 root 用户`);
  expect(df.includes("WORKDIR /workspace"), `${label} 工作目录必须是 /workspace`);
  expect(df.includes("/opt/deepsonar/tool-manifest.json"), `${label} 必须生成 tool-manifest.json`);
  expect(df.includes("COPY deploy/vendor/gitcode-repo-py3 /tmp/repo"), `${label} 必须使用仓库内受控 repo launcher`);
  expect(df.includes(openHarmonyRepoSha256), `${label} repo checksum 不匹配`);
  expect(df.includes("sha256sum -c -"), `${label} repo 安装前必须执行 sha256sum 校验`);
  expect(!/curl[^\n]*(raw\.gitcode\.com|storage\.googleapis\.com|google\.com)/s.test(df), `${label} 构建期不得 curl GitCode Raw 或 Google`);
  expect(!df.includes("raw.gitcode.com"), `${label} 构建期不得依赖 GitCode Raw`);
  expect(!df.includes("storage.googleapis.com"), `${label} 不得从 storage.googleapis.com 下载 repo`);
  expect(!df.includes("google.com"), `${label} 构建期不得依赖 Google`);
  expect(df.includes("gitcode.com/openharmony/manifest.git"), `${label} 必须使用官方 GitCode manifest 默认地址`);
}
for (const tool of ["build-essential", "ccache", "cmake", "ninja-build", "repo", "git-lfs", "python3", "python3-requests", "python-is-python3", "hdc"]) {
  expect(openHarmonyDockerfile.includes(tool), `OpenHarmony Test 镜像缺少工具：${tool}`);
}
expect(openHarmonyTestConfig.contract === "deepsonar.runtime.contract/v1", "OpenHarmony Test runtime contract drift");
expect(openHarmonyTestConfig.project_opt_in === true, "OpenHarmony Test config must remain project_opt_in");
expect(openHarmonyTestConfig.toolset === "openharmony-test", "OpenHarmony Test toolset drift");
expect(openHarmonyTestConfig.downloads?.hdc?.version === "3.2.0b", "OpenHarmony Test must pin official hdc 3.2.0b");
expect(openHarmonyTestConfig.downloads?.hdc?.sdk?.url === "https://repo.huaweicloud.com/openharmony/os/6.0-Release/ohos-sdk-windows_linux-public.tar.gz", "OpenHarmony Test hdc must use the official OpenHarmony SDK URL");
expect(openHarmonyTestConfig.downloads?.hdc?.sdk?.sha256 === "a315834ac133625efc912bd078f3e2b2550868d04aef1b5aa4f9679c8b3c9d8e", "OpenHarmony Test official SDK SHA256 drift");
expect(!JSON.stringify(openHarmonyTestConfig).includes("harmonyos/os"), "OpenHarmony Test must not pin HarmonyOS proprietary SDK paths");
expect(!openHarmonyDockerfile.includes("DevEco") && !openHarmonyHdc.includes("DevEco"), "OpenHarmony Test must not install DevEco");
expect(!openHarmonyDockerfile.includes("nmap") && !openHarmonyHdc.includes("nmap"), "OpenHarmony Test must not default-on nmap");
const hdcAsset = openHarmonyTestConfig.downloads?.hdc?.assets;
for (const arch of ["amd64", "arm64"]) {
  expect(hdcAsset?.[arch]?.url === openHarmonyTestConfig.downloads.hdc.sdk.url, `OpenHarmony ${arch} hdc URL must match the official SDK`);
  expect(/^[0-9a-f]{64}$/.test(hdcAsset?.[arch]?.sha256 ?? ""), `OpenHarmony ${arch} hdc must carry a SHA256 checksum`);
  expect(hdcAsset?.[arch]?.sha256 === "a72d26110eb6af8391c74325183b419c28355027ce9d68fcc528437fdf21eb6e", `OpenHarmony ${arch} hdc SHA256 drift`);
  expect(hdcAsset?.[arch]?.libusbSharedSha256 === "431e69ebe2f87ac693c3dae032ec82baa3196b9d403139ae9775ccbaf9227887", `OpenHarmony ${arch} libusb_shared SHA256 drift`);
  expect(openHarmonyDockerfile.includes(hdcAsset?.[arch]?.sha256 ?? ""), `OpenHarmony Test Dockerfile missing hdc checksum for ${arch}`);
  expect(openHarmonyDockerfile.includes(hdcAsset[arch].libusbSharedSha256), `OpenHarmony Test Dockerfile missing libusb_shared checksum for ${arch}`);
}
expect(createHash("sha256").update(readFileSync(new URL("../deploy/vendor/openharmony-hdc/hdc", import.meta.url))).digest("hex") === hdcAsset.amd64.sha256, "vendored hdc SHA256 must match the runtime manifest");
expect(createHash("sha256").update(readFileSync(new URL("../deploy/vendor/openharmony-hdc/libusb_shared.so", import.meta.url))).digest("hex") === hdcAsset.amd64.libusbSharedSha256, "vendored libusb_shared SHA256 must match the runtime manifest");
expect(PRESETS["deepsonar-openharmony-test"]?.paths?.includes("agent-harness/openharmony-test-runtime.json"), "OpenHarmony Test fingerprint must include the hdc runtime manifest");
expect(PRESETS["deepsonar-openharmony-test"]?.paths?.includes("deploy/vendor/openharmony-hdc/hdc"), "OpenHarmony Test fingerprint must include vendored hdc");
expect(openHarmonyDockerfile.includes("openharmony-hdc.sh") && openHarmonyDockerfile.includes("device") && openHarmonyDockerfile.includes('"protocol":"hdc"'), "OpenHarmony Test must declare hdc as the device protocol");
expect(openHarmonyDockerfile.includes("qemu-user-static") && openHarmonyHdcBin.includes("qemu-x86_64-static"), "OpenHarmony Test arm64 must run official linux-x64 hdc via qemu-user-static");
expect(openHarmonyEnv.includes("hdc version") && openHarmonyEnv.includes("hdc -v") && openHarmonyEnv.includes("--hdc"), "OpenHarmony Test env smoke must expect hdc version / hdc -v");
expect(openHarmonyEnv.includes("${hdc_version}${hdc_verbose}") && openHarmonyEnv.includes("*Ver:*"), "OpenHarmony Test env smoke must accept Ver: from either hdc version or hdc -v");
expect(openHarmonyHdc.includes("hdc version") && openHarmonyHdc.includes("hdc -v") && openHarmonyHdc.includes("needs_human") && openHarmonyHdc.includes("inconclusive") && openHarmonyHdc.includes("[Empty]"), "OpenHarmony hdc helper must smoke version and emit structured no-target evidence");
expect(openHarmonyHdc.includes("${version}${verbose}") && openHarmonyHdc.includes("*Ver:*"), "OpenHarmony hdc helper must accept Ver: from either hdc version or hdc -v");
expect(openHarmonyHdcSmoke.includes("hdc version smoke") && openHarmonyHdcSmoke.includes("no_hdc_target") && openHarmonyHdcSmoke.includes("needs_human"), "OpenHarmony hdc unit smoke must cover version and empty targets without a device");
expect(openHarmonyHdcSmoke.includes("Connect server failed") && openHarmonyHdcSmoke.includes("Ver: 3.2.0b") && openHarmonyHdcSmoke.includes("--check --hdc") && openHarmonyHdcSmoke.includes("qemu split"), "OpenHarmony hdc unit smoke must accept qemu split version output without a device");
expect(!openHarmonyDockerfile.includes("ohos-sdk-windows_linux-public.tar.gz") || openHarmonyDockerfile.includes("HDC_SDK_URL"), "OpenHarmony Test may document the official SDK URL but must not bake the full SDK tree");
expect(!openHarmonyAuditDockerfile.includes("openharmony-hdc") && !openHarmonyFuzzDockerfile.includes("openharmony-hdc"), "hdc is the Test device protocol; do not copy it into audit/fuzz as a Kali-style process tool");
for (const tool of ["clang", "clang-tidy", "clang-tools", "libclang-rt-dev", "sparse", "cppcheck", "bear", "libasan8", "libubsan1", "gdb"]) {
  expect(openHarmonyAuditDockerfile.includes(tool), `OpenHarmony Audit 镜像缺少工具：${tool}`);
}
for (const tool of ["clang", "libclang-rt-dev", "afl++", "libasan8", "libubsan1", "gdb", "llvm"]) {
  expect(openHarmonyFuzzDockerfile.includes(tool), `OpenHarmony Fuzz 镜像缺少工具：${tool}`);
}
expect(openHarmonyFuzzDockerfile.includes('"compiler-rt","libfuzzer"'), "OpenHarmony Fuzz manifest must declare compiler-rt and libfuzzer");
expect(openHarmonyFuzzEnv.includes("clang -print-resource-dir"), "OpenHarmony Fuzz check must probe Clang's resource dir dynamically");
expect(openHarmonyFuzzEnv.includes("clang -print-target-triple"), "OpenHarmony Fuzz check must derive the runtime architecture from Clang");
expect(openHarmonyFuzzEnv.includes("fuzzer_interceptors"), "OpenHarmony Fuzz check must verify the libFuzzer interceptor archive");
expect(openHarmonyFuzzEnv.includes("ubsan_standalone"), "OpenHarmony Fuzz check must verify the UBSan compiler-rt archive");
expect(openHarmonyFuzzEnv.includes("-fsanitize=fuzzer,address,undefined"), "OpenHarmony Fuzz check must compile with the production sanitizer set");
expect(openHarmonyFuzzEnv.includes("--static"), "OpenHarmony Fuzz check must expose a static cross-architecture mode");
expect(openHarmonyFuzzEnv.includes("readelf -h") && openHarmonyFuzzEnv.includes("readelf -Ws") && openHarmonyFuzzEnv.includes("file \"$smoke_binary\""), "OpenHarmony Fuzz static mode must inspect ELF metadata");
expect(openHarmonyFuzzEnv.includes("__asan_init") && openHarmonyFuzzEnv.includes("LLVMFuzzerRunDriver"), "OpenHarmony Fuzz static mode must prove ASan/libFuzzer instrumentation");
expect(openHarmonyFuzzEnv.includes("tool-manifest.json") && openHarmonyFuzzEnv.includes("deepsonar.runtime.contract/v1"), "OpenHarmony Fuzz check must validate its runtime manifest");
expect(openHarmonyFuzzEnv.includes('if [[ "$check_mode" == "static" ]]'), "OpenHarmony Fuzz static mode must branch before sanitizer execution");
expect(openHarmonyFuzzEnv.includes("ASAN_OPTIONS=detect_leaks=0") && openHarmonyFuzzEnv.includes('"$smoke_binary" -runs=1'), "OpenHarmony Fuzz amd64 mode must run the sanitizer/libFuzzer smoke binary");
expect(openHarmonyFuzzDockerfile.includes("ARG TARGETARCH") && openHarmonyFuzzDockerfile.includes("openharmony-fuzz-env.sh --check --static"), "OpenHarmony Fuzz image build must use static mode for arm64 targets");
expect(openHarmonyWorkflow.includes("check_args: --check --static") && openHarmonyWorkflow.includes("matrix.check_args"), "OpenHarmony Fuzz CI must use static mode for arm64 smoke");
expect(openHarmonyDockerfile.includes("openharmony-env.sh --check --hdc"), "OpenHarmony Test 必须在构建时执行含 hdc version 的环境 smoke check");
expect(openHarmonyAuditDockerfile.includes("openharmony-audit-env.sh --check"), "OpenHarmony Audit 必须在构建时执行环境 smoke check");
expect(openHarmonyFuzzDockerfile.includes("openharmony-fuzz-env.sh --check"), "OpenHarmony Fuzz 必须在构建时执行环境 smoke check");
const decisionScanners = ["semgrep", "gitleaks", "shellcheck"];
const officialRuntimeSources = [
  ["runtime-images.json", JSON.stringify(config)],
  ["kali-minimal-runtime.json", JSON.stringify(kaliConfig)],
  ["chrome-audit-runtime.json", JSON.stringify(chromeAuditConfig)],
  ["chrome-test-runtime.json", JSON.stringify(chromeTestConfig)],
  ["chrome-fuzz-runtime.json", JSON.stringify(chromeFuzzConfig)],
  ["openharmony-test-runtime.json", JSON.stringify(openHarmonyTestConfig)],
  ["mobile-runtime.json", JSON.stringify(mobileConfig)],
  ["Dockerfile.agent", dockerfile],
  ["Dockerfile.agent-kali-minimal", kaliDockerfile],
  ["Dockerfile.agent-chrome-audit", chromeAuditDockerfile],
  ["Dockerfile.agent-chrome-test", chromeTestDockerfile],
  ["Dockerfile.agent-chrome-fuzz", chromeFuzzDockerfile],
  ["Dockerfile.agent-openharmony", openHarmonyDockerfile],
  ["Dockerfile.agent-openharmony-audit", openHarmonyAuditDockerfile],
  ["Dockerfile.agent-openharmony-fuzz", openHarmonyFuzzDockerfile],
  ["Dockerfile.agent-mobile", mobileDockerfile],
  ["agent-harness/image.mjs", localDefinition],
];
for (const [label, source] of officialRuntimeSources) {
  for (const scanner of decisionScanners) {
    expect(!source.includes(scanner), `${label} 不得安装决策扫描器 ${scanner}`);
  }
}
expect(runtimeSmoke.includes("! command -v semgrep") && runtimeSmoke.includes("! command -v gitleaks") && runtimeSmoke.includes("! command -v shellcheck"), "offline smoke must fail if decision scanners reappear");
expect(!runtimeSmoke.includes("semgrep --version") && !runtimeSmoke.includes("gitleaks version") && !runtimeSmoke.includes("shellcheck --version"), "offline smoke must not require decision scanners");
expect(chromeAuditEnv.includes("for command_name in semgrep gitleaks shellcheck") && chromeAuditEnv.includes("不得预装决策扫描器"), "Chrome Audit env check must fail if decision scanners reappear");
expect(!chromeAuditEnv.includes("semgrep --version") && !chromeAuditEnv.includes("semgrep --config"), "Chrome Audit env check must not run semgrep");
expect(openHarmonyInit.includes("[[ \"$manifest\" == https://* ]]"), "OpenHarmony manifest 必须限制为 HTTPS");
expect(!openHarmonyInit.includes("eval ") && !openHarmonyBuild.includes("eval "), "OpenHarmony 入口不得使用 eval");
expect(!openHarmonyAuditScan.includes("eval ") && !openHarmonyFuzzBuild.includes("eval "), "OpenHarmony audit/fuzz 入口不得使用 eval");
expect(openHarmonyBuild.includes('exec ./build.sh --product-name "$product_name" "${build_args[@]}"'), "OpenHarmony 构建参数必须严格传递");
expect(prepareScript.includes("deepsonar-openharmony-test"), "prepare 脚本必须接入 OpenHarmony Test 镜像");
expect(prepareScript.includes("deepsonar-openharmony-audit"), "prepare 脚本必须接入 OpenHarmony Audit 镜像");
expect(prepareScript.includes("deepsonar-openharmony-fuzz"), "prepare 脚本必须接入 OpenHarmony Fuzz 镜像");
expect(prepareScript.includes("Dockerfile.agent-openharmony"), "prepare 脚本必须使用 OpenHarmony Test Dockerfile");
expect(prepareScript.includes("Dockerfile.agent-openharmony-audit"), "prepare 脚本必须使用 OpenHarmony Audit Dockerfile");
expect(prepareScript.includes("Dockerfile.agent-openharmony-fuzz"), "prepare 脚本必须使用 OpenHarmony Fuzz Dockerfile");
expect(prepareScript.includes('"deepsonar-base:local"'), "OpenHarmony 构建必须在 base 流程之后使用本地 base");
expect(releaseWorkflow.includes("openharmony-test:"), "release workflow 缺少 OpenHarmony Test 独立 job");
expect(releaseWorkflow.includes("openharmony-audit:"), "release workflow 缺少 OpenHarmony Audit 独立 job");
expect(releaseWorkflow.includes("openharmony-fuzz:"), "release workflow 缺少 OpenHarmony Fuzz 独立 job");
expect(releaseWorkflow.includes("needs: base-image"), "OpenHarmony job 必须依赖 base-image job");
expect(releaseWorkflow.includes("Dockerfile.agent-openharmony"), "release workflow 未发布 OpenHarmony Test Dockerfile");
expect(releaseWorkflow.includes("Dockerfile.agent-openharmony-audit"), "release workflow 未发布 OpenHarmony Audit Dockerfile");
expect(releaseWorkflow.includes("Dockerfile.agent-openharmony-fuzz"), "release workflow 未发布 OpenHarmony Fuzz Dockerfile");
expect(releaseWorkflow.includes("steps.image.outputs.digest"), "release workflow 必须用统一 image digest（build 或 skip-reuse）");
expect(releaseWorkflow.includes("image-build-fingerprint.mjs"), "release workflow 必须计算构建指纹以支持未变更跳过");
expect(releaseWorkflow.includes("name: assets-helper") && releaseWorkflow.includes("Dockerfile.assets-helper"), "release workflow 必须按 app 镜像矩阵发布 deepsonar-assets-helper");
expect(releaseWorkflow.includes("name: silo") && releaseWorkflow.includes("Dockerfile.silo"), "release workflow 必须按 app 镜像矩阵发布 deepsonar-silo");
expect(PRESETS["deepsonar-assets-helper"]?.dockerfile === "deploy/Dockerfile.assets-helper" && PRESETS["deepsonar-assets-helper"]?.platforms === "linux/amd64", "assets-helper fingerprint preset 必须与 app 镜像一致");
expect(PRESETS["deepsonar-silo"]?.dockerfile === "deploy/Dockerfile.silo" && PRESETS["deepsonar-silo"]?.platforms === "linux/amd64", "silo fingerprint preset 必须与 app 镜像一致");
const assetsHelperDockerfile = readFileSync(new URL("../deploy/Dockerfile.assets-helper", import.meta.url), "utf8");
const siloDockerfile = readFileSync(new URL("../deploy/Dockerfile.silo", import.meta.url), "utf8");
const sharedAssetsVolume = readFileSync(new URL("../packages/runtime-sandbox/src/shared-assets-volume.ts", import.meta.url), "utf8");
const deployScript = readFileSync(new URL("../deploy/deploy.sh", import.meta.url), "utf8");
const busyboxHelperPin = "docker.io/library/busybox@sha256:fc6dddc4c44b1bfe37f41cae8e67d1693828e8f42a91862816d7953e2c9d3f23";
const siloPinTag = "docker.io/pgsty/silo:RELEASE.2026-08-06T00-00-00Z";
const siloPinDigest = "docker.io/pgsty/silo@sha256:29a498b24669cae1fed11c1a2fb2b3d73c68829a0a9c0b14e71b386671d38fac";
expect(assetsHelperDockerfile.includes(`FROM ${busyboxHelperPin}`), "assets-helper Dockerfile 必须 FROM 当前 busybox pin");
expect(siloDockerfile.includes(`FROM ${siloPinDigest}`) && siloDockerfile.includes(siloPinTag), "silo Dockerfile 必须 FROM 已解析的上游 pin，并注明对应 Release tag");
expect(sharedAssetsVolume.includes(busyboxHelperPin), "runtime 默认 helper 在官方 digest 发布前必须仍是 busybox pin");
expect(deployScript.includes("${IMAGE_REGISTRY}/deepsonar-assets-helper:${IMAGE_TAG}") && deployScript.includes(busyboxHelperPin), "deploy.sh 必须优先拉官方 helper 并在缺失时回退 busybox pin");
expect(deployScript.includes("${IMAGE_REGISTRY}/deepsonar-silo:${IMAGE_TAG}") && deployScript.includes(siloPinTag), "deploy.sh 必须优先拉官方 Silo 并在缺失时回退当前 pgsty tag");
expect(releaseWorkflow.includes("resolve-image-src-cache.sh"), "release workflow 必须解析 GHCR src-* 内容寻址缓存");
expect(releaseWorkflow.includes("steps.resolve.outputs.skip"), "release workflow 必须在构建输入未变时跳过 rebuild");
expect(releaseWorkflow.includes("record-runtime-image-digest.mjs"), "release workflow 缺少 digest artifact 记录脚本");
expect(ciWorkflow.includes("image-build-fingerprint.mjs"), "ci workflow 必须计算构建指纹以支持未变更跳过");
expect(ciWorkflow.includes("resolve-image-src-cache.sh"), "ci workflow 必须解析 GHCR src-* 内容寻址缓存");
expect(releaseWorkflow.includes("DOCKER_METADATA_ANNOTATIONS_LEVELS"), "release workflow 必须生成 OCI manifest/index annotations");
expect(releaseWorkflow.includes("steps.meta.outputs.annotations"), "release workflow 必须把 metadata annotations 传给 build-push-action");
expect((releaseWorkflow.match(/^\s{10}annotations: \|$/gm) ?? []).length >= 6, "runtime metadata 必须显式生成镜像专属 OCI annotations");
expect(releaseWorkflow.includes("index:org.opencontainers.image.description=DeepSonar Test"), "Kali multi-arch index 缺少 GHCR 包说明 annotation");
expect(descriptorScript.includes("inspectPublishedImageSize"), "release descriptor 必须采集 OCI 多架构镜像大小");
expect(descriptorScript.includes("platform_size_bytes"), "release descriptor 必须保留各平台大小证据");
expect(descriptorScript.includes("platform_digests"), "release descriptor 必须保留各平台 child digest");
expect(registryScript.includes("expandDescriptorVersions") || registryScript.includes("一平台一版本"), "runtime registry 必须按平台展开版本");
expect(registryScript.includes("platforms.length !== 1") || registryScript.includes("恰好包含一个 platform"), "runtime registry 校验必须要求一平台一版本");
expect(schedulerRuntimeImages.includes("releases/latest/download/runtime-image-registry.json"), "Scheduler 必须从固定官方 latest Release 同步清单");
expect(schedulerRuntimeImages.includes("image.versions.length > 0"), "正式清单已有版本时不能被环境变量旧版本覆盖");
expect(schedulerRuntimeImages.includes("SET promoted_at = NULL"), "同步最新版本后必须取消旧版本默认 promoted 状态");
const runtimeImageListRoute = schedulerRuntimeImageRoutes.slice(
  schedulerRuntimeImageRoutes.indexOf('app.get("/runtime-images"'),
  schedulerRuntimeImageRoutes.indexOf('app.get("/runtime-images/registry"'),
);
const trustPriorityIndex = runtimeImageListRoute.indexOf("ORDER BY CASE v.trust_status");
const platformPriorityIndex = runtimeImageListRoute.indexOf("WHEN v.platforms_json @>");
expect(trustPriorityIndex >= 0 && platformPriorityIndex > trustPriorityIndex, "/runtime-images 最新版本必须先按可信状态排序，再优先 Scheduler 宿主平台");
expect(releaseWorkflow.includes("actions/upload-artifact@v4"), "release workflow 缺少 digest/registry artifact");
expect(releaseWorkflow.includes("generate-runtime-image-registry.mjs"), "release workflow 缺少 runtime registry 合并脚本");
expect(releaseWorkflow.includes("deploy/runtime-image-registry.json"), "release workflow 未发布 runtime registry");
expect(releaseWorkflow.includes("回写 bundled 清单到默认分支"), "release workflow 必须在发布后回写 deploy/runtime-image-registry.json");
expect(releaseWorkflow.includes('env_file="deploy/.env.example"'), "release workflow 必须同步 deploy/.env.example");
expect(releaseWorkflow.includes('DEEPSONAR_IMAGE_TAG=[^[:space:]]+'), "release workflow 必须校验 DEEPSONAR_IMAGE_TAG 配置行");
expect(releaseWorkflow.includes('[[ "$VERSION" =~ ^[0-9][^[:space:]]*$ ]]'), "release workflow 必须校验 ACR 标签使用无 v 的数字版本");
expect(releaseWorkflow.includes('print "DEEPSONAR_IMAGE_TAG=" ENVIRON["VERSION"]'), "release workflow 必须把 ACR 镜像标签同步为无 v 的 VERSION");
expect(releaseWorkflow.includes('git add -- "$registry_file" "$env_file"'), "release workflow 必须同时暂存 runtime registry 和 deploy/.env.example");
expect(releaseWorkflow.includes("group: release-runtime-images-${{ github.repository }}"), "release workflow 必须跨 tag 串行执行");
expect(releaseWorkflow.includes("cancel-in-progress: false"), "release workflow 不得取消正在执行的旧发布");
expect((releaseWorkflow.match(/timeout --foreground --signal=TERM --kill-after=1m 20m docker buildx imagetools create/g) ?? []).length >= 6, "所有跨 Registry imagetools 重试必须设置单次 20 分钟超时，并在 TERM 后 1 分钟强制结束");
expect((releaseWorkflow.match(/::warning::Docker Hub 标签发布失败/g) ?? []).length >= 6, "所有运行时镜像发布必须把 Docker Hub 复制失败降级为警告");
expect(
  (releaseWorkflow.match(/agent-harness\/select-runtime-platform-sources\.sh/g) ?? []).length >= 5 &&
    releaseWorkflow.includes('selected_sources_text="$(bash agent-harness/select-runtime-platform-sources.sh') &&
    releaseWorkflow.includes('mapfile -t selected_sources') &&
    !releaseWorkflow.includes('platform_args+=(--platform "$target_platforms")') &&
    !releaseWorkflow.includes('retry_imagetools_create --prefer-index=false "${platform_args[@]}"') &&
    (releaseWorkflow.match(/publish_tags false "\$GHCR_TAGS" "\$\{selected_sources\[@\]\}"/g) ?? []).length >= 5 &&
    (releaseWorkflow.match(/clean_digest="\$\(docker buildx imagetools inspect "\$canonical_tag"/g) ?? []).length >= 5 &&
    (releaseWorkflow.match(/publish_tags true "\$ACR_TAGS" "\$clean_source"/g) ?? []).length >= 5 &&
    (releaseWorkflow.match(/DIGEST: \$\{\{ steps\.publish\.outputs\.digest \}\}/g) ?? []).length >= 5,
  "version tags must share one clean runnable canonical digest while src tags retain provenance",
);
const chromeReleaseBlock = releaseWorkflow.slice(
  releaseWorkflow.indexOf("  chrome-images:"),
  releaseWorkflow.indexOf("  kali-minimal:"),
);
expect(
  chromeReleaseBlock.includes('mapfile -t amd64_sources < <(bash agent-harness/select-runtime-platform-sources.sh "$amd64_source" "linux/amd64")') &&
    chromeReleaseBlock.includes('mapfile -t arm64_sources < <(bash agent-harness/select-runtime-platform-sources.sh "$arm64_source" "linux/arm64")') &&
    chromeReleaseBlock.includes('source_refs=("${amd64_sources[0]}" "${arm64_sources[0]}")') &&
    chromeReleaseBlock.includes('retry_imagetools_create "${annotation_args[@]}" "${acr_tag_args[@]}" "$clean_source"') &&
    chromeReleaseBlock.includes('retry_imagetools_create "${annotation_args[@]}" "${dockerhub_tag_args[@]}" "$clean_source"') &&
    !chromeReleaseBlock.includes('retry_imagetools_create "${annotation_args[@]}" "${acr_tag_args[@]}" "${source_refs[@]}"'),
  "Chrome release must strip per-architecture attestations before canonical assembly and cross-registry copy",
);
expect(releaseWorkflow.includes('git push origin "HEAD:${DEFAULT_BRANCH}"') || releaseWorkflow.includes("git push origin \"HEAD:${DEFAULT_BRANCH}\""), "release workflow 必须把清单推送到默认分支");
expect(releaseWorkflow.includes("chore(release): sync runtime-image-registry.json"), "release workflow 回写提交信息必须可识别");
expect(releaseWorkflow.includes("kali-minimal:"), "release workflow 缺少 Kali 独立 job（避免多架构同作业 ENOSPC）");
expect(releaseWorkflow.includes("  mobile:") && releaseWorkflow.includes("Dockerfile.agent-mobile"), "release workflow 必须发布 Mobile 专项镜像");
expect(releaseWorkflow.includes("needs: [base-image, images, kali-minimal, openharmony-test, openharmony-audit, openharmony-fuzz, chrome-images, mobile]"), "runtime registry 与 Release 必须由同一个最终 job 发布");
for (const name of ["ALIYUN_REGISTRY", "ALIYUN_REGISTRY_NAMESPACE", "ALIYUN_REGISTRY_USERNAME", "ALIYUN_REGISTRY_PASSWORD"]) {
  expect(releaseWorkflow.includes(`secrets.${name}`), `release workflow 缺少 ACR Secret：${name}`);
}
expect(releaseWorkflow.includes("docker/login-action@v3"), "release workflow 缺少 registry 登录动作");
expect(releaseWorkflow.includes("set -euo pipefail"), "release workflow shell 必须启用严格模式");
expect(releaseWorkflow.includes('owner="${GITHUB_REPOSITORY_OWNER,,}"'), "release workflow 必须输出小写 repository owner");
expect(releaseWorkflow.includes("owner: ${{ steps.release.outputs.owner }}"), "base-image 必须暴露小写 owner job output");
expect(!releaseWorkflow.includes("needs.base-image.outputs.owner"), "依赖 job 不得使用可能为空的 base-image owner job output");
expect(releaseWorkflow.includes("steps.release.outputs.owner"), "各发布 job 必须在本 job 内使用小写 owner step output");
expect(releaseWorkflow.includes("解析 registry 命名空间"), "依赖 job 必须本地解析 registry 命名空间");
expect(releaseWorkflow.includes("steps.release.outputs.image_name"), "Kali job 必须在本 job 内生成完整 GHCR image_name");
expect(!releaseWorkflow.includes("github.repository_owner"), "release workflow 不得直接使用 github.repository_owner 拼接 OCI 引用");
// Issue #70 Slice B release/catalog gates.  Keep these checks static and
// credential-free so CI can prove the workflow cannot publish unchecked refs.
expect(openHarmonyRegistry.schema === "deepsonar.registry/v2" && openHarmonyRegistry.schema_version === 2, "bundled runtime catalog must be v2");
expect(openHarmonyRegistry.images.every((image) => image.versions.every((version) => Array.isArray(version.platforms) && version.platforms.length >= 2 || image.versions.length === 0)), "bundled v2 catalog must consolidate platforms");
expect(registryScript.includes("registry_records") && registryScript.includes("inspect_digest"), "v2 generator must require destination inspect evidence");
expect(registryScript.includes("registry_records must include ${channel} evidence"), "every release descriptor must carry all three channel outcomes");
expect(registryScript.includes("registry_evidence must contain exactly all three channels"), "v2 generator must require exactly three channel evidence entries");
expect(registryScript.includes("must contain exactly the ten official image keys"), "release/bundled registry checks must require all ten official products");
expect(schedulerRegistryContract.includes("assertKnownKeys") && schedulerRegistryContract.includes("project_opt_in must be boolean"), "Scheduler catalog parser must reject unknown fields and invalid project_opt_in types");
expect(schedulerRegistryContract.includes("RUNTIME_IMAGE_REGISTRY_AVAILABLE_PROVENANCE") && schedulerRegistryContract.includes("UNAVAILABLE_REASON_RE"), "Scheduler catalog parser must bound provenance and unavailable reasons");
expect(recordContractScript.includes("AVAILABLE_PROVENANCE") && recordContractScript.includes("REASON_RE"), "release record verifier must use fixed provenance and bounded reasons");
expect(descriptorScript.includes("inspectPublishedImageDigest") && descriptorScript.includes("canonical"), "release descriptor must gate every destination against canonical digest");
expect(descriptorScript.includes("buildRegistryRecord") && recordContractScript.includes("inspectedDigest"), "release descriptor must use the pure inspected-digest evidence contract");
expect(!releaseWorkflow.includes("crypto.createHash(\"sha256\").update(s)"), "release workflow must not hash raw JSON as a registry digest");
expect(releaseWorkflow.includes("DOCKERHUB_CONFIGURED") && releaseWorkflow.includes("ACR_CONFIGURED"), "release workflow must record optional channel availability explicitly");
expect(releaseWorkflow.includes("DOCKERHUB_UNAVAILABLE_REASON") && releaseWorkflow.includes("ACR_UNAVAILABLE_REASON"), "release workflow must summarize missing optional channels");
expect(releaseWorkflow.includes("inspectPublishedImageDigest") || releaseWorkflow.includes("imagetools inspect"), "release workflow must inspect destination digests");
expect(releaseWorkflow.includes("registry_records"), "release workflow must archive channel evidence");
expect((releaseWorkflow.match(/publish_tags true/g) ?? []).length >= 6, "cross-registry publish must use bounded retry");
expect((releaseWorkflow.match(/CHANNEL_PUBLISH_FAILED=true/g) ?? []).length >= 6, "every release image publish retry must fail closed");
expect((releaseWorkflow.match(/warning::Docker Hub/g) ?? []).length >= 6 && (releaseWorkflow.match(/exit 1/g) ?? []).length >= 6, "configured Docker Hub failure must fail the release");
expect(releaseWorkflow.includes("runtime-image-registry-v2.json"), "release must attach the validated v2 catalog asset");
expect(!openHarmonyRegistry.fallback && !openHarmonyRegistry.error && !openHarmonyRegistry.checked_at, "bundled catalog must not accept Scheduler-owned fallback/error/checked_at metadata");
const kaliDigestInspectIndex = releaseWorkflow.indexOf('digest="$(docker buildx imagetools inspect "$primary"');
const kaliImmutableCopyIndex = releaseWorkflow.indexOf('retry_imagetools_create "${annotation_args[@]}" "${dockerhub_tag_args[@]}" "$immutable_primary"');
expect(kaliDigestInspectIndex >= 0 && kaliImmutableCopyIndex > kaliDigestInspectIndex, "Kali Docker Hub copy must use a GHCR digest inspected before the cross-registry copy");
expect(!releaseWorkflow.includes('retry_imagetools_create "${annotation_args[@]}" "${dockerhub_tag_args[@]}" "$primary"'), "Kali Docker Hub copy must not use the mutable GHCR tag");

if (failures.length) {
  console.error(failures.map((item) => `- ${item}`).join("\n"));
  process.exit(1);
}
console.log(`运行时镜像定义一致（${[...Object.keys(config.toolsets), ...Object.keys(kaliConfig.toolsets), "openharmony-test", "openharmony-audit", "openharmony-fuzz", "chrome-audit", "chrome-test", "chrome-fuzz", "mobile"].join("、")}）`);
