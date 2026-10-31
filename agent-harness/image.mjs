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
    ...Object.entries(config.npm).filter(([, entry]) => enabled(entry)).map(([name, entry]) => ({ name, source: "npm", version: entry.version, license: entry.license, capabilities: entry.capabilities, ...(entry.agent_cli ? { agent_cli: entry.agent_cli, compatible_image_keys: entry.compatible_image_keys } : {}) })),
    ...Object.entries(config.downloads).filter(([, entry]) => enabled(entry)).map(([name, entry]) => ({ name, source: "download", version: entry.version, license: entry.license, capabilities: entry.capabilities, assets: entry.assets })),
    ...Object.entries(config.piExtensions ?? {}).filter(([, entry]) => enabled(entry)).map(([name, entry]) => ({ name, source: "npm", version: entry.version, license: entry.license, capabilities: entry.capabilities, pi_extension: true, compatible_image_keys: entry.compatible_image_keys })),
  ],
};
manifest.sha256 = `sha256:${createHash("sha256").update(JSON.stringify(manifest)).digest("hex")}`;

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
    ...Object.entries(config.piExtensions ?? {}).filter(([, entry]) => enabled(entry)).map(([, entry]) =>
      `mkdir -p /opt/deepsonar/pi-extensions && test "$(npm view ${entry.package}@${entry.version} dist.integrity)" = "${entry.integrity}" && npm install --omit=dev --no-audit --no-fund --prefix /opt/deepsonar/pi-extensions ${entry.package}@${entry.version} && npm cache clean --force`
    ),
    `mkdir -p /opt/deepsonar && node -e 'require("node:fs").writeFileSync("/opt/deepsonar/tool-manifest.json", Buffer.from(process.argv[1], "base64"))' '${Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`).toString("base64")}'`,
  ],
  workdir: "/workspace",
  cmd: ["sleep", "infinity"],
};
