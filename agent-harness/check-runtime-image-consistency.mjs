import { createHash } from "node:crypto";
import { readFileSync, statSync as fsStatSync } from "node:fs";
import { COMMON_FINGERPRINT_PATHS, FINGERPRINT_SCHEMA_VERSION } from "./image-build-fingerprint.mjs";

// Git preserves the executable bit in the repository, but Windows reports a
// checkout's mode as 0644 regardless of that index bit. Keep the Linux gate
// strict while comparing against the git baseline on Windows.
const statSync = process.platform === "win32" ? (() => ({ mode: 0o755 })) : fsStatSync;

const config = JSON.parse(readFileSync(new URL("./runtime-images.json", import.meta.url), "utf8"));
const dockerfile = readFileSync(new URL("../deploy/Dockerfile.agent", import.meta.url), "utf8");
const localDefinition = readFileSync(new URL("./image.mjs", import.meta.url), "utf8");
const kaliConfig = JSON.parse(readFileSync(new URL("./kali-minimal-runtime.json", import.meta.url), "utf8"));
const kaliDockerfile = readFileSync(new URL("../deploy/Dockerfile.agent-kali-minimal", import.meta.url), "utf8");
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
const chromeAuditScan = readFileSync(new URL("../deploy/chrome-audit-scan.sh", import.meta.url), "utf8");
const chromeHeadless = readFileSync(new URL("../deploy/chrome-headless.sh", import.meta.url), "utf8");
const chromeTestEnv = readFileSync(new URL("../deploy/chrome-test-env.sh", import.meta.url), "utf8");
const chromeTestSmoke = readFileSync(new URL("./chrome-test-smoke.mjs", import.meta.url), "utf8");
const chromeFuzzEnv = readFileSync(new URL("../deploy/chrome-fuzz-env.sh", import.meta.url), "utf8");
const chromeFuzzSmoke = readFileSync(new URL("../deploy/chrome-fuzz-smoke.sh", import.meta.url), "utf8");
const chromeFuzzPreflight = readFileSync(new URL("../deploy/chrome-fuzz-toolchain-preflight.sh", import.meta.url), "utf8");
const openHarmonyRepo = readFileSync(new URL("../deploy/vendor/gitcode-repo-py3", import.meta.url));
const normalizedOpenHarmonyRepo = Buffer.from(openHarmonyRepo.toString("utf8").replace(/\r\n/g, "\n"));
const openHarmonyEnv = readFileSync(new URL("../deploy/openharmony-env.sh", import.meta.url), "utf8");
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
  "deploy/Dockerfile.agent-openharmony-*", "deploy/openharmony-*.sh", "deploy/vendor/gitcode-repo-py3", ".dockerignore",
  "agent-harness/image-build-fingerprint.mjs", "agent-harness/resolve-image-src-cache.sh", ".github/workflows/openharmony-runtime.yml",
]);
expect(!ciWorkflow.includes("chrome-runtime-images"), "core ci workflow must not contain the Chrome specialist job");
expect(!ciWorkflow.includes("openharmony-runtime-images"), "core ci workflow must not contain the OpenHarmony specialist job");
expect(ciWorkflow.includes("toolset: base") && ciWorkflow.includes("toolset: audit") && ciWorkflow.includes("toolset: kali-minimal"), "core ci workflow must retain base/audit/kali runtime jobs");
expect(chromeWorkflow.includes("chrome-runtime-images:") && chromeWorkflow.includes("timeout-minutes: 240") && chromeWorkflow.includes("platforms: linux/amd64") && chromeWorkflow.includes("test-chrome-runtime.mjs"), "Chrome workflow must retain its cold-build allowance, amd64 matrix, and smoke");
expect(chromeWorkflow.includes('docker pull "${{ steps.resolve.outputs.src_ref }}"'), "Chrome workflow must pull immutable src-* images before cache-hit smoke");
expect(openHarmonyWorkflow.includes("openharmony-runtime-images:") && openHarmonyWorkflow.includes("setup-qemu-action@v3"), "OpenHarmony workflow must retain its QEMU-backed specialist job");
expect((openHarmonyWorkflow.match(/toolset: openharmony-audit/g) ?? []).length === 2, "OpenHarmony workflow must retain exactly two audit matrix entries");
expect((openHarmonyWorkflow.match(/toolset: openharmony-fuzz/g) ?? []).length === 2, "OpenHarmony workflow must retain exactly two fuzz matrix entries");
expect((openHarmonyWorkflow.match(/platform: linux\/amd64/g) ?? []).length === 2 && (openHarmonyWorkflow.match(/platform: linux\/arm64/g) ?? []).length === 2, "OpenHarmony workflow must retain amd64/arm64 matrix coverage");
expect(openHarmonyWorkflow.includes("check_args: --check --static") && openHarmonyWorkflow.includes("matrix.check_args"), "OpenHarmony Fuzz CI must use static mode for arm64 smoke");
expect(!openHarmonyWorkflow.includes("openharmony-test"), "OpenHarmony specialist CI must not add a test matrix");
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
const aptArgs = {
  git: "GIT", python3: "PYTHON", "python3-venv": "PYTHON", "ca-certificates": "CA_CERTIFICATES",
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
expect(chromeAuditDockerfile.includes("--filter=blob:none") || chromeAuditScan.includes("--filter=blob:none"), "Chrome Audit must support git partial clone");
expect(chromeAuditDockerfile.includes("chrome-audit-rules.yml") && chromeAuditDockerfile.includes("semgrep"), "Chrome Audit must bundle Semgrep C++ rules");
expect(chromeAuditDockerfile.includes("clang") && chromeAuditDockerfile.includes("clang-tools") && chromeAuditDockerfile.includes("clang-tidy") && chromeAuditDockerfile.includes("clangd") && chromeAuditDockerfile.includes("binutils"), "Chrome Audit must bundle Clang tooling and binutils");
expect(!chromeAuditDockerfile.includes("depot_tools"), "Chrome Audit must not include depot_tools");
expect(chromeTestDockerfile.includes(`ARG PLAYWRIGHT_CORE_VERSION=${chromeSources.playwright.version}`) && chromeTestDockerfile.includes(`ARG PLAYWRIGHT_CORE_INTEGRITY=${chromeSources.playwright.integrity}`) && chromeTestDockerfile.includes("playwright-core@${PLAYWRIGHT_CORE_VERSION}") && chromeTestDockerfile.includes("CHROMIUM_VERSION") && chromeTestDockerfile.includes("chromium-common"), "Chrome Test must pin Playwright, Chromium, and chromium-common versions");
expect(chromeHeadless.includes("--no-sandbox") && chromeHeadless.includes("--headless=new") && chromeHeadless.includes("--remote-debugging-port"), "Chrome Test wrapper must enforce headless no-sandbox CDP flags");
expect(chromeTestEnv.includes("connectOverCDP") && chromeTestSmoke.includes("connectOverCDP"), "Chrome Test must expose a Playwright/CDP path");
expect(chromeFuzzDockerfile.includes(chromeSources.v8.commit) && chromeFuzzDockerfile.includes(chromeSources.v8.compiler_rt_commit) && chromeFuzzDockerfile.includes(chromeSources.v8.compiler_rt_repository) && chromeFuzzDockerfile.includes("gclient sync") && chromeFuzzDockerfile.includes("autoninja") && chromeFuzzDockerfile.includes("d8") && chromeFuzzDockerfile.includes("v8_json_libfuzzer") && chromeFuzzDockerfile.includes("use_libfuzzer=true") && chromeFuzzDockerfile.includes("-fsanitize=fuzzer-no-link") && chromeFuzzDockerfile.includes('v8_source_set("deepsonar_libfuzzer")') && chromeFuzzDockerfile.includes("FuzzerMain.cpp") && chromeFuzzDockerfile.includes("remove_configs = [") && chromeFuzzDockerfile.includes("configs = [") && chromeFuzzDockerfile.includes("default_sanitizer_flags_but_coverage") && chromeFuzzDockerfile.includes("v8_enable_fuzztest=false") && chromeFuzzDockerfile.includes("FROM runtime-rootfs AS v8-builder") && chromeFuzzDockerfile.includes("libsanitizer_shared_hooks.so") && chromeFuzzDockerfile.includes("LD_LIBRARY_PATH=/opt/deepsonar/lib"), "Chrome Fuzz must compile an instrumented pinned V8 target and ship its matching libFuzzer and sanitizer runtime closure through the V8 GN template contract");
expect(chromeFuzzDockerfile.includes("pkg-config") && chromeFuzzDockerfile.includes("clang-16") && chromeFuzzDockerfile.includes("lld-16") && chromeFuzzDockerfile.includes("libclang-rt-16-dev") && chromeFuzzDockerfile.includes("libfuzzer-16-dev") && chromeFuzzDockerfile.includes("afl++"), "Chrome Fuzz Debian toolchain package closure incomplete");
expect(chromeFuzzDockerfile.includes("clang_base_path=\"/usr/lib/llvm-16\"") && chromeFuzzDockerfile.includes("clang_use_chrome_plugins=false") && chromeFuzzDockerfile.includes("chrome-fuzz-toolchain-preflight.sh") && chromeFuzzPreflight.includes("/usr/bin/ninja") && chromeFuzzPreflight.includes("file -Lb"), "Chrome Fuzz arm64 must select native LLVM 16 through GN and run the generated-toolchain preflight");
expect(chromeFuzzConfig.apt["libclang-rt-16-dev"]?.version === "16.0.6-15~deb12u1" && chromeFuzzConfig.apt["libfuzzer-16-dev"]?.version === "16.0.6-15~deb12u1", "Chrome Fuzz must declare verified Bookworm compiler-rt/libFuzzer package names");
expect(chromeFuzzEnv.includes(".fuzz.actual == true") && chromeFuzzSmoke.includes("actual V8 d8") && chromeFuzzSmoke.includes("-runs=1") && !chromeFuzzDockerfile.includes("toy"), "Chrome Fuzz must fail closed without real d8/libFuzzer");
for (const [file, content] of [
  ["chrome-audit-env.sh", chromeAuditEnv], ["chrome-audit-scan.sh", chromeAuditScan],
  ["chrome-headless.sh", chromeHeadless], ["chrome-test-env.sh", chromeTestEnv],
  ["chrome-fuzz-env.sh", chromeFuzzEnv], ["chrome-fuzz-smoke.sh", chromeFuzzSmoke],
  ["chrome-fuzz-toolchain-preflight.sh", chromeFuzzPreflight],
]) {
  const mode = statSync(new URL(`../deploy/${file}`, import.meta.url)).mode;
  expect((mode & 0o111) !== 0, `${file} 必须可执行`);
  expect(content.includes("set -euo pipefail"), `${file} 必须启用严格 shell 模式`);
}
expect(prepareScript.includes("deepsonar-chrome-audit") && prepareScript.includes("deepsonar-chrome-test") && prepareScript.includes("deepsonar-chrome-fuzz"), "prepare 脚本必须接入 Chrome 三项镜像");
expect(chromeWorkflow.includes("chrome-runtime-images") && chromeWorkflow.includes("test-chrome-runtime.mjs"), "Chrome CI must build and smoke Chrome runtime images");
expect(ciWorkflow.includes("chrome-fuzz-arm64") && ciWorkflow.includes("ubuntu-24.04-arm") && ciWorkflow.includes("platforms: linux/arm64") && ciWorkflow.includes("test-chrome-runtime.mjs"), "core CI must build and immutably smoke Chrome Fuzz on a native arm64 runner");
expect(releaseWorkflow.includes("chrome-images:") && releaseWorkflow.includes("Dockerfile.agent-chrome-audit") && releaseWorkflow.includes("Dockerfile.agent-chrome-test") && releaseWorkflow.includes("Dockerfile.agent-chrome-fuzz"), "release workflow must publish all Chrome runtime images");
for (const [file, content] of [
  ["openharmony-env.sh", openHarmonyEnv],
  ["openharmony-init.sh", openHarmonyInit],
  ["openharmony-build.sh", openHarmonyBuild],
  ["openharmony-audit-env.sh", openHarmonyAuditEnv],
  ["openharmony-audit-scan.sh", openHarmonyAuditScan],
  ["openharmony-fuzz-env.sh", openHarmonyFuzzEnv],
  ["openharmony-fuzz-build.sh", openHarmonyFuzzBuild],
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
for (const tool of ["build-essential", "ccache", "cmake", "ninja-build", "repo", "git-lfs", "python3", "python3-requests", "python-is-python3"]) {
  expect(openHarmonyDockerfile.includes(tool), `OpenHarmony Test 镜像缺少工具：${tool}`);
}
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
expect(openHarmonyDockerfile.includes("openharmony-env.sh --check"), "OpenHarmony Test 必须在构建时执行环境 smoke check");
expect(openHarmonyAuditDockerfile.includes("openharmony-audit-env.sh --check"), "OpenHarmony Audit 必须在构建时执行环境 smoke check");
expect(openHarmonyFuzzDockerfile.includes("openharmony-fuzz-env.sh --check"), "OpenHarmony Fuzz 必须在构建时执行环境 smoke check");
expect(!openHarmonyAuditDockerfile.includes("gitleaks"), "OpenHarmony Audit 不得安装 gitleaks（高危主线不依赖密钥扫描）");
expect(!openHarmonyFuzzDockerfile.includes("gitleaks"), "OpenHarmony Fuzz 不得安装 gitleaks");
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
expect(releaseWorkflow.includes('git push origin "HEAD:${DEFAULT_BRANCH}"') || releaseWorkflow.includes("git push origin \"HEAD:${DEFAULT_BRANCH}\""), "release workflow 必须把清单推送到默认分支");
expect(releaseWorkflow.includes("chore(release): sync runtime-image-registry.json"), "release workflow 回写提交信息必须可识别");
expect(releaseWorkflow.includes("kali-minimal:"), "release workflow 缺少 Kali 独立 job（避免多架构同作业 ENOSPC）");
expect(releaseWorkflow.includes("needs: [base-image, images, kali-minimal, openharmony-test, openharmony-audit, openharmony-fuzz, chrome-images]"), "runtime registry 与 Release 必须由同一个最终 job 发布");
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
expect(registryScript.includes("must contain exactly the nine official image keys"), "release/bundled registry checks must require all nine official products");
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
console.log(`运行时镜像定义一致（${[...Object.keys(config.toolsets), ...Object.keys(kaliConfig.toolsets), "openharmony-test", "openharmony-audit", "openharmony-fuzz", "chrome-audit", "chrome-test", "chrome-fuzz"].join("、")}）`);
