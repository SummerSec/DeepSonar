/**
 * #954：模块源漂移检测。
 *
 * 周期刷新不应该每次都重新浅克隆：先用 `git ls-remote --heads` 取远端分支 HEAD，
 * 与库里 `last_commit_sha` 相同就只前移 `synced_at`。探针失败（网络/主机拒绝）
 * 一律回退到真实同步——「探不到」不等于「没变化」。
 */
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { sql } from "./db.js";
import type { SkillSourceSyncResult } from "./skill-sources.js";

const execFileP = promisify(execFile);

export type GitExecFileLike = (
  file: string,
  args: readonly string[],
  options: { timeout?: number; signal?: AbortSignal },
) => Promise<{ stdout: string | Buffer }>;

export interface SkillSourceSkipRow {
  id: string;
  repo_url: string;
  branch: string;
  last_commit_sha?: unknown;
  last_content_hash?: unknown;
  catalog_json?: unknown;
}

/** `git ls-remote --heads` 只读探针，返回目标分支 HEAD；无匹配返回 null。 */
export async function probeSkillSourceRemoteHead(input: {
  repoUrl: string;
  branch: string;
  signal?: AbortSignal;
  execFile?: GitExecFileLike;
  timeoutMs?: number;
}): Promise<string | null> {
  const run: GitExecFileLike = input.execFile ?? (async (file, args, options) => {
    const { stdout } = await execFileP(file, [...args], options);
    return { stdout };
  });
  const { stdout } = await run(
    "git",
    ["ls-remote", "--heads", input.repoUrl, input.branch],
    { timeout: input.timeoutMs ?? 30_000, signal: input.signal },
  );
  const line = String(stdout ?? "")
    .split("\n")
    .map((entry) => entry.trim())
    .find((entry) => entry.length > 0);
  if (!line) return null;
  const sha = line.split(/\s+/)[0] ?? "";
  return /^[0-9a-f]{7,64}$/i.test(sha) ? sha : null;
}

function asSha(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

/**
 * 远端 HEAD 与本地 commit 一致时只刷新 `synced_at`，返回同步结果；
 * 需要真正拉取内容时返回 null，由调用方继续走 clone→scan→落库。
 */
export async function skipUnchangedSourceSync(input: {
  sourceId: string;
  syncedBy?: string | null;
  src: SkillSourceSkipRow;
  signal?: AbortSignal;
  probe: (input: { repoUrl: string; branch: string; signal?: AbortSignal }) => Promise<string | null>;
}): Promise<SkillSourceSyncResult | null> {
  const previousCommitSha = asSha(input.src.last_commit_sha);
  const previousContentHash = asSha(input.src.last_content_hash);
  // 没有本地 commit 可比较时无从判断漂移，必须走真实同步。
  if (!previousCommitSha) return null;
  // 探针报错不等于「没变化」：只有明确拿到同一个 HEAD 才允许跳过内容拉取。
  const remoteHead = await input.probe({
    repoUrl: input.src.repo_url,
    branch: input.src.branch,
    signal: input.signal,
  }).catch(() => null);
  if (!remoteHead || remoteHead !== previousCommitSha) return null;
  const [touched] = await sql`
    UPDATE skill_sources SET synced_at = now(), synced_by = ${input.syncedBy ?? null}
    WHERE id = ${input.sourceId}
    RETURNING synced_at`;
  const modules = Array.isArray(input.src.catalog_json) ? input.src.catalog_json.length : 0;
  return {
    modules,
    changed: false,
    skipped: true,
    previous_commit_sha: previousCommitSha,
    last_commit_sha: previousCommitSha,
    previous_content_hash: previousContentHash,
    last_content_hash: previousContentHash,
    synced_at: touched?.synced_at instanceof Date
      ? touched.synced_at.toISOString()
      : String(touched?.synced_at ?? new Date().toISOString()),
    selector_cleanup: { role_configs_updated: 0, migrated: [], removed: [] },
  };
}