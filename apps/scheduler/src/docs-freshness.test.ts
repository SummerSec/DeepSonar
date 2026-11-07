/**
 * 文档保鲜门禁（#696）。
 *
 * 发版前的人工保鲜清单见 `AGENTS.md` 的「发布前的文档保鲜（发版硬门）」；
 * 本套件把其中可机检的部分变成会失败的断言：
 *
 *   1. `AGENTS.md` / `DESIGN.md` / `docs/**` / `skills/**` 里的当前 schema 版本 == `SCHEMA_VERSION`；
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


/** 只识别当前状态断言；历史迁移、产品/工具版本不属于数据库主线编号。 */
function currentSchemaVersions(markdown: string): string[] {
  const subjects = [
    "当前主线",
    "(?:远端\\s*)?origin/main\\s*(?:当前|最新)\\s*(?:schema\\s*)?(?:版本|基线)",
    "(?:当前|最新)\\s*(?:数据库\\s*)?(?:schema|SCHEMA_VERSION)\\s*(?:(?:版本|基线)\\s*)?",
    "(?:数据库\\s*)?schema\\s*(?:当前|最新)\\s*(?:(?:版本|基线)\\s*)?",
    "schema\\s*(?:版本|基线)\\s*(?:当前|最新)",
  ];
  // 整数编号必须完整匹配，不能把 v0.6.16、v24-beta 或 v24foo 截成 schema 编号。
  const declaration = new RegExp(`(?:${subjects.join("|")})\\s*(?:为|是|[:：=])?\\s*v?(\\d+)(?![\\dA-Za-z_+-]|\\.\\d)`, "gi");
  const versions: string[] = [];
  const body = stripFences(markdown).replace(/[`*]/g, "");
  for (const match of body.matchAll(declaration)) {
    const prefix = body.slice(0, match.index).split(/[。；;\n]/).at(-1)!;
    // 限定语必须紧邻声明之前；文首同步日期、声明后的核对日期/历史说明不能豁免当前断言。
    if (/(?:历史(?:记录|版本|快照|迁移)?|迁移记录|当时|(?:引用)?示例|引用原文)\s*[:：]?\s*[「“"']?\s*$/.test(prefix)) continue;
    if (/\b\d{4}-\d{2}-\d{2}\b(?:\s*(?:核对|记录|时))?\s*[)）]?\s*[:：，,]?\s*$/.test(prefix)) continue;
    versions.push(match[1]!);
  }
  return versions;
}

test("#996 旧 origin/main 最新基线断言不能因未同步 checkout 的附注漏检", () => {
  for (const checkout of ["工作树", "checkout", "工作树/checkout"]) {
    const old = `远端 origin/main 最新基线为 v24，当前未同步${checkout}仍可能是 v23`;
    assert.deepEqual(currentSchemaVersions(old), ["24"], old);
    assert.deepEqual(currentSchemaVersions(`| schema 版本 | 以运行中 \`/schema\` 为准；${old.replace("origin/main", "\`origin/main\`")} |`), ["24"]);
    // 与仓库门禁相同的比较：已有正确声明也不能掩盖另一处旧断言。
    assert.deepEqual(currentSchemaVersions(`当前主线 v68\n${old}`).filter((version) => version !== "68"), ["24"]);
  }
});

test("#996 当前 schema 声明保留旧句式并覆盖版本、基线与内联格式", () => {
  for (const statement of [
    "当前主线 v24", "当前主线\nv24", "当前 schema v24", "当前数据库 schema 版本为 24",
    "最新 schema 基线：v24", "schema 当前版本是 v24", "schema 版本当前为 24",
    "当前 SCHEMA_VERSION = 24", "> **当前主线** `v24`", "远端 `origin/main` 最新基线为 **v24**",
    "当前主线 v24（2026-11-07 核对；历史 v23 只作参考）",
    "同步日期：2026-11-07\n当前主线 v24", "历史 schema v23，当前主线 v24",
    "引用示例：当前主线 v23；当前 schema v24", "历史记录：当前主线 v23，当前 schema v24",
  ]) assert.deepEqual(currentSchemaVersions(statement), ["24"], statement);
  assert.deepEqual(currentSchemaVersions("当前主线 v68\r\n当前 schema v24"), ["68", "24"]);
});

test("#996 历史版本、日期记录、引用示例与产品工具版本无需追平 schema", () => {
  for (const statement of [
    "历史记录：当前主线 v24", "当时当前 schema 为 v24", "迁移记录：当前主线 v24",
    "2026-10-01：当前主线 v24", "截至 2026-10-01，远端 origin/main 最新基线为 v24",
    "2026-10-01 核对：当前 schema 版本为 v24", "引用原文：“当前主线 v24”",
    "引用示例：「当前主线 v24」", "示例：`当前 schema v24`",
    "```md\n当前主线 v24\n```", "~~~~md\r\n远端 origin/main 最新基线为 v24\r\n~~~~",
    "schema 基线由 v65 推进到 v66；已验收历史 schema67；v62/v63/v64 用于备份恢复",
    "**项目知识（2026-10-20，#752）**：schema v61；Job 冻结目录保持历史真相",
    "当前产品版本 v0.6.16；当前主线 v0.6.16；origin/main 最新基线为 v0.6.16",
    "当前 REA v24；当前 Ghidra v12；当前 JDK v21；最新 schema v24-beta；当前 schema v24foo",
  ]) {
    assert.deepEqual(currentSchemaVersions(statement), [], statement);
    assert.deepEqual(currentSchemaVersions(`${statement}\n当前主线 v68`), ["68"], statement);
  }
});

test("#696 文档声明的 schema 主线版本与 SCHEMA_VERSION 一致", () => {
  const source = read("apps/scheduler/src/schema-version.ts");
  const version = /SCHEMA_VERSION\s*=\s*(\d+)/.exec(source)?.[1];
  assert.ok(version, "apps/scheduler/src/schema-version.ts 必须导出数字 SCHEMA_VERSION");

  const declared = new Map<string, Set<string>>();
  // skills/** 也纳入：技能文档里写错主线版本同样会误导操作者。
  for (const file of ["AGENTS.md", "DESIGN.md", ...relativeFiles("docs", [".md"]), ...relativeFiles("skills", [".md"])]) {
    for (const declaredVersion of currentSchemaVersions(read(file))) {
      const seen = declared.get(declaredVersion) ?? new Set<string>();
      seen.add(file);
      declared.set(declaredVersion, seen);
    }
  }

  assert.ok(declared.has(version), `没有任何文档声明当前 schema v${version}（找到了 ${[...declared.keys()].join(", ") || "无"}）`);
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

function markdownLinkTargets(body: string): string[] {
  return [...body.matchAll(/!?\[[^\]]*\]\((?:<([^>\r\n]+)>|([^)\s]+))(?:\s+"[^"]*")?\)/g)]
    .map((match) => match[1] ?? match[2]!);
}

test("#696 角括号链接保留空格与锚点并仍纳入目标校验", () => {
  assert.deepEqual(markdownLinkTargets([
    "[plain](docs/guide.md#part)", "[wrapped](<docs/guide.md#part>)",
    "![space](<docs/path with spaces/image.png>)", '[title](<docs/guide.md> "guide")',
    "[broken](<docs/missing-target.md>)", "[external](<https://example.invalid/docs>)",
  ].join("\n")), [
    "docs/guide.md#part", "docs/guide.md#part", "docs/path with spaces/image.png",
    "docs/guide.md", "docs/missing-target.md", "https://example.invalid/docs",
  ]);
});

test("#696 文档里的相对链接都有目标文件", () => {
  const broken: string[] = [];
  for (const file of docFiles()) {
    if (HISTORICAL_DOCS.has(file)) continue;
    const body = stripFences(read(file));
    for (const link of markdownLinkTargets(body)) {
      const target = link.split("#")[0]!;
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
