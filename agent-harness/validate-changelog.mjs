import { readFileSync, writeFileSync } from "node:fs";

const VERSION_RE = /^\d+\.\d+\.\d+$/u;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/u;
const COMPARE_BASE = "https://github.com/SummerSec/DeepSonar/compare";

function fail(message) {
  throw new Error(`CHANGELOG validation failed: ${message}`);
}

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith("--")) fail(`unexpected argument ${arg}`);
    const key = arg.slice(2);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) fail(`missing value for --${key}`);
    args[key] = value;
    index += 1;
  }
  return args;
}

function compareVersions(left, right) {
  const a = left.split(".").map(Number);
  const b = right.split(".").map(Number);
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index] - b[index];
  }
  return 0;
}

function isValidDate(value) {
  if (!DATE_RE.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function parseSections(source) {
  const lines = source.replace(/\r\n?/gu, "\n").split("\n");
  const headers = [];
  const referenceLinks = new Map();
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const header = /^## \[([^\]]+)\](?:\s+-\s+(\d{4}-\d{2}-\d{2}))?\s*$/u.exec(line);
    if (header) headers.push({ index, label: header[1], date: header[2] ?? null });
    const reference = /^\[([^\]]+)\]:\s+(\S+)\s*$/u.exec(line);
    if (reference) referenceLinks.set(reference[1], [...(referenceLinks.get(reference[1]) ?? []), { index, url: reference[2] }]);
  }
  const sections = headers.map((header, index) => {
    const end = headers[index + 1]?.index ?? lines.length;
    return { ...header, end, text: lines.slice(header.index, end).join("\n").trim() };
  });
  return { lines, sections, referenceLinks };
}

function substantiveLines(section) {
  return section.text
    .split("\n")
    .slice(1)
    .map((line) => line.trim())
    .filter((line) => line && !/^#{2,6}\s/u.test(line) && !/^\[[^\]]+\]:\s+\S+$/u.test(line) && !/^<!--.*-->$/u.test(line));
}

export function validateChangelog({ source, version, previousVersion, tag, outputPath }) {
  if (!VERSION_RE.test(version ?? "")) fail(`version must be X.Y.Z, got ${version ?? "empty"}`);
  if (tag !== undefined && tag !== `v${version}`) fail(`tag ${tag} does not match v${version}`);
  if (previousVersion !== undefined && !VERSION_RE.test(previousVersion)) fail(`previous version must be X.Y.Z, got ${previousVersion}`);

  const parsed = parseSections(source);
  const unreleased = parsed.sections.filter((section) => section.label === "Unreleased");
  if (unreleased.length !== 1) fail("CHANGELOG must contain exactly one ## [Unreleased] section");

  const duplicateVersionSections = parsed.sections.filter((section) => VERSION_RE.test(section.label));
  const seenVersions = new Set();
  for (const section of duplicateVersionSections) {
    if (seenVersions.has(section.label)) fail(`duplicate version section ${section.label}`);
    seenVersions.add(section.label);
  }

  const targetSections = parsed.sections.filter((section) => section.label === version);
  if (targetSections.length !== 1) fail(`version ${version} must have exactly one section`);
  const target = targetSections[0];
  if (!target.date || !isValidDate(target.date)) fail(`version ${version} must have a valid YYYY-MM-DD date`);
  if (substantiveLines(target).length === 0) fail(`version ${version} section must not be empty`);

  const inferredPrevious = [...seenVersions]
    .filter((candidate) => compareVersions(candidate, version) < 0)
    .sort(compareVersions)
    .at(-1);
  const expectedPrevious = previousVersion ?? inferredPrevious;
  if (!expectedPrevious) fail(`no previous version found for ${version}`);
  if (compareVersions(expectedPrevious, version) >= 0) fail(`previous version ${expectedPrevious} must be lower than ${version}`);

  const expectedUrl = `${COMPARE_BASE}/v${expectedPrevious}...v${version}`;
  const links = parsed.referenceLinks.get(version) ?? [];
  if (links.length !== 1) fail(`version ${version} must have exactly one compare link`);
  if (links[0].url !== expectedUrl) fail(`compare link for ${version} must be ${expectedUrl}`);

  if (outputPath) writeFileSync(outputPath, `${target.text}\n`, "utf8");
  return { section: target.text, previousVersion: expectedPrevious, compareUrl: expectedUrl };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const file = args.file ?? "CHANGELOG.md";
  const source = readFileSync(file, "utf8");
  const result = validateChangelog({
    source,
    version: args.version,
    previousVersion: args["previous-version"],
    tag: args.tag,
    outputPath: args.output,
  });
  if (!args.output) process.stdout.write(`${result.section}\n`);
}

if (process.argv[1] && process.argv[1].endsWith("validate-changelog.mjs")) main();
