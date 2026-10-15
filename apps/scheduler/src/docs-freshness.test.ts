/**
 * 文档保鲜门禁（#696）。
 *
 * 发版前的人工保鲜清单见 `AGENTS.md` 的「发布前的文档保鲜（发版硬门）」；
 * 本套件把其中可机检的部分变成会失败的断言：
 *
 *   1. `AGENTS.md` / `DESIGN.md` / `docs/**` 里的 schema 主线版本 == `SCHEMA_VERSION`；
 *   2. as-built 文档里引用的 `pnpm <script>` 都存在于根 `package.json`；
 *   3. 文档里的相对链接与图片都有目标文件；
 *   4. 已删机制（`project_managed` / `image_strategy` / `role_runtime_images` / `项目镜像策略`）
 *      只允许出现在已声明「解释移除」的文档里；
 *   5. `docs/architecture/**`（#741）纳入上述扫描，且每个文件文首标注状态与同步日期。
 *
 * 机检覆盖不到语义：**「as-built 段落是否与代码相反」仍需人工按清单第 3 项逐条核**，
 * 本套件只能在版本字面量、命令、链接和已删机制残留上兜底。
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { repoRootFromModuleUrl } from "./file-size-gate.js";

const ROOT = repoRootFromModuleUrl();

/** 历史快照 / 素材文档：正文保留当时的命令与版本，不参与命令与链接门禁。 */
const HISTORICAL_DOCS = new Set([
  "docs/PROJECT_REVIEW_2026-08.md",
  "docs/TASTE_SKILL_TUTORIAL_LANDING_PROMPTS.md",
  "docs/RELEASE_READINESS_POST_v0.4.4.md",
]);

/**
 * 允许出现已删机制字面量的文档：它们都在解释「该机制已删除 / 已被清扫 / 已被收敛」。
 * 其它文件命中即失败——确需在别处解释已删机制时，把文件加进本清单，并在 PR 里说明原因。
 */
const DEAD_TOKEN_DOCS = new Set([
  "AGENTS.md",
  "DESIGN.md",
  "CHANGELOG.md",
  "docs/ARCHITECTURE.md",
  "docs/README.md",
  "docs/ONE_CLICK_DEPLOYMENT.md",
  "docs/RUNTIME_ROLE_IMAGE_MATRIX.md",
]);

const DEAD_TOKENS = ["project_managed", "image_strategy", "role_runtime_images", "项目镜像策略"];

/** `pnpm` 后面不是脚本名的常见写法。 */
const NON_SCRIPT_TOKENS = new Set(["install", "exec", "dlx", "add", "run", "workspace"]);

/** Normalize to POSIX separators so Windows `path.join` results match forward-slash literals / Set keys. */
function toPosixRelative(relative: string): string {
  return relative.split(path.sep).join("/");
}

function relativeFiles(dir: string, extensions: string[]): string[] {
  const absolute = path.join(ROOT, dir);
  if (!existsSync(absolute)) return [];
  return readdirSync(absolute, { withFileTypes: true }).flatMap((entry) => {
    const relative = toPosixRelative(path.join(dir, entry.name));
    if (entry.isDirectory()) return relativeFiles(relative, extensions);
    return extensions.some((extension) => entry.name.endsWith(extension)) ? [relative] : [];
  });
}

function docFiles(): string[] {
  return [
    "AGENTS.md",
    "DESIGN.md",
    "README.md",
    ...relativeFiles("docs", [".md"]),
    ...relativeFiles("skills", [".md"]),
  ].filter((file) => existsSync(path.join(ROOT, file)));
}

function read(relative: string): string {
  return readFileSync(path.join(ROOT, relative), "utf8");
}

/** 去掉围栏代码块，避免把示例命令里的 `[x](y)` 当链接、把 `pnpm ...` 当文档命令。 */
function stripFences(text: string): string {
  return text.replace(/^```[\s\S]*?^```/gm, "");
}

test("#696 文档声明的 schema 主线版本与 SCHEMA_VERSION 一致", () => {
  const source = read("apps/scheduler/src/schema-version.ts");
  const version = /SCHEMA_VERSION\s*=\s*(\d+)/.exec(source)?.[1];
  assert.ok(version, "apps/scheduler/src/schema-version.ts 必须导出数字 SCHEMA_VERSION");

  const declared = new Map<string, Set<string>>();
  for (const file of ["AGENTS.md", "DESIGN.md", ...relativeFiles("docs", [".md"])]) {
    for (const match of read(file).matchAll(/当前主线\s*v(\d+)/g)) {
      const seen = declared.get(match[1]!) ?? new Set<string>();
      seen.add(file);
      declared.set(match[1]!, seen);
    }
  }

  assert.ok(declared.has(version), `没有任何文档声明当前主线 v${version}（找到了 ${[...declared.keys()].join(", ") || "无"}）`);
  const stale = [...declared.entries()].filter(([declaredVersion]) => declaredVersion !== version);
  assert.deepEqual(
    stale.map(([declaredVersion, files]) => `v${declaredVersion} → ${[...files].join(", ")}`),
    [],
    `文档里的 schema 主线版本与 SCHEMA_VERSION = ${version} 不一致，请按 AGENTS.md「发布前的文档保鲜」第 1 项回写`,
  );

  const packageVersion = JSON.parse(read("package.json")).version as string;
  const changelog = read("CHANGELOG.md");
  assert.ok(
    changelog.includes(packageVersion),
    `CHANGELOG.md 里找不到 package.json 的版本 ${packageVersion}（发布前必须写清本版条目）`,
  );
});

test("#696 文档引用的 pnpm 脚本都存在于 package.json", () => {
  const scripts = new Set(Object.keys(JSON.parse(read("package.json")).scripts ?? {}));
  const missing: string[] = [];
  for (const file of docFiles()) {
    if (HISTORICAL_DOCS.has(file)) continue;
    for (const match of stripFences(read(file)).matchAll(/\bpnpm ([A-Za-z0-9:_-]+)/g)) {
      const token = match[1]!;
      if (token.startsWith("-") || NON_SCRIPT_TOKENS.has(token)) continue;
      if (!scripts.has(token)) missing.push(`${file}: pnpm ${token}`);
    }
  }
  assert.deepEqual(
    [...new Set(missing)].sort(),
    [],
    "文档引用了不存在的 pnpm 脚本（历史快照文档请加入本文件的 HISTORICAL_DOCS）",
  );
});

test("#696 文档里的相对链接都有目标文件", () => {
  const broken: string[] = [];
  for (const file of docFiles()) {
    if (HISTORICAL_DOCS.has(file)) continue;
    const body = stripFences(read(file));
    for (const match of body.matchAll(/!?\[[^\]]*\]\(([^)\s]+)\)/g)) {
      const target = match[1]!.split("#")[0]!;
      if (!target || /^(https?:|mailto:|tel:)/.test(target)) continue;
      const resolved = path.normalize(path.join(path.dirname(file), target));
      if (!existsSync(path.join(ROOT, resolved))) broken.push(`${file} -> ${target}`);
    }
  }
  assert.deepEqual(
    [...new Set(broken)].sort(),
    [],
    "文档里的相对链接指向不存在的文件（请修正路径或去掉链接）",
  );
});

test("#696 已删机制只出现在解释性文档里", () => {
  const offenders: string[] = [];
  for (const file of docFiles()) {
    const body = stripFences(read(file));
    for (const token of DEAD_TOKENS) {
      if (!body.includes(token)) continue;
      if (DEAD_TOKEN_DOCS.has(file)) continue;
      offenders.push(`${file}: ${token}`);
    }
  }
  assert.deepEqual(
    [...new Set(offenders)].sort(),
    [],
    "已删机制出现在未声明的文档里；确需解释该机制时把文件加进本套件的 DEAD_TOKEN_DOCS，否则请改写为当前 as-built 说法",
  );
});

/** #741：系统架构设计目录的文首必须在前若干行内声明状态与同步日期。 */
const ARCHITECTURE_DIR = "docs/architecture";
const ARCHITECTURE_HEADER_LINES = 12;

test("#741 docs/architecture 纳入保鲜扫描且文首标注状态与同步日期", () => {
  const files = relativeFiles(ARCHITECTURE_DIR, [".md"]);
  for (const required of [`${ARCHITECTURE_DIR}/README.md`, `${ARCHITECTURE_DIR}/adr/README.md`]) {
    assert.ok(files.includes(required), `缺少 ${required}`);
  }
  const scanned = new Set(docFiles());
  assert.deepEqual(
    files.filter((file) => !scanned.has(file)),
    [],
    "docs/architecture 下的文档必须被 docFiles() 扫描（相对链接、pnpm 脚本、已删机制门禁）",
  );

  const missingHeader: string[] = [];
  for (const file of files) {
    const head = read(file).split("\n").slice(0, ARCHITECTURE_HEADER_LINES).join("\n");
    if (!/^> 状态：\S/m.test(head)) missingHeader.push(`${file}: 缺少「> 状态：」`);
    if (!/^> 同步日期：\d{4}-\d{2}-\d{2}\s*$/m.test(head)) missingHeader.push(`${file}: 缺少「> 同步日期：YYYY-MM-DD」`);
  }
  assert.deepEqual(missingHeader, [], "docs/architecture 文档文首必须标注状态与同步日期（见 docs/architecture/README.md §3）");

  assert.ok(
    read("docs/README.md").includes("](architecture/README.md)"),
    "docs/README.md 必须在「系统架构设计」分区链接 docs/architecture/README.md",
  );
});

/**
 * #741 PR 2：需求定义格式与追溯机检。
 *
 * 定义部位：`01-system-specification.md` 中独立成行的三级标题
 * `### FR-JOB-001` / `### IR-001` 等形式（标题本身即完整 ID；正文与矩阵中的引用不算定义）。
 * 不得对全文出现的 ID 简单去重——合法引用会重复。
 */
const SPEC_PATH = `${ARCHITECTURE_DIR}/01-system-specification.md`;
const TRACE_PATH = `${ARCHITECTURE_DIR}/traceability.md`;
/** 完整 ID：`FR|NFR-<域>-NNN` 或 `IR|CON-NNN`（不含仅前缀如 `FR-CAP`）。 */
const REQUIREMENT_ID_RE = /^(?:(?:FR|NFR)-[A-Z][A-Z0-9]*-\d{3}|(?:IR|CON)-\d{3})$/;
const REQUIREMENT_DEF_RE = /^### ((?:(?:FR|NFR)-[A-Z][A-Z0-9]*-\d{3}|(?:IR|CON)-\d{3}))\s*$/gm;
const REQUIREMENT_REF_RE = /\b((?:(?:FR|NFR)-[A-Z][A-Z0-9]*-\d{3}|(?:IR|CON)-\d{3}))\b/g;

/** 已废弃、禁止复用的需求 ID。本期尚无废弃条目；废弃时在此登记并保留规格中的「已废弃」条目。 */
const DEPRECATED_REQUIREMENT_IDS = new Set<string>([]);

function definedRequirementIds(spec: string): string[] {
  return [...spec.matchAll(REQUIREMENT_DEF_RE)].map((match) => match[1]!);
}

function matrixRequirementIds(matrix: string): string[] {
  // 追溯矩阵表：首列是需求 ID（允许链接形式 `[FR-…](…)` 或裸 ID）。
  const ids: string[] = [];
  for (const line of matrix.split("\n")) {
    const cell = /^\|\s*(.*?)\s*\|/.exec(line)?.[1];
    if (!cell || cell.includes("---") || /需求\s*ID/i.test(cell)) continue;
    const bare = cell.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1").trim();
    if (REQUIREMENT_ID_RE.test(bare)) {
      ids.push(bare);
    }
  }
  return ids;
}

test("#741 需求 ID 定义唯一、追溯矩阵覆盖且无悬空引用", () => {
  assert.ok(existsSync(path.join(ROOT, SPEC_PATH)), `缺少 ${SPEC_PATH}`);
  assert.ok(existsSync(path.join(ROOT, TRACE_PATH)), `缺少 ${TRACE_PATH}`);

  const spec = read(SPEC_PATH);
  // 围栏内的「### FR-…」示例不是定义；引用检查同样忽略示例块。
  const specBody = stripFences(spec);
  const defined = definedRequirementIds(specBody);
  assert.ok(defined.length > 0, `${SPEC_PATH} 必须至少用「### FR-…」形式定义一条需求`);

  const duplicates = defined.filter((id, index) => defined.indexOf(id) !== index);
  assert.deepEqual(
    [...new Set(duplicates)].sort(),
    [],
    "01-system-specification.md 中以「### ID」定义的需求 ID 必须全局唯一（引用处重复不算）",
  );

  const reusedDeprecated = defined.filter((id) => DEPRECATED_REQUIREMENT_IDS.has(id));
  assert.deepEqual(
    reusedDeprecated.sort(),
    [],
    "已废弃的需求 ID 不得作为新定义复用（见 docs-freshness DEPRECATED_REQUIREMENT_IDS）",
  );

  const definedSet = new Set(defined);
  const matrix = read(TRACE_PATH);
  const matrixIds = matrixRequirementIds(matrix);
  const matrixSet = new Set(matrixIds);

  assert.deepEqual(
    defined.filter((id) => !matrixSet.has(id)).sort(),
    [],
    "traceability.md 必须覆盖 01-system-specification.md 中全部已定义需求 ID",
  );
  assert.deepEqual(
    [...matrixSet].filter((id) => !definedSet.has(id)).sort(),
    [],
    "traceability.md 不得引用未在 01-system-specification.md 中以「### ID」定义的需求 ID",
  );

  // 规格正文里出现的引用不得指向未定义 ID（定义标题已计入 definedSet）。
  const danglingInSpec = [...new Set(
    [...specBody.matchAll(REQUIREMENT_REF_RE)]
      .map((match) => match[1]!)
      .filter((id) => !definedSet.has(id)),
  )].sort();
  assert.deepEqual(
    danglingInSpec,
    [],
    "01-system-specification.md 正文引用的需求 ID 必须已有「### ID」定义",
  );
});
