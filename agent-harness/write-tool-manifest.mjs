import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));

function readWrapperBytes(entry) {
  const candidates = [
    entry.path,
    resolve(scriptDirectory, "..", entry.source),
  ];
  const sourcePath = candidates.find((candidate) => existsSync(candidate));
  if (!sourcePath) {
    throw new Error(`wrapper source is missing: ${entry.source} (image path ${entry.path})`);
  }
  return readFileSync(sourcePath);
}

const [, , configPath, toolset = "base", outputPath] = process.argv;
if (!configPath || !outputPath) {
  throw new Error("usage: node write-tool-manifest.mjs <runtime-images.json> <base|audit> <output>");
}

const config = JSON.parse(readFileSync(configPath, "utf8"));
if (!config.toolsets[toolset]) throw new Error(`unknown toolset: ${toolset}`);
const enabled = (entry) => !entry.toolsets || entry.toolsets.includes(toolset);
const tools = [];
for (const [name, entry] of Object.entries(config.apt)) {
  if (!enabled(entry)) continue;
  const version = entry.version === "dpkg"
    ? execFileSync("dpkg-query", ["-W", "-f=${Version}", name], { encoding: "utf8" }).trim()
    : entry.version;
  tools.push({ name, source: entry.source ?? config.aptSource ?? "debian:bookworm", ...entry, version, toolsets: undefined });
}
for (const [name, entry] of Object.entries(config.npm)) {
  if (enabled(entry)) tools.push({ name, source: "npm", ...entry, toolsets: undefined });
}
for (const [name, entry] of Object.entries(config.downloads)) {
  if (enabled(entry)) tools.push({
    name,
    source: entry.source ?? "download",
    version: entry.version,
    license: entry.license,
    capabilities: entry.capabilities,
    assets: entry.assets,
  });
}
for (const [name, entry] of Object.entries(config.managed ?? {})) {
  if (enabled(entry)) tools.push({ name, ...entry, toolsets: undefined });
}
for (const [name, entry] of Object.entries(config.piExtensions ?? {})) {
  if (enabled(entry)) tools.push({
    name,
    source: "npm",
    package: entry.package,
    version: entry.version,
    integrity: entry.integrity,
    entry: entry.entry,
    license: entry.license,
    capabilities: entry.capabilities,
    pi_extension: true,
    compatible_image_keys: entry.compatible_image_keys,
    requires_egress: entry.requires_egress === true,
    requires_gateway: entry.requires_gateway === true,
  });
}
for (const [name, entry] of Object.entries(config.piExtensionWrappers ?? {})) {
  if (enabled(entry)) {
    const bytes = readWrapperBytes(entry);
    tools.push({
      name,
      source: "repository-wrapper",
      source_path: entry.source,
      wrapper_path: entry.path,
      version: entry.version,
      license: entry.license,
      capabilities: entry.capabilities,
      compatible_image_keys: entry.compatible_image_keys,
      pi_extension_wrapper: true,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    });
  }
}
const manifest = {
  contract: config.contract,
  image_key: config.toolsets[toolset].imageKey,
  toolset,
  platforms: config.platforms,
  base_image: config.baseImage,
  tools,
};
manifest.sha256 = createHash("sha256").update(JSON.stringify(manifest)).digest("hex");
writeFileSync(outputPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
