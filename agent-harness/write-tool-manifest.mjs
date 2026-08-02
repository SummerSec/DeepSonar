import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

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
    source: "download",
    version: entry.version,
    license: entry.license,
    capabilities: entry.capabilities,
    assets: entry.assets,
  });
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
