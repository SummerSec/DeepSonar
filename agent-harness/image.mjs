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
// npm verifies archive bytes against the resolved lock integrity. Check that
// exact lock identity after an install with lifecycle scripts disabled; a
// pre-install metadata comparison alone would leave a registry race.
export const OM_INSTALL_IDENTITY_CHECK = 'const fs=require("node:fs"),root=process.argv[3]||"/opt/deepsonar/pi-extensions",p=JSON.parse(fs.readFileSync(root+"/package-lock.json")).packages["node_modules/pi-observational-memory"],installed=JSON.parse(fs.readFileSync(root+"/node_modules/pi-observational-memory/package.json")); if(p?.version!==process.argv[1]||p?.integrity!==process.argv[2]||p?.resolved!=="https://registry.npmjs.org/pi-observational-memory/-/pi-observational-memory-"+process.argv[1]+".tgz"||installed.name!=="pi-observational-memory"||installed.version!==process.argv[1]||installed.license!=="MIT"||!fs.existsSync(root+"/node_modules/pi-observational-memory/src/index.ts")) throw new Error("PI_OM_INSTALL_IDENTITY_MISMATCH");';
const wrapperTools = Object.entries(config.piExtensionWrappers ?? {}).filter(([, entry]) => enabled(entry)).map(([name, entry]) => {
  const source = new URL(`../${entry.source}`, import.meta.url);
  const tool = {
    name,
    source: "repository-wrapper",
    source_path: entry.source,
    wrapper_path: entry.path,
    version: entry.version,
    license: entry.license,
    capabilities: entry.capabilities,
    compatible_image_keys: entry.compatible_image_keys,
    pi_extension_wrapper: true,
  };
  tool.sha256 = createHash("sha256").update(readFileSync(source)).digest("hex");
  return tool;
});
const manifest = {
  contract: config.contract,
  image_key: config.toolsets[toolset].imageKey,
  toolset,
  platforms: config.platforms,
  tools: [
    ...Object.entries(config.apt).filter(([, entry]) => enabled(entry)).map(([name, entry]) => ({ name, source: "debian:bookworm", version: entry.version, license: entry.license, capabilities: entry.capabilities })),
    ...Object.entries(config.npm).filter(([, entry]) => enabled(entry)).map(([name, entry]) => ({ name, source: "npm", version: entry.version, license: entry.license, capabilities: entry.capabilities, ...(entry.agent_cli ? { agent_cli: entry.agent_cli, compatible_image_keys: entry.compatible_image_keys } : {}) })),
    ...Object.entries(config.downloads).filter(([, entry]) => enabled(entry)).map(([name, entry]) => ({ name, source: "download", version: entry.version, license: entry.license, capabilities: entry.capabilities, assets: entry.assets })),
    ...Object.entries(config.piExtensions ?? {}).filter(([, entry]) => enabled(entry)).map(([name, entry]) => ({ name, source: "npm", package: entry.package, version: entry.version, integrity: entry.integrity, entry: entry.entry, license: entry.license, capabilities: entry.capabilities, pi_extension: true, compatible_image_keys: entry.compatible_image_keys, requires_egress: entry.requires_egress === true, requires_gateway: entry.requires_gateway === true })),
    ...wrapperTools,
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
    ...Object.entries(config.piExtensions ?? {}).filter(([, entry]) => enabled(entry)).map(([name, entry]) =>
      `mkdir -p /opt/deepsonar/pi-extensions && test "$(npm view ${entry.package}@${entry.version} dist.integrity)" = "${entry.integrity}" && npm install --omit=dev ${name === "pi-observational-memory" ? "--ignore-scripts --save-exact " : ""}--no-audit --no-fund --prefix /opt/deepsonar/pi-extensions ${entry.package}@${entry.version}${name === "pi-observational-memory" ? ` && node -e '${OM_INSTALL_IDENTITY_CHECK}' '${entry.version}' '${entry.integrity}'` : ""} && npm cache clean --force`
    ),
    ...Object.entries(config.piExtensionWrappers ?? {}).filter(([, entry]) => enabled(entry)).map(([, entry]) =>
      `mkdir -p /opt/deepsonar/pi-extensions && node -e 'require("node:fs").writeFileSync(process.argv[2], Buffer.from(process.argv[1], "base64"))' '${readFileSync(new URL(`../${entry.source}`, import.meta.url)).toString("base64")}' '${entry.path}'`
    ),
    `mkdir -p /opt/deepsonar && node -e 'require("node:fs").writeFileSync("/opt/deepsonar/tool-manifest.json", Buffer.from(process.argv[1], "base64"))' '${Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`).toString("base64")}'`,
  ],
  workdir: "/workspace",
  cmd: ["sleep", "infinity"],
};
