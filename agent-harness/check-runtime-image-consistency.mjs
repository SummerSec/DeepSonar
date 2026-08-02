import { readFileSync } from "node:fs";

const config = JSON.parse(readFileSync(new URL("./runtime-images.json", import.meta.url), "utf8"));
const dockerfile = readFileSync(new URL("../deploy/Dockerfile.agent", import.meta.url), "utf8");
const localDefinition = readFileSync(new URL("./image.mjs", import.meta.url), "utf8");
const kaliConfig = JSON.parse(readFileSync(new URL("./kali-minimal-runtime.json", import.meta.url), "utf8"));
const kaliDockerfile = readFileSync(new URL("../deploy/Dockerfile.agent-kali-minimal", import.meta.url), "utf8");

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
expect(kaliDockerfile.includes(`ARG BASE_IMAGE=${kaliConfig.baseImage}`), "Kali minimal base image digest drift");
expect(kaliDockerfile.includes("FROM ${BASE_IMAGE}"), "Kali minimal Dockerfile must consume the pinned BASE_IMAGE arg");
expect(kaliDockerfile.includes(`ARG CLAUDE_CODE_VERSION=${kaliConfig.npm["@anthropic-ai/claude-code"].version}`), "Kali minimal Claude Code version drift");
for (const [name, entry] of Object.entries(kaliConfig.downloads)) {
  expect(kaliDockerfile.includes(`ARG ${name.toUpperCase()}_VERSION=${entry.version}`), `Kali minimal ${name} version drift`);
  for (const asset of Object.values(entry.assets)) expect(kaliDockerfile.includes(asset.sha256), `Kali minimal ${name} checksum missing: ${asset.sha256}`);
}
for (const forbidden of ["kali-linux-core", "kali-linux-headless", "kali-linux-default", "kali-linux-large", "kali-linux-everything", "kali-tools-"]) {
  expect(!kaliDockerfile.match(new RegExp(`apt-get install[^;]*${forbidden}`, "s")), `Kali minimal must not install metapackage ${forbidden}`);
}
expect(kaliDockerfile.includes("--no-install-recommends"), "Kali minimal apt install must disable recommends");
if (failures.length) {
  console.error(failures.map((item) => `- ${item}`).join("\n"));
  process.exit(1);
}
console.log(`runtime image definitions are consistent (${[...Object.keys(config.toolsets), ...Object.keys(kaliConfig.toolsets)].join(", ")})`);
