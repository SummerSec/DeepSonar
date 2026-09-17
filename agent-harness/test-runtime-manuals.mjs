#!/usr/bin/env node
/** Static acceptance gate for the official runtime manual catalog. */
import { existsSync, lstatSync, readFileSync, readdirSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const OFFICIAL_RUNTIME_IMAGES = Object.freeze([
  "deepsonar-base",
  "deepsonar-audit",
  "deepsonar-kali-minimal",
  "deepsonar-chrome-test",
  "deepsonar-chrome-audit",
  "deepsonar-chrome-fuzz",
  "deepsonar-clickhouse-test",
  "deepsonar-clickhouse-audit",
  "deepsonar-clickhouse-fuzz",
  "deepsonar-openharmony-test",
  "deepsonar-openharmony-audit",
  "deepsonar-openharmony-fuzz",
  "deepsonar-mobile",
]);

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const manualRoot = join(root, "agent-harness", "runtime-manuals");
const catalogPath = process.argv[2] ? resolve(process.argv[2]) : join(manualRoot, "catalog.json");
const requiredHeadings = [
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
  throw new Error(`runtime manual static gate: ${message}`);
}

function object(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${label} must be an object`);
  return value;
}

function text(value, label) {
  if (typeof value !== "string" || value.trim() === "") fail(`${label} must be a non-empty string`);
  return value.trim();
}

function relativePath(value, label) {
  const path = text(value, label).replaceAll("\\", "/");
  if (path.startsWith("/") || path.split("/").some((part) => part === ".." || part === "")) fail(`${label} must be relative and non-traversing`);
  return path;
}

function safeEntryId(value) {
  const result = String(value).trim().toLowerCase()
    .replaceAll("\\", "-")
    .replace(/[^a-z0-9+._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!result) fail(`entry id is not usable as a filename: ${value}`);
  return result;
}

function hasHeading(content, alternatives) {
  return alternatives.some((heading) => content.split(/\r?\n/).some((line) => {
    const trimmed = line.trim().toLowerCase();
    return /^#{1,6}\s+/.test(trimmed) && trimmed.includes(heading.toLowerCase());
  }));
}

function validateDoc(docPath, label) {
  if (!existsSync(docPath)) fail(`${label} is missing: ${relative(root, docPath)}`);
  const stat = lstatSync(docPath);
  if (!stat.isFile() || stat.isSymbolicLink()) fail(`${label} must be a regular file: ${relative(root, docPath)}`);
  const content = readFileSync(docPath, "utf8");
  if (content.trim().length < 80) fail(`${label} is too short`);
  if (/^\s*(?:see|refer to|reference|参考|参见|详见|见)\s+base\b/im.test(content)) fail(`${label} delegates to base manual`);
  const missing = requiredHeadings.filter((items) => !hasHeading(content, items));
  if (missing.length > 0) fail(`${label} is missing required sections: ${missing.map((items) => items[0]).join(", ")}`);
}

function imageCatalog(catalog, imageKey) {
  const images = catalog.images ?? catalog.image_manifests ?? catalog.runtime_images;
  if (images && typeof images === "object" && !Array.isArray(images) && images[imageKey]) return object(images[imageKey], `${imageKey} catalog entry`);
  if (Array.isArray(images)) {
    const found = images.find((item) => item?.image_key === imageKey || item?.imageKey === imageKey);
    if (found) return object(found, `${imageKey} catalog entry`);
  }
  fail(`catalog has no image entry for ${imageKey}`);
}

function sourceFileCandidates(image, entry) {
  const directory = typeof image.directory === "string" ? image.directory.replaceAll("\\", "/") : "";
  const doc = relativePath(entry.doc, `${entry.id}.doc`);
  const explicit = typeof entry.source === "string" ? relativePath(entry.source, `${entry.id}.source`) : null;
  return [...new Set([
    explicit ? join(manualRoot, explicit) : null,
    join(manualRoot, directory, doc),
    join(manualRoot, doc),
    join(manualRoot, "common", doc),
    join(manualRoot, directory, "common", doc),
  ].filter(Boolean).map((path) => resolve(path)))];
}

function entriesFor(image, imageKey) {
  const entries = image.entries ?? image.tools ?? image.manuals;
  if (!Array.isArray(entries) || entries.length === 0) fail(`${imageKey} entries must be non-empty`);
  return entries.map((raw, index) => {
    if (typeof raw === "string") return { id: raw, doc: `tools/${safeEntryId(raw)}.md` };
    const entry = object(raw, `${imageKey}.entries[${index}]`);
    text(entry.id, `${imageKey}.entries[${index}].id`);
    const doc = entry.doc ? relativePath(entry.doc, `${imageKey}.entries[${index}].doc`) : `tools/${safeEntryId(entry.id)}.md`;
    text(entry.version, `${imageKey}.entries[${index}].version`);
    return { ...entry, doc };
  });
}

const REQUIRED_ENTRY_FIELDS = [
  "image_key", "id", "kind", "version", "commands", "usage_scenario", "selection_basis", "prerequisites",
  "minimal_invocation", "common_parameters", "output_interpretation", "failure_handling", "composition_flow",
  "evidence_retention", "version_limits_side_effects_cleanup", "verification_status", "verification_note",
];
const FAILURE_CATEGORIES = ["normal_empty", "model_correctable", "transient_retryable", "missing_condition", "permanent"];

function validateCatalogEntry(entry, imageKey, index) {
  const label = `${imageKey}.entries[${index}]`;
  for (const key of REQUIRED_ENTRY_FIELDS) {
    if (entry[key] === undefined || entry[key] === null) fail(`${label}.${key} is missing`);
    if (typeof entry[key] === "string") text(entry[key], `${label}.${key}`);
  }
  if (entry.image_key !== imageKey) fail(`${label}.image_key does not match ${imageKey}`);
  if (!Array.isArray(entry.commands)) fail(`${label}.commands must be an array`);
  if (!Array.isArray(entry.prerequisites) || entry.prerequisites.length === 0) fail(`${label}.prerequisites must be non-empty`);
  if (!Array.isArray(entry.common_parameters)) fail(`${label}.common_parameters must be an array`);
  if (!Array.isArray(entry.evidence_retention) || entry.evidence_retention.length === 0) fail(`${label}.evidence_retention must be non-empty`);
  const failures = object(entry.failure_handling, `${label}.failure_handling`);
  for (const category of FAILURE_CATEGORIES) text(failures[category], `${label}.failure_handling.${category}`);
  const serialized = JSON.stringify(entry);
  if (/^\s*(?:see|refer to|reference|参考|参见|详见|见)\s+base\b/im.test(serialized)) fail(`${label} delegates to base manual`);
  if (!text(entry.minimal_invocation, `${label}.minimal_invocation`)) fail(`${label}.minimal_invocation is missing`);
}

function dockerfileFor(imageKey) {
  if (imageKey === "deepsonar-base" || imageKey === "deepsonar-audit") return join(root, "deploy", "Dockerfile.agent");
  const suffix = imageKey.replace(/^deepsonar-/, "");
  const aliases = {
    "kali-minimal": "Dockerfile.agent-kali-minimal",
    "mobile": "Dockerfile.agent-mobile",
    "openharmony-test": "Dockerfile.agent-openharmony",
    "openharmony-audit": "Dockerfile.agent-openharmony-audit",
    "openharmony-fuzz": "Dockerfile.agent-openharmony-fuzz",
    "chrome-test": "Dockerfile.agent-chrome-test",
    "chrome-audit": "Dockerfile.agent-chrome-audit",
    "chrome-fuzz": "Dockerfile.agent-chrome-fuzz",
    "clickhouse-test": "Dockerfile.agent-clickhouse-test",
    "clickhouse-audit": "Dockerfile.agent-clickhouse-audit",
    "clickhouse-fuzz": "Dockerfile.agent-clickhouse-fuzz",
  };
  return join(root, "deploy", aliases[suffix] ?? `Dockerfile.agent-${suffix}`);
}

function normalizedCoverage(value) {
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

function catalogCoverage(entries) {
  return new Set(entries.flatMap((entry) => [
    entry.id,
    ...entry.commands,
    ...(Array.isArray(entry.covers) ? entry.covers : []),
  ]).flatMap((value) => [normalizedCoverage(value), String(value).trim().toLowerCase()]));
}

function missingCoverage(declared, coverage) {
  return declared.filter((tool) => ![normalizedCoverage(tool), tool.toLowerCase()].some((key) => coverage.has(key)));
}

function assertDockerfile(imageKey, entries) {
  const file = dockerfileFor(imageKey);
  if (!existsSync(file)) fail(`${imageKey} Dockerfile is missing`);
  const source = readFileSync(file, "utf8");
  if (!source.includes("agent-harness/runtime-manuals")) fail(`${imageKey} Dockerfile does not copy canonical manuals`);
  if (!source.includes("materialize-runtime-manuals.mjs")) fail(`${imageKey} Dockerfile does not run materializer`);
  if (!source.includes("--tool-manifest") || !source.includes("--image-key")) fail(`${imageKey} Dockerfile materializer is not bound to final tool manifest`);
  if (!source.includes('io.deepsonar.manuals="/opt/deepsonar/manuals/index.json"')) fail(`${imageKey} Dockerfile is missing OCI manual label`);
  if (!source.includes(`io.deepsonar.image-key="${imageKey}"`) && !source.includes('io.deepsonar.image-key="deepsonar-${TOOLSET}"')) {
    fail(`${imageKey} Dockerfile is missing OCI image-key label`);
  }
  const inlineTools = source.match(/(?:tools|\\"tools\\"):\[(.*?)\]/s)?.[1];
  if (inlineTools) {
    const manifestTools = [...inlineTools.matchAll(/\\"([^\"]+)\\"/g)].map((match) => match[1]);
    const missing = missingCoverage(manifestTools, catalogCoverage(entries));
    if (missing.length > 0) fail(`${imageKey} final tool manifest entries lack documentation: ${missing.join(", ")}`);
  }
}

const GENERATED_MANIFEST_SOURCES = Object.freeze({
  "deepsonar-base": ["agent-harness/runtime-images.json", "base"],
  "deepsonar-audit": ["agent-harness/runtime-images.json", "audit"],
  "deepsonar-kali-minimal": ["agent-harness/kali-minimal-runtime.json", "kali-minimal"],
});

function assertGeneratedManifestSource(imageKey, entries) {
  const source = GENERATED_MANIFEST_SOURCES[imageKey];
  if (!source) return;
  const [relativeConfigPath, toolset] = source;
  const config = object(JSON.parse(readFileSync(join(root, relativeConfigPath), "utf8")), `${imageKey} runtime inventory`);
  const enabled = (entry) => !entry.toolsets || entry.toolsets.includes(toolset);
  const declared = ["apt", "npm", "downloads", "managed", "piExtensions"].flatMap((section) =>
    Object.entries(config[section] ?? {}).filter(([, entry]) => enabled(entry)).map(([name]) => name));
  const missing = missingCoverage(declared, catalogCoverage(entries));
  if (missing.length > 0) fail(`${imageKey} generated tool manifest entries lack documentation: ${missing.join(", ")}`);
}

function assertFingerprint(imageKey) {
  const source = readFileSync(join(root, "agent-harness", "image-build-fingerprint.mjs"), "utf8");
  const key = `"${imageKey}"`;
  const start = source.indexOf(`${key}:`);
  if (start < 0) fail(`fingerprint preset missing for ${imageKey}`);
  const end = source.indexOf("\n  },", start);
  const block = source.slice(start, end < 0 ? source.length : end);
  if (!block.includes("agent-harness/runtime-manuals")) fail(`${imageKey} fingerprint does not include manuals`);
}

function commandName(value) {
  const first = String(value).trim().split(/\s+/)[0]?.replaceAll("\\", "/") ?? "";
  return first.slice(first.lastIndexOf("/") + 1);
}

export function runStaticManualGate() {
  if (!existsSync(catalogPath)) fail(`canonical catalog is missing: ${catalogPath}`);
  const catalog = object(JSON.parse(readFileSync(catalogPath, "utf8")), "manual catalog");
  const keys = Array.isArray(catalog.images)
    ? catalog.images.map((item) => item?.image_key ?? item?.imageKey).filter((item) => typeof item === "string")
    : catalog.images && typeof catalog.images === "object" ? Object.keys(catalog.images) : [];
  if (keys.length !== OFFICIAL_RUNTIME_IMAGES.length || OFFICIAL_RUNTIME_IMAGES.some((key) => !keys.includes(key))) {
    fail(`catalog must contain exactly the 13 official images; got ${keys.join(", ")}`);
  }
  const baseEntries = entriesFor(imageCatalog(catalog, "deepsonar-base"), "deepsonar-base");
  const inheritedCommands = new Set(baseEntries
    .filter((entry) => entry.agent_visible !== false && entry.implementation_only !== true)
    .flatMap((entry) => entry.commands.map(commandName))
    .filter(Boolean));
  for (const imageKey of OFFICIAL_RUNTIME_IMAGES) {
    const image = imageCatalog(catalog, imageKey);
    text(image.manual_version ?? image.version ?? catalog.manual_version ?? catalog.catalog_version ?? catalog.version, `${imageKey}.manual_version`);
    const entries = entriesFor(image, imageKey);
    const seen = new Set();
    for (const [index, entry] of entries.entries()) {
      const id = text(entry.id, `${imageKey}.entry.id`);
      if (seen.has(id)) fail(`${imageKey} has duplicate entry ${id}`);
      seen.add(id);
      validateCatalogEntry(entry, imageKey, index);
    }
    const coveredCommands = new Set(entries.flatMap((entry) => [
      ...entry.commands.map(commandName),
      ...(Array.isArray(entry.covers) ? entry.covers.map(commandName) : []),
    ]).filter(Boolean));
    const missingInherited = [...inheritedCommands].filter((command) => !coveredCommands.has(command));
    if (missingInherited.length > 0) fail(`${imageKey} omits inherited base commands: ${missingInherited.join(", ")}`);
    assertDockerfile(imageKey, entries);
    assertGeneratedManifestSource(imageKey, entries);
    assertFingerprint(imageKey);
  }
  return { imageCount: OFFICIAL_RUNTIME_IMAGES.length, catalogPath };
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const result = runStaticManualGate();
  console.log(`runtime manual static gate passed: ${result.imageCount} official images`);
}
