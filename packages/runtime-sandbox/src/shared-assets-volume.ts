import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { SHARED_ASSETS_JOB_LABEL, SHARED_ASSETS_VOLUME_LABEL, assertSharedAssetsVolumeOwnership } from "./agentbox.js";

const execFileP = promisify(execFile);
const JOB_ID_RE = /^[0-9a-f]{8}-[0-9a-f-]{27}$/i;

async function docker(...args: string[]): Promise<string> {
  const { stdout } = await execFileP("docker", args, { timeout: 60_000, maxBuffer: 8 * 1024 * 1024 });
  return stdout.trim();
}

export interface SharedAssetVolumeFile {
  sourcePath: string;
  relativePath: string;
}

export interface SharedAssetsVolumeManager {
  prepare(input: { jobId: string; image: string; files: SharedAssetVolumeFile[]; catalog: unknown }): Promise<string | null>;
  removeForJob(jobId: string): Promise<void>;
  listManaged(): Promise<Array<{ volumeName: string; jobId: string }>>;
}

function volumeName(jobId: string): string {
  if (!JOB_ID_RE.test(jobId)) throw new Error("invalid shared-assets Job id");
  return `deepsonar-assets-${jobId.toLowerCase()}`;
}

function safeRelativePath(input: string): string {
  const normalized = input.replaceAll("\\", "/").replace(/^\/+/, "");
  if (!normalized || normalized.length > 320 || normalized.split("/").some((part) => !part || part === "." || part === "..")) {
    throw new Error("invalid shared-assets volume path");
  }
  return normalized;
}

export class NoopSharedAssetsVolumeManager implements SharedAssetsVolumeManager {
  async prepare(): Promise<null> { return null; }
  async removeForJob(): Promise<void> {}
  async listManaged(): Promise<Array<{ volumeName: string; jobId: string }>> { return []; }
}

export class DockerSharedAssetsVolumeManager implements SharedAssetsVolumeManager {
  async prepare(input: { jobId: string; image: string; files: SharedAssetVolumeFile[]; catalog: unknown }): Promise<string | null> {
    if (input.files.length === 0) return null;
    const name = volumeName(input.jobId);
    await this.removeForJob(input.jobId);
    await docker("volume", "create", "--driver", "local", "--label", `${SHARED_ASSETS_VOLUME_LABEL}=true`, "--label", `${SHARED_ASSETS_JOB_LABEL}=${input.jobId}`, name);
    const inspected = JSON.parse(await docker("volume", "inspect", name, "--format", "{{json .}}")) as Record<string, unknown>;
    assertSharedAssetsVolumeOwnership(inspected, name, input.jobId);

    const staging = await mkdtemp(path.join(os.tmpdir(), "deepsonar-assets-"));
    const helper = `deepsonar-assets-writer-${input.jobId.toLowerCase()}`;
    try {
      for (const file of input.files) {
        const relative = safeRelativePath(file.relativePath);
        const target = path.join(staging, ...relative.split("/"));
        await mkdir(path.dirname(target), { recursive: true });
        await cp(file.sourcePath, target, { force: false, errorOnExist: true });
      }
      await writeFile(path.join(staging, "catalog.json"), `${JSON.stringify(input.catalog, null, 2)}\n`, { flag: "wx" });
      await docker(
        "run", "-d", "--name", helper, "--network", "none", "--cap-drop", "ALL",
        "--security-opt", "no-new-privileges", "--read-only", "-v", `${name}:/assets`,
        "--entrypoint", "/bin/sh", input.image, "-c", "while :; do sleep 60; done",
      );
      await docker("cp", `${staging}${path.sep}.`, `${helper}:/assets`);
    } catch (error) {
      await docker("rm", "-f", helper).catch(() => "");
      await docker("volume", "rm", "-f", name).catch(() => "");
      throw error;
    } finally {
      await docker("rm", "-f", helper).catch(() => "");
      await rm(staging, { recursive: true, force: true });
    }
    return name;
  }

  async removeForJob(jobId: string): Promise<void> {
    const name = volumeName(jobId);
    let inspected: Record<string, unknown>;
    try {
      inspected = JSON.parse(await docker("volume", "inspect", name, "--format", "{{json .}}")) as Record<string, unknown>;
    } catch { return; }
    assertSharedAssetsVolumeOwnership(inspected, name, jobId);
    await docker("volume", "rm", "-f", name);
  }

  async listManaged(): Promise<Array<{ volumeName: string; jobId: string }>> {
    const names = (await docker("volume", "ls", "--filter", `label=${SHARED_ASSETS_VOLUME_LABEL}=true`, "--format", "{{.Name}}"))
      .split(/\r?\n/).filter(Boolean);
    const result: Array<{ volumeName: string; jobId: string }> = [];
    for (const name of names) {
      const inspected = JSON.parse(await docker("volume", "inspect", name, "--format", "{{json .}}")) as { Labels?: Record<string, string> };
      const jobId = inspected.Labels?.[SHARED_ASSETS_JOB_LABEL];
      if (!jobId) continue;
      assertSharedAssetsVolumeOwnership(inspected, name, jobId);
      result.push({ volumeName: name, jobId });
    }
    return result;
  }
}
