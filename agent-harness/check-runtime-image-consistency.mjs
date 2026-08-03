import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";

const config = JSON.parse(readFileSync(new URL("./runtime-images.json", import.meta.url), "utf8"));
const dockerfile = readFileSync(new URL("../deploy/Dockerfile.agent", import.meta.url), "utf8");
const localDefinition = readFileSync(new URL("./image.mjs", import.meta.url), "utf8");
const kaliConfig = JSON.parse(readFileSync(new URL("./kali-minimal-runtime.json", import.meta.url), "utf8"));
const kaliDockerfile = readFileSync(new URL("../deploy/Dockerfile.agent-kali-minimal", import.meta.url), "utf8");
const openHarmonyDockerfile = readFileSync(new URL("../deploy/Dockerfile.agent-openharmony", import.meta.url), "utf8");
const openHarmonyAuditDockerfile = readFileSync(new URL("../deploy/Dockerfile.agent-openharmony-audit", import.meta.url), "utf8");
const openHarmonyFuzzDockerfile = readFileSync(new URL("../deploy/Dockerfile.agent-openharmony-fuzz", import.meta.url), "utf8");
const openHarmonyRepo = readFileSync(new URL("../deploy/vendor/gitcode-repo-py3", import.meta.url));
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
const registryScript = readFileSync(new URL("./generate-runtime-image-registry.mjs", import.meta.url), "utf8");
const schedulerRuntimeImages = readFileSync(new URL("../apps/scheduler/src/runtime-images.ts", import.meta.url), "utf8");
const runtimeSmoke = readFileSync(new URL("./test-runtime-image.mjs", import.meta.url), "utf8");
const mavenSmoke = readFileSync(new URL("./test-maven-package.mjs", import.meta.url), "utf8");
const ciWorkflow = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");

const failures = [];
const expect = (condition, message) => { if (!condition) failures.push(message); };
expect(localDefinition.includes('runtime-images.json'), "agent-harness/image.mjs must consume runtime-images.json");
expect(dockerfile.includes(`ARG BASE_IMAGE=${config.baseImage}`), "Dockerfile.agent base image differs from runtime-images.json");
expect(dockerfile.includes("FROM ${BASE_IMAGE}"), "Dockerfile.agent must consume the pinned BASE_IMAGE arg");
expect(dockerfile.includes(`ARG CLAUDE_CODE_VERSION=${config.npm["@anthropic-ai/claude-code"].version}`), "Claude Code version drift");
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
expect(ciWorkflow.includes("test-maven-package.mjs"), "CI must run the Maven package smoke");
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
expect(createHash("sha256").update(openHarmonyRepo).digest("hex") === openHarmonyRepoSha256, "OpenHarmony vendored repo launcher checksum 不匹配");
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
expect(openHarmonyFuzzEnv.includes("ASAN_OPTIONS=detect_leaks=0") && openHarmonyFuzzEnv.includes('"$smoke_binary" -runs=1'), "OpenHarmony Fuzz check must run the sanitizer/libFuzzer smoke binary");
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
expect(releaseWorkflow.includes("steps.build.outputs.digest"), "release workflow 必须使用 build-push-action 真实 digest");
expect(releaseWorkflow.includes("record-runtime-image-digest.mjs"), "release workflow 缺少 digest artifact 记录脚本");
expect(releaseWorkflow.includes("DOCKER_METADATA_ANNOTATIONS_LEVELS"), "release workflow 必须生成 OCI manifest/index annotations");
expect(releaseWorkflow.includes("steps.meta.outputs.annotations"), "release workflow 必须把 metadata annotations 传给 build-push-action");
expect((releaseWorkflow.match(/^\s{10}annotations: \|$/gm) ?? []).length >= 6, "runtime metadata 必须显式生成镜像专属 OCI annotations");
expect(releaseWorkflow.includes("index:org.opencontainers.image.description=DeepSonar Test"), "Kali multi-arch index 缺少 GHCR 包说明 annotation");
expect(descriptorScript.includes("inspectPublishedImageSize"), "release descriptor 必须采集 OCI 多架构镜像大小");
expect(descriptorScript.includes("platform_size_bytes"), "release descriptor 必须保留各平台大小证据");
expect(registryScript.includes("size_bytes: descriptor.size_bytes"), "runtime registry 必须合并 descriptor size_bytes");
expect(schedulerRuntimeImages.includes("releases/latest/download/runtime-image-registry.json"), "Scheduler 必须从固定官方 latest Release 同步清单");
expect(schedulerRuntimeImages.includes("image.versions.length > 0"), "正式清单已有版本时不能被环境变量旧版本覆盖");
expect(schedulerRuntimeImages.includes("SET promoted_at = NULL"), "同步最新版本后必须取消旧版本默认 promoted 状态");
expect(releaseWorkflow.includes("actions/upload-artifact@v4"), "release workflow 缺少 digest/registry artifact");
expect(releaseWorkflow.includes("generate-runtime-image-registry.mjs"), "release workflow 缺少 runtime registry 合并脚本");
expect(releaseWorkflow.includes("deploy/runtime-image-registry.json"), "release workflow 未发布 runtime registry");
expect(releaseWorkflow.includes("kali-minimal:"), "release workflow 缺少 Kali 独立 job（避免多架构同作业 ENOSPC）");
expect(releaseWorkflow.includes("needs: [base-image, images, kali-minimal, openharmony-test, openharmony-audit, openharmony-fuzz]"), "runtime registry 与 Release 必须由同一个最终 job 发布");
for (const name of ["ALIYUN_REGISTRY", "ALIYUN_REGISTRY_NAMESPACE", "ALIYUN_REGISTRY_USERNAME", "ALIYUN_REGISTRY_PASSWORD"]) {
  expect(releaseWorkflow.includes(`secrets.${name}`), `release workflow 缺少 ACR Secret：${name}`);
}
expect(releaseWorkflow.includes("docker/login-action@v3"), "release workflow 缺少 registry 登录动作");
expect(releaseWorkflow.includes("set -euo pipefail"), "release workflow shell 必须启用严格模式");
expect(releaseWorkflow.includes('owner="${GITHUB_REPOSITORY_OWNER,,}"'), "release workflow 必须输出小写 repository owner");
expect(releaseWorkflow.includes("owner: ${{ steps.release.outputs.owner }}"), "base-image 必须暴露小写 owner job output");
expect(releaseWorkflow.includes("needs.base-image.outputs.owner"), "依赖 job 必须使用 base-image 小写 owner output");
expect(!releaseWorkflow.includes("github.repository_owner"), "release workflow 不得直接使用 github.repository_owner 拼接 OCI 引用");
if (failures.length) {
  console.error(failures.map((item) => `- ${item}`).join("\n"));
  process.exit(1);
}
console.log(`运行时镜像定义一致（${[...Object.keys(config.toolsets), ...Object.keys(kaliConfig.toolsets), "openharmony-test", "openharmony-audit", "openharmony-fuzz"].join("、")}）`);
