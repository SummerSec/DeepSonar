import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";

const config = JSON.parse(readFileSync(new URL("./runtime-images.json", import.meta.url), "utf8"));
const dockerfile = readFileSync(new URL("../deploy/Dockerfile.agent", import.meta.url), "utf8");
const localDefinition = readFileSync(new URL("./image.mjs", import.meta.url), "utf8");
const kaliConfig = JSON.parse(readFileSync(new URL("./kali-minimal-runtime.json", import.meta.url), "utf8"));
const kaliDockerfile = readFileSync(new URL("../deploy/Dockerfile.agent-kali-minimal", import.meta.url), "utf8");
const openHarmonyDockerfile = readFileSync(new URL("../deploy/Dockerfile.agent-openharmony", import.meta.url), "utf8");
const openHarmonyRepo = readFileSync(new URL("../deploy/vendor/gitcode-repo-py3", import.meta.url));
const openHarmonyEnv = readFileSync(new URL("../deploy/openharmony-env.sh", import.meta.url), "utf8");
const openHarmonyInit = readFileSync(new URL("../deploy/openharmony-init.sh", import.meta.url), "utf8");
const openHarmonyBuild = readFileSync(new URL("../deploy/openharmony-build.sh", import.meta.url), "utf8");
const openHarmonyRegistry = JSON.parse(readFileSync(new URL("../deploy/runtime-image-registry.json", import.meta.url), "utf8"));
const prepareScript = readFileSync(new URL("../deploy/prepare-runtime-images.sh", import.meta.url), "utf8");
const releaseWorkflow = readFileSync(new URL("../.github/workflows/release.yml", import.meta.url), "utf8");
const descriptorScript = readFileSync(new URL("./record-runtime-image-digest.mjs", import.meta.url), "utf8");
const registryScript = readFileSync(new URL("./generate-runtime-image-registry.mjs", import.meta.url), "utf8");
const schedulerRuntimeImages = readFileSync(new URL("../apps/scheduler/src/runtime-images.ts", import.meta.url), "utf8");

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
    expect(dockerfile.includes(asset.sha256), `${name} asset checksum missing: ${asset.sha256}`);
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
}
expect(kaliDockerfile.includes(`ARG BASE_IMAGE=${kaliConfig.baseImage}`), "Kali minimal base image digest drift");
expect(kaliDockerfile.includes("FROM ${BASE_IMAGE}"), "Kali minimal Dockerfile must consume the pinned BASE_IMAGE arg");
expect(kaliDockerfile.includes(`ARG CLAUDE_CODE_VERSION=${kaliConfig.npm["@anthropic-ai/claude-code"].version}`), "Kali minimal Claude Code version drift");
for (const [name, entry] of Object.entries(kaliConfig.downloads)) {
  expect(kaliDockerfile.includes(`ARG ${name.toUpperCase()}_VERSION=${entry.version}`), `Kali minimal ${name} version drift`);
  for (const asset of Object.values(entry.assets)) expect(kaliDockerfile.includes(asset.sha256), `Kali minimal ${name} checksum missing: ${asset.sha256}`);
}
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
const openHarmonyImage = openHarmonyRegistry.images?.find((image) => image.image_key === "deepsonar-openharmony-test");
expect(openHarmonyImage, "registry 缺少 deepsonar-openharmony-test");
if (openHarmonyImage) {
  expect(openHarmonyImage.source_kind === "official", "OpenHarmony 镜像必须是 official");
  expect(openHarmonyImage.project_opt_in === true, "OpenHarmony 镜像必须启用 project_opt_in");
  expect(openHarmonyImage.default_role === "test", "OpenHarmony 镜像 default_role 必须是 test");
  expect(Array.isArray(openHarmonyImage.versions), "OpenHarmony registry versions 必须是数组");
}
for (const [file, content] of [
  ["openharmony-env.sh", openHarmonyEnv],
  ["openharmony-init.sh", openHarmonyInit],
  ["openharmony-build.sh", openHarmonyBuild],
]) {
  const mode = statSync(new URL(`../deploy/${file}`, import.meta.url)).mode;
  expect((mode & 0o111) !== 0, `${file} 必须可执行`);
  expect(content.includes("set -euo pipefail"), `${file} 必须启用严格 shell 模式`);
}
expect(openHarmonyDockerfile.includes("ARG BASE_IMAGE=deepsonar-base:local"), "OpenHarmony 必须默认依赖本地 base 镜像");
expect(openHarmonyDockerfile.includes("apt-get install -y --no-install-recommends"), "OpenHarmony apt 安装必须禁用 recommends");
for (const tool of ["build-essential", "ccache", "cmake", "ninja-build", "repo", "git-lfs", "python3", "python3-requests", "python-is-python3"]) {
  expect(openHarmonyDockerfile.includes(tool), `OpenHarmony 镜像缺少工具：${tool}`);
}
expect(openHarmonyDockerfile.includes("USER deepsonar"), "OpenHarmony 镜像必须使用非 root 用户");
expect(openHarmonyDockerfile.includes("WORKDIR /workspace"), "OpenHarmony 镜像工作目录必须是 /workspace");
expect(openHarmonyDockerfile.includes("/opt/deepsonar/tool-manifest.json"), "OpenHarmony 镜像必须生成 tool-manifest.json");
expect(openHarmonyDockerfile.includes("openharmony-env.sh --check"), "OpenHarmony 镜像必须在构建时执行环境 smoke check");
expect(openHarmonyDockerfile.includes("COPY deploy/vendor/gitcode-repo-py3 /tmp/repo"), "OpenHarmony 必须使用仓库内受控 repo launcher");
const openHarmonyRepoSha256 = "2410cfea0b746fa175acd7130116e3cab26fb2f1cb8107e7a030cd50b0f2c020";
expect(openHarmonyDockerfile.includes(openHarmonyRepoSha256), "OpenHarmony repo checksum 不匹配");
expect(createHash("sha256").update(openHarmonyRepo).digest("hex") === openHarmonyRepoSha256, "OpenHarmony vendored repo launcher checksum 不匹配");
expect(openHarmonyDockerfile.includes("sha256sum -c -"), "OpenHarmony repo 安装前必须执行 sha256sum 校验");
expect(!/curl[^\n]*(raw\.gitcode\.com|storage\.googleapis\.com|google\.com)/s.test(openHarmonyDockerfile), "OpenHarmony 构建期不得 curl GitCode Raw 或 Google");
expect(!openHarmonyDockerfile.includes("raw.gitcode.com"), "OpenHarmony 构建期不得依赖 GitCode Raw");
expect(!openHarmonyDockerfile.includes("storage.googleapis.com"), "OpenHarmony 不得从 storage.googleapis.com 下载 repo");
expect(!openHarmonyDockerfile.includes("google.com"), "OpenHarmony 构建期不得依赖 Google");
expect(openHarmonyDockerfile.includes("gitcode.com/openharmony/manifest.git"), "OpenHarmony 必须使用官方 GitCode manifest 默认地址");
expect(openHarmonyInit.includes("[[ \"$manifest\" == https://* ]]"), "OpenHarmony manifest 必须限制为 HTTPS");
expect(!openHarmonyInit.includes("eval ") && !openHarmonyBuild.includes("eval "), "OpenHarmony 入口不得使用 eval");
expect(openHarmonyBuild.includes('exec ./build.sh --product-name "$product_name" "${build_args[@]}"'), "OpenHarmony 构建参数必须严格传递");
expect(prepareScript.includes("deepsonar-openharmony-test"), "prepare 脚本必须接入 OpenHarmony 镜像");
expect(prepareScript.includes("Dockerfile.agent-openharmony"), "prepare 脚本必须使用 OpenHarmony Dockerfile");
expect(prepareScript.includes('"deepsonar-base:local"'), "OpenHarmony 构建必须在 base 流程之后使用本地 base");
expect(releaseWorkflow.includes("openharmony-test:"), "release workflow 缺少 OpenHarmony 独立 job");
expect(releaseWorkflow.includes("needs: base-image"), "OpenHarmony job 必须依赖 base-image job");
expect(releaseWorkflow.includes("Dockerfile.agent-openharmony"), "release workflow 未发布 OpenHarmony Dockerfile");
expect(releaseWorkflow.includes("steps.build.outputs.digest"), "release workflow 必须使用 build-push-action 真实 digest");
expect(releaseWorkflow.includes("record-runtime-image-digest.mjs"), "release workflow 缺少 digest artifact 记录脚本");
expect(releaseWorkflow.includes("DOCKER_METADATA_ANNOTATIONS_LEVELS"), "release workflow 必须生成 OCI manifest/index annotations");
expect(releaseWorkflow.includes("steps.meta.outputs.annotations"), "release workflow 必须把 metadata annotations 传给 build-push-action");
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
expect(releaseWorkflow.includes("needs: [base-image, images, kali-minimal, openharmony-test]"), "runtime registry 与 Release 必须由同一个最终 job 发布");
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
console.log(`运行时镜像定义一致（${[...Object.keys(config.toolsets), ...Object.keys(kaliConfig.toolsets), "openharmony-test"].join("、")}）`);
