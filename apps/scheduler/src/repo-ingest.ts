import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  lstatSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

/**
 * 真实代码摄入（§10）：任务的审计代码从 repo_path / repo_url 读取，经限制与清单
 * 生成后作为种子文件送入沙箱（内容注入，不是宿主路径挂载——§10.1 明确禁止挂载）。
 *
 * 摄入安全（§10.2 落地项）：
 * - repo_url 仅允许 https://，可选 Host 允许列表（DFH_GIT_ALLOWED_HOSTS）
 * - 浅克隆 --depth 1、submodule 默认关闭、LFS 默认跳过（GIT_LFS_SKIP_SMUDGE=1）、克隆超时
 * - 符号链接解析后逃出仓库根的一律跳过
 * - 文件数 / 总字节 / 单文件字节上限，二进制文件跳过
 * - 摄入产出证据清单（file_count/total_bytes/commit sha/内容哈希）随 job 存档（§10.1 任务记录）
 */

const execFileP = promisify(execFile);

export interface RepoSpec {
  repoPath?: string;
  repoUrl?: string;
  ref?: string;
}

export interface RepoLimits {
  maxFiles: number;
  maxTotalBytes: number;
  maxFileBytes: number;
  cloneTimeoutSec: number;
  /** 空数组 = 不限制（仅强制 https）；否则 host 必须命中 */
  allowedGitHosts: string[];
  /** 空数组 = 不限制本地路径；否则 repoPath 必须落在其中一个根下 */
  localRoots: string[];
}

export interface RepoEvidence {
  source: "local_path" | "git" | "demo";
  repo_url?: string;
  requested_ref?: string;
  resolved_commit_sha?: string;
  file_count: number;
  total_bytes: number;
  skipped_files: number;
  /** 摄入内容清单哈希（文件名+内容 sha256 的聚合，§10.2 送入沙箱前生成清单与哈希） */
  manifest_sha256: string;
  ingested_at: string;
}

export interface IngestResult {
  files: Record<string, string>;
  evidence: RepoEvidence;
}

const SKIP_DIRS = new Set([".git", ".svn", ".hg", ".idea", ".vscode"]);

function looksBinary(buf: Buffer): boolean {
  const n = Math.min(buf.length, 8000);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

interface WalkOut {
  files: Record<string, string>;
  fileCount: number;
  totalBytes: number;
  skipped: number;
}

/** 确定性遍历（按名排序），应用全部摄入限制 */
function readTree(root: string, limits: RepoLimits): WalkOut {
  const realRoot = realpathSync(root);
  const out: WalkOut = { files: {}, fileCount: 0, totalBytes: 0, skipped: 0 };
  const manifest = createHash("sha256");

  const walk = (dir: string, prefix: string): void => {
    const entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
      a.name < b.name ? -1 : 1,
    );
    for (const entry of entries) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      const full = path.join(dir, entry.name);
      const st = lstatSync(full);

      if (st.isSymbolicLink()) {
        // 符号链接：解析后逃出仓库根 → 跳过（§10.2）
        let target: string;
        try {
          target = realpathSync(full);
        } catch {
          out.skipped++;
          continue; //  dangling link
        }
        if (!target.startsWith(realRoot + path.sep) && target !== realRoot) {
          out.skipped++;
          continue;
        }
        if (!lstatSync(target).isFile()) continue; // 目录链接不展开，防环
      } else if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        walk(full, rel);
        continue;
      } else if (!entry.isFile()) {
        continue; // socket/fifo 等特殊文件
      }

      if (out.fileCount >= limits.maxFiles || out.totalBytes >= limits.maxTotalBytes) {
        out.skipped++;
        continue;
      }
      const buf = readFileSync(full);
      if (buf.length > limits.maxFileBytes || looksBinary(buf)) {
        out.skipped++;
        continue;
      }
      const sandboxPath = `/workspace/src/${rel.split(path.sep).join("/")}`;
      out.files[sandboxPath] = buf.toString("utf8");
      out.fileCount++;
      out.totalBytes += buf.length;
      manifest.update(rel).update("\0").update(buf).update("\0");
    }
  };
  walk(realRoot, "");
  // 把清单哈希挂到返回值（调用方并入 evidence）
  (out as WalkOut & { manifestSha: string }).manifestSha = manifest.digest("hex");
  return out;
}

async function git(...args: string[]): Promise<string> {
  const { stdout } = await execFileP("git", args, {
    timeout: 30_000,
    env: { ...process.env, GIT_LFS_SKIP_SMUDGE: "1", GIT_TERMINAL_PROMPT: "0" },
  });
  return stdout.trim();
}

/** 浅克隆到临时目录（submodule/LFS 默认关闭），用完由调用方清理 */
async function cloneShallow(
  url: string,
  ref: string | undefined,
  limits: RepoLimits,
): Promise<{ dir: string; commitSha: string }> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`repo_url 非法: ${url}`);
  }
  if (parsed.protocol !== "https:") {
    throw new Error(`repo_url 仅允许 https://（收到 ${parsed.protocol}）`);
  }
  if (parsed.username || parsed.password) {
    throw new Error("repo_url 不允许内嵌凭据（私有仓库凭据由 Credential Store 管理，CRED 工作包落地）");
  }
  if (limits.allowedGitHosts.length > 0 && !limits.allowedGitHosts.includes(parsed.host)) {
    throw new Error(`git host 不在允许列表: ${parsed.host}`);
  }

  const dir = mkdtempSync(path.join(tmpdir(), "dfh-repo-"));
  try {
    const args = [
      "clone", "--depth", "1", "--no-tags",
      "-c", "submodule.recurse=false",
      ...(ref ? ["--branch", ref] : []),
      "--", url, dir,
    ];
    await execFileP("git", args, {
      timeout: limits.cloneTimeoutSec * 1000,
      env: { ...process.env, GIT_LFS_SKIP_SMUDGE: "1", GIT_TERMINAL_PROMPT: "0" },
    });
    const commitSha = await git("-C", dir, "rev-parse", "HEAD");
    return { dir, commitSha };
  } catch (e) {
    rmSync(dir, { recursive: true, force: true });
    throw new Error(`git 克隆失败: ${e instanceof Error ? e.message.slice(0, 300) : e}`);
  }
}

/** 摄入入口：repoUrl 优先于 repoPath；二者皆无抛错（demo 回退由调用方决定） */
export async function ingestCodeSource(spec: RepoSpec, limits: RepoLimits): Promise<IngestResult> {
  if (spec.repoUrl) {
    const { dir, commitSha } = await cloneShallow(spec.repoUrl, spec.ref, limits);
    try {
      const tree = readTree(dir, limits);
      return {
        files: tree.files,
        evidence: {
          source: "git",
          repo_url: spec.repoUrl,
          requested_ref: spec.ref,
          resolved_commit_sha: commitSha,
          file_count: tree.fileCount,
          total_bytes: tree.totalBytes,
          skipped_files: tree.skipped,
          manifest_sha256: (tree as WalkOut & { manifestSha: string }).manifestSha,
          ingested_at: new Date().toISOString(),
        },
      };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  if (spec.repoPath) {
    let real: string;
    try {
      real = realpathSync(spec.repoPath);
    } catch {
      throw new Error(`repo_path 不存在: ${spec.repoPath}`);
    }
    if (limits.localRoots.length > 0) {
      const ok = limits.localRoots.some((root) => {
        const r = realpathSync(root);
        return real === r || real.startsWith(r + path.sep);
      });
      if (!ok) throw new Error(`repo_path 不在允许的根目录内（DFH_REPO_LOCAL_ROOTS）: ${spec.repoPath}`);
    }
    const tree = readTree(real, limits);
    return {
      files: tree.files,
      evidence: {
        source: "local_path",
        file_count: tree.fileCount,
        total_bytes: tree.totalBytes,
        skipped_files: tree.skipped,
        manifest_sha256: (tree as WalkOut & { manifestSha: string }).manifestSha,
        ingested_at: new Date().toISOString(),
      },
    };
  }

  throw new Error("未提供代码来源（repo_path / repo_url 均为空）");
}
