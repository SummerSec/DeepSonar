/** Read-only remote probe. A matching SHA alone is never cache-health evidence. */
import { promisify } from "node:util";
import { execFile } from "node:child_process";

const execFileP = promisify(execFile);

export type GitExecFileLike = (
  file: string,
  args: readonly string[],
  options: { timeout?: number; signal?: AbortSignal },
) => Promise<{ stdout: string | Buffer }>;

/** Match the full ref: ls-remote patterns can also return another branch first. */
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
  const ref = `refs/heads/${input.branch}`;
  const { stdout } = await run(
    "git", ["ls-remote", "--heads", input.repoUrl, ref],
    { timeout: input.timeoutMs ?? 30_000, signal: input.signal },
  );
  for (const line of String(stdout ?? "").split("\n")) {
    const [sha, name] = line.trim().split(/\s+/);
    if (name === ref && sha && /^[0-9a-f]{40,64}$/i.test(sha)) return sha;
  }
  return null;
}
