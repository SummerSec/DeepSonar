/**
 * CI test-hook ratchet (#681).
 *
 * Every tracked `*.test.ts` must appear in a package.json script or GitHub
 * workflow, or sit on the allowlist. NEW unhooked tests fail. The allowlist
 * may only shrink (`--update`); growth vs origin/main fails.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const MANIFEST_SCHEMA = "deepsonar.ci-test-hook/v1";
export const MANIFEST_RELATIVE = "apps/scheduler/src/ci-test-hook.manifest.json";

const EXCLUDED_DIR_SEGMENTS = new Set(["node_modules", "dist", "build", ".git"]);
const PACKAGE_JSON_CANDIDATES = [
  "package.json",
  "apps/scheduler/package.json",
  "apps/web/package.json",
  "apps/image-admission/package.json",
  "apps/device-broker/package.json",
  "packages/runtime-sandbox/package.json",
] as const;
const PACKAGE_PREFIXES = [
  "apps/scheduler/",
  "apps/web/",
  "apps/image-admission/",
  "apps/device-broker/",
  "packages/runtime-sandbox/",
] as const;

export type CiTestHookManifest = {
  schema: string;
  /** Repo-relative posix paths of `*.test.ts` known to be unhooked from CI. */
  allowlist: string[];
};

export type GateFinding = {
  path: string;
  kind: "error" | "warn";
  message: string;
};

export type GateResult = {
  findings: GateFinding[];
  unhooked: string[];
  hooked: string[];
};

export function repoRootFromModuleUrl(moduleUrl: string = import.meta.url): string {
  const here = path.dirname(fileURLToPath(moduleUrl));
  return path.resolve(here, "../../..");
}

export function loadManifest(manifestPath: string): CiTestHookManifest {
  const raw = JSON.parse(readFileSync(manifestPath, "utf8")) as CiTestHookManifest;
  if (raw.schema !== MANIFEST_SCHEMA) {
    throw new Error(`unsupported ci-test-hook manifest schema: ${String(raw?.schema)}`);
  }
  if (!Array.isArray(raw.allowlist)) {
    throw new Error("ci-test-hook manifest missing allowlist array");
  }
  return {
    schema: raw.schema,
    allowlist: raw.allowlist.map((entry) => String(entry)).sort(),
  };
}

export function loadPreviousManifest(
  root: string,
  baseRef = process.env.CI_TEST_HOOK_BASE_REF ?? "origin/main",
): CiTestHookManifest | null {
  const refs = baseRef === "main" ? ["main"] : [baseRef, "main"];
  for (const ref of refs) {
    try {
      const raw = execFileSync("git", ["show", `${ref}:${MANIFEST_RELATIVE}`], {
        cwd: root,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
      return loadManifestFromRaw(raw, "previous");
    } catch {
      /* try next ref */
    }
  }
  return null;
}

function loadManifestFromRaw(raw: string, label: string): CiTestHookManifest {
  const parsed = JSON.parse(raw) as CiTestHookManifest;
  if (parsed.schema !== MANIFEST_SCHEMA) {
    throw new Error(`unsupported ${label} ci-test-hook manifest schema: ${String(parsed?.schema)}`);
  }
  if (!Array.isArray(parsed.allowlist)) {
    throw new Error(`${label} ci-test-hook manifest missing allowlist`);
  }
  return {
    schema: parsed.schema,
    allowlist: parsed.allowlist.map((entry) => String(entry)).sort(),
  };
}

export function listTrackedTestFiles(root: string): string[] {
  const out = execFileSync("git", ["ls-files", "-z"], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
  return out
    .split("\0")
    .filter(Boolean)
    .filter((rel) => !rel.split("/").some((segment) => EXCLUDED_DIR_SEGMENTS.has(segment)))
    .filter((rel) => rel.endsWith(".test.ts"))
    .sort();
}

export function referenceFormsForTest(relPosix: string): string[] {
  const forms = new Set<string>([relPosix]);
  for (const prefix of PACKAGE_PREFIXES) {
    if (relPosix.startsWith(prefix)) {
      const rest = relPosix.slice(prefix.length);
      forms.add(rest);
      forms.add(`../../${relPosix}`);
    }
  }
  return [...forms];
}

function listWorkflowFiles(root: string): string[] {
  const workflows = path.join(root, ".github", "workflows");
  if (!existsSync(workflows)) return [];
  const out: string[] = [];
  const stack = [workflows];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    for (const name of readdirSync(dir)) {
      const abs = path.join(dir, name);
      const st = statSync(abs);
      if (st.isDirectory()) {
        stack.push(abs);
        continue;
      }
      if (name.endsWith(".yml") || name.endsWith(".yaml")) out.push(abs);
    }
  }
  return out.sort();
}

export function buildReferenceCorpus(root: string, extraFiles: readonly string[] = []): string {
  const chunks: string[] = [];
  for (const rel of PACKAGE_JSON_CANDIDATES) {
    const abs = path.join(root, rel);
    if (existsSync(abs)) chunks.push(readFileSync(abs, "utf8"));
  }
  for (const abs of listWorkflowFiles(root)) {
    chunks.push(readFileSync(abs, "utf8"));
  }
  for (const rel of extraFiles) {
    const abs = path.isAbsolute(rel) ? rel : path.join(root, rel);
    if (existsSync(abs)) chunks.push(readFileSync(abs, "utf8"));
  }
  return chunks.join("\n");
}

export function isTestReferenced(relPosix: string, corpus: string): boolean {
  return referenceFormsForTest(relPosix).some((form) => form.length >= 8 && corpus.includes(form));
}

export function classifyTestHooks(options: {
  tests: readonly string[];
  corpus: string;
}): { hooked: string[]; unhooked: string[] } {
  const hooked: string[] = [];
  const unhooked: string[] = [];
  for (const rel of options.tests) {
    if (isTestReferenced(rel, options.corpus)) hooked.push(rel);
    else unhooked.push(rel);
  }
  return { hooked, unhooked };
}

export function evaluateGate(options: {
  manifest: CiTestHookManifest;
  previous: CiTestHookManifest | null;
  tests: readonly string[];
  corpus: string;
}): GateResult {
  const { manifest, previous, tests, corpus } = options;
  const findings: GateFinding[] = [];
  const { hooked, unhooked } = classifyTestHooks({ tests, corpus });
  const allow = new Set(manifest.allowlist);

  if (previous) {
    const prior = new Set(previous.allowlist);
    for (const rel of manifest.allowlist) {
      if (!prior.has(rel)) {
        findings.push({
          path: rel,
          kind: "error",
          message:
            "allowlist grew vs previous manifest; wire the test into ci:unit:* / workflows, or shrink with --update (growth is not allowed)",
        });
      }
    }
  }

  for (const rel of unhooked) {
    if (allow.has(rel)) continue;
    findings.push({
      path: rel,
      kind: "error",
      message:
        "new/unallowlisted test is not referenced by any package.json script or GitHub workflow; wire it into ci:unit:* (preferred) or temporarily grandfather only via a deliberate allowlist shrink path",
    });
  }

  for (const rel of manifest.allowlist) {
    if (!tests.includes(rel)) {
      findings.push({
        path: rel,
        kind: "error",
        message: "allowlist entry is not present in the tracked *.test.ts set; remove with --update",
      });
      continue;
    }
    if (hooked.includes(rel)) {
      findings.push({
        path: rel,
        kind: "warn",
        message: "allowlisted test is now hooked; shrink the allowlist with --update",
      });
    }
  }

  return { findings, unhooked, hooked };
}

export function runRepoGate(root: string, manifestPath: string): GateResult {
  const manifest = loadManifest(manifestPath);
  const tests = listTrackedTestFiles(root);
  const corpus = buildReferenceCorpus(root);
  const previous = loadPreviousManifest(root);
  return evaluateGate({ manifest, previous, tests, corpus });
}

export function updateManifestRatchet(
  root: string,
  manifestPath: string,
): { removed: string[]; kept: string[]; rejected: string[] } {
  const manifest = loadManifest(manifestPath);
  const tests = new Set(listTrackedTestFiles(root));
  const corpus = buildReferenceCorpus(root);
  const removed: string[] = [];
  const kept: string[] = [];
  const rejected: string[] = [];

  for (const rel of manifest.allowlist) {
    if (!tests.has(rel)) {
      removed.push(`${rel}: missing on disk`);
      continue;
    }
    if (isTestReferenced(rel, corpus)) {
      removed.push(`${rel}: now hooked`);
      continue;
    }
    kept.push(rel);
  }

  // --update only shrinks; never invent new allowlist entries for fresh unhooked tests.
  const stillUnhooked = classifyTestHooks({ tests: [...tests].sort(), corpus }).unhooked
    .filter((rel) => !kept.includes(rel));
  for (const rel of stillUnhooked) {
    rejected.push(
      `${rel}: still unhooked and not on allowlist (wire into CI; --update will not grow the baseline)`,
    );
  }

  const next: CiTestHookManifest = {
    schema: MANIFEST_SCHEMA,
    allowlist: [...kept].sort(),
  };
  writeFileSync(manifestPath, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  return { removed, kept, rejected };
}

function main(argv: string[]): void {
  const root = repoRootFromModuleUrl();
  const manifestPath = path.join(root, MANIFEST_RELATIVE);
  if (argv.includes("--update")) {
    const { removed, kept, rejected } = updateManifestRatchet(root, manifestPath);
    for (const line of removed) console.log(`removed: ${line}`);
    for (const line of rejected) console.error(`rejected: ${line}`);
    if (rejected.length > 0) {
      process.exitCode = 1;
      return;
    }
    if (removed.length === 0) console.log(`ci-test-hook allowlist already tight (${kept.length} entries)`);
    else console.log(`ci-test-hook allowlist shrunk to ${kept.length} entries`);
    return;
  }

  const result = runRepoGate(root, manifestPath);
  for (const finding of result.findings) {
    const prefix = finding.kind === "error" ? "error" : "warn";
    console[finding.kind === "error" ? "error" : "warn"](`${prefix}: ${finding.path}: ${finding.message}`);
  }
  const errors = result.findings.filter((f) => f.kind === "error");
  if (errors.length > 0) {
    console.error(`ci-test-hook gate failed with ${errors.length} error(s)`);
    process.exitCode = 1;
    return;
  }
  console.log(
    `ci-test-hook gate passed (hooked=${result.hooked.length} unhooked=${result.unhooked.length}; ${
      result.findings.filter((f) => f.kind === "warn").length
    } warning(s))`,
  );
}

const entry = process.argv[1] ? path.resolve(process.argv[1]) : "";
const self = path.resolve(fileURLToPath(import.meta.url));
if (entry === self) {
  main(process.argv.slice(2));
}
