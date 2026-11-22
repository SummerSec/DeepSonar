#!/usr/bin/env node
/**
 * Classify a pull-request diff for the core CI workflow.
 *
 * The safe result is deliberately narrow: only an explicit list of ordinary
 * documentation paths may produce docs-only. Everything else requires the
 * full workflow. GitHub's NUL-delimited name-status output is parsed so that
 * spaces and Unicode in paths cannot change the classification.
 */
import { appendFileSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export const CLASSIFIER_MODES = Object.freeze({
  DOCS_ONLY: "docs-only",
  FULL: "full",
});

export const CLASSIFIER_STATUSES = Object.freeze({
  OK: "ok",
  FAILED: "failed",
});

// Keep this list explicit. A new documentation path must be reviewed before
// it can suppress the full CI workflow. In particular, do not replace this
// with a Markdown suffix rule, docs/**, or a suffix-only check.
//
// #1221 adds two reviewed exceptions on top of the list:
//  - root `DESIGN.md` is documentation only; `docs-freshness` still runs in the
//    docs lane and is what keeps its schema/version statements honest;
//  - new or modified plain Markdown under `docs/superpowers/plans/` are design
//    notes with no build, packaging or runtime consumer (verified by grep), so
//    they do not need a per-file allowlist entry. The rule stays a *file name*
//    rule (no nested directories, no leading dot, ASCII name, exactly `.md`),
//    and every non A/M git status (delete, rename, copy, type change, unknown)
//    still fails closed before this rule is consulted.
export const DOCS_ONLY_PATHS = Object.freeze([
  "CHANGELOG.md",
  "DESIGN.md",
  "LICENSE",
  "README.md",
  "THIRD_PARTY_NOTICES.md",
  "docs/AGENT_CLI_RUNTIME_ADAPTERS.md",
  "docs/AGENT_RUNTIME_CONTEXT.md",
  "docs/AGENT_RUNTIME_PROFILES.md",
  "docs/ARCHITECTURE.md",
  "docs/ARCHITECTURE_SCHEDULER_BOUNDED_CONTEXTS.md",
  "docs/AI_NATIVE_TRUSTED_KERNEL.md",
  "docs/CLI_CAPABILITIES.md",
  "docs/CI_COST_ACCEPTANCE_992.md",
  "docs/DEVICE_ACCESS.md",
  "docs/EVIDENCE_TRACE.md",
  "docs/EXTENSION_MATERIALIZATION.md",
  "docs/ISSUE_752_TRIAL.md",
  "docs/LANGUAGE_SERVER_CAPABILITIES.md",
  "docs/ONE_CLICK_DEPLOYMENT.md",
  "docs/PI_RPC_PAYLOAD_LIMITS.md",
  "docs/PLAN_BOUNDED_INTENT_DESIGN.md",
  "docs/PLAN_GAP_PROJECTION.md",
  "docs/PROJECT_FINDING_EVALUATION.md",
  "docs/PROJECT_FINDING_RESEARCH.md",
  "docs/PROJECT_KNOWLEDGE.md",
  "docs/PROJECT_REVIEW_2026-08.md",
  "docs/PROVIDER_ADAPTER_MODEL_DESCRIPTOR.md",
  "docs/REA_CLI_CAPABILITIES.md",
  "docs/README.md",
  "docs/RELEASE_READINESS_POST_v0.4.4.md",
  "docs/RELEASE_RUNTIME_IMAGES.md",
  "docs/REPAIR_FEEDBACK_ACCEPTANCE.md",
  "docs/REPAIR_FEEDBACK_BASELINE.md",
  "docs/REPAIR_FEEDBACK_CLI_MATRIX.md",
  "docs/REPAIR_FEEDBACK_DONE_REPAIR.md",
  "docs/RUNTIME_IMAGE_CONTRACT_DEPLOY.md",
  "docs/RUNTIME_IMAGE_REGISTRY_CONTRACT.md",
  "docs/RUNTIME_ROLE_IMAGE_MATRIX.md",
  "docs/RUNTIME_TEST_TOOLCHAINS.md",
  "docs/RUNTIME_TOOL_MANUALS.md",
  "docs/SHARED_ASSET_BLOB_STORE.md",
  "docs/TASK_DISPATCH_ACCEPTANCE.md",
  "docs/TASK_GOAL_REVIEW.md",
  "docs/TASK_OUTCOME_ADMISSION.md",
  "docs/TASK_OUTCOME_REPORT.md",
  "docs/TASK_RESULT_REVIEW.md",
  "docs/TODO_CANVAS_PROCESS_TRUTH.md",
  "docs/USAGE_LIMITS.md",
  "docs/architecture/01-system-specification.md",
  "docs/architecture/02-context-and-scope.md",
  "docs/architecture/03-constraints-and-principles.md",
  "docs/architecture/04-quality-attributes.md",
  "docs/architecture/05-building-blocks.md",
  "docs/architecture/06-runtime-view.md",
  "docs/architecture/07-deployment-view.md",
  "docs/architecture/08-data-architecture.md",
  "docs/architecture/09-interface-specs.md",
  "docs/architecture/10-security-and-trust-boundaries.md",
  "docs/architecture/11-engineering-specs.md",
  "docs/architecture/12-risks-and-tech-debt.md",
  "docs/architecture/README.md",
  "docs/architecture/adr/0001-no-backward-compatibility.md",
  "docs/architecture/adr/0002-schema-baseline.md",
  "docs/architecture/adr/0003-api-only-control.md",
  "docs/architecture/adr/0004-fact-and-finding-verification.md",
  "docs/architecture/adr/0005-event-evidence-stream.md",
  "docs/architecture/adr/0006-runtime-image-admission.md",
  "docs/architecture/adr/0007-paused-upgrade-recovery.md",
  "docs/architecture/adr/0008-maintenance-candidate-upgrade.md",
  "docs/architecture/adr/0009-finding-source-identity.md",
  "docs/architecture/adr/README.md",
  "docs/architecture/traceability.md",
  "docs/runbooks/runtime-image-pull-partial-failure.md",
  "docs/superpowers/plans/2026-10-15-architecture-741.md",
  "docs/superpowers/plans/2026-10-20-project-knowledge-lifecycle.md",
  "docs/superpowers/specs/2026-10-20-project-knowledge-lifecycle.md",
]);

const DOCS_ONLY_SET = new Set(DOCS_ONLY_PATHS);

/**
 * #1221：已评审的设计方案目录。只接受 `docs/superpowers/plans/` 下**直接**新增或修改的
 * 普通 Markdown 文件名（ASCII 名称、必须 `.md` 结尾、无子目录、无前导点），避免变成
 * `docs/**` 或后缀放行。删除/重命名/复制/类型变更在到达这里之前已 fail closed。
 */
const REVIEWED_DOC_DIRECTORIES = Object.freeze([
  /^docs\/superpowers\/plans\/[A-Za-z0-9][A-Za-z0-9._-]*\.md$/u,
]);
const ALWAYS_FULL_SEGMENTS = new Set(["code", "config", "evidence", "prompts", "skills", "workflows"]);

function normalizePath(path) {
  return String(path);
}

function pathHasAlwaysFullSegment(path) {
  return normalizePath(path).split("/").some((segment) => ALWAYS_FULL_SEGMENTS.has(segment));
}

export function isDocsOnlyPath(path) {
  const normalized = normalizePath(path);
  if (!normalized || normalized.startsWith("/") || normalized.includes("\0") || normalized.includes("\\")) return false;
  if (normalized.split("/").some((segment) => segment === "" || segment === "." || segment === "..")) return false;
  if (pathHasAlwaysFullSegment(normalized)) return false;
  if (DOCS_ONLY_SET.has(normalized)) return true;
  return REVIEWED_DOC_DIRECTORIES.some((pattern) => pattern.test(normalized));
}

/**
 * Parse `git diff --name-status -z` output.
 * Rename/copy records carry two paths; all other records carry one path.
 */
export function parseGitNameStatusZ(input) {
  const bytes = Buffer.isBuffer(input) ? input : Buffer.from(String(input), "utf8");
  if (bytes.length > 0 && bytes.at(-1) !== 0) throw new Error("unterminated git diff record");
  const tokens = [];
  let start = 0;
  for (let index = 0; index < bytes.length; index += 1) {
    if (bytes[index] !== 0) continue;
    tokens.push(bytes.subarray(start, index).toString("utf8"));
    start = index + 1;
  }
  if (start < bytes.length) tokens.push(bytes.subarray(start).toString("utf8"));
  if (tokens.at(-1) === "") tokens.pop();

  const records = [];
  let index = 0;
  while (index < tokens.length) {
    const status = tokens[index++];
    if (!status || /[\0\t\r\n]/u.test(status)) throw new Error("malformed git diff status");
    if (!/^(?:[ACDMRTUXB]|[RC][0-9]{1,3})$/u.test(status)) throw new Error("malformed git diff status");
    const code = status[0];
    const pathCount = code === "R" || code === "C" ? 2 : 1;
    if (index + pathCount > tokens.length) throw new Error("malformed git diff path record");
    const paths = tokens.slice(index, index + pathCount);
    index += pathCount;
    if (paths.some((path) => !path || path.includes("\0"))) throw new Error("malformed git diff path");
    records.push({ status, paths });
  }
  return records;
}

/**
 * Parse `git diff --raw -z` output. Unlike `--name-status`, raw records carry the
 * blob modes, which is what tells a real document from a symlink (120000) or a
 * submodule (160000) that merely has a `.md` name (#1221 review).
 */
export function parseGitRawZ(input) {
  const bytes = Buffer.isBuffer(input) ? input : Buffer.from(String(input), "utf8");
  if (bytes.length > 0 && bytes.at(-1) !== 0) throw new Error("unterminated git diff record");
  const tokens = bytes.toString("utf8").split("\0");
  if (tokens.at(-1) === "") tokens.pop();
  const records = [];
  let index = 0;
  while (index < tokens.length) {
    const header = tokens[index++];
    if (!header.startsWith(":")) throw new Error("malformed git raw diff header");
    const fields = header.slice(1).split(" ");
    if (fields.length !== 5) throw new Error("malformed git raw diff header");
    const [oldMode, newMode, , , status] = fields;
    const pathCount = /^[RC]/u.test(status) ? 2 : 1;
    const paths = tokens.slice(index, index + pathCount);
    index += pathCount;
    if (paths.length !== pathCount || paths.some((path) => !path || path.includes("\0"))) {
      throw new Error("malformed git diff path");
    }
    records.push({ status, paths, oldMode, newMode });
  }
  return records;
}

/** Accept either `--raw -z` or legacy `--name-status -z` fixture bytes. */
export function parseGitDiffRecords(input) {
  const bytes = Buffer.isBuffer(input) ? input : Buffer.from(String(input), "utf8");
  if (bytes.length > 0 && bytes[0] === 0x3a /* ":" */) return parseGitRawZ(bytes);
  return parseGitNameStatusZ(bytes);
}

export function isRegularFileMode(mode) {
  return mode === "100644";
}

/**
 * Docs-only requires a real regular file: symlinks (120000), submodules (160000)
 * and missing mode data are unsafe. A modification must also have been a regular
 * file before, so "existing symlink retargeted" cannot pass.
 */
function recordHasSafeFileMode(record) {
  if (typeof record.oldMode !== "string" || typeof record.newMode !== "string") return false;
  if (!isRegularFileMode(record.newMode)) return false;
  if (record.status === "M" && !isRegularFileMode(record.oldMode)) return false;
  return true;
}

export function classifyRecords(records, { eventName = "pull_request", base = "", head = "" } = {}) {
  if (eventName !== "pull_request") {
    return { mode: CLASSIFIER_MODES.FULL, status: CLASSIFIER_STATUSES.OK, reason: "non_pull_request_event", changedCount: 0 };
  }
  if (!base || !head) {
    return { mode: CLASSIFIER_MODES.FULL, status: CLASSIFIER_STATUSES.FAILED, reason: "missing_pull_request_revision", changedCount: 0 };
  }
  if (!Array.isArray(records)) {
    return { mode: CLASSIFIER_MODES.FULL, status: CLASSIFIER_STATUSES.FAILED, reason: "invalid_diff_records", changedCount: 0 };
  }
  if (records.length === 0) {
    return { mode: CLASSIFIER_MODES.FULL, status: CLASSIFIER_STATUSES.OK, reason: "empty_diff", changedCount: 0 };
  }

  for (const record of records) {
    if (!record || typeof record.status !== "string" || !Array.isArray(record.paths)) {
      return { mode: CLASSIFIER_MODES.FULL, status: CLASSIFIER_STATUSES.FAILED, reason: "invalid_diff_record", changedCount: records.length };
    }
    const code = record.status[0];
    if (record.status !== "A" && record.status !== "M") {
      return { mode: CLASSIFIER_MODES.FULL, status: CLASSIFIER_STATUSES.OK, reason: code === "R" ? "rename" : code === "D" ? "delete" : "unsafe_change_status", changedCount: records.length };
    }
    if (!recordHasSafeFileMode(record)) {
      return { mode: CLASSIFIER_MODES.FULL, status: CLASSIFIER_STATUSES.OK, reason: "unsafe_file_mode", changedCount: records.length };
    }
    if (record.paths.length !== 1 || !isDocsOnlyPath(record.paths[0])) {
      return { mode: CLASSIFIER_MODES.FULL, status: CLASSIFIER_STATUSES.OK, reason: "path_not_allowlisted", changedCount: records.length };
    }
  }
  return { mode: CLASSIFIER_MODES.DOCS_ONLY, status: CLASSIFIER_STATUSES.OK, reason: "all_paths_allowlisted", changedCount: records.length };
}

function readGitDiff(base, head, cwd = process.cwd()) {
  return execFileSync("git", ["diff", "--raw", "-z", "--find-renames", `${base}...${head}`], {
    cwd,
    encoding: "buffer",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 16 * 1024 * 1024,
  });
}

export function classifyPullRequest({ eventName, base, head, cwd = process.cwd(), diffBytes } = {}) {
  if (!eventName) {
    return { mode: CLASSIFIER_MODES.FULL, status: CLASSIFIER_STATUSES.FAILED, reason: "missing_event_name", changedCount: 0 };
  }
  if (eventName !== "pull_request") return classifyRecords([], { eventName, base, head });
  if (!base || !head) return classifyRecords(null, { eventName, base, head });
  try {
    const bytes = diffBytes ?? readGitDiff(base, head, cwd);
    return classifyRecords(parseGitDiffRecords(bytes), { eventName, base, head });
  } catch {
    return { mode: CLASSIFIER_MODES.FULL, status: CLASSIFIER_STATUSES.FAILED, reason: "diff_read_failed", changedCount: 0 };
  }
}

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--event-name") options.eventName = argv[++index];
    else if (argument === "--base") options.base = argv[++index];
    else if (argument === "--head") options.head = argv[++index];
    else if (argument === "--diff-file") options.diffFile = argv[++index];
    else if (argument === "--help" || argument === "-h") {
      console.log("Usage: node agent-harness/classify-ci-changes.mjs --event-name <name> [--base <sha> --head <sha>]");
      process.exit(0);
    } else throw new Error(`unknown argument: ${argument}`);
  }
  return options;
}

function writeGitHubOutput(result) {
  const outputPath = process.env.GITHUB_OUTPUT;
  if (!outputPath) return;
  appendFileSync(outputPath, [
    `docs_only=${result.mode === CLASSIFIER_MODES.DOCS_ONLY}`,
    `mode=${result.mode}`,
    `classifier_status=${result.status}`,
    `reason=${result.reason}`,
    `changed_count=${result.changedCount}`,
  ].join("\n") + "\n");
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const result = options.diffFile
    ? classifyPullRequest({
        eventName: options.eventName,
        base: options.base,
        head: options.head,
        diffBytes: readFileSync(options.diffFile),
      })
    : classifyPullRequest(options);
  writeGitHubOutput(result);
  console.log(`mode=${result.mode}`);
  console.log(`classifier_status=${result.status}`);
  console.log(`reason=${result.reason}`);
  console.log(`changed_count=${result.changedCount}`);
  if (result.status === CLASSIFIER_STATUSES.FAILED) process.exitCode = 1;
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) main();
