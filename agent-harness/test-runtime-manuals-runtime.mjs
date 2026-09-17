#!/usr/bin/env node
/**
 * Verify the materialized manual inside an already-built runtime image.
 *
 * Usage:
 *   node test-runtime-manuals-runtime.mjs <image> [toolset|image-key] [config] [platform]
 *   node test-runtime-manuals-runtime.mjs <image> --image-key deepsonar-mobile --platform linux/amd64
 */
import { execFileSync } from "node:child_process";

const argv = process.argv.slice(2);
const image = argv.shift();
if (!image) throw new Error("usage: node test-runtime-manuals-runtime.mjs <image> [toolset|image-key] [config] [platform]");

let imageKey;
let platform;
const positional = [];
for (let i = 0; i < argv.length; i += 1) {
  const arg = argv[i];
  if (arg === "--image-key") imageKey = argv[++i];
  else if (arg === "--platform") platform = argv[++i];
  else if (arg.startsWith("--image-key=")) imageKey = arg.slice("--image-key=".length);
  else if (arg.startsWith("--platform=")) platform = arg.slice("--platform=".length);
  else positional.push(arg);
}
if (!imageKey && positional[0]) imageKey = positional[0].startsWith("deepsonar-") ? positional[0] : `deepsonar-${positional[0]}`;
if (!platform) platform = positional.find((item) => /^linux\/(?:amd64|arm64)$/.test(item));

const inspectArgs = ["image", "inspect", image];
const inspect = JSON.parse(execFileSync("docker", inspectArgs, { encoding: "utf8" }))[0];
const labels = inspect?.Config?.Labels ?? {};
if (labels["io.deepsonar.manuals"] !== "/opt/deepsonar/manuals/index.json") {
  throw new Error(`${image} is missing io.deepsonar.manuals=/opt/deepsonar/manuals/index.json`);
}

const expectedImageKey = imageKey ?? "";
const checkScript = String.raw`
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const root = "/opt/deepsonar/manuals";
const expectedImageKey = ${JSON.stringify(expectedImageKey)};
const contract = "deepsonar.runtime.manuals/v1";
function fail(message) { throw new Error("runtime manual image check: " + message); }
function regular(file, label) {
  let stat;
  try { stat = fs.lstatSync(file); } catch { fail(label + " is missing: " + file); }
  if (!stat.isFile() || stat.isSymbolicLink()) fail(label + " must be a regular file: " + file);
}
function walk(directory) {
  const stat = fs.lstatSync(directory);
  if (stat.isSymbolicLink()) fail("manual directory contains a symlink: " + directory);
  if (!stat.isDirectory()) fail("manual root is not a directory");
  for (const name of fs.readdirSync(directory)) {
    const file = path.join(directory, name);
    const child = fs.lstatSync(file);
    if (child.isSymbolicLink()) fail("manual directory contains a symlink: " + file);
    if (child.isDirectory()) walk(file);
  }
}
function canonicalJson(value) { return JSON.stringify(value, null, 2) + "\n"; }
function sha(value) { return crypto.createHash("sha256").update(value).digest("hex"); }
function safeRelative(value, label) {
  if (typeof value !== "string" || !value || path.posix.isAbsolute(value) || value.split("/").some((part) => part === ".." || part === "")) fail(label + " is unsafe");
  return value;
}
walk(root);
const indexFile = path.join(root, "index.json");
regular(indexFile, "manual index");
const index = JSON.parse(fs.readFileSync(indexFile, "utf8"));
if (index.contract !== contract) fail("manual contract mismatch");
if (expectedImageKey && index.image_key !== expectedImageKey) fail("manual image key mismatch");
if (typeof index.manual_version !== "string" || !index.manual_version.trim()) fail("manual version missing");
if (!Array.isArray(index.entries) || index.entries.length === 0) fail("manual entries missing");
const files = [{ path: "INDEX.md", absolute: path.join(root, "INDEX.md") }];
regular(files[0].absolute, "manual INDEX.md");
const seen = new Set();
for (const entry of index.entries) {
  if (!entry || typeof entry !== "object" || typeof entry.id !== "string" || typeof entry.doc !== "string") fail("manual entry is malformed");
  const doc = safeRelative(entry.doc, entry.id + ".doc");
  if (seen.has(doc)) fail("manual entries reuse documentation path: " + doc);
  seen.add(doc);
  const absolute = path.resolve(root, doc);
  if (!absolute.startsWith(root + path.sep)) fail("manual entry escapes root: " + doc);
  regular(absolute, entry.id + " documentation");
  const content = fs.readFileSync(absolute, "utf8");
  if (content.trim().length < 80) fail(entry.id + " documentation is too short");
  if (/^\s*(?:see|refer to|reference|参考|参见|详见|见)\s+base\b/im.test(content)) fail(entry.id + " delegates to base manual");
  for (const heading of ["使用场景", "选型依据", "前置条件", "调用方式", "输出解释", "失败处理", "组合流程", "证据留存", "版本与限制"]) {
    if (!content.split(/\r?\n/).some((line) => /^#{1,6}\s+/.test(line.trim()) && line.toLowerCase().includes(heading.toLowerCase()))) fail(entry.id + " missing section " + heading);
  }
  files.push({ path: doc, absolute });
}
const digestIndex = { ...index };
delete digestIndex.manual_sha256;
delete digestIndex.index_sha256;
const manualHash = crypto.createHash("sha256");
manualHash.update("index.json\n");
manualHash.update(canonicalJson(digestIndex));
for (const file of files.sort((left, right) => left.path.localeCompare(right.path))) {
  manualHash.update("file:" + file.path + "\n");
  manualHash.update(fs.readFileSync(file.absolute));
  manualHash.update("\n");
}
const manualSha256 = manualHash.digest("hex");
if (index.manual_sha256 !== manualSha256) fail("manual sha256 mismatch");
const indexForHash = { ...index };
delete indexForHash.index_sha256;
if (index.index_sha256 !== sha(canonicalJson(indexForHash))) fail("index sha256 mismatch");
const manifestFile = "/opt/deepsonar/tool-manifest.json";
regular(manifestFile, "tool manifest");
const manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
const manual = manifest.manual;
if (!manual || manual.contract !== contract || manual.path !== "/opt/deepsonar/manuals/index.json") fail("tool manifest manual contract/path mismatch");
if (manual.version !== index.manual_version || manual.sha256 !== manualSha256 || manual.count !== index.entries.length) fail("tool manifest manual metadata mismatch");
const manifestForHash = { ...manifest };
delete manifestForHash.sha256;
if (manifest.sha256 !== sha(JSON.stringify(manifestForHash))) fail("tool manifest sha256 mismatch");
console.log(JSON.stringify({ image_key: index.image_key, manual_version: index.manual_version, manual_sha256: manualSha256, count: index.entries.length }));
`;

const dockerArgs = [
  "run", "--rm", "--network", "none", "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
  "--cpus", "1", "--memory", "1g", "--pids-limit", "256",
];
if (platform) dockerArgs.push("--platform", platform);
dockerArgs.push(image, "node", "-e", checkScript);
execFileSync("docker", dockerArgs, { stdio: "inherit" });
console.log(`${image} offline runtime manual check passed${platform ? ` (${platform})` : ""}`);
