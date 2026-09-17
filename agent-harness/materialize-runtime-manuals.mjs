#!/usr/bin/env node
/**
 * Materialize the offline manual for one runtime image.
 *
 * The source catalog is deliberately kept outside the image filesystem.  A
 * Docker build copies the catalog and this helper into a temporary path,
 * expands the selected image (including common entries), validates coverage
 * against the image's final tool-manifest, and leaves only the selected
 * manuals in /opt/deepsonar/manuals.
 */
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const MANUAL_CONTRACT = "deepsonar.runtime.manuals/v1";
export const MANUAL_INDEX_PATH = "/opt/deepsonar/manuals/index.json";
export const MANUAL_ROOT_PATH = "/opt/deepsonar/manuals";

const REQUIRED_CATALOG_KEYS = ["id", "doc"];
const REQUIRED_DOC_HEADINGS = [
  ["使用场景", "scenarios", "scenario", "when to use"],
  ["选型依据", "selection", "selection rationale", "choose"],
  ["前置条件", "prerequisites", "preconditions", "requirements"],
  ["调用方式", "invocation", "usage", "command"],
  ["输出解释", "output", "interpretation", "results"],
  ["失败处理", "failures", "failure handling", "errors"],
  ["组合流程", "composition", "workflow", "next steps"],
  ["证据留存", "evidence", "evidence retention"],
  ["版本与限制", "limitations", "limits", "version"],
];

function fail(message) {
  throw new Error(`runtime manual: ${message}`);
}

function assertObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${label} must be an object`);
  return value;
}

function assertString(value, label) {
  if (typeof value !== "string" || value.trim() === "") fail(`${label} must be a non-empty string`);
  return value.trim();
}

function canonicalJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function readJsonFile(filePath, label) {
  try {
    return JSON.parse(readFileSync(filePath, "utf8").replace(/^\uFEFF/, ""));
  } catch (error) {
    fail(`${label} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function sha256Bytes(value) {
  return createHash("sha256").update(value).digest("hex");
}

function normalize(value) {
  return String(value)
    .trim()
    .toLowerCase()
    .replaceAll("\\", "/")
    .replace(/^.*\//, "")
    .replace(/\.(?:sh|bash|py|mjs|js|jar)$/i, "")
    .replace(/@\d[\w.+-]*/g, "")
    .replace(/-(?:\d+)(?:\.\d+)+$/g, "")
    .replace(/-(?:\d+)$/g, "")
    .replace(/[^a-z0-9+.-]+/g, "-");
}

function safeEntryId(value) {
  const result = String(value)
    .trim()
    .toLowerCase()
    .replaceAll("\\", "-")
    .replace(/[^a-z0-9+._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!result) fail(`entry id is not usable as a filename: ${value}`);
  return result;
}

function safeRelativePath(value, label) {
  const pathValue = assertString(value, label).replaceAll("\\", "/");
  if (isAbsolute(pathValue) || pathValue.split("/").some((part) => part === ".." || part === "")) {
    fail(`${label} must be a relative non-traversing path`);
  }
  return pathValue;
}

function ensureRegularFile(filePath, label) {
  if (!existsSync(filePath)) fail(`${label} is missing: ${filePath}`);
  const stat = lstatSync(filePath);
  if (!stat.isFile() || stat.isSymbolicLink()) fail(`${label} must be a regular file: ${filePath}`);
}

function catalogImage(catalog, imageKey) {
  const images = catalog.images ?? catalog.image_manifests ?? catalog.runtime_images;
  let image;
  if (images && typeof images === "object" && !Array.isArray(images)) image = images[imageKey];
  if (!image && catalog[imageKey] && typeof catalog[imageKey] === "object") image = catalog[imageKey];
  if (!image && Array.isArray(images)) image = images.find((item) => item?.image_key === imageKey || item?.imageKey === imageKey);
  if (!image) fail(`catalog has no image entry for ${imageKey}`);
  return assertObject(image, `catalog.images.${imageKey}`);
}

function entryList(image, imageKey) {
  const entries = image.entries ?? image.tools ?? image.manuals;
  if (!Array.isArray(entries) || entries.length === 0) fail(`${imageKey} catalog entry must contain non-empty entries[]`);
  return entries.map((raw, index) => {
    if (typeof raw === "string") return { id: raw, doc: `tools/${safeEntryId(raw)}.md`, covers: [raw] };
    const entry = assertObject(raw, `${imageKey}.entries[${index}]`);
    assertString(entry.id, `${imageKey}.entries[${index}].id`);
    const id = assertString(entry.id, `${imageKey}.entries[${index}].id`);
    const doc = entry.doc ? safeRelativePath(entry.doc, `${imageKey}.entries[${index}].doc`) : `tools/${safeEntryId(id)}.md`;
    const covers = [id, entry.command, entry.path, ...(Array.isArray(entry.commands) ? entry.commands : []), ...(Array.isArray(entry.covers) ? entry.covers : [])]
      .filter((item) => typeof item === "string" && item.trim());
    return { ...entry, id, doc, covers: [...new Set(covers)] };
  });
}

function sourceCandidates(sourceRoot, image, entry) {
  const imageDir = typeof image.directory === "string" ? safeRelativePath(image.directory, "image.directory") : "";
  const source = typeof entry.source === "string" ? safeRelativePath(entry.source, `${entry.id}.source`) : null;
  const candidates = [];
  if (source) candidates.push(join(sourceRoot, source));
  candidates.push(join(sourceRoot, imageDir, entry.doc));
  candidates.push(join(sourceRoot, entry.doc));
  candidates.push(join(sourceRoot, "common", entry.doc));
  candidates.push(join(sourceRoot, imageDir, "common", entry.doc));
  return [...new Set(candidates.map((item) => resolve(item)))];
}

function findSourceFile(sourceRoot, image, entry) {
  for (const candidate of sourceCandidates(sourceRoot, image, entry)) {
    if (existsSync(candidate)) {
      ensureRegularFile(candidate, `${entry.id} documentation`);
      return candidate;
    }
  }
  return null;
}

function markdownValue(value) {
  if (Array.isArray(value)) return value.map((item) => `- ${markdownValue(item)}`).join("\n");
  if (value && typeof value === "object") {
    return Object.entries(value).map(([key, item]) => `- **${key}**: ${markdownValue(item)}`).join("\n");
  }
  return String(value ?? "").trim();
}

function renderEntryMarkdown(entry, imageKey) {
  const failure = entry.failure_handling;
  if (!failure || typeof failure !== "object" || Array.isArray(failure)) fail(`${entry.id} failure_handling must be an object`);
  const lines = [
    `# ${entry.id}`,
    "",
    `- Image: \`${imageKey}\``,
    `- Kind: \`${entry.kind ?? "tool"}\``,
    `- Version: \`${entry.version ?? "unspecified"}\``,
    `- Verification: \`${entry.verification_status ?? "unspecified"}\``,
    "",
    "## 使用场景",
    "",
    markdownValue(entry.usage_scenario),
    "",
    "## 选型依据",
    "",
    markdownValue(entry.selection_basis),
    "",
    "## 前置条件",
    "",
    markdownValue(entry.prerequisites),
    "",
    "## 调用方式",
    "",
    "最小调用：",
    "",
    "```text",
    markdownValue(entry.minimal_invocation),
    "```",
    "",
    "常用参数：",
    "",
    markdownValue(entry.common_parameters),
    "",
    "## 输出解释",
    "",
    markdownValue(entry.output_interpretation),
    "",
    "## 失败处理",
    "",
  ];
  for (const category of ["normal_empty", "model_correctable", "transient_retryable", "missing_condition", "permanent"]) {
    if (typeof failure[category] !== "string" || failure[category].trim() === "") fail(`${entry.id} failure_handling.${category} is missing`);
    lines.push(`### ${category}`, "", failure[category].trim(), "");
  }
  lines.push(
    "## 组合流程", "", markdownValue(entry.composition_flow), "",
    "## 证据留存", "", markdownValue(entry.evidence_retention), "",
    "## 版本与限制", "", markdownValue(entry.version_limits_side_effects_cleanup), "",
  );
  if (entry.verification_note) lines.push(`验证说明：${entry.verification_note}`, "");
  return `${lines.join("\n").replace(/\n{3,}/g, "\n\n").trim()}\n`;
}

function requiredHeadingPresent(text, alternatives) {
  return alternatives.some((item) => new RegExp(`^#{1,6}\\s+.*${item.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "imu").test(text));
}

function validateDocumentation(text, entry) {
  if (text.trim().length < 80) fail(`${entry.id} documentation is too short`);
  if (/^\s*(?:see|refer to|reference|参考|参见|详见|见)\s+base\b/im.test(text)) {
    fail(`${entry.id} documentation cannot delegate to base manual`);
  }
  const missing = REQUIRED_DOC_HEADINGS.filter((alternatives) => !requiredHeadingPresent(text, alternatives));
  if (missing.length > 0) fail(`${entry.id} documentation is missing required sections: ${missing.map((item) => item[0]).join(", ")}`);
}

function manifestToolNames(manifest) {
  if (!Array.isArray(manifest.tools)) fail("tool manifest tools must be an array");
  return manifest.tools.map((tool, index) => {
    if (typeof tool === "string") return tool;
    const value = tool?.name ?? tool?.id ?? tool?.command;
    return assertString(value, `tool manifest tools[${index}]`).trim();
  });
}

function endpointValues(value, output = []) {
  // `entrypoints` is already the manifest's direct command surface. Walk every
  // string so newly introduced named wrappers cannot bypass documentation.
  if (typeof value === "string") {
    output.push(value);
    return output;
  }
  if (Array.isArray(value)) {
    for (const item of value) endpointValues(item, output);
    return output;
  }
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) endpointValues(child, output);
  }
  return output;
}

function coverageSet(entry) {
  return new Set(entry.covers.flatMap((value) => [normalize(value), String(value).trim().toLowerCase()]));
}

function assertCoverage(entries, manifest) {
  const docs = entries.map((entry) => ({ entry, coverage: coverageSet(entry) }));
  const missingTools = manifestToolNames(manifest).filter((tool) => {
    const keys = [normalize(tool), tool.trim().toLowerCase()];
    return !docs.some(({ coverage }) => keys.some((key) => coverage.has(key)));
  });
  if (missingTools.length > 0) fail(`tool manifest entries without documentation: ${missingTools.join(", ")}`);

  const endpoints = endpointValues(manifest.entrypoints ?? {});
  const missingEndpoints = endpoints.filter((endpoint) => {
    const keys = [normalize(endpoint), endpoint.trim().toLowerCase()];
    return !docs.some(({ coverage }) => keys.some((key) => coverage.has(key)));
  });
  if (missingEndpoints.length > 0) fail(`manifest entrypoints without documentation: ${missingEndpoints.join(", ")}`);
}

function digestManual(index, files) {
  const digestIndex = { ...index };
  delete digestIndex.manual_sha256;
  delete digestIndex.index_sha256;
  const hash = createHash("sha256");
  hash.update("index.json\n");
  hash.update(canonicalJson(digestIndex));
  for (const file of [...files].sort((a, b) => a.path.localeCompare(b.path))) {
    hash.update(`file:${file.path}\n`);
    hash.update(readFileSync(file.absolute));
    hash.update("\n");
  }
  return hash.digest("hex");
}

export function verifyManualDirectory(manualRoot, expected = {}) {
  const root = resolve(manualRoot);
  const indexPath = join(root, "index.json");
  ensureRegularFile(indexPath, "manual index");
  const index = assertObject(JSON.parse(readFileSync(indexPath, "utf8")), "manual index");
  if (index.contract !== MANUAL_CONTRACT) fail(`manual index contract is invalid: ${index.contract}`);
  if (expected.imageKey && index.image_key !== expected.imageKey) fail(`manual index image_key mismatch: ${index.image_key}`);
  if (typeof index.manual_version !== "string" || index.manual_version.trim() === "") fail("manual index manual_version is missing");
  if (!Array.isArray(index.entries) || index.entries.length === 0) fail("manual index entries must be non-empty");
  const files = [];
  for (const entry of index.entries) {
    assertObject(entry, "manual index entry");
    const doc = safeRelativePath(entry.doc, `${entry.id}.doc`);
    const absolute = resolve(root, doc);
    if (!absolute.startsWith(`${root}${sep}`)) fail(`manual entry escapes root: ${doc}`);
    ensureRegularFile(absolute, `${entry.id} documentation`);
    const text = readFileSync(absolute, "utf8");
    validateDocumentation(text, entry);
    files.push({ path: doc, absolute });
  }
  const indexDocument = join(root, "INDEX.md");
  ensureRegularFile(indexDocument, "manual INDEX.md");
  files.push({ path: "INDEX.md", absolute: indexDocument });
  const manualSha256 = digestManual(index, files);
  if (index.manual_sha256 !== manualSha256) fail(`manual sha256 mismatch: expected ${manualSha256}, got ${index.manual_sha256}`);
  const indexForHash = { ...index };
  delete indexForHash.index_sha256;
  const indexSha256 = sha256Bytes(canonicalJson(indexForHash));
  if (index.index_sha256 !== indexSha256) fail(`manual index sha256 mismatch: expected ${indexSha256}, got ${index.index_sha256}`);
  return { index, files, manualSha256, indexSha256 };
}

export function materializeRuntimeManuals({ catalogPath, sourceRoot, toolManifestPath, outputDir, imageKey }) {
  const catalog = assertObject(readJsonFile(catalogPath, "manual catalog"), "manual catalog");
  const image = catalogImage(catalog, imageKey);
  const entries = entryList(image, imageKey);
  const manifest = assertObject(readJsonFile(toolManifestPath, "tool manifest"), "tool manifest");
  const manifestImageKey = manifest.image_key ?? manifest.imageKey;
  if (manifestImageKey !== imageKey) fail(`tool manifest image key mismatch: expected ${imageKey}, got ${manifestImageKey}`);
  assertCoverage(entries, manifest);

  const root = resolve(outputDir);
  if (existsSync(root) && lstatSync(root).isSymbolicLink()) fail(`manual output cannot be a symlink: ${root}`);
  rmSync(root, { recursive: true, force: true });
  mkdirSync(root, { recursive: true, mode: 0o755 });

  const materialized = [];
  const destinations = new Map();
  for (const entry of entries) {
    const source = findSourceFile(sourceRoot, image, entry);
    const destination = safeRelativePath(entry.doc, `${entry.id}.doc`);
    const previous = destinations.get(destination);
    if (previous && previous !== (source ?? "inline")) fail(`multiple source files map to ${destination}`);
    destinations.set(destination, source ?? "inline");
    const absolute = resolve(root, destination);
    mkdirSync(dirname(absolute), { recursive: true, mode: 0o755 });
    if (source) copyFileSync(source, absolute);
    else writeFileSync(absolute, renderEntryMarkdown(entry, imageKey), "utf8");
    validateDocumentation(readFileSync(absolute, "utf8"), entry);
    materialized.push({ path: destination, absolute });
  }

  const manualVersion = image.manual_version ?? image.version ?? catalog.manual_version ?? catalog.catalog_version ?? catalog.version;
  assertString(manualVersion, `${imageKey}.manual_version`);
  const index = {
    contract: MANUAL_CONTRACT,
    image_key: imageKey,
    manual_version: manualVersion,
    path: MANUAL_INDEX_PATH,
    entries: entries.map((entry) => {
      const output = { ...entry };
      delete output.covers;
      delete output.source;
      return output;
    }).sort((a, b) => a.id.localeCompare(b.id)),
  };
  const indexDraft = { ...index, manual_sha256: "", index_sha256: "" };
  const indexPath = join(root, "index.json");
  writeFileSync(indexPath, canonicalJson(indexDraft), "utf8");
  const indexMarkdown = [
    `# DeepSonar Runtime Manual: ${imageKey}`,
    "",
    `- Contract: \`${MANUAL_CONTRACT}\``,
    `- Manual version: \`${manualVersion}\``,
    "- Read the individual chapter before invoking a tool; this index does not grant permissions.",
    "",
    "| Entry | Kind | Version | Documentation |",
    "| --- | --- | --- | --- |",
    ...index.entries.map((entry) => `| ${entry.id} | ${entry.kind ?? "tool"} | ${entry.version ?? "unspecified"} | [${entry.doc}](${entry.doc}) |`),
    "",
  ].join("\n");
  const indexMarkdownPath = join(root, "INDEX.md");
  writeFileSync(indexMarkdownPath, indexMarkdown, "utf8");
  const files = [{ path: "INDEX.md", absolute: indexMarkdownPath }, ...materialized];
  index.manual_sha256 = digestManual(index, files);
  index.index_sha256 = sha256Bytes(canonicalJson(index));
  writeFileSync(indexPath, canonicalJson(index), "utf8");

  const manual = {
    contract: MANUAL_CONTRACT,
    path: MANUAL_INDEX_PATH,
    version: manualVersion,
    sha256: index.manual_sha256,
    count: index.entries.length,
  };
  const manifestForHash = { ...manifest, manual };
  delete manifestForHash.sha256;
  manifestForHash.sha256 = sha256Bytes(JSON.stringify(manifestForHash));
  writeFileSync(toolManifestPath, `${JSON.stringify(manifestForHash, null, 2)}\n`, "utf8");
  return { index, manual, manifest: manifestForHash };
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--catalog") args.catalogPath = argv[++i];
    else if (arg === "--source-root") args.sourceRoot = argv[++i];
    else if (arg === "--tool-manifest") args.toolManifestPath = argv[++i];
    else if (arg === "--output") args.outputDir = argv[++i];
    else if (arg === "--image-key") args.imageKey = argv[++i];
    else if (arg === "--help" || arg === "-h") {
      console.log("Usage: materialize-runtime-manuals.mjs --catalog <file> --source-root <dir> --tool-manifest <file> --output <dir> --image-key <key>");
      process.exit(0);
    } else fail(`unknown argument: ${arg}`);
  }
  for (const key of ["catalogPath", "sourceRoot", "toolManifestPath", "outputDir", "imageKey"]) {
    if (!args[key]) fail(`missing --${key.replace(/[A-Z]/g, (item) => `-${item.toLowerCase()}`)}`);
  }
  return args;
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const args = parseArgs(process.argv.slice(2));
  const result = materializeRuntimeManuals(args);
  console.log(JSON.stringify({ image_key: result.index.image_key, manual_version: result.manual.version, manual_sha256: result.manual.sha256, count: result.manual.count }));
}
