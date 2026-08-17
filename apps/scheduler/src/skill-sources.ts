/**
 * Git 模块源（§8.2）：Agent 的插件/skill 集中托管在 Git 仓库（如 SumSec-Skills）
 * - sync：浅克隆 → 扫描 SKILL.md / commands → 目录（含文件内容）落库
 * - 下发：RoleConfig 勾选模块，快照时展开为 agentbox embedded skills/commands
 *   （内容在 sync 时缓存，运行 job 不再访问 Git —— 断网/私有网络也能跑）
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import {
  parseModuleSelector,
  type ParsedModuleSelector,
  validateModuleSelectors,
} from "@deepsonar/shared-types";
import { config } from "./config.js";
import { sql } from "./db.js";

export {
  parseModuleSelector,
  validateModuleSelectors,
  type ParsedModuleSelector,
} from "@deepsonar/shared-types";

const execFileP = promisify(execFile);

/** 仓库 URL 校验（§5.1 安全要求）：仅 https（host 白名单复用 DEEPSONAR_GIT_ALLOWED_HOSTS）；禁 file://、本地路径、内嵌凭据 */
export function validateSourceUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`repo_url 非法: ${url}`);
  }
  if (parsed.protocol !== "https:") {
    throw new Error(`模块源仅允许 https:// Git URL（收到 ${parsed.protocol}）`);
  }
  if (parsed.username || parsed.password) throw new Error("repo_url 不允许内嵌凭据");
  const allowed = config.skillSources.allowedGitHosts.split(",").map((s) => s.trim()).filter(Boolean);
  if (allowed.length > 0 && !allowed.includes(parsed.host)) {
    throw new Error(`git host 不在允许列表: ${parsed.host}`);
  }
}

export interface SourceModule {
  /** 模块 id = 仓库内相对路径（skill 目录 / command 文件） */
  id: string;
  kind: "skill" | "command";
  /** 所属插件（含 .claude-plugin/plugin.json 的最近祖先目录名；无则 "(root)"） */
  plugin: string;
  name: string;
  description: string;
  /** skill: 相对模块目录的文件 → 内容；command: { "command.md": 模板 } */
  files: Record<string, string>;
}

const FILE_CAP = 64 * 1024;
const MODULE_CAP = 512 * 1024;
const BINARY_EXT = new Set([".png", ".jpg", ".jpeg", ".gif", ".ico", ".pdf", ".zip", ".woff", ".woff2", ".pyc"]);

/** SKILL.md frontmatter 提取（不引 yaml 依赖，key: value 足够） */
function frontmatter(content: string): Record<string, string> {
  const m = content.match(/^---\n([\s\S]*?)\n---/);
  const out: Record<string, string> = {};
  if (!m) return out;
  for (const line of m[1].split("\n")) {
    const kv = line.match(/^(\w[\w-]*)\s*:\s*(.+)$/);
    if (kv) out[kv[1]] = kv[2].trim().replace(/^["']|["']$/g, "");
  }
  return out;
}

function* walk(dir: string): Generator<string> {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === ".git" || e.name === "node_modules") continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) yield* walk(full);
    else yield full;
  }
}

/** 收集目录下所有文本文件（相对路径 → 内容），超限即截断跳过 */
function collectFiles(root: string): Record<string, string> {
  const files: Record<string, string> = {};
  let total = 0;
  for (const full of walk(root)) {
    if (statSync(full).size > FILE_CAP) continue;
    if (BINARY_EXT.has(path.extname(full).toLowerCase())) continue;
    const rel = path.relative(root, full).split(path.sep).join("/");
    const content = readFileSync(full, "utf8");
    if (content.includes("\0")) continue; // 二进制兜底
    if (total + content.length > MODULE_CAP) break;
    files[rel] = content;
    total += content.length;
  }
  return files;
}

/** 找最近祖先插件目录（含 .claude-plugin/plugin.json），返回相对仓库根的路径 */
function pluginOf(repoRoot: string, dir: string): string {
  let cur = dir;
  while (cur.startsWith(repoRoot) && cur !== repoRoot) {
    try {
      statSync(path.join(cur, ".claude-plugin", "plugin.json"));
      return path.relative(repoRoot, cur).split(path.sep).join("/");
    } catch {
      cur = path.dirname(cur);
    }
  }
  return "(root)";
}

/** 目录内容哈希（§5.1：不使用不可复现的 branch HEAD 作执行版本——记录 commit + 内容哈希）。
 * Catalog metadata is observable in the frozen component manifest, so a
 * plugin/name/description-only change must invalidate the evidence hash too.
 */
export function contentHashOf(catalog: SourceModule[]): string {
  const h = createHash("sha256");
  for (const m of [...catalog].sort((a, b) => a.id.localeCompare(b.id))) {
    h.update(m.id).update("\0").update(m.kind).update("\0");
    h.update(m.plugin).update("\0").update(m.name).update("\0").update(m.description).update("\0");
    for (const k of Object.keys(m.files).sort()) {
      h.update(k).update("\0").update(m.files[k]).update("\0");
    }
  }
  return h.digest("hex");
}

/** 单个展开模块的内容证据；不含可变 catalog 引用。 */
export interface ExpandedModuleSnapshot {
  source_id: string;
  module_id: string;
  kind: SourceModule["kind"];
  plugin: string;
  name: string;
  description: string;
  content_hash: string;
}

export type ModuleMissingReason =
  | "source-not-found"
  | "source-not-trusted"
  | "catalog-empty"
  | "plugin-not-found"
  | "module-not-found"
  | "manual-override"
  | "name-conflict";

/** Structured missing-module evidence frozen into the Job snapshot. */
export interface MissingModule {
  selector: string;
  source_id: string;
  reason: ModuleMissingReason;
  plugin?: string;
  module_id?: string;
  kind?: SourceModule["kind"];
  name?: string;
  conflicts_with?: Array<{
    source_id: string;
    module_id: string;
    kind: SourceModule["kind"];
    name: string;
  }>;
}

function missingModuleText(missing: MissingModule): string {
  if (missing.reason === "name-conflict") {
    return `${missing.selector}(name-conflict:${missing.kind}:${missing.name})`;
  }
  if (missing.reason === "manual-override") {
    return `${missing.selector}(manual-override:${missing.kind}:${missing.name})`;
  }
  return `${missing.selector}(${missing.reason})`;
}

function missingForSelector(
  selector: ParsedModuleSelector,
  reason: Exclude<ModuleMissingReason, "name-conflict">,
): MissingModule {
  return {
    selector: selector.raw,
    source_id: selector.source_id,
    reason,
    ...(selector.plugin ? { plugin: selector.plugin } : {}),
    ...(selector.module_id ? { module_id: selector.module_id } : {}),
  };
}

type SelectedModule = { source_id: string; module: SourceModule };

/**
 * Materializer paths are namespace-specific: skill names and command names can
 * coexist, but duplicate names within either namespace would silently overwrite
 * one another. Exclude every member of a conflict group deterministically.
 */
export function resolveModuleNameConflicts(entries: SelectedModule[]): {
  modules: SelectedModule[];
  missing_modules: MissingModule[];
} {
  const groups = new Map<string, SelectedModule[]>();
  for (const entry of entries) {
    const key = `${entry.module.kind}:${entry.module.name}`;
    const group = groups.get(key) ?? [];
    group.push(entry);
    groups.set(key, group);
  }

  const conflictKeys = new Set<string>();
  const missing_modules: MissingModule[] = [];
  for (const [key, group] of groups) {
    if (group.length < 2) continue;
    conflictKeys.add(key);
    const ordered = [...group].sort((a, b) => {
      const ak = `${a.source_id}:${a.module.id}`;
      const bk = `${b.source_id}:${b.module.id}`;
      return ak.localeCompare(bk);
    });
    for (const entry of ordered) {
      missing_modules.push({
        selector: `${entry.source_id}:${entry.module.id}`,
        source_id: entry.source_id,
        reason: "name-conflict",
        module_id: entry.module.id,
        kind: entry.module.kind,
        name: entry.module.name,
        conflicts_with: ordered
          .filter((other) => other !== entry)
          .map((other) => ({
            source_id: other.source_id,
            module_id: other.module.id,
            kind: other.module.kind,
            name: other.module.name,
          })),
      });
    }
  }

  // Preserve catalog/selector order for the materializer; collision decisions
  // and evidence ordering above remain deterministic independent of that order.
  const modules = entries.filter((entry) => !conflictKeys.has(`${entry.module.kind}:${entry.module.name}`));
  missing_modules.sort((a, b) =>
    `${a.kind}:${a.name}:${a.source_id}:${a.module_id}`.localeCompare(`${b.kind}:${b.name}:${b.source_id}:${b.module_id}`),
  );
  return { modules, missing_modules };
}

export function contentHashOfSelected(entries: SelectedModule[]): string {
  const h = createHash("sha256");
  for (const entry of [...entries].sort((a, b) => {
    const ak = `${a.source_id}:${a.module.id}`;
    const bk = `${b.source_id}:${b.module.id}`;
    return ak.localeCompare(bk);
  })) {
    h.update(entry.source_id).update("\0").update(entry.module.id).update("\0");
    h.update(entry.module.kind).update("\0");
    h.update(entry.module.plugin).update("\0").update(entry.module.name).update("\0").update(entry.module.description).update("\0");
    for (const key of Object.keys(entry.module.files).sort()) {
      h.update(key).update("\0").update(entry.module.files[key]).update("\0");
    }
  }
  return h.digest("hex");
}

export interface ModuleExpansionOverrides {
  /** Names from RoleConfig.skills_json that take precedence over catalog skills. */
  skill_names?: Iterable<string>;
  /** Names from RoleConfig.commands_json that take precedence over catalog commands. */
  command_names?: Iterable<string>;
}

function filterManualOverrides(
  entries: SelectedModule[],
  overrides: ModuleExpansionOverrides | undefined,
): { modules: SelectedModule[]; missing_modules: MissingModule[] } {
  const manualNames = new Set<string>([
    ...[...(overrides?.skill_names ?? [])].filter((name) => typeof name === "string" && name.length > 0).map((name) => `skill:${name}`),
    ...[...(overrides?.command_names ?? [])].filter((name) => typeof name === "string" && name.length > 0).map((name) => `command:${name}`),
  ]);
  if (manualNames.size === 0) return { modules: entries, missing_modules: [] };

  const modules: SelectedModule[] = [];
  const missing_modules: MissingModule[] = [];
  for (const entry of entries) {
    const key = `${entry.module.kind}:${entry.module.name}`;
    if (!manualNames.has(key)) {
      modules.push(entry);
      continue;
    }
    missing_modules.push({
      selector: `${entry.source_id}:${entry.module.id}`,
      source_id: entry.source_id,
      reason: "manual-override",
      module_id: entry.module.id,
      kind: entry.module.kind,
      name: entry.module.name,
    });
  }
  return { modules, missing_modules };
}

/**
 * 在一个已经读取的 trusted catalog 上展开 selector。这个纯函数同时被测试和
 * DB-backed expandModules 使用，确保 plugin/source 与显式 module 的去重规则一致。
 */
function expandCatalogSelectorsRaw(
  sourceId: string,
  catalog: SourceModule[],
  selectors: ParsedModuleSelector[],
): { modules: SelectedModule[]; missing_modules: MissingModule[] } {
  const byId = new Map(catalog.map((module) => [module.id, module]));
  const selected = new Map<string, SourceModule>();
  const missing_modules: MissingModule[] = [];
  for (const selector of selectors) {
    let matches: SourceModule[];
    if (selector.kind === "source") {
      matches = catalog;
    } else if (selector.kind === "plugin") {
      matches = catalog.filter((module) => module.plugin === selector.plugin);
    } else {
      const module = selector.module_id ? byId.get(selector.module_id) : undefined;
      matches = module ? [module] : [];
    }
    if (matches.length === 0) {
      const reason = selector.kind === "source"
        ? "catalog-empty"
        : selector.kind === "plugin"
          ? "plugin-not-found"
          : "module-not-found";
      missing_modules.push(missingForSelector(selector, reason));
      continue;
    }
    for (const module of matches) selected.set(module.id, module);
  }
  return {
    modules: [...selected.values()].map((module) => ({ source_id: sourceId, module })),
    missing_modules,
  };
}

export function expandCatalogSelectors(
  sourceId: string,
  catalog: SourceModule[],
  selectors: ParsedModuleSelector[],
): { modules: SelectedModule[]; missing: string[]; missing_modules: MissingModule[] } {
  const raw = expandCatalogSelectorsRaw(sourceId, catalog, selectors);
  const conflicts = resolveModuleNameConflicts(raw.modules);
  const missing_modules = [...raw.missing_modules, ...conflicts.missing_modules];
  return {
    modules: conflicts.modules,
    missing_modules,
    missing: missing_modules.map(missingModuleText),
  };
}

function isCatalogModule(value: unknown): value is SourceModule {
  if (!value || typeof value !== "object") return false;
  const module = value as Record<string, unknown>;
  return (
    typeof module.id === "string" &&
    module.id.length > 0 &&
    (module.kind === "skill" || module.kind === "command") &&
    typeof module.plugin === "string" &&
    typeof module.name === "string" &&
    typeof module.description === "string" &&
    Boolean(module.files) &&
    typeof module.files === "object" &&
    !Array.isArray(module.files) &&
    Object.values(module.files as Record<string, unknown>).every((content) => typeof content === "string")
  );
}

const MODULE_COUNT_CAP = 200;

function scanRepo(repoRoot: string): SourceModule[] {
  const modules: SourceModule[] = [];
  const seenSkills = new Set<string>();

  for (const full of walk(repoRoot)) {
    if (modules.length >= MODULE_COUNT_CAP) break;
    const rel = path.relative(repoRoot, full).split(path.sep).join("/");
    const dir = path.dirname(full);

    if (path.basename(full) === "SKILL.md") {
      const skillDir = path.relative(repoRoot, dir).split(path.sep).join("/");
      if (seenSkills.has(skillDir)) continue;
      seenSkills.add(skillDir);
      const content = readFileSync(full, "utf8");
      const fm = frontmatter(content);
      modules.push({
        id: skillDir,
        kind: "skill",
        plugin: pluginOf(repoRoot, dir),
        name: fm.name ?? path.basename(dir),
        description: fm.description ?? "",
        files: collectFiles(dir),
      });
    } else if (path.basename(full).endsWith(".md") && path.basename(dir) === "commands") {
      // 插件的 commands/*.md → slash 命令模板
      const content = readFileSync(full, "utf8");
      const fm = frontmatter(content);
      const name = path.basename(full, ".md");
      modules.push({
        id: rel,
        kind: "command",
        plugin: pluginOf(repoRoot, dir),
        name,
        description: fm.description ?? (content.match(/^#\s+(.+)$/m)?.[1] ?? name),
        files: { "command.md": content.replace(/^---\n[\s\S]*?\n---\n?/, "") },
      });
    }
  }
  return modules;
}

/** 同步一个模块源：浅克隆 → 扫描 → catalog + commit sha + 内容哈希落库。返回模块数。 */
export async function syncSkillSource(sourceId: string, syncedBy?: string | null): Promise<{ modules: number }> {
  const [src] = await sql`SELECT * FROM skill_sources WHERE id = ${sourceId}`;
  if (!src) throw new Error(`skill source ${sourceId} 不存在`);
  if ((src.trust_status as string) === "disabled") throw new Error("模块源已禁用，不能同步");

  const tmp = mkdtempSync(path.join(os.tmpdir(), "deepsonar-src-"));
  try {
    try {
      await execFileP("git", ["clone", "--depth", "1", "--branch", src.branch as string, src.repo_url as string, tmp], { timeout: 120_000 });
    } catch {
      // 分支不存在等场景：退回默认分支
      await execFileP("git", ["clone", "--depth", "1", src.repo_url as string, tmp], { timeout: 120_000 });
    }
    const { stdout: commitSha } = await execFileP("git", ["-C", tmp, "rev-parse", "HEAD"], { timeout: 15_000 });
    const catalog = scanRepo(tmp);
    await sql`
      UPDATE skill_sources SET
        catalog_json = ${sql.json(catalog as never)},
        synced_at = now(),
        last_commit_sha = ${commitSha.trim()},
        last_content_hash = ${contentHashOf(catalog)},
        synced_by = ${syncedBy ?? null}
      WHERE id = ${sourceId}`;
    return { modules: catalog.length };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

/** 模块来源的版本证据（随 Job 快照冻结，§5.1：Job 历史只读快照不受后续同步覆盖） */
export interface SkillRevisionRef {
  source_id: string;
  commit_sha: string | null;
  content_hash: string | null;
}

/**
 * 展开 RoleConfig 的模块选择器（历史 module、plugin、source 三种语法）
 * → agentbox embedded skills / commands，与 RoleConfig 手写 JSON 合并去重（按 name）
 * 非 trusted 或已禁用来源的模块一律跳过（§5.1：quarantined 未经审批不得下发）
 */
export async function expandModules(
  modules: string[],
  db: typeof sql = sql,
  overrides?: ModuleExpansionOverrides,
): Promise<{
  skills: Record<string, unknown>[];
  commands: Record<string, unknown>[];
  missing: string[];
  missing_modules: MissingModule[];
  revisions: SkillRevisionRef[];
  resolved_modules: ExpandedModuleSnapshot[];
  content_hash: string;
}> {
  const skills: Record<string, unknown>[] = [];
  const commands: Record<string, unknown>[] = [];
  const missing_modules: MissingModule[] = [];
  const revisions: SkillRevisionRef[] = [];
  const selectedModules: SelectedModule[] = [];
  if (modules.length === 0) {
    return {
      skills,
      commands,
      missing: [],
      missing_modules,
      revisions,
      resolved_modules: [],
      content_hash: contentHashOfSelected([]),
    };
  }

  // Parse before touching the database: malformed selectors must be an explicit
  // RoleConfig/Job error, never a silently ignored module.
  const parsed = validateModuleSelectors(modules, "RoleConfig.modules")
    .map((selector) => parseModuleSelector(selector));
  const bySource = new Map<string, ParsedModuleSelector[]>();
  for (const selector of parsed) {
    const list = bySource.get(selector.source_id) ?? [];
    list.push(selector);
    bySource.set(selector.source_id, list);
  }

  for (const [sourceId, selectors] of bySource) {
    const [src] = await db`
      SELECT catalog_json, trust_status, enabled, last_commit_sha, last_content_hash
      FROM skill_sources WHERE id = ${sourceId}`;
    if (!src) {
      for (const selector of selectors) missing_modules.push(missingForSelector(selector, "source-not-found"));
      continue;
    }
    if ((src.trust_status as string) !== "trusted" || !src.enabled) {
      // 未信任/已禁用来源：整组拒绝下发
      for (const selector of selectors) missing_modules.push(missingForSelector(selector, "source-not-trusted"));
      continue;
    }
    revisions.push({
      source_id: sourceId,
      commit_sha: (src.last_commit_sha as string) ?? null,
      content_hash: (src.last_content_hash as string) ?? null,
    });
    const catalog = Array.isArray(src.catalog_json)
      ? src.catalog_json.filter(isCatalogModule)
      : [];
    if (catalog.length === 0) {
      for (const selector of selectors) missing_modules.push(missingForSelector(selector, "catalog-empty"));
      continue;
    }
    const expanded = expandCatalogSelectorsRaw(sourceId, catalog, selectors);
    missing_modules.push(...expanded.missing_modules);
    for (const selected of expanded.modules) {
      selectedModules.push(selected);
    }
  }
  // Apply the deterministic collision policy across all selected sources, not
  // just within each catalog. Skill/command names use separate namespaces.
  const resolved = resolveModuleNameConflicts(selectedModules);
  missing_modules.push(...resolved.missing_modules);
  const manualFiltered = filterManualOverrides(resolved.modules, overrides);
  missing_modules.push(...manualFiltered.missing_modules);
  for (const selected of manualFiltered.modules) {
    const mod = selected.module;
    if (mod.kind === "skill") {
      skills.push({ source: "embedded", name: mod.name, files: mod.files });
    } else {
      commands.push({ name: mod.name, description: mod.description, template: mod.files["command.md"] ?? "" });
    }
  }
  const missing = missing_modules.map(missingModuleText);
  return {
    skills,
    commands,
    missing,
    missing_modules,
    revisions,
    resolved_modules: manualFiltered.modules.map(({ source_id, module }) => ({
      source_id,
      module_id: module.id,
      kind: module.kind,
      plugin: module.plugin,
      name: module.name,
      description: module.description,
      content_hash: contentHashOf([module]),
    })),
    content_hash: contentHashOfSelected(manualFiltered.modules),
  };
}

export const SKILL_SOURCE_BOOT_SYNC_TIMEOUT_MS = 20_000;

export async function runWithTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  label: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function syncTrustedSkillSourcesOnce(deps: {
  listSources: () => Promise<Array<{ id: string; name: string }>>;
  sync: (id: string) => Promise<{ modules: number }>;
  timeoutMs: number;
}): Promise<void> {
  const sources = await deps.listSources();
  if (sources.length === 0) {
    console.log("[boot] 无已信任模块源，跳过启动同步");
    return;
  }
  for (const src of sources) {
    try {
      const result = await runWithTimeout(deps.sync(src.id), deps.timeoutMs, `skill-source ${src.name} boot sync`);
      console.log(`[boot] 模块源 ${src.name} 同步完成：${result.modules} 个模块`);
    } catch (error) {
      console.warn(
        `[boot] 模块源 ${src.name} 同步失败（不阻塞启动）:`,
        error instanceof Error ? error.message : error,
      );
      throw error;
    }
  }
}

/**
 * 启动同步不阻塞 listen。GitHub 不可达时有界超时并后台重试。
 */
export function startSkillSourceBootSync(deps: {
  enabled?: boolean;
  listSources?: () => Promise<Array<{ id: string; name: string }>>;
  sync?: (id: string) => Promise<{ modules: number }>;
  timeoutMs?: number;
  retryDelaysMs?: readonly number[];
  sleep?: (ms: number) => Promise<void>;
} = {}): () => void {
  const enabled = deps.enabled ?? config.skillSources.bootSync;
  if (!enabled) {
    console.log("[boot] 跳过模块源启动同步（DEEPSONAR_SKILL_SOURCE_BOOT_SYNC=false）");
    return () => {};
  }
  const timeoutMs = deps.timeoutMs ?? config.skillSources.bootSyncTimeoutSec * 1000;
  const delays = deps.retryDelaysMs ?? [5_000, 15_000, 30_000];
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref();
  }));
  const listSources = deps.listSources ?? (async () => {
    const rows = await sql`
      SELECT id, name FROM skill_sources
      WHERE enabled = true AND trust_status = 'trusted'
      ORDER BY created_at ASC`;
    return rows.map((row) => ({ id: String(row.id), name: String(row.name) }));
  });
  const sync = deps.sync ?? ((id: string) => syncSkillSource(id, "boot"));
  let stopped = false;
  void (async () => {
    let attempt = 0;
    while (!stopped) {
      attempt += 1;
      try {
        await syncTrustedSkillSourcesOnce({ listSources, sync, timeoutMs });
        return;
      } catch (error) {
        const delay = delays[Math.min(attempt - 1, delays.length - 1)] ?? 30_000;
        console.warn(
          `[boot] 模块源启动同步失败（attempt ${attempt}，${delay}ms 后后台重试）:`,
          error instanceof Error ? error.message : error,
        );
        await sleep(delay);
      }
    }
  })();
  return () => { stopped = true; };
}
