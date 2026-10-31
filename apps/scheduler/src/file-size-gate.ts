/**
 * File-size / max-lines gate (Issue #544).
 *
 * Ratchet: grandfathered maxLines may only decrease (--update). Raising a
 * ceiling fails CI. New files over class hard limits fail immediately.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export type FileSizeClass = "logic" | "web" | "contract";

export type FileSizeLimits = {
  logicSoft: number;
  logicHard: number;
  webComponentSoft: number;
  contractHard: number;
};

export type GrandfatheredEntry = {
  class: FileSizeClass;
  maxLines: number;
  issue: string;
};

export type FileSizeManifest = {
  schema: string;
  limits: FileSizeLimits;
  contractPaths: string[];
  grandfathered: Record<string, GrandfatheredEntry>;
};

export type GateFinding = {
  path: string;
  kind: "error" | "warn";
  message: string;
};

export type GateResult = {
  findings: GateFinding[];
  measured: Record<string, number>;
};

export const MANIFEST_SCHEMA = "deepsonar.file-size/v1";
export const MANIFEST_RELATIVE = "apps/scheduler/src/file-size.manifest.json";

const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".mjs", ".cjs", ".sql"]);
const GENERATED_MARKERS = [/generated/i, /DO NOT EDIT/i, /自动生成/];
const EXCLUDED_DIR_SEGMENTS = new Set(["node_modules", "dist", "build"]);

export function repoRootFromModuleUrl(moduleUrl: string = import.meta.url): string {
  const here = path.dirname(fileURLToPath(moduleUrl));
  return path.resolve(here, "../../..");
}

export function loadManifest(manifestPath: string): FileSizeManifest {
  const raw = JSON.parse(readFileSync(manifestPath, "utf8")) as FileSizeManifest;
  if (raw.schema !== MANIFEST_SCHEMA) {
    throw new Error(`unsupported file-size manifest schema: ${String(raw?.schema)}`);
  }
  if (!raw.limits || !raw.grandfathered || !Array.isArray(raw.contractPaths)) {
    throw new Error("file-size manifest missing limits, contractPaths, or grandfathered");
  }
  return raw;
}

export function countLines(content: string): number {
  if (content.length === 0) return 0;
  return (content.match(/\n/g) ?? []).length;
}

export function isExcludedPath(relPosix: string): boolean {
  return relPosix.split("/").some((segment) => EXCLUDED_DIR_SEGMENTS.has(segment));
}

export function hasSourceExtension(relPosix: string): boolean {
  return SOURCE_EXTENSIONS.has(path.posix.extname(relPosix));
}

export function classifyPath(relPosix: string, contractPaths: readonly string[]): FileSizeClass {
  if (contractPaths.includes(relPosix)) return "contract";
  if (relPosix.startsWith("apps/web/") && relPosix.endsWith(".tsx") && !relPosix.includes(".test.")) {
    return "web";
  }
  return "logic";
}

export function hardLimitFor(fileClass: FileSizeClass, limits: FileSizeLimits): number {
  switch (fileClass) {
    case "web":
      return limits.webComponentSoft;
    case "contract":
      return limits.contractHard;
    default:
      return limits.logicHard;
  }
}

export function looksGenerated(content: string): boolean {
  const head = content.slice(0, 4000);
  return GENERATED_MARKERS.some((re) => re.test(head));
}

export function listTrackedSourceFiles(root: string): string[] {
  const out = execFileSync("git", ["ls-files", "-z"], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
  return out
    .split("\0")
    .filter(Boolean)
    .filter((rel) => !isExcludedPath(rel))
    .filter((rel) => hasSourceExtension(rel))
    .sort();
}

function parseManifestJson(raw: string, label: string): FileSizeManifest {
  const parsed = JSON.parse(raw) as FileSizeManifest;
  if (parsed.schema !== MANIFEST_SCHEMA) {
    throw new Error(`unsupported ${label} file-size manifest schema: ${String(parsed?.schema)}`);
  }
  return parsed;
}

export function loadPreviousManifest(
  root: string,
  baseRef = process.env.FILE_SIZE_BASE_REF ?? "origin/main",
): FileSizeManifest | null {
  const refs = baseRef === "main" ? ["main"] : [baseRef, "main"];
  for (const ref of refs) {
    try {
      const raw = execFileSync("git", ["show", `${ref}:${MANIFEST_RELATIVE}`], {
        cwd: root,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
      return parseManifestJson(raw, "previous");
    } catch {
      /* try next ref */
    }
  }
  return null;
}

export function evaluateManifestShape(manifest: FileSizeManifest): GateFinding[] {
  const findings: GateFinding[] = [];
  for (const [rel, entry] of Object.entries(manifest.grandfathered)) {
    if (!entry || typeof entry !== "object") {
      findings.push({ path: rel, kind: "error", message: "grandfathered entry must be an object" });
      continue;
    }
    if (entry.class !== "logic" && entry.class !== "web" && entry.class !== "contract") {
      findings.push({ path: rel, kind: "error", message: "grandfathered entry missing valid class" });
    }
    if (typeof entry.maxLines !== "number" || !Number.isInteger(entry.maxLines) || entry.maxLines < 1) {
      findings.push({ path: rel, kind: "error", message: "grandfathered entry missing valid maxLines" });
    }
    if (typeof entry.issue !== "string" || !/^#\d+$/.test(entry.issue)) {
      findings.push({
        path: rel,
        kind: "error",
        message: "grandfathered entry missing issue (expected form #123)",
      });
    }
  }
  return findings;
}

export function evaluateGate(options: {
  manifest: FileSizeManifest;
  previous: FileSizeManifest | null;
  files: readonly string[];
  contentsByPath: Record<string, string>;
}): GateResult {
  const { manifest, previous, files, contentsByPath } = options;
  const findings: GateFinding[] = [];
  const measured: Record<string, number> = {};

  findings.push(...evaluateManifestShape(manifest));

  for (const rel of manifest.contractPaths) {
    if (!(rel in contentsByPath)) {
      findings.push({ path: rel, kind: "error", message: "contractPaths entry is missing on disk" });
    }
  }

  for (const [rel, entry] of Object.entries(manifest.grandfathered)) {
    if (entry.class !== "contract") continue;
    const content = contentsByPath[rel];
    if (content == null) {
      findings.push({ path: rel, kind: "error", message: "contract grandfathered path is missing on disk" });
      continue;
    }
    if (!manifest.contractPaths.includes(rel) && !looksGenerated(content)) {
      findings.push({
        path: rel,
        kind: "error",
        message:
          "contract class requires a generated marker (generated / DO NOT EDIT / 自动生成) or an entry in contractPaths — do not reclassify logic files as contract to bypass the gate",
      });
    }
  }

  if (previous) {
    for (const [rel, entry] of Object.entries(manifest.grandfathered)) {
      const prior = previous.grandfathered[rel];
      if (prior && entry.maxLines > prior.maxLines) {
        findings.push({
          path: rel,
          kind: "error",
          message: `maxLines raised from ${prior.maxLines} to ${entry.maxLines}; split the file, or (not allowed) raise the ceiling; lower with --update`,
        });
      }
    }
  }

  for (const rel of files) {
    const content = contentsByPath[rel];
    if (content == null) continue;
    const lines = countLines(content);
    measured[rel] = lines;
    const entry = manifest.grandfathered[rel];

    if (entry) {
      if (lines > entry.maxLines) {
        findings.push({
          path: rel,
          kind: "error",
          message: `split the file, or (not allowed) raise maxLines; lower the ceiling with --update (lines=${lines} maxLines=${entry.maxLines})`,
        });
      }
      continue;
    }

    const fileClass = classifyPath(rel, manifest.contractPaths);
    const hard = hardLimitFor(fileClass, manifest.limits);
    if (lines > hard) {
      findings.push({
        path: rel,
        kind: "error",
        message: `new/ungrandfathered ${fileClass} file exceeds hard limit ${hard} (lines=${lines}); split before merge`,
      });
      continue;
    }

    if (fileClass === "logic" && lines >= manifest.limits.logicSoft && lines <= manifest.limits.logicHard) {
      findings.push({
        path: rel,
        kind: "warn",
        message: `approaching logic hard limit ${manifest.limits.logicHard} (lines=${lines}, soft=${manifest.limits.logicSoft})`,
      });
    }
  }

  for (const rel of Object.keys(manifest.grandfathered)) {
    if (!(rel in measured)) {
      findings.push({
        path: rel,
        kind: "error",
        message: "grandfathered path is not present in the tracked source set",
      });
    }
  }

  return { findings, measured };
}

export function runRepoGate(root: string, manifestPath: string): GateResult {
  const manifest = loadManifest(manifestPath);
  const files = listTrackedSourceFiles(root);
  const contentsByPath: Record<string, string> = {};
  for (const rel of files) {
    const abs = path.join(root, rel);
    if (!existsSync(abs)) continue;
    contentsByPath[rel] = readFileSync(abs, "utf8");
  }
  for (const rel of [...manifest.contractPaths, ...Object.keys(manifest.grandfathered)]) {
    if (rel in contentsByPath) continue;
    const abs = path.join(root, rel);
    if (existsSync(abs)) contentsByPath[rel] = readFileSync(abs, "utf8");
  }
  const previous = loadPreviousManifest(root);
  return evaluateGate({
    manifest,
    previous,
    files: [...new Set([...files, ...Object.keys(contentsByPath)])].sort(),
    contentsByPath,
  });
}

export function updateManifestRatchet(
  root: string,
  manifestPath: string,
): { changed: string[]; rejected: string[] } {
  const manifest = loadManifest(manifestPath);
  const changed: string[] = [];
  const rejected: string[] = [];

  for (const [rel, entry] of Object.entries(manifest.grandfathered)) {
    const abs = path.join(root, rel);
    if (!existsSync(abs)) {
      rejected.push(`${rel}: missing on disk`);
      continue;
    }
    const lines = countLines(readFileSync(abs, "utf8"));
    if (lines < entry.maxLines) {
      const previous = entry.maxLines;
      entry.maxLines = lines;
      changed.push(`${rel}: ${previous} → ${lines}`);
    } else if (lines > entry.maxLines) {
      rejected.push(
        `${rel}: lines ${lines} > maxLines ${entry.maxLines} (split the file; raising is not allowed)`,
      );
    }
  }

  if (rejected.some((line) => line.includes("raising is not allowed"))) {
    return { changed: [], rejected };
  }

  const next = {
    schema: manifest.schema,
    limits: manifest.limits,
    contractPaths: manifest.contractPaths,
    grandfathered: Object.fromEntries(
      Object.entries(manifest.grandfathered).sort(([a], [b]) => a.localeCompare(b)),
    ),
  };
  writeFileSync(manifestPath, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  return { changed, rejected };
}

function main(argv: string[]): void {
  const root = repoRootFromModuleUrl();
  const manifestPath = path.join(root, MANIFEST_RELATIVE);
  if (argv.includes("--update")) {
    const { changed, rejected } = updateManifestRatchet(root, manifestPath);
    for (const line of changed) console.log(`updated: ${line}`);
    for (const line of rejected) console.error(`rejected: ${line}`);
    if (rejected.length > 0) {
      process.exitCode = 1;
      return;
    }
    if (changed.length === 0) console.log("file-size manifest already tight; nothing to ratchet");
    return;
  }

  const result = runRepoGate(root, manifestPath);
  for (const finding of result.findings) {
    const prefix = finding.kind === "error" ? "error" : "warn";
    console[finding.kind === "error" ? "error" : "warn"](`${prefix}: ${finding.path}: ${finding.message}`);
  }
  const errors = result.findings.filter((f) => f.kind === "error");
  if (errors.length > 0) {
    console.error(`file-size gate failed with ${errors.length} error(s)`);
    process.exitCode = 1;
    return;
  }
  console.log(
    `file-size gate passed (${Object.keys(result.measured).length} files; ${
      result.findings.filter((f) => f.kind === "warn").length
    } warning(s))`,
  );
}

const entry = process.argv[1] ? path.resolve(process.argv[1]) : "";
const self = path.resolve(fileURLToPath(import.meta.url));
if (entry === self) {
  main(process.argv.slice(2));
}
