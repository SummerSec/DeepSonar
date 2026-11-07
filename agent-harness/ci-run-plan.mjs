#!/usr/bin/env node
/**
 * Build the pull-request run plan for the CI tier split (#836).
 *
 * One classifier, one plan: this module reuses classify-ci-changes.mjs instead
 * of inventing a second notion of "what changed". It only decides WHICH suites
 * this run must execute and whether the run is a Draft fast check or the full
 * merge-candidate verification. Nothing here may be used to skip a suite that
 * the plan says is required, and a failed classification always widens the plan.
 *
 * Baseline discipline (#836 step 1): the specialist suites are derived from the
 * path filters the specialist workflows already declare, read from the workflow
 * files at plan time. A workflow can therefore not drift from the plan, and no
 * coverage is narrowed by copying a stale table.
 */
import { appendFileSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { matchesAnyPath } from "./path-match.mjs";
import { classifyPackageJsonChange, planReverseSuites } from "./reverse-suite-plan.mjs";
import {
  CLASSIFIER_MODES,
  CLASSIFIER_STATUSES,
  classifyRecords,
  isDocsOnlyPath,
  parseGitNameStatusZ,
} from "./classify-ci-changes.mjs";

export const RUN_MODES = Object.freeze({
  DOCS: "docs",
  DRAFT_FAST: "draft-fast",
  READY_FULL: "ready-full",
});

export const PLAN_STATUSES = Object.freeze({
  OK: "ok",
  FAILED: "failed",
});

/** Repository variable that gates the rollout; anything but `tiered` is full. */
export const CI_PR_MODE_VARIABLE = "CI_PR_MODE";
export const TIERED_MODE = "tiered";

/** Specialist workflows that ci.yml can call, and the file that owns their paths. */
export const SPECIALIST_WORKFLOWS = Object.freeze({
  reverse: ".github/workflows/reverse-runtime.yml",
  chrome: ".github/workflows/chrome-runtime.yml",
  mobile: ".github/workflows/mobile-runtime.yml",
  openharmony: ".github/workflows/openharmony-runtime.yml",
});

/**
 * Draft fast checks: existing no-service suites only. Every entry must be a
 * `pnpm` script that runs without PostgreSQL, Docker or a browser.
 */
export const FAST_SUITE_ROUTES = Object.freeze([
  Object.freeze({ paths: Object.freeze(["apps/web/**"]), script: "ci:unit:web-facts" }),
  Object.freeze({ paths: Object.freeze(["apps/scheduler/**"]), script: "ci:unit:bounded-contexts" }),
  Object.freeze({ paths: Object.freeze(["packages/shared-types/**"]), script: "ci:unit:finding-protocol" }),
  Object.freeze({ paths: Object.freeze(["deploy/**"]), script: "ci:unit:deploy-ps1" }),
]);

const unquote = (value) => value.trim().replace(/^"(.*)"$/u, "$1").replace(/^'(.*)'$/u, "$1");

/**
 * Read the `pull_request.paths` filter a workflow declares. Text-based on
 * purpose: the CI image has no YAML dependency, and these blocks are simple
 * indented lists.
 */
export function readWorkflowPullRequestPaths(contents) {
  const lines = String(contents).split(/\r?\n/);
  const paths = [];
  let inOn = false;
  let inPullRequest = false;
  let inPaths = false;
  let pathsIndent = -1;
  for (const line of lines) {
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    const indent = line.length - line.trimStart().length;
    const trimmed = line.trim();
    if (indent === 0) {
      inOn = trimmed === "on:";
      inPullRequest = false;
      inPaths = false;
      continue;
    }
    if (!inOn) continue;
    if (indent === 2) {
      inPullRequest = trimmed.startsWith("pull_request:");
      inPaths = false;
      continue;
    }
    if (!inPullRequest) continue;
    if (!inPaths && /^paths:\s*$/u.test(trimmed)) {
      inPaths = true;
      pathsIndent = indent;
      continue;
    }
    if (!inPaths) continue;
    if (indent <= pathsIndent && !trimmed.startsWith("- ")) {
      inPaths = false;
      continue;
    }
    if (trimmed.startsWith("- ")) paths.push(unquote(trimmed.slice(2)));
  }
  return paths;
}

// #976: the matcher lives in path-match.mjs so the Reverse suite plan can use
// it without importing this module. Re-exported here to keep the existing API.
export { matchesAnyPath, matchesPathPattern, pathPatternToRegExp } from "./path-match.mjs";

/** Suites whose declared path filter is hit by any changed path, in stable order. */
export function matchSuites(suitePaths, paths) {
  return Object.keys(suitePaths)
    .filter((suite) => paths.some((path) => matchesAnyPath(suitePaths[suite], path)))
    .sort();
}

export function fastSuitesFor(paths) {
  return FAST_SUITE_ROUTES
    .filter((route) => paths.some((path) => matchesAnyPath(route.paths, path)))
    .map((route) => route.script);
}

/**
 * #961: inputs that invalidate the Chrome Fuzz V8 ARM gate even when no file
 * under the chrome specialist filter changed. The ARM gate derives from
 * `deepsonar-base` and shares the fingerprint/cache mechanism with the other
 * image jobs, so a base, fingerprint or routing change must keep it required.
 * Routing changes themselves are included on purpose: the plan model may not
 * grant itself a cheaper path.
 */
export const CHROME_FUZZ_ARM_PINNED_INPUTS = Object.freeze([
  "deploy/Dockerfile.agent",
  "agent-harness/runtime-images.json",
  "agent-harness/image-build-fingerprint.mjs",
  "agent-harness/resolve-image-src-cache.sh",
  "agent-harness/runtime-manuals/**",
  "agent-harness/materialize-runtime-manuals.mjs",
  ".dockerignore",
  ".github/workflows/ci.yml",
  "agent-harness/ci-run-plan.mjs",
  "agent-harness/classify-ci-changes.mjs",
]);

/** Reviewed business paths that neither the base nor Chrome runtime consumes. */
export const CHROME_FUZZ_ARM_NON_IMAGE_INPUTS = Object.freeze([
  "apps/scheduler/**",
  "apps/web/**",
  "packages/shared-types/**",
  "database/**",
]);

/**
 * Decide whether this run must execute the Chrome Fuzz ARM build + native smoke.
 *
 * Fail closed: a failed plan or an unreadable diff keeps the gate required.
 * Every "not required" answer carries a reason so `ci-summary` can explain the
 * skip instead of silently accepting it (#961 acceptance).
 */
export function chromeFuzzArmRequirement({
  status,
  mode,
  paths = [],
  suitePaths = {},
} = {}) {
  if (status !== PLAN_STATUSES.OK) {
    return { required: true, reason: "chrome_fuzz_plan_failed_fail_closed" };
  }
  if (mode === RUN_MODES.DOCS) {
    return { required: false, reason: "chrome_fuzz_docs_only" };
  }
  if (mode === RUN_MODES.DRAFT_FAST) {
    return { required: false, reason: "chrome_fuzz_draft_fast_path" };
  }
  if (paths.length === 0 || !suitePaths.chrome?.length) {
    return { required: true, reason: "chrome_fuzz_inputs_missing_fail_closed" };
  }
  const chromeInputs = [...suitePaths.chrome, ...CHROME_FUZZ_ARM_PINNED_INPUTS];
  if (paths.some((path) => matchesAnyPath(chromeInputs, path))) {
    return { required: true, reason: "chrome_fuzz_inputs_changed" };
  }
  if (paths.some((path) => !isDocsOnlyPath(path) && !matchesAnyPath(CHROME_FUZZ_ARM_NON_IMAGE_INPUTS, path))) {
    return { required: true, reason: "chrome_fuzz_unknown_input_fail_closed" };
  }
  return { required: false, reason: "chrome_fuzz_inputs_unchanged" };
}

/** Only `tiered` enables the Draft split; unset, invalid or `full` restore full PR runs. */
export const isTiered = (ciPrMode) => String(ciPrMode ?? "").trim() === TIERED_MODE;

/**
 * @param {{eventName?: string, base?: string, head?: string, draft?: boolean,
 *   diffBytes?: Buffer|string, classifier?: object, ciPrMode?: string,
 *   suitePaths?: Record<string, string[]>}} input
 */
export function buildRunPlan({
  eventName,
  base,
  head,
  draft = false,
  diffBytes,
  classifier,
  ciPrMode,
  suitePaths = {},
  // #976: package.json contents at base/head, used for the field-level impact
  // check. Missing contents keep every Reverse suite required (fail closed).
  packageJsonBase,
  packageJsonHead,
} = {}) {
  const suites = Object.keys(suitePaths).sort();
  const tiered = isTiered(ciPrMode);
  const plan = {
    status: PLAN_STATUSES.OK,
    mode: RUN_MODES.READY_FULL,
    docsOnly: false,
    requiredSuites: [],
    fastSuites: [],
    // #961: 默认必须跑 ARM 门禁；只有明确判定「与 Chrome 构建输入无关」的分支才置 false。
    chromeFuzzArm: true,
    // #976: Reverse/Pi-OM/Claude sub-suites this run must execute. Default is
    // the full set; only an evidence-backed branch narrows it.
    reverseSuites: [],
    tiered,
    reasons: [],
    base: base ?? "",
    head: head ?? "",
    inputs: {
      event: eventName ?? "unknown", draft: Boolean(draft), ciPrMode: ciPrMode ?? "",
      classifier: null, changes: [], omittedChanges: 0,
    },
  };

  // #976: captured while the diff is parsed so the Reverse sub-suite plan sees
  // the same records/paths as the specialist suite matching.
  let diffRecords = [];
  let diffPaths = [];
  const finalize = (candidate) => {
    const packageJsonChanged = diffPaths.includes("package.json");
    const impact = packageJsonChanged
      ? classifyPackageJsonChange({ baseText: packageJsonBase, headText: packageJsonHead })
      : { impact: "none", reasons: [] };
    const reverse = planReverseSuites({
      status: candidate.status,
      mode: candidate.mode,
      tiered: candidate.tiered,
      eventName,
      records: diffRecords,
      paths: diffPaths,
      packageJsonImpact: impact.impact,
      packageJsonReasons: impact.reasons,
    });
    candidate.reverseSuites = reverse.suites;
    candidate.reasons.push(...reverse.reasons.map((reason) => `reverse:${reason}`));
    return candidate;
  };

  if (eventName !== "pull_request") {
    plan.reasons.push("non_pull_request_event");
    plan.reasons.push("chrome_fuzz_required_non_pull_request");
    return finalize(plan);
  }
  if (!base || !head) {
    plan.status = PLAN_STATUSES.FAILED;
    plan.reasons.push("missing_pull_request_revision");
    plan.reasons.push("chrome_fuzz_plan_failed_fail_closed");
    plan.requiredSuites = suites;
    plan.fastSuites = [...new Set(FAST_SUITE_ROUTES.map((route) => route.script))];
    return finalize(plan);
  }

  let records;
  try {
    const bytes = diffBytes ?? readGitDiff(base, head);
    records = parseGitNameStatusZ(bytes);
    plan.reasons.push("diff_parsed");
  } catch {
    plan.status = PLAN_STATUSES.FAILED;
    plan.reasons.push("diff_read_failed");
    plan.reasons.push("chrome_fuzz_plan_failed_fail_closed");
    plan.requiredSuites = suites;
    plan.fastSuites = [...new Set(FAST_SUITE_ROUTES.map((route) => route.script))];
    return finalize(plan);
  }

  const classification = classifier ?? classifyRecords(records, { eventName, base, head });
  plan.inputs.classifier = classification;
  plan.inputs.classifierTrigger = records.find((record) =>
    !["M", "A"].includes(record.status) || record.paths.some((path) => !isDocsOnlyPath(path))) ?? null;
  // Explanatory only: decisions above/below still consume the entire diff.
  // Keep summaries bounded and retain Git's change status, including both rename sides.
  plan.inputs.changes = records.slice(0, 128);
  plan.inputs.omittedChanges = Math.max(0, records.length - 128);
  if (classification.status === CLASSIFIER_STATUSES.FAILED) {
    plan.status = PLAN_STATUSES.FAILED;
    plan.reasons.push(`classifier_failed:${classification.reason}`);
    plan.reasons.push("chrome_fuzz_plan_failed_fail_closed");
    plan.requiredSuites = suites;
    plan.fastSuites = [...new Set(FAST_SUITE_ROUTES.map((route) => route.script))];
    return finalize(plan);
  }

  diffRecords = records;
  const paths = records.flatMap((record) => (record.status[0] === "R" || record.status[0] === "C" ? record.paths : record.paths));
  diffPaths = paths;
  if (classification.mode === CLASSIFIER_MODES.DOCS_ONLY) {
    plan.mode = RUN_MODES.DOCS;
    plan.docsOnly = true;
    plan.reasons.push("docs_only");
    plan.chromeFuzzArm = false;
    plan.reasons.push("chrome_fuzz_docs_only");
    return finalize(plan);
  }

  const matched = matchSuites(suitePaths, paths);
  plan.fastSuites = fastSuitesFor(paths);
  if (matched.length === 0) plan.reasons.push("no_specialist_suite_matched");
  else plan.reasons.push(...matched.map((suite) => `suite:${suite}`));

  if (!tiered) {
    // Rollback path: keep the pre-#836 full PR acceptance for code changes and
    // let every specialist run from its own pull_request trigger.
    plan.reasons.push("ci_pr_mode_full");
    plan.chromeFuzzArm = true;
    plan.reasons.push("chrome_fuzz_required_full_mode");
    return finalize(plan);
  }
  if (draft) {
    plan.mode = RUN_MODES.DRAFT_FAST;
    plan.reasons.push("draft_fast_path");
    plan.chromeFuzzArm = false;
    plan.reasons.push("chrome_fuzz_draft_fast_path");
    return finalize(plan);
  }
  plan.reasons.push("ready_for_review_full_path");
  plan.requiredSuites = matched;
  const arm = chromeFuzzArmRequirement({
    status: plan.status,
    mode: plan.mode,
    paths,
    suitePaths,
  });
  plan.chromeFuzzArm = arm.required;
  plan.reasons.push(arm.reason);
  return finalize(plan);
}

function readGitDiff(base, head, cwd = process.cwd()) {
  const output = spawnSync("git", ["diff", "--name-status", "-z", "--find-renames", `${base}...${head}`], {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 16 * 1024 * 1024,
  });
  if (output.error || output.status !== 0) throw new Error("git diff failed");
  return output.stdout;
}

/** Load every specialist suite's declared pull-request path filter. */
export function loadSuitePaths(root, workflows = SPECIALIST_WORKFLOWS) {
  const paths = {};
  for (const [suite, file] of Object.entries(workflows)) {
    paths[suite] = readWorkflowPullRequestPaths(readFileSync(`${root}/${file}`, "utf8"));
  }
  return paths;
}

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--event-name") options.eventName = argv[++index];
    else if (argument === "--base") options.base = argv[++index];
    else if (argument === "--head") options.head = argv[++index];
    else if (argument === "--draft") options.draft = argv[++index] === "true";
    else if (argument === "--ci-pr-mode") options.ciPrMode = argv[++index];
    else if (argument === "--root") options.root = argv[++index];
    else if (argument === "--diff-file") options.diffFile = argv[++index];
    else if (argument === "--help" || argument === "-h") {
      console.log("Usage: node agent-harness/ci-run-plan.mjs --event-name <name> [--base <sha> --head <sha>] [--draft true|false] [--ci-pr-mode tiered|full]");
      process.exit(0);
    } else throw new Error(`unknown argument: ${argument}`);
  }
  return options;
}

/**
 * #992: human-readable reasons for the tokens the plan actually emits.
 *
 * Unknown tokens are printed verbatim instead of being dropped, so adding a new
 * reason can never make the summary silently less complete.
 */
const REASON_TEXT = Object.freeze({
  non_pull_request_event: "非 PR 事件：按主干/手动全量验收，不做范围收窄",
  missing_pull_request_revision: "缺少 PR base/head：fail closed，保守全跑",
  chrome_fuzz_required_non_pull_request: "非 PR 事件：Chrome Fuzz ARM 必跑",
  chrome_fuzz_plan_failed_fail_closed: "运行计划未成功：Chrome Fuzz ARM fail closed 必跑",
  diff_parsed: "diff 解析成功，按变更路径判定",
  diff_read_failed: "diff 读取失败：fail closed，保守全跑",
  docs_only: "仅命中纯文档白名单，跳过核心重活",
  chrome_fuzz_docs_only: "纯文档变更：Chrome Fuzz ARM 跳过",
  no_specialist_suite_matched: "没有命中任何专项 workflow 的路径基线",
  ci_pr_mode_full: "CI_PR_MODE 不是 tiered（或为 full）：按完整 PR 验收",
  chrome_fuzz_required_full_mode: "ready-full：Chrome Fuzz ARM 属于必跑集合",
  draft_fast_path: "Draft PR：只跑 draft-fast 快速套件",
  chrome_fuzz_draft_fast_path: "Draft PR：Chrome Fuzz ARM 跳过",
  ready_for_review_full_path: "Ready PR：走完整验收",
  chrome_fuzz_inputs_missing_fail_closed: "缺少 Chrome 路径基线或 diff 为空：fail closed 必跑",
  chrome_fuzz_inputs_changed: "命中 Chrome 专项或 ARM 固定输入：必跑",
  chrome_fuzz_unknown_input_fail_closed: "存在既非文档也非已知非镜像输入的路径：fail closed 必跑",
  chrome_fuzz_inputs_unchanged: "改动都不影响 ARM 镜像与冒烟：跳过",
  // Reverse 判定：planReverseSuites 在 reason 前统一加 `reverse_`，
  // buildRunPlan 再加 `reverse:`，所以真实 token 形如
  // `reverse:reverse_package_json_package_json_field_changed:dependencies`。
  reverse_plan_failed_fail_closed: "运行计划未成功：Reverse 三个子套件 fail closed 全跑",
  reverse_non_pull_request_full: "非 PR 事件：Reverse 保留全量",
  reverse_docs_only: "纯文档变更：Reverse 三个子套件都不跑",
  reverse_draft_fast_path: "Draft PR：Reverse 三个子套件都不跑",
  reverse_full_mode: "未启用 tiered：Reverse 保留全量",
  reverse_inputs_missing_fail_closed: "缺少变更路径：Reverse fail closed 全跑",
  reverse_package_json_unknown_fail_closed: "package.json 影响未知：Reverse fail closed 全跑",
  reverse_unsafe_change_status: "存在删除/改名/复制：无法证明无关，Reverse 全跑",
  reverse_routing_inputs_changed: "命中 Reverse 路由输入：全跑",
  reverse_shared_inputs_changed: "命中 Reverse 共享输入（base/锁文件/runtime-sandbox 等）：全跑",
  reverse_docs_paths_only: "改动都是文档：Reverse 三个子套件都不跑",
  reverse_inputs_unchanged: "改动都落在 Reverse 输入之外：三个子套件都不跑",
  package_json_missing: "缺少 package.json 内容：无法证明独立，Reverse 全跑",
  package_json_unparseable: "package.json 无法解析：Reverse 全跑",
  package_json_not_object: "package.json 顶层不是对象：Reverse 全跑",
  package_json_scripts_not_object: "package.json 的 scripts 不是对象：Reverse 全跑",
  package_json_scripts_unchanged: "package.json 只增删了不相关字段之外的内容：不扩大范围",
});

function explainPackageJson(token) {
  const [head, ...rest] = token.split(":");
  const detail = rest.join(":");
  switch (head) {
    case "package_json_field_changed": return `package.json 字段变化（${detail}）：Reverse 全跑`;
    case "package_json_script_removed": return `package.json 删除了脚本（${detail}）：Reverse 全跑`;
    case "package_json_script_modified": return `package.json 修改了已有脚本（${detail}）：Reverse 全跑`;
    case "package_json_script_added_consumed": return `新增脚本被专项消费（${detail}）：Reverse 全跑`;
    case "package_json_script_added_not_test": return `新增脚本不是 ci:unit:* 测试入口（${detail}）：Reverse 全跑`;
    case "package_json_script_added_not_test_command": return `新增脚本命令不含 --test（${detail}）：Reverse 全跑`;
    case "package_json_added_test_script": return `新增了独立测试脚本（${detail}）：不扩大范围`;
    default: return undefined;
  }
}

function explainReason(reason) {
  const raw = String(reason ?? "").trim();
  if (!raw) return "";
  if (REASON_TEXT[raw]) return REASON_TEXT[raw];
  if (raw.startsWith("reverse:")) {
    // `planReverseSuites` 已给 reason 加了 `reverse_` 前缀，这里剥掉再解释，
    // 否则 `package_json_*` 永远匹配不到（#992 review P2）。
    const inner = raw.slice("reverse:".length);
    // `reverse_suite:<name>` 不能再剥 `reverse_`，否则会变成 `suite:<name>`
    // 而丢掉「这是 Reverse 子套件」的语义。
    if (inner.startsWith("reverse_suite:")) {
      return `计划执行 Reverse 子套件：${inner.slice("reverse_suite:".length)}`;
    }
    const token = inner.startsWith("reverse_") ? inner.slice("reverse_".length) : inner;
    // `reverse_package_json_` 又套了一层 `package_json_*`，所以要试两种形态：
    // `reverse_package_json_package_json_field_changed:dependencies` 的真实字段
    // 判定在第二次剥离之后。
    const variants = [token];
    if (token.startsWith("package_json_package_json_")) variants.push(token.slice("package_json_".length));
    for (const candidate of variants) {
      if (REASON_TEXT[`reverse_${candidate}`]) return REASON_TEXT[`reverse_${candidate}`];
      if (REASON_TEXT[candidate]) return REASON_TEXT[candidate];
      if (candidate.startsWith("reverse_suite:")) return `计划执行 Reverse 子套件：${candidate.slice("reverse_suite:".length)}`;
      const pkg = explainPackageJson(candidate);
      if (pkg) return pkg;
    }
    return `Reverse 判定：${token}`;
  }
  if (raw.startsWith("suite:")) return `命中专项 workflow：${raw.slice("suite:".length)}`;
  if (raw.startsWith("classifier_failed:")) return `变更分类失败（${raw.slice("classifier_failed:".length)}）：fail closed 保守全跑`;
  if (raw.startsWith("chrome_fuzz_")) return `Chrome Fuzz ARM 判定：${raw.slice("chrome_fuzz_".length)}`;
  const pkg = explainPackageJson(raw);
  if (pkg) return pkg;
  return `未登记原因：${raw}`;
}

/**
 * #992: why were the Reverse suites skipped?
 *
 * `planReverseSuites` returns an empty suite list in three different situations
 * (docs-only, Draft fast path, and "inputs proven unrelated"), so a single
 * canned sentence would misattribute the reason (#992 review P2).
 */
function reverseSkipReason(plan, reasons) {
  if (plan.mode === "docs") return "纯文档变更";
  if (plan.mode === "draft-fast") return "Draft PR 只跑 draft-fast 快速套件";
  if (reasons.some((reason) => String(reason).endsWith("reverse_docs_paths_only"))) return "改动都是文档";
  return "改动都落在 Reverse 输入之外，已证明无关";
}

export function explainRunPlan(plan = {}) {
  const reasons = Array.isArray(plan.reasons) ? plan.reasons : [];
  const required = Array.isArray(plan.requiredSuites) ? plan.requiredSuites : [];
  const fast = Array.isArray(plan.fastSuites) ? plan.fastSuites : [];
  const reverse = Array.isArray(plan.reverseSuites) ? plan.reverseSuites : [];
  const skippedReverse = ["reverse", "claude", "pi-om"].filter((suite) => !reverse.includes(suite));
  const lines = [
    "### CI 运行计划（#992）",
    "",
    "| 项 | 值 |",
    "| --- | --- |",
    `| 模式 | \`${plan.mode ?? "unknown"}\` |`,
    `| 计划状态 | \`${plan.status ?? "unknown"}\` |`,
    `| 基线 → 头部 | \`${String(plan.base ?? "").slice(0, 12)}\` → \`${String(plan.head ?? "").slice(0, 12)}\` |`,
    `| 纯文档 | ${plan.docsOnly ? "是" : "否"} |`,
    `| tiered 分层 | ${plan.tiered ? "启用" : "未启用（完整验收）"} |`,
    `| 核心必需专项 | ${required.length ? required.map((name) => `\`${name}\``).join("、") : "无"} |`,
    `| 快速套件 | ${fast.length ? fast.map((name) => `\`${name}\``).join("、") : "无"} |`,
    `| Chrome Fuzz ARM | ${plan.chromeFuzzArm ? "必跑" : "跳过"} |`,
    "",
    "**判定依据**",
    "",
  ];
  if (reasons.length === 0) lines.push("- 无（计划未记录原因，按 fail closed 处理）");
  for (const reason of reasons) lines.push(`- \`${reason}\`：${explainReason(reason)}`);
  lines.push("");
  lines.push(`**Reverse 子套件**：${reverse.length ? reverse.map((name) => `\`${name}\``).join("、") : "全部跳过"}`);
  if (skippedReverse.length) {
    lines.push("");
    lines.push(`**Reverse 跳过**：${skippedReverse.map((name) => `\`${name}\``).join("、")}（原因：${reverseSkipReason(plan, reasons)}）`);
  }
  lines.push("");
  // JSON escapes embedded newlines; HTML escaping also prevents filenames or
  // variable values from forging summary markup. No shell eval / path links.
  lines.push("**实际输入与命中路径**（完整 diff 用于决策，下列最多展示 128 条）", "", "```json");
  lines.push(JSON.stringify({ checkout: plan.checkout ?? null, ...plan.inputs }, null, 2)
    .replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;"));
  lines.push("```", "");
  lines.push("> 跳过判定只缩小范围，不放宽门禁：失败、取消、缺片或应跑误跳过都会被 `ci-summary` / `reverse-runtime-acceptance` 拒绝。");
  return `${lines.join("\n")}\n`;
}

function writeGitHubOutput(plan) {
  const outputPath = process.env.GITHUB_OUTPUT;
  if (!outputPath) return;
  appendFileSync(outputPath, [
    `mode=${plan.mode}`,
    `plan_status=${plan.status}`,
    `docs_only=${plan.docsOnly}`,
    `tiered=${plan.tiered}`,
    `required_suites=${plan.requiredSuites.join(",")}`,
    `fast_suites=${plan.fastSuites.join(",")}`,
    `chrome_fuzz_arm=${plan.chromeFuzzArm ? "required" : "skipped"}`,
    `reverse_suites=${plan.reverseSuites.join(",")}`,
    `reasons=${plan.reasons.join(",")}`,
    `base=${plan.base}`,
    `head=${plan.head}`,
  ].join("\n") + "\n");
}

/**
 * #976: read `package.json` at a revision so the field-level impact check can
 * compare base and head. Any failure returns undefined, which the plan treats
 * as "cannot prove independence" and keeps every Reverse suite required.
 */
function readPackageJsonAt(revision, cwd = process.cwd()) {
  if (!revision) return undefined;
  const output = spawnSync("git", ["show", `${revision}:package.json`], {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 16 * 1024 * 1024,
  });
  if (output.error || output.status !== 0) return undefined;
  return output.stdout.toString("utf8");
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const root = options.root ?? process.cwd();
  const plan = buildRunPlan({
    eventName: options.eventName,
    base: options.base,
    head: options.head,
    draft: options.draft,
    ciPrMode: options.ciPrMode ?? process.env[CI_PR_MODE_VARIABLE],
    suitePaths: loadSuitePaths(root),
    packageJsonBase: readPackageJsonAt(options.base, root),
    packageJsonHead: readPackageJsonAt(options.head, root),
    ...(options.diffFile ? { diffBytes: readFileSync(options.diffFile) } : {}),
  });
  const identity = spawnSync("git", ["rev-parse", "HEAD", "HEAD^{tree}"], {
    cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
  });
  const [sha, tree] = String(identity.stdout ?? "").trim().split(/\s+/u);
  plan.checkout = identity.status === 0 && /^[0-9a-f]{40}$/u.test(sha ?? "") && /^[0-9a-f]{40}$/u.test(tree ?? "")
    ? { sha, tree } : null;
  writeGitHubOutput(plan);
  console.log(JSON.stringify(plan, null, 2));
  // #992: GitHub sets GITHUB_STEP_SUMMARY for every step; writing here keeps the
  // explanation available without changing any workflow file.
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (summaryPath) appendFileSync(summaryPath, explainRunPlan(plan));
  if (plan.status === PLAN_STATUSES.FAILED) process.exitCode = 1;
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) main();