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
import { config } from "./config.js";
import { sql } from "./db.js";

const execFileP = promisify(execFile);

/** 仓库 URL 校验（§5.1 安全要求）：仅 https（host 白名单复用 DFH_GIT_ALLOWED_HOSTS）；禁 file://、本地路径、内嵌凭据 */
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

/** 目录内容哈希（§5.1：不使用不可复现的 branch HEAD 作执行版本——记录 commit + 内容哈希） */
function contentHashOf(catalog: SourceModule[]): string {
  const h = createHash("sha256");
  for (const m of [...catalog].sort((a, b) => (a.id < b.id ? -1 : 1))) {
    h.update(m.id).update("\0").update(m.kind).update("\0");
    for (const k of Object.keys(m.files).sort()) {
      h.update(k).update("\0").update(m.files[k]).update("\0");
    }
  }
  return h.digest("hex");
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

  const tmp = mkdtempSync(path.join(os.tmpdir(), "dfh-src-"));
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
 * 展开 RoleConfig 勾选的模块（["<source_id>:<module_id>", ...]）
 * → agentbox embedded skills / commands，与 RoleConfig 手写 JSON 合并去重（按 name）
 * 非 trusted 或已禁用来源的模块一律跳过（§5.1：quarantined 未经审批不得下发）
 */
export async function expandModules(
  modules: string[],
): Promise<{
  skills: Record<string, unknown>[];
  commands: Record<string, unknown>[];
  missing: string[];
  revisions: SkillRevisionRef[];
}> {
  const skills: Record<string, unknown>[] = [];
  const commands: Record<string, unknown>[] = [];
  const missing: string[] = [];
  const revisions: SkillRevisionRef[] = [];
  if (modules.length === 0) return { skills, commands, missing, revisions };

  const bySource = new Map<string, string[]>();
  for (const m of modules) {
    const idx = m.indexOf(":");
    if (idx <= 0) { missing.push(m); continue; }
    const list = bySource.get(m.slice(0, idx)) ?? [];
    list.push(m.slice(idx + 1));
    bySource.set(m.slice(0, idx), list);
  }

  for (const [sourceId, ids] of bySource) {
    const [src] = await sql`
      SELECT catalog_json, trust_status, enabled, last_commit_sha, last_content_hash
      FROM skill_sources WHERE id = ${sourceId}`;
    if (!src || (src.trust_status as string) !== "trusted" || !src.enabled) {
      // 未信任/已禁用来源：整组拒绝下发
      for (const id of ids) missing.push(`${sourceId}:${id}(source-not-trusted)`);
      continue;
    }
    revisions.push({
      source_id: sourceId,
      commit_sha: (src.last_commit_sha as string) ?? null,
      content_hash: (src.last_content_hash as string) ?? null,
    });
    const catalog = ((src?.catalog_json as SourceModule[]) ?? []) as SourceModule[];
    for (const id of ids) {
      const mod = catalog.find((c) => c.id === id);
      if (!mod) { missing.push(`${sourceId}:${id}`); continue; }
      if (mod.kind === "skill") {
        skills.push({ source: "embedded", name: mod.name, files: mod.files });
      } else {
        commands.push({ name: mod.name, description: mod.description, template: mod.files["command.md"] ?? "" });
      }
    }
  }
  return { skills, commands, missing, revisions };
}
