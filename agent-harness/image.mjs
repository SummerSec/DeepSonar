// DeepSonar Agentbox local image definition. The same runtime-images.json drives
// deploy/Dockerfile.agent; CI rejects version/checksum drift between the two paths.
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";

const config = JSON.parse(readFileSync(new URL("./runtime-images.json", import.meta.url), "utf8"));
const toolset = process.env.DEEPSONAR_IMAGE_TOOLSET ?? "audit";
if (!config.toolsets[toolset]) throw new Error(`DEEPSONAR_IMAGE_TOOLSET must be base or audit, got ${toolset}`);
const enabled = (entry) => !entry.toolsets || entry.toolsets.includes(toolset);
const aptPackages = Object.entries(config.apt).filter(([, entry]) => enabled(entry)).map(([name, entry]) => `${name}=${entry.version}`);
const npmPackages = Object.entries(config.npm).filter(([, entry]) => enabled(entry)).map(([name, entry]) => `${name}@${entry.version}`);
const manifest = {
  contract: config.contract,
  image_key: config.toolsets[toolset].imageKey,
  toolset,
  platforms: config.platforms,
  tools: [
    ...Object.entries(config.apt).filter(([, entry]) => enabled(entry)).map(([name, entry]) => ({ name, source: "debian:bookworm", version: entry.version, license: entry.license, capabilities: entry.capabilities })),
    ...Object.entries(config.npm).filter(([, entry]) => enabled(entry)).map(([name, entry]) => ({ name, source: "npm", version: entry.version, license: entry.license, capabilities: entry.capabilities })),
    ...Object.entries(config.downloads).filter(([, entry]) => enabled(entry)).map(([name, entry]) => ({ name, source: "download", version: entry.version, license: entry.license, capabilities: entry.capabilities, assets: entry.assets })),
  ],
};
manifest.sha256 = `sha256:${createHash("sha256").update(JSON.stringify(manifest)).digest("hex")}`;
const auditInstall = toolset === "audit" ? String.raw`
arch="$(dpkg --print-architecture)"; case "$arch" in amd64) ds_arch=amd64;; arm64) ds_arch=arm64;; *) echo "unsupported architecture: $arch" >&2; exit 1;; esac; \
mkdir -p /opt/deepsonar/downloads /opt/deepsonar/semgrep; \
node -e 'const c=require("/tmp/runtime-images.json");const a=c.downloads;const arch=process.argv[1];for(const [n,v] of Object.entries(a)){console.log([n,v.assets[arch].url,v.assets[arch].sha256].join("\t"))}' "$ds_arch" > /tmp/downloads.tsv; \
while IFS="$(printf '\t')" read -r name url sum; do curl -fsSL "$url" -o "/opt/deepsonar/downloads/$name"; echo "$sum  /opt/deepsonar/downloads/$name" | sha256sum -c -; done < /tmp/downloads.tsv; \
python3 -m venv /opt/deepsonar/semgrep && /opt/deepsonar/semgrep/bin/pip install --no-cache-dir /opt/deepsonar/downloads/semgrep && ln -s /opt/deepsonar/semgrep/bin/semgrep /usr/local/bin/semgrep; \
tar -xzf /opt/deepsonar/downloads/gitleaks -C /usr/local/bin gitleaks; \
mkdir -p /tmp/shellcheck && tar -xJf /opt/deepsonar/downloads/shellcheck -C /tmp/shellcheck --strip-components=1 && install -m 0755 /tmp/shellcheck/shellcheck /usr/local/bin/shellcheck; \
rm -rf /opt/deepsonar/downloads /tmp/shellcheck /tmp/downloads.tsv` : "true";

export default {
  name: config.toolsets[toolset].imageKey,
  base: config.baseImage,
  labels: {
    "io.deepsonar.contract": config.contract,
    "io.deepsonar.toolset": toolset,
    "io.deepsonar.tools-manifest": "/opt/deepsonar/tool-manifest.json",
    "org.opencontainers.image.source": "https://github.com/SummerSec/DeepSonar",
  },
  env: { IS_SANDBOX: "1" },
  run: [
    `apt-get update && apt-get install -y --no-install-recommends ${aptPackages.join(" ")} && rm -rf /var/lib/apt/lists/*`,
    `npm install -g ${npmPackages.join(" ")} && npm cache clean --force`,
    `node -e 'require("node:fs").writeFileSync("/tmp/runtime-images.json", Buffer.from(process.argv[1], "base64"))' '${Buffer.from(JSON.stringify(config)).toString("base64")}' && ${auditInstall}`,
    `mkdir -p /opt/deepsonar && node -e 'require("node:fs").writeFileSync("/opt/deepsonar/tool-manifest.json", Buffer.from(process.argv[1], "base64"))' '${Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`).toString("base64")}' && rm -f /tmp/runtime-images.json`,
  ],
  workdir: "/workspace",
  cmd: ["sleep", "infinity"],
};
