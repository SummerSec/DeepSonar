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
 *   5. `docs/architecture/**`（#741）文首标注状态与同步日期，必需视图与 ADR 齐全；
 *   6. 需求定义唯一，追溯矩阵完整，架构文档引用的需求 ID 存在；
 *   7. 开发 Skill 可发现，CLAUDE 保持为 AGENTS 的 Git 符号链接。
 *
 * 机检覆盖不到语义：**「as-built 段落是否与代码相反」仍需人工按清单第 3 项逐条核**，
 * 本套件只验证结构与引用，不能证明规范已由实现满足。
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync, readlinkSync, readdirSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { repoRootFromModuleUrl } from "./file-size-gate.js";
import { auditRequirements, normalizeDocPath, stripMarkdownFences as stripFences } from "./docs-architecture-gate.js";

const ROOT = repoRootFromModuleUrl();

test("#741 文档路径规范化保持 Windows 与 POSIX 白名单身份一致", () => {
  assert.equal(normalizeDocPath("docs\\architecture\\README.md"), "docs/architecture/README.md");
  assert.equal(normalizeDocPath("docs/architecture/README.md"), "docs/architecture/README.md");
});

const SPEC_FIXTURE = "### FR-JOB-001 冻结快照\n必须冻结。引用 FR-JOB-001。\n### CON-001 边界\n不得越权。";
const TRACE_FIXTURE = "| FR-JOB-001 | view | — | code | test |\n| CON-001 | view | adr | code | 人工核查 |";

test("#741 需求定义与引用分离，接受重复引用、CRLF 和围栏示例", () => {
  assert.deepEqual(auditRequirements(SPEC_FIXTURE, TRACE_FIXTURE, ["引用 FR-JOB-001 两次 FR-JOB-001"]), []);
  assert.deepEqual(auditRequirements(`${SPEC_FIXTURE}\n\`\`\`md\n### FR-JOB-999 示例\n\`\`\``, TRACE_FIXTURE), []);
  assert.deepEqual(auditRequirements(`${SPEC_FIXTURE}\n~~~~md\n### FR-JOB-999 示例\n~~~\n~~~~`, TRACE_FIXTURE), []);
  assert.deepEqual(auditRequirements(SPEC_FIXTURE.replaceAll("\n", "\r\n"), TRACE_FIXTURE), []);
  assert.equal(stripFences("正文\r\n~~~~md\r\npnpm missing-script\r\n[x](missing.md)\r\n~~~\r\n~~~~\r\n末尾"), "正文\n末尾");
});

test("#741 追溯门禁拒绝重复、遗漏、悬空、无效编号与空验收列", () => {
  assert.match(auditRequirements(`${SPEC_FIXTURE}\n### FR-JOB-001 重复`, TRACE_FIXTURE).join("\n"), /重复定义.*FR-JOB-001/);
  assert.match(auditRequirements(SPEC_FIXTURE, "| CON-001 | view | adr | code | test |").join("\n"), /缺少追溯.*FR-JOB-001/);
  assert.match(auditRequirements(SPEC_FIXTURE, `${TRACE_FIXTURE}\n| FR-JOB-999 | view | — | code | test |`).join("\n"), /未定义.*FR-JOB-999/);
  assert.match(auditRequirements(SPEC_FIXTURE, `${TRACE_FIXTURE}\n| CON-001 | view | adr | code | test |`).join("\n"), /重复追溯.*CON-001/);
  assert.match(auditRequirements(SPEC_FIXTURE, TRACE_FIXTURE, ["引用 NFR-SEC-999"]).join("\n"), /未定义.*NFR-SEC-999/);
  assert.match(auditRequirements("### FR-JOB-1 错误", "").join("\n"), /无效定义/);
  assert.match(auditRequirements(SPEC_FIXTURE, TRACE_FIXTURE.replace("| test |", "|  |")).join("\n"), /空字段.*FR-JOB-001/);
  assert.match(auditRequirements("", "").join("\n"), /没有需求定义/);
  assert.match(auditRequirements(SPEC_FIXTURE, TRACE_FIXTURE, [], ["FR-JOB-001"]).join("\n"), /已废弃 ID/);
  const tombstone = SPEC_FIXTURE.replace("必须冻结。", "**实现状态**：已废弃；由 CON-001 取代。");
  assert.deepEqual(auditRequirements(tombstone, TRACE_FIXTURE, [], ["FR-JOB-001"]), []);
});

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

function relativeFiles(dir: string, extensions: string[]): string[] {
  const absolute = path.join(ROOT, dir);
  if (!existsSync(absolute)) return [];
  return readdirSync(absolute, { withFileTypes: true }).flatMap((entry) => {
    const relative = normalizeDocPath(path.join(dir, entry.name));
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
    ...relativeFiles(".agents/skills", [".md"]),
  ].filter((file) => existsSync(path.join(ROOT, file)));
}

function read(relative: string): string {
  return readFileSync(path.join(ROOT, relative), "utf8");
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
/** 已发布 ID 的废弃登记：保留 tombstone，禁止重新变成活跃需求。 */
const DEPRECATED_REQUIREMENT_IDS: readonly string[] = [];
const ARCHITECTURE_VIEWS = [
  "01-system-specification", "02-context-and-scope", "03-constraints-and-principles",
  "04-quality-attributes", "05-building-blocks", "06-runtime-view", "07-deployment-view",
  "08-data-architecture", "09-interface-specs", "10-security-and-trust-boundaries",
  "11-engineering-specs", "12-risks-and-tech-debt", "traceability",
];

test("#741 docs/architecture 纳入保鲜扫描且文首标注状态与同步日期", () => {
  const files = relativeFiles(ARCHITECTURE_DIR, [".md"]);
  for (const required of ["README", "adr/README", ...ARCHITECTURE_VIEWS].map((name) => `${ARCHITECTURE_DIR}/${name}.md`)) {
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

test("#741 系统需求与追溯矩阵覆盖一致，架构引用无悬空 ID", () => {
  const files = relativeFiles(ARCHITECTURE_DIR, [".md"]);
  assert.deepEqual(auditRequirements(
    read(`${ARCHITECTURE_DIR}/01-system-specification.md`),
    read(`${ARCHITECTURE_DIR}/traceability.md`),
    files.map(read),
    DEPRECATED_REQUIREMENT_IDS,
  ), []);
});

test("#741 六条 ADR、开发 Skill 与双入口保持可发现", () => {
  const adrs = ["0001-no-backward-compatibility", "0002-schema-baseline", "0003-api-only-control",
    "0004-fact-and-finding-verification", "0005-event-evidence-stream", "0006-runtime-image-admission"];
  for (const adr of adrs) {
    assert.ok(existsSync(path.join(ROOT, ARCHITECTURE_DIR, "adr", `${adr}.md`)), `缺少 ADR ${adr}`);
    assert.ok(read(`${ARCHITECTURE_DIR}/adr/README.md`).includes(`](${adr}.md)`), `ADR 索引缺少 ${adr}`);
  }
  const skill = ".agents/skills/architecture-doc-sync/SKILL.md";
  assert.ok(docFiles().includes(skill), "开发文档同步 Skill 必须纳入门禁");
  assert.ok(read("AGENTS.md").includes(`](${skill})`), "AGENTS 必须绑定开发 Skill");
  // Git stores this alias as a symlink; core.symlinks=false checks out its target text on Windows.
  assert.match(execFileSync("git", ["ls-files", "-s", "--", "CLAUDE.md"], { cwd: ROOT, encoding: "utf8" }), /^120000 /);
  const alias = path.join(ROOT, "CLAUDE.md");
  assert.equal(lstatSync(alias).isSymbolicLink() ? readlinkSync(alias) : read("CLAUDE.md"), "AGENTS.md");
});
