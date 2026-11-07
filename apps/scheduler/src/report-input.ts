import { createHash, randomUUID } from "node:crypto";
import { link, mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { config } from "./config.js";

const digest = (bytes: string | Buffer): string => createHash("sha256").update(bytes).digest("hex");
const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};

/** Exact Scheduler-frozen bytes, not a reconstruction from current Finding/Canvas state. */
export function readFrozenReportInput(
  job: Record<string, unknown>,
  report?: { input_uri: unknown; input_sha256: unknown; version: unknown },
): Buffer {
  const payload = record(job.payload_json);
  const version = payload.report_version;
  const findingScoped = payload.kind === "finding_report";
  if (job.type !== "report" || !job.canvas_id || !job.project_id
    || (!findingScoped && payload.kind !== "task_report")
    || !Number.isSafeInteger(version) || Number(version) < 1) {
    throw new Error("REPORT_INPUT_IDENTITY_INVALID: report Job scope/version is invalid");
  }
  if (typeof payload.report_input_json !== "string" || !payload.report_input_json.trim()) {
    throw new Error("REPORT_INPUT_FROZEN_MISSING: explicitly create a new Report version; historical input is not rebuilt");
  }
  const bytes = Buffer.from(payload.report_input_json, "utf8");
  if (typeof payload.report_input_sha256 !== "string" || digest(bytes) !== payload.report_input_sha256) {
    throw new Error("REPORT_INPUT_DIGEST_MISMATCH: frozen input bytes do not match the Job digest");
  }
  const input = record(JSON.parse(bytes.toString("utf8")));
  const task = record(input.task);
  const findingId = String(job.finding_id ?? "");
  const safeCanvasId = String(job.canvas_id).replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 80) || "unknown";
  const expectedUri = findingScoped
    ? path.posix.join("finding-reports", findingId, `v${version}`, "report-input.json")
    : path.posix.join("reports", safeCanvasId, `v${version}`, "report-input.json");
  if (task.canvas_id !== job.canvas_id
    || (findingScoped ? record(input.project).id !== job.project_id : task.project_id !== job.project_id)
    || (findingScoped && (!/^[0-9a-f-]{36}$/i.test(findingId) || payload.finding_id !== findingId
      || input.scope !== "finding" || record(input.finding).id !== findingId || input.report_version !== version))
    || payload.report_input_uri !== expectedUri
    || (report && (report.input_uri !== expectedUri || report.input_sha256 !== payload.report_input_sha256
      || Number(report.version) !== version))) {
    throw new Error("REPORT_INPUT_IDENTITY_INVALID: frozen input, Job and Report identities disagree");
  }
  return bytes;
}

/** Run only after claim commits, outside every retried SQL callback and before runtime IO. */
export async function materializeReportInput(job: Record<string, unknown>): Promise<void> {
  const bytes = readFrozenReportInput(job);
  const uri = String(record(job.payload_json).report_input_uri);
  const root = path.resolve(config.storage.blobDir);
  const target = path.resolve(root, uri);
  if (!target.startsWith(`${root}${path.sep}`)) throw new Error("REPORT_INPUT_PATH_INVALID");
  await mkdir(path.dirname(target), { recursive: true });
  const temporary = `${target}.${randomUUID()}.tmp`;
  // Link publishes complete bytes without replacing an existing historical input.
  // Both paths are resolved under the checked BLOB root before cleanup.
  try {
    await writeFile(temporary, bytes, { flag: "wx" });
    try {
      await link(temporary, target);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (digest(await readFile(target)) !== digest(bytes)) {
        throw new Error("REPORT_INPUT_DIGEST_MISMATCH: existing input is preserved, not overwritten");
      }
    }
  } finally {
    await unlink(temporary).catch(() => {});
  }
}
